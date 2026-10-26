CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  -- sha256 of the session token; the token itself only lives in the cookie
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- original file (immutable)
  original_filename text NOT NULL,
  storage_key text NOT NULL,
  file_size bigint NOT NULL,
  sha256 text NOT NULL,

  -- indexed metadata: extracted from EXIF on import, editable afterwards
  camera_make text,
  camera_model text,
  lens text,
  iso integer,
  exposure_time double precision,
  f_number real,
  focal_length real,
  exposure_bias real,
  captured_at timestamptz,
  width integer,
  height integer,
  gps_latitude double precision,
  gps_longitude double precision,
  artist text,
  copyright text,

  -- library curation
  title text,
  description text,
  rating smallint NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  flag text CHECK (flag IN ('picked', 'rejected')),
  color_label text CHECK (color_label IN ('red', 'yellow', 'green', 'blue', 'purple')),
  tags text[] NOT NULL DEFAULT '{}',

  -- metadata exactly as extracted from the file, for reference
  exif jsonb,

  -- development recipe (see packages/pipeline/src/params.ts)
  edit_params jsonb,
  edited_at timestamptz,

  -- rendered previews
  render_status text NOT NULL DEFAULT 'pending' CHECK (render_status IN ('pending', 'ready', 'failed')),
  render_error text,
  render_version integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX photos_owner_sha256_key ON photos (owner_id, sha256);
CREATE INDEX photos_owner_captured_idx ON photos (owner_id, captured_at DESC NULLS LAST, id);
CREATE INDEX photos_owner_created_idx ON photos (owner_id, created_at DESC, id);
CREATE INDEX photos_owner_camera_idx ON photos (owner_id, camera_model);
CREATE INDEX photos_owner_lens_idx ON photos (owner_id, lens);
CREATE INDEX photos_tags_idx ON photos USING gin (tags);
CREATE INDEX photos_render_pending_idx ON photos (created_at) WHERE render_status = 'pending';
