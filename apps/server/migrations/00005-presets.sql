-- Presets (roadmap 4.2): named parameters for one module kind, and styles (a chosen set
-- of module instances). Built-in presets ship with the app and aren't stored here.

CREATE TABLE presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('module', 'style')),
  -- the module kind of a module preset (`ModuleKind`); null for a style
  module_kind text CHECK ((kind = 'module') = (module_kind IS NOT NULL)),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- a module preset: { version, params } (some or all of the module's parameters);
  -- a style: { version, modules } (module instances without ids).
  -- See packages/pipeline/src/presets.ts.
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- saving under an existing name replaces that preset
  UNIQUE NULLS NOT DISTINCT (owner_id, kind, module_kind, name)
);
