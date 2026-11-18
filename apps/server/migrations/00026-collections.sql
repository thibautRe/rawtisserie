-- Collections (roadmap 8.14): where a photo comes from, a tree like folders (one per day
-- of shooting, a wedding, a trip). A photo is in one collection or none, its versions
-- with it. Names are unique among siblings, so a path of names (`2026` › `2026-11-09`)
-- finds one: imports and transfers reuse the collections they name.
CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Deleting a collection deletes those under it (their photos stay, in no collection).
  parent_id uuid REFERENCES collections (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collections_sibling_names UNIQUE NULLS NOT DISTINCT (owner_id, parent_id, name)
);
CREATE INDEX collections_parent_idx ON collections (parent_id);

ALTER TABLE photos ADD COLUMN collection_id uuid REFERENCES collections (id) ON DELETE SET NULL;
CREATE INDEX photos_collection_idx ON photos (collection_id);

-- The collection an upload goes to, as a path of names from the top (created if needed
-- when it's taken in).
ALTER TABLE uploads ADD COLUMN collection text[];
