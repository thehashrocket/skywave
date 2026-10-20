"""Validates receiver addresses before we dial them.

This service connects to whatever host the browser asks for, which makes it
a potential SSRF proxy. We resolve the name ourselves, refuse anything that
lands on a private, loopback, link-local or otherwise non-public address, and
then dial the exact IP we checked.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
import threading
from collections.abc import Hashable
from concurrent.futures import Future

log = logging.getLogger(__name__)

# A dead dynamic-DNS name can stall the resolver for a long time; give up
# well before the browser's patience runs out.
DNS_TIMEOUT_S = 10.0

# Giving up doesn't stop the lookup: its thread runs until the OS resolver
# does. Each lookup gets its own daemon thread (so a stuck one never holds up
# process exit), and once this many are still running we refuse new ones
# instead of letting dead names starve the rest.
MAX_PENDING_LOOKUPS = 8
_pending = 0
_pending_lock = threading.Lock()
# Each client's last lookup, so one client can't hold more than one thread.
# Keyed by whatever identifies the client (see resolve_receiver's `owner`);
# an entry goes away when its lookup's thread finishes.
_last_lookup: dict[Hashable, Future] = {}

# How long the browser should wait before retrying after "still waiting on
# the last lookup". The stuck lookup has no known end, so this is a guess.
RETRY_AFTER_MS = 5000

# Resolver failures that are about the name being looked up. Anything else
# (out of memory, a system error) is this service's problem, not the receiver's.
_NAME_ERRNOS = {
    getattr(socket, name)
    for name in ("EAI_NONAME", "EAI_NODATA", "EAI_AGAIN", "EAI_FAIL", "EAI_ADDRFAMILY")
    if hasattr(socket, name)
}

HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$")


class HostRejected(Exception):
    """A receiver address we won't dial.

    `code` tells the browser what's wrong with the receiver: "invalid" (not a
    hostname or port), "dns" (didn't resolve) or "blocked" (resolves somewhere
    non-public). None means the refusal is about this service being busy, not
    the receiver, so the browser shouldn't move on to another one.

    `retry_after_ms`, when set, tells the browser the same receiver may work
    if it tries again after that long.
    """

    def __init__(self, code: str | None, message: str, *, retry_after_ms: int | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after_ms = retry_after_ms


def _still_waiting() -> HostRejected:
    return HostRejected(
        None, "Still waiting on the last address lookup; try again in a moment.", retry_after_ms=RETRY_AFTER_MS
    )


def is_public_address(address: str) -> bool:
    """True for a public IP literal; False for anything else, names included."""
    try:
        return _is_public(ipaddress.ip_address(address))
    except ValueError:
        return False


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


def _lookup_finished(owner: Hashable | None, fut: Future) -> None:
    global _pending
    with _pending_lock:
        _pending -= 1
        if owner is not None and _last_lookup.get(owner) is fut:
            del _last_lookup[owner]


def _run_lookup(fut: Future, host: str, port: int) -> None:
    try:
        fut.set_result(_getaddrinfo(host, port))
    except BaseException as e:
        fut.set_exception(e)


def _in_flight(owner: Hashable | None) -> Future | None:
    """This client's lookup whose thread is still running, if any."""
    prev = _last_lookup.get(owner) if owner is not None else None
    return prev if prev is not None and not prev.done() else None


async def _wait_for_previous_lookup(owner: Hashable | None) -> None:
    """Let this client's earlier lookup finish before starting another."""
    prev = _in_flight(owner)
    if prev is None:
        return
    try:
        await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(prev)), timeout=DNS_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        raise _still_waiting() from e
    except asyncio.CancelledError:
        # The earlier lookup was cancelled while queued, which finishes it as
        # far as we care. Only our own cancellation goes up.
        task = asyncio.current_task()
        if task is not None and task.cancelling():
            raise
    except Exception:
        pass  # its failure was already reported to whoever asked


def _lookup(host: str, port: int, owner: Hashable | None) -> asyncio.Future:
    """Start a lookup on its own thread, or refuse if too many are stuck."""
    global _pending
    fut: Future = Future()
    # Running from the start, so giving up on it (which cancels the asyncio
    # wrapper) can't mark it done while its thread is still resolving.
    fut.set_running_or_notify_cancel()
    with _pending_lock:
        # Checked and claimed under the lock: several sockets from one client
        # can all see the previous lookup finish at once, and only one may go.
        if _in_flight(owner):
            raise _still_waiting()
        if _pending >= MAX_PENDING_LOOKUPS:
            raise HostRejected(None, "The radio service has too many address lookups stuck; try again shortly.")
        _pending += 1
        if owner is not None:
            _last_lookup[owner] = fut
    # Fires when the thread actually finishes, not when we stop waiting.
    fut.add_done_callback(lambda f: _lookup_finished(owner, f))
    try:
        threading.Thread(target=_run_lookup, args=(fut, host, port), name="dns", daemon=True).start()
    except BaseException as e:
        fut.set_exception(e)
        raise
    return asyncio.wrap_future(fut)


async def resolve_receiver(host: str, port: int, *, allow_private: bool, owner: Hashable | None = None) -> str:
    """Return an IP address to dial for host:port, or raise HostRejected.

    `owner` identifies the client (its public IP, or else its session) and
    limits each one to one lookup thread.
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
            # A timeout or EAI_AGAIN usually means the receiver's own DNS is
            # dead, which we can't tell from a hiccup here, so those stay "dns".
            if e.errno not in _NAME_ERRNOS:
                log.warning("looking up %s failed: %s", host, e)
                raise HostRejected(None, f"The radio service couldn't look up {host}; try again shortly.") from e
            raise HostRejected("dns", f"Couldn't resolve {host}.") from e
        except asyncio.TimeoutError as e:
            raise HostRejected("dns", f"Looking up {host} took too long.") from e
        candidates = [ipaddress.ip_address(info[4][0]) for info in infos]

    if not candidates:
        raise HostRejected("dns", f"Couldn't resolve {host}.")
    if not allow_private:
        blocked = [ip for ip in candidates if not _is_public(ip)]
        if blocked:
            # The address stays in our log: echoing it would tell any client
            # what internal names resolve to.
            log.info("refused %s: resolves to %s", host, blocked[0])
            raise HostRejected("blocked", f"{host} resolves to a non-public address.")
    # Prefer IPv4; plenty of Kiwis sit behind home routers without IPv6.
    candidates.sort(key=lambda ip: ip.version)
    return str(candidates[0])
