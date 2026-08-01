import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, listAlbums: vi.fn() };
});

import { AlbumCoverMode } from "./StudioAlbumCover";
import * as api from "./api";
import type { AlbumSummary } from "./api";
const mocked = vi.mocked(api);

function album(over: Partial<AlbumSummary> = {}): AlbumSummary {
  return {
    artistId: "a1",
    artistName: "Metallica",
    album: "Metallica",
    songCount: 12,
    hasCover: false,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

// AlbumCoverMode is the Studio surface that generates a square 1:1 cover for a
// library album and applies it to every song of that album. Rendered idle (no
// effects run under SSR) so the markup is deterministic and fetch-free.
describe("AlbumCoverMode", () => {
  it("renders the album picker, model picker, prompt field, and Generate action", () => {
    const html = renderToStaticMarkup(
      <AlbumCoverMode
        chatEnabled={false}
        imageModels={["flux-2-klein-4b"]}
        defaultImageModel="flux-2-klein-4b"
      />,
    );
    expect(html).toContain('aria-label="Album"');
    expect(html).toContain('aria-label="Image model"');
    expect(html).toContain('aria-label="Album cover prompt"');
    expect(html).toContain("Generate cover");
  });

  it("shows Suggest prompt and Refine only when chat is enabled", () => {
    const off = renderToStaticMarkup(
      <AlbumCoverMode
        chatEnabled={false}
        imageModels={[]}
        defaultImageModel=""
      />,
    );
    expect(off).not.toContain("Suggest prompt");
    expect(off).not.toContain("Refine");
    const on = renderToStaticMarkup(
      <AlbumCoverMode
        chatEnabled={true}
        imageModels={[]}
        defaultImageModel=""
      />,
    );
    expect(on).toContain("Suggest prompt");
    expect(on).toContain("Refine");
  });

  // This mode exists to fill gaps, so an album that already has artwork is not a
  // candidate — in a full library those would bury the few that need one.
  it("lists only albums that are missing cover art", async () => {
    mocked.listAlbums.mockResolvedValue([
      album({ artistId: "a1", album: "Ride the Lightning", hasCover: false }),
      album({ artistId: "a2", artistName: "New Order", album: "Power, Corruption & Lies", hasCover: true }),
      album({ artistId: "a3", artistName: "Slayer", album: "Reign in Blood", hasCover: false }),
    ]);
    render(
      <AlbumCoverMode chatEnabled={false} imageModels={[]} defaultImageModel="" />,
    );
    expect(await screen.findByRole("option", { name: /Ride the Lightning/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Reign in Blood/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Power, Corruption/ })).not.toBeInTheDocument();
  });

  it("says so when every album already has artwork", async () => {
    mocked.listAlbums.mockResolvedValue([album({ hasCover: true })]);
    render(
      <AlbumCoverMode chatEnabled={false} imageModels={[]} defaultImageModel="" />,
    );
    expect(
      await screen.findByRole("option", { name: /no albums are missing artwork/i }),
    ).toBeInTheDocument();
  });
});
