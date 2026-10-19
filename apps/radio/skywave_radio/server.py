"""HTTP + WebSocket entry point.

Run with:  uvicorn skywave_radio.server:app --port 8765
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status

from .config import Settings
from .session import ClientGone, ListenSession

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("skywave_radio")


def create_app(settings: Settings | None = None, **session_kwargs) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="skywave radio service")
    app.state.settings = settings
    app.state.active = 0
    lock = asyncio.Lock()

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True, "listeners": app.state.active, "maxListeners": settings.max_sessions}

    @app.websocket("/ws")
    async def listen(ws: WebSocket) -> None:
        origin = ws.headers.get("origin")
        if settings.allowed_origins and "*" not in settings.allowed_origins and origin not in settings.allowed_origins:
            log.warning("rejected origin %r", origin)
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        if settings.token:
            supplied = ws.query_params.get("token", "")
            if not hmac.compare_digest(supplied, settings.token):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                return

        async with lock:
            if app.state.active >= settings.max_sessions:
                await ws.accept()
                await ws.send_text(
                    json.dumps({"type": "status", "state": "error", "message": "The radio service is at its listener limit."})
                )
                await ws.close(code=status.WS_1013_TRY_AGAIN_LATER)
                return
            app.state.active += 1

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

        session = ListenSession(settings, send_text, send_bytes, **session_kwargs)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await send_text({"type": "status", "state": "error", "message": "Expected JSON."})
                    continue
                if isinstance(msg, dict):
                    await session.handle(msg)
        except (WebSocketDisconnect, RuntimeError, ClientGone):
            # RuntimeError covers Starlette's WebSocketDisconnected, raised when
            # the socket already closed underneath us.
            pass
        finally:
            await session.close()
            async with lock:
                app.state.active -= 1

    return app


app = create_app()
