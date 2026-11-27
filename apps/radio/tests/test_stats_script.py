"""deploy/stats.sh, run against a fake `docker` on PATH (no Docker needed)."""

import os
import shutil
import stat
import subprocess
import sys
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
# exec or logs calls fail. Without a proc_tcp6 file, tcp6 is absent (exit 1), as
# on a kernel without IPv6.
FAKE_DOCKER = """#!/usr/bin/env bash
case "$1" in
  compose) case "$6" in radio) echo radioid;; caddy) echo caddyid;; esac ;;
  stats)
    [ -n "${FAKE_FAIL_STATS:-}" ] && { echo "Error: container is restarting" >&2; exit 1; }
    echo "  skywave-radio-1  cpu=21.73%  mem=125.9MiB / 1.922GiB" ;;
  inspect)
    [ -n "${FAKE_FAIL_INSPECT:-}" ] && { echo "Error: container is restarting" >&2; exit 1; }
    case "$3" in
      *Created*) echo "${FAKE_CREATED:-2026-11-20T00:00:00.000000000Z}" ;;
      *Health*) echo "  radio started=${FAKE_STARTED:-2026-11-25T06:00:00Z}  health=healthy" ;;
      *StartedAt*) echo "${FAKE_STARTED:-2026-11-25T06:00:00Z}" ;;
      *) echo "unexpected docker inspect: $*" >&2; exit 9 ;;
    esac ;;
  exec)
    [ -n "${FAKE_FAIL_EXEC:-}" ] && { echo "Error: container is restarting" >&2; exit 1; }
    case "$3 $4" in
      "cat /proc/net/tcp") cat "$FAKE_DIR/proc_tcp" ;;
      "cat /proc/net/tcp6") [ -f "$FAKE_DIR/proc_tcp6" ] || exit 1; cat "$FAKE_DIR/proc_tcp6" ;;
      # The script the real container runs, with RECEIVER_LOG set as in production.
      "sh -c")
        [ -n "${FAKE_FAIL_FILE:-}" ] && { echo "Error: container is restarting" >&2; exit 1; }
        # Stream the file, then die, as a restart in the middle of the read does.
        [ -n "${FAKE_FAIL_FILE_MIDREAD:-}" ] && { cat "$FAKE_DIR/receivers.log"; exit 137; }
        # An image whose stat can't read the inode.
        if [ -n "${FAKE_STAT_FAILS:-}" ]; then
          mkdir -p "$FAKE_DIR/statbin"
          printf '#!/bin/sh\nexit 1\n' > "$FAKE_DIR/statbin/stat"
          chmod +x "$FAKE_DIR/statbin/stat"
          PATH="$FAKE_DIR/statbin:$PATH" RECEIVER_LOG="$FAKE_DIR/receivers.log" sh -c "$5"; exit $?
        fi
        # RotatingFileHandler rotating mid-read: a cat that renames the live file
        # and opens a fresh one once it has read it.
        if [ -n "${FAKE_ROTATE_MIDREAD:-}" ]; then
          mkdir -p "$FAKE_DIR/rotbin"
          printf '#!/bin/sh\n/bin/cat "$@"\nmv "$RECEIVER_LOG" "$RECEIVER_LOG.1"; : > "$RECEIVER_LOG"\n' > "$FAKE_DIR/rotbin/cat"
          chmod +x "$FAKE_DIR/rotbin/cat"
          PATH="$FAKE_DIR/rotbin:$PATH" RECEIVER_LOG="$FAKE_DIR/receivers.log" sh -c "$5"; exit $?
        fi
        if [ -n "${FAKE_RECEIVER_LOG:-}" ]; then RECEIVER_LOG="$FAKE_RECEIVER_LOG" sh -c "$5"
        elif [ -f "$FAKE_DIR/receivers.log" ]; then RECEIVER_LOG="$FAKE_DIR/receivers.log" sh -c "$5"
        else sh -c "$5"; fi ;;
      *) echo "unexpected docker exec: $*" >&2; exit 9 ;;
    esac ;;
  logs)
    [ -n "${FAKE_FAIL_LOGS:-}" ] && { echo "Error: no such container" >&2; exit 1; }
    # The full log (no --since) starts with the server's start-up line unless
    # docker's own size cap has already rotated it out.
    case "$*" in
      *--since*) ;;
      *) [ -n "${FAKE_LOGS_TRIMMED:-}" ] || echo "2026-11-25T06:00:01.000000000Z INFO:     Started server process [1]" ;;
    esac
    cat "$FAKE_DIR/logs" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
"""

# A fixed "now" (17:07 UTC, when the workflow runs), so the 24 h cut is stable.
FAKE_DATE = """#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "24 hours ago" ] && { echo 2026-11-25T17:07:00; exit 0; }; done
for a in "$@"; do [ "$a" = -d ] && exec /bin/date "$@"; done
echo 2026-11-26T17:07:00Z
"""


def run_stats(
    tmp_path: Path,
    logs: str,
    sar: str | None = None,
    receivers: str | None = None,
    files: dict[str, str] | None = None,
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
    for name, text in (files or {}).items():
        (tmp_path / name).write_text(text)
    if sar is not None:
        fake_sar = bin_dir / "sar"
        fake_sar.write_text(f"#!/usr/bin/env bash\ncat <<'OUT'\n{sar}OUT\n")
        fake_sar.chmod(fake_sar.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_DIR": str(tmp_path), **env_extra}
    return subprocess.run(
        ["bash", str(root / "deploy" / "stats.sh")], capture_output=True, text=True, env=env, timeout=30
    )


# stats.sh runs only on the Droplet: it calls GNU date -d, free and
# /proc/loadavg for real (only docker and sar are faked), so off Linux it
# can't run at all. CI runs on Ubuntu.
pytestmark = [
    pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash"),
    pytest.mark.skipif(not sys.platform.startswith("linux"), reason="stats.sh is Linux-only (date -d, free, /proc)"),
]


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
    # A crash restart inside the window keeps the container (created long before)
    # and its logs: no label.
    kept = run_stats(tmp_path / "b", LOGS, FAKE_STARTED="2026-11-26T12:00:00Z").stdout
    assert "previous container" not in kept


# Value: protects=a failed docker stats, inspect, exec or logs call skips only its own section, so the rest of the daily report still posts, and a receiver section that read nothing says so instead of "no lines"; fails_when=any docker call loses its fallback under set -euo pipefail, or both reads failing prints the quiet-day message; why_new=stats.sh:46 ended the script on a failed exec (D5); seam=fake docker on PATH; no_claim=docker's real error behaviour while a container restarts
def test_failed_exec_and_logs_keep_reporting(tmp_path: Path):
    out = run_stats(
        tmp_path, LOGS, sar=SAR, receivers=RECEIVERS,
        FAKE_FAIL_EXEC="1", FAKE_FAIL_LOGS="1", FAKE_FAIL_STATS="1", FAKE_FAIL_INSPECT="1",
    )
    assert out.returncode == 0, out.stderr
    assert "(couldn't read the containers' CPU and memory)" in out.stdout
    assert "(couldn't read the radio container's start and health)" in out.stdout
    assert "previous container" not in out.stdout  # no .Created, no label
    assert "(couldn't read the container's sockets)" in out.stdout
    assert "(couldn't read the container's logs)" in out.stdout
    # Nothing was read, so it must not read as a quiet day.
    assert "(couldn't read the receiver log file or the container's logs)" in out.stdout
    assert "no receiver-log lines" not in out.stdout
    assert "  10:00   65.0 /  80.0" in out.stdout


# Value: protects=when only the receiver log file can't be read, the container-log receiver lines are still counted, as the message promises; fails_when=a failed file read discards or blanks the container-log events; why_new=the failure test fails both reads at once, so it can't see this; seam=fake docker on PATH; no_claim=docker's real error output
def test_file_read_fails_still_counts_container_lines(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS, FAKE_FAIL_FILE="1").stdout
    assert "(couldn't read the receiver log file; only the container's logs are counted)" in out
    assert "2  event=refused code=full" in out  # the two container-log lines, not the file's
    assert "event=listening" not in out  # file-only line


# Value: protects=a receiver-file read cut short mid-stream counts none of its partial lines, matching the "only the container's logs are counted" note; fails_when=lines read before the failure are merged into the counts; why_new=the other failure tests fail before any line is read; seam=fake docker on PATH; no_claim=how docker exec reports a killed container
def test_file_read_cut_short_counts_nothing_from_the_file(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS, FAKE_FAIL_FILE_MIDREAD="1").stdout
    assert "(couldn't read the receiver log file; only the container's logs are counted)" in out
    assert "2  event=refused code=full" in out  # container-log lines only
    assert "event=listening" not in out and "code=busy" not in out  # file lines dropped


# Value: protects=IPv6 browser and Kiwi sockets are added to the open-socket counts; fails_when=the tcp6 read is dropped or its output isn't appended; why_new=every other test runs without tcp6; seam=fake docker on PATH; no_claim=the kernel's tcp6 columns beyond state and local port
def test_counts_tcp6_sockets(tmp_path: Path):
    tcp6 = textwrap.dedent(
        """\
          sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
           0: 00000000000000000000000001000000:223D 00000000000000000000000002000000:D433 01 00000000:00000000 00:00000000 00000000     0        0 5
           1: 00000000000000000000000001000000:9C41 00000000000000000000000003000000:1F99 01 00000000:00000000 00:00000000 00000000     0        0 6
        """
    )
    out = run_stats(tmp_path, LOGS, files={"proc_tcp6": tcp6}).stdout
    assert "browser_sockets=3  kiwi_sockets=2" in out


# Value: protects=the older rotated copies (.2 to .4) inside the window are counted too; fails_when=the cat list drops .2, .3 or .4; why_new=the other tests only fill the live file and .1; seam=fake docker runs the real in-container sh against these files; no_claim=the Droplet's real rotation timing
def test_reads_older_rotated_copies(tmp_path: Path):
    out = run_stats(
        tmp_path,
        LOGS_NO_EVENTS,
        files={
            "receivers.log.4": f"2026-11-26 08:00:00,000 event=refused host={KIWI_HOST} port=8073 code=skywave_cap detail=- audio_s=0.0 listeners=15\n",
            "receivers.log.3": f"2026-11-26 08:30:00,000 event=error host={KIWI_HOST} port=8073 code=timeout detail=- audio_s=0.0 listeners=14\n",
            "receivers.log.2": f"2026-11-26 09:00:00,000 event=error host={KIWI_HOST} port=8073 code=busy detail=- audio_s=0.0 listeners=13\n",
            "receivers.log": f"2026-11-26 10:00:00,000 event=listening host={KIWI_HOST} port=8073 code=- detail=- audio_s=0.0 listeners=12\n",
        },
    ).stdout
    for counted in ("event=refused code=skywave_cap", "event=error code=timeout", "event=error code=busy", "event=listening code=-"):
        assert f"1  {counted}" in out


# Value: protects=when the container's logs can't be read the receiver section says so, still counts the file, and never prints the quiet-day "no lines" message; fails_when=a logs-only failure falls through to "no receiver-log lines" or drops the note; why_new=the other failure tests fail the file read too; seam=fake docker on PATH; no_claim=docker's real error output
def test_logs_unread_never_reads_as_quiet_day(tmp_path: Path):
    out = run_stats(tmp_path / "a", LOGS, receivers=RECEIVERS, FAKE_FAIL_LOGS="1").stdout
    assert "(couldn't read the container's logs; only the receiver log file is counted)" in out
    assert "1  event=listening code=-" in out  # from the file
    empty = run_stats(tmp_path / "b", LOGS, receivers="", FAKE_FAIL_LOGS="1").stdout
    assert "no receiver-log lines" not in empty


# Value: protects=a set RECEIVER_LOG whose live file is missing (wrong path, unmounted volume) is reported as unread, not as an empty day; fails_when=the in-container read treats a missing live file like a missing rotated copy; why_new=new missing-file check; seam=fake docker runs the real in-container sh; no_claim=the Droplet's real mount layout
def test_missing_receiver_log_file_is_a_failed_read(tmp_path: Path):
    out = run_stats(tmp_path / "a", LOGS, FAKE_RECEIVER_LOG=str(tmp_path / "missing.log")).stdout
    assert "(couldn't read the receiver log file; only the container's logs are counted)" in out
    assert "no receiver-log lines" not in out
    assert "2  event=refused code=full" in out  # the container-log lines still count
    # The same unreadable file on a day the container logs hold no receiver lines:
    # nothing was counted from where production writes, so no quiet-day message.
    quiet = run_stats(tmp_path / "b", LOGS_NO_EVENTS, FAKE_RECEIVER_LOG=str(tmp_path / "missing.log")).stdout
    assert "(couldn't read the receiver log file; only the container's logs are counted)" in quiet
    assert "no receiver-log lines" not in quiet


# Value: protects=without RECEIVER_LOG (dev, or local runs) an empty day reads as empty, not as a failed file read; fails_when=the in-container read exits non-zero when RECEIVER_LOG is unset; why_new=no test checked the unset path's notes; seam=fake docker runs the real in-container sh; no_claim=production's environment
def test_unset_receiver_log_is_a_clean_read(tmp_path: Path):
    out = run_stats(tmp_path, LOGS_NO_EVENTS).stdout
    assert "(no receiver-log lines in the last 24 h)" in out
    assert "couldn't read the receiver log file" not in out


# Value: protects=a day whose only receiver lines are event=dropped notes (no code= field) still prints the rest of the report; fails_when=the event/code grep's empty result ends the script under set -e/pipefail; why_new=every other fixture has code= on each line; seam=fake docker on PATH; no_claim=how often the writer drops lines
def test_drop_notes_only_day_keeps_reporting(tmp_path: Path):
    out = run_stats(
        tmp_path, LOGS_NO_EVENTS, sar=SAR, receivers="2026-11-26 09:00:00,000 event=dropped lines=5\n"
    )
    assert out.returncode == 0, out.stderr
    assert "    (none)" in out.stdout.split("by event and code:")[1]
    assert "  10:00   65.0 /  80.0" in out.stdout


# Value: protects=a failed receiver-file read keeps docker's daemon error (with the container id) out of the output the monitoring key sees; fails_when=the receiver-file docker exec loses its own 2>/dev/null; why_new=other tests check stdout only; seam=fake docker on PATH; no_claim=docker's real daemon wording
def test_failed_file_read_keeps_docker_errors_out(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS, FAKE_FAIL_FILE="1")
    assert "(couldn't read the receiver log file" in out.stdout
    assert "container is restarting" not in out.stderr


# Value: protects=only a receiver line that starts with a timestamp is dated and counted; fails_when=an undated " event=" line (a wrapped or continuation line) falls through and sorts above the cutoff as text; why_new=every fixture line starts with a timestamp; seam=fake docker on PATH; no_claim=that the writer ever emits such a line
def test_undated_receiver_lines_are_not_counted(tmp_path: Path):
    stale = "  continuation event=refused host=x port=8073 code=stale detail=- audio_s=0.0 listeners=99\n"
    out = run_stats(tmp_path, LOGS_NO_EVENTS, receivers=RECEIVERS + stale).stdout
    assert "code=stale" not in out
    assert "1  event=listening code=-" in out


# Value: protects=a receiver log that rotates while it is being read counts as a failed read, not a quiet undercount; fails_when=the in-container read stops comparing the live file's inode before and after; why_new=new rotation check; seam=fake docker runs the real in-container sh with a cat that rotates; no_claim=the real handler's rename timing
def test_rotation_during_read_is_a_failed_read(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS, FAKE_ROTATE_MIDREAD="1").stdout
    assert "(couldn't read the receiver log file; only the container's logs are counted)" in out
    assert "event=listening" not in out  # nothing from the file


# Value: protects=when docker's own log cap has already dropped lines from inside the 24 h window, sessions per hour says how far back it reaches; fails_when=the note is missing on a trimmed log or shows on a complete one; why_new=new note; seam=fake docker serves a full or trimmed log; no_claim=docker's real rotation timing
def test_docker_log_cap_is_noted(tmp_path: Path):
    trimmed = run_stats(tmp_path / "a", LOGS, FAKE_LOGS_TRIMMED="1").stdout
    assert "(container logs only reach back to 2026-11-26T08:01:02Z; older lines were rotated out)" in trimmed
    complete = run_stats(tmp_path / "b", LOGS).stdout
    assert "older lines were rotated out" not in complete
    # A container deployed inside the window has a log that starts there anyway:
    # only the deploy note, not the cap note.
    fresh = run_stats(
        tmp_path / "c", LOGS, FAKE_LOGS_TRIMMED="1",
        FAKE_CREATED="2026-11-26T08:00:00.000000000Z", FAKE_STARTED="2026-11-26T08:00:00Z",
    ).stdout
    assert "(since 2026-11-26T08:00:00Z; earlier hours were in the previous container)" in fresh
    assert "older lines were rotated out" not in fresh
    # A crash restart inside the window keeps the log back to creation, so a
    # trimmed one is still noted.
    restarted = run_stats(tmp_path / "d", LOGS, FAKE_LOGS_TRIMMED="1", FAKE_STARTED="2026-11-26T12:00:00Z").stdout
    assert "(container logs only reach back to 2026-11-26T08:01:02Z; older lines were rotated out)" in restarted
    # Created inside the window, then trimmed hours past creation: the deploy
    # note alone would claim full coverage since creation.
    late = "\n".join(LOGS.splitlines()[2:]) + "\n"
    recreated = run_stats(
        tmp_path / "e", late, FAKE_LOGS_TRIMMED="1", FAKE_CREATED="2026-11-26T08:00:00.000000000Z"
    ).stdout
    assert "(container logs only reach back to 2026-11-26T09:20:00Z; older lines were rotated out)" in recreated


# Value: protects=a rotation check that can't read the inode counts the file as unread instead of passing; fails_when=empty inode reads compare equal and the read counts as complete; why_new=fail-closed check; seam=fake docker runs the real in-container sh with a failing stat; no_claim=which images lack GNU stat
def test_unreadable_inode_is_a_failed_read(tmp_path: Path):
    out = run_stats(tmp_path, LOGS, receivers=RECEIVERS, FAKE_STAT_FAILS="1").stdout
    assert "(couldn't read the receiver log file; only the container's logs are counted)" in out
    assert "event=listening" not in out


# Value: protects=when the receiver log's own 25 MB cap has deleted lines from inside the 24 h window, the receiver section says how far back the file reaches; fails_when=the oldest-copy check is dropped or misreads its timestamp; why_new=new note; seam=fake docker runs the real in-container sh; no_claim=the writer's real rotation timing
def test_receiver_file_cap_is_noted(tmp_path: Path):
    files = {
        "receivers.log.4": f"2026-11-26 08:00:00,000 event=refused host={KIWI_HOST} port=8073 code=full detail=- audio_s=0.0 listeners=15\n",
        "receivers.log": f"2026-11-26 10:00:00,000 event=listening host={KIWI_HOST} port=8073 code=- detail=- audio_s=0.0 listeners=12\n",
    }
    out = run_stats(tmp_path / "a", LOGS_NO_EVENTS, files=files).stdout
    assert "(receiver log file only reaches back to 2026-11-26T08:00:00Z; older lines were rotated out)" in out
    # Without a .4 copy, or with one that starts before the window, nothing is missing.
    complete = run_stats(tmp_path / "b", LOGS_NO_EVENTS, receivers=RECEIVERS).stdout
    assert "receiver log file only reaches back" not in complete


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


# The refusal throttle as session.py writes it: one line per receiver and code
# every 10 s, the next carrying suppressed=N for the ones held back, and a
# detail=throttled line at close that is only those N.
THROTTLED = textwrap.dedent(
    f"""\
    2026-11-26 15:00:00,000 event=refused host={KIWI_HOST} port=8073 code=skywave_cap detail=skywave_cap=1 audio_s=0.0 listeners=11
    2026-11-26 15:00:10,000 event=refused host={KIWI_HOST} port=8073 code=skywave_cap detail=skywave_cap=1 audio_s=0.0 listeners=11 suppressed=4
    2026-11-26 15:00:15,000 event=refused host={KIWI_HOST} port=8073 code=skywave_cap detail=throttled audio_s=0.0 listeners=10 suppressed=2
    2026-11-26 15:01:00,000 event=listening host={KIWI_HOST} port=8073 code=- detail=- audio_s=0.0 listeners=9
    """
)


# Value: protects=refusal counts in the daily report are refusals, not log lines: each line's suppressed=N is added and a detail=throttled line adds only its N; fails_when=the count goes back to counting lines, drops suppressed=, or counts the close-time flush as a refusal of its own; why_new=the #155 report counted 701 skywave_cap lines, fewer than the refusals behind the 10 s throttle; seam=fake docker on PATH; no_claim=the throttle interval or when sessions flush
def test_counts_refusals_the_throttle_held_back(tmp_path: Path):
    out = run_stats(tmp_path, LOGS_NO_EVENTS, receivers=THROTTLED)
    assert out.returncode == 0, out.stderr
    section = out.stdout.split("by event and code:")[1].split("most listeners")[0]
    assert "    8  event=refused code=skywave_cap" in section  # 1 + (1 + 4) + 2
    assert "    1  event=listening code=-" in section
    assert "2026-11-26T15  11" in out.stdout
