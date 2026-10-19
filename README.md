# skywave

Listen to shortwave broadcasters and ham radio through public [KiwiSDR](https://rx.kiwisdr.com) receivers, with your own DSP doing the demodulation.

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

Open http://localhost:3000, paste a receiver hostname from rx.kiwisdr.com (port is usually 8073), and hit Listen. WWV on 10,000 kHz AM is the easiest first signal: it's on 24/7 and you'll hear the time ticks.

## Using it

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
  src/components/                    Dial, Waterfall, SMeter, Presets, FrequencyReadout
  src/server/                        tRPC router + Prisma client
  public/worklets/radio-player.js    jitter buffer + resampler
```

Browser ↔ service protocol: the browser sends JSON (`{"type":"tune","host","port","freqKhz","mode"}` or `{"type":"stop"}`). The service sends JSON status and S-meter messages, plus binary frames: first byte `0x01` for mono Float32 audio at the Kiwi's sample rate, `0x02` for a 512-bin Float32 dB spectrum row.

## Deploying the radio service

Run it on one of your EC2 boxes or the home server (`docker compose --profile radio up -d radio`). Two things matter:

1. **TLS.** A web app served over `https` can only open `wss://` sockets, so put the service behind your usual reverse proxy (Caddy, nginx) and set `NEXT_PUBLIC_RADIO_WS_URL=wss://radio.example.com/ws`. This is also why the service exists at all: most Kiwis only speak plain `ws://`, which browsers block from secure pages.
2. **Lock it down.** Set `ALLOWED_ORIGINS` to your web app's origin. `ALLOW_PRIVATE_HOSTS` stays off so the service can't be pointed at your internal network. `RADIO_TOKEN` adds a shared token, but it ships to the browser, so treat it as a speed bump; put the app behind real auth if it's public.

## Tests

```bash
pnpm test:radio     # 37 tests: DSP math, a fake Kiwi for the protocol, end-to-end WebSocket sessions
pnpm typecheck
```

## Next steps

1. **Receiver map:** load the public KiwiSDR list (it includes GPS coordinates) into a `Receiver` table and pick receivers by clicking a map.
2. **Station lookup:** import the EiBi shortwave schedule CSV so tuning 9,535 kHz at 0300 UTC tells you who's probably on and pins the transmitter site.
3. **Wider view:** the Kiwi's separate waterfall stream (`W/F`) covers the whole 0–30 MHz band; showing it on the dial would let you see activity before tuning.
