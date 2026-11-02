-- Edit params v6: the base image is balanced for D65 light and colour calibration (CAT16,
-- "as shot") does the white balance, replacing warmth/tint. Every image looks a little
-- different: re-render every preview. (Recipes are migrated when they're read.)
UPDATE versions SET render_status = 'pending', render_error = NULL;
