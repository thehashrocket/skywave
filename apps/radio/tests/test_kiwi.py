import asyncio
import ssl

import numpy as np
import pytest
import trustme
import websockets.asyncio.client

from skywave_radio import kiwi as kiwi_module
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

    assert kiwi.paths[0].startswith("/kiwi/")
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


@pytest.mark.parametrize(
    "fake,message",
    [
        (FakeKiwi(silent=True), "connected but never answered"),
        (FakeKiwi(no_rate=True), "never sent its sample rate"),
    ],
)
async def test_handshake_timeout_says_whether_the_kiwi_answered(fake, message):
    async with fake as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "timeout"
        assert message in str(e.value)


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


# Value: protects=time the caller spends on a block (a stalled browser) isn't blamed on the receiver; fails_when=the deadline keeps running while the caller holds a block; why_new=a 10-15 s browser stall used to time out a healthy Kiwi; seam=none; no_claim=real WebSocket backpressure timing
async def test_time_spent_by_the_caller_does_not_count_against_the_receiver():
    async with FakeKiwi() as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        await client.tune(9535.0)
        await client.connect()
        seen = 0
        async for _ in client.blocks():
            seen += 1
            if seen == 3:
                await asyncio.sleep(1.0)  # twice timeout_s
            if seen == 20:
                break
        await client.close()


# Value: protects=a Kiwi that stops reading can't block a send forever (no deadline in blocks() runs while one waits); fails_when=_send awaits the socket without a timeout; why_new=sends had no bound; seam=KiwiClient._ws and _send (a stub socket whose send never completes); no_claim=real TCP buffer sizes (a send that never completes stands in for full buffers)
async def test_send_to_a_kiwi_that_stopped_reading_times_out():
    class StuckSocket:
        async def send(self, msg):
            await asyncio.Event().wait()

    client = KiwiClient("kiwi.example", 8073, timeout_s=0.2)
    client._ws = StuckSocket()
    with pytest.raises(KiwiError) as e:
        await client._send("SET keepalive")
    assert e.value.code == "timeout"
    assert "stopped reading" in str(e.value)


# Value: protects=a receiver that sent real audio and then only empty blocks still times out; fails_when=the audio count isn't cleared when the deadline resets, so one good window keeps every later block resetting it; why_new=server tests' empty receivers never send real audio first; seam=none; no_claim=a real Kiwi's failure pattern (FakeKiwi stands in)
async def test_receiver_that_goes_quiet_after_real_audio_times_out():
    async with FakeKiwi(empty_after=20) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        await client.tune(9535.0)
        await client.connect()
        sizes = []

        async def drain():
            async for b in client.blocks():
                sizes.append(b.samples.size)

        with pytest.raises(KiwiError) as e:
            await asyncio.wait_for(drain(), timeout=5)
        assert e.value.code == "timeout"
        assert sizes[:20] == [512] * 20 and set(sizes[20:]) == {0}
        await client.close()


# Value: protects=a receiver well below real time but above the floor, with dropouts, keeps playing; fails_when=MIN_AUDIO_FRACTION is raised far enough to cut off a slow link; why_new=FakeKiwi streams at 4x, so only the too-lenient side of the floor was tested; seam=none; no_claim=a real congested Kiwi's pacing
async def test_slow_receiver_with_dropouts_keeps_streaming():
    # 128-sample frames at FakeKiwi's fixed pace, every second one empty: about 0.45x real time.
    async with FakeKiwi(block_size=128, empty_every=2) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        await client.tune(9535.0)
        await client.connect()
        started = asyncio.get_running_loop().time()
        async for _ in client.blocks():
            if asyncio.get_running_loop().time() - started > 2.0:  # 4 x timeout_s
                break
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


def test_ipv6_hosts_are_bracketed_in_the_url():
    client = KiwiClient("2001:db8::1", 8073)
    assert client.url.startswith("ws://[2001:db8::1]:8073/")
    assert KiwiClient("kiwi.example", 8073).url.startswith("ws://kiwi.example:8073/")


async def test_an_undialable_url_is_a_coded_error(monkeypatch):
    # A bad URL used to escape as a bare ValueError: "Something broke" and no code.
    def bad_url(self):
        return "ws://2001:db8::1:8073/1/SND"  # what an unbracketed IPv6 host used to produce

    monkeypatch.setattr(KiwiClient, "url", property(bad_url))
    with pytest.raises(KiwiError) as e:
        await KiwiClient("kiwi.example", 8073, timeout_s=0.5).connect()
    assert e.value.code == "invalid"


def test_secure_clients_dial_wss():
    assert KiwiClient("kiwi.example", 443, secure=True).url.startswith("wss://kiwi.example:443/")


# Value: protects=a copied address in an error message pastes back as a working host:port; fails_when=messages format host:port without brackets; why_new=only the URL was bracketed; seam=none; no_claim=web-side display
async def test_ipv6_addresses_are_bracketed_in_messages():
    with pytest.raises(KiwiError) as e:
        await KiwiClient("::1", 9, timeout_s=2).connect()
    assert e.value.code == "unreachable"
    assert "[::1]:9" in str(e.value)


# Value: protects=only a URL we can't build is "invalid" (which Pick best treats as a free skip); fails_when=connect maps any ValueError to invalid again; why_new=TODOS small edges; seam=none; no_claim=which ValueErrors websockets raises
async def test_a_value_error_while_dialing_is_not_an_address_problem(monkeypatch):
    def broken(*args, **kwargs):
        raise ValueError("something inside the handshake")

    monkeypatch.setattr(kiwi_module, "_connect", broken)
    with pytest.raises(ValueError):
        await KiwiClient("kiwi.example", 8073, timeout_s=0.5).connect()


# Value: protects=the service dials the address hostguard checked even with HTTPS_PROXY set; fails_when=proxy=None is dropped and websockets picks a proxy from the environment; why_new=no test pinned it; seam=none; no_claim=real proxies
async def test_never_dials_through_an_environment_proxy(monkeypatch):
    seen = {}

    def capture(url, **kwargs):
        seen.update(kwargs)
        raise OSError("stop here")

    monkeypatch.setattr(kiwi_module, "_connect", capture)
    with pytest.raises(KiwiError):
        await KiwiClient("kiwi.example", 8073, connect_host="203.0.113.7", timeout_s=0.5).connect()
    assert seen["proxy"] is None
    assert seen["host"] == "203.0.113.7"


@pytest.fixture
def tls(monkeypatch):
    """A CA the client trusts, and a server context for 'kiwi.test' signed by it."""
    ca = trustme.CA()
    trusting = ssl.create_default_context()
    ca.configure_trust(trusting)
    # websockets builds its own default context for wss://; make it this one.
    monkeypatch.setattr(websockets.asyncio.client.ssl_module, "create_default_context", lambda: trusting)

    def server(name="kiwi.test"):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ca.issue_cert(name).configure_cert(ctx)
        return ctx

    return server


# Value: protects=wss checks the certificate against the receiver's name while dialing the checked IP; fails_when=server_hostname follows connect_host or TLS is skipped; why_new=no TLS path existed; seam=websockets default-context factory (test CA); no_claim=public CA trust
async def test_wss_verifies_the_hostname_while_dialing_the_checked_address(tls):
    async with FakeKiwi(ssl=tls("kiwi.test")) as kiwi:
        client = KiwiClient("kiwi.test", kiwi.port, connect_host="127.0.0.1", secure=True, timeout_s=3)
        info = await client.connect()
        assert info.sample_rate == 12000.0
        await client.close()

    async with FakeKiwi(ssl=tls("someone-else.test")) as kiwi:
        client = KiwiClient("kiwi.test", kiwi.port, connect_host="127.0.0.1", secure=True, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "unreachable"


# Value: protects=redirects can't take the service beyond the same host moving to https; fails_when=any Location is followed, or websockets follows same-origin hops itself; why_new=no redirect path existed; seam=HTTPS_PORT (the fake can't bind 443); no_claim=real Kiwis behind nginx
@pytest.mark.parametrize(
    "location,followed",
    [
        ("https://kiwi.test/", True),  # same host, https, default port
        ("https://KIWI.test/", True),
        ("https://evil.test/", False),  # another host
        ("/elsewhere", False),  # same origin, still ws: websockets used to follow these itself
        ("https://kiwi.test:1/", False),  # neither 443 nor the original port
        ("ftp://kiwi.test/", False),
    ],
)
async def test_only_same_host_https_upgrades_are_followed(tls, monkeypatch, location, followed):
    async with FakeKiwi(ssl=tls("kiwi.test")) as secure:
        monkeypatch.setattr(kiwi_module, "HTTPS_PORT", secure.port)
        async with FakeKiwi(redirect_to=location) as plain:
            client = KiwiClient("kiwi.test", plain.port, connect_host="127.0.0.1", timeout_s=3)
            if followed:
                await client.connect()
                assert (client.secure, client.port) == (True, secure.port)
                await client.close()
            else:
                with pytest.raises(KiwiError) as e:
                    await client.connect()
                assert e.value.code == "unreachable"
                assert "redirects to" in str(e.value)
                assert secure.paths == []


async def test_a_second_redirect_is_not_followed(tls, monkeypatch):
    async with FakeKiwi(ssl=tls("kiwi.test"), redirect_to="https://kiwi.test/again") as secure:
        monkeypatch.setattr(kiwi_module, "HTTPS_PORT", secure.port)
        async with FakeKiwi(redirect_to="https://kiwi.test/") as plain:
            client = KiwiClient("kiwi.test", plain.port, connect_host="127.0.0.1", timeout_s=3)
            with pytest.raises(KiwiError) as e:
                await client.connect()
    assert e.value.code == "unreachable"
    assert len(secure.paths) == 1
