"""The /asset/model route: a variant's chibi, exported in memory and never cacheable."""

from __future__ import annotations

import io
from types import SimpleNamespace

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.server import WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState


class RouteCatalog:
    def variant(self, key):
        if key not in ("ch0242", "ch0252"):
            raise ServiceError("catalog_variant_not_found", key=key)
        return SimpleNamespace(key=key, model="ch0242" if key == "ch0242" else None)


class RouteGame:
    resource_version = "rv"

    def __init__(self):
        self.asked = []

    def model_glb(self, core):
        self.asked.append(core)
        return b"glTF model"


def _get(app, path):
    seen = {}
    environ = {"REQUEST_METHOD": "GET", "PATH_INFO": path, "QUERY_STRING": "", "HTTP_X_BAMT_TOKEN": "tok",
               "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO(b"")}
    body = b"".join(app(environ, lambda status, headers: seen.update(status=status, headers=dict(headers))))
    return seen["status"], seen["headers"], body


def test_model_route_is_never_cacheable(tmp_path):
    game = RouteGame()
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                 cache=object(), game=game, catalog=RouteCatalog(), library=object())
    s.state.set_consent(True)
    app = WebApp(build_api(s), s.events, assets=s.asset, token="tok", consent=lambda: s.state.consent)
    try:
        status, headers, body = _get(app, "/asset/model/ch0242.glb")
        assert status == "200 OK" and body == b"glTF model" and game.asked == ["ch0242"]
        assert headers["Content-Type"] == "model/gltf-binary" and headers["Cache-Control"] == "no-store"
        assert _get(app, "/asset/model/ch0252.glb")[0] == "404 Not Found"   # no model in this install
        assert _get(app, "/asset/model/missing.glb")[0] == "404 Not Found"
        assert _get(app, "/asset/model/ch0242.png")[0] == "404 Not Found"
    finally:
        s.close()
