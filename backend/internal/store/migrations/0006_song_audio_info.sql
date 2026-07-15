-- Audio properties for the tag editor's Info tab: sample rate, channel count and
-- average bitrate. All three are intrinsic to the stored file, so they ride the
-- song payload like duration_ms rather than living behind the /stats endpoint
-- (which is play data).
--
-- Nullable with no default on purpose. A SQL migration cannot read the MP3s, so
-- existing rows land NULL and are filled by the backfill in
-- httpapi/audio_backfill.go on the next start (its queries live in
-- library/audio_info.go).
--
-- NULL vs 0 carries meaning, and the backfill depends on it:
--   NULL = not measured yet — still pending, retried on the next start.
--   0    = measured, unknowable (the file won't decode) — settled, never retried.
-- Both render "—" in the UI, exactly as duration already degrades.
ALTER TABLE songs ADD COLUMN sample_rate INTEGER;
ALTER TABLE songs ADD COLUMN channels INTEGER;
ALTER TABLE songs ADD COLUMN bitrate_kbps INTEGER;
