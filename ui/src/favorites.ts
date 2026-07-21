import { useCallback, useEffect, useState } from "react";
import { addFavorite, getFavorites, removeFavorite } from "./api";

export type Store = Pick<Storage, "getItem" | "setItem">;

const KEY = "music.favorites";

export function loadFavorites(store: Store): string[] {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
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

// useFavorites is the React binding for the favorites feature. It exposes a
// backend-agnostic { ids, toggle, has } interface; call sites don't care where
// favorites live. The `authed` argument selects the backend:
//   - null  → auth still loading: hold an empty list, never read or write
//             (avoids a flash and prevents writing to the wrong backend).
//   - false → anonymous: browser localStorage, synced across tabs via `storage`.
//   - true  → logged in: the server (GET/PUT/DELETE /api/favorites), optimistic
//             toggle with revert-on-failure.
export function useFavorites(authed: boolean | null) {
  const [ids, setIds] = useState<string[]>(() =>
    authed === false ? loadFavorites(window.localStorage) : [],
  );

  // Anonymous: cross-tab sync via the storage event.
  useEffect(() => {
    if (authed !== false) return;
    setIds(loadFavorites(window.localStorage));
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setIds(loadFavorites(window.localStorage));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [authed]);

  // Logged in: load the server list once auth is known. Reset to empty first so
  // the logged-in view never reflects a stale localStorage list (and a toggle in
  // the load window can't compute against it and write the wrong state).
  useEffect(() => {
    if (authed !== true) return;
    setIds([]);
    let cancelled = false;
    getFavorites().then(
      (list) => {
        if (!cancelled) setIds(list);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [authed]);

  const toggle = useCallback(
    (id: string) => {
      if (authed === null) return; // auth unknown: ignore
      if (authed === false) {
        setIds(toggleFavorite(window.localStorage, id));
        return;
      }
      // Logged in: optimistic update, then persist; revert on failure.
      const willAdd = !ids.includes(id);
      setIds((prev) =>
        willAdd ? [...prev, id] : prev.filter((x) => x !== id),
      );
      const persist = willAdd ? addFavorite(id) : removeFavorite(id);
      persist.catch(() => {
        setIds((prev) =>
          willAdd
            ? prev.filter((x) => x !== id)
            : prev.includes(id)
              ? prev
              : [...prev, id],
        );
      });
    },
    [authed, ids],
  );
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { ids, toggle, has };
}
