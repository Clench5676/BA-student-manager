"""Entry point of the web UI: ``bamt-web`` (or ``python -m ba_modding_toolkit.webui``)."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser

from ..i18n import i18n_manager, t
from .api import build_api
from .server import Server, WebApp
from .services import Services

logger = logging.getLogger(__name__)

CONFIG_POLL_SECONDS = 2.0


def build(port: int = 0, services: Services | None = None, token: str | None = None) -> tuple[Services, Server]:
    s = services or Services()
    lang = s.settings.get("language")
    if lang and lang != i18n_manager.lang:
        i18n_manager.set_language(lang)  # the language chosen in either GUI
    app = WebApp(build_api(s), s.events, assets=s.asset, consent=lambda: s.state.consent, token=token)
    return s, Server(app, port)


def _watch_config(s: Services, stop: threading.Event) -> None:
    # the classic GUI may save config.toml while the web UI runs
    while not stop.wait(CONFIG_POLL_SECONDS):
        try:
            s.settings.reload_if_changed()
        except Exception:
            logger.exception("config reload failed")


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

    s, server = build(args.port, token=args.token)
    s.mute = args.mute
    server.start()
    stop = threading.Event()
    threading.Thread(target=_watch_config, args=(s, stop), name="bamt-config", daemon=True).start()
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


def _run_window(s: Services, server: Server, debug: bool) -> None:
    import webview

    from .native import WEBVIEW2_URL, renderer_supported, watch_drops

    window = webview.create_window(t("ui.app_title"), server.url, width=1600, height=900, min_size=(960, 540),
                                   background_color="#0d2a4c", text_select=False)
    s.window = window

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

    window.events.initialized += on_initialized
    window.events.loaded += on_loaded
    storage = s.data_dir / "webview"  # never next to the program in a compiled build: data_dir follows EXE_DIR rules
    webview.start(debug=debug, private_mode=True, storage_path=str(storage))


if __name__ == "__main__":
    main(sys.argv[1:])
