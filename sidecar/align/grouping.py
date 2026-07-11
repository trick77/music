"""Regroup a flat, time-ordered word list back into the original lyric lines.

The aligner is fed the whole lyric as one text and returns a flat word list. We
slice the flat list back into lines by each line's whitespace word count.

KNOWN LIMITATION (tracked for the Phase 2 sidecar-quality follow-up): the slice
count uses naive `str.split()`, but the flat list comes from WhisperX's own
tokenization, which can disagree on apostrophes, hyphens, punctuation, and
number/symbol expansion — or drop unalignable words. Any per-line count mismatch
does not just empty one line: it *shifts* every subsequent line's words by the
delta, so later timings drift silently while the row is still marked ready. The
guard below only prevents a crash (trailing lines get whatever remains, possibly
empty); it does not correct the drift. A robust fix aligns WhisperX tokens back to
source words rather than counting — deferred until we can evaluate real output.
"""


def group_words_into_lines(lines, flat_words):
    out = []
    idx = 0
    for line in lines:
        n = len(line.split())
        chunk = flat_words[idx:idx + n]
        idx += n
        start = chunk[0]["start"] if chunk else None
        end = chunk[-1]["end"] if chunk else None
        out.append({"text": line, "start": start, "end": end, "words": chunk})
    return out
