/** Library filtering: query-string → SQL conditions. */
import type { SQLQuery } from '@databases/pg';
import { z } from 'zod';
import { sql } from '../db.ts';

const list = z.preprocess((v) => (v === undefined || v === '' ? undefined : [v].flat()), z.array(z.string()).optional());
const num = z.coerce.number().optional();

export const PhotoFilters = z.object({
  q: z.string().trim().optional(),
  camera: list,
  lens: list,
  tag: list,
  ratingMin: z.coerce.number().int().min(0).max(5).optional(),
  flag: z.enum(['picked', 'rejected', 'unflagged', 'notRejected']).optional(),
  colorLabel: list,
  isoMin: num,
  isoMax: num,
  focalMin: num,
  focalMax: num,
  apertureMin: num,
  apertureMax: num,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  edited: z.enum(['true', 'false']).optional(),
});
export type PhotoFilters = z.infer<typeof PhotoFilters>;

export const SORTS = {
  capturedDesc: sql`captured_at DESC NULLS LAST, id`,
  capturedAsc: sql`captured_at ASC NULLS LAST, id`,
  importedDesc: sql`created_at DESC, id`,
  ratingDesc: sql`rating DESC, captured_at DESC NULLS LAST, id`,
  filename: sql`original_filename, id`,
} as const;

export const PhotoListQuery = PhotoFilters.extend({
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS]).default('capturedDesc'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export function whereClause(ownerId: string, f: PhotoFilters): SQLQuery {
  const c: SQLQuery[] = [sql`owner_id = ${ownerId}`];
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(sql`(original_filename ILIKE ${like} OR title ILIKE ${like} OR description ILIKE ${like}
      OR camera_model ILIKE ${like} OR lens ILIKE ${like} OR ${f.q} = ANY(tags))`);
  }
  if (f.camera?.length) c.push(sql`camera_model = ANY(${f.camera})`);
  if (f.lens?.length) c.push(sql`lens = ANY(${f.lens})`);
  if (f.tag?.length) c.push(sql`tags @> ${f.tag}`);
  if (f.colorLabel?.length) c.push(sql`color_label = ANY(${f.colorLabel})`);
  if (f.ratingMin) c.push(sql`rating >= ${f.ratingMin}`);
  if (f.flag === 'picked' || f.flag === 'rejected') c.push(sql`flag = ${f.flag}`);
  if (f.flag === 'unflagged') c.push(sql`flag IS NULL`);
  if (f.flag === 'notRejected') c.push(sql`flag IS DISTINCT FROM 'rejected'`);
  if (f.isoMin !== undefined) c.push(sql`iso >= ${f.isoMin}`);
  if (f.isoMax !== undefined) c.push(sql`iso <= ${f.isoMax}`);
  if (f.focalMin !== undefined) c.push(sql`focal_length >= ${f.focalMin}`);
  if (f.focalMax !== undefined) c.push(sql`focal_length <= ${f.focalMax}`);
  if (f.apertureMin !== undefined) c.push(sql`f_number >= ${f.apertureMin}`);
  if (f.apertureMax !== undefined) c.push(sql`f_number <= ${f.apertureMax}`);
  if (f.from) c.push(sql`captured_at >= ${f.from}`);
  if (f.to) c.push(sql`captured_at <= ${f.to}`);
  if (f.edited === 'true') c.push(sql`edit_params IS NOT NULL`);
  if (f.edited === 'false') c.push(sql`edit_params IS NULL`);
  return sql.join(c, sql` AND `);
}
