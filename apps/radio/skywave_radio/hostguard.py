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
import threading
import weakref
from concurrent.futures import Future, ThreadPoolExecutor

# A dead dynamic-DNS name can stall the resolver for a long time; give up
# well before the browser's patience runs out.
DNS_TIMEOUT_S = 10.0

# Giving up doesn't stop the lookup: its thread runs until the OS resolver
# does. Lookups get their own small pool, and once this many are still
# running we refuse new ones instead of letting dead names starve the rest.
MAX_PENDING_LOOKUPS = 8
_dns_pool = ThreadPoolExecutor(max_workers=MAX_PENDING_LOOKUPS, thread_name_prefix="dns")
_pending = 0
_pending_lock = threading.Lock()
# Each listener's last lookup, so one client can't hold more than one thread.
_last_lookup: weakref.WeakKeyDictionary[object, Future] = weakref.WeakKeyDictionary()

HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$")


class HostRejected(Exception):
    """A receiver address we won't dial.

    `code` tells the browser what's wrong with the receiver: "invalid" (not a
    hostname or port), "dns" (didn't resolve) or "blocked" (resolves somewhere
    non-public). None means the refusal is about this service being busy, not
    the receiver, so the browser shouldn't move on to another one.
    """

    def __init__(self, code: str | None, message: str):
        super().__init__(message)
        self.code = code


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # is_global is an allowlist: it also refuses ranges the flags below miss,
    # like 100.64.0.0/10 (carrier NAT, and every Tailscale address).
    return ip.is_global and not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _getaddrinfo(host: str, port: int):
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def _lookup_finished(_: Future | None = None) -> None:
    global _pending
    with _pending_lock:
        _pending -= 1


async def _wait_for_previous_lookup(owner: object | None) -> None:
    """Let this listener's earlier lookup finish before starting another."""
    prev = _last_lookup.get(owner) if owner is not None else None
    if prev is None or prev.done():
        return
    try:
        await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(prev)), timeout=DNS_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        raise HostRejected(None, "Still waiting on the last address lookup; try again in a moment.") from e
    except asyncio.CancelledError:
        # The earlier lookup was cancelled while queued, which finishes it as
        # far as we care. Only our own cancellation goes up.
        task = asyncio.current_task()
        if task is not None and task.cancelling():
            raise
    except Exception:
        pass  # its failure was already reported to whoever asked


def _lookup(host: str, port: int, owner: object | None) -> asyncio.Future:
    """Start a lookup on the DNS pool, or refuse if too many are stuck."""
    global _pending
    with _pending_lock:
        if _pending >= MAX_PENDING_LOOKUPS:
            raise HostRejected(None, "The radio service has too many address lookups stuck; try again shortly.")
        _pending += 1
    try:
        fut = _dns_pool.submit(_getaddrinfo, host, port)
    except BaseException:
        _lookup_finished()
        raise
    # Fires when the thread actually finishes, not when we stop waiting.
    fut.add_done_callback(_lookup_finished)
    if owner is not None:
        _last_lookup[owner] = fut
    return asyncio.wrap_future(fut)


async def resolve_receiver(host: str, port: int, *, allow_private: bool, owner: object | None = None) -> str:
    """Return an IP address to dial for host:port, or raise HostRejected.

    `owner` (the listening session) limits each listener to one lookup thread.
    """
    host = host.strip().lower()
    if not 1 <= port <= 65535:
        raise HostRejected("invalid", "Port must be between 1 and 65535.")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is None and not HOSTNAME_RE.match(host):
        raise HostRejected("invalid", "That doesn't look like a hostname.")

    if literal is not None:
        candidates = [literal]
    else:
        await _wait_for_previous_lookup(owner)
        try:
            infos = await asyncio.wait_for(_lookup(host, port, owner), timeout=DNS_TIMEOUT_S)
        except socket.gaierror as e:
            raise HostRejected("dns", f"Couldn't resolve {host}.") from e
        except asyncio.TimeoutError as e:
            raise HostRejected("dns", f"Looking up {host} took too long.") from e
        candidates = [ipaddress.ip_address(info[4][0]) for info in infos]

    if not candidates:
        raise HostRejected("dns", f"Couldn't resolve {host}.")
    if not allow_private:
        blocked = [ip for ip in candidates if not _is_public(ip)]
        if blocked:
            raise HostRejected("blocked", f"{host} resolves to a non-public address ({blocked[0]}).")
    # Prefer IPv4; plenty of Kiwis sit behind home routers without IPv6.
    candidates.sort(key=lambda ip: ip.version)
    return str(candidates[0])
