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

**Port 5432 already taken** (another project's Postgres)? Put `POSTGRES_PORT=5433` in a root `.env` (see `.env.example`) before `pnpm db:up`, and use the same port in `DATABASE_URL` in `apps/web/.env`.

**Port 3000 already taken** (often another project's Docker container)? Start the web app on another port with `PORT=3001 pnpm dev`, and add that origin (`http://localhost:3001`) to `ALLOWED_ORIGINS` in `apps/radio/.env`; if the radio service runs in Docker, recreate it so it reads the change (`docker compose --profile radio up -d radio`). Don't count on Next.js moving to a free port on its own: when a container holds `127.0.0.1:3000`, `next dev` binds `*:3000` beside it, so `localhost:3000` can reach either app, and the radio service refuses the one it doesn't allow. Docker runs only Postgres and, with the `radio` profile, the radio service; the web app always runs on your machine with `pnpm dev`.

The radio service treats `localhost`, `127.0.0.1` and `[::1]` on the same port as one origin, and the dev server accepts `127.0.0.1`, so `http://127.0.0.1:3000` works too.

Open http://localhost:3000 and press **Listen** with the Receiver field blank: skywave picks the best receiver for you (the same as **Pick best receiver**). Or choose one from the list. WWV on 10,000 kHz AM is the easiest first signal: it's on 24/7 and you'll hear the time ticks.

The list comes from [rx.linkfanel.net](http://rx.linkfanel.net/), which mirrors the [public KiwiSDR list](http://kiwisdr.com/public/) as data (kiwisdr.com itself sits behind a click-through captcha). The web server fetches it at most every 15 minutes and keeps serving the last good copy if the mirror is down, marked stale once it's two hours old. You can always paste an address yourself: a full URL like `http://f4kiy.ddns.net:8073/` is fine (one with no port means 80, or 443 for `https://`), and the port is usually 8073 (a port of 0 or above 65535 is taken as 8073). The list only offers entries on Kiwi ports (80 and 8070–8079, plus 443 for `https://`), so a bad entry can't aim the radio service at some other kind of server; anything you paste yourself can use any port. It also leaves out receivers whose owners only take listeners on the Kiwi's own web page (`ext_api=0`), since those hang up on this app about 10 seconds in.

## Using it

- **Receivers:** Pick best tunes the receiver with the highest self-reported HF signal-to-noise ratio that covers your frequency. If it's full, down or otherwise refuses, it tries the next one, up to 3 per click (refusals about the address itself, such as a dead hostname, take no channel on anyone's receiver and don't count, up to 6 receivers in all; a dead name can still take up to 10 seconds to give up on). If nothing works, or you press Stop picking, it goes back to whatever you were listening to. A receiver that refused (in a run or when you tuned it yourself) is left out of Pick best for 15 minutes, since the list's copy of it can be that old, unless it plays again. Only a receiver's own answer counts (it's full, takes no apps, or needs a password); a dropped connection, a timeout or an address problem doesn't. Once a receiver plays, Pick best looks done but watches it for 15 seconds more: if it then refuses apps (an owner who changed `ext_api` since the list was fetched; such receivers play for about 10 seconds first), it moves on to the next one that covers the dial, with a note saying why. Moving the dial doesn't end that watch; choosing another receiver or Stop does. The list's listener counts can be 20 minutes old, so receivers it calls full are ranked last rather than hidden. If the mirror stops answering, the last copy stays in use and the picker says how old it is. If the list never loaded, the picker offers **Try again** (it reads "Trying again…" while a retry you asked for runs) and also asks again on its own every 15 seconds while the tab is visible. Browse the list to search by name, place or antenna, sort by column, and click a receiver to switch to it, even mid-listen. While it's open the list refreshes in the background, but the rows stay put until you sort, filter, search or press **Show all**, or press **Show it** on the "List updated" line between the filters and the table, which also moves keyboard focus to the table. The Night column says whether the sun has set at each receiver right now (sort by it to put the night side first); it's a hint about propagation, not a ranking. After a switch, the **Back to …** button beside the status line names the receiver you heard before and returns to it; if a switch fails or you stop it, Back offers the receiver you were just hearing. Pick best's progress ("… was full; trying …") shows in the status line, which always shows the newest message, and while you listen it names where the receiver is when the list says. When a receiver refuses and nothing else is handling it, a **Pick best receiver** link appears beside Back. A connection to the radio service that hasn't opened after 10 seconds is reported as unreachable, and so is a second tune that was waiting on that connection.
- **Map:** the receiver map shows every listed receiver with a known position, shaded where it's night now (lighter for civil twilight) and redrawn each minute. Night dots are brighter, full receivers are rings, and receivers that can't tune the dial's frequency are faint; the one you're hearing is amber, and the one before it has a faint "last" ring. Night is a hint about propagation, not a ranking: Pick best still ranks by signal and load. Click or tap a dot to see the receiver (a crowded spot lists up to 10, with **Zoom into this area** for more), then press **Listen** to switch; a click alone never changes what's playing. The map follows the receiver you're hearing until you pan or zoom, then stays put until **Center** (enabled while you're listening to a receiver with a known position and the map is showing). When playback starts, the listening dot gets one 600 ms emphasis (none under reduced motion). Zoom with ⌘/Ctrl+scroll, two fingers on touch, or the +/− buttons. So the radio starts first, the map loads only after the first audio arrives, or after 5 seconds with nothing playing or connecting. Dots and the greyline draw as soon as the map's style loads; base tiles from [OpenFreeMap](https://openfreemap.org) (no key) fill in after. If the map can't be drawn it shows "Map unavailable" with the reason and offers **Retry map** and **Browse receivers**; the table and Pick best keep working. If the map's code file itself is missing (most likely a deploy replaced it while the page was open), it also offers **Reload page** on a line of its own, which stops the radio; a download that only stalled, or a browser that knows it's offline, gets Retry alone. Reasons: its code didn't load (30 s limit), no WebGL, the browser dropped its graphics context (fails at once; Retry starts clean), the style or the receivers layer didn't draw within 30 s of visible time (a background tab doesn't count), or the base-map tiles aren't loading.
- **Strong signals now:** about 10 seconds after a receiver starts playing (and after Pick best's 15-second watch, if Pick best chose it), skywave scans that receiver's broadcast bands, medium wave plus the 14 shortwave bands on the dial, and lists the strongest signals it can hear right now, strongest first. Click one to tune it in AM. The list ranks by how far a signal stands above the noise, so it can't tell talk from music; flat-topped signals such as digital broadcasts and noise jammers are left out and counted instead. The scan rides on the receiver's existing channel (no extra listener slot on the volunteer's Kiwi), takes a few seconds, and stops at 15 seconds (or when the receiver stalls) with the bands it finished. A complete scan is kept for 10 minutes per receiver, for everyone listening there; a partial one is shown but not kept, and a receiver that refuses the scan isn't asked again for a minute. **Scan again** makes a new scan, at most one every 30 seconds per listener (per IP address) on a receiver: sooner on the same connection, it shows the last answer; on a new connection, the scan waits out the rest of the 30 seconds. A receiver that sends no waterfall at all is reported as an error, not as an empty list. Ham bands aren't scanned.
- **Dial:** drag to tune coarsely (snaps to 5 kHz). Focus it and use arrow keys for 1 kHz steps, Shift for 10, Page Up/Down for 100. Crossing into a ham band switches to the conventional sideband automatically. On a touch screen, a finger tunes once it moves sideways (a scroll that starts on the dial doesn't), and a tap tunes where it lands; on a phone, a drag that ends near the edge of the visible dial scrolls the rest into reach.
- **Readout:** click the big number and type an exact frequency, in kHz or with a unit (`7.2 MHz`, `7200k`). Anything else stays in the box, flagged, with the range to use; Escape puts the current frequency back. skywave remembers the last frequency and mode, as well as the last receiver, for your next visit.
- **Waterfall:** shows the ±6 kHz the Kiwi is sending, right under the status line. Click a signal to tune to it. The shaded strip is your current mode's passband. Until the first audio of a visit it's a short strip pointing at Listen.
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
  kiwi.py        KiwiSDR SND protocol client (I/Q mode) and the dialing it shares with waterfall.py
  waterfall.py   KiwiSDR W/F (waterfall) client, paired with the audio, for the band scan
  scan.py        band scan: which frames to sweep, peak finding, ranking
  dsp.py         filters, demodulators, AGC, spectrum
  session.py     one browser listener: Kiwi in, audio/spectrum out
  hostguard.py   refuses private/internal addresses (SSRF guard)
  server.py      FastAPI app: /ws and /healthz
apps/web/
  src/lib/use-radio.ts               WebSocket + Web Audio graph
  src/components/                    Dial, Waterfall, SMeter, Presets, FrequencyReadout, ReceiverPicker, SignalList
  src/lib/kiwi-list.ts               parses and ranks the public receiver list (with positions)
  src/lib/solar.ts                   where the sun is; which receivers are in darkness
  src/lib/use-solar-clock.ts         one minute clock for the page's Night column and map
  src/components/MapPanel.tsx        the map's panel: heading, legend, states; loads the map lazily
  src/components/ReceiverMap.tsx     MapLibre adapter (dots, greyline, card, camera)
  src/lib/receiver-map-model.ts      the map's logic: dot states, click hits, follow
  src/lib/receiver-map-style.ts      minimal map style on OpenFreeMap tiles, from --map-* tokens
  src/lib/use-map-admission.ts       holds the map back until the radio is playing
  src/app/vendor/maplibre/           serves MapLibre's worker (which the bundler doesn't copy) at /vendor/maplibre/<version>/
  src/lib/use-pick-best.ts           Pick best's try-the-next-one logic
  src/lib/use-receiver-list.ts       the receiver list query the page and the Receivers section share
  src/server/                        tRPC routers (presets, receivers) + Prisma client
  public/worklets/radio-player.js    jitter buffer + resampler
```

Browser ↔ service protocol: the browser sends JSON (`{"type":"tune","host","port","freqKhz","mode","source?","secure?"}`, `{"type":"stop"}` or `{"type":"scan","id","fresh?"}`; `"source":"list"` marks a receiver from the public list, which the service only dials on public addresses even with `ALLOW_PRIVATE_HOSTS` on, and `"secure":true` dials an https-only receiver over `wss://`, with its certificate checked against the hostname. A plain receiver that redirects to https on the same hostname, on port 443 or its own port, is followed once; any other redirect is refused as `unreachable`). The service sends JSON status messages (`{"type":"status","state","message?","code?","retryAfterMs?","host?","port?","sampleRate?","mode","freqKhz","features"}`; `features` lists `"scan"`, and the browser only sends `scan` to a service that does), scan replies (`{"type":"scan","id","host?","port?","state":"scanning|done|error",...}`; `done` adds `signals` [`{"freqKhz","snrDb","band"}`], `hidden`, `bandsDone`, `bandsTotal`, `partial` and `atMs`, `error` adds `message`; the browser applies only the reply for its newest request and current receiver, and a scan failure never comes as a status) and S-meter messages, plus binary frames: first byte `0x03` for mono int16 audio at the Kiwi's sample rate (full scale 32767), `0x04` for a 512-bin spectrum row (a float32 base level in dB, then one uint8 per bin at base + v × 0.5 dB). A service from before that switch sends `0x01`/`0x02` (Float32 audio and dB) instead; the browser reads both, so for that change deploy the web app first. An error status carries a `code`: `busy`, `no_apps` (the receiver only takes listeners on its own web page: `ext_api=0` in the public list, which the web app hides), `down`, `unreachable`, `timeout`, `password`, `redirect`, `bad_rate` or `closed` from the Kiwi connection, and `invalid`, `dns` or `blocked` when the address is refused (`invalid` also covers an address the Kiwi client can't build a URL for). For the `source`/`code` change, deploy the radio service before the web app: the browser relies on both, and an older service ignores `source` and sends errors without a `code`. Pick best moves to the next receiver on any coded error (they're all about that receiver), stops on an uncoded one (a bad request, the service's own listener limit or DNS lookup capacity, an internal error, or a dropped connection), and uses `host`/`port` to ignore statuses from earlier attempts. The one uncoded error with `retryAfterMs` (this client's earlier address lookup is still stuck) gets the same receiver tried once more after that wait. A web build ignores codes it doesn't know, treating those errors as uncoded.

The web app's design system (colors, fonts, spacing, components, and where the code is inconsistent) is recorded in [DESIGN.md](DESIGN.md); the receiver map's design record is [docs/designs/receiver-map.md](docs/designs/receiver-map.md).

## Deploying the radio service

Run it on one of your EC2 boxes or the home server (`docker compose --profile radio up -d radio`). Four things matter:

1. **TLS.** A web app served over `https` can only open `wss://` sockets, so put the service behind your usual reverse proxy (Caddy, nginx) and set `NEXT_PUBLIC_RADIO_WS_URL=wss://radio.example.com/ws`. This is also why the service exists at all: most Kiwis only speak plain `ws://`, which browsers block from secure pages.
2. **Lock it down.** Set `ALLOWED_ORIGINS` to your web app's origin. Any script can fake an Origin header, so the service refuses to start without `RADIO_TOKEN` once any non-localhost origin is allowed. The token ships to the browser in the web app's JavaScript, so set `APP_PASSWORD` on the web app (see below) to keep the token behind a password. `ALLOW_PRIVATE_HOSTS` stays off so the service can't be pointed at your internal network or tailnet.
3. **Trust your proxy, and only it.** The service lets each user have one address lookup running at a time, keyed by their IP. Behind a reverse proxy it only sees the user's IP if it trusts that proxy's `X-Forwarded-For` header, so set `FORWARDED_ALLOW_IPS` to the proxy's address as the container sees it (with docker compose and a proxy on the host, the bridge gateway, often `172.17.0.1`). Never use `*` while port 8765 is reachable without going through the proxy: anyone could then claim any IP. docker-compose publishes 8765 on every interface, and Docker's own port forwarding can make direct connections arrive from that same gateway address, so with a proxy on the host change the mapping to `127.0.0.1:8765:8765`; then only the proxy can reach the service and the gateway address really means the proxy. Until it's set, the limit falls back to one lookup per connection, which still works but lets one user open more connections to get more lookups.
4. **One process.** Run the service as a single process: one uvicorn worker, as the Dockerfile does, and one copy per outgoing IP address. The band scan pairs its waterfall with a listener's audio by the timestamp in the Kiwi URL, and that timestamp is unique only within one process (`KiwiConnection._last_timestamp` in `kiwi.py`). With several workers, or several copies behind one outgoing address, two listeners could get the same timestamp, and one listener's scan could end another listener's audio.

**Deploy order.** For the switch to int16/uint8 binary frames (`0x03`/`0x04`), deploy the web app before the radio service: the new web app still reads the old frames, but an older one plays nothing from the new ones. For the `no_apps` error code, deploy the web app first too, so the receiver list stops offering those receivers before the service starts naming the refusal. Such a receiver usually plays for about 10 s before it refuses; Pick best keeps watching for 15 s after audio starts, so it still moves past one. The band scan needs no order: the radio service lists `"features": ["scan"]` on its statuses and the web app only asks a service that does, so either side can go first or be rolled back. The protocol notes above say which side goes first for each protocol change.

## Deploying the web app

If the web app is reachable from the internet, set `APP_PASSWORD`. Every request then needs that password via HTTP Basic auth (any username): pages, the preset API, and the static JavaScript that contains `NEXT_PUBLIC_RADIO_TOKEN`. Leave it empty for local development. `src/proxy.ts` does the check.

## Tests

```bash
pnpm test:radio     # DSP math, a fake Kiwi for the protocol, end-to-end WebSocket sessions, the band scan and waterfall client, scripts/pregate-run.sh
pnpm test:web       # password gate, preset + receiver APIs, receiver ranking and Pick best, sun position, the receiver map (logic, style, panel and adapter wiring, worker route), band/S-meter math, the audio worklet's buffer
pnpm typecheck
```

## Next steps

1. **Station lookup:** import the EiBi shortwave schedule CSV so tuning 9,535 kHz at 0300 UTC tells you who's probably on and pins the transmitter site. On the map, that would draw the path from the transmitter to each receiver.
2. **Wider view:** the Kiwi's separate waterfall stream (`W/F`) covers the whole 0–30 MHz band; showing it on the dial would let you see activity before tuning.
