"""Per-receiver and per-address slot caps, and dial retunes that never open a channel."""

from __future__ import annotations

import asyncio

import pytest

from skywave_radio.kiwi import KiwiInfo
from skywave_radio.session import ListenSession, Slots

from .test_server import settings


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


def session(slots, owner=None):
    sent: list[dict] = []

    async def send_text(payload):
        sent.append(payload)

    async def nothing(_):
        pass

    s = ListenSession(
        settings(), send_text, nothing, slots=slots, resolver=resolver, client_factory=QuietClient, owner=owner
    )
    return s, sent


def tune(host, **extra):
    return {"type": "tune", "host": host, "port": 8073, "freqKhz": 7200, "mode": "usb", **extra}


async def listening(s):
    while not s._listening:
        await asyncio.sleep(0.01)


# --- Slots on its own ---


def test_slots_cap_each_receiver_and_owner():
    slots = Slots(10, per_receiver=1, per_owner=2)
    a = slots.acquire(("a", 8073), "1.2.3.4")
    assert not isinstance(a, str)
    assert slots.acquire(("a", 8073), "5.6.7.8") == "receiver"
    b = slots.acquire(("b", 8073), "1.2.3.4")
    assert not isinstance(b, str)
    assert slots.acquire(("c", 8073), "1.2.3.4") == "owner"
    assert not isinstance(slots.acquire(("c", 8073), None), str)  # uncounted owner
    slots.release(a)
    slots.release(a)  # a lease frees once
    assert slots.active == 2
    assert not isinstance(slots.acquire(("a", 8073), "1.2.3.4"), str)


def test_slots_overall_limit_still_applies():
    slots = Slots(1, per_receiver=5, per_owner=5)
    assert not isinstance(slots.acquire(("a", 8073), "x"), str)
    assert slots.acquire(("b", 8073), "y") == "full"


# Value: protects=while Skywave is full, a receiver that already has a Skywave listener (or an address at its own cap) is refused as "full", so the page says Skywave is full and the receiver log counts skywave_full, not skywave_cap (#146 review D3); fails_when=the per-receiver or per-owner check runs before the overall limit again; why_new=the order was receiver-first, so a full service hid behind skywave_cap on held receivers; seam=none; no_claim=how Pick best orders held receivers (use-pick-best.test.ts)
def test_slots_full_beats_the_receiver_and_owner_caps():
    slots = Slots(1, per_receiver=1, per_owner=1)
    assert not isinstance(slots.acquire(("a", 8073), "x"), str)
    assert slots.acquire(("a", 8073), "y") == "full"
    assert slots.acquire(("b", 8073), "x") == "full"
    assert not slots.receiver_full(("b", 8073))  # /held is unaffected


def test_slots_move_respects_the_new_receivers_cap():
    slots = Slots(10, per_receiver=1)
    a = slots.acquire(("a", 8073), None)
    slots.acquire(("b", 8073), None)
    assert not slots.move(a, ("b", 8073))
    assert slots.move(a, ("c", 8073))
    assert (slots.on_receiver(("a", 8073)), slots.on_receiver(("c", 8073))) == (0, 1)


# --- Sessions ---


async def test_a_second_listener_on_a_full_receiver_gets_a_coded_busy():
    slots = Slots(10, per_receiver=1)
    first, _ = session(slots)
    second, sent = session(slots)
    await first.handle(tune("kiwi.example"))
    await listening(first)
    await second.handle(tune("KIWI.example"))
    assert sent[-1]["state"] == "error"
    assert (sent[-1]["code"], sent[-1]["host"], sent[-1]["port"]) == ("busy", "kiwi.example", 8073)
    assert slots.active == 1
    # Another receiver is fine.
    await second.handle(tune("other.example"))
    await listening(second)
    assert slots.active == 2
    await first.close()
    await second.close()
    await asyncio.sleep(0)
    assert slots.active == 0


# Value: protects=an older page (no `codes`) switching a playing session onto a receiver at our cap keeps the old order: the current receiver stops, its slot frees, and the answer is busy (#144); fails_when=old pages get the refused event they can't read, or the slot leaks; why_new=the switch path used to be tested only with busy; seam=none; no_claim=production MAX_SESSIONS_PER_RECEIVER
async def test_an_old_page_switching_onto_a_full_receiver_frees_the_slot():
    slots = Slots(10, per_receiver=1)
    first, _ = session(slots)
    second, sent = session(slots)
    await first.handle(tune("busy.example"))
    await second.handle(tune("free.example"))
    await listening(first)
    await listening(second)
    await second.handle(tune("busy.example"))
    assert sent[-1]["code"] == "busy"
    assert slots.active == 1
    assert slots.on_receiver(("free.example", 8073)) == 0
    await first.close()


# Value: protects=a page that knows skywave_cap switching onto a receiver at our cap is refused before anything stops: one "refused" message naming both receivers, then the session's own listening status, and the current receiver plays on with its slot and frequency (owner D5/D8, #144); fails_when=the cap is checked only after the old pump stops, the refusal goes out as an error status, or a refused switch changes the session; why_new=D5 reopened with the one-message design; seam=none; no_claim=how the page and Pick best read the message (web tests)
async def test_switching_onto_a_full_receiver_keeps_the_current_one():
    slots = Slots(10, per_receiver=1)
    first, _ = session(slots)
    second, sent = session(slots)
    await first.handle(tune("busy.example"))
    await second.handle(tune("free.example"))
    await listening(first)
    await listening(second)
    before = len(sent)
    await second.handle({**tune("busy.example", codes=["skywave_cap"]), "freqKhz": 9535})
    answers = sent[before:]
    assert [p.get("type", "status") for p in answers] == ["refused", "status"]
    refused, status = answers
    assert (refused["host"], refused["port"], refused["code"]) == ("busy.example", 8073, "skywave_cap")
    assert refused["stillOn"] == {"host": "free.example", "port": 8073}
    assert status["state"] == "listening" and status["host"] == "free.example"
    assert not any(p.get("state") == "error" for p in answers)
    assert second._listening and second._freq_khz == 7200
    assert slots.active == 2
    assert slots.on_receiver(("free.example", 8073)) == 1
    await first.close()
    await second.close()


async def test_one_address_cant_hold_more_than_its_share():
    slots = Slots(10, per_receiver=5, per_owner=1)
    first, _ = session(slots, owner="203.0.113.7")
    second, sent = session(slots, owner="203.0.113.7")
    await first.handle(tune("a.example"))
    await listening(first)
    await second.handle(tune("b.example"))
    assert sent[-1]["state"] == "error"
    assert "code" not in sent[-1]  # uncoded: another receiver won't help
    # Switching receivers in the same tab keeps its one slot.
    await first.handle(tune("b.example"))
    await listening(first)
    assert slots.active == 1
    await first.close()


async def test_a_late_dial_retune_doesnt_start_a_session():
    slots = Slots(10)
    s, sent = session(slots)
    await s.handle(tune("kiwi.example", retune=True))
    assert sent == []
    assert slots.active == 0
    assert s._pump is None


async def test_a_dial_retune_still_retunes_what_plays():
    slots = Slots(10)
    s, sent = session(slots)
    await s.handle(tune("kiwi.example"))
    await listening(s)
    await s.handle({**tune("kiwi.example", retune=True), "freqKhz": 7250})
    assert sent[-1]["state"] == "listening"
    assert sent[-1]["freqKhz"] == 7250
    await s.close()


async def test_a_dial_retune_for_another_receiver_reports_what_plays():
    slots = Slots(10)
    s, sent = session(slots)
    await s.handle(tune("now.example"))
    await listening(s)
    await s.handle(tune("before.example", retune=True))
    assert (sent[-1]["state"], sent[-1]["host"]) == ("listening", "now.example")
    assert slots.active == 1
    await s.close()


# --- Receivers whose owners opted out ---


def test_parse_blocked():
    import pytest

    from skywave_radio.config import parse_blocked

    assert parse_blocked(" Kiwi.Example. , other.example:8074, [2001:db8::1]:8073, 2001:db8::2 ,") == {
        ("kiwi.example", None),
        ("other.example", 8074),
        ("2001:db8::1", 8073),
        ("2001:db8::2", None),
    }
    assert parse_blocked("") == frozenset()
    with pytest.raises(ValueError):
        parse_blocked("kiwi.example:0")


async def test_a_blocked_receiver_is_refused_with_a_coded_error():
    from dataclasses import replace

    sent: list[dict] = []

    async def send_text(payload):
        sent.append(payload)

    async def nothing(_):
        pass

    slots = Slots(10)
    s = ListenSession(
        replace(settings(), blocked_receivers=frozenset({("kiwi.example", None), ("other.example", 8074)})),
        send_text,
        nothing,
        slots=slots,
        resolver=resolver,
        client_factory=QuietClient,
    )
    await s.handle(tune("KIWI.example"))
    assert (sent[-1]["state"], sent[-1]["code"], sent[-1]["host"]) == ("error", "blocked", "kiwi.example")
    assert slots.active == 0
    # Only the listed port of other.example is blocked.
    await s.handle({**tune("other.example"), "port": 8073})
    await listening(s)
    # Switching onto a blocked receiver frees the slot.
    await s.handle({**tune("other.example"), "port": 8074})
    assert sent[-1]["code"] == "blocked"
    assert slots.active == 0
