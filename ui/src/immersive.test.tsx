import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Hero } from "./Hero";
import { Chapter } from "./Chapter";
import type { GenreChapter, HomeHero, Song } from "./api";

function song(id: string, title: string): Song {
  return { id, title, artistName: "Vesper Lake", album: "", year: 0, trackNo: 0, durationMs: 200000, genres: [], coverArtId: "", published: true };
}

const AI_TERMS = ["generate", "prompt", "flux", "bfl", " ai ", "model:", "seed"];

function assertNoAI(html: string) {
  const lower = html.toLowerCase();
  for (const t of AI_TERMS) {
    expect(lower).not.toContain(t);
  }
}

describe("Hero", () => {
  const hero: HomeHero = { fanartId: "f1", kind: "genre", genreId: "g1", title: "Neon Undertow", subtitle: "", accentColor: "#c6613f" };

  it("renders the featured song with Play/Download/Share and no AI reference", () => {
    const html = renderToStaticMarkup(<Hero hero={hero} featured={song("s1", "Neon Undertow")} onPlay={() => {}} onShare={() => {}} />);
    expect(html).toContain("Neon Undertow");
    expect(html).toContain("Play");
    expect(html).toContain("Download");
    expect(html).toContain("/api/fanart/f1?size=hero"); // presents fanart as ordinary art
    assertNoAI(html);
  });

  it("degrades gracefully with no hero imagery", () => {
    const html = renderToStaticMarkup(<Hero hero={null} featured={null} onPlay={() => {}} onShare={() => {}} />);
    expect(html).toContain("Your library");
    assertNoAI(html);
  });
});

describe("Chapter", () => {
  const chapter: GenreChapter = {
    id: "g1",
    name: "Synthwave",
    songCount: 2,
    accentColor: "#d97757",
    hasBackground: true,
    backgroundFanartId: "f2",
    songs: [song("s1", "Chrome Sunset"), song("s2", "Afterimage")],
  };

  it("renders the genre chapter with its songs and no AI reference", () => {
    const html = renderToStaticMarkup(<Chapter chapter={chapter} onPlay={() => {}} />);
    expect(html).toContain("Synthwave");
    expect(html).toContain("Chrome Sunset");
    expect(html).toContain("/api/fanart/f2?size=hero");
    assertNoAI(html);
  });
});
