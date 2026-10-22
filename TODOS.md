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

## Completed

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
