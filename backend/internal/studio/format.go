package studio

import "strings"

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
