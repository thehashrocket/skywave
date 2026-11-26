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
#      uvicorn process with --native at 20 Hz, from when py-spy starts sampling.
#
# py-spy runs on the same single core as the radio and pauses it for each
# sample, and that process streams every listener's audio. So it isn't
# attached when the baseline shows the host over 70% busy (--force overrides
# that), with under 250 MB of memory free, or if the radio restarted during
# the baseline; the kernel is told to kill py-spy, not the radio, if memory
# runs out; and py-spy is stopped as soon as the radio misses two /healthz
# answers in a row. Keep the window short and listen for gaps while it runs.
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
# Memory py-spy --native needs headroom for (its symbol tables), in MB.
MIN_AVAILABLE_MB=250

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
# box doesn't spill one phase's rows into the next. In the profile phase it is
# also the watchdog: two /healthz probes in a row the radio doesn't answer
# within 2 s mean py-spy is starving it, so py-spy is stopped (stop_spy also
# resumes the radio) and the reason goes in $out/aborted.
sample() {
  local phase=$1 window=$2 rows=$(($2 / INTERVAL_S)) start=$SECONDS i pause listeners stats radio_cpu caddy_cpu misses=0
  for ((i = 1; i <= rows; i++)); do
    ((SECONDS - start >= window)) && break
    listeners=$(curl -s --max-time 2 "http://$radio_ip:8765/healthz" | grep -oE '"listeners": ?[0-9]+' | grep -oE '[0-9]+$' || true)
    # One call for both: {{.Container}} echoes the ID as given.
    stats=$(docker stats --no-stream --format '{{.Container}} {{.CPUPerc}}' "$radio" ${caddy:+"$caddy"} || true)
    radio_cpu=$(awk -v id="$radio" '$1 == id { sub(/%/, "", $2); print $2 }' <<<"$stats")
    caddy_cpu=$(awk -v id="$caddy" 'id != "" && $1 == id { sub(/%/, "", $2); print $2 }' <<<"$stats")
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%H:%M:%S)" "$phase" "${listeners:--}" "${radio_cpu:--}" "${caddy_cpu:--}" >>"$out/samples.tsv"
    # Without an address there is nothing to judge the radio by.
    if [[ $phase == profile && -n "$radio_ip" && -n "$spy_pid" ]]; then
      if [[ -z "$listeners" ]]; then misses=$((misses + 1)); else misses=0; fi
      if ((misses >= 2)); then
        echo "the radio stopped answering /healthz (twice in a row) with py-spy attached, so py-spy was stopped" >"$out/aborted"
        stop_spy
        [[ -n "$radio_pid" ]] && kill -CONT "$radio_pid" 2>/dev/null
        break
      fi
    fi
    pause=$((start + i * INTERVAL_S - SECONDS))
    ((pause > 0)) && sleep "$pause"
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

# On any exit, Ctrl-C or a dropped SSH session: stop py-spy first (its pauses
# are the only thing here that touches listeners), then the samplers. SIGINT,
# not SIGTERM: py-spy finishes the sample it's on and lets go of the process.
# It starts with SIGINT ignored (bash ignores it for background jobs), so
# that relies on py-spy's own Ctrl-C handler. Then SIGTERM, then SIGKILL (a
# tracer's death detaches it), after 2 s and 1 s: a py-spy stuck while holding
# the radio stopped freezes everyone's audio until then. The radio gets a
# SIGCONT before and after the last wait in case it was left paused; to a
# running process that does nothing.
spy_pid= radio_pid=
stop_spy() {
  local sig ticks t
  for sig in INT TERM; do
    kill "-$sig" "$spy_pid" 2>/dev/null || return 0
    ticks=20 # tenths of a second: 2 s after SIGINT, 1 s after SIGTERM
    [[ $sig == TERM ]] && ticks=10
    for ((t = 0; t < ticks; t++)); do
      kill -0 "$spy_pid" 2>/dev/null || return 0
      sleep 0.1
    done
  done
  [[ -n "$radio_pid" ]] && kill -CONT "$radio_pid" 2>/dev/null
  kill -KILL "$spy_pid" 2>/dev/null
}
cleanup() {
  set +e
  if [[ -n "$spy_pid" ]]; then
    stop_spy
    wait "$spy_pid" 2>/dev/null
  fi
  [[ -n "$radio_pid" ]] && kill -CONT "$radio_pid" 2>/dev/null
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
  [[ -z "$radio_ip" ]] && echo "warning: the radio container has no network address; listener counts will show as -" >&2

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
  mem=$(available_mb)
  if [[ ! "$mem" =~ ^[0-9]+$ ]]; then
    refuse "couldn't read free memory (free -m), and py-spy --native needs ${MIN_AVAILABLE_MB} MB to spare."
  elif ((mem < MIN_AVAILABLE_MB)); then
    refuse "only ${mem} MB of memory available (under ${MIN_AVAILABLE_MB}); py-spy --native could push the radio into swap."
  fi

  # The pid read before the baseline must still be the radio's: if its
  # container restarted meanwhile, the pid may now belong to anything.
  if [[ "$("${compose[@]}" ps -q radio || true)" != "$radio" ||
    "$(docker inspect -f '{{.State.Pid}}' "$radio" 2>/dev/null || true)" != "$pid" ]]; then
    refuse "the radio container restarted during the baseline, so its pid changed. Run it again."
  fi

  echo "profile: ${seconds} s, py-spy --native at ${RATE_HZ} Hz on pid $pid (listen for audio gaps)"
  local spy=0 pending= t
  # The radio is resumed by any exit from here on. From starting py-spy until
  # its pid is noted (cleanup needs it to stop py-spy cleanly), a Ctrl-C, TERM
  # or HUP is only recorded, then acted on at once. The subshell gets those
  # signals' default actions back (bash resets trapped signals in children),
  # except SIGINT, which bash ignores in background jobs; py-spy's own Ctrl-C
  # handler overrides that.
  radio_pid=$pid
  trap 'pending=1' INT TERM HUP
  # oom_score_adj 1000: if memory runs out, the kernel kills py-spy, not the radio.
  # --function: one row per function, not per line it was on when sampled.
  # --threads: each stack starts with its thread, so the inclusive view below
  # shows the event loop apart from the noise store's and DNS lookups' threads.
  (
    echo 1000 2>/dev/null >/proc/self/oom_score_adj || echo "warning: couldn't set py-spy's oom_score_adj" >&2
    exec "$spy_bin" record --pid "$pid" --native --function --threads --rate "$RATE_HZ" --duration "$seconds" \
      --format raw --output "$out/radio.raw"
  ) >"$out/py-spy.log" 2>&1 &
  spy_pid=$!
  trap 'exit 130' INT TERM HUP
  [[ -z "$pending" ]] || exit 130
  # Sample from when py-spy starts sampling (its --duration starts then too,
  # after it has loaded the radio's symbols), so both windows match. Up to
  # 30 s for that; if py-spy ends first, sample anyway for the record.
  for ((t = 0; t < 300; t++)); do
    grep -q "Sampling process" "$out/py-spy.log" 2>/dev/null && break
    kill -0 "$spy_pid" 2>/dev/null || break
    sleep 0.1
  done
  vmstat -n "$INTERVAL_S" $((seconds / INTERVAL_S + 1)) >"$out/vmstat-profile.txt" &
  sample profile "$seconds" &
  wait "$spy_pid" || spy=$?
  spy_pid=
  # However py-spy ended, don't leave the radio paused while the samplers finish.
  kill -CONT "$radio_pid" 2>/dev/null || true
  wait

  busy=$(vmstat_busy "$out/vmstat-profile.txt")
  {
    echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $(hostname)  cpus=$(nproc)  $("$spy_bin" --version)"
    echo
    echo "== baseline (${BASELINE_S} s, no profiler)"
    echo "  $(phase_avg baseline)"
    echo "  $(vmstat_avg "$out/vmstat-baseline.txt")"
    echo
    echo "== profile (${seconds} s, py-spy attached)"
    echo "  radio_cpu isn't comparable with the baseline: py-spy's pauses can only lower it."
    echo "  py-spy runs on the host, so its own CPU is in host us/sy here, not in radio_cpu."
    echo "  $(phase_avg profile)"
    echo "  $(vmstat_avg "$out/vmstat-profile.txt")"
    if grep -q "^warning: couldn't set py-spy's oom_score_adj" "$out/py-spy.log"; then
      echo "  warning: py-spy's OOM score couldn't be set, so the radio wasn't protected if memory ran out."
    fi
    if ((busy >= WARN_BUSY)); then
      echo "  warning: the host was ${busy}% busy with py-spy attached: audio may have stuttered and these numbers are skewed. Try a quieter hour or a shorter window."
    fi
    echo
    if [[ -s "$out/aborted" ]]; then
      echo "== aborted: $(cat "$out/aborted")"
      echo
    fi
    if ((spy != 0)) || [[ ! -s "$out/radio.raw" ]]; then
      echo "== py-spy failed (exit $spy): see py-spy.log"
      sed 's/^/  /' "$out/py-spy.log"
    else
      # py-spy says on stderr when it fell behind or hit errors; a run like
      # that still finishes, with numbers that read too low.
      if grep -v "^warning: couldn't set" "$out/py-spy.log" | grep -qiE 'behind|inaccurate|error|warn'; then
        echo "== py-spy warnings (its numbers may read low):"
        grep -v "^warning: couldn't set" "$out/py-spy.log" | grep -iE 'behind|inaccurate|error|warn' | sed 's/^/  /'
      fi
      # Collapsed stacks: "frame;frame;...;leaf count". Frames are keyed
      # without their line number. py-spy leaves out idle samples, so the count
      # against duration x rate says how busy the process was, summed over its
      # threads (it can pass 100%). Shares below are of those non-idle samples:
      # a thread's share times that busy % is its share of one core, which for
      # the event loop should roughly match the baseline radio_cpu.
      awk -v want=$((seconds * RATE_HZ)) '{ n = $NF; total += n }
           END { printf "== py-spy: %d non-idle samples of about %d per thread (%.0f%% busy, all threads)\n", total, want, 100 * total / want }' "$out/radio.raw"
      # Self time: only the innermost frame of each sample.
      echo "== top 20 functions by self time (% of non-idle samples)"
      awk '{ n = $NF; total += n; sub(/ [0-9]+$/, ""); k = split($0, f, ";"); leaf = f[k]
             sub(/:[0-9]+\)$/, ")", leaf); self[leaf] += n }
           END { for (s in self) printf "%6.1f%%  %s\n", 100 * self[s] / total, s }' "$out/radio.raw" \
        | sort -rn | head -20 | sed 's/^/  /'
      # Inclusive time: every frame on the stack, once per sample even when it
      # recurses. This is what names a path (send, Kiwi receive, scans, audio).
      echo "== top 25 functions by inclusive time (% of non-idle samples)"
      awk '{ n = $NF; total += n; sub(/ [0-9]+$/, ""); k = split($0, f, ";"); delete seen
             for (i = 1; i <= k; i++) { fr = f[i]; sub(/:[0-9]+\)$/, ")", fr)
               if (!(fr in seen)) { seen[fr] = 1; inc[fr] += n } } }
           END { for (s in inc) printf "%6.1f%%  %s\n", 100 * inc[s] / total, s }' "$out/radio.raw" \
        | sort -rn | head -25 | sed 's/^/  /'
    fi
  } | tee "$out/summary.txt"
  echo
  echo "saved in $out"
}

main
