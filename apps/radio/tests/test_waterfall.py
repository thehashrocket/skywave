import asyncio
import struct

import numpy as np
import pytest

from skywave_radio.kiwi import KiwiClient, KiwiError
from skywave_radio.waterfall import WaterfallClient, parse_wf

from .fakekiwi import FakeKiwi


def carrier_at(rf_khz: float, *, offset_khz: float = 0.0, level: int = 200):
    """wf_bins for a fake: noise at 140 and one carrier at rf_khz."""

    def bins(start: float, span: float) -> np.ndarray:
        out = np.full(1024, 140, dtype=np.uint8)
        i = int((rf_khz - offset_khz - start) / span * 1024)
        if 0 <= i < 1024:
            out[i] = level
        return out

    return bins


async def paired(kiwi: FakeKiwi) -> tuple[KiwiClient, WaterfallClient]:
    snd = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
    await snd.tune(9650.0)
    await snd.connect()
    wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=3, timestamp=snd.timestamp)
    await wf.connect()
    return snd, wf


# Value: protects=the W/F handshake reads the receiver's offset and coverage and asks for uncompressed fast frames; fails_when=wf_setup isn't awaited, bandwidth is read as kHz, or wf_comp stays on; why_new=no W/F client existed; seam=none; no_claim=every firmware's MSG order (fake Kiwi)
async def test_handshake_reads_offset_and_coverage():
    async with FakeKiwi(freq_offset_khz=100_000.0, bandwidth_khz=32_000.0) as kiwi:
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=3)
        info = await wf.connect()
        assert info.freq_offset_khz == 100_000.0
        assert wf.bandwidth_khz == 32_000.0
        await asyncio.sleep(0.05)
        assert {"SET wf_comp=0", "SET wf_speed=4"} <= set(kiwi.wf_commands)
        await wf.close()


# Value: protects=a frame is used only once it shows the requested zoom and start, and the first match is skipped (C2); fails_when=the first frame after SET zoom is taken, so peaks land in the previous band; why_new=no sweep code; seam=none; no_claim=real Kiwi settle time (fake sends 2 stale frames)
async def test_frame_skips_frames_from_the_previous_position():
    async with FakeKiwi(wf_bins=carrier_at(9_420.0), wf_stale_frames=3) as kiwi:
        snd, wf = await paired(kiwi)
        frame = await wf.frame(zoom=6, cf_khz=9_650.0)
        span = 30_000 / 2**6
        assert frame.zoom == 6
        assert frame.span_khz == span
        assert frame.start_khz == pytest.approx(9_650.0 - span / 2, abs=0.01)
        peak = int(np.argmax(frame.bins))
        assert frame.start_khz + peak * span / 1024 == pytest.approx(9_420.0, abs=span / 1024)
        await wf.close()
        await snd.close()


# Value: protects=a W/F under another timestamp than our open SND is refused as unpaired: not a password problem, and not "busy", which scans remember for every listener (adversarial review); fails_when=badp=5 maps to "password" or "busy" for the waterfall; why_new=found by the T1 spike, recoded in Step 11; seam=none; no_claim=other badp codes
async def test_an_unpaired_waterfall_is_refused_as_unpaired():
    async with FakeKiwi() as kiwi:
        snd = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        await snd.tune(9650.0)
        await snd.connect()
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=3, timestamp=snd.timestamp + 1)
        with pytest.raises(KiwiError) as e:
            await wf.connect()
        assert e.value.code == "unpaired"
        assert "password" not in str(e.value)
        await wf.close()
        await snd.close()


# Value: protects=a W/F the Kiwi drops mid-sweep ends frame() with a coded error, never a hang; fails_when=a closed socket is retried or swallowed; why_new=no W/F client; seam=none; no_claim=real close codes
async def test_a_dropped_waterfall_raises_closed():
    async with FakeKiwi(wf_drop_after=3) as kiwi:
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=3)
        await wf.connect()
        with pytest.raises(KiwiError) as e:
            for cf in (9_650.0, 11_850.0, 15_450.0):
                await wf.frame(zoom=6, cf_khz=cf)
        assert e.value.code == "closed"
        await wf.close()


# Value: protects=after a sweep the paired W/F slows to about a frame a second and keeps reading and sending keepalives (D19); fails_when=idle stops reading or never sends wf_speed=1; why_new=closing a paired W/F ends the audio (T1 spike); seam=none; no_claim=real Kiwi idle rate
async def test_idle_slows_the_stream_and_keeps_it_alive():
    async with FakeKiwi(wf_interval=0.2) as kiwi:
        snd, wf = await paired(kiwi)
        task = asyncio.create_task(wf.idle())
        # Poll with a deadline rather than sleeping a fixed time: the second
        # keepalive is due about 1 s after the handshake's.
        async with asyncio.timeout(5):
            while kiwi.wf_commands.count("SET keepalive") < 2:
                await asyncio.sleep(0.05)
        assert not task.done()
        assert "SET wf_speed=1" in kiwi.wf_commands
        task.cancel()
        await wf.close()
        await snd.close()


# Value: protects=frames that are short, at an impossible zoom, or not exactly 1024 bins are refused before any peak finding; fails_when=parse_wf accepts them, so a hostile receiver can hand the loop a huge frame (review D3); why_new=security review; seam=none; no_claim=real firmware variants
@pytest.mark.parametrize(
    "body",
    [
        b"\x00" + bytes(11),
        b"\x00" + struct.pack("<III", 0, 15, 0) + bytes(1024),
        b"\x00" + struct.pack("<III", 0, 6, 0) + bytes(1023),
        b"\x00" + struct.pack("<III", 0, 6, 0) + bytes(2**20),
    ],
    ids=["short", "zoom out of range", "too few bins", "a million bins"],
)
def test_malformed_frames_are_rejected(body):
    with pytest.raises(ValueError):
        parse_wf(body, 30_000.0)


# Value: protects=a paired waterfall the Kiwi answers but never sets up is left open after the handshake times out, so the caller can drain it instead of closing it and ending the audio (review D9); fails_when=connect closes every stream on a late handshake timeout; why_new=red team (setup never finishes); seam=none; no_claim=firmware that behaves this way
async def test_a_waterfall_that_never_sets_up_is_left_open():
    async with FakeKiwi(wf_no_setup=True) as kiwi:
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        with pytest.raises(KiwiError) as e:
            await wf.connect()
        assert e.value.code == "timeout" and "waterfall setup" in str(e.value)
        assert wf.is_open
        await wf.close()
        assert not wf.is_open


# Value: protects=a paired waterfall whose socket opened but which never answered at all is left open too, since closing it would end the audio (cycle-2 red team); fails_when=connect closes a W/F that hasn't answered; why_new=red team (slow Kiwi accepts the upgrade, sends nothing); seam=a bare WebSocket server; no_claim=real slow-Kiwi timing
async def test_a_waterfall_that_never_answers_is_left_open():
    from websockets.asyncio.server import serve

    async def silent(ws):
        await ws.wait_closed()

    async with serve(silent, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        wf = WaterfallClient("127.0.0.1", port, timeout_s=0.5)
        with pytest.raises(KiwiError) as e:
            await wf.connect()
        assert "never answered" in str(e.value)
        assert wf.is_open
        await wf.close()


# Value: protects=a waterfall that never set up can't sweep (fast() raises and leaves it open), and one whose setup arrived late gets its settings before sweeping (cycle-2 review); fails_when=fast() sweeps an unconfigured stream (compressed frames, "the scan broke") or closes it; why_new=concurrency review; seam=_handle_msg fed the late setup by hand; no_claim=firmware that sets up late
async def test_a_late_setup_is_configured_before_a_sweep():
    async with FakeKiwi(wf_no_setup=True) as kiwi:
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        with pytest.raises(KiwiError):
            await wf.connect()
        with pytest.raises(KiwiError) as e:
            await wf.fast()
        assert e.value.code == "timeout" and wf.is_open
        wf._handle_msg({"wf_setup": None})
        await wf.fast()
        await asyncio.sleep(0.05)
        assert "SET wf_comp=0" in kiwi.wf_commands
        await wf.close()


# Value: protects=hostile MSG values are ignored: non-numbers, NaN, infinity, a coverage under 1 MHz or over 64 MHz, and unknown keys past the cap (cycle-2 security); fails_when=a guard goes, letting a hostile Kiwi crowd every peak into a few kHz or grow memory without bound; why_new=security review; seam=_handle_msg called directly; no_claim=what real firmware sends
@pytest.mark.parametrize("value", ["abc", "nan", "inf", "-inf", "1", "999999", "1e12"])
def test_hostile_coverage_values_are_ignored(value):
    wf = WaterfallClient("kiwi.example", 8073)
    wf._handle_msg({"bandwidth": value, "freq_offset": value})
    assert wf.bandwidth_khz == 30_000.0
    if value in ("1", "999999", "1e12"):
        assert wf.info.freq_offset_khz == float(value)  # finite offsets are fine; plan_frames clips them
    else:
        assert wf.info.freq_offset_khz == 0.0


def test_unknown_msg_keys_are_capped():
    from skywave_radio.kiwi import MAX_EXTRA_KEYS

    wf = WaterfallClient("kiwi.example", 8073)
    wf._handle_msg({f"k{i}": "v" for i in range(10_000)})
    assert len(wf.info.extra) == MAX_EXTRA_KEYS


# Value: protects=a malformed frame mid-sweep is skipped and the next good frame used, so one bad frame from a hostile Kiwi doesn't throw away the whole scan (adversarial review); fails_when=frame() lets parse_wf's ValueError escape; why_new=Step 11 Claude adversarial; seam=fake sends a short frame before each good one; no_claim=real firmware sending bad frames
async def test_a_malformed_frame_is_skipped():
    async with FakeKiwi(wf_bins=carrier_at(9_420.0), wf_bad_frames=True) as kiwi:
        snd, wf = await paired(kiwi)
        frame = await wf.frame(zoom=6, cf_khz=9_650.0)
        assert frame.bins.size == 1024
        await wf.close()
        await snd.close()
