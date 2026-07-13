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

	// Suno tends to inject unwanted wordless humming, so the style prompt must
	// always end with the "no humming" negative. A prompt can't guarantee the
	// model emits it, so enforce it here: append the token unless it is already
	// present, dropping trailing descriptors if needed to stay within the cap.
	const noHumming = "no humming"
	if !seen[noHumming] {
		for len(out) > 0 && length+len(noHumming)+1 > 500 {
			last := out[len(out)-1]
			out = out[:len(out)-1]
			length -= len(last)
			if len(out) > 0 {
				length-- // the comma that had joined it
			}
		}
		out = append(out, noHumming)
	}
	return strings.Join(out, ",")
}

// formatLyrics normalizes line endings and inserts a blank line before each Suno
// structure/meta tag section (a line that is exactly "[...]"), except a leading
// one — so sections read clearly. It never doubles an existing blank separator.
// Applied server-side so the copied text and the display share one formatting.
func formatLyrics(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines)+4)
	for i, line := range lines {
		if isTagLine(line) && i > 0 && len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
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
