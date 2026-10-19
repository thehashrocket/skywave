import asyncio

import numpy as np
import pytest

from skywave_radio.kiwi import KiwiClient, KiwiError, parse_msg

from .fakekiwi import FakeKiwi


def test_parse_msg_decodes_values():
    assert parse_msg(b"sample_rate=12001.135 down rx_name=My%20Kiwi") == {
        "sample_rate": "12001.135",
        "down": None,
        "rx_name": "My Kiwi",
    }


async def test_handshake_and_iq_stream():
    async with FakeKiwi(tone_hz=1500) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port)
        await client.tune(9535.0)
        info = await client.connect()
        assert info.sample_rate == 12000.0
        blocks = []
        async for b in client.blocks():
            blocks.append(b)
            if len(blocks) == 5:
                break
        await client.close()

    assert kiwi.paths[0].endswith("/SND")
    assert kiwi.commands[0] == "SET auth t=kiwi p="
    assert "SET AR OK in=12000 out=44100" in kiwi.commands
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=9535.000" in kiwi.commands
    assert "SET compression=0" in kiwi.commands
    iq = np.concatenate([b.samples for b in blocks])
    assert iq.dtype == np.complex64
    assert blocks[0].rssi_dbm == pytest.approx(-73.0)
    freq = np.fft.fftfreq(iq.size, 1 / 12000)[np.argmax(np.abs(np.fft.fft(iq)))]
    assert abs(freq - 1500) < 30


async def test_busy_kiwi_raises():
    async with FakeKiwi(busy=True) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "busy"
        await client.close()


async def test_unreachable_kiwi_raises():
    client = KiwiClient("127.0.0.1", 9, timeout_s=2)
    with pytest.raises(KiwiError) as e:
        await client.connect()
    assert e.value.code == "unreachable"
