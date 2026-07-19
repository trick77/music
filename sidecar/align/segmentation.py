"""Split a long track into a few silence-bounded segments so alignment fits in RAM.

WhisperX force-aligns each segment by running a wav2vec2 forward over just that
segment's audio (`audio[f1:f2]`), and wav2vec2's memory grows with length — a whole
7-minute track needs ~9-12 GB and OOM-kills the sidecar. But wav2vec2 attention is
bidirectional/global, so a segment must NOT cut through a sung phrase: every frame's
emission depends on the rest of its segment, and a mid-word cut corrupts the timing
(measured: even 200 s windows slipped words by tens of seconds). The safe cut is a
SILENCE in the vocal stem — across a real gap there is no phonetic context to lose,
and no word spans it. That is also WhisperX's intended usage (one segment per sung
region, not one whole-track segment).

We therefore cut only at silences, into as FEW segments as the memory budget allows
(fewer boundaries = fewer line-assignment decisions to get wrong), then split the
known lyrics across those segments in proportion to how much singing each contains.
Per-segment forced alignment then bounds peak memory to one segment (~4 GB at the
150 s target) regardless of track length, while preserving alignment within each
sung region. The pure planning/assignment logic here is unit-tested without torch;
`find_silences` runs on the vocal waveform at request time.
"""
import re

SAMPLE_RATE = 16000

# Target/limit segment length. 150 s forwards at ~3.8 GB (measured ~1.4 GB per 100 s
# over a ~1.6 GB base); the hard max keeps a segment with no nearby silence from
# growing the forward past the memory budget.
TARGET_SEG_S = 150.0
MAX_SEG_S = 220.0
MIN_SEG_S = 20.0
# A silence must be at least this long to be a cut point — long enough to be a real
# gap between sung phrases, not a stop consonant or a breath within a word.
MIN_CUT_GAP_S = 0.6


def find_silences(wav, sr=SAMPLE_RATE, frame_ms=20, min_gap_s=MIN_CUT_GAP_S, rel_thresh=0.02):
    """Silence gaps in a mono float waveform, as a list of (start_s, end_s).

    A frame is silent when its RMS is below `rel_thresh` of the track's loud level
    (95th-percentile frame RMS); a gap is a run of silent frames >= `min_gap_s`.
    Operates on the Demucs VOCAL stem, where non-sung regions are genuinely quiet.
    """
    import numpy as np

    x = np.asarray(wav, dtype=np.float32)
    hop = max(1, int(sr * frame_ms / 1000))
    n = len(x) // hop
    if n == 0:
        return []
    frames = x[: n * hop].reshape(n, hop)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    loud = np.percentile(rms, 95)
    thresh = max(loud * rel_thresh, 1e-6)
    silent = rms < thresh

    gaps = []
    i = 0
    min_frames = max(1, int(min_gap_s * sr / hop))
    while i < n:
        if silent[i]:
            j = i
            while j < n and silent[j]:
                j += 1
            if j - i >= min_frames:
                gaps.append((i * hop / sr, j * hop / sr))
            i = j
        else:
            i += 1
    return gaps


def plan_segments(duration_s, silences, target_s=TARGET_SEG_S, max_s=MAX_SEG_S,
                  min_seg_s=MIN_SEG_S, min_gap_s=MIN_CUT_GAP_S):
    """Tile [0, duration_s) into segments, cutting only at silence midpoints.

    Greedy: from each segment start, take the silence gap whose midpoint is closest
    to `target_s` ahead (and no further than `max_s`) as the next cut; if none
    qualifies, extend to the end. Returns dicts with start_s, end_s and voiced_s
    (segment length minus the silence inside it) — voiced_s drives line assignment.

    Cutting at the gap MIDPOINT leaves a silent pad on both sides so a segment always
    begins and ends in quiet, never mid-phrase.
    """
    usable = [(s, e) for s, e in silences if e - s >= min_gap_s and 0 < s and e < duration_s]
    segs = []
    start = 0.0
    while duration_s - start > max_s:
        lo, hi = start + min_seg_s, start + max_s
        target = start + target_s
        candidates = [g for g in usable if lo <= (g[0] + g[1]) / 2 <= hi]
        if not candidates:
            # No silence in range: force a cut at the target to bound memory (rare —
            # >max_s of continuous singing). A word may split here; logged by caller.
            cut = min(target, duration_s)
        else:
            cut = min(((g[0] + g[1]) / 2 for g in candidates), key=lambda m: abs(m - target))
        segs.append((start, cut))
        start = cut
    segs.append((start, duration_s))

    def voiced(a, b):
        sil = sum(min(b, e) - max(a, s) for s, e in silences if s < b and e > a)
        return max(0.0, (b - a) - max(0.0, sil))

    return [{"start_s": a, "end_s": b, "voiced_s": voiced(a, b)} for a, b in segs]


def _weight(line):
    """A line's share of singing time, proxied by its non-space character count."""
    return len(re.sub(r"\s+", "", line))


def assign_lines(seg_voiced, lines):
    """Split `lines` (in order) across segments in proportion to each segment's
    voiced seconds. Whole lines only; a segment with ~no singing gets none.

    Returns a list parallel to `seg_voiced`, each a list of the lines for that
    segment. Every line is assigned exactly once, in order, so the concatenated
    result still reads as the full lyric (grouping re-anchors by content anyway).
    """
    k = len(seg_voiced)
    result = [[] for _ in range(k)]
    if k == 1:
        result[0] = list(lines)
        return result

    weights = [_weight(ln) for ln in lines]
    total_w = sum(weights) or 1
    total_v = sum(seg_voiced) or 1.0
    # Cumulative target char-count at the end of each segment.
    targets, cum = [], 0.0
    for v in seg_voiced:
        cum += v
        targets.append(total_w * cum / total_v)

    seg = 0
    cum_c = 0
    for line, w in zip(lines, weights):
        while seg < k - 1 and cum_c >= targets[seg]:
            seg += 1  # this segment's share is full (or it holds no singing) -> next
        result[seg].append(line)
        cum_c += w
    return result
