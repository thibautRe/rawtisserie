-- Sending versions, presets, styles and LUTs to another instance (one user's library,
-- from one server to another). See apps/server/src/transfer/.

-- This instance's identity: what its copies on other instances say they came from.
CREATE TABLE instance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  single boolean NOT NULL DEFAULT true UNIQUE CHECK (single)
);
INSERT INTO instance DEFAULT VALUES;

-- Receiving: tokens a user creates here and gives to another instance, which can then
-- add to their library (only that: `/api/transfer/…`). Stored hashed.
CREATE TABLE access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX access_tokens_owner_idx ON access_tokens (owner_id);

-- A received version or preset remembers where it came from, so sending it again
-- updates it. `origin_revision`: this copy's revision right after it was last received
-- (moved since: it was edited here too).
ALTER TABLE versions
  ADD COLUMN origin_instance uuid,
  ADD COLUMN origin_version uuid,
  ADD COLUMN origin_revision integer;
CREATE INDEX versions_origin_idx ON versions (origin_instance, origin_version) WHERE origin_instance IS NOT NULL;
ALTER TABLE presets
  ADD COLUMN origin_instance uuid,
  ADD COLUMN origin_preset uuid;

-- Sending: the instances a user connected (their URL and a token from there), what was
-- sent to each (to skip what hasn't changed), and the transfers, run by the server.
CREATE TABLE remote_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  url text NOT NULL,
  token text NOT NULL,
  -- What it said when connected: its identity, and the account the token is for.
  remote_id uuid NOT NULL,
  remote_account text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, url)
);

CREATE TABLE sent_versions (
  remote_id uuid NOT NULL REFERENCES remote_instances (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  -- A digest of what was sent: unchanged, it isn't sent again.
  fingerprint text NOT NULL,
  PRIMARY KEY (remote_id, version_id)
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  remote_id uuid NOT NULL REFERENCES remote_instances (id) ON DELETE CASCADE,
  -- Everything (versions, presets, styles, LUTs), or the versions listed in its items.
  everything boolean NOT NULL,
  -- How this instance is called in "Sent from …" (the address the user sent from).
  origin_label text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  -- Why it stopped, when it failed as a whole (the other instance refused the token…).
  error text,
  -- Presets, styles and LUTs, sent with "everything".
  extras_sent integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX transfers_owner_idx ON transfers (owner_id, created_at DESC);

CREATE TABLE transfer_items (
  transfer_id uuid NOT NULL REFERENCES transfers (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  position integer NOT NULL,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'created', 'updated', 'unchanged', 'failed')),
  error text,
  PRIMARY KEY (transfer_id, version_id)
);
CREATE INDEX transfer_items_waiting_idx ON transfer_items (transfer_id, position) WHERE status = 'waiting';
