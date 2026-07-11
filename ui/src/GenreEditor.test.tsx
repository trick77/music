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

// Generation moved to Studio: the editor manages upload / gallery / active
// background, but never runs an in-browser generator. The no-AI-in-UI invariant
// now means no prompt box and no in-modal generate control at all.
describe("GenreEditor generation moved to Studio", () => {
  it("renders no prompt box or in-modal generate control", () => {
    const html = renderToStaticMarkup(
      <GenreEditor detail={detail} studioEnabled={false} imageGenEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).not.toContain("Describe the image");
    expect(html).not.toContain("Suggest prompt");
    expect(html).not.toContain("<textarea");
  });

  it("shows 'Generate in Studio' only when BOTH Studio and image generation are configured", () => {
    const neither = renderToStaticMarkup(
      <GenreEditor detail={detail} studioEnabled={false} imageGenEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(neither).not.toContain("Generate in Studio");

    // Studio present but no image generator — the link must stay hidden so it
    // never dead-ends into the Suno tool (the two entry points share one gate).
    const noImageGen = renderToStaticMarkup(
      <GenreEditor detail={detail} studioEnabled={true} imageGenEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(noImageGen).not.toContain("Generate in Studio");

    const both = renderToStaticMarkup(
      <GenreEditor detail={detail} studioEnabled={true} imageGenEnabled={true} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(both).toContain("Generate in Studio");
  });

  it("keeps the upload affordance regardless of Studio availability", () => {
    const html = renderToStaticMarkup(
      <GenreEditor detail={detail} studioEnabled={false} imageGenEnabled={false} onClose={() => {}} onChanged={() => {}} />,
    );
    expect(html).toContain("Upload");
  });
});
