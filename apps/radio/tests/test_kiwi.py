import asyncio
import itertools
import ssl
import struct

import numpy as np
import pytest
import trustme
import websockets.asyncio.client
from websockets.asyncio.server import serve

from skywave_radio import kiwi as kiwi_module
from skywave_radio.kiwi import KiwiClient, KiwiError, parse_msg
from skywave_radio.waterfall import WaterfallClient

from .fakekiwi import FakeKiwi


def test_parse_msg_decodes_values():
    assert parse_msg(b"sample_rate=12001.135 down rx_name=My%20Kiwi") == {
        "sample_rate": "12001.135",
        "down": None,
        "rx_name": "My Kiwi",
    }


async def test_handshake_and_iq_stream():
    async with FakeKiwi(tone_hz=1500) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port)
        await client.tune(9535.0)
        info = await client.connect()
        assert info.sample_rate == 12000.0
        blocks = []
        async for b in client.blocks():
            blocks.append(b)
            if len(blocks) == 5:
                break
        await client.close()

    assert kiwi.paths[0].startswith("/kiwi/")
    assert kiwi.paths[0].endswith("/SND")
    assert kiwi.commands[0] == "SET auth t=kiwi p="
    assert "SET AR OK in=12000 out=44100" in kiwi.commands
    assert "SET mod=iq low_cut=-5000 high_cut=5000 freq=9535.000" in kiwi.commands
    assert "SET compression=0" in kiwi.commands
    iq = np.concatenate([b.samples for b in blocks])
    assert iq.dtype == np.complex64
    assert blocks[0].rssi_dbm == pytest.approx(-73.0)
    freq = np.fft.fftfreq(iq.size, 1 / 12000)[np.argmax(np.abs(np.fft.fft(iq)))]
    assert abs(freq - 1500) < 30


@pytest.mark.parametrize(
    "reject,code",
    [
        (b"MSG badp=1", "password"),
        # A second stream under another timestamp: refused, not a password problem.
        (b"MSG badp=5", "busy"),
        (b"MSG down", "down"),
        (b"MSG redirect=http%3A%2F%2Fother.example%3A8073", "redirect"),
    ],
)
async def test_kiwi_refusals_raise_coded_errors(reject, code):
    async with FakeKiwi(reject=reject) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == code
        await client.close()


@pytest.mark.parametrize(
    "reject,code,says",
    [
        (b"MSG too_busy=4", "busy", "is full (4 listeners max)"),
        (b"MSG too_busy", "busy", "is full. Try"),
        (b"MSG too_busy=0", "no_apps", "only lets listeners in through its own web page"),
    ],
)
async def test_too_busy_message_matches_the_reason(reject, code, says):
    # too_busy=0 is a Kiwi that refuses apps (ext_api=0), not a full one.
    async with FakeKiwi(reject=reject) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == code
        assert says in str(e.value)
        await client.close()


async def test_too_busy_while_streaming_ends_with_its_reason():
    # Real ext_api=0 Kiwis send audio for about 10 s before too_busy=0.
    async with FakeKiwi(drop_after=20, last_words=b"MSG too_busy=0") as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        await client.tune(9535)
        await client.connect()
        got = 0
        with pytest.raises(KiwiError) as e:
            async for _ in client.blocks():
                got += 1
        assert got == 20
        assert e.value.code == "no_apps"
        assert "own web page" in str(e.value)
        await client.close()


@pytest.mark.parametrize("rate", ["1e12", "nan", "0"])
async def test_unsupported_sample_rate_refused(rate):
    async with FakeKiwi(sample_rate=rate) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "bad_rate"
        await client.close()


@pytest.mark.parametrize(
    "fake,message",
    [
        (FakeKiwi(silent=True), "connected but never answered"),
        (FakeKiwi(no_rate=True), "never sent its sample rate"),
    ],
)
async def test_handshake_timeout_says_whether_the_kiwi_answered(fake, message):
    async with fake as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "timeout"
        assert message in str(e.value)
        # The audio stream is closed either way: only a paired waterfall stays open.
        assert client._ws is None or client._ws.state.name == "CLOSED"


async def test_stalled_stream_times_out():
    async with FakeKiwi(stall=True) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=1)
        await client.tune(9535.0)
        await client.connect()
        with pytest.raises(KiwiError) as e:
            async for _ in client.blocks():
                pass
        assert e.value.code == "timeout"
        await client.close()


# Value: protects=time the caller spends on a block (a stalled browser) isn't blamed on the receiver; fails_when=the deadline keeps running while the caller holds a block; why_new=a 10-15 s browser stall used to time out a healthy Kiwi; seam=none; no_claim=real WebSocket backpressure timing
async def test_time_spent_by_the_caller_does_not_count_against_the_receiver():
    async with FakeKiwi() as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        await client.tune(9535.0)
        await client.connect()
        seen = 0
        async for _ in client.blocks():
            seen += 1
            if seen == 3:
                await asyncio.sleep(1.0)  # twice timeout_s
            if seen == 20:
                break
        await client.close()


# Value: protects=a Kiwi that stops reading can't block a send forever (no deadline in blocks() runs while one waits); fails_when=_send awaits the socket without a timeout; why_new=sends had no bound; seam=KiwiClient._ws and _send (a stub socket whose send never completes); no_claim=real TCP buffer sizes (a send that never completes stands in for full buffers)
async def test_send_to_a_kiwi_that_stopped_reading_times_out():
    class StuckSocket:
        async def send(self, msg):
            await asyncio.Event().wait()

    client = KiwiClient("kiwi.example", 8073, timeout_s=0.2)
    client._ws = StuckSocket()
    with pytest.raises(KiwiError) as e:
        await client._send("SET keepalive")
    assert e.value.code == "timeout"
    assert "stopped reading" in str(e.value)


def snd(samples: int) -> bytes:
    """A stereo SND frame carrying this many silent I/Q pairs."""
    return b"SND" + struct.pack("<BI", 0x08, 0) + struct.pack(">H", 0) + bytes(10) + bytes(samples * 4)


class QueuedSocket:
    """A Kiwi whose first frame arrives late and the rest are already queued.

    The first keepalive send is slow, standing in for our own work (parsing,
    a send) using up the window. Timeline with streaming_client's 1 s
    window: first frame at 0.5 s, keepalive done at 1.25 s, so every later
    frame is read past the deadline.
    """

    def __init__(self, frames):
        self.frames = iter(frames)
        self.first = True
        self.slow_send = True
        self.sent = []

    async def recv(self):
        if self.first:
            self.first = False
            await asyncio.sleep(0.5)
        return next(self.frames)

    async def send(self, msg):
        self.sent.append(msg)
        # Always yield, so a test's wait_for can still cancel a loop that
        # otherwise never waits (frames are always queued).
        await asyncio.sleep(0.75 if self.slow_send else 0)
        self.slow_send = False


def streaming_client(ws) -> KiwiClient:
    client = KiwiClient("kiwi.example", 8073, timeout_s=1.0)
    client._ws = ws
    client.info.sample_rate = 12000.0  # so a window needs 1200 samples
    return client


# Value: protects=a frame already queued when our own work uses up the window still counts; fails_when=blocks() waits with wait_for(..., 0), which raises without reading the socket; why_new=a receiver at the audio floor was dropped for a frame it sent in time; seam=KiwiClient._ws (a stub socket whose frames are always queued); no_claim=real socket queueing
async def test_frame_queued_at_the_deadline_still_counts():
    # 1000 samples in time, then a queued 500 makes 1500 of the 1200 needed.
    sizes = []
    async for b in streaming_client(QueuedSocket([snd(1000), snd(500)])).blocks():
        sizes.append(b.samples.size)
        if len(sizes) == 2:
            break
    assert sizes == [1000, 500]


# Value: protects=time we spend sending a keepalive isn't taken out of the receiver's next window; fails_when=the window is reset before the keepalive send on the frame that meets the floor; why_new=that order was briefly introduced on this branch and caught in review; seam=KiwiClient._ws (a stub socket with paced frames); no_claim=real send backpressure
async def test_a_slow_keepalive_does_not_shorten_the_next_window():
    class PacedSocket(QueuedSocket):
        async def recv(self):
            delay, frame = next(self.frames)
            await asyncio.sleep(delay)
            return frame

    # The 1200 samples a window needs land at 0.5 s and our keepalive takes
    # until 1.25 s. The next window starts after that send, so the next full
    # window's audio at 1.95 s is in time (it would be late against 1.5 s).
    ws = PacedSocket([(0.5, snd(1200)), (0.7, snd(1200))])
    sizes = []
    async for b in streaming_client(ws).blocks():
        sizes.append(b.samples.size)
        if len(sizes) == 2:
            break
    assert sizes == [1200, 1200]


# Value: protects=a real websockets recv() hands back a frame already queued past the deadline, which the fix relies on; fails_when=a websockets upgrade makes recv() suspend on a queued frame, so asyncio.timeout(0) cancels it; why_new=the queued-frame tests use a stub socket that never suspends; seam=KiwiClient._ws (a real connection with its send slowed); no_claim=a real KiwiSDR's frame pacing
async def test_frame_queued_on_a_real_socket_at_the_deadline_still_counts():
    async def kiwi(ws):
        await asyncio.sleep(0.5)  # the first frame lands mid-window
        await ws.send(snd(1000))
        await ws.send(snd(500))
        await ws.wait_closed()

    async with serve(kiwi, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        ws = await websockets.asyncio.client.connect(f"ws://127.0.0.1:{port}")
        send = ws.send
        first = True

        async def slow_first_send(msg):
            nonlocal first
            if first:
                first = False
                await asyncio.sleep(0.75)  # done at 1.25 s, past the 1 s window
            await send(msg)

        ws.send = slow_first_send
        sizes = []
        async for b in streaming_client(ws).blocks():
            sizes.append(b.samples.size)
            if len(sizes) == 2:
                break
        await ws.close()
    assert sizes == [1000, 500]


# Value: protects=past the deadline only the one frame that completes the window is taken; fails_when=every queued frame past the deadline is read (a plain asyncio.timeout swap), so a receiver that already missed its window gets unlimited tries; why_new=the queued-frame grace needs a bound; seam=KiwiClient._ws (a stub socket whose frames are always queued); no_claim=real socket queueing
async def test_a_queued_frame_that_misses_the_floor_ends_the_stream():
    # 1 sample in time, then queued frames that would refill the window only on the third try.
    frames = itertools.chain([snd(1), snd(1), snd(1)], itertools.repeat(snd(1500)))
    sizes = []

    async def drain():
        async for b in streaming_client(QueuedSocket(frames)).blocks():
            sizes.append(b.samples.size)

    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(drain(), timeout=3)
    assert e.value.code == "timeout"
    assert sizes == [1]


# Value: protects=past the deadline a queued non-audio frame (status MSG or unknown tag) ends the stream, unhandled, rather than buying more time; fails_when=the overdue check is dropped from the non-SND branch, so a Kiwi flooding status frames gets unlimited tries, or runs after _handle_msg, so an overdue audio_rate MSG makes us send to a Kiwi that may have stopped reading; why_new=FakeKiwi's status-only receiver paces its frames, so it only reaches the recv timeout; seam=KiwiClient._ws (a stub socket whose frames are always queued); no_claim=real socket queueing
@pytest.mark.parametrize(
    "filler",
    [b"MSG status=ok", b"MSG audio_rate=12000", b"XYZ"],
    ids=["status MSG", "audio_rate MSG", "unknown tag"],
)
async def test_a_queued_non_audio_frame_past_the_deadline_ends_the_stream(filler):
    # 1 sample in time, then queued filler, then audio that would refill the window.
    frames = itertools.chain([snd(1)], itertools.repeat(filler, 50), itertools.repeat(snd(1500)))
    ws = QueuedSocket(frames)
    sizes = []

    async def drain():
        async for b in streaming_client(ws).blocks():
            sizes.append(b.samples.size)

    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(drain(), timeout=3)
    assert e.value.code == "timeout"
    assert sizes == [1]
    # An overdue MSG isn't handled: answering audio_rate would be a send that
    # a Kiwi which stopped reading could stall, holding the slot.
    assert ws.sent == ["SET keepalive"]


# Value: protects=a Kiwi close that fails with an unexpected error still drops the socket and ends quietly with a log, so the slot never frees over an open channel and a failed goodbye can't crash the session; fails_when=close() skips the abort or re-raises the error; why_new=only the timeout and cancel paths were tested; seam=KiwiClient._ws (a stub socket whose close raises); no_claim=which errors websockets' close can raise
async def test_a_close_that_fails_still_drops_the_socket(caplog):
    aborted = []

    class BrokenClose:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

        async def close(self):
            raise OSError("close broke")

    client = KiwiClient("kiwi.example")
    client._ws = BrokenClose()
    await client.close()  # logs instead of raising
    assert aborted == [True]
    assert client._ws is None
    assert "closing kiwi.example failed: close broke" in caplog.text


# Value: protects=a Kiwi close cancelled partway (the session closing mid-switch) still drops the socket and passes the cancel on; fails_when=the abort branch is narrowed to Exception, which CancelledError skips; why_new=only the timeout and failure paths were tested; seam=KiwiClient._ws (a stub socket whose close hangs); no_claim=real websockets close timing
async def test_a_cancelled_close_still_drops_the_socket():
    aborted = []
    entered = asyncio.Event()

    class HangingClose:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

        async def close(self):
            entered.set()
            await asyncio.Event().wait()

    client = KiwiClient("kiwi.example")
    client._ws = HangingClose()
    closing = asyncio.create_task(client.close())
    await asyncio.wait_for(entered.wait(), timeout=5)
    closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    assert aborted == [True]
    assert client._ws is None


# Value: protects=abort() drops a socket even while a close() is still waiting on it, so session teardown can cut off a stuck scan's waterfall; fails_when=abort() only reaches the open socket, not one a close took; why_new=abort() is new; seam=KiwiClient._ws (a stub socket whose close hangs); no_claim=real websockets close timing
async def test_abort_reaches_a_socket_that_is_still_closing():
    aborted = []
    entered = asyncio.Event()

    class HangingClose:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

        async def close(self):
            entered.set()
            await asyncio.Event().wait()

    client = KiwiClient("kiwi.example")
    client._ws = HangingClose()
    closing = asyncio.create_task(client.close())
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        client.abort()
        assert aborted == [True]
    finally:
        closing.cancel()
        await asyncio.gather(closing, return_exceptions=True)


# Value: protects=abort() drops an open socket, cancels a dial still in progress before any handshake, and stops a dial that hasn't started from dialing at all, so a stuck scan's waterfall never completes a handshake on the Kiwi after its slot is freed; fails_when=abort() only reaches sockets that already exist, lets a dial in progress finish its handshake, or a later dial forgets it; why_new=only the closing case was tested, then round 3b (TODO: abort stops an in-flight dial); seam=kiwi._connect (the dial is held by hand) and KiwiClient._ws; no_claim=real websockets handshake timing
@pytest.mark.parametrize("when", ["open", "dialing", "before"])
async def test_abort_drops_an_open_or_still_dialing_socket(when, monkeypatch):
    aborted = []

    class Socket:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

    client = KiwiClient("kiwi.example")
    if when == "open":
        client._ws = Socket()
        client.abort()
        assert aborted == [True]
        return
    if when == "before":
        dialed = []

        async def instant_connect(*args, **kwargs):
            dialed.append(True)
            return Socket()

        monkeypatch.setattr(kiwi_module, "_connect", instant_connect)
        client.abort()
        with pytest.raises(KiwiError) as e:
            await asyncio.wait_for(client._dial(), timeout=5)
        assert e.value.code == "closed"
        assert dialed == []  # never dialed, so nothing to drop
        assert client._ws is None
        return
    dialing, cancelled = asyncio.Event(), []

    async def held_connect(*args, **kwargs):
        dialing.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(True)
            raise
        return Socket()

    monkeypatch.setattr(kiwi_module, "_connect", held_connect)
    dial = asyncio.create_task(client._dial())
    await asyncio.wait_for(dialing.wait(), timeout=5)
    client.abort()
    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(dial, timeout=5)
    assert e.value.code == "closed"
    assert cancelled == [True]  # the handshake itself was stopped
    assert aborted == []  # no socket ever opened
    assert client._ws is None


# Value: protects=an abort that lands just as the handshake completes (the dial finishes despite the cancel) still drops the new socket, so no Kiwi channel outlives its slot; fails_when=the check after the dial is removed; why_new=coverage audit (round 3b): rewriting the "dialing" case to cover cancellation left this path untested; seam=kiwi._connect (a handshake that finishes anyway when cancelled); no_claim=real websockets timing
async def test_an_abort_landing_as_the_handshake_completes_drops_the_socket(monkeypatch):
    aborted, dialing = [], asyncio.Event()

    class Socket:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

    async def finishes_anyway(*args, **kwargs):
        dialing.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            pass  # the handshake had already finished
        return Socket()

    monkeypatch.setattr(kiwi_module, "_connect", finishes_anyway)
    client = KiwiClient("kiwi.example")
    dial = asyncio.create_task(client._dial())
    await asyncio.wait_for(dialing.wait(), timeout=5)
    client.abort()
    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(dial, timeout=5)
    assert e.value.code == "closed"
    assert aborted == [True]
    assert client._ws is None


# Value: protects=a caller cancelled after its dial already finished (the socket open, the caller not yet resumed) drops that socket rather than orphaning it open on the Kiwi; fails_when=the cancel branch re-raises without looking at the finished dial; why_new=round 3b security review: running the dial as its own task opened this window; seam=kiwi._connect returning at once, the cancel timed between the dial finishing and the caller resuming; no_claim=how often real cancels land there
async def test_a_cancel_after_the_dial_finished_drops_its_socket(monkeypatch):
    aborted = []

    class Socket:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

    async def instant_connect(*args, **kwargs):
        return Socket()

    monkeypatch.setattr(kiwi_module, "_connect", instant_connect)
    client = KiwiClient("kiwi.example")
    caller = asyncio.create_task(client._dial())
    async with asyncio.timeout(5):
        while not (client._dialing is not None and client._dialing.done()):
            await asyncio.sleep(0)
    caller.cancel()  # lands before the caller resumes with the socket
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert aborted == [True]
    assert client._ws is None


# Value: protects=a retune whose send surely failed (the connection closed) leaves the client on the frequency it is still on; fails_when=tune() stores the new frequency before the send succeeds; why_new=round 3b state-machine review; seam=KiwiClient._send_mod raising, _ws set by hand; no_claim=real send failures
async def test_a_failed_tune_keeps_the_old_frequency(monkeypatch):
    client = KiwiClient("kiwi.example")
    client._ws = object()
    client.info.sample_rate = 12000.0
    client.freq_khz = 7200.0

    async def refused():
        raise KiwiError("closed", "kiwi.example closed the connection")

    monkeypatch.setattr(client, "_send_mod", refused)
    with pytest.raises(KiwiError):
        await client.tune(9535.0)
    assert client.freq_khz == 7200.0


# Value: protects=a retune the Kiwi stops reading (the frame may still be queued) gives the connection up, and the reader then ends the session with "stopped reading" rather than going on with tuning the service can't know; fails_when=tune() rolls back and keeps the connection, or the reader reports a generic "closed", or _recv re-raises the stored error (rewriting its cause) or drops the stored error from the fresh one's cause; why_new=owner D1 (round 3b red team: a queued retune could be taken later and garble audio), round 3c (fresh error from _recv); seam=a stand-in socket whose send never finishes and whose recv ends once the transport is aborted; no_claim=real TCP buffering
async def test_a_retune_the_kiwi_stops_reading_ends_the_connection():
    from websockets.exceptions import ConnectionClosedError

    gone = asyncio.Event()

    class Stalled:
        transport = type("Transport", (), {"abort": lambda self: gone.set()})()

        async def send(self, msg):
            await asyncio.Event().wait()

        async def recv(self):
            await gone.wait()
            raise ConnectionClosedError(None, None)

    client = KiwiClient("kiwi.example", timeout_s=0.1)
    client._ws = Stalled()
    client.info.sample_rate = 12000.0
    client.freq_khz = 7200.0
    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(client.tune(9535.0), 5)
    assert e.value.code == "timeout"
    assert gone.is_set()  # given up
    with pytest.raises(KiwiError) as read:
        await asyncio.wait_for(client._recv(), 5)
    assert read.value.code == "timeout" and "stopped reading" in str(read.value)
    assert read.value is not client._broken  # a fresh error: the stored one keeps its own cause
    assert read.value.__cause__ is client._broken  # and the traceback still shows why it was given up


# Value: protects=once a retune gave the connection up, a send (a keepalive, an MSG reply) that hits the dropped socket also raises "stopped reading", so the listener sees the reason whichever call the reader was in; fails_when=_send turns it into a generic "closed"; why_new=round 3b review pass 3 (four reviewers); seam=a stand-in socket whose send raises ConnectionClosed, _broken set by hand; no_claim=which call the reader is in
async def test_a_send_after_the_connection_was_given_up_says_why():
    from websockets.exceptions import ConnectionClosedError

    class Dropped:
        async def send(self, msg):
            raise ConnectionClosedError(None, None)

    client = KiwiClient("kiwi.example")
    client._ws = Dropped()
    client._broken = KiwiError("timeout", "kiwi.example stopped reading")
    with pytest.raises(KiwiError) as e:
        await client._send("SET keepalive")
    assert e.value.code == "timeout" and "stopped reading" in str(e.value)
    assert e.value is not client._broken  # a fresh error: the stored one keeps its own cause
    assert e.value.__cause__ is client._broken  # and the traceback still shows why it was given up


# Value: protects=a retune cancelled while its send is in flight (the browser left) keeps the old frequency and doesn't give the connection up; fails_when=the cancel path takes the timeout branch or keeps the new frequency; why_new=round 3b state machines (send-cancelled x tune); seam=KiwiClient._send_mod held, _ws set by hand; no_claim=real cancel timing
async def test_a_cancelled_retune_keeps_the_old_frequency(monkeypatch):
    client = KiwiClient("kiwi.example")
    client._ws = object()
    client.info.sample_rate = 12000.0
    client.freq_khz = 7200.0
    sending = asyncio.Event()

    async def held():
        sending.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(client, "_send_mod", held)
    retune = asyncio.create_task(client.tune(9535.0))
    await asyncio.wait_for(sending.wait(), 5)
    retune.cancel()
    with pytest.raises(asyncio.CancelledError):
        await retune
    assert client.freq_khz == 7200.0 and client._broken is None


# Value: protects=a cancel aimed at the dialing task itself still propagates as a cancel when abort() also ran, so the caller's cancel handling (a scan closing its half-open waterfall) still runs; fails_when=_dial turns every cancel after abort into KiwiError("closed"); why_new=coverage audit (round 3b); seam=kiwi._connect held; no_claim=real handshake timing
async def test_the_callers_cancel_wins_over_abort_while_dialing(monkeypatch):
    dialing = asyncio.Event()

    async def held_connect(*args, **kwargs):
        dialing.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(kiwi_module, "_connect", held_connect)
    client = KiwiClient("kiwi.example")
    dial = asyncio.create_task(client._dial())
    await asyncio.wait_for(dialing.wait(), timeout=5)
    client.abort()
    dial.cancel()
    with pytest.raises(asyncio.CancelledError):
        await dial


# Value: protects=a connection aborted while its first dial is answered with an https redirect never redials, so an aborted scan waterfall can't open an extra connection to the volunteer's Kiwi; fails_when=connect() redials over https without checking abort; why_new=round 3b (TODO: the https redial after abort); seam=kiwi._connect (a redirect answer, with abort landing during it); no_claim=real redirect timing
async def test_an_aborted_connection_does_not_redial_over_https(monkeypatch):
    from websockets.datastructures import Headers
    from websockets.exceptions import InvalidStatus
    from websockets.http11 import Response

    client = KiwiClient("kiwi.example", 8073)
    calls = []

    async def redirecting_connect(*args, **kwargs):
        calls.append(kwargs.get("port"))
        client.abort()  # the session ends while the Kiwi answers
        raise InvalidStatus(Response(301, "Moved", Headers({"Location": "https://kiwi.example/"})))

    monkeypatch.setattr(kiwi_module, "_connect", redirecting_connect)
    with pytest.raises(KiwiError) as e:
        await asyncio.wait_for(client.connect(), timeout=5)
    assert e.value.code == "closed"
    assert calls == [8073]  # no second, https dial


# Value: protects=a second close() while the first is still saying goodbye waits until the socket is gone, so "close() returned" can't free a slot with the Kiwi channel open; fails_when=close() returns at once whenever _ws is already None; why_new=review (Claude adversarial): close() wasn't re-entrant; seam=KiwiClient._ws (a stand-in socket whose close is held by hand); no_claim=real websockets close timing
async def test_a_second_close_waits_for_the_first():
    closing, gone = asyncio.Event(), asyncio.Event()

    class Socket:
        transport = type("Transport", (), {"abort": lambda self: gone.set()})()

        async def close(self):
            closing.set()
            await gone.wait()

        async def wait_closed(self):
            await gone.wait()

    client = KiwiClient("kiwi.example")
    client._ws = Socket()
    first = asyncio.create_task(client.close())
    tasks = [first]
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)
        second = asyncio.create_task(client.close())
        tasks.append(second)
        await asyncio.sleep(0.05)
        assert not second.done()  # still waiting on the first close
    finally:
        gone.set()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)


# Value: protects=a second close() never waits longer than CLOSE_TIMEOUT_S, even if the socket never reports closed, so a slot can't stay held on the library's word; fails_when=the second caller awaits wait_closed() with no deadline; why_new=review (Codex adversarial): the wait was bounded only by websockets internals; seam=kiwi.CLOSE_TIMEOUT_S shortened, KiwiClient._ws (a socket that never closes); no_claim=real websockets close behavior
async def test_a_second_close_gives_up_on_a_socket_that_never_closes(monkeypatch):
    monkeypatch.setattr(kiwi_module, "CLOSE_TIMEOUT_S", 0.1)
    aborted, closing, never = [], asyncio.Event(), asyncio.Event()

    class Socket:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

        async def close(self):
            closing.set()
            await never.wait()

        async def wait_closed(self):
            await never.wait()

    client = KiwiClient("kiwi.example")
    client._ws = Socket()
    first = asyncio.create_task(client.close())
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)
        await asyncio.wait_for(client.close(), timeout=5)
        assert aborted == [True, True]  # the first close's timeout, then the second caller's own
    finally:
        never.set()
    await asyncio.wait_for(first, timeout=5)


# Value: protects=a second close() cancelled while it waits still drops the socket, like the first close does, so its caller can never move on with the Kiwi channel open; fails_when=the second caller's wait re-raises the cancel without aborting; why_new=review (state matrix: close-while-closing-cancelled); seam=KiwiClient._ws (a socket that never closes); no_claim=real websockets close behavior
async def test_a_cancelled_second_close_still_drops_the_socket():
    aborted, closing, never = [], asyncio.Event(), asyncio.Event()

    class Socket:
        transport = type("Transport", (), {"abort": lambda self: aborted.append(True)})()

        async def close(self):
            closing.set()
            await never.wait()

        async def wait_closed(self):
            await never.wait()

    client = KiwiClient("kiwi.example")
    client._ws = Socket()
    first = asyncio.create_task(client.close())
    try:
        await asyncio.wait_for(closing.wait(), timeout=5)
        second = asyncio.create_task(client.close())
        await asyncio.sleep(0)  # let it start waiting
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await second
        assert aborted == [True]  # the second caller dropped it on its way out
    finally:
        never.set()
    await asyncio.wait_for(first, timeout=5)


# Value: protects=keepalives keep going out while audio streams; fails_when=the keepalive call is lost from blocks() (it moved in this change); why_new=no test streamed past the 1 s keepalive interval and looked at commands; seam=none; no_claim=how long a real Kiwi waits before dropping a silent client
async def test_keepalives_are_sent_while_streaming():
    async with FakeKiwi() as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=1)
        await client.tune(9535.0)
        await client.connect()
        started = asyncio.get_running_loop().time()
        async for _ in client.blocks():
            if asyncio.get_running_loop().time() - started > 2.5:
                break
        await client.close()
    # One is forced at connect; the rest come from blocks(), at most one a second.
    assert kiwi.commands.count("SET keepalive") >= 3


# Value: protects=a receiver that sent real audio and then only empty blocks still times out; fails_when=the audio count isn't cleared when the deadline resets, so one good window keeps every later block resetting it; why_new=server tests' empty receivers never send real audio first; seam=none; no_claim=a real Kiwi's failure pattern (FakeKiwi stands in)
async def test_receiver_that_goes_quiet_after_real_audio_times_out():
    async with FakeKiwi(empty_after=20) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        await client.tune(9535.0)
        await client.connect()
        sizes = []

        async def drain():
            async for b in client.blocks():
                sizes.append(b.samples.size)

        with pytest.raises(KiwiError) as e:
            await asyncio.wait_for(drain(), timeout=5)
        assert e.value.code == "timeout"
        assert sizes[:20] == [512] * 20 and set(sizes[20:]) == {0}
        await client.close()


# Value: protects=a receiver well below real time but above the floor, with dropouts, keeps playing; fails_when=MIN_AUDIO_FRACTION is raised far enough to cut off a slow link; why_new=FakeKiwi streams at 4x, so only the too-lenient side of the floor was tested; seam=none; no_claim=a real congested Kiwi's pacing
async def test_slow_receiver_with_dropouts_keeps_streaming():
    # 128-sample frames at FakeKiwi's fixed pace, every second one empty: about 0.45x real time.
    async with FakeKiwi(block_size=128, empty_every=2) as kiwi:
        client = KiwiClient("127.0.0.1", kiwi.port, timeout_s=0.5)
        await client.tune(9535.0)
        await client.connect()
        started = asyncio.get_running_loop().time()
        async for _ in client.blocks():
            if asyncio.get_running_loop().time() - started > 2.0:  # 4 x timeout_s
                break
        await client.close()


# The dialing rules (hostguard's address, no proxy, one same-host https
# upgrade) are shared by both streams, so these run against each (D9).
@pytest.fixture(params=[KiwiClient, WaterfallClient], ids=["SND", "W/F"])
def client_cls(request):
    return request.param


async def test_unreachable_kiwi_raises(client_cls):
    client = client_cls("127.0.0.1", 9, timeout_s=2)
    with pytest.raises(KiwiError) as e:
        await client.connect()
    assert e.value.code == "unreachable"


async def test_silent_port_gives_a_reason(client_cls):
    # Accepts TCP but never answers the WebSocket upgrade, like a wrong port.
    held = []
    server = await asyncio.start_server(lambda r, w: held.append(w), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        with pytest.raises(KiwiError) as e:
            await client_cls("127.0.0.1", port, timeout_s=0.5).connect()
        assert e.value.code == "unreachable"
        assert "()" not in str(e.value)
        assert "check the port" in str(e.value)
    finally:
        for w in held:
            w.close()
        server.close()


def test_ipv6_hosts_are_bracketed_in_the_url(client_cls):
    client = client_cls("2001:db8::1", 8073)
    assert client.url.startswith("ws://[2001:db8::1]:8073/")
    assert client_cls("kiwi.example", 8073).url.startswith("ws://kiwi.example:8073/")


async def test_an_undialable_url_is_a_coded_error(client_cls, monkeypatch):
    # A bad URL used to escape as a bare ValueError: "Something broke" and no code.
    def bad_url(self):
        return "ws://2001:db8::1:8073/1/SND"  # what an unbracketed IPv6 host used to produce

    monkeypatch.setattr(client_cls, "url", property(bad_url))
    with pytest.raises(KiwiError) as e:
        await client_cls("kiwi.example", 8073, timeout_s=0.5).connect()
    assert e.value.code == "invalid"


def test_secure_clients_dial_wss(client_cls):
    assert client_cls("kiwi.example", 443, secure=True).url.startswith("wss://kiwi.example:443/")


# Value: protects=a copied address in an error message pastes back as a working host:port; fails_when=messages format host:port without brackets; why_new=only the URL was bracketed; seam=none; no_claim=web-side display
async def test_ipv6_addresses_are_bracketed_in_messages(client_cls):
    with pytest.raises(KiwiError) as e:
        await client_cls("::1", 9, timeout_s=2).connect()
    assert e.value.code == "unreachable"
    assert "[::1]:9" in str(e.value)


# Value: protects=only a URL we can't build is "invalid" (which Pick best treats as a free skip); fails_when=connect maps any ValueError to invalid again; why_new=TODOS small edges; seam=none; no_claim=which ValueErrors websockets raises
async def test_a_value_error_while_dialing_is_not_an_address_problem(client_cls, monkeypatch):
    def broken(*args, **kwargs):
        raise ValueError("something inside the handshake")

    monkeypatch.setattr(kiwi_module, "_connect", broken)
    with pytest.raises(ValueError):
        await client_cls("kiwi.example", 8073, timeout_s=0.5).connect()


# Value: protects=the service dials the address hostguard checked even with HTTPS_PROXY set; fails_when=proxy=None is dropped and websockets picks a proxy from the environment; why_new=no test pinned it; seam=none; no_claim=real proxies
async def test_never_dials_through_an_environment_proxy(client_cls, monkeypatch):
    seen = {}

    def capture(url, **kwargs):
        seen.update(kwargs)
        raise OSError("stop here")

    monkeypatch.setattr(kiwi_module, "_connect", capture)
    with pytest.raises(KiwiError):
        await client_cls("kiwi.example", 8073, connect_host="203.0.113.7", timeout_s=0.5).connect()
    assert seen["proxy"] is None
    assert seen["host"] == "203.0.113.7"


@pytest.fixture
def tls(monkeypatch):
    """A CA the client trusts, and a server context for 'kiwi.test' signed by it."""
    ca = trustme.CA()
    trusting = ssl.create_default_context()
    ca.configure_trust(trusting)
    # websockets builds its own default context for wss://; make it this one.
    monkeypatch.setattr(websockets.asyncio.client.ssl_module, "create_default_context", lambda: trusting)

    def server(name="kiwi.test"):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ca.issue_cert(name).configure_cert(ctx)
        return ctx

    return server


# Value: protects=wss checks the certificate against the receiver's name while dialing the checked IP; fails_when=server_hostname follows connect_host or TLS is skipped; why_new=no TLS path existed; seam=websockets default-context factory (test CA); no_claim=public CA trust
async def test_wss_verifies_the_hostname_while_dialing_the_checked_address(client_cls, tls):
    async with FakeKiwi(ssl=tls("kiwi.test")) as kiwi:
        client = client_cls("kiwi.test", kiwi.port, connect_host="127.0.0.1", secure=True, timeout_s=3)
        info = await client.connect()
        if client_cls is KiwiClient:
            assert info.sample_rate == 12000.0
        await client.close()

    async with FakeKiwi(ssl=tls("someone-else.test")) as kiwi:
        client = client_cls("kiwi.test", kiwi.port, connect_host="127.0.0.1", secure=True, timeout_s=3)
        with pytest.raises(KiwiError) as e:
            await client.connect()
        assert e.value.code == "unreachable"


# Value: protects=redirects can't take the service beyond the same host moving to https; fails_when=any Location is followed, or websockets follows same-origin hops itself; why_new=no redirect path existed; seam=HTTPS_PORT (the fake can't bind 443); no_claim=real Kiwis behind nginx
@pytest.mark.parametrize(
    "location,followed",
    [
        ("https://kiwi.test/", True),  # same host, https, default port
        ("https://KIWI.test/", True),
        ("https://evil.test/", False),  # another host
        ("/elsewhere", False),  # same origin, still ws: websockets used to follow these itself
        ("https://kiwi.test:1/", False),  # neither 443 nor the original port
        ("ftp://kiwi.test/", False),
    ],
)
async def test_only_same_host_https_upgrades_are_followed(client_cls, tls, monkeypatch, location, followed):
    async with FakeKiwi(ssl=tls("kiwi.test")) as secure:
        monkeypatch.setattr(kiwi_module, "HTTPS_PORT", secure.port)
        async with FakeKiwi(redirect_to=location) as plain:
            client = client_cls("kiwi.test", plain.port, connect_host="127.0.0.1", timeout_s=3)
            if followed:
                await client.connect()
                assert (client.secure, client.port) == (True, secure.port)
                await client.close()
            else:
                with pytest.raises(KiwiError) as e:
                    await client.connect()
                assert e.value.code == "unreachable"
                assert "redirects to" in str(e.value)
                assert secure.paths == []


async def test_a_second_redirect_is_not_followed(client_cls, tls, monkeypatch):
    async with FakeKiwi(ssl=tls("kiwi.test"), redirect_to="https://kiwi.test/again") as secure:
        monkeypatch.setattr(kiwi_module, "HTTPS_PORT", secure.port)
        async with FakeKiwi(redirect_to="https://kiwi.test/") as plain:
            client = client_cls("kiwi.test", plain.port, connect_host="127.0.0.1", timeout_s=3)
            with pytest.raises(KiwiError) as e:
                await client.connect()
    assert e.value.code == "unreachable"
    assert len(secure.paths) == 1


# Value: protects=connections made in the same second get different URL timestamps, so one listener's scan waterfall can't pair with another listener's audio (review D7); fails_when=the timestamp is int(time.time()) again; why_new=red team (shared timestamp); seam=none; no_claim=how a Kiwi treats colliding timestamps
def test_connections_get_unique_timestamps():
    clients = [KiwiClient("kiwi.example", 8073) for _ in range(3)]
    stamps = [c.timestamp for c in clients]
    assert len(set(stamps)) == 3 and stamps == sorted(stamps)
    assert WaterfallClient("kiwi.example", 8073, timestamp=stamps[0]).timestamp == stamps[0]


# Value: protects=if a dial ever outlives the _dial call that started it (a cancel reaching the caller while the dial still runs), the socket it opens is dropped on arrival instead of staying open on the volunteer's Kiwi, and a late failure or cancel closes nothing and raises nothing (owner decisions D1, D3 and D9, round 3c); fails_when=_dial unwinds without a done callback on a still-pending dial or without asking it to stop, or the callback calls result()/exception() unguarded; why_new=round 3b Codex finding, owner D1 (round 3c): asyncio itself never lets this happen, so the guard is a safety net; seam=asyncio.ensure_future in kiwi swapped for one dial-only future whose await unwinds at once; loop exception handler captured; no_claim=a real event loop producing this order
@pytest.mark.parametrize("late", ["opens", "fails", "cancelled"])
async def test_a_dial_that_outlives_its_caller_drops_its_socket_on_arrival(late, monkeypatch):
    import gc

    from skywave_radio import kiwi as kiwi_module

    class OutlivingDial(asyncio.Future):
        cancel_requested = False

        def __await__(self):
            raise asyncio.CancelledError  # the caller unwinds while this dial runs on
            yield  # pragma: no cover - makes this a generator

        def cancel(self, msg=None):
            # Like a task asked to stop: the request is noted, the dial ends later.
            self.cancel_requested = True
            return True

    dial = OutlivingDial()
    real_ensure_future = asyncio.ensure_future

    def only_the_dial(awaitable, **kwargs):
        if getattr(awaitable, "__qualname__", "") == "wait_for":
            awaitable.close()
            return dial
        return real_ensure_future(awaitable, **kwargs)

    monkeypatch.setattr(kiwi_module.asyncio, "ensure_future", only_the_dial)
    client = KiwiClient("kiwi.example")
    with pytest.raises(asyncio.CancelledError):
        await client._dial()
    monkeypatch.undo()
    assert dial.cancel_requested  # stopped at once, not left to run to its timeout (owner D9)
    loop = asyncio.get_running_loop()
    loop_errors = []
    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    aborted = []

    class Transport:
        def abort(self):
            aborted.append(True)

    class Late:
        transport = Transport()

    try:
        if late == "opens":
            dial.set_result(Late())
        elif late == "fails":
            dial.set_exception(OSError("refused"))
        else:
            asyncio.Future.cancel(dial)
        await asyncio.sleep(0)  # done callbacks run on the next loop step
        del dial
        gc.collect()  # an unread error would be reported now
        assert aborted == ([True] if late == "opens" else [])
        assert loop_errors == []
    finally:
        loop.set_exception_handler(None)
