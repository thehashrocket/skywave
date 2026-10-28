"""One browser listener: owns a Kiwi connection and the DSP chain for it.

Browser -> service (JSON text frames):
    {"type": "tune", "host": "...", "port": 8073, "freqKhz": 9535, "mode": "am", "source": "list", "secure": true}
    ("source": "list" marks a receiver the browser picked from the public list
    rather than one a person typed; those are only ever dialed on public
    addresses, even with ALLOW_PRIVATE_HOSTS on. "secure": true dials wss://.)
    {"type": "stop"}
    {"type": "scan", "id": 3, "fresh": false, "ham": true}
    (scan the receiver being listened to for strong broadcast signals; "fresh"
    skips the caches (10 minutes for broadcast, 2 for amateur). Send it only
    to a service whose status lists "scan" in "features": an older one
    answers it with a status error.
    "ham": true also scans the amateur bands; send it only when "features"
    lists "scan-ham", and only from a page that tunes each row in its "mode".)

Service -> browser:
    JSON text: {"type": "status", "state": "connecting|listening|stopped|error", "features": ["scan"], ...}
               (an uncoded error may carry "retryAfterMs": the same receiver
               may work if tried again after that long)
    JSON text: {"type": "scan", "id": 3, "host": "...", "port": 8073, "state": "scanning|done|error", ...}
               (done: "signals" [{"freqKhz", "snrDb", "band"}] strongest first,
               "hidden" flat-topped signals left out, "bandsDone", "bandsTotal",
               "partial", "atMs"; error: "message". Scan failures never come as
               a status: listening goes on. id, host and port echo the request,
               so a late reply for another receiver or request can be ignored.
               With "ham": true a done reply carries "ham": first
               {"state": "scanning"} with the broadcast part, then a second
               done reply under the same id with {"state": "done", "voice",
               "cw", "digital" ([{"freqKhz", "snrDb", "band", "mode",
               "label"?}] strongest first), "bandsDone", "bandsTotal",
               "partial", "atMs", "ageMs"} or {"state": "error", "message"}.
               An amateur failure never turns the broadcast part into an error.)
    JSON text: {"type": "meter", "rssi": -73.1, "overflow": false}
    Binary:    0x03 + int16 LE mono audio at `sampleRate` (full scale = 32767)
    Binary:    0x04 + float32 LE base dB + uint8 bins spanning -sampleRate/2..+sampleRate/2,
               each bin base + v * 0.5 dB
    (0x01/0x02, the same with float32 samples and dB, are no longer sent; the
    browser still reads them so the web app can deploy before this service.)
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Hashable, Iterable
from dataclasses import replace
from typing import Any

from .config import Settings
from .dsp import CW_PITCH_HZ, MODES, Demodulator, Spectrum, encode_audio, encode_spectrum
from .hostguard import HostRejected, is_public_address, resolve_receiver
from .kiwi import CLOSE_TIMEOUT_S, DEFAULT_PORT, KiwiClient, KiwiError
from .scan import DEADLINE_S, HamResult, ScanResult, sweep, sweep_ham
from .waterfall import WaterfallClient

log = logging.getLogger(__name__)

AUDIO_TAG = b"\x03"
SPECTRUM_TAG = b"\x04"
MAX_FREQ_KHZ = 32_000.0
METER_INTERVAL_S = 0.25
# A browser that stops reading (frozen tab, dead Wi-Fi) blocks our sends; past
# this we give up on it so it stops holding a slot and a volunteer's channel.
# Long enough to ride out a Wi-Fi roam or a laptop waking up.
SEND_TIMEOUT_S = 15.0

# Statuses list what this service can do, so a newer web app knows whether to ask.
FEATURES = ["scan", "scan-ham"]
# How long a receiver's scan is reused before a new one is made.
SCAN_CACHE_S = 600.0
# The amateur part is reused far less: ham signals come and go in minutes.
HAM_CACHE_S = 120.0
OUT_OF_TIME = "The scan ran out of time before the amateur bands."
# A receiver that refused a scan isn't asked again for this long. Only refusals
# are kept: a dropped connection or a timeout says nothing about the next try.
SCAN_REFUSAL_CACHE_S = 60.0
SCAN_REFUSALS = frozenset({"busy", "no_apps", "password", "down"})
# Receivers the shared cache remembers at most; the soonest to expire goes first.
SCAN_CACHE_MAX = 500
# A listener's next sweep waits this long after the last; a request sooner
# (Scan again in a loop) gets the last answer, sparing the volunteer's Kiwi.
SCAN_MIN_INTERVAL_S = 30.0
# Pause before draining a paired waterfall again after idling failed while it is still open.
IDLE_RETRY_S = 1.0
# How long ending a session waits for a cancelled scan to stop. Its own cleanup
# is a waterfall close (bounded by CLOSE_TIMEOUT_S); past this, log and move on.
# The listener's "Stopped" waits on this, so keep it tight.
SCAN_STOP_TIMEOUT_S = CLOSE_TIMEOUT_S + 0.5

# A receiver as the session dials it: host, port, whether private addresses
# may be dialed for it, and wss.
Target = tuple[str, int, bool, bool]

# Cancelled scan tasks that may outlive their stop (past SCAN_STOP_TIMEOUT_S,
# or caught by _end_scan's backstop): held so they aren't garbage-collected
# mid-run, and logged when they end. Server shutdown waits on these too.
scan_stragglers: set[asyncio.Task[None]] = set()
# Those of them still running when a stop's wait ended (timed out or was cut
# short by another cancel): only these log "has stopped".
late_stragglers: set[asyncio.Task[None]] = set()
# Task names carry a host; log at most this much of one.
TASK_NAME_MAX = 200
# A receiver host longer than any DNS name is refused: the raw value before it
# is copied (stripped, lowercased), the cleaned one after.
RAW_HOST_MAX = 1024
HOST_MAX = 253
# Longer than any name in MODES: refused before it is lowercased.
MODE_MAX = 8
# A port or frequency sent as text longer than this is refused before int() or
# float() parses it: no real one is near this long.
NUMBER_TEXT_MAX = 32


def _task_name(task: asyncio.Task[Any]) -> str:
    name = task.get_name()
    qualname = getattr(task.get_coro(), "__qualname__", None)
    if qualname is None:
        return name
    # Tasks named here carry their receiver; asyncio's own are "Task-N". The
    # pump is named before its host is resolved, so the host may still hold
    # unprintable characters: escape them. A valid host (up to HOST_MAX) plus its
    # port can still pass TASK_NAME_MAX, so long names are clipped.
    if name.startswith("Task-"):
        return qualname
    clipped = name[:TASK_NAME_MAX]
    shown = clipped if clipped.isprintable() else repr(clipped)
    return f"{qualname} ({shown}{'…' if len(name) > TASK_NAME_MAX else ''})"


def _log_straggler(task: asyncio.Task[None]) -> None:
    scan_stragglers.discard(task)
    late = task in late_stragglers
    late_stragglers.discard(task)
    if not task.cancelled() and task.exception() is not None:
        log.warning(
            "%s failed after it was stopped: %r",
            _task_name(task),
            task.exception(),
            exc_info=task.exception(),
        )
    elif late:
        log.info("%s has stopped", _task_name(task))
    else:
        log.debug("%s stopped in time", _task_name(task))


def _failures(tasks: Iterable[asyncio.Task[Any]]) -> list[BaseException]:
    """Every finished task's error, each one read so none logs "never retrieved"."""
    return [e for t in tasks if t.done() and not t.cancelled() and (e := t.exception()) is not None]

SendText = Callable[[dict[str, Any]], Awaitable[None]]
SendBytes = Callable[[bytes], Awaitable[None]]


class BadRequest(Exception):
    pass


class ClientGone(Exception):
    """The browser disconnected; stop quietly."""


class Slots:
    """Caps live Kiwi connections across every browser session.

    Each one occupies a channel on a volunteer's receiver, so that's what we
    count. No lock: acquire and release never await, and everything runs on
    one event loop. release() refuses to go below zero, which catches a double
    release only once nothing else is held; it can't tell whose slot it is.
    """

    def __init__(self, limit: int):
        self.limit = limit
        self.active = 0

    def try_acquire(self) -> bool:
        if self.active >= self.limit:
            return False
        self.active += 1
        return True

    def release(self) -> None:
        # Below zero the cap would admit extra listeners. Never end anyone's
        # audio over the bookkeeping; say so loudly instead.
        if self.active <= 0:
            log.error("listener slot released with none held (active=%d)", self.active)
            self.active = 0
            return
        self.active -= 1


class ScanCache:
    """Recent scans per receiver, shared by every session for SCAN_CACHE_S.

    A refusal is kept too, as its error message, for a shorter time, so a
    receiver that turned a scan away isn't asked again by every listener.
    """

    def __init__(self, ttl_s: float = SCAN_CACHE_S):
        self.ttl_s = ttl_s
        # key -> (expiry on the monotonic clock, result or refusal message).
        # A receiver's amateur part is kept under (receiver, "ham").
        self._entries: dict[Hashable, tuple[float, ScanResult | HamResult | str]] = {}

    def get(self, key: Hashable) -> ScanResult | HamResult | str | None:
        entry = self._entries.get(key)
        if entry is None or time.monotonic() > entry[0]:
            return None
        return entry[1]

    def put(self, key: Hashable, result: ScanResult | HamResult | str, ttl_s: float | None = None) -> None:
        now = time.monotonic()
        # Pruned here so a long-running service doesn't keep every receiver it ever scanned.
        self._entries = {k: e for k, e in self._entries.items() if now <= e[0]}
        self._entries.pop(key, None)
        while len(self._entries) >= SCAN_CACHE_MAX:
            del self._entries[min(self._entries, key=lambda k: self._entries[k][0])]
        self._entries[key] = (now + (self.ttl_s if ttl_s is None else ttl_s), result)


class SweepTimes:
    """When each listener last started a sweep of each receiver, shared by every session.

    Shared so a new connection doesn't start a listener's SCAN_MIN_INTERVAL_S
    over. A listener is a public IP, or one session behind a proxy the
    service doesn't trust (see ListenSession.lookup_owner).
    """

    def __init__(self) -> None:
        # (listener, receiver) -> start time on the monotonic clock
        self._starts: dict[Hashable, float] = {}

    def wait_s(self, key: Hashable) -> float:
        """Seconds until this listener may start another sweep of this receiver."""
        start = self._starts.get(key)
        return 0.0 if start is None else max(0.0, start + SCAN_MIN_INTERVAL_S - time.monotonic())

    def start(self, key: Hashable) -> None:
        now = time.monotonic()
        self._starts = {k: t for k, t in self._starts.items() if now < t + SCAN_MIN_INTERVAL_S}
        self._starts.pop(key, None)
        while len(self._starts) >= SCAN_CACHE_MAX:
            del self._starts[min(self._starts, key=self._starts.__getitem__)]
        self._starts[key] = now


def kiwi_freq_khz(freq_khz: float, mode: str) -> float:
    """Frequency to ask the Kiwi for. CW is offset so the signal lands at an audible pitch."""
    return freq_khz - CW_PITCH_HZ / 1000 if mode == "cw" else freq_khz


class ListenSession:
    """One browser's listening session.

    A tune for a new receiver takes a slot and starts a pump task:

        connecting ──handshake──▶ listening ──limit/error/stop──▶ ended
                                                                  (slot released)

    A tune for the same receiver while the pump is alive is always a retune,
    never a restart. Before the handshake finishes it only records the new
    frequency and mode, which the handshake then applies.
    """

    def __init__(
        self,
        settings: Settings,
        send_text: SendText,
        send_bytes: SendBytes,
        *,
        slots: Slots | None = None,
        scan_cache: ScanCache | None = None,
        sweep_times: SweepTimes | None = None,
        resolver: Callable[..., Awaitable[str]] = resolve_receiver,
        client_factory: Callable[..., KiwiClient] = KiwiClient,
        waterfall_factory: Callable[..., WaterfallClient] = WaterfallClient,
        client_ip: str | None = None,
        on_stalled: Callable[[], None] | None = None,
    ):
        self.settings = settings
        self._raw_send_text = send_text
        self._raw_send_bytes = send_bytes
        self._slots = slots or Slots(settings.max_sessions)
        self._scan_cache = scan_cache or ScanCache()
        self._sweep_times = sweep_times or SweepTimes()
        self._resolver = resolver
        self._client_factory = client_factory
        self._waterfall_factory = waterfall_factory
        self._client_ip = client_ip
        self._on_stalled = on_stalled
        self._client: KiwiClient | None = None
        self._pump: asyncio.Task[None] | None = None
        # When this session went idle, at creation or when its pump ended
        # (time.monotonic()), or None while a pump runs: the server closes a
        # socket left idle too long.
        self.idle_since: float | None = time.monotonic()
        # The pump whose end releases this session's slot. Switching receivers
        # hands the slot to the new pump instead of releasing and re-taking it,
        # which another listener could win in between.
        self._slot_holder: asyncio.Task[None] | None = None
        self._demod: Demodulator | None = None
        self._spectrum: Spectrum | None = None
        self._mode = "am"
        self._freq_khz = 0.0
        # host, port, whether private addresses may be dialed for it, and wss.
        self._target: Target | None = None
        # The receiver a pump that has ended is still closing, until its status
        # goes out. A tune for it meanwhile is the browser not knowing yet.
        self._ending_target: Target | None = None
        self._listening = False
        # The band scan's waterfall, paired with self._client. It shares that
        # channel and closing it ends the audio, so once opened it idles until
        # the receiver connection ends (_end_scan), and uses no slot.
        self._waterfall: WaterfallClient | None = None
        # A scan's waterfall still in its handshake. Only the scan holds it, so
        # it's kept here too: ending the session can drop it even if that scan
        # never stops.
        self._connecting: WaterfallClient | None = None
        self._waterfall_idle: asyncio.Task[None] | None = None
        self._scan: asyncio.Task[None] | None = None
        # The newest scan request's id; a running scan answers under it.
        self._scan_id: int | None = None
        # The last sweep's answer, (monotonic time, target, state, payload),
        # repeated to requests within SCAN_MIN_INTERVAL_S while this receiver
        # connection lasts. A new connection waits out the interval instead
        # (SweepTimes) and sweeps again.
        self._last_sweep: tuple[float, Target, str, dict[str, Any]] | None = None
        # Whether the newest scan request asked for the amateur bands too
        # ("ham": true); replies to one that didn't never carry them.
        self._scan_ham = False
        # The last amateur sweep's answer, kept like _last_sweep.
        self._last_ham: tuple[float, Target, HamResult | dict[str, Any]] | None = None

    @property
    def lookup_owner(self) -> Hashable:
        """Who hostguard's one-lookup-at-a-time limit applies to.

        The client's IP when it's public, so opening more sockets doesn't get
        more lookups. Behind a proxy the service doesn't trust (see
        FORWARDED_ALLOW_IPS), every listener shares the proxy's private
        address, so fall back to this session rather than lump them together.
        """
        if self._client_ip and is_public_address(self._client_ip):
            return ("ip", self._client_ip)
        return self

    async def _send_text(self, payload: dict[str, Any]) -> None:
        await self._send_or_give_up(self._raw_send_text(payload))

    async def _send_bytes(self, data: bytes) -> None:
        await self._send_or_give_up(self._raw_send_bytes(data))

    async def _send_or_give_up(self, send: Awaitable[None]) -> None:
        try:
            await asyncio.wait_for(send, SEND_TIMEOUT_S)
        except asyncio.TimeoutError as e:
            log.info("browser stopped reading for %gs; ending its session", SEND_TIMEOUT_S)
            if self._on_stalled is not None:
                self._on_stalled()
            raise ClientGone() from e

    async def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        try:
            if kind == "tune":
                await self._tune(msg)
            elif kind == "stop":
                await self.stop("Stopped.")
            elif kind == "scan":
                await self._start_scan(msg)
            else:
                # Echo only a short string type: never repr() a list or object whole.
                shown = f" {kind[:40]!r}" if isinstance(kind, str) else ""
                raise BadRequest(f"Unknown message type{shown}.")
        except BadRequest as e:
            await self._status("error", message=str(e))
            if self._pump_owns_receiver():
                # Refused before anything changed: the session still plays. The
                # browser reads "error" as the radio having stopped, so say where
                # it stands (owner D1, round 3d).
                await self._status("listening" if self._listening else "connecting")
        except ClientGone:
            raise
        except Exception:
            # Keep the socket rather than let the error drop it with no word
            # why. Say "error" only if the session really ended: the browser
            # treats that status as the radio having stopped.
            log.exception("handling %r failed", kind)
            if kind == "scan":
                scan_id = msg.get("id")
                if not isinstance(scan_id, int) or isinstance(scan_id, bool):
                    scan_id = None
                await self._scan_reply(
                    scan_id, self._target, "error", message="The scan broke. Check the radio service's logs."
                )
            elif self._pump is None or self._pump.done():
                await self._status("error", message="Something broke in the radio service. Try again.")
            elif kind == "tune" and self._pump_owns_receiver():
                # The session still plays; the retune just didn't apply. Say where
                # it stands, or the browser's pending tune waits on an answer forever.
                await self._status("listening" if self._listening else "connecting")

    def _pump_owns_receiver(self) -> bool:
        # A pump that ended on its own clears _target before it closes the Kiwi
        # and sends its ending: say nothing for it, or "connecting" could land
        # after that ending and stick.
        return self._pump is not None and not self._pump.done() and self._target is not None

    async def _tune(self, msg: dict[str, Any]) -> None:
        # Lowercased like the resolver does, so Kiwi.Example and kiwi.example
        # are the same receiver and a retune doesn't reconnect.
        raw_host = msg.get("host")
        if raw_host is None:  # null or absent: no receiver picked
            raw_host = ""
        if not isinstance(raw_host, str):  # never str() a list or object: that copies it whole
            raise BadRequest("tune needs host, port and freqKhz.")
        if len(raw_host) > RAW_HOST_MAX:  # checked before copying it
            raise BadRequest("That receiver address is too long.")
        host = raw_host.strip().lower()
        if not host:
            raise BadRequest("Pick a receiver first.")
        raw_port = msg.get("port")
        if raw_port is None or (type(raw_port) is int and raw_port == 0):
            raw_port = DEFAULT_PORT  # null, absent or the number 0 (not "0" or 0.0): the default
        raw_freq = msg.get("freqKhz")
        # JSON true/false are ints to Python, int() truncates 8073.9, and an
        # empty list or object is no port: refuse them rather than dial a port
        # or frequency the client never meant.
        if (
            isinstance(raw_port, bool)
            or not isinstance(raw_port, (int, float, str))
            or (isinstance(raw_port, float) and not raw_port.is_integer())
        ):
            raise BadRequest("Port must be between 1 and 65535.")
        if isinstance(raw_port, str) and len(raw_port) > NUMBER_TEXT_MAX:
            raise BadRequest("Port must be between 1 and 65535.")
        if isinstance(raw_freq, bool) or (isinstance(raw_freq, str) and len(raw_freq) > NUMBER_TEXT_MAX):
            raise BadRequest("tune needs host, port and freqKhz.")
        try:
            port = int(raw_port)
            freq = float(raw_freq)
        except (TypeError, ValueError, OverflowError) as e:
            # OverflowError: a JSON freqKhz integer too big for a float.
            raise BadRequest("tune needs host, port and freqKhz.") from e
        raw_mode = msg.get("mode", "am")
        # Same rule as the host, and never lowercase a long one: no mode is that long.
        if not isinstance(raw_mode, str) or len(raw_mode) > MODE_MAX:
            raise BadRequest(f"Mode must be one of {', '.join(MODES)}.")
        mode = raw_mode.lower()
        if not 1 <= port <= 65535:  # also keeps a huge port out of task names
            raise BadRequest("Port must be between 1 and 65535.")
        if len(host) > HOST_MAX:  # longer than any DNS name: kept out of task names and logs
            raise BadRequest("That receiver address is too long.")
        if mode not in MODES:
            raise BadRequest(f"Mode must be one of {', '.join(MODES)}.")
        if not 0 < freq <= MAX_FREQ_KHZ:
            raise BadRequest("Frequency must be between 0 and 32,000 kHz.")

        public_only = msg.get("source") == "list"
        secure = msg.get("secure") is True
        # Same receiver means same address dialed under the same rule: a list
        # tune of an address a typed tune reached privately must restart, but
        # with private hosts off (production) the two are one receiver.
        target = (host, port, self.settings.allow_private_hosts and not public_only, secure)
        pump_running = self._pump is not None and not self._pump.done()
        if pump_running and self._ending_target == target:
            # That session has ended and is closing; its status (the reason it
            # ended) is on its way. Redialing now would knock again on a Kiwi
            # that may just have refused us, and hide that answer.
            return
        same_receiver = self._target == target and pump_running
        if same_receiver:
            # Still resolving: _run reads _freq_khz/_mode when it builds the client.
            # Otherwise change them only once the retune is sent, so a failed send
            # can't leave us decoding with a mode the Kiwi never got.
            client = self._client
            if client is not None:
                try:
                    await client.tune(kiwi_freq_khz(freq, mode))
                except KiwiError:
                    # The connection is gone (the Kiwi closed it, or tune() gave
                    # it up when the Kiwi stopped reading); the pump sees that
                    # failure and reports it, so don't send a second error.
                    return
            self._freq_khz = freq
            if mode != self._mode:
                # The demodulator first: if building it fails, _mode and the
                # decoder still agree (the Kiwi already has the retune). Built
                # after the send so a pump that came up during it gets one too.
                # Accepted gap (owner D7, round 3c): a failure here leaves the
                # Kiwi on the new mode's offset (CW is shifted) while decoding
                # the old mode. Unreachable while modes are a fixed list; revisit
                # if they ever become dynamic.
                if self._listening and client is not None:
                    self._demod = Demodulator(client.info.sample_rate, mode)
                self._mode = mode
            if self._listening:
                await self._status("listening")
            return

        self._freq_khz = freq

        # Keep the slot the old pump holds: its done callback then releases nothing.
        old_holder = self._slot_holder
        handing_over = old_holder is not None
        self._slot_holder = None
        try:
            await self.stop(None)
        except BaseException:
            # The switch was cancelled (the browser left), or stopping the old
            # pump failed. Either way the old pump may still be closing its
            # Kiwi: free the slot when it ends, not now, or another listener
            # could take it while that channel is still open. For a pump that
            # has already ended, asyncio runs the callback on the next loop pass.
            # handle() reports a failure; a cancel keeps propagating.
            if old_holder is not None:
                old_holder.add_done_callback(lambda _: self._slots.release())
            raise
        if not handing_over and not self._slots.try_acquire():
            raise BadRequest("The radio service is at its listener limit. Try again in a bit.")
        self._mode = mode
        self._target = target
        self._ending_target = None
        self._pump = self._slot_holder = asyncio.create_task(
            self._run(host, port, public_only=public_only, secure=secure), name=f"{host}:{port}"
        )
        self.idle_since = None
        # A done callback, not a finally in _run: a task cancelled before it
        # first runs never enters its body.
        self._pump.add_done_callback(self._pump_done)
        self._pump.add_done_callback(self._mark_idle)

    def _pump_done(self, pump: asyncio.Task[None]) -> None:
        if pump is self._slot_holder:
            self._slot_holder = None
            self._slots.release()

    def _mark_idle(self, pump: asyncio.Task[None]) -> None:
        # A pump replaced by a switch is no longer self._pump: the new one plays.
        if pump is self._pump:
            self.idle_since = time.monotonic()

    async def _run(self, host: str, port: int, *, public_only: bool = False, secure: bool = False) -> None:
        await self._status("connecting", host=host)
        # How this pump ended, for the browser. Sent only once its Kiwi sockets
        # are closed and its slot is free, so a reconnect on "Stopped" or an
        # error finds the slot available.
        ending: dict[str, Any] | None = None
        # Cancelled (a Stop, a switch): a teardown error is logged, never raised
        # in place of the cancel, which would turn a switch into "Something broke".
        cancelled = False
        try:
            allow_private = self.settings.allow_private_hosts and not public_only
            ip = await self._resolver(host, port, allow_private=allow_private, owner=self.lookup_owner)
            client = self._client_factory(
                host, port, connect_host=ip, secure=secure, user=self.settings.ident, kiwi_agc=self.settings.kiwi_agc
            )
            self._client = client
            await client.tune(kiwi_freq_khz(self._freq_khz, self._mode))
            info = await client.connect()
            assert info.sample_rate is not None
            self._demod = Demodulator(info.sample_rate, self._mode)
            self._spectrum = Spectrum(info.sample_rate)
            self._listening = True
            await self._status("listening")

            last_meter = 0.0

            def limit_ending() -> dict[str, Any]:
                # Built when the limit fires, so it carries the frequency then.
                return self._status_payload(
                    "stopped",
                    message=f"Hit the {self.settings.max_session_minutes:g}-minute session limit. "
                    "Reconnect if you're still listening.",
                )

            # Its own timer, not a check per block: a receiver that goes quiet
            # would otherwise hold the channel until blocks() times out.
            limit = asyncio.timeout(self.settings.max_session_minutes * 60)
            try:
                async with limit:
                    async for block in client.blocks():
                        # A short SND block has no samples: the demodulator's
                        # filter can't take an empty array, and there's nothing
                        # to send. blocks() times out a receiver that only
                        # sends these.
                        if not block.samples.size:
                            continue
                        audio = self._demod.process(block.samples)
                        await self._send_bytes(AUDIO_TAG + encode_audio(audio))
                        for frame in self._spectrum.process(block.samples):
                            await self._send_bytes(SPECTRUM_TAG + encode_spectrum(frame.db))
                        now = time.monotonic()
                        if now - last_meter >= METER_INTERVAL_S:
                            last_meter = now
                            await self._send_text(
                                {"type": "meter", "rssi": round(block.rssi_dbm, 1), "overflow": block.adc_overflow}
                            )
            except TimeoutError:
                if not limit.expired():
                    raise
                ending = limit_ending()
            except KiwiError:
                # The limit's cancel can land in a call that turns it into its
                # own error (a send to the Kiwi raising "closed"): it's still the limit.
                if not limit.expired():
                    raise
                ending = limit_ending()
        except ClientGone as e:
            if (current := asyncio.current_task()) is not None and current.cancelling():
                # The browser left as a Stop or switch cancelled us: still the cancel.
                cancelled = True
                raise asyncio.CancelledError from e
        except HostRejected as e:
            if (current := asyncio.current_task()) is not None and current.cancelling():
                log.info("looking up %s ended as the session was cancelled: %r", host, e)
                cancelled = True
                raise asyncio.CancelledError from e
            ending = self._status_payload("error", message=str(e), code=e.code, retryAfterMs=e.retry_after_ms)
        except KiwiError as e:
            if (current := asyncio.current_task()) is not None and current.cancelling():
                log.info("%s ended as the session was cancelled: %r", host, e)
                # A Stop or switch's cancel that a call turned into its own error
                # (a send to the Kiwi raising "closed"): it's still that cancel,
                # not the receiver failing, so no error goes to the listener.
                cancelled = True
                raise asyncio.CancelledError from e
            ending = self._status_payload("error", message=str(e), code=e.code)
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception as e:
            if (current := asyncio.current_task()) is not None and current.cancelling():
                # A Stop or switch was cancelling us: still that cancel, so no
                # error goes to the listener (and none is logged as a crash).
                log.info("%s ended as the session was cancelled: %r", host, e, exc_info=e)
                cancelled = True
                raise asyncio.CancelledError from e
            log.exception("listen session crashed")
            ending = self._status_payload("error", message="Something broke in the radio service. Check its logs.")
        finally:
            self._listening = False
            # This pump is done with its receiver even while the teardown below
            # waits, so a tune for it now must start over, not retune a dead client.
            # One that ended on its own holds same-receiver tunes until its
            # status has gone out (see _tune).
            if ending is not None:
                self._ending_target = self._target
            self._target = None
            # Close the audio and the scan (with its waterfall, which shares this
            # Kiwi channel) side by side, so the listener's status waits for the
            # slower of the two, not their sum. The slot frees when this pump
            # ends, so a second cancel (the session closing mid-switch) must not
            # end the pump early: it aborts the audio socket (gone at once) and
            # waits out the scan's teardown, which is bounded. The client is
            # taken here, not in the close task, so that abort reaches it even
            # if the task never gets to run.
            client, self._client = self._client, None
            closing = {asyncio.create_task(self._end_scan())}
            closing_audio = asyncio.create_task(client.close()) if client is not None else None
            if closing_audio is not None:
                closing.add(closing_audio)

            def drop_audio() -> None:
                if client is not None:
                    client.abort()
                if closing_audio is not None:
                    closing_audio.cancel()

            try:
                await asyncio.wait(closing)
            except asyncio.CancelledError:
                drop_audio()
                # Later cancels (a Stop or switch, then the browser leaving)
                # don't end the wait either: it's bounded, and ending early
                # would free the slot while the scan's waterfall still closes.
                while True:
                    try:
                        await asyncio.wait(closing)
                        break
                    except asyncio.CancelledError:
                        drop_audio()
                for error in _failures(closing):
                    log.warning("closing %s after a cancel failed: %r", host, error, exc_info=error)
                # This pump's ending status won't go out, so stop holding tunes for it.
                if ending is not None:
                    self._ending_target = None
                raise
            teardown_errors = _failures(closing)
            if teardown_errors and ending is None and not cancelled:
                for error in teardown_errors[1:]:
                    log.warning("closing %s also failed: %r", host, error, exc_info=error)
                raise teardown_errors[0]
            for error in teardown_errors:
                # The sockets are dropped either way; an ending still goes to
                # the listener, and a cancel still propagates.
                log.warning("closing %s failed: %r", host, error, exc_info=error)
        # Every socket on the channel is closed (the finally above ran in full),
        # so free the slot now and then tell the browser. _pump_done, the done
        # callback, is the backstop for every pump that doesn't get here:
        # cancelled before it started, while listening (Stop, a switch) or
        # during teardown, or failing its teardown with no ending to report.
        self._pump_done(asyncio.current_task())
        if ending is not None:
            # Same-receiver tunes stay held through this send: a switch now
            # would cancel it, losing the reason (a refusal, the limit) and
            # redialing the Kiwi that gave it.
            await self._send_status(ending)
            self._ending_target = None

    async def _close_client(self) -> None:
        # Let go first: a close cut short by a cancel leaves no dead client to
        # retune or close again.
        client, self._client = self._client, None
        if client is not None:
            await client.close()

    def _status_payload(self, state: str, **extra: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "type": "status",
            "state": state,
            "mode": self._mode,
            "freqKhz": self._freq_khz,
            "features": FEATURES,
        }
        if self._target:
            payload["host"], payload["port"], _, _ = self._target
        if self._client is not None and self._client.info.sample_rate:
            payload["sampleRate"] = self._client.info.sample_rate
        payload.update({k: v for k, v in extra.items() if v is not None})
        return payload

    async def _status(self, state: str, **extra: Any) -> None:
        await self._send_status(self._status_payload(state, **extra))

    async def _send_status(self, payload: dict[str, Any]) -> None:
        try:
            await self._send_text(payload)
        except Exception:
            # The browser went away; nothing useful to do.
            pass

    async def stop(self, message: str | None) -> None:
        # A cancel aimed at our caller (the browser left mid-switch) still
        # propagates, or the switch would go on to dial a receiver for nobody.
        # An error the pump ended with is logged: the session stops either way,
        # and raising it would answer Stop with "Something broke".
        try:
            await self._cancel(self._pump)
        except Exception as e:
            log.warning("the stopped session's pump had failed: %r", e, exc_info=e)
        self._pump = None
        # A pump that had already ended returns from _cancel at once, before
        # its _mark_idle callback runs, which then no longer sees it as ours.
        if self.idle_since is None:
            self.idle_since = time.monotonic()
        self._target = None
        await self._close_client()
        try:
            await self._end_scan()
        except Exception as e:
            # Its waterfall is closed either way (_end_scan's finally).
            log.warning("the stopped session's scan had failed: %r", e, exc_info=e)
        if message:
            await self._status("stopped", message=message)

    async def close(self) -> None:
        await self.stop(None)

    async def _start_scan(self, msg: dict[str, Any]) -> None:
        scan_id = msg.get("id")
        if not isinstance(scan_id, int) or isinstance(scan_id, bool):
            scan_id = None
        target, client = self._target, self._client
        if not self._listening or target is None or client is None:
            await self._scan_reply(scan_id, target, "error", message="Start listening to a receiver first.")
            return
        self._scan_id = scan_id
        self._scan_ham = msg.get("ham") is True
        if self._scan is not None and not self._scan.done():
            # Already sweeping this receiver: that sweep answers this request.
            # Cancelling it could close a half-open paired waterfall, which
            # takes the audio down with it.
            await self._scan_reply(scan_id, target, "scanning")
            return
        self._scan = asyncio.create_task(
            self._run_scan(target, client, fresh=msg.get("fresh") is True), name=f"{target[0]}:{target[1]}"
        )

    async def _run_scan(self, target: Target, client: KiwiClient, *, fresh: bool) -> None:
        answer = await self._broadcast_answer(target, client, fresh=fresh)
        if answer is None:
            return  # the connection ended; nothing to say about a receiver we left
        state, extra, swept_s = answer
        if state != "done" or not self._scan_ham:
            await self._finish(target, state, **extra)
            return
        # Broadcast first (owner D11): its rows show while the amateur bands
        # are swept, and an amateur problem can't cost the broadcast list.
        await self._scan_reply(self._scan_id, target, "done", **extra, ham={"state": "scanning"})
        budget = None if swept_s is None else max(0.0, DEADLINE_S - swept_s)
        ham = await self._ham_answer(target, client, fresh=fresh, budget_s=budget)
        if ham is None:
            return
        await self._finish(target, "done", **extra, ham=ham_payload(ham))

    async def _broadcast_answer(
        self, target: Target, client: KiwiClient, *, fresh: bool
    ) -> tuple[str, dict[str, Any], float | None] | None:
        """The broadcast part: (state, payload, seconds swept or None if reused), or None if the connection ended."""

        def reuse() -> tuple[str, dict[str, Any], None] | None:
            cached = None if fresh else self._scan_cache.get(target)
            if isinstance(cached, str):
                return "error", {"message": cached}, None
            if isinstance(cached, ScanResult):
                return "done", scan_payload(cached), None
            return None

        if (answer := reuse()) is not None:
            return answer
        last = self._last_sweep
        if last is not None and last[1] == target and time.monotonic() - last[0] < SCAN_MIN_INTERVAL_S:
            return last[2], last[3], None
        await self._scan_reply(self._scan_id, target, "scanning")
        if not await self._take_sweep_slot(target, client, reuse):
            return None
        # Another listener's sweep (or refusal) may have filled the cache while this one waited.
        if (answer := reuse()) is not None:
            return answer
        started = time.monotonic()
        try:
            waterfall = await self._paired_waterfall(client)
            result = await sweep(waterfall.frame, waterfall.info.freq_offset_khz, waterfall.bandwidth_khz)
        except KiwiError as e:
            if self._client is not client:
                return None  # this connection ended; its teardown owns the waterfall
            await self._keep_waterfall_after_error()
            message = f"Couldn't scan this receiver: {e}"
            # Only while still on this receiver: a scan cut short by the
            # listener leaving (or the receiver dropping them) proves nothing.
            if e.code in SCAN_REFUSALS and self._target == target:
                self._scan_cache.put(target, message, SCAN_REFUSAL_CACHE_S)
            return self._swept(target, "error", message=message)
        except Exception:
            log.exception("scan crashed")
            if self._client is not client:
                return None
            # Keep any waterfall drained: a dropped one takes the audio with it.
            self._idle_waterfall()
            return self._swept(target, "error", message="The scan broke. Check the radio service's logs.")
        if self._client is not client:
            # The connection ended mid-sweep: no answer about a receiver we
            # left, and nothing cached or idled against the next one.
            return None
        self._idle_waterfall()
        if result.bands_done == 0 and result.bands_total > 0:
            # Not one frame came back: "no strong signals" would be a claim
            # the scan can't make.
            return self._swept(target, "error", message="Couldn't scan this receiver: it didn't send its waterfall.")
        result = replace(result, at_ms=int(time.time() * 1000))
        # A partial sweep (a stalled or slow receiver) isn't kept: shared for
        # 10 minutes it would stand in for a full scan for every listener.
        if not result.partial:
            self._scan_cache.put(target, result)
        state, extra, _ = self._swept(target, "done", **scan_payload(result))
        return state, extra, time.monotonic() - started

    async def _ham_answer(
        self, target: Target, client: KiwiClient, *, fresh: bool, budget_s: float | None
    ) -> HamResult | dict[str, Any] | None:
        """The amateur part: a result, an error payload, or None if the connection ended.

        budget_s is what's left of DEADLINE_S after a broadcast sweep in this
        same scan, which also holds the listener's sweep slot; None means the
        broadcast part was reused, so this pass takes a slot of its own.
        """
        key = (target, "ham")

        def reuse() -> HamResult | None:
            cached = None if fresh else self._scan_cache.get(key)
            return cached if isinstance(cached, HamResult) else None

        if (cached := reuse()) is not None:
            return cached
        last = self._last_ham
        if last is not None and last[1] == target and time.monotonic() - last[0] < SCAN_MIN_INTERVAL_S:
            return last[2]
        if budget_s is None:
            if not await self._take_sweep_slot(target, client, reuse):
                return None
            if (cached := reuse()) is not None:
                return cached
        elif budget_s <= 0:
            # The broadcast sweep used the whole of DEADLINE_S (a very slow receiver).
            return self._swept_ham(target, {"state": "error", "message": OUT_OF_TIME})
        started = time.monotonic()
        try:
            waterfall = await self._paired_waterfall(client)
            result = await sweep_ham(
                waterfall.frame,
                waterfall.hold,
                waterfall.info.freq_offset_khz,
                waterfall.bandwidth_khz,
                deadline_s=DEADLINE_S if budget_s is None else budget_s,
            )
        except KiwiError as e:
            if self._client is not client:
                return None
            await self._keep_waterfall_after_error()
            return self._swept_ham(target, {"state": "error", "message": f"Couldn't scan the amateur bands: {e}"})
        except Exception:
            log.exception("amateur scan crashed")
            if self._client is not client:
                return None
            self._idle_waterfall()
            message = "The amateur scan broke. Check the radio service's logs."
            return self._swept_ham(target, {"state": "error", "message": message})
        if self._client is not client:
            return None
        self._idle_waterfall()
        if result.bands_done == 0 and result.bands_total > 0:
            # Not one band in: either the budget ran out first (after a slow
            # broadcast sweep) or the waterfall stalled.
            ran_out = budget_s is not None and time.monotonic() - started >= budget_s - 0.05
            message = OUT_OF_TIME if ran_out else "The receiver didn't send its waterfall."
            return self._swept_ham(target, {"state": "error", "message": message})
        result = replace(result, at_ms=int(time.time() * 1000))
        # Amateur signals come and go: kept HAM_CACHE_S, and only when complete.
        if not result.partial:
            self._scan_cache.put(key, result, HAM_CACHE_S)
        return self._swept_ham(target, result)

    async def _take_sweep_slot(self, target: Target, client: KiwiClient, cached: Callable[[], object]) -> bool:
        """Wait out this listener's SCAN_MIN_INTERVAL_S for this receiver, then take it.

        False if the connection ended meanwhile (the slot is left for the next
        one). Not taken either when cached() finds an answer after the wait
        (O5): the caller then reuses it instead of sweeping.
        """
        # No await between the last check and start(), so listeners sharing
        # an IP queue up one sweep at a time.
        key = (self.lookup_owner, target)
        while (wait := self._sweep_times.wait_s(key)) > 0:
            await asyncio.sleep(wait)
        if self._client is not client:
            return False
        if cached() is None:
            self._sweep_times.start(key)
        return True

    async def _keep_waterfall_after_error(self) -> None:
        if self._waterfall is not None and self._waterfall.is_open:
            # Still paired with the audio: closing it would end the
            # listener's audio over a scan problem. Keep it drained; idle
            # closes it if it turns out to be dead.
            self._idle_waterfall()
        else:
            await self._drop_waterfall()

    def _swept_ham(self, target: Target, answer: HamResult | dict[str, Any]) -> HamResult | dict[str, Any]:
        """Remember an amateur sweep's answer for SCAN_MIN_INTERVAL_S, like _swept."""
        self._last_ham = (time.monotonic(), target, answer)
        return answer

    def _swept(self, target: Target, state: str, **extra: Any) -> tuple[str, dict[str, Any], None]:
        """Remember a broadcast sweep's answer for SCAN_MIN_INTERVAL_S."""
        self._last_sweep = (time.monotonic(), target, state, extra)
        return state, extra, None

    async def _finish(self, target: Target, state: str, **extra: Any) -> None:
        """The scan's last reply, under the newest request's id.

        The scan stops counting as running first, so a request arriving while
        this reply is sent starts a new scan instead of waiting on this one.
        """
        if self._scan is asyncio.current_task():
            self._scan = None
        await self._scan_reply(self._scan_id, target, state, **extra)

    def _idle_waterfall(self) -> None:
        if self._waterfall is not None and (self._waterfall_idle is None or self._waterfall_idle.done()):
            name = f"{self._target[0]}:{self._target[1]}" if self._target is not None else None
            self._waterfall_idle = asyncio.create_task(self._idle(self._waterfall), name=name)

    async def _paired_waterfall(self, client: KiwiClient) -> WaterfallClient:
        if self._client is not client:
            # A scan from a connection that has ended: the session's waterfall
            # (if any) belongs to the next one.
            raise KiwiError("closed", f"{client.host}: the receiver connection ended")
        # Wait for the idle reader to finish: its recv would collide with the sweep's.
        await self._cancel(self._waterfall_idle)
        if self._client is not client:
            # The connection ended while the idle reader stopped: the waterfall
            # and idle reader now belong to the next one, and a new dial would
            # land on a channel whose slot may already be free.
            raise KiwiError("closed", f"{client.host}: the receiver connection ended")
        self._waterfall_idle = None
        if self._waterfall is not None:
            kept = self._waterfall
            refusal = getattr(kept, "refusal", None)
            if refusal is not None:
                # Refused but kept open (it may carry the audio): it can't
                # sweep, and the receiver's reason still stands.
                raise refusal
            await kept.fast()
            if self._client is not client:
                # Ended while switching speed: don't sweep this waterfall, whose
                # connection (and maybe slot) is gone; any the next connection
                # stored meanwhile is left alone.
                raise KiwiError("closed", f"{client.host}: the receiver connection ended")
            return kept
        waterfall = self._waterfall_factory(
            client.host,
            client.port,
            connect_host=client.connect_host,
            secure=client.secure,
            user=self.settings.ident,
            # Same timestamp: joins the audio's channel instead of being refused.
            timestamp=client.timestamp,
        )
        self._connecting = waterfall
        try:
            try:
                await waterfall.connect()
            except asyncio.CancelledError:
                # Cancelled mid-handshake (the audio is ending): drop the half-open
                # one at once rather than wait on a goodbye.
                waterfall.abort()
                await waterfall.close()
                raise
            except Exception as e:
                unpaired = isinstance(e, KiwiError) and e.code == "unpaired"
                if waterfall.is_open and not unpaired and self._client is client:
                    # Not set up, or refused after the Kiwi may have paired it:
                    # keep it, so the caller drains it rather than closing it and
                    # ending the audio. A Kiwi that really refused it closes it itself.
                    self._waterfall = waterfall
                    if isinstance(e, KiwiError) and e.code != "timeout":
                        waterfall.refusal = e
                else:
                    # Never paired (badp=5), already closed, or its connection
                    # has ended: safe to close.
                    await waterfall.close()
                raise
            if self._client is not client:
                await waterfall.close()
                raise KiwiError("closed", f"{client.host}: the receiver connection ended")
            self._waterfall = waterfall
            return waterfall
        finally:
            if self._connecting is waterfall:
                self._connecting = None

    async def _idle(self, waterfall: WaterfallClient) -> None:
        while True:
            try:
                await waterfall.idle()
            except Exception as e:
                if (current := asyncio.current_task()) is not None and current.cancelling():
                    # A cancel that came back as an error is still the cancel:
                    # don't keep looping and hold up the stop (owner D11).
                    raise asyncio.CancelledError from e
                if isinstance(e, KiwiError):
                    # The audio pump reports it if the Kiwi took the audio down too.
                    log.info("scan waterfall ended: %s", e)
                else:
                    log.exception("scan waterfall crashed while idling")
            else:
                return
            if not waterfall.is_open:
                break
            # Still paired: closing it would end the audio. Keep draining; the
            # audio's end closes it (_end_scan), so nothing is left behind.
            await asyncio.sleep(IDLE_RETRY_S)
        if self._waterfall is waterfall:
            self._waterfall = None
        await waterfall.close()

    async def _drop_waterfall(self) -> None:
        waterfall, self._waterfall = self._waterfall, None
        if waterfall is not None:
            await waterfall.close()

    async def _end_scan(self) -> None:
        """Stop any scan and close its waterfall; the receiver connection has ended."""
        scan, idle = self._scan, self._waterfall_idle
        try:
            await self._stop_scan_tasks(scan, idle)
        except asyncio.CancelledError:
            # Backstop for a caller that cancels this while a scan stops (the
            # pump runs it as its own task and doesn't): that scan may still be
            # closing a half-open waterfall on this channel that only it holds.
            # Let it finish (bounded) before the slot can free.
            # Read any that had already failed: the cut-short stop never did.
            for error in _failures(t for t in (scan, idle) if t is not None):
                log.warning("a stopped scan task failed: %r", error, exc_info=error)
            stopping = {t for t in (scan, idle) if t is not None and not t.done()}
            # Tracked before the wait, so a second cancel cutting it short
            # still leaves each held and its error logged when it ends.
            for task in stopping - scan_stragglers:
                scan_stragglers.add(task)
                task.add_done_callback(_log_straggler)
            if stopping:
                try:
                    _, pending = await asyncio.wait(stopping, timeout=SCAN_STOP_TIMEOUT_S)
                except asyncio.CancelledError:
                    # Cut short: whatever still runs has outlived the stop.
                    late_stragglers.update(t for t in stopping if not t.done())
                    raise
                late_stragglers.update(pending)  # a stop on time stays quiet
            raise
        finally:
            # However the stop went (even if a scan task raised): a new
            # connection gets a new sweep, since the last answer may be an
            # error from a scan this ending cut short.
            if self._scan is scan:
                self._scan = None
            if self._waterfall_idle is idle:
                self._waterfall_idle = None
            self._last_sweep = None
            self._last_ham = None
            # Even when cancelled waiting on the scan: the waterfall shares the
            # Kiwi channel, and the pump that called us frees the slot next.
            # A scan that never stopped may still hold one mid-handshake (or
            # mid-close, or still dialing): abort drops that socket, cancels a
            # dial still in progress (or stops one from starting), and a
            # handshake that finishes anyway is dropped on arrival.
            connecting, self._connecting = self._connecting, None
            if connecting is not None:
                connecting.abort()
            await self._drop_waterfall()

    @staticmethod
    async def _stop_scan_tasks(*tasks: asyncio.Task[None] | None) -> None:
        """Cancel the scan and idle tasks and wait for them together, but not forever.

        Their own cleanup is a bounded waterfall close; one that outlives
        SCAN_STOP_TIMEOUT_S has swallowed its cancel, so log it and let the
        session end (its connecting waterfall is aborted) instead of holding
        the slot indefinitely. Both are stopped before either's error is raised.
        """
        running = {t for t in tasks if t is not None and not t.done() and t is not asyncio.current_task()}
        for task in running:
            task.cancel()
        if running:
            _, pending = await asyncio.wait(running, timeout=SCAN_STOP_TIMEOUT_S)
            if pending:
                log.warning("%d cancelled scan task(s) still running after %gs", len(pending), SCAN_STOP_TIMEOUT_S)
                late_stragglers.update(pending)
                for task in pending - scan_stragglers:  # once, however often it is stopped
                    scan_stragglers.add(task)
                    task.add_done_callback(_log_straggler)
        errors = _failures(running)
        for error in errors[1:]:
            log.warning("a stopped scan task also failed: %r", error, exc_info=error)
        if errors:
            raise errors[0]

    @staticmethod
    async def _cancel(task: asyncio.Task[None] | None) -> None:
        if task is not None and task.done():
            if not task.cancelled() and task.exception() is not None:
                # Ended with an error that may never have been read: say so
                # here, not as an unexplained "never retrieved" at garbage
                # collection.
                log.warning("%s had failed: %r", _task_name(task), task.exception(), exc_info=task.exception())
            return
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        # Wait for it without taking on its CancelledError. A cancel aimed at
        # our caller still raises here, as the caller's own: re-raising the
        # task's instead (one that lands in a shielded websocket close carries
        # no message) slips past the cancel scope that sent the caller's, as
        # Starlette's TestClient and a server shutdown do.
        await asyncio.wait({task})
        if not task.cancelled() and task.exception() is not None:
            raise task.exception()

    async def _scan_reply(self, scan_id: int | None, target: Target | None, state: str, **extra: Any) -> None:
        payload: dict[str, Any] = {"type": "scan", "id": scan_id, "state": state}
        if target is not None:
            payload["host"], payload["port"], _, _ = target
        payload.update(extra)
        if not self._scan_ham:
            # A request that didn't ask for the amateur bands (an older web
            # app tunes every row in AM) never gets them, even from a scan
            # that swept them for an earlier request.
            payload.pop("ham", None)
        try:
            await self._send_text(payload)
        except Exception:
            # The browser went away; nothing useful to do.
            pass


def ham_payload(answer: HamResult | dict[str, Any]) -> dict[str, Any]:
    """The reply's "ham" object. ageMs is how old the sweep is now, so a reused
    result never reads as fresh and the browser's clock doesn't matter."""
    if isinstance(answer, dict):
        return answer
    return {
        "state": "done",
        "voice": answer.voice,
        "cw": answer.cw,
        "digital": answer.digital,
        "bandsDone": answer.bands_done,
        "bandsTotal": answer.bands_total,
        "partial": answer.partial,
        "atMs": answer.at_ms,
        "ageMs": max(0, int(time.time() * 1000) - answer.at_ms),
    }


def scan_payload(result: ScanResult) -> dict[str, Any]:
    return {
        "signals": result.signals,
        "hidden": result.hidden,
        "bandsDone": result.bands_done,
        "bandsTotal": result.bands_total,
        "partial": result.partial,
        "atMs": result.at_ms,
    }
