import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./Rail";
import { StudioPage, ResultCard } from "./StudioPage";

// The Studio rail slot follows the presence-vs-absence model: it appears only
// when the viewer is authenticated AND Studio is configured (studioEnabled).
describe("Rail Studio slot", () => {
  const render = (authenticated: boolean, studioEnabled: boolean) =>
    renderToStaticMarkup(
      <Rail route={{ name: "home" }} authenticated={authenticated} studioEnabled={studioEnabled} onUpload={() => {}} />,
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
