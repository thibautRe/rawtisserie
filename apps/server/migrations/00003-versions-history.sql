-- Split "the file" (photos) from "an edit of the file" (versions, like darktable
-- duplicates). Each version has a linear history of full recipe snapshots.

CREATE TABLE versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id uuid NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  -- display name of a duplicate ("B&W"); null for the unnamed first version
  name text,
  -- order among the versions of the same photo
  position integer NOT NULL DEFAULT 0,

  -- library curation (per version, so variants can be culled separately)
  title text,
  description text,
  rating smallint NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  flag text CHECK (flag IN ('picked', 'rejected')),
  color_label text CHECK (color_label IN ('red', 'yellow', 'green', 'blue', 'purple')),
  tags text[] NOT NULL DEFAULT '{}',

  -- history: entries 1..history_end are applied; 0 means the original (no edits).
  -- Entries after history_end are kept until the next edit truncates them.
  history_end integer NOT NULL DEFAULT 0 CHECK (history_end >= 0),
  -- bumped on every history change, for optimistic concurrency
  revision integer NOT NULL DEFAULT 0,
  edited_at timestamptz,

  -- rendered previews
  render_status text NOT NULL DEFAULT 'pending' CHECK (render_status IN ('pending', 'ready', 'failed')),
  render_error text,
  render_version integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX versions_photo_idx ON versions (photo_id, position);
CREATE INDEX versions_tags_idx ON versions USING gin (tags);
CREATE INDEX versions_render_pending_idx ON versions (created_at) WHERE render_status = 'pending';

CREATE TABLE history_entries (
  version_id uuid NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- short description of the change ("exposure +0.3 EV")
  label text NOT NULL,
  -- full recipe snapshot (see packages/pipeline/src/params.ts)
  recipe jsonb NOT NULL,
  PRIMARY KEY (version_id, seq)
);

-- One version per existing photo. It reuses the photo's id, so rendered files
-- (stored by id) and existing links keep working.
INSERT INTO versions (id, photo_id, title, description, rating, flag, color_label, tags, history_end, edited_at,
                      render_status, render_error, render_version, created_at, updated_at)
SELECT id, id, title, description, rating, flag, color_label, tags, CASE WHEN edit_params IS NULL THEN 0 ELSE 1 END,
       edited_at, render_status, render_error, render_version, created_at, updated_at
FROM photos;

INSERT INTO history_entries (version_id, seq, created_at, label, recipe)
SELECT id, 1, coalesce(edited_at, updated_at), 'Edit', edit_params
FROM photos WHERE edit_params IS NOT NULL;

DROP INDEX photos_tags_idx;
DROP INDEX photos_render_pending_idx;
ALTER TABLE photos
  DROP COLUMN title,
  DROP COLUMN description,
  DROP COLUMN rating,
  DROP COLUMN flag,
  DROP COLUMN color_label,
  DROP COLUMN tags,
  DROP COLUMN edit_params,
  DROP COLUMN edited_at,
  DROP COLUMN render_status,
  DROP COLUMN render_error,
  DROP COLUMN render_version;
