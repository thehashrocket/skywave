"""One browser listener: owns a Kiwi connection and the DSP chain for it.

Browser -> service (JSON text frames):
    {"type": "tune", "host": "...", "port": 8073, "freqKhz": 9535, "mode": "am", "source": "list", "secure": true,
     "ident": "N0CALL"}
    ("source": "list" marks a receiver the browser picked from the public list
    rather than one a person typed; those are only ever dialed on public
    addresses, even with ALLOW_PRIVATE_HOSTS on. "secure": true dials wss://.
    "retune": true marks a dial move: it only retunes the session playing that
    receiver and never starts one. "ident", optional, is the listener's call
    sign or name: shown in the receiver's user list as "skywave N0CALL"
    when it passes listener_ident's check, else the service's own name. It
    applies from the Listen that carries it: a tune without "retune" for the
    receiver already playing renames its connections in place, while a dial
    retune keeps the name. The waterfall a scan or view opens joins the audio's
    channel, so it carries the audio's name.)
    {"type": "stop"}
    {"type": "scan", "id": 3, "fresh": false}
    (scan the receiver being listened to for strong broadcast signals; "fresh"
    skips the 10-minute cache. Send it only to a service whose status lists
    "scan" in "features": an older one answers it with a status error.)
    {"type": "view", "id": 4, "zoom": 9, "cfKhz": 9650}
    {"type": "view", "zoom": null}
    (stream the receiver's own waterfall, bandwidth/2^zoom wide around cfKhz
    (RF), as 0x05 frames; null goes back to none. It shares the audio's Kiwi
    channel, pauses while a scan sweeps, and points again after it. Ask again
    after each "listening" status for a new receiver. Needs "view" in
    "features".)
    {"type": "decode", "mode": "rtty", "markHz": 1585, "reverse": false}
    {"type": "decode", "mode": null}
    (decode RTTY, 45.45 baud 170 Hz shift, from the audio's own I/Q: no extra
    Kiwi channel. "markHz" is the mark tone's offset from the dial frequency,
    the pitch it has in USB; leave it out or null to find the tone pair
    automatically. A retune to another frequency goes back to automatic.
    "reverse" swaps mark and space (normal: mark is the higher tone). Kept
    across receivers until turned off. Needs "decode" in "features".)

Service -> browser:
    JSON text: {"type": "status", "state": "connecting|listening|stopped|error", "features": ["scan"], ...}
               (an uncoded error may carry "retryAfterMs": the same receiver
               may work if tried again after that long)
    JSON text: {"type": "scan", "id": 3, "host": "...", "port": 8073, "state": "scanning|done|error", ...}
               (done: "signals" [{"freqKhz", "snrDb", "band"}] strongest first,
               "hidden" flat-topped signals left out, "bandsDone", "bandsTotal",
               "partial", "atMs"; error: "message". Scan failures never come as
               a status: listening goes on. id, host and port echo the request,
               so a late reply for another receiver or request can be ignored.)
    JSON text: {"type": "meter", "rssi": -73.1, "overflow": false}
    JSON text: {"type": "view", "id": 4, "state": "error", "message": "..."}
               (the view asked for can't be shown; the audio plays on)
    JSON text: {"type": "decode", "mode": "rtty", "state": "searching|locked|off|error",
                "markHz": 1585, "reverse": false, "message": "..."}
               (the decoder's state: on each decode request, and when it finds,
               moves or loses its tone pair. "locked" means text is coming
               out; markHz is set once a pair is found. "error": the request
               was refused or the decoder failed and is off; the audio plays on)
    JSON text: {"type": "decoded", "mode": "rtty", "text": "...", "atMs": 1764000000000}
               (decoded text, batched about every DECODED_INTERVAL_S; atMs is
               wall-clock ms when the batch went out)
    Binary:    0x03 + int16 LE mono audio at `sampleRate` (full scale = 32767)
    Binary:    0x04 + float32 LE base dB + uint8 bins spanning -sampleRate/2..+sampleRate/2,
               each bin base + v * 0.5 dB
    Binary:    0x05 + uint32 LE view id + float32 LE start kHz (RF) + float32 LE span kHz
               + 1024 uint8 bins across it, about 1 dB per step (the Kiwi's own scale)
    (0x01/0x02, the same with float32 samples and dB, are no longer sent; the
    browser still reads them so the web app can deploy before this service.)
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import struct
import time
from collections.abc import Awaitable, Callable, Hashable, Iterable
from dataclasses import replace
from functools import partial
from typing import Any

from .config import Settings
from .dsp import CW_PITCH_HZ, MODES, PASSBANDS, Demodulator, Spectrum, encode_audio, encode_spectrum
from .hostguard import HostRejected, is_public_address, loggable_host, resolve_receiver
from .kiwi import CLOSE_TIMEOUT_S, DEFAULT_PORT, KiwiClient, KiwiError
from .noise import OVERFLOW_HOLD_S, NoiseSampler
from .rtty import RttyDecoder
from .scan import ScanResult, sweep
from .waterfall import MAX_ZOOM, View, WaterfallClient, WaterfallFrame

log = logging.getLogger(__name__)
# One line per receiver outcome (#144): every error a Listen ends on, every
# coded refusal of ours, and every receiver that starts playing, so failures can
# be read as rates per receiver. `listeners` is the service's load at the time
# (#146): a timeout under load may be us falling behind, not the Kiwi. Only
# shaped values: a checked host, codes, KiwiError.detail and numbers; never a
# listener's name or address. server.py can also send it to a file (RECEIVER_LOG).
receiver_log = logging.getLogger("skywave_radio.receivers")
# Always on, whatever level the root logger runs at.
receiver_log.setLevel(logging.INFO)

AUDIO_TAG = b"\x03"
SPECTRUM_TAG = b"\x04"
VIEW_TAG = b"\x05"
# View ids are the browser's, echoed in each frame's uint32.
MAX_VIEW_ID = 2**32 - 1
MAX_FREQ_KHZ = 32_000.0
METER_INTERVAL_S = 0.25
# A browser that stops reading (frozen tab, dead Wi-Fi) blocks our sends; past
# this we give up on it so it stops holding a slot and a volunteer's channel.
# Long enough to ride out a Wi-Fi roam or a laptop waking up.
SEND_TIMEOUT_S = 15.0
# A session writes at most one receiver-log line per refusal of ours (receiver,
# code) this often, so a page looping refused tunes, which dial nothing, can't
# rotate the receiver log's history out (#144). The next line says how many it dropped.
REFUSED_LOG_INTERVAL_S = 10.0
# Receivers that throttle remembers per session, at most: past this, refusals of
# the same code share one "host=<many>" key, so a page tuning ever-new dead
# names can't grow a session's memory without limit (owner D4, run 2).
REFUSED_LOG_KEYS = 256
# The host the shared key logs as.
MANY_RECEIVERS = "<many>"

# Statuses list what this service can do, so a newer web app knows whether to ask.
FEATURES = ["scan", "view", "decode"]
# Decoders a "decode" request can name.
DECODE_MODES = ("rtty",)
# Decoded text goes out in batches at most this often.
DECODED_INTERVAL_S = 0.5
# A mark tone further than this from the dial is outside any I/Q the Kiwi sends.
MAX_MARK_HZ = 5000.0
# How long a receiver's scan is reused before a new one is made.
SCAN_CACHE_S = 600.0
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
# A listener's own name for the receiver's user list (issue #108): letters,
# digits, / - _ and single spaces, at most IDENT_MAX characters once trimmed.
IDENT_MAX = 24
IDENT_CHARS = re.compile(r"[A-Za-z0-9/_\- ]+")
# Put before it, so the receiver's owner still sees the listener came through
# Skywave. First, not last (owner decision, #108): a Kiwi cuts idents at its
# ident_len (16 on most), and a cut must take the name's end, not the marker.
# Fixed, not KIWI_IDENT: production's "skywavehf.com " would leave a 16-character
# ident_len room for two letters of the name. KIWI_IDENT names only the
# connections that carry no listener's name.
IDENT_PREFIX = "skywave "
# Longer than any name in MODES: refused before it is lowercased.
MODE_MAX = 8
# A port or frequency sent as text longer than this is refused before int() or
# float() parses it: no real one is near this long.
NUMBER_TEXT_MAX = 32


def listener_ident(raw: object, default: str) -> str:
    """The ident_user for a listener's audio connection: their name with
    IDENT_PREFIX before it, or `default` for anything blank or outside IDENT_CHARS.
    Runs of whitespace (tabs and newlines too) become one space, so nothing
    but those characters can reach a SET command."""
    if not isinstance(raw, str) or len(raw) > 4 * IDENT_MAX:
        return default
    name = " ".join(raw.split())
    if not name or len(name) > IDENT_MAX or not IDENT_CHARS.fullmatch(name):
        return default
    return IDENT_PREFIX + name


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
    """A message we refuse. `code`, when set, is about the receiver named by
    `host`/`port` (like a KiwiError's), so the browser can move on to another
    one; uncoded means the request or this service, and Pick best stops. The
    one exception is skywave_full (this service at MAX_SESSIONS, #146): coded
    so the page can tell it from a failure, but Pick best stops on it too.

    `code` is what the page is sent; `log_code` is what the receiver log gets."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        host: str | None = None,
        port: int | None = None,
        detail: str | None = None,
        log_code: str | None = None,
    ):
        super().__init__(message)
        self.code = code
        # For the receiver log only, like KiwiError.detail.
        self.detail = detail
        self.log_code = log_code or code
        self.host = host
        self.port = port


class ClientGone(Exception):
    """The browser disconnected; stop quietly."""


class Lease:
    """One listener slot taken through Slots.acquire: who holds it and where."""

    __slots__ = ("receiver", "owner", "released")

    def __init__(self, receiver: Hashable, owner: Hashable | None):
        self.receiver = receiver
        self.owner = owner
        self.released = False


class Slots:
    """Caps live Kiwi connections across every browser session.

    Each one occupies a channel on a volunteer's receiver, so that's what we
    count: in all (`limit`), on any one receiver (`per_receiver`), so a crowd
    can't fill one volunteer's Kiwi, and per listener (`per_owner`, a public
    address as server.socket_owner groups it), so one person with a few tabs
    can't hold every slot. None means no cap of that kind.

    No lock: acquire, move and release never await, and everything runs on
    one event loop. try_acquire()/release() take and free a slot counted only
    against `limit`; a Lease is released at most once, however often asked.
    """

    def __init__(self, limit: int, *, per_receiver: int | None = None, per_owner: int | None = None):
        self.limit = limit
        self.per_receiver = per_receiver
        self.per_owner = per_owner
        self.active = 0
        self._receivers: dict[Hashable, int] = {}
        self._owners: dict[Hashable, int] = {}

    def try_acquire(self) -> bool:
        if self.active >= self.limit:
            return False
        self.active += 1
        return True

    def release(self, lease: Lease | None = None) -> None:
        if lease is not None:
            if lease.released:
                return
            lease.released = True
            self._drop(self._receivers, lease.receiver)
            if lease.owner is not None:
                self._drop(self._owners, lease.owner)
        # Below zero the cap would admit extra listeners. Never end anyone's
        # audio over the bookkeeping; say so loudly instead.
        if self.active <= 0:
            log.error("listener slot released with none held (active=%d)", self.active)
            self.active = 0
            return
        self.active -= 1

    def refusal(self, receiver: Hashable, owner: Hashable | None) -> str | None:
        """Why a new slot on `receiver` for `owner` would be refused, or None.

        "receiver", "owner" or "full" (the overall limit), checked in that
        order: a full receiver is the one answer another receiver can fix.
        """
        if self.receiver_full(receiver):
            return "receiver"
        if owner is not None and self.per_owner is not None and self._owners.get(owner, 0) >= self.per_owner:
            return "owner"
        if self.active >= self.limit:
            return "full"
        return None

    def receiver_full(self, receiver: Hashable) -> bool:
        return self.per_receiver is not None and self._receivers.get(receiver, 0) >= self.per_receiver

    def held(self, receivers: Iterable[Hashable]) -> list[Hashable]:
        """Those of `receivers` at the per-receiver cap now, in the order given (GET /held)."""
        return [r for r in receivers if self.receiver_full(r)]

    def acquire(self, receiver: Hashable, owner: Hashable | None) -> Lease | str:
        """A Lease, or the refusal() reason when there's no room."""
        reason = self.refusal(receiver, owner)
        if reason is not None:
            return reason
        self.active += 1
        self._receivers[receiver] = self._receivers.get(receiver, 0) + 1
        if owner is not None:
            self._owners[owner] = self._owners.get(owner, 0) + 1
        return Lease(receiver, owner)

    def move(self, lease: Lease, receiver: Hashable) -> bool:
        """Point a held lease at another receiver, if that one has room.

        A switch keeps its slot this way rather than releasing and re-taking
        it, which another listener could win in between.
        """
        if lease.released:
            return False
        if receiver == lease.receiver:
            return True
        if self.receiver_full(receiver):
            return False
        self._drop(self._receivers, lease.receiver)
        self._receivers[receiver] = self._receivers.get(receiver, 0) + 1
        lease.receiver = receiver
        return True

    def on_receiver(self, receiver: Hashable) -> int:
        return self._receivers.get(receiver, 0)

    @staticmethod
    def _drop(counts: dict[Hashable, int], key: Hashable) -> None:
        left = counts.get(key, 0) - 1
        if left > 0:
            counts[key] = left
        else:
            counts.pop(key, None)


class ScanCache:
    """Recent scans per receiver, shared by every session for SCAN_CACHE_S.

    A refusal is kept too, as its error message, for a shorter time, so a
    receiver that turned a scan away isn't asked again by every listener.
    """

    def __init__(self, ttl_s: float = SCAN_CACHE_S):
        self.ttl_s = ttl_s
        # key -> (expiry on the monotonic clock, result or refusal message)
        self._entries: dict[Hashable, tuple[float, ScanResult | str]] = {}

    def get(self, key: Hashable) -> ScanResult | str | None:
        entry = self._entries.get(key)
        if entry is None or time.monotonic() > entry[0]:
            return None
        return entry[1]

    def put(self, key: Hashable, result: ScanResult | str, ttl_s: float | None = None) -> None:
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
        owner: Hashable | None = None,
        on_stalled: Callable[[], None] | None = None,
        noise: NoiseSampler | None = None,
    ):
        self.settings = settings
        self._raw_send_text = send_text
        self._raw_send_bytes = send_bytes
        self._slots = slots or Slots(
            settings.max_sessions,
            per_receiver=settings.max_sessions_per_receiver,
            per_owner=settings.max_sessions_per_ip,
        )
        # Who MAX_SESSIONS_PER_IP counts this session against (server.socket_owner),
        # or None for no one.
        self._owner = owner
        self._scan_cache = scan_cache or ScanCache()
        self._sweep_times = sweep_times or SweepTimes()
        self._resolver = resolver
        self._client_factory = client_factory
        self._waterfall_factory = waterfall_factory
        self._client_ip = client_ip
        self._on_stalled = on_stalled
        # Shared by every session: samples each receiver's noise floor from the
        # sweeps' and live views' frames (issue #67). None measures nothing.
        self._noise = noise
        # When the receiver's audio last reported an ADC overflow (monotonic):
        # frames near it aren't sampled.
        self._overflow_at = -math.inf
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
        # The slot that holder's end releases.
        self._lease: Lease | None = None
        # Refusal lines written to the receiver log: (host, port, code) -> (when, dropped since).
        self._refused_logged: dict[tuple[str, object, str, str], tuple[float, int]] = {}
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
        # The receiver user-list name for this listener's connections (#108).
        self._ident: str = settings.ident
        self._waterfall_idle: asyncio.Task[None] | None = None
        self._scan: asyncio.Task[None] | None = None
        # The live view the browser asked for, (id, zoom, RF centre in kHz), or
        # None. Kept across receivers; the browser asks again for each one.
        self._view: tuple[int, int, float] | None = None
        # Opening the paired waterfall for the view (no scan has opened one).
        self._view_open: asyncio.Task[None] | None = None
        # The view frame on its way to the browser; frames that come while it
        # is still going are dropped, so a slow browser never stalls the reader
        # that keeps the waterfall (and with it the audio) alive.
        self._view_send: asyncio.Task[None] | None = None
        # A view change arrived while a sweep or the opener had the waterfall;
        # it is applied when they finish.
        self._view_deferred = False
        # The scan is sweeping (or about to): it owns the waterfall. A scan
        # still waiting for its turn (SCAN_MIN_INTERVAL_S) doesn't hold up a view.
        self._sweeping = False
        # The newest scan request's id; a running scan answers under it.
        self._scan_id: int | None = None
        # The last sweep's answer, (monotonic time, target, state, payload),
        # repeated to requests within SCAN_MIN_INTERVAL_S while this receiver
        # connection lasts. A new connection waits out the interval instead
        # (SweepTimes) and sweeps again.
        self._last_sweep: tuple[float, Target, str, dict[str, Any]] | None = None
        # The decoder the browser asked for, (mode, mark Hz from the dial or
        # None for automatic, reverse), or None. Kept across receivers.
        self._decode: tuple[str, float | None, bool] | None = None
        # The running decoder, built for the pump's sample rate and mode.
        self._decoder: RttyDecoder | None = None
        # Decoded text not sent yet, and when the last batch went (monotonic).
        self._decoded_pending = ""
        self._decoded_at = 0.0
        # The last decode state sent, so changes go out once.
        self._decode_sent: dict[str, Any] | None = None
        # Why the decoder couldn't be built, until the next decode reply says so.
        self._decode_error: str | None = None

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
            elif kind == "view":
                await self._set_view(msg)
            elif kind == "decode":
                await self._set_decode(msg)
            else:
                # Echo only a short string type: never repr() a list or object whole.
                shown = f" {kind[:40]!r}" if isinstance(kind, str) else ""
                raise BadRequest(f"Unknown message type{shown}.")
        except BadRequest as e:
            if e.log_code is not None:
                self._log_refused(e.host, e.port, e.log_code, detail=e.detail)
            await self._status("error", message=str(e), code=e.code, host=e.host, port=e.port)
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
            elif kind == "view":
                await self._view_reply("error", message="The waterfall broke. Check the radio service's logs.")
            elif kind == "decode":
                self._decode = None
                self._decoder = None
                await self._decode_reply("error", message="The decoder broke. Check the radio service's logs.")
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
        # A page that lists "skywave_cap" in `codes` knows that code; an older
        # one (a tab left open) gets "busy" for our cap, as before (#144).
        # Likewise "skywave_full" (#146): an older page gets it uncoded.
        codes = msg.get("codes")
        knows_cap = isinstance(codes, list) and "skywave_cap" in codes
        knows_full = isinstance(codes, list) and "skywave_full" in codes
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
        if msg.get("retune") is True and not same_receiver:
            # A dial move only ever retunes what plays: one that arrives after
            # its session ended (the time limit, a receiver drop) must not open
            # a new Kiwi channel nobody clicked Listen for. That ending's status
            # already went out and settled the page, so nothing more is owed,
            # unless another receiver plays now: then say where that stands.
            if self._pump_owns_receiver():
                await self._status("listening" if self._listening else "connecting")
            return
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
            if msg.get("retune") is not True:
                # A Listen on the receiver already playing: the name it carries
                # (perhaps edited since, or cleared) is the one to show now.
                if not await self._rename(listener_ident(msg.get("ident"), self.settings.ident)):
                    return
            moved = freq != self._freq_khz or mode != self._mode
            freq_moved = freq != self._freq_khz
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
            had_decode = moved and self._decode is not None
            if had_decode:
                # A new mode only moves the search range and CW's offset (the
                # mark is from the dial, so it still holds); a new frequency
                # puts the signal elsewhere.
                if freq_moved:
                    self._forget_mark()
                await self._flush_decoded()
                self._start_decoder()
            if self._listening:
                await self._status("listening")
                if had_decode:
                    await self._decode_reply()
            return

        receiver = (host, port)
        current = self._lease
        if (
            knows_cap
            and self._pump_owns_receiver()
            and self._slots.receiver_full(receiver)
            and not (current is not None and current.receiver == receiver)
        ):
            # A switch onto a receiver at our own cap, from a page that knows
            # skywave_cap: refused before anything changes, so the station
            # playing keeps playing on its frequency (owner D5, #144). One
            # "refused" message says so, then the session's own status answers
            # the tune as usual. An error status followed by that status would
            # be merged into one render on the page and lost (owner D8). An
            # older page gets the old order below: stop, then "busy".
            await self._refuse_switch(self._receiver_full(host, port, knows_cap))
            return

        if self._freq_khz and freq != self._freq_khz:
            # Another receiver on another frequency: same rule as a retune. (A
            # mark set before the first Listen is for that Listen: kept.)
            self._forget_mark()
        self._freq_khz = freq

        # Keep the slot the old pump holds: its done callback then releases nothing.
        old_holder = self._slot_holder
        lease = self._lease
        handing_over = old_holder is not None and lease is not None
        self._slot_holder = None
        self._lease = None
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
                old_holder.add_done_callback(lambda _: self._slots.release(lease))
            raise
        # Checked once the old pump has closed its Kiwi, like the overall limit:
        # a refusal ends the old session too, the same as a busy Kiwi would.
        blocked = self.settings.blocked_receivers
        if (host.rstrip("."), port) in blocked or (host.rstrip("."), None) in blocked:
            if handing_over:
                self._slots.release(lease)
            # Coded, so Pick best moves on to another receiver.
            raise BadRequest(
                f"{host}'s owner has asked Skywave not to use it. Try another receiver.",
                code="blocked",
                host=host,
                port=port,
            )
        if handing_over:
            if not self._slots.move(lease, receiver):
                self._slots.release(lease)
                raise self._receiver_full(host, port, knows_cap)
        else:
            taken = self._slots.acquire(receiver, self._owner)
            if taken == "receiver":
                raise self._receiver_full(host, port, knows_cap)
            if taken == "owner":
                n = self._slots.per_owner
                raise BadRequest(
                    f"You already have {n} radio{'' if n == 1 else 's'} playing (another tab?), "
                    "the most Skywave plays for one connection. Stop one to listen here."
                )
            if isinstance(taken, str):
                # Logged as skywave_full for every page, so the load report can
                # count the refused tunes (#146). A page from before that code
                # would read it as a receiver's answer and move Pick best on, so
                # it gets the old uncoded error.
                raise BadRequest(
                    "Skywave is full right now. Each listener uses a channel on a volunteer's "
                    "receiver, so Skywave keeps the number small. Try again in a few minutes.",
                    code="skywave_full" if knows_full else None,
                    host=host,
                    port=port,
                    detail=f"max_sessions={self._slots.limit}",
                    log_code="skywave_full",
                )
            lease = taken
        self._lease = lease
        self._mode = mode
        self._target = target
        self._ending_target = None
        self._ident = listener_ident(msg.get("ident"), self.settings.ident)
        self._pump = self._slot_holder = asyncio.create_task(
            self._run(host, port, public_only=public_only, secure=secure), name=f"{host}:{port}"
        )
        self.idle_since = None
        # A done callback, not a finally in _run: a task cancelled before it
        # first runs never enters its body.
        self._pump.add_done_callback(self._pump_done)
        self._pump.add_done_callback(self._mark_idle)

    def _log_receiver(
        self,
        event: str,
        host: object,
        port: object,
        *,
        code: str | None = None,
        detail: str | None = None,
        audio_s: float = 0.0,
        suppressed: int = 0,
    ) -> None:
        """One receiver_log line (see there); `suppressed` adds how many like it were dropped."""
        receiver_log.info(
            "event=%s host=%s port=%s code=%s detail=%s audio_s=%.1f listeners=%d%s",
            event,
            MANY_RECEIVERS if host is MANY_RECEIVERS else loggable_host(host),
            port if isinstance(port, int) and not isinstance(port, bool) else "-",
            code or "-",
            detail or "-",
            audio_s,
            self._slots.active,
            f" suppressed={suppressed}" if suppressed else "",
        )

    def _log_refused(
        self, host: object, port: object, code: str, *, detail: str | None = None, event: str = "refused"
    ) -> None:
        """A receiver_log line for a refusal that dialed no Kiwi (ours, or a
        lookup's), at most once per REFUSED_LOG_INTERVAL_S for the same
        receiver, code and event; flush_refused_counts() writes what's left at close."""
        which = (loggable_host(host), port, code, event)
        if which not in self._refused_logged and len(self._refused_logged) >= REFUSED_LOG_KEYS:
            which = (MANY_RECEIVERS, None, code, event)
            host, port = MANY_RECEIVERS, None
        now = time.monotonic()
        last = self._refused_logged.get(which)
        if last is not None and now - last[0] < REFUSED_LOG_INTERVAL_S:
            self._refused_logged[which] = (last[0], last[1] + 1)
            return
        dropped = last[1] if last is not None else 0
        self._refused_logged[which] = (now, 0)
        self._log_receiver(event, host, port, code=code, detail=detail, suppressed=dropped)

    def flush_refused_counts(self) -> None:
        """Write the refusals still held back by the throttle, so a session
        that ends mid-burst doesn't lose them from the receiver log."""
        for (host, port, code, event), (_, dropped) in self._refused_logged.items():
            if dropped:
                self._log_receiver(event, host, port, code=code, detail="throttled", suppressed=dropped)
        self._refused_logged.clear()

    async def _refuse_switch(self, e: BadRequest) -> None:
        """Refuse a switch while this session's receiver keeps playing: a
        "refused" message naming both receivers, then the session's own status."""
        assert self._target is not None
        still_host, still_port = self._target[0], self._target[1]
        assert e.code is not None
        self._log_refused(e.host, e.port, e.code, detail=e.detail)
        await self._send_text(
            {
                "type": "refused",
                "host": e.host,
                "port": e.port,
                "code": e.code,
                "message": str(e),
                "stillOn": {"host": still_host, "port": still_port},
            }
        )
        await self._status("listening" if self._listening else "connecting")

    def _receiver_full(self, host: str, port: int, knows_cap: bool) -> BadRequest:
        # Its own code, not "busy" (#144): the receiver itself may have room, and
        # Pick best moves on without spending one of its tries. A page from
        # before that code would read it as our own failure and stop Pick best,
        # so it gets "busy" (one try spent, as before); the log says which.
        n = self._slots.per_receiver
        return BadRequest(
            f"{host} already has {n} Skywave listener{'' if n == 1 else 's'}, the most Skywave puts on "
            "one volunteer's receiver. Try another receiver.",
            code="skywave_cap" if knows_cap else "busy",
            host=host,
            port=port,
            detail=f"skywave_cap={n}",
        )

    def _pump_done(self, pump: asyncio.Task[None]) -> None:
        if pump is self._slot_holder:
            self._slot_holder = None
            lease, self._lease = self._lease, None
            self._slots.release(lease)

    def _mark_idle(self, pump: asyncio.Task[None]) -> None:
        # A pump replaced by a switch is no longer self._pump: the new one plays.
        if pump is self._pump:
            self.idle_since = time.monotonic()

    async def _rename(self, ident: str) -> bool:
        """Show `ident` for this listener on the receiver playing: the audio and
        any waterfall on its channel. False when the audio's connection is gone
        (its pump reports that). A waterfall that fails is left to its own
        error handling: the name matters less than the scan or view."""
        if ident == self._ident:
            return True
        self._ident = ident
        client = self._client
        if client is not None:
            try:
                await client.rename(ident)
            except KiwiError:
                return False
        for waterfall in (self._waterfall, self._connecting):
            if waterfall is not None:
                try:
                    await waterfall.rename(ident)
                except KiwiError:
                    pass
        return True

    async def _run(self, host: str, port: int, *, public_only: bool = False, secure: bool = False) -> None:
        await self._status("connecting", host=host)
        # How this pump ended, for the browser. Sent only once its Kiwi sockets
        # are closed and its slot is free, so a reconnect on "Stopped" or an
        # error finds the slot available.
        ending: dict[str, Any] | None = None
        # Seconds of the receiver's audio sent to the browser, for the receiver log.
        audio_s = 0.0
        # Cancelled (a Stop, a switch): a teardown error is logged, never raised
        # in place of the cancel, which would turn a switch into "Something broke".
        cancelled = False
        try:
            allow_private = self.settings.allow_private_hosts and not public_only
            ip = await self._resolver(host, port, allow_private=allow_private, owner=self.lookup_owner)
            client = self._client_factory(
                host,
                port,
                connect_host=ip,
                secure=secure,
                # Read now, not when the pump started: a Listen during the
                # lookup may have renamed it.
                user=self._ident,
                kiwi_agc=self.settings.kiwi_agc,
            )
            self._client = client
            await client.tune(kiwi_freq_khz(self._freq_khz, self._mode))
            info = await client.connect()
            assert info.sample_rate is not None
            self._demod = Demodulator(info.sample_rate, self._mode)
            self._spectrum = Spectrum(info.sample_rate)
            self._listening = True
            self._start_decoder()
            await self._status("listening")
            self._log_receiver("listening", host, port)
            if self._decode is not None or self._decode_error is not None:
                await self._decode_reply()

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
                        if block.adc_overflow:
                            self._overflow_at = time.monotonic()
                        audio = self._demod.process(block.samples)
                        await self._send_bytes(AUDIO_TAG + encode_audio(audio))
                        audio_s += block.samples.size / info.sample_rate
                        if self._decoder is not None:
                            await self._feed_decoder(block.samples)
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
            # Throttled like our own refusals: a lookup dials no Kiwi, so a page
            # looping dead names could otherwise flood the receiver log.
            self._log_refused(host, port, e.code or "service", event="error")
            ending = self._status_payload("error", message=str(e), code=e.code, retryAfterMs=e.retry_after_ms)
        except KiwiError as e:
            if (current := asyncio.current_task()) is not None and current.cancelling():
                log.info("%s ended as the session was cancelled: %r", host, e)
                # A Stop or switch's cancel that a call turned into its own error
                # (a send to the Kiwi raising "closed"): it's still that cancel,
                # not the receiver failing, so no error goes to the listener.
                cancelled = True
                raise asyncio.CancelledError from e
            self._log_receiver("error", host, port, code=e.code, detail=e.detail, audio_s=audio_s)
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
            # The listener gets "Something broke"; the receiver log names the class only.
            self._log_receiver("error", host, port, code="service", detail=type(e).__name__, audio_s=audio_s)
            ending = self._status_payload("error", message="Something broke in the radio service. Check its logs.")
        finally:
            self._listening = False
            self._decoder = None
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
        # Text decoded in the last moments goes before the ending's status.
        await self._flush_decoded()
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
        await self._flush_decoded()
        if message:
            await self._status("stopped", message=message)

    async def close(self) -> None:
        await self.stop(None)
        self.flush_refused_counts()

    async def _set_decode(self, msg: dict[str, Any]) -> None:
        mode, mark, reverse = msg.get("mode"), msg.get("markHz"), msg.get("reverse", False)
        # Whatever the old decoder found still goes out (a Reverse toggle
        # rebuilds it); the browser ignores it if this turns decoding off.
        await self._flush_decoded()
        if mode is None:
            self._decode = None
            self._start_decoder()
            await self._decode_reply()
            return
        if (
            mode not in DECODE_MODES
            or not (mark is None or (isinstance(mark, (int, float)) and not isinstance(mark, bool)))
            # Also refuses NaN and infinity, which Python's JSON reads.
            or (mark is not None and not abs(mark) <= MAX_MARK_HZ)
            or not isinstance(reverse, bool)
        ):
            # Answered as a decode error, never a status one: the audio is fine.
            self._decode = None
            self._start_decoder()
            await self._decode_reply("error", message="That isn't a decoder this service can run.")
            return
        self._decode = (mode, None if mark is None else float(mark), reverse)
        self._start_decoder()
        await self._decode_reply()

    def _forget_mark(self) -> None:
        """The signal sits somewhere else now: a mark set for the old frequency
        means nothing here, so the decoder looks for the pair again."""
        if self._decode is not None:
            dmode, _, reverse = self._decode
            self._decode = (dmode, None, reverse)

    def _start_decoder(self) -> None:
        """(Re)build the decoder for what the browser asked and what plays now."""
        self._decoder = None
        self._decode_sent = None
        client = self._client
        if self._decode is None or not self._listening or client is None or not client.info.sample_rate:
            return
        _, mark, reverse = self._decode
        # Baseband is the Kiwi's tuning, which sits CW_PITCH_HZ under the dial in CW.
        shift = (self._freq_khz - kiwi_freq_khz(self._freq_khz, self._mode)) * 1000
        try:
            self._decoder = RttyDecoder(
                client.info.sample_rate,
                mark_hz=None if mark is None else mark + shift,
                reverse=reverse,
                search=PASSBANDS[self._mode],  # type: ignore[index]
            )
        except Exception:
            # Like a failure while decoding: never let it reach the pump and
            # end the audio. The next decode reply says it's off.
            log.exception("building the %s decoder failed; turning it off", self._decode[0])
            self._decode = None
            self._decode_error = "The decoder couldn't start and was turned off. The audio plays on."

    def _decode_state(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": "decode", "mode": None, "state": "off"}
        if self._decode is None:
            return payload
        mode, mark, reverse = self._decode
        payload.update(mode=mode, reverse=reverse, state="searching")
        decoder = self._decoder
        if decoder is not None and decoder.mark_hz is not None:
            shift = (self._freq_khz - kiwi_freq_khz(self._freq_khz, self._mode)) * 1000
            payload["markHz"] = round(decoder.mark_hz - shift, 1)
            if decoder.squelch_open:
                payload["state"] = "locked"
        elif mark is not None:
            payload["markHz"] = mark
        return payload

    async def _decode_reply(self, state: str | None = None, **extra: Any) -> None:
        payload = self._decode_state()
        error, self._decode_error = self._decode_error, None
        if state is None and error is not None:
            state, extra = "error", {**extra, "message": error}
        if state is not None:
            payload["state"] = state
        payload.update({k: v for k, v in extra.items() if v is not None})
        self._decode_sent = payload
        await self._send_text(payload)

    async def _feed_decoder(self, samples: Any) -> None:
        decoder = self._decoder
        assert decoder is not None and self._decode is not None
        try:
            text = decoder.process(samples)
        except Exception:
            # A decoder bug must never end the audio: turn it off and say so.
            log.exception("the %s decoder failed; turning it off", self._decode[0])
            self._decode = None
            self._decoder = None
            await self._decode_reply("error", message="The decoder broke and was turned off. The audio plays on.")
            return
        self._decoded_pending += text
        state = self._decode_state()
        if state != self._decode_sent:
            self._decode_sent = state
            await self._send_text(state)
        now = time.monotonic()
        if self._decoded_pending and now - self._decoded_at >= DECODED_INTERVAL_S:
            text, self._decoded_pending = self._decoded_pending, ""
            self._decoded_at = now
            await self._send_text(
                {"type": "decoded", "mode": self._decode[0], "text": text, "atMs": int(time.time() * 1000)}
            )

    async def _flush_decoded(self) -> None:
        """Send decoded text still waiting for its batch: called before the
        decoder is rebuilt or dropped, so the last characters aren't lost."""
        text, self._decoded_pending = self._decoded_pending, ""
        if not text:
            return
        self._decoded_at = time.monotonic()
        try:
            await self._send_text({"type": "decoded", "mode": "rtty", "text": text, "atMs": int(time.time() * 1000)})
        except Exception:
            # The browser went away; like _send_status, nothing more to do.
            pass

    async def _start_scan(self, msg: dict[str, Any]) -> None:
        scan_id = msg.get("id")
        if not isinstance(scan_id, int) or isinstance(scan_id, bool):
            scan_id = None
        target, client = self._target, self._client
        if not self._listening or target is None or client is None:
            await self._scan_reply(scan_id, target, "error", message="Start listening to a receiver first.")
            return
        self._scan_id = scan_id
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
        cached = None if fresh else self._scan_cache.get(target)
        if isinstance(cached, str):
            await self._finish(target, "error", message=cached)
            return
        if cached is not None:
            await self._finish(target, "done", **scan_payload(cached))
            return
        last = self._last_sweep
        if last is not None and last[1] == target and time.monotonic() - last[0] < SCAN_MIN_INTERVAL_S:
            await self._finish(target, last[2], **last[3])
            return
        await self._scan_reply(self._scan_id, target, "scanning")
        # No await between the last check and start(), so listeners sharing
        # an IP queue up one sweep at a time.
        key = (self.lookup_owner, target)
        while (wait := self._sweep_times.wait_s(key)) > 0:
            await asyncio.sleep(wait)
        if self._client is not client:
            return  # the connection ended while it waited: don't use up the sweep slot
        self._sweep_times.start(key)
        self._sweeping = True
        opening = self._view_open
        if opening is not None and not opening.done():
            # The view is opening the paired waterfall: sweep on that one, not
            # a second. Waited for, never cancelled: cancelling a half-open one
            # closes it, which can end the audio.
            await asyncio.wait({opening})
        try:
            waterfall = await self._paired_waterfall(client)
            result = await sweep(
                waterfall.frame,
                waterfall.info.freq_offset_khz,
                waterfall.bandwidth_khz,
                on_frame=partial(self._sample_noise, target, waterfall),
            )
        except KiwiError as e:
            if self._client is not client:
                return  # this connection ended; its teardown owns the waterfall
            if self._waterfall is not None and self._waterfall.is_open:
                # Still paired with the audio: closing it would end the
                # listener's audio over a scan problem. Keep it drained; idle
                # closes it if it turns out to be dead.
                self._idle_waterfall()
            else:
                await self._drop_waterfall()
            message = f"Couldn't scan this receiver: {e}"
            # Only while still on this receiver: a scan cut short by the
            # listener leaving (or the receiver dropping them) proves nothing.
            if e.code in SCAN_REFUSALS and self._target == target:
                self._scan_cache.put(target, message, SCAN_REFUSAL_CACHE_S)
            await self._swept(target, "error", message=message)
            return
        except Exception:
            log.exception("scan crashed")
            if self._client is not client:
                return
            # Keep any waterfall drained: a dropped one takes the audio with it.
            self._idle_waterfall()
            await self._swept(target, "error", message="The scan broke. Check the radio service's logs.")
            return
        if self._client is not client:
            # The connection ended mid-sweep: no answer about a receiver we
            # left, and nothing cached or idled against the next one.
            return
        self._idle_waterfall()
        if result.bands_done == 0 and result.bands_total > 0:
            # Not one frame came back: "no strong signals" would be a claim
            # the scan can't make.
            await self._swept(target, "error", message="Couldn't scan this receiver: it didn't send its waterfall.")
            return
        result = replace(result, at_ms=int(time.time() * 1000))
        # A partial sweep (a stalled or slow receiver) isn't kept: shared for
        # 10 minutes it would stand in for a full scan for every listener.
        if not result.partial:
            self._scan_cache.put(target, result)
        await self._swept(target, "done", **scan_payload(result))

    async def _swept(self, target: Target, state: str, **extra: Any) -> None:
        """Answer a sweep that ran, remembering the answer for SCAN_MIN_INTERVAL_S."""
        self._last_sweep = (time.monotonic(), target, state, extra)
        await self._finish(target, state, **extra)

    async def _finish(self, target: Target, state: str, **extra: Any) -> None:
        """The scan's last reply, under the newest request's id.

        The scan stops counting as running first, so a request arriving while
        this reply is sent starts a new scan instead of waiting on this one.
        """
        if self._scan is asyncio.current_task():
            self._scan = None
            self._sweeping = False
        await self._scan_reply(self._scan_id, target, state, **extra)
        await self._apply_deferred_view()

    def _idle_waterfall(self) -> None:
        if self._waterfall is not None and (self._waterfall_idle is None or self._waterfall_idle.done()):
            # The reader points the current view as it starts, so nothing waits.
            self._point(self._waterfall)
            self._view_deferred = False
            name = f"{self._target[0]}:{self._target[1]}" if self._target is not None else None
            self._waterfall_idle = asyncio.create_task(self._idle(self._waterfall), name=name)

    # --- Live wide view ---

    async def _set_view(self, msg: dict[str, Any]) -> None:
        zoom, view_id, cf = msg.get("zoom"), msg.get("id"), msg.get("cfKhz")
        valid_id = isinstance(view_id, int) and not isinstance(view_id, bool) and 0 <= view_id <= MAX_VIEW_ID
        if zoom is None:
            self._view = None
        elif (
            not valid_id
            or not isinstance(zoom, int)
            or isinstance(zoom, bool)
            or not 0 <= zoom <= MAX_ZOOM
            or not isinstance(cf, (int, float))
            or isinstance(cf, bool)
            # Also refuses NaN and infinity, which Python's JSON reads.
            or not 0 < cf <= MAX_FREQ_KHZ
        ):
            # Answered as a view error, never a status one: the audio is fine.
            # Whatever streamed before stops: the browser has moved on from it.
            self._view = None
            await self._apply_view()
            await self._view_reply(
                "error",
                view_id=view_id if valid_id else None,
                message="That waterfall view isn't one this service can show.",
            )
            return
        else:
            self._view = (view_id, zoom, float(cf))
        await self._apply_view()

    async def _apply_view(self) -> None:
        """Point the paired waterfall at the view asked for, opening it if need be."""
        client = self._client
        if not self._listening or client is None:
            return  # the browser asks again once a receiver is playing
        if self._sweep_owns_waterfall() or (self._view_open is not None and not self._view_open.done()):
            # A sweep or the opener has the waterfall; applied when it's done.
            self._view_deferred = True
            return
        waterfall = self._waterfall
        if waterfall is None:
            if self._view is not None:
                name = f"{client.host}:{client.port}"
                self._view_open = asyncio.create_task(self._open_view(client), name=name)
            return
        if waterfall.refusal is not None:
            if self._view is not None:
                await self._view_reply("error", message=f"Couldn't show this receiver's waterfall: {waterfall.refusal}")
            return
        if self._view is not None:
            try:
                await waterfall.ready()
            except KiwiError as e:
                await self._view_reply("error", message=f"Couldn't show this receiver's waterfall: {e}")
                return
            if self._client is not client or self._waterfall is not waterfall:
                return  # the connection ended, or the waterfall went, meanwhile
            if self._sweep_owns_waterfall():
                self._view_deferred = True  # a sweep started meanwhile
                return
        if self._waterfall_idle is None or self._waterfall_idle.done():
            self._idle_waterfall()  # its reader points the view as it starts
            return
        self._point(waterfall)
        try:
            await waterfall.show(waterfall.view)
        except KiwiError:
            pass  # gone: the reader sees it and the audio pump reports it

    def _sweep_owns_waterfall(self) -> bool:
        return self._sweeping and self._scan is not None and not self._scan.done()

    async def _apply_deferred_view(self) -> None:
        if self._view_deferred:
            self._view_deferred = False
            await self._apply_view()

    def _point(self, waterfall: WaterfallClient) -> None:
        """Set the waterfall's view to the one asked for, at its own offset and coverage."""
        if self._view is None:
            waterfall.view = None
            return
        view_id, zoom, rf_khz = self._view
        waterfall.view = View(zoom, waterfall.centre(zoom, rf_khz))
        waterfall.on_frame = partial(self._forward_view, waterfall, view_id)

    def _sample_noise(self, target: Target | None, waterfall: WaterfallClient, frame: WaterfallFrame) -> None:
        """Offer a frame we already have to the noise sampler; never raises."""
        if self._noise is None or target is None:
            return
        try:
            self._noise.offer(
                f"{target[0]}:{target[1]}",
                frame,
                waterfall.info.freq_offset_khz,
                overflow=time.monotonic() - self._overflow_at < OVERFLOW_HOLD_S,
            )
        except Exception:
            # A sampling bug must not cost a listener their scan or view.
            log.exception("noise sampling failed")

    def _forward_view(self, waterfall: WaterfallClient, view_id: int, frame: WaterfallFrame) -> None:
        self._sample_noise(self._target, waterfall, frame)
        if self._view_send is not None and not self._view_send.done():
            return  # the browser is still taking the last one
        start_khz = waterfall.info.freq_offset_khz + frame.start_khz
        data = VIEW_TAG + struct.pack("<Iff", view_id, start_khz, frame.span_khz) + frame.bins.tobytes()
        self._view_send = asyncio.create_task(self._send_view(data))

    async def _send_view(self, data: bytes) -> None:
        try:
            await self._send_bytes(data)
        except Exception:
            # The browser went away or stalled (the server closes it then).
            pass

    async def _open_view(self, client: KiwiClient) -> None:
        try:
            await self._open_view_waterfall(client)
        finally:
            if self._view_open is asyncio.current_task():
                self._view_open = None
        if self._client is client:
            await self._apply_deferred_view()

    async def _open_view_waterfall(self, client: KiwiClient) -> None:
        try:
            await self._paired_waterfall(client, fast=False)
        except KiwiError as e:
            if self._client is not client:
                return  # this connection ended; its teardown owns the waterfall
            # As after a failed sweep: one still open may carry the audio.
            if self._waterfall is not None and self._waterfall.is_open:
                self._idle_waterfall()
            else:
                await self._drop_waterfall()
            if self._view is not None:
                await self._view_reply("error", message=f"Couldn't show this receiver's waterfall: {e}")
            return
        except Exception:
            log.exception("opening the view's waterfall crashed")
            if self._client is not client:
                return
            self._idle_waterfall()
            await self._view_reply("error", message="The waterfall broke. Check the radio service's logs.")
            return
        if self._client is client:
            self._idle_waterfall()

    async def _view_reply(self, state: str, *, view_id: int | None = None, **extra: Any) -> None:
        if view_id is None and self._view is not None:
            view_id = self._view[0]
        payload: dict[str, Any] = {"type": "view", "id": view_id, "state": state}
        payload.update(extra)
        try:
            await self._send_text(payload)
        except Exception:
            pass

    async def _paired_waterfall(self, client: KiwiClient, *, fast: bool = True) -> WaterfallClient:
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
            if not fast:
                return kept
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
            # The audio's own name: the waterfall joins its channel, so it is the
            # same listener on the receiver's user list, and a different name here
            # could replace theirs there.
            user=self._ident,
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
        scan, idle, view_open = self._scan, self._waterfall_idle, self._view_open
        if self._view_send is not None:
            self._view_send.cancel()  # a frame for a connection that's ending
            self._view_send = None
        try:
            await self._stop_scan_tasks(scan, idle, view_open)
        except asyncio.CancelledError:
            # Backstop for a caller that cancels this while a scan stops (the
            # pump runs it as its own task and doesn't): that scan may still be
            # closing a half-open waterfall on this channel that only it holds.
            # Let it finish (bounded) before the slot can free.
            # Read any that had already failed: the cut-short stop never did.
            for error in _failures(t for t in (scan, idle, view_open) if t is not None):
                log.warning("a stopped scan task failed: %r", error, exc_info=error)
            stopping = {t for t in (scan, idle, view_open) if t is not None and not t.done()}
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
            self._sweeping = False
            if self._waterfall_idle is idle:
                self._waterfall_idle = None
            if self._view_open is view_open:
                self._view_open = None
            self._view_deferred = False
            self._last_sweep = None
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
        try:
            await self._send_text(payload)
        except Exception:
            # The browser went away; nothing useful to do.
            pass


def scan_payload(result: ScanResult) -> dict[str, Any]:
    return {
        "signals": result.signals,
        "hidden": result.hidden,
        "bandsDone": result.bands_done,
        "bandsTotal": result.bands_total,
        "partial": result.partial,
        "atMs": result.at_ms,
    }
