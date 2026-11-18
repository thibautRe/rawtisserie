/**
 * Sending to another instance (`receive.ts` there): the instances a user connected,
 * and transfers, run here one at a time (they go on without the page, and resume when
 * the server starts). A transfer sends versions (a selection, or all of them with the
 * user's presets, styles and LUTs); each version takes the LUTs its recipes use, and its
 * original only if the other side doesn't have it. What was sent is remembered by a
 * fingerprint, so sending again skips what hasn't changed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type EditParams, isBuiltinLut, lutIds } from '@rawtisserie/pipeline';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, sql } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { collectionPath } from '../photos/collections.ts';
import { Target, targetClause } from '../photos/query.ts';
import type Photos from '../__generated__/photos.ts';
import type Versions from '../__generated__/versions.ts';
import { readLut } from '../luts/files.ts';
import { originalKey } from '../photos/storage.ts';
import { storage } from '../storage/index.ts';
import { instanceId } from './instance.ts';
import type { SentPreset, SentVersion } from './protocol.ts';
import { type Remote, RemoteError, hello, normalizeUrl, remoteError, remoteFetch } from './remote.ts';
import { MAX_COUNT, checkCount } from '../limits.ts';

const Id = z.object({ id: z.uuid() });
/** Uploading an original can take a while. */
const ORIGINAL_TIMEOUT_MS = 30 * 60_000;

interface RemoteRow {
  id: string;
  owner_id: string;
  url: string;
  token: string;
  remote_id: string;
  remote_account: string;
  created_at: Date;
}

const remoteDto = (r: RemoteRow) => ({ id: r.id, url: r.url, account: r.remote_account, createdAt: r.created_at });

export async function sendRoutes(app: FastifyInstance, { runner }: { runner: TransferRunner }) {
  app.addHook('preHandler', requireUser);

  app.get('/api/instances', async (request) => {
    const rows = (await db.query(sql`
      SELECT * FROM remote_instances WHERE owner_id = ${currentUser(request).id} ORDER BY created_at`)) as RemoteRow[];
    return { instances: rows.map(remoteDto) };
  });

  /** Connect an instance: its address and a token made there, checked by asking it. */
  app.post('/api/instances', async (request, reply) => {
    const input = z.object({ url: z.string().min(1).max(500), token: z.string().trim().min(1).max(200) });
    const { url: given, token } = input.parse(request.body);
    const url = normalizeUrl(given);
    const [mine] = (await db.query(sql`
      SELECT count(*)::int AS n FROM remote_instances WHERE owner_id = ${currentUser(request).id} AND url <> ${url}`)) as {
      n: number;
    }[];
    checkCount(mine!.n, MAX_COUNT.instances, 'connected instances');
    const there = await hello({ url, token });
    if (there.instance === (await instanceId())) throw badRequest('That’s this instance');
    const account = `${there.account.displayName} <${there.account.email}>`;
    const [row] = (await db.query(sql`
      INSERT INTO remote_instances (owner_id, url, token, remote_id, remote_account)
      VALUES (${currentUser(request).id}, ${url}, ${token}, ${there.instance}, ${account})
      ON CONFLICT (owner_id, url) DO UPDATE SET token = excluded.token, remote_id = excluded.remote_id,
        remote_account = excluded.remote_account
      RETURNING *`)) as RemoteRow[];
    return reply.code(201).send(remoteDto(row!));
  });

  app.delete('/api/instances/:id', async (request) => {
    const { id } = Id.parse(request.params);
    const gone = await db.query(sql`
      DELETE FROM remote_instances WHERE id = ${id} AND owner_id = ${currentUser(request).id} RETURNING id`);
    if (!gone.length) throw notFound('Instance not found');
    return { ok: true };
  });

  /** Send versions (a `Target`: ids or a filter), or everything, to an instance: a transfer, run here. */
  app.post('/api/instances/:id/send', async (request, reply) => {
    const { id } = Id.parse(request.params);
    const user = currentUser(request);
    const body = z.union([Target, z.object({ everything: z.literal(true) })]).parse(request.body);
    const [remote] = await db.query(sql`
      SELECT id FROM remote_instances WHERE id = ${id} AND owner_id = ${user.id}`);
    if (!remote) throw notFound('Instance not found');
    const everything = 'everything' in body;
    const transferId = await db.tx(async (tx) => {
      const [t] = (await tx.query(sql`
        INSERT INTO transfers (owner_id, remote_id, everything, origin_label)
        VALUES (${user.id}, ${id}, ${everything}, ${request.host})
        RETURNING id`)) as { id: string }[];
      // In the library's order of files, versions of a file together: its original goes once.
      await tx.query(sql`
        INSERT INTO transfer_items (transfer_id, version_id, position)
        SELECT ${t!.id}, v.id, row_number() OVER (ORDER BY p.created_at, p.id, v.position, v.id)
        FROM versions v JOIN photos p ON p.id = v.photo_id
        WHERE ${'everything' in body ? sql`p.owner_id = ${user.id} AND v.trashed_at IS NULL` : targetClause(user.id, body)}`);
      return t!.id;
    });
    runner.kick();
    return reply.code(201).send(await transferDto(user.id, transferId));
  });

  app.get('/api/transfers/:id', async (request) => {
    const { id } = Id.parse(request.params);
    return transferDto(currentUser(request).id, id);
  });

  /** Send the failed versions again. */
  app.post('/api/transfers/:id/retry', async (request) => {
    const { id } = Id.parse(request.params);
    const user = currentUser(request);
    const updated = await db.query(sql`
      UPDATE transfers SET status = 'running', error = NULL, finished_at = NULL
      WHERE id = ${id} AND owner_id = ${user.id} AND status <> 'running' RETURNING id`);
    if (!updated.length) throw notFound('Transfer not found (or still running)');
    await db.query(sql`
      UPDATE transfer_items SET status = 'waiting', error = NULL WHERE transfer_id = ${id} AND status = 'failed'`);
    runner.kick();
    return transferDto(user.id, id);
  });

  app.post('/api/transfers/:id/cancel', async (request) => {
    const { id } = Id.parse(request.params);
    const user = currentUser(request);
    await db.query(sql`
      UPDATE transfers SET status = 'cancelled', finished_at = now()
      WHERE id = ${id} AND owner_id = ${user.id} AND status = 'running'`);
    return transferDto(user.id, id);
  });
}

async function transferDto(ownerId: string, id: string) {
  const [t] = (await db.query(sql`
    SELECT t.*, r.url FROM transfers t JOIN remote_instances r ON r.id = t.remote_id
    WHERE t.id = ${id} AND t.owner_id = ${ownerId}`)) as {
    id: string;
    url: string;
    everything: boolean;
    status: string;
    error: string | null;
    extras_sent: number;
    created_at: Date;
    finished_at: Date | null;
  }[];
  if (!t) throw notFound('Transfer not found');
  const counts = (await db.query(sql`
    SELECT status, count(*)::int AS n FROM transfer_items WHERE transfer_id = ${id} GROUP BY status`)) as {
    status: string;
    n: number;
  }[];
  const failed = (await db.query(sql`
    SELECT i.version_id, p.original_filename, i.error
    FROM transfer_items i JOIN versions v ON v.id = i.version_id JOIN photos p ON p.id = v.photo_id
    WHERE i.transfer_id = ${id} AND i.status = 'failed' ORDER BY i.position LIMIT 200`)) as {
    version_id: string;
    original_filename: string;
    error: string | null;
  }[];
  const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return {
    id: t.id,
    url: t.url,
    everything: t.everything,
    status: t.status,
    error: t.error,
    total: counts.reduce((sum, c) => sum + c.n, 0),
    created: count('created'),
    updated: count('updated'),
    unchanged: count('unchanged'),
    failed: count('failed'),
    waiting: count('waiting'),
    extrasSent: t.extras_sent,
    failures: failed.map((f) => ({ versionId: f.version_id, filename: f.original_filename, error: f.error })),
    createdAt: t.created_at,
    finishedAt: t.finished_at,
  };
}

// ── Running transfers ───────────────────────────────────────────────────────

/** Runs transfers one at a time, in the order they were made. */
export class TransferRunner {
  private running: Promise<void> | null = null;
  private again = false;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }

  /** There's something to send (or the server started: resume what was running). */
  kick() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Wait for what's running (tests, shutdown). */
  idle() {
    return this.running ?? Promise.resolve();
  }

  private async drain() {
    for (;;) {
      const [next] = (await db.query(sql`
        SELECT id FROM transfers WHERE status = 'running' ORDER BY created_at LIMIT 1`)) as { id: string }[];
      if (!next) return;
      try {
        await runTransfer(next.id, this.log);
        await db.query(sql`
          UPDATE transfers SET status = 'done', finished_at = now() WHERE id = ${next.id} AND status = 'running'`);
      } catch (err) {
        if (!(err instanceof RemoteError)) this.log.error({ err, transfer: next.id }, 'transfer failed');
        const message = err instanceof Error ? err.message : String(err);
        await db.query(sql`
          UPDATE transfers SET status = 'failed', error = ${message}, finished_at = now()
          WHERE id = ${next.id} AND status = 'running'`);
      }
    }
  }
}

async function runTransfer(id: string, log: FastifyBaseLogger) {
  const [t] = (await db.query(sql`
    SELECT t.owner_id, t.everything, t.extras_sent, t.origin_label,
      r.id AS remote_id, r.url, r.token, r.remote_id AS remote_instance
    FROM transfers t JOIN remote_instances r ON r.id = t.remote_id WHERE t.id = ${id}`)) as {
    owner_id: string;
    everything: boolean;
    extras_sent: number;
    origin_label: string;
    remote_id: string;
    url: string;
    token: string;
    remote_instance: string;
  }[];
  if (!t) return;
  const remote: Remote = { url: t.url, token: t.token };
  const there = await hello(remote);
  if (there.instance !== t.remote_instance)
    throw new RemoteError(`${t.url} is another instance now: connect it again`, true);
  const origin = { instance: await instanceId(), label: t.origin_label };
  const sentLuts = new Set<string>();

  if (t.everything && t.extras_sent === 0) {
    const n = (await sendAllLuts(remote, t.owner_id, sentLuts)) + (await sendPresets(remote, t.owner_id, origin));
    await db.query(sql`UPDATE transfers SET extras_sent = ${n} WHERE id = ${id}`);
  }

  for (;;) {
    const [state] = (await db.query(sql`SELECT status FROM transfers WHERE id = ${id}`)) as { status: string }[];
    if (state?.status !== 'running') return;
    const [item] = (await db.query(sql`
      SELECT version_id FROM transfer_items WHERE transfer_id = ${id} AND status = 'waiting'
      ORDER BY position LIMIT 1`)) as { version_id: string }[];
    if (!item) return;
    let status: string;
    let error: string | null = null;
    try {
      status = await sendVersion(remote, t.remote_id, there.editParamsVersion, t.owner_id, item.version_id, {
        origin,
        importId: id,
        sentLuts,
      });
    } catch (err) {
      if (err instanceof RemoteError && err.fatal) throw err;
      if (!(err instanceof RemoteError)) log.warn({ err, version: item.version_id }, 'could not send a version');
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }
    await db.query(sql`
      UPDATE transfer_items SET status = ${status}, error = ${error}
      WHERE transfer_id = ${id} AND version_id = ${item.version_id}`);
  }
}

interface SendContext {
  origin: { instance: string; label: string };
  /** This transfer's id: the other side shows what it brought as one import. */
  importId: string;
  /** LUTs sent already in this transfer. */
  sentLuts: Set<string>;
}

async function sendVersion(
  remote: Remote,
  remoteId: string,
  theirParamsVersion: number,
  ownerId: string,
  versionId: string,
  { origin, importId, sentLuts }: SendContext,
): Promise<string> {
  const [row] = (await db.query(sql`
    SELECT v.*, p.sha256, p.original_filename, p.storage_key, p.exif,
      p.camera_make, p.camera_model, p.lens, p.iso, p.exposure_time, p.f_number, p.focal_length,
      p.exposure_bias, p.captured_at, p.gps_latitude, p.gps_longitude, p.artist, p.copyright, p.file_modified_at,
      p.collection_id
    FROM versions v JOIN photos p ON p.id = v.photo_id
    WHERE v.id = ${versionId} AND p.owner_id = ${ownerId} AND v.trashed_at IS NULL`)) as (Versions & Photos)[];
  // Moved to the trash since: not sent.
  if (!row) return 'unchanged';
  const entries = (await db.query(sql`
    SELECT label, recipe, created_at FROM history_entries WHERE version_id = ${versionId} ORDER BY seq`)) as {
    label: string;
    recipe: EditParams;
    created_at: Date;
  }[];
  const newest = Math.max(0, ...entries.map((e) => e.recipe.version ?? 0));
  if (newest > theirParamsVersion)
    throw new RemoteError('Edited with a newer version of RAWtisserie than the other instance: update it first');

  const meta: SentVersion = {
    origin: { ...origin, id: versionId },
    importId,
    sha256: row.sha256,
    filename: row.original_filename,
    fileModifiedAt: row.file_modified_at?.getTime() ?? null,
    collection: row.collection_id ? await collectionPath(db, ownerId, row.collection_id) : null,
    patch: {
      versionName: row.name,
      title: row.title,
      description: row.description,
      rating: row.rating,
      flag: row.flag,
      colorLabel: row.color_label,
      tags: row.tags.filter((t): t is string => !!t),
      cameraMake: row.camera_make,
      cameraModel: row.camera_model,
      lens: row.lens,
      iso: row.iso,
      exposureTime: row.exposure_time,
      fNumber: row.f_number,
      focalLength: row.focal_length,
      exposureBias: row.exposure_bias,
      capturedAt: row.captured_at,
      gpsLatitude: row.gps_latitude,
      gpsLongitude: row.gps_longitude,
      artist: row.artist,
      copyright: row.copyright,
    },
    exif: (row.exif as Record<string, unknown> | null) ?? null,
    history: {
      end: row.history_end,
      entries: entries.map((e) => ({ label: e.label, recipe: e.recipe, createdAt: e.created_at })),
    },
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...meta, importId: null }))
    .digest('base64url');
  const [sent] = await db.query(sql`
    SELECT 1 FROM sent_versions WHERE remote_id = ${remoteId} AND version_id = ${versionId} AND fingerprint = ${fingerprint}`);
  if (sent) return 'unchanged';

  // The LUTs its recipes use, first: it renders with them as soon as it arrives.
  const luts = new Set(entries.flatMap((e) => lutIds(e.recipe)));
  for (const lutId of luts) await sendLut(remote, ownerId, lutId, sentLuts);

  let res = await postVersion(remote, meta, null);
  if (
    res.status === 409 &&
    (
      (await res
        .clone()
        .json()
        .catch(() => null)) as { needOriginal?: boolean }
    )?.needOriginal
  ) {
    const file = await storage.get(originalKey(row.storage_key));
    if (!file) throw new RemoteError('Its original file is missing here');
    res = await postVersion(remote, meta, file);
  }
  if (!res.ok) throw new RemoteError(await remoteError(res));
  const { status } = (await res.json()) as { status: 'created' | 'updated' };
  await db.query(sql`
    INSERT INTO sent_versions (remote_id, version_id, fingerprint) VALUES (${remoteId}, ${versionId}, ${fingerprint})
    ON CONFLICT (remote_id, version_id) DO UPDATE SET fingerprint = excluded.fingerprint`);
  return status;
}

/** `POST /api/transfer/versions` as multipart: `meta`, then the original (streamed) if given. */
function postVersion(remote: Remote, meta: SentVersion, file: Readable | null) {
  const boundary = `rawtisserie-${randomUUID()}`;
  async function* body() {
    yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n` +
        `Content-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n`,
    );
    if (file) {
      yield Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      );
      yield* file;
      yield Buffer.from('\r\n');
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }
  return remoteFetch(remote, '/api/transfer/versions', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Readable.toWeb(Readable.from(body())) as ReadableStream,
    // @ts-expect-error Node's fetch needs this for a streamed body.
    duplex: 'half',
    timeoutMs: file ? ORIGINAL_TIMEOUT_MS : undefined,
  });
}

/** A LUT the user has (built-in ones are there already), under the user's name for it. */
async function sendLut(remote: Remote, ownerId: string, lutId: string, sent: Set<string>) {
  if (sent.has(lutId) || isBuiltinLut(lutId)) return;
  sent.add(lutId);
  const [row] = (await db.query(sql`
    SELECT name FROM user_luts WHERE owner_id = ${ownerId} AND lut_id = ${lutId}`)) as { name: string }[];
  const packed = await readLut(lutId);
  // Not this user's, or its file is gone: the copy renders without it, as it does here.
  if (!row || !packed) return;
  const res = await remoteFetch(remote, `/api/transfer/luts?${new URLSearchParams({ name: row.name })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(packed),
  });
  if (!res.ok) throw new RemoteError(`The LUT “${row.name}”: ${await remoteError(res)}`);
}

async function sendAllLuts(remote: Remote, ownerId: string, sent: Set<string>): Promise<number> {
  const rows = (await db.query(sql`
    SELECT lut_id FROM user_luts WHERE owner_id = ${ownerId} AND hidden_at IS NULL`)) as { lut_id: string }[];
  let n = 0;
  for (const { lut_id } of rows) {
    if (sent.has(lut_id) || isBuiltinLut(lut_id)) continue;
    await sendLut(remote, ownerId, lut_id, sent);
    n++;
  }
  return n;
}

async function sendPresets(remote: Remote, ownerId: string, origin: SendContext['origin']): Promise<number> {
  const rows = (await db.query(sql`
    SELECT id, kind, module_kind, name, payload FROM presets WHERE owner_id = ${ownerId} ORDER BY created_at`)) as {
    id: string;
    kind: 'module' | 'style';
    module_kind: string | null;
    name: string;
    payload: Record<string, unknown>;
  }[];
  for (const p of rows) {
    const body: SentPreset = {
      origin: { ...origin, id: p.id },
      kind: p.kind,
      moduleKind: p.module_kind,
      name: p.name,
      payload: p.payload,
    };
    const res = await remoteFetch(remote, '/api/transfer/presets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new RemoteError(`The preset “${p.name}”: ${await remoteError(res)}`);
  }
  return rows.length;
}
