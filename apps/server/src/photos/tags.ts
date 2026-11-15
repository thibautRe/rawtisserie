/**
 * Tags are paths: levels separated by `|`, as XMP's `lr:hierarchicalSubject` has them
 * (`People|Gwen`, shown as People › Gwen). A version's tags are its `tags` array; a tag
 * counts under each of its ancestors (filters, counts), without them being stored.
 */
import { z } from 'zod';
import { sql } from '../db.ts';

export const SEPARATOR = '|';

/** A tag as typed: its levels trimmed, empty ones dropped. */
export const normalizeTag = (tag: string) =>
  tag
    .split(SEPARATOR)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(SEPARATOR);

export const Tag = z
  .string()
  .transform(normalizeTag)
  .pipe(
    z
      .string()
      .min(1)
      .max(300)
      .refine((t) => t.split(SEPARATOR).every((l) => l.length <= 100), 'A tag level is at most 100 characters'),
  );

/**
 * Each level of tag `t` (in scope, from `unnest(… ) t`) as `n`: `People`, `People|Gwen`.
 * Use as a lateral join.
 */
export const TAG_LEVELS = sql`LATERAL (
  SELECT array_to_string((string_to_array(t, '|'))[1:i], '|') AS n
  FROM generate_series(1, cardinality(string_to_array(t, '|'))) i
) levels`;
