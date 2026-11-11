-- The blur and sharpen (unsharp mask) modules are gone: diffuse or sharpen replaces them.
-- Their instances are dropped when recipes are read, without migrating them, so versions
-- whose current recipe uses them look different: re-render those previews. Module presets
-- of the retired kinds can't be applied any more (styles drop the instances like recipes).
UPDATE versions v SET render_status = 'pending', render_error = NULL
  FROM history_entries h
  WHERE h.version_id = v.id AND h.seq = v.history_end
    AND jsonb_path_exists(h.recipe, '$.modules[*] ? (@.kind == "blur" || @.kind == "sharpen")');
DELETE FROM presets WHERE kind = 'module' AND module_kind IN ('blur', 'sharpen');
