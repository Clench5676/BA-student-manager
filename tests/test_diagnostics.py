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


@pytest.mark.parametrize("popup", [False, True])
def test_report_includes_the_current_import_list_and_ui_language(reports, monkeypatch, popup):
    monkeypatch.setattr(diagnostics.i18n_manager, "lang", "en-US")
    (reports.data_dir / "config.toml").write_text('[AppSettings]\nlanguage = "zh-CN"\n')
    handler = open_run_log(reports.log_path, set())
    handler.close()
    rows = [{"id": str(i), "kind": "model", "state": "blocked", "reason": "required_assets_unmatched",
             "error": {"code": "required_assets_unmatched", "params": {"file": "/private/Owner Mod.bundle", "name": "Body"}},
             "files": [{"path": "/private/Owner Mod.bundle"}], "selected": False,
             "source": {"server": "global", "platform": "android"},
             "target": {"server": "global", "platform": "windows"}} for i in range(60)]
    context = {"language": "zh-CN", "page": "#/import" if popup else "#/settings",
               "batchImport": {"phase": "idle", "revision": 7, "rows": rows}}
    params = {"context": context}
    if popup:
        params["event"] = {"code": "required_assets_unmatched"}
    result = build_api(reports.services).call("app.report", params)["result"]
    files = contents(result)
    data = json.loads(files["report.json"])
    header = json.loads(files["webui.log"].splitlines()[0].removeprefix("Environment "))
    assert data["language"] == header["language"] == "zh-CN"
    assert "zh-CN" in result["summary"] and "en-US" not in result["summary"]
    imports = data["batchImport"]
    assert imports["total"] == 60 and imports["omitted"] == 0 and len(imports["rows"]) == 60
    assert imports["rows"][0]["params"] == {"file": "[asset].bundle", "name": "Body"}
    assert imports["rows"][0]["conversionRoute"] == "global/android -> global/windows"
    assert "Owner Mod" not in "\n".join(files.values())
    assert "[batchImport]" in files["report.txt"] and "required_assets_unmatched" in files["report.txt"]
    context["batchImport"]["rows"] = []
    cleared = build_api(reports.services).call("app.report", {"context": context})["result"]
    assert json.loads(contents(cleared)["report.json"])["batchImport"]["rows"] == []


def test_report_uses_backend_import_snapshot_when_frontend_is_unavailable(reports):
    reports.services.batch_import = SimpleNamespace(diagnostic_snapshot=lambda: {
        "revision": 2, "rows": [{"id": "model", "kind": "model", "state": "blocked", "reason": "mod_target_unknown"}]})
    data = json.loads(contents(reports.generate())["report.json"])
    assert data["batchImport"]["rows"][0]["reason"] == "mod_target_unknown"


def test_import_snapshot_bounds_large_lists_with_explicit_omission_count(reports):
    rows = [{"id": str(i), "kind": "model", "state": "blocked", "reason": "conversion_failed",
             "params": {"error": "details " * 1000}} for i in range(2000)]
    reports.frontend_event(context={"batchImport": {"rows": rows}})
    result = reports.generate()
    files = contents(result)
    assert len(files["report.json"].encode()) <= diagnostics.DATA_CAP
    snapshot = json.loads(files["report.json"])["batchImport"]
    assert snapshot["total"] == 2000
    assert 0 < len(snapshot["rows"]) < 2000
    assert snapshot["omitted"] + len(snapshot["rows"]) == 2000


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
        assert "function progress()" in response
    finally:
        s.close()


def test_restart_safe_refuses_writers_and_restarts_only_after_lock_release(monkeypatch, tmp_path):
    monkeypatch.setattr(diagnostics.updater, "is_compiled", lambda: True)
    monkeypatch.setattr(main.devmode, "active", lambda: False)
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


@pytest.mark.parametrize("value", ["Private Mod Name.bundle", "C:/Mods/Private Folder/Private Mod Name.bundle",
                                  "/opt/Private Folder/Private Mod Name.bundle"])
def test_review_asset_values_and_unquoted_log_paths_are_wholly_redacted(value):
    assert diagnostics.clean({"file": value}, set()) == {"file": "[asset].bundle"}
    text = diagnostics.private_text(f"Cannot open {value}\nTiming boot: 1 s", set())
    assert "Private" not in text and "[asset].bundle" in text and "Timing boot: 1 s" in text


def test_review_encoded_identities_are_scrubbed_everywhere(reports, monkeypatch):
    import socket
    from urllib.parse import quote
    home = Path("/Users/\u5c71\u7530")
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setattr(diagnostics.getpass, "getuser", lambda: home.name)
    monkeypatch.setattr(socket, "gethostname", lambda: "Private-Mac")
    monkeypatch.setattr(diagnostics.platform, "node", lambda: "Private-Mac")
    monkeypatch.setenv("COMPUTERNAME", "Private-PC")
    forms = [str(home), json.dumps(str(home))[1:-1], quote(str(home)), quote(str(home), safe=""),
             quote(quote(str(home), safe=""), safe=""), json.dumps(home.name)[1:-1],
             "Private-Mac", "Private-PC"]
    payload = "\n".join(forms)
    for name in diagnostics.LOG_NAMES:
        (reports.data_dir / name).write_text(payload)
    reports.frontend_event({"message": payload})
    joined = "\n".join(contents(reports.generate()).values())
    for form in forms:
        assert form not in joined


def test_review_short_secrets_keys_and_version_survive(reports, monkeypatch):
    reports.secrets.update({"a", "0", "0.3.0", "long-secret"})
    value = diagnostics.clean({"phase": "data", "long-secret": "long-secret", "message": "long-secret long-secret-extra"}, reports.secrets)
    assert value == {"phase": "data", "long-secret": "[redacted]", "message": "[redacted] long-secret-extra"}
    monkeypatch.setattr(diagnostics.updater, "current_version", lambda: "0.3.0-development")
    reports.secrets.add("0.3.0-development")
    result = reports.generate()
    assert Path(result["path"]).name.startswith("BAMT-report-0.3.0-development-")
    assert json.loads(contents(result)["report.json"])["app"]["version"] == "0.3.0-development"


@pytest.mark.parametrize("operation", ["mkdir", "open", "rotate"])
def test_review_unwritable_logging_keeps_hooks_reports_and_native_alert(reports, monkeypatch, operation):
    monkeypatch.setattr(main, "EXE_DIR", reports.data_dir)
    desktop = native.report_folders()[0]
    desktop.mkdir()
    log = reports.data_dir / "webui.log"
    log.write_text("old log")
    import builtins
    original_mkdir, original_open, original_replace = Path.mkdir, builtins.open, Path.replace

    def mkdir(path, *args, **kwargs):
        if operation == "mkdir" and path == reports.data_dir:
            raise PermissionError("data directory unavailable")
        return original_mkdir(path, *args, **kwargs)

    def open_file(path, *args, **kwargs):
        if operation == "open" and Path(path) == log:
            raise PermissionError("log unavailable")
        return original_open(path, *args, **kwargs)

    def replace(path, *args, **kwargs):
        if operation == "rotate" and path == log:
            raise PermissionError("rotation unavailable")
        return original_replace(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", mkdir)
    monkeypatch.setattr(builtins, "open", open_file)
    monkeypatch.setattr(Path, "replace", replace)
    previous_hook, original_log = sys.excepthook, main.open_run_log
    def open_log(*args, **kwargs):
        assert sys.excepthook is not previous_hook
        return original_log(*args, **kwargs)
    monkeypatch.setattr(main, "open_run_log", open_log)
    entered, messages = [], []
    def serve(args, instance, r, handler):
        entered.append(handler)
        handler.emit(logging.makeLogRecord({"msg": "fallback log works", "levelno": logging.ERROR, "levelname": "ERROR"}))
        raise RuntimeError("service startup failed")
    monkeypatch.setattr(main, "_serve", serve)
    monkeypatch.setattr(native, "message_box", lambda *args: messages.append(args))
    assert main._run(SimpleNamespace(safe_mode=False, token=None, serve=False), SimpleNamespace()) is False
    assert entered and messages and sys.excepthook is previous_hook
    assert list(desktop.glob("BAMT-report-*.zip"))
    if getattr(entered[0], "baseFilename", None):
        assert "fallback log works" in Path(entered[0].baseFilename).read_text()


@pytest.mark.parametrize("runtime", [False, True])
def test_review_native_alert_survives_report_failure(reports, monkeypatch, runtime):
    messages = []
    monkeypatch.setattr(reports, "generate", lambda: (_ for _ in ()).throw(OSError("no writable destination")))
    monkeypatch.setattr(native, "message_box", lambda *args: messages.append(args))
    result = native.startup_failure(reports, RuntimeError("startup failed"), runtime=runtime)
    assert result is None and len(messages) == 1
    assert (native.WEBVIEW2_URL in messages[0][1]) is runtime
    assert ".zip" not in messages[0][1]


@pytest.mark.parametrize("compiled,development,serve", [(False, False, False), (True, True, False), (True, False, True)])
def test_review_restart_safe_refuses_unsupported_launches(monkeypatch, compiled, development, serve):
    monkeypatch.setattr(diagnostics.updater, "is_compiled", lambda: compiled)
    monkeypatch.setattr(main.devmode, "active", lambda: development)
    s = SimpleNamespace(jobs=SimpleNamespace(busy=lambda: False), window=None if serve else object(),
                        quit_handle=None, restart_requested=False, timings=Timings(), safe_mode=False)
    result = build_api(s).call("app.restartSafe", {})
    assert result["error"]["code"] == "safe_restart_unavailable"
    assert s.restart_requested is False
    assert main.recovery_config(s)["canRestartSafe"] is False


def test_review_optional_failures_and_blocking_reads_yield_report(reports, monkeypatch):
    import time
    release = threading.Event()
    entered = []
    def blocked(*args):
        entered.append(True)
        release.wait(2)
        return {}
    monkeypatch.setattr(reports.services, "library_dir", lambda: (_ for _ in ()).throw(RuntimeError("bad settings")))
    monkeypatch.setattr(reports.services.timings, "snapshot", blocked)
    monkeypatch.setattr(native, "engine_info", blocked)
    try:
        started = time.monotonic()
        data = json.loads(contents(reports.generate())["report.json"])
        assert time.monotonic() - started < 1.5
        assert data["libraryCounts"] is None and data["timings"] is None and data["webview"] is None
    finally:
        release.set()


def test_review_consent_uses_cache_without_file_lock(reports, monkeypatch):
    from ba_modding_toolkit.webui.state import UiState
    state = UiState(reports.data_dir / "webui.json")
    state.set_consent(True)
    state.set("spine_consent", False)
    reports.services.state = state
    monkeypatch.setattr(state, "_current", lambda: (_ for _ in ()).throw(AssertionError("blocking state read")))
    library = reports.data_dir / "chosen-library"
    library.mkdir()
    (library / "state.json").write_text('{"mods": [{"kind": "spr"}]}')
    state.set("library_dir", str(library))
    reports.services.library_dir = lambda: Path(state.get("library_dir"))
    data = reports.snapshot()
    assert data["consent"] == {"uiAssets": True, "spine": False}
    assert data["libraryCounts"] == {"spr": 1, "lobby": 0, "model": 0, "other": 0}


def test_review_popup_report_records_error_code_and_private_parameters(reports):
    result = build_api(reports.services).call("app.report", {"event": {"kind": "popup", "code": "library_io_error",
        "params": {"file": "Private Mod Name.bundle", "token": "secret-value", "operation": "read"}}})
    assert "result" in result
    error = json.loads(contents(result["result"])["report.json"])["frontendErrors"][-1]
    assert error["code"] == "library_io_error"
    assert error["params"] == {"file": "[asset].bundle", "token": "[redacted]", "operation": "read"}


def test_review_recovery_embeds_shared_plain_style(reports):
    from ba_modding_toolkit.webui.server import WebApp, WEB_DIR
    from ba_modding_toolkit.webui.events import EventBus
    from ba_modding_toolkit.webui.rpc import RpcRegistry
    body = b"".join(WebApp(RpcRegistry(), EventBus())._static("/", lambda *args: None)).decode()
    style = (WEB_DIR / "css" / "fallback.css").read_text()
    assert style in body
    assert body.index(style) < body.index('href="css/app.css"')
    assert "#bamt-recovery" in style and ".screen.message" in style
    assert "#edf6fa" not in body and "#89b9d0" not in body


def test_review_collection_deadline_and_stuck_worker_count(reports, monkeypatch):
    import time
    release = threading.Event()
    calls = []
    def blocked():
        calls.append(True)
        release.wait(5)
    monkeypatch.setattr(diagnostics, "READ_TIMEOUT", .05)
    monkeypatch.setattr(diagnostics, "COLLECTION_TIMEOUT", .2)
    monkeypatch.setattr(native, "engine_info", blocked)
    monkeypatch.setattr(native, "report_folders", blocked)
    monkeypatch.setattr(reports.services.timings, "snapshot", blocked)
    monkeypatch.setattr(reports, "library_counts", blocked)
    monkeypatch.setattr(reports, "_previous_error", blocked)
    try:
        for _ in range(2):
            started = time.monotonic()
            result = reports.generate()
            assert Path(result["path"]).is_file()
            assert time.monotonic() - started < .5
        assert len(calls) <= 5
    finally:
        release.set()


def test_review_held_diagnostic_lock_does_not_block_report_rpc(reports):
    import time
    held, release = threading.Event(), threading.Event()
    def hold():
        with reports._lock:
            held.set()
            release.wait(5)
    worker = threading.Thread(target=hold, daemon=True)
    worker.start()
    assert held.wait(1)
    try:
        started = time.monotonic()
        result = build_api(reports.services).call("app.report", {})
        assert "result" in result and time.monotonic() - started < 1.5
    finally:
        release.set()
        worker.join(1)


def test_review_popup_trigger_survives_a_full_error_rate_limit(reports):
    for i in range(10):
        reports.frontend_event({"message": str(i)})
    result = build_api(reports.services).call("app.report", {"event": {
        "kind": "popup", "code": "busy", "params": {"file": "Private Mod.bundle"}}})["result"]
    data = json.loads(contents(result)["report.json"])
    assert data["triggeringError"] == {"kind": "popup", "code": "busy", "params": {"file": "[asset].bundle"}}
    assert "busy" in data["summary"]


def test_review_stderr_fallback_when_no_log_file_is_writable(reports, monkeypatch):
    import builtins
    previous = builtins.open
    def denied(path, mode="r", *args, **kwargs):
        if str(path).endswith(".log") and mode == "w":
            raise PermissionError("logs unavailable")
        return previous(path, mode, *args, **kwargs)
    monkeypatch.setattr(builtins, "open", denied)
    handler = open_run_log(reports.data_dir / "webui.log", set())
    try:
        assert handler.stream is sys.stderr
        assert not isinstance(handler, logging.FileHandler)
    finally:
        handler.close()


def test_review_structured_filenames_keep_only_extensions():
    assert diagnostics.clean({"file": "Private Settings.txt", "paths": ["Private Archive.tar.gz", "Private Folder"],
                              "filename": "Private Mod.bundle.backup"}, set()) == {
        "file": "[asset].txt", "paths": ["[asset].gz", "[asset]"], "filename": "[asset].bundle.backup"}
