export function coverUrl(coverArtId: string): string {
  return coverArtId ? `/api/cover/${coverArtId}` : "";
}

export function coverInitial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
