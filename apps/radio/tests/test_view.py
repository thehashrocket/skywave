"""The live wide view: the receiver's own waterfall streamed beside the audio."""

import asyncio
import json
import struct
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from skywave_radio.config import Settings
from skywave_radio.server import create_app
from skywave_radio.session import VIEW_TAG, ListenSession
from skywave_radio.waterfall import WaterfallClient, WaterfallFrame

from .test_server import (
    ORIGIN,
    audio_after,
    carrier_bins,
    run_with_fake,
    scan_msg,
    settings,
    tune_msg,
    until_scan,
    until_state,
)


def view_msg(view_id=1, zoom=9, cf=9_650.0):
    return json.dumps({"type": "view", "id": view_id, "zoom": zoom, "cfKhz": cf})


def decode_view(payload: bytes):
    """A 0x05 payload (after the tag): uint32 id, float32 start and span in kHz, then the bins."""
    view_id, start, span = struct.unpack_from("<Iff", payload)
    return view_id, start, span, np.frombuffer(payload[12:], dtype=np.uint8)


def views(ws, n=3, limit=20000):
    """The next n view frames, and every text message seen on the way."""
    frames, texts = [], []
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("text"):
            texts.append(json.loads(msg["text"]))
        elif msg.get("bytes", b"")[:1] == VIEW_TAG:
            frames.append(decode_view(msg["bytes"][1:]))
            if len(frames) >= n:
                return frames, texts
    raise AssertionError(f"only {len(frames)} view frames: {texts}")


def until_scan_counting_views(ws, limit=20000):
    """Messages up to the scan's done reply, and how many view frames came after its scanning one."""
    seen, during, scanning = [], 0, False
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("text"):
            payload = json.loads(msg["text"])
            seen.append(payload)
            if payload.get("type") == "scan":
                scanning = scanning or payload.get("state") == "scanning"
                if payload.get("state") == "done":
                    return seen, during
        elif scanning and msg.get("bytes", b"")[:1] == VIEW_TAG:
            during += 1
    raise AssertionError(f"no scan done: {seen}")


def frames_after_marker(ws, marker_id=99, then=400):
    """Sends a bad view as a marker (answered in order), then counts view frames
    in the `then` messages after its reply."""
    ws.send_text(json.dumps({"type": "view", "id": marker_id, "zoom": 15, "cfKhz": 9650}))
    for _ in range(20000):
        msg = ws.receive()
        if msg.get("text") and json.loads(msg["text"]).get("id") == marker_id:
            break
    return sum(ws.receive().get("bytes", b"")[:1] == VIEW_TAG for _ in range(then))


def until_view_reply(ws, limit=20000):
    seen = []
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("text"):
            payload = json.loads(msg["text"])
            seen.append(payload)
            if payload.get("type") == "view":
                return seen
    raise AssertionError(f"no view reply: {seen}")


def wait_for(check, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end and not check():
        time.sleep(0.02)
    return check()


# Value: protects=a view request streams the receiver's waterfall at that zoom and centre as 0x05 frames under the request's id, on the audio's channel (same timestamp, no extra slot) while the audio plays on; fails_when=frames carry the wrong id, start or span, the W/F opens unpaired or takes a slot, or the audio stops; why_new=the live view is new; seam=none; no_claim=real Kiwi frame rates
@pytest.mark.timeout(20)
def test_a_view_streams_the_receivers_waterfall_beside_the_audio():
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=9_650, mode="am"))
            until_state(ws, "listening")
            ws.send_text(view_msg(4, zoom=9, cf=9_650.0))
            frames, texts = views(ws)
            listeners = client.get("/healthz").json()["listeners"]
            playing = audio_after(ws)
            paths, wf_closed = list(kiwi.paths), kiwi.wf_closed
        return frames, texts, listeners, playing, paths, wf_closed

    frames, texts, listeners, playing, paths, wf_closed = run_with_fake(body, wf_bins=carrier_bins(9_640.0))
    span = 30_000 / 2**9
    for view_id, start, got_span, bins in frames:
        assert view_id == 4
        assert got_span == pytest.approx(span)
        assert start == pytest.approx(9_650.0 - span / 2, abs=0.01)
        assert bins.size == 1024
        assert (start + int(np.argmax(bins)) * span / 1024) == pytest.approx(9_640.0, abs=span / 1024)
    assert not [t for t in texts if t.get("state") == "error"]
    assert listeners == 1 and playing and wf_closed == 0
    snd, wf = paths
    assert snd.endswith("/SND") and wf.endswith("/W/F") and snd.split("/")[2] == wf.split("/")[2]


# Value: protects=a receiver behind a converter (freq_offset) is viewed at RF: the request is shifted to baseband and frames report RF starts, and a centre past the coverage's edge is pulled inside it; fails_when=cf goes to the Kiwi as RF, frames report baseband, or an edge view never matches (no frames); why_new=the live view is new; seam=none; no_claim=real converter setups
@pytest.mark.timeout(20)
def test_a_view_works_in_rf_behind_a_converter_and_stays_inside_the_coverage():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=10_000, mode="am"))
            until_state(ws, "listening")
            ws.send_text(view_msg(1, zoom=7, cf=10_000.0))  # 100 kHz past the lowest RF it covers
            frames, _ = views(ws)
            commands = [c for c in kiwi.wf_commands if isinstance(c, str) and c.startswith("SET zoom=7")]
        return frames, commands

    frames, commands = run_with_fake(body, freq_offset_khz=9_900.0)
    span = 30_000 / 2**7
    assert commands and commands[-1] == f"SET zoom=7 cf={span / 2:.3f}"
    for _, start, _, _ in frames:
        assert start == pytest.approx(9_900.0, abs=0.01)


# Value: protects=a scan while the view streams sweeps on the view's own waterfall (no second W/F), pausing the frames, and the view comes back on its id once the sweep is done; fails_when=the scan opens another W/F, the view stays on the sweep's last band or stops for good, or the audio ends; why_new=owner decision: freeze the live view during a sweep and keep the auto-scan; seam=none; no_claim=real sweep timing
@pytest.mark.timeout(30)
def test_a_scan_pauses_the_view_on_the_same_waterfall_and_it_comes_back():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=9_650, mode="am"))
            until_state(ws, "listening")
            ws.send_text(view_msg(2, zoom=9, cf=9_650.0))
            views(ws, n=1)
            ws.send_text(scan_msg(1))
            replies, during = until_scan_counting_views(ws)
            after, _ = views(ws)
            playing = audio_after(ws)
            wf_paths = [p for p in kiwi.paths if p.endswith("/W/F")]
            wf_closed = kiwi.wf_closed
        return replies, during, after, playing, wf_paths, wf_closed

    replies, during, after, playing, wf_paths, wf_closed = run_with_fake(body, wf_bins=carrier_bins(9_420.0))
    assert replies[-1]["signals"][0]["freqKhz"] == 9_420.0
    # The fake sends about 200 frames a second: a view leaking through the
    # sweep would show dozens. One may still have been on its way as it began.
    assert during <= 1
    span = 30_000 / 2**9
    for view_id, start, _, _ in after:
        assert view_id == 2 and start == pytest.approx(9_650.0 - span / 2, abs=0.01)
    assert playing and len(wf_paths) == 1 and wf_closed == 0


# Value: protects=a view asked for mid-sweep waits for the sweep and then streams (not lost, not pointing the Kiwi mid-sweep), and a view after a scan reuses the scan's waterfall; fails_when=the deferred view is dropped, or it opens a second W/F; why_new=the live view is new; seam=none; no_claim=real sweep timing
@pytest.mark.timeout(30)
def test_a_view_asked_for_mid_scan_starts_when_the_sweep_ends():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=9_650, mode="am"))
            until_state(ws, "listening")
            ws.send_text(scan_msg(1))
            until_scan(ws, "scanning")
            ws.send_text(view_msg(3, zoom=9, cf=9_650.0))
            # In arrival order: the sweep's answer, then the view's frames.
            order = []
            while len([o for o in order if o == "frame"]) < 3:
                msg = ws.receive()
                if msg.get("text"):
                    t = json.loads(msg["text"])
                    if t.get("type") == "scan":
                        order.append(t["state"])
                elif msg.get("bytes", b"")[:1] == VIEW_TAG:
                    order.append("frame")
                    assert decode_view(msg["bytes"][1:])[0] == 3
            zooms = [c for c in kiwi.wf_commands if isinstance(c, str) and c.startswith("SET zoom=")]
            wf_paths = [p for p in kiwi.paths if p.endswith("/W/F")]
        return order, zooms, wf_paths

    order, zooms, wf_paths = run_with_fake(body, wf_bins=carrier_bins(9_420.0))
    assert "done" in order and order.index("done") < order.index("frame")
    # The view's SET zoom went out only after every one of the sweep's.
    view_at = next(i for i, c in enumerate(zooms) if c.startswith("SET zoom=9 "))
    assert all(c.startswith("SET zoom=9 ") for c in zooms[view_at:])
    assert len(wf_paths) == 1


# Value: protects=a view of null stops the frames but keeps the paired waterfall open (closing it would end the audio), and Stop then closes it; fails_when=frames keep coming, the W/F is closed on null, or outlives the session; why_new=the live view is new; seam=none; no_claim=real close ordering
@pytest.mark.timeout(20)
def test_no_view_stops_the_frames_but_keeps_the_waterfall_until_stop():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=9_650, mode="am"))
            until_state(ws, "listening")
            ws.send_text(view_msg(1))
            views(ws, n=1)
            ws.send_text(json.dumps({"type": "view", "zoom": None}))
            stray = frames_after_marker(ws)
            open_then = kiwi.wf_closed
            playing = audio_after(ws)
            ws.send_text(json.dumps({"type": "stop"}))
            until_state(ws, "stopped")
        closed = wait_for(lambda: kiwi.wf_closed == 1)
        speeds = [c for c in kiwi.wf_commands if isinstance(c, str) and c.startswith("SET wf_speed=")]
        return stray, open_then, playing, closed, speeds

    stray, open_then, playing, closed, speeds = run_with_fake(body)
    assert stray <= 1  # at most one that was already being sent
    assert open_then == 0 and playing and closed
    assert speeds[-1] == "SET wf_speed=1"  # back to idling


# Value: protects=a malformed view (bad zoom, id or centre) and one the receiver refuses are answered as view errors only, and the audio plays on; fails_when=either becomes a status error (the browser would think the radio stopped) or ends the audio; why_new=the live view is new; seam=none; no_claim=which refusals real Kiwis send
@pytest.mark.timeout(20)
@pytest.mark.parametrize(
    "request_",
    [
        {"type": "view", "id": 1, "zoom": 15, "cfKhz": 9650},
        {"type": "view", "id": 1, "zoom": True, "cfKhz": 9650},
        {"type": "view", "id": -1, "zoom": 9, "cfKhz": 9650},
        {"type": "view", "id": 1, "zoom": 9, "cfKhz": "9650"},
        {"type": "view", "id": 1, "zoom": 9, "cfKhz": 40_000},
    ],
)
def test_a_bad_view_is_a_view_error_and_the_audio_plays_on(request_):
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(json.dumps(request_))
            seen = until_view_reply(ws)
            playing = audio_after(ws)
            wf_paths = [p for p in kiwi.paths if p.endswith("/W/F")]
        return seen, playing, wf_paths

    seen, playing, wf_paths = run_with_fake(body)
    assert seen[-1]["state"] == "error" and "isn't one this service can show" in seen[-1]["message"]
    assert not [s for s in seen if s["type"] == "status" and s["state"] == "error"]
    assert playing and wf_paths == []


# Value: protects=a receiver refusing the waterfall answers the view with an error naming why, never a status error, and the audio plays on; fails_when=the refusal goes out as a status or ends the audio; why_new=the live view is new; seam=none; no_claim=which refusals real Kiwis send
@pytest.mark.timeout(20)
def test_a_refused_view_is_a_view_error_and_the_audio_plays_on():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(view_msg(5))
            seen = until_view_reply(ws)
            playing = audio_after(ws)
        return seen, playing

    seen, playing = run_with_fake(body, wf_reject=b"MSG too_busy=4")
    assert seen[-1] == {"type": "view", "id": 5, "state": "error", "message": seen[-1]["message"]}
    assert "Couldn't show this receiver's waterfall" in seen[-1]["message"]
    assert not [s for s in seen if s["type"] == "status" and s["state"] == "error"]
    assert playing


# Value: protects=a view asked for before anything plays is ignored without an error (the browser asks again on listening), and opens no waterfall; fails_when=it dials a W/F with no audio to pair with, or answers with an error; why_new=the live view is new; seam=none; no_claim=none
@pytest.mark.timeout(20)
def test_a_view_before_listening_does_nothing():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(view_msg(1))
            ws.send_text(tune_msg(kiwi.port))
            seen = until_state(ws, "listening")
            playing = audio_after(ws)
            wf_paths = [p for p in kiwi.paths if p.endswith("/W/F")]
        return seen, playing, wf_paths

    seen, playing, wf_paths = run_with_fake(body)
    assert not [s for s in seen if s.get("type") == "view" or s.get("state") == "error"]
    assert playing and wf_paths == []


# Value: protects=a browser slow to take view frames gets the newest one when it's ready and the rest are dropped, so the reader keeping the paired waterfall (and the audio) alive never waits on it; fails_when=frames queue up behind a blocked send or the reader awaits the send; why_new=the live view is new; seam=send_bytes held by hand; no_claim=real socket back-pressure
async def test_a_slow_browser_drops_view_frames_instead_of_holding_the_reader():
    release = asyncio.Event()
    sent: list[bytes] = []

    async def send_bytes(data: bytes) -> None:
        await release.wait()
        sent.append(data)

    async def send_text(_payload) -> None:
        pass

    session = ListenSession(Settings.from_env(), send_text, send_bytes)
    waterfall = WaterfallClient("127.0.0.1", 1)
    frame = WaterfallFrame(zoom=9, start_khz=9_600.0, span_khz=58.6, bins=np.zeros(1024, dtype=np.uint8))
    for _ in range(5):
        session._forward_view(waterfall, 7, frame)  # returns at once, even with the send held
    release.set()
    await asyncio.sleep(0.05)
    assert len(sent) == 1
    view_id, start, span, bins = decode_view(sent[0][1:])
    assert (view_id, bins.size) == (7, 1024)
    assert start == pytest.approx(9_600.0) and span == pytest.approx(58.6, abs=1e-4)
    session._forward_view(waterfall, 7, frame)  # the send is done: the next frame goes
    await asyncio.sleep(0.05)
    assert len(sent) == 2


# Value: protects=a malformed view sent while one streams stops that stream and is answered under its own id, so the browser can tell which request failed; fails_when=the old view keeps streaming after the service dropped it, or the error goes out with a null id; why_new=service review; seam=none; no_claim=none
@pytest.mark.timeout(20)
def test_a_bad_view_while_streaming_stops_it_and_names_the_request():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port, freq=9_650, mode="am"))
            until_state(ws, "listening")
            ws.send_text(view_msg(1))
            views(ws, n=1)
            ws.send_text(view_msg(2, zoom=15))
            reply = [t for t in until_view_reply(ws) if t["type"] == "view"][-1]
            stray = frames_after_marker(ws)
            playing = audio_after(ws)
        return reply, stray, playing

    reply, stray, playing = run_with_fake(body)
    assert (reply["id"], reply["state"]) == (2, "error")
    assert stray <= 1 and playing


# Value: protects=Stop, or a switch, while the view's waterfall is still in its handshake ends it with the audio: the half-open W/F is closed, the slot frees once and the switch plays the next receiver; fails_when=a W/F is left on the volunteer's channel, a slot is held or the switch fails, or Stop hangs on the handshake; why_new=service review: no teardown test for the view's tasks; seam=none; no_claim=real handshake timing (the fake never sends wf_setup)
@pytest.mark.timeout(30)
@pytest.mark.parametrize("end", ["stop", "switch"])
def test_ending_while_the_view_opens_closes_its_waterfall(end):
    def body(kiwi):
        client = TestClient(create_app(settings()))
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            ws.send_text(view_msg(1))
            assert wait_for(lambda: any(p.endswith("/W/F") for p in kiwi.paths))
            time.sleep(0.1)  # in its handshake: the fake never sends wf_setup
            started = time.monotonic()
            if end == "stop":
                ws.send_text(json.dumps({"type": "stop"}))
                until_state(ws, "stopped")
            else:
                ws.send_text(tune_msg(kiwi.port, host="localhost"))
                until_state(ws, "connecting")
                seen = until_state(ws, "listening")
                assert seen[-1]["host"] == "localhost"
            took = time.monotonic() - started
            closed = wait_for(lambda: kiwi.wf_closed >= 1)
            listeners = client.get("/healthz").json()["listeners"]
            playing = end == "stop" or audio_after(ws)
        return took, closed, listeners, playing

    took, closed, listeners, playing = run_with_fake(body, wf_no_setup=True)
    assert took < 5  # never waits out the handshake's timeout
    assert closed and playing
    assert listeners == (0 if end == "stop" else 1)


# Value: protects=ending the receiver connection stops the view's opener and its frame send with the scan tasks, so neither outlives the connection (an opener left running could store a waterfall against the next one); fails_when=_end_scan leaves _view_open or _view_send running; why_new=service review; the integration test can't see the task (the half-open W/F is aborted either way); seam=ListenSession._view_open and ._view_send set by hand; no_claim=real handshake timing
async def test_ending_stops_the_view_opener_and_its_send():
    async def send(_):
        pass

    session = ListenSession(Settings.from_env(), send, send)
    opener = asyncio.create_task(asyncio.sleep(100))
    sending = asyncio.create_task(asyncio.sleep(100))
    session._view_open, session._view_send = opener, sending
    await session._end_scan()
    await asyncio.sleep(0)
    assert opener.cancelled() and sending.cancelled()
    assert session._view_open is None and session._view_send is None

