import importlib.util

import pytest

from segmentation import assign_lines, find_silences, plan_segments

_needs_numpy = pytest.mark.skipif(
    importlib.util.find_spec("numpy") is None, reason="numpy not installed"
)


def total_lines(assigned):
    return [ln for seg in assigned for ln in seg]


class TestPlanSegments:
    def test_short_track_is_a_single_segment(self):
        segs = plan_segments(120.0, [(30.0, 31.0)])
        assert segs == [{"start_s": 0.0, "end_s": 120.0, "voiced_s": 119.0}]

    def test_cuts_only_at_silence_midpoints(self):
        # 450s track, silences near 150 and 300 -> cut at their midpoints.
        segs = plan_segments(450.0, [(148.0, 150.0), (299.0, 301.0)])
        cuts = [round(s["start_s"], 1) for s in segs[1:]]
        assert cuts == [149.0, 300.0]
        assert segs[0]["start_s"] == 0.0 and segs[-1]["end_s"] == 450.0

    def test_every_segment_within_the_memory_budget(self):
        segs = plan_segments(900.0, [(t, t + 1.0) for t in range(100, 900, 130)])
        for s in segs:
            assert s["end_s"] - s["start_s"] <= 220.0 + 1e-6

    def test_segments_tile_without_gaps(self):
        segs = plan_segments(500.0, [(140.0, 142.0), (300.0, 302.0)])
        assert segs[0]["start_s"] == 0.0
        assert segs[-1]["end_s"] == 500.0
        for a, b in zip(segs, segs[1:]):
            assert a["end_s"] == b["start_s"]

    def test_forces_a_cut_when_no_silence_in_range(self):
        # No silences at all on a long track -> forced cuts still bound length.
        segs = plan_segments(600.0, [])
        assert len(segs) >= 3
        for s in segs:
            assert s["end_s"] - s["start_s"] <= 220.0 + 1e-6

    def test_voiced_excludes_silence(self):
        segs = plan_segments(120.0, [(10.0, 20.0)])  # 10s of silence in a single seg
        assert segs[0]["voiced_s"] == pytest.approx(110.0)


class TestAssignLines:
    def test_single_segment_takes_all_lines(self):
        assert assign_lines([120.0], ["a", "b", "c"]) == [["a", "b", "c"]]

    def test_every_line_assigned_once_in_order(self):
        lines = [f"line {i}" for i in range(20)]
        assigned = assign_lines([100.0, 100.0, 100.0], lines)
        assert total_lines(assigned) == lines

    def test_proportional_to_voiced_seconds(self):
        # Equal-weight lines; segment 0 has 3x the singing of segment 1.
        lines = [f"aaaa" for _ in range(8)]  # equal char weight
        assigned = assign_lines([150.0, 50.0], lines)
        assert len(assigned[0]) == 6 and len(assigned[1]) == 2

    def test_instrumental_segment_gets_no_lines(self):
        lines = [f"word{i}" for i in range(6)]
        assigned = assign_lines([100.0, 0.0, 100.0], lines)
        assert assigned[1] == []
        assert total_lines(assigned) == lines

    def test_leading_instrumental_intro_gets_no_lines(self):
        lines = ["first", "second", "third", "fourth"]
        assigned = assign_lines([0.0, 100.0], lines)
        assert assigned[0] == []
        assert assigned[1] == lines

    def test_all_silent_track_spreads_lines_instead_of_piling_up(self):
        # Pathological: find_silences read the whole vocal as silent (voiced 0
        # everywhere). Fall back to spreading by segment count, not dumping every
        # line into the last segment.
        lines = [f"aaaa" for _ in range(9)]  # equal weight
        assigned = assign_lines([0.0, 0.0, 0.0], lines)
        assert total_lines(assigned) == lines
        assert all(len(seg) > 0 for seg in assigned), assigned


@_needs_numpy
class TestFindSilences:
    def test_detects_a_central_gap(self):
        import numpy as np

        sr = 16000
        loud = np.random.RandomState(0).randn(sr * 2).astype(np.float32) * 0.3  # 2s loud
        quiet = np.zeros(sr * 2, dtype=np.float32)  # 2s silence
        wav = np.concatenate([loud, quiet, loud])
        gaps = find_silences(wav, sr=sr)
        assert len(gaps) == 1
        s, e = gaps[0]
        assert 1.8 < s < 2.2 and 3.8 < e < 4.2

    def test_no_gap_in_continuous_audio(self):
        import numpy as np

        sr = 16000
        wav = (np.random.RandomState(1).randn(sr * 3).astype(np.float32) * 0.3)
        assert find_silences(wav, sr=sr) == []

    def test_ignores_gaps_shorter_than_min(self):
        import numpy as np

        sr = 16000
        loud = np.random.RandomState(2).randn(sr).astype(np.float32) * 0.3
        short_quiet = np.zeros(int(sr * 0.3), dtype=np.float32)  # 0.3s < 0.6s min
        wav = np.concatenate([loud, short_quiet, loud])
        assert find_silences(wav, sr=sr) == []
