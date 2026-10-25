"""HTTP + WebSocket entry point.

Run with:  uvicorn skywave_radio.server:app --port 8765
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import hmac
import ipaddress
import json
import logging
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status

from .config import Settings, is_local_origin, origin_allowed
from .hostguard import is_public_address
from .session import ClientGone, ListenSession, ScanCache, Slots, SweepTimes

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("skywave_radio")

EXPECTED_JSON = {"type": "status", "state": "error", "message": "Expected JSON."}
# Close code for a socket left idle (no session playing, no messages) for
# IDLE_SOCKET_MINUTES. The web app treats it as a quiet hang-up, not an outage,
# and opens a new socket on its next tune. Keep in step with use-radio.ts.
IDLE_CLOSE_CODE = 4000
# Close code for a socket refused because its address already holds
# MAX_SOCKETS_PER_IP. The web app explains it. Keep in step with use-radio.ts.
TOO_MANY_SOCKETS_CODE = 4001
# How long a close frame we start may take. A browser that stopped reading can
# block it; past this, returning drops the connection without one.
CLOSE_FRAME_TIMEOUT_S = 2.0
# How long shutdown waits for socket cleanups still closing their Kiwis (each
# is bounded on its own, about 4.5 s at worst). Past this, asyncio.run's exit
# cancels what's left and waits for that teardown too; the container's stop
# period (docker-compose.yml) covers uvicorn's 15 s, this and that.
SHUTDOWN_CLEANUP_TIMEOUT_S = 5.0
# One "refused a socket" warning per address per this many seconds, so a page
# reconnecting in a loop doesn't flood the log.
REFUSAL_LOG_INTERVAL_S = 60.0


async def _close_bounded(ws: WebSocket, code: int, reason: str) -> None:
    try:
        async with asyncio.timeout(CLOSE_FRAME_TIMEOUT_S):
            await ws.close(code=code, reason=reason)
    except TimeoutError:
        log.info("socket not reading; dropping it without a close frame")
    except (OSError, RuntimeError, WebSocketDisconnect):
        # The browser left as the frame went out (Starlette turns uvicorn's
        # OSError into WebSocketDisconnect, or raises a RuntimeError once the
        # socket is closed); the socket is gone either way.
        log.info("socket already gone; no close frame sent")


def socket_owner(host: str | None) -> str | None:
    """Who MAX_SOCKETS_PER_IP counts a socket against, or None for no one.

    A public address, with IPv6 grouped by /64: one user can pick any address
    in theirs. Anything else goes uncounted: behind a proxy the service doesn't
    trust (see FORWARDED_ALLOW_IPS), every listener shares the proxy's private
    address, and counting that would lock everyone out at once. Python counts
    6to4 and Teredo addresses as private, so those go uncounted too.
    """
    try:
        ip = ipaddress.ip_address(host or "")
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped  # a dual-stack listener's view of an IPv4 client
    if not is_public_address(str(ip)):
        return None
    if isinstance(ip, ipaddress.IPv6Address):
        # From the integer, not f"{ip}/64": that string keeps any %zone suffix.
        return str(ipaddress.IPv6Network((int(ip) >> 64 << 64, 64)))
    return str(ip)


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
    # Socket cleanups still running after their handler was cancelled; held
    # here so they aren't garbage-collected before they finish.
    cleanups: set[asyncio.Task[None]] = set()

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        # uvicorn waits for socket handlers before this until its graceful
        # shutdown timeout (15 s in the Dockerfile), then cancels them; let their
        # cleanups close each Kiwi cleanly (bounded) rather than the process
        # exit cutting them off. The container's stop period covers both.
        # Looped: a handler cancelled as this wait starts adds its cleanup late.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + SHUTDOWN_CLEANUP_TIMEOUT_S
        while cleanups and (remaining := deadline - loop.time()) > 0:
            done, _ = await asyncio.wait(set(cleanups), timeout=remaining)
            for task in done:
                if not task.cancelled() and task.exception() is not None:
                    log.warning("a socket cleanup failed at shutdown: %r", task.exception(), exc_info=task.exception())
        if cleanups:
            log.warning("%d socket cleanup(s) still running at shutdown", len(cleanups))

    app = FastAPI(title="skywave radio service", lifespan=lifespan)
    app.state.settings = settings
    app.state.cleanups = cleanups
    # Caps live Kiwi connections, not browser sockets: a tab sitting on
    # "Stopped" or "Problem" holds no slot.
    slots = app.state.slots = Slots(settings.max_sessions)
    # Shared, so a receiver scanned for one listener isn't rescanned for the next.
    scan_cache = app.state.scan_cache = ScanCache()
    # Shared, so reconnecting doesn't get a listener a sooner sweep.
    sweep_times = app.state.sweep_times = SweepTimes()
    # Browser sockets open per socket_owner, for MAX_SOCKETS_PER_IP.
    open_sockets: dict[str, int] = {}
    app.state.open_sockets = open_sockets
    # When each owner's last refusal was logged.
    refusals_logged: collections.OrderedDict[str, float] = collections.OrderedDict()
    app.state.refusals_logged = refusals_logged

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True, "listeners": slots.active, "maxListeners": slots.limit}

    @app.websocket("/ws")
    async def listen(ws: WebSocket) -> None:
        origin = ws.headers.get("origin")
        if not origin_allowed(origin, settings.allowed_origins):
            log.warning("rejected origin %r", origin)
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        if settings.token:
            supplied = ws.query_params.get("token", "")
            # Compare bytes: compare_digest raises TypeError on non-ASCII str.
            if not hmac.compare_digest(supplied.encode(), settings.token.encode()):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                return

        client_ip = ws.client.host if ws.client else None
        owner = socket_owner(client_ip)
        await ws.accept()
        if owner is not None and open_sockets.get(owner, 0) >= settings.max_sockets_per_ip:
            now = time.monotonic()
            # Pruned on every refusal, logged or not, so retries inside the
            # interval can't keep a burst of addresses here for good.
            # Entries are only ever added, so the oldest come first: stop at the
            # first fresh one (an OrderedDict pops its front cheaply).
            while refusals_logged and now - next(iter(refusals_logged.values())) >= REFUSAL_LOG_INTERVAL_S:
                refusals_logged.popitem(last=False)
            if owner not in refusals_logged:
                refusals_logged[owner] = now
                log.warning("refused a socket: %s already holds %d", owner, settings.max_sockets_per_ip)
            await _close_bounded(ws, TOO_MANY_SOCKETS_CODE, "too many sockets")
            return
        counted = False

        def release_place() -> None:
            nonlocal counted
            if not counted:
                return
            counted = False
            left = open_sockets[owner] - 1
            if left:
                open_sockets[owner] = left
            else:
                del open_sockets[owner]

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

        stalled = asyncio.Event()
        session = ListenSession(
            settings,
            send_text,
            send_bytes,
            slots=slots,
            scan_cache=scan_cache,
            sweep_times=sweep_times,
            # Behind a reverse proxy this is only the user's address if
            # FORWARDED_ALLOW_IPS trusts that proxy; the session copes if not.
            client_ip=client_ip,
            on_stalled=stalled.set,
            **session_kwargs,
        )

        idle_s = settings.idle_socket_minutes * 60

        async def serve() -> None:
            last_message = time.monotonic()
            while True:
                # The idle clock runs only while no session plays, from the
                # later of its last message and the session ending.
                wait = idle_s
                if session.idle_since is not None:
                    wait = max(last_message, session.idle_since) + idle_s - time.monotonic()
                    if wait <= 0:
                        # Freed first: the page may reconnect as soon as it
                        # sees the close, before this socket's cleanup ends.
                        release_place()
                        await _close_bounded(ws, IDLE_CLOSE_CODE, "idle")
                        return
                deadline = asyncio.timeout(wait)
                try:
                    async with deadline:
                        message = await ws.receive()
                except TimeoutError:
                    if deadline.expired():
                        continue  # look again: a session may have started or ended
                    raise
                last_message = time.monotonic()
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

        async def finish() -> None:
            try:
                # Let a tune that serve() was handling unwind first: closing the
                # session underneath it would let it start a pump after we stopped.
                await asyncio.wait({serving})
                await session.close()
            finally:
                release_place()

        serving = asyncio.create_task(serve())
        gave_up = asyncio.create_task(stalled.wait())
        # Counted only now, with nothing left that can fail before the finally
        # below releases it. No await since the cap check, so none slipped in.
        if owner is not None:
            open_sockets[owner] = open_sockets.get(owner, 0) + 1
            counted = True
        try:
            await asyncio.wait({serving, gave_up}, return_when=asyncio.FIRST_COMPLETED)
            if serving.done():
                serving.result()
        except (WebSocketDisconnect, RuntimeError, ClientGone):
            # RuntimeError covers Starlette's WebSocketDisconnected, raised when
            # the socket already closed underneath us.
            pass
        finally:
            # A browser that stopped reading gets no close frame (sending one
            # would block like the audio did); returning closes the connection,
            # which it sees once it reads again, instead of a silent "Listening".
            serving.cancel()
            gave_up.cancel()
            # Its own task, shielded: cancelling this handler mid-cleanup can't
            # skip session.close() and leave a volunteer's channel open.
            cleanup = asyncio.create_task(finish())
            cleanups.add(cleanup)
            cleanup.add_done_callback(cleanups.discard)
            await asyncio.shield(cleanup)

    return app


app = create_app()
