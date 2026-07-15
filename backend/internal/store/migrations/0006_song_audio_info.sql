-- Audio properties for the tag editor's Info tab: sample rate, channel count and
-- average bitrate. All three are intrinsic to the stored file, so they ride the
-- song payload like duration_ms rather than living behind the /stats endpoint
-- (which is play data).
--
-- Nullable with no default on purpose. A SQL migration cannot read the MP3s, so
-- existing rows land NULL and are filled by the backfill in library/audio_info.go
-- on the next start. NULL is also the permanent resting state for a file we can't
-- decode — the UI renders "—", exactly as duration already degrades.
ALTER TABLE songs ADD COLUMN sample_rate INTEGER;
ALTER TABLE songs ADD COLUMN channels INTEGER;
ALTER TABLE songs ADD COLUMN bitrate_kbps INTEGER;
