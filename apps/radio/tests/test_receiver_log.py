"""The receiver log (#144): one shaped line per receiver error, refusal of ours
and receiver that starts playing, with the service's load (#146)."""

from __future__ import annotations

import asyncio
import logging

import numpy as np
import pytest

from skywave_radio.hostguard import HostRejected, loggable_host
from skywave_radio.kiwi import IQBlock, KiwiError
from skywave_radio.server import attach_receiver_log
from skywave_radio.session import Slots, receiver_log

from .test_listener_caps import QuietClient, listening, resolver, session, tune

RATE = 12000.0
BLOCK = 1200  # samples: 0.1 s at RATE


@pytest.fixture
def lines(caplog):
    caplog.set_level(logging.INFO, logger=receiver_log.name)

    def read() -> list[str]:
        return [r.getMessage() for r in caplog.records if r.name == receiver_log.name]

    return read


async def until(check, timeout=5.0):
    async with asyncio.timeout(timeout):
        while not check():
            await asyncio.sleep(0.01)


class RefusesAfterAudio(QuietClient):
    """Plays `blocks` blocks of 0.1 s, then refuses the way a full Kiwi does."""

    blocks_before = 10

    async def blocks(self):
        rng = np.random.default_rng(0)
        for seq in range(self.blocks_before):
            samples = (rng.standard_normal(BLOCK) * 0.01).astype(np.complex64)
            yield IQBlock(seq=seq, rssi_dbm=-80.0, samples=samples, adc_overflow=False)
            await asyncio.sleep(0)
        raise KiwiError("busy", "kiwi.example is full (4 listeners max). Try another receiver.", detail="too_busy=4")


# Value: protects=a refusal after audio logs code, raw detail, seconds of audio actually sent and the load, and the play before it logs a listening line (#144 D1/D7, #146); fails_when=either line is missing, detail or audio_s is wrong, or listeners is left out; why_new=the service never logged receiver outcomes; seam=none (stand-in Kiwi client); no_claim=real Kiwi timing
async def test_a_refusal_after_audio_logs_detail_audio_and_load(lines):
    slots = Slots(10, per_receiver=1)
    s, _ = session(slots)
    s._client_factory = RefusesAfterAudio
    await s.handle(tune("Kiwi.Example", ident="N0CALL"))
    await until(lambda: any(line.startswith("event=error") for line in lines()))
    got = lines()
    assert got[0] == "event=listening host=kiwi.example port=8073 code=- detail=- audio_s=0.0 listeners=1"
    assert got[1] == "event=error host=kiwi.example port=8073 code=busy detail=too_busy=4 audio_s=1.0 listeners=1"
    # The listener's name never goes in the log.
    assert not any("N0CALL" in line for line in got)
    await s.close()


# Value: protects=a Stop or switch is not logged as a receiver failure; fails_when=the cancel paths write an error line; why_new=new log; seam=none (stand-in Kiwi client); no_claim=a cancel landing inside a Kiwi call (covered for statuses elsewhere)
async def test_a_stop_logs_no_error(lines):
    slots = Slots(10, per_receiver=1)
    s, _ = session(slots)
    await s.handle(tune("kiwi.example"))
    await listening(s)
    await s.handle({"type": "stop"})
    await until(lambda: slots.active == 0)
    assert [line.split()[0] for line in lines()] == ["event=listening"]
    await s.close()


# Value: protects=a lookup refusal is logged with its code, and the service-side one (no code) as service; fails_when=HostRejected skips the log or logs code=-; why_new=new log; seam=stub resolver; no_claim=real DNS
@pytest.mark.parametrize("code,logged", [("dns", "dns"), (None, "service")])
async def test_a_lookup_refusal_is_logged(lines, code, logged):
    async def refuse(host, port, *, allow_private, owner):
        raise HostRejected(code, "nope")

    s, _ = session(Slots(10, per_receiver=1))
    s._resolver = refuse
    await s.handle(tune("nowhere.example"))
    await until(lambda: bool(lines()))
    # listeners counts this session too: it holds its slot until the pump ends, as /healthz counts it.
    assert lines() == [f"event=error host=nowhere.example port=8073 code={logged} detail=- audio_s=0.0 listeners=1"]
    await s.close()


# Value: protects=our own per-receiver cap answers skywave_cap only to a page that lists that code, busy (as before) to an older open tab, and logs skywave_cap=N either way (#144 D3, D8); fails_when=old tabs get the new code (Pick best would stop) or new ones still get busy, or the refusal isn't logged; why_new=the cap was sent as busy and never logged; seam=none; no_claim=production MAX_SESSIONS_PER_RECEIVER
@pytest.mark.parametrize("extra,code", [({"codes": ["skywave_cap"]}, "skywave_cap"), ({}, "busy"), ({"codes": "skywave_cap"}, "busy")])
async def test_our_cap_is_its_own_code_for_pages_that_know_it(lines, extra, code):
    slots = Slots(10, per_receiver=1)
    first, _ = session(slots)
    second, sent = session(slots)
    await first.handle(tune("kiwi.example"))
    await listening(first)
    await second.handle(tune("kiwi.example", **extra))
    assert (sent[-1]["state"], sent[-1]["code"]) == ("error", code)
    assert lines()[-1] == f"event=refused host=kiwi.example port=8073 code={code} detail=skywave_cap=1 audio_s=0.0 listeners=1"
    await first.close()
    await second.close()


# Value: protects=a host from the browser reaches the log only as a checked hostname or IP address (#144 D5); fails_when=loggable_host passes free text, newlines or non-strings; why_new=new rule; seam=none; no_claim=none beyond protects
@pytest.mark.parametrize(
    "host,shown",
    [
        ("Kiwi.Example.", "kiwi.example"),
        ("192.0.2.7", "192.0.2.7"),
        ("2001:DB8::1", "2001:db8::1"),
        ("bad host!", "<invalid>"),
        ("kiwi.example\nevent=fake", "<invalid>"),
        ("alice@example.com", "<invalid>"),
        (None, "<invalid>"),
        (8073, "<invalid>"),
    ],
)
def test_only_checked_hosts_reach_the_log(host, shown):
    assert loggable_host(host) == shown


# Value: protects=RECEIVER_LOG sends the lines to a rotating file (once per path), none when unset, and a path that can't be opened never stops the service (#144 D4); fails_when=no file, a second handler per create_app, or attach raises; why_new=no file logging existed; seam=none; no_claim=Docker volume permissions on the Droplet
def test_the_receiver_log_file(tmp_path, caplog):
    assert attach_receiver_log(None) is None
    path = tmp_path / "receivers.log"
    handler = attach_receiver_log(str(path))
    try:
        assert handler is not None
        assert attach_receiver_log(str(path)) is handler
        receiver_log.info("event=listening host=kiwi.example")
        handler.flush()
        assert "event=listening host=kiwi.example" in path.read_text()
    finally:
        receiver_log.removeHandler(handler)
        handler.close()
    with caplog.at_level(logging.WARNING):
        assert attach_receiver_log(str(tmp_path / "missing" / "receivers.log")) is None
    assert "stdout only" in caplog.text


class FailsWhenCancelled(QuietClient):
    """Plays silence until cancelled, then turns the cancel into a KiwiError, as a send to a closing Kiwi does."""

    async def blocks(self):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            raise KiwiError("closed", "kiwi.example closed the connection", detail="close=1000") from None
        yield


# Value: protects=a Stop whose cancel lands inside a Kiwi call (and so arrives as a KiwiError) is not logged as the receiver failing; fails_when=_run writes the error line before checking that the task is being cancelled; why_new=test_a_stop_logs_no_error only covers a plain cancel; seam=none (stand-in Kiwi client); no_claim=which real calls convert cancels
async def test_a_stop_turned_into_a_kiwi_error_logs_no_error(lines):
    slots = Slots(10, per_receiver=1)
    s, _ = session(slots)
    s._client_factory = FailsWhenCancelled
    await s.handle(tune("kiwi.example"))
    await listening(s)
    await s.handle({"type": "stop"})
    await until(lambda: slots.active == 0)
    assert [line.split()[0] for line in lines()] == ["event=listening"]
    await s.close()


# Value: protects=RECEIVER_LOG reaches Settings, create_app attaches the file from it, and production points it at the radio_data volume so a rebuild keeps it (#144 D4); fails_when=the env name drifts, create_app stops calling attach_receiver_log, or compose moves the file off /data; why_new=test_the_receiver_log_file calls attach directly; seam=none; no_claim=Docker volume permissions on the Droplet
def test_receiver_log_setting_reaches_the_file_and_the_volume(tmp_path, monkeypatch):
    from pathlib import Path

    from skywave_radio.config import Settings
    from skywave_radio.server import create_app

    from .test_server import settings

    monkeypatch.setenv("RECEIVER_LOG", "")
    assert Settings.from_env().receiver_log is None
    path = str(tmp_path / "receivers.log")
    monkeypatch.setenv("RECEIVER_LOG", path)
    assert Settings.from_env().receiver_log == path
    before = list(receiver_log.handlers)
    create_app(settings(receiver_log=path))
    added = [h for h in receiver_log.handlers if h not in before]
    try:
        assert [h.baseFilename for h in added] == [path]
    finally:
        for h in added:
            receiver_log.removeHandler(h)
            h.close()
    compose = (Path(__file__).resolve().parents[3] / "docker-compose.prod.yml").read_text()
    assert "RECEIVER_LOG: /data/receivers.log" in compose
    assert "- radio_data:/data" in compose
