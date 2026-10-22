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
    base = dict(
        allowed_origins=("http://localhost:3000",),
        token=None,
        max_sessions=2,
        max_session_minutes=60,
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


def wait_for_free_slots(client, within_s=5.0):
    started = time.monotonic()
    while client.get("/healthz").json()["listeners"]:
        assert time.monotonic() - started < within_s, "the listener slot was never freed"
        time.sleep(0.05)


# Value: protects=a Kiwi that stops reading ends the session with 'stopped reading' and frees the slot, even though closing its socket would block too; fails_when=close() waits on the full socket with no bound, or the send timeout doesn't end the session; why_new=only _send was tested, against a stub with no close(); seam=KiwiClient._ws (a socket whose sends and close never finish); no_claim=real TCP buffer sizes
@pytest.mark.timeout(15)
def test_kiwi_that_stops_reading_ends_the_session_and_frees_the_slot():
    def body(kiwi):
        client = TestClient(create_app(settings(max_sessions=1), client_factory=partial(_StopsReading, timeout_s=0.5)))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            statuses = until_state(ws, "error", "stopped")
            wait_for_free_slots(client)
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
            with client.websocket_connect("/ws", headers=ORIGIN) as ws2:
                ws2.send_text(tune_msg(kiwi.port))
                second = until_state(ws2, "listening", "error")
        return first, second

    first, second = run_with_fake(body)
    assert first[-1]["state"] == "stopped"
    assert "session limit" in first[-1]["message"]
    assert second[-1]["state"] == "listening"


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


# Value: protects=the browser isn't left showing "Listening" with no audio after we give up on it; fails_when=the server keeps its receive loop open after a stall; why_new=Codex O6; seam=none; no_claim=uvicorn closing the transport when the app returns (its documented behaviour)
async def test_a_stalled_browser_is_disconnected(monkeypatch):
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
        "client": ("8.8.8.8", 50000),
        "server": ("testserver", 80),
        "scheme": "ws",
        "subprotocols": [],
        "asgi": {"version": "3.0"},
    }
    await asyncio.wait_for(app(scope, receive, send), 5)
    assert app.state.slots.active == 0


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
    await session.handle({"type": "scan", "id": 3, "fresh": True})
    await asyncio.wait_for(dones(3), 5)
    assert frames[0] > swept  # swept again once the interval passed
    await session.close()


# Value: protects=the shared scan cache keeps at most SCAN_CACHE_MAX receivers, dropping the soonest to expire, so it stays bounded over a long uptime (Step 11 D7); fails_when=put stops evicting; why_new=adversarial review (unbounded cache); seam=none; no_claim=memory use itself
def test_the_scan_cache_is_capped():
    from skywave_radio.scan import ScanResult
    from skywave_radio.session import SCAN_CACHE_MAX, ScanCache

    cache = ScanCache()
    for i in range(SCAN_CACHE_MAX + 5):
        cache.put(("kiwi", i), ScanResult())
    assert len(cache._entries) == SCAN_CACHE_MAX
    assert cache.get(("kiwi", 0)) is None and cache.get(("kiwi", SCAN_CACHE_MAX + 4)) is not None
