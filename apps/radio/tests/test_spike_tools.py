import sys
from pathlib import Path

import numpy as np
import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
try:
    import auto_label
    import ft8_sync
    import record_ham
    import voice_dial
finally:
    sys.path.remove(str(SCRIPTS))

RATE = 12_000.0
SPAN = 30_000.0 / 2**auto_label.REF_ZOOM
KB = SPAN / 1024


def reference(start_khz: float, signals, frames: int = 48, seed: int = 0) -> np.ndarray:
    """A reference position: noise near 40 with signals (lo_khz, hi_khz, dB, on_per_frame)."""
    rng = np.random.default_rng(seed)
    stack = rng.normal(40, 1.5, (frames, 1024))
    freqs = start_khz + (np.arange(1024) + 0.5) * KB
    for lo, hi, db, on in signals:
        inside = (freqs >= lo) & (freqs <= hi)
        for t in range(frames):
            if on(t):
                stack[t, inside] += db
    return np.clip(stack, 0, 255).astype(np.uint8)


def keyed(t: int) -> bool:
    return (t // 3) % 2 == 0


def speech(t: int) -> bool:
    return t % 8 < 5


def steady(_t: int) -> bool:
    return True


# Value: protects=the labeler calls keyed CW, not a steady carrier or WSPR-like tone, in a CW segment (spike: three carriers on real 80m passed the old flicker test); fails_when=a steady narrow line is labeled CW again; why_new=found by eye on live 80m frames; seam=synthetic frames; no_claim=real keying speeds
def test_the_labeler_calls_keyed_cw_and_not_carriers():
    stack = reference(14_000.0, [(14_010.0, 14_010.06, 20, keyed), (14_020.0, 14_020.06, 20, steady)])
    labels = auto_label.label_frames(stack, 14_000.0, SPAN, ("20m", "cw", 14_000.0, 14_050.0))
    assert [(x["kind"], round(x["freqKhz"])) for x in labels] == [("cw", 14_010)]


# Value: protects=the labeler calls intermittent 2.4 kHz energy voice and puts the USB dial 0.3 kHz under its low edge, and skips steady wide data modes and AM (spike: a VARA-like modem at 3870 kHz on real 80m); fails_when=a steady wide signal is labeled voice; why_new=found on live 80m clips; seam=synthetic frames; no_claim=that the 0.3 kHz edge rule is right (voice_dial checks that)
def test_the_labeler_calls_speech_voice_but_not_steady_wide_signals():
    stack = reference(
        14_200.0,
        [
            (14_210.3, 14_212.7, 18, speech),
            (14_220.3, 14_222.7, 18, steady),  # a data modem
            (14_230.0, 14_235.0, 15, speech),  # AM: sidebands ...
            (14_232.45, 14_232.55, 45, steady),  # ... and a carrier
        ],
    )
    labels = auto_label.label_frames(stack, 14_200.0, SPAN, ("20m", "phone", 14_150.0, 14_350.0))
    assert [(x["kind"], x["mode"]) for x in labels] == [("voice", "usb")]
    assert abs(labels[0]["freqKhz"] - 14_210.0) <= 2 * KB


# Value: protects=a busy FT8 window is labeled digital at its dial and its bins never become CW labels, even in a position that cuts the window off; fails_when=FT8 traffic is labeled CW; why_new=new labeler; seam=synthetic frames; no_claim=FT4's shorter cycle
def test_the_labeler_calls_ft8_windows_digital_and_not_cw():
    tones = [(14_074.5 + i * 0.4, 14_074.55 + i * 0.4, 18, steady) for i in range(5)]
    stack = reference(14_050.0, tones)
    labels = auto_label.label_frames(stack, 14_050.0, SPAN, ("20m", "cw", 14_000.0, 14_150.0))
    assert [(x["kind"], x["freqKhz"]) for x in labels] == [("digital", 14_074)]
    cut = reference(14_076.0 - SPAN, tones)  # the window's start only
    labels = auto_label.label_frames(cut, 14_076.0 - SPAN, SPAN, ("20m", "cw", 14_000.0, 14_150.0))
    assert labels == []


def voice_iq(offset_hz: float, mode: str, seconds: float = 8.0) -> np.ndarray:
    """Harmonic speech with moving pitch, its true dial offset_hz from the tuned one."""
    t = np.arange(int(RATE * seconds)) / RATE
    f0 = 130 + 35 * np.sin(2 * np.pi * 0.4 * t) + 15 * np.sin(2 * np.pi * 1.3 * t)
    phase = 2 * np.pi * np.cumsum(f0) / RATE
    syllables = (np.sin(2 * np.pi * 3 * t) > -0.2).astype(float)
    sign = 1 if mode == "usb" else -1
    x = np.zeros(t.size, dtype=complex)
    for k in range(1, 30):
        amp = np.where((k * f0 > 250) & (k * f0 < 2700), 1 / np.sqrt(k), 0)
        x += amp * syllables * np.exp(1j * (sign * k * phase + 2 * np.pi * offset_hz * t))
    rng = np.random.default_rng(3)
    return (x + 0.3 * (rng.standard_normal(t.size) + 1j * rng.standard_normal(t.size))).astype(np.complex64)


# Value: protects=the true dial is found from the speech's harmonics, independent of the edge rule the detector and labeler share, in both sidebands (user: grading the edge guess against a similar guess can't catch the 0.3 kHz assumption); fails_when=the LSB sign flips or an alias a pitch away wins; why_new=user review of the spike plan; seam=synthetic harmonic speech; no_claim=real voices' pitch ranges or heavy processing
@pytest.mark.parametrize("mode", ["usb", "lsb"])
@pytest.mark.parametrize("offset_hz", [-450, 0, 300])
def test_the_dial_estimator_finds_a_voices_true_dial(mode, offset_hz):
    est = voice_dial.estimate_offset(voice_iq(offset_hz, mode), RATE, mode)
    assert est["offsetKhz"] == pytest.approx(offset_hz / 1000, abs=0.01)


# Value: protects=noise gets no dial rather than a confident wrong one; fails_when=noise yields an offset; why_new=new estimator; seam=none; no_claim=weak voices near the noise
def test_the_dial_estimator_says_nothing_for_noise():
    rng = np.random.default_rng(1)
    noise = (rng.standard_normal(96_000) + 1j * rng.standard_normal(96_000)).astype(np.complex64)
    assert voice_dial.estimate_offset(noise, RATE, "usb")["offsetKhz"] is None


# Value: protects=clips go to disagreements first, then the extra voice clips that check the dial; fails_when=agreements crowd out the rows worth listening to; why_new=new recorder pass; seam=none; no_claim=which rows a listener finds most useful
def test_clips_go_to_disagreements_first_then_voices():
    rows = [{"kind": "cw", "freqKhz": 14_020.0, "band": "20m", "mode": "cw"}]
    labels = [
        {"kind": "voice", "freqKhz": 14_200.0, "band": "20m", "mode": "usb", "snrDb": 20},
        {"kind": "voice", "freqKhz": 14_230.0, "band": "20m", "mode": "usb", "snrDb": 20},
        {"kind": "voice", "freqKhz": 14_260.0, "band": "20m", "mode": "usb", "snrDb": 20},
    ]
    picked = record_ham.pick_clips(labels, rows, 2, voices=1)
    assert [c["source"] for c in picked] == ["detector-only", "labeler-only", "labeler-only"]
    assert len({c["freqKhz"] for c in picked}) == 3


def ft8_slot(signals, seconds: float = 16.0, seed: int = 0) -> np.ndarray:
    """Unit-power noise plus FT8 transmissions (audio_hz, snr_db in 2.5 kHz, start_s) with their Costas syncs."""
    rng = np.random.default_rng(seed)
    total = int(RATE * seconds)
    x = (rng.standard_normal(total) + 1j * rng.standard_normal(total)) / np.sqrt(2)
    n = int(RATE * ft8_sync.SYMBOL_S)
    for audio_hz, snr_db, start_s in signals:
        tones = list(rng.integers(0, 8, 79))
        for block in ft8_sync.SYNC_AT:
            tones[block : block + 7] = ft8_sync.COSTAS
        amp = np.sqrt(10 ** (snr_db / 10) * 2500 / RATE)
        phase, t0, t = 0.0, int(start_s * RATE), np.arange(n) / RATE
        for k, tone in enumerate(tones):
            f = audio_hz + tone * ft8_sync.TONE_HZ
            x[t0 + k * n : t0 + (k + 1) * n] += amp * np.exp(1j * (phase + 2 * np.pi * f * t))
            phase += 2 * np.pi * f * n / RATE
    return x.astype(np.complex64)


# Value: protects=FT8 is found by its Costas sync at its audio frequency, one result per transmission, down to -20 dB where no ear hears it (user: the detector and labeler judge a digital window busy the same way, so agreeing proves nothing); fails_when=a strong signal is counted several times or weak ones are missed; why_new=the decoder build was blocked, so this is the independent check; seam=synthetic slot; no_claim=decoding the messages (no LDPC/CRC)
def test_ft8_sync_finds_each_transmission_once():
    found = ft8_sync.find_signals(ft8_slot([(1000, -5, 1.0), (1600, -15, 1.2), (2200, -20, 0.9)]), RATE)
    assert sorted(round(s["audioHz"], -2) for s in found) == [1000, 1600, 2200]
    assert all(abs(s["snrDb"] - want) <= 3.5 for s, want in zip(sorted(found, key=lambda s: s["audioHz"]), (-5, -15, -20)))


# Value: protects=noise alone gives no FT8, so a quiet window isn't called busy; fails_when=MIN_SYNC drops to where noise reaches; why_new=new tool; seam=none; no_claim=other narrow digital modes in the window
def test_ft8_sync_finds_nothing_in_noise():
    assert ft8_sync.find_signals(ft8_slot([]), RATE) == []
