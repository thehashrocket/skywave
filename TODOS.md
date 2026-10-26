# TODOS

## Radio service

### Revert the web dial when the service refuses a retune

**What:** When a same-receiver retune fails (the service answers with the current "listening" or "connecting" status), move the web app's dial back to the frequency still playing.

**Why:** Since round 3b the service keeps the old frequency after a failed retune and says so, but the page's dial keeps showing the frequency it asked for, so the dial and the audio disagree until the next move.

**Context:** Accepted in the fix/channel-teardown-followups /ship review (2026-10-25). Since round 3d the service also answers any refused message, while a station still holds its receiver, with "error" and then that station's status (owner D1), which carries `freqKhz` and `mode`; the page's uncoded-error handling also clears the scan list then. `apps/web` (`use-radio.ts`, the status handler).

**Effort:** S
**Priority:** P3
**Depends on:** None

### Limit how many Kiwi channels one address can hold

**What:** Decide whether one address may hold several listener slots at once, and if not, add a per-address slot limit (for example `MAX_SESSIONS_PER_IP`) checked where a session takes a slot.

**Why:** `MAX_SOCKETS_PER_IP` caps browser sockets, not Kiwi channels. With the defaults (8 sockets, `MAX_SESSIONS` 2), one person or script with two tabs can hold every listener slot and keep refreshing them, locking everyone else out of listening.

**Context:** Raised by the security review of feat/idle-socket-timeout (2026-10-25); owner chose to decide it separately (D2). Unchanged from before that PR. Trade-off: people sharing one home, office or carrier address would share the limit; count by `socket_owner` (public addresses only, IPv6 by /64) so an untrusted proxy can't lump every listener together. `apps/radio/skywave_radio/session.py` (`Slots.try_acquire`, `_tune`).

**Effort:** S
**Priority:** P3
**Depends on:** Owner's choice of limit and shared-address handling

### Tighten the socket cap's IPv6 grouping and the lookup limit

**What:** Decide how coarsely to group IPv6 for `MAX_SOCKETS_PER_IP` (/64 today; /56 or /48 would stop rotation inside one home or hosting allocation), whether to add an overall socket ceiling, and key hostguard's one-lookup-at-a-time limit (`ListenSession.lookup_owner`) by the same owner as the socket cap.

**Why:** A client with a /56 or /48 can open 8 sockets in each of its /64s, and nothing caps the total. The lookup limit still keys on the exact address, so several addresses in one /64 can run parallel slow lookups and delay receiver resolution for everyone (`MAX_PENDING_LOOKUPS`).

**Context:** Raised by the Claude and Codex adversarial reviews of feat/idle-socket-timeout (2026-10-25); owner chose a TODO (D7). Both predate that PR. Coarser grouping can lump separate customers some ISPs place in one /56. `apps/radio/skywave_radio/server.py` (`socket_owner`), `session.py` (`lookup_owner`), `hostguard.py`.

**Effort:** S
**Priority:** P3
**Depends on:** Owner's choice of grouping and ceiling

### Retry the old Kiwi path only for a Kiwi that needs it

**What:** Add a single retry on `/<ts>/SND` when `/kiwi/<ts>/SND` gets no reply, but only after a receiver proves it needs one.

**Why:** PR #6 moved to `/kiwi/<ts>/SND` because current firmware ignores the bare path. Every receiver tested on 2026-10-20 answered `/kiwi/`, so there is no fallback. A blind retry would make every dead receiver take 20 s to fail instead of 10 s.

**Context:** Trigger: a live Kiwi fails with "connected but never answered" **and** a probe shows it answers `/<ts>/SND` but not `/kiwi/<ts>/SND`. Without that proof, don't add the retry. The path is built in `KiwiClient.url`, and `connect` raises the timeout (`apps/radio/skywave_radio/kiwi.py`). Note: a leftover host `uvicorn` on `127.0.0.1:8765` once made fixed receivers look broken; check `lsof -nP -iTCP:8765 -sTCP:LISTEN` before blaming the Kiwi.

**Effort:** S
**Priority:** P4
**Depends on:** A receiver that reproduces the failure

### Scan the ham bands too

**What:** Extend the band scan to the ham bands in `HAM_BANDS` (`apps/web/src/lib/radio-types.ts`), with results that suit hams: repeated sweeps instead of one snapshot, and a sideband guess for each signal.

**Why:** The scan covers broadcast bands only. Ham voice signals come and go in seconds and sit off any channel grid, so a single snapshot ranks them badly and the list goes stale at once. Covering them would make the list useful on busy contest weekends.

**Context:** Add the bands to `SCAN_BANDS` in `apps/radio/skywave_radio/scan.py` and reuse `find_peaks`; ham peaks need no AM-shape filter or channel snapping. Consider short repeated sweeps that keep only signals seen in most of them, and `guessMode` for the sideband. Keep the 15 s cap (`DEADLINE_S`); more sweeps mean the paired waterfall runs fast for longer.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Count listener slots across processes if the service ever scales out

**What:** Move the listener count out of process memory (or document a single-worker requirement) before running more than one radio service process.

**Why:** `Slots` lives in `app.state` and `/healthz` reports that process's count, so with several workers or replicas `MAX_SESSIONS` stops being a global cap and volunteers' receivers can be overbooked.

**Context:** Raised by Codex in the fix/slot-freed-flake /ship adversarial review (2026-10-23). Today the Dockerfile runs one uvicorn worker (`apps/radio/Dockerfile`), so nothing is wrong yet.

**Effort:** M
**Priority:** P4
**Depends on:** Running more than one radio service process

## Web app

### Pick best follow-ups from the design-pass review

**What:** Finish the refused-receiver memory and the Pick best edges the design-pass /ship reviews listed but didn't fix.

**Why:** Pick best now skips receivers that refused (full, no apps, needs a password) for 15 minutes, which stops it redialing a volunteer's Kiwi that just said no. That memory has gaps that can still knock on the same receiver, and a few nearby edges can take a listener off their station.

**Context:** Approved as follow-ups on 2026-10-23 (branch `feat/design-pass`). In `apps/web/src/lib/use-pick-best.ts` unless noted:
- The memory is a `useRef` in the tab: a reload or another listener redials a receiver that just refused. Persist it (`sessionStorage`), or better, keep a per-receiver refusal memory in the radio service so every listener benefits.
- During a list-mirror outage the page keeps an old copy (can be hours); after `REFUSED_MS` a refused receiver drops out while the stale copy still ranks it first. Keep entries until a fresher list arrives.
- The error link (`app/page.tsx`) shows for any coded error, but only busy/no_apps/password are remembered, so after `dns`/`down` it can redial the same failing receiver first. Decide the retry policy per code.
- `goBack` can redial a fallback receiver that refused while the run was starting; skip one refused within `REFUSED_MS`.
- `start()` failing while a Go Back reconnect is in flight drops its tracking, so a failed go-back never says "Couldn't get back".
- A quick tap to stop a momentum page scroll on the dial retunes the live receiver (`components/Dial.tsx`); consider ignoring taps during or just after a scroll.
- `app/page.tsx` and `ReceiverPicker` both mount `useReceiverList`, so TanStack polls the list twice per cycle; let one observer poll.
- Tests: an `it.each` over every error code asserting only busy/no_apps/password are remembered; `start()` returning false when all refused; the remaining status×action cells.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Receiver map follow-ups from PR 2b review

**What:**
- **Audio that never arrives:** admission waits for first audio while the radio is busy; a service that holds "listening" with no frames keeps the map waiting. Consider a hard cap (say 20 s), which changes the agreed radio-first rule.
- **Worker cache key:** the worker URL is keyed on the maplibre-gl version; a patched or rebuilt package of the same version would pair a cached worker with new page code. Key on a content hash if packages are ever patched.
- **Tile-loading colour:** before tiles arrive the frame is land colour (the design says sea); OpenMapTiles has no land layer, so this needs a land polygon source or a sea background with land drawn from tiles.
- **"Zoom into this area"** doesn't switch follow to stay, so the next listening change pulls the camera away; decide whether it counts as a user move.
- **Stale worker after a MapLibre upgrade:** the worker URL carries the maplibre-gl version and the route 404s any other version. A page open across a deploy that upgrades maplibre-gl, with its map code already loaded, never starts the worker; the map fails through `onFail`, which offers Retry only, and Retry asks for the same 404. Have the route answer 410 for an old version and let ReceiverMap report that as code gone, so the overlay offers Reload page (`gstack-shortcut(dec-3318f2fa)` in `MapPanel.tsx`). Found by the feat/web-follow-ups /ship red team.
- **Slow links:** the worker's shared chunk (~150 KB gzipped) is a second download inside the 30 s budget, alongside live audio; check it's served compressed.

**Why:** Found by the PR 2b /ship review rounds (2026-10-21) and left for after merge; none blocks using the map.

**Context:** `apps/web/src/components/ReceiverMap.tsx`, `MapPanel.tsx`, `apps/web/src/lib/use-map-admission.ts`, `apps/web/src/app/vendor/maplibre/`.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Make repeat list polls cheap

**What:** Let the receiver table's background polls skip the full list when nothing changed: a small `receivers.version` query (fetchedAt/stale only), or `receivers.list` accepting the client's `fetchedAt` and answering `{ unchanged: true }`.

**Why:** Each poll re-downloads the whole list (about 700 receivers) even when the server's copy is the same, which during a mirror outage means a full transfer a minute per open tab.

**Context:** Split from "Keep table rows still while the list refreshes" (PR 2a, 2026-10-21), which shipped the steady rows and skew-proof timing. Polls already back off to the server's retry pace (`LIST_RETRY_MS`), so this is cost, not correctness.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Decide what Preset.receiverHost / receiverPort become

**What:** Wire up the unused `receiverHost`/`receiverPort` columns on `Preset` once there's a button to pin a preset to a receiver.

**Why:** The schema implies presets can be pinned to a receiver, but the UI never sends these fields (`Presets.tsx`), even though the API accepts them (`presets.ts`). Kept as-is on 2026-10-20; the receiver map design settled that `host:port` is a receiver's identity, so no `Receiver` table is coming.

**Context:** `apps/web/prisma/schema.prisma:16-17`. The columns already hold what a pin needs (host and port). Add the pin button, send them from `Presets.tsx`, and tune that receiver when the preset is chosen.

**Effort:** S
**Priority:** P3
**Depends on:** A pin-to-receiver button (not planned yet)

### Drop the browser's float32 frame decoding

**What:** Remove the `0x01`/`0x02` branches from `handleBinary` (`apps/web/src/lib/use-radio.ts`) and their test.

**Why:** They exist only so the web app could deploy before the radio service during the switch to compact frames. Once every running radio service sends `0x03`/`0x04`, they are dead code.

**Context:** Added with the int16/uint8 frame change (feat/compact-stream). Safe to remove once no radio service from before that change is deployed anywhere this web app points.

**Effort:** S
**Priority:** P4
**Depends on:** Every radio service deployment on the compact frames

### Keep one audio frame from overrunning the player's buffer

**What:** Make sure no single audio frame is bigger than the browser player's ring buffer: either split large blocks on the radio side, or size `MAX_AUDIO_SAMPLES` to the ring.

**Why:** `MAX_AUDIO_SAMPLES` is 2**18 so the browser accepts anything the radio service can send (a 1 MiB Kiwi frame), but the worklet's ring is 4 s at the Kiwi's own input rate (`rate * CAPACITY_SECONDS` in `apps/web/public/worklets/radio-player.js`), about 48,000 samples at 12 kHz. One maximum-size frame is about 5 times the ring, so it overwrites everything queued several times over: an audible jump, not a held slot. Real frames are about 512 samples.

**Context:** Raised by the Codex adversarial review of feat/stream-hardening. Before that branch there was no cap at all. Splitting on the radio side (`ListenSession._run`, `apps/radio/skywave_radio/session.py`) keeps the two caps in step; keep the comments on `MAX_FRAME_BYTES` and `MAX_AUDIO_SAMPLES` true.

**Effort:** S
**Priority:** P4
**Depends on:** None

### Name the stations in the scan list

**What:** Label "Strong signals now" rows with the station on that frequency now: match the public EiBi broadcast schedule by frequency and UTC time, and fall back to the receiver's own DX labels.

**Why:** The list shows "9420 kHz, 31m, 30 dB above noise" but not who it is. Schedules also give language and often programme type, the closest the app can get to "voices, not just loud": the scan's shape filter can't tell talk from music.

**Context:** EiBi publishes a free CSV each season (A and B schedules), so it needs refreshing twice a year, and shared frequencies need a matching rule. Kiwis expose owner DX labels (MSG keys `load_dxcfg` and `request_dx_update` arrive on the waterfall connection, `apps/radio/skywave_radio/waterfall.py`). Start by matching exact frequency plus the current UTC hour, and show nothing extra otherwise. The web side is `apps/web/src/components/SignalList.tsx`.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Completed

### Round 3d: small follow-ups from round 3c's reviews

**What:** (1) `_task_name`'s comments still say a host "can be megabytes long" and that the pump is named "before its host is validated"; `_tune` now caps hosts at 253 characters first, so the 200-character clip is only a backstop (say so, and name the 200 once). (2) `_recv`/`_send` raise the fresh error `from self._broken`, which hides the Kiwi's close frame (`ConnectionClosed`) from tracebacks; add it as a note. (3) `_tune` copies the whole host string (`strip().lower()`) before the 253-character check; check the raw length first. (4) `_end_scan`'s backstop registers every stopping task as a straggler before its wait, so a scan that stops on time logs "has stopped" at INFO; log only the ones still pending after the wait. (5) A same-receiver retune into a new mode whose `Demodulator` fails to build leaves the Kiwi on the new mode's offset while decoding with the old one (owner D7, round 3c: accepted as unreachable while modes are a fixed list; revisit if they become dynamic).

**Why:** Small log, comment and robustness items; none ends audio or leaves a Kiwi channel open.

**Context:** From the chore/round-3c-tidies /ship reviews (2026-10-25); owner D13 chose to ship and record these. `apps/radio/skywave_radio/{session,kiwi}.py`.

**Effort:** S
**Priority:** P4
**Depends on:** None

**Completed:** chore/round-3d-followups (2026-10-25). All five items, plus input hardening from its reviews: `_tune` refuses non-string hosts and modes without stringifying them, overlong hosts, modes and number text before copying or parsing, and odd ports (bool, containers, fractions, `""`, `"0"`; owner D2: strict, while null, absent and the number 0 still mean 8073); a refused message while a station holds its receiver leaves it playing and answers "error" then its status (owner D1); unknown types are echoed clipped; deeply nested or over-long JSON numbers are just bad JSON. Item (5) stays an accepted gap (owner D7), now noted at the demodulator build.

### Round 3c: tests, CI and wording left from rounds 2, 3a and 3b

**What:** (1) Add Python 3.12 to the radio CI matrix (`requires-python` is `>=3.12`, CI runs only 3.13), or raise the floor. (2) Tests: the crash branch of `_run_scan`'s ended-connection guard (a sweep that raises after its connection ended); `handle()`'s catch-all cleaning a bad scan id (bool or missing) to None; a socket with `IDLE_SOCKET_MINUTES=inf` is never idle-closed and its loop doesn't spin. (3) Wording: `_minutes()`'s error text reads as if only for the session limit, but `IDLE_SOCKET_MINUTES` uses it too; the `MAX_SESSION_MINUTES` error reads "at least 1 minute" even for a huge value refused because it overflows in seconds; the comment on the re-check after `kept.fast()` and the Value line of `test_a_stale_scan_does_not_take_a_waterfall_stored_during_fast` still describe the hazard from before `kept`. (4) Test tidies from round 3a: `test_one_address_can_hold_only_so_many_sockets` keeps a needless `expected = EXPECTED` alias, and `test_messages_keep_an_idle_socket_open` repeats the `EXPECTED` dict literally. (5) From round 3b's reviews: two `log.warning` calls for failed tasks lack `exc_info`, and the name-based failure logs (`_task_name`) don't say which receiver; a second cancel landing during `_end_scan`'s backstop wait skips its straggler registration and error reads (sockets are still aborted); `_recv`/`_send` re-raise the same stored `_broken` error object, which rewrites its cause and keeps a reference cycle (raise a fresh `KiwiError` instead); in `_tune`, build the new `Demodulator` before setting `_mode`, so a constructor failure can't leave mode and decoder out of step.

**Why:** (1) A 3.12-only break would ship unseen. (2)-(5) Small gaps in tests, logs and messages; none ends audio or leaves a Kiwi channel open.

**Context:** Left from fix/session-end-order (round 2, owner D4), feat/idle-socket-timeout (round 3a) and fix/channel-teardown-followups (round 3b, 2026-10-25). `apps/radio/skywave_radio/{session,kiwi,config}.py`, `apps/radio/tests/`, `.github/workflows/ci.yml`.

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** chore/round-3c-tidies (2026-10-25). All five items, plus owner decisions from that branch's reviews: D1 a dial that outlives `_dial` drops its socket on arrival and (D9) is cancelled at once; D2 shutdown also waits on running socket handlers, re-checked as each ends (D10), and (D8) on this loop's scan tasks that outlived their stop; D3 every case of those nets tested; D4/D5 a cleanup's failure is logged by whoever would otherwise miss it (an unawaited cleanup itself, or `_await_cleanup` when its handler is cancelled again); D6 a 10 s cleanup wait with a 40 s container stop period, held by a budget test; D10 refused sockets get a bounded close; D11 the idle waterfall reader stops when a cancel comes back as an error; D12 the docs say the exit after the wait is uncapped. Also: hosts over 253 characters are refused, task names carry and escape their receiver, warnings carry tracebacks.


### Finish the session-end follow-ups from round 2's review

**What:** (1) Make `abort()` stop any dial still in flight, not just drop its socket on arrival: check `KiwiConnection._aborted` before the https redial in `connect()`, and cancel an in-flight first dial too (keep a handle on the dial task), so an aborted waterfall never completes a handshake after its slot is freed. (2) Test the crash branch of `_run_scan`'s ended-connection guard (a sweep that raises after its connection ended). (3) In `_run`'s teardown, let a cancel win over a teardown error: log the error instead of replacing the `CancelledError`. (4) Small items from the round-2 re-review: `_stop_scan_tasks`, and `_run`'s teardown, read only the first failed task's exception (a second failure logs "never retrieved"); if the session-limit cancel lands inside a call that turns it into another error (e.g. a send raising `KiwiError("closed")`), the listener sees that error instead of the limit message; `_cancel`'s log line doesn't name the task; no test for `handle()`'s catch-all cleaning a bad scan id (bool or missing) to None; a scan task that outlives `_stop_scan_tasks`' timeout is dropped untracked, so a later failure only shows as "never retrieved" and cancel-swallowing tasks could pile up (keep them in a tracked set with a done callback that logs them); `_run`'s cancelled-teardown path reads teardown errors without logging them; a cancelled teardown leaves `_ending_target` set (harmless while the hold also needs a running pump; clear it); a scan whose connection ended still uses up its IP's sweep slot (`_sweep_times.start` runs before the connection check); `stop()` re-raises a scan task's error after the session did stop, so the listener sees "Something broke" instead of "Stopped." (log it, as `_run`'s teardown does when it has an ending), and the same error escapes `session.close()` in the server as an ASGI traceback; `_paired_waterfall`'s cancelled half-open waterfall closes gracefully where `abort()` would be quicker; the `MAX_SESSION_MINUTES` error reads "at least 1 minute" even for a huge value refused because it overflows in seconds; the comment on the re-check after `kept.fast()` and the Value line of `test_a_stale_scan_does_not_take_a_waterfall_stored_during_fast` still describe the hazard from before `kept` (now: a stale scan must not sweep its own old waterfall after its connection ended). (5) In `_tune`'s same-receiver retune, change `_mode` and the demodulator only after `client.tune()` succeeds, so an unexpected (non-Kiwi) error can't leave the session decoding with a mode the Kiwi never took. On that failure also send the current status back, so the browser's pending tune doesn't stay on "tuning" while audio plays. (6) CI runs only Python 3.13 while `requires-python` is `>=3.12`: add 3.12 to the radio CI matrix, or raise the floor. (7) From the round-3a (idle socket) review: on shutdown, wait (bounded, a few seconds) for the socket cleanups still running in `server.py`'s `cleanups` set, so a cleanup cut off by shutdown still closes its Kiwi cleanly instead of the process exit dropping the TCP connection (owner D6, round 3a); catch a peer that vanished while the idle close frame goes out (uvicorn may raise an `OSError` subclass from `ws.close`, logged as an ASGI traceback; no leak); rate-limit the "refused a socket" warning per address. (8) Test and wording tidies from round 3a: `_minutes()`'s error text reads as if only for the session limit, but `IDLE_SOCKET_MINUTES` uses it too; `test_one_address_can_hold_only_so_many_sockets` keeps a needless `expected = EXPECTED` alias and `test_messages_keep_an_idle_socket_open` repeats the `EXPECTED` dict literally; no test runs a socket with `IDLE_SOCKET_MINUTES=inf` to show it is never idle-closed and the loop doesn't spin.

**Why:** (1) An aborted scan waterfall that gets a redirect can still open one brief extra connection to the volunteer's Kiwi before it's dropped. (2) Without a test, dropping that guard would let a crashed straggler sweep idle against the next connection. (3) A teardown error during a cancel turns a switch into a generic "Something broke".

**Context:** Deferred from the fix/session-end-order /ship review (2026-10-23, owner decision D4) to the next PR. `apps/radio/skywave_radio/kiwi.py` (`connect`, `_dial`, `abort`), `apps/radio/skywave_radio/session.py` (`_run_scan`, `_run`, `_tune`, `_stop_scan_tasks`, `_cancel`, `handle`), `.github/workflows/ci.yml` (6). None ends audio; (1) can briefly hold one Kiwi connection (a single handshake) after its slot is freed, and only when a scan swallows its cancel or the Kiwi redirects to https. Items (4)-(6) are small follow-ups from the round-2 re-reviews.

**Effort:** S
**Priority:** P2
**Depends on:** None

**Completed:** fix/channel-teardown-followups (2026-10-25). `abort()` cancels an in-flight dial and blocks the https redial; a cancel after a dial finished drops its socket; a retune send that times out gives the connection up (owner D1, round 3b) and other failures keep the old frequency, with mode and demodulator changed only after the send and the current status sent back; a cancel (Stop, switch, limit) wins over teardown errors, including errors a cancel turns into; every teardown and scan error is read and logged; stragglers are tracked once; `stop()` logs pump and scan errors and still answers "Stopped."; shutdown waits up to 5 s in total for socket cleanups, with uvicorn `--timeout-graceful-shutdown 15` and compose `stop_grace_period: 30s` (owner, round 3b) and a test that the budget fits; a vanished browser's close is quiet; refusal warnings are throttled per address. Items (2), part of (4), (6) and (8) moved to "Round 3c".

### Close or time out a browser socket after its session ends

**What:** Close the browser WebSocket, or give it an idle timeout, once its session is stopped or errored and nothing new is tuned.

**Why:** `/ws` keeps `serve()` waiting on `ws.receive()` until the browser leaves; Stop and the session limit end only the Kiwi side. A client can open many sockets that never take a slot and hold them indefinitely, using file descriptors and memory.

**Context:** Raised by Codex in the fix/slot-freed-flake /ship adversarial review (2026-10-23); not measured. `apps/radio/skywave_radio/server.py` (`listen`). The web app reuses one open socket across tunes (`use-radio.ts`), so a timeout must be long enough not to drop a listener who pauses between stations, and the page must reconnect cleanly if it does.

**Effort:** S
**Priority:** P2
**Depends on:** None

**Completed:** feat/idle-socket-timeout (2026-10-25). A browser socket with no session playing and no message for `IDLE_SOCKET_MINUTES` (default 10, checked at startup) is closed with code 4000; the close frame is bounded, the idle clock runs from the later of the last message and the session's end, and the page treats 4000 as a quiet hang-up, resending a Listen that crossed it with the newest dial. One public address (IPv6 by /64) can hold at most `MAX_SOCKETS_PER_IP` sockets (default 8); the next is refused with 4001, which the page explains. Private and unknown addresses aren't counted, so an untrusted proxy can't turn the cap into a site-wide lockout. A socket's count is released once, before its idle close frame or in a shielded cleanup that always closes the session, even if the handler is cancelled mid-cleanup. Owner decisions D1-D7 (round 3a).

### End sessions cleanly when cleanup itself goes wrong

**What:** Make every session end (switch, Stop, time limit, connect timeout) survive a cleanup error and leave no Kiwi socket open behind a freed slot: (1) a switch that fails with an unexpected error sends an error status and keeps the browser socket instead of dropping it; (2) `KiwiConnection.close` logs and swallows non-cancel errors after it aborts (it re-raises them today); (3) a band scan cancelled mid-handshake keeps its half-open waterfall where `_end_scan` can close it, so the slot can't free while that waterfall is still closing; (4) reword `_tune`'s except-branch comment to cover cancellation, a failed close and unexpected errors.

**Why:** Each is a rare way for a listener to be dropped with no message, see a misleading "Something broke", or for a volunteer's Kiwi to carry one connection over the limit for up to `CLOSE_TIMEOUT_S`.

**Context:** Deferred from the fix/slot-accounting /ship review (2026-10-23) to round 2, which reworks session-end order. (1) `handle()` catches only `BadRequest`, so the error escapes `serve()`. (2) `apps/radio/skywave_radio/kiwi.py` `close()`; update `test_a_close_that_fails_still_drops_the_socket`. (3) `_paired_waterfall` holds the connecting waterfall in a local; test by holding `waterfall.connect()` and cancelling the session mid-switch. Also bound the wait for a cancelled scan (`_end_scan`'s `_cancel(self._scan)` has no timeout).

**Effort:** M
**Priority:** P2
**Depends on:** None

**Completed:** fix/session-end-order (2026-10-23). (1) `handle()` turns an unexpected error from a tune, Stop or scan into an error status and keeps the socket; `ClientGone` and cancels still propagate. (2) `KiwiConnection.close` aborts, logs and swallows non-cancel errors. (3) When ending is cancelled while a scan stops, `_end_scan` waits (up to `SCAN_STOP_TIMEOUT_S`) for that scan to close its half-open waterfall before the pump ends; the normal wait for a cancelled scan is bounded too, with a warning. (4) Comment rewritten. Tests: failed close on switch and Stop, half-open waterfall, stuck scan, close that fails. A scan that never stops can't keep its waterfall either: `_paired_waterfall` records the handshaking waterfall in `self._connecting`, and `_end_scan` calls `KiwiConnection.abort()` on it (open, mid-close or still dialing; `test_abort_reaches_a_socket_that_is_still_closing`, `test_abort_drops_an_open_or_still_dialing_socket`). Scan writes are tied to the connection that started them, and a tune for the receiver a session is still ending on is held until its status goes out (`test_a_tune_while_the_session_ends`).

### Don't refuse a reconnect in the 2 s after "Stopped"

**What:** Let a listener who reconnects on a new socket right after "Stopped" or an error get a slot: either send the terminal status after the Kiwi close and slot release, or add a "ready to reconnect" signal.

**Why:** `_run` sends "stopped" and then closes the Kiwi (up to `CLOSE_TIMEOUT_S`, 2 s) before the slot frees. On a full service, a reload or second tab in that gap gets "at its listener limit". Same-socket retunes are fine: they take the slot over.

**Context:** Both reviewers in the fix/slot-freed-flake /ship (2026-10-23). Sending the status later delays "Stopped" by up to 2 s after the audio has already ended, so decide which the listener should see first. `apps/radio/skywave_radio/session.py` (`_run`, `_pump_done`).

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** fix/session-end-order (2026-10-23). `_run` builds its terminal status (still naming the receiver), closes the Kiwi and the scan's waterfall side by side, frees the slot itself, then sends it. Worst case with stalled receivers mid-scan is about 4.5 s (`SCAN_STOP_TIMEOUT_S` = `CLOSE_TIMEOUT_S` + 0.5, then the waterfall close); normally milliseconds. `test_terminal_status_waits_for_the_close_and_the_free_slot`; `test_slot_freed_when_session_hits_time_limit` no longer needs to wait for the slot.

### End a session at its time limit even when the receiver goes quiet

**What:** Enforce `MAX_SESSION_MINUTES` with its own timer, not only when `client.blocks()` yields.

**Why:** The limit is checked per block, so a receiver that stops sending just before the limit keeps the session (and the volunteer's channel) until `blocks()` times out, up to about one receive timeout (~10 s) past the limit.

**Context:** Raised by Codex in the fix/slot-freed-flake /ship adversarial review (2026-10-23). `apps/radio/skywave_radio/session.py` (`_run`), `kiwi.py` (`blocks`). Small overrun; matters only for broken or hostile receivers.

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** fix/session-end-order (2026-10-23). The listening loop runs under `asyncio.timeout(MAX_SESSION_MINUTES)`, so a quiet receiver ends at the limit. `test_session_limit_ends_a_session_whose_receiver_went_quiet`.

### Don't free a slot while a cancelled switch's old Kiwi is still closing

**What:** When a receiver switch is cancelled while it waits for the old pump to stop, release the listener slot only once the old pump has finished, not in `_tune`'s `except BaseException` branch.

**Why:** In `ListenSession._tune` with `handing_over`, `stop(None)` waits on the old pump, which may be in its `finally` awaiting `client.close()` (up to `CLOSE_TIMEOUT_S`). If the caller is cancelled there (the browser leaves, or `server.py` gives up on a stalled browser), the slot is released at once while the old Kiwi connection is still open. Until the handler's `session.close()` aborts it, another listener can take the slot, putting a volunteer's Kiwi one connection over the limit.

**Context:** Found by the fix/slot-freed-flake /ship adversarial review (2026-10-23); reproduced by `test_cancelled_switch_keeps_the_slot_until_the_old_kiwi_closes`. One shape: hand the release to the old pump's done callback instead of releasing in the except branch. Tests: extend `test_slot_stays_held_until_the_kiwi_connection_closes` (held `close()`, assert `slots.active == 1` until it finishes) from the time-limit path to Stop, a `KiwiError` and a cancelled switch; `test_leaving_mid_switch_starts_no_new_pump` shows how to cancel mid-switch.

**Effort:** S
**Priority:** P2
**Depends on:** None

**Completed:** fix/slot-accounting (2026-10-23). A switch cancelled while the old pump closes now hands the slot's release to that pump's own end (`add_done_callback`, which also fires for a pump that already finished), so the slot frees once, after the old Kiwi connection has ended. Tests: `test_cancelled_switch_keeps_the_slot_until_the_old_kiwi_closes` (fails on the old code: the slot was free while the old channel was still open), and the slot-order test now covers the time limit, Stop and a Kiwi error.

### Make a double slot release loud

**What:** Guard `Slots.release()` so `active` can't go below zero (assert, or clamp and log).

**Why:** No path double-releases today, but if one ever did, `active` would go negative, the service would admit more listeners than `MAX_SESSIONS` (more volunteer channels than the limit) and `/healthz` would report a negative count, all silently.

**Context:** fix/slot-freed-flake /ship adversarial review (2026-10-23). `apps/radio/skywave_radio/session.py` (`Slots`). An assert could end a live session if it fires; a clamp plus `log.error` keeps listening but hides the over-admission until someone reads the log.

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** fix/slot-accounting (2026-10-23). Clamp plus `log.error`, chosen over an assert so a bookkeeping bug never ends a listener's audio. `test_releasing_a_free_slot_never_goes_below_zero`.

### Fix the flaky slot-freed-at-time-limit test

**What:** Find why `tests/test_server.py::test_slot_freed_when_session_hits_time_limit` sometimes sees the second session end in `error` instead of `listening`, and fix the test or the service.

**Why:** It failed once in the full radio lane on 2026-10-23 (branch `feat/design-pass`, which changes nothing in `apps/radio`) while the web suite ran in parallel; 5 solo reruns passed. A timing flake there could also hide a real bug where a session at its time limit doesn't free its slot, which would hold a volunteer's Kiwi channel.

**Context:** Failure: `assert second[-1]["state"] == "listening"` → `AssertionError: assert 'error' == 'listening'` at `tests/test_server.py:423`, right after `first[-1]` was `stopped` with "session limit". Reproduce under CPU load (run `pnpm test:web` and `pnpm test:radio` together).

**Effort:** S
**Priority:** P0
**Depends on:** None

**Completed:** fix/slot-freed-flake (2026-10-23). The test, not the service. `ListenSession._run` sends "stopped" before its `finally` closes the Kiwi connection (up to `CLOSE_TIMEOUT_S`, 2 s), and the slot is freed only after that, in `_pump_done`; the test tuned a second socket on seeing "stopped" and, under load, got "at its listener limit". Holding the slot while the volunteer's channel is still closing is correct. The test now waits with `wait_for_free_slots` before the second tune. With the close slowed by 0.5 s the old test failed 3 of 3 and the new one passed 5 of 5; with slot release disabled both fail 5 of 5, now with "the listener slot was never freed". The /ship review also added `test_slot_stays_held_until_the_kiwi_connection_closes`, which holds `close()` open and checks the slot stays taken until it finishes (it fails 3 of 3 when the release is moved ahead of the close).

### Give the remaining phone controls a 44 px tap target

**What:** On phones, give these controls at least a 44 px tap target, as feat/phone-polish did for inline links: the Listen/Stop button (`.power`, `.power-on`), the mode segments (`.mode span`), the presets Save button (`.presets-save button`), the preset delete ✕ (`.preset-delete`, 32 px) and the receiver table's choose buttons (`.receiver-choose`, 6 px vertical padding).

**Why:** The ≤520px block (`apps/web/src/app/globals.css:1276`) and the coarse-pointer block (`globals.css:1332`) set `min-height: 44px` only on `.pick-best`, `.link-button`, table header buttons and the map card controls. The five above get no such rule, so on a phone the main controls are smaller than the links around them. Found while writing DESIGN.md (listed there under Layout › Known gaps); feat/phone-polish being marked complete does not cover them.

**Context:** Mode segments sit in one row, so taller padding must not wrap the group at 320 px. The preset delete ✕ is round, so grow its hit area (padding or a pseudo-element) rather than the visible circle. `.receiver-choose` fills a table cell, so its extra height adds to every row's height. Check at 320 and 390 px, then remove the item from DESIGN.md's Known gaps.

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** feat/design-pass (2026-10-22). Under `@media (max-width: 520px), (pointer: coarse)`: `.power` (Listen/Stop), presets Save and `.receiver-choose` get `min-height: 44px`, the mode segments 10px vertical padding, and `.preset-delete` a 44px hit area from a `::before` 6px outside its 32px ✕. Removed from DESIGN.md's Layout › Known gaps.

### Write a DESIGN.md for the web app

**What:** Run `/design-consultation` to write `DESIGN.md` from the tokens and components in `apps/web/src/app/globals.css`, including the receiver map's `--map-*` tokens.

**Why:** skywave's look (enamel teal, glass dial, brass, amber lamp, Barlow Condensed + Atkinson Hyperlegible) exists only as CSS variables, so each design review has to reverse-engineer it.

**Context:** Raised by the receiver map design review (2026-10-20), which calibrated against `globals.css` because no DESIGN.md exists.

**Effort:** S
**Priority:** P3
**Depends on:** None (better after the receiver map adds its tokens)
**Completed:** docs/design-md (2026-10-21). DESIGN.md in the open DESIGN.md format (`gstack-design-md check` reports spec, tokens resolve with no errors): every `:root` color including the `--map-*` tokens, the two faces and the sizes in use, radii, the spacing values the CSS actually uses, key components, and Do's and Don'ts the code follows. It documents what exists; inconsistencies (stray hex colors, Barlow weights that aren't loaded, uneven brass-pill padding, phone controls without 44 px targets, drift from the map design record) are listed under Known gaps rather than resolved.

### Keep a dial move made mid-switch when the connection drops

**What:** When the radio service connection drops while a switch waits on audio, the switch reconnects and tunes the frequency from the click, losing a dial move made in between. Keep the newest tuning through the drop.

**Why:** `tune(B@f1)` stalls in `ensureAudio()`, the dial sends `retune(B@f2)`, then the socket closes. `onclose` calls `setTuningBoth(false)`, which clears `pendingRef`. When audio resumes, `tune()` opens a new socket and sends `pendingRef.current ?? t`, which is B@f1. The dial shows f2 while the radio plays f1. "Lost the connection" shows only until the new socket's answer replaces it. The next dial move corrects it. It's the same kind of desync as "Don't let a late tune undo a dial move made mid-switch" (P2, done), but it needs a dropped connection during a stalled audio resume, so it's rarer.

**Context:** Found while adding the per-socket retune test in feat/web-follow-ups (2026-10-21). That test (`use-radio.test.ts`, "still tunes on a new socket when the one a dial move went out on dropped") checks only that a tune goes out on the new socket, not its frequency. `pendingRef` is both the "awaiting an answer" marker and the tune's payload. Keep the newest tuning in its own ref that only `tune`/`stop` reset, then extend that test to expect `freqKhz: 7_100`.

**Effort:** S
**Priority:** P3
**Depends on:** None
**Completed:** fix/dial-move-on-drop (2026-10-21). `use-radio` keeps the tune's payload in its own `latestRef`, set by `tune`, updated by a same-receiver `retune`, and cleared only by `tune` and `stop`; `pendingRef` stays the "awaiting an answer" marker that a dropped socket clears. The per-socket test now expects the new socket to get `freqKhz: 7_100`; it got 10000 before the fix.

### Give inline buttons a usable tap target on phones

**What:** On phones, make the inline text buttons (`.link-button.inline`) easy to tap without breaking the sentences they sit in.

**Why:** The mobile breakpoint gives buttons `min-height: 44px` (`apps/web/src/app/globals.css:1297`), but `.link-button.inline` resets it to `0` (`globals.css:1303-1304`), so inline buttons are 24 px tall. That includes the map overlay's Retry map, Browse receivers and "Reload page (stops the radio)", and the picker's Try again. Measured at 320 and 390 px wide in a local check after feat/web-follow-ups (2026-10-21).

**Context:** Raising the height on inline text would push line spacing apart. Options: extra padding with a matching negative margin so the hit area grows but the text doesn't move, or making the map overlay's actions block-level buttons (they aren't running prose). The overlay is a fixed 220 px tall on phones (`.map-overlay`, `--map-height`); check it still fits.

**Effort:** S
**Priority:** P3
**Depends on:** None
**Completed:** feat/phone-polish (2026-10-21). Inline buttons keep `min-height: 0` on phones but get `padding-block: 10px` with `margin-block: -10px`, so the tap target is 44 px while the sentence keeps its line spacing (measured at 320 and 390 px: buttons 44 px, text lines unmoved, the map overlay still fits). The same PR folds the map attribution on maps 640 px wide or narrower the first time it opens, as MapLibre does on the first drag; the "i" button still opens it.

### Small receiver-table follow-ups from PR 2a review

**What:** (1) "Show all N" should `adopt()` the new list like the other row-shaping controls. (2) The held table's "fetched N ago" freezes when a poll returns identical rows (react-query keeps the `receivers` reference); refresh `view.fetchedAt` silently. (3) The credit's age still subtracts the server's `fetchedAt` from the browser clock; use `ageMs` like the poller. (4) `validPort` accepts `0x1F90` and `1e3`; require digits.

**Why:** Each is a small inconsistency left after the steady-rows work; none breaks listening.

**Context:** Codex structured + Claude adversarial passes, PR 2a /ship (2026-10-21). Also noted there and judged fine: Pick best ranks the newest list while the table is held (it should use the freshest data).

**Effort:** S
**Priority:** P3
**Depends on:** None
**Completed:** feat/web-follow-ups (2026-10-21). All four, plus two found on the way: the "list isn't answering" note had the same clock mix-up as the credit, and a held table now keeps the age of the last poll that confirmed its rows instead of the age it was first shown with. Every list age is now the server's `ageMs` plus this browser's time since the answer.

### Let Pick best move past a receiver that refuses after audio starts

**What:** Keep Pick best's run open for a short while after "listening", so a `no_apps` refusal in that window moves on to the next receiver with its note.

**Why:** Pick best finishes on "listening" (`apps/web/src/lib/use-pick-best.ts`), but a receiver whose owner allows no apps (`ext_api=0`) plays for about 10 s before it refuses (live probe 2026-10-21: 213 blocks, then `no_apps` at 10.8 s). The list hides these receivers, so Pick best only lands on one when an owner changed the setting since the list was fetched; the listener then sees the right error but has to pick again by hand.

**Context:** Found by the fix/ext-api-receivers /ship review. The window would need to cover about 15 s and must not resume a run the listener has since replaced (the `host`/`port` check on statuses). Test with a status sequence `listening` → `error no_apps` in `use-pick-best.test.ts`.

**Effort:** S
**Priority:** P3
**Depends on:** None
**Completed:** feat/web-follow-ups (2026-10-21). On "listening" the run looks finished but keeps a 15 s watch (`WATCH_MS`) on that receiver; a `no_apps` from it moves on to the next candidate that covers the dial, with its note. Dial and mode retunes of that receiver keep the watch (the refusal is about the receiver); any other status, choosing another receiver, a new run or the timer ends it.

### Show progress when Try again is pressed

**What:** While a user-started list retry runs with no list yet, show it next to the still-mounted Try again button (label or `aria-busy`), not on background polls.

**Why:** With `retry: false`, pressing Try again changes nothing on screen until the fetch settles, and an identical failure isn't re-announced. A "Trying again…" note that replaced the button (tried in PR 2a) dropped keyboard focus and re-announced every 15 s poll.

**Context:** PR 2a /ship final review (2026-10-21). Track a local "manual retry" flag rather than `list.isFetching`.

**Effort:** S
**Priority:** P3
**Depends on:** None
**Completed:** feat/web-follow-ups (2026-10-21). The failure line keeps the same Try again button through every retry and poll (react-query puts a query with no data back to pending on each refetch, so the failure now keys on `errorUpdatedAt`). A retry you start swaps the sentence for "Trying again…" and sets `aria-busy`; the sentence coming back announces a repeat failure. Polls never show it.

### Don't let a late tune undo a dial move made mid-switch

**What:** In `use-radio`'s `tune()`, skip the final `ws.send` when this generation's tune was already answered (the service named the pending receiver), or keep the latest Tuning in a ref that only `tune`/`stop` reset.

**Why:** With the socket open, `tune(B@f1)` can stall in `ensureAudio()` (a suspended audio device, common on phones). A dial drag then sends `retune(B@f2)` at once; the service answers for B, which ends the tune and clears `pendingRef`. When audio resumes, `tune()` sends its own `t` (B@f1), so the radio plays f1 while the dial shows f2, with no error. The next dial move corrects it.

**Context:** Found by the final Claude adversarial pass in PR 2a's /ship (2026-10-21) after the review cycle cap; deferred by decision 9ddd7713. `pendingRef` is cleared in `setTuningBoth(false)`, which made it both the "awaiting answer" marker and the retune payload. Natural home: PR 2b, which touches this hook.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2b (2026-10-21)

### Back: keep the right target through Stop, refusals and new dial flags

**What:** Rework the Back target in `apps/web/src/app/page.tsx` (`heard` history and `backTo`) so it handles three cases it gets wrong today.

**Why:** Stop pressed while a switch is still connecting (or just failed) makes Back disappear or jump two receivers back, because the idle branch always returns `previous`. A receiver reached again later from the list or over https keeps the flags it was first dialed with, so Back can redial it the old way. And after a refused (`no_apps`) receiver is dropped from the history and then plays again, Back can offer the receiver just stopped.

**Context:** Deferred from the receiver map PR 1 /ship review (Codex structured P2, Codex adversarial, Claude adversarial; 2026-10-21); fix at the start of PR 2, which adds Back to the map card and the map's "last" ring. Likely shape: treat the receiver in the fields as "shown" when idle (so Stop mid-switch keeps pointing at the one left), refresh `fromList`/`secure`/`label` when a receiver plays again, and never promote `previous` to `last` when they are the same receiver. Also decide whether Back should name a host-less failure (service drop) as a retry or fall back to `previous`, and whether the status line should name the receiver it is connecting to. Tests in `page.test.tsx` next to the existing Back tests.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Don't stall on an error code this build doesn't know

**What:** In `use-radio.ts`, decide whether an error ends a pending tune from the sanitized code (`KNOWN_CODES`), not the raw one.

**Why:** A rejected tune names the old receiver. If a newer radio service sends a code this web build doesn't know, the status is shown as uncoded but the pending-tune check still treats it as coded, so the page stays on "Connecting…" with locked fields until Stop.

**Context:** Deferred from the receiver map PR 1 /ship review (Claude adversarial + Codex structured P3, 2026-10-21); only reachable when the service ships a new code before the web app, which the README's deploy order rules out for codes so far. One-line fix at `const rejected = …` plus a test with an unknown code naming the old receiver.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Time out a radio-service connection that never opens

**What:** Give `ensureSocket()` in `use-radio.ts` its own connect deadline (say 10 s) that fails the tune with the existing "Can't reach the radio service" error.

**Why:** A tune now shows "Connecting…" and locks the fields from the click. If the radio service's address silently drops packets, the WebSocket stays in CONNECTING until the browser's own network timeout; Stop works, but nothing tells the listener the service is unreachable.

**Context:** Deferred from the receiver map PR 1 /ship review (Codex adversarial, 2026-10-21). Close the half-open socket on timeout and keep the generation guard so a late open can't revive it. Test with a `FakeSocket` that never opens and fake timers.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Keep table rows still while the list refreshes

**What:** Hold the receiver table's row order (and filtered set) steady when a background refetch delivers a new list, until the listener changes sort, filter or search, or presses a "List updated" control.

**Why:** The list is now polled while the table is open. Default order and "Has a free slot" depend on listener counts, so a refresh can move rows just before a click and the click lands on a different receiver than the one aimed at.

**Context:** Deferred from the receiver map PR 1 /ship review (Claude adversarial, 2026-10-21). The Night sort already freezes its order (`sortSun` in `ReceiverPicker.tsx`); extend that idea to the whole order. Fold in the polling follow-ups from the same review: each poll re-downloads the whole list (a small "has it changed?" query or an `unchanged` reply would make repeat polls cheap), and a viewer clock 15-16 minutes ahead of the server polls every 15 s (have the server send the copy's age instead of comparing two clocks).

**Effort:** M
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Keep dial changes made while a first connection starts

**What:** Send the newest frequency and mode once a tune that started from idle or an error is answered, instead of dropping dial, readout, preset and mode changes made in that window.

**Why:** `sendRetune` (`apps/web/src/app/page.tsx`) only sends while the status is connecting or listening, but `tune()` waits on audio setup and the socket first, which can take seconds on a cold start. The page already shows that window as "Connecting…", so the service then connects on the old frequency while the readout shows the new one.

**Context:** Deferred from the receiver map PR 1 /ship review (red team pass 3, 2026-10-21); fix at the start of PR 2. Either read the latest freq/mode right before `ws.send` in `use-radio`'s `tune()`, or send one retune when the pending receiver's first status arrives and it differs from what was sent. Test: start a tune with audio setup stalled (`workletReady`), move the dial, then check the tune or the follow-up retune carries the new frequency.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Don't leave a port-0 tune stuck on "Connecting…"

**What:** Normalize a typed port of 0 (or anything outside 1-65535) to the default port, or reject it, before tuning.

**Why:** The field and `parseReceiver` accept `0`; the service quietly dials 8073 (`int(port or DEFAULT_PORT)` in `session.py`) and reports port 8073, so `use-radio`'s pending-receiver check never matches. The receiver plays while the page shows "Connecting…" with the fields locked, and it's never saved or offered as Back.

**Context:** Deferred from the receiver map PR 1 /ship review (red team pass 3, 2026-10-21); fix at the start of PR 2. Fix in `normalizeReceiver`/`listen` in `page.tsx` (or make the service reject port 0 with a BadRequest). Test: type `host:0`, Listen, deliver `listening` on 8073, and check the page leaves the connecting state.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Give Pick best's fallback the old receiver's real scheme and list tag

**What:** When Pick best returns to the receiver that was playing before it started, dial it with that receiver's own `secure` and list tag.

**Why:** `provenance` (`apps/web/src/app/page.tsx`) only knows the receiver the page is tuned to. If Pick best starts in the moment after a table or Back click, before the service answers, the fallback is the old receiver but the page is already tuned to the new one, so the old one is dialed as typed and insecure: an https-only receiver fails over ws://, and a list receiver loses its public-only rule when `ALLOW_PRIVATE_HOSTS` is on.

**Context:** Deferred from the receiver map PR 1 /ship review (red team pass 3, 2026-10-21); fix at the start of PR 2. Look the fallback up in the page's Back history (`heard.last` / `heard.previous`) before defaulting. Test in `page.test.tsx`: secure receiver A playing, click a list receiver, start Pick best before any status, fail every candidate, and check A is redialed with `secure: true`.

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** receiver map PR 2a (2026-10-21)

### Find out why some Kiwis send `too_busy=0` ten seconds in

**What:** Work out what `too_busy=0` means and whether `KiwiClient._handle_msg` should treat it as "full".

**Why:** In a 2026-10-21 probe, receivers with free slots sent `too_busy=0` about 10 s after connect, with audio flowing and with or without keepalives, and listeners got "is full (0 channels in use)".

**Completed:** fix/ext-api-receivers (2026-10-21). It's the owner's `ext_api` setting: how many connections may come from anything but the Kiwi's own web page. At 0 the Kiwi plays for about 10 s, sends `too_busy=0` and closes, even if we ignore the message (6 of 6 receivers matched; same owner, g8ure:8076 with `ext_api=4` kept us, g8ure:8071 with 0 kicked us). That was 143 of 873 online receivers. The list now drops `ext_api=0` entries (a missing field stays listed), and `too_busy=0` says the receiver only allows its own web page. Other values now read "N listeners max", which is what the number means in the Kiwi's own client, not channels in use. It gets its own error code, `no_apps`; deploy the web app before the radio service for it, so the list stops offering these receivers first. Pick best moves past such a receiver even after audio starts (see "Let Pick best move past a receiver that refuses after audio starts", completed).

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
