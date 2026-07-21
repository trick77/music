// Genres & fanart: genre browse/detail plus the fanart (background/hero) upload,
// AI generation, and prompt helpers.
import type { Song } from "./songs";

export type Fanart = {
  id: string;
  kind: "genre" | "hero";
  genreId: string;
  status: "generating" | "ready" | "failed";
  caption: string;
  isActive: boolean;
  isHero: boolean;
  width: number;
  height: number;
  error?: string;
};

export type GenreSummary = {
  id: string;
  name: string;
  songCount: number;
  accentColor: string;
  hasBackground: boolean;
  backgroundFanartId: string;
};

export type GenreDetail = {
  genre: GenreSummary;
  songs: Song[];
  fanart: Fanart[];
  backgroundId: string;
  heroId: string;
};

export async function listGenres(): Promise<GenreSummary[]> {
  const r = await fetch("/api/genres");
  if (!r.ok) throw new Error("failed to load genres");
  const data = await r.json();
  return data.genres ?? [];
}

export async function getGenre(id: string): Promise<GenreDetail> {
  const r = await fetch(`/api/genres/${id}`);
  if (!r.ok) throw new Error(`failed to load genre (${r.status})`);
  return r.json();
}

export async function uploadFanart(
  kind: "genre" | "hero",
  genreId: string,
  file: File,
): Promise<Fanart> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);
  form.append("genreId", genreId);
  const r = await fetch("/api/fanart", { method: "POST", body: form });
  if (!r.ok) throw new Error(`fanart upload failed (${r.status})`);
  return r.json();
}

export async function generateFanart(
  prompt: string,
  kind: "genre" | "hero",
  genreId: string,
  model?: string,
): Promise<{ id: string; status: string }> {
  const r = await fetch("/api/fanart/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, kind, genreId, model }),
  });
  if (!r.ok) throw new Error(`generate failed (${r.status})`);
  return r.json();
}

export async function suggestGenrePrompt(genreId: string): Promise<string> {
  const r = await fetch(`/api/genres/${genreId}/suggest-prompt`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`suggest failed (${r.status})`);
  const data = await r.json();
  return data.prompt ?? "";
}

export async function getFanartMeta(id: string): Promise<Fanart> {
  const r = await fetch(`/api/fanart/${id}?meta=1`);
  if (!r.ok) throw new Error(`fanart meta failed (${r.status})`);
  return r.json();
}

export async function patchGenre(
  id: string,
  body: {
    name?: string;
    backgroundFanartId?: string;
    heroFanartId?: string;
    clearHero?: string;
  },
): Promise<GenreDetail> {
  const r = await fetch(`/api/genres/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}

export async function refineGenrePrompt(
  genreId: string,
  prompt: string,
  instruction: string,
): Promise<string> {
  const r = await fetch(`/api/genres/${genreId}/refine-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, instruction }),
  });
  if (!r.ok) throw new Error(`refine failed (${r.status})`);
  const data = await r.json();
  return data.prompt ?? "";
}
