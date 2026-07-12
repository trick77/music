import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "search" }
  | { name: "library" }
  | { name: "favorites" }
  | { name: "playlists" }
  | { name: "genres" }
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
  if (parts.length === 1 && parts[0] === "playlists") return { name: "playlists" };
  if (parts.length === 1 && parts[0] === "genres") return { name: "genres" };
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
