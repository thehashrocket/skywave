import asyncio
import socket
import threading

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


async def test_unresolvable_name_is_a_dns_rejection(monkeypatch):
    def fail(host, port):
        raise socket.gaierror(socket.EAI_NONAME, "not known")

    monkeypatch.setattr(hostguard, "_getaddrinfo", fail)
    with pytest.raises(HostRejected) as e:
        await resolve_receiver("gone.ddns.net", 8073, allow_private=False)
    assert e.value.code == "dns"


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
    with pytest.raises(HostRejected, match="too long"):
        await resolve_receiver("theirs.ddns.net", 8073, allow_private=False, owner=someone_else)

    stuck_resolver.set()
    await _until_no_lookups_pending()
    assert await resolve_receiver("next.ddns.net", 8073, allow_private=False, owner=me) == "8.8.8.8"
