"""The ordinary lobby's day/night NGUI background, read from the installed game."""

from __future__ import annotations

import copy
import logging
import hashlib
from pathlib import Path
from urllib.parse import quote

from ..errors import ServiceError
from .errors import AssetNotFound
from .layouts import export_layout
from .unity import open_bundle
from .spine_materials import blend_state

logger = logging.getLogger(__name__)
BACKGROUNDS = {
    "day": ("LobbyCommon", "UILobbyBackground_Day", "hall.officeDay",
            "ui-uilobbyelement-_mxload-prefabs-2025-07-02_assets_all_1158600183.bundle"),
    "night": ("LobbyCommonNight", "UILobbyBackground_Night", "hall.officeNight",
              "ui-uilobbyelement-_mxload-prefabs-2026-07-02_assets_all_1202836469.bundle"),
}


def texture_bundle(path: Path) -> bool:
    return path.name.startswith("uis-00_images-lobby-")


def _background_branch(node: dict, name: str) -> dict | None:
    """Keep the real background and its ancestor transforms, excluding students and dialogue."""
    if node["name"] == name:
        return copy.deepcopy(node)
    children = [branch for child in node.get("children", []) if (branch := _background_branch(child, name))]
    if not children:
        return None
    result = {**copy.deepcopy(node), "children": children}
    result["widgets"] = [widget for widget in result.get("widgets", [])
                         if not any(key in widget for key in ("texture", "sprite", "text"))]
    return result


def _textures(node: dict, active: bool = True) -> set[str]:
    active = active and node.get("active", True)
    if not active:
        return set()
    found = {widget["texture"] for widget in node.get("widgets", []) if "texture" in widget}
    for child in node.get("children", []):
        found.update(_textures(child, active))
    return found


def _stamps(paths: list[Path]) -> list[tuple] | None:
    result = []
    for path in paths:
        try:
            stat = path.stat()
            result.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        except FileNotFoundError:
            return None
    return result


def material_description(form: dict, material: dict | None = None) -> dict:
    """Read the shader's pass factors; unused material properties never override fixed state."""
    state = form["m_SubShaders"][0]["m_Passes"][0]["m_State"]
    blend = state.get("rtBlend0") or state["rtBlend"][0]
    floats = dict(((material or {}).get("m_SavedProperties") or {}).get("m_Floats", []))
    def value(key: str, default: int) -> int:
        field = blend.get(key, {})
        name = field.get("name")
        return int(floats[name] if name and name != "<noninit>" and name in floats else field.get("val", default))
    return {"shader": form["m_Name"], **blend_state(form, floats),
            "op": value("blendOp", 0), "opA": value("blendOpAlpha", 0), "mask": value("colMask", 15)}


def _add_materials(game, path: Path, tree: dict) -> set[Path]:
    """Resolve only active background UITexture materials, preserving the prefab's own geometry."""
    from .model import BundleGraph
    from .service import _MODEL_LOCK

    nodes = {}
    def collect(node: dict, parent: str = "") -> None:
        if not node.get("active", True):
            return
        name = f'{parent}/{node["name"]}' if parent else node["name"]
        nodes[name] = node
        for child in node.get("children", []):
            collect(child, name)
    collect(tree)
    index = game._cab_index(everything=True)
    with _MODEL_LOCK, BundleGraph(index, opener=open_bundle) as graph:
        env = graph.add(path)
        objects = {obj.path_id: obj for obj in env.objects}
        names, owners, parents = {}, {}, {}
        for pid, obj in objects.items():
            if obj.type.name == "GameObject":
                names[pid] = graph.tree(obj)["m_Name"]
            elif obj.type.name in ("Transform", "RectTransform"):
                data = graph.tree(obj)
                owner = data["m_GameObject"]["m_PathID"]
                owners[pid] = owner
                parents[owner] = data["m_Father"]["m_PathID"]
        def node_path(gid: int) -> str:
            parts, seen = [], set()
            while gid in names and gid not in seen:
                seen.add(gid)
                parts.append(names[gid])
                gid = owners.get(parents.get(gid))
            return "/".join(reversed(parts))
        for obj in objects.values():
            if obj.type.name != "MonoBehaviour":
                continue
            data = graph.tree(obj)
            if "mTexture" not in data or "mWidth" not in data:
                continue
            node = nodes.get(node_path(data.get("m_GameObject", {}).get("m_PathID")))
            if node is None:
                continue
            pointer = data.get("mMat") or {}
            material = graph.deref(obj, pointer)
            if pointer.get("m_PathID") and material is None:
                raise AssetNotFound("Office material unavailable")
            saved = graph.tree(material) if material else None
            shader = graph.deref(material, saved.get("m_Shader")) if material else graph.deref(obj, data.get("mShader"))
            if shader is None:
                raise AssetNotFound("Office shader unavailable")
            description = material_description(graph.tree(shader)["m_ParsedForm"], saved)
            for widget in node.get("widgets", []):
                if "texture" in widget:
                    widget["material"] = description
        return {Path(p) for p in graph.loaded if Path(p) != path}


def inventory(game) -> dict:
    paths = game._paths()
    by_name = {path.name: path for path in paths}
    textures = [path for path in paths if texture_bundle(path)]
    prefabs = {key: by_name.get(spec[3]) for key, spec in BACKGROUNDS.items()}
    # Changed resource filenames are discovered only in the lobby prefab family.
    fallback = [path for path in paths if path.name.startswith("ui-uilobbyelement-")] if not all(prefabs.values()) else []
    watched = sorted(set(textures + [path for path in prefabs.values() if path] + fallback))
    stamps = _stamps(watched)
    if stamps is None:
        return {}
    with game._lock("office-backgrounds"):
        shared_paths = game._indexes.get("office-shared-paths", [])
        material_paths = game._indexes.get("office-material-paths", [])
        shared_stamps = _stamps(shared_paths)
        material_stamps = _stamps(material_paths)
        if (shared_stamps is not None and game._indexes.get("office-background-stamps") == stamps
                and material_stamps is not None and game._indexes.get("office-shared-stamps") == shared_stamps
                and game._indexes.get("office-material-stamps") == material_stamps):
            return game._indexes["office-backgrounds"]
        if not textures:
            return {}
        if fallback:
            missing = {spec[0].casefold(): key for key, spec in BACKGROUNDS.items() if prefabs[key] is None}
            for path in fallback:
                try:
                    with open_bundle(path) as env:
                        roots = {Path(name.replace("\\", "/")).stem.casefold() for name in env.container}
                    for root in roots & missing.keys():
                        prefabs[missing[root]] = path
                except (OSError, ServiceError):
                    continue
                if all(prefabs.values()):
                    break
        texture_index = game._scan_textures(textures)
        # Reuse already supported shared textures when the prefab references a common layer.
        shared = game._texture_index()
        refreshed = game._scan_textures([path for path in shared_paths if path.is_file()]) if shared_paths else {"names": {}, "textures": {}}
        replaced = {path.name for path in shared_paths}
        names = {**shared["names"], **refreshed["names"], **texture_index["names"]}
        records = {**{name: record for name, record in shared["textures"].items() if record["bundle"] not in replaced},
                   **refreshed["textures"], **texture_index["textures"]}
        result, material_dependencies = {}, set()
        for key, (root, branch, label, _) in BACKGROUNDS.items():
            path = prefabs[key]
            if path is None:
                continue
            try:
                with open_bundle(path) as env:
                    tree = _background_branch(export_layout(env, root, names), branch)
                if tree is None:
                    continue
                material_dependencies.update(_add_materials(game, path, tree))
                required = _textures(tree)
                if not required or not required <= records.keys():
                    continue
                result[key] = {"tree": tree, "records": {name: records[name] for name in required},
                               "label": label}
            except (OSError, ServiceError, ValueError, KeyError):
                logger.info("Office background unavailable: %s", key)
        background_bundles = {path.name for path in textures}
        dependencies = {record["bundle"] for value in result.values() for record in value["records"].values()
                        if record["bundle"] not in background_bundles}
        dependencies.update(replaced)
        shared_paths = [by_name[name] for name in sorted(dependencies) if name in by_name]
        game._indexes["office-shared-paths"] = shared_paths
        game._indexes["office-shared-stamps"] = _stamps(shared_paths)
        game._indexes["office-material-paths"] = sorted(material_dependencies)
        game._indexes["office-material-stamps"] = _stamps(sorted(material_dependencies))
        revision = hashlib.sha256(repr((stamps, game._indexes["office-shared-stamps"],
                                        game._indexes["office-material-stamps"])).encode()).hexdigest()[:24]
        for value in result.values():
            value["revision"] = revision
        game._indexes["office-background-stamps"], game._indexes["office-backgrounds"] = stamps, result
        return result


def choices(game) -> list[dict]:
    try:
        available = inventory(game)
    except (OSError, ServiceError, ValueError, KeyError):
        logger.info("Office backgrounds unavailable in this install")
        return []
    return [{"name": "office-" + key, "labelKey": data["label"],
             "layoutUrl": f"/asset/office/{key}/layout.json"} for key, data in available.items()]


def layout(game, key: str) -> dict:
    value = inventory(game).get(key)
    if value is None:
        raise AssetNotFound(key)
    return {"tree": copy.deepcopy(value["tree"]), "textures": {
        name: f"/asset/office/{key}/texture/{quote(name, safe='')}.png?revision={value['revision']}"
        for name in value["records"]}}


def texture_record(game, key: str, name: str) -> dict:
    value = inventory(game).get(key)
    if value is None or name not in value["records"]:
        raise AssetNotFound(name)
    return value["records"][name]
