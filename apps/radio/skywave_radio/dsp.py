"""Signal processing for the receiver.

Everything here works on complex baseband I/Q: a stream of complex samples
where 0 Hz is the frequency you tuned to, positive frequencies are above it
and negative frequencies below it. Every class keeps its own filter state so
blocks can be fed in one after another without clicks at the seams.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
from scipy import signal

Mode = Literal["am", "usb", "lsb", "cw"]
MODES: tuple[Mode, ...] = ("am", "usb", "lsb", "cw")

# Audio passbands relative to the tuned frequency, in Hz.
PASSBANDS: dict[Mode, tuple[float, float]] = {
    "am": (-4500.0, 4500.0),
    "usb": (300.0, 2700.0),
    "lsb": (-2700.0, -300.0),
    "cw": (450.0, 950.0),
}

# For CW we tune this far below the signal so it comes out as an audible tone.
CW_PITCH_HZ = 700.0


def complex_bandpass(fs: float, low: float, high: float, ntaps: int = 255) -> np.ndarray:
    """FIR taps that pass only frequencies between `low` and `high` (Hz).

    Design a real low-pass with half the bandwidth, then shift it to the
    passband center by multiplying by a complex exponential. The result is
    asymmetric in frequency, which is exactly what lets SSB keep one sideband
    and throw away the other.
    """
    if not low < high:
        raise ValueError("low must be below high")
    half_width = (high - low) / 2
    center = (high + low) / 2
    lowpass = signal.firwin(ntaps, half_width, fs=fs)
    n = np.arange(ntaps) - (ntaps - 1) / 2
    return (lowpass * np.exp(2j * np.pi * center * n / fs)).astype(np.complex64)


class StatefulFIR:
    """An FIR filter that remembers its tail between blocks."""

    def __init__(self, taps: np.ndarray):
        self.taps = taps
        self._zi = np.zeros(len(taps) - 1, dtype=np.result_type(taps, np.complex64))

    def process(self, x: np.ndarray) -> np.ndarray:
        y, self._zi = signal.lfilter(self.taps, 1.0, x, zi=self._zi)
        return y


class DCBlocker:
    """One-pole high-pass: y[n] = x[n] - x[n-1] + r*y[n-1].

    AM demodulation leaves a big DC offset (the carrier). This removes it.
    """

    def __init__(self, r: float = 0.999):
        self._b = np.array([1.0, -1.0])
        self._a = np.array([1.0, -r])
        self._zi = np.zeros(1)

    def process(self, x: np.ndarray) -> np.ndarray:
        y, self._zi = signal.lfilter(self._b, self._a, x, zi=self._zi)
        return y


class AGC:
    """Automatic gain control with fast attack, hang, and slow decay.

    Gain is computed once per short chunk (a few ms) from the chunk's peak and
    interpolated across samples, which keeps it cheap in Python and avoids
    zipper noise from abrupt gain steps.
    """

    def __init__(
        self,
        fs: float,
        target: float = 0.3,
        hang_s: float = 0.25,
        decay_s: float = 0.6,
        max_gain: float = 10_000.0,
        chunk_s: float = 0.004,
    ):
        self.target = target
        self.max_gain = max_gain
        self.chunk = max(1, int(round(fs * chunk_s)))
        self.hang_chunks = max(0, int(round(hang_s / chunk_s)))
        # Per-chunk multiplier so the level falls by ~63% over decay_s.
        self.decay = float(np.exp(-chunk_s / decay_s))
        self._level = 0.0
        self._hang = 0
        self._last_gain = 1.0

    def process(self, x: np.ndarray) -> np.ndarray:
        if x.size == 0:
            return x
        n_chunks = int(np.ceil(x.size / self.chunk))
        padded = np.zeros(n_chunks * self.chunk, dtype=np.float64)
        padded[: x.size] = np.abs(x)
        peaks = padded.reshape(n_chunks, self.chunk).max(axis=1)

        gains = np.empty(n_chunks)
        level, hang = self._level, self._hang
        for i, p in enumerate(peaks):
            if p >= level:
                level, hang = p, self.hang_chunks
            elif hang > 0:
                hang -= 1
            else:
                level = max(p, level * self.decay)
            gains[i] = min(self.target / max(level, 1e-9), self.max_gain)
        self._level, self._hang = level, hang

        # Interpolate from the previous block's final gain so seams are smooth.
        anchor_x = np.concatenate(([-1.0], (np.arange(n_chunks) + 0.5) * self.chunk))
        anchor_y = np.concatenate(([self._last_gain], gains))
        per_sample = np.interp(np.arange(x.size), anchor_x, anchor_y)
        self._last_gain = float(gains[-1])
        return np.clip(x * per_sample, -1.0, 1.0)


class Demodulator:
    """Turns complex baseband I/Q into real audio for one mode."""

    def __init__(self, fs: float, mode: Mode = "am"):
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}")
        self.fs = fs
        self.mode = mode
        low, high = PASSBANDS[mode]
        self._filter = StatefulFIR(complex_bandpass(fs, low, high))
        self._dc = DCBlocker()
        self._agc = AGC(fs)

    def process(self, iq: np.ndarray) -> np.ndarray:
        filtered = self._filter.process(iq)
        if self.mode == "am":
            # Envelope detection: the audio rides on the carrier's amplitude.
            audio = self._dc.process(np.abs(filtered))
        else:
            # SSB/CW: the filter already removed the unwanted sideband, so the
            # real part is the audio, shifted down to start near 0 Hz.
            audio = filtered.real
        return self._agc.process(audio).astype(np.float32)


@dataclass
class SpectrumFrame:
    db: np.ndarray  # float32, length = bins, ordered low to high frequency
    span_hz: float


class Spectrum:
    """Produces waterfall rows at a fixed rate from a continuous I/Q stream."""

    def __init__(self, fs: float, nfft: int = 1024, bins: int = 512, rate_hz: float = 10.0):
        if nfft % bins:
            raise ValueError("nfft must be a multiple of bins")
        self.fs = fs
        self.nfft = nfft
        self.bins = bins
        self.hop = max(nfft, int(fs / rate_hz))
        self._window = signal.windows.hann(nfft).astype(np.float32)
        self._window_gain = float(self._window.sum())
        self._buf = np.zeros(0, dtype=np.complex64)

    def process(self, iq: np.ndarray) -> list[SpectrumFrame]:
        self._buf = np.concatenate((self._buf, iq.astype(np.complex64)))
        frames: list[SpectrumFrame] = []
        while self._buf.size >= self.hop:
            seg = self._buf[self.hop - self.nfft : self.hop]
            self._buf = self._buf[self.hop :]
            spec = np.fft.fftshift(np.fft.fft(seg * self._window))
            power = np.abs(spec) ** 2
            power = power.reshape(self.bins, -1).mean(axis=1)
            db = 10 * np.log10(power / self._window_gain**2 + 1e-20)
            frames.append(SpectrumFrame(db=db.astype(np.float32), span_hz=self.fs))
        return frames


def int16_iq_to_complex(interleaved: np.ndarray) -> np.ndarray:
    """Interleaved int16 I,Q,I,Q... scaled to complex64 in [-1, 1)."""
    f = interleaved.astype(np.float32) / 32768.0
    return (f[0::2] + 1j * f[1::2]).astype(np.complex64)


# A spectrum row on the wire is a float32 base level then one uint8 per bin in
# steps of SPECTRUM_STEP_DB above it, so 255 steps cover 127.5 dB.
SPECTRUM_STEP_DB = 0.5
# The base sits this far under the row's 20th percentile, the noise floor the
# waterfall (apps/web/src/components/Waterfall.tsx) levels on. Clamping only
# what's below it leaves each row's floor exactly where it was, and the
# waterfall never shows more than 52 dB above it (floor - 3 + RANGE_DB 55).
# Its floor is a running average, so for a moment after a retune to a much
# noisier band it can sit under the base and show the clamp as a flat band.
SPECTRUM_FLOOR_MARGIN_DB = 20.0


def encode_audio(audio: np.ndarray) -> bytes:
    """Audio in [-1, 1] as int16 LE. 32767, not 32768: +1.0 must not wrap to -32768."""
    return np.round(np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def encode_spectrum(db: np.ndarray) -> bytes:
    """A dB row as float32 LE base level plus uint8 bins: dB = base + v * SPECTRUM_STEP_DB."""
    base = float(np.percentile(db, 20)) - SPECTRUM_FLOOR_MARGIN_DB
    steps = np.clip(np.round((db - base) / SPECTRUM_STEP_DB), 0, 255).astype(np.uint8)
    return np.array([base], dtype="<f4").tobytes() + steps.tobytes()
