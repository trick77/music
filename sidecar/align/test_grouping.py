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


def test_handles_word_count_mismatch_without_crashing():
    # Fewer aligned words than expected: the last line simply gets what's left.
    lines = ["one two", "three four"]
    flat = [{"w": "one", "start": 0.0, "end": 0.5, "conf": 1.0}]
    out = group_words_into_lines(lines, flat)
    assert out[0]["words"][0]["w"] == "one"
    assert out[1]["words"] == []  # nothing left; empty, not an exception
