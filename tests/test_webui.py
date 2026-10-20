"""Tests for the web UI server, RPC layer, jobs and events, driven through the WSGI app without a window."""

import binascii
import io
import json
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.i18n import offered_languages
from ba_modding_toolkit.webui.api import build_api, ui_strings
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.jobs import JobRunner
from ba_modding_toolkit.webui.server import WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import ALIAS_LENGTH, ALIAS_MAX, UiState, roster_view


@dataclass
class FakeVariant:
    key: str
    family: str
    file_id: str = ""
    names: dict = field(default_factory=dict)
    playable: bool = True
    order: int = 0
    spr: str | None = None
    lobby: str | None = None
    bg: str | None = "BG_Test_Collection"
    portrait: str | None = None
    date: str | None = None
    recruitable: bool = True
    model: str | None = None
    aliases: list = field(default_factory=list)


@dataclass
class FakeFamily:
    key: str
    names: dict
    school: str | None
    variants: list
    aliases: list = field(default_factory=list)


class FakeGame:
    resource_version = "rv1"

    def atlases(self):
        return {"Common": {"Common_Icon_Back": {"x": 0, "y": 0, "width": 8, "height": 8}}}

    def sprite_png(self, atlas, sprite):
        if (atlas, sprite) != ("Common", "Common_Icon_Back"):
            raise KeyError(sprite)
        return b"\x89PNG sprite"

    def textures(self):
        return ["UITex_A"]

    def texture_png(self, name):
        return b"\x89PNG texture"

    def layout(self, root, subpath=""):
        return {"name": subpath.split("/")[-1] if subpath else root, "children": []}

    def collection_bg(self, name):
        return b"jpg", "image/jpeg"

    def collection_portrait(self, name):
        return b"\x89PNG portrait"

    def spine_files(self, kind, core):
        return {f"{core}.skel": b"skel", f"{core}.atlas": b"atlas", f"{core}.png": b"png"}


class FakeCatalog:
    def __init__(self):
        self.v = FakeVariant("hoshino", "hoshino", "hoshino", {"zh-CN": {"full": "星野", "short": "原皮"}}, spr="hoshino_spr")
        self.f = FakeFamily("hoshino", {"zh-CN": "星野"}, "Abydos", [self.v])

    def families(self):
        return [self.f]

    def family(self, key):
        if key != "hoshino":
            raise ServiceError("family_not_found", key=key)
        return self.f


@dataclass
class FakeMod:
    id: str
    target: str
    fresh: bool = True
    added: str = "2026-10-01T08:00:00+00:00"
    kind: str = "spr"

    def to_json(self):
        return {"id": self.id, "target": self.target, "fresh": self.fresh}


class FakeLibrary:
    """The library calls of the web UI's handlers, with plain answers; ``pins`` are its known installs, the first
    one current."""

    def __init__(self, pins=()):
        self.favs = set()
        self.applied = []
        self.pins = list(pins)
        self.enabled = True
        self.writes = True  # what would_write answers
        self.toggled = []
        self.live = {}  # core -> the game files in the order live_bundles answers; others are not known

    def mods(self):
        return [FakeMod("m1", "hoshino")]

    def modified(self):
        return {"hoshino": "variant:hoshino_swimsuit"}

    def favorites(self):
        return set(self.favs)

    def set_favorite(self, key, on):
        (self.favs.add if on else self.favs.discard)(key)

    def state(self, key, pin=None):
        return {"applied": "official", "crc": "ok"}

    def configured(self, key, pin=None):
        return {"spr": None, "lobby": None}

    def apply(self, variant_key, source, log, progress, kind="spr", pin=None):
        log("applying")
        progress(1, 1, variant_key)
        self.applied.append((variant_key, source))
        return {"applied": source}

    def restore(self, variant_key, log, kind="spr", pin=None):
        self.applied.append((variant_key, "official"))
        return {"applied": "official"}

    def would_write(self, variant_key, source, kind="spr", pin=None):
        return self.writes

    def live_bundles(self, core, pin=None):
        if core not in self.live:
            raise ServiceError("game_file_not_found", variant=core)
        return self.live[core]

    def installs(self):
        return list(self.pins)

    def current_pin(self):
        return self.pins[0] if self.pins else None

    def intent(self):
        return {"enabled": self.enabled, "toggled": None, "unfinished": {"pending": 0, "left": 0, "stuck": 0}}

    def status(self):
        current = self.current_pin()
        return {"installs": [{"id": p.id, "key": p.key, "server": p.server, "folder": str(p.root), "named": True,
                              "distinct": None} for p in self.pins],
                "current": current.key if current else None, "builtSize": 0, "originalsSize": 0, "reason": None,
                "configured": 0, **self.intent()}

    def toggle(self, enabled, expect, pins=None, log=None, progress=None, cancel=None):
        self.toggled.append((enabled, expect, pins))
        self.enabled = enabled
        return {"enabled": enabled}

    def judge_unfinished(self):
        return 0

    def prune(self):
        return []


@pytest.fixture
def services(tmp_path: Path):
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                 cache=object(), game=FakeGame(), catalog=FakeCatalog(), library=FakeLibrary())
    yield s
    s.close()


@pytest.fixture
def app(services):
    return WebApp(build_api(services), services.events, assets=services.asset, token="tok",
                  consent=lambda: services.state.consent)


def call(app, path, method="GET", body=None, token="tok", host=None, cookie=None):
    data = json.dumps(body).encode() if body is not None else b""
    environ = {"REQUEST_METHOD": method, "PATH_INFO": path.split("?")[0],
               "QUERY_STRING": path.split("?", 1)[1] if "?" in path else "",
               "CONTENT_LENGTH": str(len(data)), "wsgi.input": io.BytesIO(data)}
    if token:
        environ["HTTP_X_BAMT_TOKEN"] = token
    if host:
        environ["HTTP_HOST"] = host
    if cookie:
        environ["HTTP_COOKIE"] = cookie
    seen = {}

    def start_response(status, headers):
        seen["status"], seen["headers"] = status, dict(headers)

    chunks = app(environ, start_response)
    return seen["status"], seen["headers"], b"".join(chunks)


def rpc(app, method, **params):
    status, _, body = call(app, "/api/rpc", "POST", {"method": method, "params": params})
    assert status == "200 OK"
    return json.loads(body)


def test_token_required(app):
    assert call(app, "/api/rpc", "POST", {"method": "app.info"}, token=None)[0] == "403 Forbidden"
    assert call(app, "/", token="wrong")[0] == "403 Forbidden"


def test_first_load_sets_cookie_and_cookie_authorises(app):
    status, headers, _ = call(app, "/?t=tok", token=None)
    assert status == "303 See Other" and headers["Location"] == "/"
    cookie = headers["Set-Cookie"].split(";")[0]
    assert "HttpOnly" in headers["Set-Cookie"]
    assert rpc_with_cookie(app, cookie)["result"]["gameFound"] is True


def rpc_with_cookie(app, cookie):
    _, _, body = call(app, "/api/rpc", "POST", {"method": "app.info"}, token=None, cookie=cookie)
    return json.loads(body)


def test_host_header_checked_when_serving(app):
    app.port = 4321
    assert call(app, "/api/rpc", "POST", {"method": "app.info"}, host="evil.example:4321")[0] == "403 Forbidden"
    assert call(app, "/api/rpc", "POST", {"method": "app.info"}, host="127.0.0.1:4321")[0] == "200 OK"


def test_rpc_errors_are_codes(app):
    assert rpc(app, "nope")["error"]["code"] == "unknown_method"
    assert rpc(app, "family.get")["error"]["code"] == "bad_params"
    assert rpc(app, "family.get", key="x")["error"] == {"code": "family_not_found", "params": {"key": "x"}}


def test_roster_and_family(app, services):
    roster = rpc(app, "roster.list")["result"]
    v = roster["families"][0]["variants"][0]
    assert v["key"] == "hoshino" and v["mods"] == 1 and v["fresh"] is True
    assert v["added"] == "2026-10-01T08:00:00+00:00"  # the newest own mod, for the "recently added" sort
    assert v["replaced"] == "variant:hoshino_swimsuit"
    assert v["bg"] == "/asset/art/bg/BG_Test_Collection"
    assert v["playable"] is True and v["recruitable"] is True
    rpc(app, "favorites.set", variant="hoshino", on=True)
    services.catalog.v.recruitable = False  # playable on another server only
    fam = rpc(app, "family.get", key="hoshino")["result"]
    assert fam["variants"][0]["playable"] is True and fam["variants"][0]["recruitable"] is False
    assert fam["variants"][0]["favorite"] is True
    assert fam["variants"][0]["state"] == {"applied": "official", "crc": "ok"}
    assert fam["variants"][0]["modList"] == [{"id": "m1", "target": "hoshino", "fresh": True}]
    assert fam["version"] == "rv1"  # the install the parts come from


def test_library_counts_and_configured_sources_reach_roster_and_family(app, services, monkeypatch):
    mods = [FakeMod(f"p{i}", "hoshino") for i in range(3)] + [FakeMod("l1", "hoshino", kind="lobby")]
    monkeypatch.setattr(services.library, "mods", lambda: mods)
    configured = {"spr": "mod:p1", "lobby": "mod:l1"}
    monkeypatch.setattr(services.library, "configured", lambda key: configured)
    for enabled in (True, False):
        services.library.enabled = enabled
        roster = rpc(app, "roster.list")["result"]["families"][0]
        family = rpc(app, "family.get", key="hoshino")["result"]
        for data in (roster, family):
            v = data["variants"][0]
            assert v["mods"] == 4
            assert v["modCounts"] == {"spr": 3, "lobby": 1}
            assert v["configured"] == configured
    monkeypatch.setattr(services.library, "mods", lambda: [])
    v = rpc(app, "roster.list")["result"]["families"][0]["variants"][0]
    assert v["mods"] == 0 and v["modCounts"] == {"spr": 0, "lobby": 0}


def test_roster_and_family_carry_the_aliases_the_search_matches(app, services):
    services.catalog.f.aliases = ["\u5c0f\u661f"]
    services.catalog.v.aliases = ["\u5c0f\u661f\uff08x\uff09"]
    for result in (rpc(app, "roster.list")["result"]["families"][0], rpc(app, "family.get", key="hoshino")["result"]):
        assert result["aliases"] == ["\u5c0f\u661f"]
        assert result["variants"][0]["aliases"] == ["\u5c0f\u661f\uff08x\uff09"]


def test_own_aliases_are_kept_and_listed(app, services, tmp_path):
    assert rpc(app, "roster.list")["result"]["families"][0]["custom"] == []
    kept = rpc(app, "aliases.set", family="hoshino", aliases=[" Oji  san ", "oji san", "", "<i>x</i>"])["result"]
    assert kept == ["Oji san", "<i>x</i>"]
    assert rpc(app, "roster.list")["result"]["families"][0]["custom"] == kept
    assert rpc(app, "family.get", key="hoshino")["result"]["custom"] == kept
    # kept across launches, in the user's data folder
    assert UiState(tmp_path / "webui.json").aliases() == {"hoshino": kept}
    # past the limits nothing changes
    too_long = rpc(app, "aliases.set", family="hoshino", aliases=["x" * (ALIAS_LENGTH + 1)])["error"]
    assert too_long == {"code": "alias_too_long", "params": {"max": ALIAS_LENGTH}}
    too_many = rpc(app, "aliases.set", family="hoshino", aliases=[f"a{i}" for i in range(ALIAS_MAX + 1)])["error"]
    assert too_many == {"code": "alias_too_many", "params": {"max": ALIAS_MAX}}
    # repeats count once
    assert rpc(app, "aliases.set", family="hoshino", aliases=["a"] * (ALIAS_MAX + 1))["result"] == ["a"]
    assert rpc(app, "aliases.set", family="hoshino", aliases=kept)["result"] == kept
    for bad in ("x", [1], None):
        assert rpc(app, "aliases.set", family="hoshino", aliases=bad)["error"]["code"] == "bad_params"
    assert rpc(app, "aliases.set", family="nobody", aliases=["x"])["error"]["code"] == "family_not_found"
    assert rpc(app, "family.get", key="hoshino")["result"]["custom"] == kept
    # none: the student's entry goes
    assert rpc(app, "aliases.set", family="hoshino", aliases=[])["result"] == []
    assert UiState(tmp_path / "webui.json").aliases() == {}


def _bundle(folder: Path, stem: str, trailing: bytes = b"") -> Path:
    """A minimal UnityFS file named with the CRC of its whole content, as the game names its bundles."""
    head = b"UnityFS\x00" + (6).to_bytes(4, "big") + b"5.x.x\x002021.3\x00"
    data = head + (len(head) + 8 + 16).to_bytes(8, "big") + bytes(16)
    crc = binascii.crc32(data + trailing) & 0xFFFFFFFF
    path = folder / f"{stem}_{crc}.bundle"
    path.write_bytes(data + trailing)
    return path


def test_family_lists_the_model_prefab_bundles(app, services, monkeypatch, tmp_path):
    old = _bundle(tmp_path, "character-hoshino_original-_mxload-2024-11-18_000_assets_all")
    new = _bundle(tmp_path, "character-hoshino_original-_mxload-2025-07-25_assets_all", trailing=b"\x01\x02\x03\x04")
    broken = tmp_path / "character-hoshino_original-_mxload-2025-08-01_assets_all_12345.bundle"
    broken.write_bytes(old.read_bytes())
    monkeypatch.setattr(FakeGame, "_model_index", lambda self: {"hoshino_original": [str(old), str(new), str(broken)]},
                        raising=False)
    services.catalog.v.model = "hoshino_original"
    files = rpc(app, "family.get", key="hoshino")["result"]["variants"][0]["modelFiles"]
    # newest first, each with the date and CRC state the info panel shows, judged from the header only (decision 27):
    # no switch writes model bundles, so a name whose CRC does not match without trailing bytes shows ok
    assert [(Path(f["file"]), f["date"], f["crc"], f["kind"]) for f in files] == [
        (broken, "2025-08-01", "ok", "model"), (new, "2025-07-25", "fixed", "model"), (old, "2024-11-18", "ok", "model")]
    assert files[2]["size"] == old.stat().st_size
    services.catalog.v.model = None
    assert rpc(app, "family.get", key="hoshino")["result"]["variants"][0]["modelFiles"] == []


def test_catalog_follows_the_selected_server(tmp_path: Path):
    settings = Settings(tmp_path / "config.toml")
    settings.set("file_source", "windows_japan")
    s = Services(settings, tmp_path, state=UiState(tmp_path / "webui.json"), cache=object(), game=FakeGame(),
                 library=FakeLibrary())
    try:
        assert s.catalog.server == "japan"
        settings.set("file_source", "windows_global")
        s.reload_game()
        assert s.catalog.server == "global"
    finally:
        s.close()


def test_consent_controls_cache_headers(app, services):
    _, headers, body = call(app, "/asset/ui/sprite/Common/Common_Icon_Back.png")
    assert body == b"\x89PNG sprite" and headers["Cache-Control"] == "no-store"
    services.state.set_consent(True)
    assert call(app, "/asset/ui/sprite/Common/Common_Icon_Back.png")[1]["Cache-Control"].startswith("private")
    # heavy assets are never cacheable
    assert call(app, "/asset/art/portrait/X.png")[1]["Cache-Control"] == "no-store"


def test_asset_routes(app):
    assert call(app, "/asset/ui/sprite/Common/Missing.png")[0] == "404 Not Found"
    assert json.loads(call(app, "/asset/ui/textures.json")[2]) == {"UITex_A": "/asset/ui/texture/UITex_A.png"}
    assert json.loads(call(app, "/asset/ui/layout/UIRoot.json?path=A/B")[2])["name"] == "B"
    assert call(app, "/asset/spine/spr/hoshino_spr/hoshino_spr.atlas")[2] == b"atlas"
    assert call(app, "/asset/spine/spr/hoshino_spr/skeleton.skel")[2] == b"skel"
    assert call(app, "/asset/spine/spr/hoshino_spr/other.png")[0] == "404 Not Found"


def test_another_installs_skeleton_is_read_from_its_own_files(app, services, monkeypatch, tmp_path):
    from ba_modding_toolkit.library.models import Pin

    current = Pin("/games/global", tmp_path / "global", (tmp_path / "global",), "global")
    other = Pin("/games/japan", tmp_path / "japan", (tmp_path / "japan",), "japan")
    services.library.pins = [current, other]
    made = []

    class OtherGame(FakeGame):
        def __init__(self, dirs, private=False):
            # never the shared cache: it is keyed by the resource version, which two installs may share
            assert private
            made.append(dirs)

        def spine_files(self, kind, core):
            return {f"{core}.skel": b"japan skel"}

    monkeypatch.setattr(services, "_make_game", OtherGame)
    # the core in another install: that install's own files, its GameAssets made once
    assert json.loads(call(app, f"/asset/spine/spr/hoshino_spr@{other.id}/files.json")[2]) == ["hoshino_spr.skel"]
    assert call(app, f"/asset/spine/spr/hoshino_spr@{other.id}/skeleton.skel")[2] == b"japan skel"
    assert made == [[tmp_path / "japan"]]
    # the same path without the id, or with the current install's: the current install's files
    assert call(app, "/asset/spine/spr/hoshino_spr/skeleton.skel")[2] == b"skel"
    assert call(app, f"/asset/spine/spr/hoshino_spr@{current.id}/skeleton.skel")[2] == b"skel"
    assert call(app, "/asset/spine/spr/hoshino_spr@000000000000/files.json")[0] == "404 Not Found"


def test_mod_skeleton_is_the_one_named_by_the_mods_core(app, services, monkeypatch):
    # a memorial lobby mod holds the character's skeleton and its background's
    bundle = Path("assets-_mx-spinelobbies-hoshino_home-_mxdependency-2026-01-01_assets_all_1.bundle")
    monkeypatch.setattr(services.library, "preview_bundles", lambda mod_id: [bundle], raising=False)
    monkeypatch.setattr(services.game, "spine_files_from", lambda bundles: {
        "Hoshino_home.skel": b"main", "Hoshino_home.atlas": b"main atlas",
        "Hoshino_home_bg.skel": b"bg", "Hoshino_home_bg.atlas": b"bg atlas"}, raising=False)
    assert call(app, "/asset/spine/mod/m1/skeleton.skel")[2] == b"main"
    assert call(app, "/asset/spine/mod/m1/skeleton.atlas")[2] == b"main atlas"


def test_official_skeleton_route_reads_the_librarys_official_parts(app, services, monkeypatch, tmp_path):
    bundle = _bundle(tmp_path, "official.bundle")
    requested = []

    def official_bundles(core_name, pin=None):
        requested.append(core_name)
        return [bundle]

    def spine_files_from(bundles):
        assert bundles == [bundle]
        return {"hoshino_spr.skel": b"official skel", "hoshino_spr.atlas": b"official atlas",
                "hoshino_spr.png": b"official png"}

    monkeypatch.setattr(services.library, "official_bundles", official_bundles, raising=False)
    monkeypatch.setattr(services.game, "spine_files_from", spine_files_from, raising=False)
    for name, expected in [("skeleton.skel", b"official skel"), ("skeleton.atlas", b"official atlas"),
                           ("hoshino_spr.png", b"official png")]:
        status, headers, body = call(app, f"/asset/spine/official-spr/hoshino_spr/{name}")
        assert status == "200 OK" and body == expected
        assert headers["Cache-Control"] == "no-store"
    assert requested and set(requested) == {"hoshino_spr"}
    assert json.loads(call(app, "/asset/spine/official-spr/hoshino_spr/files.json")[2]) == [
        "hoshino_spr.atlas", "hoshino_spr.png", "hoshino_spr.skel"]
    assert call(app, "/asset/spine/spr/hoshino_spr/skeleton.skel")[2] == b"skel"
    assert call(app, "/asset/spine/official/hoshino_spr/skeleton.skel")[0] == "404 Not Found"


@pytest.mark.parametrize("kind", ["spr", "lobby", "mod", "official-spr", "official-lobby"])
def test_spine_revision_routes_reject_switched_files(app, services, monkeypatch, tmp_path, kind):
    bundle = _bundle(tmp_path, "assets-_mx-spinecharacters-hoshino_spr-_mxdependency-2026-01-01_assets_all")
    monkeypatch.setattr(services.game, "spine_cores", lambda kind: {"hoshino_spr": [bundle]}, raising=False)
    monkeypatch.setattr(services.game, "spine_files_from", lambda paths: {
        "hoshino_spr.skel": paths[0].read_bytes(), "hoshino_spr.atlas": paths[0].read_bytes(),
        "Pages/portrait.png": paths[0].read_bytes()}, raising=False)
    monkeypatch.setattr(services.game, "lobby_info", lambda core: {"content": bundle.read_bytes().hex()}, raising=False)
    monkeypatch.setattr(services.library, "preview_bundles", lambda mod: [bundle], raising=False)
    monkeypatch.setattr(services.library, "official_bundles", lambda core, pin=None: [bundle], raising=False)
    prefix = f"/asset/spine/{kind}/hoshino_spr"
    before = json.loads(call(app, prefix + "/manifest.json")[2])["revision"]
    expected = bundle.read_bytes()
    assert call(app, f"{prefix}/{before}/skeleton.skel")[2] == expected
    bundle.write_bytes(expected + b"changed")
    for name in ("skeleton.skel", "skeleton.atlas", "Pages/portrait.png", "files.json", "lobby.json"):
        assert call(app, f"{prefix}/{before}/{name}")[0] == "404 Not Found"
    after = json.loads(call(app, prefix + "/manifest.json")[2])["revision"]
    assert after != before
    for name in ("skeleton.skel", "skeleton.atlas", "Pages/portrait.png"):
        status, headers, body = call(app, f"{prefix}/{after}/{name}")
        assert status == "200 OK" and body == bundle.read_bytes()
        assert headers["Cache-Control"] == "no-store"
    if kind == "lobby":
        assert json.loads(call(app, f"{prefix}/{after}/lobby.json")[2])["content"] == bundle.read_bytes().hex()


@pytest.mark.parametrize("kind", ["spr", "lobby"])
def test_live_spine_files_are_read_in_the_librarys_order(app, services, monkeypatch, tmp_path, kind):
    name = "hoshino_spr" if kind == "spr" else "hoshino_home"
    official = _bundle(tmp_path, "assets-_mx-spinelobbies-b-_mxdependency-2026-01-01_assets_all")
    mod = _bundle(tmp_path, "assets-_mx-spinelobbies-a-_mxdependency-2026-01-01_assets_all", b"x")
    monkeypatch.setattr(services.game, "spine_cores", lambda k: {name: [mod, official]}, raising=False)
    seen = []
    monkeypatch.setattr(services.game, "spine_files_from", lambda paths: seen.append(list(paths)) or {
        f"{name}.skel": b"skeleton"}, raising=False)
    # a library that knows nothing of the core: the game's own order
    first = json.loads(call(app, f"/asset/spine/{kind}/{name}/manifest.json")[2])["revision"]
    assert call(app, f"/asset/spine/{kind}/{name}/{first}/skeleton.skel")[0] == "200 OK"
    assert seen[-1] == [mod, official]
    # the library puts the part that carries a mod last: the revision and the files follow that order
    services.library.live[name] = [official, mod]
    second = json.loads(call(app, f"/asset/spine/{kind}/{name}/manifest.json")[2])["revision"]
    assert second != first
    assert call(app, f"/asset/spine/{kind}/{name}/{second}/skeleton.skel")[0] == "200 OK"
    assert seen[-1] == [official, mod]


def test_missing_official_spine_returns_404(app, services, monkeypatch):
    def missing(core, pin=None):
        raise ServiceError("original_unavailable", file=core)

    monkeypatch.setattr(services.library, "official_bundles", missing, raising=False)
    for name in ("manifest.json", "skeleton.skel", "skeleton.atlas", "portrait.png"):
        assert call(app, f"/asset/spine/official-spr/hoshino_spr/{name}")[0] == "404 Not Found"


def test_a_new_library_prunes_its_kept_originals_once(tmp_path, monkeypatch):
    pruned = []

    class Library:
        def __init__(self, *args, **kwargs):
            pass

        def prune(self):
            pruned.append(self)
            return [tmp_path / "originals" / "a.bundle"]

        def judge_unfinished(self):
            return 0

    monkeypatch.setattr("ba_modding_toolkit.library.ModLibrary", Library)
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                 cache=object(), game=FakeGame(), catalog=FakeCatalog())
    try:
        library = s.library
        assert s.library is library
        deadline = time.monotonic() + 5
        while (not pruned or s.jobs.busy()) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert pruned == [library]
    finally:
        s.close()


def test_lobby_warm_builds_the_prefab_index_once_per_game(app, services, monkeypatch):
    calls, cabs, release = [], [], threading.Event()

    def prefabs(game):
        calls.append(game)
        release.wait(5)
        return {}

    monkeypatch.setattr(FakeGame, "_lobby_prefabs", prefabs, raising=False)
    # then the index of every bundle's CABs, for the lobbies' particle effects
    monkeypatch.setattr(FakeGame, "_cab_index", lambda game, everything=False: cabs.append((game, everything)) or {},
                        raising=False)
    first = services.game
    # answered at once while the index is built in the background; a second call does not start another build
    assert "error" not in rpc(app, "lobby.warm") and "error" not in rpc(app, "lobby.warm")
    release.set()
    for thread in [t for t in threading.enumerate() if t.name == "lobby-warm"]:
        thread.join(5)
    assert calls == [first] and cabs == [(first, True)]
    # another game (a new game folder or file source) is warmed again
    services._game = FakeGame()
    rpc(app, "lobby.warm")
    for thread in [t for t in threading.enumerate() if t.name == "lobby-warm"]:
        thread.join(5)
    assert calls == [first, services._game]
    # without a game nothing is started
    monkeypatch.setattr(services, "game_found", lambda: False)
    services._game = FakeGame()
    assert "error" not in rpc(app, "lobby.warm")
    assert len(calls) == 2


def test_static_files_stay_inside_web_dir(app, tmp_path):
    app.static_dir = tmp_path
    (tmp_path / "index.html").write_text("<html>")
    assert call(app, "/")[2] == b"<html>"
    assert call(app, "/../config.toml")[0] == "404 Not Found"


def test_job_runs_and_reports_events(services):
    q = services.events.subscribe()
    job_id = services.jobs.submit("apply", lambda log, progress, **p: services.library.apply(log=log, progress=progress, **p),
                                  variant_key="hoshino", source="mod:m1")
    events = []
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not any(e[0] in ("job.done", "job.failed") for e in events):
        try:
            events.append(q.get(timeout=0.2))
        except Exception:
            pass
    kinds = [e[0] for e in events]
    assert kinds[0] == "job.started" and kinds[-1] == "job.done"
    assert {"id": job_id, "lines": ["applying"]} in [e[1] for e in events if e[0] == "job.log"]
    assert services.jobs.get(job_id).result == {"applied": "mod:m1"}


def test_job_failure_keeps_worker_alive():
    bus = EventBus()
    jobs = JobRunner(bus)

    def boom(log, progress):
        raise ServiceError("game_file_locked", file="x")

    bad = jobs.submit("x", boom)
    good = jobs.submit("y", lambda log, progress: 42)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and jobs.get(good).state != "done":
        time.sleep(0.02)
    assert jobs.get(bad).error == {"code": "game_file_locked", "params": {"file": "x"}}
    assert jobs.get(good).result == 42
    jobs.shutdown()


def test_sse_stream_delivers_events():
    bus = EventBus()
    stream = bus.stream(heartbeat=0.1)
    assert next(stream).startswith(b"retry:")
    threading.Timer(0.05, lambda: bus.publish("drop", {"paths": ["a"]})).start()
    chunk = next(stream)
    while chunk.startswith(b":"):
        chunk = next(stream)
    assert chunk == b'event: drop\ndata: {"paths":["a"]}\n\n'
    bus.close()


def test_ui_strings_fall_back_key_by_key():
    zh = ui_strings("zh-CN")
    en = ui_strings("en-US")
    assert zh["webui.tab.lobby"] == "记忆大厅"
    assert en["webui.tab.model"] == "3D Model"
    assert set(zh) == set(en)
    assert all("·" not in v and "・" not in v for v in zh.values())
    # Traditional Chinese falls back to English, not to Simplified Chinese (i18n.fallback_language); Korean and
    # Japanese too, key by key: until its locale file ships a language shows the English strings, then its own,
    # never the Simplified Chinese ones
    for lang in ("zh-TW", "ja-JP", "ko-KR"):
        shipped = lang in offered_languages()
        assert (ui_strings(lang)["webui.tab.lobby"] != en["webui.tab.lobby"]) is shipped, lang
        assert ui_strings(lang)["webui.tab.lobby"] != zh["webui.tab.lobby"], lang
        assert set(ui_strings(lang)) == set(en), lang
    assert ui_strings("zh-TW")["webui.tab.lobby"] == "紀念大廳"
    assert ui_strings("ja-JP")["webui.tab.lobby"] == "メモリアルロビー"
    # a shipped translation: the Global client's own Korean term
    assert ui_strings("ko-KR")["webui.tab.lobby"] == "메모리얼 로비"
    assert ui_strings("zh-SG")["webui.tab.lobby"] == "记忆大厅"


def test_cookie_found_among_unparsable_cookies(app):
    _, headers, _ = call(app, "/?t=tok", token=None)
    ours = headers["Set-Cookie"].split(";")[0]
    status, _, _ = call(app, "/api/rpc", "POST", {"method": "app.info"}, token=None, cookie=f'junk="a;b; x=[1]; {ours}')
    assert status == "200 OK"


def test_non_ascii_token_is_refused_not_crashed(app):
    assert call(app, "/api/rpc", "POST", {"method": "app.info"}, token="星野")[0] == "403 Forbidden"
    assert call(app, "/?t=星野", token=None)[0] == "403 Forbidden"


def test_roster_view_keeps_only_valid_fields():
    assert roster_view(None) == {"merged": False, "mods": "all", "recruit": "all", "sort": "recent", "order": "desc",
                                 "filters": {}}
    view = roster_view({"merged": True, "mods": "none", "recruit": "maybe", "sort": "name", "extra": 1,
                        "filters": {"lobby": ["no", "no", "x"], "kind": "npc", "favorite": [], "bogus": ["yes"]}})
    assert view == {"merged": True, "mods": "none", "recruit": "all", "sort": "name", "order": "asc",
                    "filters": {"lobby": ["no"]}}
    assert roster_view({"sort": "mods", "order": "asc"})["order"] == "asc"


def test_roster_view_is_kept_across_launches(app, services, tmp_path):
    assert rpc(app, "settings.get")["result"]["roster"]["sort"] == "recent"
    sent = {"merged": True, "recruit": "yes", "sort": "added", "order": "asc", "filters": {"portrait": ["replaced"]}}
    saved = rpc(app, "settings.set", key="roster", value=sent)["result"]["roster"]
    assert saved == {**roster_view(None), **sent}
    # a new launch reads the same file
    assert roster_view(UiState(tmp_path / "webui.json").get("roster")) == saved


def test_settings_offer_the_languages_with_a_locale_file(app, services, tmp_path, monkeypatch):
    from ba_modding_toolkit.i18n import i18n_manager
    from ba_modding_toolkit.webui import api as webui_api

    locales = tmp_path / "locales"
    locales.mkdir()
    for code, name in (("zh-CN", "简体中文"), ("en-US", "English"), ("ko-KR", "한국어")):
        (locales / f"{code}.json").write_text(json.dumps({"webui": {"languageName": name}}), encoding="utf-8")
    monkeypatch.setattr(webui_api, "get_locale_dir", lambda: locales)
    monkeypatch.setattr(webui_api, "offered_languages", lambda: offered_languages(locales))
    monkeypatch.setattr(i18n_manager, "lang", i18n_manager.lang)  # restored after the test
    languages = rpc(app, "settings.get")["result"]["languages"]
    assert languages == [{"code": "zh-CN", "name": "简体中文"}, {"code": "en-US", "name": "English"},
                         {"code": "ko-KR", "name": "한국어"}]
    # a known language without its locale file yet (zh-TW, ja-JP) cannot be chosen
    assert rpc(app, "settings.set", key="language", value="zh-TW")["error"]["code"] == "bad_params"
    monkeypatch.setattr(i18n_manager, "set_language", lambda lang: None)
    assert "error" not in rpc(app, "settings.set", key="language", value="ko-KR")
    assert services.settings.get("language") == "ko-KR"


def test_install_update_needs_the_window_and_the_verified_download(app, services, tmp_path):
    assert rpc(app, "app.installUpdate", file=str(tmp_path / "x.dmg"))["error"]["code"] == "update_unsupported"


@pytest.fixture
def update_env(services, tmp_path, monkeypatch):
    from ba_modding_toolkit import updater

    info = updater.UpdateInfo("1.1.0", "1.0.0", "", updater.Asset("app.dmg", "https://example.invalid/app.dmg", 8),
                              updater.Asset("app.dmg.md5", "https://example.invalid/app.dmg.md5", 32), installable=True)
    env = SimpleNamespace(info=info, downloads=[], installs=[], quits=[])
    monkeypatch.setattr(updater, "check", lambda: env.info)
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("network access"))
    monkeypatch.setattr(updater, "_get", lambda *a, **kw: pytest.fail("network access"))
    monkeypatch.setattr("ba_modding_toolkit.webui.api.tempfile.mkdtemp", lambda **kw: str(tmp_path / "downloads"))

    def download(info, dest, progress):
        env.downloads.append(info.version)
        dest.mkdir(exist_ok=True)
        path = dest / f"{info.version}.dmg"
        path.write_bytes(b"verified")
        progress(8, 8, path.name)
        return path, "verified-md5"

    monkeypatch.setattr(updater, "download", download)
    monkeypatch.setattr(updater, "prepare_install", lambda path, md5: lambda: env.installs.append((path, md5)))

    def destroy():
        if services.on_closing():
            env.quits.append(True)
            services.on_closed()

    services.window = SimpleNamespace(destroy=destroy)
    return env


def download_update(app, services):
    job = rpc(app, "app.update")["result"]
    assert services.jobs.wait(job, 5)
    result = services.jobs.get(job)
    assert result.state == "done", result.error
    return result.result["file"]


def test_update_rpc_keeps_a_verified_version_for_later_and_installs_only_on_request(app, services, update_env):
    info = rpc(app, "app.checkUpdate")["result"]
    assert info == {**update_env.info.to_json(), "downloaded": False, "file": None}
    file = download_update(app, services)
    assert services.update_file == (Path(file), "verified-md5", update_env.info.version)
    assert update_env.installs == update_env.quits == []
    # A new check produces a new UpdateInfo instance; its version still matches the retained download.
    update_env.info = replace(update_env.info)
    ready = rpc(app, "app.checkUpdate")["result"]
    assert ready["downloaded"] is True and ready["file"] == file
    assert download_update(app, services) == file
    assert update_env.downloads == ["1.1.0"]
    assert update_env.installs == update_env.quits == []
    assert rpc(app, "app.installUpdate", file=file) == {"result": None}
    assert update_env.installs == [(Path(file), "verified-md5")]
    assert update_env.quits == [True]


def test_update_rpc_never_reuses_a_download_for_another_version(app, services, update_env):
    rpc(app, "app.checkUpdate")
    old = download_update(app, services)
    update_env.info = replace(update_env.info, version="1.2.0")
    info = rpc(app, "app.checkUpdate")["result"]
    assert info["version"] == "1.2.0" and info["downloaded"] is False and info["file"] is None
    assert rpc(app, "app.installUpdate", file=old)["error"]["code"] == "update_unavailable"
    new = download_update(app, services)
    assert new != old and update_env.downloads == ["1.1.0", "1.2.0"]
    assert rpc(app, "app.installUpdate", file=old)["error"]["code"] == "update_unavailable"
    assert rpc(app, "app.checkUpdate")["result"]["file"] == new
    assert update_env.installs == update_env.quits == []


def test_update_rpc_redownloads_a_missing_file_and_handles_no_release(app, services, update_env):
    rpc(app, "app.checkUpdate")
    file = download_update(app, services)
    Path(file).unlink()
    assert rpc(app, "app.installUpdate", file=file)["error"]["code"] == "update_unavailable"
    missing = rpc(app, "app.checkUpdate")["result"]
    assert missing["downloaded"] is False and missing["file"] is None
    assert download_update(app, services) == file
    assert update_env.downloads == ["1.1.0", "1.1.0"]
    update_env.info = replace(update_env.info, installable=False)
    rpc(app, "app.checkUpdate")
    assert rpc(app, "app.update")["error"]["code"] == "update_unsupported"
    update_env.info = None
    assert rpc(app, "app.checkUpdate") == {"result": None}
    assert rpc(app, "app.update")["error"]["code"] == "update_unsupported"
    assert rpc(app, "app.installUpdate", file=file)["error"]["code"] == "update_unavailable"


def test_update_rpc_rechecks_the_cache_when_queued_downloads_run(app, services, update_env):
    gate = threading.Event()
    services.jobs.submit("block", lambda log, progress: gate.wait(5))
    try:
        rpc(app, "app.checkUpdate")
        first = rpc(app, "app.update")["result"]
        second = rpc(app, "app.update")["result"]
        assert rpc(app, "app.checkUpdate")["result"]["downloaded"] is False
        gate.set()
        assert services.jobs.wait(first, 5) and services.jobs.wait(second, 5)
        assert services.jobs.get(first).state == services.jobs.get(second).state == "done"
        assert services.jobs.get(first).result == services.jobs.get(second).result
        assert update_env.downloads == ["1.1.0"]
    finally:
        gate.set()


def test_update_rpc_does_not_cache_a_failed_download_and_can_retry(app, services, update_env, monkeypatch):
    from ba_modding_toolkit import updater

    rpc(app, "app.checkUpdate")
    download = updater.download

    def fail(info, dest, progress):
        raise ServiceError("update_checksum_mismatch", file=info.asset.name)

    monkeypatch.setattr(updater, "download", fail)
    job = rpc(app, "app.update")["result"]
    assert services.jobs.wait(job, 5)
    assert services.jobs.get(job).error["code"] == "update_checksum_mismatch"
    assert services.update_file is None
    assert rpc(app, "app.checkUpdate")["result"]["downloaded"] is False
    assert update_env.installs == update_env.quits == []
    monkeypatch.setattr(updater, "download", download)
    file = download_update(app, services)
    assert rpc(app, "app.checkUpdate")["result"]["file"] == file


@pytest.mark.parametrize("code", ["classic_open", "busy", "update_unavailable", "update_unsupported"])
def test_install_update_refusals_keep_the_download_for_retry(app, services, update_env, monkeypatch, code):
    from ba_modding_toolkit import updater

    rpc(app, "app.checkUpdate")
    file = download_update(app, services)
    retained = services.update_file
    gate = threading.Event()
    job = None
    prepare = updater.prepare_install
    if code == "classic_open":
        monkeypatch.setattr(services, "classic_open", lambda: True)
    elif code == "busy":
        job = services.jobs.submit("writer", lambda log, progress: gate.wait(5), writes="game")
    elif code == "update_unavailable":
        file += ".other"
    else:
        def unsupported(path, md5):
            raise ServiceError("update_unsupported")
        monkeypatch.setattr(updater, "prepare_install", unsupported)
    try:
        assert rpc(app, "app.installUpdate", file=file)["error"]["code"] == code
        assert services.update_file == retained
        assert rpc(app, "app.checkUpdate")["result"]["downloaded"] is True
        assert update_env.installs == update_env.quits == []
    finally:
        gate.set()
    monkeypatch.setattr(services, "classic_open", lambda: False)
    monkeypatch.setattr(updater, "prepare_install", prepare)
    if job:
        assert services.jobs.wait(job, 5)
    assert rpc(app, "app.installUpdate", file=str(retained[0])) == {"result": None}
    assert update_env.installs == [(retained[0], retained[1])]
    assert update_env.quits == [True]


@pytest.mark.parametrize("closing_event", [True, False])
def test_install_update_reserves_admission_until_native_closed_and_starts_only_one_helper(
        app, services, update_env, monkeypatch, closing_event):
    from ba_modding_toolkit import updater

    rpc(app, "app.checkUpdate")
    file = download_update(app, services)
    destroying, finish = threading.Event(), threading.Event()
    answer = {}

    def destroy():
        destroying.set()
        assert finish.wait(5)
        # Some native backends skip closing on destroy(), but all signal closed once the window is gone.
        def closed():
            if closing_event:
                assert services.on_closing() is True
            assert update_env.installs == []
            update_env.quits.append(True)
            services.on_closed()

        closer = threading.Thread(target=closed)
        closer.start()
        closer.join(5)
        assert not closer.is_alive()

    def install(path, md5):
        assert update_env.quits == [True]  # launch only after a confirmed native close
        with pytest.raises(ServiceError, match="busy"):
            services.jobs.submit("writer", lambda log, progress: None, writes="game")
        update_env.installs.append((path, md5))

    monkeypatch.setattr(services.window, "destroy", destroy)
    monkeypatch.setattr(updater, "prepare_install", lambda path, md5: lambda: install(path, md5))
    installer = threading.Thread(target=lambda: answer.update(rpc(app, "app.installUpdate", file=file)))
    installer.start()
    try:
        assert destroying.wait(5)
        assert update_env.installs == update_env.quits == []
        # The tray and the classic queue use guarded service submissions; direct library writers use jobs.submit.
        with services.classic.starting():
            with pytest.raises(ServiceError, match="busy"):
                services.submit("mods.toggle", lambda log, progress: None, writes="game")
        with pytest.raises(ServiceError, match="busy"):
            services.jobs.submit("library.adopt", lambda log, progress: None, writes="library")
        assert rpc(app, "app.openClassic")["error"]["code"] == "busy"
        assert rpc(app, "app.installUpdate", file=file)["error"]["code"] == "busy"
    finally:
        finish.set()
        installer.join(5)
    assert not installer.is_alive()
    assert answer == {"result": None}
    assert update_env.installs == [(Path(file), "verified-md5")]
    assert update_env.quits == [True]
    # A page watchdog may enable Restart again if the window survives; neither request nor callback spawns twice.
    assert rpc(app, "app.installUpdate", file=file)["error"]["code"] == "busy"
    assert services.on_closing() is True
    services.on_closed()
    assert len(update_env.installs) == 1
    with pytest.raises(ServiceError, match="busy"):
        services.jobs.submit("writer", lambda log, progress: None, writes="game")


@pytest.mark.parametrize("refusal", ["silent", "accepted", "exception", "classic_open"])
def test_install_update_never_launches_a_helper_for_a_refused_native_close_and_releases_admission(
        app, services, update_env, monkeypatch, refusal):
    from ba_modding_toolkit.webui import services as services_module

    monkeypatch.setattr(services_module, "UPDATE_QUIT_WAIT", 0.01)
    rpc(app, "app.checkUpdate")
    file = download_update(app, services)
    destroy = services.window.destroy

    def refuse():
        assert update_env.installs == []
        if refusal == "exception":
            raise ServiceError("update_restart_failed")
        if refusal == "classic_open":
            monkeypatch.setattr(services, "classic_open", lambda: True)
            assert services.on_closing() is False
        if refusal == "accepted":
            assert services.on_closing() is True

    monkeypatch.setattr(services.window, "destroy", refuse)
    code = "classic_open" if refusal == "classic_open" else "update_restart_failed"
    assert rpc(app, "app.installUpdate", file=file)["error"]["code"] == code
    assert update_env.installs == update_env.quits == []
    assert services.update_installing is False
    assert services.update_file[0] == Path(file)
    writer = services.jobs.submit("writer", lambda log, progress: None, writes="game")
    assert services.jobs.wait(writer, 5)
    # A delayed closing callback after cancellation cannot launch the old pending helper.
    monkeypatch.setattr(services, "classic_open", lambda: False)
    assert services.on_closing() is True
    services.on_closed()
    assert update_env.installs == []
    monkeypatch.setattr(services.window, "destroy", destroy)
    assert rpc(app, "app.installUpdate", file=file) == {"result": None}
    assert update_env.installs == [(Path(file), "verified-md5")]


def test_settings_change_waits_for_the_running_job(services):
    gate = threading.Event()
    library = services.library
    job = services.jobs.submit("slow", lambda log, progress: gate.wait(5), writes="library")
    deadline = time.monotonic() + 5
    while not services.jobs.busy() and time.monotonic() < deadline:
        time.sleep(0.01)
    services._injected.discard("library")
    services._on_settings_changed()
    assert services._library is library  # not swapped while the job runs
    gate.set()
    while services.jobs.get(job).state != "done" and time.monotonic() < deadline:
        time.sleep(0.01)
    services._refresh_if_idle()
    assert services._library is None


def test_every_service_error_has_a_string():
    import re
    root = Path(__file__).resolve().parents[1] / "src" / "ba_modding_toolkit"
    codes = set()
    for path in root.rglob("*.py"):
        codes |= set(re.findall(r'ServiceError\("([a-z_]+)"', path.read_text(encoding="utf-8")))
    for lang in ("zh-CN", "en-US"):
        strings = ui_strings(lang)
        assert not [c for c in sorted(codes) if f"webui.error.{c}" not in strings], lang


def test_static_files_behind_symlinks_are_served(app, tmp_path):
    # a macOS app bundle keeps some page folders as symlinks into Contents/Resources
    page, resources = tmp_path / "web", tmp_path / "Resources" / "vendor"
    (page).mkdir()
    resources.mkdir(parents=True)
    (resources / "lib.js").write_text("var lib = 1;")
    (page / "vendor").symlink_to(resources, target_is_directory=True)
    (tmp_path / "secret.txt").write_text("no")
    app.static_dir = page
    assert call(app, "/vendor/lib.js")[2] == b"var lib = 1;"
    assert call(app, "/vendor/../../secret.txt")[0] == "404 Not Found"
    assert call(app, "/../secret.txt")[0] == "404 Not Found"


def test_program_command_in_a_compiled_build(monkeypatch, tmp_path):
    from ba_modding_toolkit.webui import system
    exe = tmp_path / "Tool"
    exe.write_text("")
    monkeypatch.setitem(system.__dict__, "__compiled__", True)
    monkeypatch.setattr(system.sys, "argv", [str(exe)])
    monkeypatch.setattr(system.sys, "executable", str(tmp_path / "python"))
    assert system.program_command() == [str(exe.resolve())]


def test_the_window_leaves_the_pointer_and_text_selection_to_the_page(monkeypatch, tmp_path):
    """pywebview's text_select=False (its default) appends "body { user-select: none; cursor: default }" to the page,
    after app.css: the game's pointer (web/js/cursor.js) then shows only on buttons, the system arrow everywhere else.
    The window keeps text selection on and the page turns it off itself."""
    import re
    import sys
    from types import SimpleNamespace

    from ba_modding_toolkit.webui import main

    class Hook:
        def __iadd__(self, handler):
            return self

    created, started = {}, {}

    def create_window(title, url, **options):
        created.update(options)
        return SimpleNamespace(events=SimpleNamespace(initialized=Hook(), loaded=Hook(), closing=Hook(), closed=Hook()))

    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(create_window=create_window,
                                                                start=lambda **options: started.update(options)))
    from ba_modding_toolkit.webui.tray import Tray

    monkeypatch.setattr(Tray, "supported", staticmethod(lambda platform=sys.platform: False))  # tests/test_tray.py
    main._run_window(SimpleNamespace(window=None, data_dir=tmp_path), SimpleNamespace(url="http://127.0.0.1:1/"), False)
    assert created["text_select"] is True
    assert started["private_mode"] is True

    css = (Path(main.__file__).parent.parent / "web" / "css" / "app.css").read_text(encoding="utf-8")
    body = " ".join(re.findall(r"^body\s*\{([^}]*)\}", css, re.M))
    for declaration in ("cursor: var(--cursor)", "-webkit-user-select: none", " user-select: none"):
        assert declaration in body


def test_the_close_button_waits_only_for_a_writer_job(services, monkeypatch, tmp_path):
    import sys
    from types import SimpleNamespace

    from ba_modding_toolkit.webui import main

    handlers = {}

    class Hook:
        def __init__(self, name):
            self.name = name

        def __iadd__(self, handler):
            handlers[self.name] = handler
            return self

    def create_window(title, url, **options):
        return SimpleNamespace(events=SimpleNamespace(initialized=Hook("initialized"), loaded=Hook("loaded"),
                                                      closing=Hook("closing"), closed=Hook("closed")))

    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(create_window=create_window, start=lambda **o: None))
    main._run_window(services, SimpleNamespace(url="http://127.0.0.1:1/"), False)
    gate = threading.Event()
    services.jobs.submit("extract", lambda log, progress: gate.wait(5))  # read-only: the window may close
    assert handlers["closing"]() is True
    services.jobs.submit("library.adopt", lambda log, progress: gate.wait(5), writes="library")
    assert handlers["closing"]() is False
    gate.set()
