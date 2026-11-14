-- Imports as the library lists them (its sidebar): when each one began, and where it
-- came from when another instance sent it. Versions refer to them by `import_id`.
CREATE TABLE imports (
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The sending instance ("Sent from …"), for one received from another instance.
  source text,
  PRIMARY KEY (owner_id, id)
);

-- Imports made before this: when their first version was created.
INSERT INTO imports (owner_id, id, created_at)
SELECT p.owner_id, v.import_id, min(v.created_at)
FROM versions v JOIN photos p ON p.id = v.photo_id
WHERE v.import_id IS NOT NULL
GROUP BY p.owner_id, v.import_id;
