-- Export options (roadmap 8.5): each user's last export settings, and named export
-- presets. Both hold `ExportSettings` (packages/pipeline/src/export.ts), normalised on
-- the way in and out.

ALTER TABLE users ADD COLUMN export_settings jsonb;

CREATE TABLE export_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- saving under an existing name replaces that preset
  UNIQUE (owner_id, name)
);
