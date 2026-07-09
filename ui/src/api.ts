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
};

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
