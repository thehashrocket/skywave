#!/usr/bin/env bash
# Where the radio service spends its CPU, measured on the live box (issue #153,
# "Step 0"). Run on the Droplet as root during a moderately busy hour, not the
# very top of a peak:
#
#   sudo ~/skywave/deploy/profile.sh [--force] [seconds]     # default 120, 30-300
#
# Two windows, back to back:
#   1. baseline (60 s): host CPU incl. steal (vmstat), both containers' CPU and
#      the listener count from /healthz, every 5 s. No profiler attached.
#   2. profile (<seconds>): the same samples while py-spy records the radio's
#      uvicorn process at 20 Hz, from when py-spy starts sampling.
#
# py-spy runs with --nonblocking: it reads the radio's memory without ever
# pausing it, so nothing py-spy does, or fails to do, can freeze the process
# that streams every listener's audio. The costs: Python-level stacks (time
# spent inside C code, such as NumPy, zlib or websockets' speedups, shows under
# the Python line that called it), and samples read while the radio keeps
# running, which py-spy warns "may lead to inaccurate results": some are
# garbled or charged to the wrong function, so only a clear leader counts as a
# hot spot (the summary says so). A --native run, which has to pause the radio for
# each sample, is a separate, deliberate step if C code turns out to dominate.
#
# py-spy still uses CPU on the same single core. So it isn't attached when the
# baseline shows the host over 70% busy (--force overrides that and the next
# one), with no radio address for the /healthz watchdog, with under 250 MB of
# memory free, or if the radio restarted during the baseline; the kernel is
# told to kill py-spy, not the radio, if memory runs out; and from its launch
# py-spy is stopped as soon as the radio misses two /healthz answers in a row.
#
# Needs py-spy on the host, on root's PATH or in its own venv (Ubuntu's pip
# won't install into the system Python, and stock Ubuntu lacks venv):
#
#   sudo apt install -y python3-venv && sudo python3 -m venv /opt/py-spy && sudo /opt/py-spy/bin/pip install py-spy
#
# This script installs nothing and changes nothing on the box. Everything goes
# to one new folder ($PROFILE_OUT, which must not exist yet, or by default a
# fresh /var/tmp/skywave-profile-<UTC time>-XXXXXX): summary.txt, samples.tsv,
# vmstat-*.txt and radio.raw (collapsed stacks: open it at
# https://www.speedscope.app for the flame graph).
set -euo pipefail

BASELINE_S=60
INTERVAL_S=5
RATE_HZ=20
# Host busy (us + sy + steal) above which py-spy isn't attached without --force.
MAX_BASELINE_BUSY=70
# Host busy during the profile at which the summary says the numbers are skewed.
WARN_BUSY=95
# Memory to keep free for the radio while py-spy runs beside it, in MB.
MIN_AVAILABLE_MB=250
# The watchdog: a /healthz probe every WATCH_S, each given WATCH_TIMEOUT_S, and
# WATCH_MISSES misses in a row stop py-spy (SIGINT, then SIGTERM after 2 s,
# then SIGKILL after 1 s more). The radio ends every listener's Kiwi stream
# once audio is ~10 s late (timeout_s in apps/radio/skywave_radio/kiwi.py), so
# a radio starved of CPU by py-spy must get it back well before then:
# WATCH_MISSES * (WATCH_S + WATCH_TIMEOUT_S) + 2 s = 6 s at most here, and in
# practice py-spy stops sampling as soon as it gets SIGINT. The tests check
# this against kiwi.py.
WATCH_S=1
WATCH_TIMEOUT_S=1
WATCH_MISSES=2
# How long py-spy may take to start sampling; the profile's samplers start
# then, or after this anyway.
ATTACH_WAIT_S=30
# py-spy may run this long past its window (writing out) before the watchdog
# stops it anyway.
SPY_OVERRUN_S=30
# New "behind in sampling" warnings on this many probes in a row stop py-spy.
BEHIND_PROBES=3

force=0
if [[ "${1:-}" == --force ]]; then
  force=1
  shift
fi
seconds="${1:-120}"
# A multiple of INTERVAL_S, so the samples cover exactly the profiled window.
# No leading zero: bash would read 0454 as octal 300 while py-spy runs 454 s.
if [[ $# -gt 1 || ! "$seconds" =~ ^[1-9][0-9]*$ ]] || ((seconds < 30 || seconds > 300 || seconds % INTERVAL_S)); then
  echo "usage: $0 [--force] [seconds]   (profile window, 30-300 in steps of $INTERVAL_S; default 120)" >&2
  exit 2
fi

# One row every INTERVAL_S for $2 seconds: UTC time, phase, listeners (from
# /healthz), radio CPU %, caddy CPU %. Ticks keep to the schedule however long
# docker stats takes, and a tick past the window's end isn't taken, so a slow
# box doesn't spill one phase's rows into the next. docker stats gets 4 s at
# most, so a stalled Docker daemon can't stop the rows.
sample() {
  local phase=$1 window=$2 rows=$(($2 / INTERVAL_S)) start=$SECONDS i pause listeners stats radio_cpu caddy_cpu
  for ((i = 1; i <= rows; i++)); do
    ((SECONDS - start >= window)) && break
    listeners=$(curl -sf --max-time 2 "http://$radio_ip:8765/healthz" | grep -oE '"listeners": ?[0-9]+' | grep -oE '[0-9]+$' || true)
    # One call for both: {{.Container}} echoes the ID as given.
    stats=$(timeout 4 docker stats --no-stream --format '{{.Container}} {{.CPUPerc}}' "$radio" ${caddy:+"$caddy"} || true)
    radio_cpu=$(awk -v id="$radio" '$1 == id { sub(/%/, "", $2); print $2 }' <<<"$stats")
    caddy_cpu=$(awk -v id="$caddy" 'id != "" && $1 == id { sub(/%/, "", $2); print $2 }' <<<"$stats")
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%H:%M:%S)" "$phase" "${listeners:--}" "${radio_cpu:--}" "${caddy_cpu:--}" >>"$out/samples.tsv"
    pause=$((start + i * INTERVAL_S - SECONDS))
    ((pause > 0)) && sleep "$pause"
  done
  return 0
}

# Still our py-spy: running and not yet reaped. Once main has reaped it
# ($out/spy-done), its pid could belong to anything.
spy_alive() {
  [[ ! -e "$out/spy-done" ]] && kill -0 "$spy_pid" 2>/dev/null &&
    [[ "$(awk '{ print $3 }' "/proc/$spy_pid/stat" 2>/dev/null)" != Z ]]
}

# From py-spy's launch until it's gone, on its own so nothing else (docker
# stats, the wait for py-spy to start sampling) can hold it up. It stops py-spy
# and then writes why to $out/aborted when:
#   - the radio misses WATCH_MISSES /healthz probes in a row (no answer, or
#     an HTTP error, within WATCH_TIMEOUT_S): py-spy is starving it of CPU;
#   - py-spy keeps saying it is behind in sampling (new warnings on
#     BEHIND_PROBES probes in a row; its lag only adds up, so one hiccup
#     prints it once and is ignored): its numbers are going bad;
#   - py-spy is still attached SPY_OVERRUN_S past its window, counted from
#     when it started sampling (or from launch plus ATTACH_WAIT_S if it never
#     said so).
# set +e: a failed fork or write mustn't end the watchdog with py-spy attached.
watchdog() {
  set +e
  local misses=0 launched=$SECONDS started= behind=0 last_behind=0 n reason limit
  while spy_alive; do
    if curl -sf --max-time "$WATCH_TIMEOUT_S" -o /dev/null "http://$radio_ip:8765/healthz"; then
      misses=0
    else
      misses=$((misses + 1))
    fi
    [[ -z "$started" && -e "$out/sampling" ]] && started=$SECONDS
    n=$(grep -ci 'behind in sampling' "$out/py-spy.log" 2>/dev/null)
    if ((${n:-0} > last_behind)); then behind=$((behind + 1)); else behind=0; fi
    last_behind=${n:-0}
    if [[ -n "$started" ]]; then
      limit=$((SECONDS - started > seconds + SPY_OVERRUN_S))
    else
      limit=$((SECONDS - launched > ATTACH_WAIT_S + seconds + SPY_OVERRUN_S))
    fi
    reason=
    if ((misses >= WATCH_MISSES)); then
      reason="the radio stopped answering /healthz ($WATCH_MISSES times in a row) with py-spy attached"
    elif ((behind >= BEHIND_PROBES)); then
      reason="py-spy kept falling behind in sampling ($BEHIND_PROBES probes in a row)"
    elif ((limit)); then
      reason="py-spy was still attached $SPY_OVERRUN_S s past its window"
    fi
    if [[ -n "$reason" ]] && spy_alive; then
      stop_spy
      echo "$reason, so py-spy was stopped" >"$out/aborted" 2>/dev/null
      break
    fi
    sleep "$WATCH_S"
  done
  return 0
}

# vmstat's first row is the average since boot, so it's dropped; columns are
# found by name, since their order differs between procps versions.
vmstat_avg() {
  awk 'NR == 2 { for (i = 1; i <= NF; i++) col[$i] = i; next }
       NR > 3 { us += $col["us"]; sy += $col["sy"]; st += $col["st"]; n++ }
       END { if (n) printf "host us=%.1f%%  sy=%.1f%%  steal=%.1f%%  (%d samples)\n", us / n, sy / n, st / n, n
             else print "host: no vmstat samples" }' "$1"
}

# Average host busy (us + sy + steal) as a whole percent; empty with no samples.
vmstat_busy() {
  awk 'NR == 2 { for (i = 1; i <= NF; i++) col[$i] = i; next }
       NR > 3 { b += $col["us"] + $col["sy"] + $col["st"]; n++ }
       END { if (n) printf "%d\n", b / n + 0.5 }' "$1"
}

phase_avg() {
  awk -F'\t' -v p="$1" '$2 == p {
      rows++; if ($3 != "-") { l += $3; nl++ } if ($4 != "-") { r += $4; nr++ } if ($5 != "-") { c += $5; nc++ } }
    END { printf "listeners=%s  radio_cpu=%s%%  caddy_cpu=%s%%  (%d rows)\n",
            nl ? sprintf("%.1f", l / nl) : "-", nr ? sprintf("%.1f", r / nr) : "-", nc ? sprintf("%.1f", c / nc) : "-", rows }' "$out/samples.tsv"
}

# Stop here without attaching py-spy: the baseline and why, in summary.txt.
refuse() {
  {
    echo "== baseline (${BASELINE_S} s, no profiler)"
    echo "  $(phase_avg baseline)"
    echo "  $(vmstat_avg "$out/vmstat-baseline.txt")"
    echo
    echo "== not profiled: $1"
  } | tee "$out/summary.txt"
  echo "saved in $out"
  exit 3
}

# Free memory in MB (the "available" column), empty if it can't be read.
available_mb() {
  free -m 2>/dev/null | awk '/^Mem:/ { print $7 }' || true
}

# On any exit, Ctrl-C or a dropped SSH session: stop py-spy first (it uses CPU
# on the core the radio needs), then the samplers. SIGINT first, so py-spy
# stops sampling and writes radio.raw. It starts with SIGINT ignored (bash
# ignores it for background jobs), so that relies on py-spy's own Ctrl-C
# handler. Then SIGTERM after 2 s and SIGKILL after 1 s more.
spy_pid=
stop_spy() {
  local sig ticks t
  for sig in INT TERM; do
    spy_alive || return 0
    kill "-$sig" "$spy_pid" 2>/dev/null || return 0
    ticks=20 # tenths of a second: 2 s after SIGINT, 1 s after SIGTERM
    [[ $sig == TERM ]] && ticks=10
    for ((t = 0; t < ticks; t++)); do
      spy_alive || return 0
      sleep 0.1
    done
  done
  kill -KILL "$spy_pid" 2>/dev/null || true
}
cleanup() {
  # A second Ctrl-C (likely while a stuck py-spy is being stopped) mustn't cut
  # this short and leave py-spy running, so signals are ignored from here.
  trap '' INT TERM HUP
  set +e
  if [[ -n "$spy_pid" ]]; then
    stop_spy
    wait "$spy_pid" 2>/dev/null
    : >"$out/spy-done"
  fi
  # shellcheck disable=SC2046
  kill $(jobs -p) 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

main() {
  cd "$(dirname "$0")/.."
  spy_bin=$(command -v py-spy || true)
  [[ -z "$spy_bin" && -x /opt/py-spy/bin/py-spy ]] && spy_bin=/opt/py-spy/bin/py-spy
  if [[ -z "$spy_bin" ]]; then
    echo "py-spy isn't installed: sudo apt install -y python3-venv && sudo python3 -m venv /opt/py-spy && sudo /opt/py-spy/bin/pip install py-spy" >&2
    return 1
  fi
  local compose=(docker compose -f docker-compose.prod.yml)
  radio=$("${compose[@]}" ps -q radio)
  caddy=$("${compose[@]}" ps -q caddy)
  if [[ -z "$radio" ]]; then
    echo "radio container isn't running" >&2
    return 1
  fi
  local pid
  pid=$(docker inspect -f '{{.State.Pid}}' "$radio")
  radio_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$radio" | awk '{print $1}')
  [[ -z "$radio_ip" ]] && echo "warning: the radio container has no network address: no listener counts and no /healthz watchdog (it won't profile without --force)" >&2

  # A new folder only: root writing into one that already exists (in a
  # world-writable /var/tmp) could follow a link someone planted there.
  if [[ -n "${PROFILE_OUT:-}" ]]; then
    out=$PROFILE_OUT
    if [[ -e "$out" || -L "$out" ]]; then
      echo "$out already exists: give PROFILE_OUT a new path" >&2
      return 2
    fi
    mkdir -m 700 "$out"
  else
    out=$(mktemp -d "/var/tmp/skywave-profile-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  fi
  printf 'time\tphase\tlisteners\tradio_cpu\tcaddy_cpu\n' >"$out/samples.tsv"
  # Now, not only at the end: a Ctrl-C or a dropped session still says where.
  echo "output: $out"

  echo "baseline: ${BASELINE_S} s, no profiler"
  vmstat -n "$INTERVAL_S" $((BASELINE_S / INTERVAL_S + 1)) >"$out/vmstat-baseline.txt" &
  sample baseline "$BASELINE_S"
  wait

  local busy mem
  busy=$(vmstat_busy "$out/vmstat-baseline.txt")
  if [[ -z "$busy" ]]; then
    # Not measured is refused like too busy: the gate fails closed.
    ((force)) || refuse "couldn't measure host CPU (no vmstat samples), so py-spy could land on a busy core. Pass --force to profile anyway."
  elif ((busy > MAX_BASELINE_BUSY && !force)); then
    refuse "the host was ${busy}% busy (over ${MAX_BASELINE_BUSY}%), and py-spy on the same core could make audio choppy. Try a quieter hour, or pass --force."
  fi
  if [[ -z "$radio_ip" ]] && ((!force)); then
    refuse "the radio container has no network address, so the /healthz watchdog that stops py-spy if the radio stops answering can't run. Pass --force to profile without it."
  fi
  mem=$(available_mb)
  if [[ ! "$mem" =~ ^[0-9]+$ ]]; then
    refuse "couldn't read free memory (free -m), and the radio needs ${MIN_AVAILABLE_MB} MB to spare beside py-spy."
  elif ((mem < MIN_AVAILABLE_MB)); then
    refuse "only ${mem} MB of memory available (under ${MIN_AVAILABLE_MB}); py-spy beside the radio could push it into swap."
  fi

  # The pid read before the baseline must still be the radio's: if its
  # container restarted meanwhile, the pid may now belong to anything.
  if [[ "$("${compose[@]}" ps -q radio || true)" != "$radio" ||
    "$(docker inspect -f '{{.State.Pid}}' "$radio" 2>/dev/null || true)" != "$pid" ]]; then
    refuse "the radio container restarted during the baseline, so its pid changed. Run it again."
  fi

  echo "profile: ${seconds} s, py-spy --nonblocking at ${RATE_HZ} Hz on pid $pid"
  local spy=0 pending= t sampling=
  # From starting py-spy until its pid is noted (cleanup needs it to stop
  # py-spy), a Ctrl-C, TERM or HUP is only recorded, then acted on at once.
  # The subshell gets those signals' default actions back (bash resets trapped
  # signals in children), except SIGINT, which bash ignores in background
  # jobs; py-spy's own Ctrl-C handler overrides that.
  trap 'pending=1' INT TERM HUP
  # oom_score_adj 1000: if memory runs out, the kernel kills py-spy, not the radio.
  # --nonblocking: never pauses the radio (see the top of this file).
  # --function: one row per function, not per line it was on when sampled.
  # --threads: each stack starts with its thread, so the inclusive view below
  # shows the event loop apart from the noise store's and DNS lookups' threads.
  (
    echo 1000 2>/dev/null >/proc/self/oom_score_adj || echo "warning: couldn't set py-spy's oom_score_adj" >&2
    exec "$spy_bin" record --pid "$pid" --nonblocking --function --threads --rate "$RATE_HZ" --duration "$seconds" \
      --format raw --output "$out/radio.raw"
  ) >"$out/py-spy.log" 2>&1 &
  spy_pid=$!
  trap 'exit 130' INT TERM HUP
  [[ -z "$pending" ]] || exit 130
  # The watchdog runs from now, while py-spy is still attaching.
  [[ -n "$radio_ip" ]] && watchdog &
  # Sample from when py-spy starts sampling (its --duration starts then too),
  # so both windows match. Up to ATTACH_WAIT_S for that; if py-spy ends first,
  # sample anyway for the record. $out/sampling tells the watchdog when its
  # overrun clock starts.
  for ((t = 0; t < ATTACH_WAIT_S * 10; t++)); do
    if grep -q "Sampling process" "$out/py-spy.log" 2>/dev/null; then
      sampling=1
      : >"$out/sampling"
      break
    fi
    spy_alive || break
    sleep 0.1
  done
  vmstat -n "$INTERVAL_S" $((seconds / INTERVAL_S + 1)) >"$out/vmstat-profile.txt" &
  sample profile "$seconds" &
  wait "$spy_pid" || spy=$?
  # Reaped: from here its pid may be reused, so the watchdog stops using it.
  : >"$out/spy-done"
  spy_pid=
  wait

  busy=$(vmstat_busy "$out/vmstat-profile.txt")
  {
    echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $(hostname)  cpus=$(nproc)  $("$spy_bin" --version)"
    echo
    echo "== baseline (${BASELINE_S} s, no profiler)"
    echo "  $(phase_avg baseline)"
    echo "  $(vmstat_avg "$out/vmstat-baseline.txt")"
    echo
    echo "== profile (${seconds} s, py-spy attached, --nonblocking)"
    echo "  py-spy runs on the host, so its own CPU is in host us/sy here, not in radio_cpu."
    echo "  $(phase_avg profile)"
    echo "  $(vmstat_avg "$out/vmstat-profile.txt")"
    if grep -q "^warning: couldn't set py-spy's oom_score_adj" "$out/py-spy.log"; then
      echo "  warning: py-spy's OOM score couldn't be set, so the radio wasn't protected if memory ran out."
    fi
    if ((busy >= WARN_BUSY)); then
      echo "  warning: the host was ${busy}% busy with py-spy attached: audio may have stuttered and these numbers are skewed. Try a quieter hour or a shorter window."
    fi
    if [[ -z "$radio_ip" ]]; then
      echo "  warning: unguarded run: no radio address, so the /healthz watchdog didn't run (--force)."
    fi
    if [[ -z "$sampling" && -s "$out/radio.raw" ]]; then
      echo "  warning: py-spy never said it started sampling (\"Sampling process\"), so this window's numbers may not line up with its samples."
    fi
    echo
    if [[ -s "$out/aborted" ]]; then
      echo "== aborted: $(cat "$out/aborted")"
      echo "  The busy % below is against the whole window, so it reads low, and the"
      echo "  profile averages above include time after py-spy stopped."
      echo
    fi
    if ((spy != 0)) || [[ ! -s "$out/radio.raw" ]]; then
      echo "== py-spy failed (exit $spy): see py-spy.log"
      sed 's/^/  /' "$out/py-spy.log"
    else
      # py-spy says on stderr when it fell behind or hit errors; a run like
      # that still finishes, with numbers that read too low. Its normal last
      # line ("... Samples: N Errors: 0") isn't one of those.
      # (No grep -q or head in these pipelines: an early exit would SIGPIPE the
      # stage before it and, under pipefail, end the summary right there.)
      local warn_re='behind|inaccurate|errors: [1-9]|error:|warn' warns
      # (Its "Wrote raw flamegraph data to '<path>'" line is left out: the path
      # could contain any of these words.)
      warns=$(grep -v -e "^warning: couldn't set" -e "Wrote raw flamegraph data" "$out/py-spy.log" |
        grep -iE "$warn_re" || true)
      if [[ -n "$warns" ]]; then
        echo "== py-spy warnings (its numbers may read low):"
        sed 's/^/  /' <<<"$warns"
      fi
      # Collapsed stacks: "frame;frame;...;leaf count". Frames are keyed
      # without their line number, and are Python-level (--nonblocking): time
      # inside C code is charged to the Python line that called it. py-spy
      # leaves out idle samples, so the count against duration x rate says how
      # busy the process was, summed over its threads (it can pass 100%).
      # Shares below are of those non-idle samples: a thread's share times that
      # busy % is its share of one core, which for the event loop should
      # roughly match the baseline radio_cpu.
      awk -v want=$((seconds * RATE_HZ)) '{ n = $NF; total += n }
           END { printf "== py-spy: %d non-idle samples of about %d per thread (%.0f%% busy, all threads)\n", total, want, 100 * total / want }' "$out/radio.raw"
      echo "  --nonblocking: the radio keeps running while a sample is read, so some samples"
      echo "  are garbled or charged to the wrong function. Trust the overall shape; pick a hot"
      echo "  spot only if it clearly leads, and run again if the top entries are close."
      # Self time: only the innermost frame of each sample.
      echo "== top 20 functions by self time (% of non-idle samples; C time shows under its Python caller)"
      awk '{ n = $NF; total += n; sub(/ [0-9]+$/, ""); k = split($0, f, ";"); leaf = f[k]
             sub(/:[0-9]+\)$/, ")", leaf); self[leaf] += n }
           END { for (s in self) printf "%6.1f%%  %s\n", 100 * self[s] / total, s }' "$out/radio.raw" \
        | sort -rn | awk 'NR <= 20' | sed 's/^/  /'
      # Inclusive time: every frame on the stack, once per sample even when it
      # recurses. This is what names a path (send, Kiwi receive, scans, audio).
      echo "== top 25 functions by inclusive time (% of non-idle samples)"
      awk '{ n = $NF; total += n; sub(/ [0-9]+$/, ""); k = split($0, f, ";"); delete seen
             for (i = 1; i <= k; i++) { fr = f[i]; sub(/:[0-9]+\)$/, ")", fr)
               if (!(fr in seen)) { seen[fr] = 1; inc[fr] += n } } }
           END { for (s in inc) printf "%6.1f%%  %s\n", 100 * inc[s] / total, s }' "$out/radio.raw" \
        | sort -rn | awk 'NR <= 25' | sed 's/^/  /'
    fi
  } | tee "$out/summary.txt"
  echo
  echo "saved in $out"
}

main
