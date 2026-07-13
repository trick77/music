// Songs: the core track type plus its CRUD, upload, cover, and play-report
// endpoints. Song is the base type most other domains build on, so it lives here
// and is imported by playlists/genres/artists/home rather than the other way round.

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
  lyrics?: string;
  published: boolean;
  alignmentStatus?: "" | "generating" | "ready" | "failed";
};

export type SongEdit = {
  title: string;
  artistName: string;
  album: string;
  year: number;
  trackNo: number;
  genres: string[];
  lyrics: string;
};

export type Suggestion = { value: string; count: number };

export async function listSongs(): Promise<Song[]> {
  const r = await fetch("/api/songs");
  if (!r.ok) throw new Error("failed to load songs");
  const data = await r.json();
  return data.songs ?? [];
}

// uploadSong posts an MP3 and, unlike fetch(), reports byte-level upload
// progress via onProgress (0–100) — fetch has no upload-progress API, so we
// drop to XMLHttpRequest to hook xhr.upload.onprogress. onProgress fires up to
// 100% as bytes leave the client; the server then hashes/dedupes before
// responding, so callers should show an indeterminate state at 100%.
export function uploadSong(file: File, onProgress?: (pct: number) => void): Promise<Song> {
  const form = new FormData();
  form.append("file", file);
  return new Promise<Song>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/songs");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      // 201 Created, or 200 on a content-hash dedupe hit — both return a Song.
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          resolve(JSON.parse(xhr.responseText) as Song);
        } catch {
          reject(new Error("upload failed (bad response)"));
        }
      } else {
        reject(new Error(`upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed (network error)"));
    xhr.send(form);
  });
}

export function streamUrl(id: string): string {
  return `/api/songs/${id}/stream`;
}

// setPublished flips a song's publish state. Uploads land unpublished (visible
// only to logged-in users); publishing makes a song visible to everyone.
export async function setPublished(id: string, published: boolean): Promise<Song> {
  const r = await fetch(`/api/songs/${id}/${published ? "publish" : "unpublish"}`, { method: "POST" });
  if (!r.ok) throw new Error(`publish toggle failed (${r.status})`);
  return r.json();
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

export async function removeCover(id: string): Promise<Song> {
  const r = await fetch(`/api/songs/${id}/cover`, { method: "DELETE" });
  if (!r.ok) throw new Error(`cover removal failed (${r.status})`);
  return r.json();
}

export async function deleteSong(id: string): Promise<void> {
  const r = await fetch(`/api/songs/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete failed (${r.status})`);
}

// reportPlay records a qualified play. It is the single public write; fire it
// once per listen (the caller dedups). Failures are non-fatal — playback
// continues regardless of whether the play was counted.
export function reportPlay(id: string): Promise<void> {
  return fetch(`/api/songs/${id}/play`, { method: "POST" }).then(() => {}, () => {});
}
