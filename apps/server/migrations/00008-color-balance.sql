-- Edit params v7: colour balance replaces the colour (saturation/vibrance) and
-- shadows/highlights modules. Their instances become colour balance instances when
-- recipes are read, with an approximate look: re-render every preview. Module presets of
-- the retired kinds can't be applied any more (styles are migrated like recipes).
UPDATE versions SET render_status = 'pending', render_error = NULL;
DELETE FROM presets WHERE kind = 'module' AND module_kind IN ('color', 'shadowsHighlights');
