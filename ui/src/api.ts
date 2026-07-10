export type Session = { authenticated: boolean; username: string };

export type Song = {
  id: string;
  title: string;
  artistName: string;
  album: string;
  year: number;
  trackNo: number;
  durationMs: number;
  genres: string[];
  coverArtId: string;
};

export type SongEdit = {
  title: string;
  artistName: string;
  album: string;
  year: number;
  trackNo: number;
  genres: string[];
};

export type Suggestion = { value: string; count: number };

export async function getSession(): Promise<Session> {
  const r = await fetch("/api/auth/session");
  return r.json();
}

export async function listSongs(): Promise<Song[]> {
  const r = await fetch("/api/songs");
  if (!r.ok) throw new Error("failed to load songs");
  const data = await r.json();
  return data.songs ?? [];
}

export async function uploadSong(file: File): Promise<Song> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/songs", { method: "POST", body: form });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  return r.json();
}

export function streamUrl(id: string): string {
  return `/api/songs/${id}/stream`;
}

export async function updateSong(id: string, edit: SongEdit): Promise<Song> {
  const r = await fetch(`/api/songs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edit),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}

export async function suggest(field: "artist" | "album" | "genre", q: string): Promise<Suggestion[]> {
  const r = await fetch(`/api/suggest?field=${field}&q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  const data = await r.json();
  return data.suggestions ?? [];
}

export async function uploadCover(id: string, file: File): Promise<Song> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/songs/${id}/cover`, { method: "PUT", body: form });
  if (!r.ok) throw new Error(`cover upload failed (${r.status})`);
  return r.json();
}
