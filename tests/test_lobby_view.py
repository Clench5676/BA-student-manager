"""The memorial lobby's viewing options: the zoom-out setting and its UI strings."""

import io
import json
from pathlib import Path

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.webui.api import build_api, ui_strings
from ba_modding_toolkit.webui.server import WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState


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


def test_lobby_strings_in_both_languages():
    for lang in ("zh-CN", "en-US"):
        strings = ui_strings(lang)
        for key in ("tab.l2d", "zoomOut.label", "zoomOut.game", "zoomOut.art"):
            assert strings.get(f"webui.settings.{key}"), (lang, key)
