import { useEffect, useState } from "react";
import { usePlayer } from "./player";
import { coverUrl, coverInitial } from "./cover";
import { Icon } from "./Icon";
import { KaraokeView } from "./KaraokeView";
import { KaraokeCard } from "./KaraokeCard";
import { getAlign, postAlign, type AlignmentData, type Song } from "./api";
import { navigate, type PlayerParam } from "./router";
import { AirplayButton, Divider, ImmersiveControls, IMMERSIVE_CONTROLS_RESERVE, Scrubber, StarButton, Transport, iconBtn, type Fav } from "./PlayerControls";
import { useEscape } from "./useEscape";
import { useBackgroundDismiss } from "./backgroundDismiss";

// PlayerBar renders the docked mini-player (whenever a track is loaded) and,
// when expanded, the full-screen player. Both are driven entirely by the
// player store via usePlayer().
// open/lyrics are derived from the URL (the source of truth for player-overlay
// state) and passed in by App; the overlay writes changes back through onExpand
// (push a history entry, naming the state it was opened out of) /
// onLyricsUnavailable / onClose. Every Share button copies the bare /song/:id
// link (via onShare) so a shared link always opens the big player, never the
// karaoke view — regardless of which surface it was shared from.
export function PlayerBar({ fav, onShare, renderMenu, alignmentEnabled, open, lyrics, onExpand, onLyricsUnavailable, onClose }: { fav: Fav; onShare: (s: Song) => void; renderMenu?: (s: Song) => React.ReactNode; alignmentEnabled: boolean; open: boolean; lyrics: boolean; onExpand: (mode: PlayerParam, from?: PlayerParam) => void; onLyricsUnavailable: () => void; onClose: () => void }) {
  const p = usePlayer();
  const [align, setAlign] = useState<AlignmentData | null>(null);
  const song = p.current;
  const hasLyrics = !!song?.lyrics && song.lyrics.trim() !== "";
  // canGenerate gates only the karaoke-generation CTA (signed-in + alignment on).
  // Karaoke *playback* is not auth-gated — it keys off whether timing data exists,
  // so everyone (logged out included) sees the animated player for a synced song.
  const canGenerate = alignmentEnabled && hasLyrics;

  // Each new track gets fresh alignment state.
  useEffect(() => {
    setAlign(null);
  }, [song?.id]);

  // Graceful degradation: if the URL asks for lyrics but the loaded track has no
  // lyrics at all, downgrade the URL to artwork so the deep link stays honest. Gated
  // on a loaded song so we know whether it has lyrics; this no longer depends on the
  // session, since static lyrics are shown to everyone (karaoke sync is the only
  // signed-in-gated part, handled inside the body).
  useEffect(() => {
    if (open && lyrics && song && !hasLyrics) onLyricsUnavailable();
  }, [open, lyrics, song, hasLyrics, onLyricsUnavailable]);

  // In lyrics mode, fetch the alignment and poll while it is still generating.
  // Gated on hasLyrics (not auth) so anon viewers also pull existing timing and get
  // the animated player; the backend serves timing to everyone for published songs.
  useEffect(() => {
    if (!open || !lyrics || !hasLyrics || !song) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const a = await getAlign(song.id).catch(() => null);
      if (!alive) return;
      setAlign(a);
      if (a?.status === "generating") timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // align?.status is a dep so the in-view Generate/Try-again buttons (which set
    // status to "generating" without changing any other dep) re-arm the poll; it
    // converges because same-status refetches don't change the dep.
  }, [open, lyrics, hasLyrics, song?.id, align?.status]);

  // Escape leaves the expanded player — the same single destination its X goes to.
  useEscape(open, onClose);

  // Tapping the background does the same. Artwork, title and lyrics all count as
  // background; the controls and the band around them never dismiss.
  const backgroundDismiss = useBackgroundDismiss(onClose);

  // A full-screen takeover must not leave the page behind it scrollable. Besides
  // the obvious wart — scrolling a page you can't see — that page's scrollbar
  // narrows the viewport, and the docked controls are centred in it: they'd sit
  // ~7px off from the visualizer's, which has no scrolling page under it. The two
  // are meant to be pixel-identical, so the scrollbar can't be allowed to differ.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!p.current || !song) return null;

  // Await the POST so the row is claimed before we flip to generating; otherwise
  // the poll's immediate getAlign can race ahead of the claim and 404 back to the
  // needs-sync card. Flipping status also re-arms the poll effect (align?.status dep).
  const onGenerate = async () => {
    await postAlign(song.id);
    setAlign({ status: "generating" });
  };
  // Effective status: prefer the freshly-fetched alignment, but fall back to the
  // status already carried on the loaded song so the correct state renders on the
  // very first paint — before getAlign's round-trip resolves. Otherwise a synced
  // song briefly shows the needs-sync card while align is still null.
  const alignStatus = align?.status ?? song.alignmentStatus ?? "";

  return (
    <>
      <div
        className="player-dock"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          // `bottom` and the safe-area padding live in .player-dock (index.css):
          // on phones the dock stands on the tab bar rather than on the floor,
          // and an inline bottom would win over that media query.
          background: "color-mix(in srgb, var(--color-panel) 92%, transparent)",
          backdropFilter: "blur(14px)",
          zIndex: 60,
        }}
      >
        {/* Scrubber gets top breathing room so the position knob doesn't kiss the
            page above; the soft fade (.player-dock::before) replaces the old hard
            border between the scrolling page and the dock.
            Keep the scrubber BEFORE the transport row: the seek input's tap area
            is padded out past its 4px track (.scrubber-input) and just reaches
            this row, and it's paint order — later sibling on top — that lets Play
            keep its own top edge. Reordering these two would hand those pixels to
            the scrubber, and tapping the top of Play would seek instead. */}
        <div style={{ paddingTop: "0.7rem" }}>
          <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem", padding: "0.5rem 1rem 0.7rem", maxWidth: 1100, margin: "0 auto" }}>
          <button onClick={() => onExpand("full")} aria-label="Expand player" style={{ display: "flex", alignItems: "center", gap: "0.7rem", background: "none", border: "none", cursor: "pointer", minWidth: 0, flex: 1, textAlign: "left" }}>
            <span style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", flexShrink: 0 }}>
              {song.coverArtId ? <img src={coverUrl(song.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(song.title)}</span>}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", color: "var(--color-ink)", fontSize: "var(--text-ui)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "var(--text-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artistName}</span>
            </span>
          </button>
          <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} canNext={p.queue.length > 0} size={20} />
          <Divider />
          <StarButton song={song} fav={fav} />
          {/* Visualizer and AirPlay are mutually exclusive: while audio is routed to
              a remote device there is nothing local to visualize, so hide this. */}
          {!p.airplayActive && (
            <button aria-label="Open visualizer" onClick={() => navigate("/visualizer")} style={iconBtn}><Icon name="visualizer" size="23px" /></button>
          )}
          {hasLyrics && (
            <button aria-label="Show lyrics" onClick={() => onExpand("lyrics")} style={iconBtn}><Icon name="captions" size="23px" /></button>
          )}
          <AirplayButton available={p.airplayAvailable} active={p.airplayActive} onClick={p.showAirplayPicker} />
          <button aria-label="Share" onClick={() => onShare(song)} style={iconBtn}><Icon name="share" size="20px" /></button>
          {renderMenu?.(song)}
          <button aria-label="Expand" onClick={() => onExpand("full")} style={iconBtn}><Icon name="chevronUp" size="20px" /></button>
          <button aria-label="Stop and close" onClick={p.stop} style={iconBtn}><Icon name="close" size="20px" /></button>
        </div>
      </div>

      {open && (
        <div
          {...backgroundDismiss}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            overflow: "hidden",
            background: "var(--color-bg)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          {/* Cover backdrop on its own layer so the blur never touches the text above it.
              Covers with big lettering would otherwise stay legible behind the title and lyrics.
              scale() pushes the blur's transparent fringe outside the overlay's clip. */}
          {song.coverArtId && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                // Negative z-index keeps it under the in-flow karaoke body, which is
                // unpositioned and would otherwise paint below this absolute layer.
                zIndex: -1,
                background: `linear-gradient(180deg, rgba(20,20,18,0.6), rgba(20,20,18,0.96)), url(${coverUrl(song.coverArtId, "hero")}) center/cover`,
                filter: "blur(14px)",
                transform: "scale(1.12)",
              }}
            />
          )}

          <button aria-label="Close player" onClick={onClose} style={{ ...iconBtn, position: "absolute", top: 16, right: 16, zIndex: 5 }}>
            <Icon name="close" size="24px" />
          </button>

          {lyrics && hasLyrics ? (
            <>
              {/* Now-playing chip: artwork shrinks up-top in lyrics mode (Apple-style). */}
              <div style={{ position: "absolute", top: 16, left: 20, right: 64, display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <span style={{ width: 46, height: 46, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--color-active)", display: "grid", placeItems: "center", boxShadow: "0 6px 20px rgba(0,0,0,.4)" }}>
                  {song.coverArtId ? <img src={coverUrl(song.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(song.title)}</span>}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: "var(--font-serif)", fontWeight: 700, fontSize: "clamp(1.1rem, 3vw, 1.6rem)", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
                  <span style={{ display: "block", fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)", color: "rgba(255,255,255,0.72)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {song.artistName}
                  </span>
                </span>
              </div>
              {/* Karaoke body: the animated sweep whenever timing data is ready — for
                  everyone, logged out included. With no ready timing we show static
                  plain lyrics; a signed-in viewer who can generate also gets the
                  needs/failed CTA over them — but never while a sync is generating
                  (no in-progress chrome). Static lyrics are the *only* untimed view. */}
              {/* The control row floats (absolute), so it can't push this body up:
                  reserve its footprint here instead, for every karaoke state. */}
              <div style={{ flex: 1, minHeight: 0, width: "100%", marginTop: 72, marginBottom: IMMERSIVE_CONTROLS_RESERVE }}>
                {align?.status === "ready" && align.lines?.length ? (
                  <KaraokeView lines={align.lines} />
                ) : alignStatus === "ready" ? (
                  // Alignment is ready but the lines are still loading — show plain
                  // lyrics, never the needs-sync card. The sweep replaces this next tick.
                  <KaraokeCard state="loading" lyrics={song.lyrics ?? ""} onGenerate={onGenerate} />
                ) : canGenerate && alignStatus !== "generating" ? (
                  <KaraokeCard state={alignStatus === "failed" ? "failed" : "needs"} lyrics={song.lyrics ?? ""} onGenerate={onGenerate} />
                ) : (
                  // No ready timing (untimed, or a sync still generating) → crisp static
                  // lyrics for everyone. Once it's ready the sweep takes over.
                  <KaraokeCard state="plain" lyrics={song.lyrics ?? ""} onGenerate={onGenerate} />
                )}
              </div>
              {/* Docked scrubber + transport stay driving playback — same block,
                  same place as the visualizer's. */}
              <ImmersiveControls positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek}>
                <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} canNext={p.queue.length > 0} size={26} />
                <Divider color="rgba(255,255,255,0.2)" />
                <StarButton song={song} fav={fav} size={24} />
                {/* No lyrics/visualizer buttons while the lyrics player is open:
                    this view is left via the X, not swapped away in place. */}
                <AirplayButton available={p.airplayAvailable} active={p.airplayActive} onClick={p.showAirplayPicker} size={22} />
                <button aria-label="Share" onClick={() => onShare(song)} style={iconBtn}><Icon name="share" size="22px" /></button>
              </ImmersiveControls>
            </>
          ) : (
            <>
              {/* 432px = the old 360 + 20%. The vw cap is what makes it scale on a
                  phone, where width — not the cap — is the binding constraint. */}
              <div style={{ width: "min(432px, 72vw)", aspectRatio: "1", borderRadius: 18, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
                {song.coverArtId ? <img src={coverUrl(song.coverArtId, "card")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", fontSize: "4rem", color: "var(--color-muted)" }}>{coverInitial(song.title)}</span>}
              </div>
              {/* Title/artist type matches the lyrics player's now-playing chip. */}
              <h2 style={{ margin: "1.5rem 0 0.25rem", fontFamily: "var(--font-serif)", fontWeight: 700, fontSize: "clamp(1.1rem, 3vw, 1.6rem)", color: "#fff", textAlign: "center" }}>{song.title}</h2>
              <p style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)", color: "rgba(255,255,255,0.72)" }}>{song.artistName}</p>
              {/* One data-player-ui wrapper around BOTH rows, not one per row: it
                  has to cover the gap between the scrubber and the transport too,
                  or a tap that lands between them closes the player. The karaoke
                  and visualizer band gets this for free via ImmersiveControls. */}
              <div data-player-ui style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: "min(440px, 86vw)", marginTop: "1.5rem" }}>
                  <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "1.5rem", marginTop: "1.25rem" }}>
                  <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} canNext={p.queue.length > 0} size={26} />
                  <Divider color="rgba(255,255,255,0.2)" />
                  <StarButton song={song} fav={fav} size={24} />
                  {!p.airplayActive && (
                    <button aria-label="Open visualizer" onClick={() => navigate("/visualizer")} style={iconBtn}><Icon name="visualizer" size="24px" /></button>
                  )}
                  {/* Pushes rather than swapping in place, so the lyrics player's X
                      returns here — the big player it was opened from, which "full"
                      names for the fallback when a track turns out to have no lyrics. */}
                  {hasLyrics && (
                    <button aria-label="Show lyrics" aria-pressed={false} onClick={() => onExpand("lyrics", "full")} style={iconBtn}><Icon name="captions" size="25px" /></button>
                  )}
                  <AirplayButton available={p.airplayAvailable} active={p.airplayActive} onClick={p.showAirplayPicker} size={22} />
                  <button aria-label="Share" onClick={() => onShare(song)} style={iconBtn}><Icon name="share" size="22px" /></button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
