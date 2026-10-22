"""Local, bounded diagnostic reports. No upload and no game/library initialization."""

from __future__ import annotations

import getpass
import json
import locale
import logging
import os
import platform
import re
import sys
import threading
import time
import traceback
import zipfile
from collections import Counter, deque
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .. import devmode, updater
from ..i18n import i18n_manager
from . import native, system
from .session_log import redact

logger = logging.getLogger(__name__)
LOG_CAP = 512 * 1024
DATA_CAP = 256 * 1024
LOG_NAMES = ("webui.log", "webui.1.log", "webui.2.log")
CRASH_NAME = "last-backend-error.json"
# Asset names are unnecessary for diagnostics; retain extensions and each occurrence.
_ASSET = re.compile(r'''(?i)(?<![^\s\[\]<>"'=,;])[^\s\[\]<>"'=,;]+?\.(?:bundle(?:\.backup)?|backup|skel|atlas|png|jpg|jpeg|webp|zip|glb|fbx|wav|ogg|mp3)(?![\w.])''')
_QUOTED_ASSET = re.compile(r'''(?i)(["'])[^"'\r\n]+\.(bundle(?:\.backup)?|backup|skel|atlas|png|jpg|jpeg|webp|zip|glb|fbx|wav|ogg|mp3)\1''')
_HOME = re.compile(r"(?i)(?:[A-Z]:[/\\](?:Users|Documents and Settings)[/\\]|/(?:Users|home)/)[^/\\\s\"']+")


def private_text(text: str, secrets: set[str]) -> str:
    home = str(Path.home())
    for value in (home, home.replace("\\", "/"), quote(home, safe=""), quote(home)):
        text = text.replace(value, "~")
    text = _HOME.sub("~", text)
    for name in {getpass.getuser(), Path.home().name, os.environ.get("USERNAME", "")} - {"", "root"}:
        text = re.sub(r"(?<![\w])" + re.escape(name) + r"(?![\w])", "[user]", text, flags=re.I)
    text = _QUOTED_ASSET.sub(lambda m: m[1] + "[asset]." + m[2] + m[1], text)
    text = _ASSET.sub(lambda m: "[asset]" + (".bundle.backup" if m[0].lower().endswith(".bundle.backup") else
                                              "." + m[0].rsplit(".", 1)[-1]), text)
    return redact(text, secrets)


def clean(value: Any, secrets: set[str], depth: int = 0) -> Any:
    if depth > 8:
        return "[truncated]"
    if isinstance(value, dict):
        return {private_text(str(k), secrets)[:100]: ("[redacted]" if re.search(
            r"token|secret|password|passwd|api.?key|authorization|cookie", str(k), re.I) else clean(v, secrets, depth + 1))
                for k, v in list(value.items())[:100]}
    if isinstance(value, (list, tuple, deque)):
        return [clean(v, secrets, depth + 1) for v in list(value)[-40:]]
    if isinstance(value, str):
        # Redact before truncation so a clipped credential cannot survive.
        return private_text(value, secrets)[-8000:]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return clean(str(value), secrets, depth + 1)


def environment(safe_mode: bool = False) -> dict:
    return {"app": {"version": updater.current_version(), "build": "compiled" if updater.is_compiled() else "source"},
            "os": {"name": platform.system(), "version": platform.version(), "arch": platform.machine()},
            "locale": locale.getlocale()[0], "language": i18n_manager.lang,
            "webview": native.engine_info(), "safeMode": safe_mode}


def log_tail(path: Path, secrets: set[str]) -> str:
    try:
        with path.open("rb") as stream:
            stream.seek(0, 2)
            start = max(0, stream.tell() - LOG_CAP)
            stream.seek(start)
            data = stream.read(LOG_CAP)
        if start:
            data = data.partition(b"\n")[2]
        text = private_text(data.decode("utf-8", errors="replace"), secrets)
        bounded = text.encode("utf-8")
        if len(bounded) > LOG_CAP:
            text = bounded[-LOG_CAP:].decode("utf-8", errors="ignore")
            start = 1
        return ("[Earlier log content truncated]\n" if start else "") + text
    except OSError:
        return "[Log unavailable]\n"


class Reports:
    def __init__(self, data_dir: Path, *, services: Any = None, safe_mode: bool = False):
        self.data_dir, self.services, self.safe_mode = Path(data_dir), services, safe_mode
        self.secrets: set[str] = set()
        self.frontend: dict = {}
        self.errors: deque = deque(maxlen=20)
        self.last_job: dict | None = None
        self.game: dict = {"found": None, "server": None, "platform": None, "resourceVersion": None}
        self._seen: dict[str, float] = {}
        self._times: deque = deque()
        self._lock = threading.RLock()
        self._writing = threading.Lock()
        self._crash_at = -float("inf")

    def frontend_event(self, event: dict | None = None, context: dict | None = None) -> bool:
        now = time.monotonic()
        with self._lock:
            if isinstance(context, dict):
                self.frontend = clean({k: context[k] for k in ("page", "phase", "userAgent", "screen", "webgl", "timings")
                                       if k in context}, self.secrets)
            if not isinstance(event, dict):
                return False
            item = clean({k: event[k] for k in ("message", "stack", "page", "phase", "kind", "source") if k in event}, self.secrets)
            key = json.dumps(item, sort_keys=True)
            self._seen = {k: t for k, t in self._seen.items() if now - t < 60}
            while self._times and now - self._times[0] >= 60:
                self._times.popleft()
            if key in self._seen or len(self._times) >= 10:
                return False
            self._seen[key] = now
            self._times.append(now)
            self.errors.append({"at": datetime.now().astimezone().isoformat(timespec="seconds"), **item})
        logger.error("Frontend %s", json.dumps(item, ensure_ascii=False))
        return True

    def job_finished(self, job: Any) -> None:
        if job.state == "failed":
            self.last_job = clean({"kind": job.kind, **(job.error or {})}, self.secrets)
            logger.error("Failed job %s", json.dumps(self.last_job, ensure_ascii=False))

    def library_counts(self) -> dict | None:
        s = self.services
        if s is None:
            return None
        # Read persisted metadata only; taking the library lock could hang a report during failed work.
        path = s.library_dir() / "state.json"
        try:
            devmode.check_read(path)
            with path.open("rb") as stream:
                raw = stream.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                return None
            data = json.loads(raw)
            mods = data.get("mods", {})
            items = mods.values() if isinstance(mods, dict) else mods
            counts = Counter(m.get("kind", "other") for m in items if isinstance(m, dict))
            return {kind: counts.get(kind, 0) for kind in ("spr", "lobby", "model", "other")}
        except FileNotFoundError:
            return {kind: 0 for kind in ("spr", "lobby", "model", "other")}
        except (OSError, ValueError, TypeError, AttributeError):
            return None

    def snapshot(self) -> dict:
        s = self.services
        with self._lock:
            data = {**environment(self.safe_mode), "created": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "privacy": "Redacted: home paths, user names, credentials and asset filenames. Local only; no upload.",
                    "game": dict(self.game), "frontend": dict(self.frontend), "frontendErrors": list(self.errors),
                    "lastFailedJob": self.last_job, "libraryCounts": self.library_counts(),
                    "consent": {"uiAssets": s.state.consent, "spine": s.state.spine_consent} if s else None,
                    "timings": s.timings.snapshot() if s else {}}
        try:
            with (self.data_dir / CRASH_NAME).open("rb") as stream:
                data["previousBackendError"] = json.loads(stream.read(DATA_CAP))
        except (OSError, ValueError):
            data["previousBackendError"] = None
        return clean(data, self.secrets)

    def generate(self, *, automatic: bool = False) -> dict:
        with self._writing:
            data = self.snapshot()
            last = data["lastFailedJob"] or {}
            phase = data["frontend"].get("phase", "startup")
            latest = data["frontendErrors"][-1] if data["frontendErrors"] else {}
            reason = " ".join(str(last.get("code") or latest.get("message") or phase).split())[:160]
            summary = (f"BAMT {data['app']['version']} | {data['os']['name']} {data['os']['arch']} | {data['language']}\n"
                       f"{reason} | Safe mode: {self.safe_mode}\n")
            data = {"summary": summary, **data}
            encoded = json.dumps(data, ensure_ascii=False, indent=2)
            # A malicious error payload must not inflate the archive. Keep the latest bounded fields.
            for field in ("previousBackendError", "frontendErrors", "lastFailedJob", "frontend", "timings"):
                if len(encoded.encode("utf-8")) <= DATA_CAP:
                    break
                data[field] = "[Truncated]"
                encoded = json.dumps(data, ensure_ascii=False, indent=2)
            report = summary + "\n" + "\n\n".join(
                f"[{key}]\n{json.dumps(value, ensure_ascii=False, indent=2)}" for key, value in data.items() if key != "summary")
            version = re.sub(r"[^A-Za-z0-9.+-]", "_", str(data["app"]["version"]))
            stem = f"BAMT-report-{version}-{datetime.now():%Y%m%d-%H%M}" + ("-auto" if automatic else "")
            folders = [self.data_dir] if automatic else [*native.report_folders(), self.data_dir]
            error = None
            for folder in dict.fromkeys(folders):
                path, created = None, False
                try:
                    if folder == self.data_dir:
                        folder.mkdir(parents=True, exist_ok=True)
                    if not folder.is_dir():
                        continue
                    for number in range(1000):
                        path = folder / f"{stem}{'-' + str(number) if number else ''}.zip"
                        try:
                            stream = path.open("xb")
                            created = True
                            break
                        except FileExistsError:
                            continue
                    else:
                        raise OSError("Report names exhausted")
                    with stream, zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                        archive.writestr("report.txt", report)
                        archive.writestr("report.json", encoded)
                        for name in LOG_NAMES:
                            archive.writestr(name, log_tail(self.data_dir / name, self.secrets))
                    break
                except OSError as exc:
                    error = exc
                    if created:
                        try:
                            path.unlink(missing_ok=True)
                        except OSError:
                            pass
            else:
                raise OSError("No writable report folder") from error
            result = {"path": str(path), "summary": summary, "copied": False, "revealed": False}
            if not automatic:
                for action, fn, value in (("copied", native.copy_text, summary), ("revealed", system.reveal, path)):
                    try:
                        fn(value)
                        result[action] = True
                    except Exception:
                        logger.warning("Report %s unavailable", action, exc_info=True)
            return result

    def backend_exception(self, exc_type: type, exc: BaseException, tb: Any) -> None:
        # One automatic report per minute. Keep one snapshot for the next user report, without recursive archives.
        now = time.monotonic()
        with self._lock:
            if now - self._crash_at < 60:
                return
            self._crash_at = now
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            data = self.snapshot()
            data.pop("previousBackendError", None)
            data["error"] = private_text("".join(traceback.format_exception(exc_type, exc, tb)), self.secrets)[-32000:]
            encoded = json.dumps(data, ensure_ascii=False)
            for field in ("frontendErrors", "frontend", "lastFailedJob", "timings"):
                if len(encoded.encode("utf-8")) <= DATA_CAP:
                    break
                data[field] = "[Truncated]"
                encoded = json.dumps(data, ensure_ascii=False)
            (self.data_dir / CRASH_NAME).write_text(encoded, encoding="utf-8")
            self.generate(automatic=True)
            reports = sorted((p for p in self.data_dir.glob("BAMT-report-*.zip")
                              if re.search(r"-\d{8}-\d{4}-auto(?:-\d+)?\.zip$", p.name)),
                             key=lambda p: p.stat().st_mtime)
            for path in reports[:-3]:
                path.unlink()
        except Exception:
            logger.warning("Automatic report unavailable", exc_info=True)


def install_exception_hooks(reports: Reports):
    previous, previous_thread = sys.excepthook, threading.excepthook

    def exception(kind, value, tb):
        reports.backend_exception(kind, value, tb)
        previous(kind, value, tb)

    def thread_exception(args):
        reports.backend_exception(args.exc_type, args.exc_value, args.exc_traceback)
        previous_thread(args)

    sys.excepthook, threading.excepthook = exception, thread_exception

    def restore():
        sys.excepthook, threading.excepthook = previous, previous_thread

    return restore
