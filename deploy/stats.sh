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

  # The last 24 h starts here. Every timestamp below is put in this same form
  # (YYYY-MM-DDTHH:MM:SS, UTC) and compared to it as text.
  local cutoff
  cutoff=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)

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
  # Kiwi socket (audio, waterfall, scans and noise measurements). A failed exec
  # (container restarting) skips this section, not the rest of the report, and
  # a kernel without IPv6 has no tcp6.
  local tcp
  if tcp=$(docker exec "$radio" cat /proc/net/tcp 2>/dev/null); then
    tcp+=$'\n'$(docker exec "$radio" cat /proc/net/tcp6 2>/dev/null || true)
    awk '
      $4 == "01" { split($2, a, ":"); if (a[2] == "223D") ws++; else kiwi++ }
      END { printf "  browser_sockets=%d  kiwi_sockets=%d\n", ws, kiwi }' <<<"$tcp"
  else
    echo "  (couldn't read the container's sockets)"
  fi

  # The container's own logs (uvicorn writes to stderr, hence 2>&1). They go
  # when a deploy recreates the container; a restart keeps them.
  local logs logs_ok=1
  logs=$(docker logs -t --since 24h "$radio" 2>&1) || { logs_ok=0; logs=; }

  echo
  echo "== /ws sessions opened per hour, last 24 h (UTC)"
  local created
  created=$(docker inspect -f '{{.Created}}' "$radio" 2>/dev/null || true)
  created=${created:0:19}
  if [[ -n "$created" && ! "$created" < "$cutoff" ]]; then
    echo "  (since ${created}Z; earlier hours were in the previous container)"
  fi
  if (( ! logs_ok )); then
    echo "  (couldn't read the container's logs)"
  else
    grep 'WebSocket /ws' <<<"$logs" | cut -c1-13 | sort | uniq -c | awk '{printf "  %s  %s\n", $2, $1}' \
      || echo "  (none)"
  fi

  # Receiver-log lines (#144): refusals by code and the most listeners seen per
  # hour. With RECEIVER_LOG set (production) the service writes them to that
  # file and its rotated copies (.1-.4), not to its own logs; if it can't open
  # the file they go to its logs instead. Each line is in exactly one of the
  # two, so both are read and joined, with no dedupe.
  #
  # File lines start "2026-11-26 09:21:00,123" in the container's local time,
  # which is UTC (python:3.13-slim sets no TZ); docker's start
  # "2026-11-26T09:21:00.000000000Z". Both become "2026-11-26T09:21:00 event=..."
  # and are cut at $cutoff as they stream, so the rotated files (up to 25 MB)
  # are never held whole.
  # shellcheck disable=SC2016  # awk's own $1/$2/$0, not the shell's
  local to_events='
    { i = index($0, " event="); if (!i) next
      if (length($1) == 10 && substr($1, 5, 1) == "-") ts = $1 "T" substr($2, 1, 8)
      else ts = substr($1, 1, 19)
      if (ts >= cutoff) print ts substr($0, i) }'
  local file_events file_ok=1 events
  # shellcheck disable=SC2016  # $RECEIVER_LOG expands inside the container
  file_events=$(docker exec "$radio" sh -c \
      'f=${RECEIVER_LOG:-}; [ -z "$f" ] || cat "$f.4" "$f.3" "$f.2" "$f.1" "$f" 2>/dev/null; exit 0' \
    | awk -v cutoff="$cutoff" "$to_events") || file_ok=0
  events=$(printf '%s\n%s\n' "$file_events" \
    "$(awk -v cutoff="$cutoff" "$to_events" <<<"$logs")" | grep -F ' event=' || true)
  echo
  echo "== receiver log, last 24 h"
  if (( ! file_ok )); then
    echo "  (couldn't read the receiver log file; only the container's logs are counted)"
  fi
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
