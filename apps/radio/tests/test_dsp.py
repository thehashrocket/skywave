import struct

import numpy as np
import pytest

from skywave_radio.dsp import (
    AGC,
    SPECTRUM_FLOOR_MARGIN_DB,
    SPECTRUM_STEP_DB,
    Demodulator,
    Spectrum,
    complex_bandpass,
    encode_audio,
    encode_spectrum,
    int16_iq_to_complex,
)

from .frames import decode_spectrum

FS = 12000.0


def tone(freq_hz: float, seconds: float = 1.0, amp: float = 0.2) -> np.ndarray:
    t = np.arange(int(FS * seconds)) / FS
    return (amp * np.exp(2j * np.pi * freq_hz * t)).astype(np.complex64)


def dominant_hz(audio: np.ndarray) -> float:
    spec = np.abs(np.fft.rfft(audio * np.hanning(audio.size)))
    return float(np.fft.rfftfreq(audio.size, 1 / FS)[np.argmax(spec)])


def run(demod: Demodulator, iq: np.ndarray, block: int = 600) -> np.ndarray:
    return np.concatenate([demod.process(iq[i : i + block]) for i in range(0, iq.size, block)])


def power_at(x: np.ndarray, taps: np.ndarray) -> float:
    from scipy.signal import lfilter

    return float(np.mean(np.abs(lfilter(taps, 1.0, x)[500:]) ** 2))


def test_complex_bandpass_keeps_one_side():
    taps = complex_bandpass(FS, 300, 2700)
    assert power_at(tone(1500), taps) > 100 * power_at(tone(-1500), taps)


def test_am_recovers_modulating_tone():
    t = np.arange(int(FS * 2)) / FS
    iq = (0.3 * (1 + 0.5 * np.sin(2 * np.pi * 440 * t))).astype(np.complex64)
    audio = run(Demodulator(FS, "am"), iq)
    assert abs(dominant_hz(audio[int(FS):]) - 440) < 5


@pytest.mark.parametrize("mode,freq,expect_audible", [
    ("usb", 1000, True),
    ("usb", -1000, False),
    ("lsb", -1000, True),
    ("lsb", 1000, False),
])
def test_ssb_sideband_selection(mode, freq, expect_audible):
    # Same input level for both; the AGC would normalize either, so compare
    # pre-AGC energy through the demod's filter instead.
    demod = Demodulator(FS, mode)
    filtered = demod._filter.process(tone(freq))
    energy = float(np.mean(filtered.real[1000:] ** 2))
    assert (energy > 1e-3) is expect_audible


def test_usb_tone_comes_out_at_its_offset():
    audio = run(Demodulator(FS, "usb"), tone(1000, 2))
    assert abs(dominant_hz(audio[int(FS):]) - 1000) < 5


def test_agc_brings_weak_and_strong_signals_to_similar_levels():
    weak = run(Demodulator(FS, "usb"), tone(1000, 2, amp=0.001))
    strong = run(Demodulator(FS, "usb"), tone(1000, 2, amp=0.5))
    rms = lambda x: float(np.sqrt(np.mean(x[int(FS):] ** 2)))
    assert 0.5 < rms(weak) / rms(strong) < 2.0
    assert np.max(np.abs(strong)) <= 1.0


def test_agc_handles_empty_and_odd_blocks():
    agc = AGC(FS)
    assert agc.process(np.zeros(0)).size == 0
    assert agc.process(np.ones(7) * 0.1).size == 7


def test_spectrum_peak_lands_in_right_bin():
    frames = Spectrum(FS, nfft=1024, bins=512, rate_hz=10).process(tone(3000, 1))
    assert len(frames) >= 9
    db = frames[-1].db
    freqs = np.linspace(-FS / 2, FS / 2, db.size, endpoint=False)
    assert abs(freqs[np.argmax(db)] - 3000) < 30


def test_int16_conversion():
    out = int16_iq_to_complex(np.array([16384, -16384, 0, 32767], dtype=np.int16))
    assert out[0] == pytest.approx(0.5 - 0.5j)
    assert out.dtype == np.complex64


# Value: protects=full-scale audio stays full scale on the wire; fails_when=the encoder scales by 32768 and +1.0 wraps to -32768 (a click); why_new=no test covered frame encoding; seam=none; no_claim=playback in a browser
def test_encode_audio_full_scale_does_not_wrap():
    samples = np.frombuffer(encode_audio(np.array([1.0, -1.0, 0.0, 0.5, 1.5], dtype=np.float32)), dtype="<i2")
    assert samples.tolist() == [32767, -32767, 0, 16384, 32767]


# Value: protects=the waterfall's noise floor survives the uint8 row; fails_when=the base moves to the row max or the clamp is dropped; why_new=Codex reproduced a 47 dB floor shift with a max anchor; seam=none; no_claim=waterfall pixels
def test_encode_spectrum_keeps_the_noise_floor_and_clamps():
    rng = np.random.default_rng(0)
    db = np.full(512, -200.0)  # exact zeros outside the Kiwi's passband
    db[64:448] = rng.uniform(-140, -120, 384)  # noise floor
    db[256] = -20.0  # a strong station, 180 dB above the zeros
    payload = encode_spectrum(db.astype(np.float32))
    assert len(payload) == 4 + 512
    out = decode_spectrum(payload)
    floor = np.percentile(db, 20)  # -200: a quarter of the row is zeros
    assert np.percentile(out, 20) == pytest.approx(floor, abs=SPECTRUM_STEP_DB / 2)
    noise = np.r_[64:256, 257:448]
    assert np.abs(out[noise] - db[noise]).max() <= SPECTRUM_STEP_DB / 2 + 1e-4
    assert out[0] == pytest.approx(-200.0, abs=SPECTRUM_STEP_DB / 2)
    # The station clamps at the top of the window, still far past the 52 dB
    # above the floor where the waterfall is already full white.
    assert out[256] > floor + 100


# Value: protects=a spike far above the floor clamps to 255 without wrapping or dragging its neighbours; fails_when=the clip is dropped so the uint8 cast wraps; why_new=the floor test only clamps a station in a row of zeros; seam=none; no_claim=waterfall pixels
def test_encode_spectrum_clamps_far_above_the_floor():
    db = np.full(512, -130.0)
    db[0] = 0.0  # 130 dB above a floor the window only reaches 107.5 dB over
    payload = encode_spectrum(db)
    out = decode_spectrum(payload)
    assert payload[4] == 255
    assert out[1] == pytest.approx(-130.0, abs=SPECTRUM_STEP_DB / 2)


# Value: protects=bins far under the noise floor (deep nulls, filter skirts) clamp to the base instead of wrapping to the top of the row; fails_when=the lower clip bound is dropped so negative steps wrap through the uint8 cast and draw nulls as strong signals; why_new=the existing tests never put a bin below the base; seam=none; no_claim=waterfall pixels
def test_encode_spectrum_clamps_far_below_the_floor():
    db = np.full(512, -130.0)
    db[:40] = -300.0  # under 20% of the row, so the floor stays at -130
    out = decode_spectrum(encode_spectrum(db))
    base = -130.0 - SPECTRUM_FLOOR_MARGIN_DB
    assert out[:40] == pytest.approx(np.full(40, base), abs=SPECTRUM_STEP_DB / 2)
    assert out[40:] == pytest.approx(np.full(472, -130.0), abs=SPECTRUM_STEP_DB / 2)


# Value: protects=the 0x04 bytes the browser decodes with its own hardcoded 0.5 dB step; fails_when=SPECTRUM_STEP_DB or SPECTRUM_FLOOR_MARGIN_DB changes on the Python side only; why_new=the other tests decode with the module's own constants; seam=none; no_claim=the browser side (use-radio.test.ts pins it)
def test_encode_spectrum_wire_format_golden():
    db = np.full(512, -130.0, dtype=np.float32)
    db[0] = -110.0
    payload = encode_spectrum(db)
    assert payload[:4] == struct.pack("<f", -150.0)
    assert payload[4] == 80
    assert payload[5:] == bytes([40] * 511)
