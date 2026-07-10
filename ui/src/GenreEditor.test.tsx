import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GenreEditor } from "./GenreEditor";
import type { GenreDetail } from "./api";

const detail: GenreDetail = {
  genre: { id: "g1", name: "Jazz", songCount: 3, accentColor: "#334455" },
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
      <GenreEditor detail={detail} imageGenEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).not.toContain("Describe the image");
    expect(html.toLowerCase()).not.toContain("generate");
  });

  it("shows the generate panel only when enabled", () => {
    const html = renderToStaticMarkup(
      <GenreEditor detail={detail} imageGenEnabled={true} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).toContain("Describe the image");
    expect(html).toContain("Generate");
  });
});
