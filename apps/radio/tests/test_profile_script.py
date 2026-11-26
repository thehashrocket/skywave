"""deploy/profile.sh, run against fake docker, py-spy, vmstat, curl and sleep on PATH."""

import os
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
  "stats --no-stream") [[ -n "${FAKE_STATS_FAIL:-}" ]] && exit 1; echo "radioid 30.00%"; echo "caddyid 10.00%" ;;
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
echo "py-spy> Sampling process 20 times a second. Press Control-C to exit."
: >"$FAKE_DIR/spy-started"
if [[ -n "${FAKE_SPY_HANG:-}" ]]; then echo $$ >"$FAKE_DIR/spy-pid"; exec /bin/sleep 30; fi
# Ignores SIGINT and SIGTERM, as a py-spy stuck mid-attach might: only SIGKILL ends it.
if [[ -n "${FAKE_SPY_STUBBORN:-}" ]]; then
  trap '' INT TERM; echo $$ >"$FAKE_DIR/spy-pid"; while :; do /bin/sleep 1; done
fi
[[ -n "${FAKE_SPY_WARN:-}" ]] && echo "py-spy> 1.20s behind in sampling, results may be inaccurate. Try reducing the sampling rate" >&2
while [[ $# -gt 0 ]]; do [[ "$1" == --output ]] && out=$2; shift; done
if [[ -n "${FAKE_SPY_EMPTY:-}" ]]; then : >"$out"; exit 0; fi
cp "$FAKE_DIR/raw" "$out"
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
FAKE_CURL = """#!/usr/bin/env bash
[[ -n "${FAKE_CURL_FAIL:-}" ]] && exit 7
[[ -n "${FAKE_CURL_FAIL_ONCE_SAMPLING:-}" && -e "$FAKE_DIR/spy-started" ]] && exit 28
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
        "sleep": "#!/usr/bin/env bash\nexit 0\n",
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


# Value: protects=the profiler settings the owner approved for production (native stacks, per function, per thread, 20 Hz, the requested window, the radio's host PID) and that py-spy starts only after the baseline window, with vmstat covering each window; fails_when=a flag is dropped, the rate or duration drifts, py-spy overlaps the baseline, or a vmstat count drifts from its window; why_new=new script; seam=fake py-spy and vmstat on PATH; no_claim=py-spy's own flag parsing
def test_py_spy_settings_and_windows(tmp_path: Path):
    result, _ = run_profile(tmp_path, "45")
    assert result.returncode == 0, result.stderr
    args = (tmp_path / "py-spy-args").read_text().split()
    assert args[:3] == ["record", "--pid", "4194303"]
    for flag, value in (("--rate", "20"), ("--duration", "45"), ("--format", "raw")):
        assert args[args.index(flag) + 1] == value
    assert {"--native", "--function", "--threads"} <= set(args)
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


# Value: protects=py-spy starts with TERM and HUP not ignored, so an abort's SIGTERM stops it at once instead of waiting for SIGKILL while it may hold the radio stopped; fails_when=the subshell's trap - INT TERM HUP is removed and py-spy inherits the launch window's ignores; why_new=specialist finding in the pre-landing review (pass 2); seam=fake py-spy reads /proc/self/status; no_claim=macOS (no /proc; skipped) or py-spy's own SIGINT handler
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc/<pid>/status")
def test_py_spy_starts_with_term_and_hup_not_ignored(tmp_path: Path):
    result, _ = run_profile(tmp_path, "30")
    assert result.returncode == 0, result.stderr
    ignored = int((tmp_path / "py-spy-sigign").read_text().split()[1], 16)
    assert ignored & (1 << (signal.SIGTERM - 1)) == 0
    assert ignored & (1 << (signal.SIGHUP - 1)) == 0


# Value: protects=py-spy --native isn't attached with under 250 MB free, where its symbol tables could push the radio into swap or the OOM killer; fails_when=the memory check is removed or reads the wrong column of free -m; why_new=owner-approved guard from the pre-landing review; seam=fake free on PATH; no_claim=py-spy's real memory use
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


# Value: protects=one busy-hour run survives a /healthz that doesn't answer, failing docker stats and no radio address: those columns read "-" and the profile still finishes; fails_when=a "|| true" is dropped under set -euo pipefail; why_new=test_summary only feeds healthy fakes; seam=fake docker/curl on PATH; no_claim=real /healthz or docker stats output formats
def test_failed_samples_degrade_to_dashes(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_CURL_FAIL="1", FAKE_STATS_FAIL="1", FAKE_NO_IP="1")
    assert result.returncode == 0, result.stderr
    assert "no network address" in result.stderr
    summary = (out / "summary.txt").read_text()
    assert summary.count("listeners=-  radio_cpu=-%  caddy_cpu=-%") == 2
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


def _stopped(pid: int) -> bool:
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
    return state.strip().startswith("T")


def _wait_for(path: Path, seconds: float = 20) -> None:
    deadline = time.monotonic() + seconds
    while not path.exists() or not path.read_text().strip():
        assert time.monotonic() < deadline, f"{path.name} never appeared"
        time.sleep(0.05)


# Value: protects=listeners' audio when the owner aborts mid-profile (Ctrl-C, dropped SSH, kill): py-spy is stopped and the radio process is resumed if left paused, for each signal the README promises; fails_when=the trap or one of its signals is removed, py-spy is left running, or the SIGCONT is dropped; why_new=the abort path is where this script can leave the live radio stopped; seam=fake py-spy that hangs, a stopped sleep standing in for uvicorn; no_claim=that real py-spy leaves a process paused when interrupted
@pytest.mark.timeout(30)
@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
def test_abort_stops_py_spy_and_resumes_the_radio(tmp_path: Path, sig: signal.Signals):
    radio = subprocess.Popen(["/bin/sleep", "60"])
    try:
        os.kill(radio.pid, signal.SIGSTOP)
        cmd, env = setup(tmp_path, FAKE_SPY_HANG="1", FAKE_RADIO_PID=str(radio.pid))
        script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _wait_for(tmp_path / "spy-pid")
        spy_pid = int((tmp_path / "spy-pid").read_text())
        assert _stopped(radio.pid)

        script.send_signal(sig)
        assert script.wait(timeout=15) == 130
        with pytest.raises(ProcessLookupError):
            os.kill(spy_pid, 0)
        assert not _stopped(radio.pid)
    finally:
        radio.kill()
        radio.wait()


# Value: protects=a py-spy that ignores SIGINT and SIGTERM (stuck mid-attach) is still ended and the radio resumed, so an abort can't hang with the radio paused; fails_when=the SIGKILL fallback or the SIGCONT before it is removed; why_new=owner-approved fix from the pre-landing review; seam=fake py-spy that ignores INT and TERM; no_claim=how long real py-spy takes to let go
@pytest.mark.timeout(40)
def test_abort_kills_a_stubborn_py_spy(tmp_path: Path):
    radio = subprocess.Popen(["/bin/sleep", "60"])
    try:
        os.kill(radio.pid, signal.SIGSTOP)
        cmd, env = setup(tmp_path, FAKE_SPY_STUBBORN="1", FAKE_RADIO_PID=str(radio.pid))
        script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _wait_for(tmp_path / "spy-pid")
        spy_pid = int((tmp_path / "spy-pid").read_text())

        script.send_signal(signal.SIGTERM)
        assert script.wait(timeout=25) == 130
        with pytest.raises(ProcessLookupError):
            os.kill(spy_pid, 0)
        assert not _stopped(radio.pid)
    finally:
        radio.kill()
        radio.wait()


# Value: protects=when py-spy dies early, the radio is resumed at once, not after the samplers finish the window (up to 300 s of no audio); fails_when=the SIGCONT right after py-spy's exit is removed, leaving only the one in the exit trap; why_new=red-team finding in the pre-landing review; seam=fake py-spy that fails, fake curl that slows the samplers, a stopped sleep standing in for uvicorn; no_claim=that real py-spy leaves a process paused when it dies
@pytest.mark.timeout(30)
def test_failed_py_spy_resumes_the_radio_before_the_samplers_finish(tmp_path: Path):
    radio = subprocess.Popen(["/bin/sleep", "60"])
    try:
        os.kill(radio.pid, signal.SIGSTOP)
        cmd, env = setup(tmp_path, FAKE_SPY_FAIL="1", FAKE_CURL_SLOW_AFTER_FAIL="1", FAKE_RADIO_PID=str(radio.pid))
        script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while not (tmp_path / "spy-failed").exists():
            assert time.monotonic() < deadline, "py-spy never ran"
            time.sleep(0.05)
        deadline = time.monotonic() + 3
        while _stopped(radio.pid):
            assert script.poll() is None, "the radio was only resumed at exit"
            assert time.monotonic() < deadline, "the radio stayed paused after py-spy failed"
            time.sleep(0.05)
        assert script.poll() is None  # the samplers are still running
        assert script.wait(timeout=20) == 0
    finally:
        radio.kill()
        radio.wait()


# Value: protects=py-spy never attaches to a pid that stopped being the radio's (a container restart during the 60 s baseline can hand the old pid to any process, which root would then pause); fails_when=the pid re-check before attaching is removed; why_new=Codex finding in the final review; seam=fake docker on PATH; no_claim=how fast the kernel reuses a pid
def test_radio_restart_during_the_baseline_is_not_profiled(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_PID_CHANGES="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    assert "not profiled: the radio container restarted during the baseline" in (out / "summary.txt").read_text()


# Value: protects=the memory gate fails closed: unreadable free -m doesn't count as enough memory for py-spy --native; fails_when=a non-numeric or empty reading is let through; why_new=specialist finding in the final review; seam=fake free on PATH; no_claim=why a real free -m would fail
def test_unreadable_memory_is_not_profiled(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_FREE_FAIL="1")
    assert result.returncode == 3
    assert not (tmp_path / "py-spy-args").exists()
    assert "not profiled: couldn't read free memory" in (out / "summary.txt").read_text()


# Value: protects=py-spy is the OOM killer's first choice (oom_score_adj 1000), not the radio and everyone's audio; fails_when=the oom_score_adj write is removed or its redirect breaks; why_new=specialist finding in the final review; seam=fake py-spy reads /proc/self/oom_score_adj; no_claim=macOS (no /proc; skipped)
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc/<pid>/oom_score_adj")
def test_py_spy_is_the_oom_killers_first_choice(tmp_path: Path):
    result, _ = run_profile(tmp_path, "30")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "py-spy-oom").read_text().strip() == "1000"


# Value: protects=py-spy's own "behind in sampling" warning reaches the summary on a run that otherwise succeeds, so numbers that read low are flagged; fails_when=the warnings block is removed or its pattern stops matching; why_new=red team and adversarial findings in the final review; seam=fake py-spy on PATH; no_claim=py-spy's exact wording in every version
def test_py_spy_warnings_reach_the_summary(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_SPY_WARN="1")
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    assert "== py-spy warnings" in summary
    assert "behind in sampling" in summary
    assert "by self time" in summary


# Value: protects=listeners' audio when py-spy starves the radio: two /healthz probes in a row without an answer stop py-spy and resume the radio, without anyone at the keyboard; fails_when=the watchdog is removed, needs more misses, or stops py-spy without the SIGCONT; why_new=owner-approved watchdog from the final review; seam=fake py-spy that hangs, fake curl that fails once sampling starts, a stopped sleep standing in for uvicorn; no_claim=that real /healthz misses mean py-spy is the cause
@pytest.mark.timeout(30)
def test_watchdog_stops_py_spy_when_the_radio_stops_answering(tmp_path: Path):
    radio = subprocess.Popen(["/bin/sleep", "60"])
    try:
        os.kill(radio.pid, signal.SIGSTOP)
        cmd, env = setup(
            tmp_path, FAKE_SPY_HANG="1", FAKE_CURL_FAIL_ONCE_SAMPLING="1", FAKE_RADIO_PID=str(radio.pid)
        )
        result = subprocess.run([*cmd, "30"], capture_output=True, text=True, env=env, timeout=25)
        assert result.returncode == 0, result.stderr
        spy_pid = int((tmp_path / "spy-pid").read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(spy_pid, 0)
        assert not _stopped(radio.pid)
        summary = (tmp_path / "out" / "summary.txt").read_text()
        assert "== aborted: the radio stopped answering /healthz" in summary
        # Two missed probes, then nothing more.
        assert summary.count("listeners=-") == 1 and "(2 rows)" in summary
    finally:
        radio.kill()
        radio.wait()
