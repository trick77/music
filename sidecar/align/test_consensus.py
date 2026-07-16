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

        assert out[0]["words"][0]["start"] == 280.54
        # end must move out with the start, never leaving an inverted span
        assert out[0]["words"][0]["end"] >= 280.54
        # "corner" disagreed by only 0.73s (< threshold) -> untouched
        assert out[0]["words"][1]["start"] == 280.46

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

        assert out[0]["words"][0]["start"] == 280.54
        assert out[0]["words"][1]["start"] == 280.46

    def test_threshold_boundary_is_exclusive(self):
        given = [line("word", [("word", 100.0, 100.5)])]

        out = apply_consensus(given, [100.0 + CONSENSUS_THRESHOLD])

        assert out[0]["words"][0]["start"] == 100.0
