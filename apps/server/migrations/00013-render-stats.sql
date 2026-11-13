-- How the render queue fares over time (admin overview), one row per hour. Written by
-- the server (`render/stats.ts`), which merges into the row: peaks are maxima, counts
-- are added up. "Pending" is waiting or rendering; "wait" is from being queued (or the
-- server's start, for renders left over from before it) to the render starting.

CREATE TABLE render_stats (
  hour timestamptz PRIMARY KEY CHECK (hour = date_trunc('hour', hour)),
  peak_pending integer NOT NULL DEFAULT 0,
  max_wait_ms integer NOT NULL DEFAULT 0,
  renders integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  -- of renders that succeeded
  render_ms bigint NOT NULL DEFAULT 0,
  max_render_ms integer NOT NULL DEFAULT 0
);
