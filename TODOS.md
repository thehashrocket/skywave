# TODOS

## Radio service

### Retry the old Kiwi path only for a Kiwi that needs it

**What:** Add a single retry on `/<ts>/SND` when `/kiwi/<ts>/SND` gets no reply, but only after a receiver proves it needs one.

**Why:** PR #6 moved to `/kiwi/<ts>/SND` because current firmware ignores the bare path. Every receiver tested on 2026-10-20 answered `/kiwi/`, so there is no fallback. A blind retry would make every dead receiver take 20 s to fail instead of 10 s.

**Context:** Trigger: a live Kiwi fails with "connected but never answered" **and** a probe shows it answers `/<ts>/SND` but not `/kiwi/<ts>/SND`. Without that proof, don't add the retry. The path is built in `KiwiClient.url`, and `connect` raises the timeout (`apps/radio/skywave_radio/kiwi.py`). Note: a leftover host `uvicorn` on `127.0.0.1:8765` once made fixed receivers look broken; check `lsof -nP -iTCP:8765 -sTCP:LISTEN` before blaming the Kiwi.

**Effort:** S
**Priority:** P4
**Depends on:** A receiver that reproduces the failure

## Web app

### Decide what Preset.receiverHost / receiverPort become

**What:** Replace or wire up the unused `receiverHost`/`receiverPort` columns on `Preset` when the receiver map lands.

**Why:** The schema implies presets can be pinned to a receiver, but the UI never sends these fields (`Presets.tsx`), even though the API accepts them (`presets.ts`). Kept as-is on 2026-10-20 to avoid a migration the Receiver table would redo.

**Context:** `apps/web/prisma/schema.prisma:16-17`. The planned `Receiver` table (README "Next steps" 1) probably turns these into a foreign key. Decide then instead of building the free-text version now.

**Effort:** S
**Priority:** P3
**Depends on:** Receiver map / `Receiver` table

### Drop the browser's float32 frame decoding

**What:** Remove the `0x01`/`0x02` branches from `handleBinary` (`apps/web/src/lib/use-radio.ts`) and their test.

**Why:** They exist only so the web app could deploy before the radio service during the switch to compact frames. Once every running radio service sends `0x03`/`0x04`, they are dead code.

**Context:** Added with the int16/uint8 frame change (feat/compact-stream). Safe to remove once no radio service from before that change is deployed anywhere this web app points.

**Effort:** S
**Priority:** P4
**Depends on:** Every radio service deployment on the compact frames

### Keep one audio frame from overrunning the player's buffer

**What:** Make sure no single audio frame is bigger than the browser player's ring buffer: either split large blocks on the radio side, or size `MAX_AUDIO_SAMPLES` to the ring.

**Why:** `MAX_AUDIO_SAMPLES` is 2**18 so the browser accepts anything the radio service can send (a 1 MiB Kiwi frame), but the worklet's ring is `sampleRate * 4` samples (`apps/web/public/worklets/radio-player.js`), 192,000 at 48 kHz. One maximum-size frame overwrites about 70k queued samples: an audible jump, not a held slot. Real frames are about 512 samples.

**Context:** Raised by the Codex adversarial review of feat/stream-hardening. Before that branch there was no cap at all. Splitting on the radio side (`ListenSession._run`, `apps/radio/skywave_radio/session.py`) keeps the two caps in step; keep the comments on `MAX_FRAME_BYTES` and `MAX_AUDIO_SAMPLES` true.

**Effort:** S
**Priority:** P4
**Depends on:** None

### Let Pick best move past a receiver that refuses after audio starts

**What:** Keep Pick best's run open for a short while after "listening", so a `no_apps` refusal in that window moves on to the next receiver with its note.

**Why:** Pick best finishes on "listening" (`apps/web/src/lib/use-pick-best.ts`), but a receiver whose owner allows no apps (`ext_api=0`) plays for about 10 s before it refuses (live probe 2026-10-21: 213 blocks, then `no_apps` at 10.8 s). The list hides these receivers, so Pick best only lands on one when an owner changed the setting since the list was fetched; the listener then sees the right error but has to pick again by hand.

**Context:** Found by the fix/ext-api-receivers /ship review. The window would need to cover about 15 s and must not resume a run the listener has since replaced (the `host`/`port` check on statuses). Test with a status sequence `listening` → `error no_apps` in `use-pick-best.test.ts`.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed

### Find out why some Kiwis send `too_busy=0` ten seconds in

**What:** Work out what `too_busy=0` means and whether `KiwiClient._handle_msg` should treat it as "full".

**Why:** In a 2026-10-21 probe, receivers with free slots sent `too_busy=0` about 10 s after connect, with audio flowing and with or without keepalives, and listeners got "is full (0 channels in use)".

**Completed:** fix/ext-api-receivers (2026-10-21). It's the owner's `ext_api` setting: how many connections may come from anything but the Kiwi's own web page. At 0 the Kiwi plays for about 10 s, sends `too_busy=0` and closes, even if we ignore the message (6 of 6 receivers matched; same owner, g8ure:8076 with `ext_api=4` kept us, g8ure:8071 with 0 kicked us). That was 143 of 873 online receivers. The list now drops `ext_api=0` entries (a missing field stays listed), and `too_busy=0` says the receiver only allows its own web page. Other values now read "N listeners max", which is what the number means in the Kiwi's own client, not channels in use. It gets its own error code, `no_apps`; deploy the web app before the radio service for it, so the list stops offering these receivers first. Pick best's note for it only shows when the refusal comes before audio, which no probed receiver did (see "Let Pick best move past a receiver that refuses after audio starts").

### Send Kiwi keepalives from their own task

**What:** Move `SET keepalive` out of the receive loop in `KiwiClient.blocks()` into a task that runs once a second regardless of what the caller is doing.

**Why:** Keepalives only go out when a SND frame is processed. While the session is stuck sending to a stalled browser (up to `SEND_TIMEOUT_S`, 15 s), none go out, and the Kiwi may drop a healthy receiver.

**Context:** Raised by the Codex adversarial review of feat/stream-hardening.

**Closed without a change (2026-10-21):** measured. With audio flowing and no keepalives, f4kiy.ddns.net:8073 dropped us at 61.3 s and 60.7 s, and wessex.zapto.org:8073 at 61.1 s. With keepalives, wessex stayed connected for the full 150 s. A Kiwi tolerates about 60 s without a keepalive, and the session ends after a 15 s browser stall (`SEND_TIMEOUT_S`), so the stall can't cost us the receiver. Reopen if `SEND_TIMEOUT_S` goes above about 45 s.

### Don't time out a frame that's already queued at the deadline

**What:** When `KiwiClient.blocks()` reaches its deadline, take a frame the socket has already queued before raising "stopped sending audio".

**Why:** Once the window has run out, `blocks()` calls `asyncio.wait_for(self._recv(), 0)`, and Python raises `TimeoutError` even when the coroutine could finish at once (checked on 3.13). A receiver right at the 10% audio floor can be dropped for a frame it sent in time, when our own work (a keepalive send, parsing) used up the last of the window.

**Context:** Found by the Codex structured review of feat/stream-hardening (P2) and deferred so that ship didn't hit its 3-cycle review cap. The wait is in `blocks()` (`apps/radio/skywave_radio/kiwi.py`). One way: on a zero or negative remaining time, try one more `_recv()` with a tiny timeout before raising. Test with a FakeKiwi whose last good frame lands just as the window ends.

**Effort:** S
**Priority:** P2
**Depends on:** None

**Completed:** fix/queued-frame-deadline (2026-10-20). `blocks()` reads with `asyncio.timeout`, so a queued frame is taken; past the deadline only that one frame counts, and it must bring the window up to the floor or the stream times out (an unlimited grace would let a receiver that already missed its window keep trying). Only a frame websockets has already queued counts, and it may have arrived during our own work. The reviews also found and fixed: an overdue status frame was handled before timing out, so an `audio_rate` MSG could make us send to a Kiwi that stopped reading; and the window reset had moved ahead of the keepalive, charging our send time to the receiver's next window. `.gstack/pregate.json` now names the radio test files, since pregate reads its `dependencies` values as literal paths and the old globs selected nothing.

### Halve stream bandwidth with int16 audio

**What:** Send audio frames as int16 (and optionally spectrum rows as uint8 dB) instead of float32.

**Why:** Cuts per-listener bandwidth from 556 kbit/s (measured 2026-10-20, ~250 MB per listening hour) to 238 kbit/s. Matters most for metered/mobile listeners or a higher `MAX_SESSIONS`.

**Context:** Binary frames are built in `ListenSession._run` (`AUDIO_TAG` / `SPECTRUM_TAG`, `apps/radio/skywave_radio/session.py`) and decoded in `handleBinary` (`apps/web/src/lib/use-radio.ts`). Agreed design (eng review 2026-10-20): new tags so old tabs go silent instead of playing noise. `0x03` is int16 LE audio scaled by 32767. `0x04` is a float32 LE `bottom` dB (row 20th percentile minus 20) followed by 512 uint8, dB = bottom + v × 0.5, clamped. The browser keeps decoding `0x01`/`0x02` too, so deploy the web app first for this change. Extend `test_server.py` and the existing `use-radio.test.ts`.

**Effort:** M
**Priority:** P2 (scheduled)
**Depends on:** None

**Completed:** feat/compact-stream (2026-10-20). Measured 556 → 238 kbit/s per listener.

### Harden the stream against broken receivers and bad frames

**What:** Close the edge cases the feat/compact-stream reviews left open: deadlines for receivers that stop sending usable audio, size and range caps in the browser decoder, and two test gaps.

**Why:** Each needs a broken or hostile receiver, a corrupted radio service or rare timing, so none affects working receivers today. But a bad receiver can still hold one of the `MAX_SESSIONS` listener slots for the full session limit, and a bad frame can still stall a tab.

**Context:** All raised by the /ship reviews of feat/compact-stream and deferred on 2026-10-20 so the PR could land:
- `KiwiClient.blocks()` (`apps/radio/skywave_radio/kiwi.py`) restarts its timeout on every frame, so a receiver that sends MSG frames but no SND blocks never times out. Track the last SND frame there (this predates the branch).
- The empty-block deadline in `ListenSession._run` (`session.py`) can be dodged with 1-sample blocks. A minimum sample rate (samples per second over a window) would catch that. Also measure it from the last real audio after the sends finish, not before: a 10-15 s browser stall followed by an empty block currently blames a healthy receiver.
- `handleBinary` (`apps/web/src/lib/use-radio.ts`) has no upper bound on an audio frame's size, and checks only that a spectrum row's base is finite, not the decoded values. (Correction from the eng review: a base near the float32 maximum does *not* overflow; it stays huge and finite, and drags the waterfall's floor for minutes.)
- `test_receiver_sending_only_empty_blocks_times_out` would hang until the 60-minute session limit if the deadline regressed. Give it a short `max_session_minutes`. Add a test that the deadline resets after real audio (FakeKiwi sending an empty block every Nth frame).

**Effort:** M
**Priority:** P2
**Depends on:** None

**Completed:** feat/stream-hardening (2026-10-20). One silence deadline in `KiwiClient.blocks()` (10% of each window must be audio; caller time excluded; MSG frames don't count), sends to the Kiwi time out, browser skips audio over 2**18 samples and spectrum rows with values outside ±300 dB in both formats, pytest-timeout guards the suite. The reviews also found and fixed: a status-only receiver skipped the session limit entirely; closing a Kiwi that stopped reading hung in websockets' drain and kept the slot (close is now bounded and aborts); a retune while the ended session closed got no answer; and switching receivers as the tab closed could dial the new receiver for nobody (`stop()` swallowed its caller's cancel).
