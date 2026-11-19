-- Edits made in another application (a darktable or Ansel XMP sidecar), sent with the
-- upload: `uploads` keeps them until the file is taken in, `versions` for good. The render
-- queue turns them into the history entry after the starting one (`startingHistory` in
-- packages/pipeline), and the developer shows how the import went while it's current.
ALTER TABLE uploads ADD COLUMN imported_edits text;
ALTER TABLE versions ADD COLUMN imported_edits text;
