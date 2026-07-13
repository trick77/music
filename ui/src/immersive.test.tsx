import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Hero, type GenreLink, type HeroItem } from "./Hero";
import { Chapter } from "./Chapter";
import type { GenreChapter, HomeHero, Song } from "./api";

function song(id: string, title: string): Song {
  return { id, title, artistName: "Vesper Lake", album: "", year: 0, trackNo: 0, durationMs: 200000, genres: [], coverArtId: "", published: true };
}

function item(id: string, title: string, genres: GenreLink[] = [], ranked = true): HeroItem {
  return { song: song(id, title), genres, ranked };
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
    const html = renderToStaticMarkup(<Hero hero={hero} items={[item("s1", "Neon Undertow")]} currentId={null} playing={false} onPlay={() => {}} onShare={() => {}} />);
    expect(html).toContain("Neon Undertow");
    expect(html).toContain("Play");
    expect(html).toContain("Download");
    expect(html).toContain("/api/fanart/f1?size=hero"); // presents fanart as ordinary art
    assertNoAI(html);
  });

  it("shows Pause only on the slide whose song is the one currently playing", () => {
    const html = renderToStaticMarkup(<Hero hero={hero} items={[item("s1", "Neon Undertow")]} currentId="s1" playing={true} onPlay={() => {}} onShare={() => {}} />);
    expect(html).toContain("Pause");
    expect(html).toContain("Pause Neon Undertow"); // aria-label reflects the toggle
    expect(html).not.toContain("Play"); // no stale Play affordance while playing
  });

  it("labels ranked slides #1/#2/#3 and renders a dot control per slide", () => {
    const html = renderToStaticMarkup(
      <Hero
        hero={hero}
        items={[item("s1", "Neon Undertow"), item("s2", "Chrome Sunset"), item("s3", "Afterimage")]}
        currentId={null}
        playing={false}
        onPlay={() => {}}
        onShare={() => {}}
      />,
    );
    expect(html).toContain("#1 most played");
    expect(html).toContain("#2 most played");
    expect(html).toContain("#3 most played");
    expect(html).toContain('aria-label="Show slide 3"'); // one dot per slide
  });

  it("keeps a generic 'Featured song' eyebrow for the unranked no-plays fallback", () => {
    const html = renderToStaticMarkup(
      <Hero hero={null} items={[item("s1", "Neon Undertow", [], false)]} currentId={null} playing={false} onPlay={() => {}} onShare={() => {}} />,
    );
    expect(html).toContain("Featured song");
    expect(html).not.toContain("most played"); // never assert a rank it did not earn
  });

  it("renders each genre as a middle-dot separated link to its genre page", () => {
    const html = renderToStaticMarkup(
      <Hero
        hero={hero}
        items={[item("s1", "Neon Undertow", [{ name: "Synthwave", id: "g7" }, { name: "Dream Pop", id: "g9" }])]}
        currentId={null}
        playing={false}
        onPlay={() => {}}
        onShare={() => {}}
      />,
    );
    expect(html).toContain('href="/genre/g7"');
    expect(html).toContain('href="/genre/g9"');
    expect(html).toContain("Synthwave");
    expect(html).toContain("Dream Pop");
    expect(html).toContain("·"); // middle-dot separator (U+00B7)
  });

  it("shows an unresolved genre as plain text, not a link", () => {
    const html = renderToStaticMarkup(
      <Hero hero={hero} items={[item("s1", "Neon Undertow", [{ name: "Mystery", id: null }])]} currentId={null} playing={false} onPlay={() => {}} onShare={() => {}} />,
    );
    expect(html).toContain("Mystery");
    expect(html).not.toContain("/genre/");
  });

  it("degrades gracefully with no hero imagery", () => {
    const html = renderToStaticMarkup(<Hero hero={null} items={[]} currentId={null} playing={false} onPlay={() => {}} onShare={() => {}} />);
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
