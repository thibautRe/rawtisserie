/** Save `blob` as a download called `filename`. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  // Long enough for the browser to start reading it, even for a large archive.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
