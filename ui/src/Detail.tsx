import { useEffect, useState, type ReactNode } from "react";
import {
  getGenre,
  getArtist,
  getPlaylist,
  setPlaylistPublished,
  type GenreDetail as GD,
  type PlaylistDetail as PD,
  type Song,
} from "./api";
import { fanartUrl } from "./fanart";
import { coverUrl, coverInitial } from "./cover";
import { navigate } from "./router";
import { playlistShareUrl } from "./share";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { GenreEditor } from "./GenreEditor";

export type DetailKind = "genre" | "artist" | "playlist";

type View = {
  title: string;
  subtitle: string;
  bg: string;
  accent: string;
  songs: Song[];
  shareUrl: string;
  onEdit?: () => void;
};

type Props = {
  kind: DetailKind;
  id: string;
  authenticated: boolean;
  studioEnabled: boolean;
  imageGenEnabled: boolean;
  onPlay: (s: Song, tail: Song[]) => void;
  onShare: (url: string) => void;
  onEditPlaylist: (pl: PD) => void;
  renderRowActions: (s: Song) => ReactNode;
  /** Bump to force a re-fetch of this page's songs (e.g. after a tag edit). */
  reloadKey?: number;
};

// Detail is the single immersive template for genre / artist / playlist pages:
// full-bleed art owns the top, and a glass song-list panel overlaps its lower
// edge. Per-kind data loads behind one shared layout so arrangements can change
// without a rewrite. Existing edit flows (genre background editor, playlist
// editor) are preserved behind the authenticated flag.
export function Detail({ kind, id, authenticated, studioEnabled, imageGenEnabled, onPlay, onShare, onEditPlaylist, renderRowActions, reloadKey }: Props) {
  const [genre, setGenre] = useState<GD | null>(null);
  const [playlist, setPlaylist] = useState<PD | null>(null);
  const [artist, setArtist] = useState<{ artist: { id: string; name: string; songCount: number }; songs: Song[] } | null>(null);
  const [editingGenre, setEditingGenre] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const loadGenre = () => getGenre(id).then(setGenre).catch(() => setNotFound(true));

  // Toggle a playlist's publish state (mirrors song publishing). Unpublished
  // playlists are visible only to logged-in users.
  const togglePlaylistPublish = async () => {
    if (!playlist) return;
    try {
      setPlaylist(await setPlaylistPublished(playlist.id, !playlist.published));
    } catch {
      /* leave state as-is on failure */
    }
  };

  // Clear stale content only when navigating to a different page. A reloadKey
  // bump (e.g. after a tag edit) must NOT null the view — that would flash a
  // "Loading…" over the current page; the fetch below swaps new data in place.
  useEffect(() => {
    setGenre(null);
    setPlaylist(null);
    setArtist(null);
    setNotFound(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  useEffect(() => {
    if (kind === "genre") loadGenre();
    else if (kind === "playlist") getPlaylist(id).then(setPlaylist).catch(() => setNotFound(true));
    else getArtist(id).then(setArtist).catch(() => setNotFound(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, reloadKey]);

  if (notFound) {
    return (
      <p style={{ color: "var(--color-muted)" }}>
        Not found.{" "}
        <button onClick={() => navigate("/")} style={linkBtn}>Home</button>
      </p>
    );
  }

  let view: View | null = null;
  if (kind === "genre" && genre) {
    view = {
      title: genre.genre.name,
      subtitle: `${genre.genre.songCount} ${genre.genre.songCount === 1 ? "track" : "tracks"}`,
      bg: fanartUrl(genre.backgroundId, "hero"),
      accent: genre.genre.accentColor || "var(--color-accent)",
      songs: genre.songs,
      shareUrl: `${location.origin}/genre/${genre.genre.id}`,
      onEdit: authenticated ? () => setEditingGenre(true) : undefined,
    };
  } else if (kind === "playlist" && playlist) {
    view = {
      title: playlist.name,
      subtitle: playlist.description || `${playlist.songCount} ${playlist.songCount === 1 ? "song" : "songs"}`,
      bg: coverUrl(playlist.coverArtId, "hero"),
      accent: "var(--color-accent)",
      songs: playlist.songs,
      shareUrl: playlistShareUrl(playlist.id),
      onEdit: authenticated ? () => onEditPlaylist(playlist) : undefined,
    };
  } else if (kind === "artist" && artist) {
    view = {
      title: artist.artist.name,
      subtitle: `${artist.artist.songCount} ${artist.artist.songCount === 1 ? "song" : "songs"}`,
      bg: coverUrl(artist.songs[0]?.coverArtId ?? "", "hero"),
      accent: "var(--color-accent)",
      songs: artist.songs,
      shareUrl: `${location.origin}/artist/${artist.artist.id}`,
    };
  }

  if (!view) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;
  const { songs } = view;

  return (
    <div>
      <div
        style={{
          position: "relative",
          borderRadius: 18,
          overflow: "hidden",
          minHeight: "clamp(300px, 46vh, 480px)",
          display: "flex",
          alignItems: "flex-end",
          background: view.bg
            ? `url(${view.bg}) center/cover no-repeat`
            : `linear-gradient(135deg, ${view.accent}, var(--color-panel))`,
        }}
      >
        <div className="scrim" />
        <button onClick={() => history.back()} aria-label="Back" style={{ ...linkBtn, position: "absolute", top: 14, left: 14, width: 40, height: 40, color: "#fff", display: "grid", placeItems: "center" }}>
          <Icon name="chevronLeft" size="24px" />
        </button>
        <div style={{ position: "relative", padding: "clamp(1.1rem, 2.6vw, 2rem)", width: "100%" }}>
          <div style={{ fontSize: "var(--text-micro)", letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.8)" }}>
            {kind}
            {kind === "playlist" && authenticated && playlist && !playlist.published && (
              <span style={{ marginLeft: 8, padding: "0.1rem 0.45rem", borderRadius: 999, border: "1px solid rgba(255,255,255,0.5)", fontSize: "var(--text-micro)" }}>Unpublished</span>
            )}
          </div>
          <h1 style={{ margin: "0.15rem 0 0.35rem", fontFamily: "var(--font-serif)", fontSize: "clamp(1.8rem, 4vw, 2.8rem)", color: "#fff", textShadow: "0 2px 18px rgba(0,0,0,0.55)" }}>{view.title}</h1>
          <p style={{ margin: "0 0 1rem", color: "rgba(255,255,255,0.85)" }}>{view.subtitle}</p>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            {songs.length > 0 && (
              <button onClick={() => onPlay(songs[0], songs.slice(1))} style={pillPrimary}>
                <Glyph name="play" size={18} /> Play
              </button>
            )}
            <button onClick={() => onShare(view!.shareUrl)} style={pillGhost}>
              <Icon name="share" size="18px" /> Share
            </button>
            {view.onEdit && (
              <button onClick={view.onEdit} style={pillGhost}>Edit</button>
            )}
            {kind === "playlist" && authenticated && playlist && (
              <button onClick={togglePlaylistPublish} style={pillGhost}>
                <Icon name="globe" size="18px" /> {playlist.published ? "Unpublish" : "Publish"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="glass" style={{ borderRadius: 16, marginTop: "-1.5rem", position: "relative", padding: "0.5rem 1rem" }}>
        {songs.length === 0 ? (
          <p style={{ color: "var(--color-muted)", padding: "1rem" }}>No songs yet.</p>
        ) : (
          songs.map((s, i) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "40px 1fr auto", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: i < songs.length - 1 ? "1px solid var(--color-border)" : "none" }}>
              <button onClick={() => onPlay(s, songs.slice(i + 1))} aria-label={`Play ${s.title}`} style={{ ...linkBtn, width: 40, height: 40, borderRadius: 6, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
                {s.coverArtId ? <img src={coverUrl(s.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)", fontSize: "0.9rem" }}>{coverInitial(s.title)}</span>}
              </button>
              <button onClick={() => onPlay(s, songs.slice(i + 1))} style={{ ...linkBtn, textAlign: "left", minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                <div style={{ color: "var(--color-muted)", fontSize: "var(--text-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artistName}</div>
              </button>
              <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>{renderRowActions(s)}</span>
            </div>
          ))
        )}
      </div>

      {editingGenre && genre && (
        <GenreEditor detail={genre} studioEnabled={studioEnabled} imageGenEnabled={imageGenEnabled} onClose={() => setEditingGenre(false)} onChanged={() => loadGenre()} />
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer", padding: 0 };

const pillPrimary: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  background: "var(--color-accent-fill)",
  color: "var(--color-ink)",
  border: "none",
  borderRadius: 999,
  padding: "0.55rem 1.25rem",
  fontSize: "var(--text-ui)",
  cursor: "pointer",
  fontWeight: 600,
};

const pillGhost: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  background: "rgba(0,0,0,0.35)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.35)",
  borderRadius: 999,
  padding: "0.55rem 1.1rem",
  fontSize: "var(--text-ui)",
  cursor: "pointer",
};
