# Karaoke player — design mockups (Phase 3 visual spec)

These two scripts encode the **locked design + motion** for the Phase 3 karaoke player
(see `KARAOKE.md`). Each reads a `canopy.html` produced by the Phase 2.5 spike (real
word timings + embedded audio) and emits a self-contained, playable HTML preview.

- **`standalone_sweep.py`** → the pure lyrics sweep (design + motion in isolation).
- **`player_integration.py`** → the same sweep wearing Music's real chrome (loom Warm
  Editorial tokens, full-screen `PlayerBar` layout, now-playing chip, docked controls),
  plus the alignment-state UI (Synced / Needs sync / Generating) with a preview switcher.

## The design these capture (lift into React for Phase 3)

- **Continuous per-line sweep** — one bright overlay per line clipped to a single leading
  edge that glides through words and the spaces between them; a soft masked glow only on
  the currently-sweeping line. NOT independent per-word fills.
- **Timing-driven speed** — within a word the front interpolates `left→right` over that
  word's duration, so it accelerates on fast words and eases on held ones, capped at
  `MAX_SWEEP ≈ 1.2 s`.
- **Line-advance lead** — a line takes focus/scroll `LEAD ≈ 0.6 s` before its first word,
  clamped past the previous line's end (`activateAt[]`).
- **Depth** — inactive lines dim + blur by distance; eased auto-scroll anchors the active
  line ~40% down; top/bottom fade masks.
- **Integration** — the karaoke view is the full-screen player with a Lyrics toggle;
  artwork ↔ sweep swap; controls stay docked; artwork-derived blurred backdrop.

## Regenerate a preview

```bash
# from a dir containing a spike canopy.html (Phase 2.5 output):
python3 standalone_sweep.py      # -> karaoke_mock.html
python3 player_integration.py    # -> integration_mock.html
```

Note: the emitted HTML embeds the source song's audio, so it is NOT committed — only
these generators are (the design lives in their CSS/JS).
