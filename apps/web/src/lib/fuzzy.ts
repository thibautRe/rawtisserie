/**
 * Fuzzy matching for short labels (tags): forgiving of case, accents and typos.
 * Better matches score higher; `null` when a candidate doesn't match at all.
 */

/** Lower case, without accents or surrounding space. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** Optimal string alignment distance: insertions, deletions, substitutions and swapped neighbours cost 1. */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = (rows[i] = [i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        row[j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      row[j] = d;
    }
  }
  return rows[a.length]![b.length]!;
}

/** How many typos a query of this length may have. */
const typosAllowed = (length: number) => (length < 3 ? 0 : length < 6 ? 1 : 2);

function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const c of text) if (c === query[i]) i++;
  return i === query.length;
}

/** Scores `candidate` against an already folded `query`. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const text = fold(candidate);
  if (!query) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 900;
  // At the start of a later word: "york" finds "new york".
  if (text.split(/[\s\-_/.]+/).some((w) => w.startsWith(query))) return 800;
  if (text.includes(query)) return 700;
  // Typos: compared with the candidate's start, a letter shorter or longer too.
  const allowed = typosAllowed(query.length);
  if (allowed) {
    let best = Infinity;
    for (let n = query.length - 1; n <= query.length + 1; n++) {
      if (n > 0 && n <= text.length) best = Math.min(best, editDistance(query, text.slice(0, n)));
    }
    if (best <= allowed) return 600 - 100 * best;
  }
  if (query.length >= 2 && isSubsequence(query, text)) return 300;
  return null;
}

/**
 * The candidates matching `query`, best first (then by `weight`, e.g. how often
 * they're used, then alphabetically), at most `limit` of them.
 */
export function fuzzyFilter<T>(
  query: string,
  candidates: readonly T[],
  { key, weight, limit = 8 }: { key: (c: T) => string; weight?: (c: T) => number; limit?: number },
): T[] {
  const q = fold(query);
  return candidates
    .flatMap((c) => {
      const score = fuzzyScore(q, key(c));
      return score == null ? [] : [{ c, score, weight: weight?.(c) ?? 0 }];
    })
    .sort((a, b) => b.score - a.score || b.weight - a.weight || key(a.c).localeCompare(key(b.c)))
    .slice(0, limit)
    .map((m) => m.c);
}
