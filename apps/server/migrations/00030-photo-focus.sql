-- Where a photo is in focus (roadmap 8.9): the sharpness map the pipeline measures on
-- its sensor data (`FocusMap`), with the version of the measure. Measured when the
-- photo is rendered or first zoomed into; NULL until then.
ALTER TABLE photos
  ADD COLUMN focus jsonb;
