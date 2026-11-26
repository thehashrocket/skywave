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
import os
import time
from logging.handlers import RotatingFileHandler
from typing import Any

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse

from .config import Settings, is_local_origin, origin_allowed
from .hostguard import is_public_address
from .noise import BAND_IDS, WINDOW_DAYS, NoiseSampler, NoiseStore, utc_slot
from .session import ClientGone, ListenSession, ScanCache, Slots, SweepTimes, receiver_log
from .session import scan_stragglers

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
# How long shutdown waits for socket handlers and cleanups still closing their
# Kiwis. A cancelled handler's teardown can take about 9 s at worst (its scan
# stop and waterfall close, then the session's close). Past this, asyncio.run's
# exit cancels what's left and waits for that too; the container's stop period
# (docker-compose.yml) covers uvicorn's 15 s, this and that.
SHUTDOWN_CLEANUP_TIMEOUT_S = 10.0
# One "refused a socket" warning per address per this many seconds, so a page
# reconnecting in a loop doesn't flood the log.
REFUSAL_LOG_INTERVAL_S = 60.0
# GET /noise: receivers one request may ask about, and how long a browser or
# cache may keep the answer (a new sample per receiver and band comes at most
# every 10 minutes, and the hour's median moves slower still).
NOISE_MAX_RECEIVERS = 100
NOISE_CACHE_S = 300
# Longer than any host (253) plus ":65535", so a bad pair is refused before parsing.
NOISE_PAIR_MAX = 260
# How long GET /noise waits on the store's thread before answering 503.
NOISE_READ_TIMEOUT_S = 5.0
# RECEIVER_LOG's size: rotated at this many bytes, keeping this many old files
# (25 MB in all; a line is about 120 bytes).
RECEIVER_LOG_BYTES = 5 * 1024 * 1024
RECEIVER_LOG_BACKUPS = 4


def attach_receiver_log(path: str | None) -> RotatingFileHandler | None:
    """Also write receiver_log to `path` (rotated), once per path.

    A file that can't be opened never stops the service: it says so and the
    lines still go to stdout.
    """
    if not path:
        return None
    full = os.path.abspath(path)
    for handler in receiver_log.handlers:
        if isinstance(handler, RotatingFileHandler) and handler.baseFilename == full:
            return handler
    try:
        handler = RotatingFileHandler(full, maxBytes=RECEIVER_LOG_BYTES, backupCount=RECEIVER_LOG_BACKUPS, encoding="utf-8")
    except OSError as e:
        log.warning("can't write the receiver log to %s (%r); it goes to stdout only", full, e)
        return None
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    receiver_log.addHandler(handler)
    return handler


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


def _log_cleanup_failure(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.warning("a socket cleanup failed: %r", task.exception(), exc_info=task.exception())


async def _await_cleanup(cleanup: asyncio.Task[None]) -> None:
    """Wait out a socket's cleanup, shielded so cancelling the handler can't skip it."""
    try:
        await asyncio.shield(cleanup)
    except asyncio.CancelledError:
        # Cancelled again mid-cleanup: from here the shield drops the cleanup's
        # error, so it must log its own (owner D5).
        cleanup.add_done_callback(_log_cleanup_failure)
        raise


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


def parse_receivers(raw: str | None) -> list[str] | None:
    """GET /noise's receivers=host:port,...: lowercased, deduplicated, in order; None if malformed."""
    if not raw or len(raw) > NOISE_MAX_RECEIVERS * (NOISE_PAIR_MAX + 1):
        return None
    out: list[str] = []
    for item in raw.split(","):
        item = item.strip().lower()
        host, sep, port = item.rpartition(":")
        if (
            not sep
            or not host
            or len(item) > NOISE_PAIR_MAX
            or not port.isascii()
            or not port.isdigit()
            or not 1 <= int(port) <= 65535
            or any(c.isspace() or c in "/?#" for c in host)
        ):
            return None
        key = f"{host}:{int(port)}"
        if key not in out:
            out.append(key)
    return out if len(out) <= NOISE_MAX_RECEIVERS else None


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
    attach_receiver_log(settings.receiver_log)
    check_settings(settings)
    # Every socket cleanup, from creation until it finishes (track_cleanup):
    # held so it isn't garbage-collected mid-run, and so shutdown can wait on it.
    cleanups: set[asyncio.Task[None]] = set()
    # Socket handlers still running. Shutdown waits on these too, so a handler
    # that adds its cleanup after the wait starts still gets it awaited,
    # whatever order the server shuts down in.
    handlers: set[asyncio.Task[Any]] = set()

    def track_cleanup(task: asyncio.Task[None], awaited: bool = False) -> None:
        """Hold a cleanup until it ends. One nothing awaits logs its own failure."""
        cleanups.add(task)
        task.add_done_callback(cleanups.discard)
        if not awaited:
            task.add_done_callback(_log_cleanup_failure)

    # Each receiver's noise floor per band and hour (issue #67), sampled from
    # the frames sessions already pull and kept on the store's own thread.
    noise_store = NoiseStore(settings.noise_db)
    noise_sampler = NoiseSampler(noise_store)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        try:
            await _shutdown_waits()
        finally:
            # Last: sessions closing above may still hand it samples.
            await asyncio.to_thread(noise_store.close)

    async def _shutdown_waits() -> None:
        # uvicorn waits for socket handlers before this until its graceful
        # shutdown timeout (15 s in the Dockerfile), then cancels them; let their
        # cleanups close each Kiwi cleanly (bounded) rather than the process
        # exit cutting them off. The container's stop period covers both.
        # Looped, and over handlers too: a handler still running (or cancelled
        # as this wait starts) adds its cleanup late.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + SHUTDOWN_CLEANUP_TIMEOUT_S
        # Scan tasks that outlived their stop may still hold a half-open
        # waterfall: same deadline for them (owner D8). Re-checked as each ends.
        # (Only this loop's: the set is shared by the whole process.)
        def ours() -> set[asyncio.Task[None]]:
            return {t for t in scan_stragglers if t.get_loop() is loop}

        while (open_now := cleanups | handlers | ours()) and (remaining := deadline - loop.time()) > 0:
            await asyncio.wait(open_now, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
        left = (len(cleanups), len(handlers), len(ours()))  # read once: tasks may end meanwhile
        if any(left):
            log.warning("%d socket cleanup(s), %d handler(s) and %d scan task(s) still running at shutdown", *left)

    app = FastAPI(title="skywave radio service", lifespan=lifespan)
    app.state.settings = settings
    app.state.cleanups = cleanups
    app.state.handlers = handlers
    app.state.track_cleanup = track_cleanup
    app.state.noise_store = noise_store
    app.state.noise_sampler = noise_sampler
    # Caps live Kiwi connections, not browser sockets: a tab sitting on
    # "Stopped" or "Problem" holds no slot.
    slots = app.state.slots = Slots(
        settings.max_sessions,
        per_receiver=settings.max_sessions_per_receiver,
        per_owner=settings.max_sessions_per_ip,
    )
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

    def cors_headers(request: Request) -> dict[str, str]:
        """The same origins the WebSocket takes, echoed back; no token (public aggregates)."""
        headers = {"Vary": "Origin"}
        origin = request.headers.get("origin")
        if origin and origin_allowed(origin, settings.allowed_origins):
            headers["Access-Control-Allow-Origin"] = origin
        return headers

    @app.options("/noise")
    async def noise_preflight(request: Request) -> Response:
        headers = cors_headers(request)
        if "Access-Control-Allow-Origin" in headers:
            headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            headers["Access-Control-Max-Age"] = "86400"
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)

    @app.get("/noise")
    async def noise(request: Request) -> Response:
        """Per receiver: its noise floor for this band and the current UTC hour, and its own baseline.

        receivers=host:port,... (at most NOISE_MAX_RECEIVERS) and band=<id from
        noise.NOISE_BANDS>. Levels are the waterfall's own ~1 dB steps, not
        dBm; receivers with no samples in the window are left out.
        """
        headers = cors_headers(request)
        params = request.query_params
        receivers = parse_receivers(params.get("receivers"))
        band = params.get("band")
        unknown = set(params.keys()) - {"receivers", "band"}
        if receivers is None or band not in BAND_IDS or unknown or len(params.getlist("receivers")) != 1:
            return JSONResponse(
                {
                    "error": f"Needs receivers=host:port,... (1 to {NOISE_MAX_RECEIVERS}) "
                    "and band=<one of the dial's bands>, and nothing else."
                },
                status_code=status.HTTP_400_BAD_REQUEST,
                headers=headers,
            )
        now = time.time()
        _day, hour = utc_slot(now)
        try:
            async with asyncio.timeout(NOISE_READ_TIMEOUT_S):
                stats = await asyncio.wrap_future(noise_store.stats(receivers, band, now))
        except Exception as e:
            log.warning("noise read failed: %r", e)
            return JSONResponse(
                {"error": "Noise levels aren't available right now."},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers=headers,
            )
        headers["Cache-Control"] = f"public, max-age={NOISE_CACHE_S}"
        return JSONResponse(
            {
                "band": band,
                "hourUtc": hour,
                "windowDays": WINDOW_DAYS,
                "receivers": {
                    key: {
                        "medianDb": s.median_db,
                        "count": s.count,
                        "baselineDb": s.baseline_db,
                        "baselineCount": s.baseline_count,
                    }
                    for key, s in stats.items()
                },
            },
            headers=headers,
        )

    @app.websocket("/ws")
    async def listen(ws: WebSocket) -> None:
        handler = asyncio.current_task()
        if handler is not None:
            handlers.add(handler)
            handler.add_done_callback(handlers.discard)
        origin = ws.headers.get("origin")
        if not origin_allowed(origin, settings.allowed_origins):
            log.warning("rejected origin %r", origin)
            await _close_bounded(ws, status.WS_1008_POLICY_VIOLATION, "")
            return
        if settings.token:
            supplied = ws.query_params.get("token", "")
            # Compare bytes: compare_digest raises TypeError on non-ASCII str.
            if not hmac.compare_digest(supplied.encode(), settings.token.encode()):
                await _close_bounded(ws, status.WS_1008_POLICY_VIOLATION, "")
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
            # MAX_SESSIONS_PER_IP counts by the same owner as MAX_SOCKETS_PER_IP.
            owner=owner,
            on_stalled=stalled.set,
            noise=noise_sampler,
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
                # Bad JSON, a number past Python's int digit limit, or nesting
                # too deep to parse: all just bad JSON, not a dropped session.
                except (ValueError, RecursionError):
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
            track_cleanup(cleanup, awaited=True)
            await _await_cleanup(cleanup)

    return app


app = create_app()
