"""HTTP + WebSocket entry point.

Run with:  uvicorn skywave_radio.server:app --port 8765
"""

from __future__ import annotations

import hmac
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status

from .config import Settings, is_local_origin
from .session import ClientGone, ListenSession, Slots

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("skywave_radio")

EXPECTED_JSON = {"type": "status", "state": "error", "message": "Expected JSON."}


def check_settings(settings: Settings) -> None:
    """Refuse configurations that would leave the service open to anyone."""
    if not settings.allowed_origins:
        log.warning("ALLOWED_ORIGINS is empty; every connection will be refused.")
    public = [o for o in settings.allowed_origins if not is_local_origin(o)]
    if public and not settings.token:
        raise RuntimeError(
            f"RADIO_TOKEN must be set when ALLOWED_ORIGINS allows {public[0]!r}: "
            "any script can fake an Origin header, so the token is the only real lock."
        )


def create_app(settings: Settings | None = None, **session_kwargs) -> FastAPI:
    settings = settings or Settings.from_env()
    check_settings(settings)
    app = FastAPI(title="skywave radio service")
    app.state.settings = settings
    # Caps live Kiwi connections, not browser sockets: a tab sitting on
    # "Stopped" or "Problem" holds no slot.
    slots = app.state.slots = Slots(settings.max_sessions)

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True, "listeners": slots.active, "maxListeners": slots.limit}

    @app.websocket("/ws")
    async def listen(ws: WebSocket) -> None:
        origin = ws.headers.get("origin")
        if "*" not in settings.allowed_origins and origin not in settings.allowed_origins:
            log.warning("rejected origin %r", origin)
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        if settings.token:
            supplied = ws.query_params.get("token", "")
            # Compare bytes: compare_digest raises TypeError on non-ASCII str.
            if not hmac.compare_digest(supplied.encode(), settings.token.encode()):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                return

        await ws.accept()

        async def send_text(payload: dict) -> None:
            try:
                await ws.send_text(json.dumps(payload))
            except (WebSocketDisconnect, RuntimeError) as e:
                raise ClientGone from e

        async def send_bytes(data: bytes) -> None:
            try:
                await ws.send_bytes(data)
            except (WebSocketDisconnect, RuntimeError) as e:
                raise ClientGone from e

        session = ListenSession(settings, send_text, send_bytes, slots=slots, **session_kwargs)
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(message.get("code", status.WS_1000_NORMAL_CLOSURE))
                raw = message.get("text")
                if raw is None:  # a binary frame
                    await send_text(EXPECTED_JSON)
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await send_text(EXPECTED_JSON)
                    continue
                if isinstance(msg, dict):
                    await session.handle(msg)
        except (WebSocketDisconnect, RuntimeError, ClientGone):
            # RuntimeError covers Starlette's WebSocketDisconnected, raised when
            # the socket already closed underneath us.
            pass
        finally:
            await session.close()

    return app


app = create_app()
