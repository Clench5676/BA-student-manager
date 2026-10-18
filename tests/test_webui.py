"""Tests for the web UI server, RPC layer, jobs and events, driven through the WSGI app without a window."""

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
from ba_modding_toolkit.webui.state import UiState


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


@dataclass
class FakeFamily:
    key: str
    names: dict
    school: str | None
    variants: list


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
    assert en["webui.tab.model"] == "Sprite"
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
