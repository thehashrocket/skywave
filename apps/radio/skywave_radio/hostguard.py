"""Validates receiver addresses before we dial them.

This service connects to whatever host the browser asks for, which makes it
a potential SSRF proxy. We resolve the name ourselves, refuse anything that
lands on a private, loopback, link-local or otherwise non-public address, and
then dial the exact IP we checked.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket

HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$")


class HostRejected(Exception):
    pass


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


async def resolve_receiver(host: str, port: int, *, allow_private: bool) -> str:
    """Return an IP address to dial for host:port, or raise HostRejected."""
    host = host.strip().lower()
    if not 1 <= port <= 65535:
        raise HostRejected("Port must be between 1 and 65535.")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is None and not HOSTNAME_RE.match(host):
        raise HostRejected("That doesn't look like a hostname.")

    if literal is not None:
        candidates = [literal]
    else:
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise HostRejected(f"Couldn't resolve {host}.") from e
        candidates = [ipaddress.ip_address(info[4][0]) for info in infos]

    if not candidates:
        raise HostRejected(f"Couldn't resolve {host}.")
    if not allow_private:
        blocked = [ip for ip in candidates if not _is_public(ip)]
        if blocked:
            raise HostRejected(f"{host} resolves to a non-public address ({blocked[0]}).")
    # Prefer IPv4; plenty of Kiwis sit behind home routers without IPv6.
    candidates.sort(key=lambda ip: ip.version)
    return str(candidates[0])
