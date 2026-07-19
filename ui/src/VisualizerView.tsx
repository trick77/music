import { useEffect, useRef } from "react";
import { player, usePlayer } from "./player";
import { coverUrl } from "./cover";
import { closeToOrigin } from "./router";
import { useBackgroundDismiss } from "./backgroundDismiss";
import { startAnalysis, stopAnalysis, syncAnalysis, analysisTime, resume, bands } from "./analyser";
import { Icon } from "./Icon";
import { Divider, ImmersiveControls, StarButton, Transport, iconBtn, type Fav } from "./PlayerControls";
import { useEscape } from "./useEscape";
import { type Song } from "./api";

const N = 28; // number of spectrum columns

// synthTargets produces a lively, bass-weighted pseudo-spectrum from layered
// sines — the fallback used when the real analyser can't run (e.g. iOS won't
// decode the hidden analysis element, or Web Audio is unavailable). It does NOT
// track the actual audio (there is no signal to read); it just keeps the bars
// alive while a track plays and flat when paused. Pure: the same (t, playing)
// always yields the same frame.
export function synthTargets(t: number, playing: boolean): number[] {
  const out = new Array<number>(N).fill(0);
  if (!playing) return out;
  const s = t / 1000;
  for (let i = 0; i < N; i++) {
    const base = 0.6 - (i / N) * 0.4; // bass columns sit taller than treble
    const w1 = 0.5 + 0.5 * Math.sin(s * (1.2 + i * 0.13) + i * 0.5);
    const w2 = 0.5 + 0.5 * Math.sin(s * (2.7 - i * 0.05) + i * 1.3);
    out[i] = Math.max(0, Math.min(1, base * (0.35 + 0.65 * w1) * (0.55 + 0.45 * w2)));
  }
  return out;
}

// After this long of a genuinely dead tap, give up on the real spectrum and show
// synthetic bars instead.
export const STARVE_LIMIT_MS = 3000;

// accrueStarvation tracks how long the analyser has been silent *while the hidden
// element is actually producing audio*. Returns the updated total (ms). It is the
// dead-tap detector for the synthetic fallback, and it is deliberately narrow so
// it can't misfire in normal use:
//   - paused → 0 (a pause is not a dead tap; this is what made a >2.5s pause
//     permanently drop to synthetic on resume before).
//   - not advancing → 0 (still loading/seeking, e.g. a slow cold open — not dead).
//   - any signal → 0 (the tap works).
// Only when the element's clock is advancing yet the spectrum stays flat does the
// timer accumulate; crossing STARVE_LIMIT_MS means the tap really is dead (iOS
// refusing to route the decoded second element), so switch to synthetic bars.
export function accrueStarvation(
  prevMs: number,
  dtMs: number,
  opts: { playing: boolean; advancing: boolean; hasSignal: boolean },
): number {
  if (!opts.playing || !opts.advancing || opts.hasSignal) return 0;
  return prevMs + dtMs;
}

// VisualizerView is the full-screen, deep-linkable audio visualizer (route
// /visualizer). Ambient composition: the album art fills the frame (a DOM layer
// with the SAME treatment as the full-screen player — center/cover under a dark
// gradient, blurred), and a slim heat-mapped LED spectrum sits along the bottom.
// Each column is a stack of discrete cells coloured by height (deep terracotta →
// amber → near-white) with a bright cap cell on the slow-falling peak.
//
// The blur keeps busy cover lettering from competing with the title/artist that
// sit over it. It stays cheap because the cover is a DOM layer (GPU-composited
// once per song), NOT redrawn each frame — the transparent <canvas> on top draws
// only the bars + peaks, so clearRect never touches the blur. Bars ride the real audio spectrum
// via the shared AnalyserNode (analyser.ts). While AirPlay is active the sound is
// on a remote speaker (nothing local to visualize), so we hide the bars and show
// a note instead — mirroring the player bar, which hides the visualizer button
// while AirPlay is active.
export function VisualizerView({ fav, onShare }: { fav: Fav; onShare: (s: Song) => void }) {
  const p = usePlayer();
  const song = p.current;
  const airplay = p.airplayActive;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const airplayRef = useRef(airplay);
  airplayRef.current = airplay;

  useEffect(() => {
    const canvas0 = canvasRef.current;
    if (!canvas0) return;
    const canvas = canvas0; // non-null capture for the rAF/resize closures
    const ctx0 = canvas.getContext("2d");
    if (!ctx0) return;
    const ctx = ctx0; // non-null capture so the rAF closures type-check

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const levels = new Float32Array(N);
    const peaks = new Float32Array(N);
    let w = 0;
    let h = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    // heat maps a cell's 0..1 height fraction to a warm colour: deep terracotta at
    // the base, warming through amber to near-white at the top.
    const C_LOW = [122, 59, 34]; // #7a3b22
    const C_MID = [217, 119, 87]; // #d97757 (--color-accent-strong)
    const C_HI = [246, 180, 131]; // #f6b483
    const C_TOP = [255, 242, 230]; // #fff2e6
    function heat(f: number): string {
      let a = C_LOW, b = C_MID, u = 0;
      if (f < 0.5) { a = C_LOW; b = C_MID; u = f / 0.5; }
      else if (f < 0.82) { a = C_MID; b = C_HI; u = (f - 0.5) / 0.32; }
      else { a = C_HI; b = C_TOP; u = (f - 0.82) / 0.18; }
      const ch = (k: number) => (a[k] + (b[k] - a[k]) * u) | 0;
      return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
    }

    function ease(target: number[]) {
      for (let i = 0; i < N; i++) {
        const a = target[i] > levels[i] ? 0.85 : 0.14; // snap up on a beat, fall gently
        levels[i] += (target[i] - levels[i]) * a;
        if (levels[i] > peaks[i]) peaks[i] = levels[i];
        else peaks[i] = Math.max(levels[i], peaks[i] - 0.0035); // slow hang-and-fall
      }
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      if (airplayRef.current) return; // sound is on a remote speaker — nothing to show
      // Ambient composition: a slim spectrum along the lower third; the album art
      // (DOM layer) fills the frame behind it. Bottom is left clear for transport.
      const x0 = w * 0.05, x1 = w * 0.95;
      const yBot = h * 0.72, yTop = h * 0.44; // lifted to clear the scrubber + control row
      const colW = (x1 - x0) / N, bw = colW * 0.62;
      const cells = 18, cellH = (yBot - yTop) / cells, cg = Math.min(2.5, cellH * 0.4);
      for (let i = 0; i < N; i++) {
        const x = x0 + i * colW + (colW - bw) / 2;
        const lit = Math.round(levels[i] * cells);
        for (let c = 0; c < lit; c++) {
          ctx.fillStyle = heat(c / (cells - 1));
          ctx.fillRect(x, yBot - (c + 1) * cellH + cg / 2, bw, cellH - cg);
        }
        // bright cap cell riding the slow-falling peak — only where there's energy,
        // so silent columns stay empty (no uniform dash row along the floor).
        const pk = peaks[i] * cells;
        if (pk >= 1) {
          const pc = Math.round(pk) - 1;
          ctx.fillStyle = "#fff2e6";
          ctx.fillRect(x, yBot - (pc + 1) * cellH + cg / 2, bw, cellH - cg);
        }
      }
    }

    let raf = 0;
    let cancelled = false;

    if (reduce) {
      // Reduced motion: one settled frame, no animation loop and no second stream.
      // A live sample would need the analysis element to load and play, which is
      // exactly the motion this branch avoids, so draw a static synthetic frame.
      const playing = !(player.getAudioElement()?.paused ?? true);
      const t = synthTargets(0, playing);
      for (let s = 0; s < 40; s++) ease(t);
      draw();
      return () => {
        cancelled = true;
        window.removeEventListener("resize", resize);
      };
    }

    // Live path: tap the DEDICATED analysis element (never the audible one) so
    // opening the visualizer no longer reroutes playback. synthetic goes true if
    // Web Audio is unavailable, or later if the analyser stays silent while a
    // track plays (e.g. iOS won't decode the hidden element) — cosmetic only,
    // since the audible element is untouched in both branches.
    let synthetic = !startAnalysis();
    resume();
    let starveMs = 0;
    let lastFrameMs = 0;
    let lastAnalysisT = -1;

    function frame() {
      if (cancelled) return;
      const now = performance.now();
      const dt = lastFrameMs ? now - lastFrameMs : 0;
      lastFrameMs = now;
      const main = player.getAudioElement();
      let target: number[];
      if (synthetic) {
        target = synthTargets(now, !(main?.paused ?? true));
      } else {
        syncAnalysis(main); // mirror src/position/play onto the silent element
        resume();
        target = bands(N);
        // Dead-tap detection (see accrueStarvation): only accumulates while the
        // hidden element's clock advances yet the spectrum stays flat. Resets on
        // pause, on loading/seeking, and on any signal — so a mid-track pause or a
        // slow cold open never spuriously drops to synthetic bars.
        const at = analysisTime();
        const advancing = at >= 0 && at !== lastAnalysisT;
        lastAnalysisT = at;
        let peak = 0;
        for (let i = 0; i < N; i++) if (target[i] > peak) peak = target[i];
        starveMs = accrueStarvation(starveMs, dt, {
          playing: !!(main && !main.paused),
          advancing,
          hasSignal: peak >= 0.02,
        });
        if (starveMs > STARVE_LIMIT_MS) {
          synthetic = true;
          stopAnalysis(); // the tap is dead — stop the now-useless second stream
        }
      }
      ease(target);
      draw();
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      stopAnalysis(); // pause + drop the second stream when the visualizer closes
    };
  }, []);

  // Return to whatever opened the visualizer — the big player it was launched
  // from, or the page the mini bar was sitting on. A cold /visualizer deep link
  // has nothing behind it, so closeToOrigin sends that case Home instead.
  function close() {
    closeToOrigin();
  }

  // Escape leaves the visualizer, exactly as its X does.
  useEscape(true, close);

  // So does tapping the background — the bars and the cover art behind them are
  // all backdrop here; only the control band is excluded.
  const dismiss = useBackgroundDismiss(close);

  return (
    <div
      {...dismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        overflow: "hidden",
        background: "#141413",
      }}
    >
      {/* Cover backdrop — IDENTICAL treatment to the full-screen player: the hero
          art at center/cover under the same dark gradient scrim, blurred so cover
          lettering can't compete with the title. scale() pushes the blur's
          transparent fringe outside the clip (the parent is overflow:hidden). */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background: song?.coverArtId
            ? `linear-gradient(180deg, rgba(20,20,18,0.6), rgba(20,20,18,0.96)), url(${coverUrl(song.coverArtId, "hero")}) center/cover`
            : "var(--color-bg)",
          ...(song?.coverArtId ? { filter: "blur(14px)", WebkitFilter: "blur(14px)", transform: "scale(1.12)" } : null),
        }}
      />

      {/* Spectrum canvas (bars + peaks only). */}
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />

      {/* Close */}
      <button
        aria-label="Close visualizer"
        onClick={close}
        style={{ ...iconBtn, position: "absolute", top: 16, right: 16, zIndex: 3 }}
      >
        <Icon name="close" size="24px" />
      </button>

      {/* Now-playing label */}
      {song && (
        <div style={{ position: "absolute", top: 18, left: 22, right: 68, zIndex: 3, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-serif)", fontWeight: 700, fontSize: "clamp(1.1rem, 3vw, 1.6rem)", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)", color: "rgba(255,255,255,0.72)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artistName}</div>
        </div>
      )}

      {/* AirPlay-active fallback: bars are hidden; explain why. */}
      {airplay && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", zIndex: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--color-accent-strong)", fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)" }}>
            <Icon name="airplay" size="22px" />
            <span>Playing on AirPlay</span>
          </div>
        </div>
      )}

      {/* Full transport — same controls as the lyrics player, minus AirPlay (nothing
          local to visualize while casting). No lyrics or artwork toggle: while the
          visualizer is open it is left via the X, not swapped away in place. */}
      {song && (
        <ImmersiveControls positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek}>
          <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} canNext={p.queue.length > 0} size={26} />
          <Divider color="rgba(255,255,255,0.2)" />
          <StarButton song={song} fav={fav} size={24} />
          {/* Unpublished songs aren't shareable — their /song/:id link 404s for
              anonymous recipients — so hide Share until published. */}
          {song.published && <button aria-label="Share" onClick={() => onShare(song)} style={iconBtn}><Icon name="share" size="22px" /></button>}
        </ImmersiveControls>
      )}

      {/* Empty state: opened with nothing playing. */}
      {!song && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", zIndex: 2, color: "rgba(255,255,255,0.7)", fontFamily: "var(--font-sans)" }}>
          Nothing is playing
        </div>
      )}
    </div>
  );
}
