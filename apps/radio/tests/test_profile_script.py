"""deploy/profile.sh, run against fake docker, py-spy, vmstat, curl and sleep on PATH."""

import inspect
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "deploy" / "profile.sh"

# FAKE_NO_RADIO / FAKE_NO_CADDY: that compose service isn't running.
# FAKE_NO_IP: the radio container has no network address.
# FAKE_STATS_FAIL: every docker stats call fails.
# FAKE_PID_CHANGES: the radio's pid is different from the second lookup on,
# as after a container restart.
FAKE_DOCKER = """#!/usr/bin/env bash
case "$1 $2" in
  "compose -f") case "$6" in
      radio) [[ -n "${FAKE_NO_RADIO:-}" ]] || echo radioid;;
      caddy) [[ -n "${FAKE_NO_CADDY:-}" ]] || echo caddyid;;
    esac ;;
  "inspect -f") case "$3" in
      *Pid*)
        if [[ -n "${FAKE_PID_CHANGES:-}" && -e "$FAKE_DIR/pid-read" ]]; then echo 4194302; exit 0; fi
        : >"$FAKE_DIR/pid-read"
        echo "${FAKE_RADIO_PID:-4194303}";;
      *IPAddress*) [[ -n "${FAKE_NO_IP:-}" ]] && echo " " || echo "172.30.0.3 ";;
    esac ;;
  "stats --no-stream")
    [[ -n "${FAKE_STATS_FAIL:-}" ]] && exit 1
    # FAKE_STATS_HANG_SAMPLING: a stalled Docker daemon once py-spy samples.
    [[ -n "${FAKE_STATS_HANG_SAMPLING:-}" && -e "$FAKE_DIR/spy-started" ]] && exec /bin/sleep 30
    echo "radioid 30.00%"; echo "caddyid 10.00%" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
"""

# Collapsed stacks as py-spy --threads --format raw writes them:
# "thread;frame;...;leaf count". recv appears at two lines; the noise
# thread's _work recurses.
RAW = textwrap.dedent(
    """\
    thread (0x1);main (server.py:1);recv (kiwi.py:454);parse_snd (kiwi.py:177) 30
    thread (0x1);main (server.py:1);recv (kiwi.py:454) 6
    thread (0x1);main (server.py:1);recv (kiwi.py:460) 4
    thread (0x1);main (server.py:1);send (session.py:577);deflate (zlib) 50
    thread (0x2);_work (noise.py:310);_work (noise.py:320);execute (sqlite) 10
    """
)

# Prints py-spy's "Sampling process" line once it starts sampling, like the
# real one. FAKE_SPY_WARN: also says it fell behind, as the real one does on stderr.
FAKE_PY_SPY = """#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo "py-spy 0.4.1"; exit 0; fi
echo "$*" >"$FAKE_DIR/py-spy-args"
# The signal dispositions and OOM score py-spy starts with (Linux only).
[[ -r /proc/$$/status ]] && grep '^SigIgn:' /proc/$$/status >"$FAKE_DIR/py-spy-sigign"
[[ -r /proc/$$/oom_score_adj ]] && cat /proc/$$/oom_score_adj >"$FAKE_DIR/py-spy-oom"
# Rows in samples.tsv when py-spy started: the baseline must be done by then.
wc -l <"$FAKE_DIR/out/samples.tsv" >"$FAKE_DIR/rows-at-spy-start"
if [[ -n "${FAKE_SPY_FAIL:-}" ]]; then
  echo "Permission denied (os error 13)" >&2; : >"$FAKE_DIR/spy-failed"; exit 1
fi
# Stuck while attaching: never starts sampling.
if [[ -n "${FAKE_SPY_HANG_ATTACH:-}" ]]; then echo $$ >"$FAKE_DIR/spy-pid"; exec /bin/sleep 60; fi
# FAKE_SPY_LATE: takes 1 s to attach; the profile rows written by then are counted.
if [[ -n "${FAKE_SPY_LATE:-}" ]]; then
  /bin/sleep 1; grep -c $'\\tprofile\\t' "$FAKE_DIR/out/samples.tsv" >"$FAKE_DIR/rows-at-sampling"
fi
# FAKE_SPY_QUIET: never prints the "Sampling process" line (a py-spy whose output changed).
[[ -n "${FAKE_SPY_QUIET:-}" ]] || echo "py-spy> Sampling process 20 times a second. Press Control-C to exit."
: >"$FAKE_DIR/spy-started"
if [[ -n "${FAKE_SPY_HANG:-}" ]]; then echo $$ >"$FAKE_DIR/spy-pid"; exec /bin/sleep 120; fi
# FAKE_SPY_BEHIND_HANG: keeps falling further behind, saying so again and again.
if [[ -n "${FAKE_SPY_BEHIND_HANG:-}" ]]; then
  echo $$ >"$FAKE_DIR/spy-pid"
  while :; do
    echo "py-spy> 3.10s behind in sampling, results may be inaccurate. Try reducing the sampling rate" >&2
    /bin/sleep 0.3
  done
fi
# FAKE_SPY_BEHIND_ONCE_HANG: one hiccup, said once, then keeps sampling.
if [[ -n "${FAKE_SPY_BEHIND_ONCE_HANG:-}" ]]; then
  echo "py-spy> 1.05s behind in sampling, results may be inaccurate. Try reducing the sampling rate" >&2
  echo $$ >"$FAKE_DIR/spy-pid"; exec /bin/sleep 60
fi
# Ignores SIGINT and SIGTERM, as a py-spy stuck mid-attach might: only SIGKILL ends it.
if [[ -n "${FAKE_SPY_STUBBORN:-}" ]]; then
  trap '' INT TERM; echo $$ >"$FAKE_DIR/spy-pid"; while :; do /bin/sleep 1; done
fi
while [[ $# -gt 0 ]]; do [[ "$1" == --output ]] && out=$2; shift; done
if [[ -n "${FAKE_SPY_EMPTY:-}" ]]; then : >"$out"; exit 0; fi
cp "$FAKE_DIR/raw" "$out"
[[ -n "${FAKE_SPY_WARN:-}" ]] && echo "py-spy> 1.20s behind in sampling, results may be inaccurate. Try reducing the sampling rate" >&2
# FAKE_SPY_BIG_LOG: one warning, then 100k lines of chatter, as a struggling run writes.
if [[ -n "${FAKE_SPY_BIG_LOG:-}" ]]; then
  echo "py-spy> Error: failed to unwind 3 samples" >&2
  /usr/bin/awk 'BEGIN { for (i = 0; i < 100000; i++) print "py-spy> sampled thread 0x1 ok" }'
fi
# The real py-spy's last line on every successful record; not a warning.
echo "py-spy> Wrote raw flamegraph data to '$out'. Samples: 100 Errors: 0"
"""

# vmstat -n: two header lines, then the since-boot row (steal 90, must be
# dropped), then real samples: busy (us + sy + steal) 40 and 60, so 50% on
# average, under the 70% gate. FAKE_VMSTAT_BUSY: 98% busy rows instead.
FAKE_VMSTAT = """#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/vmstat-args"
cat <<'OUT'
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 500000  10000 300000    0    0     0     0  100  200  5  5  0  0 90
OUT
if [[ -n "${FAKE_VMSTAT_EMPTY:-}" ]]; then
  :  # headers and the since-boot row only: no samples
elif [[ -n "${FAKE_VMSTAT_BUSY:-}" ]]; then
  echo " 1  0      0 500000  10000 300000    0    0     0     0  100  200 90  8  2  0  0"
  echo " 1  0      0 500000  10000 300000    0    0     0     0  100  200 90  8  2  0  0"
else
  echo " 1  0      0 500000  10000 300000    0    0     0     0  100  200 20 10 60  0 10"
  echo " 1  0      0 500000  10000 300000    0    0     0     0  100  200 30 10 40  0 20"
fi
"""

# free -m as procps prints it; "available" is column 7. FAKE_LOW_MEM: 120 MB.
# FAKE_FREE_FAIL: prints nothing and fails.
FAKE_FREE = """#!/usr/bin/env bash
[[ -n "${FAKE_FREE_FAIL:-}" ]] && exit 1
available=800
[[ -n "${FAKE_LOW_MEM:-}" ]] && available=120
echo "               total        used        free      shared  buff/cache   available"
echo "Mem:            1967        1100         150          10         717  $available"
echo "Swap:           1023         100         923"
"""

# FAKE_CURL_FAIL: the radio doesn't answer (curl's "couldn't connect").
# FAKE_CURL_SLOW_AFTER_FAIL: once py-spy has failed, each /healthz takes 1 s,
# so the profile's samplers outlive py-spy.
# FAKE_CURL_FAIL_ONCE_SAMPLING: the radio stops answering once py-spy samples.
# FAKE_CURL_5XX_ONCE_SAMPLING: it answers HTTP 500 instead (curl -f: exit 22).
# Each failed watchdog probe (the -o /dev/null ones) is logged to probes-failed.
FAKE_CURL = """#!/usr/bin/env bash
watchdog=; [[ " $* " == *" -o /dev/null "* ]] && watchdog=1
failed() { [[ -n "$watchdog" ]] && echo "$*" "args: ${ARGS}" >>"$FAKE_DIR/probes-failed"; exit "$1"; }
ARGS="$*"
[[ -n "${FAKE_CURL_FAIL:-}" ]] && failed 7
[[ -n "${FAKE_CURL_FAIL_ONCE_SAMPLING:-}" && -e "$FAKE_DIR/spy-started" ]] && failed 28
if [[ -n "${FAKE_CURL_5XX_ONCE_SAMPLING:-}" && -e "$FAKE_DIR/spy-started" ]]; then
  [[ " $* " == *" -sf "* ]] && failed 22
  echo '{"detail":"Internal Server Error"}'; exit 0
fi
[[ -n "${FAKE_CURL_SLOW_AFTER_FAIL:-}" && -e "$FAKE_DIR/spy-failed" ]] && /bin/sleep 1
echo '{"ok":true,"listeners":7,"maxListeners":15}'
"""


def setup(tmp_path: Path, *, spy: bool = True, **fake_env: str) -> tuple[list[str], dict[str, str]]:
    root = tmp_path / "repo"
    (root / "deploy").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "deploy" / "profile.sh")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fakes = {
        "docker": FAKE_DOCKER,
        "vmstat": FAKE_VMSTAT,
        "free": FAKE_FREE,
        "curl": FAKE_CURL,
        # Instant, except the 0.1 s steps (waiting for py-spy to start
        # sampling, stopping it) and the watchdog's 1 s, which are real so
        # timing there shows. Every call is logged to sleeps.
        "sleep": '#!/usr/bin/env bash\necho "$1" >>"$FAKE_DIR/sleeps"\n'
        '[[ "$1" == 0.1 || "$1" == 1 ]] && exec /bin/sleep "$1"\nexit 0\n',
        # A real timeout (macOS has none): kill the command after $1 seconds.
        # (The killer's output goes to /dev/null: if it held the caller's
        # pipe, every $(timeout ...) would wait the full $1 seconds.)
        "timeout": '#!/usr/bin/env bash\nt=$1; shift\n"$@" & p=$!\n'
        '( /bin/sleep "$t"; kill "$p" ) >/dev/null 2>&1 & w=$!\n'
        'wait "$p"; rc=$?; kill "$w" 2>/dev/null; exit "$rc"\n',
        "nproc": "#!/usr/bin/env bash\necho 1\n",
    }
    if spy:
        fakes["py-spy"] = FAKE_PY_SPY
    for name, body in fakes.items():
        path = bin_dir / name
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
    (tmp_path / "raw").write_text(RAW)

    env = {
        **os.environ,
        # Only system dirs after the fakes, so a py-spy installed elsewhere is not found.
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "FAKE_DIR": str(tmp_path),
        "PROFILE_OUT": str(tmp_path / "out"),
        **fake_env,
    }
    return ["bash", str(root / "deploy" / "profile.sh")], env


def run_profile(tmp_path: Path, *args: str, spy: bool = True, **fake_env: str):
    cmd, env = setup(tmp_path, spy=spy, **fake_env)
    result = subprocess.run([*cmd, *args], capture_output=True, text=True, env=env, timeout=30)
    return result, tmp_path / "out"


pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


# Value: protects=the Step 0 numbers for issue #153: steal and CPU averages per window (vmstat's since-boot row dropped), listeners from /healthz, radio/caddy CPU, rows per phase, busy share, self time per function and inclusive time per function and thread; fails_when=the since-boot row is averaged in, columns are misread, self time counts outer frames, a frame is split by line, or recursion is counted twice; why_new=new script; seam=fake docker/py-spy/vmstat/curl/free/sleep on PATH; no_claim=real py-spy attaching across the container boundary, real vmstat column order, tick timing (sleep is faked)
def test_summary(tmp_path: Path):
    result, out = run_profile(tmp_path, "30")
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    assert "listeners=7.0  radio_cpu=30.0%  caddy_cpu=10.0%  (12 rows)" in summary
    assert "listeners=7.0  radio_cpu=30.0%  caddy_cpu=10.0%  (6 rows)" in summary
    assert summary.count("host us=25.0%  sy=10.0%  steal=15.0%  (2 samples)") == 2
    assert "the host was" not in summary
    assert "aborted" not in summary
    assert "py-spy warnings" not in summary
    assert "100 non-idle samples of about 600 per thread (17% busy, all threads)" in summary
    self_time = summary.split("by self time")[1].split("== top 25")[0]
    assert "  50.0%  deflate (zlib)" in self_time
    assert "  30.0%  parse_snd (kiwi.py)" in self_time
    assert "  10.0%  recv (kiwi.py)" in self_time  # 6 + 4 samples at two lines, one row
    assert "main (server.py)" not in self_time  # never innermost
    inclusive = summary.split("by inclusive time")[1]
    for line in (
        "90.0%  thread (0x1)",
        "90.0%  main (server.py)",
        "50.0%  send (session.py)",
        "40.0%  recv (kiwi.py)",
        "10.0%  thread (0x2)",
        "10.0%  _work (noise.py)",  # recurses, but counts once per sample
    ):
        assert f"  {line}" in inclusive
    rows = (out / "samples.tsv").read_text().splitlines()
    assert len(rows) == 1 + 60 // 5 + 30 // 5  # header, baseline, profile


# Value: protects=the profiler settings the owner approved for production (--nonblocking and never --native, so the radio is never paused; per function, per thread, 20 Hz, the requested window, the radio's host PID) and that py-spy starts only after the baseline window, with vmstat covering each window; fails_when=a flag is dropped, the rate or duration drifts, py-spy overlaps the baseline, or a vmstat count drifts from its window; why_new=new script; seam=fake py-spy and vmstat on PATH; no_claim=py-spy's own flag parsing
def test_py_spy_settings_and_windows(tmp_path: Path):
    result, _ = run_profile(tmp_path, "45")
    assert result.returncode == 0, result.stderr
    args = (tmp_path / "py-spy-args").read_text().split()
    assert args[:3] == ["record", "--pid", "4194303"]
    for flag, value in (("--rate", "20"), ("--duration", "45"), ("--format", "raw")):
        assert args[args.index(flag) + 1] == value
    assert {"--nonblocking", "--function", "--threads"} <= set(args)
    assert "--native" not in args
    assert int((tmp_path / "rows-at-spy-start").read_text()) >= 1 + 60 // 5
    assert (tmp_path / "vmstat-args").read_text().splitlines() == ["-n 5 13", "-n 5 10"]


# Value: protects=the cap on how long py-spy may pause the process that streams every listener's audio, windows that line up with the 5 s samples, and --force only as the first argument; fails_when=the 30-300 s bounds, the step-of-5 check, the number check (incl. no leading zero, which bash reads as octal while py-spy reads decimal) or the argument count check are removed; why_new=new script; seam=none; no_claim=that 300 s of pauses is inaudible
@pytest.mark.parametrize(
    "args", [["301"], ["29"], ["33"], ["2m"], ["0454"], ["060"], ["30", "--force"], ["--force", "30", "40"]]
)
def test_rejects_bad_arguments(tmp_path: Path, args: list[str]):
    result, out = run_profile(tmp_path, *args)
    assert result.returncode == 2
    assert not (tmp_path / "py-spy-args").exists()
    assert not out.exists()


# Value: protects=py-spy isn't attached to a box already over 70% busy (its CPU on the same core could make every listener's audio choppy), and the baseline is still saved; fails_when=the busy gate is removed, sums the wrong columns, or counts vmstat's since-boot row; why_new=owner-approved guard from the pre-landing review; seam=fake vmstat on PATH; no_claim=that 70% is the right line for this box
def test_busy_host_is_not_profiled(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_VMSTAT_BUSY="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    summary = (out / "summary.txt").read_text()
    assert "not profiled: the host was 98% busy (over 70%)" in summary
    assert "--force" in summary
    assert "(12 rows)" in summary


# Value: protects=--force profiles a busy box anyway, and the summary then says the numbers are skewed; fails_when=--force stops overriding the gate, or the 95% warning is dropped; why_new=owner-approved guard from the pre-landing review; seam=fake vmstat on PATH; no_claim=what py-spy really costs on the Droplet
def test_force_profiles_a_busy_host_with_a_warning(tmp_path: Path):
    result, out = run_profile(tmp_path, "--force", "30", FAKE_VMSTAT_BUSY="1")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "py-spy-args").exists()
    summary = (out / "summary.txt").read_text()
    assert "warning: the host was 98% busy with py-spy attached" in summary
    assert "by self time" in summary


# Value: protects=the busy gate fails closed: with no vmstat samples py-spy isn't attached unless --force; fails_when=no samples read as 0% busy again; why_new=red-team finding in the pre-landing review (pass 2); seam=fake vmstat on PATH; no_claim=why a real vmstat would print nothing
@pytest.mark.parametrize(("args", "code"), [(["30"], 3), (["--force", "30"], 0)])
def test_unmeasured_cpu_is_not_profiled_without_force(tmp_path: Path, args: list[str], code: int):
    result, out = run_profile(tmp_path, *args, FAKE_VMSTAT_EMPTY="1")
    assert result.returncode == code, result.stderr
    assert (tmp_path / "py-spy-args").exists() == bool(code == 0)
    if code:
        assert "not profiled: couldn't measure host CPU" in (out / "summary.txt").read_text()


# Value: protects=py-spy starts with TERM and HUP not ignored, so an abort's SIGTERM stops it at once instead of waiting for SIGKILL while it may hold the radio stopped; fails_when=the launch window's trap becomes an ignore (trap '' INT TERM HUP), so py-spy inherits ignored TERM and HUP; why_new=specialist finding in the pre-landing review (pass 2); seam=fake py-spy reads /proc/self/status; no_claim=macOS (no /proc; skipped) or py-spy's own SIGINT handler
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc/<pid>/status")
def test_py_spy_starts_with_term_and_hup_not_ignored(tmp_path: Path):
    result, _ = run_profile(tmp_path, "30")
    assert result.returncode == 0, result.stderr
    ignored = int((tmp_path / "py-spy-sigign").read_text().split()[1], 16)
    assert ignored & (1 << (signal.SIGTERM - 1)) == 0
    assert ignored & (1 << (signal.SIGHUP - 1)) == 0


# Value: protects=py-spy isn't attached with under 250 MB free, where running beside the radio could push it into swap or the OOM killer; fails_when=the memory check is removed or reads the wrong column of free -m; why_new=owner-approved guard from the pre-landing review; seam=fake free on PATH; no_claim=py-spy's real memory use
def test_low_memory_is_not_profiled(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_LOW_MEM="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    assert "not profiled: only 120 MB of memory available (under 250)" in (out / "summary.txt").read_text()


# Value: protects=root never writes into a PROFILE_OUT that already exists (it could hold a planted symlink); fails_when=the exists check is removed or mkdir -p comes back; why_new=owner-approved fix from the pre-landing review; seam=none; no_claim=the mktemp default under /var/tmp (not exercised here)
def test_refuses_an_existing_output_dir(tmp_path: Path):
    (tmp_path / "out").mkdir()
    result, out = run_profile(tmp_path, "30")
    assert result.returncode == 2
    assert "already exists" in result.stderr
    assert not (tmp_path / "py-spy-args").exists()
    assert list(out.iterdir()) == []


# Value: protects=a failed attach (no root, wrong PID) or an empty profile still leaves the unprofiled numbers and says it failed, not a 0% or divide-by-zero summary; fails_when=set -e aborts on py-spy's exit, the error is swallowed, or the empty-radio.raw check is dropped; why_new=new script; seam=fake py-spy on PATH; no_claim=py-spy's real error text, or when real py-spy writes empty output
@pytest.mark.parametrize(
    ("fake", "says"),
    [("FAKE_SPY_FAIL", ["py-spy failed (exit 1)", "Permission denied"]), ("FAKE_SPY_EMPTY", ["py-spy failed (exit 0)"])],
)
def test_py_spy_failure_keeps_the_numbers(tmp_path: Path, fake: str, says: list[str]):
    result, out = run_profile(tmp_path, "30", **{fake: "1"})
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    for text in says:
        assert text in summary
    assert "by self time" not in summary
    assert "steal=15.0%" in summary


# Value: protects=the profiler never starts when the radio container is down (py-spy would get --pid ""); fails_when=the empty-$radio check is removed; why_new=no test covers compose ps returning nothing; seam=fake docker on PATH; no_claim=real docker compose ps output
def test_needs_the_radio_container(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_NO_RADIO="1")
    assert result.returncode == 1
    assert "radio container isn't running" in result.stderr
    assert not (tmp_path / "py-spy-args").exists()
    assert not out.exists()


# Value: protects=py-spy isn't attached when the radio has no address, since the /healthz watchdog can't run then; fails_when=the no-address refusal is removed and the watchdog is silently off; why_new=red team, adversarial and Codex findings in the final review; seam=fake docker on PATH; no_claim=why docker would report no address
def test_no_address_is_not_profiled_without_force(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_NO_IP="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    assert "the /healthz watchdog that stops py-spy" in (out / "summary.txt").read_text()


# Value: protects=a forced run survives a /healthz that doesn't answer, failing docker stats and no radio address: those columns read "-", the profile still finishes, and the summary says the run had no watchdog; fails_when=a "|| true" is dropped under set -euo pipefail, or the unguarded note goes; why_new=test_summary only feeds healthy fakes; seam=fake docker/curl on PATH; no_claim=real /healthz or docker stats output formats
def test_failed_samples_degrade_to_dashes(tmp_path: Path):
    result, out = run_profile(tmp_path, "--force", "30", FAKE_CURL_FAIL="1", FAKE_STATS_FAIL="1", FAKE_NO_IP="1")
    assert result.returncode == 0, result.stderr
    assert "no network address" in result.stderr
    summary = (out / "summary.txt").read_text()
    assert summary.count("listeners=-  radio_cpu=-%  caddy_cpu=-%") == 2
    assert "unguarded run" in summary
    assert "by self time" in summary  # the profile itself still ran
    rows = (out / "samples.tsv").read_text().splitlines()
    assert len(rows) == 1 + 60 // 5 + 30 // 5


# Value: protects=with no caddy container the radio's own CPU is still read and only caddy reads "-"; fails_when=${caddy:+} is dropped (an empty argument makes docker stats fail for both) or the caddy awk loses its empty-id guard; why_new=the degrade test fails docker stats too, so it can't see this; seam=fake docker on PATH; no_claim=real docker stats with an empty argument
def test_no_caddy_keeps_the_radio_numbers(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_NO_CADDY="1")
    assert result.returncode == 0, result.stderr
    assert (out / "summary.txt").read_text().count("radio_cpu=30.0%  caddy_cpu=-%") == 2


# Value: protects=the documented default window (README and usage say 120 s) when no argument is given; fails_when=the default drifts from the docs; why_new=every other test passes a window; seam=fake py-spy and vmstat on PATH; no_claim=none beyond protects
def test_default_window_is_120_s(tmp_path: Path):
    result, _ = run_profile(tmp_path)
    assert result.returncode == 0, result.stderr
    args = (tmp_path / "py-spy-args").read_text().split()
    assert args[args.index("--duration") + 1] == "120"
    assert (tmp_path / "vmstat-args").read_text().splitlines() == ["-n 5 13", "-n 5 25"]


# Value: protects=the script refuses to start without py-spy rather than sampling a window with no profile; fails_when=the check is removed; why_new=new script; seam=PATH without py-spy; no_claim=none
def test_needs_py_spy(tmp_path: Path):
    result, out = run_profile(tmp_path, spy=False)
    assert result.returncode == 1
    assert "/opt/py-spy/bin/pip install py-spy" in result.stderr
    assert not out.exists()


def _wait_for(path: Path, seconds: float = 20) -> None:
    deadline = time.monotonic() + seconds
    while not path.exists() or not path.read_text().strip():
        assert time.monotonic() < deadline, f"{path.name} never appeared"
        time.sleep(0.05)


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def _stopped(pid: int) -> bool:
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
    return state.strip().startswith("T")


def _run_and_reap_spy(tmp_path: Path, args: list[str], timeout: float, **fake_env: str):
    """Run to the end; py-spy (the fake's recorded pid) must be gone afterwards."""
    cmd, env = setup(tmp_path, **fake_env)
    result = subprocess.run([*cmd, *args], capture_output=True, text=True, env=env, timeout=timeout)
    assert _gone(int((tmp_path / "spy-pid").read_text()))
    return result, (tmp_path / "out" / "summary.txt").read_text()


# Value: protects=py-spy is stopped when the owner aborts mid-profile (Ctrl-C, dropped SSH, kill), for each signal the README promises, so it doesn't keep using the radio's core; fails_when=the trap or one of its signals is removed, or py-spy is left running; why_new=the abort path; seam=fake py-spy that hangs; no_claim=py-spy's own SIGINT handling
@pytest.mark.timeout(30)
@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
def test_abort_stops_py_spy(tmp_path: Path, sig: signal.Signals):
    cmd, env = setup(tmp_path, FAKE_SPY_HANG="1")
    script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _wait_for(tmp_path / "spy-pid")
    script.send_signal(sig)
    assert script.wait(timeout=15) == 130
    assert _gone(int((tmp_path / "spy-pid").read_text()))


# Value: protects=a py-spy that ignores SIGINT and SIGTERM is still ended (SIGKILL after 2 s + 1 s), so an abort can't leave it running; fails_when=the SIGKILL fallback is removed; why_new=pre-landing review; seam=fake py-spy that ignores INT and TERM; no_claim=how long real py-spy takes to let go
@pytest.mark.timeout(40)
def test_abort_kills_a_stubborn_py_spy(tmp_path: Path):
    cmd, env = setup(tmp_path, FAKE_SPY_STUBBORN="1")
    script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _wait_for(tmp_path / "spy-pid")
    script.send_signal(signal.SIGTERM)
    assert script.wait(timeout=25) == 130
    assert _gone(int((tmp_path / "spy-pid").read_text()))


# Value: protects=a second Ctrl-C during the stop of a stuck py-spy doesn't cut cleanup short and leave py-spy running; fails_when=cleanup stops ignoring INT/TERM/HUP; why_new=red-team finding (reproduced on bash 3.2); seam=fake py-spy that ignores INT and TERM; no_claim=bash versions other than the runner's
@pytest.mark.timeout(40)
def test_second_signal_does_not_cut_cleanup_short(tmp_path: Path):
    cmd, env = setup(tmp_path, FAKE_SPY_STUBBORN="1")
    script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _wait_for(tmp_path / "spy-pid")
    script.send_signal(signal.SIGTERM)
    time.sleep(0.5)  # inside stop_spy's 3 s escalation
    script.send_signal(signal.SIGTERM)
    assert script.wait(timeout=20) == 130
    assert _gone(int((tmp_path / "spy-pid").read_text()))


# Value: protects=the --nonblocking design's promise: the script never signals the radio process (no SIGSTOP, no SIGCONT, no kill), on a normal run, a watchdog abort or a Ctrl-C; fails_when=a signal to the radio's pid comes back anywhere in the script; why_new=owner switched to --nonblocking so nothing the script or py-spy does can stop the radio; seam=a stopped sleep standing in for uvicorn (any SIGCONT would wake it); no_claim=what py-spy --nonblocking does to the process (it only reads memory)
@pytest.mark.timeout(60)
@pytest.mark.parametrize(
    "fake_env, abort",
    [({}, False), ({"FAKE_SPY_HANG": "1", "FAKE_CURL_FAIL_ONCE_SAMPLING": "1"}, False), ({"FAKE_SPY_HANG": "1"}, True)],
)
def test_never_signals_the_radio(tmp_path: Path, fake_env: dict[str, str], abort: bool):
    radio = subprocess.Popen(["/bin/sleep", "300"])
    try:
        os.kill(radio.pid, signal.SIGSTOP)
        cmd, env = setup(tmp_path, FAKE_RADIO_PID=str(radio.pid), **fake_env)
        script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if abort:
            _wait_for(tmp_path / "spy-pid")
            script.send_signal(signal.SIGINT)
        script.wait(timeout=40)
        assert _stopped(radio.pid), "something sent the radio a signal"
        assert radio.poll() is None
        assert "--nonblocking" in (tmp_path / "py-spy-args").read_text().split()
    finally:
        radio.kill()
        radio.wait()


# Value: protects=the radio gets its core back when py-spy starves it: exactly two /healthz probes in a row without an answer, 1 s apart, stop py-spy; fails_when=the watchdog is removed, needs more misses, or probes less often; why_new=owner-approved watchdog; trigger and cadence pinned after the specialist showed 6 misses still passed; seam=fake py-spy that hangs, fake curl that fails once sampling starts and logs failed probes; no_claim=that real /healthz misses mean py-spy is the cause
@pytest.mark.timeout(30)
def test_watchdog_stops_py_spy_when_the_radio_stops_answering(tmp_path: Path):
    result, summary = _run_and_reap_spy(tmp_path, ["30"], 25, FAKE_SPY_HANG="1", FAKE_CURL_FAIL_ONCE_SAMPLING="1")
    assert result.returncode == 0, result.stderr
    assert "== aborted: the radio stopped answering /healthz" in summary
    assert "reads low" in summary
    # Exactly two failed probes, then it acted; probes 1 s apart.
    assert len((tmp_path / "probes-failed").read_text().splitlines()) == 2
    assert "1" in (tmp_path / "sleeps").read_text().split()


# Value: protects=the watchdog guards py-spy's attach too: a py-spy stuck before it starts sampling, with the radio not answering, is stopped within seconds, not after the 30 s wait for sampling to start; fails_when=the watchdog starts only once py-spy reports sampling; why_new=red team and Codex findings in the final review; seam=fake py-spy that never starts sampling, fake curl that fails, real 0.1 s sleeps in the wait loop; no_claim=how long a real py-spy attach takes
@pytest.mark.timeout(40)
def test_watchdog_guards_a_stuck_attach(tmp_path: Path):
    started = time.monotonic()
    result, summary = _run_and_reap_spy(tmp_path, ["30"], 35, FAKE_SPY_HANG_ATTACH="1", FAKE_CURL_FAIL="1")
    assert result.returncode == 0, result.stderr
    assert time.monotonic() - started < 15  # the attach wait alone is 30 s
    assert "== aborted: the radio stopped answering /healthz" in summary


def _watch_constants() -> dict[str, float]:
    text = SCRIPT.read_text()
    return {
        name: float(re.search(rf"^{name}=([0-9.]+)$", text, re.M).group(1))
        for name in ("WATCH_S", "WATCH_TIMEOUT_S", "WATCH_MISSES")
    }


# Value: protects=a radio starved of CPU by py-spy gets it back well inside the radio's own deadline: the radio ends every listener's Kiwi stream once audio is timeout_s late (KiwiConnection, kiwi.py), so the worst-case detect-and-stop time (misses x (interval + probe timeout) + the 2 s SIGINT wait) must be at most 60% of it; fails_when=the probe interval, probe timeout or miss count grows, or the Kiwi timeout shrinks, past that budget; why_new=adversarial finding: the first cadence took 9-17 s against a 10 s deadline; seam=none (reads the script's constants and KiwiConnection's default); no_claim=real /healthz latency under load
def test_watchdog_acts_inside_the_kiwi_audio_deadline():
    # KiwiClient takes timeout_s from KiwiConnection, the base of every Kiwi stream.
    from skywave_radio.kiwi import KiwiClient, KiwiConnection

    assert issubclass(KiwiClient, KiwiConnection)
    kiwi_timeout = inspect.signature(KiwiConnection.__init__).parameters["timeout_s"].default
    c = _watch_constants()
    worst = c["WATCH_MISSES"] * (c["WATCH_S"] + c["WATCH_TIMEOUT_S"]) + 2
    assert worst <= 0.6 * kiwi_timeout, (worst, kiwi_timeout)


# Value: protects=the watchdog's real stop time, not just its constants: probes use --max-time WATCH_TIMEOUT_S, and a py-spy that ignores SIGINT and SIGTERM is SIGKILLed within the 2 s + 1 s escalation (plus start-up) of the second failed probe; fails_when=the probe timeout goes back to a literal 2, or the escalation grows; why_new=specialist finding: only the constants were checked; seam=fake py-spy that ignores INT and TERM, fake curl that fails once sampling starts and logs its arguments; no_claim=start-up costs on a loaded 1-vCPU box
@pytest.mark.timeout(60)
def test_watchdog_kills_a_stuck_py_spy_within_its_escalation(tmp_path: Path):
    cmd, env = setup(tmp_path, FAKE_SPY_STUBBORN="1", FAKE_CURL_FAIL_ONCE_SAMPLING="1")
    script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _wait_for(tmp_path / "spy-pid")
    spy_pid = int((tmp_path / "spy-pid").read_text())
    probes = tmp_path / "probes-failed"
    deadline = time.monotonic() + 20
    while not probes.exists() or len(probes.read_text().splitlines()) < 2:
        assert time.monotonic() < deadline, "the watchdog never missed twice"
        time.sleep(0.02)
    second_miss = time.monotonic()
    while not _gone(spy_pid):
        assert time.monotonic() - second_miss < 4.5, "py-spy outlived the stop's escalation"
        time.sleep(0.02)
    assert script.wait(timeout=20) == 0
    assert all("--max-time 1 " in line for line in probes.read_text().splitlines())


# Value: protects=an HTTP error from /healthz counts as a miss, so a radio answering 500s under py-spy still trips the watchdog; fails_when=curl loses -f and any HTTP response reads as healthy; why_new=Codex P1 in review; seam=fake curl answering 500 once sampling starts, fake py-spy that hangs; no_claim=which errors a real starved radio returns
@pytest.mark.timeout(60)
def test_watchdog_counts_http_errors_as_misses(tmp_path: Path):
    result, summary = _run_and_reap_spy(tmp_path, ["30"], 40, FAKE_SPY_HANG="1", FAKE_CURL_5XX_ONCE_SAMPLING="1")
    assert result.returncode == 0, result.stderr
    assert "== aborted: the radio stopped answering /healthz" in summary


# Value: protects=a py-spy that keeps falling behind in sampling (new warnings on 3 probes in a row) is stopped so it can still write its output; fails_when=the watchdog stops reading py-spy's log or stops counting new warnings; why_new=red-team findings in review; seam=fake py-spy that keeps saying it fell behind; no_claim=py-spy's exact wording in every version
@pytest.mark.timeout(60)
def test_watchdog_stops_a_py_spy_that_keeps_falling_behind(tmp_path: Path):
    result, summary = _run_and_reap_spy(tmp_path, ["30"], 40, FAKE_SPY_BEHIND_HANG="1")
    assert result.returncode == 0, result.stderr
    assert "== aborted: py-spy kept falling behind in sampling (3 probes in a row)" in summary


# Value: protects=one hiccup (py-spy's lag adds up, so it says "behind" once and never un-says it) doesn't end the run and throw away the profile; fails_when=the watchdog stops on any "behind" line again; why_new=red-team finding in review; seam=fake py-spy that says it fell behind once and keeps sampling; no_claim=how often a real py-spy repeats the warning
@pytest.mark.timeout(60)
def test_one_behind_warning_does_not_stop_the_run(tmp_path: Path):
    cmd, env = setup(tmp_path, FAKE_SPY_BEHIND_ONCE_HANG="1")
    script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait_for(tmp_path / "spy-pid")
        time.sleep(5)  # five watchdog probes (1 s apart, real)
        assert not (tmp_path / "out" / "aborted").exists()
        assert script.poll() is None
    finally:
        script.send_signal(signal.SIGTERM)
        script.wait(timeout=20)


# Value: protects=a py-spy that never finishes (stuck while /healthz still answers) is stopped once its window plus SPY_OVERRUN_S has passed since it started sampling, not left attached until someone notices; fails_when=the overrun cap is removed; why_new=adversarial finding in review; seam=fake py-spy that hangs; no_claim=how long a real py-spy can take to write its output (takes about 60 s of wall time)
@pytest.mark.timeout(150)
def test_watchdog_caps_how_long_py_spy_stays_attached(tmp_path: Path):
    started = time.monotonic()
    result, summary = _run_and_reap_spy(tmp_path, ["30"], 120, FAKE_SPY_HANG="1")
    assert result.returncode == 0, result.stderr
    assert "== aborted: py-spy was still attached 30 s past its window" in summary
    assert time.monotonic() - started < 100


# Value: protects=the pid read before the baseline is still the radio's when py-spy attaches (a container restart can hand it to any process); fails_when=the pid re-check before attaching is removed; why_new=Codex finding in review; seam=fake docker on PATH; no_claim=how fast the kernel reuses a pid
def test_radio_restart_during_the_baseline_is_not_profiled(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_PID_CHANGES="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    assert "not profiled: the radio container restarted during the baseline" in (out / "summary.txt").read_text()


# Value: protects=the memory gate fails closed: unreadable free -m doesn't count as enough memory; fails_when=a non-numeric or empty reading is let through; why_new=specialist finding in review; seam=fake free on PATH; no_claim=why a real free -m would fail
def test_unreadable_memory_is_not_profiled(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_FREE_FAIL="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    assert "not profiled: couldn't read free memory" in (out / "summary.txt").read_text()


# Value: protects=py-spy is the OOM killer's first choice (oom_score_adj 1000), not the radio and everyone's audio; fails_when=the oom_score_adj write is removed or its redirect breaks; why_new=specialist finding in review; seam=fake py-spy reads /proc/self/oom_score_adj; no_claim=macOS (no /proc; skipped)
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc/<pid>/oom_score_adj")
def test_py_spy_is_the_oom_killers_first_choice(tmp_path: Path):
    result, _ = run_profile(tmp_path, "30")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "py-spy-oom").read_text().strip() == "1000"


# Value: protects=py-spy's own "behind in sampling" warning reaches the summary on a run that otherwise succeeds, and its normal "Errors: 0" line doesn't; fails_when=the warnings block is removed or its pattern stops matching or matches "Errors: 0"; why_new=red team and adversarial findings in review; seam=fake py-spy on PATH; no_claim=py-spy's exact wording in every version
def test_py_spy_warnings_reach_the_summary(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_SPY_WARN="1")
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    assert "== py-spy warnings" in summary
    assert "behind in sampling" in summary
    assert "Errors: 0" not in summary
    assert "by self time" in summary


# Value: protects=the profile window's rows start when py-spy starts sampling, so they describe the same period as its samples; fails_when=the wait for "Sampling process" is removed; why_new=plan audit: nothing delayed that line; seam=fake py-spy that takes 1 s to start sampling; no_claim=how long a real attach takes
def test_profile_rows_wait_for_py_spy_to_start_sampling(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_SPY_LATE="1")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "rows-at-sampling").read_text().strip() == "0"
    assert "(6 rows)" in (out / "summary.txt").read_text()


# Value: protects=if py-spy never says it started sampling (its output changed in a new version), the summary says the windows may not line up; fails_when=the warning or its condition is removed; why_new=Codex finding in review; seam=fake py-spy that never prints the line; no_claim=what a future py-spy prints
def test_summary_flags_a_window_py_spy_never_confirmed(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_SPY_QUIET="1")
    assert result.returncode == 0, result.stderr
    assert "never said it started sampling" in (out / "summary.txt").read_text()


# Value: protects=a stalled Docker daemon can't stop the sample rows: each docker stats gets 4 s, its columns read "-", and the ticks keep their schedule; fails_when=the timeout around docker stats is removed; why_new=plan audit: nothing made docker stats hang; seam=fake docker that hangs once sampling starts, a fake timeout that really kills; no_claim=real docker behaviour under load (takes about 30 s of wall time)
@pytest.mark.timeout(90)
def test_a_hanging_docker_stats_cannot_stall_the_rows(tmp_path: Path):
    cmd, env = setup(tmp_path, FAKE_STATS_HANG_SAMPLING="1")
    result = subprocess.run([*cmd, "30"], capture_output=True, text=True, env=env, timeout=75)
    assert result.returncode == 0, result.stderr
    profile = [r for r in (tmp_path / "out" / "samples.tsv").read_text().splitlines() if "\tprofile\t" in r]
    # With the 4 s timeout the ticks keep their 5 s schedule; without it one
    # 30 s hang uses up the whole window.
    assert 5 <= len(profile) <= 6
    assert all(r.split("\t")[3] == "-" for r in profile)


# Value: protects=a big profile (thousands of distinct frames) still gets its whole summary: no early exit in the summary pipelines SIGPIPEs the stage before it under pipefail; fails_when=head comes back into a summary pipeline; why_new=red-team finding in review (reproduced); seam=fake py-spy writing a 3000-frame profile; no_claim=py-spy's real output size
def test_a_big_profile_gets_its_whole_summary(tmp_path: Path):
    cmd, env = setup(tmp_path)
    (tmp_path / "raw").write_text(
        "".join(f"thread (0x1);main (server.py:1);f{i} (mod{i}.py:{i}) 1\n" for i in range(3000))
    )
    result = subprocess.run([*cmd, "30"], capture_output=True, text=True, env=env, timeout=60)
    assert result.returncode == 0, result.stderr
    summary = (tmp_path / "out" / "summary.txt").read_text()
    rows = [line for line in summary.split("by inclusive time")[1].splitlines() if re.match(r"\s+[0-9.]+%", line)]
    assert len(rows) == 25
    assert "saved in" in result.stdout
    assert "output: " in result.stdout.splitlines()[0]


# Value: protects=a long py-spy.log (a struggling run warns a lot) still gets its warnings into the summary: no grep -q in that pipeline SIGPIPEs the grep before it under pipefail; fails_when=grep -q comes back into the warnings pipeline; why_new=specialist finding in review; seam=fake py-spy writing a 100k-line log; no_claim=py-spy's real log size
def test_a_long_py_spy_log_keeps_its_warnings(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_SPY_BIG_LOG="1")
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    assert "== py-spy warnings" in summary
    assert "by self time" in summary
