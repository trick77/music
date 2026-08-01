package studio

import (
	"context"
	"strings"
	"testing"

	"github.com/trick77/music/internal/llm"
)

// cannedChat returns one fixed reply regardless of input, and records the last
// system + user prompts (and the tools it was handed) so tests can assert prompt
// content and whether the call was tool-less.
type cannedChat struct {
	reply      string
	lastSystem string
	lastUser   string
	lastTools  []llm.Tool
	calls      int
}

func (c *cannedChat) Chat(_ context.Context, messages []llm.Message, tools []llm.Tool) (llm.Message, error) {
	c.calls++
	c.lastTools = tools
	for _, m := range messages {
		if m.Role == "system" {
			c.lastSystem = m.Content
		}
		if m.Role == "user" {
			c.lastUser = m.Content
		}
	}
	return llm.Message{Role: "assistant", Content: c.reply}, nil
}

// turnChat answers each call with the next canned reply, so a test can drive
// the three generate turns independently. It records every call's tools and the
// message history it was handed.
type turnChat struct {
	replies    []string
	lastSystem string
	lastUser   string
	lastTools  []llm.Tool
	users      []string
	histories  [][]llm.Message
	calls      int
}

func (c *turnChat) Chat(_ context.Context, messages []llm.Message, tools []llm.Tool) (llm.Message, error) {
	c.lastTools = tools
	c.histories = append(c.histories, messages)
	for _, m := range messages {
		if m.Role == "system" {
			c.lastSystem = m.Content
		}
		if m.Role == "user" {
			c.lastUser = m.Content
		}
	}
	c.users = append(c.users, c.lastUser)
	reply := ""
	if c.calls < len(c.replies) {
		reply = c.replies[c.calls]
	}
	c.calls++
	return llm.Message{Role: "assistant", Content: reply}, nil
}

// threeTurnReplies is a well-formed answer for each of the three generate turns.
func threeTurnReplies() []string {
	return []string{
		"Here you go:\n```json\n" +
			`{"stylePrompt":"1990s,heavy metal,thrash","genres":["heavy metal","thrash","heavy metal","groove metal","nu metal"]}` +
			"\n```\nHope that helps!",
		`{"lyrics":"[Verse]\nfresh words"}`,
		`{"coverArtPrompt":"a dim bedroom, 1991 thrash aesthetic","titles":["Sleep Now","Sleep Now","Grey Between Dreams","The Sandman's Ledger","Fourth Title"],"albums":["Nightfall Sessions","Hush the World","Iron Lullaby"],"bands":["Ashen Verdict","Ashen Verdict","Grey Litany","Hollow Sabbath","Fourth Band"]}`,
	}
}

func TestGenerate_parsesThreeFieldsFromFencedJSON(t *testing.T) {
	chat := &turnChat{replies: threeTurnReplies()}
	p := New(chat, &fakeTools{})

	res, err := p.Generate(context.Background(), GenerateRequest{Reference: "Metallica, Enter Sandman"}, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if res.StylePrompt != "1990s,heavy metal,thrash,no humming" {
		t.Fatalf("StylePrompt = %q", res.StylePrompt)
	}
	// Genres are de-duplicated (case-insensitively) and capped at 3.
	if len(res.Genres) != 3 || res.Genres[0] != "heavy metal" || res.Genres[1] != "thrash" || res.Genres[2] != "groove metal" {
		t.Fatalf("Genres = %#v, want [heavy metal, thrash, groove metal]", res.Genres)
	}
	// Titles are likewise de-duplicated and capped at 3, preserving order.
	if len(res.Titles) != 3 || res.Titles[0] != "Sleep Now" || res.Titles[1] != "Grey Between Dreams" || res.Titles[2] != "The Sandman's Ledger" {
		t.Fatalf("Titles = %#v, want [Sleep Now, Grey Between Dreams, The Sandman's Ledger]", res.Titles)
	}
	if len(res.Albums) != 3 || res.Albums[0] != "Nightfall Sessions" {
		t.Fatalf("Albums = %#v, want 3 starting with Nightfall Sessions", res.Albums)
	}
	// Bands are likewise de-duplicated and capped at 3, preserving order.
	if len(res.Bands) != 3 || res.Bands[0] != "Ashen Verdict" || res.Bands[1] != "Grey Litany" || res.Bands[2] != "Hollow Sabbath" {
		t.Fatalf("Bands = %#v, want [Ashen Verdict, Grey Litany, Hollow Sabbath]", res.Bands)
	}
	if !strings.Contains(res.Lyrics, "[Verse]") {
		t.Fatalf("Lyrics = %q", res.Lyrics)
	}
	if !strings.Contains(res.CoverArtPrompt, "1991") {
		t.Fatalf("CoverArtPrompt = %q", res.CoverArtPrompt)
	}
	// The reference must reach the model.
	if !strings.Contains(chat.users[0], "Enter Sandman") {
		t.Fatalf("user prompt missing reference: %q", chat.users[0])
	}
	// ...and so must the turn-1 request itself. Each turn's instructions live in
	// its own user message; an unsent one is invisible to the compiler and to a
	// canned-reply fake, so assert the turn-1 rules and JSON contract are there.
	if !strings.Contains(chat.users[0], "stylePrompt") || !strings.Contains(chat.users[0], "genres") {
		t.Fatalf("turn 1 must ask for the style prompt and genres: %q", chat.users[0])
	}
	// The lyrics turn must carry the Suno tag vocabulary and the craft rules.
	if !strings.Contains(chat.users[1], "[Verse]") {
		t.Fatalf("lyrics turn should mention Suno tags: %q", chat.users[1])
	}
	if !strings.Contains(chat.users[1], "SUNO TAG VOCABULARY") {
		t.Fatalf("lyrics turn should carry the static tag vocabulary: %q", chat.users[1])
	}
	if !strings.Contains(chat.users[1], "SENSE BEFORE RHYME") {
		t.Fatalf("lyrics turn should carry the craft rules: %q", chat.users[1])
	}
}

// The three turns must be ONE conversation: each later turn has to see the
// research and the earlier answers, otherwise the lyrics lose the style prompt
// they are told to fit and the naming turn loses the lyrics it must be grounded
// in. Only the research turn may call tools.
func TestGenerate_laterTurnsContinueTheSameConversationWithoutTools(t *testing.T) {
	chat := &turnChat{replies: threeTurnReplies()}

	if _, err := New(chat, &fakeTools{}).Generate(context.Background(), GenerateRequest{Reference: "x"}, nil, nil); err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if chat.calls != 3 {
		t.Fatalf("expected 3 turns, got %d", chat.calls)
	}
	for i := 1; i < 3; i++ {
		if len(chat.histories[i]) <= len(chat.histories[i-1]) {
			t.Fatalf("turn %d did not continue the previous conversation (%d messages after %d)",
				i+1, len(chat.histories[i]), len(chat.histories[i-1]))
		}
	}
	// The turn-1 answer (the style prompt) must still be visible to the lyrics turn.
	var sawStyle bool
	for _, m := range chat.histories[1] {
		if strings.Contains(m.Content, "1990s,heavy metal,thrash") {
			sawStyle = true
		}
	}
	if !sawStyle {
		t.Fatal("lyrics turn cannot see the style prompt it must fit")
	}
	// The lyrics must be visible to the naming/cover-art turn.
	var sawLyrics bool
	for _, m := range chat.histories[2] {
		if strings.Contains(m.Content, "fresh words") {
			sawLyrics = true
		}
	}
	if !sawLyrics {
		t.Fatal("naming turn cannot see the lyrics it must be grounded in")
	}
	if len(chat.lastTools) != 0 {
		t.Fatalf("the final turn must be tool-free, got %d tools", len(chat.lastTools))
	}
}

// Each turn's output must reach the caller as soon as that turn finishes — the
// whole point of the split. Buffering the partials until the end would still
// pass a result-only assertion, so this test pins the emission to the turn.
func TestGenerate_emitsPartialsAsEachTurnLands(t *testing.T) {
	chat := &turnChat{replies: threeTurnReplies()}
	type snapshot struct {
		afterCalls int
		partial    GenerateResult
	}
	var seen []snapshot
	onPartial := func(r GenerateResult) {
		seen = append(seen, snapshot{afterCalls: chat.calls, partial: r})
	}

	if _, err := New(chat, &fakeTools{}).Generate(context.Background(), GenerateRequest{Reference: "x"}, nil, onPartial); err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(seen) != 3 {
		t.Fatalf("expected one partial per turn, got %d", len(seen))
	}
	// The style prompt lands after turn 1, not at the end.
	if seen[0].afterCalls != 1 || seen[0].partial.StylePrompt == "" || seen[0].partial.Lyrics != "" {
		t.Fatalf("first partial should be the style prompt after turn 1: %+v", seen[0])
	}
	if seen[1].afterCalls != 2 || seen[1].partial.Lyrics == "" || seen[1].partial.CoverArtPrompt != "" {
		t.Fatalf("second partial should be the lyrics after turn 2: %+v", seen[1])
	}
	if seen[2].afterCalls != 3 || seen[2].partial.CoverArtPrompt == "" || len(seen[2].partial.Bands) == 0 {
		t.Fatalf("third partial should be the naming/cover art after turn 3: %+v", seen[2])
	}
}

// Bands, titles and albums are best-effort: a reply that omits them must still
// yield a usable result (the Identity card simply shows no name ideas), unlike
// the core style/lyrics/cover fields which are required.
func TestGenerate_toleratesMissingBandsTitlesAndAlbums(t *testing.T) {
	chat := &turnChat{replies: []string{
		`{"stylePrompt":"1990s,thrash","genres":["thrash"]}`,
		`{"lyrics":"[Verse]\nwords"}`,
		`{"coverArtPrompt":"dim room"}`,
	}}
	res, err := New(chat, &fakeTools{}).Generate(context.Background(), GenerateRequest{Reference: "x"}, nil, nil)
	if err != nil {
		t.Fatalf("Generate should tolerate missing bands/titles/albums: %v", err)
	}
	if len(res.Bands) != 0 || len(res.Titles) != 0 || len(res.Albums) != 0 {
		t.Fatalf("expected empty Bands/Titles/Albums, got %#v / %#v / %#v", res.Bands, res.Titles, res.Albums)
	}
}

func TestGenerate_errorsOnUnparseableReply(t *testing.T) {
	p := New(&turnChat{replies: []string{"I could not find that song."}}, &fakeTools{})
	if _, err := p.Generate(context.Background(), GenerateRequest{Reference: "x"}, nil, nil); err == nil {
		t.Fatal("expected error when reply has no JSON object")
	}
}

// A turn that fails must not be papered over with a half-filled result: the
// caller gets the error, and the partials it already received stand on their own.
func TestGenerate_errorsWhenALaterTurnIsUnparseable(t *testing.T) {
	chat := &turnChat{replies: []string{
		`{"stylePrompt":"1990s,thrash","genres":["thrash"]}`,
		"sorry, I cannot write lyrics",
	}}
	var partials int
	_, err := New(chat, &fakeTools{}).Generate(context.Background(), GenerateRequest{Reference: "x"}, nil, func(GenerateResult) { partials++ })
	if err == nil {
		t.Fatal("expected an error when the lyrics turn returns no JSON")
	}
	if partials != 1 {
		t.Fatalf("the finished turn should still have been streamed, got %d partials", partials)
	}
}

func TestRefine_returnsUpdatedLyricsAndPassesInstruction(t *testing.T) {
	chat := &cannedChat{reply: `{"lyrics":"[Verse]\nno forbidden word here"}`}
	tools := &fakeTools{}
	p := New(chat, tools)

	lyrics, err := p.Refine(context.Background(), RefineRequest{
		Reference:   "Metallica, Enter Sandman",
		Lyrics:      "[Verse]\nold words",
		Instruction: "do not say lullaby",
	}, nil)
	if err != nil {
		t.Fatalf("Refine: %v", err)
	}
	if !strings.Contains(lyrics, "no forbidden word") {
		t.Fatalf("lyrics = %q", lyrics)
	}
	if !strings.Contains(chat.lastUser, "do not say lullaby") {
		t.Fatalf("refine instruction missing from prompt: %q", chat.lastUser)
	}
	if !strings.Contains(chat.lastUser, "old words") {
		t.Fatalf("current lyrics missing from refine prompt: %q", chat.lastUser)
	}
}

// The Suno tag vocabulary is static data in the repo, NOT something to look up:
// researching it cost a web round-trip (and user wait) on every generation to
// rediscover the same bracket tags. The system prompt must therefore ship the
// standing "don't search for Suno tags" instruction, and both lyric-writing
// prompts must carry the vocabulary themselves so the model never needs to.
func TestPrompts_sunoTagsAreStaticNotResearched(t *testing.T) {
	if strings.Contains(generateSystemPrompt, "CURRENT set of Suno") {
		t.Fatalf("system prompt still tells the model to research Suno tags: %q", generateSystemPrompt)
	}
	if !strings.Contains(generateSystemPrompt, "never spend a search") {
		t.Fatalf("system prompt should forbid searching for Suno tags: %q", generateSystemPrompt)
	}
	// Both prompts that emit lyrics must carry the same vocabulary — a refine pass
	// missing it would drift away from the tags generate was told to use.
	for name, p := range map[string]string{"generate turn 2": generateTurn2Prompt, "refine": refineSystemPrompt} {
		if !strings.Contains(p, sunoTagReference) {
			t.Fatalf("%s prompt is missing the static Suno tag vocabulary: %q", name, p)
		}
		if strings.Contains(p, "confirmed are current") {
			t.Fatalf("%s prompt still defers to researched tags: %q", name, p)
		}
	}
}

// Refine must NOT re-run the web-research/discovery loop: it should be a single
// tool-less completion, so the model is handed no tools and no tool is dispatched.
func TestRefine_doesNotResearch(t *testing.T) {
	chat := &cannedChat{reply: `{"lyrics":"[Verse]\nrewritten"}`}
	tools := &fakeTools{}
	p := New(chat, tools)

	if _, err := p.Refine(context.Background(), RefineRequest{
		Reference:   "Metallica, Enter Sandman",
		Lyrics:      "[Verse]\nold words",
		Instruction: "darker chorus",
	}, nil); err != nil {
		t.Fatalf("Refine: %v", err)
	}
	if chat.calls != 1 {
		t.Fatalf("expected exactly one completion, got %d", chat.calls)
	}
	if len(chat.lastTools) != 0 {
		t.Fatalf("refine must pass no tools, got %d", len(chat.lastTools))
	}
	if len(tools.called) != 0 {
		t.Fatalf("refine must not dispatch any tool call, got %v", tools.called)
	}
}
