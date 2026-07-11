import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GenreEditor } from "./GenreEditor";
import type { GenreDetail } from "./api";

const detail: GenreDetail = {
  genre: { id: "g1", name: "Jazz", songCount: 3, accentColor: "#334455", hasBackground: false },
  songs: [],
  fanart: [],
  backgroundId: "",
  heroId: "",
};

// The no-AI-in-UI invariant guarded at the render level: with generation
// disabled, the editor must not render a prompt box, a "Generate" control, or
// any AI reference — even in the raw HTML an anonymous/owner browser receives.
describe("GenreEditor no-AI-in-UI invariant", () => {
  it("hides the prompt and Generate control when generation is disabled", () => {
    const html = renderToStaticMarkup(
      <GenreEditor detail={detail} imageGenEnabled={false} chatEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).not.toContain("Describe the image");
    expect(html.toLowerCase()).not.toContain("generate");
  });

  it("hides Suggest prompt when generation is off even if chat is on", () => {
    // Suggest lives inside the generate panel: with no image generator to run
    // the prompt, the whole panel (and the AI button) stays hidden.
    const html = renderToStaticMarkup(
      <GenreEditor detail={detail} imageGenEnabled={false} chatEnabled={true} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).not.toContain("Suggest prompt");
    expect(html.toLowerCase()).not.toContain("generate");
  });

  it("shows the generate panel only when enabled", () => {
    const html = renderToStaticMarkup(
      <GenreEditor detail={detail} imageGenEnabled={true} chatEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).toContain("Describe the image");
    expect(html).toContain("Generate");
  });

  it("hides Suggest prompt unless chat is enabled", () => {
    const off = renderToStaticMarkup(
      <GenreEditor detail={detail} imageGenEnabled={true} chatEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(off).not.toContain("Suggest prompt");
    const on = renderToStaticMarkup(
      <GenreEditor detail={detail} imageGenEnabled={true} chatEnabled={true} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(on).toContain("Suggest prompt");
  });
});
