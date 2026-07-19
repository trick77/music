"""Word-timing alignment sidecar.

POST /align  (multipart: audio file + lyrics text)  -> {engine, lines:[...]}
GET  /health -> {"status":"ok"}

Pipeline: Demucs isolates the vocal stem, then WhisperX's wav2vec2 alignment stage
force-aligns the KNOWN lyrics (fed as one whole-track segment) to the audio. We use
the known words, never ASR output, so wrong-word transcription can't happen — only
timing is inferred. The flat aligned word list is regrouped into the original lines.
"""
import logging
import os
import tempfile

import torch
import whisperx
from demucs.separate import main as demucs_main
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from consensus import alignable, apply_consensus, word_starts
from grouping import group_words_into_lines
from language import detect_language
from segmentation import assign_lines, find_silences, plan_segments

log = logging.getLogger("align")

app = FastAPI()
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
ENGINE = "whisperx+demucs"

# CPU inference (Demucs + the wav2vec2 alignment stage) is torch-parallel, but torch
# under-detects cores inside a container and can pin to a single thread. Use all cores
# but one (leave one in reserve for the host) so alignment isn't stuck on a single CPU
# yet doesn't starve everything else (no-op on GPU).
if DEVICE == "cpu":
    torch.set_num_threads(max(1, (os.cpu_count() or 1) - 1))

# Align model is language-specific; load lazily and cache per language.
_align_cache = {}


def _get_align_model(language):
    if language not in _align_cache:
        _align_cache[language] = whisperx.load_align_model(language_code=language, device=DEVICE)
    return _align_cache[language]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/align")
async def align(audio: UploadFile = File(...), lyrics: str = Form(...), language: str = Form("")):
    lines = [ln for ln in (l.strip() for l in lyrics.splitlines()) if ln]
    if not lines:
        return JSONResponse(status_code=400, content={"error": "no lyrics provided"})

    # The backend sends no language (no per-song language is stored), so infer it from
    # the lyrics; an explicit form value still wins as an override.
    lang = (language or "").strip().lower() or detect_language(lines)

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.mp3")
        with open(src, "wb") as fh:
            fh.write(await audio.read())

        # 1) Load the align model FIRST — before the ~2-minute Demucs stage. The model
        # only needs `lang` (already known), so loading it up front means a broken
        # dependency (e.g. a wav2vec2/transformers import failure) fails in seconds
        # instead of after Demucs has already burned minutes of CPU.
        try:
            # An unsupported detected language would raise on load; fall back to English
            # so a bad guess never fails a song that would align fine in English.
            try:
                model, meta = _get_align_model(lang)
            except Exception:
                if lang == "en":
                    raise
                log.warning("no align model for %r; falling back to en", lang)
                lang = "en"
                model, meta = _get_align_model("en")
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"alignment failed: {e}"})

        # 2) Vocal isolation (Demucs) -> a cleaner signal for alignment.
        try:
            demucs_main(["--two-stems", "vocals", "-n", "htdemucs", "-o", tmp, src])
            vocal = os.path.join(tmp, "htdemucs", "in", "vocals.wav")
            target = vocal if os.path.exists(vocal) else src
        except Exception:
            target = src  # fall back to the full mix if separation fails

        # 3) Forced alignment of the KNOWN lyrics. A whole-track wav2vec2 forward needs
        # ~9-12 GB on a long song (memory grows with length) and OOM-kills the sidecar,
        # so we cut the vocal at silences into memory-sized segments and align each —
        # WhisperX forwards each segment's audio slice independently, bounding peak to
        # one segment. Cutting only at silence keeps every word inside its segment and
        # preserves wav2vec2's (bidirectional) context within each sung region. The
        # known lyrics are split across segments in proportion to their singing. See
        # segmentation.py.
        try:
            wav = whisperx.load_audio(target)
            duration = len(wav) / 16000.0
            plan = plan_segments(duration, find_silences(wav))
            assigned = assign_lines([s["voiced_s"] for s in plan], lines)
            segments = [
                {"text": " ".join(seg_lines), "start": s["start_s"], "end": s["end_s"]}
                for s, seg_lines in zip(plan, assigned)
                if seg_lines
            ]
            if len(plan) > 1:
                log.info("aligning %d lines over %d silence-cut segments (%.0fs track)",
                         len(lines), len(segments), duration)
            aligned = whisperx.align(segments, model, meta, wav, DEVICE, return_char_alignments=False)
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"alignment failed: {e}"})

    flat = [
        {"w": w.get("word", ""), "start": w.get("start"), "end": w.get("end"), "conf": w.get("score", 0.0)}
        for w in aligned.get("word_segments", [])
        if w.get("start") is not None and w.get("end") is not None
    ]
    grouped = group_words_into_lines(lines, flat)

    # 4) Second opinion. A forced aligner must place every word somewhere, so a word
    # preceded by a pause can latch onto quiet non-lead audio (a breath, an ad-lib, a
    # reverb tail) and start up to ~1.5s before it is actually sung — which the karaoke
    # shows as a word lighting up while the previous line is still ringing. The failure
    # only ever runs EARLY, and two independent aligners smear on different words, so
    # where they disagree the later start is the honest one. See consensus.py.
    #
    # Never fatal: a second opinion is a repair, and a song aligned without it is far
    # better than a 500. Best-effort by design.
    # English only: the second aligner's token set is a-z plus the apostrophe, which
    # SILENTLY MANGLES the Latin-with-diacritics languages language.py detects
    # (café -> caf, straße -> strae). Those strip to non-empty, so alignable() cannot
    # catch them — and a second opinion built from corrupted tokens could override a
    # perfectly good primary start. Widening this needs real romanization (uroman,
    # which we don't ship) and per-language evidence, not a wider regex.
    source_words = [w for ln in lines for w in ln.split()]
    if lang == "en" and alignable(source_words):
        try:
            # Same silence-cut segments as the primary pass, so MMS_FA's forward is
            # bounded too (it is wav2vec2 as well). Words stay in source order across
            # segments, so the returned starts remain positional over source_words.
            consensus_segments = [
                {"start_s": s["start_s"], "end_s": s["end_s"],
                 "words": [w for ln in seg_lines for w in ln.split()]}
                for s, seg_lines in zip(plan, assigned)
            ]
            grouped = apply_consensus(grouped, word_starts(wav, consensus_segments, DEVICE))
        except Exception:
            log.warning("consensus aligner failed; keeping primary alignment", exc_info=True)

    return {"engine": ENGINE, "language": lang, "lines": grouped}
