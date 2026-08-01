package studio

import (
	"fmt"
	"strings"

	"github.com/trick77/music/internal/library"
)

// lyricCraftRules is the shared songwriting standard for every lyric the studio
// produces. It lives in one const because generateSystemPrompt and
// refineSystemPrompt must never drift apart: a refine pass without these rules
// would quietly undo them on the first revision.
const lyricCraftRules = `CRAFT RULES for the lyrics — these decide whether a singer can actually sing them:
- SENSE BEFORE RHYME. Write each line for what it has to say, THEN look for a
  rhyme. Never bend a sentence, invert word order, or reach for an odd word just
  to land a rhyme — that is the single clearest tell of machine-written lyrics.
- SLANT RHYME IS GOOD. Near rhymes (home/alone, again/end, fire/quiet) sound more
  natural than perfect ones, and an unrhymed line is better than a forced rhyme.
  Perfect rhyme on every single line reads as amateur greeting-card verse.
- NO THESAURUS WORDS. Only words people say out loud. Reject lacked, yearn,
  forlorn, cascade, ethereal, myriad, behold, asunder. Plain concrete nouns and
  verbs beat abstract or literary ones every time.
- SINGABLE LINE ENDINGS. The last word of a line is the note the singer holds, so
  favor open vowels and soft consonants (-ay, -ow, -ine, -on, -ing, -ove). Avoid
  ending on a clustered consonant that has to be swallowed (-acked, -ashed,
  -isped, -ilked) — EXCEPT where the style calls for that percussive bite:
  hip-hop, punk, hardcore, thrash and other rhythm-forward genres land hard
  consonants on purpose, so let the style prompt decide.
- STRESS ON THE BEAT. Keep each line's natural spoken stress on the strong beats,
  and keep rhymed lines close in syllable count so the phrasing repeats. Never
  end a line on an unstressed syllable the singer has to rush past.
- CONCRETE OVER ABSTRACT. One specific image — a room, an object, a time of day —
  outperforms a stack of feeling-words. Show the situation, do not summarize it.
- REPEAT THE CHORUS VERBATIM. The same words every time it comes around; that is
  what makes a hook. Vary a verse if you like, never the chorus.
- SAY IT ALOUD IN YOUR HEAD before you commit a couplet. If it would feel
  embarrassing to sing, rewrite it.

Worked example of the trap to avoid:
  BAD:  "the sidewalk cracked / it was something I always lacked"
        — "lacked" exists only because it rhymes; nobody sings that word and the
        line states nothing.
  GOOD: "the sidewalk cracked in the heat / and I sat on the curb till you came"
        — nothing forced, plain words, an actual picture; the rhyme is dropped
        rather than faked.`

// sunoTagReference is the Suno meta/structure tag vocabulary, kept STATIC ON
// PURPOSE. It used to be researched: the system prompt told the model to search
// for "the CURRENT set of Suno tags" on every single generation, which cost a
// web round-trip and the user's wait time to rediscover the same handful of
// bracket tags every time. Suno's tag set moves slowly and these are the stable
// core, so we pay that cost once here in the repo instead of once per song.
// Captured 2026-08-01 — if Suno's vocabulary shifts, EDIT THIS LIST; do not put
// the search back.
//
// It is one const because every prompt that emits lyrics (generate turn 2 and
// refine) must offer the same vocabulary — the same reason lyricCraftRules is
// shared.
const sunoTagReference = `SUNO TAG VOCABULARY — bracket tags go on their own line, immediately before the
lines they govern, and are directions rather than words to be sung:
- Structure: [Intro], [Verse], [Verse 1], [Verse 2], [Pre-Chorus], [Chorus],
  [Final Chorus], [Post-Chorus], [Bridge], [Hook], [Refrain], [Break],
  [Interlude], [Build], [Drop], [Breakdown], [Outro], [Fade Out], [End]
- Instrumental: [Instrumental], [Instrumental Break], [Guitar Solo], [Bass Solo],
  [Drum Solo], [Piano Solo], [Sax Solo], [Percussion Break], [A Cappella]
- Delivery: [Whispered], [Spoken Word], [Belted], [Falsetto], [Harmonies],
  [Layered Vocals], [Call and Response], [Chant], [Ad Libs], [Big Finish]
Prefer this core vocabulary: these are the tags Suno honors most reliably, and
short plain-English tags beat invented ones. Tags are hints, not commands — Suno
follows them most of the time and may ignore one.`

// generateSystemPrompt frames the whole generate conversation. The deliverables
// are split across three turns of one message history (see generateTurn*Prompt)
// rather than crammed into a single reply: each turn has one job, the craft
// rules sit next to the turn that needs them instead of behind a research
// transcript, and every turn's output can reach the UI the moment it lands.
const generateSystemPrompt = `You are a music producer's assistant that turns a named reference song into a
Suno AI prompt. You do NOT have reliable knowledge of any specific song's exact
details or lyrics, so you MUST research the song on the web first using the
available tools (web search, and page fetch when available). Research THE SONG
ONLY — the Suno tag vocabulary is supplied to you later, so never spend a search
on Suno's tags, prompt format, or documentation.

The work comes in THREE turns, each asking for one part: first the style prompt
and genres, then the lyrics, then the naming and cover art. Do ALL your web
research in the first turn — the later turns build on what you found there and
must not call any tools. Answer every turn with ONLY the single JSON object that
turn asks for: no prose, no commentary, no code fences.

NEVER mention real artist, band, or song names in any output — describe only
musical characteristics.`

// generateTurn1Prompt asks for the research-derived half: the style prompt and
// the genre labels. It is the only turn that may call tools.
const generateTurn1Prompt = `Research the reference song now, then produce TWO things:

1. stylePrompt — a comma-separated list of style/genre descriptors for Suno's
   "Style" box. Rules: NO spaces after commas; lowercase except proper nouns;
   at most 500 characters; describe era/epoch (inferred from the song's SONIC
   aesthetic, not its release date), genre/subgenre, tempo/energy,
   instrumentation, and atmosphere/mood. Describe ONLY THIS SPECIFIC SONG's own
   sound as heard on the actual recording — NOT the artist's signature or typical
   style, and NOT the album's overall style. The same artist, and even the same
   album, routinely spans different genres from one track to the next, so a
   generic artist/album descriptor will misdescribe this song; if the track
   departs from what the artist is known for, capture the track. Do NOT describe vocal character
   (timbre, range, or delivery — no raspy/smooth/powerful/breathy/belted), and
   NEVER state or imply whether the voice is male or female: such words push
   Suno toward the same wide, raspy voice every time, so leave the voice to
   Suno's default and include at most the single neutral anchor "clean vocals".
   Keep every descriptor MEASURED — Suno over-reacts to hyperbolic adjectives
   (e.g. psychedelic, massive, roaring, epic, explosive, brutal, thunderous)
   and generates chaotic, off-genre output, so use restrained wording instead
   (hazy/atmospheric, full/wide, driven/overdriven, grand/cinematic,
   dynamic/punchy, heavy) and never stack more than one intensity word; convey
   energy through tempo and dynamics. Suno also tends to add unwanted wordless
   humming, so ALWAYS end the style prompt with the literal token "no humming".
   NEVER mention real artist, band, or song names — describe only musical
   characteristics. This is a SINGLE flat line of descriptors: NO line breaks,
   and NO Suno meta/structure/section tags (e.g. [Verse], [Chorus], [Intro]) —
   song structure belongs ONLY in the lyrics field, never here.

2. genres — an array of UP TO 3 concise genre names that best classify the song
   (1-3 words each, e.g. "synthwave", "dream pop", "drum and bass"). Lowercase,
   no duplicates, most representative first. These are the song's genres, distinct
   from the fuller comma-separated stylePrompt above. Return fewer than 3 if the
   song does not warrant three; never more than 3.

Respond with ONLY a single JSON object and nothing else (no prose, no code
fences):
{"stylePrompt":"...","genres":["...","...","..."]}`

// generateTurn2Prompt asks for the lyrics alone, with the craft rules sitting
// right next to the request rather than at the top of a long system prompt. It
// runs tool-free on the turn-1 history, so the research and the style prompt the
// craft rules defer to are both still in context.
const generateTurn2Prompt = `Now write the lyrics. Do not call any tools — you have everything you need.

lyrics — ORIGINAL lyrics that YOU compose as a brand-new song on the researched
THEME, mood and imagery — inspired by the reference, NOT a line-by-line rewrite of
it. Write them to be natural and singable; do not paraphrase the original line for
line or swap out single words, which produces awkward, unusable phrasing. For
copyright, what matters is that you do NOT reproduce the reference song's
distinctive lines, its hook, or its chorus verbatim — ordinary words, common
images, and the shared theme are free to use. Structure them with the Suno
meta/structure tags listed below. They must fit the style prompt you just wrote,
and they must obey the CRAFT RULES below — those matter as much as the theme.

` + sunoTagReference + `

` + lyricCraftRules + `

Respond with ONLY a single JSON object and nothing else (no prose, no code
fences):
{"lyrics":"..."}`

// generateTurn3Prompt asks for everything downstream of the lyrics — cover art
// and the three naming lists — now that the lyrics are a real message in the
// history rather than a same-breath promise.
const generateTurn3Prompt = `Now name the track and picture it. Do not call any tools. Produce FOUR things,
all grounded in the lyrics you just wrote:

1. coverArtPrompt — a CONCISE prompt for a downstream image generator: one or two
   vivid sentences, at most ~60 words. Ground the imagery in the THEMES, STORY, and
   KEY IMAGES of the lyrics you just wrote — not just the genre and era.
   Image models degrade on long rambling descriptions, so favor a single strong
   central subject, palette, and mood over exhaustive detail. It MUST also bake in
   the researched genre and era/epoch so the aesthetic is period-correct (e.g. a
   1991 thrash-metal cover, not a modern one). No text in the image; square album
   composition.

2. titles — an array of EXACTLY 3 original song-title ideas for the lyrics you
   just wrote. They must VARY IN DIRECTNESS: the FIRST is the most obvious
   pick (e.g. built from the hook/chorus or the central phrase), and the LAST is
   more oblique and evocative (an image, symbol, or metaphor drawn from the
   lyrics — NOT a lyric line copied verbatim). 1-6 words each, Title Case, no
   surrounding quotes, all distinct from one another, and NEVER the reference
   song's real title.

3. albums — an array of EXACTLY 3 album-name ideas in the same varied spirit
   (obvious first, oblique last), evoking the overall mood and era rather than a
   single line. Same rules: 1-6 words each, Title Case, no quotes, all distinct
   from one another AND from the titles, and never the reference song's real
   album or title.

4. bands — an array of EXACTLY 3 original band/artist-name ideas that could
   plausibly have recorded this song, fitting the researched genre and era/epoch
   and suiting the lyrics' mood. A band name names the ACT, not the song — do NOT
   reuse or echo any of the titles or albums. Same varied spirit (obvious first,
   oblique last): typically 1-3 words each, Title Case, no surrounding quotes, all
   distinct from one another AND from the titles and albums, and NEVER the
   reference song's real artist or band name.

Respond with ONLY a single JSON object and nothing else (no prose, no code
fences):
{"coverArtPrompt":"...","titles":["...","...","..."],"albums":["...","...","..."],"bands":["...","...","..."]}`

// refineSystemPrompt instructs MiMo to rewrite only the lyrics per an instruction.
const refineSystemPrompt = `You revise Suno lyrics. You are given a reference song, the current ORIGINAL
lyrics, and a refinement instruction. Rewrite the lyrics to satisfy the
instruction while keeping them natural, singable, on-theme, and structured with
the Suno meta/structure tags listed below. Keep them original:
do not reproduce the reference song's distinctive lines, hook, or chorus verbatim,
but do not word-swap or paraphrase the original into awkward phrasing either —
ordinary words and the shared theme are fine. Do not research; rewrite only the
lyrics you are given.

` + sunoTagReference + `

` + lyricCraftRules + `

Respond with ONLY a single JSON object and nothing else:
{"lyrics":"..."}`

// genrePromptSystemPrompt instructs the model to author a single image prompt
// that depicts a MUSIC GENRE as a wide page background — NOT an album cover. The
// central decision it must make is live-vs-aesthetic: genres that live on a
// stage get a photorealistic gig photo; studio/electronic genres get their
// signature visual world instead.
const genrePromptSystemPrompt = `You write ONE image-generation prompt that visually captures a MUSIC GENRE, to be
used as a wide background image for that genre's page. You are given only a genre
name.

This is NOT an album cover and NOT a logo. Depict the genre itself — its scene,
culture, setting, and aesthetic. Never put any text, letters, words, or watermarks
in the image.

Decide the approach from the genre:
- If the genre is one typically PERFORMED LIVE by musicians on a stage (e.g. thrash
  metal, rock, punk, jazz, blues, funk, reggae, hip-hop, folk), render it as a
  PHOTOREALISTIC STILL FRAME GRABBED FROM A LIVE CONCERT VIDEO: a band
  mid-performance under hard stage lighting. It must
  read like a sharp video still — tack-sharp crisp focus, high contrast, and DEEP
  TRUE BLACK blacks with crushed inky shadows (never washed-out or grey), where
  colored stage lights and spotlight beams cut through the darkness. Gritty,
  energetic, high-dynamic-range concert-video realism.
- If the genre is NOT typically a live-band genre (e.g. synthwave, vaporwave,
  ambient, lo-fi, IDM, downtempo, chillwave), instead render its CHARACTERISTIC
  VISUAL AESTHETIC / SCENE (e.g. synthwave -> a neon-drenched 1980s cityscape with
  chrome and a sunset grid; ambient -> a vast calm minimal landscape).

Rules for the prompt itself:
- One or two vivid sentences, at most ~60 words. Image models degrade on long
  rambling descriptions, so favor a single strong subject plus palette and mood.
- Bake in the era/epoch that fits the genre's SONIC aesthetic so it is
  period-correct.
- WIDE LANDSCAPE composition (this is a page background, not a square tile).

Respond with ONLY a single JSON object and nothing else (no prose, no code fences):
{"prompt":"..."}`

// albumCoverPromptSystemPrompt instructs the model to author ONE image prompt for
// a SQUARE album cover, seeded with the artist, album title, and genre(s). Unlike
// the genre background (wide, depicts a scene), this is a tight single-subject
// album composition, period-correct to the genre's sonic aesthetic.
const albumCoverPromptSystemPrompt = `You write ONE image-generation prompt for a SQUARE album cover. You are given an
artist name, an album title, its genre(s), and — when available — lyric excerpts
from the album's songs.

Depict a strong, single central subject or motif that fits the album — its genre,
mood, and era. This is an album cover, not a movie poster and not a page banner.
Never put any text, letters, words, logos, or watermarks in the image (the title
and artist are added separately).

If lyric excerpts are provided, ground the subject and imagery in their THEMES and
STORY rather than genre/era alone — the lyrics are the strongest signal for what
the cover should actually depict. If no lyrics are provided, fall back to genre,
mood, and era.

Rules for the prompt itself:
- One or two vivid sentences, at most ~60 words. Image models degrade on long
  rambling descriptions, so favor a single strong subject plus palette and mood.
- Bake in the era/epoch that fits the genre's SONIC aesthetic so it is
  period-correct.
- SQUARE composition, centered and balanced for a 1:1 album tile.

Respond with ONLY a single JSON object and nothing else (no prose, no code fences):
{"prompt":"..."}`

// refinePromptSystemPrompt instructs the model to rewrite an existing image prompt
// per a user instruction, keeping it concise and text-free. Reused by both the
// genre-background and album-cover refine flows; the caller passes any relevant
// context (e.g. the genre name or artist/album) in the user message.
const refinePromptSystemPrompt = `You revise image-generation prompts. You are given the CURRENT prompt, optional
context, and a refinement instruction. Rewrite the prompt to satisfy the
instruction while keeping it a single concise image prompt (one or two vivid
sentences, at most ~60 words, no text/letters/logos in the image). Keep whatever
the instruction does not change.

Respond with ONLY a single JSON object and nothing else (no prose, no code fences):
{"prompt":"..."}`

// generateUserPrompt opens the generate conversation: the reference plus the
// turn-1 request. The turn instructions ride in the user message, not the system
// prompt, so turn 1 is asked for its two fields the same way turns 2 and 3 are.
func generateUserPrompt(reference string) string {
	return fmt.Sprintf("Reference song: %s\n\n%s", reference, generateTurn1Prompt)
}

func genrePromptUserPrompt(genre string) string {
	return fmt.Sprintf("Genre: %s", genre)
}

func albumCoverPromptUserPrompt(artist, album string, genres []string, lyrics []library.SongLyric) string {
	// Drop blank entries before joining, not after: joining first turns
	// []string{"  ", ""} into "  , ", which survives a TrimSpace check and reaches
	// the model as a genre list made entirely of punctuation.
	cleaned := make([]string, 0, len(genres))
	for _, g := range genres {
		if g = strings.TrimSpace(g); g != "" {
			cleaned = append(cleaned, g)
		}
	}
	genre := strings.Join(cleaned, ", ")
	if genre == "" {
		genre = "(unknown)"
	}
	base := fmt.Sprintf("Artist: %s\nAlbum: %s\nGenre(s): %s", artist, album, genre)
	if len(lyrics) == 0 {
		return base
	}
	var b strings.Builder
	b.WriteString(base)
	b.WriteString("\nLyrics:")
	for _, sl := range lyrics {
		fmt.Fprintf(&b, "\n- %q: %s", sl.Title, sl.Lyrics)
	}
	return b.String()
}

func refinePromptUserPrompt(current, instruction, context string) string {
	if strings.TrimSpace(context) != "" {
		return fmt.Sprintf("Context: %s\n\nCurrent prompt:\n%s\n\nRefinement instruction: %s",
			context, current, instruction)
	}
	return fmt.Sprintf("Current prompt:\n%s\n\nRefinement instruction: %s", current, instruction)
}

func refineUserPrompt(reference, lyrics, instruction string) string {
	return fmt.Sprintf("Reference song: %s\n\nCurrent lyrics:\n%s\n\nRefinement instruction: %s",
		reference, lyrics, instruction)
}

const playlistDescSystemPrompt = `You are a music editor writing short playlist descriptions.
Given a playlist name and its songs, write THREE one-sentence descriptions in distinct tones.
Return ONLY JSON: {"punchy":"...","evocative":"...","factual":"..."}.
- punchy: energetic, imperative, <= 12 words.
- evocative: mood and imagery, <= 22 words.
- factual: plain summary of count/genres/energy, <= 22 words.
No emojis. No quotes inside values.`

func playlistDescUserPrompt(name string, songs []library.PlaylistTrackBrief) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Playlist: %s\nSongs:\n", name)
	for i, s := range songs {
		if i >= 40 {
			break
		}
		g := strings.Join(s.Genres, ", ")
		fmt.Fprintf(&b, "- %s — %s (%s)\n", s.Title, s.Artist, g)
	}
	return b.String()
}
