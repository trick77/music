import { useEffect, useRef } from "react";
import { player } from "./player";
import type { AlignedLine } from "./api";

const LEAD = 0.6;
const MAX_SWEEP = 1.2;

type WordBox = { left: number; right: number; s: number; e: number };
type LineRt = {
  el: HTMLDivElement;
  fill: HTMLSpanElement;
  wordSpans: HTMLSpanElement[];
  wl: AlignedLine["words"];
  words: WordBox[];
  lineW: number;
  on?: boolean;
};

// KaraokeView renders the Apple-Music-style continuous per-line sweep. It measures
// word x-positions after layout, then a single requestAnimationFrame loop reads the
// live <audio> currentTime and writes fill-widths, per-line dim/blur, and the eased
// auto-scroll straight to the DOM — never through React state (which can't keep
// 60fps). Motion/CSS is lifted from docs/mockups/karaoke/player_integration.py.
export function KaraokeView({ lines }: { lines: AlignedLine[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<LineRt[]>([]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const L = lineRefs.current;

    // activateAt[i]: when line i takes focus — LEAD before its first word, clamped
    // past the previous line's end so we never jump back.
    const activateAt = lines.map((ln, i) => {
      if (ln.start == null) return Infinity;
      if (i === 0) return 0;
      const pe = lines[i - 1]?.end != null ? lines[i - 1].end : ln.start - LEAD;
      return Math.max(ln.start - LEAD, pe);
    });

    function measure() {
      for (const l of L) {
        if (!l) continue;
        const n = l.wordSpans.length;
        l.words = [];
        for (let i = 0; i < n; i++) {
          const sp = l.wordSpans[i];
          const left = sp.offsetLeft;
          const right = i + 1 < n ? l.wordSpans[i + 1].offsetLeft : left + sp.offsetWidth;
          l.words.push({ left, right, s: +l.wl[i].start, e: +l.wl[i].end });
        }
        l.lineW = l.words.length ? l.words[l.words.length - 1].right : 0;
      }
    }

    function frontX(l: LineRt, t: number): number {
      const ws = l.words;
      if (!ws.length) return 0;
      if (t < ws[0].s) return 0;
      let x = 0;
      for (const w of ws) {
        const se = w.s + Math.min(w.e - w.s, MAX_SWEEP);
        if (t >= se) x = w.right;
        else if (t >= w.s) return w.left + ((t - w.s) / (se - w.s)) * (w.right - w.left);
        else return x;
      }
      return x;
    }

    let raf = 0;
    let cancelled = false;
    let lastActive = -2;
    function frame() {
      const audio = player.getAudioElement();
      const t = audio ? audio.currentTime : 0;
      let active = -1;
      for (let i = 0; i < lines.length; i++) if (t >= activateAt[i]) active = i;
      L.forEach((l, i) => {
        if (!l) return;
        const on = i === active;
        if (l.on !== on) {
          l.el.classList.toggle("kv-active", on);
          l.fill.classList.toggle("kv-sweeping", on);
          l.on = on;
        }
        if (!on) {
          const dist = Math.abs(i - (active < 0 ? 0 : active));
          l.el.style.opacity = Math.max(0.1, 0.48 - dist * 0.1).toFixed(2);
          l.el.style.filter = "blur(" + Math.min(7, 1 + dist * 1.5).toFixed(1) + "px)";
        } else {
          l.el.style.opacity = "";
          l.el.style.filter = "";
        }
        let x: number;
        if (i < active) x = l.lineW;
        else if (i > active) x = 0;
        else x = frontX(l, t);
        l.fill.style.width = x + "px";
      });
      if (active !== lastActive) {
        const el = L[active < 0 ? 0 : active]?.el;
        if (el) inner!.style.transform = "translateY(" + (window.innerHeight * 0.4 - (el.offsetTop + el.offsetHeight / 2)) + "px)";
        lastActive = active;
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      // The fonts.ready promise can resolve after unmount; bail so we don't spawn
      // an uncancellable rAF loop mutating detached DOM.
      if (cancelled) return;
      measure();
      const el = L[0]?.el;
      if (el) inner!.style.transform = "translateY(" + (window.innerHeight * 0.4 - (el.offsetTop + el.offsetHeight / 2)) + "px)";
      raf = requestAnimationFrame(frame);
    }
    const onResize = () => {
      measure();
      lastActive = -2;
    };
    window.addEventListener("resize", onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
    else raf = requestAnimationFrame(start);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [lines]);

  lineRefs.current = [];
  return (
    <>
      <style>{KV_CSS}</style>
      <div ref={stageRef} className="kv-stage">
        <div ref={innerRef} className="kv-inner">
          {lines.map((ln, li) => (
            <LineRow key={li} line={ln} register={(rt) => (lineRefs.current[li] = rt)} />
          ))}
        </div>
      </div>
    </>
  );
}

function LineRow({ line, register }: { line: AlignedLine; register: (rt: LineRt) => void }) {
  const elRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const wordRefs = useRef<HTMLSpanElement[]>([]);
  const wl = line.words ?? [];
  useEffect(() => {
    if (elRef.current && fillRef.current) {
      register({ el: elRef.current, fill: fillRef.current, wordSpans: wordRefs.current, wl, words: [], lineW: 0 });
    }
  });
  wordRefs.current = [];
  return (
    <div ref={elRef} className="kv-line">
      <div className="kv-lc">
        <span className="kv-base">
          {wl.length
            ? wl.map((w, i) => (
                <span key={i}>
                  <span ref={(el) => { if (el) wordRefs.current[i] = el; }}>{w.w}</span>
                  {i < wl.length - 1 ? " " : ""}
                </span>
              ))
            : line.text || " "}
        </span>
        <span ref={fillRef} className="kv-fill">
          {wl.length
            ? wl.map((w, i) => (
                <span key={i}>
                  {w.w}
                  {i < wl.length - 1 ? " " : ""}
                </span>
              ))
            : line.text || " "}
        </span>
      </div>
    </div>
  );
}

// Ported from docs/mockups/karaoke/player_integration.py, themed to loom tokens
// (var(--color-*) / var(--font-serif)).
const KV_CSS = `
.kv-stage { position:relative; z-index:2; height:100%; overflow:hidden;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 20%, #000 66%, transparent 92%);
  mask-image: linear-gradient(180deg, transparent 0, #000 20%, #000 66%, transparent 92%); }
.kv-inner { position:absolute; left:0; right:0; padding:0 max(24px, 8vw);
  transition: transform .55s cubic-bezier(.22,.61,.20,1); will-change: transform; }
.kv-line { padding:14px 0; opacity:.28; filter: blur(3px); transform: scale(.96); transform-origin:left center;
  transition: opacity .45s ease, filter .45s ease, transform .45s cubic-bezier(.22,.61,.2,1); }
.kv-line.kv-active { opacity:1; filter: blur(0); transform: scale(1.02); }
.kv-lc { position:relative; display:inline-block; white-space:nowrap;
  font-family:var(--font-serif); font-size: clamp(24px,3.9vw,46px); font-weight:700; line-height:1.22; letter-spacing:-.01em; }
.kv-base { color: rgba(250,249,245,.22); }
.kv-fill { position:absolute; left:0; top:0; height:100%; width:0; overflow:hidden; white-space:nowrap;
  color: var(--color-ink); text-shadow: 0 0 20px rgba(217,119,87,.4), 0 0 6px rgba(250,249,245,.25); }
.kv-fill.kv-sweeping {
  -webkit-mask-image: linear-gradient(90deg,#000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent);
  mask-image: linear-gradient(90deg,#000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent); }
`;
