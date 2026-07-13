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
