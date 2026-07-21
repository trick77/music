// Playlists: CRUD plus the AI cover/description helpers. Playlists own an
// ordered list of songs, so the detail type references Song.
import type { Song } from "./songs";

export type Playlist = {
  id: string;
  name: string;
  description: string;
  coverArtId: string;
  songCount: number;
  published: boolean;
};

export type PlaylistDetail = Playlist & { songs: Song[] };

// setPlaylistPublished flips a playlist's publish state. Playlists are created
// unpublished (visible only to logged-in users) until published, like songs.
export async function setPlaylistPublished(
  id: string,
  published: boolean,
): Promise<PlaylistDetail> {
  const r = await fetch(
    `/api/playlists/${id}/${published ? "publish" : "unpublish"}`,
    { method: "POST" },
  );
  if (!r.ok) throw new Error(`playlist publish toggle failed (${r.status})`);
  return r.json();
}

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

export async function createPlaylist(
  name: string,
  description: string,
): Promise<PlaylistDetail> {
  const r = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error(`create failed (${r.status})`);
  return r.json();
}

export async function updatePlaylist(
  id: string,
  name: string,
  description: string,
): Promise<PlaylistDetail> {
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

export async function addSongToPlaylist(
  id: string,
  songId: string,
): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/songs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songId }),
  });
  if (!r.ok) throw new Error(`add failed (${r.status})`);
  return r.json();
}

export async function removeSongFromPlaylist(
  id: string,
  songId: string,
): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/songs/${songId}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`remove failed (${r.status})`);
  return r.json();
}

export async function reorderPlaylist(
  id: string,
  songIds: string[],
): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songIds }),
  });
  if (!r.ok) throw new Error(`reorder failed (${r.status})`);
  return r.json();
}

export async function uploadPlaylistCover(
  id: string,
  file: File,
): Promise<PlaylistDetail> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/playlists/${id}/cover`, {
    method: "PUT",
    body: form,
  });
  if (!r.ok) throw new Error(`cover upload failed (${r.status})`);
  return r.json();
}

export async function suggestPlaylistPrompt(
  id: string,
): Promise<{ prompt: string }> {
  const r = await fetch(`/api/playlists/${id}/suggest-prompt`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`suggest failed (${r.status})`);
  return r.json();
}

export async function refinePlaylistPrompt(
  id: string,
  current: string,
  instruction: string,
): Promise<{ prompt: string }> {
  const r = await fetch(`/api/playlists/${id}/refine-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current, instruction }),
  });
  if (!r.ok) throw new Error(`refine failed (${r.status})`);
  return r.json();
}

// applyPlaylistCover maps a previously generated Studio cover-art image to a
// playlist. Mirrors setAlbumCover: the backend just stores/dedupes the cover
// and returns its id, not the full playlist detail.
export async function applyPlaylistCover(
  id: string,
  studioCoverArtId: string,
): Promise<{ coverArtId: string }> {
  const r = await fetch(`/api/playlists/${id}/cover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ studioCoverArtId }),
  });
  if (!r.ok) throw new Error(`apply cover failed (${r.status})`);
  return r.json();
}

export async function suggestPlaylistDescriptions(
  id: string,
): Promise<{ punchy: string; evocative: string; factual: string }> {
  const r = await fetch(`/api/playlists/${id}/suggest-description`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`suggest failed (${r.status})`);
  return r.json();
}

export async function updatePlaylistDescription(
  id: string,
  description: string,
): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}
