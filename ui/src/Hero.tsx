import { Fragment, useEffect, useRef, useState } from "react";
import { fanartUrl } from "./fanart";
import { coverUrl } from "./cover";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { navigate } from "./router";
import { genreLabel } from "./titleCase";
import type { HomeHero, Song } from "./api";

/** A featured-song genre, with its id resolved for linking when known. */
export type GenreLink = { name: string; id: string | null };

/** One hero slide: a song, its genre links, and whether it earned its rank by
 *  play count (true for the Top-ten slides, false for the no-plays fallback). */
export type HeroItem = { song: Song; genres: GenreLink[]; ranked: boolean };

// Slide transition and the dwell before auto-advancing to the next. The easing
// is a strong ease-out ("expo out") so the slide starts quickly and brakes
// degressively — decelerating to a soft stop rather than a linear glide.
const DUR_MS = 950;
const AUTO_MS = 30000;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

// Hero is the full-bleed featured panel at the top of Home. It cycles the top
// three most-played songs as an infinite carousel that always advances forward
// (after #3 it slides on to #1 rather than snapping back), with plain pill dots
// centred at the bottom. It auto-advances every 30s (paused on hover/focus/drag)
// and can be swiped/dragged or driven with ← →. With one or zero songs it
// collapses to a single static panel identical to the original hero. The #1
// slide's background is the starred is_hero fanart (presented as ordinary art —
// never any AI/prompt reference); the others use each song's own cover.
export function Hero({
  hero,
  items,
  currentId,
  playing,
  onPlay,
  onShare,
}: {
  hero: HomeHero | null;
  /** Up to three top songs; empty renders the quiet placeholder panel. */
  items: HeroItem[];
  /** The currently-loaded track's id, so each slide's Play/Pause reflects itself. */
  currentId: string | null;
  /** True when a track is actively playing (paired with currentId per slide). */
  playing: boolean;
  onPlay: (s: Song) => void;
  onShare: (s: Song) => void;
}) {
  const n = items.length;
  const multi = n > 1;
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The render sequence clones the last slide before the first and the first
  // after the last, so a forward move off either end lands on a visual copy and
  // then jumps (without animation) to the real slide — an endless one-way loop.
  // Real slides live at child indices 1..n; clones at 0 and n+1.
  const seq: (HeroItem | null)[] = n === 0 ? [null] : multi ? [items[n - 1], ...items, items[0]] : items;
  const realOf = (ci: number) => (ci === 0 ? n - 1 : ci === n + 1 ? 0 : ci - 1);

  const trackRef = useRef<HTMLDivElement>(null);
  const ciRef = useRef(multi ? 1 : 0); // current child index
  const [active, setActive] = useState(0); // real index, drives the dots
  // Bumped on every manual move so the 30s dwell restarts — each slide the user
  // lands on gets its full time before auto-advance takes over again.
  const [dwell, setDwell] = useState(0);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const downRef = useRef(false);
  // True while a slide transition is in flight — new moves are ignored until it
  // settles, so the child index can never run past a clone into empty space.
  const movingRef = useRef(false);
  // x/lastX: pointer start and most-recent x (px). base: track offset (%) the drag
  // is anchored on. w: track width (px). lastT: timestamp of the last move; vx: its
  // signed velocity (px/ms), used to commit a quick flick even under the distance
  // threshold.
  const dragRef = useRef({ x: 0, base: 0, w: 1, lastX: 0, lastT: 0, vx: 0 });

  const paint = (animate: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = animate && !reduce ? `transform ${DUR_MS}ms ${EASE}` : "none";
    el.style.transform = `translateX(${-ciRef.current * 100}%)`;
  };
  // The track's live rendered offset as a percentage of its width — read mid-flight
  // so a drag that grabs a slide during its transition anchors on where it visually
  // is, not where the (already-advanced) child index says it should end up.
  const liveBasePercent = () => {
    const el = trackRef.current;
    const t = el && getComputedStyle(el).transform;
    if (!el || !t || t === "none") return -ciRef.current * 100;
    return (new DOMMatrixReadOnly(t).m41 / (el.clientWidth || 1)) * 100;
  };
  // A move onto a clone is invisible-jumped to its real twin once settled; with
  // no animation (reduced motion) that happens immediately since no transition
  // event will fire.
  const normalize = () => {
    if (ciRef.current === n + 1) { ciRef.current = 1; paint(false); }
    else if (ciRef.current === 0) { ciRef.current = n; paint(false); }
  };
  const goChild = (ci: number) => {
    ciRef.current = ci;
    paint(true);
    setActive(realOf(ci));
    if (reduce) normalize();
    else movingRef.current = true;
  };
  const step = (dir: 1 | -1) => { if (!movingRef.current) goChild(ciRef.current + dir); };
  const toReal = (r: number) => { if (!movingRef.current && r !== active) goChild(r + 1); };
  const bumpDwell = () => setDwell((d) => d + 1);
  // Commit when the drag crossed the distance threshold OR was a quick flick (short
  // travel but fast), so a decisive short swipe still advances instead of snapping
  // back. A cancelled pointer arrives without a clientX; fall back to the last x we
  // saw so the swipe still resolves on its real delta rather than a forced dx=0.
  const FLICK_VX = 0.5; // px/ms
  const FLICK_MIN = 12; // px of travel required to treat a flick as intentional
  const endDrag = (clientX?: number) => {
    if (!downRef.current) return;
    downRef.current = false;
    const { x, w, lastX, vx } = dragRef.current;
    const dx = (clientX || lastX) - x;
    const threshold = Math.max(44, w * 0.12);
    const flick = Math.abs(vx) > FLICK_VX && Math.abs(dx) > FLICK_MIN;
    if (Math.abs(dx) > threshold || flick) {
      // Distance decides direction when it's past threshold; otherwise the flick's
      // velocity sign does.
      step(Math.abs(dx) > threshold ? (dx < 0 ? 1 : -1) : vx < 0 ? 1 : -1);
    } else {
      paint(true); // snap back
    }
    bumpDwell();
  };

  // Position the track on the first real slide once mounted / when the count
  // changes (no animation — this is the resting state, not a move).
  useEffect(() => {
    ciRef.current = multi ? 1 : 0;
    movingRef.current = false;
    paint(false);
    setActive(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, n]);

  // Seamless wrap: after the slide onto a clone finishes, snap to the matching
  // real slide with the transition disabled so the jump is invisible.
  useEffect(() => {
    const el = trackRef.current;
    if (!el || !multi) return;
    // transitioncancel matters as much as transitionend: onPointerDown kills the
    // transition to take over an in-flight slide, which fires *cancel*, not *end* —
    // without handling it, movingRef would latch true and freeze every later move.
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "transform") return;
      normalize();
      movingRef.current = false;
    };
    el.addEventListener("transitionend", onEnd);
    el.addEventListener("transitioncancel", onEnd);
    return () => {
      el.removeEventListener("transitionend", onEnd);
      el.removeEventListener("transitioncancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, n]);

  // Auto-advance forward every 30s; restarts whenever `dwell` bumps (a manual
  // move). Skipped under reduced motion; each tick no-ops while paused.
  useEffect(() => {
    if (!multi || reduce) return;
    const id = window.setInterval(() => {
      if (!hoverRef.current && !focusRef.current && !downRef.current) step(1);
    }, AUTO_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, reduce, n, dwell]);

  // Release drags that end outside the panel.
  useEffect(() => {
    if (!multi) return;
    const up = (e: PointerEvent) => endDrag(e.clientX);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, n]);

  // The action row is stationary (it does not slide with the carousel) and acts
  // on whichever slide is current, so it tracks `active` rather than a slide.
  const activeSong = items[active]?.song ?? null;
  const activePlaying = !!activeSong && currentId === activeSong.id && playing;

  return (
    <header
      // The panel is focusable only so ← → work; suppress the browser's default
      // focus ring (it reads as a stray frame around the whole hero).
      style={{ position: "relative", borderRadius: 20, overflow: "hidden", outline: "none" }}
      tabIndex={multi ? 0 : undefined}
      onKeyDown={(e) => {
        if (!multi) return;
        if (e.key === "ArrowRight") { e.preventDefault(); step(1); bumpDwell(); }
        if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); bumpDwell(); }
      }}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
      onFocus={() => { focusRef.current = true; }}
      onBlur={() => { focusRef.current = false; }}
    >
      <div className="hero-viewport">
        <div
          className="hero-track"
          ref={trackRef}
          style={{ transform: `translateX(${(multi ? 1 : 0) * -100}%)` }}
          onPointerDown={(e) => {
            if (!multi) return;
            const el = trackRef.current;
            if (!el) return;
            // Take over any in-flight slide without a visual jump: anchor on the live
            // rendered offset, and if the child index has already advanced onto a
            // clone (0 or n+1), retarget it to the real twin while shifting the anchor
            // by the same offset so the same slide stays put. Clearing movingRef here
            // (backed by the transitioncancel handler) is what lets a mid-animation
            // grab start a fresh drag instead of being swallowed by the moving gate.
            let base = liveBasePercent();
            if (ciRef.current === n + 1) { ciRef.current = 1; base += n * 100; }
            else if (ciRef.current === 0) { ciRef.current = n; base -= n * 100; }
            movingRef.current = false;
            try { el.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
            downRef.current = true;
            const now = performance.now();
            dragRef.current = { x: e.clientX, base, w: el.clientWidth || 1, lastX: e.clientX, lastT: now, vx: 0 };
            el.style.transition = "none";
            el.style.transform = `translateX(${base}%)`;
          }}
          onPointerMove={(e) => {
            if (!downRef.current) return;
            const d = dragRef.current;
            const el = trackRef.current;
            const now = performance.now();
            const dt = now - d.lastT;
            if (dt > 0) d.vx = (e.clientX - d.lastX) / dt;
            d.lastX = e.clientX;
            d.lastT = now;
            if (el) el.style.transform = `translateX(${d.base + ((e.clientX - d.x) / d.w) * 100}%)`;
          }}
          onPointerUp={(e) => endDrag(e.clientX)}
          onPointerCancel={() => endDrag()}
        >
          {seq.map((item, i) => {
            const song = item?.song ?? null;
            const genres = item?.genres ?? [];
            const realIdx = multi ? realOf(i) : i;
            const useHeroBg = realIdx === 0 && hero; // starred fanart backs the #1 slide (and its clone)
            const heroBg = useHeroBg ? fanartUrl(hero!.fanartId, "hero") : "";
            // With no fanart, fall back to the song's own cover — shown sharp and
            // muted under a dark gradient (like the full-screen player), cropped to
            // fill the wide banner rather than blurred to stretch it.
            const coverBg = !useHeroBg && song?.coverArtId ? coverUrl(song.coverArtId, "hero") : "";
            const accent = (realIdx === 0 && hero?.accentColor) || "var(--color-accent)";
            const title = song?.title ?? hero?.title ?? "Your library";
            const subtitle = song ? song.artistName : hero?.subtitle || "Songs, playlists, and the sounds you keep coming back to.";
            const eyebrow = item?.ranked ? `#${realIdx + 1} most played` : song ? "Featured song" : "Featured";

            return (
              <div
                key={`slide-${i}`}
                className="hero-slide"
                style={{ background: `radial-gradient(120% 120% at 30% 20%, ${accent} 0%, var(--color-panel) 70%)` }}
              >
                {heroBg ? (
                  <div style={{ position: "absolute", inset: 0, background: `url(${heroBg}) center/cover no-repeat` }} />
                ) : coverBg ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: `linear-gradient(180deg, rgba(20,20,18,0.6), rgba(20,20,18,0.96)), url(${coverBg}) center/cover no-repeat`,
                    }}
                  />
                ) : null}
                <div className="scrim" />
                {/* .hero-copy reserves bottom room for the stationary action row +
                    pills that sit below this sliding text (more on phones, where
                    the action row wraps to two lines). */}
                <div className="hero-copy">
                  <div
                    style={{
                      fontSize: "var(--text-micro)",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "rgba(255,255,255,0.8)",
                      marginBottom: "0.5rem",
                    }}
                  >
                    {eyebrow}
                    {/* Genre(s) trail the label, middle-dot separated; each links to
                        its genre page when the id resolved (plain text otherwise). */}
                    {genres.map((g) => (
                      <Fragment key={g.name}>
                        <span aria-hidden="true" style={{ opacity: 0.55, margin: "0 0.45em" }}>·</span>
                        {g.id ? (
                          <a
                            className="hero-genre"
                            href={`/genre/${g.id}`}
                            onClick={(e) => { e.preventDefault(); navigate(`/genre/${g.id}`); }}
                          >
                            {genreLabel(g.name)}
                          </a>
                        ) : (
                          <span>{genreLabel(g.name)}</span>
                        )}
                      </Fragment>
                    ))}
                  </div>
                  <h1
                    style={{
                      margin: 0,
                      fontFamily: "var(--font-serif)",
                      fontSize: "clamp(2rem, 5vw, 3.4rem)",
                      lineHeight: 1.05,
                      color: "#fff",
                      textShadow: "0 2px 24px rgba(0,0,0,0.55)",
                    }}
                  >
                    {title}
                  </h1>
                  <p style={{ color: "rgba(255,255,255,0.86)", margin: "0.5rem 0 0", fontSize: "var(--text-body)" }}>{subtitle}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {activeSong && (
        <div className="hero-actions">
          <button
            onClick={() => { onPlay(activeSong); bumpDwell(); }}
            aria-label={activePlaying ? `Pause ${activeSong.title}` : `Play ${activeSong.title}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              background: "var(--color-accent-fill)",
              color: "var(--color-ink)",
              border: "none",
              borderRadius: 999,
              padding: "0.65rem 1.4rem",
              fontSize: "var(--text-ui)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            <Glyph name={activePlaying ? "pause" : "play"} size={18} />
            {/* Reserve the width of the longer label ("Pause") so toggling
                Play↔Pause never resizes the button and shifts its siblings. */}
            <span style={{ display: "inline-grid", justifyItems: "start" }}>
              <span style={{ gridArea: "1 / 1", visibility: "hidden" }} aria-hidden="true">Pause</span>
              <span style={{ gridArea: "1 / 1" }}>{activePlaying ? "Pause" : "Play"}</span>
            </span>
          </button>
          <a
            href={`/api/songs/${activeSong.id}/download`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              background: "rgba(0,0,0,0.35)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.35)",
              borderRadius: 999,
              padding: "0.65rem 1.2rem",
              fontSize: "var(--text-ui)",
              textDecoration: "none",
            }}
          >
            <Icon name="download" size="18px" /> Download
          </a>
          {/* Unpublished songs aren't shareable — their /song/:id link 404s for
              anonymous recipients — so hide Share until published. */}
          {activeSong.published && (
            <button
              onClick={() => onShare(activeSong)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "rgba(0,0,0,0.35)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 999,
                padding: "0.65rem 1.2rem",
                fontSize: "var(--text-ui)",
                cursor: "pointer",
              }}
            >
              <Icon name="share" size="18px" /> Share
            </button>
          )}
        </div>
      )}
      {multi && (
        <div className="hero-dots">
          {items.map((_, i) => (
            <button
              key={i}
              aria-current={i === active ? "true" : undefined}
              aria-label={`Show slide ${i + 1}`}
              onClick={() => { toReal(i); bumpDwell(); }}
            />
          ))}
        </div>
      )}
    </header>
  );
}
