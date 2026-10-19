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

from .. import devmode
from ..errors import ServiceError
from .cache import AssetCache
from . import lobby
from .discovery import (
    bundle_paths, cab_names, group_bundles, is_atlas, is_layout_texture,
    is_lobby_prefab, is_model_dependency, is_pointer_texture, is_prefab, is_texture, resource_version,
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
        stamps = [(path.name, path.stat().st_size, path.stat().st_mtime_ns) for path in bundles if path.exists()]

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
        return self._cached("lobby-sound/" + clip_id, build, disk=False)

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
        return self._cached("lobby-fx/" + tex_id, build, disk=False)


class _FxResolver:
    """Reads what a lobby's renderers point at, for lobby.read_prefab: a particle material as (id, particles.material)
    with its textures (particles.texture), a mesh as (id, particles.mesh), and the render queue of a skeleton's atlas
    pages ("pages": a SkeletonDataAsset, or one Material) as (id, {texture name: queue}). Ids are "<cab>_<path id>"."""

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
            return None
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
            elif kind == "pages" and obj.type.name in ("MonoBehaviour", "Material"):
                out = (oid, self._pages(obj))
        except Exception:  # an unreadable object: the system is left out
            logger.debug("Cannot read lobby particle %s %s", kind, oid, exc_info=True)
            out = None
        self.done[(kind, oid)] = out
        return out

    def _pages(self, obj: Any) -> dict[str, int]:
        """{texture name: render queue} of a SkeletonDataAsset's atlas pages, as spine-unity draws them: each page with
        the material its SpineAtlasAsset lists for it (matched by the material's main texture name, which is the page's
        file name without its extension). For a Material, its own page. The textures' pixels are never read."""
        g = self.graph
        materials = [obj]
        if obj.type.name == "MonoBehaviour":
            materials = []
            for atlas in (g.deref(obj, p) for p in g.tree(obj).get("atlasAssets") or []):
                if atlas is not None:
                    materials += [g.deref(atlas, p) for p in g.tree(atlas).get("materials") or []]
        out: dict[str, int] = {}
        for mat in materials:
            if mat is None or mat.type.name != "Material":
                continue
            tree = g.tree(mat)
            envs = dict((tree.get("m_SavedProperties") or {}).get("m_TexEnvs", []))
            tex = g.deref(mat, (envs.get("_MainTex") or {}).get("m_Texture"))
            name = tex.peek_name() if tex is not None else None
            if name:
                out.setdefault(name, self._state(mat, tree)[2]["queue"])
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
        return particles.material(name, tree, state, form["m_PropInfo"].get("m_Props", []) if form else (), textures)
