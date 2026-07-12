from grouping import group_words_into_lines


def test_regroups_flat_words_by_line_word_counts():
    lines = ["hi there", "sing along now"]
    flat = [
        {"w": "hi", "start": 1.0, "end": 1.4, "conf": 0.9},
        {"w": "there", "start": 1.5, "end": 2.0, "conf": 0.8},
        {"w": "sing", "start": 3.0, "end": 3.3, "conf": 0.7},
        {"w": "along", "start": 3.4, "end": 3.8, "conf": 0.6},
        {"w": "now", "start": 3.9, "end": 4.2, "conf": 0.5},
    ]
    out = group_words_into_lines(lines, flat)
    assert len(out) == 2
    assert out[0]["text"] == "hi there"
    assert out[0]["start"] == 1.0 and out[0]["end"] == 2.0
    assert len(out[0]["words"]) == 2
    assert out[1]["text"] == "sing along now"
    assert out[1]["start"] == 3.0 and out[1]["end"] == 4.2
    assert len(out[1]["words"]) == 3


def test_fewer_aligned_words_does_not_crash_and_keeps_source_words():
    # Fewer aligned words than expected: unmatched trailing source words are kept
    # (source spelling) and clamped to the last known time, never dropped or NaN.
    lines = ["one two", "three four"]
    flat = [{"w": "one", "start": 0.0, "end": 0.5, "conf": 1.0}]
    out = group_words_into_lines(lines, flat)
    assert out[0]["words"][0]["w"] == "one"
    assert out[0]["words"][0]["start"] == 0.0
    # Every source word is still present with numeric timing (clamped to 0.5).
    assert [w["w"] for w in out[1]["words"]] == ["three", "four"]
    for w in out[0]["words"] + out[1]["words"]:
        assert w["start"] is not None and w["end"] is not None


def test_dropped_mid_word_does_not_shift_later_lines():
    # WhisperX/app.py dropped an untimed mid-lyric word ("cruel"). With naive
    # counting this shifted every later word early; alignment must re-anchor so the
    # LATER line keeps its true timestamps instead of an earlier word's.
    lines = ["it is a cruel world", "so we sing"]
    flat = [
        {"w": "it", "start": 1.0, "end": 1.2, "conf": 0.9},
        {"w": "is", "start": 1.3, "end": 1.5, "conf": 0.9},
        {"w": "a", "start": 1.6, "end": 1.7, "conf": 0.9},
        # "cruel" is missing (was untimed and dropped upstream).
        {"w": "world", "start": 2.0, "end": 2.4, "conf": 0.9},
        {"w": "so", "start": 5.0, "end": 5.2, "conf": 0.9},
        {"w": "we", "start": 5.3, "end": 5.5, "conf": 0.9},
        {"w": "sing", "start": 5.6, "end": 6.0, "conf": 0.9},
    ]
    out = group_words_into_lines(lines, flat)
    # The second line must NOT have drifted early to ~2.0s; it keeps its real 5.0s.
    assert out[1]["text"] == "so we sing"
    assert out[1]["start"] == 5.0 and out[1]["end"] == 6.0
    assert [w["w"] for w in out[1]["words"]] == ["so", "we", "sing"]
    assert [w["start"] for w in out[1]["words"]] == [5.0, 5.3, 5.6]
    # The dropped word is interpolated between its neighbours, in order.
    line0 = out[0]["words"]
    assert [w["w"] for w in line0] == ["it", "is", "a", "cruel", "world"]
    starts = [w["start"] for w in line0]
    assert starts == sorted(starts)  # monotonic, no jump
    assert 1.7 <= line0[3]["start"] <= 2.0  # "cruel" sits between "a" and "world"


def test_tokenization_mismatch_reanchors_next_line():
    # WhisperX split the contraction ("don't" -> "do"/"nt"); the following line's
    # start must stay put rather than drift by the extra token.
    lines = ["don't stop", "keep going"]
    flat = [
        {"w": "do", "start": 1.0, "end": 1.2, "conf": 0.9},
        {"w": "nt", "start": 1.2, "end": 1.3, "conf": 0.9},
        {"w": "stop", "start": 1.4, "end": 1.8, "conf": 0.9},
        {"w": "keep", "start": 4.0, "end": 4.3, "conf": 0.9},
        {"w": "going", "start": 4.4, "end": 4.9, "conf": 0.9},
    ]
    out = group_words_into_lines(lines, flat)
    assert out[1]["text"] == "keep going"
    assert out[1]["start"] == 4.0 and out[1]["end"] == 4.9
    assert [w["w"] for w in out[1]["words"]] == ["keep", "going"]
    # "stop" (matched after the split) keeps its own timing.
    assert out[0]["words"][-1]["w"] == "stop"
    assert out[0]["words"][-1]["start"] == 1.4


def test_all_source_words_present_and_monotonic():
    lines = ["alpha beta gamma", "delta epsilon"]
    flat = [
        {"w": "alpha", "start": 0.0, "end": 0.4, "conf": 0.9},
        {"w": "beta", "start": 0.5, "end": 0.9, "conf": 0.9},
        {"w": "gamma", "start": 1.0, "end": 1.4, "conf": 0.9},
        {"w": "delta", "start": 2.0, "end": 2.4, "conf": 0.9},
        {"w": "epsilon", "start": 2.5, "end": 2.9, "conf": 0.9},
    ]
    out = group_words_into_lines(lines, flat)
    flat_out = [w for ln in out for w in ln["words"]]
    assert [w["w"] for w in flat_out] == ["alpha", "beta", "gamma", "delta", "epsilon"]
    starts = [w["start"] for w in flat_out]
    assert starts == sorted(starts)
