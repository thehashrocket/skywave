import numpy as np
import pytest

from skywave_radio.dsp import AGC, Demodulator, Spectrum, complex_bandpass, int16_iq_to_complex

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
