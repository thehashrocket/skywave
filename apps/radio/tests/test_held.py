"""GET /held: which of the receivers asked about are at Skywave's per-receiver cap."""

import pytest
from fastapi.testclient import TestClient

from skywave_radio.server import NOISE_MAX_RECEIVERS, create_app

from .test_server import ORIGIN, run_with_fake, settings, tune_msg, until_state


# Value: protects=the page learns which receivers already have as many Skywave listeners as the cap allows, keyed the way it asked (host lowercased) and only for receivers it asked about; fails_when=/held keys Slots differently from a tune (case, port type), answers receivers nobody asked about, or reports one below the cap; why_new=#155's report showed skywave_cap as the most common refusal, and Pick best can only steer around it if the service says where Skywave already is; seam=app.state.slots filled directly; no_claim=that the page uses the answer
def test_held_answers_only_receivers_at_the_cap_among_those_asked():
    app = create_app(settings(max_sessions=5, max_sessions_per_receiver=1, max_sessions_per_ip=None))
    slots = app.state.slots
    slots.acquire(("a.example", 8073), None)
    slots.acquire(("c.example", 8073), None)  # at the cap, but not asked about
    client = TestClient(app)
    r = client.get("/held", params={"receivers": "A.example:8073,b.example:8073"}, headers=ORIGIN)
    assert r.status_code == 200
    assert r.json() == {"held": ["a.example:8073"]}
    assert r.headers["access-control-allow-origin"] == ORIGIN["origin"]
    assert r.headers["cache-control"] == "no-store"


# Value: protects=a receiver below MAX_SESSIONS_PER_RECEIVER isn't reported held, so Pick best doesn't push back a receiver that still has room; fails_when=/held reports any receiver with a Skywave listener instead of one at the cap; why_new=the cap is configurable and tests run with 2; seam=app.state.slots filled directly; no_claim=none
def test_held_waits_for_the_cap_not_the_first_listener():
    app = create_app(settings(max_sessions=5, max_sessions_per_receiver=2, max_sessions_per_ip=None))
    app.state.slots.acquire(("a.example", 8073), None)
    client = TestClient(app)
    assert client.get("/held", params={"receivers": "a.example:8073"}, headers=ORIGIN).json() == {"held": []}
    app.state.slots.acquire(("a.example", 8073), None)
    assert client.get("/held", params={"receivers": "a.example:8073"}, headers=ORIGIN).json() == {
        "held": ["a.example:8073"]
    }


# Value: protects=a receiver a real tune is playing on reads as held, and frees when it stops, so the key /held builds matches the one a tune takes; fails_when=the session keys its lease differently from parse_receivers' host:port (case, port as text), or a stop doesn't release it; why_new=the other tests fill Slots by hand; seam=fake Kiwi on loopback; no_claim=real Kiwi behaviour
@pytest.mark.timeout(20)
def test_a_playing_receiver_is_held_until_it_stops():
    def body(kiwi):
        app = create_app(settings(max_sessions_per_receiver=1))
        client = TestClient(app)
        key = f"127.0.0.1:{kiwi.port}"
        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.send_text(tune_msg(kiwi.port))
            until_state(ws, "listening")
            assert client.get("/held", params={"receivers": key}, headers=ORIGIN).json() == {"held": [key]}
            ws.send_text('{"type": "stop"}')
            until_state(ws, "stopped")
        return client.get("/held", params={"receivers": key}, headers=ORIGIN).json()

    assert run_with_fake(body) == {"held": []}


# Value: protects=/held refuses what /noise refuses (no receivers, a malformed pair, too many, extra parameters) with a 400 that still carries CORS, so the page can't be made to do unbounded work and reads a refusal as no answer; fails_when=a bad query is answered or crashes, or the cap on receivers is dropped; why_new=new public endpoint with no token; seam=TestClient; no_claim=none
@pytest.mark.parametrize(
    "params",
    [
        {},
        {"receivers": ""},
        {"receivers": "a.example"},
        {"receivers": "a.example:0"},
        {"receivers": "a.example:8073", "band": "ham-40m"},
        {"receivers": ",".join(f"r{i}.example:8073" for i in range(NOISE_MAX_RECEIVERS + 1))},
        # receivers= twice: each list is within the cap, together they'd pass it.
        [("receivers", "a.example:8073"), ("receivers", "b.example:8073")],
    ],
)
def test_held_refuses_a_bad_query(params):
    r = TestClient(create_app(settings())).get("/held", params=params, headers=ORIGIN)
    assert r.status_code == 400
    assert r.headers["access-control-allow-origin"] == ORIGIN["origin"]


# Value: protects=/held gives CORS only to the WebSocket's origins and answers their preflight, like /noise; fails_when=the preflight isn't registered for /held or echoes any origin; why_new=new public endpoint; seam=TestClient; no_claim=browser preflight caching
def test_held_cors_is_for_the_websockets_origins_only():
    client = TestClient(create_app(settings()))
    other = client.get("/held", params={"receivers": "a:8073"}, headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers
    pre = client.options("/held", headers={**ORIGIN, "access-control-request-method": "GET"})
    assert pre.status_code == 204
    assert pre.headers["access-control-allow-origin"] == ORIGIN["origin"]
