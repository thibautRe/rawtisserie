import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ExportPreset, type ExportSettings, normalizeExportSettings } from '@rawtisserie/pipeline';
import { currentUser, requireUser } from '../auth/routes.ts';
import { db, exportPresets, sql, users } from '../db.ts';
import { conflict, notFound } from '../errors.ts';
import type ExportPresets from '../__generated__/export_presets.ts';
import { MAX_COUNT, checkCount } from '../limits.ts';

const Id = z.object({ id: z.uuid() });
const Name = z.string().trim().min(1).max(200);
const UNIQUE_VIOLATION = '23505';

function presetDto(row: ExportPresets): ExportPreset {
  return { id: row.id, name: row.name, settings: normalizeExportSettings(row.settings) };
}

/**
 * Export settings (roadmap 8.5): the user's last ones, so that the next export starts
 * from them on any device, and named export presets. Settings are normalised both
 * ways, so older or partial ones read as current ones.
 */
export async function exportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** The last settings (null before the first export) and the presets. */
  app.get('/api/export-settings', async (request) => {
    const user = currentUser(request);
    const [row] = await users(db).find({ id: user.id }).select('export_settings').all();
    const presets = await exportPresets(db).find({ owner_id: user.id }).orderByAsc('name').all();
    const settings: ExportSettings | null = row?.export_settings ? normalizeExportSettings(row.export_settings) : null;
    return { settings, presets: presets.map(presetDto) };
  });

  app.put('/api/export-settings', async (request) => {
    const user = currentUser(request);
    const { settings } = z.object({ settings: z.unknown() }).parse(request.body);
    const normalized = normalizeExportSettings(settings);
    await users(db).update({ id: user.id }, { export_settings: normalized });
    return { settings: normalized };
  });

  /** Saving under a name the user already has replaces that preset. */
  app.post('/api/export-presets', async (request, reply) => {
    const user = currentUser(request);
    const input = z.object({ name: Name, settings: z.unknown() }).parse(request.body);
    const settings = normalizeExportSettings(input.settings);
    const [{ others }] = (await db.query(sql`
      SELECT count(*)::int AS others FROM export_presets WHERE owner_id = ${user.id} AND name <> ${input.name}`)) as [
      { others: number },
    ];
    checkCount(others, MAX_COUNT.exportPresets, 'export presets');
    const [row] = (await db.query(sql`
      INSERT INTO export_presets (owner_id, name, settings)
      VALUES (${user.id}, ${input.name}, ${JSON.stringify(settings)}::jsonb)
      ON CONFLICT (owner_id, name)
      DO UPDATE SET settings = excluded.settings, updated_at = now()
      RETURNING *`)) as ExportPresets[];
    return reply.code(201).send(presetDto(row!));
  });

  app.patch('/api/export-presets/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const { name } = z.object({ name: Name }).parse(request.body);
    const rows = await db
      .query(
        sql`
          UPDATE export_presets SET name = ${name}, updated_at = now()
          WHERE id = ${id} AND owner_id = ${user.id}
          RETURNING *`,
      )
      .catch((err: { code?: string }) => {
        throw err.code === UNIQUE_VIOLATION ? conflict(`There is already an export preset named “${name}”`) : err;
      });
    const [row] = rows as ExportPresets[];
    if (!row) throw notFound('Export preset not found');
    return presetDto(row);
  });

  app.delete('/api/export-presets/:id', async (request) => {
    const user = currentUser(request);
    const { id } = Id.parse(request.params);
    const deleted = await db.query(
      sql`DELETE FROM export_presets WHERE id = ${id} AND owner_id = ${user.id} RETURNING id`,
    );
    if (!deleted.length) throw notFound('Export preset not found');
    return { ok: true };
  });
}
