-- The recipe a new image starts with now auto-tunes filmic. Versions without history
-- render it: re-render their previews, which records it (auto-tuned) as their first entry.
UPDATE versions v SET render_status = 'pending', render_error = NULL
  WHERE NOT EXISTS (SELECT 1 FROM history_entries e WHERE e.version_id = v.id);
