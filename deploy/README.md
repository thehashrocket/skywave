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
| `Caddyfile` | TLS for `RADIO_DOMAIN`; proxies `/ws`, `/healthz` and `/noise`, 404s the rest |
| `setup-droplet.sh` | One-time box setup: updates + unattended-upgrades, Docker, log rotation, 1 GB swap, ufw, a `deploy` user |
| `deploy.sh` | Pull, rebuild, restart, wait for healthy |
| `forced-command.sh` | The only command the GitHub Actions key may run on the box |
| `../.github/workflows/radio-stats.yml` | Posts `stats.sh` output daily to the `radio-load` issue |
| `stats.sh` | Read-only load numbers (CPU, memory, open sockets, sessions per hour, refusals); also the only command the monitoring key may run |
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
`suppressed` to get them all.

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
the last 24 h, and refusals by code and the most listeners seen per hour from the
receiver log (#144). It reads that log from the `RECEIVER_LOG` file and its
rotated copies inside the container, plus any receiver lines in the container's
own logs (where they go if the file can't be opened), and keeps the last 24 h.
Session counts come from the container's own logs, which a deploy that recreates
the container deletes; on such a day the report says "since <time>; earlier
hours were in the previous container". When Docker's own log cap (10 MB x 5)
has already dropped lines from inside the 24 h, it says how far back the logs
reach instead. A section it can't read (say the
container is restarting) says so and the rest of the report still prints.
Counts only: it never prints log lines, addresses, the token or anything else
from `.env`. Changes nothing.

### Daily load log

`.github/workflows/radio-stats.yml` runs `stats.sh` every day at 17:07 UTC
(after the 10:00-16:00 UTC peak) and posts the output as a comment on the open
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
   shows each hour's average and maximum. Without it that section says
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
