import asyncio
import itertools
import ssl
import struct

import numpy as np
import pytest
import trustme
import websockets.asyncio.client
from websockets.asyncio.server import serve

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


@pytest.mark.parametrize(
    "reject,code,says",
    [
        (b"MSG too_busy=4", "busy", "is full (4 listeners max)"),
        (b"MSG too_busy", "busy", "is full. Try"),
        (b"MSG too_busy=0", "no_apps", "only lets listeners in through its own web page"),
    ],
)
async def test_too_busy_message_matches_the_reason(reject, code, says):
    # too_busy=0 is a Kiwi that refuses apps (ext_api=0), not a full one.
    async with FakeKiwi(reject=reject) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == code
        assert says in str(e.value)
        await client.close()


async def test_too_busy_while_streaming_ends_with_its_reason():
    # Real ext_api=0 Kiwis send audio for about 10 s before too_busy=0.
    async with FakeKiwi(drop_after=20, last_words=b"MSG too_busy=0") as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        await client.tune(9535)
        await client.connect()
        got = 0
        with pytest.raises(KiwiError) as e:
            async for _ in client.blocks():
                got += 1
        assert got == 20
        assert e.value.code == "no_apps"
        assert "own web page" in str(e.value)
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


def snd(samples: int) -> bytes:
    """A stereo SND frame carrying this many silent I/Q pairs."""
    return b"SND" + struct.pack("<BI", 0x08, 0) + struct.pack(">H", 0) + bytes(10) + bytes(samples * 4)


class QueuedSocket:
    """A Kiwi whose first frame arrives late and the rest are already queued.

    The first keepalive send is slow, standing in for our own work (parsing,
    a send) using up the window. Timeline with streaming_client's 1 s
    window: first frame at 0.5 s, keepalive done at 1.25 s, so every later
    frame is read past the deadline.
    """

    def __init__(self, frames):
        self.frames = iter(frames)
        self.first = True
        self.slow_send = True
        self.sent = []

    async def recv(self):
        if self.first:
            self.first = False
            await asyncio.sleep(0.5)
        return next(self.frames)

    async def send(self, msg):
        self.sent.append(msg)
        # Always yield, so a test's wait_for can still cancel a loop that
        # otherwise never waits (frames are always queued).
        await asyncio.sleep(0.75 if self.slow_send else 0)
        self.slow_send = False


def streaming_client(ws) -> KiwiClient:
    client = KiwiClient("kiwi.example", 8073, timeout_s=1.0)
    client._ws = ws
    client.info.sample_rate = 12000.0  # so a window needs 1200 samples
    return client


# Value: protects=a frame already queued when our own work uses up the window still counts; fails_when=blocks() waits with wait_for(..., 0), which raises without reading the socket; why_new=a receiver at the audio floor was dropped for a frame it sent in time; seam=KiwiClient._ws (a stub socket whose frames are always queued); no_claim=real socket queueing
async def test_frame_queued_at_the_deadline_still_counts():
    # 1000 samples in time, then a queued 500 makes 1500 of the 1200 needed.
    sizes = []
    async for b in streaming_client(QueuedSocket([snd(1000), snd(500)])).blocks():
        sizes.append(b.samples.size)
        if len(sizes) == 2:
            break
    assert sizes == [1000, 500]


# Value: protects=time we spend sending a keepalive isn't taken out of the receiver's next window; fails_when=the window is reset before the keepalive send on the frame that meets the floor; why_new=that order was briefly introduced on this branch and caught in review; seam=KiwiClient._ws (a stub socket with paced frames); no_claim=real send backpressure
async def test_a_slow_keepalive_does_not_shorten_the_next_window():
    class PacedSocket(QueuedSocket):
        async def recv(self):
            delay, frame = next(self.frames)
            await asyncio.sleep(delay)
            return frame

    # The 1200 samples a window needs land at 0.5 s and our keepalive takes
    # until 1.25 s. The next window starts after that send, so the next full
    # window's audio at 1.95 s is in time (it would be late against 1.5 s).
    ws = PacedSocket([(0.5, snd(1200)), (0.7, snd(1200))])
    sizes = []
    async for b in streaming_client(ws).blocks():
        sizes.append(b.samples.size)
        if len(sizes) == 2:
            break
    assert sizes == [1200, 1200]


# Value: protects=a real websockets recv() hands back a frame already queued past the deadline, which the fix relies on; fails_when=a websockets upgrade makes recv() suspend on a queued frame, so asyncio.timeout(0) cancels it; why_new=the queued-frame tests use a stub socket that never suspends; seam=KiwiClient._ws (a real connection with its send slowed); no_claim=a real KiwiSDR's frame pacing
async def test_frame_queued_on_a_real_socket_at_the_deadline_still_counts():
    async def kiwi(ws):
        await asyncio.sleep(0.5)  # the first frame lands mid-window
        await ws.send(snd(1000))
        await ws.send(snd(500))
        await ws.wait_closed()

    async with serve(kiwi, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        ws = await websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}")
        send = ws.send
        first = True

        async def slow_first_send(msg):
            nonlocal first
            if first:
                first = False
                await asyncio.sleep(0.75)  # done at 1.25 s, past the 1 s window
            await send(msg)

        ws.send = slow_first_send
        sizes = []
        async for b in streaming_client(ws).blocks():
            sizes.append(b.samples.size)
            if len(sizes) == 2:
                break
        await ws.close()
    assert sizes == [1000, 500]


# Value: protects=past the deadline only the one frame that completes the window is taken; fails_when=every queued frame past the deadline is read (a plain asyncio.timeout swap), so a receiver that already missed its window gets unlimited tries; why_new=the queued-frame grace needs a bound; seam=KiwiClient._ws (a stub socket whose frames are always queued); no_claim=real socket queueing
async def test_a_queued_frame_that_misses_the_floor_ends_the_stream():
    # 1 sample in time, then queued frames that would refill the window only on the third try.
    frames = itertools.chain([snd(1), snd(1), snd(1)], itertools.repeat(snd(1500)))
    sizes = []

    async def drain():
        async for b in streaming_client(QueuedSocket(frames)).blocks():
            sizes.append(b.samples.size)

    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(drain(), timeout=3)
    assert e.value.code == "timeout"
    assert sizes == [1]


# Value: protects=past the deadline a queued non-audio frame (status MSG or unknown tag) ends the stream, unhandled, rather than buying more time; fails_when=the overdue check is dropped from the non-SND branch, so a Kiwi flooding status frames gets unlimited tries, or runs after _handle_msg, so an overdue audio_rate MSG makes us send to a Kiwi that may have stopped reading; why_new=FakeKiwi's status-only receiver paces its frames, so it only reaches the recv timeout; seam=KiwiClient._ws (a stub socket whose frames are always queued); no_claim=real socket queueing
@pytest.mark.parametrize(
    "filler",
    [b"MSG status=ok", b"MSG audio_rate=12000", b"XYZ"],
    ids=["status MSG", "audio_rate MSG", "unknown tag"],
)
async def test_a_queued_non_audio_frame_past_the_deadline_ends_the_stream(filler):
    # 1 sample in time, then queued filler, then audio that would refill the window.
    frames = itertools.chain([snd(1)], itertools.repeat(filler, 50), itertools.repeat(snd(1500)))
    ws = QueuedSocket(frames)
    sizes = []

    async def drain():
        async for b in streaming_client(ws).blocks():
            sizes.append(b.samples.size)

    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(drain(), timeout=3)
    assert e.value.code == "timeout"
    assert sizes == [1]
    # An overdue MSG isn't handled: answering audio_rate would be a send that
    # a Kiwi which stopped reading could stall, holding the slot.
    assert ws.sent == ["SET keepalive"]


# Value: protects=keepalives keep going out while audio streams; fails_when=the keepalive call is lost from blocks() (it moved in this change); why_new=no test streamed past the 1 s keepalive interval and looked at commands; seam=none; no_claim=how long a real Kiwi waits before dropping a silent client
async def test_keepalives_are_sent_while_streaming():
    async with FakeKiwi() as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=1)
        await client.tune(9535.0)
        await client.connect()
        started = asyncio.get_running_loop().time()
        async for _ in client.blocks():
            if asyncio.get_running_loop().time() - started > 2.5:
                break
        await client.close()
    # One is forced at connect; the rest come from blocks(), at most one a second.
    assert kiwi.commands.count("SET keepalive") >= 3


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
