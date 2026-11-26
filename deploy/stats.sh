#!/usr/bin/env bash
# Read-only load numbers for the radio service, for deciding when to scale.
# Run on the Droplet as `deploy` (or root):  ~/skywave/deploy/stats.sh
#
# Also the only thing the monitoring key may run. Installed in
# ~deploy/.ssh/authorized_keys as:
#
#   command="/home/deploy/skywave/deploy/stats.sh",restrict ssh-ed25519 AAAA... skywave-stats
#
# It changes nothing, takes no input (SSH_ORIGINAL_COMMAND is ignored), and
# prints counts only: no log lines, addresses, tokens or other secrets. From
# apps/radio/.env it reads only the MAX_* limits.
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."
  local compose=(docker compose -f docker-compose.prod.yml)
  local radio caddy
  radio=$("${compose[@]}" ps -q radio)
  caddy=$("${compose[@]}" ps -q caddy)
  if [[ -z "$radio" ]]; then
    echo "radio container isn't running" >&2
    return 1
  fi

  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $(hostname)"
  echo "cpus=$(nproc)  load=$(cut -d' ' -f1-3 /proc/loadavg)  up=$(uptime -p | sed 's/^up //')"
  free -m | awk '/^Mem:/ {printf "mem_total=%sMB  mem_used=%sMB  mem_available=%sMB\n", $2, $3, $7}'
  [[ -f /var/run/reboot-required ]] && echo "reboot_required=yes" || echo "reboot_required=no"

  echo
  echo "== limits (apps/radio/.env)"
  grep -E '^MAX_[A-Z_]+=' apps/radio/.env | sed 's/^/  /' || echo "  (none set: service defaults)"

  echo
  echo "== containers"
  docker stats --no-stream --format '  {{.Name}}  cpu={{.CPUPerc}}  mem={{.MemUsage}}' \
    "$radio" ${caddy:+"$caddy"}
  docker inspect -f '  radio started={{.State.StartedAt}}  health={{.State.Health.Status}}' "$radio"

  echo
  echo "== open now"
  # The container's TCP table, established only (st 01). Local port 8765
  # (0x223D) is a browser socket through Caddy; anything else it dialed out is a
  # Kiwi socket (audio, waterfall and band scans; noise levels come from those
  # waterfall frames, never from a socket of their own, see noise.py).
  docker exec "$radio" cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '
    $4 == "01" { split($2, a, ":"); if (a[2] == "223D") ws++; else kiwi++ }
    END { printf "  browser_sockets=%d  kiwi_sockets=%d\n", ws, kiwi }'

  local logs started
  logs=$(docker logs -t --since 24h "$radio" 2>&1 || true)
  started=$(docker inspect -f '{{.State.StartedAt}}' "$radio" | cut -c1-16)

  echo
  echo "== /ws sessions opened per hour, last 24 h (UTC)"
  # docker logs only reach back to the container's start: a deploy that
  # rebuilds the image starts the count over.
  if [[ "$started" > "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M)" ]]; then
    echo "  (only since the container started at ${started}Z)"
  fi
  grep 'WebSocket /ws' <<<"$logs" | cut -c1-13 | sort | uniq -c | awk '{printf "  %s  %s\n", $2, $1}' \
    || echo "  (none)"

  # Receiver-log lines (#144): in production they go to RECEIVER_LOG inside the
  # container (/data/receivers.log on the volume, rotated .1 to .4, so they
  # outlive deploys), with "YYYY-MM-DD HH:MM:SS,mmm " in front. Without
  # RECEIVER_LOG they're in docker logs instead. Refusals by code and the most
  # listeners seen per hour, last 24 h.
  local events cutoff
  cutoff=$(date -u -d '24 hours ago' '+%Y-%m-%d %H:%M')
  # Oldest file first; the path is the container's own RECEIVER_LOG.
  # shellcheck disable=SC2016
  events=$(docker exec "$radio" sh -c 'f="$RECEIVER_LOG"; [ -n "$f" ] || exit 0
      for i in 4 3 2 1; do [ -f "$f.$i" ] && cat "$f.$i"; done; [ -f "$f" ] && cat "$f"; exit 0' 2>/dev/null \
    | awk -v cutoff="$cutoff" 'substr($0, 1, 16) >= cutoff && / event=/ { sub(/ /, "T"); print }' || true)
  if [[ -z "$events" ]]; then
    events=$(grep -F ' event=' <<<"$logs" || true)
  fi
  echo
  echo "== receiver log, last 24 h"
  if [[ -z "$events" ]]; then
    echo "  (no receiver-log lines in the last 24 h)"
  else
    echo "  by event and code:"
    grep -oE 'event=[a-z_]+ .* code=[A-Za-z0-9_-]+' <<<"$events" \
      | awk '{print $1, $NF}' | sort | uniq -c | sort -rn | awk '{printf "    %5d  %s %s\n", $1, $2, $3}'
    echo "  most listeners per hour:"
    awk '{ h = substr($1, 1, 13); for (i = 2; i <= NF; i++) if ($i ~ /^listeners=/) {
             split($i, a, "="); if (a[2] + 0 > m[h]) m[h] = a[2] + 0 } }
         END { for (h in m) print h, m[h] }' <<<"$events" | sort | awk '{printf "    %s  %s\n", $1, $2}'
  fi

  # Host CPU by hour, from sysstat's samples (every 10 min once it's enabled:
  # see deploy/README.md). The box keeps UTC, so this is today's UTC day so far.
  echo
  echo "== host CPU busy % per hour, today (UTC; avg / max of 10-min samples)"
  if ! command -v sar >/dev/null; then
    echo "  (sysstat not installed)"
  else
    LC_ALL=C sar -u 2>/dev/null | awk '
      $1 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ && $2 == "all" {
        h = substr($1, 1, 2); busy = 100 - $NF
        n[h]++; sum[h] += busy; if (busy > max[h]) max[h] = busy }
      END { for (h in n) printf "  %s:00  %5.1f / %5.1f\n", h, sum[h] / n[h], max[h] }' | sort \
      | grep . || echo "  (no samples yet today)"
  fi
}

main
