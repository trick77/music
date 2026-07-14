"""Tests for lyric-language detection.

The confident-override cases need the optional `langdetect` package; they skip when
it is absent (e.g. a bare dev machine) but run in the container/CI where it is pinned.
The bias-toward-English guards need no dependency and always run.
"""
import importlib.util

import pytest

from language import DEFAULT, detect_language

_HAS_LANGDETECT = importlib.util.find_spec("langdetect") is not None
_needs_langdetect = pytest.mark.skipif(
    not _HAS_LANGDETECT, reason="langdetect not installed"
)

FRENCH = [
    "Je te promets le trône, la vie d'un roi",
    "Tout ce que tu voudras, je te le donnerai",
    "Nous marcherons ensemble vers la lumière du matin",
]
GERMAN = [
    "Ich weiss, dass du mich niemals wirklich verstehen wirst",
    "Doch wir tanzen weiter durch die dunkle Nacht allein",
    "Und die Sterne leuchten über unserer stillen Stadt",
]
ENGLISH = [
    "I have been waiting here for all this time",
    "Counting every second till you finally come home",
    "And the morning light will carry us away from here",
]


def test_short_text_keeps_default():
    assert detect_language(["oh oh oh"]) == DEFAULT


def test_empty_keeps_default():
    assert detect_language([]) == DEFAULT
    assert detect_language(["   "]) == DEFAULT


@_needs_langdetect
def test_detects_french():
    assert detect_language(FRENCH) == "fr"


@_needs_langdetect
def test_detects_german():
    assert detect_language(GERMAN) == "de"


@_needs_langdetect
def test_english_stays_english():
    assert detect_language(ENGLISH) == "en"
