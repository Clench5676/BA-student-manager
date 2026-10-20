"""The local HTTP server: the static front end, /api/rpc, /api/events, /asset/..., the classic window's channel
(/api/classic/*) and a second start's raise (/api/instance/raise); see docs/web-ui.md."""

from __future__ import annotations

import hmac
import json
import logging
import mimetypes
import secrets
import socketserver
import threading
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable
from urllib.parse import parse_qs, unquote
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from ..errors import ServiceError
from .events import EventBus
from .instance import RAISE_HEADER, RAISE_PATH
from .rpc import RpcRegistry

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = 4 * 1024 * 1024

MIME = {
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".woff2": "font/woff2", ".ttf": "font/ttf", ".atlas": "text/plain; charset=utf-8",
    ".skel": "application/octet-stream", ".glb": "model/gltf-binary",
}


@dataclass
class AssetResponse:
    body: bytes
    mime: str
    light: bool  # light assets may be cached by the web view once the user agreed; heavy ones never


AssetHandler = Callable[[str, dict[str, str]], AssetResponse]


class WebApp:
    """The WSGI application. Every request needs a loopback Host header, and the session token except the classic
    window's channel (``/api/classic/*``, the child's own one-time token) and a second start's raise
    (``/api/instance/raise``, the raise token of ``instance.json``)."""

    def __init__(self, rpc: RpcRegistry, events: EventBus, assets: AssetHandler | None = None,
                 static_dir: Path = WEB_DIR, token: str | None = None,
                 consent: Callable[[], bool | None] = lambda: None,
                 classic: Callable[[dict, Callable], Iterable[bytes]] | None = None,
                 raise_window: Callable[[], Any] | None = None, raise_token: str | None = None):
        self.rpc = rpc
        self.events = events
        self.assets = assets
        self.static_dir = Path(static_dir).resolve()
        self.token = token or secrets.token_urlsafe(24)
        self.consent = consent
        self.classic = classic  # ClassicWindow.wsgi
        self.raise_window = raise_window
        self.raise_token = raise_token or secrets.token_urlsafe(24)
        self.port: int | None = None  # set by serve(); the cookie name and Host check use it

    # --- entry ---

    def __call__(self, environ: dict, start_response: Callable) -> Iterable[bytes]:
        method = environ.get("REQUEST_METHOD", "GET")
        path = unquote(environ.get("PATH_INFO", "") or "/")
        query = {k: v[0] for k, v in parse_qs(environ.get("QUERY_STRING", "")).items()}

        if not self._host_ok(environ):
            return self._text(start_response, "403 Forbidden", "forbidden")
        if path.startswith("/api/classic/"):
            if self.classic is None:
                return self._text(start_response, "404 Not Found", "not found")
            return self.classic(environ, start_response)
        if path == RAISE_PATH:
            return self._raise(environ, method, start_response)
        if path == "/" and self._same(query.get("t", "")):
            # first load: remember the token in a cookie and drop it from the address
            return self._respond(start_response, "303 See Other", b"", "text/plain",
                                 [("Location", "/"), ("Set-Cookie", self._cookie())])
        if not self._token_ok(environ):
            return self._text(start_response, "403 Forbidden", "forbidden")

        try:
            if path == "/api/rpc" and method == "POST":
                return self._rpc(environ, start_response)
            if path == "/api/events" and method == "GET":
                return self._sse(start_response)
            if path.startswith("/asset/") and method == "GET":
                return self._asset(path, query, start_response)
            if method in ("GET", "HEAD"):
                return self._static(path, start_response)
            return self._text(start_response, "405 Method Not Allowed", "method not allowed")
        except Exception:
            logger.exception("request %s %s failed", method, path)
            return self._text(start_response, "500 Internal Server Error", "internal error")

    # --- security ---

    def _cookie_name(self) -> str:
        return f"bamt{self.port or ''}"

    def _cookie(self) -> str:
        return f"{self._cookie_name()}={self.token}; Path=/; HttpOnly; SameSite=Strict"

    def _same(self, value: str) -> bool:
        # compare bytes: compare_digest refuses non-ASCII str
        return hmac.compare_digest(value.encode("utf-8", "surrogateescape"), self.token.encode("utf-8"))

    def _token_ok(self, environ: dict) -> bool:
        header = environ.get("HTTP_X_BAMT_TOKEN", "")
        if header and self._same(header):
            return True
        # split the Cookie header by hand: one unparsable cookie from another local page must not hide ours
        name = self._cookie_name()
        for part in environ.get("HTTP_COOKIE", "").split(";"):
            key, sep, value = part.strip().partition("=")
            if sep and key == name and self._same(value.strip().strip('"')):
                return True
        return False

    def _host_ok(self, environ: dict) -> bool:
        host = environ.get("HTTP_HOST", "")
        if self.port is None:
            return True  # in tests the app is called without a server
        return host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}")

    # --- handlers ---

    def _raise(self, environ: dict, method: str, start_response: Callable) -> Iterable[bytes]:
        """A second start of the program on this data directory: bring this instance's window to the front."""
        if method != "POST":
            return self._text(start_response, "405 Method Not Allowed", "method not allowed")
        given = environ.get("HTTP_" + RAISE_HEADER.upper().replace("-", "_"), "")
        if not given or not hmac.compare_digest(given.encode("utf-8", "surrogateescape"),
                                                self.raise_token.encode("utf-8")):
            return self._text(start_response, "403 Forbidden", "forbidden")
        if self.raise_window is not None:
            try:
                self.raise_window()
            except Exception:
                logger.exception("cannot raise the window")
        return self._json(start_response, {})

    def _rpc(self, environ: dict, start_response: Callable) -> Iterable[bytes]:
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self._json(start_response, {"error": {"code": "bad_request", "params": {}}}, "400 Bad Request")
        try:
            body = json.loads(environ["wsgi.input"].read(length))
            name, params = body["method"], body.get("params") or {}
        except (ValueError, KeyError, TypeError):
            return self._json(start_response, {"error": {"code": "bad_request", "params": {}}}, "400 Bad Request")
        return self._json(start_response, self.rpc.call(name, params))

    def _sse(self, start_response: Callable) -> Iterable[bytes]:
        start_response("200 OK", [("Content-Type", "text/event-stream; charset=utf-8"),
                                  ("Cache-Control", "no-store"), ("X-Accel-Buffering", "no")])
        return self.events.stream()

    def _asset(self, path: str, query: dict[str, str], start_response: Callable) -> Iterable[bytes]:
        if self.assets is None:
            return self._text(start_response, "404 Not Found", "not found")
        try:
            res = self.assets(path[len("/asset/"):], query)
        except (KeyError, FileNotFoundError, ServiceError) as e:
            logger.debug("asset %s not found: %r", path, e, exc_info=isinstance(e, OSError))
            return self._text(start_response, "404 Not Found", "not found")
        cache = "private, max-age=86400" if res.light and self.consent() else "no-store"
        return self._respond(start_response, "200 OK", res.body, res.mime, [("Cache-Control", cache)])

    def _static(self, path: str, start_response: Callable) -> Iterable[bytes]:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        # check the path itself, not where it resolves to: a macOS app bundle keeps some folders of the page as
        # symlinks into Contents/Resources, which are part of the page all the same
        parts = PurePosixPath(rel).parts
        if not parts or any(p in ("", ".", "..") or "\\" in p or ":" in p for p in parts):
            return self._text(start_response, "404 Not Found", "not found")
        file = self.static_dir.joinpath(*parts)
        if not file.is_file():
            return self._text(start_response, "404 Not Found", "not found")
        mime = MIME.get(file.suffix.lower()) or mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        return self._respond(start_response, "200 OK", file.read_bytes(), mime, [("Cache-Control", "no-cache")])

    # --- responses ---

    @staticmethod
    def _respond(start_response: Callable, status: str, body: bytes, mime: str,
                 headers: list[tuple[str, str]] | None = None) -> list[bytes]:
        base = [("Content-Type", mime), ("Content-Length", str(len(body))), ("X-Content-Type-Options", "nosniff")]
        start_response(status, base + (headers or []))
        return [body]

    def _json(self, start_response: Callable, data: Any, status: str = "200 OK") -> list[bytes]:
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return self._respond(start_response, status, body, "application/json", [("Cache-Control", "no-store")])

    def _text(self, start_response: Callable, status: str, text: str) -> list[bytes]:
        return self._respond(start_response, status, text.encode("utf-8"), "text/plain; charset=utf-8")


class _ThreadingServer(socketserver.ThreadingMixIn, WSGIServer):
    daemon_threads = True
    request_queue_size = 256
    allow_reuse_address = True


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        logger.debug("%s - %s", self.address_string(), format % args)


class Server:
    """Runs a WebApp on 127.0.0.1 in a background thread."""

    def __init__(self, app: WebApp, port: int = 0):
        self.app = app
        self.httpd = make_server("127.0.0.1", port, app, server_class=_ThreadingServer, handler_class=_QuietHandler)
        self.port = self.httpd.server_port
        app.port = self.port
        self._thread = threading.Thread(target=self.httpd.serve_forever, name="bamt-http", daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?t={self.app.token}"

    def start(self) -> "Server":
        self._thread.start()
        return self

    def stop(self) -> None:
        self.app.events.close()
        self.httpd.shutdown()
        self.httpd.server_close()
