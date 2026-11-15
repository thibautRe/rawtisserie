-- Uploads in progress (roadmap 8.2): sent in chunks to a file on local disk
-- (`STORAGE_DIR/tmp/uploads/<id>`), so an interrupted one resumes where it stopped, and
-- taken in once complete. Those left untouched for a day are deleted with their file.
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filename text NOT NULL,
  size bigint NOT NULL,
  file_modified_at timestamptz,
  import_id uuid,
  allow_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_updated_at_idx ON uploads (updated_at);
