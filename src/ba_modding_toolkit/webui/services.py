"""Builds and holds the services behind the web UI, and answers /asset/... requests."""

from __future__ import annotations

import json
import logging
import shutil
import threading
from pathlib import Path
from typing import Any

from ..config import APP_DIR_NAME, Settings, user_cache_dir
from ..kivo import Kivo
from ..errors import ServiceError
from ..utils import EXE_DIR
from .events import EventBus
from .jobs import JobRunner
from .server import MIME, AssetResponse
from .state import UiState

logger = logging.getLogger(__name__)


class Services:
    """The web UI's service container. Game-backed services are built on first use and rebuilt after a game
    folder change; tests pass fakes for any of them."""

    def __init__(self, settings: Settings | None = None, data_dir: Path = EXE_DIR, *,
                 events: EventBus | None = None, jobs: JobRunner | None = None, state: UiState | None = None,
                 cache: Any = None, game: Any = None, catalog: Any = None, library: Any = None):
        self.settings = settings or Settings()
        self.data_dir = Path(data_dir)
        self.events = events or EventBus()
        self.jobs = jobs or JobRunner(self.events)
        self.state = state or UiState(self.data_dir / "webui.json")
        self.window: Any = None  # the pywebview window, when there is one (see native.py)
        self.update_info: Any = None  # the last update check's result
        self.kivo = Kivo()
        self.mute = False  # development: never play voices
        self._lock = threading.RLock()
        self._cache, self._game, self._catalog, self._library = cache, game, catalog, library
        self._injected = {k for k, v in (("game", game), ("catalog", catalog), ("library", library)) if v is not None}
        self.settings.on_change(self._on_settings_changed)

    # --- lazily built services ---

    @property
    def cache(self) -> Any:
        with self._lock:
            if self._cache is None:
                from ..gameassets import AssetCache

                self._cache = AssetCache(allowed=self.state.consent is True, root=self.cache_dir())
            return self._cache

    @property
    def game(self) -> Any:
        self._refresh_if_idle()
        with self._lock:
            if self._game is None:
                dirs = self.settings.resource_dirs()
                if not dirs:
                    raise ServiceError("game_not_found")
                from ..gameassets import GameAssets

                self._game = GameAssets(dirs, self.cache)
            return self._game

    def game_found(self) -> bool:
        try:
            self.game
            return True
        except ServiceError:
            return False

    @property
    def catalog(self) -> Any:
        self._refresh_if_idle()
        with self._lock:
            if self._catalog is None:
                from ..catalog import Catalog

                csv = Path(self.settings.get("bacii_map_path"))
                # recruitable follows the server of the selected game folder
                self._catalog = Catalog(self.game if self.game_found() else None, csv if csv.exists() else None,
                                        server=self.settings.server_region())
            return self._catalog

    @property
    def library(self) -> Any:
        self._refresh_if_idle()
        with self._lock:
            if self._library is None:
                from ..library import ModLibrary

                self._library = ModLibrary(self.library_dir(), self.catalog, self.game, self.settings)
            return self._library

    def cache_dir(self) -> Path:
        """Where light game UI assets are cached: a BA-Modding-Toolkit/cache folder inside the folder the user chose,
        else the default user cache folder. Always a folder of its own, so clearing it never touches anything else."""
        chosen = self.state.get("cache_parent")
        return Path(chosen) / APP_DIR_NAME / "cache" if chosen else user_cache_dir()

    def set_cache_parent(self, parent: Path) -> Path:
        """Cache in another folder; the old cache is removed (it is rebuilt from the game files on demand)."""
        parent = Path(parent).expanduser().resolve()
        if not parent.is_dir():
            raise ServiceError("path_not_found", path=str(parent))
        with self._lock:
            old = self.cache_dir()
            self.state.set("cache_parent", str(parent))
            new = self.cache_dir()
            if new != old:
                if self._cache is not None:
                    self._cache.clear()  # removes the old cache folder only
                    self._cache.root = new
                elif old.is_dir() and old.name == "cache" and old.parent.name == APP_DIR_NAME:
                    shutil.rmtree(old, ignore_errors=True)
        return new

    def library_dir(self) -> Path:
        """Where the mod library lives: the user's choice, else the data directory's library folder."""
        chosen = self.state.get("library_dir")
        return Path(chosen) if chosen else self.data_dir / "library"

    def move_library(self, target: Path) -> Path:
        """Use another folder for the mod library. The current library moves there when the target holds none."""
        target = Path(target).expanduser().resolve()
        current = self.library_dir().resolve()
        if target == current:
            return target
        if target.exists() and not target.is_dir():
            raise ServiceError("path_not_found", path=str(target))
        if self.jobs.busy():
            raise ServiceError("busy")  # a running job still writes through the current library
        items = ("mods", "originals", "state.json")
        with self._lock:
            if (current / "state.json").exists() and not (target / "state.json").exists():
                clashes = [item for item in items if (target / item).exists()]
                if clashes:
                    raise ServiceError("library_target_not_empty", path=str(target / clashes[0]))
                target.mkdir(parents=True, exist_ok=True)
                moved = []
                try:
                    for item in items:
                        if (current / item).exists():
                            shutil.move(str(current / item), str(target / item))
                            moved.append(item)
                except OSError as e:
                    for item in reversed(moved):  # put back what already moved
                        try:
                            shutil.move(str(target / item), str(current / item))
                        except OSError:
                            logger.exception("could not move %s back to %s", item, current)
                    raise ServiceError("library_io_error", file=str(target)) from e
            self.state.set("library_dir", str(target))
            if "library" not in self._injected:
                self._library = None
        self.events.publish("library.changed")
        return target

    def reload_game(self) -> None:
        """Rebuild the game-backed services after the game folder or file source changed."""
        self._on_settings_changed()

    def _on_settings_changed(self) -> None:
        # a new game folder means new game-backed services; while a job runs they are swapped once it is done, so the
        # job never shares the library with a second instance
        with self._lock:
            self._stale = True
        self._refresh_if_idle()
        self.events.publish("config.changed")

    def _refresh_if_idle(self) -> None:
        with self._lock:
            if not getattr(self, "_stale", False) or self.jobs.busy():
                return
            self._stale = False
            for name in ("game", "catalog", "library"):
                if name not in self._injected:
                    setattr(self, f"_{name}", None)

    def set_consent(self, granted: bool) -> None:
        self.state.set_consent(granted)
        if self._cache is not None:
            self._cache.allowed = granted

    # --- /asset/... ---

    def asset(self, path: str, query: dict[str, str]) -> AssetResponse:
        parts = path.split("/")
        kind = parts[0]
        if kind == "ui":
            return self._ui_asset(parts[1:], query)
        if kind == "art" and len(parts) == 3:
            if parts[1] == "bg":
                data, mime = self.game.collection_bg(_stem(parts[2]))
                return AssetResponse(data, mime, light=False)
            if parts[1] == "portrait":
                return AssetResponse(self.game.collection_portrait(_stem(parts[2])), "image/png", light=False)
        if kind == "spine" and len(parts) == 4:
            return self._spine_asset(parts[1], parts[2], parts[3])
        if kind == "model" and len(parts) == 2 and parts[1].endswith(".glb"):
            # a variant's 3D chibi, exported from the game files in memory and never cached
            core = self.catalog.variant(_stem(parts[1])).model
            if not core:
                raise KeyError(path)
            return AssetResponse(self.game.model_glb(core), MIME[".glb"], light=False)
        if kind == "voice" and len(parts) == 3:
            # a memorial lobby voice clip from Kivo, relayed so it is never cached
            variant = self.catalog.variant(parts[1])
            return AssetResponse(self.kivo.audio(variant.page_id or "", _stem(parts[2])), "audio/ogg", light=False)
        raise KeyError(path)

    def _ui_asset(self, parts: list[str], query: dict[str, str]) -> AssetResponse:
        game = self.game
        if parts == ["atlases.json"]:
            return _json(game.atlases(), light=True)
        if parts == ["textures.json"]:
            return _json({name: f"/asset/ui/texture/{name}.png" for name in game.textures()}, light=True)
        if len(parts) == 3 and parts[0] == "sprite":
            return AssetResponse(game.sprite_png(parts[1], _stem(parts[2])), "image/png", light=True)
        if len(parts) == 2 and parts[0] == "texture":
            return AssetResponse(game.texture_png(_stem(parts[1])), "image/png", light=True)
        if len(parts) == 2 and parts[0] == "layout":
            return _json(game.layout(_stem(parts[1]), query.get("path", "")), light=True)
        raise KeyError("/".join(parts))

    def _spine_asset(self, kind: str, key: str, name: str) -> AssetResponse:
        if kind in ("spr", "lobby"):
            files = self.game.spine_files(kind, key)
        elif kind == "mod":
            files = self.game.spine_files_from(self.library.preview_bundles(key))
        else:
            raise KeyError(kind)
        if name == "files.json":
            return _json(sorted(files), light=False)
        data = files.get(name)
        if data is None:
            # "skeleton.skel" / "skeleton.atlas" stand for the one skeleton in the files
            suffix = Path(name).suffix
            if Path(name).stem == "skeleton":
                matches = [k for k in files if k.endswith(suffix)]
                named = [k for k in matches if Path(k).stem.lower() == key.lower()]
                pick = named or (matches if len(matches) == 1 else [])
                data = files[pick[0]] if pick else None
        if data is None:
            raise KeyError(name)
        return AssetResponse(data, MIME.get(Path(name).suffix, "application/octet-stream"), light=False)

    def close(self, wait: float | None = 600.0) -> None:
        self.jobs.shutdown(wait=wait)
        self.events.close()


def _stem(name: str) -> str:
    for suffix in (".png", ".jpg", ".json", ".ogg", ".glb"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _json(data: Any, light: bool) -> AssetResponse:
    return AssetResponse(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                         "application/json", light)
