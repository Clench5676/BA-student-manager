"""Lazy game asset service for the web UI's asset routes."""

from __future__ import annotations

import json
import logging
import re
import threading
from collections.abc import Iterable
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from ..errors import ServiceError
from .cache import AssetCache
from .discovery import (
    bundle_paths, cab_names, group_bundles, is_atlas, is_layout_texture,
    is_model_dependency, is_prefab, is_texture, resource_version,
)
from .errors import AssetNotFound
from .layouts import export_layout, subtree
from .spine import extract_spine, png_bytes
from .unity import find_object, object_record, open_bundle, reference, ref_key

logger = logging.getLogger(__name__)
_SCHEMA = "gameassets-v1/"
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
    "UICharacterDetail": "ui-_mxload-prefabs-2025-07-02_assets_all_2968814143.bundle",
    "UIPopup_Option_PC": "ui-_mxload-prefabs-2025-11-28_assets_all_1183413113.bundle",
}


class GameAssets:
    """Read light UI assets and heavy character art from the user's install.

    Construction only checks directory existence. Discovery, version hashing,
    Unity loading and index construction happen on the first relevant request.
    Index locks prevent duplicate scans, while per-path locks serialize all
    Unity operations even across different service instances.
    """

    def __init__(self, resource_dirs: list[Path], cache: AssetCache):
        self.resource_dirs = list(dict.fromkeys(Path(p).resolve() for p in resource_dirs if Path(p).is_dir()))
        if not self.resource_dirs:
            raise ServiceError("game_not_found")
        self.cache = cache
        self._guard = threading.RLock()
        self._locks: dict[str, threading.RLock] = {}
        self._indexes: dict[str, Any] = {}

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
        with self._lock("bundle-names"):
            if "bundle-names" not in self._indexes:
                self._indexes["bundle-names"] = {path.name: path for path in self._paths()}
            try:
                return self._indexes["bundle-names"][name]
            except KeyError:
                raise AssetNotFound(name) from None

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
        return self._index("atlases", self._scan_atlases)

    def _scan_atlases(self) -> dict:
        atlases, objects, materials, names = {}, {}, {}, {}
        for path in filter(is_atlas, self._paths()):
            with open_bundle(path) as env:
                for obj in env.objects:
                    key = ref_key(obj.assets_file.name, obj.path_id)
                    if obj.type.name == "MonoBehaviour":
                        tree = obj.read_typetree()
                        if "mSprites" in tree:
                            name = tree["m_Name"]
                            atlases[name] = (key, tree, obj.assets_file.name,
                                             [ext.path for ext in obj.assets_file.externals])
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
        by_key = {value[0]: value for value in atlases.values()}
        sprites, images = {}, {}
        for name, entry in atlases.items():
            seen = set()
            while True:
                key, tree, cab, externals = entry
                replacement = tree.get("mReplacement", {})
                if not replacement.get("m_PathID") or key in seen:
                    break
                seen.add(key)
                fid = replacement.get("m_FileID", 0)
                target = cab if not fid else externals[fid - 1].replace("\\", "/").rsplit("/", 1)[-1]
                entry = by_key.get(ref_key(target, replacement["m_PathID"]), entry)
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
        key = "image/" + ref_key(record["cab"], record["pid"])
        with self._lock(key):
            image = self.cache.get(_SCHEMA + key, version=self.resource_version, disk=False)
            if image is None:
                with open_bundle(self._bundle_path(record["bundle"])) as env:
                    image = find_object(env, record).read().image
                    image.load()
                self.cache.put(_SCHEMA + key, image, version=self.resource_version, disk=False)
            return image

    def sprite_png(self, atlas: str, sprite: str) -> bytes:
        """Crop a named atlas sprite and return PNG bytes."""
        def build() -> bytes:
            index = self._atlas_index()
            try:
                rect = index["sprites"][atlas][sprite]
                record = index["images"][atlas]
            except KeyError:
                raise AssetNotFound((atlas, sprite)) from None
            image = self._image(record)
            # NGUI's mSprites uses top-left coordinates. UnityPy has already
            # flipped the decoded Unity texture into Pillow's top-left space.
            x, y = rect["x"], rect["y"]
            return png_bytes(image.crop((x, y, x + rect["width"], y + rect["height"])))
        return self._cached("sprite/" + json.dumps([atlas, sprite]), build)

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

    def texture_png(self, name: str) -> bytes:
        """Decode a shared UI texture and return PNG bytes."""
        def build() -> bytes:
            try:
                record = self._texture_index()["textures"][name]
            except KeyError:
                raise AssetNotFound(name) from None
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
        data = self._cached("layout/" + root, encode)
        try:
            tree = json.loads(data)
        except (ValueError, UnicodeError):
            logger.warning("Rebuilding invalid prefab layout %s", root)
            tree = build()
            self.cache.put(_SCHEMA + "layout/" + root, json.dumps(tree).encode(),
                           version=self.resource_version)
        return subtree(tree, subpath)

    def _collection(self) -> dict:
        def build() -> dict:
            paths = [p for p in self._paths() if p.name.startswith("uis-01_common-14_charactercollect-")]
            textures = self._scan_textures(paths)["textures"]
            return {name: record for name, record in textures.items()
                    if name.endswith("_Collection") and name.startswith(("BG_", "Student_Portrait_"))}
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
        categories = {"spr": "spinecharacters", "lobby": "spinelobbies"}
        if kind not in categories:
            raise AssetNotFound(kind)
        # shared bundles of the category (e.g. "_mxcommon-.asset") are not skeletons
        valid = (lambda core: core.endswith("_spr")) if kind == "spr" else (lambda core: True)
        groups = self._index("spine-cores/" + kind, lambda: {
            core: [str(path) for path in paths]
            for core, paths in group_bundles(self._paths(), categories[kind]).items()
            if re.fullmatch(r"[a-z0-9_]+", core) and valid(core)
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
        stamps = []
        for path in paths:
            try:
                stat = path.stat()
            except FileNotFoundError:
                raise AssetNotFound(str(path)) from None
            stamps.append((str(path), stat.st_size, stat.st_mtime_ns))
        key = "spine/" + json.dumps(stamps)
        with self._lock(key):
            value = self.cache.get(_SCHEMA + key, version=self.resource_version, disk=False)
            if value is None:
                value = extract_spine(paths)
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
        stamps = []
        for path in [*bundles, *overrides]:
            try:
                stat = path.stat()
            except FileNotFoundError:
                raise AssetNotFound(str(path)) from None
            stamps.append((str(path), stat.st_size, stat.st_mtime_ns))
        key = _SCHEMA + "model/" + json.dumps([core, stamps])
        with _MODEL_LOCK:
            data = self.cache.get(key, version=self.resource_version, disk=False)
            if data is None:
                index = self._cab_index()
                with BundleGraph(index, overrides, fallback=lambda: self._cab_index(everything=True)) as graph:
                    data = export_chibi(graph, bundles, core)
                self.cache.put(key, data, version=self.resource_version, disk=False)
            return data
