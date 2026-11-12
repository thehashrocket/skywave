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

## Later deploys

```sh
ssh deploy@<droplet> 'cd skywave && deploy/deploy.sh'          # main
ssh deploy@<droplet> 'cd skywave && deploy/deploy.sh my-branch'
```

A restart drops every listener and closes their Kiwi channels cleanly within
the 40 s stop period, so deploy when nobody's listening. The main README's
"Deploy order" notes still apply when a change touches the protocol.

## Changing the config

- `apps/radio/.env`: `docker compose -f docker-compose.prod.yml up -d radio`
  (compose recreates the container when its env changes).
- `Caddyfile`: `docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.
  A reload gives open sockets up to 5 minutes (`stream_close_delay`) before cutting them.

## Rotating the token

Set a new `RADIO_TOKEN`, recreate `radio`, then update `NEXT_PUBLIC_RADIO_TOKEN`
on Vercel and redeploy the web app. Pages built with the old token can't connect
in between, so do both back to back.
