-- Renders that failed are tried again (render/queue.ts): a few times, spaced out, for
-- what passes (storage, a worker that ran out of memory), and once more by each new
-- build, for what a deploy fixes (a file missing from the image, a pipeline bug).
-- `render_attempts`: failures in a row (0 once rendered); `render_retry_at`: when to try
-- again, null when it won't be until the next build; `render_failed_build`: the build
-- that last failed it (`RAWTISSERIE_REVISION`).
ALTER TABLE versions
  ADD COLUMN render_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN render_retry_at timestamptz,
  ADD COLUMN render_failed_build text;
CREATE INDEX versions_render_retry_idx ON versions (render_retry_at) WHERE render_status = 'failed';
