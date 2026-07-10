export type ImageSize = "thumb" | "card" | "hero";

export function coverUrl(coverArtId: string, size?: ImageSize): string {
  if (!coverArtId) return "";
  return size ? `/api/cover/${coverArtId}?size=${size}` : `/api/cover/${coverArtId}`;
}

export function coverInitial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
