"""Reports stay local, bounded and useful even when the main UI cannot start."""

import json
import logging
import re
import sys
import threading
import zipfile
from types import SimpleNamespace
from pathlib import Path

import pytest

from ba_modding_toolkit.webui import diagnostics, main, native
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.diagnostics import Reports
from ba_modding_toolkit.webui.session_log import open_run_log
from ba_modding_toolkit.webui.timing import Timings


@pytest.fixture
def reports(tmp_path, monkeypatch):
    root = tmp_path / "data"
    root.mkdir()
    s = SimpleNamespace(state=SimpleNamespace(consent=True, spine_consent=False), timings=Timings(),
                        library_dir=lambda: root / "library")
    r = Reports(root, services=s)
    s.reports = r
    monkeypatch.setattr(diagnostics.updater, "current_version", lambda: "0.3.0")
    monkeypatch.setattr(native, "engine_info", lambda: {"engine": "WebKit", "version": "620.1"})
    monkeypatch.setattr(diagnostics.getpass, "getuser", lambda: "PrivateUser")
    monkeypatch.setattr(native, "report_folders", lambda: [tmp_path / "Desktop", tmp_path / "Downloads"])
    monkeypatch.setattr(native, "copy_text", lambda text: None)
    monkeypatch.setattr(diagnostics.system, "reveal", lambda path: None)
    return r


def contents(result):
    with zipfile.ZipFile(result["path"]) as archive:
        return {name: archive.read(name).decode() for name in archive.namelist()}


def test_report_content_redaction_clipboard_and_selection(reports, monkeypatch):
    r = reports
    desktop, _ = native.report_folders()
    desktop.mkdir()
    r.secrets.add("actual-session-secret")
    r.game = {"found": True, "server": "global", "platform": "Windows", "resourceVersion": "1234"}
    r.services.timings.record("page.info", .25)
    library = r.services.library_dir()
    library.mkdir()
    (library / "state.json").write_text(json.dumps({"mods": [
        {"kind": "spr", "label": "Private Mod", "files": ["private.bundle"]}, {"kind": "spr"}, {"kind": "lobby"}]}))
    r.frontend_event({"message": "failure in private.skel", "stack": "private.bundle", "page": "#/roster", "phase": "fonts"},
                     {"page": "#/roster", "phase": "fonts", "webgl": {"supported": True, "renderer": "GPU 123"},
                      "screen": {"width": 1920, "height": 1080, "scale": 2}, "userAgent": "WebKit/620"})
    r.job_finished(SimpleNamespace(state="failed", kind="apply", error={"code": "spine_version", "params": {
        "file": str(Path.home() / "private.bundle"), "token": "actual-session-secret"}}))
    for name in diagnostics.LOG_NAMES:
        (r.data_dir / name).write_text(f"PrivateUser {Path.home()}/settings token=hidden-secret actual-session-secret\n"
                                     "C:\\Users\\OtherPerson\\mods\\test.bundle /Users/Someone/mods/private.skel\n"
                                     "Timing page.info: 0.250 s\n")
    copied, selected = [], []
    monkeypatch.setattr(native, "copy_text", copied.append)
    monkeypatch.setattr(diagnostics.system, "reveal", selected.append)
    result = build_api(r.services).call("app.report", {"context": r.frontend})["result"]
    path = Path(result["path"])
    assert path.parent == desktop
    assert re.fullmatch(r"BAMT-report-0\.3\.0-\d{8}-\d{4}\.zip", path.name)
    assert result["copied"] and result["revealed"]
    assert copied == [result["summary"]] and selected == [path]
    files = contents(result)
    assert set(files) == {"report.txt", "report.json", *diagnostics.LOG_NAMES}
    assert files["report.txt"].startswith(result["summary"])
    data = json.loads(files["report.json"])
    assert data["game"] == r.game
    assert data["consent"] == {"uiAssets": True, "spine": False}
    assert data["libraryCounts"] == {"spr": 2, "lobby": 1, "model": 0, "other": 0}
    assert data["lastFailedJob"]["code"] == "spine_version"
    assert data["timings"]["page.info"]["seconds"] == .25
    assert data["frontend"]["webgl"]["renderer"] == "GPU 123"
    joined = "\n".join(files.values())
    for secret in ("PrivateUser", "OtherPerson", "Someone", "Private Mod", "private.bundle", "private.skel",
                   "actual-session-secret", "hidden-secret", str(Path.home())):
        assert secret not in joined
    assert "~" in joined and "[asset].bundle" in joined and "Redacted" in joined


def test_report_caps_logs_keeps_ends_and_never_overwrites(reports):
    for name in diagnostics.LOG_NAMES:
        (reports.data_dir / name).write_bytes(b"start\npassword=" + b"x" * (diagnostics.LOG_CAP * 2) + b"\nlast event\n")
    first = reports.generate()
    second = reports.generate()
    assert first["path"] != second["path"]
    assert Path(first["path"]).stat().st_size < 2_000_000
    files = contents(first)
    for name in diagnostics.LOG_NAMES:
        assert files[name].endswith("last event\n")
        assert "truncated" in files[name] and "password" not in files[name] and "xxx" not in files[name]
    with zipfile.ZipFile(first["path"]) as archive:
        assert sum(item.file_size for item in archive.infolist()) < 2_000_000


def test_report_folder_fallback_and_clipboard_failure(reports, monkeypatch):
    desktop, downloads = native.report_folders()
    desktop.mkdir()
    downloads.mkdir()
    original = Path.open

    def open_path(path, *args, **kwargs):
        if path.parent == desktop:
            raise PermissionError("Desktop unavailable")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_path)
    monkeypatch.setattr(native, "copy_text", lambda text: (_ for _ in ()).throw(OSError("clipboard busy")))
    result = reports.generate()
    assert Path(result["path"]).parent == downloads and not result["copied"]
    monkeypatch.setattr(native, "report_folders", lambda: [desktop, reports.data_dir / "missing"])
    assert Path(reports.generate()["path"]).parent == reports.data_dir


def test_backend_hooks_save_in_data_dir_and_next_report_includes_error(reports, monkeypatch):
    monkeypatch.setattr(sys, "excepthook", lambda *args: None)
    monkeypatch.setattr(threading, "excepthook", lambda args: None)
    called = []
    monkeypatch.setattr(native, "copy_text", lambda text: called.append("clipboard"))
    monkeypatch.setattr(diagnostics.system, "reveal", lambda path: called.append("reveal"))
    restore = diagnostics.install_exception_hooks(reports)
    try:
        try:
            raise RuntimeError("token=super-secret private.bundle")
        except RuntimeError as error:
            sys.excepthook(type(error), error, error.__traceback__)
            threading.excepthook(SimpleNamespace(exc_type=type(error), exc_value=error, exc_traceback=error.__traceback__))
        assert len(list(reports.data_dir.glob("BAMT-report-*.zip"))) == 1
        assert called == []
        data = json.loads(contents(reports.generate())["report.json"])
        assert "RuntimeError" in data["previousBackendError"]["error"]
        assert data["previousBackendError"]["app"]["version"] == "0.3.0"
        assert "previousBackendError" not in data["previousBackendError"]
        assert "super-secret" not in json.dumps(data)
    finally:
        restore()


def test_frontend_rpc_bounds_deduplicates_throttles_and_logs(reports, monkeypatch, caplog):
    now = [0]
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: now[0])
    rpc = build_api(reports.services)
    event = {"message": "bad", "stack": "trace", "phase": "ui-indexes", "page": "#/roster"}
    with caplog.at_level(logging.ERROR):
        assert rpc.call("app.frontendError", {"event": event})["result"] is True
        assert rpc.call("app.frontendError", {"event": event})["result"] is False
        for i in range(25):
            rpc.call("app.frontendError", {"event": {**event, "message": str(i)}})
    assert len(reports.errors) == 10
    assert "ui-indexes" in caplog.text and "trace" in caplog.text
    now[0] = 61
    assert rpc.call("app.frontendError", {"event": event})["result"] is True
    assert not reports.frontend_event("invalid", ["invalid"])


def test_log_rotation_and_environment_header(reports):
    path = reports.data_dir / "webui.log"
    for text in ("first", "second", "third", "fourth"):
        handler = open_run_log(path, {"secret-value"}, safe_mode=True)
        handler.stream.write(text)
        handler.close()
    assert path.read_text().endswith("fourth")
    assert path.with_name("webui.1.log").read_text().endswith("third")
    assert path.with_name("webui.2.log").read_text().endswith("second")
    assert not path.with_name("webui.3.log").exists()
    header = json.loads(path.read_text().splitlines()[0].removeprefix("Environment "))
    assert header["safeMode"] is True and header["app"]["version"] == "0.3.0"
    assert header["webview"]["version"] == "620.1" and header["os"]["arch"]


class Registry:
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE = 1, 2
    KEY_WOW64_32KEY, KEY_WOW64_64KEY, KEY_READ = 32, 64, 128

    def __init__(self, values):
        self.values = values
        self.lookups = []

    def OpenKey(self, hive, path, unused, flags):
        assert path == native.WEBVIEW2_CLIENT
        self.lookups.append((hive, flags))
        value = self.values.get((hive, flags))
        if value is None:
            raise FileNotFoundError()
        return SimpleNamespaceContext(value)

    def QueryValueEx(self, key, name):
        assert name == "pv"
        return key, 1


class SimpleNamespaceContext:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self.value

    def __exit__(self, *args):
        pass


@pytest.mark.parametrize("versions,expected,supported", [({}, None, False),
    ({(1, 160): "0.0.0.0"}, None, False), ({(2, 192): "104.0.1.1"}, "104.0.1.1", False),
    ({(1, 160): "110.0.1.1", (2, 192): "120.0.2.1"}, "120.0.2.1", True),
    ({(1, 160): "bad"}, None, False)])
def test_webview2_registry(versions, expected, supported):
    registry = Registry(versions)
    version = native.webview2_version(registry)
    assert version == expected and native.webview2_supported(version) is supported
    assert len(registry.lookups) == 4


def test_missing_webview2_fails_before_window_creation(reports, monkeypatch):
    monkeypatch.setattr(main.sys, "platform", "win32")
    monkeypatch.setattr(native, "webview2_version", lambda: None)
    calls = []
    monkeypatch.setattr(native, "startup_failure", lambda r, error, **kw: calls.append((r, kw)))
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(create_window=lambda *a, **kw: pytest.fail("window created")))
    main._run_window(SimpleNamespace(reports=reports), SimpleNamespace(url="unused"), False)
    assert calls == [(reports, {"runtime": True})]


def test_native_fallback_generates_report_and_localized_message(reports, monkeypatch):
    from ba_modding_toolkit.i18n import i18n_manager
    old = i18n_manager.lang
    messages = []
    monkeypatch.setattr(native, "message_box", lambda *args: messages.append(args))
    try:
        for lang in ("en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"):
            i18n_manager.set_language(lang)
            result = native.startup_failure(reports, RuntimeError("WebView2 missing"), runtime=True)
            assert result["path"] in messages[-1][1] and native.WEBVIEW2_URL in messages[-1][1]
            assert "webui.recovery" not in messages[-1][0]
    finally:
        i18n_manager.set_language(old)


def test_pywebview_failure_is_caught_by_startup_wrapper(reports, monkeypatch):
    monkeypatch.setattr(main, "EXE_DIR", reports.data_dir)
    monkeypatch.setattr(main, "_serve", lambda *args: (_ for _ in ()).throw(ImportError("pywebview missing")))
    calls = []
    monkeypatch.setattr(native, "startup_failure", lambda r, error: calls.append(str(error)))
    args = SimpleNamespace(safe_mode=False, token=None, serve=False)
    assert main._run(args, SimpleNamespace()) is False
    assert calls == ["pywebview missing"]
    assert list(reports.data_dir.glob("BAMT-report-*.zip"))


def test_safe_mode_disables_assets_and_maintenance_without_changing_consent(tmp_path, monkeypatch):
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.webui.services import Services
    from ba_modding_toolkit.webui.state import UiState
    from ba_modding_toolkit.errors import ServiceError
    from ba_modding_toolkit.webui.server import WebApp
    from ba_modding_toolkit.webui.events import EventBus
    from ba_modding_toolkit.webui.rpc import RpcRegistry

    state = UiState(tmp_path / "webui.json")
    state.set_consent(True)
    state.set("spine_consent", True)
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=state, safe_mode=True)
    monkeypatch.setattr(s, "start_watch", lambda: pytest.fail("watch started"))
    monkeypatch.setattr(s, "_warm", lambda: pytest.fail("maintenance started"))
    try:
        s.start()
        s.ready()
        assert s.game_found() is False and s.ui_cached() is False
        assert s.state.consent is True and s.state.spine_consent is True
        with pytest.raises(ServiceError):
            s.asset("spine/official/test/skeleton.skel", {})
        assert s._game is None and s._library is None
        config = main.recovery_config(s)
        assert config["safeMode"] and config["strings"]["recovery.report"]
        app = WebApp(RpcRegistry(), EventBus(), recovery=lambda: config)
        response = b"".join(app._static("/", lambda *args: None)).decode()
        assert 'type="module" src="js/main.js"' not in response
        assert response.index("window.BAMT_CONFIG") < response.index('href="css/app.css"')
        assert "const watchdog" in response
    finally:
        s.close()


def test_restart_safe_refuses_writers_and_restarts_only_after_lock_release(monkeypatch, tmp_path):
    r = SimpleNamespace(jobs=SimpleNamespace(busy=lambda: True, reserve_quit=lambda: None, cancel_quit=lambda: None), window=object(), quit_handle=None,
                        restart_requested=False, quit=lambda: None, timings=Timings())
    rpc = build_api(r)
    assert rpc.call("app.restartSafe", {})["error"]["code"] == "busy"
    assert r.restart_requested is False
    r.jobs.busy = lambda: False
    assert "result" in rpc.call("app.restartSafe", {}) and r.restart_requested
    order = []
    monkeypatch.setattr(main, "EXE_DIR", tmp_path)
    monkeypatch.setattr(main.devmode, "check_read", lambda _: None)
    monkeypatch.setattr(main, "InstanceLock", lambda _: SimpleNamespace(acquire=lambda: True,
                                                                       release=lambda: order.append("released")))
    monkeypatch.setattr(main, "_run", lambda args, instance: args.safe_mode)
    from ba_modding_toolkit.webui import system
    monkeypatch.setattr(system, "program_command", lambda: ["test-app"])
    import subprocess
    monkeypatch.setattr(subprocess, "Popen", lambda command: order.append(command))
    main.main(["--safe-mode", "--browser", "--mute"])
    assert order == ["released", ["test-app", "--safe-mode", "--browser", "--mute"]]


def test_unexpected_rpc_and_job_exceptions_create_reports(reports):
    from ba_modding_toolkit.webui.events import EventBus
    from ba_modding_toolkit.webui.jobs import JobRunner
    from ba_modding_toolkit.webui.rpc import RpcRegistry
    rpc = RpcRegistry(on_exception=reports.backend_exception)

    def fail(**kwargs):
        raise RuntimeError("unexpected")

    rpc.method("fail")(fail)
    assert rpc.call("fail", {})["error"]["code"] == "internal"
    assert len(list(reports.data_dir.glob("BAMT-report-*.zip"))) == 1
    reports._crash_at = -float("inf")
    jobs = JobRunner(EventBus())
    jobs.on_exception = reports.backend_exception
    jobs.listen(reports.job_finished)
    try:
        job = jobs.submit("fail", fail)
        assert jobs.wait(job, 5)
        assert reports.last_job["code"] == "internal"
        assert len(list(reports.data_dir.glob("BAMT-report-*.zip"))) == 2
    finally:
        jobs.shutdown()


def test_quoted_mod_filenames_with_spaces_and_json_credentials_are_redacted():
    text = diagnostics.private_text('Upload "Private Mod Name.bundle" and \'Another Mod.skel\' token=hidden', set())
    assert "Private Mod Name" not in text and "Another Mod" not in text and "hidden" not in text
    assert ".bundle" in text and ".skel" in text
    assert diagnostics.clean({"Authorization": "Bearer abc", "params": {"api_key": "secret"}}, set()) == {
        "Authorization": "[redacted]", "params": {"api_key": "[redacted]"}}


def test_large_report_fields_and_log_bytes_are_bounded(reports):
    payload = "row " + "0123456789abcdef" * 100 + "\n"
    for name in diagnostics.LOG_NAMES:
        (reports.data_dir / name).write_text(payload * 1000 + "last event\n")
    reports.frontend_event(context={"webgl": {str(i): "x" * 8000 for i in range(100)}})
    result = reports.generate()
    with zipfile.ZipFile(result["path"]) as archive:
        assert archive.getinfo("report.json").file_size <= diagnostics.DATA_CAP
        assert sum(item.file_size for item in archive.infolist()) < 2_100_000
        for name in diagnostics.LOG_NAMES:
            data = archive.read(name)
            assert len(data) <= diagnostics.LOG_CAP + 40
            assert data.endswith(b"last event\n") and b"row 0123456789" in data


def test_failed_wsgi_request_writes_automatic_report(reports):
    from ba_modding_toolkit.webui.server import WebApp
    from ba_modding_toolkit.webui.events import EventBus
    from ba_modding_toolkit.webui.rpc import RpcRegistry

    def fail(*args):
        raise RuntimeError("asset reader failed")

    app = WebApp(RpcRegistry(), EventBus(), assets=fail, token="test", on_exception=reports.backend_exception)
    status = []
    app({"REQUEST_METHOD": "GET", "PATH_INFO": "/asset/ui/atlases.json", "HTTP_X_BAMT_TOKEN": "test"},
        lambda code, headers: status.append(code))
    assert status == ["500 Internal Server Error"]
    assert len(list(reports.data_dir.glob("BAMT-report-*.zip"))) == 1


def test_log_header_redacts_home(reports):
    path = Path.home() / "app-data" / "webui.log"
    handler = open_run_log(path, set())
    handler.close()
    header = json.loads(path.read_text().splitlines()[0].removeprefix("Environment "))
    assert header["dataDir"] == "~/app-data"


def test_build_propagates_safe_mode_and_html_does_not_wait_for_game_cache(tmp_path, monkeypatch):
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.webui.services import Services
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, safe_mode=True)
    monkeypatch.setattr(main, "Services", lambda **kwargs: s if kwargs["safe_mode"] else pytest.fail("normal mode"))
    monkeypatch.setattr(main, "Server", lambda app, port: SimpleNamespace(app=app, port=12345))
    monkeypatch.setattr(s, "ui_cached", lambda: pytest.fail("blocking cache check"))
    reports = Reports(tmp_path, safe_mode=True)
    try:
        _, server = main.build(safe_mode=True, reports=reports)
        assert server.app.ui_cached() is False
        assert server.app.recovery()["safeMode"] is True
        assert s.reports is reports and reports.services is s
        assert server.app.token in reports.secrets
    finally:
        s.close()


def test_automatic_retention_never_removes_user_reports(reports):
    manual = Path(reports.generate()["path"])
    for number in range(4):
        reports._crash_at = -float("inf")
        error = RuntimeError(str(number))
        reports.backend_exception(type(error), error, None)
    assert manual.exists()
    assert len(list(reports.data_dir.glob("*-auto*.zip"))) == 3
