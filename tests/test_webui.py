"""Tests for the web UI server, RPC layer, jobs and events, driven through the WSGI app without a window."""

import binascii
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.i18n import I18n, offered_languages
from ba_modding_toolkit.webui.api import build_api, ui_strings
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.jobs import JobRunner
from ba_modding_toolkit.webui.server import WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import ALIAS_LENGTH, ALIAS_MAX, UiState, roster_view
from ba_modding_toolkit.webui.timing import Timings


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

    def variant(self, key):
        for variant in self.f.variants:
            if variant.key == key:
                return variant
        raise ServiceError("catalog_variant_not_found", key=key)


@dataclass
class FakeMod:
    id: str
    target: str
    fresh: bool = True
    added: str = "2026-10-01T08:00:00+00:00"
    kind: str = "spr"
    user_added: bool = True

    def to_json(self):
        return {"id": self.id, "target": self.target, "fresh": self.fresh}


class FakeLibrary:
    def assigned_targets(self):
        return set()

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

    def selection(self, key, pin=None):
        return {}

    def configured(self, key, pin=None):
        return {"spr": None, "lobby": None}

    def roster_snapshot(self, keys):
        pin = self.current_pin()
        return {"install": pin.key if pin else None, "mods": self.mods(), "favorites": self.favorites(),
                "modified": self.modified(), "configured": {key: self.configured(key) for key in keys}}

    def apply(self, variant_key, source, log, progress, kind="spr", pin=None):
        log("applying")
        progress(1, 1, variant_key)
        self.applied.append((variant_key, source))
        return {"applied": source}

    def restore(self, variant_key, log, kind="spr", pin=None, progress=None):
        self.applied.append((variant_key, "official"))
        return {"applied": "official"}

    def would_write(self, variant_key, source, kind="spr", pin=None, *, setting=False):
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
                "current": current.key if current else None, "reason": None,
                "configured": 0, **self.intent()}

    def toggle(self, enabled, expect, pins=None, log=None, progress=None, cancel=None):
        self.toggled.append((enabled, expect, pins))
        self.enabled = enabled
        return {"enabled": enabled}

    def judge_unfinished(self):
        return 0

    def prune(self):
        return []

    def take_pruned_cores(self):
        return set()


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


def test_spine_consent_rpc_reads_and_persists_the_choice(app, services):
    assert rpc(app, "app.spineConsent")["result"] is None
    assert rpc(app, "app.info")["result"]["spineConsent"] is None
    assert rpc(app, "settings.get")["result"]["spineConsent"] is None
    for granted in (True, False):
        assert rpc(app, "app.spineConsent", granted=granted)["result"] is granted
        assert rpc(app, "app.spineConsent")["result"] is granted
        assert rpc(app, "app.info")["result"]["spineConsent"] is granted
        assert rpc(app, "settings.get")["result"]["spineConsent"] is granted
        assert UiState(services.state.path).spine_consent is granted
    assert services.state.consent is None
    assert services.state.scan_consent is None
    assert services.library.applied == []


@pytest.mark.parametrize("granted", [None, 0, 1, "yes", [], {}])
def test_spine_consent_rpc_rejects_non_boolean_choices(app, services, granted):
    services.set_spine_consent(False)
    assert rpc(app, "app.spineConsent", granted=granted)["error"] == {
        "code": "bad_params", "params": {"key": "granted"}}
    assert services.state.spine_consent is False


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
    assert v["key"] == "hoshino" and v["mods"] == 1 and v["fresh"] is False
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
    assert fam["variants"][0]["modList"] == [{"id": "m1", "target": "hoshino", "fresh": False}]
    assert fam["version"] == "rv1"  # the install the parts come from


def test_mod_search_keeps_alias_core_and_file_names_in_roster_and_family(app, services, monkeypatch):
    mod = FakeMod("p1", "hoshino")
    mod.alias = mod.label = "Painted <summer>"
    mod.core = "hoshino_swimsuit_spr"
    mod.file = Path("mods/p1/2026-10-01_hoshino_swimsuit_spr.bundle")
    monkeypatch.setattr(services.library, "mods", lambda: [mod])
    for alias in ("Painted <summer>", "Evening", ""):
        mod.alias = alias
        mod.label = alias or mod.core
        for result in (rpc(app, "roster.list")["result"]["families"][0],
                       rpc(app, "family.get", key="hoshino")["result"]):
            assert result["variants"][0]["modNames"] == list(dict.fromkeys(
                name for name in (alias, mod.core, mod.file.name) if name))


def test_library_counts_and_configured_sources_reach_roster_and_family(app, services, monkeypatch):
    mods = [FakeMod(f"p{i}", "hoshino") for i in range(3)] + [FakeMod("l1", "hoshino", kind="lobby")]
    monkeypatch.setattr(services.library, "mods", lambda: mods)
    configured = {"spr": "mod:p1", "lobby": "mod:l1"}
    monkeypatch.setattr(services.library, "configured", lambda key: configured)
    for enabled in (True, False):
        services.library.enabled = enabled
        selection = {"spr": {"source": "mod:p1", "installed": enabled, "error": None}}
        monkeypatch.setattr(services.library, "selection", lambda key: selection)
        roster = rpc(app, "roster.list")["result"]["families"][0]
        family = rpc(app, "family.get", key="hoshino")["result"]
        for data in (roster, family):
            v = data["variants"][0]
            assert v["mods"] == 4
            assert v["modCounts"] == {"spr": 3, "lobby": 1}
            assert v["configured"] == configured
        assert "selection" not in roster["variants"][0]
        assert family["variants"][0]["selection"] == selection
    monkeypatch.setattr(services.library, "mods", lambda: [])
    v = rpc(app, "roster.list")["result"]["families"][0]["variants"][0]
    assert v["mods"] == 0 and v["modCounts"] == {"spr": 0, "lobby": 0}


def test_roster_uses_one_snapshot_and_validates_saved_previews_without_library_reads(app, services, monkeypatch):
    variants = [FakeVariant(f"v{i}", "hoshino", spr=f"v{i}_spr", lobby=f"v{i}_home", model=f"ch{i:04}")
                for i in range(100)]
    services.catalog.f.variants = variants
    mods = [FakeMod(f"m{i}", v.key) for i, v in enumerate(variants)]
    mods += [FakeMod("lobby", "v0", kind="lobby"), FakeMod("model", "v0", kind="model")]
    choices = {v.key: {"spr": "mod:m0", "lobby": None, "model": None} for v in variants}
    calls = []

    def snapshot(keys):
        calls.append(keys)
        return {"install": "current", "mods": mods, "favorites": {"v1"}, "configured": choices,
                "modified": {"v2": "mod:m2"}}

    def forbidden(*args, **kwargs):
        pytest.fail("The roster must use its snapshot instead of per-variant library or UI-state reads")

    monkeypatch.setattr(services.library, "roster_snapshot", snapshot)
    for name in ("current_pin", "mods", "configured", "selection", "modified", "favorites"):
        monkeypatch.setattr(services.library, name, forbidden)
    monkeypatch.setattr(services.state, "preview_sources", forbidden)
    services.state.set_preview_source("another-install", "v0", "spr", "official")
    for i, v in enumerate(variants):
        services.state.set_preview_source("current", v.key, "spr", f"mod:m{i}")
    services.state.set_preview_source("current", "v0", "lobby", "mod:lobby")
    services.state.set_preview_source("current", "v0", "model", "mod:model")
    services.state.set_preview_source("current", "v1", "lobby", "mod:lobby")
    services.state.set_preview_source("current", "v1", "model", "mod:m1")
    services.state.set_preview_source("current", "v2", "spr", "variant:v3")
    services.state.set_preview_source("current", "v3", "spr", "mod:deleted")
    services.state.set_preview_source("current", "v4", "spr", "official")
    services.state.set_preview_source("current", "removed-variant", "spr", "official")
    reads = []
    preview_snapshot = services.state.preview_snapshot

    def previews(install):
        reads.append(install)
        return preview_snapshot(install)

    monkeypatch.setattr(services.state, "preview_snapshot", previews)
    result = rpc(app, "roster.list")["result"]["families"][0]["variants"]
    assert calls == [[v.key for v in variants]] and reads == ["current"]
    assert all(v["configured"] == choices[v["key"]] and "selection" not in v for v in result)
    assert result[0]["previewSources"] == {"spr": "mod:m0", "lobby": "mod:lobby", "model": "mod:model"}
    assert result[1]["previewSources"] == {"spr": "mod:m1"} and result[1]["favorite"]
    assert result[2]["previewSources"] == {"spr": "variant:v3"} and result[2]["replaced"] == "mod:m2"
    assert result[3]["previewSources"] == {} and result[4]["previewSources"] == {"spr": "official"}
    assert result[99]["previewSources"] == {"spr": "mod:m99"}


def test_preview_snapshot_filters_malformed_choices_and_does_not_share_state(tmp_path):
    path = tmp_path / "webui.json"
    path.write_text(json.dumps({"asset_previews": {"current": {
        "valid": {"spr": "official", "lobby": "mod:one", "model": "mod:two", "future": "ignored"},
        "bad-sources": {"spr": None, "lobby": False, "model": 1}, "bad-variant": [],
    }, "bad-folder": []}}))
    state = UiState(path)
    snapshot = state.preview_snapshot("current")
    assert snapshot == {"valid": {"spr": "official", "lobby": "mod:one", "model": "mod:two"}, "bad-sources": {}}
    snapshot["valid"]["spr"] = "mod:changed"
    assert state.preview_sources("current", "valid")["spr"] == "official"
    assert state.preview_snapshot("missing") == state.preview_snapshot("bad-folder") == {}
    UiState(path).set_preview_source("current", "valid", "spr", "mod:external")
    assert state.preview_snapshot("current")["valid"]["spr"] == "mod:external"


def mod_marks(app):
    roster = rpc(app, "roster.list")["result"]["families"][0]["variants"][0]
    variant = rpc(app, "family.get", key="hoshino")["result"]["variants"][0]
    assert roster["fresh"] == variant["fresh"]
    return roster["fresh"], {m["id"]: m["fresh"] for m in variant["modList"]}


@pytest.mark.parametrize("first", ["roster.list", "family.get"])
@pytest.mark.parametrize("state", ["missing", "older"])
def test_mod_marks_first_run_baselines_the_whole_library(app, services, monkeypatch, first, state):
    mods = [FakeMod("portrait", "hoshino"), FakeMod("lobby", "hoshino", kind="lobby"),
            *[FakeMod(f"other-{i}", f"student-{i}", user_added=i % 2 == 0) for i in range(80)]]
    monkeypatch.setattr(services._library, "mods", lambda: mods)
    if state == "older":
        services.state.set("voice_volume", 20)  # an older UI state, without seen_mods
    else:
        services.state.path.unlink(missing_ok=True)
    params = {"key": "hoshino"} if first == "family.get" else {}
    assert "result" in rpc(app, first, **params)
    assert mod_marks(app) == (False, {"portrait": False, "lobby": False})
    assert UiState(services.state.path).seen_mods() == {m.id for m in mods}
    if state == "older":
        assert services.state.get("voice_volume") == 20
    assert all(m.fresh for m in mods), "the baseline must not change the shared library's flags"


def test_mod_marks_only_explicit_adds_after_the_baseline(app, services, monkeypatch):
    services.state.mark_mods_seen(["baseline"])
    mods = [FakeMod("baseline", "hoshino"), FakeMod("upload", "hoshino", fresh=False),
            *[FakeMod(origin, "hoshino", user_added=False) for origin in ("legacy", "adopted", "kept", "remapped")]]
    monkeypatch.setattr(services._library, "mods", lambda: mods)
    expected = {m.id: m.id == "upload" for m in mods}
    assert mod_marks(app) == (True, expected)
    assert rpc(app, "mods.seen", id="upload") == {"result": None}
    services.state = UiState(services.state.path)
    assert mod_marks(app) == (False, dict.fromkeys(expected, False))


@pytest.mark.parametrize("reset", ["file", "key"])
def test_mod_marks_reset_baselines_again_then_only_new_additions_get_dots(app, services, monkeypatch, reset):
    services.state.mark_mods_seen([])
    mods = [FakeMod("old", "hoshino")]
    monkeypatch.setattr(services._library, "mods", lambda: mods)
    assert mod_marks(app) == (True, {"old": True})
    if reset == "file":
        services.state.path.unlink()
    else:
        services.state.path.write_text('{"prefs": {"voice_volume": 20}}', encoding="utf-8")
    assert mod_marks(app) == (False, {"old": False})
    assert UiState(services.state.path).seen_mods() == {"old"}
    mods.append(FakeMod("new", "hoshino"))
    assert mod_marks(app) == (True, {"old": False, "new": True})


@pytest.mark.parametrize("seen", [[], ["m1"]])
def test_mod_marks_update_preserves_existing_seen_state_and_pending_dots(app, services, monkeypatch, seen):
    services.state.mark_mods_seen(seen)
    mods = [FakeMod("m1", "hoshino"), FakeMod("pending", "hoshino", kind="lobby")]
    monkeypatch.setattr(services._library, "mods", lambda: mods)
    expected = (True, {"m1": "m1" not in seen, "pending": True})
    assert mod_marks(app) == expected
    before = services.state.path.read_bytes()
    updated = Services(services.settings, services.data_dir, state=UiState(services.state.path), cache=object(),
                       game=FakeGame(), catalog=services.catalog, library=services._library)
    updated._game.resource_version = "rv2"
    try:
        updated_app = WebApp(build_api(updated), updated.events, token="tok")
        assert mod_marks(updated_app) == expected
        assert updated.state.seen_mods() == set(seen)
        assert services.state.path.read_bytes() == before
        mods.append(FakeMod("new", "hoshino"))
        assert mod_marks(updated_app) == (True, {**expected[1], "new": True})
    finally:
        updated.close()


@pytest.mark.parametrize("failure", ["json", "field", "read"])
def test_mod_marks_unreadable_state_shows_no_dots(app, services, monkeypatch, failure):
    library = services.library  # baseline m1 before adding a new mod
    mods = [*library.mods(), FakeMod("new", "hoshino")]
    monkeypatch.setattr(library, "mods", lambda: mods)
    assert mod_marks(app) == (True, {"m1": False, "new": True})
    path = services.state.path
    before = path.read_bytes()
    with monkeypatch.context() as patch:
        if failure == "read":
            real_read = Path.read_text

            def read(self, *args, **kwargs):
                if self == path:
                    raise PermissionError("State cannot be read")
                return real_read(self, *args, **kwargs)

            patch.setattr(Path, "read_text", read)
        else:
            path.write_text("{not json" if failure == "json" else '{"seen_mods": {}}', encoding="utf-8")
        unreadable = path.read_bytes()
        assert mod_marks(app) == (False, {"m1": False, "new": False})
        assert path.read_bytes() == unreadable
    path.write_bytes(before)
    assert mod_marks(app) == (True, {"m1": False, "new": True})


def test_mod_marks_follow_ui_state_per_mod_and_survive_restart(app, services, monkeypatch):
    services.state.mark_mods_seen([])  # an existing baseline, before these two mods were added
    mods = [FakeMod("portrait", "hoshino", fresh=False), FakeMod("lobby", "hoshino", kind="lobby")]
    monkeypatch.setattr(services.library, "mods", lambda: mods)
    assert mod_marks(app) == (True, {"portrait": True, "lobby": True})
    rpc(app, "ui.visit", variant="hoshino")
    assert mod_marks(app) == (True, {"portrait": True, "lobby": True})
    assert rpc(app, "mods.seen", id="portrait") == {"result": None}
    assert mod_marks(app) == (True, {"portrait": False, "lobby": True})
    assert rpc(app, "mods.seen", ids=["lobby", "portrait", "lobby"]) == {"result": None}
    services.state = UiState(services.state.path)
    assert mod_marks(app) == (False, {"portrait": False, "lobby": False})
    assert services.state.seen_mods() == {"portrait", "lobby"}
    assert [m.fresh for m in mods] == [False, True], "the UI never changes the library's flags"
    mods.append(FakeMod("new", "hoshino"))
    assert mod_marks(app) == (True, {"portrait": False, "lobby": False, "new": True})
    mods.pop()
    assert mod_marks(app)[0] is False


@pytest.mark.parametrize("params", [{}, {"id": ""}, {"id": 1}, {"ids": "mod"}, {"ids": [1]},
                                        {"ids": [""]}, {"id": "mod", "ids": ["mod"]}])
def test_mods_seen_rejects_invalid_ids(app, services, params):
    assert rpc(app, "mods.seen", **params)["error"]["code"] == "bad_params"
    assert services.state.seen_mods() is None


def test_roster_and_family_carry_the_aliases_the_search_matches(app, services):
    services.catalog.f.aliases = ["\u5c0f\u661f"]
    services.catalog.v.aliases = ["\u5c0f\u661f\uff08x\uff09"]
    for result in (rpc(app, "roster.list")["result"]["families"][0], rpc(app, "family.get", key="hoshino")["result"]):
        assert result["aliases"] == ["\u5c0f\u661f"]
        assert result["variants"][0]["aliases"] == ["\u5c0f\u661f\uff08x\uff09"]


def test_own_aliases_are_kept_and_listed(app, services, tmp_path):
    assert rpc(app, "roster.list")["result"]["families"][0]["variants"][0]["custom"] == []
    kept = rpc(app, "aliases.set", family="hoshino", aliases=[" Oji  san ", "oji san", "", "<i>x</i>"])["result"]
    assert kept == ["Oji san", "<i>x</i>"]
    assert rpc(app, "roster.list")["result"]["families"][0]["variants"][0]["custom"] == kept
    assert rpc(app, "family.get", key="hoshino")["result"]["variants"][0]["custom"] == kept
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
    assert rpc(app, "family.get", key="hoshino")["result"]["variants"][0]["custom"] == kept
    # none: the student's entry goes
    assert rpc(app, "aliases.set", family="hoshino", aliases=[])["result"] == []
    assert UiState(tmp_path / "webui.json").aliases() == {}


def test_legacy_family_aliases_migrate_to_original_only_and_skins_save_independently(app, services, tmp_path):
    path = tmp_path / "webui.json"
    legacy = {"aliases": {"hoshino": ["Original nickname"]}, "prefs": {"voice_volume": 40}, "seen_mods": []}
    path.write_text(json.dumps(legacy), encoding="utf-8")
    before = path.read_bytes()
    skin = replace(services.catalog.v, key="hoshino_swimsuit", file_id="hoshino_swimsuit")
    services.catalog.f.variants.append(skin)

    def names(method):
        result = rpc(app, method, **({"key": "hoshino"} if method == "family.get" else {}))["result"]
        family = result["families"][0] if method == "roster.list" else result
        assert "custom" not in family
        return {v["key"]: v["custom"] for v in family["variants"]}

    for method in ("roster.list", "family.get"):
        assert names(method) == {"hoshino": ["Original nickname"], skin.key: []}
    assert path.read_bytes() == before  # Reinterpreting the stable base key needs no disk rewrite.
    assert rpc(app, "aliases.set", variant=skin.key, aliases=["Skin nickname"])["result"] == ["Skin nickname"]
    for method in ("roster.list", "family.get"):
        assert names(method) == {"hoshino": ["Original nickname"], skin.key: ["Skin nickname"]}
    assert rpc(app, "aliases.set", variant="hoshino", aliases=[])["result"] == []
    assert UiState(path).aliases() == {skin.key: ["Skin nickname"]}
    services.catalog.f.variants = [skin]  # A missing original must not transfer its alias to an installed skin.
    path.write_text(json.dumps(legacy), encoding="utf-8")
    assert names("roster.list") == {skin.key: []}
    assert rpc(app, "aliases.set", variant="missing", aliases=["x"])["error"]["code"] == "catalog_variant_not_found"
    assert json.loads(path.read_text())["prefs"] == legacy["prefs"]


@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("family_key", ["special", "arona"])
def test_special_only_family_alias_migrates_once_to_one_scene(app, services, tmp_path, monkeypatch, explicit, family_key):
    path = tmp_path / "webui.json"
    scene = replace(services.catalog.v, key="special:alpha", family=family_key, spr=None, lobby="alpha", order=0)
    sibling = replace(scene, key="special:beta", lobby="beta", order=1)
    services.catalog.f = FakeFamily(family_key, {"en": "Special"}, None, [sibling, scene])
    monkeypatch.setattr(services.catalog, "family", lambda key: services.catalog.f)
    aliases = {family_key: ["Legacy scene name"]}
    if explicit:
        aliases[scene.key] = ["Explicit scene name"]
    legacy = {"aliases": aliases, "prefs": {"voice_volume": 40}, "seen_mods": []}
    path.write_text(json.dumps(legacy), encoding="utf-8")

    def names(method):
        result = rpc(app, method, **({"key": family_key} if method == "family.get" else {}))["result"]
        family = result["families"][0] if method == "roster.list" else result
        return {v["key"]: v["custom"] for v in family["variants"]}

    kept = aliases.get(scene.key, aliases[family_key])
    for method in ("roster.list", "family.get"):
        assert names(method) == {scene.key: kept, sibling.key: []}
    assert UiState(path).aliases() == {scene.key: kept}
    assert json.loads(path.read_text())["prefs"] == legacy["prefs"]
    # A new earlier scene or a different install's ordering cannot move a migrated name.
    earlier = replace(scene, key="special:aardvark", order=-1)
    services.catalog.f.variants.insert(0, earlier)
    assert names("roster.list") == {earlier.key: [], scene.key: kept, sibling.key: []}
    assert rpc(app, "aliases.set", variant=scene.key, aliases=[])["result"] == []
    assert names("family.get") == {earlier.key: [], scene.key: [], sibling.key: []}
    # Older callers using the family argument also write a usable variant key.
    assert rpc(app, "aliases.set", family=family_key, aliases=["New name"])["result"] == ["New name"]
    assert UiState(path).aliases() == {earlier.key: ["New name"]}


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


def test_preview_failures_are_logged_in_release_sessions(app, services, caplog):
    services.debug = False
    result = rpc(app, "preview.failed", url="/asset/spine/lobby/shun_home/revision/home.skel",
                 step="draw", error="Unsupported lobby Spine version: 3.8.75\n" + "x" * 9000)
    assert result == {"result": None}
    assert "shun_home/revision/home.skel" in caplog.text
    assert '"step": "draw"' in caplog.text
    assert "Unsupported lobby Spine version: 3.8.75\\n" in caplog.text
    assert len(caplog.records[-1].message) < 8500


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
def test_spine_revision_routes_reject_switched_files(app, services, monkeypatch, tmp_path, kind, caplog):
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
    assert "Spine revision changed" in caplog.text and before in caplog.text and after in caplog.text
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
    assert call(app, f"/asset/spine/{kind}/{name}/skeleton.skel")[0] == "200 OK"
    assert seen[-1] == [official, mod], "legacy routes use the same composition as the manifest"


def test_live_portrait_survives_cache_clear(app, services, monkeypatch, tmp_path):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets

    game_dir = tmp_path / "game"
    game_dir.mkdir()
    official = _bundle(game_dir, "assets-_mx-spinecharacters-ibuki_spr-_mxdependency-2026-01-01_001_assets_all")
    mod = _bundle(game_dir, "assets-_mx-spinecharacters-ibuki_spr-_mxdependency-2026-01-01_000_assets_all", b"magenta")
    cache = AssetCache(root=tmp_path / "cache", allowed=True)
    services._cache = cache
    services._game = GameAssets([game_dir], cache)
    services.library.live["ibuki_spr"] = [official, mod]
    reads = []
    def extract(paths):
        reads.append(list(paths))
        return {"Ibuki_spr.skel": b"skeleton", "Ibuki_spr.atlas": b"page.png\nsize: 1,1\n",
                "page.png": paths[-1].read_bytes()}
    monkeypatch.setattr("ba_modding_toolkit.gameassets.service.extract_spine", extract)
    def no_preview(*args, **kwargs):
        pytest.fail("A current portrait must not need a mod preview or kept originals")
    monkeypatch.setattr(services.library, "preview_bundles", no_preview, raising=False)
    monkeypatch.setattr(services.library, "official_bundles", no_preview, raising=False)
    prefix = "/asset/spine/spr/ibuki_spr"
    revision = json.loads(call(app, prefix + "/manifest.json")[2])["revision"]
    for clear in (False, True):
        if clear:
            cleared = rpc(app, "settings.clearCache")["result"]
            assert cleared["previewCache"] is True
        assert json.loads(call(app, prefix + "/manifest.json")[2])["revision"] == revision
        for name, expected in (("skeleton.skel", b"skeleton"), ("skeleton.atlas", b"page.png\nsize: 1,1\n"),
                               ("page.png", mod.read_bytes())):
            status, headers, body = call(app, f"{prefix}/{revision}/{name}")
            assert (status, body) == ("200 OK", expected)
            assert headers["Cache-Control"] == "no-store"
    assert reads == [[official, mod], [official, mod]], "cold extraction keeps the manifest's merge order"


@pytest.mark.parametrize("failure, status", [
    (ServiceError("dev_path_outside", path="refused bundle"), "404 Not Found"),
    (OSError("unreadable live bundle"), "500 Internal Server Error"),
])
def test_asset_failures_log_the_request_and_cause(app, services, monkeypatch, caplog, failure, status):
    def refused(core, pin=None):
        raise failure
    monkeypatch.setattr(services.library, "live_bundles", refused)
    assert call(app, "/asset/spine/spr/ibuki_spr/manifest.json")[0] == status
    assert str(failure) in caplog.text and "ibuki_spr/manifest.json" in caplog.text
    if isinstance(failure, ServiceError):
        assert failure.params["path"] in caplog.text


def test_atlas_route_revalidates_and_reports_failure(app, services, monkeypatch, tmp_path, caplog):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets

    services.state.set_consent(True)
    assert call(app, "/asset/ui/atlases.json")[1]["Cache-Control"] == "no-store"
    services._game = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache", allowed=True))
    assert call(app, "/asset/ui/atlases.json")[0] == "404 Not Found"
    assert "No UI atlas bundles" in caplog.text
    assert not (tmp_path / "cache").exists()


def test_missing_official_spine_returns_404(app, services, monkeypatch):
    def missing(core, pin=None):
        raise ServiceError("original_unavailable", file=core)

    monkeypatch.setattr(services.library, "official_bundles", missing, raising=False)
    for name in ("manifest.json", "skeleton.skel", "skeleton.atlas", "portrait.png"):
        assert call(app, f"/asset/spine/official-spr/hoshino_spr/{name}")[0] == "404 Not Found"


@pytest.mark.parametrize("kind,core", [("spr", "hoshino_spr"), ("lobby", "hoshino_home")])
def test_current_mod_and_ui_routes_do_not_wait_for_library_preview(app, services, monkeypatch, kind, core):
    entered, release = threading.Event(), threading.Event()

    def preview(mod_id):
        entered.set()
        assert release.wait(5), "Test did not release the preview"
        raise ServiceError("original_unavailable", file="missing original")

    monkeypatch.setattr(services.library, "preview_bundles", preview, raising=False)
    monkeypatch.setattr(services.library, "state", lambda key: {
        "files": [{"kind": kind, "applied": "mod:m1", "official": False, "restorable": False}]})
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(call, app, "/asset/spine/mod/m1/skeleton.skel")
        try:
            assert entered.wait(1)
            for path in (f"/asset/spine/{kind}/{core}/skeleton.skel", "/asset/ui/atlases.json",
                         "/asset/ui/sprite/Common/Common_Icon_Back.png"):
                assert pool.submit(call, app, path).result(timeout=1)[0] == "200 OK"
            data = pool.submit(rpc, app, "family.get", key="hoshino").result(timeout=1)
            assert data["result"]["variants"][0]["state"]["files"][0]["applied"] == "mod:m1"
        finally:
            release.set()
        assert pending.result(timeout=1)[0] == "404 Not Found"


def test_a_new_library_prunes_its_kept_originals_once(tmp_path, monkeypatch):
    pruned = []

    class Library:
        def __init__(self, *args, **kwargs):
            pass

        def mods(self):
            return []

        def prune(self):
            pruned.append(self)
            return [tmp_path / "originals" / "a.bundle"]

        def judge_unfinished(self):
            return 0

    monkeypatch.setattr("ba_modding_toolkit.library.ModLibrary", Library)
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                 cache=object(), game=FakeGame(), catalog=FakeCatalog())
    s.state.set("scan_consent", True)
    try:
        library = s.library
        assert s.library is library
        deadline = time.monotonic() + 5
        while (not pruned or s.jobs.busy()) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert pruned == [library]
    finally:
        s.close()


@pytest.mark.parametrize("enabled", [True, False])
def test_startup_maintenance_waits_for_reveal_and_respects_the_preference(services, monkeypatch, enabled):
    calls, finished = [], threading.Event()
    services.state.set("scan_consent", enabled)
    monkeypatch.setattr(services, "start_watch", lambda: None)
    monkeypatch.setattr(services.scanner, "request", lambda *args: calls.append("scan"))
    monkeypatch.setattr(services.library, "prune", lambda: calls.append("prune") or [])
    warm = services._warm

    def warmed():
        try:
            warm()
        finally:
            finished.set()

    monkeypatch.setattr(services, "_warm", warmed)
    services.start()
    assert services.library is not None
    assert calls == [] and services._prune_job is None
    services.ready()
    assert finished.wait(5)
    if enabled:
        assert services.jobs.wait(services._prune_job, 5)
        assert services.jobs.get(services._prune_job).state == "done"
        assert sorted(calls) == ["prune", "scan"]
        assert services.timings.snapshot()["library.prune"]["count"] == 1
    else:
        assert calls == [] and services._prune_job is None
        assert services.request_scan(dismissed=True) is None
    services.ready()
    assert sorted(calls) == (["prune", "scan"] if enabled else [])


def test_startup_preferences_round_trip_and_update_info(app, services):
    prefs = rpc(app, "settings.get")["result"]
    assert "startupChecks" not in prefs and prefs["startupUpdate"] is True
    assert rpc(app, "settings.set", key="startupUpdate", value=False)["result"]["startupUpdate"] is False
    assert rpc(app, "settings.set", key="startupChecks", value=False)["error"]["code"] == "bad_params"
    saved = UiState(services.data_dir / "webui.json")
    assert saved.flag("startup_update") is False
    assert rpc(app, "app.info")["result"]["startupUpdate"] is False
    assert "startupChecks" not in rpc(app, "app.info")["result"]


def test_app_info_reports_only_consented_current_ui_cache(app, services, tmp_path):
    from ba_modding_toolkit.gameassets import AssetCache

    cache = services._cache = AssetCache(root=tmp_path / "cache", allowed=True)
    cache.put("ui", b"cached", version="old")
    services.state.set_consent(True)
    assert rpc(app, "app.info")["result"]["uiCached"] is False
    cache.put("ui", b"cached", version=services.game.resource_version)
    assert rpc(app, "app.info")["result"]["uiCached"] is True
    services.set_consent(False)
    assert rpc(app, "app.info")["result"]["uiCached"] is False


def test_initial_html_selects_the_cached_loading_style_before_any_rpc(app, services, tmp_path):
    from ba_modding_toolkit.gameassets import AssetCache

    app.ui_cached = services.ui_cached
    services._cache = cache = AssetCache(root=tmp_path / "cache", allowed=True)
    cache.put("ui", b"cached", version=services.game.resource_version)
    body = call(app, "/index.html")[2]
    assert b'class="loading full on neutral"' in body
    assert b'class="loading-fallback"' not in body
    services.state.set_consent(True)
    body = call(app, "/index.html")[2]
    assert b'class="loading full on"' in body
    assert b'class="loading-fallback"' not in body
    assert b'class="loading-plain"' not in body
    cache.clear()
    assert b'class="loading full on neutral"' in call(app, "/index.html")[2]


def test_startup_timings_are_bounded_named_and_recorded_in_seconds(app, services, monkeypatch):
    ready = []
    monkeypatch.setattr(services, "ready", lambda: ready.append(True))
    assert rpc(app, "app.ready", timings={"boot": 1250, "fonts": 20, "fallback-loading": 50,
                                         "sprite-loading": 1200, "private/path": 1, "settings": True,
                                         "info": -1, "strings": float("nan"), "mod-state": float("inf")}) == {"result": None}
    assert ready == [True]
    assert rpc(app, "app.timings")["result"] == services.timings.snapshot()
    measured = {key: value for key, value in services.timings.snapshot().items() if key.startswith("page.")}
    assert measured == {"page." + key: {"seconds": seconds, "count": 1} for key, seconds in
                        {"boot": 1.25, "fonts": .02, "fallback-loading": .05, "sprite-loading": 1.2}.items()}
    assert rpc(app, "app.ready", timings=[])["error"]["code"] == "bad_params"


def test_lobby_warm_builds_the_prefab_index_once_per_game(app, services, monkeypatch):
    calls, cabs, release = [], [], threading.Event()

    def prefabs(game):
        calls.append(game)
        release.wait(5)
        return {}

    monkeypatch.setattr(FakeGame, "_lobby_prefabs", prefabs, raising=False)
    # Dependencies must remain demand-driven instead of scanning every CAB at startup.
    monkeypatch.setattr(FakeGame, "_cab_index", lambda game, everything=False: cabs.append((game, everything)) or {},
                        raising=False)
    first = services.game
    # answered at once while the index is built in the background; a second call does not start another build
    assert "error" not in rpc(app, "lobby.warm") and "error" not in rpc(app, "lobby.warm")
    release.set()
    for thread in [t for t in threading.enumerate() if t.name == "lobby-warm"]:
        thread.join(5)
    assert calls == [first] and cabs == []
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
    for lang in ("zh-TW", "ja-JP", "ko-KR", "th-TH"):
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


@pytest.mark.parametrize("kind", [["student"], ["npc"], ["student", "npc"]])
@pytest.mark.parametrize("recruit", ["all", "yes", "no"])
def test_saved_roster_type_filter_is_dropped_on_load_and_save(app, services, tmp_path, kind, recruit):
    kept = {"merged": True, "mods": "none", "recruit": recruit, "sort": "name", "order": "desc",
            "filters": {"favorite": ["no"], "portrait": ["replaced"]}}
    legacy = {**kept, "filters": {**kept["filters"], "kind": kind}}
    services.state.set("roster", legacy)
    services.state.set("voice_volume", 35)
    services.state = UiState(tmp_path / "webui.json")
    assert rpc(app, "settings.get")["result"]["roster"] == kept
    assert rpc(app, "settings.set", key="roster", value=legacy)["result"]["roster"] == kept
    reloaded = UiState(tmp_path / "webui.json")
    assert reloaded.get("roster") == kept
    assert reloaded.get("voice_volume") == 35


def test_settings_offer_the_languages_with_a_locale_file(app, services, tmp_path, monkeypatch):
    from ba_modding_toolkit.i18n import i18n_manager
    from ba_modding_toolkit.webui import api as webui_api

    locales = tmp_path / "locales"
    locales.mkdir()
    for code, name in (("zh-CN", "简体中文"), ("en-US", "English"), ("ko-KR", "한국어"), ("th-TH", "ไทย")):
        (locales / f"{code}.json").write_text(json.dumps({"webui": {"languageName": name}}), encoding="utf-8")
    monkeypatch.setattr(webui_api, "get_locale_dir", lambda: locales)
    monkeypatch.setattr(webui_api, "offered_languages", lambda: offered_languages(locales))
    monkeypatch.setattr(i18n_manager, "lang", i18n_manager.lang)  # restored after the test
    languages = rpc(app, "settings.get")["result"]["languages"]
    assert languages == [{"code": "zh-CN", "name": "简体中文"}, {"code": "en-US", "name": "English"},
                         {"code": "ko-KR", "name": "한국어"}, {"code": "th-TH", "name": "ไทย"}]
    # a known language without its locale file yet (zh-TW, ja-JP) cannot be chosen
    assert rpc(app, "settings.set", key="language", value="zh-TW")["error"]["code"] == "bad_params"
    monkeypatch.setattr(i18n_manager, "set_language", lambda lang: None)
    assert "error" not in rpc(app, "settings.set", key="language", value="ko-KR")
    assert services.settings.get("language") == "ko-KR"
    assert "error" not in rpc(app, "settings.set", key="language", value="th-TH")
    assert services.settings.get("language") == "th-TH"


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


@pytest.mark.parametrize("language", ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"])
def test_update_download_progress_names_the_action_and_asset(app, services, update_env, monkeypatch, language):
    translate = I18n(language).t
    monkeypatch.setattr("ba_modding_toolkit.webui.api.t", translate)
    rpc(app, "app.checkUpdate")
    job = rpc(app, "app.update")["result"]
    assert services.jobs.wait(job, 5)
    result = services.jobs.get(job)
    assert result.state == "done", result.error
    assert result.progress == {"id": job, "current": 8, "total": 8, "sequence": 1,
                               "label": translate("webui.progress.download", name="1.1.0.dmg")}


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
    import os
    import re
    root = Path(__file__).resolve().parents[1] / "src" / "ba_modding_toolkit"
    codes = set()
    for folder, directories, names in os.walk(root):
        directories[:] = [name for name in directories if not name.startswith(".")]
        for name in names:
            if name.endswith(".py"):
                codes |= set(re.findall(r'ServiceError\("([a-z_]+)"', (Path(folder) / name).read_text(encoding="utf-8")))
    for lang in offered_languages():
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

    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(settings={}, create_window=create_window,
                                                                start=lambda **options: started.update(options)))
    from ba_modding_toolkit.webui.tray import Tray

    monkeypatch.setattr(Tray, "supported", staticmethod(lambda platform=sys.platform: False))  # tests/test_tray.py
    main._run_window(SimpleNamespace(window=None, data_dir=tmp_path, timings=Timings()), SimpleNamespace(url="http://127.0.0.1:1/"), False)
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

    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(settings={}, create_window=create_window, start=lambda **o: None))
    main._run_window(services, SimpleNamespace(url="http://127.0.0.1:1/"), False)
    gate = threading.Event()
    services.jobs.submit("extract", lambda log, progress: gate.wait(5))  # read-only: the window may close
    assert handlers["closing"]() is True
    services.jobs.submit("library.adopt", lambda log, progress: gate.wait(5), writes="library")
    assert handlers["closing"]() is False
    gate.set()


@pytest.mark.parametrize("unread", [False, True])
def test_original_and_repaired_versions_share_roster_and_band_counts(app, services, monkeypatch, unread):
    originals = [FakeMod("portrait", "hoshino"), FakeMod("lobby", "hoshino", kind="lobby")]
    repaired = [FakeMod("portrait-fixed", "hoshino", user_added=False),
                FakeMod("lobby-fixed", "hoshino", kind="lobby", user_added=False)]
    services.state.mark_mods_seen([] if unread else [mod.id for mod in originals])
    for original, fixed in zip(originals, repaired):
        original.repaired_id = fixed.id
        fixed.repaired_from = original.id
    for mods in (originals + repaired, repaired, originals):
        monkeypatch.setattr(services.library, "mods", lambda: mods)
        for method, params in (("roster.list", {}), ("family.get", {"key": "hoshino"})):
            result = rpc(app, method, **params)["result"]
            family = result["families"][0] if method == "roster.list" else result
            variant = family["variants"][0]
            assert variant["mods"] == 2
            assert variant["modCounts"] == {"spr": 1, "lobby": 1}
            assert variant["fresh"] is (unread and any(mod.user_added for mod in mods))
            if method == "family.get":
                assert {mod["id"]: mod["fresh"] for mod in variant["modList"]} == {
                    mod.id: unread and mod.user_added for mod in mods}


@pytest.mark.parametrize("orphan", [False, True])
def test_migrated_020_library_supplies_repair_labels_markers_and_counts(app, services, monkeypatch, tmp_path, orphan):
    from ba_modding_toolkit.library import ModLibrary
    from test_legacy_remap import legacy_record, write_legacy_state
    from test_library import FakeCatalog as LibraryCatalog, FakeVariant as LibraryVariant

    root = tmp_path / "legacy-library"
    original = legacy_record(root, 1, "hoshino_spr", core="hoshino_spr", target="hoshino")
    repaired = legacy_record(root, 2, "hoshino_spr (remapped)", core="hoshino_spr", target="hoshino",
                             date="2026-10-01", parts=("002", "003"))
    original["alias"] = "My painting"
    write_legacy_state(root, [repaired] if orphan else [original, repaired])
    library = ModLibrary(root, LibraryCatalog(LibraryVariant("hoshino", "hoshino_spr")))
    monkeypatch.setattr(services.library, "mods", library.mods)
    for method, params in (("roster.list", {}), ("family.get", {"key": "hoshino"})):
        result = rpc(app, method, **params)["result"]
        family = result["families"][0] if method == "roster.list" else result
        variant = family["variants"][0]
        assert variant["mods"] == 1 and variant["modCounts"] == {"spr": 1, "lobby": 0}
        if method == "family.get":
            mods = {mod["id"]: mod for mod in variant["modList"]}
            fixed = mods[repaired["id"]]
            assert fixed["label"] == I18n().t("webui.remap.name", name="hoshino_spr" if orphan else "My painting")
            assert fixed["repaired_from"]
            if not orphan:
                assert fixed["repaired_from"] == original["id"]
                assert mods[original["id"]]["repaired_id"] == repaired["id"]


def test_release_page_snapshot_survives_another_check(app, services, update_env, monkeypatch):
    from ba_modding_toolkit import updater
    opened = []
    monkeypatch.setattr('ba_modding_toolkit.webui.api.webbrowser.open', opened.append)
    page = f'https://github.com/{updater.REPO}/releases/tag/v1.1.0'
    update_env.info.page, update_env.info.notes = page, 'Exact release notes'
    assert rpc(app, 'app.checkUpdate')['result']['notes'] == 'Exact release notes'
    update_env.info = None
    rpc(app, 'app.checkUpdate')
    assert rpc(app, 'app.openReleasePage', page=page) == {'result': None}
    assert opened == [page]
    for invalid in ('https://example.invalid/releases/tag/1.1.0', page + '/bad', page + '?next=bad', 42):
        assert rpc(app, 'app.openReleasePage', page=invalid)['error']['code'] == 'update_unavailable'
    assert update_env.downloads == update_env.installs == []
