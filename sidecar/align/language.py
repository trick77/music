"""Infer the alignment language from the lyric text.

The Go backend stores no per-song language, so the /align endpoint detects it from
the lyrics. WhisperX only ships wav2vec2 align models for a fixed set of languages,
so a detected-but-unsupported (or low-confidence) guess must fall back to English.

Detection is deliberately biased toward English: every song aligned as English
before this existed, so overriding requires a *confident* guess on a long-enough
text. A shaky or short-lyric guess keeps the status quo rather than risk loading the
wrong wav2vec2 model for a song that was already aligning fine — a false override on
English is a regression, a missed override is merely the old behaviour.
"""

DEFAULT = "en"

# Languages WhisperX 3.8.6 ships a default wav2vec2 align model for. Used as a first
# allow-list so a detected-but-unsupported code falls back to English; the model load
# in app.py is the authoritative second guard (it falls back too if this list drifts).
SUPPORTED = {
    "en", "fr", "de", "es", "it", "ja", "zh", "nl", "uk", "pt", "ar", "cs",
    "ru", "pl", "hu", "fi", "fa", "el", "tr", "da", "he", "vi", "ko", "ur",
    "te", "hi", "ca", "ml", "sk", "sl", "hr", "ro", "eu", "gl", "ka", "lv",
}

_MIN_CHARS = 24         # short/repetitive lyrics detect badly — keep the default
_MIN_CONFIDENCE = 0.90  # only override English on a confident top guess


def detect_language(lines):
    """Best-effort WhisperX-supported language code for a list of lyric lines.

    Returns English unless detection is confident, on a long-enough text, and lands
    on a supported language. Never raises (a missing langdetect just yields the
    default), so it is safe to call unconditionally on the request path.
    """
    text = " ".join(lines).strip()
    if len(text) < _MIN_CHARS:
        return DEFAULT
    try:
        from langdetect import DetectorFactory, detect_langs

        DetectorFactory.seed = 0  # deterministic output for a given text
        guesses = detect_langs(text)
    except Exception:
        return DEFAULT
    if not guesses:
        return DEFAULT
    top = guesses[0]
    code = top.lang.split("-")[0].lower()  # "zh-cn" -> "zh"
    if code == DEFAULT:
        return DEFAULT
    if top.prob >= _MIN_CONFIDENCE and code in SUPPORTED:
        return code
    return DEFAULT
