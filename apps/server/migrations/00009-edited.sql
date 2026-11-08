-- "Edited" no longer counts the history entry a new upload starts with (the recipe it
-- gets automatically, labelled 'Lens correction (auto)'): a version is edited when its
-- current entry is past that one. Kept up to date by the history routes.
ALTER TABLE versions ADD COLUMN edited boolean NOT NULL DEFAULT false;

UPDATE versions v SET edited = v.history_end > 1 OR (v.history_end = 1 AND NOT EXISTS (
  SELECT 1 FROM history_entries h WHERE h.version_id = v.id AND h.seq = 1 AND h.label = 'Lens correction (auto)'));
