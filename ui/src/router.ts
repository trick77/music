import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "search" }
  | { name: "library" }
  | { name: "favorites" }
  | { name: "unpublished" }
  | { name: "playlists" }
  | { name: "genres" }
  | { name: "visualizer" }
  | { name: "studio"; genreId?: string }
  | { name: "song"; id: string }
  | { name: "playlist"; id: string }
  | { name: "genre"; id: string }
  | { name: "artist"; id: string };

export function parsePath(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts.length === 1 && parts[0] === "search") return { name: "search" };
  if (parts.length === 1 && parts[0] === "library") return { name: "library" };
  if (parts.length === 1 && parts[0] === "favorites") return { name: "favorites" };
  if (parts.length === 1 && parts[0] === "unpublished") return { name: "unpublished" };
  if (parts.length === 1 && parts[0] === "playlists") return { name: "playlists" };
  if (parts.length === 1 && parts[0] === "genres") return { name: "genres" };
  if (parts.length === 1 && parts[0] === "visualizer") return { name: "visualizer" };
  if (parts.length === 1 && parts[0] === "studio") return { name: "studio" };
  if (parts.length === 3 && parts[0] === "studio" && parts[1] === "genre") return { name: "studio", genreId: parts[2] };
  if (parts.length === 2 && parts[0] === "song") return { name: "song", id: parts[1] };
  if (parts.length === 2 && parts[0] === "playlist") return { name: "playlist", id: parts[1] };
  if (parts.length === 2 && parts[0] === "genre") return { name: "genre", id: parts[1] };
  if (parts.length === 2 && parts[0] === "artist") return { name: "artist", id: parts[1] };
  return { name: "home" };
}

// navigate performs SPA navigation without a full reload and notifies listeners.
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// useRoute re-renders on back/forward and on navigate().
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

export type PlayerParam = "lyrics" | "full";

// parsePlayerParam reads the deep-link ?player=<state> value from a query string.
// Routing (parsePath) ignores the query string; this is the only reader of it.
export function parsePlayerParam(search: string): PlayerParam | null {
  const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("player");
  return v === "lyrics" || v === "full" ? v : null;
}

// playerHref builds the deep-link URL for a player state on a song.
function playerHref(id: string, param: PlayerParam): string {
  return `/song/${id}?player=${param}`;
}

// The player overlay mirrors its state into the URL live (source of truth), so the
// address bar is always a shareable deep link. These helpers mutate history and
// dispatch a synthetic popstate because pushState/replaceState do not fire one —
// useRoute listens for it and re-renders, re-reading location.search.

// pushPlayer opens the player at a state, adding ONE history entry so the back
// button (and the close button) return to where the user was.
export function pushPlayer(id: string, param: PlayerParam): void {
  window.history.pushState({}, "", playerHref(id, param));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// replacePlayer swaps the player state in place (no new history entry) — used for
// artwork↔lyrics toggles and for following the now-playing song as the queue
// advances, neither of which should stack the back stack.
export function replacePlayer(id: string, param: PlayerParam): void {
  window.history.replaceState({}, "", playerHref(id, param));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// closePlayer dismisses the overlay. When we pushed the entry (opened in-app) we
// pop it so back-stack and history stay clean; when we arrived via a fresh deep
// link there is nothing to pop, so we strip the param in place and stay on the
// song page.
export function closePlayer(pushed: boolean): void {
  if (pushed) {
    window.history.back();
    return;
  }
  window.history.replaceState({}, "", window.location.pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
