-- What an upload's version is called in the application it comes from (darktable's
-- version name), and darktable's duplicates of the photo: more versions to create with
-- it, each `{ tags, rating, label, flag, versionName, importedEdits }` (what its own
-- sidecar says).
ALTER TABLE uploads
  ADD COLUMN version_name text,
  ADD COLUMN duplicates jsonb;
