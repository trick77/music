#!/usr/bin/env python3
"""Generate an Apple-Music-style karaoke mock from the real spike output.

Continuous per-LINE sweep: one bright overlay per line, clipped to a single leading
edge that glides across words AND the spaces between them, driven by the word timings.
Plus: line-advance lead, per-word max sweep cap, depth-blurred inactive lines, eased
auto-scroll, ambient backdrop.
"""
import re

src = open("canopy.html").read()
lines = re.search(r"const LINES = (\[.*?\]);", src, re.S).group(1)
audio = re.search(r'src="(data:audio/mpeg;base64,[^"]+)"', src).group(1)

TEMPLATE = r"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Karaoke — mock</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
    background: #06070b; color: #fff; overflow: hidden; }

  .bg { position: fixed; inset: -20%; z-index: 0; filter: blur(70px) saturate(1.3); opacity: .55; }
  .bg span { position: absolute; width: 55vmax; height: 55vmax; border-radius: 50%; mix-blend-mode: screen; }
  .b1 { background: #3b5bdb; left: -10%; top: -15%; animation: drift1 19s ease-in-out infinite; }
  .b2 { background: #d6336c; right: -12%; top: 10%; animation: drift2 23s ease-in-out infinite; }
  .b3 { background: #0ca678; left: 20%; bottom: -20%; animation: drift3 27s ease-in-out infinite; }
  @keyframes drift1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(12vw,8vh) scale(1.15)} }
  @keyframes drift2 { 0%,100%{transform:translate(0,0) scale(1.1)} 50%{transform:translate(-10vw,10vh) scale(.9)} }
  @keyframes drift3 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(8vw,-10vh) scale(1.2)} }
  .vignette { position: fixed; inset: 0; z-index: 1; pointer-events: none;
    background: radial-gradient(120% 90% at 50% 40%, transparent 40%, rgba(3,4,7,.85) 100%); }

  header { position: fixed; z-index: 3; top: 22px; left: 26px; }
  header .t { font-size: 15px; font-weight: 600; }
  header .a { font-size: 13px; color: rgba(255,255,255,.5); margin-top: 2px; }

  .stage { position: relative; z-index: 2; height: 100%; overflow: hidden;
    mask-image: linear-gradient(180deg, transparent 0, #000 18%, #000 74%, transparent 100%);
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 18%, #000 74%, transparent 100%); }
  #inner { position: absolute; left: 0; right: 0; padding: 0 max(26px, 7vw);
    transition: transform .55s cubic-bezier(.22,.61,.20,1); will-change: transform; }

  .line { padding: 15px 0; opacity: .3; filter: blur(3px); transform: scale(.96);
    transform-origin: left center;
    transition: opacity .45s ease, filter .45s ease, transform .45s cubic-bezier(.22,.61,.2,1); }
  .line.active { opacity: 1; filter: blur(0); transform: scale(1.02); }

  .lc { position: relative; display: inline-block; white-space: nowrap;
    font-size: clamp(24px, 4vw, 46px); font-weight: 800; line-height: 1.2; letter-spacing: -.015em; }
  .base { color: rgba(255,255,255,.24); }
  .fill { position: absolute; left: 0; top: 0; height: 100%; width: 0; overflow: hidden;
    white-space: nowrap; color: #fff; text-shadow: 0 0 18px rgba(190,215,255,.45); }
  /* soft glowing leading edge — only on the line currently sweeping */
  .fill.sweeping {
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent);
    mask-image: linear-gradient(90deg, #000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent); }

  .bar { position: fixed; z-index: 4; left: 50%; bottom: 24px; transform: translateX(-50%);
    width: min(560px, 90vw); background: rgba(20,22,30,.55); border: 1px solid rgba(255,255,255,.08);
    backdrop-filter: blur(18px); border-radius: 16px; padding: 10px 14px; }
  .bar audio { width: 100%; display: block; }
  .hint { position: fixed; z-index: 4; bottom: 92px; left: 50%; transform: translateX(-50%);
    font-size: 12px; color: rgba(255,255,255,.4); }
</style></head>
<body>
  <div class="bg"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
  <div class="vignette"></div>
  <header><div class="t">__TITLE__</div><div class="a">__ARTIST__</div></header>
  <div class="stage"><div id="inner"></div></div>
  <div class="hint">press play — one continuous sweep glides across each line</div>
  <div class="bar"><audio id="a" controls src="__AUDIO__"></audio></div>
<script>
const LINES = __LINES__;
// Line advances into focus this many seconds before its first word (clamped past the
// previous line's end). Word-sweep speed within a line is capped so a single word
// never sweeps longer than MAX_SWEEP.
const LEAD = 0.6;
const MAX_SWEEP = 1.2;

const inner = document.getElementById('inner');
const audio = document.getElementById('a');
const L = [];  // per line: {el, fill, wordSpans, wl, words:[{left,right,s,e}]}

LINES.forEach(ln => {
  const d = document.createElement('div'); d.className = 'line';
  const lc = document.createElement('div'); lc.className = 'lc';
  const base = document.createElement('span'); base.className = 'base';
  const fill = document.createElement('span'); fill.className = 'fill';
  const wl = ln.words || [];
  const wordSpans = [];
  wl.forEach((w, wi) => {
    const bs = document.createElement('span'); bs.textContent = w.w; base.appendChild(bs); wordSpans.push(bs);
    const fs = document.createElement('span'); fs.textContent = w.w; fill.appendChild(fs);
    if (wi < wl.length - 1) { base.appendChild(document.createTextNode(' ')); fill.appendChild(document.createTextNode(' ')); }
  });
  if (!wl.length) { base.textContent = ln.text || ' '; }
  lc.append(base, fill); d.appendChild(lc); inner.appendChild(d);
  L.push({ el: d, fill, wordSpans, wl, words: [] });
});

function measure() {
  for (const l of L) {
    const n = l.wordSpans.length; l.words = [];
    for (let i = 0; i < n; i++) {
      const sp = l.wordSpans[i];
      const left = sp.offsetLeft;
      // right = next word's left so the fill sweeps THROUGH the inter-word space
      const right = (i + 1 < n) ? l.wordSpans[i + 1].offsetLeft : left + sp.offsetWidth;
      l.words.push({ left, right, s: +l.wl[i].start, e: +l.wl[i].end });
    }
    l.lineW = l.words.length ? l.words[l.words.length - 1].right : 0;
  }
}

// activateAt[i]: when line i takes focus — LEAD early, never before prev line ended.
const activateAt = LINES.map((ln, i) => {
  if (ln.start == null) return Infinity;
  if (i === 0) return 0;
  const prevEnd = LINES[i - 1] && LINES[i - 1].end != null ? LINES[i - 1].end : ln.start - LEAD;
  return Math.max(ln.start - LEAD, prevEnd);
});

// continuous leading-edge X (px) for one line at time t
function frontX(l, t) {
  const ws = l.words; if (!ws.length) return 0;
  if (t < ws[0].s) return 0;
  let x = 0;
  for (const w of ws) {
    const se = w.s + Math.min(w.e - w.s, MAX_SWEEP);
    if (t >= se) x = w.right;
    else if (t >= w.s) return w.left + (t - w.s) / (se - w.s) * (w.right - w.left);
    else return x;   // front waits at end of last completed word
  }
  return x;
}

let lastActive = -2;
function frame() {
  const t = audio.currentTime;
  let active = -1;
  for (let i = 0; i < LINES.length; i++) if (t >= activateAt[i]) active = i;

  L.forEach((l, i) => {
    const on = i === active;
    if (l._on !== on) { l.el.classList.toggle('active', on); l.fill.classList.toggle('sweeping', on); l._on = on; }
    if (!on) {
      const dist = Math.abs(i - (active < 0 ? 0 : active));
      l.el.style.opacity = Math.max(.12, .5 - dist * .1).toFixed(2);
      l.el.style.filter = 'blur(' + Math.min(7, 1 + dist * 1.5).toFixed(1) + 'px)';
    } else { l.el.style.opacity = ''; l.el.style.filter = ''; }

    let x;
    if (i < active) x = l.lineW;         // already sung → solid full
    else if (i > active) x = 0;          // not yet
    else x = frontX(l, t);               // the one sweeping line
    l.fill.style.width = x + 'px';
  });

  if (active !== lastActive) {
    const el = L[active < 0 ? 0 : active].el;
    inner.style.transform = 'translateY(' + (window.innerHeight * 0.42 - (el.offsetTop + el.offsetHeight / 2)) + 'px)';
    lastActive = active;
  }
  requestAnimationFrame(frame);
}

function start() {
  measure();
  const el = L[0].el;
  inner.style.transform = 'translateY(' + (window.innerHeight * 0.42 - (el.offsetTop + el.offsetHeight / 2)) + 'px)';
  requestAnimationFrame(frame);
}
window.addEventListener('resize', () => { measure(); lastActive = -2; });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else requestAnimationFrame(start);
</script>
</body></html>"""

out = (TEMPLATE
       .replace("__LINES__", lines)
       .replace("__AUDIO__", audio)
       .replace("__TITLE__", "When the Canopy Steals the Light")
       .replace("__ARTIST__", "karaoke preview · real alignment"))
open("karaoke_mock.html", "w").write(out)
print("wrote karaoke_mock.html", len(out), "bytes")
