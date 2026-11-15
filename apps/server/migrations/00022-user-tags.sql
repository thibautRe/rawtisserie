-- Tags the user manages (the tag manager): created before any photo has them, or with a
-- keyboard shortcut that toggles them on the selection. Tags on photos are still the
-- versions' `tags`; a tag here is listed (and completed) even when no photo has it.
-- `shortcut`: the keys, as the app records them (a sequence of key presses).
CREATE TABLE user_tags (
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tag text NOT NULL,
  shortcut jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, tag)
);
