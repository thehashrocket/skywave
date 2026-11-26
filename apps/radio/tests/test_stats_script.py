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

FAKE_DOCKER = """#!/usr/bin/env bash
case "$1 $2" in
  "compose -f") case "$6" in radio) echo radioid;; caddy) echo caddyid;; esac ;;
  "stats --no-stream") echo "  skywave-radio-1  cpu=21.73%  mem=125.9MiB / 1.922GiB" ;;
  "inspect -f") echo "  radio started=2026-11-25T06:00:00Z  health=healthy" ;;
  "exec radioid") cat "$FAKE_DIR/proc_tcp" ;;
  "logs -t") cat "$FAKE_DIR/logs" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
"""


def run_stats(tmp_path: Path, logs: str) -> subprocess.CompletedProcess[str]:
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
    assert "no receiver-log lines" in out.stdout
