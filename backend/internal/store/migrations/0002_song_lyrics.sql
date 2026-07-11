-- Add a lyrics column to songs. Lyrics are the ID3 USLT frame: read on import,
-- editable in the tag editor, and baked back into the USLT frame on download.
ALTER TABLE songs ADD COLUMN lyrics TEXT;
