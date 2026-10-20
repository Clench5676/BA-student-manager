"""Entry point of the web UI: ``bamt-web`` (or ``python -m ba_modding_toolkit.webui``)."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from pathlib import Path

from .. import devmode
from ..i18n import i18n_manager, t
from ..utils import EXE_DIR
from .api import build_api
from .instance import InstanceLock, raise_running
from .server import Server, WebApp
from .services import Services
from .session_log import RedactingFormatter

logger = logging.getLogger(__name__)

CONFIG_POLL_SECONDS = 2.0


def build(port: int = 0, services: Services | None = None, token: str | None = None) -> tuple[Services, Server]:
    s = services or Services()
    lang = s.settings.get("language")
    if lang and lang != i18n_manager.lang:
        i18n_manager.set_language(lang)  # the language chosen in either GUI
    app = WebApp(build_api(s), s.events, assets=s.asset, consent=lambda: s.state.consent, token=token,
                 classic=s.classic.wsgi, raise_window=s.raise_window)
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
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    devmode.check_read(EXE_DIR)
    instance = InstanceLock(EXE_DIR)
    if not instance.acquire():
        raise SystemExit(second_start(EXE_DIR, serve=args.serve))
    try:
        _run(args, instance)
    finally:
        instance.release()


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


def _run(args: argparse.Namespace, instance: InstanceLock) -> None:
    s, server = build(args.port, token=args.token)
    s.log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(s.log_path, mode="w", encoding="utf-8")
    handler.setFormatter(RedactingFormatter(s.log_secrets))
    logging.getLogger().addHandler(handler)
    s.mute = args.mute
    s.debug = args.debug
    if args.debug:
        _trace_to_file(s.data_dir / "input-trace.log")
    server.start()
    instance.publish(server.port, server.app.raise_token)
    stop = threading.Event()
    if args.browser:
        s.quit_handle = stop.set  # app.quit stops the server; the page then shows Closed
        s.browser_url = server.url
    threading.Thread(target=_watch_config, args=(s, stop), name="bamt-config", daemon=True).start()
    s.start()
    logger.info("web UI at %s", server.url)

    try:
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
        stop.set()
        server.stop()
        s.close()
        logging.getLogger().removeHandler(handler)
        handler.close()


def _run_window(s: Services, server: Server, debug: bool) -> None:
    import webview

    from .native import WEBVIEW2_URL, renderer_supported, watch_drops
    from .tray import Tray

    # text_select stays True: with False (pywebview's default) pywebview appends "body { user-select: none; cursor:
    # default }" to the page, which replaces the game's pointer with the system arrow on everything but the buttons.
    # The page turns off text selection itself (app.css).
    window = webview.create_window(t("ui.app_title"), server.url, width=1600, height=900, min_size=(960, 540),
                                   background_color="#0d2a4c", text_select=True)
    s.window = window
    # the tray or menu bar icon, shown while the preference "tray" is on; it goes with the window (decision 7)
    tray = Tray(s) if Tray.supported() else None
    s.tray_supported = tray is not None
    if tray is not None:
        tray.attach()

    def on_initialized(renderer: str) -> bool:
        if renderer_supported(renderer):
            return True
        logger.error("unsupported web renderer %s; install WebView2 from %s", renderer, WEBVIEW2_URL)
        return False

    def on_loaded() -> None:
        try:
            watch_drops(window, lambda paths: s.events.publish("drop", {"paths": paths}))
        except Exception:
            logger.exception("drag and drop is unavailable")

    def on_closing() -> bool:
        # a job may be writing into the game folder: keep the window until it is done
        if s.jobs.busy():
            s.events.publish("app.busy")
            return False
        return True

    window.events.initialized += on_initialized
    window.events.loaded += on_loaded
    window.events.closing += on_closing
    storage = s.data_dir / "webview"  # never next to the program in a compiled build: data_dir follows EXE_DIR rules
    try:
        # the tray starts on a thread of its own once the GUI loop runs
        webview.start(func=tray.start if tray is not None else None, args=(window,) if tray is not None else None,
                      debug=debug, private_mode=True, storage_path=str(storage))
    finally:
        if tray is not None:
            tray.close()  # on the main thread once the loop ended: the icon goes with the window


if __name__ == "__main__":
    main(sys.argv[1:])
