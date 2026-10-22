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


def test_model_route_uses_verified_official_or_own_mod_sources(tmp_path):
    official = [tmp_path / 'official.bundle']
    mod_parts = [tmp_path / 'mod.bundle']
    calls = []
    game = RouteGame()
    game.model_glb = lambda core, overrides=(): calls.append((core, list(overrides))) or b'glTF'
    library = SimpleNamespace(
        official_bundles=lambda core: official,
        preview_bundles=lambda mod_id: mod_parts,
        mods=lambda: [SimpleNamespace(id='own', kind='model', target='ch0242'),
                      SimpleNamespace(id='foreign', kind='model', target='ch0252'),
                      SimpleNamespace(id='portrait', kind='spr', target='ch0242')],
    )
    s = Services(Settings(tmp_path / 'config.toml'), tmp_path, state=UiState(tmp_path / 'webui.json'),
                 cache=object(), game=game, catalog=RouteCatalog(), library=library)
    try:
        assert s.asset('model/ch0242.glb', {'source': 'official'}).body == b'glTF'
        assert calls[-1] == ('ch0242', official)
        assert s.asset('model/ch0242.glb', {'source': 'mod:own'}).body == b'glTF'
        assert calls[-1] == ('ch0242', mod_parts)
        import pytest
        for source in ['mod:foreign', 'mod:portrait', 'mod:missing', 'variant:ch0252', '../elsewhere']:
            with pytest.raises(KeyError):
                s.asset('model/ch0242.glb', {'source': source})
    finally:
        s.close()


def test_indexed_npc_model_can_preview_without_a_student_entry(tmp_path):
    import pytest
    game = RouteGame()
    game.model_cores = lambda: {"en0002"}
    calls = []
    game.model_glb = lambda core, overrides=(): calls.append((core, list(overrides))) or b"glTF npc"
    sources = [tmp_path / "npc.bundle"]
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                 cache=object(), game=game, catalog=RouteCatalog(), library=object())
    s.batch_import = SimpleNamespace(preview=lambda key: ("en0002", sources))
    try:
        assert s.asset("model/en0002.glb", {}).body == b"glTF npc"
        assert calls[-1] == ("en0002", [])
        assert s.asset("model/en0002.glb", {"source": "import:verified-token"}).body == b"glTF npc"
        assert calls[-1] == ("en0002", sources)
        with pytest.raises(KeyError):
            s.asset("model/unindexed.glb", {"source": "import:verified-token"})
    finally:
        s.close()
