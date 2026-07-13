// Artists: the artist summary/detail types and the single detail fetch.
import type { Song } from "./songs";

export type ArtistSummary = { id: string; name: string; songCount: number };

export type ArtistDetail = { artist: ArtistSummary; songs: Song[] };

export async function getArtist(id: string): Promise<ArtistDetail> {
  const r = await fetch(`/api/artists/${id}`);
  if (!r.ok) throw new Error(`failed to load artist (${r.status})`);
  return r.json();
}
