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

**Context:** Binary frames are built in `apps/radio/skywave_radio/session.py:145-147` and decoded in `apps/web/src/lib/use-radio.ts:100-108`. It's a protocol change on both sides, and both need tests.

**Effort:** M
**Priority:** P4
**Depends on:** Web test setup (Vitest) for the decode path

## Web app

### Decide what Preset.receiverHost / receiverPort become

**What:** Replace or wire up the unused `receiverHost`/`receiverPort` columns on `Preset` when the receiver map lands.

**Why:** The schema implies presets can be pinned to a receiver, but no UI reads or writes these fields.

**Context:** `apps/web/prisma/schema.prisma:16-17`. The planned `Receiver` table (README "Next steps" 1) probably turns these into a foreign key. Decide then instead of building the free-text version now.

**Effort:** S
**Priority:** P3
**Depends on:** Receiver map / `Receiver` table

## Infrastructure

### Add CI once the repo has a remote

**What:** Run `pnpm test:radio`, `pnpm typecheck` and `pnpm test:web` on every push.

**Why:** Tests and typecheck only run by hand today, so a broken change can land without anyone noticing.

**Context:** There's no git remote yet, so the host (GitHub or otherwise) is undecided. CI needs Node from `.nvmrc`, Python 3.13 with `apps/radio/.venv`, and an install that works without `DATABASE_URL` (fixed in `prisma.config.ts`). Install pnpm 12.14.0 directly (e.g. `pnpm/action-setup` with `version: 12.14.0`), not by letting a pnpm 10 runner switch to it: pnpm 10 skips pnpm 12's native-binary install script and every command then fails with ENOEXEC (see README "Run it locally"). Build scripts for `@prisma/engines`, `esbuild` and `prisma` are denied in `pnpm-workspace.yaml`; pnpm 12 errors if any new dependency adds an unlisted build script.

**Effort:** S
**Priority:** P2
**Depends on:** A git remote; clean-install fix for `prisma.config.ts`

## Completed
