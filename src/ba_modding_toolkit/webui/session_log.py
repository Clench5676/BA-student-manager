"""The current session's log, shared by logging and the settings viewer."""

from __future__ import annotations

import logging
import re
import tempfile
from pathlib import Path
from urllib.parse import quote, quote_plus

from ..errors import ServiceError

LOG_LINES = 500
LOG_BYTES = 2 * 1024 * 1024
REDACTED = "[redacted]"
_CREDENTIAL = re.compile(
    r'''(?ix)(?<![\w-])(["']?(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key)|authorization|cookie|set-cookie)["']?\s*[:=]\s*)
        ("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)''')
_QUERY = re.compile(r"(?i)([?&](?:t|token|key|access_token|session_token)=)[^\s&#\"']+")
_BEARER = re.compile(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+")
_USERINFO = re.compile(r"(https?://)[^/\s:@]+:[^/\s@]+@", re.I)


def redact(text: str, secrets: set[str]) -> str:
    for secret in sorted((s for s in secrets if len(s) >= 8), key=len, reverse=True):
        for value in {secret, secret.replace(" ", "+"), quote(secret, safe=""), quote_plus(secret)}:
            text = re.sub(r"(?<![\w./%+~-])" + re.escape(value) + r"(?![\w./%+~-])", REDACTED, text)
    text = _QUERY.sub(r"\1" + REDACTED, text)
    text = _BEARER.sub(r"\1 " + REDACTED, text)
    text = _CREDENTIAL.sub(r"\1" + REDACTED, text)
    return _USERINFO.sub(r"\1" + REDACTED + "@", text)


def tail(path: Path, secrets: set[str]) -> str:
    """Read at most 500 lines, with a byte limit too. Drop a partial first line rather than disclose a cut secret."""
    try:
        with path.open("rb") as stream:
            stream.seek(0, 2)
            size = stream.tell()
            start = max(0, size - LOG_BYTES)
            stream.seek(start)
            data = stream.read(LOG_BYTES)
        if start:
            data = data.partition(b"\n")[2]
        return redact(b"\n".join(data.splitlines()[-LOG_LINES:]).decode("utf-8", errors="replace"), secrets)
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise ServiceError("library_io_error", operation="read", file=path, error=str(error)) from error


class RedactingFormatter(logging.Formatter):
    def __init__(self, secrets: set[str]):
        super().__init__("%(asctime)s %(levelname)s %(name)s: %(message)s")
        self.secrets = secrets

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record), self.secrets)


def open_run_log(path: Path, secrets: set[str], *, safe_mode: bool = False) -> logging.StreamHandler:
    """Rotate once per launch and write the environment before any other records."""
    from .diagnostics import COLLECTION_TIMEOUT, Reports, clean, configured_language, environment, private_text
    import time
    import json

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        for source, target in ((path.with_name("webui.1.log"), path.with_name("webui.2.log")),
                               (path, path.with_name("webui.1.log"))):
            if source.exists():
                source.replace(target)
        handler = logging.FileHandler(path, mode="w", encoding="utf-8")
    except OSError:
        try:
            import os
            fd, name = tempfile.mkstemp(prefix="BAMT-", suffix=".log")
            os.close(fd)
            handler = logging.FileHandler(name, mode="w", encoding="utf-8")
        except OSError:
            handler = logging.StreamHandler()
    handler.setFormatter(RedactingFormatter(secrets))
    def header_values():
        values = environment(safe_mode, configured_language(path.parent))
        app = values.pop("app")
        return {**clean(values, secrets), "app": app, "dataDir": private_text(str(path.parent), secrets)}
    header = Reports(path.parent).optional("environment", header_values, time.monotonic() + COLLECTION_TIMEOUT)
    try:
        handler.stream.write("Environment " + json.dumps(header, ensure_ascii=False) + "\n")
        handler.flush()
    except OSError:
        handler.close()
        handler = logging.StreamHandler()
        handler.setFormatter(RedactingFormatter(secrets))
    return handler
