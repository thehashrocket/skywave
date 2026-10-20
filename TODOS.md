# TODOS

## Radio service

### Verify WebSocket backpressure for slow browsers

**What:** Confirm the radio service's per-socket send buffer stays bounded when a browser reads slowly, and cap it if not.

**Why:** One throttled or backgrounded tab could grow server memory without limit while audio keeps streaming (~68 KB/s per listener).

**Context:** The 2026-10-19 eng review couldn't verify this either way. Start at `apps/radio/skywave_radio/server.py` `send_bytes` and uvicorn's WebSocket settings (`ws_max_queue`, write limits). A slow-reader test in `tests/test_server.py` would settle it.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Halve stream bandwidth with int16 audio

**What:** Send audio frames as int16 (and optionally spectrum rows as uint8 dB) instead of float32.

**Why:** Cuts per-listener bandwidth roughly in half (~550 kbit/s today, estimated). Only matters for metered/mobile listeners or a higher `MAX_SESSIONS`.

**Context:** Binary frames are built in `ListenSession._run` (`AUDIO_TAG` / `SPECTRUM_TAG`, `apps/radio/skywave_radio/session.py`) and decoded in `handleBinary` (`apps/web/src/lib/use-radio.ts`). It's a protocol change on both sides; extend `test_server.py` and add a `use-radio` decode test.

**Effort:** M
**Priority:** P4
**Depends on:** None

### Dial https-only receivers over wss://

**What:** Teach the Kiwi client to dial `wss://` (and follow an http→https redirect) for receivers that only serve HTTPS.

**Why:** The client only builds `ws://` URLs, so these receivers always fail and Pick best steps past them. The public list has 2 explicit `https://` entries and 31 portless non-proxy entries; both of the 2 probed answered `:80` with a 301 and timed out on `:8073`.

**Context:** `apps/radio/skywave_radio/kiwi.py` `KiwiClient.url`. Found in the 2026-10-19 receiver-discovery eng review (probe: `websdr.sm7iun.se`, `swl-lippi-2.stbach.de`). Needs TLS verification against the real hostname while still dialing the IP that hostguard checked. Extend `tests/fakekiwi.py` for a TLS case.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Stop one client from filling the DNS lookup cap

**What:** Make the 8-lookup cap in `hostguard.py` hold up against a client that rotates WebSocket sessions to tune dead hostnames.

**Why:** The per-listener limit is keyed by the session object, so reconnecting gets a fresh one. Timed-out lookups keep their thread until the OS resolver gives up, so a token holder can fill all 8 and every user's hostname tune is refused until they drain. Codex rated this High; the pass-3 security review found the same.

**Context:** `_lookup` / `_last_lookup` in `apps/radio/skywave_radio/hostguard.py`; slot release in `session.py`. Options: key the per-client limit by client IP (`ws.client.host`, or X-Forwarded-For behind a trusted proxy), or count stuck lookups against `Slots`. Deferred from the 2026-10-19 /ship review of feat/receiver-discovery.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Don't end Pick best when the last lookup is still resolving

**What:** After a dead hostname times out (code `dns`), Pick best's next try on the same session waits up to 10 s for that lookup's thread; if the OS resolver takes longer, the new receiver is refused uncoded ("Still waiting on the last address lookup") and Pick best stops.

**Why:** One dead dynamic-DNS receiver near the top of the ranking can end a Pick best run on a slow resolver, with a message about the service rather than the receiver.

**Context:** `_wait_for_previous_lookup` in `hostguard.py`; `use-pick-best.ts` stops on uncoded errors. Options: a distinct retryable code with a delay, or wait longer before refusing. Deferred from the same review.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Let the radio service exit while DNS lookups are stuck

**What:** The dedicated DNS pool uses non-daemon threads, which `concurrent.futures` joins at exit.

**Why:** Up to 8 lookups stuck on dead names can hold up process exit, `--reload` and container stop until the OS resolver gives up.

**Context:** `_dns_pool` in `hostguard.py`. Shut it down with `cancel_futures=True, wait=False` on app shutdown, or use daemon threads. Deferred from the same review.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Web app

### Decide what Preset.receiverHost / receiverPort become

**What:** Replace or wire up the unused `receiverHost`/`receiverPort` columns on `Preset` when the receiver map lands.

**Why:** The schema implies presets can be pinned to a receiver, but no UI reads or writes these fields.

**Context:** `apps/web/prisma/schema.prisma:16-17`. The planned `Receiver` table (README "Next steps" 1) probably turns these into a foreign key. Decide then instead of building the free-text version now.

**Effort:** S
**Priority:** P3
**Depends on:** Receiver map / `Receiver` table

### Get default ports right for portless receiver URLs

**What:** Pasting a portless URL keeps the previous or 8073 port, while the list parser assumes 80 for portless non-proxy hosts; and some of those port-80 hosts only redirect to https.

**Why:** A pasted receiver can dial the wrong port, and Pick best can spend attempts on list entries that can't work over ws://:80.

**Context:** `normalizeReceiver` in `apps/web/src/app/page.tsx`, `defaultPort` in `apps/web/src/lib/kiwi-list.ts`; related to "Dial https-only receivers over wss://". Deferred from the 2026-10-19 /ship review.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Revisit the 2-hour cutoff on a stale receiver list

**What:** After two hours of mirror trouble the cached list is dropped and `receivers.list` returns BAD_GATEWAY.

**Why:** Codex argued a long outage now takes Pick best and Browse down entirely, where a clearly-labelled old list might be more useful. The cutoff was a deliberate choice in review (so an ancient list doesn't mislead), so this is a judgment call to revisit, not a bug.

**Context:** `MAX_STALE_MS` in `apps/web/src/server/routers/receivers.ts`; the footer already shows the list's age. Deferred from the same review.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Name unknown error codes in Pick best's skip note

**What:** A fallback note for error codes this web build doesn't know, and `handleText` keeping only known codes.

**Why:** If the radio service is deployed at a newer version that sends a new code, Pick best's skip note reads "X undefined; trying Y…". It only shows up when the two apps are deployed at different versions.

**Context:** `handleText` in `apps/web/src/lib/use-radio.ts` and `WHY_SKIPPED` in `apps/web/src/lib/use-pick-best.ts`. Deferred from the 2026-10-19 /ship review.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Narrow what a list entry can make the radio service dial

**What:** Replace the port rule (80 or ≥1024, minus `SERVICE_PORTS`) with something closer to "looks like a Kiwi": a short allowlist of common Kiwi ports, or a cheap probe of `/status` before Pick best dials an entry.

**Why:** Codex rated this High. A hostile entry in the public list can still point Browse or Pick best at any public host on a high port (8080, 8443, 5000), so the service makes a WebSocket handshake to something that isn't a receiver. Private addresses are already refused.

**Context:** `toReceiver` / `SERVICE_PORTS` in `apps/web/src/lib/kiwi-list.ts`; `_tune` in `apps/radio/skywave_radio/session.py`. An allowlist would drop real Kiwis on unusual ports, so measure how many the public list has first. Deferred from the 2026-10-19 /ship adversarial pass.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Pick best and receiver-list edges from the 2026-10-19 adversarial pass

**What:**
- Double-clicking Stop picking lets the second click land on the restored Pick best button and start a new run. Give the Pick button the same `e.detail > 1` guard.
- A temporary resolver failure (`EAI_AGAIN`, DNS timeout) is reported as the receiver's `dns` fault, so Pick best skips good receivers. Make service-side resolver trouble uncoded.
- Pick best started while a typed receiver is still connecting has nothing to go back to.
- The table's "tuned" dot follows the host field, not what's actually playing.
- When the radio service itself goes away after a receiver error, the banner keeps that receiver's message (on purpose, see `onclose` in `use-radio.ts`), so the user never learns the service is down. Say both.

**Why:** Each one is small and none breaks the main path, but together they make Pick best feel unreliable in the edge cases.

**Context:** `ReceiverPicker.tsx` (Pick button), `hostguard.py` (`socket.gaierror` handling), `use-pick-best.ts` (`playing()`), `page.tsx` (`current`), `use-radio.ts` (`onclose`).

**Effort:** S
**Priority:** P2
**Depends on:** None

### Harden the list parser and table against odd or hostile lists

**What:**
- Find the `kiwisdr_com` assignment rather than the first `[` in the body.
- Drop full Kiwi URLs that include a path (reverse-proxied receivers), since the dialer only uses host and port.
- Cap string field lengths and row count.
- Bracket IPv6 hosts wherever `host:port` is shown or put in an error message, so a copied address pastes back correctly.
- Extend the web-side private-host filter to 6to4, NAT64, IPv4-compatible IPv6, multicast and reserved ranges. The radio service already refuses these for list tunes.
- Break ranking ties by something other than mirror order, so every listener doesn't converge on one volunteer's receiver.

**Why:** A changed wrapper, a giant field, or a "Show all" on a huge list could break or freeze the picker. Deterministic ties pile listeners onto one receiver.

**Context:** `extractEntries`, `toReceiver`, `isPrivateHost`, `byRank` in `apps/web/src/lib/kiwi-list.ts`; `ReceiverRow` in `ReceiverPicker.tsx`; `KiwiError` messages in `apps/radio/skywave_radio/kiwi.py`.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Keep list provenance exact through Pick best and saves

**What:**
- Pick best's way back takes the list tag from the matching candidate row before asking `wasListed`, so a receiver you typed that also appears in the public list comes back as a list receiver. Take provenance from `wasListed` always and use the row only for its details.
- A stale "listening" status from an abandoned Pick best attempt can arrive after Stop picking has switched back; the save effect then stores that receiver as the default without its list tag. Save only the receiver the page is targeting (`tuning.current`).

**Why:** With `ALLOW_PRIVATE_HOSTS` on, the first can stop you getting back to a receiver that was just working (it's re-dialed public-only), and the second can turn a list receiver into a typed one that's dialed with private addresses allowed. In production both only affect the saved default or the fallback's rule.

**Context:** `playing()` in `apps/web/src/lib/use-pick-best.ts`; the save-on-listening effect and `wasListed` in `apps/web/src/app/page.tsx`. Found by the pass-2/3 red team and Codex's structured review in the 2026-10-19 /ship run 3; each fix wants a page test.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Don't lose the listener slot when switching receivers

**What:** `_tune` stops the old pump (releasing its slot) and then calls `try_acquire`; on a full service another connection can take the slot in between. Hand the slot over instead of releasing and re-taking it.

**Why:** The switching listener gets an uncoded "listener limit" error and loses audio they already had; Pick best stops on uncoded errors without going back. Pick best now switches automatically up to 6 times a run, so this pre-existing race is easier to hit.

**Context:** `ListenSession._tune` and `Slots` in `apps/radio/skywave_radio/session.py`. Test with `max_sessions=1` and a second socket racing the switch. Found by the native adversarial pass, 2026-10-19 /ship run 3.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Small robustness edges from the 2026-10-19 /ship run 3

**What:**
- List hosts ending in a dot (`kiwi.example.`) pass the web filter but fail the service's `HOSTNAME_RE` as `invalid`, so they always fail. Strip the dot in `toReceiver`.
- `kiwi.py` maps any `ValueError` during connect to `invalid`, which Pick best treats as a free address refusal. Validate the URL before connecting and catch only `InvalidURI` around the dial.
- `loadReceiver` trusts `localStorage` JSON; a `null` or wrong-typed value crashes the page's mount effect. Shape-check it.
- The save effect writes `localStorage` on every "listening" status, so dragging the dial writes it ~8 times a second. Skip unchanged values.
- The service's same-receiver check is case-sensitive while the resolver lowercases, so `Kiwi.Example` then `kiwi.example` reconnects. Lowercase the host in `_tune`.
- Pick best's "Back on X" note shows before the fallback has reconnected; if it fails, the note is wrong and the run is over.
- The picker shows "Couldn't load the public receiver list" when a refetch fails even though a cached list is still shown and usable.
- With no cached list, one failed first fetch blocks retries for a full 60 s.
- The `blocked` message echoes the resolved private IP, which tells any allowed client what internal names resolve to. Log it server-side instead (pre-existing).

**Why:** None breaks the main path; each is a rare failure that's confusing when it happens.

**Context:** `apps/web/src/lib/kiwi-list.ts`, `apps/radio/skywave_radio/kiwi.py`, `apps/web/src/app/page.tsx`, `apps/radio/skywave_radio/session.py`, `apps/web/src/lib/use-pick-best.ts`, `apps/web/src/components/ReceiverPicker.tsx`, `apps/web/src/server/routers/receivers.ts`, `apps/radio/skywave_radio/hostguard.py`. Codex also rated refusing mirror redirects High; that refusal was a deliberate plan decision (D9) and stays.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Picker design polish

**What:** Make the Location column's max width actually apply (wrap the cell text, or a fixed table layout); bring the Pick best note to body size; add hover states to `.link-button` and the Browse summary; consider a small "Choose a receiver" heading.

**Why:** Browsers ignore `max-width` on table cells, so long locations push the numbers right; the note is Pick best's main feedback but is the smallest text in the bar. The outside design pass also wanted a clearer section heading. The list stays open on first visit (an approved decision).

**Context:** `apps/web/src/app/globals.css` (`.col-location`, `.receivers-note`, `.link-button`), `apps/web/src/components/ReceiverPicker.tsx`. Deferred from the 2026-10-19 /ship run 3 design review.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Close the remaining state-transition test gaps

**What:** Tests for the untested cells the state-machine review mapped: use-radio idle/stopped/error × socket drop, connecting × tune, stopped/error × tune and stop; Pick best fallback × listening and × cancel; page listed × choose-row and × Pick best with a typed fallback, typed × edit and × reload, pending retune × Pick best next; session ended × tune-same, handshaking × tune-other and × stop, listening × stop (extend `test_listen_end_to_end`), ended × stop. Also: the own-cancellation re-raise in `hostguard._wait_for_previous_lookup`, and that `receivers.list` really goes out unbatched.

**Why:** These transitions work today but nothing would catch a regression in them.

**Context:** `apps/web/src/lib/use-radio.test.ts`, `use-pick-best.test.ts`, `apps/web/src/app/page.test.tsx`, `apps/radio/tests/test_server.py`, `test_hostguard.py`, `apps/web/src/lib/trpc.tsx`. The 2026-10-19 /ship run 3 added the eight highest-value ones.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Infrastructure

### Add CI once the repo has a remote

**What:** Run `pnpm test:radio`, `pnpm typecheck` and `pnpm test:web` on every push.

**Why:** Tests and typecheck only run by hand today, so a broken change can land without anyone noticing.

**Context:** The repo is on GitHub (github.com/thehashrocket/skywave), so GitHub Actions is the natural host. CI needs Node from `.nvmrc`, Python 3.13 with `apps/radio/.venv`, and `pnpm install` already works without `DATABASE_URL`. Install pnpm 12.14.0 directly (e.g. `pnpm/action-setup` with `version: 12.14.0`), not by letting a pnpm 10 runner switch to it: pnpm 10 skips pnpm 12's native-binary install script and every command then fails with ENOEXEC (see README "Run it locally"). Build scripts for `@prisma/engines`, `esbuild` and `prisma` are denied in `pnpm-workspace.yaml`; pnpm 12 errors if any new dependency adds an unlisted build script.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Completed
