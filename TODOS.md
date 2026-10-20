# TODOS

## Radio service

### Halve stream bandwidth with int16 audio

**What:** Send audio frames as int16 (and optionally spectrum rows as uint8 dB) instead of float32.

**Why:** Cuts per-listener bandwidth roughly in half (~550 kbit/s today, estimated). Only matters for metered/mobile listeners or a higher `MAX_SESSIONS`.

**Context:** Binary frames are built in `ListenSession._run` (`AUDIO_TAG` / `SPECTRUM_TAG`, `apps/radio/skywave_radio/session.py`) and decoded in `handleBinary` (`apps/web/src/lib/use-radio.ts`). It's a protocol change on both sides; extend `test_server.py` and add a `use-radio` decode test.

**Effort:** M
**Priority:** P4
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
- Pick best started while a typed receiver is still connecting has nothing to go back to.
- The table's "tuned" dot follows the host field, not what's actually playing.
- When the radio service itself goes away after a receiver error, the banner keeps that receiver's message (on purpose, see `onclose` in `use-radio.ts`), so the user never learns the service is down. Say both.

**Why:** Each one is small and none breaks the main path, but together they make Pick best feel unreliable in the edge cases.

**Context:** `ReceiverPicker.tsx` (Pick button), `use-pick-best.ts` (`playing()`), `page.tsx` (`current`), `use-radio.ts` (`onclose`). The resolver-failure item was closed in the 2026-10-20 cleanup: a timeout or `EAI_AGAIN` looks the same whether this service's resolver hiccupped or the receiver's DNS is dead, so those stay `dns`; only unexpected resolver errors are uncoded now.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Harden the list parser and table against odd or hostile lists

**What:**
- Find the `kiwisdr_com` assignment rather than the first `[` in the body.
- Drop full Kiwi URLs that include a path (reverse-proxied receivers), since the dialer only uses host and port.
- Cap string field lengths and row count.
- Bracket IPv6 hosts wherever `host:port` is shown in the web app, so a copied address pastes back correctly (the radio service's messages already do).
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

### Small robustness edges from the 2026-10-19 /ship run 3

**What:**
- List hosts ending in a dot (`kiwi.example.`) pass the web filter but fail the service's `HOSTNAME_RE` as `invalid`, so they always fail. Strip the dot in `toReceiver`.
- `loadReceiver` trusts `localStorage` JSON; a `null` or wrong-typed value crashes the page's mount effect. Shape-check it.
- The save effect writes `localStorage` on every "listening" status, so dragging the dial writes it ~8 times a second. Skip unchanged values.
- Pick best's "Back on X" note shows before the fallback has reconnected; if it fails, the note is wrong and the run is over.
- The picker shows "Couldn't load the public receiver list" when a refetch fails even though a cached list is still shown and usable.
- With no cached list, one failed first fetch blocks retries for a full 60 s.

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

**What:** Tests for the untested cells the state-machine review mapped: use-radio idle/stopped/error × socket drop, connecting × tune, stopped/error × tune and stop; Pick best fallback × listening and × cancel; page listed × choose-row and × Pick best with a typed fallback, typed × edit and × reload, pending retune × Pick best next; and that `receivers.list` really goes out unbatched. (The radio-side cells were added in the 2026-10-20 cleanup.)

**Why:** These transitions work today but nothing would catch a regression in them.

**Context:** `apps/web/src/lib/use-radio.test.ts`, `use-pick-best.test.ts`, `apps/web/src/app/page.test.tsx`, `apps/radio/tests/test_server.py`, `test_hostguard.py`, `apps/web/src/lib/trpc.tsx`. The 2026-10-19 /ship run 3 added the eight highest-value ones.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Completed
