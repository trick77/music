"""Cross-check the primary alignment against a second, independent aligner.

Forced alignment must place every word somewhere. When a word is preceded by a
pause — or by quiet non-lead audio (a breath, an ad-lib, a backing harmony, a
reverb tail) — the aligner can latch onto that instead of the sung word, and the
word's span then *starts* in the quiet part and runs up to the real onset. The
karaoke lights the word from its start, so it highlights up to ~1.5s early while
the previous line is still ringing.

Observed on "Empty Streets" line 26 ("Every corner holds a ghost of you"): the
vocal stem is silent 277.5-278.8, has a quiet event 278.9-280.4, and the lead
vocal enters at 280.5. WhisperX put "Every" at 278.98 (conf 0.85 — confidently
wrong) spanning up to 280.44, i.e. exactly the quiet event before the word.

The key asymmetry: this failure only ever runs a word EARLY. An aligner does not
invent a later onset — it has nothing to latch onto after the word is sung. Two
independent aligners fail on *different* words (WhisperX smeared line 26; MMS_FA
smeared a line into a 37s instrumental gap), so where they disagree materially,
the later start is the one that isn't smeared. Where they agree, we change nothing.

This is a repair for a broken minority of words, not a re-alignment: on a song
whose alignment is already correct it is a no-op (Kings of Nothing: 0 of 56 lines
disagreed by more than the threshold).
"""
import logging
import re

log = logging.getLogger("align")

# Disagreement (seconds) above which the two aligners are considered to be telling
# different stories rather than merely jittering. Real disagreements seen in the
# wild are 1.4-2.9s; agreement between them is typically <0.15s. 0.8 sits in the
# empty middle, so it neither chases jitter nor misses a genuine smear.
CONSENSUS_THRESHOLD = 0.8

# MMS_FA's English token set is lowercase letters plus the apostrophe. Anything
# else (digits, punctuation, other scripts) has no token and cannot be aligned.
_STRIP = re.compile(r"[^a-z']")


def normalize(word):
    """Fold a source word to MMS_FA's token alphabet; "" when nothing survives."""
    return _STRIP.sub("", word.lower())


def alignable(words):
    """True when the second aligner can be trusted with this word list.

    MMS_FA romanizes non-Latin scripts via uroman, which we do not ship; and a
    lyric that strips to mostly-empty tokens would align to noise. Rather than
    feed it garbage and get a confidently wrong second opinion, we decline and
    keep the primary alignment untouched.
    """
    if not words:
        return False
    kept = sum(1 for w in words if normalize(w))
    return kept >= max(1, int(0.9 * len(words)))


def word_starts(wav, words, device):
    """Force-align `words` against `wav` (16 kHz mono float32) with MMS_FA.

    Returns one start (seconds, from the beginning of `wav`) per entry of `words`,
    or None for a word that has no alignable token. Import-time cost is deferred to
    here so the module stays importable — and unit-testable — without torch.
    """
    import torch
    from torchaudio.pipelines import MMS_FA as bundle

    toks = [normalize(w) for w in words]
    idx = [i for i, t in enumerate(toks) if t]
    if not idx:
        return [None] * len(words)

    model = _model(bundle, device)
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()
    waveform = torch.from_numpy(wav).unsqueeze(0).to(device)
    with torch.inference_mode():
        emission, _ = model(waveform)
        spans = aligner(emission[0], tokenizer([toks[i] for i in idx]))

    # Emission frames are coarser than samples; scale back to a sample offset.
    ratio = waveform.size(1) / emission.size(1)
    out = [None] * len(words)
    for i, span in zip(idx, spans):
        out[i] = (span[0].start * ratio) / bundle.sample_rate
    return out


_cached_model = {}


def _model(bundle, device):
    """The MMS_FA model, loaded once per process (a ~1.2 GB download on first use,
    then served from the mounted model cache like the primary align model)."""
    if device not in _cached_model:
        _cached_model[device] = bundle.get_model().to(device)
    return _cached_model[device]


def apply_consensus(grouped, alt_starts, threshold=CONSENSUS_THRESHOLD):
    """Take the LATER start wherever the two aligners disagree by > threshold.

    `alt_starts` is positional over the flattened source words of `grouped` — the
    same order group_words_into_lines emits, one entry per source word.

    Only a *later* second opinion can win: if the second aligner is the earlier of
    the two it is the one that smeared, and the primary stands. A word's end is
    pushed out with its start so the span can never invert; line bounds are then
    recomputed from the words they contain.
    """
    moved = 0
    i = 0
    for line in grouped:
        for w in line["words"]:
            alt = alt_starts[i] if i < len(alt_starts) else None
            i += 1
            if alt is None:
                continue
            start = float(w["start"])
            if alt - start <= threshold:
                continue  # agreement, jitter, or the alt is the smeared one
            w["start"] = alt
            if float(w["end"]) < alt:
                w["end"] = alt
            moved += 1
        words = line["words"]
        if words:
            line["start"] = min(float(x["start"]) for x in words)
            line["end"] = max(float(x["end"]) for x in words)
    if moved:
        log.info("consensus: corrected %d back-smeared word start(s)", moved)
    return grouped
