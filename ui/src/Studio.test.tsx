import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./Rail";
import { StudioPage, ResultCard, CoverArtCard } from "./StudioPage";

// The Studio rail slot follows the presence-vs-absence model: it appears only
// when the viewer is authenticated AND Studio is configured (studioEnabled).
describe("Rail Studio slot", () => {
  const render = (authenticated: boolean, studioEnabled: boolean) =>
    renderToStaticMarkup(
      <Rail route={{ name: "home" }} authenticated={authenticated} studioEnabled={studioEnabled} onUpload={() => {}} onQueue={() => {}} />,
    );

  it("shows the Studio nav when authenticated and enabled", () => {
    expect(render(true, true)).toContain('aria-label="Studio"');
  });

  it("hides the Studio nav for an anonymous visitor", () => {
    expect(render(false, true)).not.toContain('aria-label="Studio"');
  });

  it("hides the Studio nav when Studio is not configured (key-less instance)", () => {
    const html = render(true, false);
    expect(html).not.toContain('aria-label="Studio"');
    // And no leftover "soon" placeholder.
    expect(html.toLowerCase()).not.toContain("soon");
  });
});

// StudioPage renders its input affordance and, in the idle state, none of the
// output cards (which only appear after a generation).
describe("StudioPage", () => {
  it("renders the reference field and Generate action, no results yet", () => {
    const html = renderToStaticMarkup(<StudioPage />);
    expect(html).toContain("Turn a song into a Suno prompt");
    expect(html).toContain('aria-label="Song reference"');
    expect(html).toContain("Generate");
    // No result cards before generating.
    expect(html).not.toContain("Style prompt");
    expect(html).not.toContain("Cover-art prompt");
  });
});

// ResultCard renders a read-only body by default, and an editable text area when
// an onChange handler is supplied (the lyrics card).
describe("ResultCard", () => {
  it("renders a static, non-editable body by default", () => {
    const html = renderToStaticMarkup(<ResultCard name="Style prompt" text="1990s,grunge" />);
    expect(html).toContain("1990s,grunge");
    expect(html).not.toContain("<textarea");
  });

  it("renders an editable text area holding the text when onChange is given", () => {
    const html = renderToStaticMarkup(<ResultCard name="Lyrics" text="[Verse]\nhello" onChange={() => {}} />);
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Lyrics (editable)"');
    expect(html).toContain("[Verse]");
  });
});

// CoverArtCard is the (image-gen-gated) generator: a model picker plus a generate
// action. Rendered idle (no fetch on mount), so SSR markup is deterministic.
describe("CoverArtCard", () => {
  it("renders the model picker and a generate action", () => {
    const html = renderToStaticMarkup(
      <CoverArtCard prompt="a moody album cover" models={["flux-2-klein-4b", "flux-2-flex", "flux-2-pro"]} defaultModel="flux-2-klein-4b" />,
    );
    expect(html).toContain("Generate cover art");
    expect(html).toContain("flux-2-pro");
    expect(html).toContain("flux-2-klein-4b");
    expect(html).toContain('aria-label="Cover art model"');
  });
});

// StudioPage in the idle state shows no cover-art card regardless of the flag —
// the card only appears once a song has produced a result.
describe("StudioPage cover-art gating", () => {
  it("renders the idle page without a cover-art card even when image gen is enabled", () => {
    const html = renderToStaticMarkup(<StudioPage imageGenEnabled />);
    expect(html).toContain("Turn a song into a Suno prompt");
    expect(html).not.toContain("Generate cover art");
  });
});

// Studio hosts two modes; the Genre → Fanart mode only exists when the image
// generator is configured. Without it, Studio stays the single-purpose Suno tool.
describe("StudioPage mode switch", () => {
  it("offers no mode switch when image generation is off", () => {
    const html = renderToStaticMarkup(<StudioPage />);
    expect(html).not.toContain("Genre → Fanart");
    expect(html).toContain("Turn a song into a Suno prompt");
  });

  it("offers a Song → Suno / Genre → Fanart switch when image generation is on", () => {
    const html = renderToStaticMarkup(<StudioPage imageGenEnabled />);
    expect(html).toContain("Song → Suno");
    expect(html).toContain("Genre → Fanart");
    // Defaults to the Suno tool; fanart controls appear only after switching.
    expect(html).toContain("Turn a song into a Suno prompt");
    expect(html).not.toContain("Generate fanart");
  });

  it("opens directly in fanart mode when a genre is passed in", () => {
    const html = renderToStaticMarkup(<StudioPage imageGenEnabled initialGenreId="g1" />);
    expect(html).toContain("Generate fanart");
    expect(html).toContain('aria-label="Genre"');
    // The Suno reference field is not rendered in fanart mode.
    expect(html).not.toContain('aria-label="Song reference"');
  });

  it("ignores an incoming genre when image generation is off (stays Suno)", () => {
    const html = renderToStaticMarkup(<StudioPage initialGenreId="g1" />);
    expect(html).toContain("Turn a song into a Suno prompt");
    expect(html).not.toContain("Generate fanart");
  });
});
