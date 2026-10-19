"""Settings, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Browser origins allowed to open the listening WebSocket.
    allowed_origins: tuple[str, ...]
    # Optional shared secret the browser must pass as ?token=...
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
