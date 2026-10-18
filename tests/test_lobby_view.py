"""The memorial lobby's viewing options and input: the zoom-out setting, the wheel kinds (lobby-touch.js, run with
Node when it is installed) and their UI strings."""

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.webui.api import build_api, ui_strings
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


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_wheel_kinds():
    # a mouse wheel zooms, a trackpad swipe pans; one scroll keeps the kind of its first event
    script = """
const T = await import(process.argv[1]);
const now = 10000, none = { kind: null, at: -Infinity };
const cases = [
  [{ deltaMode: 1, deltaY: 3, deltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 100, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: -200, deltaX: 0, wheelDeltaY: 240, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 4.5, deltaX: 0.5, wheelDeltaY: -13, wheelDeltaX: -1 }, none],
  [{ deltaMode: 0, deltaY: 12, deltaX: 0, wheelDeltaY: -36, wheelDeltaX: 0 }, none],
  [{ deltaMode: 0, deltaY: 40, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, { kind: "trackpad", at: now - 50 }],
  [{ deltaMode: 0, deltaY: 40, deltaX: 0, wheelDeltaY: -120, wheelDeltaX: 0 }, { kind: "trackpad", at: now - 500 }],
  [{ deltaMode: 0, deltaY: 0, deltaX: 30, wheelDeltaY: 0, wheelDeltaX: -90 }, none],
];
console.log(JSON.stringify(cases.map(([e, last]) => T.wheelKind(e, now, last))));
"""
    out = subprocess.run(["node", "--input-type=module", "-e", script, (WEB / "js" / "lobby-touch.js").as_uri()],
                         capture_output=True, text=True, timeout=60, check=True).stdout
    assert json.loads(out) == ["mouse", "mouse", "mouse", "trackpad", "trackpad", "trackpad", "mouse", "trackpad"]


def test_lobby_strings_in_both_languages():
    for lang in ("zh-CN", "en-US"):
        strings = ui_strings(lang)
        for key in ("tab.l2d", "zoomOut.label", "zoomOut.game", "zoomOut.art"):
            assert strings.get(f"webui.settings.{key}"), (lang, key)
