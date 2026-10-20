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

### Narrow what a list entry can make the radio service dial

**What:** Replace the port rule (80 or ≥1024, minus `SERVICE_PORTS`) with something closer to "looks like a Kiwi": a short allowlist of common Kiwi ports, or a cheap probe of `/status` before Pick best dials an entry.

**Why:** Codex rated this High. A hostile entry in the public list can still point Browse or Pick best at any public host on a high port (8080, 8443, 5000), so the service makes a WebSocket handshake to something that isn't a receiver. Private addresses are already refused.

**Context:** `toReceiver` / `SERVICE_PORTS` in `apps/web/src/lib/kiwi-list.ts`; `_tune` in `apps/radio/skywave_radio/session.py`. An allowlist would drop real Kiwis on unusual ports, so measure how many the public list has first. Deferred from the 2026-10-19 /ship adversarial pass.

**Effort:** M
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

### Small robustness edges from the 2026-10-19 /ship run 3

**What:**
- List hosts ending in a dot (`kiwi.example.`) pass the web filter but fail the service's `HOSTNAME_RE` as `invalid`, so they always fail. Strip the dot in `toReceiver`.

**Why:** None breaks the main path; each is a rare failure that's confusing when it happens.

**Context:** `apps/web/src/lib/kiwi-list.ts`, `apps/radio/skywave_radio/kiwi.py`, `apps/web/src/app/page.tsx`, `apps/radio/skywave_radio/session.py`, `apps/web/src/lib/use-pick-best.ts`, `apps/web/src/components/ReceiverPicker.tsx`, `apps/web/src/server/routers/receivers.ts`, `apps/radio/skywave_radio/hostguard.py`. Codex also rated refusing mirror redirects High; that refusal was a deliberate plan decision (D9) and stays.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Completed
