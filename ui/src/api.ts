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

export type Playlist = {
  id: string;
  name: string;
  description: string;
  coverArtId: string;
  songCount: number;
};

export type PlaylistDetail = Playlist & { songs: Song[] };

export async function listPlaylists(): Promise<Playlist[]> {
  const r = await fetch("/api/playlists");
  if (!r.ok) throw new Error("failed to load playlists");
  const data = await r.json();
  return data.playlists ?? [];
}

export async function getPlaylist(id: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}`);
  if (!r.ok) throw new Error(`failed to load playlist (${r.status})`);
  return r.json();
}

export async function createPlaylist(name: string, description: string): Promise<PlaylistDetail> {
  const r = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error(`create failed (${r.status})`);
  return r.json();
}

export async function updatePlaylist(id: string, name: string, description: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}

export async function deletePlaylist(id: string): Promise<void> {
  const r = await fetch(`/api/playlists/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete failed (${r.status})`);
}

export async function addSongToPlaylist(id: string, songId: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/songs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songId }),
  });
  if (!r.ok) throw new Error(`add failed (${r.status})`);
  return r.json();
}

export async function removeSongFromPlaylist(id: string, songId: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/songs/${songId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`remove failed (${r.status})`);
  return r.json();
}

export async function reorderPlaylist(id: string, songIds: string[]): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songIds }),
  });
  if (!r.ok) throw new Error(`reorder failed (${r.status})`);
  return r.json();
}

export async function uploadPlaylistCover(id: string, file: File): Promise<PlaylistDetail> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/playlists/${id}/cover`, { method: "PUT", body: form });
  if (!r.ok) throw new Error(`cover upload failed (${r.status})`);
  return r.json();
}
