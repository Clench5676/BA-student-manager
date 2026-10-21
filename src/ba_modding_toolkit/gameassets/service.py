"""Lazy game asset service for the web UI's asset routes."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import threading
from collections.abc import Iterable
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from .. import devmode
from ..errors import ServiceError
from ..naming import parse_filename, spine_kind
from .cache import AssetCache
from . import lobby
from .discovery import (
    bundle_paths, cab_names, group_bundles, is_atlas, is_layout_texture,
    is_lobby_prefab, is_model_dependency, is_pointer_texture, is_prefab, is_texture, resource_version,
)
from .errors import AssetNotFound
from .layouts import export_layout, subtree
from .spine import extract_spine, png_bytes, spine_stamps
from .unity import find_object, object_record, open_bundle, reference, ref_key

logger = logging.getLogger(__name__)
_SCHEMA = "gameassets-v1/"
# The layout export's format, part of each cached layout's key: raise it whenever export_layout's output changes, so
# layouts cached in an older format are rebuilt and no other cached asset is dropped (v3: label effect colours and distances)
_LAYOUT = "layout-v4/"
_ATLASES = "atlases-v2/"
# One model export at a time in the process: an export holds the path locks of every bundle it reads
_MODEL_LOCK = threading.Lock()
_SPRITE_FIELDS = ("x", "y", "width", "height", "borderLeft", "borderRight", "borderTop",
                  "borderBottom", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom")


# Where the prefabs the UI uses are in the Global client (bundle file names, as of the 2026-10 resource version).
# Checked before scanning every prefab bundle; a game update that renames them falls back to the scan.
PREFAB_HINTS = {
    "UICharacterCollection": "ui-_mxload-prefabs-2025-07-02_assets_all_2244454933.bundle",
    "UICharacterCollectionPopulatorUnit": "ui-uiassetobject-_mxload-2024-11-18_assets_all_625906829.bundle",
    "UIPopup_GachaCharList": "ui-_mxload-prefabs-2025-07-02_assets_all_2249507476.bundle",
    "UIPopup_Sort": "ui-_mxload-prefabs-2025-07-02_assets_all_792282090.bundle",
    # the student list's display settings popup (filter and sort tabs) and its filter group template
    "UIPopup_FilterSort": "ui-_mxload-prefabs-2025-07-02_assets_all_2563991958.bundle",
    "UIFilterObjectList": "ui-uiassetobject-_mxload-2024-11-18_assets_all_625906829.bundle",
    "UICharacterDetail": "ui-_mxload-prefabs-2025-07-02_assets_all_2968814143.bundle",
    # the portrait's fullscreen view, opened by the detail screen's ZoomButton
    "UICharacterVisualMode": "ui-_mxload-prefabs-2025-07-02_assets_all_1664527646.bundle",
    "UIPopup_Option_PC": "ui-_mxload-prefabs-2025-11-28_assets_all_1183413113.bundle",
    # the loading screen (Resources/UI/UILoading.prefab) and its "Now Loading" indicator
    "UILoading": "prologgroup-assets-_mx-resources-ui-_mxprolog-2026-04-13_assets_all_2006567787.bundle",
    "UIRepeater": "ui-_mxload-prefabs-2025-07-02_assets_all_1187726256.bundle",
    # the lobby, whose bottom menu entries hold the game's disabled look (layouts.py STATE_FIELDS)
    "UILobby": "ui-_mxload-prefabs-2025-07-02_assets_all_2178802179.bundle",
}



def is_collection_art(name: str) -> bool:
    """Whether a texture of the character collection bundles (the game's UIs/01_Common/14_CharacterCollect folder, the
    one CostumeExcel's CollectionBGTexturePath and CollectionTexturePath point into) is one the art routes serve.

    Every background there is a costume's collection background: most are named BG_<place>_Collection, a few after
    the scenario background they reuse (BG_NewYearFestival2, BG_WaterFall), and two are region copies
    (BG_<place>_Collection_kr), so the suffix is not required. Portraits are Student_Portrait_<id>_Collection; the
    folder's NPC_Portrait_* are never asked for.
    """
    return name.startswith("BG_") or (name.startswith("Student_Portrait_") and name.endswith("_Collection"))


def _stamp(path: str | Path) -> tuple[int, int] | None:
    """A file's size and modification time, or None when it cannot be read."""
    try:
        stat = Path(path).stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


class GameAssets:
    """Read light UI assets and heavy character art from the user's install.

    Construction only checks directory existence. Discovery, version hashing,
    Unity loading and index construction happen on the first relevant request.
    Index locks prevent duplicate scans, while per-path locks serialize all
    Unity operations even across different service instances.
    """

    def __init__(self, resource_dirs: list[Path], cache: AssetCache):
        for path in resource_dirs:
            devmode.check_read(path)  # dev mode: only game folders inside the dev roots
        self.resource_dirs = list(dict.fromkeys(Path(p).resolve() for p in resource_dirs if Path(p).is_dir()))
        if not self.resource_dirs:
            raise ServiceError("game_not_found")
        self.cache = cache
        self._guard = threading.RLock()
        self._locks: dict[str, threading.RLock] = {}
        self._indexes: dict[str, Any] = {}
        self._shader_forms: dict[tuple[str, int], dict] = {}  # shader (cab, path id) -> name, properties, pass states

    def _lock(self, key: str) -> threading.RLock:
        with self._guard:
            return self._locks.setdefault(key, threading.RLock())

    @property
    def resource_version(self) -> str:
        """The catalog hash, or the hash of the sorted resource file listing."""
        with self._lock("version"):
            if "version" not in self._indexes:
                self._indexes["version"] = resource_version(self.resource_dirs)
            return self._indexes["version"]

    def _paths(self) -> list[Path]:
        with self._lock("paths"):
            if "paths" not in self._indexes:
                self._indexes["paths"] = bundle_paths(self.resource_dirs)
            return self._indexes["paths"]

    def _bundle_path(self, name: str) -> Path:
        # Resolve in the current folders: a sandbox can acquire more bundles after the first discovery.
        if Path(name).name == name:
            for directory in self.resource_dirs:
                path = directory / name
                if path.is_file():
                    return path
        raise AssetNotFound(name)

    def _cached(self, key: str, build: Callable[[], bytes], *, disk: bool = True) -> bytes:
        with self._lock(key):
            value = self.cache.get(_SCHEMA + key, version=self.resource_version, disk=disk)
            if value is None:
                value = build()
                self.cache.put(_SCHEMA + key, value, version=self.resource_version, disk=disk)
            return value

    def _index(self, key: str, build: Callable[[], Any], *, disk: bool = True) -> Any:
        with self._lock(key):
            if key not in self._indexes:
                def encode() -> bytes:
                    return json.dumps(build(), ensure_ascii=True, separators=(",", ":")).encode()
                data = self._cached(key, encode, disk=disk)
                try:
                    value = json.loads(data)
                except (ValueError, UnicodeError):
                    logger.warning("Rebuilding invalid asset index %s", key)
                    value = build()
                    self.cache.put(_SCHEMA + key, json.dumps(value).encode(),
                                   version=self.resource_version, disk=disk)
                self._indexes[key] = value
            return self._indexes[key]

    def _atlas_index(self) -> dict:
        # The catalog version alone does not describe the installed UI bundles (partial downloads and sandboxes).
        # Keep the inventory in the key, including replacements that preserve size and modification time.
        with self._lock("atlases"):
            try:
                paths = list(filter(is_atlas, bundle_paths(self.resource_dirs)))
                if not paths:
                    raise AssetNotFound("No UI atlas bundles in the resource folders")
                stamps = spine_stamps(paths)
                key = _ATLASES + hashlib.sha256(json.dumps(stamps).encode()).hexdigest()
                if self._indexes.get("atlas-source") == key:
                    return self._indexes["atlases"]
                data = self.cache.get(_SCHEMA + key, version=self.resource_version)
                value = None
                if data is not None:
                    try:
                        value = json.loads(data)
                        self._validate_atlases(value)
                    except (ValueError, UnicodeError, TypeError, KeyError) as error:
                        logger.warning("Rebuilding invalid UI atlas index: %s", error)
                        value = None
                if value is None:
                    value = self._scan_atlases(paths)
                    self._validate_atlases(value)
                    if spine_stamps(list(filter(is_atlas, bundle_paths(self.resource_dirs)))) != stamps:
                        raise AssetNotFound("UI atlas bundles changed during indexing")
                    self.cache.put(_SCHEMA + key, json.dumps(value).encode(), version=self.resource_version)
                self._indexes["atlases"], self._indexes["atlas-source"] = value, key
                return value
            except Exception as error:
                logger.exception("Cannot build UI atlas index from %s: %r", self.resource_dirs, error)
                raise

    @staticmethod
    def _validate_atlases(index: dict) -> None:
        if not isinstance(index, dict) or not all(isinstance(index.get(key), dict)
                                                  for key in ("sprites", "images", "names")):
            raise ValueError("Invalid UI atlas index structure")
        if not index["names"] or not any(index["sprites"].values()):
            raise ValueError("UI atlas index has no sprites")
        if set(index["names"].values()) != set(index["sprites"]):
            raise ValueError("UI atlas index is missing atlas metadata")
        for name, sprites in index["sprites"].items():
            if not isinstance(sprites, dict) or not all(isinstance(sprite, dict) for sprite in sprites.values()):
                raise ValueError(f"Invalid UI atlas metadata: {name}")
            for sprite, rect in sprites.items():
                if not all(isinstance(rect.get(field), (int, float)) and math.isfinite(rect[field])
                           for field in ("x", "y", "width", "height")):
                    raise ValueError(f"Invalid UI sprite rectangle: {name}/{sprite}")
            record = index["images"].get(name)
            if sprites and (not isinstance(record, dict) or not all(key in record
                                                                   for key in ("bundle", "cab", "pid", "name"))):
                raise ValueError(f"UI atlas {name} has sprites but no texture")

    def _scan_atlases(self, paths: list[Path]) -> dict:
        atlases, by_key, objects, materials, names = {}, {}, {}, {}, {}
        for path in paths:
            with open_bundle(path) as env:
                for obj in env.objects:
                    key = ref_key(obj.assets_file.name, obj.path_id)
                    if obj.type.name == "MonoBehaviour":
                        tree = obj.read_typetree()
                        if "mSprites" in tree:
                            name = tree["m_Name"]
                            atlases[name] = (key, tree, obj.assets_file.name,
                                             [ext.path for ext in obj.assets_file.externals])
                            by_key[key] = atlases[name]
                            names[key] = name
                    elif obj.type.name == "Texture2D":
                        name = obj.peek_name()
                        objects[key] = object_record(path, obj, name)
                    elif obj.type.name == "Material":
                        tree = obj.read_typetree()
                        for name, value in tree["m_SavedProperties"]["m_TexEnvs"]:
                            if name == "_MainTex":
                                materials[key] = ref_key(*reference(obj, value["m_Texture"]))
        # All pointers are resolved after scanning, so external material and
        # texture CABs may appear before or after their atlas bundle.
        sprites, images = {}, {}
        for name, entry in atlases.items():
            seen = set()
            while True:
                key, tree, cab, externals = entry
                replacement = tree.get("mReplacement", {})
                if not replacement.get("m_PathID"):
                    break
                if key in seen:
                    raise AssetNotFound(f"UI atlas replacement cycle: {name}")
                seen.add(key)
                fid = replacement.get("m_FileID", 0)
                target = cab if not fid else externals[fid - 1].replace("\\", "/").rsplit("/", 1)[-1]
                try:
                    entry = by_key[ref_key(target, replacement["m_PathID"])]
                except KeyError:
                    raise AssetNotFound(f"Missing UI atlas replacement: {name}") from None
            sprites[name] = {sprite["name"]: {field: sprite.get(field, 0) for field in _SPRITE_FIELDS}
                             for sprite in tree["mSprites"]}
            pointer = tree.get("material", {})
            fid = pointer.get("m_FileID", 0)
            target = cab if not fid else externals[fid - 1].replace("\\", "/").rsplit("/", 1)[-1]
            texture_key = materials.get(ref_key(target, pointer.get("m_PathID", 0)))
            if texture_key in objects:
                images[name] = objects[texture_key]
        return {"sprites": sprites, "images": images, "names": names}

    def atlases(self) -> dict[str, dict[str, dict]]:
        """Return NGUI sprite rectangles, borders and padding by atlas name."""
        return deepcopy(self._atlas_index()["sprites"])

    def _image(self, record: dict) -> Image.Image:
        path = self._bundle_path(record["bundle"])
        key = "image/" + ref_key(record["cab"], record["pid"]) + json.dumps(spine_stamps([path]))
        with self._lock(key):
            image = self.cache.get(_SCHEMA + key, version=self.resource_version, disk=False)
            if image is None:
                with open_bundle(path) as env:
                    image = find_object(env, record).read().image
                    image.load()
                self.cache.put(_SCHEMA + key, image, version=self.resource_version, disk=False)
            return image

    def sprite_png(self, atlas: str, sprite: str) -> bytes:
        """Crop a named atlas sprite and return PNG bytes."""
        with self._lock("atlases"):
            index = self._atlas_index()
            source = self._indexes["atlas-source"]
        def build() -> bytes:
            try:
                rect = index["sprites"][atlas][sprite]
                record = index["images"][atlas]
            except KeyError:
                raise AssetNotFound((atlas, sprite)) from None
            image = self._image(record)
            # NGUI's mSprites uses top-left coordinates. UnityPy has already
            # flipped the decoded Unity texture into Pillow's top-left space.
            x, y = rect["x"], rect["y"]
            data = png_bytes(image.crop((x, y, x + rect["width"], y + rect["height"])))
            if self._atlas_index() is not index:
                raise AssetNotFound("UI atlas bundles changed while reading a sprite")
            return data
        return self._cached("sprite/" + source + json.dumps([atlas, sprite]), build)

    def _texture_index(self) -> dict:
        return self._index("textures", lambda: self._scan_textures(filter(is_texture, self._paths())))

    def _scan_textures(self, paths: Iterable[Path]) -> dict:
        textures, names = {}, {}
        for path in paths:
            with open_bundle(path) as env:
                for obj in env.objects:
                    if obj.type.name == "Texture2D":
                        name = obj.peek_name()
                        record = object_record(path, obj, name)
                        textures.setdefault(name, record)
                        names[ref_key(obj.assets_file.name, obj.path_id)] = name
        return {"textures": textures, "names": names}

    def textures(self) -> list[str]:
        """List the names available in the shared UI texture families."""
        return sorted(self._texture_index()["textures"])

    def _pointer_index(self) -> dict:
        """The PC client's cursor and the touch effect's textures (a small scan, about 0.1 s). An index of its own,
        so a UI texture index cached before these families were read stays valid."""
        return self._index("pointer-textures", lambda: self._scan_textures(
            filter(is_pointer_texture, self._paths()))["textures"])

    def texture_png(self, name: str) -> bytes:
        """Decode a shared UI texture (or a cursor or touch effect texture) and return PNG bytes."""
        def build() -> bytes:
            record = self._texture_index()["textures"].get(name) or self._pointer_index().get(name)
            if record is None:
                raise AssetNotFound(name)
            return png_bytes(self._image(record))
        return self._cached("texture/" + name, build)

    def _prefabs(self) -> dict:
        return self._index("prefabs", self._scan_prefabs)

    def _prefab_bundle(self, root: str) -> Path:
        """The bundle holding a prefab root: the known bundle name first (one small read), else the full index
        (a scan of every UI prefab bundle, about 12 s cold)."""
        hint = PREFAB_HINTS.get(root)
        if hint:
            try:
                path = self._bundle_path(hint)
            except AssetNotFound:
                path = None
            if path is not None:
                suffix = f"/{root.lower()}.prefab"
                with open_bundle(path) as env:
                    if any(name.lower().endswith(suffix) for name in env.container):
                        return path
        try:
            return self._bundle_path(self._prefabs()[root])
        except KeyError:
            raise AssetNotFound(root) from None

    def _scan_prefabs(self) -> dict:
        roots = {}
        for path in filter(is_prefab, self._paths()):
            with open_bundle(path) as env:
                # The AssetBundle container points directly at prefab root
                # GameObjects, avoiding reads of every child and behaviour.
                found = False
                for name, pointer in env.container.items():
                    if not name.lower().endswith(".prefab") or pointer.m_FileID:
                        continue
                    obj = pointer.deref()
                    if obj.type.name == "GameObject":
                        roots.setdefault(obj.peek_name(), path.name)
                        found = True
                if not found:
                    for obj in env.objects:
                        if obj.type.name in ("Transform", "RectTransform"):
                            transform = obj.read()
                            if not transform.m_Father.path_id:
                                roots.setdefault(transform.m_GameObject.read().m_Name, path.name)
        return roots

    def layout(self, root: str, subpath: str = "") -> dict:
        """Return a prefab tree, optionally selecting an exact child subpath."""
        def build() -> dict:
            path = self._prefab_bundle(root)
            extra = self._index("layout-textures", lambda: self._scan_textures(
                filter(is_layout_texture, self._paths()))["names"])
            names = self._atlas_index()["names"] | self._texture_index()["names"] | extra
            with open_bundle(path) as env:
                return export_layout(env, root, names)
        # Layouts can be large. Keep their serialized bytes in the bounded LRU,
        # rather than pinning every visited prefab tree alongside the indexes.
        def encode() -> bytes:
            return json.dumps(build(), ensure_ascii=True, separators=(",", ":")).encode()
        data = self._cached(_LAYOUT + root, encode)
        try:
            tree = json.loads(data)
        except (ValueError, UnicodeError):
            logger.warning("Rebuilding invalid prefab layout %s", root)
            tree = build()
            self.cache.put(_SCHEMA + _LAYOUT + root, json.dumps(tree).encode(),
                           version=self.resource_version)
        return subtree(tree, subpath)

    def _collection(self) -> dict:
        """Collection backgrounds and portraits by texture name (names and bundle locations only, memory only)."""
        def build() -> dict:
            paths = [p for p in self._paths() if p.name.startswith("uis-01_common-14_charactercollect-")]
            textures = self._scan_textures(paths)["textures"]
            return {name: record for name, record in textures.items() if is_collection_art(name)}
        return self._index("collection", build, disk=False)

    def collection_names(self) -> dict[str, list[str]]:
        """List collection backgrounds and portraits by their full texture names."""
        names = self._collection()
        return {"bg": sorted(n for n in names if n.startswith("BG_")),
                "portrait": sorted(n for n in names if n.startswith("Student_Portrait_"))}

    def _collection_png(self, name: str, prefix: str) -> bytes:
        def build() -> bytes:
            if not name.startswith(prefix) or name not in self._collection():
                raise AssetNotFound(name)
            return png_bytes(self._image(self._collection()[name]))
        return self._cached("art/" + prefix + name, build, disk=False)

    def collection_bg(self, name: str) -> tuple[bytes, str]:
        """Return a collection background with its image MIME type (memory only)."""
        return self._collection_png(name, "BG_"), "image/png"

    def collection_portrait(self, name: str) -> bytes:
        """Return a collection portrait as PNG bytes (memory only)."""
        return self._collection_png(name, "Student_Portrait_")

    def spine_cores(self, kind: str) -> dict[str, list[Path]]:
        """Group portrait or lobby bundle parts by parsed Spine core."""
        categories = {"spr": ("spinecharacters",), "lobby": ("spinelobbies", "spinebackground", "spinecharacters")}
        if kind not in categories:
            raise AssetNotFound(kind)
        # shared bundles of the category (e.g. "_mxcommon-.asset") are not skeletons
        groups = self._index("spine-cores/" + kind, lambda: {
            core: [str(path) for path in paths]
            for category in categories[kind]
            for core, paths in group_bundles(self._paths(), category).items()
            if spine_kind(core, category) == kind
        }, disk=False)
        return {core: [Path(path) for path in paths] for core, paths in groups.items()}

    def spine_files(self, kind: str, core: str) -> dict[str, bytes]:
        """Return all files required by a portrait or lobby Spine player."""
        try:
            bundles = self.spine_cores(kind)[core.lower()]
        except KeyError:
            raise AssetNotFound((kind, core)) from None
        return self.spine_files_from(bundles)

    def spine_files_from(self, bundles: list[Path]) -> dict[str, bytes]:
        """Extract ordered parts in memory; later bundles override earlier files.

        Supply official parts first and mod parts last. Cache identity includes
        the order and file stamps, so precedence and changed mods invalidate it.
        """
        if not bundles:
            raise AssetNotFound("spine")
        paths = list(dict.fromkeys(Path(path).resolve() for path in bundles))
        stamps = spine_stamps(paths)
        key = "spine/" + json.dumps(stamps)
        with self._lock(key):
            value = self.cache.get(_SCHEMA + key, version=self.resource_version, disk=False)
            if value is None:
                value = extract_spine(paths)
                if spine_stamps(paths) != stamps:
                    raise AssetNotFound("spine changed during extraction")
                self.cache.put(_SCHEMA + key, value, version=self.resource_version,
                               disk=False, size=sum(len(data) for data in value.values()))
            return dict(value)

    # --- 3D chibi models: memory only, never cached on disk ---

    def _model_index(self) -> dict[str, list[str]]:
        return self._index("model-cores", lambda: {
            core: [str(path) for path in paths]
            for core, paths in group_bundles(self._paths(), "character").items()
            if re.fullmatch(r"[a-z0-9_]+", core)
        }, disk=False)

    def model_cores(self) -> set[str]:
        """Lower-case dev names with a 3D chibi prefab bundle (character-<dev>-_mxload-*)."""
        return set(self._model_index())

    def _cab_index(self, everything: bool = False) -> dict[str, str]:
        """CAB name -> bundle path, from bundle headers only: the model families (about 2k bundles, 0.3 s cold), or
        every bundle when a model points outside them (a few seconds, once per resource version)."""
        def build() -> dict[str, str]:
            index: dict[str, str] = {}
            for path in self._paths():
                if everything or is_model_dependency(path):
                    try:
                        names = cab_names(path)
                    except (OSError, ValueError):
                        logger.debug("Cannot read the CAB names of %s", path, exc_info=True)
                        continue
                    for cab in names:
                        index.setdefault(cab, str(path))
            return index
        return self._index("cabs-all" if everything else "cabs", build, disk=False)

    def model_glb(self, core: str, overrides: Iterable[Path] = ()) -> bytes:
        """Export a chibi to GLB bytes (memory only). ``overrides`` are bundles that replace the official bundles
        holding the same CABs (mod previews)."""
        from .model import BundleGraph, export_chibi

        core = core.lower()
        try:
            bundles = [Path(path) for path in self._model_index()[core]]
        except KeyError:
            raise AssetNotFound(("model", core)) from None
        overrides = list(dict.fromkeys(Path(path).resolve() for path in overrides))
        # Prefabs are opened directly by the exporter; CAB overrides alone only replace their dependencies.
        slots = {(parse_filename(path.name).prefix, parse_filename(path.name).res_type): path for path in overrides}
        bundles = [slots.get((parse_filename(path.name).prefix, parse_filename(path.name).res_type), path)
                   for path in bundles]
        stamps = []
        for path in [*bundles, *overrides]:
            try:
                stat = path.stat()
            except FileNotFoundError:
                raise AssetNotFound(str(path)) from None
            stamps.append((str(path), stat.st_size, stat.st_mtime_ns))
        key = _SCHEMA + "model/" + json.dumps([core, stamps])
        with _MODEL_LOCK:
            cached = self.cache.get(key, version=self.resource_version, disk=False)
            # the meshes, textures and clips sit in other bundles than the prefab: the entry also keeps the stamps of
            # every bundle the export read, so one changed in place (a mod install) exports again
            if cached is not None and all(stamp is not None and _stamp(path) == stamp
                                          for path, stamp in cached[1].items()):
                return cached[0]
            index = self._cab_index()
            with BundleGraph(index, overrides, fallback=lambda: self._cab_index(everything=True)) as graph:
                data = export_chibi(graph, bundles, core)
                read = {path: _stamp(path) for path in graph.loaded}
            self.cache.put(key, (data, read), version=self.resource_version, disk=False, size=len(data))
            return data

    def _lobby_prefabs(self) -> dict[str, str]:
        """Memorial lobby prefab names (lower case) -> bundle names, from the bundle containers alone (about 5 s
        cold). It holds names only, so it is cached like the other indexes."""
        def build() -> dict[str, str]:
            names: dict[str, str] = {}
            for path in filter(is_lobby_prefab, self._paths()):
                with open_bundle(path) as env:
                    for name in env.container:
                        if name.lower().endswith(".prefab"):
                            names.setdefault(name.rsplit("/", 1)[-1][:-7].lower(), path.name)
            return names
        return self._index("lobby-prefabs", build)

    def lobby_info(self, core: str) -> dict:
        """A memorial lobby's layout and interaction (see lobby.py), from its prefab and its own clip assets. It is
        read from the character's bundles, so it stays in memory; the file stamps keep an applied mod apart."""
        try:
            bundles = self.spine_cores("lobby")[core.lower()]
        except KeyError:
            raise AssetNotFound(("lobby", core)) from None
        stamps = spine_stamps(bundles)

        def build() -> bytes:
            skeletons, behaviours, trees, keys = [], [], {}, {}
            for path in bundles:
                with open_bundle(path) as env:
                    for obj in env.objects:
                        if obj.type.name == "TextAsset":
                            name = obj.peek_name()
                            if name.lower().endswith(".skel"):
                                skeletons.append(name[:-5])
                        elif obj.type.name == "MonoBehaviour":
                            try:
                                tree = obj.read_typetree()
                            except (ValueError, TypeError):
                                logger.debug("Cannot read lobby behaviour %s", obj.path_id, exc_info=True)
                                continue
                            behaviours.append((obj.path_id, tree))
                            # the volume profiles and their components are behaviours of the core's bundles too
                            trees[(obj.assets_file.name.lower(), obj.path_id)] = tree
                            # a clip's sound keys point at events in another bundle: their CAB names, by key
                            for i, key in enumerate(tree.get("SoundKeys") or []):
                                event = key.get("Event") or {}
                                if event.get("m_PathID"):
                                    cab, pid = reference(obj, event)
                                    keys[(obj.path_id, event.get("m_FileID", 0), pid)] = f"{cab.lower()}_{pid}"
            skeletons = list(dict.fromkeys(skeletons))
            clips = lobby.Clips(behaviours, skeletons, sound=lambda owner, pointer: keys.get(
                (owner, pointer.get("m_FileID", 0), pointer.get("m_PathID", 0))))
            prefabs, prefab = self._lobby_prefabs(), None
            for name in lobby.prefab_candidates(core, skeletons):
                if name in prefabs:
                    prefab = self._lobby_prefab(prefabs[name], name, skeletons, clips, trees)
                    if prefab:
                        break
            sounds = self._lobby_sound_events(clips.sound_events())
            return json.dumps(lobby.lobby_info(skeletons, clips, prefab, sounds), ensure_ascii=True,
                              separators=(",", ":")).encode()
        return json.loads(self._cached("lobby/" + json.dumps([core.lower(), stamps]), build, disk=False))

    def _lobby_prefab(self, bundle: str, root: str, skeletons: list[str], clips: lobby.Clips,
                      behaviours: dict[tuple[str, int], dict] | None = None) -> dict | None:
        """read_prefab on a prefab bundle; behaviours are the lobby core's MonoBehaviours by (CAB name, path id),
        where the prefab's volume profiles usually are."""
        from .model import BundleGraph

        try:
            path = self._bundle_path(bundle)
        except AssetNotFound:
            return None
        known = dict(behaviours or {})
        # the particle renderers' materials, textures and meshes sit in other bundles (the lobbies' shared effect
        # bundles, the shader bundles, a character's own): one graph holds them open, so it runs alone like a model
        # export (see BundleGraph)
        index = self._cab_index(everything=True)
        with _MODEL_LOCK, BundleGraph(index) as graph:
            env = graph.add(path)
            objects = {obj.path_id: obj for obj in env.objects}
            kinds = {pid: obj.type.name for pid, obj in objects.items()}

            def tree(pid: int) -> dict:
                # read on demand: a lobby bundle may hold several prefabs, only one tree is walked
                return graph.tree(objects[pid])

            def profile(pid: int, pointer: dict) -> list[dict] | None:
                cab, ref = reference(objects[pid], pointer)
                key = (cab.lower(), ref)
                if key not in known:
                    known.update(self._lobby_behaviours(cab))
                found = known.get(key)
                if found is None:
                    logger.debug("Volume profile %s not found", key)
                    return None
                # the components are sub-assets of the profile, in its own file
                parts = [(key[0], c.get("m_PathID")) for c in found.get("components", []) if not c.get("m_FileID")]
                return [known[part] for part in parts if part in known]
            scripts = {pid: tree(pid).get("m_ClassName") for pid, kind in kinds.items() if kind == "MonoScript"}
            fx = _FxResolver(graph, objects, self._shader_forms)
            return lobby.read_prefab(kinds, tree, scripts, root, skeletons, clips, profile=profile, resolve=fx.resolve)

    def _lobby_behaviours(self, cab: str) -> dict[tuple[str, int], dict]:
        """The MonoBehaviours of another lobby core's bundle by (CAB name, path id): a few lobbies share a volume
        profile (Neru's is Serika's). Read on demand and kept in memory only, like the lobby data."""
        def build() -> dict[str, str]:
            index: dict[str, str] = {}
            for paths in self.spine_cores("lobby").values():
                for path in paths:
                    try:
                        for name in cab_names(path):
                            index.setdefault(name, str(path))
                    except (OSError, ValueError):
                        logger.debug("Cannot read the CAB names of %s", path, exc_info=True)
            return index
        path = self._index("lobby-cabs", build, disk=False).get(cab.lower())
        out: dict[tuple[str, int], dict] = {}
        if path is None:
            return out
        with open_bundle(Path(path)) as env:
            for obj in env.objects:
                if obj.type.name == "MonoBehaviour" and obj.assets_file.name.lower() == cab.lower():
                    try:
                        out[(cab.lower(), obj.path_id)] = obj.read_typetree()
                    except (ValueError, TypeError):
                        logger.debug("Cannot read lobby behaviour %s", obj.path_id, exc_info=True)
        return out

    def _lobby_sound_events(self, ids: Iterable[str]) -> dict[str, dict]:
        """The sound key events (AnimationAudioEvent assets of the lobbies' shared bundle) by id ("<cab>_<path id>"),
        as lobby.sound_event reads them; their clips are ids of the same form. An event that cannot be read is left
        out. Part of the lobby data: kept in memory only."""
        wanted: dict[str, set[int]] = {}
        for event in ids:
            cab, _, pid = event.rpartition("_")
            if cab and pid.lstrip("-").isdigit():
                wanted.setdefault(cab, set()).add(int(pid))
        if not wanted:
            return {}
        index, out = self._cab_index(everything=True), {}
        for cab, pids in wanted.items():
            bundle = index.get(cab)
            if bundle is None:
                logger.debug("Sound events of %s not found", cab)
                continue
            try:
                with open_bundle(Path(bundle)) as env:
                    for obj in env.objects:
                        if obj.path_id not in pids or obj.assets_file.name.lower() != cab \
                                or obj.type.name != "MonoBehaviour":
                            continue

                        def clip_id(pointer: dict, obj: Any = obj) -> str | None:
                            if not pointer.get("m_PathID"):
                                return None
                            c, p = reference(obj, pointer)
                            return f"{c.lower()}_{p}"
                        event = lobby.sound_event(obj.read_typetree(), clip_id)
                        if event:
                            out[f"{cab}_{obj.path_id}"] = event
            except (OSError, ValueError, TypeError, ServiceError):
                logger.debug("Cannot read the sound events of %s", cab, exc_info=True)
        return out

    def lobby_sound(self, core: str, clip_id: str) -> bytes:
        """An AudioClip a lobby's sound events play, decoded to WAV in memory (UnityPy and FMOD); only clips the
        lobby's info lists. Game audio: never cached on disk."""
        if not any(clip_id in e.get("clips", ()) for e in self.lobby_info(core).get("sounds", {}).values()):
            raise AssetNotFound(("lobby-sound", core, clip_id))
        cab, _, pid = clip_id.rpartition("_")
        bundle = self._cab_index(everything=True).get(cab)
        if bundle is None or not pid.lstrip("-").isdigit():
            raise AssetNotFound(("lobby-sound", core, clip_id))

        def build() -> bytes:
            with open_bundle(Path(bundle)) as env:
                obj = next((o for o in env.objects if o.path_id == int(pid) and o.assets_file.name.lower() == cab
                            and o.type.name == "AudioClip"), None)
                if obj is None:
                    raise AssetNotFound(("lobby-sound", core, clip_id))
                try:
                    samples = obj.read().samples
                except Exception as exc:  # FMOD missing or a format it cannot decode
                    logger.debug("Cannot decode the lobby sound %s", clip_id, exc_info=True)
                    raise AssetNotFound(("lobby-sound", core, clip_id)) from exc
                data = next(iter(samples.values()), None)
                if not data:
                    raise AssetNotFound(("lobby-sound", core, clip_id))
                return data
        return self._cached("lobby-sound/" + json.dumps([clip_id, spine_stamps([Path(bundle)])]), build, disk=False)

    def lobby_fx_texture(self, core: str, tex_id: str) -> bytes:
        """A texture of a lobby's particle effects as PNG (memory only): only ids the lobby's info lists."""
        if tex_id not in self.lobby_info(core).get("fx", {}).get("textures", {}):
            raise AssetNotFound(("lobby-fx", core, tex_id))
        cab, _, pid = tex_id.rpartition("_")
        bundle = self._cab_index(everything=True).get(cab)
        if bundle is None or not pid.lstrip("-").isdigit():
            raise AssetNotFound(("lobby-fx", core, tex_id))

        def build() -> bytes:
            with open_bundle(Path(bundle)) as env:
                obj = next((o for o in env.objects if o.path_id == int(pid) and o.assets_file.name.lower() == cab
                            and o.type.name == "Texture2D"), None)
                if obj is None:
                    raise AssetNotFound(("lobby-fx", core, tex_id))
                return png_bytes(obj.read().image)
        return self._cached("lobby-fx/" + json.dumps([tex_id, spine_stamps([Path(bundle)])]), build, disk=False)


# Unity's built-in meshes live in "Library/unity default resources", outside the bundles; the lobbies' effect quads
# use its Quad
_BUILTIN_QUAD = ("library/unity default resources", 10210)


def _builtin_quad(owner: Any, pointer: dict | None) -> tuple[str, None] | None:
    """("quad", None) for a pointer to Unity's built-in Quad mesh, else None."""
    fid, pid = (pointer or {}).get("m_FileID", 0), (pointer or {}).get("m_PathID", 0)
    try:
        path = owner.assets_file.externals[fid - 1].path if owner is not None and fid > 0 else ""
    except (AttributeError, IndexError):
        return None
    return ("quad", None) if (str(path).lower(), pid) == _BUILTIN_QUAD else None


class _FxResolver:
    """Reads what a lobby's renderers point at, for lobby.read_prefab: a particle material as (id, particles.material)
    with its textures (particles.texture), a mesh as (id, particles.mesh) (Unity's built-in Quad as ("quad", None)),
    the render queue of a skeleton's atlas pages ("pages": a SkeletonDataAsset, or one Material) as (id, {texture
    name: queue}), or their shaders' names ("shaders") as (id, {texture name: shader name}), the materials a skeleton
    is drawn with ("skeleton": a SkeletonDataAsset) as (id, spine_materials.skeleton) and an Animator's controller
    ("animator") as (id, {"decoded", "bindings", "loop"}) of its default state's clip. Ids are "<cab>_<path id>"."""

    def __init__(self, graph: Any, objects: dict[int, Any], shader_forms: dict):
        self.graph, self.objects, self.forms = graph, objects, shader_forms
        self.done: dict[tuple[str, str], Any] = {}

    def resolve(self, kind: str, owner: int, pointer: dict) -> tuple[str, Any] | None:
        from . import particles
        from .model import read_mesh

        g = self.graph
        own = self.objects.get(owner)
        obj = g.deref(own, pointer) if own is not None else None
        if obj is None:
            return _builtin_quad(own, pointer) if kind == "mesh" else None
        oid = f"{obj.assets_file.name.lower()}_{obj.path_id}"
        if (kind, oid) in self.done:
            return self.done[(kind, oid)]
        out = None
        try:
            if kind == "material" and obj.type.name == "Material":
                out = (oid, self._material(obj))
            elif kind == "mesh" and obj.type.name == "Mesh":
                data = read_mesh(obj.read())
                tris = [t for sub in data.triangles for t in sub]
                out = (oid, particles.mesh(data.vertices, data.uv0, data.normals, tris, data.colors))
            elif kind in ("pages", "shaders") and obj.type.name in ("MonoBehaviour", "Material"):
                out = (oid, self._pages(obj, kind))
            elif kind == "skeleton" and obj.type.name == "MonoBehaviour":
                out = (oid, self._skeleton(obj))
            elif kind == "animator" and obj.type.name == "AnimatorController":
                out = self._animator(obj, oid)
            elif kind == "timeline" and obj.type.name == "MonoBehaviour":
                from . import intro
                out = (oid, intro.read_timeline(g, obj, sound=self._sound))
            elif kind == "sprite" and obj.type.name == "Sprite":
                out = (oid, self._sprite(obj))
        except Exception:  # an unreadable object: the system is left out
            logger.debug("Cannot read lobby particle %s %s", kind, oid, exc_info=True)
            out = None
        self.done[(kind, oid)] = out
        return out

    def _sound(self, asset: Any, data: dict) -> dict | None:
        """A TimeLineAudioController's AudioData as a sound event (lobby.sound_event), with its id: the asset's."""
        def clip_id(pointer: dict) -> str | None:
            if not pointer.get("m_PathID"):
                return None
            cab, pid = reference(asset, pointer)
            return f"{cab.lower()}_{pid}"
        event = lobby.sound_event({"m_Name": "Intro", "AudioData": data}, clip_id)
        return {**event, "id": f"{asset.assets_file.name.lower()}_{asset.path_id}"} if event else None

    def _sprite(self, obj: Any) -> dict | None:
        """A Sprite as intro.sprite draws it: its texture (particles.texture), its rect in the texture's pixels, its
        size in units (rect / pixels per unit) and its pivot (0 to 1). The pixels are read when served."""
        from . import particles

        g = self.graph
        st = g.tree(obj)
        rd = st.get("m_RD") or {}
        tex = g.deref(obj, rd.get("texture"))
        if tex is None or tex.type.name != "Texture2D":
            return None
        tex_id = f"{tex.assets_file.name.lower()}_{tex.path_id}"
        info = particles.texture(g.tree(tex), tex_id)
        g.trees.pop((tex.assets_file.name.lower(), tex.path_id), None)
        r, tr = st.get("m_Rect") or {}, rd.get("textureRect") or {}
        ppu = float(st.get("m_PixelsToUnits") or 100.0) or 100.0
        pivot = st.get("m_Pivot") or {}
        return {"tex": info, "rect": [float(tr.get(k, 0.0)) for k in ("x", "y", "width", "height")],
                "size": [float(r.get("width", 0.0)) / ppu, float(r.get("height", 0.0)) / ppu],
                "pivot": [float(pivot.get("x", 0.5)), float(pivot.get("y", 0.5))]}

    def _pages(self, obj: Any, kind: str = "pages") -> dict[str, Any]:
        """{texture name: render queue} of a SkeletonDataAsset's atlas pages, as spine-unity draws them: each page with
        the material its SpineAtlasAsset lists for it (matched by the material's main texture name, which is the page's
        file name without its extension). For a Material, its own page. With kind "shaders", {texture name: the name
        of the material's shader} instead (a page without a shader is left out). The textures' pixels are never
        read."""
        g = self.graph
        materials = [obj]
        if obj.type.name == "MonoBehaviour":
            materials = []
            for atlas in (g.deref(obj, p) for p in g.tree(obj).get("atlasAssets") or []):
                if atlas is not None:
                    materials += [g.deref(atlas, p) for p in g.tree(atlas).get("materials") or []]
        out: dict[str, Any] = {}
        for mat in materials:
            if mat is None or mat.type.name != "Material":
                continue
            tree = g.tree(mat)
            envs = dict((tree.get("m_SavedProperties") or {}).get("m_TexEnvs", []))
            tex = g.deref(mat, (envs.get("_MainTex") or {}).get("m_Texture"))
            name = tex.peek_name() if tex is not None else None
            if name:
                shader, _, state = self._state(mat, tree)
                value = shader if kind == "shaders" else state["queue"]
                if value is not None:
                    out.setdefault(name, value)
        return out

    def _state(self, obj: Any, tree: dict) -> tuple[str | None, dict | None, dict]:
        """A material's shader name, the shader's parsed form (the parts read here) and the render state of its
        colour pass for this material (model.shader_state: blend and queue)."""
        from .model import shader_state

        g = self.graph
        shader = g.deref(obj, tree.get("m_Shader"))
        name, form = None, None
        if shader is not None:
            key = (shader.assets_file.name.lower(), shader.path_id)
            if key not in self.forms:
                # a shader's typetree carries its compiled programs: read once, keep the parts used here
                full = g.tree(shader).get("m_ParsedForm") or {}
                self.forms[key] = {"m_Name": full.get("m_Name"), "m_PropInfo": full.get("m_PropInfo", {"m_Props": []}),
                                   "m_SubShaders": [{"m_Tags": s.get("m_Tags"), "m_Passes": [
                                       {"m_State": p.get("m_State")} for p in s.get("m_Passes", [])]}
                                       for s in full.get("m_SubShaders", [])]}
                g.trees.pop((key[0], key[1]), None)
            form = self.forms[key]
            name = form.get("m_Name")
        props = tree.get("m_SavedProperties") or {}
        floats = {k: v for k, v in props.get("m_Floats", []) if isinstance(v, (int, float))}
        try:
            state = shader_state(form, floats, tree.get("m_CustomRenderQueue", -1)) if form else {}
        except (KeyError, TypeError, IndexError, ValueError):
            state = {}
        if not state:
            queue = tree.get("m_CustomRenderQueue", -1)
            state = {"src": 1, "dst": 0, "queue": queue if queue and queue >= 0 else 3000}
        return name, form, state

    def _material(self, obj: Any) -> dict:
        from . import particles

        g = self.graph
        tree = g.tree(obj)
        name, form, state = self._state(obj, tree)
        props = tree.get("m_SavedProperties") or {}
        textures = {}
        for prop, env in props.get("m_TexEnvs", []):
            tex = g.deref(obj, env.get("m_Texture"))
            if tex is not None and tex.type.name == "Texture2D":
                textures[prop] = particles.texture(g.tree(tex), f"{tex.assets_file.name.lower()}_{tex.path_id}")
                g.trees.pop((tex.assets_file.name.lower(), tex.path_id), None)  # its pixels are read when served
        out = particles.material(name, tree, state, form["m_PropInfo"].get("m_Props", []) if form else (), textures)
        out["cull"] = state.get("cull", 2)  # back faces are culled (2), front faces (1) or none (0): meshfx.py's meshes
        return out

    def _skeleton(self, obj: Any) -> dict:
        """The materials of a SkeletonDataAsset's atlas pages and its blend mode replacement materials
        (spine_materials.skeleton). Only the pages a ported shader draws read their other textures' settings; no
        pixels are read."""
        from . import spine_materials

        g = self.graph
        tree = g.tree(obj)
        mats = []
        for atlas in (g.deref(obj, p) for p in tree.get("atlasAssets") or []):
            if atlas is not None:
                for mat in (g.deref(atlas, p) for p in g.tree(atlas).get("materials") or []):
                    if mat is not None and mat.type.name == "Material":
                        mats.append(self._spine_material(mat))

        def replacement(pointer: dict) -> tuple[str | None, dict] | None:
            mat = g.deref(obj, pointer)
            return self._spine_material(mat) if mat is not None and mat.type.name == "Material" else None
        return spine_materials.skeleton(mats, tree.get("blendModeMaterials") or {}, replacement, tree.get("scale") or 0.01)

    def _spine_material(self, mat: Any) -> tuple[str | None, dict]:
        from . import particles, spine_materials

        g = self.graph
        tree = g.tree(mat)
        name, form, _ = self._state(mat, tree)
        envs = dict((tree.get("m_SavedProperties") or {}).get("m_TexEnvs", []))
        main = g.deref(mat, (envs.get("_MainTex") or {}).get("m_Texture"))
        textures = {}
        for prop, env in envs.items() if spine_materials.program(name) else ():
            tex = g.deref(mat, env.get("m_Texture")) if prop != "_MainTex" else None
            if tex is not None and tex.type.name == "Texture2D":
                textures[prop] = particles.texture(g.tree(tex), f"{tex.assets_file.name.lower()}_{tex.path_id}")
                g.trees.pop((tex.assets_file.name.lower(), tex.path_id), None)
        return (main.peek_name() if main is not None else None), spine_materials.material(name, form, tree, textures)

    def _animator(self, controller: Any, oid: str) -> tuple[str, dict] | None:
        """The clip an AnimatorController's first layer plays in its default state (the lobbies' controllers have one
        state, looping one clip), decoded (model.decode_clip) with its bindings."""
        from .model import decode_clip

        g = self.graph
        tree = g.tree(controller)
        clips = [g.deref(controller, p) for p in tree.get("m_AnimationClips") or []]
        machine = ((tree.get("m_Controller") or {}).get("m_StateMachineArray") or [{}])[0]
        machine = machine.get("data", machine)
        states = machine.get("m_StateConstantArray") or []
        clip = None
        if states:
            state = states[min(int(machine.get("m_DefaultState", 0)), len(states) - 1)]
            state = state.get("data", state)
            for blend in state.get("m_BlendTreeConstantArray") or []:
                for node in (blend.get("data", blend).get("m_NodeArray") or []):
                    node = node.get("data", node)
                    index = node.get("m_ClipID", -1)
                    if 0 <= index < len(clips) and clips[index] is not None:
                        clip = clips[index]
                        break
                if clip is not None:
                    break
        if clip is None or clip.type.name != "AnimationClip":
            return None
        ct = g.tree(clip)
        bindings = (ct.get("m_ClipBindingConstant") or {}).get("genericBindings", [])
        loop = bool((ct.get("m_MuscleClip") or {}).get("m_LoopTime", True))
        return oid, {"decoded": decode_clip(ct), "bindings": bindings, "loop": loop}
