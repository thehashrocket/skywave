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
the last 24 h, and, on builds with the receiver log (#144), refusals by code and
the most listeners seen per hour. Counts only: it never prints log lines,
addresses, the token or anything else from `.env`. Changes nothing.

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
`ssh deploy@<droplet>`. Remove the line to revoke it.

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
