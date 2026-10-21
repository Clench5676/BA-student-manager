"""pywebview-only features: the window, file dialogs and dropped file paths."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"


def pick_files(window: Any, file_types: Iterable[str] = (), multiple: bool = True) -> list[Path]:
    """The native open-file dialog. ``file_types`` entries look like ``"Bundle (*.bundle;*.backup)"``."""
    import webview

    result = window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=multiple, file_types=tuple(file_types))
    return [Path(p) for p in result or ()]


def pick_folder(window: Any, multiple: bool = True) -> list[Path]:
    """The native folder dialog, with the same cancellation shape as pick_files."""
    import webview

    result = window.create_file_dialog(webview.FileDialog.FOLDER, allow_multiple=multiple)
    return [Path(p) for p in result or ()]


def watch_drops(window: Any, on_paths: Callable[[list[str]], None]) -> None:
    """Report the full paths of files dropped on the page. pywebview only adds the paths when the drop handler is
    registered from Python."""
    from webview.dom import DOMEventHandler

    def on_drop(event: dict) -> None:
        files = event.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if paths:
            on_paths(paths)

    def noop(_event: dict) -> None:
        pass

    doc = window.dom.document
    doc.events.dragenter += DOMEventHandler(noop, True, True)
    doc.events.dragstart += DOMEventHandler(noop, True, True)
    doc.events.dragover += DOMEventHandler(noop, True, True, debounce=500)
    doc.events.drop += DOMEventHandler(on_drop, True, True)


def renderer_supported(renderer: str) -> bool:
    """pywebview falls back to MSHTML (Internet Explorer) without WebView2; the front end cannot run there."""
    return renderer not in ("mshtml",)
