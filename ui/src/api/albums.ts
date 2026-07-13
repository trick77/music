// Albums: the album summary browse plus the Studio cover-art prompt/apply flow
// keyed by artist + album.

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
