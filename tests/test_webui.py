"""Tests for the web UI server, RPC layer, jobs and events, driven through the WSGI app without a window."""

import binascii
import io
import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
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

    def to_json(self):
        return {"id": self.id, "target": self.target, "fresh": self.fresh}


class FakeLibrary:
    def __init__(self):
        self.favs = set()
        self.applied = []

    def mods(self):
        return [FakeMod("m1", "hoshino")]

    def modified(self):
        return {"hoshino": "variant:hoshino_swimsuit"}

    def favorites(self):
        return set(self.favs)

    def set_favorite(self, key, on):
        (self.favs.add if on else self.favs.discard)(key)

    def state(self, key):
        return {"applied": "official", "crc": "ok"}

    def apply(self, variant_key, source, log, progress):
        log("applying")
        progress(1, 1, variant_key)
        self.applied.append((variant_key, source))
        return {"applied": source}


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
    # newest first, each with the date and CRC state the info panel shows (the library's rules)
    assert [(Path(f["file"]), f["date"], f["crc"], f["kind"]) for f in files] == [
        (broken, "2025-08-01", "needs_fix", "model"), (new, "2025-07-25", "fixed", "model"), (old, "2024-11-18", "ok", "model")]
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
    assert ui_strings("zh-TW")["webui.tab.lobby"] == "记忆大厅"  # falls back to zh-CN until zh-TW exists


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


def test_install_update_needs_the_window_and_the_verified_download(app, services, tmp_path):
    assert rpc(app, "app.installUpdate", file=str(tmp_path / "x.dmg"))["error"]["code"] == "update_unsupported"


def test_settings_change_waits_for_the_running_job(services):
    gate = threading.Event()
    library = services.library
    job = services.jobs.submit("slow", lambda log, progress: gate.wait(5))
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


def test_open_classic_always_asks_for_the_classic_gui(monkeypatch):
    from ba_modding_toolkit.webui import system
    calls = []
    monkeypatch.setattr(system, "program_command", lambda: ["tool"])
    monkeypatch.setattr(system.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    system.open_classic()
    system.open_classic("settings")
    assert calls == [["tool", "--classic"], ["tool", "--classic", "--settings"]]


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
        return SimpleNamespace(events=SimpleNamespace(initialized=Hook(), loaded=Hook(), closing=Hook()))

    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(create_window=create_window,
                                                                start=lambda **options: started.update(options)))
    main._run_window(SimpleNamespace(window=None, data_dir=tmp_path), SimpleNamespace(url="http://127.0.0.1:1/"), False)
    assert created["text_select"] is True
    assert started["private_mode"] is True

    css = (Path(main.__file__).parent.parent / "web" / "css" / "app.css").read_text(encoding="utf-8")
    body = " ".join(re.findall(r"^body\s*\{([^}]*)\}", css, re.M))
    for declaration in ("cursor: var(--cursor)", "-webkit-user-select: none", " user-select: none"):
        assert declaration in body
