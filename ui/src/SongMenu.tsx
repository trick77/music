import type { Song } from "./api";
import { MenuItem, MenuSeparator, menuSurface, useMenuPlacement } from "./Menu";

type Props = {
  song: Song;
  authenticated: boolean;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onAddToPlaylist: () => void;
  onShare: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function SongMenu(p: Props) {
  const { menuRef, dropUp } = useMenuPlacement<HTMLDivElement>();
  return (
    <>
      <div onClick={p.onClose} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
      <div
        ref={menuRef}
        role="menu"
        style={{
          position: "absolute",
          right: 0,
          ...(dropUp ? { bottom: "100%", marginBottom: 4 } : { top: "100%", marginTop: 4 }),
          zIndex: 41,
          ...menuSurface,
        }}
      >
        <MenuItem icon="play" onClick={p.onPlayNext}>Play next</MenuItem>
        <MenuItem icon="openItems" onClick={p.onAddToQueue}>Add to queue</MenuItem>
        {/* Playlist-building is signed-in only (spec §1); omit for anonymous. */}
        {p.authenticated && <MenuItem icon="plus" onClick={p.onAddToPlaylist}>Add to playlist</MenuItem>}
        <MenuItem icon="download" href={`/api/songs/${p.song.id}/download`}>Download</MenuItem>
        <MenuItem icon="share" onClick={p.onShare}>Share</MenuItem>
        {p.authenticated && <MenuItem icon="edit" onClick={p.onEdit}>Edit tags</MenuItem>}
        {/* Publish gate (spec): an unpublished song is visible only to logged-in
            users until published. Signed-in only. */}
        {p.authenticated && (
          <MenuItem icon="globe" onClick={p.onPublish}>{p.song.published ? "Unpublish" : "Publish"}</MenuItem>
        )}
        {p.authenticated && (
          <>
            <MenuSeparator />
            <MenuItem icon="trash" danger onClick={p.onDelete}>Delete song</MenuItem>
          </>
        )}
      </div>
    </>
  );
}
