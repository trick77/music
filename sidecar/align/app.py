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

from grouping import group_words_into_lines
from language import detect_language

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

        # 1) Vocal isolation (Demucs) -> a cleaner signal for alignment.
        try:
            demucs_main(["--two-stems", "vocals", "-n", "htdemucs", "-o", tmp, src])
            vocal = os.path.join(tmp, "htdemucs", "in", "vocals.wav")
            target = vocal if os.path.exists(vocal) else src
        except Exception:
            target = src  # fall back to the full mix if separation fails

        # 2) Forced alignment of the KNOWN lyrics as one whole-track segment.
        try:
            wav = whisperx.load_audio(target)
            duration = len(wav) / 16000.0
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
            segments = [{"text": " ".join(lines), "start": 0.0, "end": duration}]
            aligned = whisperx.align(segments, model, meta, wav, DEVICE, return_char_alignments=False)
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"alignment failed: {e}"})

    flat = [
        {"w": w.get("word", ""), "start": w.get("start"), "end": w.get("end"), "conf": w.get("score", 0.0)}
        for w in aligned.get("word_segments", [])
        if w.get("start") is not None and w.get("end") is not None
    ]
    return {"engine": ENGINE, "language": lang, "lines": group_words_into_lines(lines, flat)}
