-- Saved library filters: a name for a set of filters, applied like a module preset.
-- `query` is the library's query string (as in its address, `/api/versions`'), without
-- the sort. Tag renames and deletions in the tag manager follow into it.
CREATE TABLE filter_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  query text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- saving under an existing name replaces that preset
  UNIQUE (owner_id, name)
);
