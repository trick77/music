import { useCallback, useEffect, useState } from "react";

export type Store = Pick<Storage, "getItem" | "setItem">;

const KEY = "music.favorites";

export function loadFavorites(store: Store): string[] {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function toggleFavorite(store: Store, id: string): string[] {
  const list = loadFavorites(store);
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  store.setItem(KEY, JSON.stringify(next));
  return next;
}

export function isFavorite(list: string[], id: string): boolean {
  return list.includes(id);
}

// useFavorites is the React binding over window.localStorage. It stays in sync
// across components/tabs via the storage event.
export function useFavorites() {
  const [ids, setIds] = useState<string[]>(() => loadFavorites(window.localStorage));
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setIds(loadFavorites(window.localStorage));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = useCallback((id: string) => setIds(toggleFavorite(window.localStorage, id)), []);
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { ids, toggle, has };
}
