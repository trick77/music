from consensus import CONSENSUS_THRESHOLD, alignable, apply_consensus, normalize


def line(text, words):
    """A grouped line in the shape group_words_into_lines emits."""
    return {
        "text": text,
        "start": words[0][1],
        "end": words[-1][2],
        "words": [{"w": w, "start": s, "end": e, "conf": 0.8} for w, s, e in words],
    }


class TestNormalize:
    def test_folds_to_the_mms_token_alphabet(self):
        assert normalize("Every") == "every"
        assert normalize("don't") == "don't"
        assert normalize("well-known") == "wellknown"
        assert normalize("Rain,") == "rain"

    def test_unalignable_words_strip_to_empty(self):
        assert normalize("3") == ""
        assert normalize("&") == ""
        assert normalize("привет") == ""


class TestAlignable:
    def test_plain_english_lyric_is_alignable(self):
        assert alignable("every corner holds a ghost of you".split())

    def test_declines_non_latin_script(self):
        # MMS_FA needs uroman romanization for these; we do not ship it, so a second
        # opinion here would be noise, not a check.
        assert not alignable(["привет", "мир", "как"])

    def test_declines_empty(self):
        assert not alignable([])

    def test_tolerates_a_few_unalignable_tokens(self):
        assert alignable(["we", "were", "3", "friends", "back", "then", "and", "now", "we're", "two"])


class TestApplyConsensus:
    def test_takes_the_later_start_when_primary_smeared_backwards(self):
        # The real case: WhisperX put "Every" at 278.98 (spanning the quiet event
        # before the word); the true onset, per an independent aligner, is 280.54.
        given = [line("Every corner", [("Every", 278.98, 280.44), ("corner", 280.46, 281.72)])]

        out = apply_consensus(given, [280.54, 281.19])

        # capped at "corner" (280.46) to stay monotonic — still recovers 1.48s of the
        # 1.56s error, and the cap is itself within threshold of the true onset
        assert out[0]["words"][0]["start"] == 280.46
        # end must move out with the start, never leaving an inverted span
        assert out[0]["words"][0]["end"] >= 280.46
        # "corner" disagreed by only 0.73s (< threshold) -> untouched
        assert out[0]["words"][1]["start"] == 280.46

    def test_a_corrected_start_never_passes_the_next_word(self):
        # Only the worst word of a smeared run usually clears the threshold. Moving it
        # to the alt onset unchecked would put it AFTER its neighbour, and the frontend
        # sweeps by start time — it would light the words out of order.
        given = [line("Every corner", [("Every", 278.98, 280.44), ("corner", 280.46, 281.72)])]

        out = apply_consensus(given, [281.90, None])

        assert out[0]["words"][0]["start"] <= out[0]["words"][1]["start"]

    def test_two_adjacent_words_both_correcting_stay_ordered(self):
        # The cap exists for smeared RUNS, not lone words: when neighbours both clear
        # the threshold they must not swap. Each is capped against the ORIGINAL next
        # start, and words only ever move forward, so the pair stays ordered.
        given = [line("a b c", [("a", 100.0, 100.2), ("b", 100.4, 100.6), ("c", 103.0, 103.2)])]

        out = apply_consensus(given, [102.5, 102.8, None])

        got = [w["start"] for w in out[0]["words"]]
        assert got == sorted(got), f"non-monotonic word starts: {got}"

    def test_cap_uses_the_next_word_even_across_a_line_boundary(self):
        # The flattened word list spans lines, so a line's LAST word is capped by the
        # first word of the NEXT line — otherwise a correction could jump the boundary
        # and light the next line's opening word before its own.
        given = [
            line("first line", [("first", 10.0, 10.2), ("line", 10.4, 10.6)]),
            line("second line", [("second", 11.0, 11.2), ("line", 11.4, 11.6)]),
        ]

        out = apply_consensus(given, [None, 12.5, None, None])

        assert out[0]["words"][1]["start"] == 11.0  # capped at the next line's first word
        flat = [w["start"] for l in out for w in l["words"]]
        assert flat == sorted(flat), f"non-monotonic across lines: {flat}"

    def test_cap_skips_over_untimed_words_to_the_next_timed_one(self):
        given = [
            line("a b", [("a", 50.0, 50.2), ("b", 50.4, 50.6)]),
        ]
        given[0]["words"][1]["start"] = None  # untimed neighbour
        given[0]["words"][1]["end"] = None
        given.append(line("c", [("c", 55.0, 55.2)]))

        out = apply_consensus(given, [60.0, None, None])

        # capped at "c" (the next TIMED start), not at the untimed None
        assert out[0]["words"][0]["start"] == 55.0

    def test_starts_stay_monotonic_across_the_whole_line(self):
        given = [line("a b c", [("a", 10.0, 10.2), ("b", 12.0, 12.2), ("c", 12.4, 12.6)])]

        out = apply_consensus(given, [13.5, None, None])

        got = [w["start"] for w in out[0]["words"]]
        assert got == sorted(got), f"non-monotonic word starts: {got}"

    def test_untimed_words_are_left_untimed(self):
        # grouping.py leaves a line untimed (None) when nothing matched; the frontend
        # relies on that to never activate the line. There is no primary opinion to
        # disagree with, so consensus must not invent one.
        given = [
            {
                "text": "unknown line",
                "start": None,
                "end": None,
                "words": [
                    {"w": "unknown", "start": None, "end": None, "conf": 0.0},
                    {"w": "line", "start": None, "end": None, "conf": 0.0},
                ],
            }
        ]

        out = apply_consensus(given, [123.4, 124.5])

        assert out[0]["words"][0]["start"] is None
        assert out[0]["words"][1]["start"] is None
        assert out[0]["start"] is None

    def test_keeps_primary_when_the_second_aligner_is_the_earlier_one(self):
        # MMS dragged this line 29s back into an instrumental gap; WhisperX was right.
        # Only a LATER second opinion may win.
        given = [line("I keep searching", [("I", 244.21, 244.33), ("keep", 244.35, 244.60)])]

        out = apply_consensus(given, [215.25, 215.40])

        assert out[0]["words"][0]["start"] == 244.21
        assert out[0]["words"][1]["start"] == 244.35

    def test_agreement_within_threshold_changes_nothing(self):
        given = [line("Rain comes", [("Rain", 35.90, 36.20), ("comes", 36.30, 36.60)])]

        out = apply_consensus(given, [35.94, 36.28])

        assert out[0]["words"][0]["start"] == 35.90
        assert out[0]["words"][1]["start"] == 36.30

    def test_is_a_noop_on_an_already_correct_song(self):
        # Kings of Nothing: 0 of 56 lines disagreed beyond the threshold. A correct
        # alignment must survive the repair completely untouched.
        given = [line("The last ones", [("The", 271.44, 271.54), ("last", 271.58, 271.92)])]
        before = [dict(w) for w in given[0]["words"]]

        out = apply_consensus(given, [271.40, 271.50])

        assert out[0]["words"] == before

    def test_recomputes_line_bounds_from_its_words(self):
        given = [line("Every corner", [("Every", 278.98, 280.44), ("corner", 280.46, 281.72)])]

        out = apply_consensus(given, [280.54, None])

        assert out[0]["start"] == 280.46  # the earliest surviving word start
        assert out[0]["end"] == 281.72

    def test_none_entries_leave_words_untouched(self):
        given = [line("3 friends", [("3", 10.0, 10.4), ("friends", 10.5, 11.0)])]

        out = apply_consensus(given, [None, 10.52])

        assert out[0]["words"][0]["start"] == 10.0

    def test_tolerates_a_short_alt_list(self):
        given = [line("Every corner", [("Every", 278.98, 280.44), ("corner", 280.46, 281.72)])]

        out = apply_consensus(given, [280.54])

        assert out[0]["words"][0]["start"] == 280.46  # capped at "corner" to stay monotonic
        assert out[0]["words"][1]["start"] == 280.46  # no alt for it -> untouched

    def test_threshold_boundary_is_exclusive(self):
        given = [line("word", [("word", 100.0, 100.5)])]

        out = apply_consensus(given, [100.0 + CONSENSUS_THRESHOLD])

        assert out[0]["words"][0]["start"] == 100.0
