"""The RPC methods the front end calls (see the RPC table in docs/web-ui.md)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ..config import user_cache_dir
from ..errors import ServiceError
from ..i18n import get_locale_dir, i18n_manager
from ..utils import get_version_info
from .rpc import RpcRegistry, to_json
from .services import Services
from .system import open_classic, reveal

UI_LANGS = ("zh-CN", "zh-TW", "en-US", "ja-JP")


def ui_strings(lang: str) -> dict[str, str]:
    """The ``webui.*`` strings for a language, falling back key by key like the Python side does."""
    fallback = "zh-CN" if lang.startswith("zh-") else "en-US"
    out: dict[str, str] = {}
    for code in dict.fromkeys((fallback, lang)):  # fallback first, the language itself wins
        path = get_locale_dir() / f"{code}.json"
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


def _url_bg(name: str | None) -> str | None:
    return f"/asset/art/bg/{name}" if name else None


def _url_portrait(name: str | None) -> str | None:
    return f"/asset/art/portrait/{name}.png" if name else None


def build_api(s: Services) -> RpcRegistry:
    rpc = RpcRegistry()

    # --- app ---

    @rpc.method("app.info")
    def app_info() -> dict[str, Any]:
        found = s.game_found()
        return {
            "version": get_version_info().get("version"),
            "language": i18n_manager.lang,
            "platform": sys.platform,
            "gameFound": found,
            "resourceVersion": s.game.resource_version if found else None,
            "consent": s.state.consent,
            "cacheDir": str(user_cache_dir()),
            "dataDir": str(s.data_dir),
            "native": s.window is not None,
        }

    @rpc.method("app.consent")
    def app_consent(granted: bool) -> None:
        s.set_consent(bool(granted))
        if not granted and s.window is not None:
            s.window.destroy()

    @rpc.method("app.openClassic")
    def app_open_classic(tab: str | None = None) -> None:
        open_classic(tab)

    @rpc.method("i18n.strings")
    def i18n_strings(lang: str | None = None) -> dict[str, str]:
        return ui_strings(lang or i18n_manager.lang)

    # --- students ---

    def variant_json(v: Any, mods: dict[str, list], favorites: set[str], recent: list[str],
                     modified: dict[str, str] | None = None) -> dict[str, Any]:
        own = mods.get(v.key, [])
        return {
            "key": v.key, "fileId": v.file_id, "family": v.family, "names": v.names, "playable": v.playable,
            "order": v.order, "spr": v.spr, "lobby": v.lobby, "date": v.date,
            "bg": _url_bg(v.bg), "portrait": _url_portrait(v.portrait),
            "favorite": v.key in favorites, "mods": len(own), "fresh": any(m.fresh for m in own),
            "recent": recent.index(v.key) if v.key in recent else None,
            # the portrait game file carries something other than the official portrait (a mod or another variant)
            "replaced": (modified or {}).get(v.key),
        }

    def mods_by_target() -> dict[str, list]:
        out: dict[str, list] = {}
        for m in s.library.mods():
            out.setdefault(m.target, []).append(m)
        return out

    @rpc.method("roster.list")
    def roster_list() -> dict[str, Any]:
        if not s.game_found():
            raise ServiceError("game_not_found")
        mods, favorites, recent = mods_by_target(), s.library.favorites(), s.state.recent()
        modified = s.library.modified()
        families = []
        for f in s.catalog.families():
            families.append({"key": f.key, "base": f.names, "school": f.school,
                             "variants": [variant_json(v, mods, favorites, recent, modified) for v in f.variants]})
        return {"families": families}

    @rpc.method("family.get")
    def family_get(key: str) -> dict[str, Any]:
        f = s.catalog.family(key)
        mods, favorites, recent = mods_by_target(), s.library.favorites(), s.state.recent()
        variants = []
        for v in f.variants:
            item = variant_json(v, mods, favorites, recent)
            item["state"] = to_json(s.library.state(v.key))
            item["modList"] = [to_json(m) for m in mods.get(v.key, [])]
            variants.append(item)
        return {"key": f.key, "base": f.names, "school": f.school, "variants": variants}

    @rpc.method("favorites.set")
    def favorites_set(variant: str, on: bool) -> None:
        s.library.set_favorite(variant, bool(on))
        s.events.publish("library.changed")

    @rpc.method("ui.visit")
    def ui_visit(variant: str) -> None:
        s.state.visit(variant)

    # --- mods ---

    @rpc.method("mods.add")
    def mods_add(paths: list[str]) -> list[Any]:
        added = s.library.add([Path(p) for p in paths])
        s.events.publish("library.changed")
        return added

    @rpc.method("mods.pick")
    def mods_pick() -> list[Any]:
        if s.window is None:
            raise ServiceError("native_unavailable")
        from .native import pick_files

        paths = pick_files(s.window, ("Bundle (*.bundle;*.backup)",))
        return mods_add([str(p) for p in paths]) if paths else []

    @rpc.method("mods.remove")
    def mods_remove(id: str) -> None:
        s.library.remove(id)
        s.events.publish("library.changed")

    @rpc.method("mods.rename")
    def mods_rename(id: str, label: str) -> None:
        s.library.rename(id, label)
        s.events.publish("library.changed")

    @rpc.method("mods.seen")
    def mods_seen(id: str) -> None:
        s.library.mark_seen(id)
        s.events.publish("library.changed")

    # --- actions (jobs) ---

    def after_change(result: Any) -> Any:
        s.events.publish("library.changed")
        return result

    @rpc.method("actions.apply")
    def actions_apply(variant: str, source: str) -> str:
        return s.jobs.submit("apply", lambda log, progress, **p: after_change(s.library.apply(log=log, progress=progress, **p)),
                             variant_key=variant, source=source)

    @rpc.method("actions.restore")
    def actions_restore(variant: str) -> str:
        return s.jobs.submit("restore", lambda log, progress, **p: after_change(s.library.restore(log=log, **p)),
                             variant_key=variant)

    @rpc.method("actions.update")
    def actions_update(mod: str) -> str:
        return s.jobs.submit("update", lambda log, progress, **p: after_change(s.library.update(log=log, progress=progress, **p)),
                             mod_id=mod)

    @rpc.method("actions.extract")
    def actions_extract(target: str) -> str:
        out_dir = s.settings.output_subdir("extract")
        return s.jobs.submit("extract", lambda log, progress, **p: {"folder": str(s.library.extract(log=log, **p))},
                             target=target, out_dir=out_dir)

    @rpc.method("actions.compare")
    def actions_compare(mod: str) -> Any:
        return s.library.compare(mod)

    @rpc.method("jobs.get")
    def jobs_get(id: str) -> dict[str, Any]:
        job = s.jobs.get(id)
        return {**job.to_json(), "log": job.log[-500:]}

    # --- system ---

    @rpc.method("os.reveal")
    def os_reveal(path: str) -> None:
        reveal(path)

    return rpc
