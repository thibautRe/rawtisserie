/**
 * Cross-origin isolation, in report-only mode: what would break if the app sent
 * `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
 * require-corp` (needed for shared memory, i.e. wasm threads; roadmap P.5). Browsers
 * enforce nothing but report each violation to `/api/reports`, which logs it.
 *
 * The headers go on every response: worker scripts carry their own embedder policy, not
 * just pages. Vite's dev and preview servers send the same (`apps/web/vite.config.ts`).
 */
import type { FastifyInstance } from 'fastify';
import { RATE_LIMITS } from './limits.ts';

export const REPORT_PATH = '/api/reports';
const ENDPOINT = 'isolation';

export const ISOLATION_REPORT_ONLY_HEADERS: Readonly<Record<string, string>> = {
  'Reporting-Endpoints': `${ENDPOINT}="${REPORT_PATH}"`,
  'Cross-Origin-Opener-Policy-Report-Only': `same-origin; report-to="${ENDPOINT}"`,
  'Cross-Origin-Embedder-Policy-Report-Only': `require-corp; report-to="${ENDPOINT}"`,
};

/** Reports kept from one request: browsers batch them. */
const MAX_REPORTS = 20;

const text = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined);

const originOf = (url: unknown) => {
  try {
    return typeof url === 'string' ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/**
 * Reports that only report-only mode produces. A dedicated worker must itself *enforce*
 * an embedder policy compatible with its page's; ours only send the report-only header,
 * so every worker of our own origin is reported ("worker initialization"). Once
 * enforced, they send `require-corp` like every response here, and load.
 */
function onlyFromReportOnly(report: { url?: unknown; body?: Record<string, unknown> }): boolean {
  const body = report.body ?? {};
  const page = originOf(report.url);
  return body.type === 'worker initialization' && page !== null && originOf(body.blockedURL) === page;
}

export async function isolationReports(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(ISOLATION_REPORT_ONLY_HEADERS)) reply.header(name, value);
  });

  // The Reporting API posts a JSON array as `application/reports+json`.
  app.addContentTypeParser(
    'application/reports+json',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, []);
      }
    },
  );

  /** Log what isolation would block. Public (reports come without credentials), so keep it terse. */
  app.post(
    REPORT_PATH,
    { bodyLimit: 64 * 1024, config: { rateLimit: RATE_LIMITS.reports } },
    async (request, reply) => {
      const reports = Array.isArray(request.body) ? request.body.slice(0, MAX_REPORTS) : [];
      for (const report of reports as { type?: unknown; url?: unknown; body?: Record<string, unknown> }[]) {
        if (!report || onlyFromReportOnly(report)) continue;
        const body = report.body ?? {};
        request.log.warn(
          {
            isolationReport: {
              type: text(report.type, 50),
              page: text(report.url),
              disposition: text(body.disposition, 20),
              // COEP: what was blocked, and why (`corp`, `navigation`, `worker initialization`).
              blocked: text(body.blockedURL),
              destination: text(body.destination, 50),
              // COOP: which kind of opener or popup access broke.
              violation: text(body.violationType ?? body.type, 50),
              other: text(body.previousResponseURL ?? body.nextResponseURL ?? body.openerURL ?? body.openeeURL),
            },
          },
          'cross-origin isolation would block this',
        );
      }
      return reply.code(204).send();
    },
  );
}
