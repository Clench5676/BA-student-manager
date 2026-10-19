"""The memorial lobby's viewing options and input: the zoom-out setting, the --debug input trace, the wheel kinds
(lobby-touch.js, run with Node when it is installed) and their UI strings."""

import io
import json
import logging
import shutil
import subprocess
from pathlib import Path

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.webui.api import TRACE_BATCH, TRACE_LINE, build_api, ui_strings
from ba_modding_toolkit.webui.main import _trace_to_file
from ba_modding_toolkit.webui.server import WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState

WEB = Path(__file__).resolve().parents[1] / "src" / "ba_modding_toolkit" / "web"


class FakeGame:
    resource_version = "rv1"


@pytest.fixture
def services(tmp_path: Path):
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                 cache=object(), game=FakeGame(), catalog=object(), library=object())
    yield s
    s.close()


@pytest.fixture
def app(services):
    return WebApp(build_api(services), services.events, assets=services.asset, token="tok",
                  consent=lambda: services.state.consent)


def rpc(app, method, **params):
    data = json.dumps({"method": method, "params": params}).encode()
    environ = {"REQUEST_METHOD": "POST", "PATH_INFO": "/api/rpc", "QUERY_STRING": "", "CONTENT_LENGTH": str(len(data)),
               "wsgi.input": io.BytesIO(data), "HTTP_X_BAMT_TOKEN": "tok"}
    seen = {}
    body = b"".join(app(environ, lambda status, headers: seen.update(status=status)))
    assert seen["status"] == "200 OK"
    return json.loads(body)


def test_zoom_out_setting_is_off_by_default_and_persists(app, tmp_path):
    assert rpc(app, "settings.get")["result"]["lobbyZoomOut"] is False
    assert rpc(app, "settings.set", key="lobbyZoomOut", value=True)["result"]["lobbyZoomOut"] is True
    assert UiState(tmp_path / "webui.json").get("lobby_zoom_out") is True
    assert rpc(app, "settings.set", key="lobbyZoomOut", value=0)["result"]["lobbyZoomOut"] is False


def test_input_trace_is_logged_only_when_started_with_debug(app, services, caplog):
    caplog.set_level(logging.INFO, logger="ba_modding_toolkit.webui.trace")
    events = [{"k": "down", "pt": "mouse", "b": 0, "bs": 1}, {"k": "wheel", "dy": 4.5, "act": "pan"}]
    assert rpc(app, "app.info")["result"]["debug"] is False
    rpc(app, "debug.trace", events=events)
    assert not [r for r in caplog.records if r.name == "ba_modding_toolkit.webui.trace"]

    services.debug = True
    assert rpc(app, "app.info")["result"]["debug"] is True
    rpc(app, "debug.trace", events=events + [{"k": "move", "note": "x" * 5000}] + [{"k": "move"}] * (TRACE_BATCH + 10))
    lines = [r.getMessage() for r in caplog.records if r.name == "ba_modding_toolkit.webui.trace"]
    assert len(lines) == TRACE_BATCH  # one call logs a bounded batch
    assert json.loads(lines[0]) == events[0] and json.loads(lines[1]) == events[1]
    assert len(lines[2]) == TRACE_LINE  # and bounded lines
    rpc(app, "debug.trace", events="not a list")  # ignored, never an error


def test_input_trace_also_goes_to_a_file(tmp_path):
    trace = logging.getLogger("ba_modding_toolkit.webui.trace")
    before = list(trace.handlers)
    try:
        _trace_to_file(tmp_path / "input-trace.log")
        trace.info('{"k":"down"}')
        for h in trace.handlers:
            h.flush()
        assert '{"k":"down"}' in (tmp_path / "input-trace.log").read_text(encoding="utf-8")
    finally:
        for h in [h for h in trace.handlers if h not in before]:
            trace.removeHandler(h)
            h.close()


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_wheel_kinds():
    # a mouse wheel zooms, a trackpad swipe pans; one scroll keeps the kind of its first event, unless a scroll taken
    # for a wheel sends what no wheel sends. In WebKit (the macOS app) wheelDeltaY is 3 x deltaY for every device: a
    # notch is a tenth of a line in 16.16 fixed point (4.000244 px), a trackpad step whole pixels.
    script = """
const T = await import(process.argv[1]);
const now = 10000, none = { kind: null, at: -Infinity }, pad = { kind: "trackpad", at: now - 50 };
const cases = [
  [{ deltaMode: 1, deltaY: 3, deltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 100, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: -200, deltaX: 0, wheelDeltaY: 240, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 4.5, deltaX: 0.5, wheelDeltaY: -13, wheelDeltaX: -1 }, none],
  [{ deltaMode: 0, deltaY: 12, deltaX: 0, wheelDeltaY: -36, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 40, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, { kind: "trackpad", at: now - 50 }],
  [{ deltaMode: 0, deltaY: 40, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, { kind: "trackpad", at: now - 500 }],
  [{ deltaMode: 0, deltaY: 0, deltaX: 30, wheelDeltaY: 0, wheelDeltaX: -90 }, none],
  [{ deltaMode: 0, deltaY: -4.000244140625, deltaX: 0, wheelDeltaY: 12, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: -3.9996337890625, deltaX: 0, wheelDeltaY: 11, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 12.000732421875, deltaX: 0, wheelDeltaY: -36, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 4.000244140625, deltaX: 0, wheelDeltaY: -12, wheelDeltaX: 0 }, pad],
  [{ deltaMode: 0, deltaY: 7, deltaX: 0, wheelDeltaY: -21, wheelDeltaX: 0 }, { kind: "mouse", at: now - 20 }],
  [{ deltaMode: 0, deltaY: 40, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, { kind: "mouse", at: now - 20 }],
  [{ deltaMode: 0, deltaY: 0, deltaX: 0, wheelDeltaY: 0, wheelDeltaX: 0 }, none],
];
console.log(JSON.stringify(cases.map(([e, last]) => T.wheelKind(e, now, last))));
"""
    out = subprocess.run(["node", "--input-type=module", "-e", script, (WEB / "js" / "lobby-touch.js").as_uri()],
                         capture_output=True, text=True, timeout=60, check=True).stdout
    assert json.loads(out) == ["mouse", "mouse", "mouse", "trackpad", "trackpad", "trackpad", "mouse", "trackpad",
                               "mouse", "mouse", "mouse", "trackpad", "trackpad", "mouse", "trackpad"]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_wheel_zooms_and_pans_in_node():
    # the wheel handler on a recorded lobby: WebKit spins zoom, swipes pan, a swipe taken for a wheel is undone
    tests = Path(__file__).parent / "js" / "lobby_wheel.test.mjs"
    result = subprocess.run(["node", "--test", str(tests)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_zoom_out_limit_in_node():
    # the Full Art limit: every clip's poses are checked and the painted rect gives up what one uncovers
    tests = Path(__file__).parent / "js" / "lobby_frame.test.mjs"
    result = subprocess.run(["node", "--test", str(tests)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_lobby_strings_in_both_languages():
    for lang in ("zh-CN", "en-US"):
        strings = ui_strings(lang)
        for key in ("tab.l2d", "zoomOut.label", "zoomOut.game", "zoomOut.art"):
            assert strings.get(f"webui.settings.{key}"), (lang, key)
