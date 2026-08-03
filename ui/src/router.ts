import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "search" }
  | { name: "library" }
  | { name: "recent" }
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
  if (parts.length === 1 && parts[0] === "recent") return { name: "recent" };
  if (parts.length === 1 && parts[0] === "favorites")
    return { name: "favorites" };
  if (parts.length === 1 && parts[0] === "unpublished")
    return { name: "unpublished" };
  if (parts.length === 1 && parts[0] === "playlists")
    return { name: "playlists" };
  if (parts.length === 1 && parts[0] === "genres") return { name: "genres" };
  if (parts.length === 1 && parts[0] === "visualizer")
    return { name: "visualizer" };
  if (parts.length === 1 && parts[0] === "studio") return { name: "studio" };
  if (parts.length === 3 && parts[0] === "studio" && parts[1] === "genre")
    return { name: "studio", genreId: parts[2] };
  if (parts.length === 2 && parts[0] === "song")
    return { name: "song", id: parts[1] };
  if (parts.length === 2 && parts[0] === "playlist")
    return { name: "playlist", id: parts[1] };
  if (parts.length === 2 && parts[0] === "genre")
    return { name: "genre", id: parts[1] };
  if (parts.length === 2 && parts[0] === "artist")
    return { name: "artist", id: parts[1] };
  return { name: "home" };
}

// Every entry we push carries this marker, so a close can tell an in-app entry
// (something to return to) from a cold deep link (nothing behind it). Reading
// history.length can't make that call: it counts the whole tab's history,
// including pages from before this app was loaded.
// `from` records the player state an entry was opened *out of*, which is what
// lets the lyrics view fall back to the big player behind it instead of
// rewriting itself into a second copy of it.
type HistoryState = { appPushed?: boolean; from?: PlayerParam };

function appState(from?: PlayerParam): HistoryState {
  return from ? { appPushed: true, from } : { appPushed: true };
}

// navigate performs SPA navigation without a full reload and notifies listeners.
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(appState(), "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// useRoute re-renders on back/forward and on navigate().
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parsePath(window.location.pathname),
  );
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
  const v = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  ).get("player");
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
// button (and the close button) return to where the user was. `from` names the
// player state it was opened out of, when it was opened out of one.
export function pushPlayer(
  id: string,
  param: PlayerParam,
  from?: PlayerParam,
): void {
  window.history.pushState(appState(from), "", playerHref(id, param));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// replacePlayer swaps the player state in place (no new history entry) — used to
// open the overlay on a deep link and to follow the now-playing song as the queue
// advances, neither of which should stack the back stack. It carries the current
// entry's marker across: replacing must not turn a deep-link entry into one that
// looks in-app, or vice versa.
export function replacePlayer(id: string, param: PlayerParam): void {
  window.history.replaceState(window.history.state, "", playerHref(id, param));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// leaveLyricsForArtwork drops the lyrics view when the loaded track turns out to
// have no lyrics (skipping to one, or a dishonest deep link).
//
// When this entry was pushed out of the big player, POP it: the artwork view is
// already sitting behind us, and rewriting this entry into a second copy of it
// would leave a duplicate that every later close has to step through — the X
// would land on the twin and look dead. Otherwise (opened straight from the mini
// bar, or a cold deep link) there's no artwork view behind to fall back to, so
// rewrite in place and keep the player open.
export function leaveLyricsForArtwork(id: string): void {
  const state = window.history.state as HistoryState | null;
  if (state?.appPushed && state.from === "full") {
    window.history.back();
    return;
  }
  replacePlayer(id, "full");
}

// closeToOrigin dismisses a full-screen surface (the player overlay, the
// visualizer) back to wherever it was opened from — the big player it was
// launched out of, or the page the mini bar was sitting on. When we didn't push
// the entry there is nothing behind it (a cold deep link), so go Home: a real
// page, rather than stranding the visitor on a bare /song/:id URL.
export function closeToOrigin(): void {
  const state = window.history.state as HistoryState | null;
  if (state?.appPushed) {
    window.history.back();
    return;
  }
  navigate("/");
}
