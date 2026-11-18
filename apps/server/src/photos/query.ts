/** Library filtering: query-string → SQL conditions over `versions v JOIN photos p` (trash left out). */
import { sql, type SQLQuery } from '@databases/pg';
import { z } from 'zod';
import { badRequest } from '../errors.ts';
import { collectionSubtree } from './collections.ts';
import { SEPARATOR } from './tags.ts';

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

/** `tagAny`'s name for the group of top-level tags (a tag's path is never empty). */
export const TOP_LEVEL = '|';

/** `collection`'s value for photos in no collection. */
export const NO_COLLECTION = 'none';

export const PhotoFilters = z.object({
  q: z.string().trim().optional(),
  camera: list,
  lens: list,
  /**
   * Tags a version must have (it or one under it: `People` finds `People|Alice`). They
   * go in groups by parent: all of a group's, unless its parent is in `tagAny` (any of
   * them; `TOP_LEVEL` for the top-level tags); every group must match.
   */
  tag: list,
  /**
   * Tags it must not have, nor any under them, except under the tags it must have:
   * `tag=People|Alice&notTag=People` is Alice and nobody else.
   */
  notTag: list,
  tagAny: list,
  /** Only versions without any tag. */
  untagged: z.enum(['true']).optional(),
  ratingMin: z.coerce.number().int().min(0).max(5).optional(),
  /** Any of these ratings (0: none). */
  rating: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : [v].flat()),
    z.array(z.coerce.number().int().min(0).max(5)).max(6).optional(),
  ),
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
  /**
   * Photos in any of these collections (or under one), `none` for those in none
   * (`collections.ts`).
   */
  collection: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : [v].flat()),
    z
      .array(z.union([z.uuid(), z.literal(NO_COLLECTION)]))
      .max(500)
      .optional(),
  ),
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
  c.push(...tagConditions(f));
  if (f.untagged) c.push(sql`cardinality(v.tags) = 0`);
  if (f.colorLabel?.length) c.push(sql`v.color_label = ANY(${f.colorLabel})`);
  if (f.ratingMin) c.push(sql`v.rating >= ${f.ratingMin}`);
  if (f.rating?.length) c.push(sql`v.rating = ANY(${f.rating}::int[])`);
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
  if (f.collection?.length) {
    const ids = f.collection.filter((id) => id !== NO_COLLECTION);
    const either = [
      ...(ids.length ? [sql`p.collection_id IN ${collectionSubtree(ownerId, ids)}`] : []),
      ...(f.collection.includes(NO_COLLECTION) ? [sql`p.collection_id IS NULL`] : []),
    ];
    c.push(sql`(${sql.join(either, sql` OR `)})`);
  }
  return sql.join(c, sql` AND `);
}

const parentOf = (tag: string) => {
  const at = tag.lastIndexOf(SEPARATOR);
  return at < 0 ? TOP_LEVEL : tag.slice(0, at);
};
const isUnder = (tag: string, parent: string) => tag.startsWith(`${parent}${SEPARATOR}`);
/** `t` (in scope) is one of `tags` or under one of them. */
const inAny = (tags: string[]) =>
  sql`(t = ANY(${tags}::text[]) OR EXISTS (SELECT 1 FROM unnest(${tags}::text[]) i WHERE starts_with(t, i || ${SEPARATOR})))`;

/** The tag filters (roadmap 8.12): see `PhotoFilters.tag` and `notTag`. */
export function tagConditions(f: PhotoFilters): SQLQuery[] {
  const c: SQLQuery[] = [];
  const included = [...new Set(f.tag ?? [])];
  const groups = new Map<string, string[]>();
  for (const tag of included) groups.set(parentOf(tag), [...(groups.get(parentOf(tag)) ?? []), tag]);
  const any = new Set(f.tagAny ?? []);
  for (const [parent, tags] of groups) {
    const each = any.has(parent) ? [tags] : tags.map((t) => [t]);
    for (const set of each) c.push(sql`EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE ${inAny(set)})`);
  }
  for (const tag of new Set(f.notTag ?? [])) {
    // The tags asked for under it stay allowed.
    const kept = included.filter((t) => isUnder(t, tag));
    c.push(sql`NOT EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE ${inAny([tag])}
      ${kept.length ? sql`AND NOT ${inAny(kept)}` : sql``})`);
  }
  return c;
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

/** The filters of a library query string, checked: only the filters' keys, in a stable order. */
export function normalizeFilterQuery(query: string): string {
  const params = new URLSearchParams(query);
  const kept = new URLSearchParams();
  for (const key of Object.keys(PhotoFilters.shape)) for (const v of params.getAll(key)) if (v) kept.append(key, v);
  const fields: Record<string, string[]> = {};
  for (const key of new Set(kept.keys())) fields[key] = kept.getAll(key);
  const parsed = PhotoFilters.safeParse(
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.length > 1 ? v : v[0]])),
  );
  if (!parsed.success) throw badRequest('These filters can’t be read');
  return kept.toString();
}
