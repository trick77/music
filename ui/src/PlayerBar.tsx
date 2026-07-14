import { useEffect, useState } from "react";
import { usePlayer } from "./player";
import { coverUrl, coverInitial } from "./cover";
import { formatDuration } from "./format";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { KaraokeView } from "./KaraokeView";
import { KaraokeCard } from "./KaraokeCard";
import { getAlign, postAlign, type AlignmentData, type Song } from "./api";
import { navigate, type PlayerParam } from "./router";

type Fav = { has: (id: string) => boolean; toggle: (id: string) => void };

function StarButton({ song, fav, size = 20 }: { song: Song; fav: Fav; size?: number }) {
  const on = fav.has(song.id);
  return (
    <button
      aria-label={on ? "Remove favorite" : "Add favorite"}
      onClick={() => fav.toggle(song.id)}
      style={{ display: "grid", placeItems: "center", background: "none", border: "none", cursor: "pointer", color: on ? "var(--color-accent-strong)" : "var(--color-muted)" }}
    >
      <Icon name={on ? "starFilled" : "star"} size={`${size}px`} />
    </button>
  );
}

// AirplayButton renders only when Safari reports an AirPlay target on the network
// (available); it opens the native picker and highlights while audio is routed to
// a device (active). Absent in non-Safari browsers, where available stays false.
function AirplayButton({ available, active, onClick, size = 20, color = "var(--color-ink)" }: { available: boolean; active: boolean; onClick: () => void; size?: number; color?: string }) {
  if (!available) return null;
  return (
    <button
      aria-label="AirPlay"
      aria-pressed={active}
      onClick={onClick}
      style={{ ...iconBtn, color: active ? "var(--color-accent-strong)" : color }}
    >
      <Icon name="airplay" size={`${size}px`} />
    </button>
  );
}

function Scrubber({ positionMs, durationMs, onSeek, accent = "var(--color-accent-fill)" }: { positionMs: number; durationMs: number; onSeek: (ms: number) => void; accent?: string }) {
  const max = durationMs || 0;
  const pct = max > 0 ? Math.min(100, (positionMs / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", width: "100%" }}>
      <span className="rank-num" style={{ fontSize: "var(--text-label)", color: "var(--color-muted)", minWidth: 36, textAlign: "right" }}>{formatDuration(positionMs)}</span>
      <input
        type="range"
        min={0}
        max={max || 1}
        value={Math.min(positionMs, max || 1)}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Seek"
        style={{ flex: 1, accentColor: accent, background: "transparent", height: 4 }}
      />
      <span className="rank-num" style={{ fontSize: "var(--text-label)", color: "var(--color-muted)", minWidth: 36 }}>{formatDuration(max)}</span>
      <span style={{ display: "none" }}>{pct}</span>
    </div>
  );
}

function Transport({ playing, onPrev, onToggle, onNext, size = 22 }: { playing: boolean; onPrev: () => void; onToggle: () => void; onNext: () => void; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
      <button aria-label="Previous" onClick={onPrev} style={iconBtn}><Glyph name="prev" size={size - 2} /></button>
      <button
        aria-label={playing ? "Pause" : "Play"}
        onClick={onToggle}
        style={{ ...iconBtn, width: size + 22, height: size + 22, borderRadius: 999, background: "var(--color-accent-fill)", color: "var(--color-ink)" }}
      >
        <Glyph name={playing ? "pause" : "play"} size={size} />
      </button>
      <button aria-label="Next" onClick={onNext} style={iconBtn}><Glyph name="next" size={size - 2} /></button>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 40,
  height: 40,
  borderRadius: 8,
  background: "none",
  border: "none",
  color: "var(--color-ink)",
  cursor: "pointer",
};

// PlayerBar renders the docked mini-player (whenever a track is loaded) and,
// when expanded, the full-screen player. Both are driven entirely by the
// player store via usePlayer().
// open/lyrics are derived from the URL (the source of truth for player-overlay
// state) and passed in by App; the overlay writes changes back through onExpand
// (push a history entry) / onSetMode (replace in place) / onClose. onCopyLink
// copies the current deep link (the address bar itself while the overlay is open).
export function PlayerBar({ fav, onShare, renderMenu, alignmentEnabled, open, lyrics, onExpand, onSetMode, onClose, onCopyLink }: { fav: Fav; onShare: (s: Song) => void; renderMenu?: (s: Song) => React.ReactNode; alignmentEnabled: boolean; open: boolean; lyrics: boolean; onExpand: (mode: PlayerParam) => void; onSetMode: (mode: PlayerParam) => void; onClose: () => void; onCopyLink: () => void }) {
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
    if (open && lyrics && song && !hasLyrics) onSetMode("full");
  }, [open, lyrics, song, hasLyrics, onSetMode]);

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
          bottom: 0,
          background: "color-mix(in srgb, var(--color-panel) 92%, transparent)",
          backdropFilter: "blur(14px)",
          zIndex: 60,
        }}
      >
        {/* Scrubber gets top breathing room so the position knob doesn't kiss the
            page above; the soft fade (.player-dock::before) replaces the old hard
            border between the scrolling page and the dock. */}
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
          <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} size={20} />
          <StarButton song={song} fav={fav} />
          {hasLyrics && (
            <button aria-label="Show lyrics" onClick={() => onExpand("lyrics")} style={iconBtn}><Icon name="captions" size="23px" /></button>
          )}
          {/* Visualizer and AirPlay are mutually exclusive: while audio is routed to
              a remote device there is nothing local to visualize, so hide this. */}
          {!p.airplayActive && (
            <button aria-label="Open visualizer" onClick={() => navigate("/visualizer")} style={iconBtn}><Icon name="visualizer" size="23px" /></button>
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
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: song.coverArtId
              ? `linear-gradient(180deg, rgba(20,20,18,0.6), rgba(20,20,18,0.96)), url(${coverUrl(song.coverArtId, "hero")}) center/cover`
              : "var(--color-bg)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <button aria-label="Close player" onClick={onClose} style={{ ...iconBtn, position: "absolute", top: 16, right: 16, color: "#fff", zIndex: 5 }}>
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
                  <span style={{ display: "block", fontFamily: "var(--font-sans)", fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
                  <span style={{ display: "block", fontSize: "var(--text-label)", color: "rgba(255,255,255,0.7)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {song.artistName}
                  </span>
                </span>
              </div>
              {/* Karaoke body: the animated sweep whenever timing data is ready — for
                  everyone, logged out included. With no ready timing we show static
                  plain lyrics; a signed-in viewer who can generate also gets the
                  needs/failed CTA over them — but never while a sync is generating
                  (no in-progress chrome). Static lyrics are the *only* untimed view. */}
              <div style={{ flex: 1, minHeight: 0, width: "100%", marginTop: 72, marginBottom: 8 }}>
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
              {/* Docked scrubber + transport stay driving playback. */}
              <div style={{ width: "min(760px, 96vw)" }}>
                <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "1.5rem", marginTop: "0.75rem" }}>
                  <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} size={26} />
                  <StarButton song={song} fav={fav} size={24} />
                  <button aria-label="Show artwork" aria-pressed onClick={() => onSetMode("full")} style={{ ...iconBtn, color: "var(--color-accent-strong)" }}><Icon name="captions" size="25px" /></button>
                  {!p.airplayActive && (
                    <button aria-label="Open visualizer" onClick={() => navigate("/visualizer")} style={{ ...iconBtn, color: "#fff" }}><Icon name="visualizer" size="24px" /></button>
                  )}
                  <AirplayButton available={p.airplayAvailable} active={p.airplayActive} onClick={p.showAirplayPicker} size={22} color="#fff" />
                  <button aria-label="Share" onClick={onCopyLink} style={{ ...iconBtn, color: "#fff" }}><Icon name="share" size="22px" /></button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ width: "min(360px, 72vw)", aspectRatio: "1", borderRadius: 18, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
                {song.coverArtId ? <img src={coverUrl(song.coverArtId, "card")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", fontSize: "4rem", color: "var(--color-muted)" }}>{coverInitial(song.title)}</span>}
              </div>
              <h2 style={{ margin: "1.5rem 0 0.25rem", fontFamily: "var(--font-sans)", color: "#fff", textAlign: "center" }}>{song.title}</h2>
              <p style={{ margin: 0, color: "rgba(255,255,255,0.8)" }}>{song.artistName}</p>
              <div style={{ width: "min(440px, 86vw)", marginTop: "1.5rem" }}>
                <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "1.5rem", marginTop: "1.25rem" }}>
                <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} size={26} />
                <StarButton song={song} fav={fav} size={24} />
                {hasLyrics && (
                  <button aria-label="Show lyrics" aria-pressed={false} onClick={() => onSetMode("lyrics")} style={{ ...iconBtn, color: "#fff" }}><Icon name="captions" size="25px" /></button>
                )}
                {!p.airplayActive && (
                  <button aria-label="Open visualizer" onClick={() => navigate("/visualizer")} style={{ ...iconBtn, color: "#fff" }}><Icon name="visualizer" size="24px" /></button>
                )}
                <AirplayButton available={p.airplayAvailable} active={p.airplayActive} onClick={p.showAirplayPicker} size={22} color="#fff" />
                <button aria-label="Share" onClick={onCopyLink} style={{ ...iconBtn, color: "#fff" }}><Icon name="share" size="22px" /></button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
