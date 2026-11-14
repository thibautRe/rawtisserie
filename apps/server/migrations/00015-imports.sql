-- Imports (roadmap 8.2): the versions an import created, so the library can show that
-- import alone; and the files deleted for good, by hash only (nothing else of them is
-- kept), so importing them again is skipped unless asked for.
ALTER TABLE versions ADD COLUMN import_id uuid;
CREATE INDEX versions_import_idx ON versions (import_id) WHERE import_id IS NOT NULL;

CREATE TABLE deleted_originals (
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  PRIMARY KEY (owner_id, sha256)
);
