"""The RPC methods the front end calls (see the RPC table in docs/web-ui.md)."""

from __future__ import annotations

import json
import logging
import math
import sys
import tempfile
import threading
import time
import weakref
import webbrowser
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any

from .. import devmode, globallines, updater
from ..errors import ServiceError
from ..i18n import get_locale_dir, i18n_manager, offered_languages, t
from ..kivo import clip_id
from ..library.storage import trailing_bytes
from ..naming import parse_filename
from ..utils import get_version_info
from . import strings
from .rpc import RpcRegistry, to_json
from .services import Services
from .session_log import tail
from .state import ALIAS_LENGTH, ALIAS_MAX, LOBBY_ZOOM_MODES, alias_key, alias_text, is_number, lobby_zoom, roster_view
from .system import reveal

logger = logging.getLogger(__name__)
trace_logger = logging.getLogger("ba_modding_toolkit.webui.trace")
TRACE_BATCH, TRACE_LINE = 100, 600  # events per debug.trace call, characters per logged event
# UI language -> lobby lines key (globallines.COLUMNS: the Global server's en, zh-TW, ko; ja from Kivo, else Global)
LINE_LANGS = {"zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja", "ko-KR": "ko"}
# seconds lobby.lines waits for the Global table (a download the first time); it answers with Kivo's lines after that,
# so a slow download never holds the page's connections (the table keeps coming in for the next lobby)
LINES_WAIT = 3.0


def ui_strings(lang: str) -> dict[str, str]:
    """The ``webui.*`` strings for a language, falling back key by key like the Python side does."""
    return strings.ui_strings(lang, get_locale_dir())


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


# settings.set keys of the boolean preferences (webui/state.py FLAGS)
FLAG_KEYS = {"modSwitchShown": "mod_switch_shown", "tray": "tray", "classicPrompt": "classic_prompt",
             "startupUpdate": "startup_update"}


def build_api(s: Services) -> RpcRegistry:
    rpc = RpcRegistry()

    # --- app ---

    @rpc.method("app.info")
    def app_info() -> dict[str, Any]:
        found = s.game_found()
        version = resource_version() if found else None
        return {
            "version": get_version_info().get("version"),
            "language": i18n_manager.lang,
            "platform": sys.platform,
            "gameFound": found,
            "resourceVersion": version,
            "consent": s.state.consent,
            "uiCached": found and s.ui_cached(version),
            "cacheDir": str(s.cache_dir()),
            "dataDir": str(s.data_dir),
            "native": s.window is not None,
            "compiled": updater.is_compiled(),
            "mute": s.mute,
            "debug": s.debug,
            "startupUpdate": s.state.flag("startup_update"),
        }

    def resource_version() -> str:
        with s.timings.measure("game.resource-version"):
            return s.game.resource_version

    @rpc.method("app.ready")
    def app_ready(timings: dict[str, Any] | None = None) -> None:
        phases = {"boot", "info", "settings", "strings", "fonts", "ui-indexes", "mod-state", "first-screen",
                  "fallback-loading", "sprite-loading"}
        if timings is not None:
            if not isinstance(timings, dict):
                raise ServiceError("bad_params", key="timings")
            for phase in phases:
                value = timings.get(phase)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 86400000:
                    s.timings.record("page." + phase, value / 1000)
        s.ready()

    @rpc.method("app.timings")
    def app_timings() -> dict[str, Any]:
        return s.timings.snapshot()

    @rpc.method("app.log")
    def app_log() -> dict[str, str]:
        return {"path": str(s.log_path), "text": tail(s.log_path, s.log_secrets)}

    @rpc.method("app.consent")
    def app_consent(granted: bool) -> None:
        s.set_consent(bool(granted))
        if not granted and s.window is not None and not s.jobs.busy():
            s.window.destroy()

    @rpc.method("app.quit")
    def app_quit() -> None:
        s.quit()

    # --- the classic window (the bottom bar's entries without a web screen, Settings' More Settings) ---

    @rpc.method("app.openClassic")
    def app_open_classic(tab: str | None = None) -> dict[str, bool]:
        # a game writer job stops at its next write once a classic window is open (a toggle half done): no new window
        # until it ended; an open one is only raised
        def may_start() -> None:
            if s.update_installing or s.jobs.busy("game"):
                raise ServiceError("busy")

        return s.classic.open(tab, may_start=may_start)

    @rpc.method("app.classic")
    def app_classic() -> dict[str, Any]:
        return {**s.classic.status(), "queued": len(s.queue)}

    @rpc.method("classic.front")
    def classic_front() -> dict[str, bool]:
        """The classic modal's Bring to Front: raise the open classic window, never start one."""
        return {"raised": s.classic.bring_to_front()}

    @rpc.method("classic.queue")
    def classic_queue(method: str, params: dict[str, Any] | None = None) -> dict[str, int]:
        return {"queued": s.queue_call(method, params or {})}

    @rpc.method("classic.clearQueue")
    def classic_clear_queue() -> dict[str, Any]:
        s.clear_queue()
        return {}

    # --- updates ---

    def downloaded_update(info: Any) -> Any:
        downloaded = getattr(s, "update_file", None)
        return downloaded if (info is not None and downloaded is not None
                              and downloaded[2] == info.version and downloaded[0].is_file()) else None

    @rpc.method("app.checkUpdate")
    def app_check_update() -> Any:
        info = updater.check()
        s.update_info = info
        if info is None:
            return None
        downloaded = downloaded_update(info)
        return {**info.to_json(), "downloaded": downloaded is not None,
                "file": str(downloaded[0]) if downloaded else None}

    @rpc.method("app.update")
    def app_update() -> str:
        info = getattr(s, "update_info", None)
        if info is None or not info.installable:
            raise ServiceError("update_unsupported")

        def download(log: Any, progress: Any) -> dict[str, str]:
            downloaded = downloaded_update(info)
            if downloaded is not None:
                return {"file": str(downloaded[0])}
            dest = Path(tempfile.mkdtemp(prefix="bamt-update-"))
            path, md5 = updater.download(info, dest, lambda current, total, name: progress(
                current, total, t("webui.progress.download", name=name)))
            s.update_file = (path, md5, info.version)  # what installUpdate may swap in, for this release only
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
        downloaded = downloaded_update(s.update_info)
        if s.window is None:
            raise ServiceError("update_unsupported")
        if downloaded is None or Path(file) != downloaded[0] or not downloaded[0].is_file():
            raise ServiceError("update_unavailable")
        s.install_update(downloaded[0], downloaded[1])

    # --- settings (the popup behind the top bar's settings button) ---

    def language_name(code: str) -> str:
        # each language is named in itself (webui.languageName of its own locale file)
        return ui_strings(code).get("webui.languageName", code)

    @rpc.method("settings.get")
    def settings_get() -> dict[str, Any]:
        st = s.settings
        return {
            "language": i18n_manager.lang,
            "languages": [{"code": c, "name": language_name(c)} for c in offered_languages()],
            "fileSource": st.get("file_source"),
            "gameDirs": {"global": st.get("game_resource_dir"), "japan": st.get("game_resource_dir_japan")},
            "gameFound": s.game_found(), "libraryDir": str(s.library_dir()), "outputDir": st.get("output_dir"),
            "voiceVolume": int(s.state.get("voice_volume", 80)), "voiceMuted": bool(s.state.get("voice_muted", False)),
            # {mode, custom}; before the modes it was a boolean, lobby_zoom_out
            "lobbyZoom": lobby_zoom(s.state.get("lobby_zoom"), s.state.get("lobby_zoom_custom"),
                                    s.state.get("lobby_zoom_out")),
            "lobbyPost": bool(s.state.get("lobby_post", True)),
            "lobbyIntro": bool(s.state.get("lobby_intro", True)),
            "roster": roster_view(s.state.get("roster")),
            "consent": s.state.consent, "cacheDir": str(s.cache_dir()),
            "version": get_version_info().get("version"), "native": s.window is not None,
            "logPath": str(s.log_path),
            # the Enable Mods switch on the main screens, the tray or menu bar icon, the hand-off prompt
            "modSwitchShown": s.state.flag("mod_switch_shown"), "tray": s.state.flag("tray"),
            "classicPrompt": s.state.flag("classic_prompt"), "traySupported": s.tray_supported,
            "startupUpdate": s.state.flag("startup_update"),
        }

    @rpc.method("settings.set")
    def settings_set(key: str, value: Any) -> dict[str, Any]:
        st = s.settings
        if key == "language":
            if value not in offered_languages():
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
            devmode.check_read(path)
            from ..searching import get_search_dirs

            if not path.is_dir() or not get_search_dirs(path):
                raise ServiceError("game_not_found")
            st.set("game_resource_dir" if key.endswith("global") else "game_resource_dir_japan", str(path))
            st.save()
            s.reload_game()
        elif key == "outputDir":
            path = Path(str(value)).expanduser()
            devmode.check_read(path)
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
        elif key == "lobbyZoom":
            if not isinstance(value, str) or value not in LOBBY_ZOOM_MODES:
                raise ServiceError("bad_params", key=key)
            s.state.set("lobby_zoom", value)
        elif key == "lobbyZoomCustom":
            if not is_number(value):
                raise ServiceError("bad_params", key=key)
            s.state.set("lobby_zoom_custom", lobby_zoom(None, value)["custom"])
        elif key == "lobbyPost":
            s.state.set("lobby_post", bool(value))
        elif key == "lobbyIntro":
            s.state.set("lobby_intro", bool(value))
        elif key == "roster":
            s.state.set("roster", roster_view(value))
        elif key in FLAG_KEYS:
            if not isinstance(value, bool):
                raise ServiceError("bad_params", key=key)
            s.state.set(FLAG_KEYS[key], value)
            s.publish_state()
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

    @rpc.method("debug.trace")
    def debug_trace(events: list[Any]) -> None:
        """Input events of the fullscreen lobby, logged when the app was started with --debug (a user's trackpad
        reproduces once and the log tells what the page received)."""
        if not s.debug or not isinstance(events, list):
            return
        for event in events[:TRACE_BATCH]:
            line = json.dumps(event, ensure_ascii=True, separators=(",", ":"), default=str)
            trace_logger.info("%s", line[:TRACE_LINE])

    @rpc.method("preview.failed")
    def preview_failed(url: str = "", step: str = "", error: str = "") -> None:
        """Record bounded browser preview diagnostics in release sessions too."""
        detail = {key: str(value)[:4000] for key, value in {"url": url, "step": step, "error": error}.items()}
        logger.warning("Preview failed: %s", json.dumps(detail, ensure_ascii=True))

    @rpc.method("i18n.strings")
    def i18n_strings(lang: str | None = None) -> dict[str, str]:
        return ui_strings(lang or i18n_manager.lang)

    # --- students ---

    def variant_json(v: Any, mods: dict[str, list], favorites: set[str], recent: list[str], seen: set[str] | None,
                     modified: dict[str, str] | None = None) -> dict[str, Any]:
        own = mods.get(v.key, [])
        return {
            "key": v.key, "fileId": v.file_id, "family": v.family, "names": v.names, "playable": v.playable,
            "aliases": v.aliases,  # the search matches them, the page never shows them (the CN server's names)
            "recruitable": v.recruitable,  # on the selected server; playable is on some server
            "order": v.order, "spr": v.spr, "lobby": v.lobby, "date": v.date, "model": v.model,
            "spineCategory": getattr(v, "spine_category", None),
            "bg": _url_bg(v.bg), "portrait": _url_portrait(v.portrait),
            "favorite": v.key in favorites, "mods": len({getattr(m, "repaired_from", "") or m.id for m in own}),
            "modNames": list(dict.fromkeys(name for m in own for name in (
                getattr(m, "alias", ""), getattr(m, "label", ""), getattr(m, "core", ""),
                Path(getattr(m, "file", "")).name) if name)),
            "fresh": seen is not None and any(m.user_added and m.id not in seen for m in own),
            "modCounts": {kind: len({getattr(m, "repaired_from", "") or m.id for m in own if m.kind == kind})
                          for kind in ("spr", "lobby")},
            "configured": configured_of(v.key),
            # when the newest of its own mods was added (ISO), for the roster's "recently added" sort
            "added": max((m.added for m in own if getattr(m, "added", None)), default=None),
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
    @s.timings.measure("roster.data")
    def roster_list() -> dict[str, Any]:
        if not s.game_found():
            raise ServiceError("game_not_found")
        mods, favorites, recent = mods_by_target(), s.library.favorites(), s.state.recent()
        modified, custom = s.library.modified(), s.state.aliases()
        seen = s.state.seen_mods()
        families = []
        for f in s.catalog.families():
            families.append({"key": f.key, "base": f.names, "aliases": f.aliases, "custom": custom.get(f.key, []),
                             "school": f.school,
                             "variants": [variant_json(v, mods, favorites, recent, seen, modified) for v in f.variants]})
        return {"families": families}

    def model_files(core: str | None) -> list[dict[str, Any]]:
        """A 3D chibi's prefab bundles (character-<dev>-_mxload-*), newest first, in the shape of the variant state's
        file parts, judged cheaply from the header (decision 27): fixed with trailing bytes, else ok. No switch writes
        model bundles, so none shows Needs Fix; a bundle whose header cannot be read is left out."""
        try:
            index = getattr(s.game, "_model_index", None) if core else None
            names = index().get(core.lower(), []) if index else []
        except (ServiceError, OSError):
            return []
        out = []
        for name in names:
            path = Path(name)
            parsed = parse_filename(path.name)
            try:
                size = path.stat().st_size
            except OSError:
                continue
            trailing = trailing_bytes(path)
            if trailing is None:
                continue
            out.append({"file": str(path), "kind": "model", "date": parsed.date, "size": size,
                        "crc": "fixed" if trailing else "ok"})
        return sorted(out, key=lambda part: (part["date"] or "", part["file"]), reverse=True)

    def configured_of(key: str) -> dict[str, str | None]:
        try:
            return s.library.configured(key)
        except ServiceError:
            return {"spr": None, "lobby": None}

    @rpc.method("family.get")
    @s.timings.measure("detail.data")
    def family_get(key: str) -> dict[str, Any]:
        f = s.catalog.family(key)
        mods, favorites, recent = mods_by_target(), s.library.favorites(), s.state.recent()
        seen = s.state.seen_mods()
        variants = []
        for v in f.variants:
            item = variant_json(v, mods, favorites, recent, seen)
            item["state"] = to_json(s.library.state(v.key))
            item["modList"] = [{**to_json(m), "fresh": seen is not None and m.user_added and m.id not in seen}
                               for m in mods.get(v.key, [])]
            item["modelFiles"] = model_files(v.model)
            variants.append(item)
        # the game's resource version tells installs apart (another game folder or file source): the page then reads
        # every part of a variant again, even under the same variant key
        return {"key": f.key, "base": f.names, "aliases": f.aliases, "custom": s.state.aliases().get(f.key, []),
                "school": f.school, "variants": variants,
                "version": s.game.resource_version if s.game_found() else None}

    @rpc.method("aliases.set")
    def aliases_set(family: str, aliases: list[str]) -> list[str]:
        """Keep the user's own aliases of a student (the roster search matches them) and return them as kept: each
        cleaned (state.alias_text), empty and repeated ones dropped. ``alias_too_long`` or ``alias_too_many`` past the
        limits; nothing is kept then."""
        if not isinstance(family, str) or not isinstance(aliases, list) or not all(isinstance(a, str) for a in aliases):
            raise ServiceError("bad_params", key="aliases")
        key = s.catalog.family(family).key
        names = [alias_text(a) for a in aliases]
        if any(len(name) > ALIAS_LENGTH for name in names):
            raise ServiceError("alias_too_long", max=ALIAS_LENGTH)
        if len({alias_key(name) for name in names if name}) > ALIAS_MAX:
            raise ServiceError("alias_too_many", max=ALIAS_MAX)
        return s.state.set_aliases(key, names)

    warmed: dict[str, Any] = {"game": None}
    warm_lock = threading.Lock()

    @rpc.method("lobby.warm")
    def lobby_warm() -> None:
        """Build the memorial lobby prefab index in the background (its first build reads every lobby element bundle,
        about 8 s) and the index of every bundle's CABs (where the particle effects' materials, textures and meshes
        are, about 4 s), once per game, so the first lobby shown does not wait for them. Nothing without a game."""
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
                game._cab_index(everything=True)
            except Exception:  # the lobby builds them again when it needs them
                logger.debug("Cannot build the memorial lobby indexes", exc_info=True)

        threading.Thread(target=build, name="lobby-warm", daemon=True).start()

    @rpc.method("lobby.lines")
    def lobby_lines(variant: str, talks: dict[str, list[str]] | None = None, lang: str | None = None) -> dict[str, Any]:
        """The memorial lobby's lines by voice clip ({clip: {lang: text, "voice": bool}}): Kivo's (zh-CN, ja, the
        voices) and, for a ``lang`` other than zh-CN, the Global server's official text on the clips of each talk
        animation (``talks``: {animation: [clip ids in order]} from the skeleton, else Kivo's clip names).
        ``lines_unavailable`` when neither can be read; the Global text is left out when its table takes longer
        than LINES_WAIT."""
        v = s.catalog.variant(variant)
        lang = lang or LINE_LANGS.get(i18n_manager.lang, "en")
        character = getattr(v, "schale_id", None)
        # the Global table (a download the first time) is read while Kivo's page is
        until = time.monotonic() + LINES_WAIT
        pending = _background(s.global_lines.dialogues, character) if lang != "zh-CN" and character else None
        try:
            kivo = s.kivo.lines(v.page_id or "")
        except ServiceError:
            kivo = None
        official: dict[str, dict[str, str]] = {}
        if pending is not None:
            try:
                table = pending.result(timeout=max(0.0, until - time.monotonic()))
                official = globallines.by_clip(table, clip_talks(talks) or globallines.talks_of(kivo or {}))
            except FutureTimeout:
                logger.info("Global lobby lines not ready after %.0f s: only Kivo's for %s", LINES_WAIT, variant)
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
    def mods_add(paths: list[str], background: bool = False) -> Any:
        # dev mode: refused before the library is built (ModLibrary.add checks again)
        for p in paths:
            devmode.check_read(Path(p))
        if background:
            library = s.library
            pin = library.current_pin()

            def add(log: Any, progress: Any) -> Any:
                if pin:
                    s._check_pin(library, pin)
                return library.add_and_apply([Path(p) for p in paths], progress=progress, pin=pin, log=log)

            return s.submit("mods.add", add, writes="game", library=library)
        library = s.library
        added = library.add_and_apply([Path(p) for p in paths])
        changed = [*added.applied, *added.configured, *added.installed]
        s.events.publish("library.changed", {"cores": sorted({m.core for m in changed}),
                                              "kinds": sorted({m.kind for m in changed}), "mods": True})
        if added or added.installed:
            s.refresh_status(library)
            s.publish_state()
            s.request_scan()
        return added

    @rpc.method("mods.pick")
    def mods_pick(background: bool = False) -> Any:
        if s.window is None:
            raise ServiceError("native_unavailable")
        from .native import pick_files

        paths = pick_files(s.window, ("Bundle (*.bundle;*.backup)",))
        return mods_add([str(p) for p in paths], background) if paths else []

    @rpc.method("mods.removalInfo")
    def mods_removal_info(id: str) -> dict[str, Any]:
        return s.library.removal_info(id)

    @rpc.method("mods.remove")
    def mods_remove(id: str, confirm: bool = False) -> str:
        """Delete a library source as one writer job; game write refusals remain in its result and drift."""
        library = s.library
        return s.submit("mods.remove", lambda log, progress: library.remove(id, confirm=bool(confirm), log=log),
                        writes="library", library=library)

    @rpc.method("mods.rename")
    def mods_rename(id: str, label: str) -> dict[str, Any]:
        entry = s.library.rename(id, label)
        s.events.publish("library.changed", {"cores": [], "kinds": [], "mods": True})
        return entry.to_json()

    @rpc.method("mods.seen")
    def mods_seen(id: str | None = None, ids: list[str] | None = None) -> None:
        if (id is None) == (ids is None):
            raise ServiceError("bad_params", key="ids")
        chosen = [id] if id is not None else ids
        if not isinstance(chosen, list) or not all(isinstance(v, str) and v for v in chosen):
            raise ServiceError("bad_params", key="ids")
        if chosen:
            s.state.mark_mods_seen(chosen)
            s.events.publish("library.changed", {"cores": [], "kinds": [], "mods": True})

    # --- the Enable Mods switch, mods already in use, drift ---

    @rpc.method("mods.state")
    def mods_state() -> dict[str, Any]:
        """The switch's state for every place that shows it, from the snapshot (never through the library lock)."""
        return s.mods_state()

    @rpc.method("mods.toggle")
    def mods_toggle(enabled: bool, expect: bool) -> str:
        """Turn mods off or on in every known install (also Retry: ``expect`` equal to the current intent)."""
        return s.submit_toggle(enabled, expect)

    @rpc.method("mods.consent")
    def mods_consent(granted: bool) -> dict[str, Any]:
        if not isinstance(granted, bool):
            raise ServiceError("bad_params", key="granted")
        s.set_scan_consent(granted)
        return {}

    @rpc.method("mods.explained")
    def mods_explained() -> dict[str, Any]:
        s.state.set("mods_explained", True)
        s.publish_state()
        return {}

    @rpc.method("mods.scan")
    def mods_scan(dismissed: bool = False) -> dict[str, bool]:
        """Request a scan (``dismissed``: Settings' Check, which lists dismissed entries again); the result comes as
        ``library.scanned``. ``scan_off`` without the scan consent."""
        if not s.scan_allowed():
            raise ServiceError("scan_off")
        return {"requested": s.request_scan(bool(dismissed)) is not None}

    @rpc.method("mods.entries")
    def mods_entries() -> list[Any]:
        """The last scan's entries, as every writer job's result updated them; none without the scan consent."""
        return s.snapshot.entries() if s.scan_allowed() else []

    def entry_list(entries: Any) -> list[dict[str, Any]]:
        if not isinstance(entries, list) or not all(isinstance(item, dict) and isinstance(item.get("install"), str)
                                                    and isinstance(item.get("core"), str) for item in entries):
            raise ServiceError("bad_params", key="entries")
        return [{"install": item["install"], "core": item["core"], **({"state": item["state"]}
                 if isinstance(item.get("state"), str) else {})} for item in entries]

    @rpc.method("mods.adopt")
    def mods_adopt(entries: list[dict[str, Any]]) -> str:
        """Add to Library: a library writer job, allowed while the game runs and while a classic window is open."""
        listed = entry_list(entries)
        library = s.library
        pins = library.installs()
        return s.submit("library.adopt", lambda log, progress: library.adopt(listed, pins, log=log, progress=progress),
                        writes="library", library=library)

    @rpc.method("mods.restoreDrift")
    def mods_restore_drift(entries: list[dict[str, Any]]) -> str:
        """The drift prompt's Apply Mod Configuration."""
        return s.submit_restore_drift(entry_list(entries))

    @rpc.method("mods.dismiss")
    def mods_dismiss(kind: str, entries: list[dict[str, Any]]) -> dict[str, Any]:
        """The drift prompt's Keep as Is, the untracked prompt's Don't Ask Again."""
        listed = entry_list(entries)
        s.library.dismiss(kind, listed)
        s.snapshot.mark_dismissed({(item["install"], item["core"].lower()) for item in listed})
        s.publish_state()
        return {}

    @rpc.method("mods.sizes")
    def mods_sizes(kind: str) -> dict[str, int]:
        return s.library.sizes(kind)

    @rpc.method("mods.clearBuilt")
    def mods_clear_built() -> str:
        library = s.library
        return s.submit("library.clearBuilt", lambda log, progress: {"freed": library.clear_built()},
                        writes="library", library=library)

    @rpc.method("mods.forget")
    def mods_forget(install: str) -> str:
        """Remove from List: a recorded install this data directory's settings no longer name; ``bad_params`` for a
        named one."""
        library = s.library
        named = {item["key"] for item in library.status().get("installs", []) if item.get("named")}
        if not isinstance(install, str) or install in named:
            raise ServiceError("bad_params", install=install)
        return s.submit("library.forget", lambda log, progress: library.forget(install), writes="library",
                        library=library)

    # --- actions (jobs) ---

    @rpc.method("actions.apply")
    def actions_apply(variant: str, source: str, kind: str = "spr") -> str:
        """Switch what the game shows: write a source into the variant's portrait ("spr") or memorial lobby ("lobby")
        game files of the current install, pinned at submit, and configure it. The library keeps what it replaces
        (ModLibrary._commit). While mods are off it only configures the source (``deferred``)."""
        return s.submit_apply(variant, source, kind)

    @rpc.method("actions.restore")
    def actions_restore(variant: str, kind: str = "spr") -> str:
        return s.submit_restore(variant, kind)

    @rpc.method("actions.update")
    def actions_update(mod: str) -> str:
        library = s.library
        pin = s._current_pin(library)
        return s.submit("update", lambda log, progress: library.update(mod, log=log, progress=progress, pin=pin),
                        writes="library", library=library)

    @rpc.method("actions.extract")
    def actions_extract(target: str) -> str:
        out_dir = s.settings.output_subdir("extract")
        library = s.library
        pin = library.current_pin()
        return s.submit("extract", lambda log, progress: {
            "folder": str(library.extract(target, out_dir, log=log, pin=pin))})

    @rpc.method("actions.compare")
    def actions_compare(mod: str) -> Any:
        return s.library.compare(mod)

    @rpc.method("actions.remap")
    def actions_remap(mod: str) -> str:
        library = s.library
        pin = s._current_pin(library)
        return s.submit("remap", lambda log, progress: library.remap(mod, log=log, progress=progress, pin=pin))

    @rpc.method("actions.acceptRemap")
    def actions_accept_remap(preview: str) -> str:
        library = s.library
        return s.submit("remap.accept", lambda log, progress: library.accept_remap(preview),
                        writes="library", library=library)

    @rpc.method("actions.discardRemap")
    def actions_discard_remap(preview: str) -> None:
        s.library.discard_remap(preview)

    @rpc.method("actions.compatibility")
    def actions_compatibility(mod: str) -> str:
        library = s.library
        pin = s._current_pin(library)
        return s.submit("compatibility", lambda log, progress: library.compatibility(mod, pin=pin))

    @rpc.method("jobs.get")
    def jobs_get(id: str) -> dict[str, Any]:
        job = s.jobs.get(id)
        return {**job.to_json(), "log": job.log[-500:]}

    # --- system ---

    @rpc.method("os.reveal")
    def os_reveal(path: str) -> None:
        reveal(path)

    return rpc
