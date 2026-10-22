"""Read-only bundle preflight and Spine inputs for the web runtime's compatibility check."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from pathlib import Path

from .. import devmode
from ..bundle import Bundle
from ..errors import ServiceError
from ..gameassets.spine import atlas_pages
from ..models import AssetKey, AssetType
from ..spine import get_skel_version


def basename(name: str) -> str:
    return name.replace("\\", "/").rsplit("/", 1)[-1].lower()


def texture_key(name: str) -> str:
    return basename(name).removesuffix(".png")


@dataclass
class Contents:
    platforms: set[str] = field(default_factory=set)
    names: set[str] = field(default_factory=set)
    files: set[str] = field(default_factory=set)
    references: set[str] = field(default_factory=set)
    reference_paths: set[str] = field(default_factory=set)
    streams: set[str] = field(default_factory=set)
    reference_names: dict[str, str] = field(default_factory=dict)
    skeletons: dict[str, bytes] = field(default_factory=dict)
    atlases: dict[str, bytes] = field(default_factory=dict)
    textures: dict[str, tuple[int, int]] = field(default_factory=dict)

    def merge(self, other: Contents) -> None:
        for key in ("platforms", "names", "files", "references", "reference_paths", "streams"):
            getattr(self, key).update(getattr(other, key))
        for key in ("skeletons", "atlases", "textures", "reference_names"):
            getattr(self, key).update(getattr(other, key))

    def spine(self) -> dict:
        return {"skeletons": {name: {"version": get_skel_version(data),
                                    "data": base64.b64encode(data).decode("ascii")}
                              for name, data in self.skeletons.items()},
                "atlases": {name: data.decode("utf-8-sig", errors="replace") for name, data in self.atlases.items()},
                "textures": self.textures}


class Inspection:
    """A single analysis snapshot; never reused for execution or after input changes."""

    def __init__(self):
        self._bundles: dict[Path, Bundle] = {}
        self._contents: dict[Path, Contents] = {}
        self._keys: dict[Path, set[AssetKey]] = {}
        self._readable: dict[Path, set[AssetKey]] = {}

    def bundle(self, path: Path) -> Bundle:
        if path not in self._bundles:
            devmode.check_read(path)
            bundle = Bundle.load(path)
            if bundle is None:
                raise ServiceError("bundle_invalid", file=path.name)
            self._bundles[path] = bundle
        return self._bundles[path]

    def inspect(self, path: Path, *, allow_unknown: bool = False) -> Contents:
        if path not in self._contents:
            self._contents[path] = inspect(path, allow_unknown=True, inspection=self)
        result = self._contents[path]
        if not allow_unknown and (not result.platforms or "UnknownPlatform" in result.platforms):
            raise ServiceError("mod_platform_unknown", file=path.name)
        return result

    def keys(self, path: Path) -> set[AssetKey]:
        if path not in self._keys:
            self._keys[path] = self.bundle(path).get_asset_keys("name_type", {
                AssetType.Texture2D, AssetType.TextAsset, AssetType.Mesh, AssetType.AnimationClip})
        return self._keys[path]

    def readable_keys(self, path: Path) -> set[AssetKey]:
        if path not in self._readable:
            # Use the execution reader, including texture decoding and mesh stream resolution.
            # Source choices select conversion routes; they do not override serialized Unity metadata.
            patch, _ = self.bundle(path).extract_patch(
                {"Texture2D", "TextAsset", "Mesh", "AnimationClip"}, "name_type")
            self._readable[path] = set(patch)
        return self._readable[path]


def inspect(path: Path, *, allow_unknown: bool = False, inspection: Inspection | None = None) -> Contents:
    """Read metadata and text assets, without decoding images or following external paths."""
    devmode.check_read(path)
    bundle = inspection.bundle(path) if inspection else Bundle.load(path)
    if bundle is None:
        raise ServiceError("bundle_invalid", file=path.name)
    result = Contents(names={path.name.removesuffix(".backup")})

    def reference(path: str) -> str:
        name = basename(path)
        result.references.add(name)
        result.reference_paths.add(path.replace("\\", "/"))
        result.reference_names[name] = path.replace("\\", "/").rsplit("/", 1)[-1]
        return name

    def walk(file, name: str = "") -> None:
        if name:
            result.files.add(basename(name))
        if hasattr(file, "target_platform"):
            platform = file.target_platform
            result.platforms.add(getattr(platform, "name", str(platform)))
            for ref in file.externals:
                if ref.path:
                    reference(ref.path)
            # SerializedFile.files contains ObjectReaders keyed by numeric path IDs.
            return
        for child_name, child in getattr(file, "files", {}).items():
            walk(child, child_name)

    walk(bundle.env)
    if not allow_unknown and (not result.platforms or "UnknownPlatform" in result.platforms):
        raise ServiceError("mod_platform_unknown", file=path.name)
    result.names.update(getattr(bundle.env, "container", {}))
    for obj in bundle.env.objects:
        if obj.type.name == "AssetBundle":
            data = obj.read()
            result.names.update(filter(None, [getattr(data, "m_Name", ""),
                getattr(data, "m_AssetBundleName", ""), *getattr(data, "m_Dependencies", [])]))
        if obj.type.name == "Texture2D":
            data = obj.read()
            result.textures[texture_key(data.m_Name)] = (data.m_Width, data.m_Height)
            stream = getattr(data, "m_StreamData", None)
            if stream and stream.path:
                result.streams.add(reference(stream.path))
        elif obj.type.name == "Mesh":
            stream = getattr(obj.read(), "m_StreamData", None)
            if stream and stream.path:
                result.streams.add(reference(stream.path))
        elif obj.type.name == "AudioClip":
            stream = getattr(obj.read(), "m_Resource", None)
            if stream and stream.m_Source and stream.m_Size:
                result.streams.add(reference(stream.m_Source))
        elif obj.type.name == "TextAsset":
            name = obj.peek_name() or ""
            if name.lower().endswith((".skel", ".atlas")):
                script = obj.read().m_Script
                raw = script if isinstance(script, bytes) else script.encode("utf-8", "surrogateescape")
                (result.skeletons if name.lower().endswith(".skel") else result.atlases)[name] = raw
    return result


def check_platform(contents: Contents, path: Path, expected: set[str]) -> None:
    if contents.platforms != expected:
        raise ServiceError("mod_platform_mismatch", file=path.name,
                           platform=", ".join(sorted(contents.platforms)), expected=", ".join(sorted(expected)))


def missing_parts(effective: Contents, official: Contents) -> set[str]:
    # Current shared references (shaders, materials) remain supplied by the install.
    # A reference to an omitted part of this core must resolve in the effective set.
    shared = official.references - official.files
    missing = effective.references - effective.files - shared
    missing.update(effective.streams - effective.files)
    for data in effective.atlases.values():
        try:
            missing.update(basename(page) for page in atlas_pages(data) if texture_key(page) not in effective.textures)
        except UnicodeDecodeError:
            pass  # The compatibility report identifies unreadable atlas data.
    atlas_keys = {basename(name).removesuffix(".atlas") for name in effective.atlases}
    skeleton_keys = {basename(name).removesuffix(".skel") for name in effective.skeletons}
    unpaired = skeleton_keys - atlas_keys
    # Match the preview's single remaining pair, whose names may differ in the game too.
    if not (len(unpaired) == 1 and len(atlas_keys - skeleton_keys) == 1):
        missing.update(name + ".atlas" for name in unpaired)
    return missing
