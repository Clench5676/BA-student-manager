"""The web UI's locale strings on the Python side: for the page (``i18n.strings``) and for what the Python side names
itself (the install labels of ``mods.state``, the tray menu)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..i18n import fallback_language, get_locale_dir


def ui_strings(lang: str, locale_dir: Path | None = None, *, fallback: bool = True) -> dict[str, str]:
    """The ``webui.*`` strings, falling back by default; disable fallback for locale completeness checks."""
    folder = locale_dir or get_locale_dir()
    out: dict[str, str] = {}
    codes = dict.fromkeys((fallback_language(lang), lang)) if fallback else (lang,)
    for code in codes:  # fallback first, the language itself wins
        path = folder / f"{code}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8")).get("webui", {})
        except (OSError, ValueError):
            continue
        _flatten(data, "webui", out)
    return out


def _flatten(node: Any, prefix: str, out: dict[str, str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            _flatten(v, f"{prefix}.{k}", out)
    elif isinstance(node, str):
        out[prefix] = node


def fill(text: str, **values: Any) -> str:
    """A string with its ``{name}`` placeholders filled, as the page's ``T`` does."""
    for name, value in values.items():
        text = text.replace("{" + name + "}", str(value))
    return text


def install_label(strings: dict[str, str], server: str, distinct: str | None) -> str:
    """An install's label: its server's name, with the folder that tells it from another install of that server
    (``mods.installNamed``, "Global (BlueArchive)")."""
    name = strings.get(f"webui.settings.server.{server}", server)
    if not distinct:
        return name
    return fill(strings.get("webui.mods.installNamed", "{server} ({folder})"), server=name, folder=distinct)
