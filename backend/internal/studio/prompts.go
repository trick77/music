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
const lyricCraftRules = `CRAFT RULES for the lyrics — these decide whether a singer can actually sing them.
The lyrics are meant to be SUNG, NOT READ: sing every line in your head before you
commit it, and if a word fights the melody, replace it.

WRITE FOR THE VOICE
- SINGABLE LINE ENDINGS. The last word of a line is the note the singer holds, so
  favor open vowels and soft consonants (-ay, -ee, -oh, -ow, -ine, -ound, -ong,
  -er, -m, -n, -l). Avoid ending on a hard plosive (-ck, -k) or a clustered
  consonant that has to be swallowed (-acked, -ashed, -isped, -ilked), and be
  careful with clipped -p and -t — EXCEPT where the style calls for that
  percussive bite: hip-hop, punk, hardcore, thrash and other rhythm-forward
  genres land hard consonants on purpose, so let the style prompt decide.
- NO CROWDED MOUTHS. Skip dense consonant clusters (faults, strengths, texts).
  One open syllable beats a technically better word that cannot be sung cleanly.
- STRESS ON THE BEAT. Keep each line's natural spoken stress on the strong beats,
  and keep rhymed lines close in syllable count so the phrasing repeats. Never
  end a line on an unstressed syllable the singer has to rush past. A multi-
  syllable word that forces the singer to rush or stretch has to go.
- SAY IT ALOUD IN YOUR HEAD before you commit a couplet. If it would feel
  embarrassing to sing, rewrite it.

RHYME AND METER
- SENSE BEFORE RHYME. Write each line for what it has to say, THEN look for a
  rhyme. Never bend a sentence, invert word order, or reach for an odd word just
  to land a rhyme — that is the single clearest tell of machine-written lyrics.
- SLANT RHYME IS GOOD. Near rhymes (home/alone, again/end, fire/quiet) sound more
  natural than perfect ones, and an unrhymed line is better than a forced rhyme.
  Perfect rhyme on every single line reads as amateur greeting-card verse.
- KEEP THE PATTERN. Not every line has to rhyme, but hold the scheme steady across
  verses: if lines 2 and 4 rhyme in verse one, do the same in verse two, and match
  the syllable counts of matching lines so one melody fits both.

WORDS AND IMAGES
- NO THESAURUS WORDS. Only words people say out loud. Reject lacked, yearn,
  forlorn, cascade, ethereal, myriad, behold, asunder. Plain concrete nouns and
  verbs beat abstract or literary ones every time.
- NO MACHINE APHORISMS. This is the failure mode that gives away a machine-written
  lyric, and it is NOT about rare words — every word in "there is signal in the
  noise" is common, and the line is still unusable. Never write a line that states
  a thesis about life, and never reach for an abstract systems metaphor. The
  offenders, by name: signal, noise, static, frequency, wavelength, echo, fracture,
  gravity, orbit, wires, circuits, embers, ashes, mirrors, glass, machine, and the
  sentence frames "the space between ...", "the weight of ...", "we are the ...",
  "there is X in the Y". None of those words are banned in themselves — "the radio
  signal cut out", "her voice echoed down the hall" are fine, because something is
  happening to someone. What is banned is the FRAME: using one of them as the
  subject of a statement about life. The test that catches these when a word-list
  cannot: WOULD ONE PERSON SAY THIS SENTENCE OUT LOUD TO ANOTHER PERSON? If it only
  works as a caption, a poster, or a fortune cookie, cut it and write what actually
  happened instead.
- NO STOCK IMAGERY. Language models fall back on a small set of borrowed pictures.
  These are statistical defaults, not writing — never use them:
    light: neon signs, neon lights, city lights, flickering lights, "the glow of"
    dark: whispers in the dark, shadows in the dark, shadows dancing, "in the
          silence", "the edge of the night"
    echo/ghost: echoes of you, the ghost of you, silhouettes, "your memory haunts me"
    body: running through my veins, hearts beating as one, an "electric" touch
    struggle: rise from the ashes, break these chains, the storm inside me,
          fire/flames within, "we're still alive"
  The test: could this line appear UNCHANGED in a thousand other songs? Then it is
  a default — cut it and put a specific observed detail from this song's world in
  its place (a named street, a particular object, an exact hour, something someone
  actually said), never another generic phrase. The list is not exhaustive: treat
  any image that feels instantly, effortlessly familiar with suspicion, because
  that familiarity is the symptom.
- CONCRETE OVER ABSTRACT. One specific image — a room, an object, a time of day —
  outperforms a stack of feeling-words. Show the situation, do not summarize it.
  This is the positive form of the two rules above: when you catch yourself
  writing the abstraction, put a person somewhere doing something instead. Never
  name the emotion when an object can carry it — not "I miss you and I'm sad" but
  "your sweater's hanging in the hall upstairs". Understatement beats melodrama:
  a narrator who answers "yeah, I'm doing fine" lands harder than one who explains
  the pain. Run ONE central metaphor through the song and extend it; do not stack
  competing ones.

HOOK AND STRUCTURE
- REPEAT THE CHORUS VERBATIM. The same words every time it comes around; that is
  what makes a hook. Vary a verse if you like, never the chorus — at most one
  meaningful word.
- PROTECT THE HOOK. Pick the hook word or phrase, keep it in the chorus, and do
  not spend it in the verses, so it lands with full weight when it arrives. The
  chorus carries the SIMPLEST language in the song: open vowels, short words,
  easy to repeat. Repetition is a feature, not filler — an outro that repeats a
  hook fragment usually beats new material.
- SHAPE THE SONG. Default form: Intro, Verse 1, Chorus, Verse 2, Chorus,
  (Instrumental), Bridge, Final Chorus, Outro — deviate deliberately, never by
  accident, and when the researched reference song is plainly built differently,
  follow the reference instead of this default. Verses advance the story or shift
  perspective. The bridge brings a NEW angle — an accusation, a reveal, a jump in
  time — not a third verse in disguise. Build a dynamic arc: quietest at the
  start, fullest at the final chorus, stripped back for the outro.

Worked example of the trap to avoid:
  BAD:  "the sidewalk cracked / it was something I always lacked"
        — "lacked" exists only because it rhymes; nobody sings that word and the
        line states nothing.
  GOOD: "the sidewalk cracked in the heat / and I sat on the curb till you came"
        — nothing forced, plain words, an actual picture; the rhyme is dropped
        rather than faked.

  BAD:  "there is signal in the noise"
        — an aphorism, not a sentence anyone says. No person, no place, no moment;
        it could sit in any song about anything, which means it belongs in none.
  GOOD: "you kept talking through the radio hiss"
        — the same idea, but somebody is doing something somewhere.

  BAD:  "your ghost in the neon light"
        — two borrowed pictures in six words; it belongs to no particular song.
  GOOD: "your sweater by the door"
        — one plain object out of this song's own world, and it does the same job.`

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
short plain-English tags beat invented ones. It is still a floor, not a ceiling —
if the song genuinely calls for another well-known tag, use it (just do not
research one). Tags are hints, not commands — Suno follows them most of the time
and may ignore one.

HOW TO PLACE THEM:
- Every section opens with ONE structure tag on its own line.
- Under that header you may stack AT MOST ONE OR TWO short delivery/production
  cues, each on its own line, before the first sung line — e.g. [Whispered],
  [Layered Vocals], [Harmonies], [Build]. Hard ceiling of FOUR tags per section.
- Keep tags SHORT. A long tag gets sung instead of obeyed, so write [Whispered],
  never [Whispered, close-mic'd and full of regret].
- No grand or mood-loaded words in a tag (epic, soaring, massive, hypnotic,
  brooding): name what HAPPENS, not how it should feel.
- No genre or style description in a tag — that belongs in the style prompt.

Example of the shape:
[Verse 1]
[Whispered]
you left your sweater by the door`

// imagePromptCraft is the shared standard for the COVER-ART prompts — song cover
// art, album covers, and the refine pass over an image prompt. It lives in one
// const for the same reason lyricCraftRules does: a refine without these rules
// would undo them on the first revision.
//
// genrePromptSystemPrompt deliberately does NOT carry it yet. That prompt writes
// a wide page background depicting a whole scene rather than a cover's single
// subject, so it needs its own pass — see the note on that const.
//
// The rules come from a measured before/after. Asking for "one or two vivid
// sentences" produced narrative prose that read as generic AI illustration; the
// same subject rewritten as an ordered comma-separated list, led by an explicit
// medium and using named camera terms instead of described effects, rendered as a
// real photograph. Both versions are quoted at the bottom as the worked example —
// keep them, they teach the difference faster than the rules do.
const imagePromptCraft = `HOW TO WRITE THE PROMPT — an image generator is not a reader. It matches
fragments, so give it a COMMA-SEPARATED LIST of concrete visual facts, never
narrative prose. Roughly 8-12 fragments, at most ~50 words, in this order:

  1. MEDIUM — FIRST and always explicit. This is the single most important
     fragment: without it the generator falls back on generic digital-art
     rendering. Name a real one that suits the genre and era ("35mm film
     photograph", "high-contrast black-and-white photograph", "oil painting on
     canvas", "screenprinted gig poster", "airbrushed illustration", "grainy
     Polaroid").
  2. SUBJECT and how it is SEEN — one subject, plus its vantage ("woman seen from
     behind", "low-angle view of a drum kit"). For a person, prefer seen from
     behind, in silhouette, or partly turned away: faces are where generators
     break, and a turned figure reads as a real photograph.
  3. ONE action or pose — one only ("one hand pressed flat against the wall",
     "head slightly bowed"). Never two simultaneous actions.
  4. SETTING — the place in a few words ("in a narrow hallway").
  5. LIGHT — the source, its direction and its colour ("warm amber light from a
     single window at the end", "hard blue stage light from above").
  6. CAMERA / COMPOSITION — the technique BY NAME ("subtle Dutch angle", "shallow
     depth of field", "centered symmetrical composition", "wide establishing shot").
  7. PALETTE — two or three words ("muted earth tones", "bleached reds and black").
  8. TEXTURE / FINISH — and how much ("heavy film grain", "visible canvas texture",
     "halftone dot print texture").

RULES:
- NAME THE TECHNIQUE, DO NOT DESCRIBE ITS EFFECT. "subtle Dutch angle" is a
  renderable instruction; "the tilted composition suggesting vertigo" is a film
  review the generator cannot act on.
- NO INTERPRETATION, NO MOOD WORDS. Cut every "evoking", "suggesting", "a sense
  of", "conveying", and every named feeling (melancholy, stillness, longing,
  nostalgia, unease). Mood is a RESULT of the light, palette, texture and pose —
  state those and the mood arrives on its own. A named feeling in the prompt just
  spends words the generator cannot use.
- ONE SUBJECT, NO CLUTTER. Every extra prop is one more thing to render wrong. A
  second object earns its place only if the image is meaningless without it.
- NO CONNECTING CLAUSES. Fragments joined by commas — no "while", "as", "nearby",
  "with the other hand". Each fragment stands alone.
- ERA THROUGH THE MEDIUM, NOT AS A LABEL. The film stock, the grain, the palette
  and the printing process carry the period. Never write a decade attached to a
  feeling ("2010s indie-folk melancholy") and never name a music genre in the
  prompt — the generator does not know what a genre looks like, it knows what
  Kodachrome looks like.
- NO TEXT of any kind in the image: no letters, words, titles, logos or
  watermarks. They are added separately, and generators render them as gibberish.

Worked example — the SAME scene, and the difference is the whole rule set:
  BAD:  "A woman in a dim hallway braces one hand against a worn plaster wall
        while the other reaches forward into empty air, a forgotten sweater
        draped over a doorknob nearby. Warm amber light filters through a window,
        the tilted composition suggesting vertigo on solid ground. Muted earth
        tones, intimate domestic stillness, soft film grain evoking 2010s
        indie-folk melancholy."
        — prose, no medium named, two simultaneous actions, a clutter prop, the
        camera move described instead of named, and three interpretations
        ("suggesting vertigo", "intimate domestic stillness", "evoking ...
        melancholy") the generator has to throw away. It rendered as generic
        digital art.
  GOOD: "35mm film photograph, woman seen from behind in a narrow hallway, one
        hand pressed flat against faded plaster wall, head slightly bowed, warm
        amber light from a single window at the end, subtle Dutch angle, muted
        earth tones, heavy film grain, shallow depth of field"
        — medium first, one subject seen from behind, one pose, a located light
        source, two named camera terms, a palette and a grain weight. Same scene,
        and it rendered as a real photograph.`

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
musical characteristics. The single exception is the referenceArtist and
referenceTitle fields of turn 1, which exist to label the saved run in a list and
are never pasted into Suno; the prohibition still applies absolutely to the style
prompt, the lyrics, the titles, the albums, the bands and the cover-art prompt.`

// generateTurn1Prompt asks for the research-derived half: the style prompt, the
// genre labels, and the reference song's real artist and title (a label for the
// saved run, never prompt content). It is the only turn that may call tools.
//
// The song it works on is named at the END of the user message rather than the
// start — see generateUserPrompt for why.
const generateTurn1Prompt = `Research the reference song named at the end of this message, then produce THREE things:

1. stylePrompt — a comma-separated list of style/genre descriptors for Suno's
   "Style" box. Format: a SINGLE flat line, NO spaces after commas, NO line
   breaks, lowercase except proper nouns, at most 500 characters.

   ORDER MATTERS — Suno weighs the earliest words most, so put the descriptors in
   this order, 5 to 12 of them in total, each one adding a distinct dimension:
     a) GENRE — one or two SPECIFIC labels, the dominant one first ("alt-country,
        indie folk-rock", never just "rock").
     b) TEMPO — a BPM or a feel ("92 BPM", "mid-tempo", "driving").
     c) MOOD — one or two words, and never two words that mean the same thing.
     d) INSTRUMENTS — AT MOST 3-4 melodic instruments, each named specifically
        ("jangly electric guitar", not "guitar"). More than four turns to mush.
     e) VOCAL — always present, see below.
     f) PRODUCTION / ERA — production traits ("close-mic'd", "warm analog mix")
        and, when the sound has a recognizable period, an era cue ("2010s indie",
        "90s grunge"): it is a strong, compact signal. SKIP the era when the genre
        already implies it (synthwave is 80s by definition) or when it fights the
        production traits; a retro-modern fusion has to be deliberate ("60s soul,
        modern polished production"). Infer the era from the song's SONIC
        aesthetic, not from its release date.
   Cut any descriptor that merely restates an earlier one.

   Describe ONLY THIS SPECIFIC SONG's own sound as heard on the actual recording —
   NOT the artist's signature or typical style, and NOT the album's overall style.
   The same artist, and even the same album, routinely spans different genres from
   one track to the next, so a generic artist/album descriptor will misdescribe
   this song; if the track departs from what the artist is known for, capture the
   track. DESCRIBE THE VOICE, starting with its REGISTER — this is required, not
   optional, and "clean vocals" alone is not a description. Name the lead vocal's
   register as heard on the recording ("baritone lead vocal", "tenor lead vocal",
   "alto lead vocal", "low-register vocal", "high-register vocal"). You may add AT
   MOST ONE further vocal attribute when the recording plainly calls for it —
   delivery or timbre ("clean vocals", "breathy", "belted", "spoken-word phrasing",
   "close-mic'd", "double-tracked") — plus a short backing-vocal note if the track
   has one ("harmonized backing vocals", "gang-vocal chorus"). Never stack vocal
   adjectives, and stay away from the loud ones (raspy, powerful, soaring, gritty,
   massive) unless the recording is unmistakably that: they push Suno toward the
   same wide, raspy voice on every song. NEVER write "male vocals", "female
   vocals", or otherwise name the singer's sex — give the register and let that
   speak. Keep every descriptor MEASURED — Suno over-reacts to hyperbolic adjectives
   (e.g. psychedelic, massive, roaring, epic, cinematic, anthemic, powerful,
   explosive, brutal, thunderous) and generates chaotic, off-genre output, so use
   restrained wording instead (hazy/atmospheric, full/wide, driven/overdriven,
   grand, dynamic/punchy, heavy) and never stack more than one intensity word;
   convey energy through tempo and dynamics. Prefer a concrete production
   descriptor to a pure atmosphere word — "intimate" says little, "close-mic'd
   vocal, room-mic'd drums" says the same thing in terms Suno can act on.

   NO NEGATIVES. Never write "no X", "without X", or "not X" anywhere in the style
   prompt. Negation PRIMES the model toward the very thing it names, so "no
   humming" reliably produces more humming; state the positive you want instead
   ("clear enunciated lead vocal"). Anything you genuinely need excluded belongs in
   Suno's separate Exclude field, which is not yours to fill.

   NEVER mention real artist, band, or song names — describe only musical
   characteristics. Translate a comparison into its traits: "like Phoebe Bridgers"
   becomes "hushed indie folk,breathy close-mic'd alto lead vocal,fingerpicked
   acoustic guitar". And NO Suno meta/structure/section tags (e.g. [Verse],
   [Chorus], [Intro]) or vocal-delivery cues ([Whispered]) — those live only in the
   lyrics, never here.

2. genres — an array of UP TO 3 concise genre names that best classify the song
   (1-3 words each, e.g. "synthwave", "dream pop", "drum and bass"). Lowercase,
   no duplicates, most representative first. These are the song's genres, distinct
   from the fuller comma-separated stylePrompt above. Return fewer than 3 if the
   song does not warrant three; never more than 3.

3. referenceArtist and referenceTitle — the REAL artist and the REAL title of the
   reference song you just researched, normalized to their canonical spelling
   (e.g. "Metallica" and "Enter Sandman", however the reference was typed). These
   two fields label the run in a list and are never used as prompt content, so a
   real name is expected here and ONLY here. Leave either one an empty string if
   you cannot identify the song with confidence — a wrong name is worse than none.

Respond with ONLY a single JSON object and nothing else (no prose, no code
fences):
{"stylePrompt":"...","genres":["...","...","..."],"referenceArtist":"...","referenceTitle":"..."}`

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

1. coverArtPrompt — a prompt for a downstream image generator, written to the
   rules at the end of this message. Pick its SUBJECT from the THEMES, STORY and
   KEY IMAGES of the lyrics you just wrote — one object, place or figure that
   actually appears in them — not from the genre and era alone. Then choose a
   MEDIUM that a record from that genre and era would plausibly have used, and let
   that medium carry the period: a 1991 thrash record and a 2010s indie-folk
   record do not just differ in mood, they differ in whether the cover is a
   high-contrast black-and-white photograph or a grainy colour one. SQUARE album
   composition, centered and balanced for a 1:1 tile.

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

` + imagePromptCraft + `

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

EDIT, DO NOT REPLACE. Preserve the writer's voice and core images, and change the
MINIMUM the instruction demands — a refine that hands back a wholly different song
has failed even if the new song is good. Where the original is defensible, keep it.
Work in this order of priority, stopping once the instruction is satisfied:
  1. word sounds a singer cannot land   2. broken scansion
  3. forced rhymes                      4. a hook diluted by reuse in the verses
  5. weak or abstract images
For every line you change, you should be able to say in one sentence why it had to
change; if you cannot, put the original back.

` + sunoTagReference + `

` + lyricCraftRules + `

Respond with ONLY a single JSON object and nothing else:
{"lyrics":"..."}`

// genrePromptSystemPrompt instructs the model to author a single image prompt
// that depicts a MUSIC GENRE as a wide page background — NOT an album cover. The
// central decision it must make is live-vs-aesthetic: genres that live on a
// stage get a photorealistic gig photo; studio/electronic genres get their
// signature visual world instead.
//
// It is the one image prompt still written to the old "one or two vivid
// sentences" instruction: the cover-art prompts moved to imagePromptCraft's
// ordered tag list, and this one is held back for its own pass because its
// subject is a whole scene (a band on a stage) rather than a cover's single
// object, so the one-subject and one-action rules do not transfer as written.
// NOTE: refinePromptSystemPrompt is shared with this flow and DOES carry
// imagePromptCraft, so refining a genre background rewrites it as a tag list.
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

Depict ONE central subject or motif that fits the album. This is an album cover,
not a movie poster and not a page banner: SQUARE composition, centered and
balanced for a 1:1 tile.

If lyric excerpts are provided, take the subject from their THEMES and STORY
rather than genre/era alone — the lyrics are the strongest signal for what the
cover should actually depict. If no lyrics are provided, fall back to the genre's
own imagery. Either way, choose a MEDIUM that a record from that genre and era
would plausibly have used, and let the medium carry the period rather than saying
the period out loud.

` + imagePromptCraft + `

Respond with ONLY a single JSON object and nothing else (no prose, no code fences):
{"prompt":"..."}`

// refinePromptSystemPrompt instructs the model to rewrite an existing image prompt
// per a user instruction, keeping it concise and text-free. Reused by both the
// genre-background and album-cover refine flows; the caller passes any relevant
// context (e.g. the genre name or artist/album) in the user message.
const refinePromptSystemPrompt = `You revise image-generation prompts. You are given the CURRENT prompt, optional
context, and a refinement instruction. Rewrite the prompt to satisfy the
instruction, and keep whatever the instruction does not change — including the
current prompt's composition (square tile or wide landscape), which the
instruction alone may change.

The result must obey the rules below in full, even when the prompt you were given
does not. If the current prompt is written as prose, or names no medium, or
describes a camera move instead of naming it, fix that while you are in there:
the rewritten prompt is the one that gets rendered.

` + imagePromptCraft + `

Respond with ONLY a single JSON object and nothing else (no prose, no code fences):
{"prompt":"..."}`

// generateUserPrompt opens the generate conversation: the turn-1 request plus
// the reference. The turn instructions ride in the user message, not the system
// prompt, so turn 1 is asked for its two fields the same way turns 2 and 3 are.
//
// The reference goes LAST, after the instructions, and that order is the whole
// point of the function. Everything before the first byte that varies between
// runs can be served from the upstream prompt cache; with the song name in
// front, the cacheable prefix ended at the system prompt (~300 tokens) and the
// ~900 tokens of turn-1 rules behind it were re-read on every run. Moving one
// short line to the end puts them inside the prefix instead.
//
// The saving is a CROSS-RUN one: the run-invariant prefix grows from the
// ~300-token system prompt to that plus the ~900 tokens of turn-1 rules. How
// many of a run's three requests collect it depends on the upstream's cache
// granularity — turn 1 sends the tool list and turns 2 and 3 send none — so this
// is written for the prefix length, not for a token count saved.
func generateUserPrompt(reference string) string {
	return fmt.Sprintf("%s\n\nReference song: %s", generateTurn1Prompt, reference)
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
