package library

import (
	"strings"
	"unicode"
)

// genreSmallWords are English articles/conjunctions/short prepositions kept
// lowercase mid-genre. Mirrors the UI's SMALL["en"] set in ui/src/titleCase.ts so
// a genre reads identically in the app and in a downloaded file's ID3 tag.
var genreSmallWords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields("a an and as at but by en for if in nor of off on or per so the to up via vs yet") {
		m[w] = true
	}
	return m
}()

// GenreDisplay title-cases a canonically-lowercase genre for display, matching the
// UI's genreLabel: English title case with small words lowercased mid-phrase, and
// capitalization across '&', '-' and '/' joins ("r&b" → "R&B", "indie-rock" →
// "Indie-Rock"). Genres are stored lowercase; this is applied wherever a genre is
// surfaced to a human, including the ID3 tags baked into downloads.
func GenreDisplay(name string) string {
	words := strings.Fields(strings.ToLower(name))
	for i, w := range words {
		if genreSmallWords[w] && i != 0 && i != len(words)-1 {
			continue // small word mid-phrase stays lowercase
		}
		words[i] = capAcrossSeparators(w)
	}
	return strings.Join(words, " ")
}

// capAcrossSeparators uppercases the first letter of a word and the first letter
// following each '&', '-' or '/', skipping any leading punctuation.
func capAcrossSeparators(word string) string {
	rs := []rune(word)
	capNext := true
	for i, r := range rs {
		switch {
		case capNext && unicode.IsLetter(r):
			rs[i] = unicode.ToUpper(r)
			capNext = false
		case r == '&' || r == '-' || r == '/':
			capNext = true
		case unicode.IsLetter(r):
			capNext = false
		}
	}
	return string(rs)
}
