import asyncio
import json
import struct

import numpy as np
from fastapi.testclient import TestClient

from skywave_radio.config import Settings
from skywave_radio.server import create_app

from .fakekiwi import FakeKiwi


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
    client = TestClient(create_app(settings()))
    try:
        with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive()
        assert False, "should have been closed"
    except Exception:
        pass


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


def test_listener_limit():
    client = TestClient(create_app(settings(max_sessions=1)))
    h = {"origin": "http://localhost:3000"}
    with client.websocket_connect("/ws", headers=h):
        with client.websocket_connect("/ws", headers=h) as ws2:
            msg = json.loads(ws2.receive_text())
            assert "listener limit" in msg["message"]


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
