"""scripts/pregate-run.sh is the pre-gate's one runner command: it sends each
selected test file to its own app's runner. These run the real script against
cheap targets so a broken route or a swallowed failure shows up here."""

import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "pregate-run.sh"
VENV_PYTHON = REPO / "apps" / "radio" / ".venv" / "bin" / "python"
VITEST = REPO / "apps" / "web" / "node_modules" / ".bin" / "vitest"

# Never name this file here: the script would run it again, recursively.
CHEAP_PY = "apps/radio/tests/test_error_codes.py"
MISSING_PY = "apps/radio/tests/test_does_not_exist.py"
CHEAP_TS = "apps/web/src/lib/radio-types.test.ts"
# vitest's summary when it found and passed exactly the one file it was given.
VITEST_ONE_FILE_PASSED = re.compile(r"Test Files\s+1 passed \(1\)")


def run(*files: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT), *files],
        cwd=Path(__file__).parent,
        capture_output=True,
        text=True,
        timeout=120,
    )


def need_venv():
    if not VENV_PYTHON.exists():
        pytest.skip("apps/radio/.venv is not built")


def need_vitest():
    if not VITEST.exists():
        pytest.skip("apps/web/node_modules is not installed")


def test_unknown_path_exits_2_and_runs_nothing():
    # Value: protects=a selected file no runner owns fails the gate loudly instead of being skipped; fails_when=the catch-all branch is dropped or no longer exits 2 before the runners; why_new=pregate-run.sh had no tests; seam=none; no_claim=which files gstack-pregate selects
    result = run("README.md", MISSING_PY)
    assert result.returncode == 2
    assert "pregate-run: no runner for: README.md" in result.stderr
    assert "not found" not in result.stdout + result.stderr  # pytest never ran


def test_radio_file_runs_under_radio_pytest():
    # Value: protects=apps/radio/*.py files reach the radio venv's pytest from the repo root; fails_when=the .py pattern, the venv path or the cd to the repo root breaks; why_new=pregate-run.sh had no tests; seam=none; no_claim=runs the real local venv pytest, not gstack-pregate's own file selection
    need_venv()
    result = run(CHEAP_PY)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout


def test_failing_radio_run_exits_1():
    # Value: protects=a pytest failure fails the pre-gate; fails_when=the pytest exit status is ignored or mapped to 0; why_new=pregate-run.sh had no tests; seam=none; no_claim=runs the real local venv pytest, not gstack-pregate's own file selection
    need_venv()
    result = run(MISSING_PY)
    assert result.returncode == 1
    assert MISSING_PY in result.stdout + result.stderr  # pytest's not-found error


def test_web_file_runs_under_vitest_with_prefix_stripped():
    # Value: protects=apps/web/*.ts files reach vitest inside apps/web with the apps/web/ prefix stripped; fails_when=the prefix is kept (vitest finds no file and exits 1) or the .ts pattern breaks; why_new=pregate-run.sh had no tests; seam=none; no_claim=runs the real local node_modules vitest, not gstack-pregate's own file selection; skipped where node_modules is absent (the CI radio job)
    need_vitest()
    result = run(CHEAP_TS)
    assert result.returncode == 0, result.stdout + result.stderr
    assert VITEST_ONE_FILE_PASSED.search(result.stdout)


def test_radio_failure_still_runs_web_and_exits_1():
    # Value: protects=one runner failing neither hides the other's results nor passes the gate; fails_when=the script exits on the first runner failure or the final status drops the pytest failure; why_new=pregate-run.sh had no tests; seam=none; no_claim=runs the real local venv pytest and node_modules vitest, not gstack-pregate's own file selection; skipped where node_modules is absent (the CI radio job)
    need_venv()
    need_vitest()
    result = run(MISSING_PY, CHEAP_TS)
    assert result.returncode == 1
    assert MISSING_PY in result.stdout + result.stderr
    assert VITEST_ONE_FILE_PASSED.search(result.stdout)
