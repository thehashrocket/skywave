"""Settings, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit

LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def is_local_origin(origin: str) -> bool:
    """True for browser origins on this machine, like http://localhost:3000."""
    return urlsplit(origin).hostname in LOCAL_HOSTNAMES


def origin_allowed(origin: str | None, allowed: tuple[str, ...]) -> bool:
    """True if a browser origin may connect.

    localhost, 127.0.0.1 and [::1] are the same machine, so allowing one of
    them on a port allows the others on that port too.
    """
    if "*" in allowed or origin in allowed:
        return True
    if not origin or not is_local_origin(origin):
        return False
    o = urlsplit(origin)
    return any(
        is_local_origin(a) and urlsplit(a).scheme == o.scheme and urlsplit(a).port == o.port for a in allowed
    )


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

    @classmethod
    def from_env(cls) -> Settings:
        origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000")
        return cls(
            allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
            token=os.environ.get("RADIO_TOKEN") or None,
            max_sessions=int(os.environ.get("MAX_SESSIONS", "2")),
            max_session_minutes=float(os.environ.get("MAX_SESSION_MINUTES", "60")),
            allow_private_hosts=_bool("ALLOW_PRIVATE_HOSTS", False),
            ident=os.environ.get("KIWI_IDENT", "skywave"),
            kiwi_agc=_bool("KIWI_AGC", True),
        )
