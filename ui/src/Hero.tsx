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

// How long each slide rests before the hero auto-advances to the next.
const AUTO_MS = 7000;

// Hero is the full-bleed featured panel at the top of Home. It cycles the top
// three most-played songs as a swipeable carousel (vertical dots on the right);
// with one or zero songs it collapses to a single static panel identical to the
// original hero. The background of the #1 slide is the starred is_hero fanart
// (presented as ordinary art — never any AI/prompt reference); the other slides
// use each song's own cover. The panel degrades to a quiet gradient with no song.
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
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  // Auto-advance stops for good the first time the user takes control (play, a
  // dot, an arrow key, or a swipe/drag) — otherwise a track you just started
  // would scroll itself off a few seconds later. Hover only pauses (transient).
  const [userTook, setUserTook] = useState(false);
  // Pause the auto-advance while the panel is hovered OR keyboard-focused —
  // tracked separately so a mouse leaving the panel can't un-pause it while
  // focus is still inside.
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  // The intended slide, updated synchronously on every nav. Arrow/dot presses
  // step from this, not from `index` — which only catches up ~60ms after the
  // smooth scroll settles, so two quick presses would otherwise both read the
  // stale index and land on the same slide.
  const targetRef = useRef(0);
  const take = () => setUserTook(true);

  // One placeholder slide when there is nothing to feature (mirrors the old
  // quiet-gradient fallback). Dots + auto-advance only exist with ≥2 slides.
  const slides: (HeroItem | null)[] = items.length > 0 ? items : [null];
  const multi = slides.length > 1;
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const goTo = (i: number) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(slides.length - 1, i));
    targetRef.current = clamped;
    setIndex(clamped);
    el.scrollTo({ left: el.clientWidth * clamped, behavior: reduce ? "auto" : "smooth" });
  };

  // Keep the active dot in sync with the scroll position (swipe or programmatic).
  useEffect(() => {
    const el = trackRef.current;
    if (!el || !multi) return;
    let t: number | undefined;
    const sync = () => {
      let best = 0;
      let bd = Infinity;
      Array.from(el.children).forEach((c, i) => {
        const d = Math.abs((c as HTMLElement).offsetLeft - el.scrollLeft);
        if (d < bd) { bd = d; best = i; }
      });
      targetRef.current = best; // a manual swipe becomes the new step origin
      setIndex(best);
    };
    const onScroll = () => { window.clearTimeout(t); t = window.setTimeout(sync, 60); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); window.clearTimeout(t); };
  }, [multi, slides.length]);

  // Slow auto-advance: skipped under reduced-motion, paused while hovered/focused,
  // and cancelled permanently once the user has taken control.
  useEffect(() => {
    if (!multi || reduce || userTook) return;
    const id = window.setInterval(() => {
      const el = trackRef.current;
      if (!el || hoverRef.current || focusRef.current) return;
      const next = (targetRef.current + 1) % slides.length;
      targetRef.current = next;
      setIndex(next);
      el.scrollTo({ left: el.clientWidth * next, behavior: "smooth" });
    }, AUTO_MS);
    return () => window.clearInterval(id);
  }, [multi, reduce, userTook, slides.length]);

  // Pointer-drag for desktop (touch/trackpad already scroll natively).
  const drag = useRef({ down: false, x: 0, left: 0 });

  return (
    <header
      style={{ position: "relative", borderRadius: 20, overflow: "hidden" }}
      tabIndex={multi ? 0 : undefined}
      onKeyDown={(e) => {
        if (!multi) return;
        if (e.key === "ArrowRight") { e.preventDefault(); take(); goTo(targetRef.current + 1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); take(); goTo(targetRef.current - 1); }
      }}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; drag.current.down = false; }}
      onFocus={() => { focusRef.current = true; }}
      onBlur={() => { focusRef.current = false; }}
    >
      <div
        className="hero-track"
        ref={trackRef}
        onPointerDown={(e) => {
          const el = trackRef.current;
          if (!el) return;
          take(); // any touch/click/drag on the panel counts as taking control
          drag.current = { down: true, x: e.clientX, left: el.scrollLeft };
        }}
        onPointerMove={(e) => {
          const el = trackRef.current;
          if (!el || !drag.current.down) return;
          el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
        }}
        onPointerUp={() => { drag.current.down = false; }}
        onPointerCancel={() => { drag.current.down = false; }}
      >
        {slides.map((item, i) => {
          const song = item?.song ?? null;
          const genres = item?.genres ?? [];
          const useHeroBg = i === 0 && hero; // starred fanart backs the #1 slide only
          const heroBg = useHeroBg ? fanartUrl(hero!.fanartId, "hero") : "";
          // With no fanart, fall back to the song's own cover — shown sharp and
          // muted under a dark gradient (like the full-screen player), cropped to
          // fill the wide banner rather than blurred to stretch it.
          const coverBg = !useHeroBg && song?.coverArtId ? coverUrl(song.coverArtId, "hero") : "";
          const accent = (i === 0 && hero?.accentColor) || "var(--color-accent)";
          const title = song?.title ?? hero?.title ?? "Your library";
          const subtitle = song ? song.artistName : hero?.subtitle || "Songs, playlists, and the sounds you keep coming back to.";
          const eyebrow = item?.ranked ? `#${i + 1} most played` : song ? "Featured song" : "Featured";
          const isPlaying = !!song && currentId === song.id && playing;

          return (
            <div
              key={song?.id ?? `placeholder-${i}`}
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
              <div style={{ position: "relative", padding: "clamp(1.25rem, 3vw, 2.5rem)", maxWidth: 640 }}>
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
                <p style={{ color: "rgba(255,255,255,0.86)", margin: "0.5rem 0 1.1rem", fontSize: "var(--text-body)" }}>{subtitle}</p>
                {song && (
                  <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap" }}>
                    <button
                      onClick={() => { take(); onPlay(song); }}
                      aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
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
                      <Glyph name={isPlaying ? "pause" : "play"} size={18} />
                      {/* Reserve the width of the longer label ("Pause") so toggling
                          Play↔Pause never resizes the button and shifts its siblings. */}
                      <span style={{ display: "inline-grid", justifyItems: "start" }}>
                        <span style={{ gridArea: "1 / 1", visibility: "hidden" }} aria-hidden="true">Pause</span>
                        <span style={{ gridArea: "1 / 1" }}>{isPlaying ? "Pause" : "Play"}</span>
                      </span>
                    </button>
                    <a
                      href={`/api/songs/${song.id}/download`}
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
                    <button
                      onClick={() => onShare(song)}
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
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {multi && (
        <div className="hero-dots">
          {slides.map((_, i) => (
            <button
              key={i}
              aria-current={i === index ? "true" : undefined}
              aria-label={`Show slide ${i + 1}`}
              onClick={() => { take(); goTo(i); }}
            />
          ))}
        </div>
      )}
    </header>
  );
}
