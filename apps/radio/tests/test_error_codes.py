"""The browser decides what Pick best does from each error's `code`, so the
codes this service can send and the list the web app knows must match."""

import re
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "skywave_radio"
WEB_TYPES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "use-radio.ts"


def raised_codes(module: str, error: str) -> set[str]:
    return set(re.findall(rf'{error}\(\s*"([a-z_]+)"', (PKG / module).read_text()))


def bad_request_codes() -> set[str]:
    """Codes on the service's own refusals (BadRequest in session.py), such as skywave_cap."""
    # Only codes a BadRequest carries to the browser, not the receiver log's own labels.
    text = (PKG / "session.py").read_text()
    literal = re.findall(r'BadRequest\((?:[^()]|\([^()]*\))*?\bcode="([a-z_]+)"', text)
    # A new code written for older pages: code=for_page("skywave_cap", ...).
    new = re.findall(r'\bcode=for_page\(\s*"([a-z_]+)"', text)
    return set(literal) | set(new)


def web_list(name: str) -> set[str]:
    """The quoted codes in use-radio.ts's `name = [...]` list."""
    block = re.search(rf"{name}(?:: [^=]+)? = \[(.*?)\]", WEB_TYPES.read_text(), re.S)
    assert block, f"{name} not found in use-radio.ts"
    return set(re.findall(r'"([a-z_]+)"', block.group(1)))


# Value: protects=the web app knows every code the service can send, its own refusals (skywave_cap, #144) included, so none reads as an uncoded failure that stops Pick best; fails_when=a code is added on one side only; why_new=BadRequest codes weren't scanned; seam=none; no_claim=codes built at runtime rather than written as literals
def test_web_knows_every_error_code_the_service_sends():
    sent = raised_codes("kiwi.py", "KiwiError") | raised_codes("hostguard.py", "HostRejected") | bad_request_codes()
    assert sent == web_list("RADIO_ERROR_CODES")
    assert {"busy", "dns", "blocked", "skywave_cap"} <= sent


# Value: protects=the codes the service downgrades to "busy" for older pages are the ones the page lists as new on its tunes, so a new code reaches pages that know it and never one that doesn't (#144); fails_when=NEW_CODES differs between session.py and use-radio.ts; why_new=the fallback became one shared set when same_source joined skywave_cap; seam=none; no_claim=tabs opened before a deploy (test_receiver_log.py)
def test_service_and_web_agree_on_new_codes():
    from skywave_radio.session import NEW_CODES

    assert set(NEW_CODES) == web_list("NEW_CODES")
