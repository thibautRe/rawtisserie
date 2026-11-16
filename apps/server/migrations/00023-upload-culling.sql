-- What a file says about itself (roadmap 8.11): tags, rating, colour label and flag read
-- on import from its XMP or IPTC, its sidecars, or the JPEG next to a RAW file. The
-- version the upload creates starts with them.
ALTER TABLE uploads
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN rating smallint NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  ADD COLUMN flag text CHECK (flag IN ('picked', 'rejected')),
  ADD COLUMN color_label text CHECK (color_label IN ('red', 'yellow', 'green', 'blue', 'purple'));
