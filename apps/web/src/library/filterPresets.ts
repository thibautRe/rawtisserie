import { describeRating, describeTags } from './tagFilter.ts';

/** The library's query string without its sort: the filters a preset saves. */
export function filtersOf(params: URLSearchParams): string {
  const kept = new URLSearchParams(params);
  kept.delete('sort');
  return kept.toString();
}

/** The same filters, whatever their order. */
export function sameFilters(a: string, b: string): boolean {
  const pairs = (q: string) =>
    [...new URLSearchParams(q)]
      .filter(([k, v]) => k !== 'sort' && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .sort();
  const [x, y] = [pairs(a), pairs(b)];
  return x.length === y.length && x.every((p, i) => p === y[i]);
}

/** The library's address with `query`'s filters, keeping its sort. */
export function withFilters(params: URLSearchParams, query: string): URLSearchParams {
  const next = new URLSearchParams(query);
  next.delete('sort');
  const sort = params.get('sort');
  if (sort) next.set('sort', sort);
  return next;
}

const FLAG_NAMES: Record<string, string> = { picked: 'picked', rejected: 'rejected', unflagged: 'unflagged' };

/** What a preset's filters are, in a few words: `★ 3+ · picked · People › Alice`. */
export function describeFilters(query: string): string {
  const p = new URLSearchParams(query);
  const parts: string[] = [];
  const q = p.get('q');
  if (q) parts.push(`“${q}”`);
  const rating = describeRating(p);
  if (rating) parts.push(rating);
  const flags = p.getAll('flag');
  if (flags.length) parts.push(flags.map((f) => FLAG_NAMES[f] ?? f).join(' or '));
  const labels = p.getAll('colorLabel');
  if (labels.length) parts.push(labels.join(' or '));
  if (p.get('edited') === 'true') parts.push('edited');
  if (p.get('edited') === 'false') parts.push('not edited');
  if (p.get('untagged') === 'true') parts.push('no tags');
  parts.push(...describeTags(p));
  if (p.has('from') || p.has('to')) parts.push('dates');
  parts.push(...p.getAll('camera'), ...p.getAll('lens'));
  if (p.has('isoMin') || p.has('isoMax')) parts.push('ISO');
  if (p.has('focalMin') || p.has('focalMax')) parts.push('focal length');
  if (p.has('apertureMin') || p.has('apertureMax')) parts.push('aperture');
  const collections = p.getAll('collection').filter((c) => c !== 'none').length;
  if (collections) parts.push(collections === 1 ? 'a collection' : `${collections} collections`);
  if (p.getAll('collection').includes('none')) parts.push('no collection');
  const imports = p.getAll('import').length;
  if (imports) parts.push(imports === 1 ? 'an import' : `${imports} imports`);
  return parts.join(' · ');
}
