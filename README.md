# skywave

Listen to shortwave broadcasters and ham radio through public [KiwiSDR](http://kiwisdr.com/public/) receivers, with your own DSP doing the demodulation.

```
browser (Next.js)  ──ws──▶  radio service (Python)  ──ws──▶  public KiwiSDR
  dial, waterfall,           connects to the Kiwi,          raw I/Q, ~12 kHz wide
  audio worklet,             demodulates AM/USB/LSB/CW,
  presets (tRPC + Prisma)    streams audio + spectrum
```

The Kiwi only hands over raw I/Q. Everything from there to your speakers (filtering, sideband selection, envelope detection, AGC, the waterfall FFT) is code in this repo.

## Run it locally

You need Node 24 (see `.nvmrc`), pnpm 12, Python 3.11+, and Postgres (Docker is easiest).

The repo pins pnpm 12.14.0 in `package.json`. If your global pnpm is 10.x, it downloads 12 for you but skips the install script that puts pnpm 12's native binary in place, and every pnpm command then fails with `Failed to switch pnpm to v12.14.0 ... ENOEXEC`. Upgrade the global pnpm first, from outside the repo:

```bash
cd ~ && pnpm self-update 12.14.0
```

If it's already broken, finish the skipped step by hand: `cd ~/Library/pnpm/.tools/pnpm/12.14.0/node_modules/pnpm && node install.js` (the path differs on Linux: `~/.local/share/pnpm/.tools/...`).

```bash
pnpm install
pnpm db:up                                   # Postgres in Docker

cd apps/web
cp .env.example .env
pnpm prisma migrate deploy                   # creates the Preset table
pnpm db:seed                                 # WWV and a few ham/broadcast frequencies
cd ../..

cd apps/radio
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env
cd ../..

pnpm dev:radio                               # terminal 1: radio service on :8765
pnpm dev                                     # terminal 2: web app on :3000
```

**Port 5432 already taken** (another project's Postgres)? Put `POSTGRES_PORT=5433` in a root `.env` (see `.env.example`) before `pnpm db:up`, and use the same port in `DATABASE_URL` in `apps/web/.env`. If 3000 is taken, Next.js moves the web app to the next free port; add that origin (e.g. `http://localhost:3001`) to `ALLOWED_ORIGINS` in `apps/radio/.env`. The service treats `localhost`, `127.0.0.1` and `[::1]` on the same port as one origin, and the dev server accepts `127.0.0.1`, so `http://127.0.0.1:3000` works too.

Open http://localhost:3000 and hit **Pick best receiver**, or choose one from the list under it. WWV on 10,000 kHz AM is the easiest first signal: it's on 24/7 and you'll hear the time ticks.

The list comes from [rx.linkfanel.net](http://rx.linkfanel.net/), which mirrors the [public KiwiSDR list](http://kiwisdr.com/public/) as data (kiwisdr.com itself sits behind a click-through captcha). The web server fetches it at most every 15 minutes and keeps serving the last good copy if the mirror is down, marked stale once it's two hours old. You can always paste an address yourself: a full URL like `http://f4kiy.ddns.net:8073/` is fine (one with no port means 80, or 443 for `https://`), and the port is usually 8073. The list only offers entries on Kiwi ports (80 and 8070–8079, plus 443 for `https://`), so a bad entry can't aim the radio service at some other kind of server; anything you paste yourself can use any port. It also leaves out receivers whose owners only take listeners on the Kiwi's own web page (`ext_api=0`), since those hang up on this app about 10 seconds in.

## Using it

- **Receivers:** Pick best tunes the receiver with the highest self-reported HF signal-to-noise ratio that covers your frequency. If it's full, down or otherwise refuses, it tries the next one, up to 3 per click (refusals about the address itself, such as a dead hostname, take no channel on anyone's receiver and don't count, up to 6 receivers in all; a dead name can still take up to 10 seconds to give up on). If nothing works, or you press Stop picking, it goes back to whatever you were listening to. The list's listener counts can be 20 minutes old, so receivers it calls full are ranked last rather than hidden. If the mirror stops answering, the last copy stays in use and the picker says how old it is. Browse the list to search by name, place or antenna, sort by column, and click a receiver to switch to it, even mid-listen.
- **Dial:** drag to tune coarsely (snaps to 5 kHz). Focus it and use arrow keys for 1 kHz steps, Shift for 10, Page Up/Down for 100. Crossing into a ham band switches to the conventional sideband automatically.
- **Readout:** click the big number and type an exact frequency.
- **Waterfall:** shows the ±6 kHz the Kiwi is sending. Click a signal to tune to it. The shaded strip is your current mode's passband.
- **Modes:** AM for broadcasters and WWV. LSB below 10 MHz and USB above for ham voice. CW for Morse; the service tunes 700 Hz low so code comes out as a 700 Hz tone.
- **Etiquette:** each listener takes one of a volunteer's 4–8 channels. The service caps itself at `MAX_SESSIONS` listeners and drops a session after `MAX_SESSION_MINUTES`.

## Learning the DSP offline

You don't need the browser to experiment. These scripts use the exact same `Demodulator` the live service does:

```bash
cd apps/radio
.venv/bin/python scripts/make_test_signal.py --out synthetic.wav      # known signals, no receiver needed
.venv/bin/python scripts/record_iq.py --host <kiwi> --freq 10000 --seconds 30 --out wwv.wav
.venv/bin/python scripts/plot_spectrum.py wwv.wav                     # spectrum + waterfall
.venv/bin/python scripts/demod_wav.py wwv.wav --mode am               # writes wwv-am.wav to play
```

The loop is: edit `skywave_radio/dsp.py`, rerun `demod_wav.py`, listen. Good first experiments: swap the AM envelope detector for a synchronous detector (less fading distortion), make the AGC hang time adjustable, add a noise blanker, or add NFM for 10 meters.

## Layout

```
apps/radio/skywave_radio/
  kiwi.py        KiwiSDR SND protocol client (I/Q mode)
  dsp.py         filters, demodulators, AGC, spectrum
  session.py     one browser listener: Kiwi in, audio/spectrum out
  hostguard.py   refuses private/internal addresses (SSRF guard)
  server.py      FastAPI app: /ws and /healthz
apps/web/
  src/lib/use-radio.ts               WebSocket + Web Audio graph
  src/components/                    Dial, Waterfall, SMeter, Presets, FrequencyReadout, ReceiverPicker
  src/lib/kiwi-list.ts               parses and ranks the public receiver list
  src/lib/use-pick-best.ts           Pick best's try-the-next-one logic
  src/server/                        tRPC routers (presets, receivers) + Prisma client
  public/worklets/radio-player.js    jitter buffer + resampler
```

Browser ↔ service protocol: the browser sends JSON (`{"type":"tune","host","port","freqKhz","mode","source?","secure?"}` or `{"type":"stop"}`; `"source":"list"` marks a receiver from the public list, which the service only dials on public addresses even with `ALLOW_PRIVATE_HOSTS` on, and `"secure":true` dials an https-only receiver over `wss://`, with its certificate checked against the hostname. A plain receiver that redirects to https on the same hostname, on port 443 or its own port, is followed once; any other redirect is refused as `unreachable`). The service sends JSON status messages (`{"type":"status","state","message?","code?","retryAfterMs?","host?","port?","sampleRate?","mode","freqKhz"}`) and S-meter messages, plus binary frames: first byte `0x03` for mono int16 audio at the Kiwi's sample rate (full scale 32767), `0x04` for a 512-bin spectrum row (a float32 base level in dB, then one uint8 per bin at base + v × 0.5 dB). A service from before that switch sends `0x01`/`0x02` (Float32 audio and dB) instead; the browser reads both, so for that change deploy the web app first. An error status carries a `code`: `busy`, `no_apps` (the receiver only takes listeners on its own web page: `ext_api=0` in the public list, which the web app hides), `down`, `unreachable`, `timeout`, `password`, `redirect`, `bad_rate` or `closed` from the Kiwi connection, and `invalid`, `dns` or `blocked` when the address is refused (`invalid` also covers an address the Kiwi client can't build a URL for). For the `source`/`code` change, deploy the radio service before the web app: the browser relies on both, and an older service ignores `source` and sends errors without a `code`. Pick best moves to the next receiver on any coded error (they're all about that receiver), stops on an uncoded one (a bad request, the service's own listener limit or DNS lookup capacity, an internal error, or a dropped connection), and uses `host`/`port` to ignore statuses from earlier attempts. The one uncoded error with `retryAfterMs` (this client's earlier address lookup is still stuck) gets the same receiver tried once more after that wait. A web build ignores codes it doesn't know, treating those errors as uncoded.

## Deploying the radio service

Run it on one of your EC2 boxes or the home server (`docker compose --profile radio up -d radio`). Three things matter:

1. **TLS.** A web app served over `https` can only open `wss://` sockets, so put the service behind your usual reverse proxy (Caddy, nginx) and set `NEXT_PUBLIC_RADIO_WS_URL=wss://radio.example.com/ws`. This is also why the service exists at all: most Kiwis only speak plain `ws://`, which browsers block from secure pages.
2. **Lock it down.** Set `ALLOWED_ORIGINS` to your web app's origin. Any script can fake an Origin header, so the service refuses to start without `RADIO_TOKEN` once any non-localhost origin is allowed. The token ships to the browser in the web app's JavaScript, so set `APP_PASSWORD` on the web app (see below) to keep the token behind a password. `ALLOW_PRIVATE_HOSTS` stays off so the service can't be pointed at your internal network or tailnet.
3. **Trust your proxy, and only it.** The service lets each user have one address lookup running at a time, keyed by their IP. Behind a reverse proxy it only sees the user's IP if it trusts that proxy's `X-Forwarded-For` header, so set `FORWARDED_ALLOW_IPS` to the proxy's address as the container sees it (with docker compose and a proxy on the host, the bridge gateway, often `172.17.0.1`). Never use `*` while port 8765 is reachable without going through the proxy: anyone could then claim any IP. docker-compose publishes 8765 on every interface, and Docker's own port forwarding can make direct connections arrive from that same gateway address, so with a proxy on the host change the mapping to `127.0.0.1:8765:8765`; then only the proxy can reach the service and the gateway address really means the proxy. Until it's set, the limit falls back to one lookup per connection, which still works but lets one user open more connections to get more lookups.

**Deploy order.** For the switch to int16/uint8 binary frames (`0x03`/`0x04`), deploy the web app before the radio service: the new web app still reads the old frames, but an older one plays nothing from the new ones. For the `no_apps` error code, deploy the web app first too, so the receiver list stops offering those receivers before the service starts naming the refusal. Such a receiver usually plays for about 10 s before it refuses, after Pick best has already finished, so Pick best only moves past one that refuses before audio starts. The protocol notes above say which side goes first for each protocol change.

## Deploying the web app

If the web app is reachable from the internet, set `APP_PASSWORD`. Every request then needs that password via HTTP Basic auth (any username): pages, the preset API, and the static JavaScript that contains `NEXT_PUBLIC_RADIO_TOKEN`. Leave it empty for local development. `src/proxy.ts` does the check.

## Tests

```bash
pnpm test:radio     # DSP math, a fake Kiwi for the protocol, end-to-end WebSocket sessions, scripts/pregate-run.sh
pnpm test:web       # password gate, preset + receiver APIs, receiver ranking and Pick best, band/S-meter math, the audio worklet's buffer
pnpm typecheck
```

## Next steps

1. **Receiver map:** the public list is already loaded (`src/lib/kiwi-list.ts`) and includes GPS coordinates; plot it and pick receivers by clicking a map. That's also when a `Receiver` table starts paying for itself, so presets can point at one.
2. **Station lookup:** import the EiBi shortwave schedule CSV so tuning 9,535 kHz at 0300 UTC tells you who's probably on and pins the transmitter site.
3. **Wider view:** the Kiwi's separate waterfall stream (`W/F`) covers the whole 0–30 MHz band; showing it on the dial would let you see activity before tuning.
