# TODOS

## Radio service

### Echo a tune id so the dial settles on the newest answer

**What:** Have the service echo an id the page puts on each tune, so the page can settle the dial on the answer to its newest tune exactly: today it counts answers, and a dial move sent while the receiver was still connecting (not counted, since the service may or may not answer it) can be answered late and settle the dial on that older tuning until the next move (fix/web-dial-revert review; owner D4). The other half of this item, dial retunes carrying `"retune": true` so they never open a Kiwi channel, shipped in feat/listener-caps.

**Why:** A late answer leaves the dial showing an older tuning than what plays, until the next move.

**Context:** `apps/radio/skywave_radio/session.py` (`_tune`, `_status_payload`), `apps/web/src/lib/use-radio.ts` (`owedRef`, `settled`), README protocol. Deploy the radio service first.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Dial revert: small known gaps

**What:** (1) A refused retune's uncoded error status clears the band-scan list while the station keeps playing (the service's sweep goes on and its replies are then ignored). (2) If the service settles while a dial move is queued and that move is then dropped (playback ended or a switch started), the dial keeps the unsent value. (3) In the one render between a refusal's error and its follow-up status, a dial move updates the dial but isn't sent. (4) `use-radio` accepts 10–30,000 kHz from a status, the service up to 32,000: a settle outside the page's range moves the mode back but not the dial (the page never sends such values).

**Why:** Each leaves the dial or scan list out of step with what plays, briefly or until the next move; none cuts audio or holds a receiver. Owner D5 (fix/web-dial-revert review, 2026-10-26): record, fix later.

**Context:** `apps/web/src/lib/use-radio.ts` (status handler, `settled`), `apps/web/src/app/page.tsx` (`sendRetune`, the settled effect).

**Effort:** S
**Priority:** P4
**Depends on:** None

### Restore the receiver after a refused switch

**What:** When the service refuses a switch to another receiver (for example a bad list entry) and the old station keeps playing, put the page's tuned receiver (`host`/`port`/`fromList`/`secure`, where dial retunes go) back to the receiver still playing, and decide whether the pin and the Receiver field (`pin`, `draft`) follow it or keep naming the receiver the listener chose.

**Why:** Today the tuned receiver stays on the refused one, so every dial move goes there and is refused while the old station plays on. Already true before the dial revert. Since Auto/pins (feat/auto-receiver), a refused table, map or typed choice also leaves the chip naming a receiver that never played (it isn't saved: pins are saved only once they play). The better-receiver offer isn't affected: it switches through Pick best, which goes back on failure. Owner D6 (fix/web-dial-revert review, 2026-10-26): its own fix.

**Context:** `apps/web/src/app/page.tsx` (`tuneReceiver`, `pinTo`, `tuning`, `pin`, `draft`), `apps/web/src/lib/use-radio.ts` (uncoded error handling).

**Effort:** S
**Priority:** P3
**Depends on:** None

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

### Count listener slots across processes if the service ever scales out

**What:** Move the listener count out of process memory (or document a single-worker requirement) before running more than one radio service process.

**Why:** `Slots` lives in `app.state` and `/healthz` reports that process's count, so with several workers or replicas `MAX_SESSIONS` stops being a global cap and volunteers' receivers can be overbooked.

**Context:** Raised by Codex in the fix/slot-freed-flake /ship adversarial review (2026-10-23). Today the Dockerfile runs one uvicorn worker (`apps/radio/Dockerfile`), so nothing is wrong yet.

**Effort:** M
**Priority:** P4
**Depends on:** Running more than one radio service process

## Web app

### GhostNet: confirm the RTTY dial on a live slot (#91 follow-up)

**What:** During a GhostNet RTTY slot (Thu 1900Z Europe, Thu 0800Z Australia, Fri 0200Z North America), watch a Kiwi waterfall around 7.073-7.081 MHz. If the two tones sit at 7.077 and 7.07683 MHz (mark on 7.077), keep the dial at 7.074875 USB. If they sit 1-2.5 kHz above 7.077, move the dial to 7.077 USB.

**Why:** The GhostNet guide (v1.5) says only "RTTY 7.077 MHz, 45.45 Baud" and tells stations to use their radio's RTTY preset. It doesn't say whether 7.077 is the mark or a USB dial. If we guessed wrong, the strip's RTTY row is silent.

**Context:** Owner D8 in the #91 eng review (2026-11-22) chose the mark reading, from radio RTTY-preset convention and #92's default `markHz` of 2125. RTTY goes out only in short blind bursts, so a slot can be empty. The #93 recording session (Fri 2026-11-27 0100Z) can stay on through 0200-0230Z. The dial lives in `apps/web/src/lib/ghostnet.ts`, and a test pins it.

**Effort:** S
**Priority:** P2
**Depends on:** #91 merged, or the #93 recording session

### GhostNet: tighten "follow the net" and the ended line (#91 follow-up)

**What:** In `listenToGhostNet` (`apps/web/src/app/page.tsx`), take the follow-the-net retune only when (1) the receiver playing covers the new slot's dial, (2) the pick is this week's window (`serverNow() < ghostPick.endMs`), and (3) the receiver is the one the GhostNet run chose; otherwise go through `listenAt`/Pick best and set a fresh pick. Also let the status row's "has ended, Stop" line win over a stale "receiver list is still loading" page message, the way it already wins over a finished Pick best note.

**Why:** Today the shortcut retunes whatever plays. The na-au and eu-au bridges move from 14.107 to 3.575 MHz, so a receiver that can't tune that low goes quiet with no fallback. If the run fell back to the listener's earlier receiver, the rest of the net stays on it. A pick left from last week catches next week's Listen and is then cleared mid-net, so the next slot runs Pick best and can cut the audio. A GhostNet Listen in the list's first second of loading leaves a page message that can hide the nudge to free the volunteer's receiver.

**Context:** Owner D2 and D3 in the #91 read-only /ship review (2026-11-23) ruled these notes for a later PR. Each case is rare (nearly every KiwiSDR covers 0-30 MHz; week-long sessions; a failed run; a Listen in the list's first second). Follow-the-net itself is owner D4 from the earlier round; keep its no-Pick-best behavior when the checks pass.

**Effort:** S
**Priority:** P2
**Depends on:** #91 merged

### Live spot feed for receiver ranking (#61)

**What:** Feed live RBN and/or WSPR spots to Pick best as a re-order after today's order, the way `rankByNoise` works (`apps/web/src/lib/noise-rank.ts`).

**Why:** If the #61 replay shows that spots near a receiver predict "heard" better than today's order, the ranking still needs spots live. The replay alone ships nothing.

**Context:** Owner D7 in the #61 eng review (2026-11-18). Start only after the #61 replay passes its pre-registered bar (D1, D4); a pass also says which source earns the work. The re-review (2026-11-20) tightened that bar and added a fork:
- **Pass means a lift of at least 0.03 AUC** (D10), not only a lower bound above 0. A smaller real lift is written up as too small to build on, and this item stays closed.
- **Live or daily** (D11): the replay also scores yesterday's spots at the same time of day. If they come within 0.01 AUC of fresh spots, build this as a daily batch from RBN's daily file (`RBN_DAY_URL` in `apps/web/src/lib/rbn.ts`, no login) instead of a live feed, and #69's login stops being a dependency.
- **Kiwi-own reports** (D12): if the Step 1 freeze adds a score from Kiwis that report spots themselves (same 6-character grid), wspr.live may be the source instead of RBN.

RBN live goes through #69's single connection in the radio service once its login question is settled. wspr.live (https://wspr.live/) is a free, non-commercial research service with no availability promise: use it only as a cached, rate-limited poll, and fall back to today's order when it's down or slow. A WSPR spot counts only when both ends match: transmitter near the station or beacon, receiver near the Kiwi.

**Effort:** M
**Priority:** P3
**Depends on:** #61 replay passing (D10's 0.03 floor); #69 login (RBN live half only, not needed for the daily-batch path)

### Rank receivers for a broadcaster by transmitter site (#72)

**What:** Order Pick best's receivers for an EiBi broadcast by where they sit relative to its transmitter site, the way `rankForBeacon` does for beacons (`apps/web/src/lib/beacon-rank.ts:67`): past the skip zone, within one or two hops, sunlit midpoint.

**Why:** #72 gives each broadcast a transmitter site, but only the server uses it (to save `txSites` on answers). Broadcast listening still picks receivers by listed SNR alone.

**Context:** Named as a later use in issue #72. The #72 eng review (2026-11-19, D7 and D13) keeps sites and the server-only `ListedBroadcast` type off the page, so this needs site coordinates added to the page payload on purpose. Broadcast sites are often a group or unknown (about 25% of b26 listings have no coordinates; see D8 and D12), so receivers for those stations keep today's order. Start only if the #61 replay shows that distance and daylight predict "heard".

**Effort:** M
**Priority:** P3
**Depends on:** #72 shipped; #61 replay verdict

### Receiver notes view: heard rate per receiver and band (#60)

**What:** A read-only page (or a section of the receiver card) showing, per receiver and band, how many "Did you hear it?" answers said heard, not heard and didn't open, from `ReceptionReport`. Beacon answers listed off the air (`beaconStatus` OFF) or not spotted by RBN that day are left out, as in #61's analysis set.

**Why:** It's the last unbuilt part of #60, and the use Peter's Receiver Notes page showed demand for. The prompt, the table and the hourly limits shipped in #63 and #66.

**Context:** Triage of open issues (2026-11-20, owner D1): #60 closed and this moved here. Rates from a few days of answers would mostly be noise, so start once #61's Step 0 count (first real read ~2026-11-26) shows enough answers per receiver and band to show. Also from #60, still open: automatic heard/not-heard from a CW energy check on the beacon's 1 s dashes (v2; human answers stay the ground truth).

**Effort:** M
**Priority:** P3
**Depends on:** #61 Step 0 showing enough answers per receiver

### Make the EiBi site-table checks smarter than a count (#72 follow-up)

**What:** Notes from the hardening PR's review, none blocking: (1) `parseSites` reads every line after section IV, so a README with a new section after the site list, or two versions glued together, can inflate the count, and that inflated table then becomes the server's high-water mark until the instance restarts (stop at the next section header, or raise the mark only within a ceiling such as 1.5x the bundled table); (2) a README refused for its size is fetched again every 10 minutes per instance for good (back off on the 24 h TTL after a size refusal, keep the 10-minute retry for network errors); (3) the count is the only check, so a coordinate-format change that leaves every site with no coordinates still passes (also refuse a table whose share of placed sites drops sharply); (4) the documented recovery dead-ends if EiBi falls under the 1,000-site first-parse floor, and fails near a season change if the new schedule isn't posted yet; (5) the snapshot workflow's early exit (file unchanged) leaves an open snapshot PR's body as it was.

**Why:** Each lets a bad or changed EiBi file quietly keep stale or empty site data in the answers #61's replay counts.

**Context:** Hardening PR /ship review (2026-11-19), adversarial passes; owner rule "cap review rounds for optional data" (notes plus one TODO). The per-instance mark (D6), the 20-coordinate cap (D5) and the manual recovery (D11) are owner decisions, not part of this TODO.

**Effort:** S
**Priority:** P3
**Depends on:** None

### RBN skimmer list: a clean cut at a row boundary (#61 follow-up)

**What:** A page that stops cleanly right after a `</tr>` still parses as the whole list when it keeps at least 80% of the last saved day's skimmers. RBN sends no `Content-Length`, so a dropped connection there looks like a normal end. Possible check: RBN's rows are sorted by last-seen time, newest first, and the list covers 7 days, so a cut always loses the oldest rows. When rows are in that order, refuse a page whose oldest row is under N days old.

**Why:** A cut list saved as the day can't be fixed later. RBN keeps no history, and only refused pages are kept for re-parsing.

**Context:** Last open item (7) from the skimmer-snapshot /ship review notes (2026-11-20). Items 1 to 6 and a trailing-text check for item 7 shipped on `fix/rbn-snapshot-edges`. On the live page of 2026-11-21 (350 rows, rows in age order), the oldest row was 7.4 days old, with 22 rows at least 4 days old and 5 at least 6 days old. The test pages all use one last-seen age, so they would need varied ages. Not done yet because a bad N refuses real days (pages are kept, but the day stays unsaved until re-parsed), which makes it the owner's call.

**Effort:** S
**Priority:** P2
**Depends on:** The owner picking N, or deciding against the rule

### RBN skimmer refusals: keep "Not saved" rows out of the other-refusals count (#61 follow-up)

**What:** In `apps/web/src/server/routers/beacons.ts`, `skimmerDbStore.refusals(day, false)` counts every non-80%-rule refusal, including "Not saved: " rows, which `keep()` always stores. Count only the rows that are capped (exclude `NOT_SAVED_REASON` as well as `SHORT_REASON`), with a test where 10 failed saves are followed by a broken page that is still kept.

**Why:** After 10 failed saves in one UTC day, later parser refusals that day aren't kept, so the pages that would explain the bad day are lost for debugging. No saved list is lost.

**Context:** Codex outside voice on PR #86's last review round (2026-11-21); owner D7 ruled it a disclosed note plus this TODO. The same review's other ruled note (the day-before read now runs before parsing, so a database read failure there is an outage, not a refusal) needs no work.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Server clock: a backward change then a short sleep (#61)

**What:** Left from the scheduled-clock /ship (owner, 2026-11-19). Set the computer's clock back by hand, then sleep for less than that change before the next measurement: the drift never reads as a forward jump, so the clock sits off by up to the sleep, reading settled, until the next scheduled measurement (5 min, or the tab shown again). Re-measure on any drift past `JUMP_MS` in either direction. Also: the Codex outside review couldn't run on that branch (the session blocked sending code out), so a Codex pass on `server-clock.ts` is still owed.

**Why:** A beacon Listen in that window could name the neighbouring beacon. It needs a change by hand plus a sleep within 5 minutes; no audio impact.

**Effort:** S
**Priority:** P4
**Depends on:** nothing

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

### Cap Saved frequencies if long lists push Find a station down

**What:** Show the first 24 saved frequencies plus the one now tuned, with a "Show all N" button, in `apps/web/src/components/Presets.tsx`.

**Why:** Issue #89 moves Saved frequencies above Find a station and Strong signals now, with every row shown (owner, eng review D5, 2026-11-22). A browser can keep 200 (`LOCAL_MAX`, `Presets.tsx:19`), each with two buttons, so a long list pushes search far down the page and adds hundreds of tab stops.

**Pros:** Search and Strong signals stay near the top whatever the list size.

**Cons:** Hides saved stations behind a click; adds state and tests to Presets.

**Context:** Trigger: a listener reports a long list. Nobody has measured list sizes yet. Reuse StationSearch's "Show 20 more" pattern. Keep the tuned preset visible past the cap so `aria-current` still shows.

**Effort:** S
**Priority:** P3
**Depends on:** Issue #89 landing

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

### Check the EiBi snapshot workflow each March and October

**What:** In late March and late October, before the 1 April and 1 November runs, open the Actions tab and make sure "Refresh EiBi snapshot" is still enabled; re-enable it if GitHub turned it off. If a run was missed or failed, run it by hand (with the season, like `a27`), or run `pnpm --filter web eibi:snapshot` locally and commit `apps/web/src/server/eibi-snapshot.json`. If the snapshot PRs say the transmitter sites were refused as under 80% for two seasons in a row, EiBi has probably dropped sites for good, and only a hand step brings the new list in. Do it locally, never through the workflow. Delete the `sites` key from the bundled file, run `pnpm --filter web eibi:snapshot`, check the new count, and commit only if the script saved new sites. If it fails, restore the file with `git checkout` (README, Station names).

**Why:** skywave is a public repo, and GitHub disables scheduled workflows in public repos after 60 days without activity, silently: no run and no failure email. A quiet winter would let 1 April pass and leave the server's fallback schedule a season out of date.

**Context:** `.github/workflows/eibi-snapshot.yml` (see Completed: "Refresh the bundled EiBi schedule each season"). It only runs once merged to `main`. Next dates: check around 21 March 2027 (season `a27` from 28 March), then around 24 October 2027 (`b27` from 31 October).

**Effort:** S (twice a year)
**Priority:** P2
**Depends on:** None

### Fall back to the receiver's own DX labels for station names

**What:** Where the EiBi schedule lists nothing on a frequency, name it from the Kiwi owner's DX labels.

**Why:** EiBi covers broadcasters well, but local medium wave stations, utilities and pirates are often only in the owner's labels.

**Context:** EiBi names shipped (see Completed). Kiwis expose owner DX labels: MSG keys `load_dxcfg` and `request_dx_update` arrive on the waterfall connection, `apps/radio/skywave_radio/waterfall.py`. They'd need a new message to the browser, and `stationLine` in `apps/web/src/lib/eibi.ts` would take them as a second source.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Share the last good receiver list across Vercel instances

**What:** Keep the last good receiver list in Vercel Runtime Cache as well as in memory, so a Function instance that starts while the list mirror is down serves that list instead of "list failed", and instances don't each fetch the mirror on their own.

**Why:** On Vercel each instance starts with an empty `receiverSource()` cache. An open page keeps its list through a failed refresh, so only a fresh page load on a cold instance during a mirror outage sees the error. Owner D5 (feat/vercel-deploy eng review, 2026-10-27): defer; revisit if logs show repeated mirror fetches or cold-instance list failures.

**Context:** `apps/web/src/server/routers/receivers.ts` (`receiverSource`), `@vercel/functions` `getCache`.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Quick-tune buttons for the ham bands

**What:** Static band-plan shortcuts in the web app, for example "20m voice 14.200 USB", "40m voice 7.150 LSB" and "FT8 14.074 USB". Each tunes a frequency and mode with no scanning.

**Why:** A cheap way into amateur radio after the ham scan was shelved. The mode and dial are always right and nothing is added to the scan time. It doesn't find active stations, though on a busy band it lands near them.

**Context:** Pick dials from the US and Region 1 band plans; mind that 40m voice differs by region. Tuning goes through `changeFreq(khz, mode)` (`apps/web/src/app/page.tsx`). See "Amateur-band scan: shelved after the spike" under Completed.

**Effort:** S
**Priority:** P4
**Depends on:** None


### Show live DX cluster spots for the ham bands

**What:** List recent spots (SSB, CW, FT8) from a public DX cluster feed, which are frequencies hams typed in for stations they heard, with a button that tunes the receiver to each.

**Why:** Gives real stations with correct dials, which the shelved ham scan couldn't. The catch is that someone else heard the station, not necessarily this receiver.

**Context:** Needs an outside feed (a telnet cluster or a web API) and a server-side proxy with caching. Filter spots by mode and by distance or path to the receiver if possible. See "Amateur-band scan: shelved after the spike" under Completed.

**Effort:** M
**Priority:** P4
**Depends on:** Picking a feed and checking its terms of use


## Completed

### Find a station: list start-of-name language matches first (#110 follow-up)

**What:** In the Languages panel's filter, rank names that start with the typed text (or with a word starting with it) before names that only contain it, so typing "hin" puts Hindi above Chinese, Chin-Asho and Kachin.

**Why:** The filter matches anywhere in a name and keeps the common-first order (design 4A), so a keyboard user typing "hin" and pressing Tab lands on Chinese (browser QA in the #109/#110 /ship; owner accepted the risk for that release).

**Context:** `apps/web/src/components/LanguagePicker.tsx` (`shown`), its tests in `StationSearch.test.tsx` ("picks languages from a filterable panel").

**Effort:** XS
**Priority:** P2
**Depends on:** None
**Completed:** fix/station-filters-polish (2026-11-24): `LanguagePicker.tsx` ranks matches (start of name, then start of a later word, then anywhere), each group in the usual order; test "lists start-of-name language matches first".

### Find a station: clear the filter row's design-lint findings (#109/#110 follow-up)

**What:** Fix what gstack-design-lint flags on the lines the filters added. Two are at its top severity: a disabled "Aimed at" select or Languages button is shown by opacity alone (`globals.css` `.field select:disabled, .select-button:disabled`; add a fill and text change and `cursor: not-allowed`), and the "Outside the broadcast bands" heading is uppercase and letter-spaced (`.station-outside`; use sentence case at body size, untracked). Five are minor: `.language-panel` sets no text colour, the Languages button has no `:active` style, and three spacings are off the 4px scale (`.field select, .select-button` right padding, `.language-panel` padding, `.station-outside` margin).

**Why:** A faded control alone is easy to miss for low-vision users, and the tracked uppercase heading breaks the type rules the rest of the page follows. Found by the lint run after PR #111 was posted; owner chose a TODO over another fix round.

**Context:** `apps/web/src/app/globals.css` (filter row and `.language-panel` rules), `apps/web/src/components/LanguagePicker.tsx`. Rerun `gstack-design-lint` on those files and compare only the branch's lines; most of the file's other findings predate it.

**Effort:** XS
**Priority:** P2
**Depends on:** None
**Completed:** 2026-11-24, no code change (owner D1 on fix/station-filters-polish): checked against DESIGN.md, all seven follow the design system. Disabled controls dim to opacity 0.45 with `cursor: default` (DESIGN.md's Do list), the uppercase heading is design 5A/9A, 6, 10 and 12px are on DESIGN.md's spacing scale (30px is the chevron's room), the panel inherits `--text`, and no control on the page has an `:active` style.

### After the #109/#110 deploy: count pick version 9 in #61 (#61)

**What:** Once the Find a station filters deploy, record the deploy time on #61, change both `"pickVersion" IN (5, 6, 7, 8)` filters in `.local-data/61-step0.sql` (lines 113 and 128) to include 9, add the version 8 (#91) and version 9 deploy cutoffs to its `server_rules` CASE, and update the #61 query notes to group versions 6 to 9, with `browse` (a Pick best started from Find a station's on-now list) new in 9.

**Why:** Every Pick best answer from a current tab carries version 9 after the deploy; the Step 0 query would drop them all without an error. Deferred from plan: ~/.gstack/projects/skywave/feat-ghostnet-strip-eng-review-20261123-152437.md (T7), plus the /ship red-team finding.

**Context:** `apps/web/src/lib/pick-context.ts` (`PICK_CONTEXT_VERSION` docblock), README's pickVersion paragraph. The SQL file is local analysis data, not in the repo.

**Effort:** XS
**Priority:** P1
**Depends on:** The #109/#110 deploy
**Completed:** 2026-11-24, after PR #111 reached production (02:05:55 UTC). The cutoffs for versions 7, 8 and 9 are posted on #61; the local Step 0 query counts versions 5 to 9 and has the 8 and 9 cutoffs.

### Harden the #61 grid probe's input checks

**What:** Make `apps/radio/spikes/spots/kiwi_grid_probe.py` refuse (exit 2) every malformed input PR #85's /ship review found, instead of skipping, crashing or reading it as a short count: bad or negative `answers`, an all-unusable file, a JSON list without callsigns, unclosed or stray quotes, `--wspr-days` under 1, cache I/O under a non-UTF-8 locale, a cache name without the query, an unmarked RBN-only `--list`, and a capped block 9 download.

**Why:** The probe's D12 count goes to the #61 Step 1 freeze; a bad export could skew or stop it.

**Context:** Owner D1 in PR #85's second /ship run (2026-11-20).

**Effort:** S
**Priority:** P3
**Depends on:** Before running the probe for the #61 Step 1 freeze
**Completed:** fix/rbn-snapshot-edges, PR #86 (2026-11-21), with `--expect-rows` against new SQL block 9b.

### Tighten the RBN skimmer snapshot edges (#61 follow-up)

**What:** Seven notes from the skimmer-snapshot PR's review: (1) the agree rule read the day before's refusal even after that day was saved; (2) a `lastShortTotal` error was stored as a refusal; (3) a stale `SkimmerStore` comment; (4) two simultaneous runs could store a false "Not saved"; (5) `472kHz` bands dropped and HTML entities not decoded; (6) refusal rows unbounded per day; (7) a cut at a row boundary passed the cut-row check.

**Why:** Each could leave a wrong or misleading day in the skimmer history the #61 replay joins spots to.

**Context:** Skimmer-snapshot /ship review (2026-11-20).

**Effort:** S
**Priority:** P2
**Depends on:** None
**Completed:** fix/rbn-snapshot-edges, PR #86 (2026-11-21): items 1 to 6, plus a trailing-text check for item 7 (closing tags and comments allowed). Refusals are capped at 10 a day, 80%-rule refusals at 2, and "Not saved" pages are always kept. The rest of item 7 is open above as "RBN skimmer list: a clean cut at a row boundary".

### Move the RBN skimmer cron from Cron Jobs to Vercel Schedules

**What:** Replace the two `crons` entries in `apps/web/vercel.json` (`/api/cron/rbn-skimmers` at 01:30 and 13:30 UTC) with Vercel Schedules, following Vercel's migration guide (linked from the Cron Jobs page). Keep the route's `Authorization: Bearer $CRON_SECRET` check working, or change it to whatever Schedules sends.

**Why:** Vercel's dashboard marks Cron Jobs "Legacy" and deprecated (seen 2026-11-22). Schedules adds execution history, which the snapshot needs: today the Cron Jobs page shows only invocation counts, so whether a run saved, kept or failed is visible only in the runtime logs. A day with no snapshot is lost for good (RBN keeps no location history), so the job must not stop when the old system is retired.

**Pros:** Run history in the dashboard; off a deprecated feature before Vercel removes it.

**Cons:** One more migration on a job that works; the auth header and the 60 s `maxDuration` must be checked again under Schedules.

**Context:** Route: `apps/web/src/app/api/cron/rbn-skimmers/route.ts` (401 without the secret, 200 "saved"/"kept", 502 with a reason). Decision D14 / PR #84. First, confirm the current cron runs (Invocations reach 1 after 01:30 UTC on 2026-11-23) so the move starts from a known-good job. Check Vercel's docs for a removal date before picking the priority.

**Effort:** S
**Priority:** P2
**Depends on:** The post-deploy cron check (eng review task T7, 2026-11-22)

### Harden the EiBi site table refresh (#72 follow-up)

**What:** Four small fixes from #72's /ship review, noted rather than fixed in that PR: (1) give `scripts/eibi-snapshot.ts`'s fetches a timeout (an `AbortSignal`, like the server's `fetchLatin1`) so a stalled README can't hang the seasonal job until GitHub's 6-hour limit; (2) when the seasonal job reruns with its PR still open, update the PR body (`gh pr edit`) so the "sites refreshed / NOT refreshed" line matches the commit it just pushed; (3) cap coordinates per site in `parseSites` (today's README has at most 6) so a malformed README can't bloat every `txSites` row; (4) fix the stale `onAirBetween` comment ("one per transmitter site").

**Why:** None of these breaks anything today, but each lets a bad EiBi day quietly degrade the site data #61's replay depends on.

**Context:** #72 /ship review, run 2 (2026-11-19): owner chose notes plus this one TODO under the standing "cap review rounds for optional data" rule. Other notes from that review are in the #72 PR body.

**Effort:** S
**Priority:** P3
**Depends on:** #72 shipped
**Completed:** feat/eibi-hardening (2026-11-19), with a 3 MB download cap, previous→new site counts in the snapshot PR, and a refusal bar that can't step down added.

### Server clock on a schedule, and the edges left after round 3 (#61)

**What:** Close the #61 TODOs "Server clock: re-measure on a schedule, not only after a forward jump" (P3) and "Server clock: edges left after round 3" (P4).

**Completed:** fix/server-clock-schedule (2026-11-19). How each item closed:
- **Precision:** every tRPC reply carries the server's time in ms (`x-server-ms`, set by the route), so a measurement is good to half the round trip; the Date header is the fallback (owner: add ms header).
- **Schedule:** the page measures every 5 min while visible, when the tab comes back into view, and on any switch to the computer's clock (retry 10 s while there, else back off 60 s; 5 s timeout; one ask at a time). This closes the backward-change-then-sleep case, NTP slew between `performance.now()` and `Date.now()`, a slow first measurement and the slow-link loop (owner: every 5 min + on wake).
- **Corrections:** a measurement within its own error of the time shown keeps it; more is a correction. On an ordinary visit only an error of 1.5 s or more is corrected, so the clock almost never shifts under a planned question (owner: correct only when it matters). After a jump, or while poorly measured, 0.5 s.
- **Picks:** a held pick's context is dropped on any correction of the clock (or a jump undone), settled or not, and a pick before the first measurement keeps context only if that measurement agrees (owner: drop picks on any correction).
- **Further jumps:** a further jump while already on the computer's clock tells listeners and asks again.
- **Beacon pick:** beacon Listen while the clock is unsure says "Checking the time with the server…" and waits (up to 2 s) for a measurement before picking (owner: wait for a measurement).
- **Gap timers:** the question gap and per-channel wait run on the server's clock (owner).
- **Stale prompts:** on any clock move, a beacon prompt whose turn the server would no longer take closes (owner).
- **Version 6:** `PICK_CONTEXT_VERSION` is now 6; the server takes 2 to 6 (owner: post the deploy time on #61).
- **Review fixes (owner):** a beacon Listen waiting on the clock is cancelled by anything the listener does (a receiver chosen, Pick best, Stop, dial, mode, beacon mode, the drawer), so it can't reopen a receiver after Stop; a slow link settles on its best after one ask again; round trips are timed on the monotonic clock; question times saved by an older build are taken as no later than now.

### Pick context edge cases, round 3 (#61)

**What:** Close the two #61 TODOs "Pick context: trust only what the page could have sent" and "Server clock: edges of the forward-jump fallback".

**Completed:** fix/pick-context-round3 (2026-11-19). How each item closed:
- **Made-up candidates:** each report with context stores `candidatesListed`, how many of its candidates were on the server's public list when the answer arrived. The context is kept either way, so a receiver that left the list since the pick costs nothing; the replay filters (owner: store a listed count).
- **Server-stamped version:** closed with a note (owner). The server can't check the page's version; `createdAt` against the deploy times posted on #61 says which server rules took a row (schema comment, README).
- **Error pile-up and short sleeps:** a re-measure keeps whichever of the time shown and the old offset it agrees with within 2 s, so leftover error never stacks, a short sleep never snaps back onto the lagging clock, and a small forward change by hand (2-3 s, an NTP step) is still corrected (owner D3).
- **Flapping at the edge:** the page switches to the computer's clock past 2 s of drift and back only under 1 s, and takes a response inside that band, so jitter at 2 s can't flap between the clocks (owner D3).
- **Silent switches:** listeners hear every switch between the page's two clocks, so the beacon question re-plans when the clock moves, not only at a re-measure.
- **Stale question after a sleep:** a beacon question whose timer fired too late for the server to take the answer (with 5 s to spare for clock error and the trip) isn't asked; it plans a later turn, with or without a clock switch (a frozen tab).
- **Picks through a jump:** a pick made during a forward jump not yet re-measured keeps its context unless the time then moves before any measurement (a change by hand corrected, or the jump undone), so a pick right after a laptop wake keeps it and a wrong pick time doesn't (owner: drop only if corrected). The page asks for that measurement as soon as it switches clocks, and again every 10 s until one lands (a HEAD to `/api/trpc/clock`, which reaches the tRPC handler so the reply is never a cached page; tRPC answers it with a 204 whose Date header measures), so the correction lands before an answer (owner: re-measure on a switch, retried per D3). Offline, the context of a pick made through a forward change by hand can still go out with the computer's time, off by the change: the server's checks can't see it, since the slot is off by the same amount.
- **Listeners:** one that throws can't fail the tRPC call that measured the clock or keep the others from hearing.
- **Version 5:** these change when the page records a pick, so `PICK_CONTEXT_VERSION` is now 5; the server still takes 2 to 4 (owner: post the deploy time on #61).
- Left for later: the beacon pick after a forward change, the gap timers and two review notes ("Server clock: edges left after round 3").

### Re-measure the server clock after a jump

**What:** Keep the page's server-clock offset right after the computer's clock jumps (sleep and wake, a manual change, an NTP step).

**Completed:** fix/server-clock-monotonic (2026-11-19). How it works (owner: monotonic clock + re-plan):
- **The clock base:** `serverNow()` counts from `performance.now()`, so setting the computer's clock back (by hand or an NTP step) doesn't move it. A forward change looks like a sleep until the next quick response (below).
- **After a sleep:** when the computer's clock and the monotonic clock drift apart by more than 2 s (as when some browsers pause `performance.now()` in sleep), the next response with a round trip under 1 s measures the offset again. It replaces the offset only if it moved by more than 2 s. Until then a forward drift counts from the computer's clock with the last offset, which kept time through the sleep (owner, review: right at once on wake, as before this change); a backward one can't be a sleep and stays on the monotonic clock. A forward change by hand is corrected at that response, and listeners are told.
- **Ordinary visits:** without such a jump, later responses are ignored, so a slow first measurement is never shifted mid-visit. That was the pulled version's bug.
- **The beacon question:** when listeners are told the time moved (an offset replaced, or a forward change corrected), it starts its plan over on the new clock, so it and the band strip work from one clock again. At worst it waits one more turn. Entering the forward fallback isn't announced yet (see "Server clock: edges of the forward-jump fallback").
- **Version 4:** this changes the clock behind a report's `pickedAtMs` and when a beacon question comes after a correction, so `PICK_CONTEXT_VERSION` is now 4. The server still takes 2 and 3 from tabs opened before the deploy (owner: post the deploy time on #61).

### Pick context edge cases, round 2 (#61)

**What:** Close the rare pick-context cases PR #74's reviews noted. None of them lost an answer.

**Completed:** fix/pick-context-round2 (2026-11-19). How each item closed:
- **No-list beacon Listen:** a beacon Listen while the receiver list is missing now drops the earlier choice (`forget`).
- **Away-and-back re-pick:** the hook counts dropped choices. An answer sends its question's snapshot only if nothing was dropped since the question appeared, so a dial move away and back followed by a re-pick no longer revives it.
- **Candidate keys:** the server accepts a candidate only in its canonical spelling (`candidateKeyOk`): lowercase, no trailing dot, compressed IPv6, a port from 1 to 65535 with no leading zero, and unchanged by a URL round trip. Two spellings of one receiver can no longer pass as two.
- **The `pickVersion` null meaning:** the schema comment now says to split null rows by `createdAt` around PR #74's deploy (2026-11-19 02:52:57 UTC, also posted on #61).
- **Version 0 and 1:** both are tested and drop the context.
- **Review fixes:** a run that moves to another receiver counts a drop too, so a chain that leaves the question's receiver and comes back revokes the snapshot. Candidate keys longer than any real one (259 characters) are refused before parsing.
- **Version 3:** these rules change what an answer keeps, so `PICK_CONTEXT_VERSION` is now 3. The server still takes 2 from tabs opened before the deploy and stores it as 2 (owner: post the deploy time on #61).

### Pick context edge cases (#61)

**What:** Close the rare cases where a reception report's Pick best context was dropped or mislabelled, before the #61 replay reads that data. The answer itself was never lost in any of them.

**Completed:** fix/pick-context-edges (2026-11-19). How each item closed:
- **A stale question:** an answer now sends its snapshot only while the hook's choice for that receiver is on the snapshot's frequency.
- **A run that runs out of receivers:** it now clears its choice.
- **A failed start:** it clears the old choice only for beacon Listen; a failed Listen, link or drawer start keeps the playing receiver's still-valid choice.
- **Server checks:**
  - It accepts bare IPv6 candidate keys.
  - It accepts only candidate ports 1 to 65535.
  - It requires beacon context on a beacon answer and no beacon context on any other answer.
  - Its beacon bound is now slot start + 1.5 s, which includes the stream latency.
- **The server-clock offset:** not fixed here. Re-measuring was tried and pulled (owner), and it is now its own TODO, "Re-measure the server clock after a jump".
- **Tests:** the source-label and frequency tests were added.
- **Versions:** each answer now stores `pickVersion` (2), so the replay can tell these answers from PR #73's, which have none, including answers from tabs loaded before the deploy (owner).

**Closed without code:**
- The retry pick time: the owner ruled to keep it.
- One bad key drops the whole context: the owner chose to keep this, since dropping one key would shift rankPos.
- The tuning-correction drop: correct by design (owner).
- Case-variant hosts: these can't happen, because `new URL()` lowercases list hostnames.

### Refresh the bundled EiBi schedule each season

**What:** The `Refresh EiBi snapshot` workflow (`.github/workflows/eibi-snapshot.yml`) runs on 1 April and 1 November, a few days after EiBi's season switches, fetches the new season's file and EiBi's README (transmitter sites, #72) with `pnpm --filter web eibi:snapshot`, and opens a PR if `apps/web/src/server/eibi-snapshot.json` changed. It can also be run by hand from the Actions tab, with or without a season (`a27`).

**Watch for:** a failed run means EiBi hadn't posted the season's file yet; run it again once it has. A PR this workflow opens doesn't start CI by itself (GitHub's rule for its own token): close and reopen it to run the checks. The repo setting "Allow GitHub Actions to create and approve pull requests" must be on. GitHub can disable the schedule in a quiet public repo; see "Check the EiBi snapshot workflow each March and October" above.

### Name the stations in the scan list

**What:** Station names from the EiBi schedule, matched by frequency (within half a kHz), UTC time and day: under the readout, on each Strong signals row and as marks on the receiver's waterfall (UI critique PR 4).

**How:** The web server fetches the season's file once a day (`apps/web/src/server/routers/stations.ts`) and falls back on a bundled copy (`eibi-snapshot.json`, refreshed with `pnpm --filter web eibi:snapshot`); the page matches it locally (`apps/web/src/lib/eibi.ts`). The owner's DX labels are still open, above.

### Amateur-band scan: shelved after the spike

**What:** The amateur half of the band scan (branch `feat/ham-scan`, draft PR #33, labeled do-not-merge): voice, CW and digital rows found by sweeping the ham segments after the broadcast pass.

**Why shelved:** Owner decision, 2026-10-28, after the spike. It fails the agreed pass bar (eng D9) by a wide margin, and every real scan ran 25-48 s against the 15 s cap. The fixes that would help detection (finer frames, holds, broadcaster filtering) each make the sweep slower. Revisiting means a redesign, such as a finer-zoom sweep in the background that doesn't hold up the broadcast list, plus a new spike. Threshold tuning won't get there. Lower-cost alternatives are under Web app: "Quick-tune buttons for the ham bands" and "Show live DX cluster spots for the ham bands".

**Context:** The branch has the service, web, recorder (`record_ham.py --reference`), labeler (`auto_label.py`), scorer (`eval_ham.py`), dial estimator (`voice_dial.py`) and FT8 sync finder (`ft8_sync.py`). The plan and owner decisions are at `~/.gstack/projects/skywave/feat-vercel-deploy-eng-review-20261027-175826.md`.

**Spike run 2026-10-28 (5 public Kiwis: DE, US-WV, US-CA, two in AU; 40 rounds; labels from `scripts/auto_label.py`, pending an ear check of 20 clips):**
- Timing: every scan was over the 15 s cap. Median totals: 24.9 s (WV), 26.4 s (CA), 28.0 s (DE), 36-48 s (AU). Phone frames cost about 0.9 s each (0.4 s to settle plus the 0.5 s hold), CW frames about 0.4 s. In the service the ham pass would come back partial. D5/D13 need reopening.
- Detector vs the bar (displayed rows): voice 15% found, 1.6 false/round; CW 2% found; digital 62% found (91% with the display caps removed). The threshold search never reached the bar, and on the held-out AU receivers it did worse for voice, so `scan.py` keeps its provisional numbers.
- CW: one snapshot per CW frame misses most keyed CW, including stations 30-50 dB up. Replaying the reference frames at the same moment, a 0.5 s hold lifts CW recall from 25% to 40%.
- Voice dial: `scripts/voice_dial.py` finds the true dial from speech harmonics, with no edge rule. 4 of 5 trustworthy USB voices (20m and 17m) tune 0.25-0.53 kHz too low and sound squeaky; the one LSB voice was right.
- False voice rows: AM broadcasters in the shared segments (80m above 3900, 40m above 7200 outside the Americas).
- Owner ear check (20 clips, blind dial versions): automatic voice labels 3/3 real. CW labels under 20 dB were all inaudible (4/4), so the labeler now drops them (`CW_AUDIBLE_DB`); rescored, CW is still 3% found. Digital: 2/4 rows heard as FT8 (it can be present but inaudible; decode the saved slots to settle it). Dial: on the 3 clean SSB voices the owner's clearest version matched `voice_dial.py` (0, +0.3, +0.6 against estimates of -0.04, +0.25, +0.50). Both USB rows tuned too low, one of them a row the labeler also tuned too low, so the shared edge rule is confirmed wrong for USB. Detector voice rows: 2/5 were real ham voices; the others were noise or an AM broadcaster.
- Digital, checked independently: `scripts/ft8_sync.py` finds FT8 by its Costas sync in the saved 15 s slots (the decoder build was blocked). The labeler's digital calls matched the detector's in all 40 slots, so agreement proved nothing. Against sync: all 22 windows the detector called busy held FT8, 20 of them with 3+ signals at -10 dB or better; of the 18 it called quiet, only 1 had that many. Of the two "noise" clips in the ear check, 21074 (CA) really was weak (two faint tones). 7074 (WA) shows about eight clear FT8 tones for 3.5 s, then the gap between slots; worth a second listen.
- Data: the recordings (5 receivers, 40 rounds, clips, FT8 slots), the ear-check answers and the analysis helpers (threshold search, same-moment replay) are in `~/.gstack/projects/skywave/ham-scan-spike-2026-10-28/` on the owner's machine (about 130 MB, outside git; its README explains the layout). To get a fresh set, re-record with `record_ham.py --reference`.

**Effort:** (shelved)
**Priority:** -
**Depends on:** -


### Revert the web dial when the service refuses a retune

**What:** When a same-receiver retune fails (the service answers with the current "listening" or "connecting" status), move the web app's dial back to the frequency still playing.

**Why:** Since round 3b the service keeps the old frequency after a failed retune and says so, but the page's dial keeps showing the frequency it asked for, so the dial and the audio disagree until the next move.

**Context:** Accepted in the fix/channel-teardown-followups /ship review (2026-10-25). Since round 3d the service also answers any refused message, while a station still holds its receiver, with "error" and then that station's status (owner D1), which carries `freqKhz` and `mode`; the page's uncoded-error handling also clears the scan list then. `apps/web` (`use-radio.ts`, the status handler).

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** fix/web-dial-revert (2026-10-26). `use-radio` counts, per message, the tunes it sends while the service plays (dial retunes and tunes of the playing receiver) and the statuses that answer them; an uncoded error keeps the count only if the playing status follows it (a refusal's, owner D1), and any other ending, a new connection, Stop or a dropped socket clears it. When every one is answered it publishes the service's tuning (`freqKhz` and `mode`, checked), and the page moves the dial and mode there unless a newer move is queued, so a refused or failed retune puts them back. A refusal's error status still clears the scan list.

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
