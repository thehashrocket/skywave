# Spike #61: DVOACAP-Python for ranking KiwiSDR receivers

**Recommendation: don't adopt.** The test set was 9,345 VE3SUN listener reports.
On them, DVOACAP-Python 1.0.2 does no better than distance at predicting
"heard" (AUC 0.53 vs 0.53). It is no better than chance at the actual job,
which is ranking receivers for one signal (concordance 0.47–0.48). It also gives
physically implausible daytime results on a textbook circuit. Speed is fine and
is not the blocker. The one signal that did show up came from the receiver's
own past track record (AUC 0.61), not from propagation.

Script: [`score_ve3sun.py`](score_ve3sun.py). No row-level data or output is in
the repo. The input stays in `.local-data/`, and per-row predictions are
written next to it.

## 1. Install

`forecast = ["dvoacap>=1.0.2"]` is an optional extra in `apps/radio/pyproject.toml`.
The only dependency it brings is `numpy>=1.20`.

| environment | added by `.[forecast]` | numpy / scipy |
|---|---|---|
| `python:3.13-slim` (the server image), Python 3.13.18 | `dvoacap==1.0.2` only | 2.5.5 / 1.18.1, unchanged |
| fresh venv, Python 3.13.0 | `dvoacap==1.0.2` only | 2.5.5 / 1.18.1, unchanged |
| fresh venv, Python 3.12.9 | `dvoacap==1.0.2` only | 2.5.5 / 1.18.1, unchanged |

The issue mentioned a 3.12 env. The local `apps/radio/.venv` and the Dockerfile
are actually both on 3.13, so 3.13 was the target. The check ran on both. The
wheel ships a Flask dashboard and mockups we would never use, but its imports
are optional.

## 2. Method

- **API.** `dvoacap.prediction_engine.PredictionEngine` takes `params.{ssn, month,
  tx_location, tx_power, required_snr}`. You call
  `predict(rx: GeoPoint (radians), utc_fraction_of_day, [MHz])`; results are in
  `predictions[i].signal.{reliability, snr_db}` and `circuit_muf.muf`. This was
  read from the source, not guessed.
- **Rows.** Of 9,715 paths, 9,345 are in 2–30 MHz. 370 MW/LF/VHF rows were dropped
  from every score so that all scores see the same rows. `utc` is treated as UTC
  and rounded to the nearest hour.
- **SSN.** I used SILSO's monthly 13-month smoothed total sunspot number, V2
  ([`SN_ms_tot_V2.0.csv`](https://www.sidc.be/SILSO/INFO/snmstotcsv.php)), for
  the report's calendar month. It runs from 50.8 (2021-11) to a peak of 160.9
  (2024-10). It is downloaded to `~/.cache/skywave-spike/`, not bundled.
  - dvoacap's own `SunspotNumberFetcher` grabs the latest *daily* SSN, which is
    the wrong input for VOACAP; it needs the smoothed value.
  - VOACAP's maps were fitted to the pre-2015 V1 scale (about V2 × 0.6), so the
    whole run was repeated at ×0.6. Nothing moved by more than 0.02.
- **Fixed settings.** Isotropic antennas, 145 dB man-made noise (dvoacap default),
  3° minimum takeoff angle.
- **TX power and required SNR.** dvoacap computes SNR in a 1 Hz band, and its
  `bandwidth_hz` setting is unused. I guessed values by mode:

  | mode | TX power | required SNR |
  |---|---|---|
  | CW | 100 W | 30 dB-Hz |
  | SSB / blank | 100 W | 44 dB-Hz |
  | AM (HF broadcasters) | 100 kW | 54 dB-Hz |

  Raw SNR and MUF/f are scored too, because neither depends on these guesses.
- **Scores compared:**
  - DVOACAP reliability
  - DVOACAP SNR
  - DVOACAP MUF/f
  - distance (−path_km)
  - a no-model day/night rule: above 10 MHz wants a sunlit path midpoint,
    below 10 MHz wants a dark one
  - the receiver's heard rate over *earlier* reports only (4-char grid, shrunk
    toward the running mean, so it can't peek at the outcome)

## 3. Scores (SSN V2; the ×0.6 run is within ±0.02 everywhere)

### Overall ROC AUC, n = 9,345, heard rate 0.351

| score | AUC | 95% CI |
|---|---|---|
| DVOACAP reliability | 0.527 | 0.515–0.538 |
| DVOACAP SNR | 0.537 | 0.524–0.550 |
| DVOACAP MUF / f | 0.505 | 0.493–0.517 |
| distance baseline | 0.525 | 0.513–0.538 |
| day/night heuristic | 0.514 | 0.501–0.526 |
| receiver track record (past only) | **0.614** | 0.602–0.626 |

### Ranking within a request

This is the real question. A group is reports with the same station, frequency
and UTC hour where receivers disagree: 538 groups, 1,680 reports, 1,397
heard/not-heard pairs. The CI comes from resampling groups.

| score | concordance | 95% CI |
|---|---|---|
| DVOACAP reliability | 0.468 | 0.441–0.492 |
| DVOACAP SNR | 0.479 | 0.440–0.520 |
| DVOACAP MUF / f | 0.519 | 0.481–0.558 |
| distance baseline | 0.494 | 0.453–0.534 |
| day/night heuristic | 0.504 | 0.466–0.544 |
| receiver track record | 0.470 | 0.431–0.511 |

**Nothing ranks receivers within a request.** Every CI touches or sits below 0.5.
The receiver track record helps overall but not here. Its overall lift probably
reflects which regions and listeners file reports, not which receiver hears a
given signal better.

### Heard rate by decile

**DVOACAP reliability:** half of all predictions are the floor value (5.8e-6),
so the bins are uneven.

| reliability | n | heard rate |
|---|---|---|
| 0 – 5.8e-6 | 4,954 | 0.332 |
| 5.9e-6 – 0.0026 | 1,588 | 0.379 |
| 0.0026 – 0.06 | 934 | 0.328 |
| 0.06 – 0.47 | 935 | 0.368 |
| 0.47 – 1.0 | 934 | 0.416 |

**DVOACAP SNR (dB-Hz):**

| decile | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| SNR upper bound | −387 | −176 | −72 | −33 | −11 | 1.6 | 12 | 24 | 41 | 89 |
| heard rate | .322 | .305 | .318 | .339 | .360 | .326 | .387 | .382 | .353 | .422 |

**Distance (far → near):**

| decile | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| km lower bound | 14,400 | 11,400 | 9,740 | 8,890 | 7,810 | 6,600 | 3,680 | 1,500 | 440 | 4 |
| heard rate | .321 | .321 | .423 | .316 | .340 | .295 | .308 | .376 | .372 | .443 |

The heard rate moves about 10 points across the whole range of any score.

### By band (AUC)

| MHz | n | heard | reliability | SNR | MUF/f | distance | day/night |
|---|---|---|---|---|---|---|---|
| 2–4 | 899 | .333 | .527 | .533 | .485 | .541 | .503 |
| 4–6 | 920 | .350 | .512 | .526 | .470 | .486 | .544 |
| 6–8 | 2,541 | .384 | .537 | .537 | .468 | .539 | .517 |
| 8–11 | 482 | .384 | .541 | .561 | .553 | .515 | .506 |
| 11–15 | 1,368 | .336 | .490 | .501 | .492 | .527 | .486 |
| 15–19 | 522 | .320 | .498 | .498 | .500 | .514 | .544 |
| 19–22 | 972 | .332 | .576 | **.617** | .556 | .576 | .554 |
| 22–30 | 1,641 | .337 | .521 | .516 | .489 | .497 | .498 |

### By path length (AUC)

Path length was held roughly fixed here, to see whether DVOACAP adds anything
beyond distance.

| km | n | heard | reliability | SNR | MUF/f | distance |
|---|---|---|---|---|---|---|
| 0–1,000 | 1,521 | .420 | .521 | .518 | .508 | .558 |
| 1,000–3,000 | 1,058 | .363 | .546 | .534 | .516 | .495 |
| 3,000–7,000 | 1,434 | .312 | .502 | .524 | .573 | .569 |
| 7,000–10,000 | 2,673 | .326 | .517 | .527 | .513 | .494 |
| 10,000+ | 2,659 | .355 | .512 | .529 | .505 | .547 |

### By mode (AUC)

| mode | n | heard | reliability | SNR | distance |
|---|---|---|---|---|---|
| CW | 2,381 | .332 | .562 | .569 | .539 |
| SSB / blank | 6,303 | .352 | .518 | .526 | .524 |
| AM | 661 | .413 | .511 | .513 | .502 |

The best showings are 19–22 MHz (SNR .617) and CW (.57). Both are modest, and
the 19–22 MHz band is equally well served by distance (.576).

## 4. Is it the model or the data?

Both look weak.

**The data carries little propagation signal.** Even the day/night rule of thumb
scores 0.51, and distance 0.53. The issue's caveats apply:

- Outcomes depend on the listener and the receiver (antenna, local noise,
  effort), not only on the path.
- Rare DX is over-represented.
- Receivers are only located to a 4-char grid square.
- `utc` is still unconfirmed as UTC.

**The port also misbehaves on a textbook circuit.** The test was W1 (41.7N 72.7W)
→ London, June, SSN 100, 100 W, isotropic antennas:

| UTC | MUF | 14 MHz reliability | 14 MHz SNR |
|---|---|---|---|
| 00Z | 17 MHz | 0.04 | 24 dB-Hz |
| 12Z | 17 MHz | 0.00 | −10 dB-Hz |
| 18Z | 17 MHz | 0.00 | 14 dB-Hz |

At 12Z it also gives 3.6 MHz at −341 dB-Hz.

- 20 m transatlantic is a reliably open path on June afternoons at SSN 100.
  That is operating experience; I did not run reference VOACAP here. The port
  has it closed in the daytime and better at night.
- 28% of the test-set predictions have SNR below −100 dB-Hz, and some go
  below −4,000.
- That pattern looks like runaway daytime D-layer absorption. The source has a
  "BUG FIX: use fixed height of 100 km for D-layer absorption" patch in that
  same code path.

**Other known gaps in 1.0.2:**

- The long-path model is a stub, so paths ≥7,000 km (57% of this set) use the
  short-path model.
- Sporadic-E obscuration is not modelled.
- The upstream "86.6% validation" covers only 11 test paths.

This spike can't separate "VOACAP can't rank listener reports" from "this port is
wrong". It does show that this port, on this data, gives us nothing to ship.

## 5. Timing

Measured in `python:3.13-slim` with `--cpus=1 --memory=2g` on an Apple M3 Max.

| measure | result |
|---|---|
| single prediction | p50 2.4 ms, p95 2.9 ms |
| first call (loads month coefficients) | 3 ms |
| month change | 2 ms |
| rank 50 receivers, one tx/frequency/hour | p50 98 ms, p95 138 ms |
| peak RSS | 132 MB |

**On a 1 vCPU / 2 GB cloud box:**

- A shared x86 vCPU is typically 2–3× slower per thread than an M3 core. That is
  an estimate, not measured: about 200–400 ms to rank 50 receivers, and memory
  is a non-issue.
- **That fits a request's latency budget, but not inside the radio server.** The
  engine is pure Python and holds the GIL. On one vCPU, 200–400 ms of blocking
  in the FastAPI event loop would stall every listener's audio and waterfall.
- A thread doesn't help (GIL). A separate worker process still shares the one
  core, but the OS scheduler preempts it, so it can't freeze the event loop.
- **If we ever adopt a forecast, it needs an hourly cache built by a separate
  worker**, not an inline call. Cache keys would be (tx grid square, band, hour).
  Rough cost: about 1,000 public Kiwis × 8 bands ≈ 8,000 predictions ≈ 20 s per
  tx square per hour at M3 speed. So only a bounded set of tx squares can be
  precomputed.

## 6. What I'd build next

1. **Receiver-side priors, not path forecasts.** A receiver's own record was the
   only signal found:
   - uptime
   - the 429-receiver no-open rate from the VE3SUN set
   - our own #60 "did you hear it?" answers

   It still doesn't rank within a request on this data, so collect our own
   outcomes with exact receiver IDs before building a ranker on it.
2. **A cleaner truth set before revisiting forecasts.** Use objective spots with
   measured SNR, such as WSPR or RBN/PSKReporter, where "heard" doesn't depend
   on a listener. That separates model error from data noise in one run.
3. **If forecasts come back,** score reference VOACAP (`voacapl`, the Linux
   Fortran build) on the same paths first. If it also lands near 0.53 here, the
   data is the limit. If it does much better, the port is the problem, and an
   upstream fix to the daytime absorption is worth filing. Use the 13-month
   smoothed SSN, not dvoacap's daily fetcher.
4. **Leave `forecast` as an unused optional extra,** or drop it when this branch
   closes. Nothing in the server, web app or Dockerfile uses it.

## Reproduce

```sh
pip install -e 'apps/radio[forecast]'
P=<repo>/.local-data/ve3sun/ve3sun-reception-paths.csv
python apps/radio/spikes/dvoacap/score_ve3sun.py score --paths "$P"            # ~20 s
python apps/radio/spikes/dvoacap/score_ve3sun.py score --paths "$P" --ssn-scale 0.6
python apps/radio/spikes/dvoacap/score_ve3sun.py bench --paths "$P"
```
