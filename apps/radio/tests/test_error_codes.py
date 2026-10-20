"""The browser decides what Pick best does from each error's `code`, so the
codes this service can send and the list the web app knows must match."""

import re
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "skywave_radio"
WEB_TYPES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "use-radio.ts"


def raised_codes(module: str, error: str) -> set[str]:
    return set(re.findall(rf'{error}\(\s*"([a-z_]+)"', (PKG / module).read_text()))


def test_web_knows_every_error_code_the_service_sends():
    sent = raised_codes("kiwi.py", "KiwiError") | raised_codes("hostguard.py", "HostRejected")
    block = re.search(r"RADIO_ERROR_CODES = \[(.*?)\] as const", WEB_TYPES.read_text(), re.S)
    assert block, "RADIO_ERROR_CODES not found in use-radio.ts"
    known = set(re.findall(r'"([a-z_]+)"', block.group(1)))
    assert sent == known
    assert {"busy", "dns", "blocked"} <= sent
