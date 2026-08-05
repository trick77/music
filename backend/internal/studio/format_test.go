package studio

import (
	"strings"
	"testing"
)

func TestFormatLyrics_insertsBlankLineBeforeEachTagSection(t *testing.T) {
	in := "[Verse]\nline one\nline two\n[Chorus]\nhook line\n[Bridge]\nbridge line"
	want := "[Verse]\nline one\nline two\n\n[Chorus]\nhook line\n\n[Bridge]\nbridge line"
	if got := formatLyrics(in); got != want {
		t.Fatalf("formatLyrics =\n%q\nwant\n%q", got, want)
	}
}

func TestFormatLyrics_noBlankLineBeforeLeadingTag(t *testing.T) {
	if got := formatLyrics("[Intro]\nsoft"); got != "[Intro]\nsoft" {
		t.Fatalf("leading tag must not get a blank line: %q", got)
	}
}

func TestFormatLyrics_doesNotDoubleBlankLines(t *testing.T) {
	// A section already separated by a blank line stays single-spaced.
	in := "[Verse]\nwords\n\n[Chorus]\nhook"
	want := "[Verse]\nwords\n\n[Chorus]\nhook"
	if got := formatLyrics(in); got != want {
		t.Fatalf("formatLyrics =\n%q\nwant\n%q", got, want)
	}
}

func TestFormatLyrics_normalizesCRLF(t *testing.T) {
	if got := formatLyrics("[Verse]\r\nline\r\n[Chorus]\r\nhook"); got != "[Verse]\nline\n\n[Chorus]\nhook" {
		t.Fatalf("CRLF not normalized: %q", got)
	}
}

// The prompts ask for one or two short delivery cues stacked directly under a
// section header. Splitting those apart with a blank line would read as two
// separate sections, so only the first tag of a run opens one.
func TestFormatLyrics_keepsStackedCueTagsWithTheirSection(t *testing.T) {
	in := "[Verse 1]\n[Whispered Vocals]\nyou left your sweater by the door\n[Chorus]\n[Layered Harmonies]\nhook line"
	want := "[Verse 1]\n[Whispered Vocals]\nyou left your sweater by the door\n\n[Chorus]\n[Layered Harmonies]\nhook line"
	if got := formatLyrics(in); got != want {
		t.Fatalf("formatLyrics =\n%q\nwant\n%q", got, want)
	}
}

func TestSanitizeStylePrompt_flattensStripsTagsAndDedupes(t *testing.T) {
	// Structure tags, newlines, spaced commas, and a case-insensitive dup all get
	// normalized to a single flat comma-joined line with no spaces after commas.
	in := "[Verse] thrash metal, fast tempo\n[Chorus] aggressive, Thrash Metal, raspy vocals"
	want := "thrash metal,fast tempo,aggressive,raspy vocals"
	if got := sanitizeStylePrompt(in); got != want {
		t.Fatalf("sanitizeStylePrompt =\n%q\nwant\n%q", got, want)
	}
}

// A "no humming" token was once force-appended to every style prompt. Negation
// primes Suno toward the thing it names — it hummed more often with the token
// than without — so nothing is appended now and the reply passes through as-is.
func TestSanitizeStylePrompt_appendsNoNegative(t *testing.T) {
	if got := sanitizeStylePrompt("dream pop,dreamy"); got != "dream pop,dreamy" {
		t.Fatalf("sanitizeStylePrompt =\n%q\nwant\n%q", got, "dream pop,dreamy")
	}
}

func TestSanitizeStylePrompt_capsAt500WithoutCuttingMidDescriptor(t *testing.T) {
	// Build well over 500 chars of unique descriptors; the result must stay within
	// the cap and never end on a truncated word.
	parts := make([]string, 0, 60)
	for i := 0; i < 60; i++ {
		parts = append(parts, "descriptor-"+strings.Repeat("x", 10)+string(rune('a'+i%26))+string(rune('0'+i/26)))
	}
	got := sanitizeStylePrompt(strings.Join(parts, ","))
	if len(got) > 500 {
		t.Fatalf("style prompt exceeds 500 chars: %d", len(got))
	}
	for _, d := range strings.Split(got, ",") {
		if !strings.HasPrefix(d, "descriptor-") {
			t.Fatalf("descriptor cut mid-word: %q", d)
		}
	}
}
