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
| `Caddyfile` | TLS for `RADIO_DOMAIN`; proxies `/ws` and `/healthz`, 404s the rest |
| `setup-droplet.sh` | One-time box setup: updates + unattended-upgrades, Docker, log rotation, 1 GB swap, ufw, a `deploy` user |
| `deploy.sh` | Pull, rebuild, restart, wait for healthy |
| `forced-command.sh` | The only command the GitHub Actions key may run on the box |
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
   (Production) and redeploy: `NEXT_PUBLIC_` values are baked in at build time.

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

## Changing the config

- `apps/radio/.env`: `docker compose -f docker-compose.prod.yml up -d radio`
  (compose recreates the container when its env changes).
- `Caddyfile`: `docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.
  A reload gives open sockets up to 5 minutes (`stream_close_delay`) before cutting them.

## Rotating the token

Set a new `RADIO_TOKEN`, recreate `radio`, then update `NEXT_PUBLIC_RADIO_TOKEN`
on Vercel and redeploy the web app. Pages built with the old token can't connect
in between, so do both back to back.
