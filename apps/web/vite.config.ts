import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', xfwd: true } },
  },
  worker: { format: 'es' },
  // The wasm-bindgen glue must not be pre-bundled or its `new URL(..., import.meta.url)` breaks.
  optimizeDeps: { exclude: ['@rawtisserie/pipeline'] },
});
