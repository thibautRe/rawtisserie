-- Storage quotas, admins and invitations (roadmap 7.5).
--
-- A quota counts the user's original files (`photos.file_size`); renders and LUTs
-- don't count. NULL is unlimited, which is what existing accounts get.

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the secret in the invitation link
  code text NOT NULL UNIQUE CHECK (length(code) >= 16),
  -- for the admins: who it's for
  label text CHECK (length(label) <= 200),
  -- accounts it may still create, of how many
  max_uses integer NOT NULL CHECK (max_uses >= 1),
  uses integer NOT NULL DEFAULT 0 CHECK (uses BETWEEN 0 AND max_uses),
  -- quota of the accounts it creates, in bytes; NULL: unlimited
  storage_quota bigint CHECK (storage_quota >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN storage_quota bigint CHECK (storage_quota >= 0),
  -- the invitation the account was created with
  ADD COLUMN invitation_id uuid REFERENCES invitations (id) ON DELETE SET NULL;

-- Usage is summed per owner on every upload and in the admin's list.
CREATE INDEX photos_owner_size_idx ON photos (owner_id) INCLUDE (file_size);
