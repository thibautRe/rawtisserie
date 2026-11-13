-- The trash (roadmap 7.3): deleting from the library sets `trashed_at` instead of
-- deleting. Trashed versions can be restored for 30 days, then the server deletes them
-- for good (`photos/trash.ts`), and a photo left without versions with its original.
-- A photo's original counts towards the quota while any of its versions exists.

ALTER TABLE versions ADD COLUMN trashed_at timestamptz;

CREATE INDEX versions_trashed_idx ON versions (trashed_at) WHERE trashed_at IS NOT NULL;
