"""The RPC methods the front end calls (see the RPC table in docs/web-ui.md)."""

from __future__ import annotations

import json
import sys
import tempfile
import webbrowser
from pathlib import Path
from typing import Any

from .. import updater
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
            "cacheDir": str(s.cache_dir()),
            "dataDir": str(s.data_dir),
            "native": s.window is not None,
            "compiled": updater.is_compiled(),
            "mute": s.mute,
        }

    @rpc.method("app.consent")
    def app_consent(granted: bool) -> None:
        s.set_consent(bool(granted))
        if not granted and s.window is not None and not s.jobs.busy():
            s.window.destroy()

    @rpc.method("app.openClassic")
    def app_open_classic(tab: str | None = None) -> None:
        open_classic(tab)

    # --- updates ---

    @rpc.method("app.checkUpdate")
    def app_check_update() -> Any:
        s.update_info = updater.check()
        return s.update_info

    @rpc.method("app.update")
    def app_update() -> str:
        info = getattr(s, "update_info", None)
        if info is None or not info.installable:
            raise ServiceError("update_unsupported")
        dest = Path(tempfile.mkdtemp(prefix="bamt-update-"))

        def download(log: Any, progress: Any) -> dict[str, str]:
            path, md5 = updater.download(info, dest, progress)
            s.update_file = (path, md5)  # what installUpdate may swap in
            return {"file": str(path)}

        return s.jobs.submit("update.download", download)

    @rpc.method("app.openReleasePage")
    def app_open_release_page() -> None:
        info = getattr(s, "update_info", None)
        if info is None or not info.page.startswith(f"https://github.com/{updater.REPO}/"):
            raise ServiceError("update_unavailable")
        webbrowser.open(info.page)

    @rpc.method("app.installUpdate")
    def app_install_update(file: str) -> None:
        # only the build this session downloaded and verified, only in the app window (it has to quit to be
        # replaced), and never while a job writes into the game folder
        downloaded = getattr(s, "update_file", None)
        if s.window is None:
            raise ServiceError("update_unsupported")
        if downloaded is None or Path(file) != downloaded[0] or not downloaded[0].is_file():
            raise ServiceError("update_unavailable")
        if s.jobs.busy():
            raise ServiceError("busy")
        updater.install(downloaded[0], downloaded[1])
        s.window.destroy()

    # --- settings (the popup behind the top bar's settings button) ---

    LANGUAGES = ("zh-CN", "en-US")

    def language_name(code: str) -> str:
        # each language is named in itself (webui.languageName of its own locale file)
        return ui_strings(code).get("webui.languageName", code)

    @rpc.method("settings.get")
    def settings_get() -> dict[str, Any]:
        st = s.settings
        return {
            "language": i18n_manager.lang, "languages": [{"code": c, "name": language_name(c)} for c in LANGUAGES],
            "fileSource": st.get("file_source"),
            "gameDirs": {"global": st.get("game_resource_dir"), "japan": st.get("game_resource_dir_japan")},
            "gameFound": s.game_found(), "libraryDir": str(s.library_dir()), "outputDir": st.get("output_dir"),
            "voiceVolume": int(s.state.get("voice_volume", 80)), "voiceMuted": bool(s.state.get("voice_muted", False)),
            "consent": s.state.consent, "cacheDir": str(s.cache_dir()),
            "version": get_version_info().get("version"), "native": s.window is not None,
        }

    @rpc.method("settings.set")
    def settings_set(key: str, value: Any) -> dict[str, Any]:
        st = s.settings
        if key == "language":
            if value not in LANGUAGES:
                raise ServiceError("bad_params", key=key)
            st.set("language", value)
            st.save()
            i18n_manager.set_language(value)
        elif key == "fileSource":
            if value not in ("windows_global", "windows_japan"):
                raise ServiceError("bad_params", key=key)
            st.set("file_source", value)
            st.save()
            s.reload_game()
        elif key in ("gameDir.global", "gameDir.japan"):
            path = Path(str(value)).expanduser()
            from ..searching import get_search_dirs

            if not path.is_dir() or not get_search_dirs(path):
                raise ServiceError("game_not_found")
            st.set("game_resource_dir" if key.endswith("global") else "game_resource_dir_japan", str(path))
            st.save()
            s.reload_game()
        elif key == "outputDir":
            path = Path(str(value)).expanduser()
            path.mkdir(parents=True, exist_ok=True)
            st.set("output_dir", str(path))
            st.save()
        elif key == "libraryDir":
            s.move_library(Path(str(value)))
        elif key == "cacheDir":
            s.set_cache_parent(Path(str(value)))
        elif key == "voiceVolume":
            s.state.set("voice_volume", max(0, min(100, int(value))))
        elif key == "voiceMuted":
            s.state.set("voice_muted", bool(value))
        else:
            raise ServiceError("bad_params", key=key)
        return settings_get()

    @rpc.method("settings.detectGame")
    def settings_detect_game(region: str) -> list[str]:
        if region not in ("global", "japan"):
            raise ServiceError("bad_params", region=region)
        from ..game_paths import find_game_dirs

        return [str(p) for p in find_game_dirs(region)]

    @rpc.method("settings.pickFolder")
    def settings_pick_folder(start: str | None = None) -> str | None:
        if s.window is None:
            raise ServiceError("native_unavailable")
        import webview

        result = s.window.create_file_dialog(webview.FileDialog.FOLDER, directory=start or "")
        return str(result[0]) if result else None

    @rpc.method("settings.clearCache")
    def settings_clear_cache() -> None:
        s.cache.clear()

    @rpc.method("i18n.strings")
    def i18n_strings(lang: str | None = None) -> dict[str, str]:
        return ui_strings(lang or i18n_manager.lang)

    # --- students ---

    def variant_json(v: Any, mods: dict[str, list], favorites: set[str], recent: list[str],
                     modified: dict[str, str] | None = None) -> dict[str, Any]:
        own = mods.get(v.key, [])
        return {
            "key": v.key, "fileId": v.file_id, "family": v.family, "names": v.names, "playable": v.playable,
            "recruitable": v.recruitable,  # on the selected server; playable is on some server
            "order": v.order, "spr": v.spr, "lobby": v.lobby, "date": v.date, "model": v.model,
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

    @rpc.method("lobby.lines")
    def lobby_lines(variant: str) -> dict[str, Any]:
        """The memorial lobby's lines by voice clip, from Kivo (``lines_unavailable`` offline)."""
        v = s.catalog.variant(variant)
        lines = s.kivo.lines(v.page_id or "")
        return {clip: {"zh-CN": line["zh-CN"], "ja": line["ja"], "voice": bool(line["audio"])} for clip, line in lines.items()}

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
    def actions_apply(variant: str, source: str, kind: str = "spr") -> str:
        """Put a source on the variant's portrait ("spr") or memorial lobby ("lobby") game files."""
        if kind not in ("spr", "lobby"):
            raise ServiceError("bad_params", kind=kind)
        return s.jobs.submit("apply", lambda log, progress, **p: after_change(s.library.apply(log=log, progress=progress, **p)),
                             variant_key=variant, source=source, kind=kind)

    @rpc.method("actions.restore")
    def actions_restore(variant: str, kind: str = "spr") -> str:
        if kind not in ("spr", "lobby"):
            raise ServiceError("bad_params", kind=kind)
        return s.jobs.submit("restore", lambda log, progress, **p: after_change(s.library.restore(log=log, **p)),
                             variant_key=variant, kind=kind)

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
