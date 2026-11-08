-- The recipe new images start with now has colour balance's "Colorfulness: standard",
-- and colour balance's ranges have new defaults (fulcrum -1 EV, mid-tones 3 EV,
-- fall-offs 4 EV). Saved recipes keep their values; only versions at the original
-- (no history, or undone to it) render the new default: re-render those.
UPDATE versions SET render_status = 'pending', render_error = NULL WHERE history_end = 0;
