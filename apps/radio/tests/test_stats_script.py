"""deploy/stats.sh, run against a fake `docker` on PATH (no Docker needed)."""

import os
import shutil
import stat
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "deploy" / "stats.sh"

TOKEN = "e0secrettoken99"
BROWSER_IP = "203.0.113.45"
KIWI_HOST = "198.51.100.7"

# Docker's -t timestamps, uvicorn access lines and #144 receiver-log lines.
LOGS = textwrap.dedent(
    f"""\
    2026-11-26T08:01:02.000000000Z INFO:     {BROWSER_IP}:0 - "WebSocket /ws?token={TOKEN}" [accepted]
    2026-11-26T08:15:00.000000000Z INFO:     {BROWSER_IP}:0 - "WebSocket /ws?token={TOKEN}" [accepted]
    2026-11-26T09:20:00.000000000Z INFO:     {BROWSER_IP}:0 - "WebSocket /ws?token={TOKEN}" [accepted]
    2026-11-26T09:20:01.000000000Z INFO:     {BROWSER_IP}:0 - "GET /noise?receivers={KIWI_HOST}%3A8073 HTTP/1.1" 200
    2026-11-26T09:21:00.000000000Z INFO skywave_radio.receivers event=refused host={KIWI_HOST} port=8073 code=full detail=- audio_s=0.0 listeners=15
    2026-11-26T09:22:00.000000000Z INFO skywave_radio.receivers event=refused host={KIWI_HOST} port=8073 code=full detail=- audio_s=0.0 listeners=14
    2026-11-26T09:30:00.000000000Z INFO skywave_radio.receivers event=closed host={KIWI_HOST} port=8073 code=- detail=- audio_s=812.4 listeners=9
    """
)

# /proc/net/tcp: two established browser sockets on :8765 (0x223D), one
# established Kiwi socket, one listening socket (st 0A) that must not count.
PROC_TCP = textwrap.dedent(
    """\
      sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
       0: 0300A8C0:223D 0200A8C0:D431 01 00000000:00000000 00:00000000 00000000     0        0 1
       1: 0300A8C0:223D 0200A8C0:D432 01 00000000:00000000 00:00000000 00000000     0        0 2
       2: 0300A8C0:9C40 0733C6C6:1F99 01 00000000:00000000 00:00000000 00000000     0        0 3
       3: 00000000:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4
    """
)

# A fake docker: each subcommand the script runs, plus switches to make the
# exec or logs calls fail. tcp6 is absent (exit 1), as on a kernel without IPv6.
FAKE_DOCKER = """#!/usr/bin/env bash
case "$1" in
  compose) case "$6" in radio) echo radioid;; caddy) echo caddyid;; esac ;;
  stats) echo "  skywave-radio-1  cpu=21.73%  mem=125.9MiB / 1.922GiB" ;;
  inspect)
    case "$3" in
      *Created*) echo "${FAKE_CREATED:-2026-11-20T00:00:00.000000000Z}" ;;
      *) echo "  radio started=2026-11-25T06:00:00Z  health=healthy" ;;
    esac ;;
  exec)
    [ -n "${FAKE_FAIL_EXEC:-}" ] && { echo "Error: container is restarting" >&2; exit 1; }
    case "$3 $4" in
      "cat /proc/net/tcp") cat "$FAKE_DIR/proc_tcp" ;;
      "cat /proc/net/tcp6") exit 1 ;;
      # The script the real container runs, with RECEIVER_LOG set as in production.
      "sh -c")
        if [ -f "$FAKE_DIR/receivers.log" ]; then RECEIVER_LOG="$FAKE_DIR/receivers.log" sh -c "$5"
        else sh -c "$5"; fi ;;
      *) echo "unexpected docker exec: $*" >&2; exit 9 ;;
    esac ;;
  logs)
    [ -n "${FAKE_FAIL_LOGS:-}" ] && { echo "Error: no such container" >&2; exit 1; }
    cat "$FAKE_DIR/logs" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
"""

# A fixed "now" (17:07 UTC, when the workflow runs), so the 24 h cut is stable.
FAKE_DATE = """#!/usr/bin/env bash
for a in "$@"; do [ "$a" = -d ] && { echo 2026-11-25T17:07:00; exit 0; }; done
echo 2026-11-26T17:07:00Z
"""


def run_stats(
    tmp_path: Path,
    logs: str,
    sar: str | None = None,
    receivers: str | None = None,
    **env_extra: str,
) -> subprocess.CompletedProcess[str]:
    # A copy of the repo's layout: the script cds to its parent's parent and
    # reads apps/radio/.env there.
    root = tmp_path / "repo"
    (root / "deploy").mkdir(parents=True)
    (root / "apps" / "radio").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "deploy" / "stats.sh")
    (root / "apps" / "radio" / ".env").write_text(
        f"RADIO_TOKEN={TOKEN}\nMAX_SESSIONS=15\nMAX_SOCKETS_PER_IP=8\n"
    )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
    fake_date = bin_dir / "date"
    fake_date.write_text(FAKE_DATE)
    fake_date.chmod(fake_date.stat().st_mode | stat.S_IEXEC)
    (tmp_path / "proc_tcp").write_text(PROC_TCP)
    (tmp_path / "logs").write_text(logs)
    if receivers is not None:
        # Split across the live file and one rotated copy, as RotatingFileHandler leaves it.
        lines = receivers.splitlines(keepends=True)
        (tmp_path / "receivers.log.1").write_text("".join(lines[:2]))
        (tmp_path / "receivers.log").write_text("".join(lines[2:]))
    if sar is not None:
        fake_sar = bin_dir / "sar"
        fake_sar.write_text(f"#!/usr/bin/env bash\ncat <<'OUT'\n{sar}OUT\n")
        fake_sar.chmod(fake_sar.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_DIR": str(tmp_path), **env_extra}
    return subprocess.run(
        ["bash", str(root / "deploy" / "stats.sh")], capture_output=True, text=True, env=env, timeout=30
    )


pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


# Value: protects=stats.sh's promise that its output is counts only: the radio token, listener addresses and Kiwi hosts in the logs, the receiver log file and .env never appear, and only MAX_* limits are read from .env; fails_when=the script echoes raw log lines, prints the .env, or a refactor greps a wider pattern; why_new=the script is the only thing a monitoring SSH key may run, so its output is what that key can see; seam=fake docker on PATH; no_claim=real docker output formats
def test_prints_no_secrets_or_addresses(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS)
    assert out.returncode == 0, out.stderr
    for secret in (TOKEN, BROWSER_IP, KIWI_HOST, "RADIO_TOKEN"):
        assert secret not in out.stdout
    assert "MAX_SESSIONS=15" in out.stdout


# Value: protects=the load numbers used to decide when to scale: open browser vs Kiwi sockets from the container's TCP table, /ws sessions per UTC hour, refusals by code and peak listeners per hour; fails_when=the port test, the established-state filter, the hour bucketing or the receiver-log parsing is wrong; why_new=issue #153 needs these numbers one command away; seam=fake docker on PATH; no_claim=that the live receiver log keeps this exact line format
def test_counts(tmp_path: Path):
    out = run_stats(tmp_path, LOGS).stdout
    assert "browser_sockets=2  kiwi_sockets=1" in out
    assert "2026-11-26T08  2" in out
    assert "2026-11-26T09  1" in out
    assert "2  event=refused code=full" in out
    assert "1  event=closed code=-" in out
    assert "2026-11-26T09  15" in out


LOGS_NO_EVENTS = "\n".join(line for line in LOGS.splitlines() if " event=" not in line) + "\n"

# The RECEIVER_LOG file as server.py writes it ("%(asctime)s %(message)s", local
# time = UTC), oldest rotated copy first. The first line is outside the 24 h.
RECEIVERS = textwrap.dedent(
    f"""\
    2026-11-25 10:00:00,001 event=refused host={KIWI_HOST} port=8073 code=full detail=- audio_s=0.0 listeners=15
    2026-11-26 09:21:00,123 event=refused host={KIWI_HOST} port=8073 code=full detail=- audio_s=0.0 listeners=15
    2026-11-26 09:40:00,500 event=listening host={KIWI_HOST} port=8073 code=- detail=- audio_s=0.0 listeners=11
    2026-11-26 13:05:00,000 event=error host={KIWI_HOST} port=8073 code=busy detail=too_busy=4 audio_s=3.2 listeners=6
    """
)


# Value: protects=the empty message says no lines arrived in the window, not that the build can't write them, and an empty read doesn't abort; fails_when=the old "doesn't write them" wording returns or an empty grep trips set -e/pipefail; why_new=that wording misled the #155 reader on v0.61; seam=fake docker on PATH; no_claim=none
def test_no_receiver_lines(tmp_path: Path):
    out = run_stats(tmp_path, LOGS_NO_EVENTS, receivers="")
    assert out.returncode == 0, out.stderr
    assert "(no receiver-log lines in the last 24 h)" in out.stdout
    assert "doesn't write" not in out.stdout


# Value: protects=production's receiver log (RECEIVER_LOG file plus rotated copies, "date time,ms" stamps) is counted, grouped by UTC hour, and cut at 24 h; fails_when=the script reads only docker logs, keys hours on the date alone, or keeps a line older than 24 h; why_new=test_counts feeds docker-log lines only, which production never writes; seam=fake docker and date on PATH; no_claim=real rotation timing on the Droplet (the in-container sh script runs for real against a .1 copy)
def test_counts_from_receiver_log_file(tmp_path: Path):
    out = run_stats(tmp_path, LOGS_NO_EVENTS, receivers=RECEIVERS)
    assert out.returncode == 0, out.stderr
    section = out.stdout.split("== receiver log")[1].split("== host CPU")[0]
    assert "1  event=refused code=full" in section  # the 2026-11-25 10:00 line is outside the window
    assert "1  event=listening code=-" in section
    assert "1  event=error code=busy" in section
    assert "2026-11-26T09  15" in section
    assert "2026-11-26T13  6" in section
    assert "2026-11-25" not in section
    assert KIWI_HOST not in out.stdout


# Value: protects=lines the service sent to its own logs (it couldn't open the file) still count alongside the file's; fails_when=one source is dropped or the two timestamp forms don't land in the same hour; why_new=server.py's stdout fallback (attach_receiver_log) leaves RECEIVER_LOG set; seam=fake docker on PATH; no_claim=that a line is never in both (server.py sets propagate=False once the file opens)
def test_merges_file_and_container_lines(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS).stdout
    assert "3  event=refused code=full" in out
    assert "2026-11-26T09  15" in out


# Value: protects=a day cut short by a deploy says so, and a restart that kept the logs doesn't; fails_when=the label keys on StartedAt, compares the wrong form, or is dropped; why_new=new label (D2/D4); seam=fake docker and date on PATH; no_claim=docker's real .Created format beyond its first 19 characters
def test_label_after_recreate(tmp_path: Path):
    recreated = run_stats(tmp_path / "a", LOGS, FAKE_CREATED="2026-11-26T10:00:01.123456789Z").stdout
    assert "(since 2026-11-26T10:00:01Z; earlier hours were in the previous container)" in recreated
    # started 2026-11-25T06:00Z per the fake inspect; created long before: logs kept, no label
    kept = run_stats(tmp_path / "b", LOGS).stdout
    assert "previous container" not in kept


# Value: protects=a failed docker exec or docker logs skips only its own section, so the rest of the daily report still posts; fails_when=any exec or logs call loses its fallback under set -euo pipefail; why_new=stats.sh:46 ended the script on a failed exec (D5); seam=fake docker on PATH; no_claim=docker's real error behaviour while a container restarts
def test_failed_exec_and_logs_keep_reporting(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, sar=SAR, receivers=RECEIVERS, FAKE_FAIL_EXEC="1", FAKE_FAIL_LOGS="1")
    assert out.returncode == 0, out.stderr
    assert "(couldn't read the container's sockets)" in out.stdout
    assert "(couldn't read the container's logs)" in out.stdout
    assert "(couldn't read the receiver log file" in out.stdout
    assert "(no receiver-log lines in the last 24 h)" in out.stdout
    assert "  10:00   65.0 /  80.0" in out.stdout


# `sar -u` as LC_ALL=C prints it: a header, 10-minute samples, then an Average line.
SAR = textwrap.dedent(
    """\
    Linux 6.8.0-149-generic (skywave-radio) 11/26/2026 _x86_64_ (1 CPU)

    00:00:01        CPU     %user     %nice   %system   %iowait    %steal     %idle
    00:10:01        all     10.00      0.00      5.00      0.00      0.00     85.00
    00:20:01        all     20.00      0.00     10.00      0.00      0.00     70.00
    10:00:01        all     60.00      0.00     20.00      0.00      0.00     20.00
    10:10:01        all     40.00      0.00     10.00      0.00      0.00     50.00
    Average:        all     32.50      0.00     11.25      0.00      0.00     56.25
    """
)


# Value: protects=hourly host CPU in the daily load log, avg and max of sysstat's 10-minute samples per UTC hour, so a short peak isn't averaged away; fails_when=busy isn't 100 - %idle, the header or Average line is counted, or hours mix; why_new=the radio-stats workflow (issue #153) needs CPU history, not one reading; seam=fake sar on PATH; no_claim=sysstat's own sampling or that it's enabled on the box
def test_hourly_cpu_from_sar(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, sar=SAR).stdout
    assert "  00:00   22.5 /  30.0" in out
    assert "  10:00   65.0 /  80.0" in out
    assert "Average" not in out.split("== host CPU")[1]
