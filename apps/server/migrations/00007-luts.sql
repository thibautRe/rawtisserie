-- Creative LUTs (roadmap 4.8). A LUT's table is stored once, as a file named by its id
-- (the SHA-256 of its canonical form, see crates/pipeline/src/ops/clut.rs), however
-- many users uploaded it; each user's copy is a `user_luts` row with their name for it.
-- Built-in LUTs ship with the app (packages/pipeline/luts/) and aren't stored here.

CREATE TABLE luts (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  -- nodes along each axis
  size smallint NOT NULL CHECK (size BETWEEN 2 AND 144),
  bit_depth smallint NOT NULL CHECK (bit_depth IN (8, 16)),
  -- of the stored (packed) file
  file_size integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_luts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- no cascade: tables nobody has any more are removed with their file (`collectLuts`)
  lut_id text NOT NULL REFERENCES luts (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- removed from the user's list; the row stays so that recipes using it keep rendering
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- uploading a LUT again brings the same row back
  UNIQUE (owner_id, lut_id)
);

-- names are unique among the LUTs a user sees
CREATE UNIQUE INDEX user_luts_owner_name_key ON user_luts (owner_id, name) WHERE hidden_at IS NULL;
CREATE INDEX user_luts_lut_id_idx ON user_luts (lut_id);
