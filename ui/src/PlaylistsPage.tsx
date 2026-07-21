import { useEffect, useState } from "react";
import {
  listPlaylists,
  getPlaylist,
  createPlaylist,
  type Playlist,
  type Song,
} from "./api";
import { coverUrl } from "./cover";
import { navigate } from "./router";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { t } from "./ui";

type Props = {
  authenticated: boolean;
  onPlay: (song: Song, tail: Song[]) => void;
};

// PlaylistsPage is the dedicated Playlists destination (mockup Decision 1B):
// scannable list rows — cover thumb, name, song count + description, a quick
// ▶ that queues the whole playlist, and a header "+ New playlist" action.
// Tapping a row navigates in; all management happens on the playlist page.
export function PlaylistsPage({ authenticated, onPlay }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);

  useEffect(() => {
    listPlaylists()
      .then(setPlaylists)
      .catch(() => setPlaylists([]));
  }, []);

  const newPlaylist = async () => {
    const created = await createPlaylist("New playlist", "");
    navigate(`/playlist/${created.id}?edit=1`);
  };

  return (
    <PlaylistsPageView
      playlists={playlists}
      authenticated={authenticated}
      onPlay={onPlay}
      onNewPlaylist={newPlaylist}
    />
  );
}

type ViewProps = {
  playlists: Playlist[] | null;
  authenticated: boolean;
  onPlay: (song: Song, tail: Song[]) => void;
  onNewPlaylist: () => void;
};

// PlaylistsPageView is the pure, presentational body — split out from
// PlaylistsPage (which owns the fetch) so it can be rendered directly in
// tests with fixed data, the same way Hero/Chapter are tested apart from Home.
export function PlaylistsPageView({
  playlists,
  authenticated,
  onPlay,
  onNewPlaylist,
}: ViewProps) {
  const quickPlay = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    getPlaylist(id)
      .then((detail) => {
        if (detail.songs.length > 0)
          onPlay(detail.songs[0], detail.songs.slice(1));
      })
      .catch(() => {});
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: "1.25rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, ...t.title }}>Playlists</h1>
          <div style={t.label}>
            {playlists === null
              ? "Loading…"
              : `${playlists.length} playlist${playlists.length === 1 ? "" : "s"}`}
          </div>
        </div>
        {authenticated && (
          <button
            onClick={onNewPlaylist}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--color-accent-strong)",
              fontSize: "var(--text-ui)",
              fontWeight: 500,
            }}
          >
            + New playlist
          </button>
        )}
      </div>

      {playlists === null && (
        <p style={{ color: "var(--color-muted)" }}>Loading…</p>
      )}

      {playlists !== null && playlists.length === 0 && (
        <p style={{ color: "var(--color-muted)" }}>No playlists yet.</p>
      )}

      {playlists !== null && playlists.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {playlists.map((pl) => (
            <li
              key={pl.id}
              onClick={() => navigate(`/playlist/${pl.id}`)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.85rem",
                padding: "0.6rem 0.85rem",
                borderRadius: "var(--radius-ui, 10px)",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--color-active)",
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid var(--color-border)",
                }}
              >
                {pl.coverArtId ? (
                  <img
                    src={coverUrl(pl.coverArtId, "thumb")}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <Icon
                    name="music"
                    size="20px"
                    style={{ color: "var(--color-muted)" }}
                  />
                )}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      color: "var(--color-ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pl.name}
                  </span>
                  {authenticated && !pl.published && (
                    <span
                      style={{
                        flexShrink: 0,
                        background: "var(--color-active)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 999,
                        padding: "1px 8px",
                        ...t.micro,
                      }}
                    >
                      Unpublished
                    </span>
                  )}
                </span>
                <span
                  style={{
                    display: "block",
                    ...t.label,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {pl.songCount} {pl.songCount === 1 ? "song" : "songs"}
                  {pl.description ? ` · ${pl.description}` : ""}
                </span>
              </span>
              <button
                onClick={(e) => quickPlay(pl.id, e)}
                aria-label={`Play ${pl.name}`}
                style={{
                  flexShrink: 0,
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  background: "var(--color-accent-fill)",
                  color: "var(--color-ink)",
                  border: "none",
                  display: "grid",
                  placeItems: "center",
                  cursor: "pointer",
                }}
              >
                <Glyph name="play" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
