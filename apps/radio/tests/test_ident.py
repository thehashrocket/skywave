import json

import pytest
from fastapi.testclient import TestClient

from skywave_radio.kiwi import ident_param
from skywave_radio.server import create_app
from skywave_radio.session import IDENT_MAX, listener_ident

from .test_server import ORIGIN, run_with_fake, settings, until_state
from .test_view import view_msg, views


# Value: protects=a listener's call sign or name reaches the Kiwi only when it is plain (letters, digits, / - _ and spaces, at most IDENT_MAX), with "skywave " first (owner decision: a Kiwi's ident_len cut then takes the name's end, not the marker), and anything else falls back to the service's name; fails_when=raw text (newlines, other characters, very long input) or a blank passes through, or the suffix is dropped; why_new=issue #108 lets listener text into a SET command; seam=none; no_claim=what the Kiwi shows once its own ident_len truncates it
@pytest.mark.parametrize(
    "raw, want",
    [
        ("N0CALL", "skywave N0CALL"),
        ("  VE3/N0CALL  ", "skywave VE3/N0CALL"),
        ("Jo  Smith\tSWL", "skywave Jo Smith SWL"),
        ("x" * IDENT_MAX, "skywave " + "x" * IDENT_MAX),
        ("x" * (IDENT_MAX + 1), "default"),
        ("", "default"),
        ("   ", "default"),
        (None, "default"),
        (42, "default"),
        ("N0CALL\nSET mod=am", "default"),  # '=' isn't allowed; the newline alone would become a space
        ("N0CALL;", "default"),
        ("Zoë", "default"),
        ("%20", "default"),
        ("a" * 10_000, "default"),
    ],
)
def test_listener_ident(raw, want):
    assert listener_ident(raw, "default") == want


# Value: protects=spaces go to the Kiwi percent-encoded, as its sscanf("%s") then URL-decode needs, so "skywave Jo Smith" isn't cut to "skywave"; fails_when=ident_param sends a raw space or encodes the characters a valid ident keeps; why_new=idents with spaces are new (#108); seam=none; no_claim=none
def test_ident_param_encodes_spaces():
    assert ident_param("skywave Jo Smith") == "skywave%20Jo%20Smith"
    assert ident_param("VE3/N0CALL-1_x") == "VE3/N0CALL-1_x"
    assert ident_param("skywavehf.com") == "skywavehf.com"


def _connect_and_view(ident):
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            msg = {"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 9650, "mode": "am"}
            if ident is not None:
                msg["ident"] = ident
            ws.send_text(json.dumps(msg))
            until_state(ws, "listening")
            ws.send_text(view_msg())
            views(ws, n=1)
            return list(kiwi.commands), list(kiwi.wf_commands)

    return run_with_fake(body)


# Value: protects=the listener's name goes on the audio connection only, encoded, while the waterfall that shares its channel keeps the service's own name; fails_when=session.py drops the ident, sends it unencoded, or hands it to the waterfall (issue #108: waterfalls stay on the default); why_new=issue #108; seam=FakeKiwi records SET commands; no_claim=a real Kiwi's user list
def test_ident_on_audio_only():
    snd, wf = _connect_and_view("Jo Smith")
    assert "SET ident_user=skywave%20Jo%20Smith" in snd
    assert "SET ident_user=test" in wf
    assert not [c for c in wf if "Jo" in c]


# Value: protects=a bad or missing ident falls back to the service's name rather than failing the Listen; fails_when=an invalid ident raises or reaches the Kiwi; why_new=issue #108; seam=FakeKiwi; no_claim=none
@pytest.mark.parametrize("ident", [None, "bad=ident"])
def test_bad_or_missing_ident_uses_default(ident):
    snd, _ = _connect_and_view(ident)
    assert "SET ident_user=test" in snd
