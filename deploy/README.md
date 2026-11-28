# Deploying the radio service to a Droplet

The web app stays on Vercel. The radio service runs on one small DigitalOcean
Droplet, behind Caddy, from `docker-compose.prod.yml`. The service needs one
long-lived process, sockets that last up to an hour and a 40 s clean stop, so a
plain VM suits it better than App Platform (whose rolling deploys briefly run two
copies, which the README's "One process" rule forbids).

## What's here

| File | Does |
| --- | --- |
| `../docker-compose.prod.yml` | `radio` (no published port) + `caddy` (80/443) on a private network with fixed addresses, so `FORWARDED_ALLOW_IPS` names Caddy and only Caddy |
| `Caddyfile` | TLS for `RADIO_DOMAIN`; proxies `/ws`, `/healthz`, `/noise` and `/held`, 404s the rest |
| `setup-droplet.sh` | One-time box setup: updates + unattended-upgrades, Docker, log rotation, 1 GB swap, ufw, a `deploy` user |
| `deploy.sh` | Pull, rebuild, restart, wait for healthy |
| `forced-command.sh` | The only command the GitHub Actions key may run on the box |
| `../.github/workflows/radio-stats.yml` | Posts `stats.sh` output daily to the `radio-load` issue |
| `stats.sh` | Read-only load numbers (CPU, memory, open sockets, sessions per hour, refusals); also the only command the monitoring key may run |
| `profile.sh` | Where the radio service spends its CPU: steal, CPU and listeners over a window, plus a py-spy profile of the live process (issue #153); run by hand as root |
| `../.github/workflows/deploy-radio.yml` | Deploys `main` after CI passes, or any branch by hand |

## First deploy

1. **Droplet.** Ubuntu 24.04, Basic, 1 GB RAM, region SFO3, your SSH key.
   Attach a Cloud Firewall allowing inbound 22, 80, 443 (TCP) and 443 (UDP) only.
   Docker writes its own iptables rules for published ports, so ufw alone isn't
   the guard.
2. **DNS.** Point `radio.<your domain>` (A, plus AAAA if you enable IPv6) at the
   Droplet. If the zone is on Cloudflare, leave it **DNS only**: a proxied record
   puts Cloudflare between Caddy and users, and every listener would share
   Cloudflare's addresses for the per-IP limits.
3. **Box setup.**
   ```sh
   scp deploy/setup-droplet.sh root@<droplet>:
   ssh root@<droplet> bash setup-droplet.sh
   ```
4. **Code and config,** as `deploy`:
   ```sh
   ssh deploy@<droplet>
   git clone <repo> skywave && cd skywave     # a deploy key if the repo is private
   echo 'RADIO_DOMAIN=radio.example.com' > .env
   cp apps/radio/.env.example apps/radio/.env
   ```
   In `apps/radio/.env`:
   - `ALLOWED_ORIGINS=https://<production hostname>` (every production hostname, comma-separated, no trailing slash; see the main README's web app step 4 before adding it)
   - `RADIO_TOKEN=<openssl rand -hex 32>`, and the same value as `NEXT_PUBLIC_RADIO_TOKEN` on Vercel (Production only)
   - leave `FORWARDED_ALLOW_IPS` out: the compose file sets it to Caddy's address
   - leave `ALLOW_PRIVATE_HOSTS=false`
5. **Start it.**
   ```sh
   docker compose -f docker-compose.prod.yml up -d --build
   curl -fsS https://radio.example.com/healthz
   ```
   Caddy fetches the certificate on the first request; if `/healthz` fails,
   `docker compose -f docker-compose.prod.yml logs caddy` says why (usually DNS
   not pointing here yet).
6. **Web app.** On Vercel set `NEXT_PUBLIC_RADIO_WS_URL=wss://radio.example.com/ws`
   (Production), and `NEXT_PUBLIC_GTM_ID` (Production only) if you want Google
   Tag Manager behind the cookie bar, then redeploy: `NEXT_PUBLIC_` values are
   baked in at build time.

## Receiver log

The radio service writes one line per receiver outcome (#144): every error a
Listen ends on, each refusal of its own (`skywave_cap`, `blocked`), and every
receiver that starts playing, with the service's load at the time (#146). In
production it goes to `/data/receivers.log` on the `radio_data` volume
(`RECEIVER_LOG` in `docker-compose.prod.yml`), rotated at 5 MB with 4 old files
kept, so a rebuild doesn't lose it the way it loses `docker compose logs`. A
writer thread does the file writes, and the lines stay out of stdout, so a slow
disk never holds up anyone's audio; if the disk stalls long enough to back up
10,000 lines, newer ones are dropped and an `event=dropped lines=N` line says
how many. Without `RECEIVER_LOG` (local development), or if the file can't be
opened (the service logs a warning and keeps running), the lines go to stdout.

A refusal that dials no Kiwi (one of Skywave's own, or an address lookup that
fails, written as `event=error`) is written at most once every 10 seconds per
receiver and code on each browser connection, so a page retrying in a loop
can't rotate the history out. The next line written for it adds
`suppressed=N`, and a connection that closes writes what it still held back
(`detail=throttled`). Past 256 receivers on one connection, the rest share one
`host=<many>` line per code. Counting lines undercounts these bursts; add up
`suppressed` to get them all. `stats.sh` does: each line counts 1 plus its
`suppressed=N`, and a `detail=throttled` line counts only its N.

```sh
docker compose -f docker-compose.prod.yml exec radio sh -c 'cat /data/receivers.log*' \
  | grep -o 'event=error .* code=[a-z_]* detail=[^ ]*' | sort | uniq -c | sort -rn | head
```

A line reads `event=error host=kiwi.example port=8073 code=busy detail=too_busy=4
audio_s=3.2 listeners=6`. `detail` holds only the Kiwi's own numbers, an HTTP
status, an error class name or a fixed word; no listener names or addresses.

## Later deploys: GitHub Actions

`Deploy radio` runs after `CI` passes on a push to `main`, and by hand from
Actions → Deploy radio → Run workflow (any branch). It SSHes in as `deploy`
with a key that can only run `deploy/forced-command.sh`, which runs
`deploy.sh <branch>`. A push that doesn't touch `apps/radio` rebuilds the same
image from cache, so the running container and its listeners are left alone;
one that does restarts the service, which drops current listeners.

One-time setup, on the Droplet as `deploy`:

```sh
ssh-keygen -t ed25519 -N "" -C github-actions -f ~/gha_key
echo "command=\"$HOME/skywave/deploy/forced-command.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/gha_key.pub)" >> ~/.ssh/authorized_keys
cat ~/gha_key            # -> secret DROPLET_SSH_KEY
ssh-keyscan -t ed25519 localhost 2>/dev/null | sed 's/^localhost/143.198.70.26/'   # -> secret DROPLET_KNOWN_HOSTS
rm ~/gha_key ~/gha_key.pub
```

Check the host key before trusting it: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
on the box must match what your Mac saw on first connect.

Then in GitHub → Settings → Secrets and variables → Actions:
- secret `DROPLET_SSH_KEY`: the private key printed above
- secret `DROPLET_KNOWN_HOSTS`: the `ssh-keyscan` line
- variable `DROPLET_HOST`: `143.198.70.26`

By hand, on the box: `~/skywave/deploy/deploy.sh [branch]`.

## Load numbers

On the box, as `deploy` or root:

```sh
~/skywave/deploy/stats.sh
```

It prints the host's CPU count, load and memory, whether a reboot is pending,
the `MAX_*` limits from `apps/radio/.env`, both containers' CPU and memory, the
browser and Kiwi sockets open right now, `/ws` sessions opened per UTC hour over
the last 24 h (accepted handshakes only: one refused at the handshake for its
site or token isn't counted, one closed for too many sockets from one address
is), and refusals by code and the most listeners seen per hour from the
receiver log (#144). It reads that log from the `RECEIVER_LOG` file and its
rotated copies inside the container, plus any receiver lines in the container's
own logs (where they go if the file can't be opened), and keeps the last 24 h.
The per-hour tables' first and last hours are partial, so they are labelled
"(from HH:MM)" and "(so far, to HH:MM)". The `window=` line gives the exact 24 h
the report covers: GitHub can start the scheduled run hours late, so two
neighbouring reports can overlap or leave a gap between them.
Session counts come from the container's own logs, which a deploy that recreates
the container deletes; on such a day the report says "since <time>; earlier
hours were in the previous container". To keep a day of sessions in those logs,
the service leaves successful `/held`, `/noise` and `/healthz` requests out of
its access log (each open page polls `/held` every minute, #155); failed ones
are still logged. When Docker's own log cap (10 MB x 5),
or the receiver log's (5 MB x 5), has already dropped lines from inside the
24 h, it says how far back that log reaches. A section it can't read (say the
container is restarting) says so and the rest of the report still prints.
Counts only: it never prints log lines, addresses, the token or anything else
from `.env`. Changes nothing.

### Where the CPU goes (profile.sh)

To see which code a busy box spends its CPU on (issue #153), as root during a
moderately busy hour, not the very top of a peak:

```sh
# once (stock Ubuntu has no venv module):
sudo apt install -y python3-venv && sudo python3 -m venv /opt/py-spy && sudo /opt/py-spy/bin/pip install py-spy
# A quick check that py-spy (0.4.x or newer, for Python 3.13) can read the
# radio from the host, before spending a busy hour on it. --nonblocking never
# pauses the radio; the timeout only stops a stuck py-spy:
cd ~/skywave && pid=$(docker inspect -f '{{.State.Pid}}' "$(docker compose -f docker-compose.prod.yml ps -q radio)")
sudo timeout -s INT -k 2 10 /opt/py-spy/bin/py-spy dump --nonblocking --pid "$pid"
# In tmux, so a dropped SSH session doesn't lose the summary (written at the end):
tmux new -s prof
sudo ~/skywave/deploy/profile.sh 120
```

It samples host CPU and steal (`vmstat`), both containers' CPU and the
`/healthz` listener count for 60 s with nothing attached, then again for the
given window (30-300 s, in steps of 5) while `py-spy record --nonblocking`
profiles the radio's process at 20 Hz. `--nonblocking` reads the radio's
memory without ever pausing it, so nothing py-spy does, or fails to do, can
freeze listeners' audio. Two costs. Stacks are Python-level, so time spent
inside C code (NumPy, zlib, websockets' speedups) shows under the Python line
that called it. And because the radio keeps running while py-spy reads a
sample, some samples come out garbled or charged to the wrong function
(py-spy's help: it "may lead to inaccurate results"). Over a 2-minute run the
overall shape holds, but small gaps between the top functions don't: pick a
hot spot only if it clearly leads, and if two entries are close, run the
profile again to confirm. A `--native` run, which has to pause the radio for every
sample, is a separate, deliberate step if C code turns out to dominate.

py-spy still uses CPU on the radio's single core, so it isn't attached at all
when the baseline shows the host over 70% busy or couldn't measure it (pass
`--force` before the window to profile anyway; the summary then warns if the
host reached 95%), with under 250 MB of memory available, if the radio's
container restarted during the baseline, or if the radio has no network
address for the watchdog to probe (`--force` again), and the kernel is told to
kill py-spy, not the radio, if memory runs out. From the moment py-spy starts,
a watchdog probes `/healthz` every second and stops py-spy within about 6 s of
the radio going quiet or answering with errors (even a py-spy that ignores
SIGINT and SIGTERM: 1 s each before the next signal; a core starved badly
enough can stretch that), inside the ~10 s after which
the radio drops its Kiwi streams. It also stops py-spy when py-spy keeps
saying it is behind in sampling, or if it is still attached 30 s past its
window (the summary says "aborted" and why). Ctrl-C or a dropped SSH session
stops py-spy too, and a second Ctrl-C while it's stopping doesn't cut that
short. The script never sends the radio a signal. The output folder is
printed first thing.

Output goes to a new `/var/tmp/skywave-profile-<time>-XXXXXX/` (or a
`PROFILE_OUT` that doesn't exist yet): `summary.txt` (averages, py-spy's own
warnings if it fell behind, the top functions by self time, and by inclusive
time with each thread's share), the raw samples, and `radio.raw`, collapsed
stacks you can open at https://www.speedscope.app for the flame graph. Shares
are of py-spy's non-idle samples: a thread's share times the summary's
"% busy" is its share of one core, which for the event loop should roughly
match the baseline `radio_cpu`. High steal means a shared-CPU plan is taking
time from the box: try a dedicated-CPU plan before changing code. Unlike
`stats.sh` it needs root and is not for the monitoring key; it changes nothing
and installs nothing.

### Daily load log

`.github/workflows/radio-stats.yml` runs `stats.sh` every day, scheduled for
17:07 UTC (after the 10:00-16:00 UTC peak; GitHub has started it hours late, so
each report's `window=` line says which 24 h it covers), and posts the output as a comment on the open
issue labelled `radio-load`. A Claude scheduled task reads that issue each
morning and only raises something when it changes: peaks near `MAX_SESSIONS`,
`full` refusals, sessions per hour climbing, hourly CPU near 100%, a pending
reboot. The repo is public, so that issue is too: it holds counts and limits,
nothing else from the box.

It needs, once:

1. **The key.** On your own machine:
   ```sh
   ssh-keygen -t ed25519 -N "" -C skywave-stats-gha -f ~/skywave-stats-key
   gh secret set DROPLET_STATS_KEY --env production -R <owner>/skywave < ~/skywave-stats-key
   cat ~/skywave-stats-key.pub
   rm ~/skywave-stats-key ~/skywave-stats-key.pub   # after the next step
   ```
2. **On the box, as `deploy`,** add the public key with the forced command (see
   "A monitoring key" below for what `restrict` does).
3. **Hourly CPU (optional).** As root: `apt-get install -y sysstat`, set
   `ENABLED="true"` in `/etc/default/sysstat`, then
   `systemctl enable --now sysstat`. It samples every 10 minutes; `stats.sh`
   shows each hour's average and maximum over the report's 24 h window,
   reading both days' files by date and saying so when one is missing or from
   another date, and how many whole hours have no samples (box down, collection
   stopped). Without it that section says
   "(sysstat not installed)".
4. **Try it:** Actions → Radio stats → Run workflow.

### A monitoring key (optional)

To let a tool or another person read these numbers without a shell on the box,
give them a key that can run `stats.sh` and nothing else, the same way the
GitHub Actions key can only deploy. Have them generate a key pair and send you
the public half, then as `deploy`:

```sh
echo 'command="/home/deploy/skywave/deploy/stats.sh",restrict <their public key> skywave-stats' >> ~/.ssh/authorized_keys
```

`restrict` turns off port, agent and X11 forwarding and the pty. Any command
they send is ignored; they always get `stats.sh`'s output:
`ssh -o IdentitiesOnly=yes -i <key> deploy@<droplet> stats` (send any word as
the command: with none, sshd prints the login banner first). Remove the line to revoke it.

`deploy` is in the `docker` group, so the key's safety rests on `stats.sh`
staying read-only. `apps/radio/tests/test_stats_script.py` checks its output
holds no token or addresses; review any change to the script with that in mind.

## Changing the config

- `apps/radio/.env`: `docker compose -f docker-compose.prod.yml up -d radio`
  (compose recreates the container when its env changes).
- `Caddyfile`: `docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.
  A reload gives open sockets up to 5 minutes (`stream_close_delay`) before cutting them.
  The Caddyfile is mounted into the container as a single file, and `git pull`
  replaces the file rather than editing it, so the container can keep reading
  the old copy and the reload changes nothing. Check a new route afterwards
  (for `/held`: `curl 'https://radio.example.com/held?receivers=a:8073'` should print
  `{"held":[]}`, not a 404; the page reads a 404 as "nothing taken", so nothing
  looks broken). If it 404s, recreate Caddy:
  `docker compose -f docker-compose.prod.yml up -d --force-recreate caddy`.
  Unlike a reload, that cuts open listeners at once.

## Noise-floor data

Each receiver's noise floor per band and UTC hour (issue #67) is kept in SQLite
at `/data/noise.sqlite3`, on the `radio_data` named volume. `deploy.sh`
(`up -d --build`, `image prune`) leaves volumes alone, so it survives redeploys;
`docker compose ... down -v` deletes it. It's only aggregates (30 days, rebuilt
from listening), so losing it costs ranking quality for a while, nothing more.
To copy it off the box:
`docker compose -f docker-compose.prod.yml cp radio:/data/noise.sqlite3 .`

## Rotating the token

Set a new `RADIO_TOKEN`, recreate `radio`, then update `NEXT_PUBLIC_RADIO_TOKEN`
on Vercel and redeploy the web app. Pages built with the old token can't connect
in between, so do both back to back.
