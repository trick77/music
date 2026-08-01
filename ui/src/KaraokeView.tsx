import { useEffect, useRef } from "react";
import { player } from "./player";
import type { AlignedLine } from "./api";

const LEAD = 0.6;
const MAX_SWEEP = 1.2;
const HOLD = 4;
const INTRO_MIN = 2; // only animate the intro for lead-ins at least this long (s)
const SWEEP_LEAD = 0.2; // s — advance the sweep clock to compensate for perceived lyric-sync lag

type LineRt = {
  el: HTMLDivElement;
  wordSpans: HTMLSpanElement[];
  wl: AlignedLine["words"];
  on?: boolean;
  filled?: number; // last per-line fill state written: 0/1 for static lines, -1 sentinel for the active (dynamic) line
};

// KaraokeView renders the Apple-Music-style continuous per-line sweep. Lines wrap
// onto multiple rows; each word carries its own time-driven fill (a text-clipped
// gradient set via the --p custom property), so the highlight flows word-by-word
// across rows. A single requestAnimationFrame loop reads the live <audio>
// currentTime and writes per-word fill, per-line dim/blur, and the eased
// auto-scroll straight to the DOM — never through React state (which can't keep
// 60fps). Motion/CSS was lifted from docs/mockups/karaoke/player_integration.py,
// since removed — KV_CSS below is now the source of truth for both.
export function KaraokeView({ lines }: { lines: AlignedLine[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<LineRt[]>([]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const notes = notesRef.current;
    const L = lineRefs.current;

    // activateAt[i]: when line i takes focus — LEAD before its first word, clamped
    // past the previous line's end so we never jump back.
    const activateAt = lines.map((ln, i) => {
      if (ln.start == null) return Infinity;
      if (i === 0) return 0;
      const pe = lines[i - 1]?.end != null ? lines[i - 1].end : ln.start - LEAD;
      return Math.max(ln.start - LEAD, pe);
    });

    // Intro window: the instrumental lead-in before the first sung word. We key
    // off the real first-word start (activateAt[0] is pinned to 0 for the sweep,
    // so it can't tell us when the intro ends). Only show the intro animation for
    // a meaningful lead-in, and clear it LEAD seconds before the first word so the
    // first line takes focus cleanly.
    const firstStart =
      lines[0]?.words?.[0] != null
        ? +lines[0].words[0].start
        : lines[0]?.start != null
          ? lines[0].start
          : 0;
    const introEndsAt = firstStart - LEAD;
    const hasIntro = firstStart >= INTRO_MIN;

    // wordFill: 0..1 sung fraction of word k on the active line at time t.
    function wordFill(l: LineRt, k: number, t: number): number {
      const w = l.wl[k];
      const s = +w.start;
      const e = +w.end;
      const dur = Math.min(e - s, MAX_SWEEP);
      if (t <= s) return 0;
      if (dur <= 0) return t >= e ? 1 : 0;
      return Math.max(0, Math.min(1, (t - s) / dur));
    }

    let raf = 0;
    let cancelled = false;
    let lastActive = -2;
    let notesOn = false;
    function frame() {
      const audio = player.getAudioElement();
      const t = (audio ? audio.currentTime : 0) + SWEEP_LEAD;
      let active = -1;
      for (let i = 0; i < lines.length; i++) if (t >= activateAt[i]) active = i;
      const activeEndTime =
        active >= 0 ? (lines[active].end ?? activateAt[active]) : -Infinity;
      const held = active >= 0 && t <= activeEndTime + HOLD;
      const showNotes = hasIntro && t < introEndsAt;
      if (showNotes !== notesOn) {
        notes?.classList.toggle("kv-visible", showNotes);
        notesOn = showNotes;
      }
      L.forEach((l, i) => {
        if (!l) return;
        const on = i === active && held;
        if (l.on !== on) {
          l.el.classList.toggle("kv-active", on);
          l.on = on;
        }
        if (!on) {
          const dist = Math.abs(i - (active < 0 ? 0 : active));
          l.el.style.opacity = Math.max(0.1, 0.48 - dist * 0.1).toFixed(2);
          l.el.style.filter =
            "blur(" + Math.min(7, 1 + dist * 1.5).toFixed(1) + "px)";
        } else {
          l.el.style.opacity = "";
          l.el.style.filter = "";
        }
        // Per-word fill. Keyed on position vs. the active line (matches the old
        // width-sweep: lines before active are fully sung, after are unsung, the
        // active line sweeps word-by-word — regardless of the HOLD-gated `on`).
        if (i === active) {
          for (let k = 0; k < l.wordSpans.length; k++) {
            const p = wordFill(l, k, t);
            l.wordSpans[k].style.setProperty("--p", p.toFixed(3));
          }
          l.filled = -1;
        } else {
          const target = i < active ? 1 : 0;
          if (l.filled !== target) {
            const v = String(target);
            for (const sp of l.wordSpans) sp.style.setProperty("--p", v);
            l.filled = target;
          }
        }
      });
      if (active !== lastActive) {
        const el = L[active < 0 ? 0 : active]?.el;
        if (el)
          inner!.style.transform =
            "translateY(" +
            (window.innerHeight * 0.4 - (el.offsetTop + el.offsetHeight / 2)) +
            "px)";
        lastActive = active;
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      // The fonts.ready promise can resolve after unmount; bail so we don't spawn
      // an uncancellable rAF loop mutating detached DOM.
      if (cancelled) return;
      const el = L[0]?.el;
      if (el)
        inner!.style.transform =
          "translateY(" +
          (window.innerHeight * 0.4 - (el.offsetTop + el.offsetHeight / 2)) +
          "px)";
      raf = requestAnimationFrame(frame);
    }
    const onResize = () => {
      // Wrapped line heights change on reflow; re-run the scroll transform.
      lastActive = -2;
    };
    window.addEventListener("resize", onResize);
    if (document.fonts && document.fonts.ready)
      document.fonts.ready.then(start);
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
        <div ref={notesRef} className="kv-intro-notes" aria-hidden="true">
          <span>♪</span>
          <span>♫</span>
          <span>♩</span>
        </div>
        <div ref={innerRef} className="kv-inner">
          {lines.map((ln, li) => (
            <LineRow
              key={li}
              line={ln}
              register={(rt) => (lineRefs.current[li] = rt)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function LineRow({
  line,
  register,
}: {
  line: AlignedLine;
  register: (rt: LineRt) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<HTMLSpanElement[]>([]);
  const wl = line.words ?? [];
  useEffect(() => {
    if (elRef.current) {
      register({ el: elRef.current, wordSpans: wordRefs.current, wl });
    }
  });
  wordRefs.current = [];
  return (
    <div ref={elRef} className="kv-line">
      <div className="kv-lc">
        {wl.length ? (
          wl.map((w, i) => (
            <span key={i}>
              <span
                ref={(el) => {
                  if (el) wordRefs.current[i] = el;
                }}
                className="kv-word"
              >
                {w.w}
              </span>
              {i < wl.length - 1 ? " " : ""}
            </span>
          ))
        ) : (
          <span className="kv-word">{line.text || " "}</span>
        )}
      </div>
    </div>
  );
}

// Originally ported from docs/mockups/karaoke/player_integration.py (since
// removed; recoverable from git history), themed to loom tokens
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
.kv-lc { display:block; font-family:var(--font-serif); font-size: clamp(24px,3.9vw,46px);
  font-weight:700; line-height:1.22; letter-spacing:-.01em; }
/* Each word is its own text-clipped gradient: sung fraction (--p, 0..1, written
   by the rAF loop) shows in ink, the rest in the dim base tint. Lines wrap
   naturally at the spaces between words, so long lines flow onto multiple rows
   while the fill still advances word-by-word. */
.kv-word { --p:0;
  background-image: linear-gradient(90deg,
    var(--color-ink) calc(var(--p) * 100%),
    rgba(250,249,245,.22) calc(var(--p) * 100%));
  -webkit-background-clip:text; background-clip:text;
  -webkit-text-fill-color:transparent; color:transparent; }
/* Intro "get ready" flourish: music notes drift up and fade just ABOVE where the
   first lyric lands (the first line auto-scrolls to 40vh). Shown via .kv-visible
   during the instrumental lead-in. */
.kv-intro-notes { position:absolute; top:40vh; left:max(24px, 8vw); margin-top:-40px;
  width:120px; height:66px; transform:translateY(-100%);
  opacity:0; pointer-events:none; transition: opacity .45s ease; }
.kv-intro-notes.kv-visible { opacity:1; }
.kv-intro-notes span { position:absolute; bottom:0; color: var(--color-accent-strong);
  text-shadow: 0 0 10px rgba(217,119,87,.5); opacity:0;
  animation: kv-note-float 3.2s ease-in infinite; }
.kv-intro-notes span:nth-child(1) { left:2px;  font-size:22px; animation-delay:0s; }
.kv-intro-notes span:nth-child(2) { left:42px; font-size:30px; animation-delay:1.05s; }
.kv-intro-notes span:nth-child(3) { left:82px; font-size:18px; animation-delay:2.1s; }
@keyframes kv-note-float {
  0%   { transform: translateY(0) rotate(-6deg); opacity:0; }
  20%  { opacity:.95; }
  100% { transform: translateY(-52px) rotate(8deg); opacity:0; }
}
@media (prefers-reduced-motion: reduce) {
  .kv-intro-notes span { animation-name: kv-note-fade; }
  @keyframes kv-note-fade { 0%,100% { transform:none; opacity:.3; } 50% { transform:none; opacity:.85; } }
}
`;
