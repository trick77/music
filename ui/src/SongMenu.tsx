import type { Song } from "./api";
import { MenuItem, MenuSeparator, menuSurface, useMenuPlacement } from "./Menu";

type Props = {
  song: Song;
  authenticated: boolean;
  alignmentEnabled: boolean;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onAddToPlaylist: () => void;
  onShare: () => void;
  onCopyLyricsLink: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onSync: () => void;
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
        {/* Grouped: playback · get-and-share · manage · destructive. Every separator
            is gated on `authenticated`, which is what makes the grouping earn its
            keep: signed in there are ~10 entries and the groups do real work, but
            anonymous leaves only four, where dividers read as stray rules rather
            than structure. So the anonymous menu stays deliberately flat, and no
            separator can ever end up adjacent to an empty group. */}
        <MenuItem icon="play" onClick={p.onPlayNext}>Play next</MenuItem>
        <MenuItem icon="openItems" onClick={p.onAddToQueue}>Add to queue</MenuItem>
        {/* Playlist-building is signed-in only (spec §1); omit for anonymous. */}
        {p.authenticated && <MenuItem icon="plus" onClick={p.onAddToPlaylist}>Add to playlist…</MenuItem>}

        {p.authenticated && <MenuSeparator />}
        <MenuItem icon="download" href={`/api/songs/${p.song.id}/download`}>Download</MenuItem>
        {/* Cover-art download is signed-in only; anonymous listeners still see the
            art inline, they just can't pull the original file. */}
        {p.authenticated && !!p.song.coverArtId && (
          <MenuItem icon="imageDown" href={`/api/songs/${p.song.id}/cover/download`}>
            Download cover art
          </MenuItem>
        )}
        <MenuItem icon="share" onClick={p.onShare}>Share</MenuItem>
        {!!p.song.lyrics && p.song.lyrics.trim() !== "" && (
          <MenuItem icon="music" onClick={p.onCopyLyricsLink}>Copy lyrics link</MenuItem>
        )}

        {p.authenticated && (
          <>
            <MenuSeparator />
            <MenuItem icon="edit" onClick={p.onEdit}>Edit…</MenuItem>
            {/* Karaoke: only when enabled AND the song has lyrics — empty lyrics can
                never trigger alignment. Re-sync when already synced. */}
            {p.alignmentEnabled && !!p.song.lyrics && p.song.lyrics.trim() !== "" && (
              <MenuItem icon="music" onClick={p.onSync}>
                {p.song.alignmentStatus === "ready" ? "Re-sync karaoke" : "Generate karaoke"}
              </MenuItem>
            )}
            {/* Publish gate (spec): an unpublished song is visible only to logged-in
                users until published. Signed-in only. */}
            <MenuItem icon="globe" onClick={p.onPublish}>{p.song.published ? "Unpublish" : "Publish"}</MenuItem>

            <MenuSeparator />
            <MenuItem icon="trash" danger onClick={p.onDelete}>Delete song</MenuItem>
          </>
        )}
      </div>
    </>
  );
}
