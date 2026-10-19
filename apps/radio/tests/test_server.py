import asyncio
import json
import time

import numpy as np
import pytest
from fastapi import WebSocketDisconnect, status
from fastapi.testclient import TestClient

from skywave_radio.config import Settings
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
    import threading

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
        with client.websocket_connect("/ws", headers={"origin": "http://localhost:3000"}) as ws:
            ws.send_text(json.dumps({"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 7200, "mode": "usb"}))
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
        with client.websocket_connect("/ws", headers={"origin": "http://localhost:3000"}) as ws:
            ws.send_text(json.dumps({"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 7030, "mode": "cw"}))
            collect(ws, want_audio=1, want_spectrum=0)
        return kiwi

    kiwi = run_with_fake(body)
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=7029.300" in kiwi.commands


def test_retune_reuses_connection():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers={"origin": "http://localhost:3000"}) as ws:
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
        ws.send_text(json.dumps({"type": "tune", "host": "x.org", "freqKhz": 99999, "mode": "am"}))
        assert "between 0 and 32,000" in json.loads(ws.receive_text())["message"]


def test_private_host_blocked_by_default():
    client = TestClient(create_app(settings(allow_private_hosts=False)))
    with client.websocket_connect("/ws", headers={"origin": "http://localhost:3000"}) as ws:
        ws.send_text(json.dumps({"type": "tune", "host": "127.0.0.1", "port": 8073, "freqKhz": 9535, "mode": "am"}))
        statuses = [json.loads(ws.receive_text()) for _ in range(2)]
    assert statuses[-1]["state"] == "error"
    assert "non-public" in statuses[-1]["message"]


def test_validation_errors():
    client = TestClient(create_app(settings()))
    with client.websocket_connect("/ws", headers={"origin": "http://localhost:3000"}) as ws:
        ws.send_text(json.dumps({"type": "tune", "host": "x.org", "port": 8073, "freqKhz": 99999, "mode": "am"}))
        assert "between 0 and 32,000" in json.loads(ws.receive_text())["message"]
        ws.send_text(json.dumps({"type": "tune", "host": "x.org", "freqKhz": 7000, "mode": "fm"}))
        assert "Mode must be" in json.loads(ws.receive_text())["message"]


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
    async def slow_resolver(host, port, *, allow_private):
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
