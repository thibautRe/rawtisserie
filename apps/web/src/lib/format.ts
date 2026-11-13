export { formatExposureTime } from '@rawtisserie/pipeline';

export const formatAperture = (f: number | null | undefined) => (f ? `ƒ/${Number(f.toFixed(1))}` : null);
export const formatFocal = (mm: number | null | undefined) => (mm ? `${Math.round(mm)} mm` : null);
export const formatIso = (iso: number | null | undefined) => (iso ? `ISO ${iso}` : null);
export const formatBias = (ev: number | null | undefined) =>
  ev == null ? null : `${ev > 0 ? '+' : ev < 0 ? '−' : '±'}${Math.abs(Number(ev.toFixed(1)))} EV`;

/** Sizes are in units of 1024: a GB is 1024³ bytes (quotas too). */
export const GB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** "0.8 s", "42 s", "3 min 20 s", "2 h 5 min". */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** `Date` → value for `<input type="datetime-local">`, in local time. */
export function toDateTimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const RAW_ACCEPT =
  '.3fr,.ari,.arw,.cr2,.cr3,.crw,.dcr,.dcs,.dng,.erf,.fff,.iiq,.kdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.ori,.pef,.raf,.raw,.rw2,.rwl,.sr2,.srf,.srw,.x3f';

/** "B&W", or "Version 2" for an unnamed version. */
export const versionLabel = (v: { name: string | null; index: number }) => v.name ?? `Version ${v.index}`;
