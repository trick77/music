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
        <MenuItem icon="sortDown" href={`/api/songs/${p.song.id}/download`}>Download</MenuItem>
        <MenuItem icon="externalLink" onClick={p.onShare}>Share</MenuItem>
        {p.authenticated && (
          <>
            <MenuSeparator />
            <MenuItem icon="edit" onClick={p.onEdit}>Edit tags</MenuItem>
            <MenuItem icon="trash" danger onClick={p.onDelete}>Delete song</MenuItem>
          </>
        )}
      </div>
    </>
  );
}
