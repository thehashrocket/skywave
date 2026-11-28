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
  # (YYYY-MM-DDTHH:MM:SS, UTC) and compared to it as text. The clock is read
  # once and the cutoff derived from it, so the window is exactly 24 h and its
  # two days are the ones the CPU section reads, even if midnight turns mid-run.
  local now cutoff
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cutoff=$(date -u -d "$now - 24 hours" +%Y-%m-%dT%H:%M:%S)

  # Per-hour rows ("YYYY-MM-DDTHH N" on stdin, sorted), indented by $1. The
  # window's first and last hours are partial, so they say from or to when
  # rather than read as quiet hours. Runs aren't exactly 24 h apart (GitHub
  # starts scheduled runs late, by hours), so neighbouring reports can overlap
  # or leave a gap: the window= line says what this one covers.
  hour_rows() {
    awk -v ind="$1" -v first="${cutoff:0:13}" -v from="${cutoff:11:5}" \
        -v last="${now:0:13}" -v to="${now:11:5}" '
      { note = ""
        if ($1 == first) note = "  (from " from ")"
        else if ($1 == last) note = "  (so far, to " to ")"
        printf "%s%s  %s%s\n", ind, $1, substr($0, length($1) + 2), note }'
  }

  echo "== $now $(hostname)"
  echo "window=${cutoff}Z..$now"
  echo "cpus=$(nproc)  load=$(cut -d' ' -f1-3 /proc/loadavg)  up=$(uptime -p | sed 's/^up //')"
  free -m | awk '/^Mem:/ {printf "mem_total=%sMB  mem_used=%sMB  mem_available=%sMB\n", $2, $3, $7}'
  [[ -f /var/run/reboot-required ]] && echo "reboot_required=yes" || echo "reboot_required=no"

  echo
  echo "== limits (apps/radio/.env)"
  grep -E '^MAX_[A-Z_]+=' apps/radio/.env | sed 's/^/  /' || echo "  (none set: service defaults)"

  echo
  echo "== containers"
  # Like every docker read below: a failure (container restarting) skips this
  # line, not the rest of the report.
  docker stats --no-stream --format '  {{.Name}}  cpu={{.CPUPerc}}  mem={{.MemUsage}}' \
    "$radio" ${caddy:+"$caddy"} 2>/dev/null || echo "  (couldn't read the containers' CPU and memory)"
  docker inspect -f '  radio started={{.State.StartedAt}}  health={{.State.Health.Status}}' "$radio" 2>/dev/null \
    || echo "  (couldn't read the radio container's start and health)"

  echo
  echo "== open now"
  # The container's TCP table, established only (st 01). Local port 8765
  # (0x223D) is a browser socket through Caddy; anything else it dialed out is a
  # Kiwi socket (audio, waterfall and band scans; noise levels come from those
  # waterfall frames, never from a socket of their own, see noise.py). A failed
  # exec (container restarting) skips this section, not the rest of the report,
  # and a kernel without IPv6 has no tcp6.
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
  # Docker keeps 10 MB x 5 of the container's log (docker-compose.prod.yml), so
  # a heavy day can push lines from inside the window out. The log runs from the
  # container's creation (a restart keeps it), so a complete one starts before
  # the window, or within a couple of minutes of a creation inside it. A first
  # kept line later than that means the rest was dropped.
  local first expected=$cutoff
  first=$(docker logs -t "$radio" 2>&1 | head -n 1) || true
  first=${first:0:19}
  if [[ -n "$created" && "$created" > "$cutoff" ]]; then
    expected=$(date -u -d "${created}Z + 2 minutes" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "$created")
  fi
  if (( logs_ok )) && [[ $first =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T && ! "$first" < "$expected" ]]; then
    echo "  (container logs only reach back to ${first}Z; older lines were rotated out)"
  fi
  if (( ! logs_ok )); then
    echo "  (couldn't read the container's logs)"
  else
    # Accepted only: uvicorn logs a refused handshake as '"WebSocket /ws" 403'.
    # Anchored at the end: the path in the line carries the client's query string.
    grep -E '"WebSocket /ws[^"]*" \[accepted\]$' <<<"$logs" | cut -c1-13 | sort | uniq -c \
      | awk '{print $2, $1}' | hour_rows "  " | grep . || echo "  (none)"
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
      # Only a line that starts with a timestamp can be dated against the cutoff.
      if (ts !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/) next
      if (ts >= cutoff) print ts substr($0, i) }'
  local file_events file_ok=1 events
  # shellcheck disable=SC2016  # $RECEIVER_LOG expands inside the container
  # A set RECEIVER_LOG whose live file is missing (wrong path, volume not
  # mounted) is a failed read, not an empty day; missing rotated copies are normal.
  # A rotation while the copies are read (the live file gets a new inode) can
  # skip one file's lines, so that read counts as failed too, and so does an
  # inode that can't be read: a check that can't run doesn't pass.
  file_events=$(docker exec "$radio" sh -c \
      'f=${RECEIVER_LOG:-}; [ -z "$f" ] && exit 0; [ -r "$f" ] || exit 3
       i=$(stat -c %i "$f" 2>/dev/null); [ -n "$i" ] || exit 4
       cat "$f.4" "$f.3" "$f.2" "$f.1" "$f" 2>/dev/null
       j=$(stat -c %i "$f" 2>/dev/null); [ -n "$j" ] && [ "$j" = "$i" ] || exit 4; exit 0' 2>/dev/null \
    | awk -v cutoff="$cutoff" "$to_events") || { file_ok=0; file_events=; } # a cut-short read counts nothing
  # The file keeps 5 MB x 5 (server.py), so a heavy day can delete lines from
  # inside the window too: the oldest copy (.4) starting inside it means so.
  local oldest=""
  if (( file_ok )); then
    # shellcheck disable=SC2016  # $RECEIVER_LOG expands inside the container
    oldest=$(docker exec "$radio" sh -c \
        'f=${RECEIVER_LOG:-}; [ -n "$f" ] && [ -r "$f.4" ] && head -n 1 "$f.4"' 2>/dev/null) || true
    oldest=$(awk 'NR == 1 && length($1) == 10 { print $1 "T" substr($2, 1, 8) }' <<<"$oldest")
  fi
  events=$(printf '%s\n%s\n' "$file_events" \
    "$(awk -v cutoff="$cutoff" "$to_events" <<<"$logs")" | grep -F ' event=' || true)
  echo
  echo "== receiver log, last 24 h"
  if (( ! file_ok && ! logs_ok )); then
    echo "  (couldn't read the receiver log file or the container's logs)"
  elif (( ! file_ok )); then
    echo "  (couldn't read the receiver log file; only the container's logs are counted)"
  elif (( ! logs_ok )); then
    echo "  (couldn't read the container's logs; only the receiver log file is counted)"
  fi
  if [[ $oldest =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T && ! "$oldest" < "$cutoff" ]]; then
    echo "  (receiver log file only reaches back to ${oldest}Z; older lines were rotated out)"
  fi
  if [[ -z "$events" ]]; then
    # "No lines" only when both places were read: otherwise the lines may be
    # in the one that wasn't, and it would read as a quiet day.
    if (( file_ok && logs_ok )); then
      echo "  (no receiver-log lines in the last 24 h)"
    fi
  else
    echo "  by event and code:"
    # The service writes one refusal line per receiver and code every 10 s
    # (session.py REFUSED_LOG_INTERVAL_S) and holds the rest back: the next
    # line carries suppressed=N for them, and a session that closes mid-burst
    # writes a detail=throttled line that is only those N, not a refusal of its
    # own. So a line counts 1 (0 if throttled) plus its suppressed=N, not 1.
    # A day of only event=dropped notes has no code= field: say so, don't exit.
    awk '{ ev = code = ""; own = 1; held = 0
           for (i = 2; i <= NF; i++) {
             if ($i ~ /^event=/ && ev == "") ev = $i
             else if ($i ~ /^code=/ && code == "") code = $i
             else if ($i == "detail=throttled") own = 0
             else if ($i ~ /^suppressed=[0-9]+$/) held = substr($i, 12) + 0 }
           if (ev != "" && code != "") n[ev " " code] += own + held }
         END { for (k in n) if (n[k] > 0) print n[k], k }' <<<"$events" \
      | sort -k1,1rn -k2 | awk '{printf "    %5d  %s %s\n", $1, $2, $3}' | grep . \
      || echo "    (none)"
    echo "  most listeners per hour:"
    awk '{ h = substr($1, 1, 13); for (i = 2; i <= NF; i++) if ($i ~ /^listeners=/) {
             split($i, a, "="); if (a[2] + 0 > m[h]) m[h] = a[2] + 0 } }
         END { for (h in m) print h, m[h] }' <<<"$events" | sort | hour_rows "    " \
      | grep . || echo "    (none)"
  fi

  # Host CPU by hour over the same window, from sysstat's samples (every 10 min
  # once it's enabled: see deploy/README.md). sysstat keeps one file per UTC
  # day; the window spans two, read by the window's own dates (not sar's
  # "today", which moves if this run crosses midnight). A run just after
  # midnight (GitHub starts it hours late) needs yesterday's for the peak.
  echo
  echo "== host CPU busy % per hour, last 24 h (UTC; avg / max of 10-min samples)"
  if ! command -v sar >/dev/null; then
    echo "  (sysstat not installed)"
  else
    # One day's samples from $cutoff on, as "YYYY-MM-DDTHH busy" lines. Exit 3:
    # no file or sar failed; 4: the file is from another date (a leftover of
    # the same day of the month after collection stopped).
    cpu_samples() {
      local day=$1 file out
      file=/var/log/sysstat/sa${day//-/}                    # HISTORY > 28 names
      [[ -e $file ]] || file=/var/log/sysstat/sa${day:8:2}  # the default saDD
      out=$(S_TIME_FORMAT=ISO LC_ALL=C sar -u -f "$file" 2>/dev/null) || return 3
      # shellcheck disable=SC2016  # awk's own $1/$2/$NF, not the shell's
      awk -v day="$day" -v next_day="$(date -u -d "$day + 1 day" +%Y-%m-%d)" -v cutoff="$cutoff" '
        NR == 1 { for (i = 1; i <= NF; i++)
                    if ($i ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) fday = $i
                  if (fday != day) { stale = 1; exit }
                  d = day; next }
        $1 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ && $2 == "all" {
          # sysstat can end a file with a 00:00 record of the next day. Only a
          # wrap from 23:xx to 00:xx is that; any other step back (the clock
          # was set back) stays on this day, so its hours keep their date.
          if ($1 < last && last >= "23:" && $1 < "01:") d = next_day
          last = $1
          ts = d "T" $1; if (ts >= cutoff) print substr(ts, 1, 13), 100 - $NF }
        END { if (stale) exit 4 }' <<<"$out"
    }
    local day samples="" got
    for day in "${cutoff:0:10}" "${now:0:10}"; do
      if got=$(cpu_samples "$day"); then
        samples+=$got$'\n'
      elif (( $? == 4 )); then
        echo "  (sysstat's file for $day is from another date; its hours aren't counted)"
      else
        echo "  (couldn't read sysstat's file for $day; its hours aren't counted)"
      fi
    done
    local rows
    rows=$(awk 'NF == 2 { n[$1]++; sum[$1] += $2; if (!($1 in max) || $2 > max[$1]) max[$1] = $2 }
         END { for (h in n) printf "%s %5.1f / %5.1f\n", h, sum[h] / n[h], max[h] }' <<<"$samples" | sort)
    if [[ -z $rows ]]; then
      echo "  (no samples in the window)"
    else
      # A whole hour with no sample (box down, collection stopped) has no row;
      # say how many, so a gap over the peak doesn't read as a calm day. The
      # two partial end hours can lack a sample legitimately, so they're left out.
      local i h whole=0 missing=0
      for (( i = 1; i < 24; i++ )); do
        h=$(date -u -d "${cutoff:0:13}:00:00Z + $i hour" +%Y-%m-%dT%H)
        (( whole += 1 ))
        grep -q "^$h " <<<"$rows" || (( missing += 1 ))
      done
      (( missing == 0 )) || echo "  (no samples in $missing of the window's $whole whole hours; those hours have no row)"
      hour_rows "  " <<<"$rows"
    fi
  fi
}

main
