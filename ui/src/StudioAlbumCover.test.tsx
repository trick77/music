import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AlbumCoverMode } from "./StudioAlbumCover";

// AlbumCoverMode is the Studio surface that generates a square 1:1 cover for a
// library album and applies it to every song of that album. Rendered idle (no
// effects run under SSR) so the markup is deterministic and fetch-free.
describe("AlbumCoverMode", () => {
  it("renders the album picker, model picker, prompt field, and Generate action", () => {
    const html = renderToStaticMarkup(
      <AlbumCoverMode chatEnabled={false} imageModels={["flux-2-klein-4b"]} defaultImageModel="flux-2-klein-4b" />,
    );
    expect(html).toContain('aria-label="Album"');
    expect(html).toContain('aria-label="Image model"');
    expect(html).toContain('aria-label="Album cover prompt"');
    expect(html).toContain("Generate cover");
  });

  it("shows Suggest prompt and Refine only when chat is enabled", () => {
    const off = renderToStaticMarkup(<AlbumCoverMode chatEnabled={false} imageModels={[]} defaultImageModel="" />);
    expect(off).not.toContain("Suggest prompt");
    expect(off).not.toContain("Refine");
    const on = renderToStaticMarkup(<AlbumCoverMode chatEnabled={true} imageModels={[]} defaultImageModel="" />);
    expect(on).toContain("Suggest prompt");
    expect(on).toContain("Refine");
  });
});
