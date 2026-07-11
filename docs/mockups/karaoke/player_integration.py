#!/usr/bin/env python3
"""Integration mock: the karaoke sweep inside Music's full-screen player chrome,
themed to the real loom Warm Editorial tokens. Reuses the real spike alignment/audio.
"""
import re

src = open("canopy.html").read()
lines = re.search(r"const LINES = (\[.*?\]);", src, re.S).group(1)
audio = re.search(r'src="(data:audio/mpeg;base64,[^"]+)"', src).group(1)

TEMPLATE = r"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Music — karaoke (integration mock)</title>
<style>
  :root {
    --bg:#1f1f1e; --panel:#1b1b1a; --active:#2c2c2a; --border:#323230;
    --ink:#faf9f5; --muted:#9c9a92; --accent:#c6613f; --accent-strong:#d97757; --accent-fill:#c25f34;
    --serif: "Anthropic Serif", Georgia, serif; --sans: "Anthropic Sans", system-ui, sans-serif;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body { font-family: var(--sans); background: var(--bg); color: var(--ink); overflow: hidden; }

  /* Blurred cover-art backdrop (stand-in warm gradient; in-app this is the real
     artwork like PlayerBar's full-screen background). */
  .cover { position: fixed; inset:-25%; z-index:0; filter: blur(64px) saturate(1.25); opacity:.7; }
  .cover span { position:absolute; width:60vmax; height:60vmax; border-radius:50%; mix-blend-mode:screen; }
  .c1{ background:#c6613f; left:-8%; top:-18%; animation:d1 21s ease-in-out infinite; }
  .c2{ background:#a8843f; right:-10%; top:6%; animation:d2 25s ease-in-out infinite; }
  .c3{ background:#7a3b2c; left:22%; bottom:-22%; animation:d3 29s ease-in-out infinite; }
  @keyframes d1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(10vw,7vh) scale(1.15)}}
  @keyframes d2{0%,100%{transform:translate(0,0) scale(1.1)}50%{transform:translate(-9vw,9vh) scale(.9)}}
  @keyframes d3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(7vw,-9vh) scale(1.2)}}
  /* PlayerBar's exact scrim over the artwork */
  .scrim { position: fixed; inset:0; z-index:1; pointer-events:none;
    background: linear-gradient(180deg, rgba(20,20,18,0.55), rgba(20,20,18,0.92)); }

  /* top now-playing chip + close (Apple: artwork shrinks up-top in lyrics mode) */
  .top { position: fixed; z-index:5; top:16px; left:0; right:0; display:flex; align-items:center;
    justify-content:space-between; padding:0 20px; }
  .np { display:flex; align-items:center; gap:12px; min-width:0; }
  .np .art { width:46px; height:46px; border-radius:8px; flex-shrink:0; box-shadow:0 6px 20px rgba(0,0,0,.4);
    background: linear-gradient(135deg,#c6613f,#7a3b2c); display:grid; place-items:center;
    font-family:var(--serif); color:#f7e9df; font-size:20px; }
  .np .tt { min-width:0; }
  .np .tt b { display:block; font-family:var(--serif); font-weight:600; font-size:16px; color:var(--ink);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .np .tt span { display:block; font-size:13px; color:var(--muted); }
  .icon { display:grid; place-items:center; width:40px; height:40px; border-radius:8px; background:none;
    border:none; color:var(--ink); cursor:pointer; opacity:.85; }
  .icon:hover { opacity:1; }

  .stage { position: relative; z-index:2; height:100%; overflow:hidden;
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 20%, #000 66%, transparent 92%);
    mask-image: linear-gradient(180deg, transparent 0, #000 20%, #000 66%, transparent 92%); }
  #inner { position:absolute; left:0; right:0; padding:0 max(24px, 8vw);
    transition: transform .55s cubic-bezier(.22,.61,.20,1); will-change: transform; }

  .line { padding:14px 0; opacity:.28; filter: blur(3px); transform: scale(.96); transform-origin:left center;
    transition: opacity .45s ease, filter .45s ease, transform .45s cubic-bezier(.22,.61,.2,1); }
  .line.active { opacity:1; filter: blur(0); transform: scale(1.02); }
  .lc { position:relative; display:inline-block; white-space:nowrap;
    font-family:var(--serif); font-size: clamp(24px,3.9vw,46px); font-weight:700; line-height:1.22; letter-spacing:-.01em; }
  .base { color: rgba(250,249,245,.22); }
  .fill { position:absolute; left:0; top:0; height:100%; width:0; overflow:hidden; white-space:nowrap;
    color: var(--ink); text-shadow: 0 0 20px rgba(217,119,87,.4), 0 0 6px rgba(250,249,245,.25); }
  .fill.sweeping {
    -webkit-mask-image: linear-gradient(90deg,#000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent);
    mask-image: linear-gradient(90deg,#000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent); }

  /* docked controls — matches PlayerBar (frosted panel, accent-fill play) */
  .dock { position: fixed; z-index:6; left:50%; bottom:0; transform: translateX(-50%);
    width:100%; max-width:760px; padding:14px 22px 22px;
    background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--panel) 88%, transparent) 40%); }
  .scrub { display:flex; align-items:center; gap:10px; }
  .scrub input { flex:1; accent-color: var(--accent-fill); height:4px; }
  .scrub .t { font-size:13px; color:var(--muted); min-width:38px; }
  .ctl { display:flex; align-items:center; justify-content:center; gap:22px; margin-top:12px; }
  .play { width:56px; height:56px; border-radius:999px; background:var(--accent-fill); color:var(--ink);
    border:none; display:grid; place-items:center; cursor:pointer; box-shadow:0 8px 24px rgba(194,95,52,.4); }
  .lyr { color: var(--accent-strong); position:relative; }
  .lyr::after { content:""; position:absolute; left:50%; bottom:2px; width:4px; height:4px; border-radius:50%;
    background: var(--accent-strong); transform:translateX(-50%); }
  audio#a { display:none; }  /* real controls are the custom dock */

  /* alignment states (before the sweep exists) */
  .overlay { position:fixed; z-index:3; inset:0; display:none; place-items:center; padding:24px; }
  .overlay.show { display:grid; }
  .card { text-align:center; max-width:380px; background: color-mix(in srgb, var(--panel) 80%, transparent);
    border:1px solid var(--border); border-radius:16px; padding:30px 28px; backdrop-filter:blur(16px);
    box-shadow:0 22px 64px rgba(0,0,0,.55); }
  .card .ic { width:54px; height:54px; margin:0 auto 16px; border-radius:50%; background:var(--active);
    display:grid; place-items:center; color:var(--accent-strong); font-size:26px; }
  .card h3 { font-family:var(--serif); font-weight:600; margin:0 0 8px; font-size:21px; color:var(--ink); }
  .card p { margin:0 0 20px; color:var(--muted); font-size:14px; line-height:1.55; }
  .card .gen { background:var(--accent-fill); color:var(--ink); border:none; border-radius:10px;
    padding:12px 20px; font-size:15px; font-weight:600; cursor:pointer; box-shadow:0 8px 22px rgba(194,95,52,.35); }
  .spin { width:42px; height:42px; margin:0 auto 18px; border-radius:50%;
    border:3px solid var(--active); border-top-color:var(--accent-strong); animation:sp 1s linear infinite; }
  @keyframes sp { to { transform:rotate(360deg); } }

  /* preview-only state switcher (not part of the real UI) */
  .devsw { position:fixed; z-index:9; top:14px; left:50%; transform:translateX(-50%);
    background:rgba(0,0,0,.45); border:1px solid var(--border); border-radius:999px; padding:4px; display:flex; align-items:center; }
  .devsw .lbl { color:var(--muted); font-size:11px; padding:0 8px 0 10px; letter-spacing:.03em; text-transform:uppercase; }
  .devsw button { background:none; border:none; color:var(--muted); padding:6px 13px; border-radius:999px; cursor:pointer; font-size:12px; }
  .devsw button.on { background:var(--active); color:var(--ink); }
</style></head>
<body>
  <div class="cover"><span class="c1"></span><span class="c2"></span><span class="c3"></span></div>
  <div class="scrim"></div>

  <div class="top">
    <div class="np">
      <div class="art">W</div>
      <div class="tt"><b>When the Canopy Steals the Light</b><span id="sub">Suno &middot; Karaoke</span></div>
    </div>
    <button class="icon" title="Close">&#x2715;</button>
  </div>

  <div class="stage"><div id="inner"></div></div>

  <div class="dock">
    <div class="scrub"><span class="t" id="cur">0:00</span>
      <input type="range" id="seek" min="0" max="1000" value="0" aria-label="Seek">
      <span class="t" id="dur">0:00</span></div>
    <div class="ctl">
      <button class="icon" title="Favorite">&#9733;</button>
      <button class="icon" title="Previous">&#9198;</button>
      <button class="play" id="pp" title="Play">&#9654;</button>
      <button class="icon" title="Next">&#9197;</button>
      <button class="icon lyr" title="Lyrics (on)">&#119082;</button>
      <button class="icon" title="Share">&#x2197;</button>
    </div>
  </div>

  <div class="overlay" id="ov"></div>
  <div class="devsw"><span class="lbl">preview state</span>
    <button data-s="ready" class="on">Synced</button>
    <button data-s="needs">Needs sync</button>
    <button data-s="gen">Generating</button></div>

  <audio id="a" src="__AUDIO__"></audio>
<script>
const LINES = __LINES__;
const LEAD = 0.6, MAX_SWEEP = 1.2;
const inner = document.getElementById('inner');
const audio = document.getElementById('a');
const L = [];

LINES.forEach(ln => {
  const d=document.createElement('div'); d.className='line';
  const lc=document.createElement('div'); lc.className='lc';
  const base=document.createElement('span'); base.className='base';
  const fill=document.createElement('span'); fill.className='fill';
  const wl=ln.words||[]; const wordSpans=[];
  wl.forEach((w,wi)=>{
    const bs=document.createElement('span'); bs.textContent=w.w; base.appendChild(bs); wordSpans.push(bs);
    const fs=document.createElement('span'); fs.textContent=w.w; fill.appendChild(fs);
    if(wi<wl.length-1){ base.appendChild(document.createTextNode(' ')); fill.appendChild(document.createTextNode(' ')); }
  });
  if(!wl.length) base.textContent=ln.text||' ';
  lc.append(base,fill); d.appendChild(lc); inner.appendChild(d);
  L.push({el:d, fill, wordSpans, wl, words:[]});
});
function measure(){ for(const l of L){ const n=l.wordSpans.length; l.words=[];
  for(let i=0;i<n;i++){ const sp=l.wordSpans[i]; const left=sp.offsetLeft;
    const right=(i+1<n)?l.wordSpans[i+1].offsetLeft:left+sp.offsetWidth;
    l.words.push({left,right,s:+l.wl[i].start,e:+l.wl[i].end}); }
  l.lineW=l.words.length?l.words[l.words.length-1].right:0; } }
const activateAt=LINES.map((ln,i)=>{ if(ln.start==null)return Infinity; if(i===0)return 0;
  const pe=LINES[i-1]&&LINES[i-1].end!=null?LINES[i-1].end:ln.start-LEAD; return Math.max(ln.start-LEAD,pe); });
function frontX(l,t){ const ws=l.words; if(!ws.length)return 0; if(t<ws[0].s)return 0; let x=0;
  for(const w of ws){ const se=w.s+Math.min(w.e-w.s,MAX_SWEEP);
    if(t>=se)x=w.right; else if(t>=w.s)return w.left+(t-w.s)/(se-w.s)*(w.right-w.left); else return x; } return x; }
const fmt=s=>{s=Math.max(0,s|0);return (s/60|0)+':'+String(s%60).padStart(2,'0');};
let lastActive=-2;
function frame(){ const t=audio.currentTime;
  let active=-1; for(let i=0;i<LINES.length;i++) if(t>=activateAt[i]) active=i;
  L.forEach((l,i)=>{ const on=i===active;
    if(l._on!==on){ l.el.classList.toggle('active',on); l.fill.classList.toggle('sweeping',on); l._on=on; }
    if(!on){ const dist=Math.abs(i-(active<0?0:active));
      l.el.style.opacity=Math.max(.1,.48-dist*.1).toFixed(2);
      l.el.style.filter='blur('+Math.min(7,1+dist*1.5).toFixed(1)+'px)'; }
    else { l.el.style.opacity=''; l.el.style.filter=''; }
    let x; if(i<active)x=l.lineW; else if(i>active)x=0; else x=frontX(l,t);
    l.fill.style.width=x+'px'; });
  if(active!==lastActive){ const el=L[active<0?0:active].el;
    inner.style.transform='translateY('+(window.innerHeight*0.40-(el.offsetTop+el.offsetHeight/2))+'px)'; lastActive=active; }
  // dock sync
  if(audio.duration){ seek.value=1000*audio.currentTime/audio.duration; cur.textContent=fmt(audio.currentTime); dur.textContent=fmt(audio.duration); }
  requestAnimationFrame(frame);
}
const seek=document.getElementById('seek'), cur=document.getElementById('cur'), dur=document.getElementById('dur'), pp=document.getElementById('pp');
seek.addEventListener('input',()=>{ if(audio.duration) audio.currentTime=audio.duration*seek.value/1000; lastActive=-2; });
pp.addEventListener('click',()=>{ if(audio.paused){audio.play();pp.innerHTML='&#10074;&#10074;';} else {audio.pause();pp.innerHTML='&#9654;';} });
// ---- alignment states + persistent syncing indicator (preview switcher) ----
const ov=document.getElementById('ov'), stage=document.querySelector('.stage'), sub=document.getElementById('sub');
function setState(s){
  document.querySelectorAll('.devsw button').forEach(b=>b.classList.toggle('on', b.dataset.s===s));
  if(s==='ready'){ ov.classList.remove('show'); ov.innerHTML=''; stage.style.visibility='visible'; sub.innerHTML='Suno &middot; Karaoke'; }
  else if(s==='needs'){ stage.style.visibility='hidden'; ov.classList.add('show'); sub.innerHTML='Suno';
    ov.innerHTML='<div class="card"><div class="ic">&#9834;</div><h3>Sync lyrics to the music</h3><p>Generate word-by-word karaoke timing for this song &mdash; about a minute. Also runs automatically when you save lyrics in the tag editor.</p><button class="gen">Generate karaoke</button></div>';
    ov.querySelector('.gen').onclick=()=>setState('gen'); }
  else { stage.style.visibility='hidden'; ov.classList.add('show');
    sub.innerHTML='<span style="color:var(--accent-strong)">&#9679;</span> Syncing karaoke&hellip;';
    ov.innerHTML='<div class="card"><div class="spin"></div><h3>Aligning &ldquo;When the Canopy&hellip;&rdquo;</h3><p>Matching each word to the vocal &mdash; about a minute. Keep browsing; the song shows a spinner until it&rsquo;s ready.</p></div>'; }
}
document.querySelectorAll('.devsw button').forEach(b=>b.onclick=()=>setState(b.dataset.s));

function start(){ measure(); const el=L[0].el;
  inner.style.transform='translateY('+(window.innerHeight*0.40-(el.offsetTop+el.offsetHeight/2))+'px)'; requestAnimationFrame(frame); }
window.addEventListener('resize',()=>{ measure(); lastActive=-2; });
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(start); else requestAnimationFrame(start);
</script>
</body></html>"""

out = (TEMPLATE.replace("__LINES__", lines).replace("__AUDIO__", audio))
open("integration_mock.html", "w").write(out)
print("wrote integration_mock.html", len(out), "bytes")
