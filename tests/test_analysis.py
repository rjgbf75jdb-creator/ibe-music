"""Musical acceptance criteria using deterministic audio and numpy only."""
from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis import analyze

SR = 22050
PROGRESSION = ((0, "M", (60, 64, 67), 36),
               (7, "M", (59, 62, 67), 43),
               (9, "m", (60, 64, 69), 45),
               (5, "M", (60, 65, 69), 41))


def stereo(signal):
    return np.stack((signal, signal)).astype(np.float32)


def tone(midi, time):
    """A modest harmonic spectrum, with the fundamental dominant."""
    frequency = 440 * 2 ** ((midi - 69) / 12)
    return sum(weight * np.sin(2 * np.pi * frequency * harmonic * time)
               for harmonic, weight in ((1, 1), (2, .30), (3, .12), (4, .05)))


def progression_audio():
    time = np.arange(2 * SR) / SR
    # Short attack/release avoids discontinuities while leaving sustained triads.
    envelope = np.minimum(1, time / .02) * np.minimum(1, (2 - time) / .05)
    other, bass, expected = [], [], []
    for index, (root, quality, notes, bass_note) in enumerate(PROGRESSION * 2):
        other.append(.16 * envelope * sum(tone(note, time) for note in notes))
        bass.append(.24 * envelope * tone(bass_note, time))
        expected.append((index * 2., (index + 1) * 2., root, quality))
    return {"other": stereo(np.concatenate(other)),
            "bass": stereo(np.concatenate(bass))}, expected


def chord_accuracy(chords, expected, duration):
    """Integrate exact overlap across the ENTIRE duration, including transitions."""
    correct = 0.
    for index, chord in enumerate(chords):
        start = max(0., chord["t"])
        end = min(duration, chords[index + 1]["t"] if index + 1 < len(chords) else duration)
        for left, right, root, quality in expected:
            if (chord["pc"], chord["q"]) == (root, quality):
                correct += max(0., min(end, right) - max(start, left))
    return correct / duration


@pytest.fixture(scope="module")
def rhythm_result():
    signal = np.zeros(20 * SR, dtype=np.float32)
    time = np.arange(int(.035 * SR)) / SR
    click = .8 * np.exp(-time / .007) * np.sin(2 * np.pi * 1800 * time)
    for start in np.arange(0., 20., .5):
        offset = round(start * SR)
        signal[offset:offset + len(click)] += click[:len(signal) - offset]
    return analyze({"drums": stereo(signal)}, SR)


def test_120_bpm_clicks(rhythm_result):
    measured = rhythm_result["bpm"]
    assert abs(measured - 120) <= 2, f"Expected 120 +/-2 BPM; observed {measured} BPM"


def test_half_second_beat_intervals(rhythm_result):
    beats = np.asarray(rhythm_result["beats"])
    assert len(beats) >= 2, f"Expected detected beats; observed {beats.tolist()}"
    intervals = np.diff(beats)
    assert np.all(np.abs(intervals - .5) <= .02), (
        f"Expected every interval .50 +/-.02 s; observed {intervals.tolist()}"
    )


@pytest.fixture(scope="module")
def harmony_result():
    stems, expected = progression_audio()
    return analyze(stems, SR), expected


def test_progression_key_is_c_major(harmony_result):
    result, _ = harmony_result
    key = result["key"]
    assert key and (key["pc"], key["mode"]) == (0, "major"), (
        f"Expected C major (pc=0, mode=major); observed {key}"
    )


def test_progression_chords_cover_75_percent(harmony_result):
    result, expected = harmony_result
    accuracy = chord_accuracy(result["chords"], expected, 16.)
    assert accuracy >= .75, (
        f"Expected duration-weighted chord accuracy >=75%; observed {accuracy:.4%}; "
        f"chords={result['chords']}"
    )


def test_silence_is_unpitched_and_has_no_rhythm():
    result = analyze({"drums": np.zeros((2, 20 * SR), dtype=np.float32)}, SR)
    assert result["bpm"] == 0
    assert result["beats"] == []
    assert result["chords"] == []
    assert result["key"] is None
