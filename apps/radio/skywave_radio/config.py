"""Settings, read once from the environment."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _minutes(name: str, default: str) -> float:
    # nan or a misplaced decimal point would end every session the moment it
    # starts, and a number too big for a float (in minutes or in seconds)
    # would quietly mean no limit: only a spelled-out inf/infinity does that.
    raw = os.environ.get(name, default)
    problem = ValueError(f"{name} must be at least 1 minute (or inf for no limit), not {raw!r}")
    try:
        value = float(raw)
    except ValueError:
        raise problem from None
    if math.isnan(value) or value < 1:
        raise problem
    if math.isinf(value * 60) and raw.strip().lower().lstrip("+") not in {"inf", "infinity"}:
        raise problem
    return value


def _count(name: str, default: str) -> int:
    raw = os.environ.get(name, default)
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value < 1:
        raise ValueError(f"{name} must be a whole number of at least 1, not {raw!r}")
    return value


def _split(origin: str) -> tuple[str, str | None, int | None] | None:
    """(scheme, hostname, port) for an origin, or None if it doesn't parse.

    Origin is a client-supplied header, so a port like :99999 or a broken
    [IPv6 literal must be a refusal, not an exception in the handler.
    """
    try:
        u = urlsplit(origin)
        return u.scheme, u.hostname, u.port
    except ValueError:
        return None


def is_local_origin(origin: str) -> bool:
    """True for browser origins on this machine, like http://localhost:3000."""
    parts = _split(origin)
    return parts is not None and parts[1] in LOCAL_HOSTNAMES


def origin_allowed(origin: str | None, allowed: tuple[str, ...]) -> bool:
    """True if a browser origin may connect.

    localhost, 127.0.0.1 and [::1] are the same machine, so allowing one of
    them on a port allows the others on that port too.
    """
    if "*" in allowed or origin in allowed:
        return True
    o = _split(origin) if origin else None
    if o is None or o[1] not in LOCAL_HOSTNAMES:
        return False
    for a in allowed:
        parts = _split(a)
        if parts and parts[1] in LOCAL_HOSTNAMES and parts[0] == o[0] and parts[2] == o[2]:
            return True
    return False


@dataclass(frozen=True)
class Settings:
    # Browser origins allowed to open the listening WebSocket. Empty means
    # nobody; "*" means anybody.
    allowed_origins: tuple[str, ...]
    # Shared secret the browser must pass as ?token=... Required as soon as
    # any allowed origin is not localhost, since scripts can fake Origin.
    token: str | None
    # Hard cap on simultaneous listeners. Each one occupies a channel on
    # somebody's volunteer-run Kiwi, so keep this small.
    max_sessions: int
    # Disconnect from the Kiwi after this long even if the tab is still open.
    max_session_minutes: float
    # Allow Kiwis on private/LAN addresses. Off by default so this service
    # can't be used to poke at your internal network.
    allow_private_hosts: bool
    # Name shown in the Kiwi's user list.
    ident: str
    # Let the Kiwi apply its own AGC before we get I/Q.
    kiwi_agc: bool
    # Close a browser's socket after this long with no session playing and
    # no message from it; the page opens a new one on its next tune.
    idle_socket_minutes: float
    # Browser sockets one public address (IPv6 by /64) may hold open at once,
    # so a script can't exhaust the service by opening sockets and keeping them
    # alive. Private and unknown addresses aren't counted (see socket_owner).
    max_sockets_per_ip: int

    @classmethod
    def from_env(cls) -> Settings:
        origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000")
        return cls(
            allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
            token=os.environ.get("RADIO_TOKEN") or None,
            max_sessions=int(os.environ.get("MAX_SESSIONS", "2")),
            max_session_minutes=_minutes("MAX_SESSION_MINUTES", "60"),
            allow_private_hosts=_bool("ALLOW_PRIVATE_HOSTS", False),
            ident=os.environ.get("KIWI_IDENT", "skywave"),
            kiwi_agc=_bool("KIWI_AGC", True),
            idle_socket_minutes=_minutes("IDLE_SOCKET_MINUTES", "10"),
            max_sockets_per_ip=_count("MAX_SOCKETS_PER_IP", "8"),
        )
