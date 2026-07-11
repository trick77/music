"""Regroup a flat, time-ordered word list back into the original lyric lines.

The aligner is fed the whole lyric as one text and returns a flat word list. We
know each line's word count from the input lyrics, so we slice the flat list back
into lines deterministically. If the aligner produced fewer words than expected
(dropped an unalignable word), later lines get whatever remains (possibly empty)
rather than raising.
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
