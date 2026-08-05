package studio

import (
	"regexp"
	"strings"
)

// bracketTag matches a Suno meta/structure tag like "[Verse]" or "[Guitar Solo]"
// anywhere in a string, so it can be stripped out of the style prompt.
var bracketTag = regexp.MustCompile(`\[[^\]]*\]`)

// sanitizeStylePrompt forces the style prompt into the single flat comma-joined
// line Suno's "Style" box expects, since a prompt can't guarantee the model obeys
// (mirrors formatLyrics/sanitizeList). It strips any Suno meta/structure tags that
// leaked in (those belong only in the lyrics), collapses newlines, de-duplicates
// descriptors case-insensitively, joins with "," (no space after commas), and caps
// the result at 500 characters.
func sanitizeStylePrompt(s string) string {
	s = bracketTag.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\n", ",")

	seen := map[string]bool{}
	out := make([]string, 0)
	length := 0
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key := strings.ToLower(part)
		if seen[key] {
			continue
		}
		// Cap at 500 chars by dropping whole descriptors, never cutting mid-word.
		next := len(part)
		if len(out) > 0 {
			next++ // the joining comma
		}
		if length+next > 500 {
			break
		}
		seen[key] = true
		out = append(out, part)
		length += next
	}
	// No negative is appended here. A "no humming" token used to be forced onto
	// every style prompt, but negation primes Suno toward the very thing it names
	// and it hummed more often with the token than without. Exclusions belong in
	// Suno's separate Exclude field, which this pipeline deliberately leaves to
	// the user; the style prompt now carries no negatives at all.
	return strings.Join(out, ",")
}

// formatLyrics normalizes line endings and inserts a blank line before each Suno
// structure/meta tag section (a line that is exactly "[...]"), except a leading
// one — so sections read clearly. It never doubles an existing blank separator.
// Applied server-side so the copied text and the display share one formatting.
//
// A tag directly under another tag gets NO blank line: the prompts ask for one or
// two short delivery cues stacked under a section header ("[Verse 1]" then
// "[Whispered Vocals]"), and splitting those apart would read as two sections.
// Only the first tag of a run opens a new section.
func formatLyrics(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines)+4)
	for i, line := range lines {
		prevIsTag := len(out) > 0 && isTagLine(out[len(out)-1])
		if isTagLine(line) && i > 0 && len(out) > 0 && !prevIsTag && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "")
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// isTagLine reports whether a trimmed line is a single Suno tag like "[Chorus]".
func isTagLine(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") && len(t) > 2
}
