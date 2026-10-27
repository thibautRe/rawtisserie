-- Edit params v2 replaced the sigmoid tone mapper with filmic: re-render every preview.
-- (Old recipes keep their other settings; their tone mapping now uses filmic defaults.)
UPDATE photos SET render_status = 'pending', render_error = NULL;
