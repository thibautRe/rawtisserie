/** Library filtering: query-string → SQL conditions over `versions v JOIN photos p`. */
import type { SQLQuery } from '@databases/pg';
import { z } from 'zod';
import { sql } from '../db.ts';

const list = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : [v].flat()),
  z.array(z.string()).optional(),
);
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

/**
 * Capture times tie within a burst: many cameras (Sony's) record whole seconds only. The
 * file name's counter orders those, in the same direction as the date.
 */
export const SORTS = {
  capturedDesc: sql`p.captured_at DESC NULLS LAST, p.original_filename DESC, p.id, v.position, v.id`,
  capturedAsc: sql`p.captured_at ASC NULLS LAST, p.original_filename, p.id, v.position, v.id`,
  importedDesc: sql`p.created_at DESC, p.original_filename DESC, p.id, v.position, v.id`,
  ratingDesc: sql`v.rating DESC, p.captured_at DESC NULLS LAST, p.original_filename DESC, p.id, v.position, v.id`,
  filename: sql`p.original_filename, p.id, v.position, v.id`,
} as const;

export const PhotoListQuery = PhotoFilters.extend({
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS]).default('capturedDesc'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export function whereClause(ownerId: string, f: PhotoFilters): SQLQuery {
  const c: SQLQuery[] = [sql`p.owner_id = ${ownerId}`];
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(sql`(p.original_filename ILIKE ${like} OR v.name ILIKE ${like} OR v.title ILIKE ${like}
      OR v.description ILIKE ${like} OR p.camera_model ILIKE ${like} OR p.lens ILIKE ${like} OR ${f.q} = ANY(v.tags))`);
  }
  if (f.camera?.length) c.push(sql`p.camera_model = ANY(${f.camera})`);
  if (f.lens?.length) c.push(sql`p.lens = ANY(${f.lens})`);
  if (f.tag?.length) c.push(sql`v.tags @> ${f.tag}`);
  if (f.colorLabel?.length) c.push(sql`v.color_label = ANY(${f.colorLabel})`);
  if (f.ratingMin) c.push(sql`v.rating >= ${f.ratingMin}`);
  if (f.flag === 'picked' || f.flag === 'rejected') c.push(sql`v.flag = ${f.flag}`);
  if (f.flag === 'unflagged') c.push(sql`v.flag IS NULL`);
  if (f.flag === 'notRejected') c.push(sql`v.flag IS DISTINCT FROM 'rejected'`);
  if (f.isoMin !== undefined) c.push(sql`p.iso >= ${f.isoMin}`);
  if (f.isoMax !== undefined) c.push(sql`p.iso <= ${f.isoMax}`);
  if (f.focalMin !== undefined) c.push(sql`p.focal_length >= ${f.focalMin}`);
  if (f.focalMax !== undefined) c.push(sql`p.focal_length <= ${f.focalMax}`);
  if (f.apertureMin !== undefined) c.push(sql`p.f_number >= ${f.apertureMin}`);
  if (f.apertureMax !== undefined) c.push(sql`p.f_number <= ${f.apertureMax}`);
  if (f.from) c.push(sql`p.captured_at >= ${f.from}`);
  if (f.to) c.push(sql`p.captured_at <= ${f.to}`);
  if (f.edited === 'true') c.push(sql`v.history_end > 0`);
  if (f.edited === 'false') c.push(sql`v.history_end = 0`);
  return sql.join(c, sql` AND `);
}
