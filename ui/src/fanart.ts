export type FanartSize = "thumb" | "card" | "hero";

export function fanartUrl(id: string, size?: FanartSize): string {
  if (!id) return "";
  return size ? `/api/fanart/${id}?size=${size}` : `/api/fanart/${id}`;
}

export function genreInitial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
