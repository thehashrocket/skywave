import asyncio
import socket
import threading
import time

import pytest

from skywave_radio import hostguard
from skywave_radio.hostguard import HostRejected, resolve_receiver


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.20",
        "169.254.169.254",
        "::1",
        "localhost",
        "100.64.0.1",  # carrier NAT / Tailscale
        "100.100.100.100",  # Tailscale MagicDNS
    ],
)
async def test_private_addresses_blocked(host):
    with pytest.raises(HostRejected) as e:
        await resolve_receiver(host, 8073, allow_private=False)
    assert e.value.code == "blocked"


async def test_private_allowed_when_enabled():
    assert await resolve_receiver("127.0.0.1", 8073, allow_private=True) == "127.0.0.1"


@pytest.mark.parametrize("host", ["", "foo bar", "http://x.com", "a" * 300])
async def test_junk_rejected(host):
    with pytest.raises(HostRejected) as e:
        await resolve_receiver(host, 8073, allow_private=True)
    assert e.value.code == "invalid"


async def test_bad_port():
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("8.8.8.8", 70000, allow_private=False)
    assert e.value.code == "invalid"


# Value: protects=a dead name (gone, or its DNS server dead) is the receiver's fault and Pick best skips it, while this service's own resolver trouble stops it; fails_when=errno mapping flips either way; why_new=only EAI_NONAME was tested; seam=none; no_claim=which errno each OS returns for a dead name
@pytest.mark.parametrize(
    "errno,code",
    [
        (socket.EAI_NONAME, "dns"),
        (socket.EAI_AGAIN, "dns"),  # also what a dead name's unreachable DNS server looks like
        (socket.EAI_FAIL, "dns"),
        (socket.EAI_MEMORY, None),
        (socket.EAI_SYSTEM, None),
    ],
)
async def test_resolver_failures_are_coded_by_whose_fault_they_are(monkeypatch, errno, code):
    def fail(host, port):
        raise socket.gaierror(errno, "nope")

    monkeypatch.setattr(hostguard, "_getaddrinfo", fail)
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("gone.ddns.net", 8073, allow_private=False)
    assert e.value.code == code


# Value: protects=a refused name doesn't tell the client what it resolves to inside our network; fails_when=the address goes back into the message; why_new=TODOS small edges; seam=none; no_claim=none beyond protects
async def test_blocked_message_does_not_reveal_the_address(monkeypatch):
    monkeypatch.setattr(
        hostguard, "_getaddrinfo", lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", port))]
    )
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("intranet.example", 8073, allow_private=False)
    assert e.value.code == "blocked"
    assert "10.1.2.3" not in str(e.value)


@pytest.fixture
def stuck_resolver(monkeypatch):
    """A resolver whose lookups block until the test lets them go."""
    release = threading.Event()

    def hang(host, port):
        release.wait(5)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]

    monkeypatch.setattr(hostguard, "_getaddrinfo", hang)
    monkeypatch.setattr(hostguard, "DNS_TIMEOUT_S", 0.05)
    yield release
    release.set()


async def _until_no_lookups_pending():
    for _ in range(100):
        if hostguard._pending == 0:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("lookups still pending")


async def test_slow_resolver_gives_up(stuck_resolver):
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("slow.ddns.net", 8073, allow_private=False)
    assert e.value.code == "dns"
    assert "too long" in str(e.value)
    stuck_resolver.set()
    await _until_no_lookups_pending()


async def test_stuck_lookups_are_capped_until_they_finish(stuck_resolver, monkeypatch):
    monkeypatch.setattr(hostguard, "MAX_PENDING_LOOKUPS", 1)
    with pytest.raises(HostRejected, match="too long"):
        await resolve_receiver("dead.ddns.net", 8073, allow_private=False)
    # The timed-out lookup still holds its thread, so the next one is refused
    # at once, with no code: the service is busy, the receiver isn't at fault.
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("other.ddns.net", 8073, allow_private=False)
    assert e.value.code is None
    assert "stuck" in str(e.value)

    stuck_resolver.set()
    await _until_no_lookups_pending()
    assert await resolve_receiver("other.ddns.net", 8073, allow_private=False) == "8.8.8.8"


# Value: protects=Pick best's next receiver still gets looked up when the dead name before it finally fails with "not known"; fails_when=_wait_for_previous_lookup stops swallowing the earlier lookup's own error, so a raw gaierror escapes instead of a result; why_new=stuck_resolver lookups always end in success; seam=none; no_claim=real OS resolver timing
async def test_next_lookup_proceeds_when_the_stuck_one_fails(monkeypatch):
    release = threading.Event()

    def resolve(host, port):
        if host == "dead.ddns.net":
            release.wait(5)
            raise socket.gaierror(socket.EAI_NONAME, "not known")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]

    monkeypatch.setattr(hostguard, "_getaddrinfo", resolve)
    monkeypatch.setattr(hostguard, "DNS_TIMEOUT_S", 0.3)
    me = type("Listener", (), {})()
    try:
        with pytest.raises(HostRejected, match="too long"):
            await resolve_receiver("dead.ddns.net", 8073, allow_private=False, owner=me)
        # The dead lookup fails while the next one is waiting on it.
        asyncio.get_running_loop().call_later(0.05, release.set)
        assert await resolve_receiver("next.ddns.net", 8073, allow_private=False, owner=me) == "8.8.8.8"
    finally:
        release.set()
    await _until_no_lookups_pending()


# Value: protects=a cancelled earlier lookup can't leave the next tune hanging on "connecting"; fails_when=CancelledError from the earlier future escapes _wait_for_previous_lookup; why_new=adversarial review; seam=hostguard._last_lookup; no_claim=how often the pool cancels queued lookups
async def test_next_lookup_proceeds_when_the_earlier_one_is_cancelled():
    from concurrent.futures import Future

    me = type("Listener", (), {})()
    earlier: Future = Future()
    hostguard._last_lookup[me] = earlier
    asyncio.get_running_loop().call_later(0.05, earlier.cancel)
    await asyncio.wait_for(hostguard._wait_for_previous_lookup(me), timeout=2)


async def test_public_ip_literal_ok():
    assert await resolve_receiver("8.8.8.8", 8073, allow_private=False) == "8.8.8.8"


async def test_one_listener_holds_at_most_one_lookup(stuck_resolver):
    class Listener:
        pass

    me, someone_else = Listener(), Listener()
    with pytest.raises(HostRejected, match="too long"):
        await resolve_receiver("dead.ddns.net", 8073, allow_private=False, owner=me)
    # My stuck lookup blocks my next one (no code: it's about us), not anyone else's.
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("next.ddns.net", 8073, allow_private=False, owner=me)
    assert e.value.code is None
    assert "last address lookup" in str(e.value)
    assert e.value.retry_after_ms == hostguard.RETRY_AFTER_MS
    with pytest.raises(HostRejected, match="too long"):
        await resolve_receiver("theirs.ddns.net", 8073, allow_private=False, owner=someone_else)

    stuck_resolver.set()
    await _until_no_lookups_pending()
    assert await resolve_receiver("next.ddns.net", 8073, allow_private=False, owner=me) == "8.8.8.8"


# Value: protects=several sockets from one client get one lookup between them, however they race; fails_when=the claim isn't checked under the lock after waiting, so every waiter starts a lookup; why_new=Codex O1 (shared IP keys made this reachable); seam=none; no_claim=real sockets (owner key passed directly)
async def test_simultaneous_waiters_from_one_client_start_one_lookup(monkeypatch):
    dead_released, others_released = threading.Event(), threading.Event()
    started = []

    def resolve(host, port):
        started.append(host)
        (dead_released if host == "dead.ddns.net" else others_released).wait(5)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]

    monkeypatch.setattr(hostguard, "_getaddrinfo", resolve)
    monkeypatch.setattr(hostguard, "DNS_TIMEOUT_S", 0.3)
    client = ("ip", "203.0.113.9")
    try:
        with pytest.raises(HostRejected, match="too long"):
            await resolve_receiver("dead.ddns.net", 8073, allow_private=False, owner=client)
        asyncio.get_running_loop().call_later(0.05, dead_released.set)
        results = await asyncio.gather(
            *(resolve_receiver(f"r{i}.ddns.net", 8073, allow_private=False, owner=client) for i in range(3)),
            return_exceptions=True,
        )
    finally:
        dead_released.set()
        others_released.set()
    await _until_no_lookups_pending()
    assert len([h for h in started if h != "dead.ddns.net"]) == 1
    refused = [r for r in results if isinstance(r, HostRejected) and r.retry_after_ms]
    assert len(refused) == 2


# Value: protects=--reload, container stop and Ctrl-C don't wait on lookups stuck on dead names; fails_when=lookups go back to a non-daemon pool; why_new=Codex O2 showed shutdown(wait=False) doesn't help; seam=none; no_claim=real OS resolver
def test_a_stuck_lookup_does_not_hold_up_exit():
    import subprocess
    import sys

    script = """
import asyncio, time
from skywave_radio import hostguard
hostguard._getaddrinfo = lambda host, port: time.sleep(60)
hostguard.DNS_TIMEOUT_S = 0.1
async def main():
    try:
        await hostguard.resolve_receiver("stuck.ddns.net", 8073, allow_private=False)
    except hostguard.HostRejected:
        pass
asyncio.run(main())
"""
    started = time.monotonic()
    subprocess.run([sys.executable, "-c", script], check=True, timeout=30)
    assert time.monotonic() - started < 10


# Value: protects=a session cancelled while waiting on its earlier lookup actually stops (switch or Stop mid-lookup); fails_when=_wait_for_previous_lookup swallows its own CancelledError; why_new=only the earlier future's cancellation was tested; seam=hostguard._last_lookup; no_claim=real resolver timing
async def test_cancelling_a_waiting_lookup_cancels_it():
    from concurrent.futures import Future

    me = ("ip", "8.8.4.4")
    earlier: Future = Future()
    earlier.set_running_or_notify_cancel()
    hostguard._last_lookup[me] = earlier
    try:
        waiter = asyncio.create_task(hostguard._wait_for_previous_lookup(me))
        await asyncio.sleep(0.05)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
    finally:
        earlier.set_result([])
        hostguard._last_lookup.pop(me, None)
