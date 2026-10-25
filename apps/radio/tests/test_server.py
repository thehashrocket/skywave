import asyncio
import json
import threading
import time
from functools import partial

import numpy as np
import pytest
from fastapi import WebSocketDisconnect, status
from fastapi.testclient import TestClient

from skywave_radio.config import Settings, origin_allowed
from skywave_radio.kiwi import KiwiClient
from skywave_radio.server import create_app
from skywave_radio.session import AUDIO_TAG, SPECTRUM_TAG

from .fakekiwi import BLOCK, FakeKiwi
from .frames import decode_spectrum

ORIGIN = {"origin": "http://localhost:3000"}


def settings(**over):
    # Built directly, so values Settings.from_env refuses still work here:
    # max_session_minutes=0 means "the limit fires at once".
    base = dict(
        allowed_origins=("http://localhost:3000",),
        token=None,
        max_sessions=2,
        max_session_minutes=60,
        idle_socket_minutes=10,
        max_sockets_per_ip=8,
        allow_private_hosts=True,
        ident="test",
        kiwi_agc=True,
    )
    base.update(over)
    return Settings(**base)


def collect(ws, want_audio=3, want_spectrum=1, limit=500):
    statuses, audio, spectra = [], [], []
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("text"):
            statuses.append(json.loads(msg["text"]))
        elif msg.get("bytes"):
            b = msg["bytes"]
            if b[:1] == AUDIO_TAG:
                audio.append(np.frombuffer(b[1:], dtype="<i2"))
            elif b[:1] == SPECTRUM_TAG:
                spectra.append(decode_spectrum(b[1:]))
            else:
                raise AssertionError(f"unexpected frame tag {b[0]}")
        if len(audio) >= want_audio and len(spectra) >= want_spectrum:
            break
    return statuses, audio, spectra


def until_state(ws, *states, limit=5000):
    """Status messages up to and including the first one in `states`; audio is skipped."""
    seen = []
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("text"):
            payload = json.loads(msg["text"])
            seen.append(payload)
            if payload.get("state") in states:
                return seen
    raise AssertionError(f"never reached {states}: {seen}")


def assert_rejected(app, path="/ws", headers=ORIGIN):
    client = TestClient(app)
    # Closing before accept makes websocket_connect itself raise; an accepted
    # socket falls through and fails as "DID NOT RAISE".
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect(path, headers=headers):
            pass
    assert e.value.code == status.WS_1008_POLICY_VIOLATION


def tune_msg(port, freq=7200, mode="usb", host="127.0.0.1"):
    return json.dumps({"type": "tune", "host": host, "port": port, "freqKhz": freq, "mode": mode})


def run_with_fake(fn, **fake_kw):
    """TestClient runs the app in its own thread/loop; run the fake Kiwi in another."""
    ready = threading.Event()
    stop = threading.Event()
    holder = {}

    def serve():
        async def main():
            async with FakeKiwi(**fake_kw) as kiwi:
                holder["kiwi"] = kiwi
                ready.set()
                while not stop.is_set():
                    await asyncio.sleep(0.05)

        asyncio.run(main())

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    ready.wait(5)
    try:
        return fn(holder["kiwi"])
    finally:
        stop.set()
        t.join(5)


# Value: protects=a Kiwi SND block with no samples is skipped: it used to crash the demodulator and end the session, and must not send a bare audio tag; fails_when=session.py passes an empty block to Demodulator.process or sends AUDIO_TAG for it; why_new=the fake always sent full blocks; seam=none; no_claim=how often real Kiwis send short blocks
def test_empty_kiwi_blocks_send_no_audio_frame():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            _, audio, _ = collect(ws, want_audio=3, want_spectrum=0)
        return audio

    audio = run_with_fake(body, empty_blocks=3)
    assert audio and all(len(a) == BLOCK for a in audio)


# Value: protects=a receiver sending no usable audio ends with the usual timeout instead of holding a listener slot; fails_when=MSG frames or short/empty blocks reset the deadline; why_new=only empty blocks were covered, and status-only or trickling receivers never timed out; seam=none; no_claim=a real broken Kiwi's frame pattern (FakeKiwi stands in)
@pytest.mark.timeout(10)
@pytest.mark.parametrize(
    "fake",
    [
        pytest.param(dict(empty_blocks=10**6), id="empty blocks"),
        pytest.param(dict(block_size=1), id="1-sample blocks"),
        pytest.param(dict(msg_only=True), id="status only"),
    ],
)
def test_receiver_sending_no_usable_audio_times_out(fake):
    def body(kiwi):
        # A short session limit too: a broken deadline ends "stopped", not hung.
        app = create_app(settings(max_session_minutes=0.05), client_factory=partial(KiwiClient, timeout_s=0.5))
        with TestClient(app).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            return until_state(ws, "error", "stopped")

    statuses = run_with_fake(body, **fake)
    assert statuses[-1]["code"] == "timeout"
    assert "stopped sending audio" in statuses[-1]["message"]


# Value: protects=a healthy receiver with occasional empty blocks keeps playing past timeout_s; fails_when=the deadline never resets or counts empty blocks against a real stream; why_new=no test ran longer than timeout_s with empties mixed in; seam=none; no_claim=how often real Kiwis send empty blocks
@pytest.mark.timeout(10)
def test_deadline_resets_while_real_audio_arrives():
    def body(kiwi):
        app = create_app(settings(), client_factory=partial(KiwiClient, timeout_s=0.5))
        with TestClient(app).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            statuses, audio = [], 0
            started = time.monotonic()
            while time.monotonic() - started < 2.0:  # 4 x timeout_s
                msg = ws.receive()
                if msg.get("text"):
                    statuses.append(json.loads(msg["text"]))
                elif msg.get("bytes", b"")[:1] == AUDIO_TAG:
                    audio += 1
        return statuses, audio

    statuses, audio = run_with_fake(body, empty_every=3)
    assert [s["state"] for s in statuses if s["type"] == "status"] == ["connecting", "listening"]
    assert audio > 0


class _HungWrites:
    """A Kiwi socket whose buffers are full: reads work, sends and close never finish."""

    def __init__(self, ws):
        self._ws = ws
        self.transport = ws.transport

    async def recv(self):
        return await self._ws.recv()

    async def send(self, msg):
        await asyncio.Event().wait()

    async def close(self):
        await asyncio.Event().wait()


class _StopsReading(KiwiClient):
    """Handshakes normally, then the Kiwi stops reading what we send."""

    async def connect(self):
        info = await super().connect()
        self._ws = _HungWrites(self._ws)
        return info


# A public address, so the per-address socket cap counts it; TestClient's own
# "testclient" and private addresses go uncounted.
PUBLIC = ("1.2.3.4", 50000)
EXPECTED = {"type": "status", "state": "error", "message": "Expected JSON."}


def until_released(app, timeout_s=5):
    """Wait for every socket's count to be released."""
    started = time.monotonic()
    while app.state.open_sockets:
        # gstack-timing-ok: a poll deadline; the contract is "released at all"
        assert time.monotonic() - started < timeout_s, f"never released: {app.state.open_sockets}"
        time.sleep(0.02)  # gstack-timing-ok: poll interval


def until_closed(ws, limit=5000):
    """Messages until the service closes the socket; returns (close message, statuses seen)."""
    seen = []
    for _ in range(limit):
        msg = ws.receive()
        if msg["type"] == "websocket.close":
            return msg, seen
        if msg.get("text"):
            seen.append(json.loads(msg["text"]))
    raise AssertionError(f"never closed: {seen}")


# Value: protects=a browser socket with no session and no messages is closed after IDLE_SOCKET_MINUTES with the idle code, so idle tabs and scripts can't hold sockets forever; fails_when=serve() waits on receive() with no idle clock, or closes with another code the page treats as an outage; why_new=TODOS (idle sockets held indefinitely); seam=none; no_claim=real browser timing
@pytest.mark.timeout(15)
def test_an_idle_socket_is_closed():
    from skywave_radio.server import IDLE_CLOSE_CODE

    app = create_app(settings(idle_socket_minutes=0.005))  # 0.3 s
    with TestClient(app, client=PUBLIC).websocket_connect("/ws", headers=ORIGIN) as ws:
        closed, _ = until_closed(ws)
        until_released(app)
    assert closed["code"] == IDLE_CLOSE_CODE


# Value: protects=an idle socket whose browser stopped reading is still dropped: the idle close frame is bounded, so serve() can't hang on it forever and pin the socket; fails_when=serve() awaits ws.close() with no deadline; why_new=review (Codex, both passes): the close frame can block on a non-reading client; seam=starlette WebSocket.close patched to never finish, CLOSE_FRAME_TIMEOUT_S shortened; no_claim=real TCP buffer behaviour
@pytest.mark.timeout(15)
def test_an_idle_socket_that_stopped_reading_is_still_dropped(monkeypatch, caplog):
    import logging

    from starlette.websockets import WebSocket

    from skywave_radio import server as server_module

    real_close = WebSocket.close
    stuck = []

    async def never_finishes(self, code=1000, reason=None):
        if code == server_module.IDLE_CLOSE_CODE:
            stuck.append(True)
            await asyncio.Event().wait()
        await real_close(self, code=code, reason=reason)

    monkeypatch.setattr(WebSocket, "close", never_finishes)
    monkeypatch.setattr(server_module, "CLOSE_FRAME_TIMEOUT_S", 0.2)
    caplog.set_level(logging.INFO, logger="skywave_radio")
    app = create_app(settings(idle_socket_minutes=0.005))  # 0.3 s
    with TestClient(app, client=PUBLIC).websocket_connect("/ws", headers=ORIGIN):
        started = time.monotonic()
        while "without a close frame" not in caplog.text:
            # gstack-timing-ok: a generous deadline on a poll; the contract is "given up on at all"
            assert time.monotonic() - started < 5, "the stuck idle close was never given up on"
            time.sleep(0.05)  # gstack-timing-ok: poll interval
        until_released(app)
    assert stuck == [True]


# Value: protects=a socket refused for too many connections whose client stopped reading is still dropped, so the refusing handler can't hang; fails_when=the refusal uses a bare ws.close; why_new=coverage audit: only the idle path pinned the bounded close; seam=starlette WebSocket.close patched to hang on the too-many code (test-only), CLOSE_FRAME_TIMEOUT_S shortened; no_claim=real TCP buffers
def test_a_refused_socket_that_stopped_reading_is_still_dropped(monkeypatch, caplog):
    import logging

    from starlette.websockets import WebSocket

    from skywave_radio import server as server_module

    real_close = WebSocket.close
    stuck = []

    async def never_finishes(self, code=1000, reason=None):
        if code == server_module.TOO_MANY_SOCKETS_CODE:
            stuck.append(True)
            await asyncio.Event().wait()
        await real_close(self, code=code, reason=reason)

    monkeypatch.setattr(WebSocket, "close", never_finishes)
    monkeypatch.setattr(server_module, "CLOSE_FRAME_TIMEOUT_S", 0.2)
    caplog.set_level(logging.INFO, logger="skywave_radio")
    app = create_app(settings(max_sockets_per_ip=1))
    client = TestClient(app, client=PUBLIC)
    with client.websocket_connect("/ws", headers=ORIGIN):
        with client.websocket_connect("/ws", headers=ORIGIN):
            started = time.monotonic()
            while "without a close frame" not in caplog.text:
                # gstack-timing-ok: a generous deadline on a poll; the contract is "given up on at all"
                assert time.monotonic() - started < 5, "the stuck refusal was never given up on"
                time.sleep(0.05)  # gstack-timing-ok: poll interval
    until_released(app)
    assert stuck == [True]


# Value: protects=one address can hold at most MAX_SOCKETS_PER_IP browser sockets: the next is refused with the too-many code, and closing one frees room, so a script can't exhaust the service by keeping sockets alive; fails_when=sockets aren't counted per address, the count isn't released on close, or the refusal uses a code the page can't explain; why_new=owner D3 (round 3a): the idle timeout alone doesn't stop chatty scripts; seam=TestClient's client address (a public one); no_claim=real proxy address handling
@pytest.mark.timeout(15)
def test_one_address_can_hold_only_so_many_sockets():
    from skywave_radio.server import TOO_MANY_SOCKETS_CODE

    app = create_app(settings(max_sockets_per_ip=2))
    client = TestClient(app, client=PUBLIC)
    expected = EXPECTED
    with client.websocket_connect("/ws", headers=ORIGIN) as first:
        with client.websocket_connect("/ws", headers=ORIGIN) as second:
            with client.websocket_connect("/ws", headers=ORIGIN) as third:
                refused = third.receive()
            assert refused["type"] == "websocket.close" and refused["code"] == TOO_MANY_SOCKETS_CODE
            second.send_text("not json")
            assert json.loads(second.receive_text()) == expected  # the first two still work
        # Closing one frees room for another.
        started = time.monotonic()
        while app.state.open_sockets.get(PUBLIC[0], 0) > 1:
            assert time.monotonic() - started < 5, "the closed socket was never released"  # gstack-timing-ok: poll deadline
            time.sleep(0.02)
        with client.websocket_connect("/ws", headers=ORIGIN) as again:
            again.send_text("not json")
            assert json.loads(again.receive_text()) == expected
        first.send_text("not json")
        assert json.loads(first.receive_text()) == expected
    until_released(app)


# Value: protects=addresses that aren't a real user's (private, loopback, TestClient's name) are never counted, so behind a proxy the service doesn't trust every listener isn't squeezed into one shared limit; fails_when=the cap counts raw addresses; why_new=owner D4 (red team: an untrusted proxy turned the cap into a site-wide lockout); seam=TestClient's client address; no_claim=real proxies
@pytest.mark.parametrize("address", ["testclient", "172.17.0.1", "10.0.0.5", "127.0.0.1", "100.64.0.1"])
def test_only_public_addresses_are_counted(address):
    app = create_app(settings(max_sockets_per_ip=1))
    client = TestClient(app, client=(address, 50000))
    with client.websocket_connect("/ws", headers=ORIGIN) as first:
        with client.websocket_connect("/ws", headers=ORIGIN) as second:
            for ws in (first, second):
                ws.send_text("not json")
                assert json.loads(ws.receive_text()) == EXPECTED
            assert app.state.open_sockets == {}


# Value: protects=the cap's owner key: a public IPv4 as is, IPv6 grouped by /64 (a user can pick any address in theirs), an IPv4-mapped IPv6 as its IPv4, and anything not public uncounted; fails_when=IPv6 is keyed per address, or private/unknown addresses are counted; why_new=owner D3/D4 (round 3a review); seam=none; no_claim=real client address formats beyond these
@pytest.mark.parametrize(
    ("host", "owner"),
    [
        ("1.2.3.4", "1.2.3.4"),
        ("2001:4860:4860::8888", "2001:4860:4860::/64"),
        ("2001:4860:4860:0:abcd::1", "2001:4860:4860::/64"),
        ("::ffff:1.2.3.4", "1.2.3.4"),
        ("172.17.0.1", None),
        ("100.64.0.1", None),
        ("fe80::1", None),
        ("::1", None),
        ("testclient", None),
        ("", None),
        (None, None),
    ],
)
def test_socket_owner(host, owner):
    from skywave_radio.server import socket_owner

    assert socket_owner(host) == owner


# Value: protects=two IPv6 addresses in one /64 share the cap, so rotating addresses can't get past it, while another /64 is a separate user; fails_when=IPv6 is counted per exact address; why_new=owner D3 (security review: IPv6 rotation); seam=TestClient's client address; no_claim=real IPv6 allocation sizes
@pytest.mark.timeout(15)
def test_an_ipv6_client_is_counted_by_its_64():
    from skywave_radio.server import TOO_MANY_SOCKETS_CODE

    app = create_app(settings(max_sockets_per_ip=1))
    with TestClient(app, client=("2001:4860:4860::1", 50000)).websocket_connect("/ws", headers=ORIGIN):
        with TestClient(app, client=("2001:4860:4860::2", 50000)).websocket_connect("/ws", headers=ORIGIN) as same:
            refused = same.receive()
        assert refused["type"] == "websocket.close" and refused["code"] == TOO_MANY_SOCKETS_CODE
        with TestClient(app, client=("2001:4860:4861::1", 50000)).websocket_connect("/ws", headers=ORIGIN) as other:
            other.send_text("not json")
            assert json.loads(other.receive_text()) == EXPECTED
    until_released(app)


# Value: protects=an idle-closed socket frees its place before its close frame goes out, so the page's immediate reconnect (a resent Listen) isn't refused at the cap while the old socket's cleanup still runs; fails_when=the count is released only after session.close(), or the old socket's cleanup releases a second time; why_new=testing review: the crossed-tune resend could hit the cap; seam=ListenSession.close slowed (test-only); no_claim=real network timing
@pytest.mark.timeout(15)
def test_an_idle_closed_socket_frees_its_place_for_the_reconnect(monkeypatch):
    from skywave_radio.server import IDLE_CLOSE_CODE
    from skywave_radio.session import ListenSession

    real_close = ListenSession.close

    async def slow_close(self):
        await asyncio.sleep(1.0)  # gstack-timing-ok: a cleanup still running when the page reconnects
        await real_close(self)

    monkeypatch.setattr(ListenSession, "close", slow_close)
    app = create_app(settings(idle_socket_minutes=0.01, max_sockets_per_ip=1))  # 0.6 s
    client = TestClient(app, client=PUBLIC)
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        closed, _ = until_closed(ws)
        assert closed["code"] == IDLE_CLOSE_CODE
        with client.websocket_connect("/ws", headers=ORIGIN) as again:  # at once, as the page does
            again.send_text("not json")
            assert json.loads(again.receive_text()) == EXPECTED
            # Once the old socket's slow cleanup ends, it hasn't released a second time and
            # taken the reconnect's place: the address still counts exactly one socket.
            for _ in range(7):  # 1.4 s, outlasting the slowed close; chatter keeps this one open
                time.sleep(0.2)  # gstack-timing-ok: spaces the messages inside the idle time; the assert checks the count
                again.send_text("not json")
                assert json.loads(again.receive_text()) == EXPECTED
            assert app.state.open_sockets == {PUBLIC[0]: 1}


# Value: protects=cancelling a socket's handler while it waits for serve() to unwind still closes the session, so the volunteer's Kiwi channel and the listener slot are freed at once, not when a blocked audio send finally times out; fails_when=session.close() runs in the cancellable handler itself; why_new=owner D1 (round 3a review: security + state machines); seam=a public client address (so its socket is counted and must be released) and the ASGI app driven directly on this test's loop (TestClient's loop shuts down when the handler ends, cancelling the pump either way), a browser whose binary sends block, and ListenSession.handle patched with a request that cancels the handler and unwinds slowly (test-only); no_claim=what cancels a handler in production (uvicorn only at shutdown)
@pytest.mark.timeout(20)
def test_cancelling_the_handler_mid_cleanup_still_ends_the_session(monkeypatch):
    from skywave_radio.session import ListenSession

    handler: dict[str, asyncio.Task] = {}
    real_handle = ListenSession.handle

    async def handle(self, msg):
        if msg.get("type") != "hang":
            return await real_handle(self, msg)
        handler["task"].cancel()  # the handler starts its cleanup...
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            handler["task"].cancel()  # ...and is cancelled again while it waits on serve()
            await asyncio.sleep(0.3)  # gstack-timing-ok: serve() unwinding slowly
            raise

    monkeypatch.setattr(ListenSession, "handle", handle)

    async def main():
        async with FakeKiwi() as kiwi:
            app = create_app(settings())
            inbox: asyncio.Queue = asyncio.Queue()
            listening = asyncio.Event()
            stuck = asyncio.Event()

            async def send(message):
                if message["type"] == "websocket.send" and message.get("bytes") is not None and stuck.is_set():
                    await asyncio.Event().wait()  # the browser stopped reading: audio sends block
                if '"listening"' in (message.get("text") or ""):
                    listening.set()

            scope = {
                "type": "websocket", "path": "/ws", "raw_path": b"/ws", "root_path": "", "query_string": b"",
                "headers": [(b"origin", ORIGIN["origin"].encode())], "scheme": "ws", "subprotocols": [],
                "client": PUBLIC, "server": ("testserver", 80),
            }
            await inbox.put({"type": "websocket.connect"})
            await inbox.put({"type": "websocket.receive", "text": tune_msg(kiwi.port)})
            handler["task"] = asyncio.create_task(app(scope, inbox.get, send))
            await asyncio.wait_for(listening.wait(), 5)
            stuck.set()
            await inbox.put({"type": "websocket.receive", "text": json.dumps({"type": "hang"})})
            with pytest.raises(asyncio.CancelledError):
                await handler["task"]  # cancelled, as staged
            started = time.monotonic()
            while app.state.slots.active or kiwi._open_snd() or app.state.open_sockets:
                # gstack-timing-ok: a poll deadline well inside the 15 s send timeout that would free it anyway
                assert time.monotonic() - started < 3, "the cancelled handler left the session or its count behind"
                await asyncio.sleep(0.05)

    asyncio.run(main())


# Value: protects=the service and the page agree on the too-many-sockets close code, so a refused socket shows its own explanation, not "Lost the connection"; fails_when=one side changes the number; why_new=new close code; seam=none; no_claim=browser close-code handling
def test_web_and_service_agree_on_the_too_many_sockets_code():
    import re
    from pathlib import Path

    from skywave_radio.server import TOO_MANY_SOCKETS_CODE

    web = Path(__file__).resolve().parents[3] / "apps/web/src/lib/use-radio.ts"
    found = re.search(r"TOO_MANY_SOCKETS_CODE = (\d+);", web.read_text())
    assert found and int(found.group(1)) == TOO_MANY_SOCKETS_CODE


# Value: protects=a socket whose session is playing is never closed as idle, however long it plays without a message from the browser; fails_when=the idle clock runs during playback; why_new=new idle timeout; seam=none; no_claim=hours-long sessions
@pytest.mark.timeout(15)
def test_a_playing_session_is_not_closed_as_idle():
    def body(kiwi):
        client = TestClient(create_app(settings(idle_socket_minutes=0.005)))  # 0.3 s
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            started = time.monotonic()
            frames = 0
            # gstack-timing-ok: the contract is "still streaming well past the idle time"
            while time.monotonic() - started < 1.0:
                msg = ws.receive()
                assert msg["type"] != "websocket.close", "closed while playing"
                frames += msg.get("bytes") is not None
        return frames

    assert run_with_fake(body) > 0


# Value: protects=a scan sent with nothing playing is refused and starts nothing, so the socket still idles out; fails_when=a refused scan clears idle_since or starts a pump; why_new=state matrix no_pump x scan; seam=none; no_claim=none beyond protects
@pytest.mark.timeout(15)
def test_a_scan_with_nothing_playing_still_lets_the_socket_idle_out():
    from skywave_radio.server import IDLE_CLOSE_CODE

    client = TestClient(create_app(settings(idle_socket_minutes=0.005)))  # 0.3 s
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(scan_msg(4))
        reply = until_scan(ws, "error")[-1]
        closed, _ = until_closed(ws)
    assert reply["message"] == "Start listening to a receiver first."
    assert closed["code"] == IDLE_CLOSE_CODE


# Value: protects=a scan while playing, and the playing after it, run past the idle time without an idle close; fails_when=the scan or its waterfall marks the session idle; why_new=state matrix pump_running x scan; seam=none; no_claim=real sweep timing
@pytest.mark.timeout(20)
def test_a_scan_while_playing_is_not_closed_as_idle():
    def body(kiwi):
        client = TestClient(create_app(settings(idle_socket_minutes=0.005)))  # 0.3 s
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(5))
            replies = until_scan(ws, "done", "error")
            started = time.monotonic()
            # gstack-timing-ok: the contract is "still open well past the idle time after the scan"
            while time.monotonic() - started < 1.0:
                msg = ws.receive()
                assert msg["type"] != "websocket.close", "closed as idle after a scan"
        return replies[-1]

    assert run_with_fake(body, wf_bins=carrier_bins(9_420.0))["state"] == "done"


# Value: protects=switching receivers while playing, past the idle time, never closes the socket as idle (the old pump marks the session idle only for the instant before the new one starts); fails_when=the switch leaves idle_since set, or the old pump's end marks a playing session idle; why_new=state matrix playing x switch; seam=none (two names for the one fake Kiwi make two receivers); no_claim=real Kiwi switch timing
@pytest.mark.timeout(15)
def test_switching_receivers_is_not_an_idle_close():
    def body(kiwi):
        client = TestClient(create_app(settings(idle_socket_minutes=0.005)))  # 0.3 s
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, host="127.0.0.1"))
            until_state(ws, "listening")
            time.sleep(0.4)  # play past the idle time
            ws.send_text(tune_msg(kiwi.port, host="localhost"))  # another receiver to the session
            seen = until_state(ws, "listening")
            started = time.monotonic()
            # gstack-timing-ok: the contract is "still open well past the idle time after the switch"
            while time.monotonic() - started < 1.0:
                msg = ws.receive()
                assert msg["type"] != "websocket.close", "closed as idle after a switch"
        return seen[-1]

    assert run_with_fake(body)["host"] == "localhost"


# Value: protects=the idle clock starts when the session ends (not when the socket opened), and the socket then closes; fails_when=the clock counts playback time, closing at once on Stop, or never starts after a session ends; why_new=new idle timeout; seam=none; no_claim=real browser timing
@pytest.mark.timeout(15)
def test_the_idle_clock_starts_when_the_session_ends():
    from skywave_radio.server import IDLE_CLOSE_CODE

    def body(kiwi):
        client = TestClient(create_app(settings(idle_socket_minutes=0.02)))  # 1.2 s
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            time.sleep(1.4)  # play past the idle time
            ws.send_text(json.dumps({"type": "stop"}))
            until_state(ws, "stopped")
            stopped = time.monotonic()
            closed, _ = until_closed(ws)
            return closed, time.monotonic() - stopped

    closed, after = run_with_fake(body)
    assert closed["code"] == IDLE_CLOSE_CODE
    # gstack-timing-ok: the bound is the contract (the clock restarts at the session's end); half the
    # idle time leaves room for the client's lag behind the server
    assert after >= 0.6


# Value: protects=when a session ends on its own (the limit, a Kiwi drop) with no message from the browser, the idle clock starts at that end, so the socket gets a full idle period after it; fails_when=serve() counts only from the last browser message (the tune), closing early; why_new=owner D1 (round 3a coverage audit): the Stop test's own message masked this; seam=none; no_claim=real Kiwi drop timing
@pytest.mark.timeout(15)
def test_a_session_that_ends_on_its_own_starts_the_idle_clock():
    from skywave_radio.server import IDLE_CLOSE_CODE

    def body(kiwi):
        app = create_app(settings(idle_socket_minutes=0.04, max_session_minutes=0.02))  # idle 2.4 s, limit 1.2 s
        with TestClient(app).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "stopped")  # the limit ends it, with no browser message since the tune
            ended = time.monotonic()
            closed, _ = until_closed(ws)
            return closed, time.monotonic() - ended

    closed, after = run_with_fake(body)
    assert closed["code"] == IDLE_CLOSE_CODE
    # gstack-timing-ok: the bound is the contract (a full 2.4 s idle period after the session's own
    # end; counting from the tune instead would close about 1.2 s after it), 0.6 s of slack either way
    assert after >= 1.8


# Value: protects=any message from the browser restarts the idle clock, so a page that keeps talking isn't hung up on; fails_when=the clock ignores messages; why_new=new idle timeout; seam=none; no_claim=which messages real pages send
@pytest.mark.timeout(15)
def test_messages_keep_an_idle_socket_open():
    from skywave_radio.server import IDLE_CLOSE_CODE

    client = TestClient(create_app(settings(idle_socket_minutes=0.005)))  # 0.3 s
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        for _ in range(6):  # 0.6 s of chatter, twice the idle time
            # gstack-timing-ok: the sleep spaces the messages past the idle time; the assert checks the reply
            time.sleep(0.1)
            ws.send_text("not json")
            assert json.loads(ws.receive_text()) == {"type": "status", "state": "error", "message": "Expected JSON."}
        closed, _ = until_closed(ws)
    assert closed["code"] == IDLE_CLOSE_CODE


# Value: protects=the service and the page agree on the idle close code, so an idle hang-up never shows "Lost the connection"; fails_when=one side changes the number; why_new=new close code; seam=none; no_claim=browser close-code handling
def test_web_and_service_agree_on_the_idle_close_code():
    import re
    from pathlib import Path

    from skywave_radio.server import IDLE_CLOSE_CODE

    web = Path(__file__).resolve().parents[3] / "apps/web/src/lib/use-radio.ts"
    found = re.search(r"IDLE_CLOSE_CODE = (\d+);", web.read_text())
    assert found and int(found.group(1)) == IDLE_CLOSE_CODE


# Value: protects=a Kiwi that stops reading ends the session with 'stopped reading' and frees the slot, even though closing its socket would block too; fails_when=close() waits on the full socket with no bound, or the send timeout doesn't end the session; why_new=only _send was tested, against a stub with no close(); seam=KiwiClient._ws (a socket whose sends and close never finish); no_claim=real TCP buffer sizes
@pytest.mark.timeout(15)
def test_kiwi_that_stops_reading_ends_the_session_and_frees_the_slot():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1), client_factory=partial(_StopsReading, timeout_s=0.5)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            statuses = until_state(ws, "error", "stopped")
            # The status goes out only once the slot is free.
            assert client.get("/healthz").json()["listeners"] == 0
        return statuses

    statuses = run_with_fake(body)
    assert statuses[-1]["code"] == "timeout"
    assert "stopped reading" in statuses[-1]["message"]


# Value: protects=a tune for the same receiver while the ended session is still closing starts over and answers; fails_when=it takes the same-receiver retune path on the dead client and the browser hears nothing; why_new=red team found the closing window answered nothing; seam=KiwiClient._ws (a socket whose sends and close never finish); no_claim=real close timing
@pytest.mark.timeout(15)
def test_tune_while_the_ended_session_closes_starts_over():
    def body(kiwi):
        client = TestClient(create_app(settings(), client_factory=partial(_StopsReading, timeout_s=0.5)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "error", "stopped")
            # close() now waits up to CLOSE_TIMEOUT_S on the full socket.
            ws.send_text(tune_msg(kiwi.port))
            return until_state(ws, "listening", "error")

    statuses = run_with_fake(body)
    assert [s["state"] for s in statuses] == ["connecting", "listening"]


def test_listen_end_to_end():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            statuses, audio, spectra = collect(ws)
            ws.send_text(json.dumps({"type": "stop"}))
            stopped = until_state(ws, "stopped")
        return kiwi, statuses, audio, spectra, stopped, client.get("/healthz").json()

    kiwi, statuses, audio, spectra, stopped, health = run_with_fake(body, tone_hz=1000)
    # listening x stop: the session says so and gives its slot back.
    assert stopped[-1]["message"] == "Stopped."
    assert health["listeners"] == 0
    states = [s["state"] for s in statuses if s["type"] == "status"]
    assert states[:2] == ["connecting", "listening"]
    listening = next(s for s in statuses if s.get("state") == "listening")
    assert listening["sampleRate"] == 12000.0
    assert any(s["type"] == "meter" for s in statuses)
    # Value: protects=the session sends encode_audio's int16 under tag 3; fails_when=session.py sends float32 bytes (or rescales) under the int16 tag; why_new=the dtype check was true of any bytes read as <i2; seam=none; no_claim=what the browser plays
    assert [len(a) for a in audio] == [BLOCK] * len(audio)
    assert max(int(np.abs(a.astype(np.int32)).max()) for a in audio) > 1000
    assert len(spectra[0]) == 512
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=7200.000" in kiwi.commands


def test_cw_offsets_kiwi_frequency():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, 7030, "cw"))
            collect(ws, want_audio=1, want_spectrum=0)
        return kiwi

    kiwi = run_with_fake(body)
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=7029.300" in kiwi.commands


def test_retune_reuses_connection():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            tune = {"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 7200, "mode": "lsb"}
            ws.send_text(json.dumps(tune))
            collect(ws, want_audio=2, want_spectrum=0)
            ws.send_text(json.dumps({**tune, "freqKhz": 7185, "mode": "usb"}))
            collect(ws, want_audio=5, want_spectrum=0)
        return kiwi

    kiwi = run_with_fake(body)
    assert len(kiwi.paths) == 1
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=7185.000" in kiwi.commands


def test_bad_origin_rejected():
    assert_rejected(create_app(settings()), headers={"origin": "https://evil.example"})


# Value: protects=a socket refused for its origin from a public address is never counted, so bad requests can't use up an address's places; fails_when=the count is taken before the origin/token checks; why_new=state matrix counted owner x origin reject; seam=TestClient's client address; no_claim=none beyond protects
def test_a_refused_origin_is_never_counted():
    app = create_app(settings(max_sockets_per_ip=1))
    with pytest.raises(WebSocketDisconnect) as e:
        with TestClient(app, client=PUBLIC).websocket_connect("/ws", headers={"origin": "https://evil.example"}):
            pass
    assert e.value.code == status.WS_1008_POLICY_VIOLATION
    assert app.state.open_sockets == {}


def test_malformed_origin_port_closes_with_policy_violation():
    assert_rejected(create_app(settings()), headers={"origin": "http://localhost:99999"})


@pytest.mark.parametrize(
    ("origin", "ok"),
    [
        ("http://localhost:3000", True),
        ("http://127.0.0.1:3000", True),
        ("http://[::1]:3000", True),
        ("http://127.0.0.1:3001", False),
        ("https://127.0.0.1:3000", False),
        ("http://evil.localhost.example:3000", False),
        (None, False),
        # Malformed headers are refused, never an exception in the handler.
        ("http://localhost:99999", False),
        ("http://localhost:abc", False),
        ("http://[::1", False),
    ],
)
def test_loopback_names_are_interchangeable(origin, ok):
    assert origin_allowed(origin, ("http://localhost:3000",)) is ok


# Value: protects=a session limit that would end every session at once (nan, a decimal typo under 1 minute) or silently mean no limit (a number that overflows to inf) stops the service at startup instead; fails_when=MAX_SESSION_MINUTES is read with a bare float() again; why_new=review (red team): asyncio.timeout(nan) fires immediately; seam=none; no_claim=other settings' validation
@pytest.mark.parametrize("raw", ["nan", "0", "-5", "sixty", "0.001", "1e309", "1e308"])
def test_a_session_limit_that_cannot_work_stops_startup(raw, monkeypatch):
    monkeypatch.setenv("MAX_SESSION_MINUTES", raw)
    with pytest.raises(ValueError, match="MAX_SESSION_MINUTES"):
        Settings.from_env()


# Value: protects=an idle-socket timeout that would hang up on every page at once (nan, a decimal typo under 1 minute) or silently never fire (an overflow) stops startup; usable values pass; fails_when=IDLE_SOCKET_MINUTES is read with a bare float(); why_new=new setting; seam=none; no_claim=other settings
@pytest.mark.parametrize(("raw", "ok"), [("nan", False), ("0.5", False), ("1e308", False), ("ten", False), ("1", True), ("inf", True)])
def test_the_idle_socket_timeout_is_checked_at_startup(raw, ok, monkeypatch):
    monkeypatch.setenv("IDLE_SOCKET_MINUTES", raw)
    if ok:
        assert Settings.from_env().idle_socket_minutes == float(raw)
    else:
        with pytest.raises(ValueError, match="IDLE_SOCKET_MINUTES"):
            Settings.from_env()


# Value: protects=a per-address socket cap that would refuse every page (0, negative) or isn't a whole number stops startup; usable values pass; fails_when=MAX_SOCKETS_PER_IP is read with a bare int() or allows 0; why_new=new setting; seam=none; no_claim=other settings
@pytest.mark.parametrize(("raw", "ok"), [("0", False), ("-3", False), ("2.5", False), ("lots", False), ("1", True), ("8", True)])
def test_the_socket_cap_is_checked_at_startup(raw, ok, monkeypatch):
    monkeypatch.setenv("MAX_SOCKETS_PER_IP", raw)
    if ok:
        assert Settings.from_env().max_sockets_per_ip == int(raw)
    else:
        with pytest.raises(ValueError, match="MAX_SOCKETS_PER_IP"):
            Settings.from_env()


# Value: protects=the shipped apps/radio/.env.example starts the service (every value it sets passes the startup checks); fails_when=an example value, e.g. MAX_SESSION_MINUTES, stops validating; why_new=MAX_SESSION_MINUTES gained a startup check; seam=none; no_claim=values left commented out
def test_the_example_env_file_is_valid(monkeypatch):
    from pathlib import Path

    example = Path(__file__).resolve().parents[3] / "apps/radio/.env.example"
    for line in example.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            name, _, value = line.partition("=")
            monkeypatch.setenv(name.strip(), value.strip())
    assert Settings.from_env().max_session_minutes == 60
    assert Settings.from_env().idle_socket_minutes == 10
    assert Settings.from_env().max_sockets_per_ip == 8


# Value: protects=the limits an operator may set (exactly 1 minute, and inf spelled any way the check allows) still start the service; fails_when=the floor creeps above 1 or the inf spelling check narrows; why_new=review: only far-from-the-floor values were accepted in tests; seam=none; no_claim=how long real sessions run
@pytest.mark.parametrize(
    ("raw", "minutes"),
    [("1", 1.0), ("inf", float("inf")), ("Infinity", float("inf")), ("+inf", float("inf")), (" inf ", float("inf"))],
)
def test_a_usable_session_limit_is_allowed(raw, minutes, monkeypatch):
    monkeypatch.setenv("MAX_SESSION_MINUTES", raw)
    assert Settings.from_env().max_session_minutes == minutes


def test_loopback_equivalence_does_not_extend_public_origins():
    assert not origin_allowed("http://127.0.0.1:443", ("https://radio.example",))


def test_127_origin_accepted_end_to_end():
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:3000"}) as ws:
            ws.send_text(json.dumps({"type": "stop"}))
            assert json.loads(ws.receive_text())["state"] == "stopped"


def test_empty_origin_list_refuses_everyone(caplog):
    app = create_app(settings(allowed_origins=()))
    assert "every connection will be refused" in caplog.text
    assert_rejected(app)


@pytest.mark.parametrize(
    "origins",
    [("https://radio.example",), ("*",), ("http://localhost:3000", "https://radio.example")],
)
def test_public_origin_requires_token(origins):
    with pytest.raises(RuntimeError, match="RADIO_TOKEN"):
        create_app(settings(allowed_origins=origins))


def test_public_origin_with_token_starts():
    create_app(settings(allowed_origins=("https://radio.example",), token="secret"))


@pytest.mark.parametrize("supplied", ["", "wrong", "s%C3%A9cret"])
def test_wrong_token_rejected(supplied):
    assert_rejected(create_app(settings(token="secret")), path=f"/ws?token={supplied}")


def test_right_token_accepted():
    client = TestClient(create_app(settings(token="secret")))
    with client.websocket_connect("/ws?token=secret", headers=ORIGIN) as ws:
        ws.send_text("not json")
        assert json.loads(ws.receive_text())["message"] == "Expected JSON."


def test_binary_frame_gets_expected_json():
    client = TestClient(create_app(settings()))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_bytes(b"\x00\x01")
        assert json.loads(ws.receive_text())["message"] == "Expected JSON."
        # The session is still alive and handling tunes.
        ws.send_text(tune_msg(8073, 99999, "am", host="x.org"))
        assert "between 0 and 32,000" in json.loads(ws.receive_text())["message"]


def test_private_host_blocked_by_default():
    client = TestClient(create_app(settings(allow_private_hosts=False)))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(tune_msg(8073, 9535, "am"))
        statuses = [json.loads(ws.receive_text()) for _ in range(2)]
    assert statuses[-1]["state"] == "error"
    assert "non-public" in statuses[-1]["message"]
    # The browser's Pick best skips to the next receiver on these codes.
    assert statuses[-1]["code"] == "blocked"
    assert (statuses[-1]["host"], statuses[-1]["port"]) == ("127.0.0.1", 8073)


def test_validation_errors():
    client = TestClient(create_app(settings()))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(tune_msg(8073, 99999, "am", host="x.org"))
        assert "between 0 and 32,000" in json.loads(ws.receive_text())["message"]
        ws.send_text(tune_msg(8073, 7000, "fm", host="x.org"))
        assert "Mode must be" in json.loads(ws.receive_text())["message"]
        # Numbers too big for int()/float() are bad requests, not crashes.
        ws.send_text('{"type": "tune", "host": "x.org", "port": 1e999, "freqKhz": 7000}')
        assert "needs host, port and freqKhz" in json.loads(ws.receive_text())["message"]
        ws.send_text(tune_msg(8073, 10**400, host="x.org"))
        assert "needs host, port and freqKhz" in json.loads(ws.receive_text())["message"]


def test_listener_limit_counts_receiver_connections():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws1:
            ws1.send_text(tune_msg(kiwi.port))
            until_state(ws1, "listening")
            # A second socket connects fine; it's the tune that needs a slot.
            with client.websocket_connect("/ws", headers=ORIGIN) as ws2:
                ws2.send_text(tune_msg(kiwi.port))
                return until_state(ws2, "error", "listening")

    statuses = run_with_fake(body)
    assert statuses[-1]["state"] == "error"
    assert "listener limit" in statuses[-1]["message"]


def test_slot_freed_when_session_hits_time_limit():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1, max_session_minutes=0.005)))  # 0.3 s
        with client.websocket_connect("/ws", headers=ORIGIN) as ws1:
            ws1.send_text(tune_msg(kiwi.port))
            first = until_state(ws1, "stopped", "error")
            # ws1 stays open on "Stopped"; it must not keep the only slot.
            # "Stopped" goes out only after the Kiwi has closed and the slot
            # is free, so a new listener can tune at once.
            with client.websocket_connect("/ws", headers=ORIGIN) as ws2:
                ws2.send_text(tune_msg(kiwi.port))
                second = until_state(ws2, "listening", "error")
        return first, second

    first, second = run_with_fake(body)
    assert first[-1]["state"] == "stopped"
    assert "session limit" in first[-1]["message"]
    assert second[-1]["state"] == "listening"


def _held_close_client(end: str, closing: asyncio.Event, closed: asyncio.Event):
    """A fake Kiwi whose close() waits until the test sets `closed`.

    `end` picks how the session ends: "limit" sends empty blocks until a
    zero-minute limit stops it, "error" fails mid-stream, "stop" streams nothing
    until the listener stops.
    """
    from types import SimpleNamespace

    from skywave_radio.kiwi import KiwiError, KiwiInfo

    class HeldClose:
        def __init__(self, host, port, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)
            self._open = True

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            if end == "error":
                raise KiwiError("timeout", "a.example stopped sending audio")
            if end == "stop":
                await asyncio.Event().wait()
            while True:
                yield SimpleNamespace(samples=np.empty(0))
                await asyncio.sleep(0)

        def abort(self):
            self.aborted = True

        async def close(self):
            # Unlike KiwiClient (whose second close waits for the first), a
            # second close here returns at once.
            if not self._open:
                return
            self._open = False
            closing.set()
            await closed.wait()

    return HeldClose


async def _resolve_any(host, port, **kwargs):
    return "127.0.0.1"


async def _ignore(_):
    pass


# Value: protects=a session keeps its listener slot until the Kiwi connection has closed, whether it hit its time limit, was stopped or failed; fails_when=any end path releases the slot before close() finishes, so the service can go one connection over its limit on volunteers' Kiwis; why_new=the slot-freed test only checks the slot frees eventually; seam=none; no_claim=real close timing (close() is held open by hand)
@pytest.mark.parametrize("end", ["limit", "stop", "error"])
async def test_slot_stays_held_until_the_kiwi_connection_closes(end):
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    slots = Slots(1)
    session = ListenSession(
        settings(max_session_minutes=0 if end == "limit" else 60),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client(end, closing, closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    stopping = None
    if end == "stop":
        while not session._listening:
            await asyncio.sleep(0.01)
        stopping = asyncio.create_task(session.handle({"type": "stop"}))
    await asyncio.wait_for(closing.wait(), timeout=5)
    # The session has ended, but the volunteer's channel is still closing.
    assert slots.active == 1
    closed.set()
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)
    if stopping is not None:
        await stopping
    await session.close()


# Value: protects=a receiver switch cancelled while the old Kiwi closes keeps the slot until that connection has ended, and frees it exactly once; fails_when=the cancelled switch releases at once (another listener takes the slot over a still-open channel) or twice; why_new=the cancel-mid-switch test checked only the final count; seam=none; no_claim=real close timing (close() is held open by hand)
@pytest.mark.parametrize("old_close", ["cancelled", "finishes"])
async def test_cancelled_switch_keeps_the_slot_until_the_old_kiwi_closes(old_close, caplog):
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    slots = Slots(1)
    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", closing, closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    # What server.py does: serve() handles a switch, the browser leaves, serve() is cancelled.
    serving = asyncio.create_task(
        session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
    )
    await asyncio.wait_for(closing.wait(), timeout=5)  # the switch waits on a.example's close()
    serving.cancel()
    await asyncio.wait({serving})
    # Another listener must not get the slot while a.example's channel is open.
    assert slots.active == 1
    assert not slots.try_acquire()
    if old_close == "finishes":
        closed.set()  # the old close completes on its own first
    # The handler's finally: closing the session cancels a still-closing pump.
    await session.close()
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert slots.active == 0
    assert "released with none held" not in caplog.text


# Value: protects=a switch or Stop whose old Kiwi close() fails frees the slot exactly once, closes the waterfall before the slot frees, and tells the listener with an error status instead of dropping the socket; fails_when=the except branch skips releasing for an already-ended pump, releases twice, or the error escapes handle(); why_new=the cancelled-switch test only covers a pump still closing; seam=none; no_claim=what real close failures look like (close() raises by hand)
@pytest.mark.parametrize("action", ["switch", "stop"])
async def test_switch_whose_old_close_fails_frees_the_slot_once(action, caplog):
    from skywave_radio.kiwi import KiwiInfo
    from skywave_radio.session import ListenSession, Slots

    made = []

    class BrokenClose:
        def __init__(self, host, port, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)
            made.append(port)

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            await asyncio.Event().wait()
            yield

        async def close(self):
            raise RuntimeError("close broke")

    sent = []

    async def send_text(payload):
        sent.append(payload)

    slots = Slots(1)
    session = ListenSession(
        settings(), send_text, _ignore, slots=slots, resolver=_resolve_any, client_factory=BrokenClose
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    waterfall = _RecordingWaterfall(slots)
    session._waterfall = waterfall  # a scan's paired waterfall on the same channel
    # The old pump ends with close()'s error, so stop() re-raises it with the
    # pump already done; handle() reports it instead of dropping the socket.
    if action == "switch":
        await session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
    else:
        await session.handle({"type": "stop"})
    assert sent[-1]["state"] == "error"
    assert "Something broke" in sent[-1]["message"]
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert slots.active == 0
    assert made == [8073]
    # The failed close didn't skip the waterfall, and it closed before the slot freed.
    assert waterfall.active_at_close == [1]
    assert "released with none held" not in caplog.text
    assert slots.try_acquire()


class _RecordingWaterfall:
    """A scan waterfall that notes how many slots were held when it closed."""

    def __init__(self, slots, closed: asyncio.Event | None = None):
        self._slots = slots
        self._closed = closed
        self.closing = asyncio.Event()
        self.active_at_close = []

    async def close(self):
        self.active_at_close.append(self._slots.active)
        self.closing.set()
        if self._closed is not None:
            await self._closed.wait()


# Value: protects=the slot stays taken until a scan's waterfall (it shares the audio's Kiwi channel) has closed, even when the session closing cancels the old pump mid-close; fails_when=a second cancel skips _end_scan in the pump's finally, so the slot frees while the waterfall is still open; why_new=no slot test had a scan waterfall; seam=ListenSession._waterfall (set by hand instead of running a scan); no_claim=real waterfall close timing
async def test_slot_waits_for_the_scan_waterfall_to_close():
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    slots = Slots(1)
    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", closing, closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    waterfall_closed = asyncio.Event()
    waterfall = _RecordingWaterfall(slots, waterfall_closed)
    session._waterfall = waterfall
    serving = asyncio.create_task(
        session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
    )
    await asyncio.wait_for(closing.wait(), timeout=5)
    serving.cancel()
    await asyncio.wait({serving})
    # The session closing cancels the old pump again, in the middle of its close().
    closing_session = asyncio.create_task(session.close())
    await asyncio.wait_for(waterfall.closing.wait(), timeout=5)
    assert waterfall.active_at_close == [1]
    await asyncio.sleep(0.05)
    assert slots.active == 1  # the waterfall is still closing on the volunteer's Kiwi
    waterfall_closed.set()
    await asyncio.wait_for(closing_session, timeout=5)
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)


# Value: protects=the waterfall closes before the slot frees even when the session's second cancel lands while the old pump waits for its scan to stop; fails_when=_end_scan skips _drop_waterfall on a cancel during its scan cancels; why_new=the waterfall test only covered a cancel inside client.close(); seam=ListenSession._waterfall and ._scan (set by hand instead of running a scan); no_claim=real scan task timing
async def test_slot_waits_for_the_waterfall_when_cancelled_mid_scan_stop():
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    slots = Slots(1)
    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    scan_cancelled, scan_may_end = asyncio.Event(), asyncio.Event()

    async def slow_to_stop_scan():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            scan_cancelled.set()
            await scan_may_end.wait()
            raise

    session._scan = asyncio.create_task(slow_to_stop_scan())
    waterfall = _RecordingWaterfall(slots)
    session._waterfall = waterfall
    serving = asyncio.create_task(
        session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
    )
    await asyncio.wait_for(scan_cancelled.wait(), timeout=5)  # the old pump waits on its scan
    serving.cancel()
    await asyncio.wait({serving})
    closing_session = asyncio.create_task(session.close())
    await asyncio.sleep(0.05)
    # The pump waits for its scan to finish stopping before it ends.
    assert slots.active == 1
    scan_may_end.set()
    await asyncio.wait_for(waterfall.closing.wait(), timeout=5)
    assert waterfall.active_at_close == [1]
    await asyncio.wait_for(closing_session, timeout=5)
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)


# Value: protects=a session that hits its time limit or a receiver error says so only after its Kiwi has closed and its slot is free, so a reconnect on that status finds the slot; fails_when=the terminal status is sent before close() finishes or before the release; why_new=round 1 only checked the slot, and the order was the other way round; seam=none; no_claim=real close timing (close() is held open by hand)
@pytest.mark.parametrize("end", ["limit", "error"])
async def test_terminal_status_waits_for_the_close_and_the_free_slot(end):
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    slots = Slots(1)
    seen = []

    async def send_text(payload):
        if payload.get("type") == "status":
            seen.append((payload["state"], slots.active, payload.get("host")))

    session = ListenSession(
        settings(max_session_minutes=0 if end == "limit" else 60),
        send_text,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client(end, closing, closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    await asyncio.wait_for(closing.wait(), timeout=5)
    await asyncio.sleep(0.05)
    assert seen[-1][0] in ("connecting", "listening")  # nothing terminal while the Kiwi closes
    closed.set()
    async with asyncio.timeout(5):
        while seen[-1][0] in ("connecting", "listening"):
            await asyncio.sleep(0.01)
    state, active, host = seen[-1]
    assert state == ("stopped" if end == "limit" else "error")
    assert active == 0
    assert host == "a.example"  # still names the receiver it was about
    await session.close()


# Value: protects=a session that ends on its own (time limit) still tells the listener and frees its slot when closing its Kiwi fails; fails_when=a teardown error escapes before the status is sent; why_new=the terminal status now waits for teardown; seam=none; no_claim=which close errors happen (close() raises by hand)
async def test_a_failed_close_still_reports_how_the_session_ended(caplog):
    from skywave_radio.kiwi import KiwiInfo
    from skywave_radio.session import ListenSession, Slots

    class LimitThenBrokenClose:
        def __init__(self, host, port, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            await asyncio.Event().wait()
            yield

        async def close(self):
            raise RuntimeError("close broke")

    sent = []

    async def send_text(payload):
        sent.append(payload)

    slots = Slots(1)
    session = ListenSession(
        settings(max_session_minutes=0.005),
        send_text,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=LimitThenBrokenClose,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    async with asyncio.timeout(5):
        while not sent or sent[-1]["state"] != "stopped":
            await asyncio.sleep(0.01)
    assert "session limit" in sent[-1]["message"]
    assert slots.active == 0
    assert "close broke" in caplog.text
    await session.close()


# Value: protects=ending a session closes the audio and the scan's waterfall at the same time, so the listener's "Stopped" waits for the slower close, not both in turn; fails_when=teardown closes them one after the other (the status could lag by both close timeouts); why_new=the status now waits for teardown; seam=ListenSession._waterfall (set by hand instead of running a scan); no_claim=real close timing (both closes are held by hand)
async def test_audio_and_waterfall_close_together():
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    slots = Slots(1)
    session = ListenSession(
        settings(max_session_minutes=0),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("limit", closing, closed),
    )
    waterfall_closed = asyncio.Event()
    waterfall = _RecordingWaterfall(slots, waterfall_closed)
    original_run = session._run

    async def run_with_scan(*args, **kwargs):
        session._waterfall = waterfall  # a scan's waterfall is open when the session ends
        await original_run(*args, **kwargs)

    session._run = run_with_scan
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)
        # The audio close is still held, yet the waterfall is already closing too.
        await asyncio.wait_for(waterfall.closing.wait(), timeout=2)
        assert slots.active == 1
    finally:
        # Release both holds even on failure, so teardown can't hang.
        closed.set()
        waterfall_closed.set()
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)
    await session.close()


# Value: protects=the session limit ends a session even when the receiver stops sending; fails_when=the limit is only checked when a block arrives, so a quiet Kiwi keeps the channel until blocks() times out; why_new=every limit test streamed blocks; seam=none; no_claim=blocks()'s own silence timeout (the fake never times out)
async def test_session_limit_ends_a_session_whose_receiver_went_quiet():
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    slots = Slots(1)
    sent = []

    async def send_text(payload):
        sent.append(payload)

    session = ListenSession(
        settings(max_session_minutes=0.005),  # 0.3 s
        send_text,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),  # sends nothing
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    async with asyncio.timeout(5):
        while not sent or sent[-1]["state"] != "stopped":
            await asyncio.sleep(0.01)
    assert "session limit" in sent[-1]["message"]
    assert slots.active == 0
    await session.close()


# Value: protects=a scan cancelled mid-handshake closes its half-open waterfall (it joins the audio's channel) before the session's slot frees, even when the session closes during a cancelled switch; fails_when=the pump stops waiting for the scan on a second cancel, so it ends while that waterfall is still closing; why_new=round 1 only covered a waterfall already stored on the session; seam=ListenSession._scan (the real _paired_waterfall started by hand instead of a scan request); no_claim=real waterfall handshake timing
async def test_slot_waits_for_a_half_open_scan_waterfall():
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    connecting, wf_closing, wf_closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    slots = Slots(1)

    class HalfOpenWaterfall:
        is_open = True

        def __init__(self, *args, **kwargs):
            pass

        async def connect(self):
            connecting.set()
            await asyncio.Event().wait()

        async def close(self):
            wf_closing.set()
            await wf_closed.wait()

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
        waterfall_factory=HalfOpenWaterfall,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    session._client.host, session._client.port = "a.example", 8073
    session._client.connect_host, session._client.secure, session._client.timestamp = "127.0.0.1", False, 1
    session._scan = asyncio.create_task(session._paired_waterfall(session._client))
    await asyncio.wait_for(connecting.wait(), timeout=5)
    serving = asyncio.create_task(
        session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
    )
    await asyncio.wait_for(wf_closing.wait(), timeout=5)  # the scan is closing its half-open waterfall
    serving.cancel()
    await asyncio.wait({serving})
    closing_session = asyncio.create_task(session.close())  # cancels the old pump again
    await asyncio.sleep(0.1)
    assert slots.active == 1  # that waterfall is still closing on the volunteer's Kiwi
    wf_closed.set()
    await asyncio.wait_for(closing_session, timeout=5)
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)


# Value: protects=a scan task that swallows its cancel can't hold a session's ending (and its slot) forever: the wait is bounded and logged; fails_when=ending a session waits on the scan with no timeout; why_new=_end_scan waited unbounded; seam=SCAN_STOP_TIMEOUT_S (shortened for the test); no_claim=what makes a real scan ignore a cancel
async def test_ending_does_not_wait_forever_for_a_stuck_scan(monkeypatch, caplog):
    from skywave_radio import session as session_module
    from skywave_radio.session import ListenSession, Slots

    monkeypatch.setattr(session_module, "SCAN_STOP_TIMEOUT_S", 0.2)
    already_closed = asyncio.Event()
    already_closed.set()
    slots = Slots(1)
    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    release = asyncio.Event()

    async def stuck_scan():
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass  # swallows every cancel

    stuck = asyncio.create_task(stuck_scan())
    session._scan = stuck
    aborted_with = []

    class ConnectingWaterfall:
        def abort(self):
            aborted_with.append(slots.active)

    session._connecting = ConnectingWaterfall()  # the stuck scan's half-open waterfall
    try:
        await asyncio.wait_for(session.handle({"type": "stop"}), timeout=5)
        assert slots.active == 0
        assert "still running after" in caplog.text
        # The stuck scan never closed its waterfall, so ending dropped it, before the slot freed.
        assert aborted_with == [1]
    finally:
        release.set()
        await stuck


# Value: protects=a session that ended on its own keeps its slot until its scan has stopped even when a Stop and then the browser leaving cancel it during teardown; fails_when=a later cancel ends the teardown wait early, freeing the slot while the scan may still close its waterfall; why_new=only one extra cancel was covered; seam=ListenSession._scan (a scan task set by hand); no_claim=real scan timing
async def test_teardown_survives_repeated_cancels():
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    slots = Slots(1)
    session = ListenSession(
        settings(max_session_minutes=0.005),  # the limit ends it after 0.3 s
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    scan_cancelled, scan_may_end = asyncio.Event(), asyncio.Event()

    async def slow_to_stop_scan():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            scan_cancelled.set()
            await scan_may_end.wait()
            raise

    session._scan = asyncio.create_task(slow_to_stop_scan())
    try:
        await asyncio.wait_for(scan_cancelled.wait(), timeout=5)  # the limit fired; teardown waits on the scan
        stopping = asyncio.create_task(session.handle({"type": "stop"}))  # second cancel
        await asyncio.sleep(0.05)
        stopping.cancel()  # the browser leaves mid-Stop
        await asyncio.wait({stopping})
        closing_session = asyncio.create_task(session.close())  # third cancel
        await asyncio.sleep(0.1)
        assert slots.active == 1  # the scan hasn't stopped yet
    finally:
        scan_may_end.set()
    await asyncio.wait_for(closing_session, timeout=5)
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)


# Value: protects=a second cancel during teardown aborts the audio client itself, so the socket drops even when its close() doesn't react to the cancel; fails_when=the teardown relies on cancelling the close task (and KiwiConnection.close's own handler) to drop the socket; why_new=review (Claude adversarial, owner D6): the abort rested on asyncio running the close task first; seam=none (a fake client whose close() ignores the cancel's meaning); no_claim=real websockets abort timing
async def test_a_second_cancel_aborts_the_audio_client_itself():
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    held = _held_close_client("limit", closing, closed)
    made = []

    def factory(host, port, **kwargs):
        made.append(held(host, port, **kwargs))
        return made[-1]

    slots = Slots(1)
    session = ListenSession(
        settings(max_session_minutes=0),  # the limit fires at once
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=factory,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)  # teardown is closing the audio
        await asyncio.wait_for(session.handle({"type": "stop"}), timeout=5)  # second cancel
        assert getattr(made[0], "aborted", False)
        assert slots.active == 0
    finally:
        closed.set()
    await session.close()


# Value: protects=a second cancel that lands before the audio close task's first step still drops the socket and frees the slot only after, so a close() that never runs can't leave a volunteer channel open; fails_when=the teardown relies on the close task running (or on KiwiConnection.close's cancel handler) to drop the socket; why_new=owner D6/D7: the earlier test only covered a close already in progress; seam=asyncio.create_task wrapped for the fake's close coroutine only, cancelling it (and the pump) before it starts, which asyncio's FIFO order otherwise never produces; no_claim=real websockets abort timing
async def test_a_cancel_before_the_audio_close_starts_still_aborts_it(monkeypatch):
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    closed.set()
    held = _held_close_client("limit", closing, closed)
    made = []
    slots = Slots(1)

    def factory(host, port, **kwargs):
        client = held(host, port, **kwargs)

        def abort():
            client.held_at_abort = slots.active  # is the channel still counted?

        client.abort = abort
        made.append(client)
        return client

    real_create_task = asyncio.create_task
    cancelled_early = []

    def create_task(coro, **kwargs):
        task = real_create_task(coro, **kwargs)
        if not cancelled_early and getattr(coro, "__qualname__", "").endswith("HeldClose.close"):
            cancelled_early.append(task)
            task.cancel()  # before its first step: close() never runs
            asyncio.current_task().cancel()  # the second cancel, landing on the pump right now
        return task

    session = ListenSession(
        settings(max_session_minutes=0),  # the limit fires at once
        _ignore,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=factory,
    )
    monkeypatch.setattr(asyncio, "create_task", create_task)
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    pump = session._pump
    await asyncio.wait({pump}, timeout=5)
    monkeypatch.undo()
    assert pump.done() and cancelled_early
    assert not closing.is_set()  # close() never ran
    assert getattr(made[0], "held_at_abort", None) == 1  # dropped anyway, while the slot was still held
    assert slots.active == 0  # and freed only after
    await session.close()


# Value: protects=a scan whose connection ended can't hand its waterfall to the next connection or keep it open: it closes it and gives up; fails_when=_paired_waterfall stores a waterfall for a connection that has ended; why_new=scan state wasn't tied to its connection; seam=ListenSession._client (swapped by hand to stand in for the next connection); no_claim=real handshake timing
async def test_a_scan_from_an_ended_connection_closes_its_waterfall():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    connecting, may_connect = asyncio.Event(), asyncio.Event()
    closed = []

    class SlowWaterfall:
        is_open = True

        def __init__(self, *args, **kwargs):
            pass

        async def connect(self):
            connecting.set()
            await may_connect.wait()

        async def close(self):
            closed.append(True)

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
        waterfall_factory=SlowWaterfall,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host, old.port, old.connect_host, old.secure, old.timestamp = "a.example", 8073, "127.0.0.1", False, 1
    pairing = asyncio.create_task(session._paired_waterfall(old))
    await asyncio.wait_for(connecting.wait(), timeout=5)
    session._client = object()  # the next connection
    may_connect.set()
    with pytest.raises(KiwiError):
        await pairing
    assert closed == [True]
    assert session._waterfall is None
    assert session._connecting is None
    session._client = old
    await session.close()


# Value: protects=a scan whose connection ends while its waterfall handshake fails closes that waterfall instead of keeping it for the next connection; fails_when=the connect-failure branch keeps an open, non-unpaired waterfall without checking the connection is still the scan's, so it lingers on a channel whose slot may be free; why_new=the sibling test only reached the check after a successful connect; seam=ListenSession._client (swapped by hand to stand in for the next connection); no_claim=real handshake timing or which codes a Kiwi sends
async def test_a_failed_handshake_from_an_ended_connection_closes_its_waterfall():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    connecting, may_fail = asyncio.Event(), asyncio.Event()
    closed = []

    class FailingWaterfall:
        is_open = True

        def __init__(self, *args, **kwargs):
            pass

        async def connect(self):
            connecting.set()
            await may_fail.wait()
            raise KiwiError("timeout", "a.example: the waterfall handshake timed out")

        async def close(self):
            closed.append(True)

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
        waterfall_factory=FailingWaterfall,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host, old.port, old.connect_host, old.secure, old.timestamp = "a.example", 8073, "127.0.0.1", False, 1
    pairing = asyncio.create_task(session._paired_waterfall(old))
    try:
        await asyncio.wait_for(connecting.wait(), timeout=5)
        session._client = object()  # the next connection
    finally:
        may_fail.set()
    with pytest.raises(KiwiError):
        await asyncio.wait_for(pairing, timeout=5)
    assert closed == [True]
    assert session._waterfall is None
    session._client = old
    await session.close()


# Value: protects=a scan from a connection that has ended touches nothing on the session: the waterfall and idle reader there belong to the next connection, so the waterfall is neither switched to fast mode nor closed, and the idle reader is neither cancelled nor dropped; fails_when=_paired_waterfall's entry check is dropped, so an old scan stops the next connection's idle reader before the later re-check runs; why_new=the other ended-connection tests had no waterfall or idle reader on the session; seam=ListenSession._client and ._waterfall (set by hand to stand in for the next connection); no_claim=how a real next connection builds its waterfall
async def test_a_scan_from_an_ended_connection_leaves_the_next_waterfall_alone():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    calls = []

    class NextWaterfall:
        async def fast(self):
            calls.append("fast")

        async def close(self):
            calls.append("close")

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host, old.port, old.connect_host, old.secure, old.timestamp = "a.example", 8073, "127.0.0.1", False, 1
    session._waterfall = NextWaterfall()
    next_idle = asyncio.create_task(asyncio.Event().wait())
    session._waterfall_idle = next_idle
    session._client = object()  # the next connection, with its own waterfall and idle reader
    with pytest.raises(KiwiError):
        await asyncio.wait_for(session._paired_waterfall(old), timeout=5)
    assert calls == []
    assert session._waterfall_idle is next_idle and not next_idle.done()
    next_idle.cancel()
    session._waterfall = None
    session._waterfall_idle = None
    session._client = old
    await session.close()


# Value: protects=a sweep that finishes (or fails) after its connection ended sends no answer, caches nothing and starts no idle reader on the next connection; fails_when=_run_scan's connection checks are dropped, so it reports and idles against a receiver the listener left; why_new=the earlier test only reached _paired_waterfall's own check; seam=skywave_radio.session.sweep (blocked by hand) and ListenSession._client (swapped for the next connection); no_claim=real sweep timing
@pytest.mark.parametrize("outcome", ["done", "kiwi-error"])
async def test_a_sweep_that_outlives_its_connection_answers_nothing(outcome, monkeypatch):
    from types import SimpleNamespace

    from skywave_radio import session as session_module
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.scan import ScanResult
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    sweeping, may_finish = asyncio.Event(), asyncio.Event()

    class GoodWaterfall:
        is_open = True
        bandwidth_khz = 30_000.0
        info = SimpleNamespace(freq_offset_khz=0.0)

        def __init__(self, *args, **kwargs):
            pass

        async def connect(self):
            pass

        async def frame(self, *args, **kwargs):
            raise AssertionError("the sweep is replaced")

        async def idle(self):
            await asyncio.Event().wait()

        async def close(self):
            pass

    async def blocked_sweep(*args, **kwargs):
        sweeping.set()
        await may_finish.wait()
        if outcome == "kiwi-error":
            raise KiwiError("timeout", "a.example stopped sending its waterfall")
        return ScanResult(bands_done=1, bands_total=1)

    monkeypatch.setattr(session_module, "sweep", blocked_sweep)
    sent = []

    async def send_text(payload):
        sent.append(payload)

    session = ListenSession(
        settings(),
        send_text,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
        waterfall_factory=GoodWaterfall,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host, old.port, old.connect_host, old.secure, old.timestamp = "a.example", 8073, "127.0.0.1", False, 1
    await session.handle({"type": "scan", "id": 3, "fresh": True})
    scan = session._scan
    try:
        await asyncio.wait_for(sweeping.wait(), timeout=5)
        session._client = object()  # the next connection
    finally:
        may_finish.set()
    await asyncio.wait_for(scan, timeout=5)
    replies = [p for p in sent if p.get("type") == "scan"]
    assert [r["state"] for r in replies] == ["scanning"]  # no answer about the receiver we left
    assert session._last_sweep is None
    assert session._waterfall_idle is None
    session._client = old
    await session.close()


# Value: protects=ending a session stops the scan and the idle reader together and raises a scan's error only after both have stopped, so the idle reader can't outlive the slot; fails_when=_stop_scan_tasks raises on the first failed task before the other has stopped; why_new=its error path was untested; seam=ListenSession._scan and ._waterfall_idle (tasks set by hand) and a direct _end_scan call; no_claim=what makes a real scan task fail
async def test_ending_waits_for_both_scan_tasks_before_raising():
    from skywave_radio.session import ListenSession, Slots

    session = ListenSession(settings(), _ignore, _ignore, slots=Slots(1), resolver=_resolve_any)
    idle_stopping, idle_may_stop = asyncio.Event(), asyncio.Event()

    async def failing_scan():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            raise RuntimeError("scan broke while stopping")

    async def slow_idle():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            idle_stopping.set()
            await idle_may_stop.wait()
            raise

    session._scan = asyncio.create_task(failing_scan())
    session._waterfall_idle = idle = asyncio.create_task(slow_idle())
    await asyncio.sleep(0)
    ending = asyncio.create_task(session._end_scan())
    try:
        await asyncio.wait_for(idle_stopping.wait(), timeout=5)
        await asyncio.sleep(0.05)
        assert not ending.done()  # still waiting on the idle reader, not raising early
    finally:
        idle_may_stop.set()
    with pytest.raises(RuntimeError, match="scan broke"):
        await asyncio.wait_for(ending, timeout=5)
    assert idle.done()
    assert session._scan is None and session._waterfall_idle is None


# Value: protects=a failed scan or retune while a session still plays doesn't tell the browser the radio stopped: a scan gets a scan error, a retune is logged; fails_when=handle() sends status "error" for any failure, so the page shows the radio as stopped while audio keeps playing; why_new=the catch-all is new this round; seam=ListenSession._start_scan (replaced to fail); no_claim=what real scan or retune failures look like
@pytest.mark.parametrize("request_kind", ["scan", "retune"])
async def test_a_failed_request_on_a_live_session_keeps_it_listening(request_kind, monkeypatch):
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    sent = []

    async def send_text(payload):
        sent.append(payload)

    session = ListenSession(
        settings(),
        send_text,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)

    async def broken(*args, **kwargs):
        raise RuntimeError("broke")

    if request_kind == "scan":
        monkeypatch.setattr(session, "_start_scan", broken)
        await session.handle({"type": "scan", "id": 7})
        assert sent[-1] == {"type": "scan", "id": 7, "state": "error", "host": "a.example", "port": 8073,
                            "message": "The scan broke. Check the radio service's logs."}
    else:
        monkeypatch.setattr(session._client, "tune", broken)
        await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7100, "mode": "usb"})
    assert not any(p.get("type") == "status" and p["state"] == "error" for p in sent)
    assert session._listening
    await session.close()


# Value: protects=a dial move for the receiver a session is still ending on is held: no redial of a Kiwi that may just have refused us, and the listener still gets the ending status; a tune for another receiver still switches; fails_when=_tune treats a same-receiver tune during teardown as a fresh connect; why_new=the ending status now waits for teardown, opening this window; seam=none; no_claim=real close timing (the close is held by hand)
@pytest.mark.parametrize("next_receiver", ["same", "another"])
async def test_a_tune_while_the_session_ends(next_receiver):
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    held = _held_close_client("stop", closing, closed)
    made = []

    def factory(host, port, **kwargs):
        made.append(port)
        return held(host, port, **kwargs)

    sent = []

    async def send_text(payload):
        sent.append(payload)

    session = ListenSession(
        settings(max_session_minutes=0.005),  # the limit ends it after 0.3 s
        send_text,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=factory,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    port = 8073 if next_receiver == "same" else 8074
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)  # the limit fired; the Kiwi is closing
        tuning = asyncio.create_task(
            session.handle({"type": "tune", "host": "a.example", "port": port, "freqKhz": 7100, "mode": "usb"})
        )
        await asyncio.sleep(0.05)
    finally:
        closed.set()
    await asyncio.wait_for(tuning, timeout=5)
    statuses = [p["state"] for p in sent if p.get("type") == "status"]
    if next_receiver == "same":
        async with asyncio.timeout(5):
            while "stopped" not in [p["state"] for p in sent if p.get("type") == "status"]:
                await asyncio.sleep(0.01)
        assert made == [8073]  # no redial
    else:
        assert made == [8073, 8074]  # the listener chose another receiver
        assert "stopped" not in statuses  # that ending was cut short by the switch
    await session.close()


# Value: protects=a same-receiver tune while the ending status is still being sent is held, so the reason (a refusal, the limit) reaches the listener and the Kiwi that gave it isn't redialed; the next tune after it goes through; fails_when=_ending_target is cleared before _send_status returns, so the tune cancels that send and redials, or the held tune still overwrites the session's frequency; why_new=review (Claude adversarial) after an earlier fix cleared the hold too early; seam=none; no_claim=real websocket backpressure (the send is held by hand)
async def test_a_tune_while_the_ending_status_is_sent_is_held():
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    held = _held_close_client("stop", closing, closed)
    made = []

    def factory(host, port, **kwargs):
        made.append(port)
        return held(host, port, **kwargs)

    sending, may_send = asyncio.Event(), asyncio.Event()
    delivered = []

    async def send_text(payload):
        if payload.get("type") == "status" and payload.get("state") == "stopped" and not may_send.is_set():
            sending.set()
            await may_send.wait()
        if payload.get("type") == "status":
            delivered.append(payload["state"])

    session = ListenSession(
        settings(max_session_minutes=0.005),  # the limit ends it after 0.3 s
        send_text,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=factory,
    )
    tune = {"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7100, "mode": "usb"}
    await session.handle({**tune, "freqKhz": 7200})
    closed.set()  # closes go straight through
    try:
        await asyncio.wait_for(sending.wait(), timeout=5)  # slot free, status send stuck
        session.settings = settings()
        await asyncio.wait_for(session.handle(tune), timeout=5)
        assert made == [8073]  # held: no redial while the reason is on its way
        assert session._freq_khz == 7200  # and it changed nothing
    finally:
        may_send.set()
    async with asyncio.timeout(5):
        while "stopped" not in delivered:
            await asyncio.sleep(0.01)
    await asyncio.wait_for(session.handle(tune), timeout=5)
    async with asyncio.timeout(5):
        while len(made) < 2:
            await asyncio.sleep(0.01)
    assert made == [8073, 8073]
    await session.close()


# Value: protects=a tune for another receiver while the ending status is still being sent switches at once on one fresh slot (the ended pump already freed its own), and the first receiver can be tuned again after; fails_when=the switch treats the ended pump as still holding a slot (double release or a leaked slot), or the hold blocks other receivers; why_new=review (state matrix: another-receiver x during-ending-status-send); seam=none; no_claim=real websocket backpressure (the send is held by hand)
async def test_a_switch_while_the_ending_status_is_sent_takes_one_slot():
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    held = _held_close_client("stop", closing, closed)
    made = []

    def factory(host, port, **kwargs):
        made.append(port)
        return held(host, port, **kwargs)

    sending, may_send = asyncio.Event(), asyncio.Event()

    async def send_text(payload):
        if payload.get("type") == "status" and payload.get("state") == "stopped" and not may_send.is_set():
            sending.set()
            await may_send.wait()

    slots = Slots(1)
    session = ListenSession(
        settings(max_session_minutes=0.005),  # the limit ends it after 0.3 s
        send_text,
        _ignore,
        slots=slots,
        resolver=_resolve_any,
        client_factory=factory,
    )
    tune = {"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7100, "mode": "usb"}
    await session.handle(tune)
    closed.set()  # closes go straight through
    try:
        await asyncio.wait_for(sending.wait(), timeout=5)  # slot free, status send stuck
        assert slots.active == 0
        session.settings = settings()
        await asyncio.wait_for(session.handle({**tune, "port": 8074}), timeout=5)
    finally:
        may_send.set()
    async with asyncio.timeout(5):
        while len(made) < 2:
            await asyncio.sleep(0.01)
    assert made == [8073, 8074]
    assert slots.active == 1
    await asyncio.wait_for(session.handle(tune), timeout=5)
    async with asyncio.timeout(5):
        while len(made) < 3:
            await asyncio.sleep(0.01)
    assert made == [8073, 8074, 8073]
    assert slots.active == 1
    await session.close()
    assert slots.active == 0


# Value: protects=once a session switches away from a receiver it was ending on, that receiver can be tuned again later; fails_when=_tune keeps the old ending target when it starts a new pump, so a later tune of that receiver is silently dropped as "still ending" while another plays; why_new=the sibling test stopped right after the switch; seam=ListenSession.settings (swapped after the first ending so the second receiver isn't cut off by the same tiny limit); no_claim=real close timing (the close is held by hand)
async def test_a_receiver_left_while_ending_can_be_tuned_again():
    from skywave_radio.session import ListenSession, Slots

    closing, closed = asyncio.Event(), asyncio.Event()
    held = _held_close_client("stop", closing, closed)
    made = []

    def factory(host, port, **kwargs):
        made.append(port)
        return held(host, port, **kwargs)

    session = ListenSession(
        settings(max_session_minutes=0.005),  # the limit ends it after 0.3 s
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=factory,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)  # A hit its limit; its Kiwi is closing
        session.settings = settings()  # B gets the normal hour
        switching = asyncio.create_task(
            session.handle({"type": "tune", "host": "a.example", "port": 8074, "freqKhz": 7100, "mode": "usb"})
        )
        await asyncio.sleep(0.05)
    finally:
        closed.set()
    await asyncio.wait_for(switching, timeout=5)
    async with asyncio.timeout(5):
        while not session._listening:
            await asyncio.sleep(0.01)
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    async with asyncio.timeout(5):  # the new pump resolves, then dials
        while len(made) < 3:
            await asyncio.sleep(0.01)
    assert made == [8073, 8074, 8073]
    await session.close()


# Value: protects=a scan whose connection ends while it waits for the idle reader doesn't dial a new waterfall afterwards; fails_when=_paired_waterfall checks the connection only on entry, so it dials onto a channel whose slot may be free; why_new=the earlier check ran before the awaits; seam=ListenSession._client and ._waterfall_idle (set by hand); no_claim=real idle-reader timing
async def test_a_scan_rechecks_its_connection_before_dialing():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    dialed = []

    class CountingWaterfall:
        def __init__(self, *args, **kwargs):
            dialed.append(True)

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
        waterfall_factory=CountingWaterfall,
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host, old.port, old.connect_host, old.secure, old.timestamp = "a.example", 8073, "127.0.0.1", False, 1
    idle_stopping, idle_may_stop = asyncio.Event(), asyncio.Event()

    async def slow_idle():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            idle_stopping.set()
            await idle_may_stop.wait()
            raise

    session._waterfall_idle = asyncio.create_task(slow_idle())
    pairing = asyncio.create_task(session._paired_waterfall(old))
    try:
        await asyncio.wait_for(idle_stopping.wait(), timeout=5)
        session._client = object()  # the connection ended meanwhile
    finally:
        idle_may_stop.set()
    with pytest.raises(KiwiError):
        await asyncio.wait_for(pairing, timeout=5)
    assert dialed == []
    session._client = old
    await session.close()


# Value: protects=a scan whose connection ends while it waits for the idle reader leaves the next connection's kept waterfall and idle reader alone (no fast(), no sweep, idle reader still tracked), so a stale scan can't disturb a live session's audio; fails_when=_paired_waterfall re-checks the connection only before dialing, not before reusing a kept waterfall; why_new=owner D9 (Claude adversarial); seam=ListenSession._client, ._waterfall and ._waterfall_idle (set by hand to stand in for the next connection); no_claim=what makes a scan outlive its stop timeout
async def test_a_stale_scan_leaves_the_next_connections_waterfall_alone():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    calls = []

    class NextWaterfall:
        async def fast(self):
            calls.append("fast")

        async def close(self):
            calls.append("close")

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host = "a.example"
    idle_stopping, idle_may_stop = asyncio.Event(), asyncio.Event()

    async def slow_idle():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            idle_stopping.set()
            await idle_may_stop.wait()
            raise

    session._waterfall_idle = asyncio.create_task(slow_idle())
    pairing = asyncio.create_task(session._paired_waterfall(old))
    next_idle = None
    try:
        await asyncio.wait_for(idle_stopping.wait(), timeout=5)
        # Meanwhile the listener's next connection came up with its own
        # waterfall and idle reader.
        session._client = object()
        session._waterfall = NextWaterfall()
        next_idle = asyncio.create_task(asyncio.Event().wait())
        session._waterfall_idle = next_idle
    finally:
        idle_may_stop.set()
    with pytest.raises(KiwiError):
        await asyncio.wait_for(pairing, timeout=5)
    assert calls == []  # never swept or closed
    assert session._waterfall_idle is next_idle  # still tracked
    next_idle.cancel()
    session._waterfall = None
    session._waterfall_idle = None
    session._client = old
    await session.close()


# Value: protects=a stale scan whose connection ends while its kept waterfall switches to fast mode gives up instead of handing back (and sweeping) the waterfall the next connection stored meanwhile; fails_when=_paired_waterfall returns self._waterfall after the fast() await without re-checking the connection; why_new=review (red team), within owner D9; seam=ListenSession._client and ._waterfall (swapped by hand during a held fast()); no_claim=how a real next connection builds its waterfall
async def test_a_stale_scan_does_not_take_a_waterfall_stored_during_fast():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()
    switching, may_switch = asyncio.Event(), asyncio.Event()
    next_calls = []

    class OldWaterfall:
        async def fast(self):
            switching.set()
            await may_switch.wait()

        async def close(self):
            pass

    class NextWaterfall:
        async def fast(self):
            next_calls.append("fast")

        async def close(self):
            next_calls.append("close")

    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=Slots(1),
        resolver=_resolve_any,
        client_factory=_held_close_client("stop", asyncio.Event(), already_closed),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    old = session._client
    old.host = "a.example"
    session._waterfall = OldWaterfall()
    pairing = asyncio.create_task(session._paired_waterfall(old))
    try:
        await asyncio.wait_for(switching.wait(), timeout=5)
        session._client = object()  # the next connection comes up meanwhile
        session._waterfall = NextWaterfall()
    finally:
        may_switch.set()
    with pytest.raises(KiwiError):
        await asyncio.wait_for(pairing, timeout=5)
    assert next_calls == []
    session._waterfall = None
    session._client = old
    await session.close()


# Value: protects=a task that already failed is reported when it's next cancelled, not lost as an unexplained "never retrieved"; fails_when=_cancel returns early for a done task without looking at its exception; why_new=the early return skipped it; seam=none; no_claim=which tasks fail in practice
async def test_cancel_reports_a_task_that_already_failed(caplog):
    from skywave_radio.session import ListenSession

    async def fails():
        raise RuntimeError("it broke earlier")

    task = asyncio.create_task(fails())
    await asyncio.wait({task})
    await ListenSession._cancel(task)
    assert "it broke earlier" in caplog.text


def _gate_resolver(gate: asyncio.Event, fail: Exception | None = None):
    async def resolve(host, port, **kwargs):
        await gate.wait()
        if fail is not None:
            raise fail
        return "127.0.0.1"

    return resolve


# Value: protects=a slot taken by a tune still resolving its hostname is freed exactly once however that tune ends: a cancelled switch, a failed lookup or the session closing; fails_when=one of those paths leaks the slot or releases it twice; why_new=only Stop while resolving was tested; seam=none; no_claim=real DNS timing
@pytest.mark.parametrize("end", ["switch-cancelled", "lookup-fails", "session-closes"])
async def test_a_resolving_tune_frees_its_slot_once(end, caplog):
    from skywave_radio.hostguard import HostRejected
    from skywave_radio.session import ListenSession, Slots

    gate = asyncio.Event()
    fail = HostRejected("dns", "a.example didn't resolve") if end == "lookup-fails" else None
    slots = Slots(1)
    session = ListenSession(
        settings(),
        _ignore,
        _ignore,
        slots=slots,
        resolver=_gate_resolver(gate, fail),
        client_factory=_held_close_client("stop", asyncio.Event(), asyncio.Event()),
    )
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    assert slots.active == 1
    if end == "switch-cancelled":
        serving = asyncio.create_task(
            session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
        )
        await asyncio.sleep(0)
        serving.cancel()
        await asyncio.wait({serving})
        await session.close()
    elif end == "lookup-fails":
        gate.set()
    else:
        await session.close()
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert slots.active == 0
    assert "released with none held" not in caplog.text


# Value: protects=switching right after the old receiver failed keeps exactly one slot, held by the new pump; fails_when=the ended pump's slot is released as well as handed over, or the new tune takes a second slot; why_new=no test switched from a pump that had already ended; seam=none; no_claim=whether _pump_done had already run (both orders keep one slot)
async def test_switch_right_after_the_old_receiver_failed_keeps_one_slot(caplog):
    from skywave_radio.session import ListenSession, Slots

    already_closed = asyncio.Event()
    already_closed.set()  # neither receiver's close is held here
    failing = _held_close_client("error", asyncio.Event(), already_closed)
    streaming = _held_close_client("stop", asyncio.Event(), already_closed)

    def factory(host, port, **kwargs):
        return (failing if port == 8073 else streaming)(host, port, **kwargs)

    slots = Slots(2)
    session = ListenSession(settings(), _ignore, _ignore, slots=slots, resolver=_resolve_any, client_factory=factory)
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    async with asyncio.timeout(5):
        while not session._pump.done():
            await asyncio.sleep(0)
    await session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert slots.active == 1
    await session.close()
    async with asyncio.timeout(5):
        while slots.active:
            await asyncio.sleep(0.01)
    assert "released with none held" not in caplog.text


# Value: protects=a double release never pushes the listener count below zero, so the cap can't admit extra listeners; fails_when=release() decrements past zero; why_new=Slots had no floor; seam=none; no_claim=which code path would double-release (none known)
def test_releasing_a_free_slot_never_goes_below_zero(caplog):
    from skywave_radio.session import Slots

    slots = Slots(1)
    slots.release()
    assert slots.active == 0
    assert "released with none held" in caplog.text
    assert slots.try_acquire()
    assert not slots.try_acquire()


def test_retune_while_connecting_keeps_one_connection():
    async def slow_resolver(host, port, *, allow_private, owner=None):
        await asyncio.sleep(0.3)
        return "127.0.0.1"

    def body(kiwi):
        client = TestClient(create_app(settings(), resolver=slow_resolver))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, 7200))
            ws.send_text(tune_msg(kiwi.port, 7210))  # still resolving the host
            time.sleep(0.5)
            ws.send_text(tune_msg(kiwi.port, 7185, "lsb"))  # connected, handshake pending
            statuses, _, _ = collect(ws, want_audio=3, want_spectrum=0)
        return kiwi, statuses

    kiwi, statuses = run_with_fake(body, handshake_delay=0.6)
    states = [s["state"] for s in statuses if s["type"] == "status"]
    assert states.count("connecting") == 1  # never restarted
    listening = [s for s in statuses if s.get("state") == "listening"]
    assert listening and all("sampleRate" in s for s in listening)  # none sent early
    assert len(kiwi.paths) == 1
    # Only the last frequency reaches the Kiwi, applied by the handshake.
    assert [c for c in kiwi.commands if c.startswith("SET mod=iq")] == [
        "SET mod=iq low_cut=-5000 high_cut=5000 freq=7185.000"
    ]


# Value: protects=hostguard's one-lookup-per-listener limit stays switched on; fails_when=session.py stops passing owner=self (or passes a fresh object per tune); why_new=every fake resolver accepted owner=None, so dropping it passed all tests (TODOS.md gap); seam=none; no_claim=the limit itself (test_hostguard.py)
def test_session_is_the_lookup_owner_across_tunes():
    from skywave_radio.hostguard import HostRejected

    owners = []

    async def recording_resolver(host, port, *, allow_private, owner):
        owners.append(owner)
        raise HostRejected("dns", f"Couldn't resolve {host}.")

    client = TestClient(create_app(settings(), resolver=recording_resolver))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(tune_msg(8073, host="dead.ddns.net"))
        first = until_state(ws, "error")
        ws.send_text(tune_msg(8073, host="next.ddns.net"))
        second = until_state(ws, "error")
    assert first[-1]["code"] == second[-1]["code"] == "dns"
    assert len(owners) == 2
    assert owners[0] is not None and owners[0] is owners[1]


def test_receiver_dropping_mid_stream_reports_error():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            return until_state(ws, "error")

    statuses = run_with_fake(body, drop_after=5)
    assert statuses[-1]["code"] == "closed"


def test_unexpected_crash_reports_generic_error():
    def boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    client = TestClient(create_app(settings(), client_factory=boom))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(tune_msg(8073))
        statuses = until_state(ws, "error")
        # The error goes out only once the slot is free.
        assert client.get("/healthz").json()["listeners"] == 0
    assert "Something broke" in statuses[-1]["message"]


def test_healthz():
    client = TestClient(create_app(settings()))
    assert client.get("/healthz").json()["ok"] is True


async def test_session_stops_quietly_when_browser_vanishes():
    from skywave_radio.session import ClientGone, ListenSession

    sent = {"n": 0}

    async def send_text(_):
        pass

    async def send_bytes(_):
        sent["n"] += 1
        if sent["n"] > 3:
            raise ClientGone()

    async with FakeKiwi() as kiwi:
        session = ListenSession(settings(), send_text, send_bytes)
        await session.handle({"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 7200, "mode": "usb"})
        await asyncio.wait_for(session._pump, 5)
        assert session._client is None


async def test_retune_as_the_kiwi_drops_is_not_a_crash():
    from skywave_radio.kiwi import KiwiError, KiwiInfo
    from skywave_radio.session import ListenSession

    class DroppingClient:
        """Connects fine, then fails the first retune as if the Kiwi just hung up."""

        def __init__(self, *args, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)
            self.tunes = 0

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            self.tunes += 1
            if self.tunes > 1:
                raise KiwiError("closed", "kiwi.example closed the connection")

        async def blocks(self):
            await asyncio.Event().wait()
            yield

        async def close(self):
            pass

    sent = []

    async def send_text(payload):
        sent.append(payload)

    async def send_bytes(_):
        pass

    session = ListenSession(settings(), send_text, send_bytes, client_factory=DroppingClient)
    await session.handle({"type": "tune", "host": "127.0.0.1", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    await session.handle({"type": "tune", "host": "127.0.0.1", "port": 8073, "freqKhz": 7185, "mode": "usb"})
    await session.close()
    # The failed retune neither raised nor sent its own error; the pump owns that.
    assert [s["state"] for s in sent] == ["connecting", "listening"]


# Value: protects=a browser leaving while a receiver switch waits for the old pump starts no new pump and frees the slot; fails_when=stop() swallows the cancel aimed at its caller, so the switch goes on to dial the new receiver for nobody; why_new=red team found the shutdown race; seam=none; no_claim=real disconnect timing (the server's serving.cancel() is reproduced by hand)
async def test_leaving_mid_switch_starts_no_new_pump():
    from skywave_radio.kiwi import KiwiInfo
    from skywave_radio.session import ListenSession, Slots

    made = []

    class SlowToClose:
        """Listens until stopped; close() takes a while, as KiwiClient's bounded close can."""

        def __init__(self, host, port, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)
            made.append(port)

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            await asyncio.Event().wait()
            yield

        def abort(self):
            pass

        async def close(self):
            await asyncio.sleep(0.3)

    async def resolve(host, port, **kwargs):
        return "127.0.0.1"

    async def send(_):
        pass

    slots = Slots(1)
    session = ListenSession(settings(), send, send, slots=slots, resolver=resolve, client_factory=SlowToClose)
    await session.handle({"type": "tune", "host": "a.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    # What server.py does: serve() handles a switch, the browser leaves, serve() is cancelled.
    serving = asyncio.create_task(session.handle({"type": "tune", "host": "b.example", "port": 8074, "freqKhz": 7200, "mode": "usb"}))
    await asyncio.sleep(0.05)  # the switch is now waiting for the old pump's close()
    serving.cancel()
    await asyncio.wait({serving})
    await session.close()
    await asyncio.sleep(0.05)
    assert made == [8073]
    assert slots.active == 0


# Value: protects=receivers picked from the public list are never dialed on private addresses, even with ALLOW_PRIVATE_HOSTS on; fails_when=session ignores "source": "list"; why_new=list tunes relied on the operator's flag; seam=none; no_claim=the web client sending the tag (use-radio/page tests)
def test_list_tunes_are_public_only_even_when_private_hosts_are_allowed():
    client = TestClient(create_app(settings(allow_private_hosts=True)))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(json.dumps({"type": "tune", "host": "127.0.0.1", "port": 9, "freqKhz": 7200, "mode": "usb", "source": "list"}))
        statuses = until_state(ws, "error")
    assert statuses[-1]["code"] == "blocked"


def _gated_resolver(gate: threading.Event):
    async def resolve(host, port, *, allow_private, owner=None):
        while not gate.is_set():
            await asyncio.sleep(0.02)
        return "127.0.0.1"

    return resolve


# Value: protects=Stop while a hostname is still resolving frees the listener slot; fails_when=stop() stops cancelling a resolving pump or the slot callback is lost; why_new=state matrix resolving x stop was untested; seam=none; no_claim=real DNS timing
def test_stop_while_resolving_frees_the_slot():
    gate = threading.Event()

    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1), resolver=_gated_resolver(gate)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws1:
            ws1.send_text(tune_msg(kiwi.port, host="slow.example"))
            until_state(ws1, "connecting")
            ws1.send_text(json.dumps({"type": "stop"}))
            stopped = until_state(ws1, "stopped")
            gate.set()
            with client.websocket_connect("/ws", headers=ORIGIN) as ws2:
                ws2.send_text(tune_msg(kiwi.port, host="slow.example"))
                second = until_state(ws2, "listening", "error")
        return stopped, second

    stopped, second = run_with_fake(body)
    assert stopped[-1]["message"] == "Stopped."
    assert "host" not in stopped[-1]
    assert second[-1]["state"] == "listening"


# Value: protects=switching receivers before the first one resolves never needs a second slot; fails_when=tune stops calling stop() before try_acquire, so max_sessions=1 refuses the switch; why_new=state matrix resolving x tune-other was untested; seam=none; no_claim=real DNS timing
def test_switching_receivers_while_resolving_keeps_one_slot():
    gate = threading.Event()

    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1), resolver=_gated_resolver(gate)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, host="first.example"))
            until_state(ws, "connecting")
            ws.send_text(tune_msg(kiwi.port, host="second.example"))
            gate.set()
            return until_state(ws, "listening", "error")

    statuses = run_with_fake(body)
    assert statuses[-1]["state"] == "listening"
    assert statuses[-1]["host"] == "second.example"


# Value: protects=switching receivers mid-listen releases the old slot before taking a new one; fails_when=the old pump's slot is released after the new try_acquire; why_new=state matrix listening x tune-other was untested; seam=none; no_claim=two real Kiwis
def test_switching_receivers_while_listening_reuses_the_slot():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(tune_msg(kiwi.port, host="localhost"))
            return until_state(ws, "connecting", "error") + until_state(ws, "listening", "error")

    statuses = run_with_fake(body)
    assert [s.get("state") for s in statuses if s.get("state") in ("connecting", "listening", "error")][-2:] == [
        "connecting",
        "listening",
    ]
    assert statuses[-1]["host"] == "localhost"


# Value: protects=a list tune of an address a typed tune already uses restarts public-only; fails_when=same_receiver compares only host and port again; why_new=api-contract review found the short-circuit kept the typed rule; seam=none; no_claim=the browser sending the tag
def test_list_tune_of_a_running_typed_tune_is_public_only():
    def body(kiwi):
        client = TestClient(create_app(settings(allow_private_hosts=True)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            listed = {"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 7200, "mode": "usb", "source": "list"}
            ws.send_text(json.dumps(listed))
            return until_state(ws, "error")

    statuses = run_with_fake(body)
    assert statuses[-1]["code"] == "blocked"


# Value: protects=with private hosts off, choosing the list row of the receiver you typed retunes instead of re-dialing; fails_when=same_receiver keys on the raw source flag; why_new=pass-2 red team found the pass-1 fix dropped the held channel; seam=none; no_claim=a real busy receiver
def test_list_tune_of_a_typed_session_is_a_retune_when_private_hosts_are_off():
    async def resolver(host, port, *, allow_private, owner=None):
        return "127.0.0.1"  # the fake Kiwi; the rule under test is the session's, not hostguard's

    def body(kiwi):
        client = TestClient(create_app(settings(allow_private_hosts=False), resolver=resolver))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            typed = {"type": "tune", "host": "kiwi.example", "port": kiwi.port, "freqKhz": 7200, "mode": "usb"}
            ws.send_text(json.dumps(typed))
            first = until_state(ws, "listening")
            ws.send_text(json.dumps({**typed, "freqKhz": 7185, "source": "list"}))
            second = until_state(ws, "listening", "error")
        return kiwi, first + second

    kiwi, statuses = run_with_fake(body)
    assert [s.get("state") for s in statuses].count("connecting") == 1
    assert len(kiwi.paths) == 1
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=7185.000" in kiwi.commands


# Value: protects=the lookup limit follows a person, not a socket, but never lumps listeners behind an untrusted proxy together; fails_when=lookup_owner keys on private addresses or ignores the client IP; why_new=R5 per-IP keying; seam=none; no_claim=uvicorn's X-Forwarded-For handling
@pytest.mark.parametrize(
    "client_ip,keyed_by_ip",
    [("8.8.8.8", True), ("2001:4860:4860::8888", True), ("172.17.0.1", False), ("127.0.0.1", False), ("203.0.113.9", False), (None, False), ("testclient", False)],
)
def test_lookup_owner_is_a_public_client_ip_or_else_the_session(client_ip, keyed_by_ip):
    from skywave_radio.session import ListenSession

    async def nothing(_):
        pass

    session = ListenSession(settings(), nothing, nothing, client_ip=client_ip)
    assert session.lookup_owner == (("ip", client_ip) if keyed_by_ip else session)


# Value: protects=Kiwi.Example then kiwi.example is a retune, not a reconnect; fails_when=_tune stops lowercasing the host; why_new=TODOS small edges; seam=none; no_claim=none beyond protects
def test_retune_ignores_hostname_case():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, 7200, host="LocalHost"))
            first = until_state(ws, "listening")
            ws.send_text(tune_msg(kiwi.port, 7185, host="localhost"))
            second = until_state(ws, "listening")
        return kiwi, first + second

    kiwi, statuses = run_with_fake(body)
    assert [s.get("state") for s in statuses].count("connecting") == 1
    assert len(kiwi.paths) == 1


# Value: protects=the browser learns it may retry the same receiver; fails_when=retryAfterMs is dropped from the status; why_new=R7; seam=none; no_claim=the browser's retry (use-pick-best tests)
def test_retry_hint_reaches_the_browser():
    from skywave_radio.hostguard import HostRejected

    async def busy(host, port, *, allow_private, owner):
        raise HostRejected(None, "Still waiting on the last address lookup; try again in a moment.", retry_after_ms=5000)

    client = TestClient(create_app(settings(), resolver=busy))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(tune_msg(8073, host="next.ddns.net"))
        error = until_state(ws, "error")[-1]
    assert "code" not in error
    assert error["retryAfterMs"] == 5000


# Value: protects=a browser that stops reading gives back its slot and Kiwi channel; fails_when=sends lose their timeout; why_new=the vanish test only covers closed sockets; seam=none; no_claim=real TCP backpressure (a send that never returns)
async def test_a_stalled_browser_ends_its_session(monkeypatch):
    from skywave_radio import session as session_module
    from skywave_radio.kiwi import IQBlock, KiwiInfo
    from skywave_radio.session import ListenSession, Slots

    monkeypatch.setattr(session_module, "SEND_TIMEOUT_S", 0.2)
    stalled = []

    async def send_text(_):
        pass

    async def never_returns(_):
        await asyncio.Event().wait()

    class StreamingClient:
        def __init__(self, *args, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            while True:
                yield IQBlock(seq=0, rssi_dbm=-73.0, samples=np.zeros(512, np.complex64), adc_overflow=False)

        async def close(self):
            pass

    async def resolver(host, port, *, allow_private, owner):
        return "127.0.0.1"

    slots = Slots(1)
    session = ListenSession(
        settings(), send_text, never_returns, slots=slots, resolver=resolver, client_factory=StreamingClient,
        on_stalled=lambda: stalled.append(1),
    )
    await session.handle({"type": "tune", "host": "kiwi.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    await asyncio.wait_for(session._pump, 5)
    await asyncio.sleep(0)
    assert stalled
    assert slots.active == 0


# Value: protects=a dead tab gives back its slot and the volunteer's channel soon after the send timeout, even though the Kiwi's audio has backed up behind it; fails_when=closing the Kiwi waits out websockets' 10 s default; why_new=the fake-client stall test can't see the close wait (user caught the ~25 s total); seam=none; no_claim=a real Kiwi's close timing
async def test_a_stalled_browser_frees_its_slot_soon_with_a_real_receiver(monkeypatch):
    from skywave_radio import kiwi as kiwi_module
    from skywave_radio import session as session_module
    from skywave_radio.session import ListenSession, Slots

    monkeypatch.setattr(session_module, "SEND_TIMEOUT_S", 0.2)

    async def send_text(_):
        pass

    async def never_returns(_):
        await asyncio.Event().wait()

    slots = Slots(1)
    async with FakeKiwi() as kiwi:
        session = ListenSession(settings(), send_text, never_returns, slots=slots)
        await session.handle({"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 7200, "mode": "usb"})
        started = time.monotonic()
        await asyncio.wait_for(session._pump, 5)
        await asyncio.sleep(0)
        elapsed = time.monotonic() - started
    assert slots.active == 0
    assert elapsed < kiwi_module.CLOSE_TIMEOUT_S + 2


# Value: protects=Stop marks the session idle even when its pump ended on its own in the same loop pass, so the socket still idles out instead of staying open (and counted) for good; fails_when=only the pump's done callback sets idle_since, which then no longer sees the pump as current; why_new=red team (pass 2); seam=a finished future standing in for the pump, its callbacks still queued; no_claim=how often the race happens
async def test_stop_marks_the_session_idle_when_the_pump_ended_first():
    from skywave_radio.session import ListenSession

    async def ignore(_payload):
        pass

    session = ListenSession(settings(), ignore, ignore)
    pump = asyncio.get_running_loop().create_future()
    pump.add_done_callback(session._mark_idle)
    session._pump, session.idle_since = pump, None
    pump.set_result(None)  # done, but _mark_idle hasn't run yet
    await session.stop("Stopped.")
    await asyncio.sleep(0)  # let the queued callback run
    assert session.idle_since is not None


# Value: protects=the browser isn't left showing "Listening" with no audio after we give up on it, and a counted address gets its socket place back; fails_when=the server keeps its receive loop open after a stall, or a stalled socket's count is never released; why_new=Codex O6, then state matrix (counted and uncounted owner x stall); seam=none; no_claim=uvicorn closing the transport when the app returns (its documented behaviour)
@pytest.mark.parametrize("client", [("8.8.8.8", 50000), ("testclient", 50000)])
async def test_a_stalled_browser_is_disconnected(monkeypatch, client):
    from skywave_radio import session as session_module
    from skywave_radio.kiwi import IQBlock, KiwiInfo

    monkeypatch.setattr(session_module, "SEND_TIMEOUT_S", 0.2)

    class StreamingClient:
        def __init__(self, *args, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            while True:
                yield IQBlock(seq=0, rssi_dbm=-73.0, samples=np.zeros(512, np.complex64), adc_overflow=False)

        async def close(self):
            pass

    async def resolver(host, port, *, allow_private, owner):
        return "127.0.0.1"

    app = create_app(settings(max_sessions=1), resolver=resolver, client_factory=StreamingClient)
    incoming = [
        {"type": "websocket.connect"},
        {"type": "websocket.receive", "text": tune_msg(8073, host="kiwi.example")},
    ]

    async def receive():
        if incoming:
            return incoming.pop(0)
        await asyncio.Event().wait()  # the browser says nothing more

    async def send(message):
        if message.get("bytes") is not None:
            await asyncio.Event().wait()  # and stops reading

    scope = {
        "type": "websocket",
        "path": "/ws",
        "raw_path": b"/ws",
        "query_string": b"",
        "headers": [(b"origin", b"http://localhost:3000")],
        "client": client,
        "server": ("testserver", 80),
        "scheme": "ws",
        "subprotocols": [],
        "asgi": {"version": "3.0"},
    }
    await asyncio.wait_for(app(scope, receive, send), 5)
    assert app.state.slots.active == 0
    assert app.state.open_sockets == {}


# Value: protects=switching receivers never lets go of the slot, so another listener can't take it mid-switch; fails_when=_tune releases and re-acquires again; why_new=TODOS slot handover (not reachable today, fragile); seam=none; no_claim=a real second listener racing
async def test_switching_receivers_hands_the_slot_over():
    from skywave_radio.kiwi import KiwiInfo
    from skywave_radio.session import ListenSession, Slots

    class CountingSlots(Slots):
        releases = 0

        def release(self):
            CountingSlots.releases += 1
            super().release()

    class QuietClient:
        def __init__(self, *args, **kwargs):
            self.info = KiwiInfo(sample_rate=12000.0)

        async def connect(self):
            return self.info

        async def tune(self, freq_khz):
            pass

        async def blocks(self):
            await asyncio.Event().wait()
            yield

        async def close(self):
            pass

    async def resolver(host, port, *, allow_private, owner):
        return "127.0.0.1"

    async def nothing(_):
        pass

    slots = CountingSlots(1)
    session = ListenSession(settings(), nothing, nothing, slots=slots, resolver=resolver, client_factory=QuietClient)
    await session.handle({"type": "tune", "host": "first.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    while not session._listening:
        await asyncio.sleep(0.01)
    await session.handle({"type": "tune", "host": "second.example", "port": 8073, "freqKhz": 7200, "mode": "usb"})
    await asyncio.sleep(0.05)
    assert (slots.active, CountingSlots.releases) == (1, 0)
    assert session._listening
    await session.close()
    await asyncio.sleep(0)
    assert (slots.active, CountingSlots.releases) == (0, 1)


# Value: protects=after a receiver drops us, tuning it again reconnects rather than being taken for a retune of a dead pump; fails_when=same_receiver ignores whether the pump is still alive; why_new=state matrix ended x tune-same; seam=none; no_claim=a real Kiwi restart
def test_tuning_the_same_receiver_after_it_dropped_reconnects():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            dropped = until_state(ws, "error")
            ws.send_text(tune_msg(kiwi.port))
            again = until_state(ws, "connecting") + until_state(ws, "listening", "error")
        return kiwi, dropped, again

    kiwi, dropped, again = run_with_fake(body, drop_after=3)
    assert dropped[-1]["code"] == "closed"
    assert again[-1]["state"] in ("listening", "error")  # the fake drops again after 3 frames
    assert len(kiwi.paths) == 2


# Value: protects=switching receivers mid-handshake keeps one slot and ends on the new one; fails_when=a handshaking pump isn't cancelled or its slot is counted twice; why_new=state matrix handshaking x tune-other; seam=none; no_claim=two real Kiwis
def test_switching_receivers_mid_handshake_keeps_one_slot():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "connecting")
            time.sleep(0.1)  # resolved and connected; the fake is holding the handshake
            ws.send_text(tune_msg(kiwi.port, host="localhost"))
            return until_state(ws, "listening", "error")

    statuses = run_with_fake(body, handshake_delay=0.5)
    assert statuses[-1]["state"] == "listening"
    assert statuses[-1]["host"] == "localhost"


# Value: protects=Stop during the handshake frees the slot for the next listener; fails_when=stop() leaves a handshaking client or slot behind; why_new=state matrix handshaking x stop; seam=none; no_claim=real handshake timing
def test_stop_mid_handshake_frees_the_slot():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "connecting")
            time.sleep(0.1)
            ws.send_text(json.dumps({"type": "stop"}))
            stopped = until_state(ws, "stopped")
            return stopped, client.get("/healthz").json()

    stopped, health = run_with_fake(body, handshake_delay=0.5)
    assert stopped[-1]["message"] == "Stopped."
    assert health["listeners"] == 0


# Value: protects=Stop after a receiver error is harmless and still answers; fails_when=stop() trips over the ended pump; why_new=state matrix ended x stop; seam=none; no_claim=none beyond protects
def test_stop_after_an_error_still_answers():
    from skywave_radio.hostguard import HostRejected

    async def dead(host, port, *, allow_private, owner):
        raise HostRejected("dns", f"Couldn't resolve {host}.")

    client = TestClient(create_app(settings(), resolver=dead))
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.send_text(tune_msg(8073, host="gone.example"))
        until_state(ws, "error")
        ws.send_text(json.dumps({"type": "stop"}))
        stopped = until_state(ws, "stopped")
    assert stopped[-1]["message"] == "Stopped."
    assert client.get("/healthz").json()["listeners"] == 0


# --- Band scan (eng review 2026-10-22: D4, D5, D13, D16, D19, D20) ---


def carrier_bins(rf_khz):
    """wf_bins: flat noise with one narrow carrier at rf_khz."""

    def bins(start, span):
        out = np.full(1024, 140, dtype=np.uint8)
        i = int((rf_khz - start) / span * 1024)
        if 0 <= i < 1024:
            out[i] = 200
        return out

    return bins


def scan_msg(scan_id=1, fresh=False):
    return json.dumps({"type": "scan", "id": scan_id, "fresh": fresh})


def until_scan(ws, *states, limit=20000):
    """Messages up to and including the first scan reply in `states`; audio is skipped."""
    seen = []
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("text"):
            payload = json.loads(msg["text"])
            seen.append(payload)
            if payload.get("type") == "scan" and payload.get("state") in states:
                return seen
    raise AssertionError(f"no scan reply in {states}: {seen}")


def audio_after(ws, n=5, limit=2000):
    got = 0
    for _ in range(limit):
        if ws.receive().get("bytes", b"")[:1] == AUDIO_TAG:
            got += 1
            if got >= n:
                return True
    return False


# Value: protects=a scan pairs a waterfall with the audio's timestamp, lists the carrier, leaves audio playing and uses no listener slot (D19, D20); fails_when=the W/F uses another timestamp, is closed after the sweep, or takes a slot; why_new=no scan existed; seam=none; no_claim=real Kiwi pairing (the fake models badp=5 and close-ends-audio)
@pytest.mark.timeout(20)
def test_scan_lists_signals_and_audio_keeps_playing():
    def body(kiwi):
        app = create_app(settings())
        client = TestClient(app)
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            statuses = until_state(ws, "listening")
            ws.send_text(scan_msg(7))
            replies = until_scan(ws, "done")
            listeners = client.get("/healthz").json()["listeners"]
            playing = audio_after(ws)
            paths = list(kiwi.paths)
            # Read while still connected: leaving closes the W/F with the audio.
            wf_closed = kiwi.wf_closed
        return statuses, replies, listeners, playing, paths, wf_closed

    statuses, replies, listeners, playing, paths, wf_closed = run_with_fake(body, wf_bins=carrier_bins(9_420.0))
    assert statuses[-1]["features"] == ["scan"]
    scan = [r for r in replies if r["type"] == "scan"]
    assert [r["state"] for r in scan] == ["scanning", "done"]
    done = scan[-1]
    assert (done["id"], done["host"]) == (7, "127.0.0.1") and isinstance(done["port"], int)
    assert done["signals"][0] == {"freqKhz": 9_420.0, "snrDb": 60, "band": "31m"}
    assert (done["bandsDone"], done["bandsTotal"], done["partial"]) == (15, 15, False)
    assert not [r for r in replies if r["type"] == "status" and r["state"] == "error"]
    assert listeners == 1  # the paired waterfall shares the audio's channel and slot
    assert playing and wf_closed == 0  # kept open, idling, until the audio ends
    snd, wf = paths
    assert snd.endswith("/SND") and wf.endswith("/W/F") and snd.split("/")[2] == wf.split("/")[2]


# Value: protects=a second scan within 10 min reuses the result and Scan again re-sweeps on the same waterfall (D4); fails_when=the cache is missed or fresh is ignored, or each scan opens a new W/F; why_new=no cache; seam=none; no_claim=cache expiry (unit-tested below)
@pytest.mark.timeout(20)
@pytest.mark.usefixtures("no_scan_interval")
def test_scan_is_cached_and_fresh_rescans_on_the_same_waterfall():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(1))
            first = until_scan(ws, "done")[-1]
            ws.send_text(scan_msg(2))
            cached = [r for r in until_scan(ws, "done") if r["type"] == "scan"]
            ws.send_text(scan_msg(3, fresh=True))
            fresh = [r for r in until_scan(ws, "done") if r["type"] == "scan"]
            wf_paths = [p for p in kiwi.paths if p.endswith("/W/F")]
        return first, cached, fresh, wf_paths

    first, cached, fresh, wf_paths = run_with_fake(body, wf_bins=carrier_bins(9_420.0))
    assert [r["state"] for r in cached] == ["done"] and cached[0]["id"] == 2
    assert cached[0]["atMs"] == first["atMs"]
    assert [r["state"] for r in fresh] == ["scanning", "done"] and fresh[-1]["atMs"] >= first["atMs"]
    assert len(wf_paths) == 1


# Value: protects=scan failures arrive as scan errors and never as a status error over working audio (D5); fails_when=a W/F refusal or a scan before listening goes through status; why_new=D5; seam=none; no_claim=which refusals real Kiwis send
@pytest.mark.timeout(20)
def test_scan_failures_stay_out_of_the_status():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(scan_msg(1))
            early = until_scan(ws, "error")
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(2))
            refused = until_scan(ws, "error")
            playing = audio_after(ws)
        return early, refused, playing

    early, refused, playing = run_with_fake(body, wf_reject=b"MSG too_busy=4")
    assert early[-1]["id"] == 1 and "listening" in early[-1]["message"]
    assert refused[-1]["id"] == 2 and "Couldn't scan" in refused[-1]["message"]
    assert not [r for r in early + refused if r["type"] == "status" and r["state"] == "error"]
    assert playing


# Value: protects=stopping closes the scan's waterfall with the audio (D19); fails_when=the W/F outlives the session, holding the volunteer's channel; why_new=D19; seam=none; no_claim=close ordering on a real Kiwi
@pytest.mark.timeout(20)
def test_stop_closes_the_scans_waterfall():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(1))
            until_scan(ws, "done")
            open_before = kiwi.wf_closed
            ws.send_text(json.dumps({"type": "stop"}))
            until_state(ws, "stopped")
        for _ in range(100):
            if kiwi.wf_closed:
                break
            time.sleep(0.02)
        return open_before, kiwi.wf_closed

    open_before, closed_after = run_with_fake(body, wf_bins=carrier_bins(9_420.0))
    assert (open_before, closed_after) == (0, 1)


# Value: protects=a cached scan expires after its TTL and expired entries are pruned on the next put, so the shared cache can't grow without bound; fails_when=get ignores the TTL or put stops pruning; why_new=ScanCache is new; seam=monotonic clock patched; no_claim=memory use (the private dict stands in for it)
def test_scan_cache_expires_and_prunes(monkeypatch):
    from skywave_radio.scan import ScanResult
    from skywave_radio.session import ScanCache

    now = [1000.0]
    monkeypatch.setattr("skywave_radio.session.time.monotonic", lambda: now[0])
    cache = ScanCache(ttl_s=600)
    cache.put("a", ScanResult())
    assert cache.get("a") is not None and cache.get("b") is None
    now[0] += 601
    assert cache.get("a") is None
    cache.put("b", ScanResult())
    assert list(cache._entries) == ["b"]


# Value: protects=Scan again during a sweep is answered by that sweep under the newest id, without cancelling it (a half-open paired W/F closed mid-handshake can end the audio); fails_when=the running scan is cancelled, answers with the old id, or a second reader hits the waterfall; why_new=found while building; seam=none; no_claim=real Kiwi timing
@pytest.mark.timeout(20)
def test_scan_again_mid_sweep_is_answered_by_the_running_scan():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(1))
            until_scan(ws, "scanning")
            ws.send_text(scan_msg(2, fresh=True))
            replies = [r for r in until_scan(ws, "done", "error") if r["type"] == "scan"]
            playing = audio_after(ws)
        return replies, playing

    replies, playing = run_with_fake(body, wf_bins=carrier_bins(9_420.0), wf_interval=0.02)
    assert [(r["state"], r["id"]) for r in replies] == [("scanning", 2), ("done", 2)]
    assert playing


@pytest.fixture
def no_scan_interval(monkeypatch):
    """For tests of back-to-back rescans themselves: no wait between sweeps."""
    monkeypatch.setattr("skywave_radio.session.SCAN_MIN_INTERVAL_S", 0.0)


class _ScanWaterfall:
    """A stand-in paired waterfall: frame() fails as told; idle() waits or fails."""

    def __init__(self, *args, frame_error=None, idle_error=None, **kwargs):
        from skywave_radio.kiwi import KiwiInfo

        self.info = KiwiInfo()
        self.bandwidth_khz = 30_000.0
        self.frame_error = frame_error
        self.idle_error = idle_error
        self.closed = False
        self.idling = asyncio.Event()

    async def connect(self):
        return self.info

    async def fast(self):
        pass

    async def frame(self, zoom, cf):
        raise self.frame_error

    async def idle(self):
        self.idling.set()
        if self.idle_error:
            raise self.idle_error
        await asyncio.Event().wait()

    async def close(self):
        self.closed = True

    @property
    def is_open(self):
        # A Kiwi-side close is a dead socket; anything else is still paired with the audio.
        return not self.closed and getattr(self.frame_error, "code", None) != "closed"


def listening_session(send_text, **kwargs):
    """A ListenSession that believes it is listening to kiwi.test, without a real Kiwi."""
    from types import SimpleNamespace

    from skywave_radio.session import ListenSession

    async def nothing(_):
        pass

    session = ListenSession(settings(), send_text, nothing, **kwargs)
    session._listening = True
    session._target = ("kiwi.test", 8073, True, False)
    async def close():
        pass

    session._client = SimpleNamespace(
        host="kiwi.test", port=8073, connect_host="127.0.0.1", secure=False, timestamp=1, close=close
    )
    return session


# Value: protects=a scan request arriving while the last scan's final reply is being sent gets its own answer; fails_when=the finishing scan still counts as running, adopts the request and answers only the old id, leaving the page on Scanning… for good; why_new=bug review (adopt vs final send); seam=ListenSession internals set by hand (no Kiwi); no_claim=real socket timing
async def test_a_request_during_the_final_reply_gets_its_own_answer():
    from skywave_radio.scan import ScanResult
    from skywave_radio.session import ScanCache

    cache = ScanCache()
    cache.put(("kiwi.test", 8073, True, False), ScanResult(at_ms=1))
    sent = []
    session = None

    async def send_text(payload):
        sent.append(payload)
        if payload["type"] == "scan" and payload["state"] == "done" and payload["id"] == 1:
            await session.handle({"type": "scan", "id": 2})  # lands mid-send

    session = listening_session(send_text, scan_cache=cache)
    await session.handle({"type": "scan", "id": 1})
    for _ in range(50):
        if any(p.get("id") == 2 and p["state"] == "done" for p in sent):
            break
        await asyncio.sleep(0.01)
    assert [(p["id"], p["state"]) for p in sent] == [(1, "done"), (2, "done")]


# Value: protects=a sweep that crashes leaves the paired waterfall drained and open, so the audio keeps playing; fails_when=the crash path leaves it unread (the Kiwi drops it and the audio with it) or closes it; why_new=bug review (undrained W/F); seam=stand-in waterfall; no_claim=which crashes happen live
async def test_a_crashed_scan_keeps_the_waterfall_drained():
    sent = []
    made = []

    async def send_text(payload):
        sent.append(payload)

    def factory(*args, **kwargs):
        made.append(_ScanWaterfall(frame_error=ValueError("bad frame")))
        return made[-1]

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(made_and_idling(made), 2)
    assert sent[-1]["state"] == "error" and "broke" in sent[-1]["message"]
    assert not made[0].closed
    await session.close()
    assert made[0].closed


async def made_and_idling(made):
    while not made:
        await asyncio.sleep(0.01)
    await made[0].idling.wait()


# Value: protects=a waterfall that fails while idling is closed if its socket is dead, and kept draining (then closed with the audio) if it's still open, so it neither leaks nor ends the audio (cycle-2 red team); fails_when=_idle closes an open paired waterfall, or forgets a dead one without closing it; why_new=bug review, then red team (a send timeout closed the audio); seam=stand-in waterfall; no_claim=real close codes
# Value (crash rows): protects=a non-Kiwi crash while idling is handled like a Kiwi error, not left to kill the drain task; fails_when=_idle's except Exception goes, so the open waterfall goes unread (the Kiwi drops it, and the audio) or a dead one is never closed; why_new=ship coverage audit gap (a); seam=stand-in waterfall; no_claim=which crashes happen live
@pytest.mark.parametrize("crash", [False, True], ids=["kiwi_error", "crash"])
@pytest.mark.parametrize("dead", [True, False])
async def test_a_waterfall_that_fails_while_idling(dead, crash):
    from skywave_radio.kiwi import KiwiError

    made = []

    async def send_text(payload):
        pass

    class Sweeps(_ScanWaterfall):
        idles = 0

        async def frame(self, zoom, cf):
            from skywave_radio.waterfall import WaterfallFrame

            return WaterfallFrame(zoom, cf - 30_000 / 2**zoom / 2, 30_000 / 2**zoom, np.full(1024, 140, dtype=np.uint8))

        async def idle(self):
            Sweeps.idles += 1
            await super().idle()

        @property
        def is_open(self):
            return not self.closed and not dead

    def factory(*args, **kwargs):
        made.append(Sweeps(idle_error=RuntimeError("bug") if crash else KiwiError("timeout", "stopped reading")))
        return made[-1]

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(made_and_idling(made), 5)
    if dead:
        for _ in range(50):
            if made[0].closed:
                break
            await asyncio.sleep(0.01)
        assert made[0].closed and session._waterfall is None
    else:
        async with asyncio.timeout(5):
            while Sweeps.idles < 2:
                await asyncio.sleep(0.05)
        assert not made[0].closed and session._waterfall is made[0]
        await session.close()
        assert made[0].closed


# Value: protects=a waterfall the receiver refuses while connecting is kept open and drained (closing one the Kiwi may already have paired would end the audio), except an unpaired one (badp=5), which never joined the audio and is closed (Step 11 D3); fails_when=_paired_waterfall closes every refused waterfall, or keeps an unpaired one; why_new=testing review, then adversarial review; seam=stand-in waterfall; no_claim=whether a real Kiwi can refuse after pairing
@pytest.mark.parametrize("code,kept", [("busy", True), ("down", True), ("timeout", True), ("unpaired", False)])
async def test_only_an_unpaired_waterfall_is_closed_on_refusal(code, kept):
    from skywave_radio.kiwi import KiwiError

    made = []

    async def send_text(payload):
        pass

    class Refuses(_ScanWaterfall):
        async def connect(self):
            raise KiwiError(code, "kiwi.test said no")

    def factory(*args, **kwargs):
        made.append(Refuses())
        return made[-1]

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    for _ in range(100):
        if made and (made[0].closed or session._waterfall is not None):
            break
        await asyncio.sleep(0.01)
    assert made[0].closed is not kept
    await session.close()
    assert made[0].closed


# Value: protects=a receiver error mid-sweep closes that waterfall and answers as a scan error, so the next scan dials a fresh paired one; fails_when=the KiwiError path keeps or idles the dead waterfall (the next scan reuses it and fails again) or reports through status; why_new=only a refusal during connect was tested, which never stores a waterfall; seam=stand-in waterfall; no_claim=whether a real Kiwi's audio survives the drop
@pytest.mark.usefixtures("no_scan_interval")
async def test_a_receiver_error_mid_sweep_drops_the_waterfall():
    from skywave_radio.kiwi import KiwiError

    sent = []
    made = []

    async def send_text(payload):
        sent.append(payload)

    def factory(*args, **kwargs):
        made.append(_ScanWaterfall(frame_error=KiwiError("closed", "kiwi.test closed the connection")))
        return made[-1]

    async def answered(n):
        while sum(p["type"] == "scan" and p["state"] == "error" for p in sent) < n:
            await asyncio.sleep(0.01)

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(answered(1), 2)
    assert sent[-1]["id"] == 1 and "Couldn't scan this receiver" in sent[-1]["message"]
    assert made[0].closed and session._waterfall is None
    assert not [p for p in sent if p["type"] == "status"]
    await session.handle({"type": "scan", "id": 2, "fresh": True})
    await asyncio.wait_for(answered(2), 2)
    assert len(made) == 2 and sent[-1]["id"] == 2
    await session.close()


class _BlockingWaterfall(_ScanWaterfall):
    """A stand-in paired waterfall that blocks in connect() or frame() until cancelled."""

    def __init__(self, *args, block_in="frame", **kwargs):
        super().__init__(*args, **kwargs)
        self.block_in = block_in
        self.blocked = asyncio.Event()

    async def connect(self):
        if self.block_in == "connect":
            self.blocked.set()
            await asyncio.Event().wait()
        return self.info

    async def frame(self, zoom, cf):
        self.blocked.set()
        await asyncio.Event().wait()


# Value: protects=stopping or closing during a scan, whether the waterfall is still connecting or mid-sweep, closes it and leaves no scan task or reply behind; fails_when=_end_scan misses a running scan or a half-open waterfall, leaving a volunteer's channel open; why_new=only stop after a finished scan was tested (review D6); seam=stand-in waterfall; no_claim=real close timing
@pytest.mark.parametrize("block_in", ["connect", "frame"])
@pytest.mark.parametrize("end", ["stop", "close"])
async def test_ending_mid_scan_closes_the_waterfall(block_in, end):
    sent, made = [], []

    async def send_text(payload):
        sent.append(payload)

    def factory(*args, **kwargs):
        made.append(_BlockingWaterfall(block_in=block_in))
        return made[-1]

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    while not made:
        await asyncio.sleep(0.01)
    await asyncio.wait_for(made[0].blocked.wait(), 2)
    if end == "stop":
        await session.stop("Stopped.")
    else:
        await session.close()
    assert made[0].closed
    assert session._scan is None and session._waterfall is None and session._waterfall_idle is None
    assert [p["state"] for p in sent if p["type"] == "scan"] == ["scanning"]


# Value: protects=a partial sweep (a stalled frame) is answered as partial but not cached, so the next request sweeps again instead of serving the thin result for 10 minutes (review D4); fails_when=partial results are put in the shared cache; why_new=red team (cached partials); seam=stand-in waterfall; no_claim=real stall timing
@pytest.mark.usefixtures("no_scan_interval")
async def test_a_partial_scan_is_not_cached():
    from skywave_radio.waterfall import WaterfallFrame

    sent, made = [], []

    async def send_text(payload):
        sent.append(payload)

    class StallsAfterTwo(_ScanWaterfall):
        calls = 0

        async def frame(self, zoom, cf):
            StallsAfterTwo.calls += 1
            if StallsAfterTwo.calls > 2:
                raise TimeoutError  # what WaterfallClient.frame raises when frames stop
            span = 30_000 / 2**zoom
            return WaterfallFrame(zoom, cf - span / 2, span, np.full(1024, 140, dtype=np.uint8))

    def factory(*args, **kwargs):
        made.append(StallsAfterTwo())
        return made[-1]

    async def done_count():
        return sum(p["state"] == "done" for p in sent if p["type"] == "scan")

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    while await done_count() < 1:
        await asyncio.sleep(0.01)
    first = [p for p in sent if p["type"] == "scan"][-1]
    assert first["partial"] is True and first["bandsDone"] < first["bandsTotal"]
    StallsAfterTwo.calls = 0  # the rescan gets its two frames too
    await session.handle({"type": "scan", "id": 2})
    while await done_count() < 2:
        await asyncio.sleep(0.01)
    assert [(p["id"], p["state"]) for p in sent if p["type"] == "scan"] == [
        (1, "scanning"),
        (1, "done"),
        (2, "scanning"),
        (2, "done"),
    ]
    await session.close()


# Value: protects=a scan request with a missing, boolean, string or fractional id is answered with id null, so the page's strict id match ignores it rather than mistaking True for 1; fails_when=the int check (and its bool exclusion) goes; why_new=review D6; seam=ListenSession internals set by hand; no_claim=none beyond protects
@pytest.mark.parametrize("bad", [True, "3", None, 1.5])
async def test_a_scan_with_a_bad_id_is_answered_with_null(bad):
    from skywave_radio.scan import ScanResult
    from skywave_radio.session import ScanCache

    cache = ScanCache()
    cache.put(("kiwi.test", 8073, True, False), ScanResult())
    sent = []

    async def send_text(payload):
        sent.append(payload)

    session = listening_session(send_text, scan_cache=cache)
    await session.handle({"type": "scan", "id": bad})
    for _ in range(50):
        if sent:
            break
        await asyncio.sleep(0.01)
    assert sent[-1]["id"] is None and sent[-1]["state"] == "done"


# Value: protects=switching to another receiver mid-scan closes the scan's waterfall and no result for the old receiver arrives afterwards; fails_when=the switch path skips _end_scan, leaving the old waterfall open or letting its reply land; why_new=review D6 (state matrix: scan-running x switch); seam=none; no_claim=real Kiwi close timing
@pytest.mark.timeout(20)
def test_switching_receivers_mid_scan_closes_the_waterfall():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(1))
            until_scan(ws, "scanning")
            # "scanning" goes out before the waterfall dials; switch only once
            # it's open, or an ending connection rightly never dials it at all.
            for _ in range(250):
                if kiwi.wf_commands:
                    break
                time.sleep(0.02)
            # gstack-timing-ok: a 5 s deadline on a poll, not a fixed sleep
            assert kiwi.wf_commands, "the scan's waterfall never connected"
            # Another port is another receiver to the session (nothing listens
            # there, so the new one fails; what matters is the old scan's end).
            ws.send_text(tune_msg(kiwi.port + 1))
            after = until_state(ws, "error")
        for _ in range(100):
            if kiwi.wf_closed:
                break
            time.sleep(0.02)
        return after, kiwi.wf_closed

    after, closed = run_with_fake(body, wf_bins=carrier_bins(9_420.0), wf_interval=0.05)
    assert closed >= 1
    assert not [p for p in after if p["type"] == "scan" and p["state"] == "done"]


# Value: protects=when the receiver drops after a scan, the idle paired waterfall is closed with it; fails_when=the pump's end skips _end_scan, so the waterfall outlives the receiver connection; why_new=review D6 (state matrix: waterfall-idle x pump-ends); seam=none; no_claim=real Kiwi drop behaviour
@pytest.mark.timeout(20)
def test_a_receiver_drop_closes_the_idle_waterfall():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(scan_msg(1))
            until_scan(ws, "done")
            open_after_scan = kiwi.wf_closed
            until_state(ws, "error")
        for _ in range(100):
            if kiwi.wf_closed:
                break
            time.sleep(0.02)
        return open_after_scan, kiwi.wf_closed

    open_after_scan, closed = run_with_fake(body, wf_bins=carrier_bins(9_420.0), drop_after=400)
    assert (open_after_scan, closed) == (0, 1)


# Value: protects=a scan error on a waterfall that is still open keeps it drained instead of closing it (which would end the audio), and a refusal is remembered so the next request doesn't dial again; fails_when=the KiwiError path closes an open paired waterfall, or refusals aren't cached (review D8, D9, D10); why_new=reopened review findings; seam=stand-in waterfall; no_claim=which real errors leave the waterfall open
# (A refusal while connecting closes instead: test_a_refused_waterfall_is_closed.)
async def test_a_scan_error_keeps_an_open_waterfall_and_is_remembered():
    where = "frame"
    from skywave_radio.kiwi import KiwiError

    sent, made = [], []
    error = KiwiError("busy", "kiwi.test is full")

    async def send_text(payload):
        sent.append(payload)

    class Fails(_ScanWaterfall):
        async def connect(self):
            if where == "connect":
                raise error
            return self.info

    def factory(*args, **kwargs):
        made.append(Fails(frame_error=error))
        return made[-1]

    async def errors(n):
        while sum(p["type"] == "scan" and p["state"] == "error" for p in sent) < n:
            await asyncio.sleep(0.01)

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(errors(1), 2)
    await asyncio.wait_for(made[0].idling.wait(), 2)
    assert not made[0].closed and session._waterfall is made[0]
    await session.handle({"type": "scan", "id": 2})
    await asyncio.wait_for(errors(2), 2)
    assert [(p["id"], p["state"]) for p in sent if p["type"] == "scan"] == [(1, "scanning"), (1, "error"), (2, "error")]
    assert len(made) == 1
    await session.close()
    assert made[0].closed


# Value: protects=only refusals are remembered, for 60 s; a timeout or a dropped connection isn't, so one blip can't hide scans from every listener of a receiver (D10, red team); fails_when=every KiwiError is cached, or refusals keep the 10-minute life; why_new=cycle-2 red team (receiver drop poisoned the cache for 10 minutes); seam=stand-in waterfall, expiry read from the cache; no_claim=which real errors a Kiwi sends
@pytest.mark.parametrize(
    "code,cached", [("busy", True), ("no_apps", True), ("timeout", False), ("closed", False), ("unpaired", False)]
)
async def test_only_refusals_are_remembered_briefly(code, cached):
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import SCAN_REFUSAL_CACHE_S, ScanCache

    cache = ScanCache()

    async def send_text(payload):
        pass

    def factory(*args, **kwargs):
        return _ScanWaterfall(frame_error=KiwiError(code, "kiwi.test said no"))

    session = listening_session(send_text, waterfall_factory=factory, scan_cache=cache)
    await session.handle({"type": "scan", "id": 1})
    for _ in range(100):
        if session._scan is None:
            break
        await asyncio.sleep(0.01)
    target = session._target
    assert isinstance(cache.get(target), str) is cached
    if cached:
        # Kept for the refusal's minute, not the 10 minutes a result gets.
        left = cache._entries[target][0] - time.monotonic()
        assert 0 < left <= SCAN_REFUSAL_CACHE_S
    await session.close()


# Value: protects=a refusal that lands after the listener left the receiver isn't remembered, so a scan cut short by leaving can't hide scans from that receiver's next listeners for a minute; fails_when=the self._target == target guard goes and every refusal is cached; why_new=ship coverage audit (only refusals on the current receiver were tested); seam=stand-in waterfall; no_claim=real timing of a refusal against a switch
async def test_a_refusal_after_leaving_the_receiver_is_not_remembered():
    from skywave_radio.kiwi import KiwiError
    from skywave_radio.session import ScanCache

    cache = ScanCache()
    session = None

    async def send_text(payload):
        pass

    class RefusesAfterLeaving(_ScanWaterfall):
        async def frame(self, zoom, cf):
            session._target = None  # the pump's end clears it before the scan hears the refusal
            raise KiwiError("busy", "kiwi.test is full")

    session = listening_session(send_text, waterfall_factory=RefusesAfterLeaving, scan_cache=cache)
    target = session._target
    await session.handle({"type": "scan", "id": 1})
    async with asyncio.timeout(2):
        while session._scan is not None:
            await asyncio.sleep(0.01)
    assert cache.get(target) is None
    await session.close()


# Value: protects=the scan cache is shared across browser connections, so a receiver scanned for one listener answers the next from cache without a new sweep or W/F (D4); fails_when=create_app stops passing its ScanCache and each session gets its own; why_new=cache hits were tested within one connection only; seam=none; no_claim=cache across service restarts or workers
@pytest.mark.timeout(30)
def test_a_scan_is_shared_with_the_next_listener():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        replies = []
        for scan_id in (1, 2):
            with client.websocket_connect("/ws", headers=ORIGIN) as ws:
                ws.send_text(tune_msg(kiwi.port))
                until_state(ws, "listening")
                ws.send_text(scan_msg(scan_id))
                replies.append([r for r in until_scan(ws, "done") if r["type"] == "scan"])
        return replies, [p for p in kiwi.paths if p.endswith("/W/F")]

    (first, second), wf_paths = run_with_fake(body, wf_bins=carrier_bins(9_420.0))
    assert [r["state"] for r in first] == ["scanning", "done"]
    assert [r["state"] for r in second] == ["done"]
    assert second[-1]["atMs"] == first[-1]["atMs"]
    assert len(wf_paths) == 1


# Value: protects=a refused waterfall kept open repeats the receiver's real refusal on later scans instead of a misleading "never sent its waterfall setup" (Step 11 D4); fails_when=_paired_waterfall reuses a refused waterfall through fast(); why_new=adversarial review (refusal lost after D3); seam=stand-in waterfall; no_claim=how long a real Kiwi keeps a refused socket open
@pytest.mark.usefixtures("no_scan_interval")
async def test_a_kept_refusal_is_repeated_on_later_scans():
    from skywave_radio.kiwi import KiwiError

    sent, made = [], []

    async def send_text(payload):
        sent.append(payload)

    class Refuses(_ScanWaterfall):
        async def connect(self):
            raise KiwiError("busy", "kiwi.test is full (4 listeners max). Try another receiver.")

        async def fast(self):
            raise KiwiError("timeout", "kiwi.test never sent its waterfall setup")

    def factory(*args, **kwargs):
        made.append(Refuses())
        return made[-1]

    async def errors(n):
        while sum(p["type"] == "scan" and p["state"] == "error" for p in sent) < n:
            await asyncio.sleep(0.01)

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(errors(1), 2)
    await session.handle({"type": "scan", "id": 2, "fresh": True})
    await asyncio.wait_for(errors(2), 2)
    messages = [p["message"] for p in sent if p["type"] == "scan" and p["state"] == "error"]
    assert all("is full" in m for m in messages) and len(made) == 1 and not made[0].closed
    await session.close()


# Value: protects=a sweep that got no frame at all answers as an error, not an empty "done" that reads as quiet bands (Step 11 D5); fails_when=bands_done == 0 falls through to a done reply; why_new=adversarial review; seam=stand-in waterfall; no_claim=why a real Kiwi sends no frames
async def test_a_sweep_with_no_frames_is_an_error():
    sent = []

    async def send_text(payload):
        sent.append(payload)

    class Silent(_ScanWaterfall):
        async def frame(self, zoom, cf):
            raise TimeoutError  # what WaterfallClient.frame raises when frames stop

    session = listening_session(send_text, waterfall_factory=lambda *a, **k: Silent())
    await session.handle({"type": "scan", "id": 1})
    for _ in range(200):
        if any(p["type"] == "scan" and p["state"] != "scanning" for p in sent):
            break
        await asyncio.sleep(0.01)
    final = [p for p in sent if p["type"] == "scan"][-1]
    assert final["state"] == "error" and "didn't send its waterfall" in final["message"]
    await session.close()


# Value: protects=a listener's next sweep waits SCAN_MIN_INTERVAL_S after the last; a fresh request sooner gets the last answer without touching the waterfall, so a scripted Scan again loop can't keep a volunteer's Kiwi sweeping (Step 11 D6); fails_when=fresh always sweeps; why_new=adversarial review (no server-side limit); seam=stand-in waterfall, last sweep time aged by hand; no_claim=the web page's own button state
async def test_fresh_scans_are_limited_per_listener():
    from skywave_radio.session import SCAN_MIN_INTERVAL_S
    from skywave_radio.waterfall import WaterfallFrame

    sent, made = [], []
    frames = [0]

    async def send_text(payload):
        sent.append(payload)

    class Sweeps(_ScanWaterfall):
        async def frame(self, zoom, cf):
            frames[0] += 1
            span = 30_000 / 2**zoom
            return WaterfallFrame(zoom, cf - span / 2, span, np.full(1024, 140, dtype=np.uint8))

    def factory(*args, **kwargs):
        made.append(Sweeps())
        return made[-1]

    async def dones(n):
        while sum(p["type"] == "scan" and p["state"] == "done" for p in sent) < n:
            await asyncio.sleep(0.01)

    session = listening_session(send_text, waterfall_factory=factory)
    await session.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(dones(1), 5)
    swept = frames[0]
    await session.handle({"type": "scan", "id": 2, "fresh": True})
    await asyncio.wait_for(dones(2), 5)
    assert frames[0] == swept  # answered from the last sweep
    replies = [p for p in sent if p["type"] == "scan" and p["state"] == "done"]
    assert replies[1]["id"] == 2 and replies[1]["atMs"] == replies[0]["atMs"]
    at, target, state, extra = session._last_sweep
    session._last_sweep = (at - SCAN_MIN_INTERVAL_S - 1, target, state, extra)
    starts = session._sweep_times._starts
    for key in starts:
        starts[key] -= SCAN_MIN_INTERVAL_S + 1
    await session.handle({"type": "scan", "id": 3, "fresh": True})
    await asyncio.wait_for(dones(3), 5)
    assert frames[0] > swept  # swept again once the interval passed
    await session.close()


# Value: protects=a listener who comes back to a receiver on a new connection (a stop, a drop, or a new socket) gets a new sweep, but only once SCAN_MIN_INTERVAL_S has passed since their last one, so reconnecting can't keep a volunteer's Kiwi sweeping and the old connection's answer (an error from a scan the drop cut short, say) isn't replayed; fails_when=_end_scan keeps _last_sweep, or the interval lives only in the session; why_new=TODOS follow-up from the band scan /ship (D8 B) and its review; seam=stand-in waterfall, two sessions sharing SweepTimes as server.py's sockets do, a short interval; no_claim=listeners behind an untrusted proxy (limited per connection)
async def test_a_new_connection_waits_out_the_interval_then_scans_again(monkeypatch):
    from skywave_radio.session import SweepTimes
    from skywave_radio.waterfall import WaterfallFrame

    monkeypatch.setattr("skywave_radio.session.SCAN_MIN_INTERVAL_S", 0.3)
    sent = []
    starts = []

    async def send_text(payload):
        sent.append(payload)

    class Sweeps(_ScanWaterfall):
        async def frame(self, zoom, cf):
            starts.append(time.monotonic())
            span = 30_000 / 2**zoom
            return WaterfallFrame(zoom, cf - span / 2, span, np.full(1024, 140, dtype=np.uint8))

    async def dones(n):
        while sum(p["type"] == "scan" and p["state"] == "done" for p in sent) < n:
            await asyncio.sleep(0.01)

    times = SweepTimes()

    def connect():
        return listening_session(
            send_text, waterfall_factory=lambda *a, **k: Sweeps(), sweep_times=times, client_ip="8.8.8.8"
        )

    first = connect()
    await first.handle({"type": "scan", "id": 1})
    await asyncio.wait_for(dones(1), 5)
    swept_at = starts[0]
    swept = len(starts)
    await first.stop(None)
    assert first._last_sweep is None

    second = connect()
    await second.handle({"type": "scan", "id": 2, "fresh": True})
    await asyncio.wait_for(dones(2), 5)
    assert len(starts) > swept  # a new sweep, not the old answer
    assert starts[swept] - swept_at >= 0.25  # after the interval (less clock slack)
    replies = [p for p in sent if p["type"] == "scan"]
    assert [p["state"] for p in replies if p["id"] == 2] == ["scanning", "done"]
    await first.close()
    await second.close()


# Value: protects=the shared scan cache keeps at most SCAN_CACHE_MAX receivers, dropping the soonest to expire, so it stays bounded over a long uptime (Step 11 D7); fails_when=put stops evicting; why_new=adversarial review (unbounded cache); seam=none; no_claim=memory use itself
def test_the_scan_cache_is_capped():
    from skywave_radio.scan import ScanResult
    from skywave_radio.session import SCAN_CACHE_MAX, ScanCache

    cache = ScanCache()
    for i in range(SCAN_CACHE_MAX + 5):
        cache.put(("kiwi", i), ScanResult())
    assert len(cache._entries) == SCAN_CACHE_MAX
    assert cache.get(("kiwi", 0)) is None and cache.get(("kiwi", SCAN_CACHE_MAX + 4)) is not None


# Value: protects=stopping a session while its own task is being cancelled (the browser left and Starlette or a shutdown cancels the endpoint) lets the canceller's own CancelledError through, so the cancel scope that sent it absorbs it; fails_when=_cancel re-raises the cancelled pump's message-less CancelledError (it lands in websockets' shielded close), which escapes the scope and fails the connection's task (the CI flake in test_receiver_sending_no_usable_audio_times_out); why_new=CI flake root-caused on PR 21; seam=a shielded future stands in for websockets' close; no_claim=uvicorn's own disconnect handling
async def test_stopping_under_a_cancelled_scope_keeps_the_scopes_cancellation():
    import anyio

    from skywave_radio.session import ListenSession

    loop = asyncio.get_running_loop()
    for _ in range(20):
        closed = loop.create_future()

        async def closing():
            await asyncio.shield(closed)  # how websockets waits for its close

        task = asyncio.create_task(closing())
        await asyncio.sleep(0)
        loop.call_later(0.005, lambda f=closed: f.done() or f.set_result(None))
        with anyio.CancelScope() as scope:
            loop.call_soon(scope.cancel)
            await ListenSession._cancel(task)
            await anyio.sleep_forever()
        assert scope.cancelled_caught and task.done()

