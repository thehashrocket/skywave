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


@pytest.mark.parametrize(
    "reject,code",
    [
        (b"MSG too_busy=4", "busy"),
        (b"MSG badp=1", "password"),
        (b"MSG down", "down"),
        (b"MSG redirect=http%3A%2F%2Fother.example%3A8073", "redirect"),
    ],
)
async def test_kiwi_refusals_raise_coded_errors(reject, code):
    async with FakeKiwi(reject=reject) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == code
        await client.close()


@pytest.mark.parametrize("rate", ["1e12", "nan", "0"])
async def test_unsupported_sample_rate_refused(rate):
    async with FakeKiwi(sample_rate=rate) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "bad_rate"
        await client.close()


async def test_stalled_stream_times_out():
    async with FakeKiwi(stall=True) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=1)
        await client.tune(9535.0)
        await client.connect()
        with pytest.raises(KiwiError) as e:
            async for _ in client.blocks():
                pass
        assert e.value.code == "timeout"
        await client.close()


async def test_unreachable_kiwi_raises():
    client = KiwiClient("127.0.0.1", 9, timeout_s=2)
    with pytest.raises(KiwiError) as e:
        await client.connect()
    assert e.value.code == "unreachable"


async def test_silent_port_gives_a_reason():
    # Accepts TCP but never answers the WebSocket upgrade, like a wrong port.
    held = []
    server = await asyncio.start_server(lambda r, w: held.append(w), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        with pytest.raises(KiwiError) as e:
            await KiwiClient("127.0.0.1", port, timeout_s=0.5).connect()
        assert e.value.code == "unreachable"
        assert "()" not in str(e.value)
        assert "check the port" in str(e.value)
    finally:
        for w in held:
            w.close()
        server.close()
