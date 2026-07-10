package studio

import "testing"

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
