import json
import time

import pytest
from fastapi.testclient import TestClient

from skywave_radio.kiwi import ident_param, loggable
from skywave_radio.server import create_app
from skywave_radio.session import IDENT_MAX, listener_ident

from .test_server import ORIGIN, run_with_fake, settings, until_state
from .test_view import view_msg, views


# Value: protects=a listener's call sign or name reaches the Kiwi only when it is plain (letters, digits, / - _ and spaces, at most IDENT_MAX), with "skywave " first (owner decision: a Kiwi's ident_len cut then takes the name's end, not the marker), and anything else falls back to the service's name; fails_when=raw text (newlines, other characters, very long input) or a blank passes through, or the prefix is dropped; why_new=issue #108 lets listener text into a SET command; seam=none; no_claim=what the Kiwi shows once its own ident_len truncates it
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


# Value: protects=the listener's name goes out encoded on the audio connection and on the waterfall that joins its channel, so opening a scan or the wide view never sends a different name that could replace theirs on the receiver's user list; fails_when=session.py drops the ident, sends it unencoded, or gives the paired waterfall the service's own name; why_new=review of PR 121 (the paired waterfall sent the default); seam=FakeKiwi records SET commands; no_claim=a real Kiwi's user list
def test_ident_on_audio_and_its_waterfall():
    snd, wf = _connect_and_view("Jo Smith")
    assert "SET ident_user=skywave%20Jo%20Smith" in snd
    assert "SET ident_user=skywave%20Jo%20Smith" in wf
    assert "SET ident_user=test" not in wf


# Value: protects=a bad or missing ident falls back to the service's name rather than failing the Listen; fails_when=an invalid ident raises or reaches the Kiwi; why_new=issue #108; seam=FakeKiwi; no_claim=none
@pytest.mark.parametrize("ident", [None, "bad=ident"])
def test_bad_or_missing_ident_uses_default(ident):
    snd, _ = _connect_and_view(ident)
    assert "SET ident_user=test" in snd


# Value: protects=a Listen on the receiver already playing shows the name it carries, on the audio and on the waterfall sharing its channel, without reconnecting, while a dial retune leaves the name alone; fails_when=the same-receiver branch ignores the ident (the name edited mid-listen never shows), renames on a retune, or reconnects to rename; why_new=review of PR 121; seam=FakeKiwi records SET commands and SND paths; no_claim=that a real Kiwi updates its user list on a second SET ident_user
def test_listen_again_renames_in_place():
    def body(kiwi):
        with TestClient(create_app(settings())).websocket_connect("/ws", headers=ORIGIN) as ws:
            tune = {"type": "tune", "host": "127.0.0.1", "port": kiwi.port, "freqKhz": 9650, "mode": "am"}
            ws.send_text(json.dumps({**tune, "ident": "Jo"}))
            until_state(ws, "listening")
            ws.send_text(view_msg())
            views(ws, n=1)
            ws.send_text(json.dumps({**tune, "freqKhz": 9655, "retune": True}))
            until_state(ws, "listening")
            ws.send_text(json.dumps({**tune, "ident": "N0CALL"}))
            until_state(ws, "listening")
            # The fake Kiwi reads in its own thread: give the sends time to land.
            renamed = "SET ident_user=skywave%20N0CALL"
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not (renamed in kiwi.commands and renamed in kiwi.wf_commands):
                time.sleep(0.01)
            return list(kiwi.commands), list(kiwi.wf_commands), [p for p in kiwi.paths if p.endswith("/SND")]

    snd, wf, snd_paths = run_with_fake(body)
    idents = [c for c in snd if isinstance(c, str) and c.startswith("SET ident_user=")]
    assert idents == ["SET ident_user=skywave%20Jo", "SET ident_user=skywave%20N0CALL"]
    assert [c for c in wf if isinstance(c, str) and c.startswith("SET ident_user=")][-1] == (
        "SET ident_user=skywave%20N0CALL"
    )
    assert len(snd_paths) == 1


# Value: protects=a listener's name stays out of the debug log of commands sent to receivers; fails_when=loggable passes SET ident_user's value through or mangles other commands; why_new=review of PR 121 (names are personal data); seam=none; no_claim=other log lines
def test_loggable_hides_the_name():
    assert loggable("SET ident_user=skywave%20Jo%20Smith") == "SET ident_user=<name>"
    assert loggable("SET mod=am low_cut=-5000 high_cut=5000 freq=9650.000") == (
        "SET mod=am low_cut=-5000 high_cut=5000 freq=9650.000"
    )
