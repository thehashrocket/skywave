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
