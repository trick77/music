export type Session = { authenticated: boolean; username: string; imageGenEnabled: boolean; studioEnabled: boolean; chatEnabled: boolean; imageModels: string[]; defaultImageModel: string; authMode: string };

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
  published: boolean;
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
export async function setPlaylistPublished(id: string, published: boolean): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/${published ? "publish" : "unpublish"}`, { method: "POST" });
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

export async function deleteSong(id: string): Promise<void> {
  const r = await fetch(`/api/songs/${id}`, { method: "DELETE" });
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

export type GenreSummary = { id: string; name: string; songCount: number; accentColor: string; hasBackground: boolean };

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

export async function uploadFanart(kind: "genre" | "hero", genreId: string, file: File): Promise<Fanart> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);
  form.append("genreId", genreId);
  const r = await fetch("/api/fanart", { method: "POST", body: form });
  if (!r.ok) throw new Error(`fanart upload failed (${r.status})`);
  return r.json();
}

export async function generateFanart(prompt: string, kind: "genre" | "hero", genreId: string, model?: string): Promise<{ id: string; status: string }> {
  const r = await fetch("/api/fanart/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, kind, genreId, model }),
  });
  if (!r.ok) throw new Error(`generate failed (${r.status})`);
  return r.json();
}

export async function suggestGenrePrompt(genreId: string): Promise<string> {
  const r = await fetch(`/api/genres/${genreId}/suggest-prompt`, { method: "POST" });
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
  body: { name?: string; backgroundFanartId?: string; heroFanartId?: string; clearHero?: string },
): Promise<GenreDetail> {
  const r = await fetch(`/api/genres/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}

export type ArtistSummary = { id: string; name: string; songCount: number };

export type ArtistDetail = { artist: ArtistSummary; songs: Song[] };

export async function getArtist(id: string): Promise<ArtistDetail> {
  const r = await fetch(`/api/artists/${id}`);
  if (!r.ok) throw new Error(`failed to load artist (${r.status})`);
  return r.json();
}

// ── Phase 6: play counting, home feed, search ──────────────────────────────

export type TopTenEntry = Song & { plays: number };

export type HomeHero = {
  fanartId: string;
  kind: string;
  genreId: string;
  title: string;
  subtitle: string;
  accentColor: string;
};

export type GenreChapter = GenreSummary & { backgroundFanartId: string; songs: Song[] };

export type HomeFeed = {
  hero: HomeHero | null;
  topTen: TopTenEntry[];
  recentlyAdded: Song[];
  genres: GenreChapter[];
  playlists: Playlist[];
};

export type SearchHit = { type: "song" | "artist" | "genre" | "playlist"; id: string };

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

// reportPlay records a qualified play. It is the single public write; fire it
// once per listen (the caller dedups). Failures are non-fatal — playback
// continues regardless of whether the play was counted.
export function reportPlay(id: string): Promise<void> {
  return fetch(`/api/songs/${id}/play`, { method: "POST" }).then(() => {}, () => {});
}

// --- Favorites (logged-in users; anonymous users use localStorage) ----------
export async function getFavorites(): Promise<string[]> {
  const r = await fetch("/api/favorites");
  if (!r.ok) throw new Error(`failed to load favorites (${r.status})`);
  const data = await r.json();
  return data.ids ?? [];
}

export async function addFavorite(id: string): Promise<void> {
  const r = await fetch(`/api/favorites/${id}`, { method: "PUT" });
  if (!r.ok) throw new Error(`add favorite failed (${r.status})`);
}

export async function removeFavorite(id: string): Promise<void> {
  const r = await fetch(`/api/favorites/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`remove favorite failed (${r.status})`);
}

// --- Studio (Phase 9) -------------------------------------------------------
// Generate/refine stream Server-Sent Events: `progress` while MiMo researches,
// then a final `result` (or `error`). onProgress is called per progress event.

export type StudioProgress = { phase: string; detail: string };
export type StudioResult = { stylePrompt: string; lyrics: string; coverArtPrompt: string };

// streamStudio POSTs a JSON body and reads an SSE response, dispatching progress
// events and returning the final result (or throwing on error).
async function streamStudio(
  path: string,
  body: unknown,
  onProgress: (p: StudioProgress) => void,
): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) throw new Error(`studio request failed (${r.status})`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Record<string, unknown> | undefined;
  let errorMsg: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const lines = frame.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.slice(6).trim() : "message";
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event === "progress") onProgress(data as StudioProgress);
      else if (event === "result") result = data;
      else if (event === "error") errorMsg = String(data.error ?? "generation failed");
    }
  }
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error("studio returned no result");
  return result;
}

export async function studioGenerate(reference: string, onProgress: (p: StudioProgress) => void): Promise<StudioResult> {
  return (await streamStudio("/api/studio/generate", { reference }, onProgress)) as unknown as StudioResult;
}

export async function studioRefine(
  reference: string,
  lyrics: string,
  instruction: string,
  onProgress: (p: StudioProgress) => void,
): Promise<string> {
  const result = await streamStudio("/api/studio/refine", { reference, lyrics, instruction }, onProgress);
  return String(result.lyrics ?? "");
}

// MODEL_LABELS gives known BFL models a friendly picker label; the model list
// itself comes from the session (imageModels), so an operator-set model still
// renders (falling back to its raw id).
const MODEL_LABELS: Record<string, string> = {
  "flux-2-klein-4b": "Fast · flux-2-klein-4b",
  "flux-2-flex": "Balanced (typography) · flux-2-flex",
  "flux-2-pro": "Best quality · flux-2-pro",
};

// imageModelOptions turns the session's model ids into {id,label} picker options.
export function imageModelOptions(models: string[]): { id: string; label: string }[] {
  return (models ?? []).map((id) => ({ id, label: MODEL_LABELS[id] ?? id }));
}

export async function generateStudioCoverArt(
  prompt: string,
  model: string,
): Promise<{ id: string; status: string; width: number; height: number }> {
  const r = await fetch("/api/studio/coverart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });
  if (!r.ok) throw new Error(`cover art failed (${r.status})`);
  return r.json();
}

export function studioCoverArtUrl(id: string): string {
  return `/api/studio/coverart/${id}`;
}

export type AlbumSummary = { artistId: string; artistName: string; album: string; songCount: number; hasCover: boolean };

export async function listAlbums(): Promise<AlbumSummary[]> {
  const r = await fetch("/api/albums");
  if (!r.ok) throw new Error("failed to load albums");
  const data = await r.json();
  return data.albums ?? [];
}

export async function suggestAlbumPrompt(artistId: string, album: string): Promise<string> {
  const r = await fetch("/api/albums/suggest-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artistId, album }),
  });
  if (!r.ok) throw new Error(`suggest failed (${r.status})`);
  const data = await r.json();
  return data.prompt ?? "";
}

export async function refineGenrePrompt(genreId: string, prompt: string, instruction: string): Promise<string> {
  const r = await fetch(`/api/genres/${genreId}/refine-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, instruction }),
  });
  if (!r.ok) throw new Error(`refine failed (${r.status})`);
  const data = await r.json();
  return data.prompt ?? "";
}

export async function refineAlbumPrompt(artistId: string, album: string, prompt: string, instruction: string): Promise<string> {
  const r = await fetch("/api/albums/refine-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artistId, album, prompt, instruction }),
  });
  if (!r.ok) throw new Error(`refine failed (${r.status})`);
  const data = await r.json();
  return data.prompt ?? "";
}

export async function setAlbumCover(artistId: string, album: string, studioCoverArtId: string): Promise<{ coverArtId: string }> {
  const r = await fetch("/api/albums/cover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artistId, album, studioCoverArtId }),
  });
  if (!r.ok) throw new Error(`apply cover failed (${r.status})`);
  return r.json();
}
