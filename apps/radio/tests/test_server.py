import asyncio
import json
import threading
import time

import numpy as np
import pytest
from fastapi import WebSocketDisconnect, status
from fastapi.testclient import TestClient

from skywave_radio.config import Settings, origin_allowed
from skywave_radio.server import create_app

from .fakekiwi import FakeKiwi

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
            arr = np.frombuffer(b[1:], dtype="<f4")
            (audio if b[0] == 1 else spectra).append(arr)
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


def test_listen_end_to_end():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            statuses, audio, spectra = collect(ws)
            ws.send_text(json.dumps({"type": "stop"}))
        return kiwi, statuses, audio, spectra

    kiwi, statuses, audio, spectra = run_with_fake(body, tone_hz=1000)
    states = [s["state"] for s in statuses if s["type"] == "status"]
    assert states[:2] == ["connecting", "listening"]
    listening = next(s for s in statuses if s.get("state") == "listening")
    assert listening["sampleRate"] == 12000.0
    assert any(s["type"] == "meter" for s in statuses)
    assert all(a.dtype == np.float32 for a in audio)
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
