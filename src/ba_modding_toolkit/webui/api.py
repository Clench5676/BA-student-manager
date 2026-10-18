"""The RPC methods the front end calls (see the RPC table in docs/web-ui.md)."""

from __future__ import annotations

import json
import logging
import sys
import tempfile
import threading
import weakref
import webbrowser
from concurrent.futures import Future
from pathlib import Path
from typing import Any

from .. import globallines, updater
from ..errors import ServiceError
from ..i18n import get_locale_dir, i18n_manager
from ..kivo import clip_id
from ..naming import parse_filename
from ..utils import get_version_info
from .rpc import RpcRegistry, to_json
from .services import Services
from .system import open_classic, reveal

logger = logging.getLogger(__name__)
UI_LANGS = ("zh-CN", "zh-TW", "en-US", "ja-JP")
LINE_LANGS = {"zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja"}  # UI language -> lobby lines key


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


def clip_talks(talks: Any) -> dict[str, list[str]]:
    """The page's {talk animation: [clip ids]}, checked and normalised; {} when absent or malformed."""
    if not isinstance(talks, dict):
        return {}
    return {str(anim): [clip_id(str(c)) for c in ids[:32]] for anim, ids in list(talks.items())[:64]
            if isinstance(ids, list)}


def _background(fn: Any, *args: Any) -> Future:
    """Run fn on a daemon thread (a slow download never holds up quitting); its result as a future."""
    future: Future = Future()

    def run() -> None:
        try:
            future.set_result(fn(*args))
        except BaseException as e:  # handed to the caller
            future.set_exception(e)

    threading.Thread(target=run, name="lobby-lines", daemon=True).start()
    return future


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
            "lobbyZoomOut": bool(s.state.get("lobby_zoom_out", False)),
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
        elif key == "lobbyZoomOut":
            s.state.set("lobby_zoom_out", bool(value))
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

    @rpc.method("loading.list")
    def loading_list(lang: str | None = None) -> dict[str, Any]:
        """The loading screen illustrations for a UI language; none without a game folder or when they cannot be
        read (the loading screen then stays plain)."""
        if not s.game_found():
            return {"lang": None, "images": []}
        try:
            return s.game.loading_list(lang or i18n_manager.lang)
        except (ServiceError, KeyError, OSError):
            logger.warning("Cannot list the loading screen illustrations", exc_info=True)
            return {"lang": None, "images": []}

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

    fingerprints: dict[str, Any] = {}  # the bundle hash cache for model_files, made on first use

    def model_files(core: str | None) -> list[dict[str, Any]]:
        """A 3D chibi's prefab bundles (character-<dev>-_mxload-*), newest first, in the shape of the variant state's
        file parts, with the CRC state by the library's rules (official, fixed by trailing bytes, or needing a fix)."""
        try:
            index = getattr(s.game, "_model_index", None) if core else None
            names = index().get(core.lower(), []) if index else []
        except (ServiceError, OSError):
            return []
        if "cache" not in fingerprints:
            from ..library.storage import Fingerprints

            fingerprints["cache"] = Fingerprints()
        out = []
        for name in names:
            path = Path(name)
            parsed = parse_filename(path.name)
            try:
                fp = fingerprints["cache"].get(path)
            except OSError:
                continue
            matches = bool(parsed.crc) and fp.crc == int(parsed.crc)
            crc = "ok" if matches and fp.trailing == 0 else "fixed" if matches and fp.trailing else "needs_fix"
            out.append({"file": str(path), "kind": "model", "date": parsed.date, "size": fp.size, "crc": crc})
        return sorted(out, key=lambda part: (part["date"] or "", part["file"]), reverse=True)

    @rpc.method("family.get")
    def family_get(key: str) -> dict[str, Any]:
        f = s.catalog.family(key)
        mods, favorites, recent = mods_by_target(), s.library.favorites(), s.state.recent()
        variants = []
        for v in f.variants:
            item = variant_json(v, mods, favorites, recent)
            item["state"] = to_json(s.library.state(v.key))
            item["modList"] = [to_json(m) for m in mods.get(v.key, [])]
            item["modelFiles"] = model_files(v.model)
            variants.append(item)
        # the game's resource version tells installs apart (another game folder or file source): the page then reads
        # every part of a variant again, even under the same variant key
        return {"key": f.key, "base": f.names, "school": f.school, "variants": variants,
                "version": s.game.resource_version if s.game_found() else None}

    warmed: dict[str, Any] = {"game": None}
    warm_lock = threading.Lock()

    @rpc.method("lobby.warm")
    def lobby_warm() -> None:
        """Build the memorial lobby prefab index in the background (its first build reads every lobby element bundle,
        about 8 s), once per game, so the first lobby shown does not wait for it. Nothing without a game."""
        if not s.game_found():
            return
        game = s.game
        with warm_lock:
            if warmed["game"] is not None and warmed["game"]() is game:
                return
            warmed["game"] = weakref.ref(game)

        def build() -> None:
            try:
                game._lobby_prefabs()
            except Exception:  # the lobby builds it again when it needs it
                logger.debug("Cannot build the memorial lobby prefab index", exc_info=True)

        threading.Thread(target=build, name="lobby-warm", daemon=True).start()

    @rpc.method("lobby.lines")
    def lobby_lines(variant: str, talks: dict[str, list[str]] | None = None, lang: str | None = None) -> dict[str, Any]:
        """The memorial lobby's lines by voice clip ({clip: {lang: text, "voice": bool}}): Kivo's (zh-CN, ja, the
        voices) and, for a ``lang`` other than zh-CN, the Global server's official text on the clips of each talk
        animation (``talks``: {animation: [clip ids in order]} from the skeleton, else Kivo's clip names).
        ``lines_unavailable`` when neither can be read."""
        v = s.catalog.variant(variant)
        lang = lang or LINE_LANGS.get(i18n_manager.lang, "en")
        character = getattr(v, "schale_id", None)
        # the Global table (a download the first time) is read while Kivo's page is
        pending = _background(s.global_lines.dialogues, character) if lang != "zh-CN" and character else None
        try:
            kivo = s.kivo.lines(v.page_id or "")
        except ServiceError:
            kivo = None
        official: dict[str, dict[str, str]] = {}
        if pending is not None:
            try:
                official = globallines.by_clip(pending.result(), clip_talks(talks) or globallines.talks_of(kivo or {}))
            except ServiceError:
                pass
        if kivo is None and not official:
            raise ServiceError("lines_unavailable")
        return globallines.merge(kivo or {}, official)

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
