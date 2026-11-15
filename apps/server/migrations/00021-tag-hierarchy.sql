-- Tags are paths (roadmap: tag hierarchy): levels separated by `|`, as XMP's
-- `lr:hierarchicalSubject` has them (`People|Gwen`). Tags written with `/` before (as
-- digiKam shows them) become paths; from now on only `|` separates levels, so a name
-- may contain `/`. Levels are trimmed, empty ones dropped. Trashed versions too.
UPDATE versions SET tags = ARRAY(
  SELECT DISTINCT n FROM (
    SELECT array_to_string(array_remove(ARRAY(SELECT btrim(l) FROM unnest(string_to_array(t, '/')) l), ''), '|') AS n
    FROM unnest(tags) t
  ) x WHERE n <> '' ORDER BY 1
)
WHERE EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE '%/%');
