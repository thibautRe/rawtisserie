/** File names in a library export. */

/** `name`, or with -2, -3… before its extension until `taken` says no. */
export function uniqueName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The archive's name: the app and when it was exported (local time), and what it is (`retry`). */
export function archiveName(at: Date, what?: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `rawtisserie-${date}-${time}${what ? `-${what}` : ''}.zip`;
}
