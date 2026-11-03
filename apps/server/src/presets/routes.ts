import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MODULE_KINDS,
  PRESET_KINDS,
  type ModuleKind,
  type Preset,
  normalizeModulePreset,
  normalizeStyle,
} from '@rawtisserie/pipeline';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, presets, sql } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type Presets from '../__generated__/presets.ts';

const Id = z.object({ id: z.uuid() });
const UNIQUE_VIOLATION = '23505';

/** Saving a preset under a name the user already has (for that kind) replaces it. */
const PresetInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('module'),
    moduleKind: z.enum(MODULE_KINDS).refine((k) => PRESET_KINDS.includes(k), 'No presets for this module'),
    name: z.string().trim().min(1).max(200),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('style'),
    name: z.string().trim().min(1).max(200),
    payload: z.unknown(),
  }),
]);

function presetDto(row: Presets): Preset {
  const base = { id: row.id, name: row.name, builtIn: false };
  return row.kind === 'module'
    ? {
        ...base,
        type: 'module',
        moduleKind: row.module_kind!,
        payload: normalizeModulePreset(row.module_kind!, row.payload),
      }
    : { ...base, type: 'style', moduleKind: null, payload: normalizeStyle(row.payload) };
}

/** The user's own presets and styles. Built-in ones live in the app (`BUILTIN_PRESETS`). */
export async function presetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/presets', async (request) => {
    const rows = await presets(db)
      .find({ owner_id: currentUser(request).id })
      .orderByAsc('name')
      .all();
    return { presets: rows.map(presetDto) };
  });

  app.post('/api/presets', async (request, reply) => {
    const user = currentUser(request);
    const input = PresetInput.parse(request.body);
    const moduleKind: ModuleKind | null = input.type === 'module' ? input.moduleKind : null;
    const payload = moduleKind ? normalizeModulePreset(moduleKind, input.payload) : normalizeStyle(input.payload);
    const empty = 'params' in payload ? Object.keys(payload.params).length === 0 : payload.modules.length === 0;
    if (empty) throw badRequest(moduleKind ? 'A preset needs at least one parameter' : 'A style needs a module');
    const [row] = (await db.query(sql`
      INSERT INTO presets (owner_id, kind, module_kind, name, payload)
      VALUES (${user.id}, ${input.type}, ${moduleKind}, ${input.name}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (owner_id, kind, module_kind, name)
      DO UPDATE SET payload = excluded.payload, updated_at = now()
      RETURNING *`)) as Presets[];
    return reply.code(201).send(presetDto(row!));
  });

  app.patch('/api/presets/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).parse(request.body);
    const rows = await db
      .query(
        sql`
          UPDATE presets SET name = ${name}, updated_at = now()
          WHERE id = ${id} AND owner_id = ${user.id}
          RETURNING *`,
      )
      .catch((err: { code?: string }) => {
        throw err.code === UNIQUE_VIOLATION ? conflict(`There is already a preset named “${name}”`) : err;
      });
    const [row] = rows as Presets[];
    if (!row) throw notFound('Preset not found');
    return presetDto(row);
  });

  app.delete('/api/presets/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const deleted = await db.query(sql`DELETE FROM presets WHERE id = ${id} AND owner_id = ${user.id} RETURNING id`);
    if (!deleted.length) throw notFound('Preset not found');
    return { ok: true };
  });
}
