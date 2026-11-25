import difflib

import numpy as np
import pytest

from skywave_radio.rtty import SHIFT_HZ, Ita2, RttyDecoder, ita2_encode, modulate

# A Kiwi's real rate is never a round 12 kHz.
FS = 12001.3
TEXT = "CQ CQ DE TEST RYRY 73 DE TEST 12345 THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789 " * 2


def with_noise(iq: np.ndarray, snr_db: float, seed: int = 0) -> np.ndarray:
    """Add complex white noise so the SNR in a 3 kHz bandwidth is `snr_db`."""
    rng = np.random.default_rng(seed)
    var = np.mean(np.abs(iq) ** 2) / 10 ** (snr_db / 10) * FS / 3000
    noise = np.sqrt(var / 2) * (rng.standard_normal(iq.size) + 1j * rng.standard_normal(iq.size))
    return (iq + noise).astype(np.complex64)


def decode(iq: np.ndarray, block: int = 512, **kw) -> tuple[str, RttyDecoder]:
    d = RttyDecoder(FS, **kw)
    return "".join(d.process(iq[i : i + block]) for i in range(0, iq.size, block)), d


def cer(got: str, want: str) -> float:
    return 1 - difflib.SequenceMatcher(None, got.strip(), want.strip()).ratio()


# Value: protects=clean RTTY at a typical USB pitch decodes to the exact text, tone pair found automatically; fails_when=bit timing, ITA2 tables, bit order or the pair search is wrong; why_new=first RTTY decoder; seam=none; no_claim=real-world fading or multipath
def test_decodes_clean_signal_exactly():
    got, d = decode(modulate(TEXT, FS, mark_hz=1585))
    assert got.strip() == TEXT.strip()
    assert d.mark_hz == pytest.approx(1585, abs=5)


# Value: protects=a weak signal (10 dB SNR in 3 kHz, a usable GhostNet copy) still reads; fails_when=the matched filter or squelch is so lossy that marginal signals print nothing or garbage; why_new=no decoder before; seam=none; no_claim=QSB or impulse noise
def test_decodes_at_10_db_snr():
    got, _ = decode(with_noise(modulate(TEXT, FS, mark_hz=1585), 10))
    assert cer(got, TEXT) < 0.05


# Value: protects=reverse polarity decodes when asked, and the wrong polarity doesn't print the text; fails_when=reverse is ignored or swaps the wrong tone; why_new=no decoder before; seam=none; no_claim=automatic polarity detection (not built)
def test_reverse_polarity():
    iq = with_noise(modulate(TEXT, FS, mark_hz=1415, reverse=True), 20)
    got, _ = decode(iq, reverse=True)
    assert cer(got, TEXT) < 0.02
    wrong, _ = decode(iq)
    assert cer(wrong, TEXT) > 0.5


# Value: protects=a mark set 30 Hz off the real tone (a sloppy waterfall click) still decodes; fails_when=the tone filters are so narrow a small mistune loses the copy; why_new=no decoder before; seam=none; no_claim=drift during a transmission
def test_fixed_mark_tolerates_30_hz_mistune():
    got, d = decode(with_noise(modulate(TEXT, FS, mark_hz=1615), 20), mark_hz=1585)
    assert d.mark_hz == 1585
    assert cer(got, TEXT) < 0.02


# Value: protects=figures and letters shifts, including unshift-on-space, round-trip; fails_when=FIGS/LTRS handling or the FIGS table is wrong; why_new=no decoder before; seam=none; no_claim=senders that never resend FIGS after a space
def test_letters_figures_mix():
    text = "RYRY 73 DE TEST 12345 A1B2 ?/-."
    got, _ = decode(modulate(text, FS, mark_hz=2125))
    assert got.strip() == text


# Value: protects=noise alone prints nothing (the squelch holds), so the panel doesn't fill with random letters; fails_when=the squelch opens on noise; why_new=no decoder before; seam=none; no_claim=behaviour on busy bands with voice or other digital modes
def test_noise_alone_prints_nothing():
    rng = np.random.default_rng(3)
    n = int(FS * 15)
    iq = (0.01 * (rng.standard_normal(n) + 1j * rng.standard_normal(n))).astype(np.complex64)
    got, d = decode(iq)
    assert got == ""
    assert not d.squelch_open


# Value: protects=a lone carrier isn't taken for a tone pair; fails_when=the pair score uses the stronger tone instead of the weaker; why_new=no decoder before; seam=none; no_claim=two carriers exactly 170 Hz apart
def test_single_carrier_is_not_a_pair():
    n = int(FS * 10)
    t = np.arange(n) / FS
    rng = np.random.default_rng(4)
    iq = 0.1 * np.exp(2j * np.pi * 1200 * t) + 0.001 * (rng.standard_normal(n) + 1j * rng.standard_normal(n))
    got, d = decode(iq.astype(np.complex64))
    assert got == ""
    assert not d.squelch_open


# Value: protects=block size doesn't change the text, so Kiwi frame sizes (and tiny or empty blocks) are safe; fails_when=decimation phase or slicer buffers lose samples at block seams; why_new=no decoder before; seam=none; no_claim=none
@pytest.mark.parametrize("block", [1, 7, 333, 4096])
def test_block_size_does_not_matter(block):
    iq = modulate("RYRY DE TEST 12345", FS, mark_hz=1585)
    got, _ = decode(iq, block=block)
    assert got.strip() == "RYRY DE TEST 12345"
    d = RttyDecoder(FS)
    assert d.process(np.zeros(0, dtype=np.complex64)) == ""


# Value: protects=LSB signals (negative baseband) decode when the search range is the LSB passband; fails_when=the search or mixers assume positive frequencies; why_new=no decoder before; seam=none; no_claim=none
def test_lsb_side():
    got, d = decode(modulate(TEXT, FS, mark_hz=-1500), search=(-2700.0, -300.0))
    assert got.strip() == TEXT.strip()
    assert d.space_hz == pytest.approx(d.mark_hz - SHIFT_HZ)


# Value: protects=ITA2 encoding and decoding agree on every printable character; fails_when=the two tables drift apart; why_new=no decoder before; seam=none; no_claim=CCITT (non-US) figures differences
def test_ita2_round_trip():
    text = "THE QUICK BROWN FOX 0123456789 -$',!:(\")#?&./;"
    dec = Ita2()
    assert "".join(dec.feed(c) for c in ita2_encode(text)) == text


# --- Independent of rtty.py's own tables and modulator ---------------------
# The tests above make their signal with rtty.modulate, which shares the
# decoder's ITA2 table and tone order, so a mistake in both would pass them.
# These build the signal from the published ITA2 bit patterns (transmission
# order, first bit first, 1 = mark) and the RF convention that mark is the
# higher frequency, written out here by hand.
ITA2_PUBLISHED = {
    "LTRS": "11111", "FIGS": "11011", " ": "00100",
    "C": "01110", "D": "10010", "E": "10000", "Q": "11101", "R": "01010",
    "W": "11001", "Y": "10101", "A": "11000", "T": "00001", "U": "11100",
    "K": "11110", "B": "10011",
}  # fmt: skip
# Figures sit on the top row's letter codes: 1 on Q, 2 on W ... 7 on U (US TTY).
FIG_ON = {"1": "Q", "2": "W", "3": "E", "4": "R", "5": "T", "6": "Y", "7": "U"}


def published_frames(text: str) -> list[str]:
    frames = ["LTRS", "LTRS"]
    figs = False
    for ch in text:
        if ch == " ":
            frames.append(" ")
            figs = False  # the receiver unshifts on space
            continue
        want = ch in FIG_ON
        if want != figs:
            frames.append("FIGS" if want else "LTRS")
            figs = want
        frames.append(FIG_ON[ch] if want else ch)
    return frames + ["LTRS"]


def hand_fsk(text: str, fs: float, upper_hz: float, lower_hz: float) -> np.ndarray:
    """Mark on `upper_hz` (the higher frequency), space on `lower_hz`; 45.45 baud,
    1 start bit, 5 data bits, 1.5 stop bits."""
    levels: list[tuple[int, float]] = [(1, 20.0)]  # idle mark first
    for name in published_frames(text):
        levels.append((0, 1.0))
        levels.extend((int(b), 1.0) for b in ITA2_PUBLISHED[name])
        levels.append((1, 1.5))
    levels.append((1, 20.0))
    f = np.concatenate(
        [np.full(int(round(n / 45.45 * fs)), upper_hz if v else lower_hz) for v, n in levels]
    )
    return (0.1 * np.exp(2j * np.pi * np.cumsum(f) / fs)).astype(np.complex64)


# Value: protects=the decoder reads the published ITA2 codes, LSB-first bit order and mark-is-higher-RF convention, checked against a signal built without any rtty.py code; fails_when=the ITA2 tables, bit order or tone polarity in rtty.py are wrong (a shared mistake the modulate-based tests can't see), or the characters sent before the pair is found are lost; why_new=user review: every other test used rtty.modulate; seam=hand-written bit patterns from the ITA2 standard; no_claim=which polarity a given real station uses (see the W1AW recording check)
def test_published_ita2_and_polarity_independent_of_modulate():
    text = "CQ CQ DE W1AW RYRY 73 WA2 24567"
    got, d = decode(hand_fsk(text, FS, upper_hz=1700, lower_hz=1530))
    assert got.strip() == text
    assert d.mark_hz == pytest.approx(1700, abs=5)
    # The same signal read as reverse is not the text.
    wrong, _ = decode(hand_fsk(text, FS, upper_hz=1700, lower_hz=1530), reverse=True)
    assert text not in wrong


# Value: protects=noise just before a transmission (replayed when the pair is found) and just after it (before the squelch closes) prints nothing, so each burst reads clean; fails_when=the per-character level gate is missing or too loose; why_new=a recorded-file check printed junk letters around a burst; seam=hand-built FSK, not rtty.modulate; no_claim=deep fading inside a burst
def test_no_junk_around_a_burst():
    rng = np.random.default_rng(7)
    quiet = np.zeros(int(FS * 3), dtype=np.complex64)
    burst = hand_fsk("CQ DE W1AW 73", FS, upper_hz=2125, lower_hz=1955)
    iq = np.concatenate((quiet, burst, quiet, quiet))
    iq = (iq + 0.003 * (rng.standard_normal(iq.size) + 1j * rng.standard_normal(iq.size))).astype(np.complex64)
    got, _ = decode(iq)
    assert got.strip() == "CQ DE W1AW 73"


def mfsk16(seconds: float, centre: float = 1500.0, seed: int = 0) -> np.ndarray:
    """MFSK16 as W1AW sends it: one of 16 tones 15.625 Hz apart, 15.625 symbols a second."""
    rng = np.random.default_rng(seed)
    n = int(seconds * 15.625)
    tones = centre + (rng.integers(0, 16, n) - 7.5) * 15.625
    f = np.repeat(tones, int(round(FS / 15.625)))
    return (0.1 * np.exp(2j * np.pi * np.cumsum(f) / FS)).astype(np.complex64)


# Value: protects=other data modes don't fill the panel with junk: a minute of MFSK16 (whose tones do sit 170 Hz apart) prints at most a few single-transition letters, where before the strong/decisive gate it printed screens of random text; fails_when=the per-character gate is dropped or loosened; why_new=the W1AW recording printed junk through PSK31 and MFSK16; seam=hand-built MFSK16; no_claim=every other mode (Olivia, PSK, voice) or the rare M runs it still lets through
@pytest.mark.parametrize("seed", range(4))
def test_mfsk16_prints_almost_nothing(seed):
    got, _ = decode(mfsk16(60, seed=seed))
    assert len(got.strip()) <= 12
    assert set(got.strip()) <= set("MOTV ")


# Value: protects=two unrelated carriers 170 Hz apart (both on at once) print nothing, though the search takes them for a pair; fails_when=the decisiveness check is missing; why_new=busy-band junk seen on the W1AW 40 m recording; seam=none; no_claim=keyed carriers that alternate like FSK
def test_two_steady_carriers_print_nothing():
    t = np.arange(int(FS * 30)) / FS
    iq = 0.1 * np.exp(2j * np.pi * 1500 * t) + 0.1 * (1 + 0.5 * np.sin(2 * np.pi * 0.7 * t)) * np.exp(2j * np.pi * 1670 * t)
    got, _ = decode(iq.astype(np.complex64))
    assert got == ""


# Value: protects=the next over on the same tones (a net taking turns) prints from its first word, and starts in letters even if junk left the decoder in figures; fails_when=the replay runs only on a new pair, or the ITA2 shift survives a closed squelch; why_new=code review of PR 120; seam=hand-built FSK; no_claim=overs that start within a second of the last one ending (the squelch never closes)
def test_second_over_on_same_tones_prints_from_its_start():
    rng = np.random.default_rng(11)
    gap = np.zeros(int(FS * 12), dtype=np.complex64)
    first = hand_fsk("CQ DE W1AW", FS, upper_hz=2125, lower_hz=1955)
    second = hand_fsk("CQ CQ DE K1ABC K", FS, upper_hz=2125, lower_hz=1955)

    def noisy(x):
        return (x + 0.003 * (rng.standard_normal(x.size) + 1j * rng.standard_normal(x.size))).astype(np.complex64)

    d = RttyDecoder(FS)
    run = lambda x: "".join(d.process(x[i : i + 512]) for i in range(0, x.size, 512))  # noqa: E731
    assert run(noisy(first)).strip() == "CQ DE W1AW"
    assert run(noisy(gap)) == ""
    assert not d.squelch_open
    d._ita2.figs = True  # as if junk read during the gap decoded as FIGS
    assert run(noisy(np.concatenate((second, gap[: int(FS * 3)])))).strip() == "CQ CQ DE K1ABC K"


# Value: protects=when the squelch shuts and reopens within the replay window (a short fade mid-over), the replay doesn't print words again that were already shown; fails_when=replayed characters aren't checked against what was shown; why_new=second review of PR 120; seam=the squelch forced shut by hand (a real fade needs a weak signal and exact timing); no_claim=a different station starting on a drifted pair inside the replay window (its first characters may be dropped)
def test_reopening_squelch_does_not_repeat_text():
    text = "CQ CQ DE W1AW W1AW TU K"
    iq = hand_fsk(text, FS, upper_hz=2125, lower_hz=1955)
    d = RttyDecoder(FS)
    half = iq.size // 2
    out = "".join(d.process(iq[i : min(i + 512, half)]) for i in range(0, half, 512))
    assert d.squelch_open and out.strip()
    d.squelch_open = False  # as if a fade had closed it; the next search reopens it and replays
    out += "".join(d.process(iq[i : i + 512]) for i in range(half, iq.size, 512))
    assert out.strip() == text
