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


# Value: protects=a W/F under another timestamp than our open SND is refused as busy, not reported as a password problem; fails_when=badp=5 maps to "password" again; why_new=found by the T1 spike; seam=none; no_claim=other badp codes
async def test_an_unpaired_waterfall_is_refused_as_busy():
    async with FakeKiwi() as kiwi:
        snd = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        await snd.tune(9650.0)
        await snd.connect()
        wf = WaterfallClient("127.0.0.1", kiwi.port, timeout_s=3, timestamp=snd.timestamp + 1)
        with pytest.raises(KiwiError) as e:
            await wf.connect()
        assert e.value.code == "busy"
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
        await asyncio.sleep(1.3)
        assert not task.done()
        assert "SET wf_speed=1" in kiwi.wf_commands
        assert kiwi.wf_commands.count("SET keepalive") >= 2
        task.cancel()
        await wf.close()
        await snd.close()


@pytest.mark.parametrize(
    "body",
    [b"\x00" + bytes(11), b"\x00" + struct.pack("<III", 0, 15, 0)],
    ids=["short", "zoom out of range"],
)
def test_malformed_frames_are_rejected(body):
    with pytest.raises(ValueError):
        parse_wf(body, 30_000.0)
