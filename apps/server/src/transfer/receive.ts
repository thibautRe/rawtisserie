/**
 * Receiving from another instance (`send.ts` on the other side), with an access token
 * (`tokens.ts`): `/api/transfer/…` can add versions, presets, styles and LUTs to the
 * token's user's library, and nothing else. A copy remembers its origin, so sending it
 * again updates it: its history is replaced by the sender's if it wasn't edited here
 * since, else the sender's current recipe goes on top, as one more step.
 */
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  EDIT_PARAMS_VERSION,
  MODULE_KINDS,
  PRESET_KINDS,
  type ModuleKind,
  normalizeModulePreset,
  normalizeStyle,
} from '@rawtisserie/pipeline';
import type { SessionUser } from '../auth/sessions.ts';
import { db, sql, versions } from '../db.ts';
import { HttpError, badRequest, conflict } from '../errors.ts';
import type Photos from '../__generated__/photos.ts';
import type Versions from '../__generated__/versions.ts';
import { addLut } from '../luts/routes.ts';
import { ingestFile } from '../photos/ingest.ts';
import { PHOTO_FIELDS, Sha256, VERSION_FIELDS, applyHistoryChange, toColumns } from '../photos/routes.ts';
import type { RenderQueue } from '../render/queue.ts';
import { instanceId } from './instance.ts';
import { Hello, PROTOCOL, type ReceivedStatus, SentPreset, SentVersion } from './protocol.ts';
import { tokenUser } from './tokens.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The user of the request's access token (`/api/transfer/…` only). */
    tokenUser: SessionUser | null;
  }
}

const userOf = (request: FastifyRequest) => request.tokenUser!;

export async function receiveRoutes(app: FastifyInstance, { renderQueue }: { renderQueue: RenderQueue }) {
  app.decorateRequest('tokenUser', null);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/transfer/')) return;
    request.tokenUser = await tokenUser(request);
    if (!request.tokenUser) return reply.code(401).send({ error: 'This access token isn’t valid (revoked?)' });
  });

  app.get('/api/transfer/hello', async (request): Promise<Hello> => {
    const user = userOf(request);
    return {
      protocol: PROTOCOL,
      instance: await instanceId(),
      editParamsVersion: EDIT_PARAMS_VERSION,
      account: { displayName: user.displayName, email: user.email },
    };
  });

  /** Which of these originals the user has here (in the library or the trash). */
  app.post('/api/transfer/check', async (request) => {
    const { hashes } = z.object({ hashes: z.array(Sha256).min(1).max(1000) }).parse(request.body);
    const rows = (await db.query(sql`
      SELECT sha256 FROM photos WHERE owner_id = ${userOf(request).id} AND sha256 = ANY(${hashes})`)) as {
      sha256: string;
    }[];
    return { have: rows.map((r) => r.sha256) };
  });

  /**
   * A version (multipart: `meta`, a `SentVersion`, then its original as `file` if the
   * user doesn't have it here; without it, 409 `needOriginal`).
   */
  app.post('/api/transfer/versions', async (request, reply) => {
    const user = userOf(request);
    let meta: SentVersion | null = null;
    let versionId: string | null = null;
    let status: ReceivedStatus = 'updated';
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        // Parsed already when sent as JSON (`content-type: application/json`).
        if (part.fieldname === 'meta')
          meta = SentVersion.parse(typeof part.value === 'string' ? JSON.parse(part.value) : part.value);
        continue;
      }
      if (!meta || versionId) {
        part.file.resume();
        continue;
      }
      checkRecipes(meta);
      // The original: only stored if it's still needed (another transfer may have brought it).
      ({ versionId, status } = await findOrCreate(user.id, meta, part.file));
    }
    if (!meta) throw badRequest('Expected the version’s `meta` first');
    checkRecipes(meta);
    await db.query(sql`
      INSERT INTO imports (owner_id, id, source) VALUES (${user.id}, ${meta.importId}, ${meta.origin.label})
      ON CONFLICT DO NOTHING`);
    if (!versionId) {
      try {
        ({ versionId, status } = await findOrCreate(user.id, meta, null));
      } catch (err) {
        if (err instanceof NeedOriginal) return reply.code(409).send({ error: err.message, needOriginal: true });
        throw err;
      }
    }
    await update(user.id, versionId, meta, status === 'created');
    renderQueue.enqueue(versionId);
    return reply.code(status === 'created' ? 201 : 200).send({ status, versionId });
  });

  /** A LUT, packed (`?name=`). A name taken by another LUT gets a number. */
  app.post('/api/transfer/luts', async (request) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.query);
    const user = userOf(request);
    for (let n = 1; ; n++) {
      try {
        const lut = await addLut(user.id, n === 1 ? name : `${name} (${n})`, request.body);
        return { lutId: lut.lut_id };
      } catch (err) {
        if (!(err instanceof HttpError && err.statusCode === 409) || n >= 20) throw err;
      }
    }
  });

  /**
   * A module preset or a style: updates the copy sent before, else is saved like one
   * made here (replacing one of the same name).
   */
  app.put('/api/transfer/presets', async (request) => {
    const input = SentPreset.parse(request.body);
    const user = userOf(request);
    let moduleKind: ModuleKind | null = null;
    if (input.kind === 'module') {
      const kind = z
        .enum(MODULE_KINDS)
        .refine((k) => PRESET_KINDS.includes(k))
        .safeParse(input.moduleKind);
      if (!kind.success) throw badRequest(`No presets for module “${input.moduleKind}”`);
      moduleKind = kind.data;
    }
    const payload = JSON.stringify(
      moduleKind ? normalizeModulePreset(moduleKind, input.payload) : normalizeStyle(input.payload),
    );
    const { instance, id } = input.origin;
    const updated = await db
      .query(
        sql`
          UPDATE presets SET name = ${input.name}, payload = ${payload}::jsonb, updated_at = now()
          WHERE owner_id = ${user.id} AND origin_instance = ${instance} AND origin_preset = ${id}
          RETURNING id`,
      )
      .catch((err: { code?: string }) => {
        throw err.code === '23505' ? conflict(`There is already a preset named “${input.name}”`) : err;
      });
    if (updated.length) return { status: 'updated' };
    await db.query(sql`
      INSERT INTO presets (owner_id, kind, module_kind, name, payload, origin_instance, origin_preset)
      VALUES (${user.id}, ${input.kind}, ${moduleKind}, ${input.name}, ${payload}::jsonb, ${instance}, ${id})
      ON CONFLICT (owner_id, kind, module_kind, name)
      DO UPDATE SET payload = excluded.payload, origin_instance = excluded.origin_instance,
        origin_preset = excluded.origin_preset, updated_at = now()`);
    return { status: 'created' };
  });
}

/** Recipes this instance can't read yet (sent by a newer one) are refused, not guessed at. */
function checkRecipes(meta: SentVersion) {
  if (meta.history.end > meta.history.entries.length) throw badRequest('The history has no such entry');
  for (const e of meta.history.entries) {
    const version = (e.recipe as { version?: unknown }).version;
    if (typeof version === 'number' && version > EDIT_PARAMS_VERSION)
      throw new HttpError(422, 'This photo was edited with a newer version of RAWtisserie: update this instance first');
  }
}

const newVersionColumns = (meta: SentVersion): Partial<Versions> => ({
  import_id: meta.importId,
  origin_instance: meta.origin.instance,
  origin_version: meta.origin.id,
});

class NeedOriginal extends Error {}

/**
 * The copy of `meta`'s version here: the one sent before, else a new one on the photo
 * (stored from `file` if the user doesn't have its original, else `NeedOriginal`). A
 * file that isn't needed is read to its end and dropped.
 */
async function findOrCreate(
  userId: string,
  meta: SentVersion,
  file: (Readable & { truncated?: boolean }) | null,
): Promise<{ versionId: string; status: ReceivedStatus }> {
  const [copy] = (await db.query(sql`
    SELECT v.id FROM versions v JOIN photos p ON p.id = v.photo_id
    WHERE p.owner_id = ${userId} AND v.origin_instance = ${meta.origin.instance} AND v.origin_version = ${meta.origin.id}
    LIMIT 1`)) as { id: string }[];
  if (copy) {
    await drain(file);
    return { versionId: copy.id, status: 'updated' };
  }
  const [photo] = (await db.query(sql`
    SELECT id FROM photos WHERE owner_id = ${userId} AND sha256 = ${meta.sha256}`)) as Pick<Photos, 'id'>[];
  if (!photo) {
    if (!file) throw new NeedOriginal('The original is needed');
    const result = await ingestFile(userId, meta.filename, file, {
      allowDeleted: true,
      version: newVersionColumns(meta),
      modifiedAt: meta.fileModifiedAt == null ? null : new Date(meta.fileModifiedAt),
    });
    if (result.status === 'skipped') throw new HttpError(422, result.reason);
    if (result.status === 'created') return { versionId: result.versionId, status: 'created' };
    return createOn(result.photoId, meta);
  }
  await drain(file);
  return createOn(photo.id, meta);
}

async function drain(file: Readable | null) {
  if (!file) return;
  file.resume();
  await finished(file).catch(() => {});
}

async function createOn(photoId: string, meta: SentVersion) {
  const [row] = await versions(db).insert({ ...newVersionColumns(meta), photo_id: photoId });
  return { versionId: row!.id, status: 'created' as const };
}

/** Make the copy match what was sent: culling, metadata, the photo's corrections, the history. */
async function update(userId: string, versionId: string, meta: SentVersion, isNew: boolean) {
  await db.tx(async (tx) => {
    const [v] = (await tx.query(sql`
      SELECT v.revision, v.origin_revision, v.history_end, v.photo_id, p.exif IS NULL AS no_exif,
        (SELECT h.recipe FROM history_entries h WHERE h.version_id = v.id AND h.seq = v.history_end) AS current
      FROM versions v JOIN photos p ON p.id = v.photo_id
      WHERE v.id = ${versionId} AND p.owner_id = ${userId} FOR UPDATE OF v`)) as (Pick<
      Versions,
      'revision' | 'origin_revision' | 'history_end' | 'photo_id'
    > & { no_exif: boolean; current: unknown })[];
    if (!v) throw conflict('The copy went away while it was updated');
    // Sent again: it comes back from the trash, and belongs to this transfer's import.
    await versions(tx).update(
      { id: versionId },
      { ...toColumns<Versions>(meta.patch, VERSION_FIELDS), trashed_at: null, import_id: meta.importId },
    );
    const photo = toColumns<Photos>(meta.patch, PHOTO_FIELDS);
    if (meta.exif) Object.assign(photo, { exif: meta.exif });
    if (Object.keys(photo).length) await tx.query(updatePhoto(v.photo_id, photo));

    const { entries, end } = meta.history;
    const untouched = isNew || v.revision === v.origin_revision;
    let ops;
    if (untouched) ops = [{ type: 'splice' as const, from: 1, entries, end }];
    else if (end > 0 && JSON.stringify(entries[end - 1]!.recipe) !== JSON.stringify(v.current)) {
      // Edited here since: kept, under the sender's current recipe.
      const label = `Sent from ${meta.origin.label}`;
      const entry = { label, recipe: entries[end - 1]!.recipe };
      ops = [{ type: 'splice' as const, from: v.history_end + 1, entries: [entry], end: v.history_end + 1 }];
    }
    const revision = ops ? (await applyHistoryChange(tx, userId, versionId, { ops }))!.revision : v.revision;
    await versions(tx).update({ id: versionId }, { origin_revision: revision });
  });
}

function updatePhoto(id: string, columns: Partial<Photos>) {
  const sets = Object.entries(columns).map(([column, value]) =>
    column === 'exif' ? sql`exif = ${JSON.stringify(value)}::jsonb` : sql`${sql.ident(column)} = ${value}`,
  );
  return sql`UPDATE photos SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE id = ${id}`;
}
