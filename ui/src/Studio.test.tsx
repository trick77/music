import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./Rail";
import { StudioPage } from "./StudioPage";

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
