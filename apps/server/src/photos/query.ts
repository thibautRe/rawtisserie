/** Library filtering: query-string → SQL conditions over `versions v JOIN photos p` (trash left out). */
import { sql, type SQLQuery } from '@databases/pg';
import { z } from 'zod';

const list = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : [v].flat()),
  z.array(z.string()).optional(),
);
const num = z.coerce.number().optional();
const FLAGS = ['picked', 'rejected', 'unflagged'] as const;
/** The flags to show (any combination; none: all). `notRejected`, from older links: picked or unflagged. */
const flags = z.preprocess(
  (v) =>
    v === undefined || v === ''
      ? undefined
      : [v].flat().flatMap((f) => (f === 'notRejected' ? ['picked', 'unflagged'] : [f])),
  z.array(z.enum(FLAGS)).optional(),
);

export const PhotoFilters = z.object({
  q: z.string().trim().optional(),
  camera: list,
  lens: list,
  tag: list,
  ratingMin: z.coerce.number().int().min(0).max(5).optional(),
  flag: flags,
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
  /** The versions some imports created (`versions.import_id`). */
  import: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : [v].flat()),
    z.array(z.uuid()).max(100).optional(),
  ),
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
  const c: SQLQuery[] = [sql`p.owner_id = ${ownerId}`, sql`v.trashed_at IS NULL`];
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(sql`(p.original_filename ILIKE ${like} OR v.name ILIKE ${like} OR v.title ILIKE ${like}
      OR v.description ILIKE ${like} OR p.camera_model ILIKE ${like} OR p.lens ILIKE ${like}
      OR EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE t ILIKE ${like}))`);
  }
  if (f.camera?.length) c.push(sql`p.camera_model = ANY(${f.camera})`);
  if (f.lens?.length) c.push(sql`p.lens = ANY(${f.lens})`);
  // Each tag asked for, or one under it (`People` finds `People|Alice`).
  for (const tag of f.tag ?? [])
    c.push(sql`EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE t = ${tag} OR starts_with(t, ${`${tag}|`}))`);
  if (f.colorLabel?.length) c.push(sql`v.color_label = ANY(${f.colorLabel})`);
  if (f.ratingMin) c.push(sql`v.rating >= ${f.ratingMin}`);
  if (f.flag?.length && !FLAGS.every((flag) => f.flag!.includes(flag))) {
    const set = f.flag.filter((flag) => flag !== 'unflagged');
    c.push(f.flag.includes('unflagged') ? sql`(v.flag IS NULL OR v.flag = ANY(${set}))` : sql`v.flag = ANY(${set})`);
  }
  if (f.isoMin !== undefined) c.push(sql`p.iso >= ${f.isoMin}`);
  if (f.isoMax !== undefined) c.push(sql`p.iso <= ${f.isoMax}`);
  if (f.focalMin !== undefined) c.push(sql`p.focal_length >= ${f.focalMin}`);
  if (f.focalMax !== undefined) c.push(sql`p.focal_length <= ${f.focalMax}`);
  if (f.apertureMin !== undefined) c.push(sql`p.f_number >= ${f.apertureMin}`);
  if (f.apertureMax !== undefined) c.push(sql`p.f_number <= ${f.apertureMax}`);
  if (f.from) c.push(sql`p.captured_at >= ${f.from}`);
  if (f.to) c.push(sql`p.captured_at <= ${f.to}`);
  if (f.edited === 'true') c.push(sql`v.edited`);
  if (f.edited === 'false') c.push(sql`NOT v.edited`);
  if (f.import?.length) c.push(sql`v.import_id = ANY(${f.import})`);
  return sql.join(c, sql` AND `);
}

/** The library's own query string (filters and sort, as in its address), parsed like `/api/versions`'s. */
export function parseLibraryQuery(query: string) {
  const params = new URLSearchParams(query);
  const fields: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    fields[key] = values.length > 1 ? values : values[0]!;
  }
  return PhotoListQuery.omit({ limit: true, offset: true }).parse(fields);
}

/**
 * What a library action applies to (roadmap 8.13): versions by id, or every version the
 * library's filters match (its query string), but those unticked by hand since. Resolved
 * on the server in the same query as the action, so the browser never lists them all.
 */
export const Target = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(5000) }),
  z.object({ filter: z.string().max(20_000), except: z.array(z.uuid()).max(5000).default([]) }),
]);
export type Target = z.infer<typeof Target>;

/**
 * The target's versions among the owner's outside the trash: a condition over
 * `versions v JOIN photos p` (`VERSIONS_FROM`).
 */
export function targetClause(ownerId: string, target: Target): SQLQuery {
  if ('ids' in target)
    return sql`p.owner_id = ${ownerId} AND v.trashed_at IS NULL AND v.id = ANY(${target.ids}::uuid[])`;
  return sql`${whereClause(ownerId, parseLibraryQuery(target.filter))} AND v.id <> ALL(${target.except}::uuid[])`;
}
