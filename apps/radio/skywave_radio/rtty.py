"""RTTY decoding: 45.45 baud, 170 Hz shift, ITA2 (Baudot), from complex baseband I/Q.

Works on the same I/Q the Demodulator gets, so it needs no extra Kiwi channel.
Every frequency here is a baseband offset in Hz (0 Hz = the frequency the Kiwi
is tuned to; positive is above it, which in USB is the audio pitch you hear).

The chain, per block:

    I/Q ──mix tone pair centre to 0 Hz──▶ low-pass ──decimate to ~1.5 kHz──▶
        ┌─ mix mark to 0 ── one-bit boxcar ── |·| ─┐
        └─ mix space to 0 ─ one-bit boxcar ── |·| ─┴─ mark − space ──▶ slicer ──▶ ITA2

The boxcars are the matched filter for a bit. The slicer is a UART: it waits
for a mark-to-space edge (a start bit), samples each bit where its boxcar has
just integrated a whole bit, and keeps the character only if the stop bit is
mark. That edge is the clock recovery: every character re-times itself.

The tone pair is found from the spectrum (the strongest pair 170 Hz apart in
the search range) unless the browser set one. Text only comes out while that
pair stands clear of the noise, so noise doesn't print as random letters.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import signal

BAUD = 45.45
SHIFT_HZ = 170.0
DATA_BITS = 5
STOP_BITS = 1.5
# The decimated rate the tone filters run at; the real one is fs / round(fs / this).
WORK_RATE_HZ = 1500.0

# Tone-pair search: power spectrum resolution and how often a pair is chosen.
SEARCH_NFFT = 4096
SEARCH_EVERY_S = 1.0
# Each new spectrum counts this much against the running average (about 4 s of memory).
SEARCH_AVERAGE = 0.25
# How far a tone's power is summed either side of its bin, in Hz (a keyed
# tone spreads about ±baud).
TONE_HALF_WIDTH_HZ = 25.0
# Squelch on the weaker tone's power over the search band's median, per bin.
# Opens at OPEN, closes under CLOSE, so text doesn't flicker on and off.
SQUELCH_OPEN_DB = 10.0
SQUELCH_CLOSE_DB = 6.0
# A locked pair is only given up for one this much stronger, or once squelched.
RELOCK_MARGIN_DB = 3.0
# A character prints only if its tones carry at least this share of the
# signal's recent level (LEVEL_PERCENTILE of the tone energy over LEVEL_S).
# That drops what the slicer makes of the noise just before a transmission
# (replayed below) and after it ends, while the slower squelch is still open.
LEVEL_S = 10.0
LEVEL_PERCENTILE = 90
LEVEL_SHARE = 0.4
# And at every one of its seven bit samples, one tone must clearly win:
# |mark − space| / (mark + space) at least this. Real FSK sends one tone at a
# time, so it scores near 1. A pair the search took from other signals (MFSK
# hopping across both, two unrelated carriers 170 Hz apart, PSK) doesn't: either
# energy is on neither tone or on both at once.
DECISIVE = 0.5
# I/Q kept so a newly found pair, or a squelch that has just opened, is decoded
# from here back, not just from the moment the search noticed (the search runs
# every SEARCH_EVERY_S on a spectrum averaged over about 4 s, so it can take a
# few seconds of keying to open).
REPLAY_S = 4.0

# ITA2 as US teleprinters (and fldigi) use it. None marks LTRS/FIGS shifts and
# codes that print nothing.
_LTRS = "\0E\nA SIU\rDRJNFCKTZLWHYPQOBG\0MXV\0"
_FIGS = "\x003\n- \a87\r$4',!:(5\")2#6019?&\0./;\0"
CODE_LTRS = 0x1F
CODE_FIGS = 0x1B
CODE_SPACE = 0x04
assert len(_LTRS) == len(_FIGS) == 32


class Ita2:
    """Turns 5-bit codes into text, tracking the letters/figures shift."""

    def __init__(self, unshift_on_space: bool = True):
        self.unshift_on_space = unshift_on_space
        self.figs = False

    def feed(self, code: int) -> str:
        if code == CODE_LTRS:
            self.figs = False
            return ""
        if code == CODE_FIGS:
            self.figs = True
            return ""
        ch = (_FIGS if self.figs else _LTRS)[code]
        if code == CODE_SPACE and self.unshift_on_space:
            self.figs = False
        # Bell, NUL and carriage return print nothing; line feed is the newline.
        return "" if ch in "\0\a\r" else ch


def ita2_encode(text: str) -> list[int]:
    """Codes for `text`, with the shifts it needs; characters ITA2 lacks are dropped.

    Shifts are sent whenever the case changes, and again after a space, which
    a receiver that unshifts on space would otherwise read as letters.
    """
    codes: list[int] = []
    figs: bool | None = None
    for ch in text.upper():
        if ch == " ":
            codes.append(CODE_SPACE)
            if figs:
                figs = False
            continue
        if ch in _LTRS and ch not in "\0\r\a":
            want = False
            code = _LTRS.index(ch)
        elif ch in _FIGS and ch not in "\0\r\a":
            want = True
            code = _FIGS.index(ch)
        else:
            continue
        if ch == "\n":
            codes.append(code)
            continue
        if figs is not want:
            codes.append(CODE_FIGS if want else CODE_LTRS)
            figs = want
        codes.append(code)
    return codes


def modulate(
    text: str,
    fs: float,
    mark_hz: float,
    *,
    reverse: bool = False,
    lead_s: float = 0.5,
    amp: float = 0.1,
) -> np.ndarray:
    """Phase-continuous FSK I/Q for `text`, mark at `mark_hz`, space SHIFT_HZ below
    (above when `reverse`). Starts and ends with `lead_s` of idle mark and a
    few LTRS, as real stations do, so a receiver can find the tones first."""
    space_hz = mark_hz + (SHIFT_HZ if reverse else -SHIFT_HZ)
    codes = [CODE_LTRS] * 4 + ita2_encode(text) + [CODE_LTRS] * 2
    bits: list[tuple[int, float]] = [(1, lead_s * BAUD)]
    for code in codes:
        bits.append((0, 1.0))
        bits.extend(((code >> i) & 1, 1.0) for i in range(DATA_BITS))
        bits.append((1, STOP_BITS))
    bits.append((1, lead_s * BAUD))
    freqs: list[np.ndarray] = []
    t_bits = 0.0
    n_done = 0
    for value, length in bits:
        t_bits += length
        n_end = int(round(t_bits / BAUD * fs))
        freqs.append(np.full(n_end - n_done, mark_hz if value else space_hz))
        n_done = n_end
    f = np.concatenate(freqs)
    phase = 2 * np.pi * np.cumsum(f) / fs
    return (amp * np.exp(1j * phase)).astype(np.complex64)


class RttyDecoder:
    """Streams I/Q in, decoded text out. Feed blocks of any size, in order.

    `mark_hz` fixes the mark tone (baseband Hz); None finds the pair itself
    within `search` (low, high), the listener's passband. Normal polarity is
    mark on the higher frequency of the two; `reverse` swaps them.
    """

    def __init__(
        self,
        fs: float,
        *,
        mark_hz: float | None = None,
        reverse: bool = False,
        search: tuple[float, float] = (300.0, 2700.0),
    ):
        if not fs > 0:
            raise ValueError("fs must be positive")
        self.fs = fs
        self.reverse = reverse
        self.fixed = mark_hz is not None
        self.search = search
        self._decim = max(1, int(round(fs / WORK_RATE_HZ)))
        self.work_fs = fs / self._decim
        self._spb = self.work_fs / BAUD

        # Mixer to the pair's centre, then a low-pass wide enough for both
        # tones plus their keying sidebands, and decimation.
        self._lowpass = signal.firwin(129, SHIFT_HZ / 2 + 3 * BAUD, fs=fs).astype(np.float32)
        self._lp_zi = np.zeros(len(self._lowpass) - 1, dtype=np.complex128)
        self._mix_phase = 0.0
        self._decim_offset = 0  # index in the next block of its first kept sample
        # Tone mixers at the work rate, and their one-bit boxcars.
        self._boxcar_len = max(1, int(round(self._spb)))
        self._box = np.ones(self._boxcar_len) / self._boxcar_len
        self._tone_phase = 0.0
        self._mark_zi = np.zeros(self._boxcar_len - 1, dtype=np.complex128)
        self._space_zi = np.zeros(self._boxcar_len - 1, dtype=np.complex128)

        # mark − space at the work rate, not yet sliced; _pos indexes into it.
        self._d = np.zeros(0, dtype=np.float64)
        self._e = np.zeros(0, dtype=np.float64)
        self._level_buf = np.zeros(0, dtype=np.float64)
        self._pos = 1
        self._ita2 = Ita2()
        self._recent: list[np.ndarray] = []
        self._recent_n = 0
        # Input samples seen so far, and the work-rate position of _d[0] on the
        # same clock, so a replayed character can be told from one already shown.
        self._n_in = 0
        self._d_abs0 = 0.0
        # Work-rate position of the start edge of the last character shown.
        self._shown_to = -math.inf

        # Tone-pair search state.
        self._spec_buf = np.zeros(0, dtype=np.complex64)
        self._spec_avg: np.ndarray | None = None
        self._spec_window = signal.windows.hann(SEARCH_NFFT).astype(np.float32)
        self._since_search = 0
        self.snr_db: float | None = None
        self.squelch_open = False

        self.mark_hz: float | None = None
        self._relocked = False
        if mark_hz is not None:
            self._set_mark(float(mark_hz))

    @property
    def space_hz(self) -> float | None:
        if self.mark_hz is None:
            return None
        return self.mark_hz + (SHIFT_HZ if self.reverse else -SHIFT_HZ)

    def _set_mark(self, mark_hz: float) -> None:
        self.mark_hz = mark_hz
        self._restart()

    def _restart(self) -> None:
        """Start decoding afresh from the last REPLAY_S of I/Q, on the next block.

        On a new pair, what's in flight belongs to the old one. When the
        squelch opens again on the same pair (the next over on a net), what
        the slicer made meanwhile was thrown away, so it is decoded again;
        and the letters/figures shift starts clean, not wherever junk read
        while the squelch was shut left it.
        """
        self._d = np.zeros(0, dtype=np.float64)
        self._e = np.zeros(0, dtype=np.float64)
        self._level_buf = np.zeros(0, dtype=np.float64)
        self._pos = 1
        self._ita2 = Ita2()
        self._lp_zi[:] = 0
        self._mark_zi[:] = 0
        self._space_zi[:] = 0
        self._decim_offset = 0
        self._relocked = True

    def process(self, iq: np.ndarray) -> str:
        if iq.size == 0:
            return ""
        self._recent.append(iq)
        self._recent_n += iq.size
        self._n_in += iq.size
        while self._recent_n - self._recent[0].size >= REPLAY_S * self.fs:
            self._recent_n -= self._recent.pop(0).size
        was_open = self.squelch_open
        self._relocked = False
        self._search(iq)
        if self.mark_hz is None:
            return ""
        if self.squelch_open and not was_open and not self._relocked:
            self._restart()
        # Just locked, or the squelch just opened: decode the last REPLAY_S,
        # which ends with this block.
        if self._relocked:
            feed = np.concatenate(self._recent)
            self._d_abs0 = (self._n_in - feed.size) / self._decim
        else:
            feed = iq
        d, e = self._discriminate(feed)
        chars = self._slice(d, e)
        if not self.squelch_open:
            return ""
        # A replay goes back over up to REPLAY_S, which may hold characters
        # already shown before a fade closed the squelch: show only newer ones.
        # (Half a bit of slack: the same character's edge lands within a sample
        # or two when decoded again.)
        new = [(at, ch) for at, ch in chars if at > self._shown_to + self._spb / 2]
        if new:
            self._shown_to = new[-1][0]
        return "".join(ch for _, ch in new)

    # --- tone pair ---------------------------------------------------------

    def _search(self, iq: np.ndarray) -> None:
        self._spec_buf = np.concatenate((self._spec_buf, iq.astype(np.complex64)))
        while self._spec_buf.size >= SEARCH_NFFT:
            seg = self._spec_buf[:SEARCH_NFFT]
            self._spec_buf = self._spec_buf[SEARCH_NFFT:]
            power = np.abs(np.fft.fftshift(np.fft.fft(seg * self._spec_window))) ** 2
            if self._spec_avg is None:
                self._spec_avg = power
            else:
                self._spec_avg += SEARCH_AVERAGE * (power - self._spec_avg)
            self._since_search += SEARCH_NFFT
        if self._spec_avg is not None and self._since_search >= SEARCH_EVERY_S * self.fs:
            self._since_search = 0
            self._choose_pair(self._spec_avg)

    def _choose_pair(self, power: np.ndarray) -> None:
        bin_hz = self.fs / SEARCH_NFFT
        freqs = (np.arange(SEARCH_NFFT) - SEARCH_NFFT // 2) * bin_hz
        low, high = self.search
        band = (freqs >= low) & (freqs <= high)
        if band.sum() < 8:
            return
        noise = float(np.median(power[band])) + 1e-30
        half = max(1, int(round(TONE_HALF_WIDTH_HZ / bin_hz)))
        # Each bin's power summed over ±half bins, as the energy of a tone
        # centred there, against what noise alone would sum to.
        tone = np.convolve(power, np.ones(2 * half + 1), mode="same") / ((2 * half + 1) * noise)

        def pair_db(mark: float) -> float:
            space = mark + (SHIFT_HZ if self.reverse else -SHIFT_HZ)
            i, j = (int(round(f / bin_hz)) + SEARCH_NFFT // 2 for f in (mark, space))
            if not (0 <= i < SEARCH_NFFT and 0 <= j < SEARCH_NFFT):
                return -math.inf
            return 10 * math.log10(max(min(tone[i], tone[j]), 1e-30))

        if not self.fixed:
            shift_bins = SHIFT_HZ / bin_hz
            # Mark and space both inside the search band.
            idx = np.nonzero(band)[0]
            lo_f, hi_f = freqs[idx[0]], freqs[idx[-1]]
            sign = -1 if self.reverse else 1
            cand = idx[(freqs[idx] + sign * -SHIFT_HZ >= lo_f) & (freqs[idx] + sign * -SHIFT_HZ <= hi_f)]
            if cand.size:
                other = np.clip(np.round(cand - sign * shift_bins).astype(int), 0, SEARCH_NFFT - 1)
                score = np.minimum(tone[cand], tone[other])
                best = int(cand[int(np.argmax(score))])
                best_mark = float(freqs[best])
                best_db = pair_db(best_mark)
                current_db = pair_db(self.mark_hz) if self.mark_hz is not None else -math.inf
                moved = self.mark_hz is None or abs(best_mark - self.mark_hz) > 2 * bin_hz
                if (
                    moved
                    and best_db >= SQUELCH_OPEN_DB
                    and (current_db < SQUELCH_CLOSE_DB or best_db >= current_db + RELOCK_MARGIN_DB)
                ):
                    self._set_mark(best_mark)
        if self.mark_hz is None:
            self.snr_db = None
            self.squelch_open = False
            return
        self.snr_db = pair_db(self.mark_hz)
        if self.squelch_open:
            self.squelch_open = self.snr_db >= SQUELCH_CLOSE_DB
        else:
            self.squelch_open = self.snr_db >= SQUELCH_OPEN_DB

    # --- demodulation ------------------------------------------------------

    def _discriminate(self, iq: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """mark − space, and mark + space (the tones' energy), at the work rate."""
        assert self.mark_hz is not None and self.space_hz is not None
        centre = (self.mark_hz + self.space_hz) / 2
        n = np.arange(iq.size)
        step = -2 * np.pi * centre / self.fs
        mixed = iq * np.exp(1j * (self._mix_phase + step * n))
        self._mix_phase = float((self._mix_phase + step * iq.size) % (2 * np.pi))
        filtered, self._lp_zi = signal.lfilter(self._lowpass, 1.0, mixed, zi=self._lp_zi)
        kept = filtered[self._decim_offset :: self._decim]
        # Where the next block's first kept sample falls.
        self._decim_offset = (self._decim_offset - iq.size) % self._decim
        if kept.size == 0:
            return kept.real, kept.real

        # Mark sits +shift/2 from the centre in normal polarity, space −shift/2.
        offset = (self.mark_hz - centre) / self.work_fs
        k = np.arange(kept.size)
        rot = np.exp(-2j * np.pi * offset * k + -1j * self._tone_phase)
        self._tone_phase = float((self._tone_phase + 2 * np.pi * offset * kept.size) % (2 * np.pi))
        mark, self._mark_zi = signal.lfilter(self._box, 1.0, kept * rot, zi=self._mark_zi)
        space, self._space_zi = signal.lfilter(self._box, 1.0, kept * np.conj(rot), zi=self._space_zi)
        m, sp = np.abs(mark), np.abs(space)
        return m - sp, m + sp

    # --- slicing -----------------------------------------------------------

    def _slice(self, d: np.ndarray, e: np.ndarray) -> list[tuple[float, str]]:
        """Characters found, each with its start edge's work-rate position."""
        self._d = np.concatenate((self._d, d))
        self._e = np.concatenate((self._e, e))
        keep = int(LEVEL_S * self.work_fs)
        self._level_buf = np.concatenate((self._level_buf, e))[-keep:]
        level = float(np.percentile(self._level_buf, LEVEL_PERCENTILE)) if self._level_buf.size else 0.0
        out: list[tuple[float, str]] = []
        spb = self._spb
        # From a start edge, the stop bit's sample is this far on.
        frame = (DATA_BITS + 1.5) * spb
        while True:
            # The next mark-to-space crossing at or after _pos.
            seg = self._d[self._pos - 1 :]
            if seg.size < 2:
                break
            edges = np.nonzero((seg[:-1] >= 0) & (seg[1:] < 0))[0]
            if edges.size == 0:
                self._pos = max(1, self._d.size)
                break
            edge = self._pos + int(edges[0])
            if int(round(edge + frame)) >= self._d.size:
                # The character isn't all here yet: wait at its edge.
                self._pos = edge
                break
            # The boxcar's crossing lags the real edge by half a bit, so bit k
            # has just been integrated whole at edge + (k + 0.5) bits.
            at = [int(round(edge + (k + 0.5) * spb)) for k in range(DATA_BITS + 2)]
            samples = [self._d[i] for i in at]
            e_at = self._e[at]
            strong = bool(
                np.all(e_at >= LEVEL_SHARE * level)
                and np.all(np.abs(self._d[at]) >= DECISIVE * np.maximum(e_at, 1e-30))
            )
            if samples[0] < 0 and samples[-1] > 0 and not strong:
                # Framed like a character, but not this signal's FSK: skip it whole.
                self._pos = int(edge + frame)
            elif samples[0] < 0 and samples[-1] > 0:
                code = sum(1 << i for i, v in enumerate(samples[1:-1]) if v > 0)
                out.append((self._d_abs0 + edge, self._ita2.feed(code)))
                self._pos = int(edge + frame)
            else:
                # Not a character (noise, or we came in mid-character): look on.
                self._pos = edge + 1
        # Drop what's been read, keeping one sample for the next crossing test.
        drop = max(0, self._pos - 1)
        if drop:
            self._d = self._d[drop:]
            self._d_abs0 += drop
            self._e = self._e[drop:]
            self._pos -= drop
        return out
