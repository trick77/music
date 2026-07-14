import { useEffect, useRef } from "react";
import { player, usePlayer } from "./player";
import { coverUrl } from "./cover";
import { navigate } from "./router";
import { attach, resume, bands } from "./analyser";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";

const N = 24; // number of spectrum bars

// VisualizerView is the full-screen, deep-linkable audio visualizer (route
// /visualizer). It draws direction "F": rounded terracotta bars with floating
// peak caps over the current song's album art, blurred and dimmed as a backdrop.
//
// The blurred cover is a DOM layer (GPU-composited once per song), NOT redrawn
// each frame — the transparent <canvas> on top draws only the bars + peaks, so
// clearRect never touches the expensive blur. Bars ride the real audio spectrum
// via the shared AnalyserNode (analyser.ts). While AirPlay is active the sound is
// on a remote speaker (nothing local to visualize), so we hide the bars and show
// a note instead — mirroring the player bar, which hides the visualizer button
// while AirPlay is active.
export function VisualizerView() {
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

    function barGrad(x0: number, y0: number, x1: number, y1: number) {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, "#f0a877");
      g.addColorStop(0.45, "#d97757");
      g.addColorStop(1, "#c25f34");
      return g;
    }
    // Rounded-top bar path. r is clamped non-negative so a tiny/zero height can't
    // feed arcTo a negative radius (which throws IndexSizeError).
    function rrTop(x: number, y: number, bw: number, bh: number, r: number) {
      r = Math.max(0, Math.min(r, bw / 2, bh));
      ctx.beginPath();
      ctx.moveTo(x, y + bh);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + bw - r, y);
      ctx.arcTo(x + bw, y, x + bw, y + r, r);
      ctx.lineTo(x + bw, y + bh);
      ctx.closePath();
    }

    function ease(target: number[]) {
      for (let i = 0; i < N; i++) {
        const a = target[i] > levels[i] ? 0.5 : 0.14; // fast attack, slow decay
        levels[i] += (target[i] - levels[i]) * a;
        if (levels[i] > peaks[i]) peaks[i] = levels[i];
        else peaks[i] = Math.max(levels[i], peaks[i] - 0.012);
      }
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      if (airplayRef.current) return; // sound is on a remote speaker — nothing to show
      const gap = w / N;
      const bw = gap * 0.56;
      const base = h * 0.8; // leave the bottom ~20% clear for the transport control
      ctx.save();
      ctx.shadowColor = "rgba(240,168,119,0.7)";
      ctx.shadowBlur = 15;
      for (let i = 0; i < N; i++) {
        const bh = Math.max(2, levels[i] * base * 0.8);
        const x = i * gap + (gap - bw) / 2;
        ctx.fillStyle = barGrad(x, base - bh, x, base);
        rrTop(x, base - bh, bw, bh, bw / 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#faf0e4";
      for (let i = 0; i < N; i++) {
        const ph = Math.max(2, peaks[i] * base * 0.8);
        const x = i * gap + (gap - bw) / 2;
        ctx.fillRect(x, base - ph - 3, bw, 2.5);
      }
      ctx.restore();
    }

    let raf = 0;
    let cancelled = false;

    if (reduce) {
      // Static, honest frame: sample once, settle, draw — no animation loop.
      attach(player.getAudioElement());
      resume();
      const t = bands(N);
      for (let s = 0; s < 40; s++) ease(t);
      draw();
      return () => {
        cancelled = true;
        window.removeEventListener("resize", resize);
      };
    }

    function frame() {
      if (cancelled) return;
      attach(player.getAudioElement()); // idempotent; no-op once tapped or on null
      resume();
      ease(bands(N));
      draw();
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  function close() {
    if (window.history.length > 1) window.history.back();
    else navigate("/");
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        overflow: "hidden",
        background: "#141413",
      }}
    >
      {/* Blurred cover backdrop (DOM layer, composited once per song). */}
      {song?.coverArtId ? (
        <img
          key={song.coverArtId}
          src={coverUrl(song.coverArtId, "hero")}
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "-8%",
            width: "116%",
            height: "116%",
            objectFit: "cover",
            filter: "blur(40px) saturate(1.1)",
          }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(120% 100% at 35% 30%, #5c2f1e 0%, #2a1a14 55%, #161311 100%)",
          }}
        />
      )}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(180deg, rgba(18,18,16,0.55) 0%, rgba(18,18,16,0.62) 55%, rgba(18,18,16,0.8) 100%)",
        }}
      />

      {/* Spectrum canvas (bars + peaks only). */}
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />

      {/* Close */}
      <button
        aria-label="Close visualizer"
        onClick={close}
        style={{ position: "absolute", top: 16, right: 16, zIndex: 3, display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 8, background: "none", border: "none", color: "#fff", cursor: "pointer" }}
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

      {/* Minimal transport (no AirPlay control here by design). */}
      {song && (
        <div style={{ position: "absolute", bottom: "max(28px, 6vh)", left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 3 }}>
          <button
            aria-label={p.playing ? "Pause" : "Play"}
            onClick={p.toggle}
            style={{ display: "grid", placeItems: "center", width: 60, height: 60, borderRadius: 999, background: "var(--color-accent-fill)", border: "none", color: "var(--color-ink)", cursor: "pointer" }}
          >
            <Glyph name={p.playing ? "pause" : "play"} size={26} />
          </button>
        </div>
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
