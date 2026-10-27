"""Entry point of the web UI: ``bamt-web`` (or ``python -m ba_modding_toolkit.webui``)."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .. import devmode
from ..i18n import i18n_manager, t
from ..utils import EXE_DIR
from .api import build_api
from .instance import InstanceLock, raise_running
from .server import Server, WebApp
from .services import Services
from .session_log import RedactingFormatter, open_run_log
from .diagnostics import Reports, install_exception_hooks

logger = logging.getLogger(__name__)

CONFIG_POLL_SECONDS = 2.0


def build(port: int = 0, services: Services | None = None, token: str | None = None, *,
          safe_mode: bool = False, reports: Reports | None = None) -> tuple[Services, Server]:
    s = services or Services(safe_mode=safe_mode)
    if reports is not None:
        reports.services = s
        reports.game = s.reports.game
        reports.secrets.update(s.log_secrets)
        s.log_secrets = reports.secrets
        s.reports = reports
    with s.timings.measure("server.build"):
        lang = s.settings.get("language")
        if lang and lang != i18n_manager.lang:
            i18n_manager.set_language(lang)  # the language chosen in either GUI
        app = WebApp(build_api(s), s.events, assets=s.asset, consent=lambda: s.state.consent, token=token,
                     ui_cached=lambda: False, recovery=lambda: recovery_config(s),
                     classic=s.classic.wsgi, raise_window=s.raise_window, on_exception=s.reports.backend_exception)
        s.log_secrets.update((app.token, app.raise_token))
        server = Server(app, port)
        s.origin = f"http://127.0.0.1:{server.port}"  # the classic window's channel
    return s, server


def _watch_config(s: Services, stop: threading.Event) -> None:
    # the classic GUI may save config.toml while the web UI runs
    while not stop.wait(CONFIG_POLL_SECONDS):
        try:
            s.settings.reload_if_changed()
        except Exception:
            logger.exception("config reload failed")


def _trace_to_file(path: Path) -> None:
    """The front end's input trace (debug.trace) also goes to a file next to the settings, which a compiled app can
    send along without a terminal; it starts empty on every --debug start."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(path, mode="w", encoding="utf-8")
    except OSError:
        logger.warning("cannot write the input trace to %s", path, exc_info=True)
        return
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    trace = logging.getLogger("ba_modding_toolkit.webui.trace")
    trace.setLevel(logging.INFO)
    trace.addHandler(handler)
    logger.info("input trace in %s", path)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="bamt-web")
    parser.add_argument("--browser", action="store_true", help="open the UI in the system browser instead of a window")
    parser.add_argument("--serve", action="store_true", help="only run the server (for development tools)")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", help="a fixed session token instead of a random one (development only)")
    parser.add_argument("--mute", action="store_true", help="never play voices (development and tests)")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--safe-mode", action="store_true", help="start without game assets, Spine or restored pages")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    devmode.check_read(EXE_DIR)
    instance = InstanceLock(EXE_DIR)
    if not instance.acquire():
        raise SystemExit(second_start(EXE_DIR, serve=args.serve))
    restart = False
    try:
        restart = _run(args, instance)
    finally:
        instance.release()
    if restart:
        import subprocess
        from .system import safe_restart_command
        command = safe_restart_command() + ["--safe-mode"]
        command += [flag for flag in ("--browser", "--debug", "--mute") if getattr(args, flag[2:])]
        subprocess.Popen(command)


def second_start(data_dir: Path, *, serve: bool) -> int:
    """Another instance runs on this data directory: bring its window to the front and exit (exit code 0), or, with
    ``--serve`` or without an answer, refuse to start (1)."""
    if serve:
        logger.error("another instance of the web UI runs on the data directory %s", data_dir)
        return 1
    if raise_running(data_dir):
        logger.info("brought the running instance on %s to the front", data_dir)
        return 0
    logger.error("another instance holds %s but did not answer", data_dir)
    return 1


def recovery_config(s: Services) -> dict:
    from .strings import ui_strings
    from .system import can_restart_safe
    strings = ui_strings(i18n_manager.lang)
    return {"safeMode": s.safe_mode, "canRestartSafe": can_restart_safe() and not getattr(s, "serve_only", False) and
            (getattr(s, "window", None) is not None or getattr(s, "quit_handle", None) is not None), "language": i18n_manager.lang,
            "strings": {k.removeprefix("webui."): v for k, v in strings.items() if k.startswith("webui.recovery.") or
                        k in ("webui.settings.button", "webui.settings.log.open", "webui.picker.ok")}}


def _run(args: argparse.Namespace, instance: InstanceLock) -> bool:
    safe_mode = getattr(args, "safe_mode", False)
    reports = Reports(EXE_DIR, safe_mode=safe_mode)
    if args.token:
        reports.secrets.add(args.token)
    handler = None
    restore = install_exception_hooks(reports)
    try:
        handler = open_run_log(EXE_DIR / "webui.log", reports.secrets, safe_mode=safe_mode)
        reports.log_path = Path(handler.baseFilename) if hasattr(handler, "baseFilename") else None
        logging.getLogger().addHandler(handler)
        return _serve(args, instance, reports, handler)
    except Exception as error:
        logger.exception("Startup failed")
        reports.backend_exception(type(error), error, error.__traceback__)
        if not args.serve:
            from .native import startup_failure
            startup_failure(reports, error)
        return False
    finally:
        logger.info("Application lifecycle: run finished")
        restore()
        if handler is not None:
            logging.getLogger().removeHandler(handler)
            handler.close()


def _serve(args: argparse.Namespace, instance: InstanceLock, reports: Reports, handler) -> bool:
    s, server = build(args.port, token=args.token, safe_mode=reports.safe_mode, reports=reports)
    s.serve_only = args.serve
    s.log_path = reports.log_path
    handler.setFormatter(RedactingFormatter(s.log_secrets))
    for phase, value in s.timings.snapshot().items():
        logger.info("Timing %s: %.3f s (%s calls before log opened)", phase, value["seconds"], value["count"])
    s.mute = args.mute
    s.debug = args.debug
    stop = threading.Event()
    try:
        if args.debug:
            _trace_to_file(s.data_dir / "input-trace.log")
        with s.timings.measure("server.start"):
            server.start()
        instance.publish(server.port, server.app.raise_token)
        if args.browser:
            s.quit_handle = stop.set
            s.browser_url = server.url
        threading.Thread(target=_watch_config, args=(s, stop), name="bamt-config", daemon=True).start()
        s.start()
        logger.info("web UI at %s", server.url)
        if args.browser or args.serve:
            if args.browser:
                webbrowser.open(server.url)
            print(server.url, flush=True)
            stop.wait()
        else:
            _run_window(s, server, args.debug)
    except KeyboardInterrupt:
        pass
    finally:
        logger.info("Application lifecycle: services cleanup begin")
        stop.set()
        server.stop()
        s.close()
        logger.info("Application lifecycle: services cleanup complete")
    return s.restart_requested


def _run_window(s: Services, server: Server, debug: bool) -> None:
    from . import native
    if sys.platform == "win32":
        version = native.webview2_version()
        if not native.webview2_supported(version):
            native.startup_failure(s.reports, RuntimeError(f"WebView2 {version or 'missing'}"), runtime=True)
            return
    with s.timings.measure("native.import"):
        import webview

    from .native import WEBVIEW2_URL, renderer_supported, watch_drops
    from .tray import Tray

    # text_select stays True: with False (pywebview's default) pywebview appends "body { user-select: none; cursor:
    # default }" to the page, which replaces the game's pointer with the system arrow on everything but the buttons.
    # The page turns off text selection itself (app.css).
    webview.settings["SHOW_DEFAULT_MENUS"] = False
    webview.settings["DRAG_REGION_SELECTOR"] = ".topbar:not(.native-toolbar)"
    webview.settings["DRAG_REGION_DIRECT_TARGET_ONLY"] = True
    with s.timings.measure("native.create-window"):
        window = webview.create_window(t("ui.app_title"), server.url, width=1600, height=900, min_size=(960, 540),
                                       background_color="#000000", text_select=True, frameless=True, easy_drag=False)
    s.window = window
    from .window_chrome import WindowChrome
    from .window_close import CloseCoordinator
    s.chrome = WindowChrome(window, s.events)
    s.close_coordinator = CloseCoordinator(s, s.chrome.close, page_loaded=False)
    commands = None
    lifecycle = {"shown": False, "loaded": False, "closing": False, "closed": False, "drops": "not-started"}

    def before_show():
        nonlocal commands
        logger.info("Native lifecycle: before-show begin")
        if sys.platform == "darwin":
            commands = native.install_window_commands(s, s.chrome)
        logger.info("Native lifecycle: before-show complete")

    window.events.before_show += before_show
    def on_shown():
        lifecycle["shown"] = True
        logger.info("Native lifecycle: shown")
        if s.chrome.active:
            s.chrome.host.dispatch(s.chrome.refresh)
    window.events.shown += on_shown
    for name, key, value in (("maximized", "maximized", True), ("restored", "maximized", False),
                              ("minimized", "minimized", True)):
        # Event handlers with default parameters are called with event arguments by pywebview.
        def bind_state(key, value):
            return lambda: s.chrome.fallback_state(key, value)
        event = getattr(window.events, name)
        event += bind_state(key, value)
    # the tray or menu bar icon, shown while the preference "tray" is on; it goes with the window (decision 7)
    tray = Tray(s) if Tray.supported() else None
    s.tray_supported = tray is not None
    if tray is not None:
        tray.attach()

    def on_initialized(renderer: str) -> bool:
        logger.info("Native lifecycle: initialized renderer=%s", renderer)
        s.timings.record("native.initialize", time.perf_counter() - native_started)
        if renderer_supported(renderer):
            return True
        logger.error("unsupported web renderer %s; install WebView2 from %s", renderer, WEBVIEW2_URL)
        native.startup_failure(s.reports, RuntimeError(f"Unsupported renderer: {renderer}"), runtime=True)
        return False

    def on_loaded() -> None:
        lifecycle["loaded"] = True
        logger.info("Native lifecycle: loaded begin")
        s.close_coordinator.page_loaded = True
        s.timings.record("native.document", time.perf_counter() - native_started)
        if sys.platform == "win32" and s.chrome.host is None:
            # WebView2 Settings exists after initialization, not at before_show.
            def install_chrome():
                from System import Action
                window.native.BeginInvoke(Action(s.chrome.install))
            install_chrome()
        if sys.platform == "darwin" and getattr(window, "native", None) is not None:
            # Cocoa replaces its placeholder contentView when navigation finishes.
            from PyObjCTools import AppHelper
            if s.chrome.host is None:
                AppHelper.callAfter(s.chrome.install)
            if commands is not None:
                AppHelper.callAfter(commands.refresh)
        try:
            lifecycle["drops"] = "running"
            watch_drops(window, lambda paths: s.events.publish("drop", {"paths": paths}))
            lifecycle["drops"] = "complete"
        except Exception:
            lifecycle["drops"] = "failed"
            logger.exception("drag and drop is unavailable")
        logger.info("Native lifecycle: loaded complete drops=%s", lifecycle["drops"])

    def on_closing() -> bool:
        lifecycle["closing"] = True
        logger.info("Native lifecycle: closing begin")
        allowed = s.on_closing()
        logger.info("Native lifecycle: closing complete allowed=%s", allowed)
        return allowed

    def on_closed() -> None:
        lifecycle["closed"] = True
        logger.info("Native lifecycle: closed begin")
        s.on_closed()
        logger.info("Native lifecycle: closed complete")

    window.events.initialized += on_initialized
    window.events.loaded += on_loaded
    window.events.closing += on_closing
    window.events.closed += on_closed
    storage = s.data_dir / "webview"  # never next to the program in a compiled build: data_dir follows EXE_DIR rules
    try:
        # the tray starts on a thread of its own once the GUI loop runs
        native_started = time.perf_counter()
        logger.info("Native lifecycle: loop starting")
        webview.start(func=tray.start if tray is not None else None, args=(window,) if tray is not None else None,
                      debug=debug, private_mode=True, storage_path=str(storage),
                      gui="edgechromium" if sys.platform == "win32" else None)
    except BaseException as error:
        logger.info("Native lifecycle: loop raised type=%s", type(error).__name__)
        raise
    else:
        logger.info("Native lifecycle: loop returned")
    finally:
        logger.info("Native lifecycle: cleanup begin shown=%s loaded=%s closing=%s closed=%s drops=%s",
                    lifecycle["shown"], lifecycle["loaded"], lifecycle["closing"], lifecycle["closed"], lifecycle["drops"])
        if commands is not None:
            commands()
        s.chrome.dispose()
        if tray is not None:
            tray.close()  # on the main thread once the loop ended: the icon goes with the window
        logger.info("Native lifecycle: cleanup complete")


if __name__ == "__main__":
    main(sys.argv[1:])
