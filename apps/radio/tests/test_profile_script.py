"""deploy/profile.sh, run against fake docker, py-spy, vmstat, curl and sleep on PATH."""

import os
import shutil
import signal
import stat
import subprocess
import textwrap
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "deploy" / "profile.sh"

FAKE_DOCKER = """#!/usr/bin/env bash
case "$1 $2" in
  "compose -f") case "$6" in radio) echo radioid;; caddy) echo caddyid;; esac ;;
  "inspect -f") case "$3" in *Pid*) echo "${FAKE_RADIO_PID:-4194303}";; *IPAddress*) echo "172.30.0.3 ";; esac ;;
  "stats --no-stream") echo "radioid 30.00%"; echo "caddyid 10.00%" ;;
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

FAKE_PY_SPY = """#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo "py-spy 0.4.1"; exit 0; fi
echo "$*" >"$FAKE_DIR/py-spy-args"
# Rows in samples.tsv when py-spy started: the baseline must be done by then.
wc -l <"$FAKE_DIR/out/samples.tsv" >"$FAKE_DIR/rows-at-spy-start"
if [[ -n "${FAKE_SPY_HANG:-}" ]]; then echo $$ >"$FAKE_DIR/spy-pid"; exec /bin/sleep 30; fi
if [[ -n "${FAKE_SPY_FAIL:-}" ]]; then echo "Permission denied (os error 13)" >&2; exit 1; fi
while [[ $# -gt 0 ]]; do [[ "$1" == --output ]] && out=$2; shift; done
cp "$FAKE_DIR/raw" "$out"
"""

# vmstat -n: two header lines, then the since-boot row (steal 90, must be
# dropped), then real samples with steal 10 and 20.
FAKE_VMSTAT = """#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/vmstat-args"
cat <<'OUT'
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 500000  10000 300000    0    0     0     0  100  200  5  5  0  0 90
 1  0      0 500000  10000 300000    0    0     0     0  100  200 40 20 30  0 10
 1  0      0 500000  10000 300000    0    0     0     0  100  200 50 10 20  0 20
OUT
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
        "curl": '#!/usr/bin/env bash\necho \'{"ok":true,"listeners":7,"maxListeners":15}\'\n',
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


# Value: protects=the Step 0 numbers for issue #153: steal and CPU averages per window (vmstat's since-boot row dropped), listeners from /healthz, radio/caddy CPU, busy share, self time per function and inclusive time per function and thread; fails_when=the since-boot row is averaged in, columns are misread, self time counts outer frames, a frame is split by line, or recursion is counted twice; why_new=new script; seam=fake docker/py-spy/vmstat/curl/sleep on PATH; no_claim=real py-spy attaching across the container boundary, real vmstat column order, tick timing (sleep is faked)
def test_summary(tmp_path: Path):
    result, out = run_profile(tmp_path, "30")
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    assert summary.count("listeners=7.0  radio_cpu=30.0%  caddy_cpu=10.0%") == 2
    assert summary.count("host us=45.0%  sy=15.0%  steal=15.0%  (2 samples)") == 2
    assert "100 non-idle samples of about 1500 per thread (7% busy, all threads)" in summary
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


# Value: protects=the profiler settings the owner approved for production (native stacks, per function, per thread, 50 Hz, the requested window, the radio's host PID) and that py-spy starts only after the baseline window, with vmstat covering each window; fails_when=a flag is dropped, the duration stops following the argument, py-spy overlaps the baseline, or a vmstat count drifts from its window; why_new=new script; seam=fake py-spy and vmstat on PATH; no_claim=py-spy's own flag parsing
def test_py_spy_settings_and_windows(tmp_path: Path):
    result, _ = run_profile(tmp_path, "45")
    assert result.returncode == 0, result.stderr
    args = (tmp_path / "py-spy-args").read_text().split()
    assert args[:3] == ["record", "--pid", "4194303"]
    for flag, value in (("--rate", "50"), ("--duration", "45"), ("--format", "raw")):
        assert args[args.index(flag) + 1] == value
    assert {"--native", "--function", "--threads"} <= set(args)
    assert int((tmp_path / "rows-at-spy-start").read_text()) >= 1 + 60 // 5
    assert (tmp_path / "vmstat-args").read_text().splitlines() == ["-n 5 13", "-n 5 10"]


# Value: protects=the cap on how long py-spy may pause the process that streams every listener's audio, and windows that line up with the 5 s samples; fails_when=the 30-300 s bounds, the step-of-5 check or the number check are removed; why_new=new script; seam=none; no_claim=that 300 s of pauses is inaudible
@pytest.mark.parametrize("arg", ["301", "29", "33", "2m"])
def test_rejects_bad_window(tmp_path: Path, arg: str):
    result, out = run_profile(tmp_path, arg)
    assert result.returncode == 2
    assert not (tmp_path / "py-spy-args").exists()
    assert not out.exists()


# Value: protects=a failed attach (no root, wrong PID) still leaves the unprofiled numbers and says why; fails_when=set -e aborts on py-spy's exit or the error is swallowed; why_new=new script; seam=fake py-spy on PATH; no_claim=py-spy's real error text
def test_py_spy_failure_keeps_the_numbers(tmp_path: Path):
    result, out = run_profile(tmp_path, "30", FAKE_SPY_FAIL="1")
    assert result.returncode == 0, result.stderr
    summary = (out / "summary.txt").read_text()
    assert "py-spy failed (exit 1)" in summary
    assert "Permission denied" in summary
    assert "steal=15.0%" in summary


# Value: protects=the script refuses to start without py-spy rather than sampling a window with no profile; fails_when=the check is removed; why_new=new script; seam=PATH without py-spy; no_claim=none
def test_needs_py_spy(tmp_path: Path):
    result, out = run_profile(tmp_path, spy=False)
    assert result.returncode == 1
    assert "/opt/py-spy/bin/pip install py-spy" in result.stderr
    assert not out.exists()


def _stopped(pid: int) -> bool:
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
    return state.strip().startswith("T")


# Value: protects=listeners' audio when the owner aborts mid-profile (Ctrl-C, dropped SSH): py-spy is stopped and the radio process is resumed if left paused; fails_when=the trap is removed, py-spy is left running, or the SIGCONT is dropped; why_new=the only path where this script can leave the live radio stopped; seam=fake py-spy that hangs, a stopped sleep standing in for uvicorn; no_claim=that real py-spy leaves a process paused when interrupted
@pytest.mark.timeout(30)
def test_abort_stops_py_spy_and_resumes_the_radio(tmp_path: Path):
    radio = subprocess.Popen(["/bin/sleep", "60"])
    try:
        os.kill(radio.pid, signal.SIGSTOP)
        cmd, env = setup(tmp_path, FAKE_SPY_HANG="1", FAKE_RADIO_PID=str(radio.pid))
        script = subprocess.Popen([*cmd, "30"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        spy_pid_file = tmp_path / "spy-pid"
        deadline = time.monotonic() + 20
        while not spy_pid_file.exists() or not spy_pid_file.read_text().strip():
            assert time.monotonic() < deadline, "py-spy never started"
            time.sleep(0.05)
        spy_pid = int(spy_pid_file.read_text())
        assert _stopped(radio.pid)

        script.send_signal(signal.SIGTERM)
        assert script.wait(timeout=10) == 130
        with pytest.raises(ProcessLookupError):
            os.kill(spy_pid, 0)
        assert not _stopped(radio.pid)
    finally:
        radio.kill()
        radio.wait()
