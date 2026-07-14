"""Regroup a flat, time-ordered word list back into the original lyric lines.

The aligner is fed the whole lyric as one text and returns a flat, time-ordered
word list. We map those aligned words back onto the original source words with a
global sequence alignment (difflib) rather than counting whitespace tokens.

Counting was fragile: the flat list comes from WhisperX's own tokenization, which
can disagree with `str.split()` on apostrophes, hyphens, punctuation and
number/symbol expansion — or drop unalignable words entirely. A per-line count
mismatch did not just empty one line, it *shifted* every subsequent line's words by
the delta, so later timings drifted ever earlier toward the end of the song.
Sequence alignment re-anchors at the next matching word, so a local mismatch stays
local instead of cascading.

Output shape is unchanged: [{"text", "start", "end", "words": [{"w", "start",
"end", "conf"}, ...]}]. Each word `w` keeps the *source* spelling; its timing comes
from the aligned word it matched, or is interpolated from its neighbours when a
source word had no match — so the frontend always receives numeric, monotonic
timings (a null start would render a word as filled from t=0).
"""
import difflib
import re

# Cap the per-word slot used to time interpolated (unaligned) words between two
# anchors. Sung words rarely exceed this; a larger implied slot means the gap holds
# non-vocal time (an instrumental break), so we place words at this cadence next to
# the anchor rather than smearing them across the silence. See _fill_unmatched.
_MAX_INTERP_STEP = 0.6


def _norm(w):
    """Fold a token to lowercase alphanumerics for matching (apostrophes, hyphens
    and punctuation are stripped so "don't" <-> "dont", "well-known" <-> "wellknown").

    Non-Latin scripts (Cyrillic, Greek, Arabic, ...) strip to empty under the ASCII
    filter; collapsing every token to "" would make difflib match purely positionally
    and defeat the content re-anchoring. Fall back to the lowercased token so those
    words still match on their own content. (Spaceless scripts like CJK still tokenize
    per line, so their timing stays coarse — a separate limitation.)"""
    w = w.lower()
    return re.sub(r"[^a-z0-9]", "", w) or w.strip()


def _fill_unmatched(src):
    """Give every source word a numeric, monotonic timing.

    Interior gaps between two matched anchors place their unmatched words at the
    vocal cadence just before the next anchor (identical to an even spread for small
    gaps, but never smeared across a large instrumental gap — which would light a
    line's leading word up seconds early). Leading/trailing unmatched runs are clamped
    to the nearest anchor. If nothing matched at all, the whole list stays untimed
    (None) — the line then never force-activates on the frontend, the correct "we
    don't know" display.
    """
    anchors = [i for i, s in enumerate(src) if s["start"] is not None]
    if not anchors:
        return
    first, last = anchors[0], anchors[-1]
    for i in range(first):  # leading run -> clamp to the first anchor's start
        src[i]["start"] = src[i]["end"] = src[first]["start"]
    for i in range(last + 1, len(src)):  # trailing run -> clamp to the last anchor's end
        src[i]["start"] = src[i]["end"] = src[last]["end"]
    for a, b in zip(anchors, anchors[1:]):  # interior gap
        gap = b - a
        if gap <= 1:
            continue
        t0, t1 = src[a]["end"], src[b]["start"]
        if t1 < t0:
            t1 = t0  # degenerate (out-of-order anchors) -> collapse the run
        # Cap the per-word slot so a large gap (an instrumental break the aligner
        # skipped) isn't smeared across the silence. Words are placed by which line
        # they belong to: those continuing the PREVIOUS anchor's line run forward from
        # t0; those leading into the NEXT anchor's line run backward from t1; whole
        # unmatched lines in between fill the remaining span evenly. This keeps each
        # word next to its real vocal instead of drifting across the gap (the cause of
        # a line's first word lighting up seconds early). For small gaps the cap is
        # inert and this stays a near-even spread.
        run = range(a + 1, b)
        la, lb = src[a]["line"], src[b]["line"]
        head = [i for i in run if src[i]["line"] == la]                 # prev line's tail
        lead = [i for i in run if src[i]["line"] == lb and lb != la]    # next line's head
        mid = [i for i in run if i not in head and i not in lead]       # whole lines between
        step = min((t1 - t0) / gap, _MAX_INTERP_STEP)
        for j, i in enumerate(head):
            src[i]["start"], src[i]["end"] = t0 + step * j, t0 + step * (j + 1)
        for p, i in enumerate(lead):
            end = t1 - step * (len(lead) - 1 - p)
            src[i]["start"], src[i]["end"] = end - step, end
        if mid:
            m0, m1 = t0 + step * len(head), t1 - step * len(lead)
            mstep = max(0.0, m1 - m0) / len(mid)
            for q, i in enumerate(mid):
                src[i]["start"], src[i]["end"] = m0 + mstep * q, m0 + mstep * (q + 1)


def group_words_into_lines(lines, flat_words):
    # Flatten source words, remembering which line each one belongs to.
    src = []
    for li, line in enumerate(lines):
        for w in line.split():
            src.append({"w": w, "line": li, "start": None, "end": None, "conf": 0.0})

    # Align normalized source tokens against the aligned words. "equal" runs map
    # 1:1 and take the aligned timing; mismatched runs are left for _fill_unmatched
    # and re-anchored by the next equal run, so drift can't cascade.
    src_norm = [_norm(s["w"]) for s in src]
    flat_norm = [_norm(f.get("w", "")) for f in flat_words]
    matcher = difflib.SequenceMatcher(None, src_norm, flat_norm, autojunk=False)
    for tag, i1, i2, j1, _ in matcher.get_opcodes():
        if tag != "equal":
            continue
        for k in range(i2 - i1):
            fw = flat_words[j1 + k]
            s = src[i1 + k]
            s["start"] = fw.get("start")
            s["end"] = fw.get("end")
            s["conf"] = fw.get("conf", 0.0)

    _fill_unmatched(src)

    # Regroup by line, preserving the original output shape.
    out = []
    for li, line in enumerate(lines):
        words = [
            {"w": s["w"], "start": s["start"], "end": s["end"], "conf": s["conf"]}
            for s in src
            if s["line"] == li
        ]
        start = words[0]["start"] if words else None
        end = words[-1]["end"] if words else None
        out.append({"text": line, "start": start, "end": end, "words": words})
    return out
