// ── Phase 6: play counting, home feed, search ──────────────────────────────
// Aggregate read models that stitch together songs, playlists, genres, and
// artists, so this module imports those base types rather than redefining them.
import type { Song } from "./songs";
import type { Playlist } from "./playlists";
import type { GenreSummary } from "./genres";
import type { ArtistSummary } from "./artists";

export type TopTenEntry = Song & { plays: number };

export type HomeHero = {
  fanartId: string;
  kind: string;
  genreId: string;
  title: string;
  subtitle: string;
  accentColor: string;
};

export type GenreChapter = GenreSummary & {
  backgroundFanartId: string;
  songs: Song[];
};

export type HomeFeed = {
  hero: HomeHero | null;
  topTen: TopTenEntry[];
  recentlyAdded: Song[];
  genres: GenreChapter[];
  playlists: Playlist[];
};

export type SearchHit = {
  type: "song" | "artist" | "genre" | "playlist";
  id: string;
};

export type SearchResults = {
  top: SearchHit | null;
  songs: Song[];
  artists: ArtistSummary[];
  genres: GenreSummary[];
  playlists: Playlist[];
};

export async function getHome(): Promise<HomeFeed> {
  const r = await fetch("/api/home");
  if (!r.ok) throw new Error(`failed to load home (${r.status})`);
  return r.json();
}

export async function getTopTen(): Promise<TopTenEntry[]> {
  const r = await fetch("/api/top-ten");
  if (!r.ok) throw new Error(`failed to load top-ten (${r.status})`);
  const data = await r.json();
  return data.songs ?? [];
}

export async function search(q: string): Promise<SearchResults> {
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  return r.json();
}
