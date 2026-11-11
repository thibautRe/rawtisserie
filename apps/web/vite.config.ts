import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Cross-origin isolation, report-only, as the server sends it in production
 * (`apps/server/src/isolation.ts`, which logs the reports).
 */
const ISOLATION_REPORT_ONLY_HEADERS = {
  'Reporting-Endpoints': 'isolation="/api/reports"',
  'Cross-Origin-Opener-Policy-Report-Only': 'same-origin; report-to="isolation"',
  'Cross-Origin-Embedder-Policy-Report-Only': 'require-corp; report-to="isolation"',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: ISOLATION_REPORT_ONLY_HEADERS,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', xfwd: true } },
  },
  preview: { headers: ISOLATION_REPORT_ONLY_HEADERS },
  worker: { format: 'es' },
  // The wasm-bindgen glue must not be pre-bundled or its `new URL(..., import.meta.url)` breaks.
  optimizeDeps: { exclude: ['@rawtisserie/pipeline'] },
});
