export { formatExposureTime } from '@rawtisserie/pipeline';

export const formatAperture = (f: number | null | undefined) => (f ? `ƒ/${Number(f.toFixed(1))}` : null);
export const formatFocal = (mm: number | null | undefined) => (mm ? `${Math.round(mm)} mm` : null);
export const formatIso = (iso: number | null | undefined) => (iso ? `ISO ${iso}` : null);
export const formatBias = (ev: number | null | undefined) =>
  ev == null ? null : `${ev > 0 ? '+' : ev < 0 ? '−' : '±'}${Math.abs(Number(ev.toFixed(1)))} EV`;

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
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
