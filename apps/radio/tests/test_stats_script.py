"""deploy/stats.sh, run against a fake `docker` on PATH (no Docker needed)."""

import os
import shutil
import stat
import subprocess
import textwrap
from datetime import datetime, timedelta, timezone
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

FAKE_DOCKER = """#!/usr/bin/env bash
case "$1 $2" in
  "compose -f") case "$6" in radio) echo radioid;; caddy) echo caddyid;; esac ;;
  "stats --no-stream") echo "  skywave-radio-1  cpu=21.73%  mem=125.9MiB / 1.922GiB" ;;
  "inspect -f") case "$3" in
      *Health*) echo "  radio started=2026-11-25T06:00:00Z  health=healthy" ;;
      *) cat "$FAKE_DIR/started" ;;
    esac ;;
  "exec radioid") case "$3" in
      cat) cat "$FAKE_DIR/proc_tcp" ;;
      sh) [ -f "$FAKE_DIR/receivers" ] && cat "$FAKE_DIR/receivers"; exit 0 ;;
      *) echo "unexpected exec: $*" >&2; exit 9 ;;
    esac ;;
  "logs -t") cat "$FAKE_DIR/logs" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
"""


def run_stats(
    tmp_path: Path,
    logs: str,
    sar: str | None = None,
    receivers: str | None = None,
    started: str = "2026-11-01T00:00:00.000000000Z",
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
    (tmp_path / "proc_tcp").write_text(PROC_TCP)
    (tmp_path / "logs").write_text(logs)
    (tmp_path / "started").write_text(started + "\n")
    if receivers is not None:
        (tmp_path / "receivers").write_text(receivers)
    if sar is not None:
        fake_sar = bin_dir / "sar"
        fake_sar.write_text(f"#!/usr/bin/env bash\ncat <<'OUT'\n{sar}OUT\n")
        fake_sar.chmod(fake_sar.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_DIR": str(tmp_path)}
    return subprocess.run(
        ["bash", str(root / "deploy" / "stats.sh")], capture_output=True, text=True, env=env, timeout=30
    )


pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


# Value: protects=stats.sh's promise that its output is counts only: the radio token, listener addresses and Kiwi hosts in the logs and .env never appear, and only MAX_* limits are read from .env; fails_when=the script echoes raw log lines, prints the .env, or a refactor greps a wider pattern; why_new=the script is the only thing a monitoring SSH key may run, so its output is what that key can see; seam=fake docker on PATH; no_claim=real docker output formats
def test_prints_no_secrets_or_addresses(tmp_path: Path):
    out = run_stats(tmp_path, LOGS)
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


# Value: protects=the script still reports on a build without the #144 receiver log instead of failing; fails_when=an empty grep aborts under set -e/pipefail; why_new=production ran such a build when the script was written; seam=fake docker on PATH; no_claim=none
def test_without_receiver_log(tmp_path: Path):
    logs = "\n".join(line for line in LOGS.splitlines() if " event=" not in line) + "\n"
    out = run_stats(tmp_path, logs)
    assert out.returncode == 0, out.stderr
    assert "no receiver-log lines in the last 24 h" in out.stdout


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


def receiver_line(at: datetime, rest: str) -> str:
    """A RECEIVER_LOG file line: logging's asctime ("2026-11-26 10:00:56,411"), then the message."""
    return at.strftime("%Y-%m-%d %H:%M:%S,000 ") + rest + "\n"


# Value: protects=production's receiver log is read from RECEIVER_LOG in the container (/data/receivers.log and its rotated .1-.4, oldest first), with only the last 24 h counted and its "date time," stamp bucketed by UTC hour like docker's; fails_when=the script reads only docker logs (where production writes none of these lines), the 24 h cutoff is wrong, rotated lines are dropped, or the hour key is built from the wrong field; why_new=the first live run found the section empty because RECEIVER_LOG keeps these lines off stdout (#144 owner D1); seam=fake docker on PATH; no_claim=that the live file is complete (the writer can drop lines under a stalled disk and says so with event=dropped)
def test_receiver_log_file(tmp_path: Path):
    now = datetime.now(timezone.utc).replace(minute=30, second=0, microsecond=0)
    hour = now.strftime("%Y-%m-%dT%H")
    receivers = (
        receiver_line(now - timedelta(hours=30), "event=refused host=old port=8073 code=full detail=- audio_s=0.0 listeners=15")
        + receiver_line(now - timedelta(minutes=10), "event=refused host=h port=8073 code=skywave_cap detail=- audio_s=0.0 listeners=11")
        + receiver_line(now - timedelta(minutes=5), "event=listening host=h port=8073 code=- detail=- audio_s=0.0 listeners=12")
    )
    logs = "\n".join(line for line in LOGS.splitlines() if " event=" not in line) + "\n"
    out = run_stats(tmp_path, logs, receivers=receivers).stdout
    section = out.split("== receiver log")[1].split("== host CPU")[0]
    assert "1  event=refused code=skywave_cap" in section
    assert "1  event=listening code=-" in section
    assert "code=full" not in section  # 30 h old
    assert f"{hour}  12" in section


# Value: protects=the sessions-per-hour count says when it only covers time since a restart, so a deploy isn't read as traffic falling off; fails_when=the note is missing after a recent start or shown for a container up more than a day; why_new=a deploy (#157) restarted the container minutes before the first live run; seam=fake docker on PATH; no_claim=none
def test_restart_note(tmp_path: Path):
    recent = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
    assert "only since the container started" in run_stats(tmp_path, LOGS, started=recent).stdout
    assert "only since the container started" not in run_stats(tmp_path / "old", LOGS).stdout
