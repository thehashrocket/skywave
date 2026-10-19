import pytest

from skywave_radio.hostguard import HostRejected, resolve_receiver


@pytest.mark.parametrize("host", ["127.0.0.1", "10.0.0.5", "192.168.1.20", "169.254.169.254", "::1", "localhost"])
async def test_private_addresses_blocked(host):
    with pytest.raises(HostRejected):
        await resolve_receiver(host, 8073, allow_private=False)


async def test_private_allowed_when_enabled():
    assert await resolve_receiver("127.0.0.1", 8073, allow_private=True) == "127.0.0.1"


@pytest.mark.parametrize("host", ["", "foo bar", "http://x.com", "a" * 300])
async def test_junk_rejected(host):
    with pytest.raises(HostRejected):
        await resolve_receiver(host, 8073, allow_private=True)


async def test_bad_port():
    with pytest.raises(HostRejected):
        await resolve_receiver("8.8.8.8", 70000, allow_private=False)


async def test_public_ip_literal_ok():
    assert await resolve_receiver("8.8.8.8", 8073, allow_private=False) == "8.8.8.8"
