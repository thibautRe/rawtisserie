/**
 * Loads the repo's `.env` for `npm run dev` (`--import`), like `--env-file-if-exists`.
 * Not that flag: with it, Node's watch mode also watches the env file's folder,
 * recursively, so the whole repo (`data/` included) restarted the server, and writing a
 * render restarted it before the render was saved, forever.
 */
try {
  process.loadEnvFile(new URL('../../../../.env', import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
