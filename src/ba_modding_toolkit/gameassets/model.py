"""In-memory export of a student's 3D chibi (prefab, meshes, skins, textures, clips) to one GLB.

The prefabs are in the bundle family ``character-<dev>-_mxload-*``; their meshes, materials, textures and clips sit
in other bundles and are reached through external CAB references. :class:`BundleGraph` loads only the bundles the
used objects point into, by a CAB -> bundle index. :func:`export_chibi` walks one prefab and writes the skinned
meshes, the skeleton, the textures as PNG, the game's material constants (material extras), the halo follower and
the mouth receiver (root extras) and the clips, decoded from Unity's streamed, dense and constant curves, with the
renderers they switch on and off (animation extras).

Unity is left-handed (+Z forward), glTF right-handed: positions, rotations and bind matrices are mirrored on X.
Nothing is written to disk.
"""

from __future__ import annotations

import io
import json
import logging
import math
import struct
import zlib
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

import UnityPy.helpers.MeshHelper as MeshHelper
from UnityPy.helpers.MeshHelper import MeshHandler
from UnityPy.helpers.PackedBitVector import reshape, unpack_floats, unpack_ints

from .discovery import cab_names
from .errors import AssetNotFound
from .unity import open_bundle

logger = logging.getLogger(__name__)

# The clips put in the GLB (by name suffix): the formation idle (weapon in hand) is the default loop.
DEFAULT_CLIPS = ("Formation_Idle", "Formation_Pickup", "Cafe_Idle", "Cafe_Reaction", "Cafe_Walk",
                 "Victory_Start", "Victory_End")
# idles used when a prefab has neither the formation nor the cafe idle (NPC and battle-only prefabs)
FALLBACK_IDLES = ("Normal_Idle", "Stand_Idle", "Idle")
PREFAB_KINDS = {"echelon": "Echelon_{}", "battle": "{}", "cafe": "Cafe_{}", "strategy": "Strategy_{}"}
SHADER_KINDS = {
    "MX/C-Face": "face", "MX/C-General/Layer4": "body", "MX/C-Hair": "hair", "MX/C-EyesMouth": "eyemouth",
    "MX/C-Eyebrow-OneColor": "eyebrow", "MX/C-Eyebrow": "eyebrow", "MX/C-Halo/UnlitTextured": "halo",
    "MX/C-Halo/Simple": "halo", "MX/C-Weapon": "weapon", "MX/C-General/Single": "general",
    "MX/C-Simple-Transparent": "transparent", "Unlit/TexColorHDR": "unlit",
}
_ARRAY = 34962
_INDICES = 34963


# --- UnityPy 1.23 fixes -------------------------------------------------------------------------------------------

def safe_unpack_floats(packed: Any, start: int = 0, count: int | None = None, shape: tuple | None = None) -> list:
    """``unpack_floats`` that accepts ``m_BitSize == 0``: every value then equals ``m_Start`` (UnityPy divides by
    ``(1 << 0) - 1`` there)."""
    if not packed.m_BitSize:
        n = (packed.m_NumItems - start) if count is None else count
        return reshape([float(packed.m_Start)] * n, shape)
    return unpack_floats(packed, start, count, shape)


# MeshHandler looks the function up in its own module; only the m_BitSize == 0 case behaves differently
MeshHelper.unpack_floats = safe_unpack_floats


def compressed_skin(weights: list[int], bones: list[int], vertex_count: int) -> tuple[list[list[float]], list[list[int]]]:
    """Per-vertex weights and bone indices of a compressed mesh, summed as integers.

    Weights are 5-bit (a vertex's weights add up to 31). After three weights that fall short, the fourth is implied
    (31 - sum) and only its bone index is stored. UnityPy sums the weights as floats, where 1/31 + 25/31 + 5/31 < 1,
    reads a phantom fourth weight and shifts every later vertex.
    """
    w_rows = [[0, 0, 0, 0] for _ in range(vertex_count)]
    j_rows = [[0, 0, 0, 0] for _ in range(vertex_count)]
    bone = lambda i: bones[i] if i < len(bones) else 0  # noqa: E731
    v = j = total = bi = 0
    for w in weights:
        if v >= vertex_count:
            break
        w_rows[v][j], j_rows[v][j] = w, bone(bi)
        bi += 1
        j += 1
        total += w
        if total >= 31:
            v, j, total = v + 1, 0, 0
        elif j == 3:
            w_rows[v][3], j_rows[v][3] = 31 - total, bone(bi)
            bi += 1
            v, j, total = v + 1, 0, 0
    return [[x / 31 for x in row] for row in w_rows], j_rows


# VertexFormat (Unity 2019+): UNorm8, SNorm8, UNorm16, SNorm16
_NORM = {2: 255.0, 3: 127.0, 4: 65535.0, 5: 32767.0}
_CHANNEL_ATTRS = {0: "m_Vertices", 1: "m_Normals", 2: "m_Tangents", 3: "m_Colors", 4: "m_UV0", 5: "m_UV1",
                  6: "m_UV2", 7: "m_UV3", 12: "m_BoneWeights"}


def fix_vertex_formats(mesh: Any, handler: Any) -> None:
    """Scale normalised integer vertex channels to floats; UnityPy returns them raw (UNorm8 colours as 0..255,
    which drew giant outline hulls, since the outline width is in the colour alpha)."""
    data = mesh.m_VertexData
    if data is None or not data.m_Channels or tuple(getattr(handler, "version", (2019,)))[0] < 2019:
        return
    for channel, info in enumerate(data.m_Channels):
        scale, attr = _NORM.get(info.format), _CHANNEL_ATTRS.get(channel)
        if not info.dimension or scale is None or attr is None:
            continue
        values = getattr(handler, attr, None)
        if values:
            setattr(handler, attr, [tuple(max(-1.0, x / scale) for x in v) for v in values])


def pad_skin(joints: list | None, weights: list | None, count: int) -> tuple[list | None, list | None]:
    """Four joints and normalised weights per vertex. Rigid props have one BlendIndices component and no
    BlendWeight channel: that is weight 1 on the one bone."""
    if not joints:
        return None, None
    joints = [tuple(int(x) for x in j) + (0,) * (4 - len(j)) for j in joints]
    if not weights:
        weights = [(1.0, 0.0, 0.0, 0.0)] * count
    out = []
    for w in weights:
        w = tuple(w) + (0.0,) * (4 - len(w))
        total = sum(w) or 1.0
        out.append(tuple(x / total for x in w))
    return joints, out


@dataclass
class MeshData:
    vertices: list
    normals: list | None
    uv0: list | None
    uv1: list | None
    colors: list | None
    tangents: list | None
    joints: list | None
    weights: list | None
    triangles: list[list[tuple[int, int, int]]]


def read_mesh(mesh: Any) -> MeshData:
    """Decode a Unity Mesh object with the fixes above; triangles per submesh, baseVertex applied."""
    cm = mesh.m_CompressedMesh
    packed_skin = bool(cm and cm.m_Weights.m_NumItems)
    if packed_skin:
        # UnityPy's own weight decoding can run past the bone index list (StopIteration): skip it, decode below
        items, cm.m_Weights.m_NumItems = cm.m_Weights.m_NumItems, 0
    try:
        handler = MeshHandler(mesh)
        handler.process()
    finally:
        if packed_skin:
            cm.m_Weights.m_NumItems = items
    count = handler.m_VertexCount
    fix_vertex_formats(mesh, handler)
    if packed_skin:
        weights, joints = compressed_skin(unpack_ints(cm.m_Weights), unpack_ints(cm.m_BoneIndices), count)
    else:
        weights, joints = handler.m_BoneWeights, handler.m_BoneIndices
    joints, weights = pad_skin(joints, weights, count)
    triangles = []
    for sub, tris in zip(mesh.m_SubMeshes, handler.get_triangles()):
        base = getattr(sub, "baseVertex", 0) or 0
        triangles.append([(a + base, b + base, c + base) for a, b, c in tris])
    return MeshData(handler.m_Vertices or [], handler.m_Normals, handler.m_UV0, handler.m_UV1, handler.m_Colors,
                    handler.m_Tangents, joints, weights, triangles)


# --- math (Unity -> glTF: mirror X) -------------------------------------------------------------------------------

def mpos(v: Iterable[float]) -> tuple[float, float, float]:
    x, y, z = v
    return (-x, y, z)


def mquat(q: Iterable[float]) -> tuple[float, float, float, float]:
    x, y, z, w = q
    return (x, -y, -z, w)


def mirror_matrix(e: Mapping[str, float]) -> list[float]:
    """A Unity Matrix4x4 typetree (e<row><col>) as the mirrored S*M*S, column-major for glTF."""
    s = (-1, 1, 1, 1)
    return [e[f"e{r}{c}"] * s[r] * s[c] for c in range(4) for r in range(4)]


def quat_norm(q: Iterable[float]) -> tuple[float, ...]:
    q = tuple(q)
    n = math.sqrt(sum(x * x for x in q)) or 1.0
    return tuple(x / n for x in q)


def qmul(a: tuple, b: tuple) -> tuple[float, float, float, float]:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def euler_to_quat(e: Iterable[float]) -> tuple[float, float, float, float]:
    """Unity Euler degrees, applied Z, then X, then Y: q = qy * qx * qz."""
    x, y, z = (math.radians(a) / 2 for a in e)
    qx, qy, qz = (math.sin(x), 0, 0, math.cos(x)), (0, math.sin(y), 0, math.cos(y)), (0, 0, math.sin(z), math.cos(z))
    return qmul(qmul(qy, qx), qz)


# --- animation clips (generic mecanim clips: streamed + dense + constant curves) -----------------------------------

def binding_dims(binding: Mapping[str, int]) -> int:
    """How many curves a generic binding takes: Transform (typeID 4) position, scale and Euler 3, rotation 4."""
    if binding["typeID"] == 4:
        return 4 if binding["attribute"] == 2 else 3 if binding["attribute"] in (1, 3, 4) else 1
    return 1


def read_streamed(words: list[int]) -> list[tuple[float, list[tuple[int, float, float, float, float]]]]:
    """The frames of a streamed clip: [(time, [(curve, c0, c1, c2, c3), ...])].

    Each key stores the cubic of the segment that starts at it, value(t) = ((c0*dt + c1)*dt + c2)*dt + c3. The first
    frame is a slope helper at -inf, the last one sits at +inf.
    """
    data = struct.pack(f"<{len(words)}I", *words)
    frames, pos = [], 0
    while pos + 8 <= len(data):
        time, count = struct.unpack_from("<fi", data, pos)
        pos += 8
        keys = [struct.unpack_from("<i4f", data, pos + i * 20) for i in range(count)]
        pos += count * 20
        frames.append((time, keys))
    return frames


@dataclass
class DecodedClip:
    duration: float
    times: list[float]
    curves: dict[int, list[float]]  # curve index -> one value per time, or a single value (constant)


def decode_clip(tt: Mapping[str, Any]) -> DecodedClip:
    """Sample a clip typetree on a uniform grid at its sample rate. Curve index space: streamed, then dense, then
    constant curves."""
    muscle = tt["m_MuscleClip"]
    clip = muscle["m_Clip"]["data"]
    start, stop = muscle["m_StartTime"], muscle["m_StopTime"]
    rate = tt.get("m_SampleRate") or 30.0
    times = [start + i / rate for i in range(max(1, int(round((stop - start) * rate)) + 1))]
    streamed, dense, constant = clip["m_StreamedClip"], clip["m_DenseClip"], clip["m_ConstantClip"]
    curves: dict[int, list[float]] = {}
    keys: dict[int, list[tuple]] = {}
    for time, frame in (read_streamed(streamed["data"]) if streamed["data"] else []):
        if -1e30 < time < 1e30:
            for curve, c0, c1, c2, c3 in frame:
                keys.setdefault(curve, []).append((time, c0, c1, c2, c3))
    for curve, ks in keys.items():
        values, j = [], 0
        for t in times:
            while j + 1 < len(ks) and ks[j + 1][0] <= t + 1e-6:
                j += 1
            kt, c0, c1, c2, c3 = ks[j]
            dt = t - kt
            values.append(c3 if dt < 0 else ((c0 * dt + c1) * dt + c2) * dt + c3)  # before the first key: hold it
        curves[curve] = values
    offset = streamed["curveCount"]
    count, frames = dense["m_CurveCount"], dense["m_FrameCount"]
    if count and frames:
        samples, drate, begin = dense["m_SampleArray"], dense["m_SampleRate"], dense["m_BeginTime"]
        for i in range(count):
            values = []
            for t in times:
                f = min(max((t - begin) * drate, 0), frames - 1)
                f0 = int(f)
                f1, a = min(f0 + 1, frames - 1), f - f0
                values.append(samples[f0 * count + i] * (1 - a) + samples[f1 * count + i] * a)
            curves[offset + i] = values
    for i, value in enumerate(constant["data"]):
        curves[offset + count + i] = [value]
    return DecodedClip(stop - start, times, curves)


def bind_tracks(bindings: list[Mapping[str, int]], curves: Mapping[int, list[float]],
                nodes: Mapping[int, int]) -> dict[int, dict[int, list[list[float]]]]:
    """Transform curves by node and attribute (1 position, 2 rotation, 3 scale, 4 Euler), one component list each.
    ``nodes`` maps crc32 of a hierarchy path to its node; bindings to other paths or types only advance the index."""
    out: dict[int, dict[int, list[list[float]]]] = {}
    index = 0
    for binding in bindings:
        dims = binding_dims(binding)
        if binding["typeID"] == 4 and binding["attribute"] in (1, 2, 3, 4) and binding["path"] in nodes:
            parts = [curves.get(index + k) for k in range(dims)]
            if all(p is not None for p in parts):
                out.setdefault(nodes[binding["path"]], {})[binding["attribute"]] = parts
        index += dims
    return out


# switches a clip can animate: a renderer's m_Enabled (Renderer 25, MeshRenderer 23, SkinnedMeshRenderer 137) and a
# GameObject's m_IsActive (1); the attribute of a non-Transform binding is the crc32 of the property name
TOGGLE_TYPES = {25: "renderer", 23: "renderer", 137: "renderer", 1: "active"}
TOGGLE_ATTRIBUTES = {"renderer": zlib.crc32(b"m_Enabled"), "active": zlib.crc32(b"m_IsActive")}


def bind_toggles(bindings: list[Mapping[str, int]], curves: Mapping[int, list[float]],
                 nodes: Mapping[int, int]) -> list[tuple[int, str, list[float]]]:
    """(node, "renderer" | "active", values) of the renderer and GameObject switches a clip animates, in the same
    curve index walk as :func:`bind_tracks`."""
    out, index = [], 0
    for binding in bindings:
        kind = TOGGLE_TYPES.get(binding["typeID"])
        if kind and binding["attribute"] == TOGGLE_ATTRIBUTES[kind] and binding["path"] in nodes \
                and curves.get(index) is not None and not binding.get("isPPtrCurve"):
            out.append((nodes[binding["path"]], kind, curves[index]))
        index += binding_dims(binding)
    return out


def toggle_keys(values: list[float], times: list[float], start: float = 0.0) -> list[list[float]]:
    """A switch curve as change points [[time, 0 | 1], ...] from the clip start (on at 0.5 and above)."""
    keys: list[list[float]] = []
    for i, value in enumerate(values):
        state = 1 if value >= 0.5 else 0
        if not keys or keys[-1][1] != state:
            time = 0.0 if len(values) == 1 else round(times[i] - start, 4)
            keys.append([time, state])
    return keys


def track_values(attribute: int, parts: list[list[float]]) -> tuple[str, list[tuple[float, ...]]]:
    """A glTF channel path and its values (mirrored; rotations normalised and kept continuous)."""
    length = max(len(p) for p in parts)
    rows = [tuple(p[i] if len(p) > 1 else p[0] for p in parts) for i in range(length)]
    if attribute == 1:
        return "translation", [mpos(v) for v in rows]
    if attribute == 3:
        return "scale", rows
    quats = [quat_norm(mquat(v if attribute == 2 else euler_to_quat(v))) for v in rows]
    for i in range(1, len(quats)):
        if sum(a * b for a, b in zip(quats[i], quats[i - 1])) < 0:
            quats[i] = tuple(-x for x in quats[i])
    return "rotation", quats


def pick_clips(names: list[str], wanted: Iterable[str] = DEFAULT_CLIPS, dev: str = "") -> list[tuple[int, str]]:
    """(index, slot) of the clips to export: one clip per wanted name suffix, the prefab's own (``<dev>_<slot>``)
    before a shared one. When neither the formation nor the cafe idle is there, the first fallback idle comes along
    as slot 'Idle'."""
    def best(suffix: str) -> int | None:
        hits = [i for i, n in enumerate(names) if n.lower().endswith("_" + suffix.lower())]
        own = [i for i in hits if names[i].lower() == f"{dev}_{suffix}".lower()]
        return (own or hits or [None])[0]

    chosen = [(i, slot) for slot in wanted if (i := best(slot)) is not None]
    if not any(slot in ("Formation_Idle", "Cafe_Idle") for _, slot in chosen):
        for suffix in FALLBACK_IDLES:
            if (i := best(suffix)) is not None:
                chosen.append((i, "Idle"))
                break
    return chosen


# --- GLB -----------------------------------------------------------------------------------------------------------

FLT_MAX = 3.4028234663852886e38  # the largest float32


def finite_json(value: Any) -> Any:
    """A copy of a JSON tree with only finite numbers: an infinity becomes +-FLT_MAX (still unbounded for a shader),
    NaN becomes 0. glTF readers parse the JSON chunk with a strict parser (JSON.parse), which rejects NaN and
    Infinity, and the game's materials do hold infinite constants (``_CameraFadeParams`` of some NPCs and Saya)."""
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return math.copysign(FLT_MAX, value) if math.isinf(value) else 0.0
    if isinstance(value, dict):
        return {k: finite_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite_json(v) for v in value]
    return value


class GlbWriter:
    """glTF 2.0 JSON plus one binary buffer; buffer views are 4-byte aligned."""

    def __init__(self, generator: str = "BA Modding and Patching Tool"):
        self.json: dict[str, Any] = {
            "asset": {"version": "2.0", "generator": generator}, "scene": 0, "scenes": [{"nodes": []}],
            "nodes": [], "meshes": [], "materials": [], "textures": [], "images": [],
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
            "accessors": [], "bufferViews": [], "buffers": [], "skins": [], "animations": [],
        }
        self.bin = bytearray()

    def _align(self) -> None:
        self.bin += b"\0" * (-len(self.bin) % 4)

    def view(self, data: bytes, target: int | None = None) -> int:
        self._align()
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.bin += data
        self.json["bufferViews"].append(view)
        return len(self.json["bufferViews"]) - 1

    def accessor(self, values: list, kind: str, component: int = 5126, target: int | None = None,
                 minmax: bool = False) -> int:
        size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[kind]
        flat = [x for v in values for x in v] if size > 1 else list(values)
        fmt = {5126: "f", 5123: "H", 5125: "I", 5121: "B"}[component]
        accessor = {"bufferView": self.view(struct.pack(f"<{len(flat)}{fmt}", *flat), target),
                    "componentType": component, "count": len(values), "type": kind}
        if minmax and flat:
            columns = [flat[i::size] for i in range(size)]
            accessor["min"] = [min(c) for c in columns]
            accessor["max"] = [max(c) for c in columns]
        self.json["accessors"].append(accessor)
        return len(self.json["accessors"]) - 1

    def image(self, png: bytes, name: str) -> int:
        self.json["images"].append({"bufferView": self.view(png), "mimeType": "image/png", "name": name})
        self.json["textures"].append({"sampler": 0, "source": len(self.json["images"]) - 1, "name": name})
        return len(self.json["textures"]) - 1

    def finish(self) -> bytes:
        self._align()
        self.json["buffers"] = [{"byteLength": len(self.bin)}]
        doc = finite_json({k: v for k, v in self.json.items() if v != []})
        # allow_nan=False: anything non-finite left over raises here instead of breaking the viewer's JSON.parse
        text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        text += b" " * (-len(text) % 4)
        total = 12 + 8 + len(text) + 8 + len(self.bin)
        return (struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(text), b"JSON") + text
                + struct.pack("<I4s", len(self.bin), b"BIN\0") + bytes(self.bin))


# --- the object graph -----------------------------------------------------------------------------------------------

def _key(obj: Any) -> tuple[str, int]:
    return obj.assets_file.name.lower(), obj.path_id


def _external_cab(obj: Any, file_id: int) -> str:
    if file_id == 0:
        return obj.assets_file.name.lower()
    return obj.assets_file.externals[file_id - 1].path.replace("\\", "/").rsplit("/", 1)[-1].lower()


class BundleGraph:
    """Objects of the loaded bundles by (CAB, path id). A pointer into a CAB that is not loaded yet loads the bundle
    holding it, so only what the model really uses is read.

    Every bundle stays open (with its process-wide path lock held) until :meth:`close`. Callers serialise exports,
    and every other reader holds one path lock at a time, so holding several cannot deadlock. ``fallback`` is asked
    once for a wider CAB index when a CAB is not in ``index``. Override bundles (mods) take over the CABs they hold.
    """

    def __init__(self, index: Mapping[str, Any], overrides: Iterable[Path] = (), *,
                 fallback: Callable[[], Mapping[str, Any]] | None = None, opener: Callable = open_bundle):
        self.index = {cab: str(path) for cab, path in index.items()}
        for path in overrides:
            for cab in cab_names(Path(path)):
                self.index[cab] = str(path)
        self.fallback = fallback
        self.opener = opener
        self.objects: dict[tuple[str, int], Any] = {}
        self.trees: dict[tuple[str, int], Any] = {}
        self.loaded: list[str] = []
        self._stack = ExitStack()

    def __enter__(self) -> "BundleGraph":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self.objects.clear()
        self.trees.clear()
        self._stack.close()

    def add(self, path: Path | str) -> Any:
        """Load a bundle (once) and index its objects; returns its environment, or None when already loaded."""
        path = str(path)
        if path in self.loaded:
            return None
        self.loaded.append(path)
        env = self._stack.enter_context(self.opener(Path(path)))
        for obj in env.objects:
            self.objects[_key(obj)] = obj
        return env

    def tree(self, obj: Any) -> Any:
        key = _key(obj)
        tree = self.trees.get(key)
        if tree is None:
            tree = self.trees[key] = obj.read_typetree()
        return tree

    def deref(self, obj: Any, pointer: Mapping[str, int] | None) -> Any:
        if obj is None or not pointer or not pointer.get("m_PathID"):
            return None
        cab, pid = _external_cab(obj, pointer.get("m_FileID", 0)), pointer["m_PathID"]
        hit = self.objects.get((cab, pid))
        if hit is None:
            if cab not in self.index and self.fallback is not None and cab.startswith("cab-"):
                logger.debug("CAB %s is not in the model index; scanning every bundle", cab)
                wider, self.fallback = self.fallback(), None
                self.index = {**{c: str(p) for c, p in wider.items()}, **self.index}
            path = self.index.get(cab)
            if path is not None and path not in self.loaded:
                self.add(path)
                hit = self.objects.get((cab, pid))
        return hit

    def component(self, game_object: Any, type_name: str) -> Any:
        for c in self.tree(game_object)["m_Component"]:
            obj = self.deref(game_object, c["component"])
            if obj is not None and obj.type.name == type_name:
                return obj
        return None

    def script(self, behaviour: Any) -> str | None:
        script = self.deref(behaviour, self.tree(behaviour).get("m_Script"))
        return self.tree(script).get("m_ClassName") if script is not None else None


# --- the exporter ---------------------------------------------------------------------------------------------------

def _color(c: Mapping[str, float]) -> list[float]:
    return [round(c["r"], 5), round(c["g"], 5), round(c["b"], 5), round(c["a"], 5)]


def _vec3(v: Mapping[str, float]) -> list[float]:
    return [v["x"], v["y"], v["z"]]


def _prefabs(graph: BundleGraph, bundles: Iterable[Path]) -> dict[str, Any]:
    """Prefab roots of the prefab bundles by lower-case stem (Echelon_CH0242, CH0242, ...)."""
    found = {}
    for path in bundles:
        env = graph.add(path)
        for name, pointer in (env.container.items() if env is not None else ()):
            lower = name.lower()
            if lower.endswith(".prefab") and "/character/" in lower:
                found[lower.rsplit("/", 1)[-1][:-7]] = pointer
    return found


class _Exporter:
    def __init__(self, graph: BundleGraph, dev: str):
        self.g, self.dev = graph, dev
        self.glb = GlbWriter()
        self.nodes = self.glb.json["nodes"]
        self.node_of: dict[tuple[str, int], int] = {}  # Transform -> node
        self.path_of: dict[int, str] = {}              # node -> hierarchy path below the root
        self.renderers: list[tuple[int, Any, Any]] = []  # (node, renderer, GameObject), shown ones only
        # renderers the prefab disables, by node: exported only when a clip enables them (alternative faces)
        self.disabled: dict[int, tuple[int, Any, Any]] = {}
        self.shown: set[int] = set()                     # nodes outside inactive and effect subtrees
        self.follower = self.mouth = None
        self.textures: dict[tuple[str, int], int] = {}
        self.materials: dict[tuple[str, int], int] = {}

    # hierarchy
    def visit(self, go_obj: Any, parent: int | None, path: str, active: bool, shown: bool = True) -> None:
        """Nodes for a GameObject and its children. Inactive objects and effect nodes (particles, the EX camera and
        light) are kept for the clips but marked hidden; renderers below a hidden node are not exported, since the
        viewer never shows them (and their effect materials sit in unrelated bundles). Renderers the prefab disables
        (m_Enabled 0: alternative faces, bodies and props) are kept aside: only a clip that enables one brings it in
        (:meth:`toggles`)."""
        g = self.g
        go = g.tree(go_obj)
        transform, components = None, []
        for c in go["m_Component"]:
            obj = g.deref(go_obj, c["component"])
            if obj is None:
                continue
            if obj.type.name in ("Transform", "RectTransform"):
                transform = obj
            else:
                components.append(obj)
        if transform is None:
            return
        t = g.tree(transform)
        p, r, s = t["m_LocalPosition"], t["m_LocalRotation"], t["m_LocalScale"]
        node: dict[str, Any] = {"name": go["m_Name"]}
        translation, rotation = mpos((p["x"], p["y"], p["z"])), mquat((r["x"], r["y"], r["z"], r["w"]))
        scale = (s["x"], s["y"], s["z"])
        if any(abs(x) > 1e-7 for x in translation):
            node["translation"] = list(translation)
        if any(abs(a - b) > 1e-7 for a, b in zip(rotation, (0, 0, 0, 1))):
            node["rotation"] = list(quat_norm(rotation))
        if any(abs(x - 1) > 1e-7 for x in scale):
            node["scale"] = list(scale)
        index = len(self.nodes)
        self.nodes.append(node)
        self.node_of[_key(transform)] = index
        self.path_of[index] = path
        if parent is None:
            self.glb.json["scenes"][0]["nodes"].append(index)
        else:
            self.nodes[parent].setdefault("children", []).append(index)
        here = active and bool(go["m_IsActive"])
        effect = any(obj.type.name in ("ParticleSystem", "Camera", "Light") for obj in components)
        shown = shown and here and not effect
        if shown:
            self.shown.add(index)
        for obj in components:
            kind = obj.type.name
            if kind in ("SkinnedMeshRenderer", "MeshRenderer"):
                if shown and g.tree(obj).get("m_Enabled", 1):
                    self.renderers.append((index, obj, go_obj))
                elif shown:
                    self.disabled[index] = (index, obj, go_obj)
            elif kind == "MonoBehaviour":
                name = g.script(obj)
                if name == "FxFollower":
                    self.follower = (index, obj, g.tree(obj))
                elif name == "CharacterAnimationEventReceiver":
                    self.mouth = (obj, g.tree(obj))
        if not here or effect:
            node.setdefault("extras", {})["hidden"] = True
        for child in t["m_Children"]:
            child_tr = g.deref(transform, child)
            child_go = g.deref(child_tr, g.tree(child_tr)["m_GameObject"]) if child_tr is not None else None
            if child_go is not None:
                name = g.tree(child_go)["m_Name"]
                self.visit(child_go, index, f"{path}/{name}" if path else name, here, shown)

    # textures and materials
    def texture(self, obj: Any) -> int:
        key = _key(obj)
        if key not in self.textures:
            data = obj.read()
            buffer = io.BytesIO()
            data.image.save(buffer, format="PNG", compress_level=1)
            self.textures[key] = self.glb.image(buffer.getvalue(), data.m_Name)
        return self.textures[key]

    def material(self, obj: Any) -> int:
        key = _key(obj)
        if key in self.materials:
            return self.materials[key]
        g, tree = self.g, self.g.tree(obj)
        shader_obj = g.deref(obj, tree.get("m_Shader"))
        shader = None
        if shader_obj is not None:
            try:
                shader = g.tree(shader_obj)["m_ParsedForm"]["m_Name"]
            except (KeyError, TypeError, ValueError):
                shader = None
        props = tree["m_SavedProperties"]
        textures = {}
        for name, env in props["m_TexEnvs"]:
            tex = g.deref(obj, env["m_Texture"])
            if tex is not None and tex.type.name == "Texture2D":
                textures[name] = {"index": self.texture(tex), "scale": [env["m_Scale"]["x"], env["m_Scale"]["y"]],
                                  "offset": [env["m_Offset"]["x"], env["m_Offset"]["y"]]}
        colors = {k: _color(v) for k, v in props["m_Colors"]}
        floats = {k: round(v, 5) for k, v in props["m_Floats"]}
        keywords = set(tree.get("m_ValidKeywords") or []) | set((tree.get("m_ShaderKeywords") or "").split())
        material: dict[str, Any] = {
            "name": tree["m_Name"], "doubleSided": floats.get("_Cull", 2) == 0,
            "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1},
            "extras": {"shader": shader, "kind": SHADER_KINDS.get(shader, "general"), "colors": colors,
                       "floats": floats, "textures": textures, "keywords": sorted(keywords)},
        }
        if "_MainTex" in textures:
            material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": textures["_MainTex"]["index"]}
        elif "_Tint" in colors:
            material["pbrMetallicRoughness"]["baseColorFactor"] = [min(1, x) for x in colors["_Tint"][:3]] + [1]
        self.glb.json["materials"].append(material)
        self.materials[key] = len(self.glb.json["materials"]) - 1
        return self.materials[key]

    # meshes
    def meshes(self, renderers: Iterable[tuple[int, Any, Any]] | None = None) -> None:
        g, glb, root = self.g, self.glb, self.glb.json["scenes"][0]["nodes"][0]
        for node_index, renderer, go_obj in (self.renderers if renderers is None else renderers):
            tree = g.tree(renderer)
            if renderer.type.name == "SkinnedMeshRenderer":
                mesh_obj = g.deref(renderer, tree["m_Mesh"])
            else:
                filt = g.component(go_obj, "MeshFilter")
                mesh_obj = g.deref(filt, g.tree(filt)["m_Mesh"]) if filt is not None else None
            materials = [g.deref(renderer, m) for m in tree["m_Materials"]]
            if mesh_obj is None or any(m is None for m in materials):
                continue  # effect meshes in shared bundles
            mesh = mesh_obj.read()
            data = read_mesh(mesh)
            attrs = {"POSITION": glb.accessor([mpos(v) for v in data.vertices], "VEC3", target=_ARRAY, minmax=True)}
            if data.normals:
                attrs["NORMAL"] = glb.accessor([mpos(v[:3]) for v in data.normals], "VEC3", target=_ARRAY)
            for name, uv in (("TEXCOORD_0", data.uv0), ("TEXCOORD_1", data.uv1)):
                if uv:
                    attrs[name] = glb.accessor([(u[0], 1 - u[1]) for u in uv], "VEC2", target=_ARRAY)
            if data.colors:
                attrs["COLOR_0"] = glb.accessor([tuple(c[:4]) if len(c) >= 4 else (*c[:3], 1) for c in data.colors],
                                                "VEC4", target=_ARRAY)
            if data.tangents:
                # OL_ meshes keep the smoothed outline normal in the tangent xyz: a custom attribute, not a tangent
                attrs["_OUTLINE"] = glb.accessor([mpos(t[:3]) for t in data.tangents], "VEC3", target=_ARRAY)
            skinned = renderer.type.name == "SkinnedMeshRenderer" and data.joints and tree["m_Bones"]
            if skinned:
                attrs["JOINTS_0"] = glb.accessor(data.joints, "VEC4", component=5123, target=_ARRAY)
                attrs["WEIGHTS_0"] = glb.accessor(data.weights, "VEC4", target=_ARRAY)
            component = 5123 if len(data.vertices) < 65536 else 5125
            primitives = []
            for i, tris in enumerate(data.triangles[:len(materials)]):
                flat = [k for a, b, c in tris for k in (a, c, b)]  # mirrored: flip the winding
                primitives.append({"attributes": attrs, "material": self.material(materials[i]),
                                   "indices": glb.accessor(flat, "SCALAR", component=component, target=_INDICES)})
            glb.json["meshes"].append({"name": mesh.m_Name, "primitives": primitives})
            mesh_index = len(glb.json["meshes"]) - 1
            if not skinned:
                self.nodes[node_index]["mesh"] = mesh_index
                continue
            joints = []
            for bone in tree["m_Bones"]:
                bone_obj = g.deref(renderer, bone)
                joints.append(self.node_of.get(_key(bone_obj), root) if bone_obj is not None else root)
            skin = {"joints": joints, "name": mesh.m_Name,
                    "inverseBindMatrices": glb.accessor([mirror_matrix(e) for e in g.tree(mesh_obj)["m_BindPose"]], "MAT4")}
            root_bone = g.deref(renderer, tree.get("m_RootBone"))
            if root_bone is not None and _key(root_bone) in self.node_of:
                skin["skeleton"] = self.node_of[_key(root_bone)]
            glb.json["skins"].append(skin)
            # Unity skins with bone.localToWorld * bindpose and ignores the renderer's own transform; glTF uses the
            # mesh node's world matrix at bind time, so skinned meshes go on a new identity node under the root
            mesh_node: dict[str, Any] = {"name": self.nodes[node_index]["name"] + "_mesh", "mesh": mesh_index,
                                         "skin": len(glb.json["skins"]) - 1}
            self.nodes.append(mesh_node)
            self.nodes[root].setdefault("children", []).append(len(self.nodes) - 1)
            self.nodes[node_index].setdefault("extras", {})["renderer"] = len(self.nodes) - 1

    # behaviours
    def extras(self, prefab: str) -> dict[str, Any]:
        extras: dict[str, Any] = {"prefab": prefab, "dev": self.dev}
        if self.follower:
            index, obj, tree = self.follower
            target = self.g.deref(obj, tree.get("FollowTarget"))
            lo, hi = tree["ClampMinOffset"], tree["ClampMaxOffset"]
            rot = tree["TargetRelativeRotation"]
            extras["haloFollower"] = {
                "node": index, "target": self.node_of.get(_key(target)) if target is not None else None,
                "relativePosition": list(mpos(_vec3(tree["TargetRelativePosition"]))),
                "relativeRotation": list(mquat([rot[k] for k in "xyzw"])),
                # mirroring X swaps the bounds
                "clampMin": [-hi["x"], lo["y"], lo["z"]], "clampMax": [-lo["x"], hi["y"], hi["z"]],
                "positionPower": tree["FollowPositionPower"], "rotationPower": tree["FollowRotationPower"],
            }
        if self.mouth:
            _, tree = self.mouth
            extras["mouth"] = {"materialIndex": tree.get("MouthMaterialIndex"),
                               "defaultOffset": [tree["MouthDefaultUV"]["x"], tree["MouthDefaultUV"]["y"]]}
        return extras

    # clips
    def controller_clips(self, prefabs: Mapping[str, Any]) -> list[Any]:
        """Clips of every prefab's animator controller (an override clip, or the original where the override is
        empty: NPCs share generic clips), plus override controllers stored next to the prefabs."""
        g, pointers = self.g, []

        def add(controller: Any) -> None:
            if controller is None:
                return
            tree = g.tree(controller)
            if controller.type.name == "AnimatorOverrideController":
                pointers.extend((controller, c["m_OverrideClip"] if c["m_OverrideClip"].get("m_PathID") else c["m_OriginalClip"])
                                for c in tree["m_Clips"])
            elif controller.type.name == "AnimatorController":
                pointers.extend((controller, c) for c in tree.get("m_AnimationClips", []))

        for pointer in prefabs.values():
            animator = g.component(pointer.deref(), "Animator")
            if animator is not None:
                add(g.deref(animator, g.tree(animator)["m_Controller"]))
        for obj in list(g.objects.values()):
            if obj.type.name == "AnimatorOverrideController":
                add(obj)
        clips, seen = [], set()
        for owner, pointer in pointers:
            clip = g.deref(owner, pointer)
            if clip is not None and _key(clip) not in seen:
                seen.add(_key(clip))
                clips.append(clip)
        return clips

    def animations(self, clips: list[Any], wanted: Iterable[str]) -> None:
        glb = self.glb
        by_hash = {zlib.crc32(path.encode("utf-8")): index for index, path in self.path_of.items()}
        rest = {i: (n.get("translation", [0, 0, 0]), n.get("rotation", [0, 0, 0, 1]), n.get("scale", [1, 1, 1]))
                for i, n in enumerate(self.nodes)}
        names = [c.peek_name() for c in clips]
        exported = set()
        for index, slot in pick_clips(names, wanted, self.dev):
            if names[index] in exported:
                continue
            exported.add(names[index])
            tt = clips[index].read_typetree()
            decoded = decode_clip(tt)
            tracks = bind_tracks(tt["m_ClipBindingConstant"]["genericBindings"], decoded.curves, by_hash)
            animation: dict[str, Any] = {"name": tt["m_Name"], "channels": [], "samplers": []}
            times = glb.accessor(decoded.times, "SCALAR", minmax=True)
            zero = None
            for node, attrs in tracks.items():
                for attribute, parts in attrs.items():
                    path, values = track_values(attribute, parts)
                    if all(max(abs(a - b) for a, b in zip(v, values[0])) < 1e-5 for v in values):
                        # constant over the clip: one key, or nothing when it is the rest pose (three.js restores
                        # the original state of bindings no clip uses)
                        rest_value = rest[node][{"translation": 0, "rotation": 1, "scale": 2}[path]]
                        if max(abs(a - b) for a, b in zip(values[0], rest_value)) < 1e-5:
                            continue
                        if zero is None:
                            zero = glb.accessor([0.0], "SCALAR", minmax=True)
                        source, values = zero, values[:1]
                    else:
                        source = times
                    output = glb.accessor(values, "VEC4" if path == "rotation" else "VEC3")
                    animation["samplers"].append({"input": source, "output": output, "interpolation": "LINEAR"})
                    animation["channels"].append({"sampler": len(animation["samplers"]) - 1,
                                                  "target": {"node": node, "path": path}})
            events = [{"time": round(e["time"], 4), "function": e["functionName"], "int": e["intParameter"]}
                      for e in tt.get("m_Events", []) if e["functionName"] == "SetMouthTile"]
            animation["extras"] = {"slot": slot, "loop": bool(tt["m_MuscleClip"]["m_LoopTime"]),
                                   "duration": decoded.duration, "events": events}
            toggles = self.toggles(tt, decoded, by_hash)
            if toggles:
                animation["extras"]["toggles"] = toggles
            if animation["channels"]:  # NPC placeholders have no bindings
                glb.json["animations"].append(animation)

    def toggles(self, tt: Mapping[str, Any], decoded: DecodedClip, by_hash: Mapping[int, int]) -> list[dict[str, Any]]:
        """The renderers a clip switches on and off ({node: mesh node, keys: [[time, 0 | 1], ...]}), such as the
        alternative faces of an expression. A renderer the prefab disables is exported once a clip enables it, hidden
        at rest. Switches equal to the rest state over the whole clip are left out."""
        start = tt["m_MuscleClip"]["m_StartTime"]
        out: dict[int, list[list[float]]] = {}
        for node, kind, values in bind_toggles(tt["m_ClipBindingConstant"]["genericBindings"], decoded.curves, by_hash):
            if node not in self.shown:
                continue  # below an inactive or effect object: nothing of it is exported
            keys = toggle_keys(values, decoded.times, start)
            if kind == "renderer":
                if node in self.disabled and any(state for _, state in keys):
                    self.meshes([self.disabled.pop(node)])
                    self._hide_renderer(node)
                nodes = [node]
            else:  # a GameObject: every exported renderer at or below it
                nodes = self._subtree(node)
            for target in [t for t in map(self._renderer_node, nodes) if t is not None]:
                rest = 0 if self.nodes[target].get("extras", {}).get("hidden") else 1
                if any(state != rest for _, state in keys):
                    out[target] = keys
        return [{"node": node, "keys": keys} for node, keys in sorted(out.items())]

    def _renderer_node(self, node: int) -> int | None:
        """The node that draws a GameObject's renderer: its skinned mesh node, or the node itself for a static mesh."""
        extras = self.nodes[node].get("extras", {})
        if "renderer" in extras:
            return extras["renderer"]
        return node if "mesh" in self.nodes[node] else None

    def _hide_renderer(self, node: int) -> None:
        target = self._renderer_node(node)
        if target is not None:
            self.nodes[target].setdefault("extras", {})["hidden"] = True

    def _subtree(self, node: int) -> list[int]:
        out, stack = [], [node]
        while stack:
            n = stack.pop()
            out.append(n)
            stack.extend(c for c in self.nodes[n].get("children", []) if c in self.path_of)
        return out


def export_chibi(graph: BundleGraph, bundles: Iterable[Path], dev: str, *, prefab: str = "echelon",
                 clips: Iterable[str] = DEFAULT_CLIPS) -> bytes:
    """Export one chibi to GLB bytes. ``bundles`` are the prefab bundles of ``dev``; the prefab is the Echelon
    (formation) one where there is one, else the battle, cafe or strategy one."""
    prefabs = _prefabs(graph, bundles)
    root, name = None, None
    for kind in [prefab, *(k for k in PREFAB_KINDS if k != prefab)]:
        pointer = prefabs.get(PREFAB_KINDS[kind].format(dev).lower())
        if pointer is not None:
            root = pointer.deref()
            name = root.peek_name()
            break
    if root is None:
        raise AssetNotFound(("model", dev))
    exporter = _Exporter(graph, dev)
    exporter.visit(root, None, "", True)
    exporter.meshes()
    exporter.glb.json["extras"] = exporter.extras(name)
    exporter.animations(exporter.controller_clips(prefabs), clips)
    data = exporter.glb.finish()
    logger.debug("model %s (%s): %d bundles, %d KB", dev, name, len(graph.loaded), len(data) // 1024)
    return data
