import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GenreFanartMode } from "./StudioGenreFanart";

// GenreFanartMode is the Studio surface that generates a wide genre background.
// It reuses the existing generate + suggest-prompt endpoints; rendered idle (no
// effects run under SSR) so the markup is deterministic and fetch-free.
describe("GenreFanartMode", () => {
  it("renders the genre picker, prompt field, and Generate action", () => {
    const html = renderToStaticMarkup(<GenreFanartMode chatEnabled={false} imageModels={["flux-2-klein-4b"]} defaultImageModel="flux-2-klein-4b" />);
    expect(html).toContain('aria-label="Genre"');
    expect(html).toContain('aria-label="Fanart prompt"');
    expect(html).toContain("Generate fanart");
  });

  it("shows Suggest prompt only when chat is enabled", () => {
    const off = renderToStaticMarkup(<GenreFanartMode chatEnabled={false} imageModels={[]} defaultImageModel="" />);
    expect(off).not.toContain("Suggest prompt");
    const on = renderToStaticMarkup(<GenreFanartMode chatEnabled={true} imageModels={[]} defaultImageModel="" />);
    expect(on).toContain("Suggest prompt");
  });
});
