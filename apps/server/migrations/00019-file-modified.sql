-- When the original file was last modified, as the browser saw it at import (on a
-- memory card, when the shot was written). With its name and size, it tells an import
-- which files it has already without hashing them. Unknown for files imported before.
ALTER TABLE photos ADD COLUMN file_modified_at timestamptz;
CREATE INDEX photos_owner_filename_idx ON photos (owner_id, original_filename) INCLUDE (file_size, file_modified_at);
