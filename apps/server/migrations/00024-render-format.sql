-- Renders as AVIF (roadmap 7.11): the format a version's stored renders are in, since
-- renders made before stay JPEG until the version is rendered again.
ALTER TABLE versions
  ADD COLUMN render_format text NOT NULL DEFAULT 'jpeg' CHECK (render_format IN ('jpeg', 'avif'));
