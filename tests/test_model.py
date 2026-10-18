"""3D chibi export: UnityPy workarounds, clip decoding, the GLB writer, CAB discovery and the catalog mapping, plus a
read-only export from a local install."""

from __future__ import annotations

import json
import math
import os
import struct
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from UnityPy.helpers.CompressionHelper import compress_lz4

from ba_modding_toolkit.catalog import Catalog, model_core
from ba_modding_toolkit.gameassets import AssetCache, AssetNotFound, GameAssets
from ba_modding_toolkit.gameassets import model
from ba_modding_toolkit.gameassets.discovery import cab_names, is_model_dependency
from ba_modding_toolkit.searching import get_search_dirs

FIXTURES = Path(__file__).parent / "fixtures" / "catalog"
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR", str(Path.home() / "Library/Application Support/Blue Archive/Game")))


# --- UnityPy workarounds ---

def test_safe_unpack_floats_with_zero_bit_size():
    packed = SimpleNamespace(m_BitSize=0, m_NumItems=6, m_Start=0.25, m_Range=0.0, m_Data=b"")
    assert model.safe_unpack_floats(packed) == [0.25] * 6
    assert model.safe_unpack_floats(packed, 0, 4, shape=(2,)) == [[0.25, 0.25], [0.25, 0.25]]
    # the mesh decoder uses the safe version
    from UnityPy.helpers import MeshHelper
    assert MeshHelper.unpack_floats is model.safe_unpack_floats


def test_compressed_skin_sums_integer_weights():
    # 1 + 25 + 5 = 31 ends the vertex (as floats the sum is below 1.0 and a phantom fourth weight is read);
    # three weights short of 31 imply the fourth and read one more bone index
    weights = [1, 25, 5, 31, 10, 10, 10]
    bones = [3, 4, 5, 6, 7, 8, 9, 2]
    w, j = model.compressed_skin(weights, bones, 3)
    assert j == [[3, 4, 5, 0], [6, 0, 0, 0], [7, 8, 9, 2]]
    assert w[0] == pytest.approx([1 / 31, 25 / 31, 5 / 31, 0])
    assert w[1] == [1, 0, 0, 0]
    assert w[2] == pytest.approx([10 / 31, 10 / 31, 10 / 31, 1 / 31])
    assert all(sum(row) == pytest.approx(1) for row in w)
    # extra data past the last vertex is ignored, missing bone indices do not raise
    assert model.compressed_skin([31, 31, 31], [1], 2)[1] == [[1, 0, 0, 0], [0, 0, 0, 0]]


def _channels(*formats):
    return SimpleNamespace(m_VertexData=SimpleNamespace(m_Channels=[SimpleNamespace(format=f, dimension=d) for f, d in formats]))


def test_fix_vertex_formats_scales_normalised_channels():
    # channel 3 (colour) UNorm8, channel 1 (normal) SNorm8, channel 4 (uv0) float
    mesh = _channels((0, 3), (3, 3), (0, 0), (2, 4), (0, 2))
    handler = SimpleNamespace(version=(2021, 3, 0, 0), m_Vertices=[(1.0, 2.0, 3.0)], m_Normals=[(127, -128, 0)],
                              m_Colors=[(255, 0, 51, 255)], m_UV0=[(0.5, 0.5)])
    model.fix_vertex_formats(mesh, handler)
    assert handler.m_Colors == [pytest.approx((1.0, 0.0, 0.2, 1.0))]
    assert handler.m_Normals == [pytest.approx((1.0, -1.0, 0.0))]  # SNorm -128 clamps to -1
    assert handler.m_Vertices == [(1.0, 2.0, 3.0)] and handler.m_UV0 == [(0.5, 0.5)]
    # older vertex format tables differ: left alone
    old = SimpleNamespace(version=(2018, 4, 0, 0), m_Colors=[(255, 0, 0, 255)])
    model.fix_vertex_formats(_channels((0, 3), (0, 3), (0, 0), (2, 4)), old)
    assert old.m_Colors == [(255, 0, 0, 255)]


def test_pad_skin_rigid_props_and_renormalise():
    joints, weights = model.pad_skin([(5,), (6,)], None, 2)
    assert joints == [(5, 0, 0, 0), (6, 0, 0, 0)] and weights == [(1.0, 0.0, 0.0, 0.0)] * 2
    joints, weights = model.pad_skin([(1, 2)], [(0.5, 0.25)], 1)
    assert joints == [(1, 2, 0, 0)] and weights == [pytest.approx((2 / 3, 1 / 3, 0, 0))]
    assert model.pad_skin(None, None, 3) == (None, None)


# --- clips ---

def _words(*frames):
    data = b""
    for time, keys in frames:
        data += struct.pack("<fi", time, len(keys))
        for key in keys:
            data += struct.pack("<i4f", *key)
    return list(struct.unpack(f"<{len(data) // 4}I", data))


def _clip(streamed=(), curve_count=0, dense=None, constant=(), stop=1.0, rate=2.0):
    dense = dense or {"m_CurveCount": 0, "m_FrameCount": 0, "m_SampleRate": 0, "m_BeginTime": 0, "m_SampleArray": []}
    return {"m_Name": "Test_Formation_Idle", "m_SampleRate": rate, "m_MuscleClip": {
        "m_StartTime": 0.0, "m_StopTime": stop, "m_LoopTime": 1,
        "m_Clip": {"data": {"m_StreamedClip": {"data": list(streamed), "curveCount": curve_count},
                            "m_DenseClip": dense, "m_ConstantClip": {"data": list(constant)}}}}}


def test_read_streamed_frames():
    words = _words((-math.inf, [(0, 0, 0, 0, 1)]), (0.0, [(0, 0, 0, 2, 1)]), (math.inf, []))
    frames = model.read_streamed(words)
    assert [f[0] for f in frames] == [-math.inf, 0.0, math.inf]
    assert frames[1][1] == [(0, 0.0, 0.0, 2.0, 1.0)]


def test_decode_clip_streamed_dense_constant():
    streamed = _words(
        (-math.inf, [(0, 9, 9, 9, 9)]),            # slope helper: ignored
        (0.0, [(0, 0, 0, 2, 1)]),                  # curve 0: 2 dt + 1 on [0, 1)
        (0.5, [(1, 1, 0, 0, 0)]),                  # curve 1 starts at 0.5: dt^3
        (1.0, [(0, 0, 0, 0, 5)]),                  # curve 0 holds 5 from 1
        (math.inf, [(0, 9, 9, 9, 9)]),
    )
    dense = {"m_CurveCount": 2, "m_FrameCount": 2, "m_SampleRate": 1.0, "m_BeginTime": 0.0, "m_SampleArray": [10, 20, 30, 40]}
    clip = model.decode_clip(_clip(streamed, 2, dense, constant=[7, 8]))
    assert clip.duration == 1.0 and clip.times == [0.0, 0.5, 1.0]
    assert clip.curves[0] == pytest.approx([1, 2, 5])
    assert clip.curves[1] == pytest.approx([0, 0, 0.125])  # before its first key it holds that key's value
    assert clip.curves[2] == pytest.approx([10, 20, 30])   # dense curves follow the streamed ones
    assert clip.curves[3] == pytest.approx([20, 30, 40])
    assert clip.curves[4] == [7] and clip.curves[5] == [8]  # then the constant ones


def test_bind_tracks_walks_binding_dimensions():
    a, b = zlib.crc32(b"bone_root/Bip001"), zlib.crc32(b"bone_root/Bip001/Bip001 Pelvis")
    bindings = [
        {"typeID": 4, "attribute": 1, "path": a},       # position: curves 0-2
        {"typeID": 4, "attribute": 2, "path": b},       # rotation: 3-6
        {"typeID": 137, "attribute": 5, "path": a},     # another type: one curve (7)
        {"typeID": 4, "attribute": 3, "path": 12345},   # scale of an unknown path: 8-10
        {"typeID": 4, "attribute": 4, "path": a},       # Euler: 11-13
    ]
    curves = {i: [float(i)] for i in range(14)}
    tracks = model.bind_tracks(bindings, curves, {a: 0, b: 1})
    assert tracks == {0: {1: [[0.0], [1.0], [2.0]], 4: [[11.0], [12.0], [13.0]]}, 1: {2: [[3.0], [4.0], [5.0], [6.0]]}}
    assert model.binding_dims({"typeID": 4, "attribute": 2}) == 4 and model.binding_dims({"typeID": 23, "attribute": 2}) == 1


def test_track_values_mirror_and_continuity():
    path, values = model.track_values(1, [[1.0, 2.0], [2.0], [3.0, 4.0]])
    assert path == "translation" and values == [(-1.0, 2.0, 3.0), (-2.0, 2.0, 4.0)]
    # the second quaternion is the first one negated: kept on the same side
    path, values = model.track_values(2, [[0.0, 0.0], [0.6, -0.6], [0.0, 0.0], [0.8, -0.8]])
    assert path == "rotation" and values[0] == pytest.approx((0, -0.6, 0, 0.8)) and values[1] == pytest.approx(values[0])
    # Euler 90 degrees about Y: a quarter turn, mirrored to -Y
    path, values = model.track_values(4, [[0.0], [90.0], [0.0]])
    s = math.sqrt(0.5)
    assert path == "rotation" and values[0] == pytest.approx((0, -s, 0, s))


def test_mirror_matrix_and_quaternion_helpers():
    identity = {f"e{r}{c}": float(r == c) for r in range(4) for c in range(4)}
    assert model.mirror_matrix(identity) == [float(r == c) for c in range(4) for r in range(4)]
    m = dict(identity, e03=2.0, e13=3.0)  # translation (2, 3, 0)
    assert model.mirror_matrix(m)[12:15] == [-2.0, 3.0, 0.0]
    assert model.qmul((0, 0, 0, 1), (0.1, 0.2, 0.3, 0.9)) == pytest.approx((0.1, 0.2, 0.3, 0.9))
    assert model.euler_to_quat((0, 0, 0)) == pytest.approx((0, 0, 0, 1))


def test_pick_clips_prefers_own_clips_and_falls_back_to_an_idle():
    names = ["CH0258_01_Formation_Idle", "CH0258_02_Formation_Idle", "CH0258_01_Cafe_Idle", "CH0258_02_Victory_End"]
    assert model.pick_clips(names, ("Formation_Idle", "Cafe_Idle", "Victory_End"), "ch0258_02") == [
        (1, "Formation_Idle"), (2, "Cafe_Idle"), (3, "Victory_End")]
    npc = ["Police_Normal_Attack_Ing", "Police_Stand_Idle", "Police_Normal_Idle"]
    assert model.pick_clips(npc, model.DEFAULT_CLIPS, "police") == [(2, "Idle")]
    assert model.pick_clips(["X_Move_Ing"], model.DEFAULT_CLIPS, "x") == []


# --- GLB ---

def test_glb_writer_layout():
    glb = model.GlbWriter()
    pos = glb.accessor([(0.0, 1.0, 2.0), (-1.0, 0.5, 3.0)], "VEC3", target=34962, minmax=True)
    idx = glb.accessor([0, 1, 1], "SCALAR", component=5123, target=34963)  # 6 bytes: the next view is padded
    tex = glb.image(b"\x89PNG..", "Tex")
    glb.json["nodes"].append({"name": "root"})
    glb.json["scenes"][0]["nodes"].append(0)
    data = glb.finish()
    magic, version, total = struct.unpack_from("<4sII", data)
    assert (magic, version, total) == (b"glTF", 2, len(data))
    json_len, json_type = struct.unpack_from("<I4s", data, 12)
    assert json_type == b"JSON" and json_len % 4 == 0
    doc = json.loads(data[20:20 + json_len])
    bin_len, bin_type = struct.unpack_from("<I4s", data, 20 + json_len)
    assert bin_type == b"BIN\0" and bin_len % 4 == 0 and doc["buffers"] == [{"byteLength": bin_len}]
    assert all(v["byteOffset"] % 4 == 0 for v in doc["bufferViews"])
    assert doc["accessors"][pos]["count"] == 2 and doc["accessors"][pos]["min"] == [-1.0, 0.5, 2.0]
    assert doc["accessors"][idx]["count"] == 3 and doc["accessors"][idx]["componentType"] == 5123
    assert doc["textures"][tex] == {"sampler": 0, "source": 0, "name": "Tex"}
    assert "skins" not in doc and "animations" not in doc  # empty lists are left out
    binary = data[28 + json_len:]
    view = doc["bufferViews"][doc["images"][0]["bufferView"]]
    assert binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]] == b"\x89PNG.."


# --- renderer switches ---

def test_bind_toggles_walks_the_curve_index():
    face, face01, fx = (zlib.crc32(p.encode()) for p in ("Face", "Face01", "bone_root/FX"))
    enabled, active = zlib.crc32(b"m_Enabled"), zlib.crc32(b"m_IsActive")
    bindings = [
        {"typeID": 4, "attribute": 2, "path": face},            # a rotation: curves 0-3
        {"typeID": 25, "attribute": enabled, "path": face},     # Renderer.m_Enabled: 4
        {"typeID": 137, "attribute": enabled, "path": face01},  # SkinnedMeshRenderer.m_Enabled: 5
        {"typeID": 1, "attribute": active, "path": fx},         # GameObject.m_IsActive: 6
        {"typeID": 23, "attribute": 99, "path": face},          # another renderer property: 7
        {"typeID": 25, "attribute": enabled, "path": 12345},    # an unknown path: 8
        {"typeID": 25, "attribute": enabled, "path": face01, "isPPtrCurve": 1},  # 9
    ]
    curves = {i: [float(i)] for i in range(10)}
    assert model.bind_toggles(bindings, curves, {face: 1, face01: 2, fx: 3}) == [
        (1, "renderer", [4.0]), (2, "renderer", [5.0]), (3, "active", [6.0])]


def test_toggle_keys_are_change_points():
    times = [0.0, 0.5, 1.0, 1.5, 2.0]
    assert model.toggle_keys([1.0, 1.0, 0.0, 0.2, 1.0], times) == [[0.0, 1], [1.0, 0], [2.0, 1]]
    assert model.toggle_keys([0.0], times) == [[0.0, 0]]  # a constant curve
    assert model.toggle_keys([0.0, 1.0], [2.0, 2.5], start=2.0) == [[0.0, 0], [0.5, 1]]  # from the clip start


def test_toggles_bring_in_disabled_renderers_and_drop_rest_states(monkeypatch):
    # Miyu (ch0145): two faces enabled in the prefab, the idle turns the expression face off; a disabled face that a
    # clip turns on is exported hidden at rest; a GameObject switch reaches the renderers below it
    graph = _Graph(
        *_game_object(1, "CH0145", [], children=(10, 20, 30, 40)),
        *_game_object(10, "Face", [_object(12, "SkinnedMeshRenderer", m_Enabled=1)]),
        *_game_object(20, "Face01", [_object(22, "SkinnedMeshRenderer", m_Enabled=1)]),
        *_game_object(30, "Face02", [_object(32, "SkinnedMeshRenderer", m_Enabled=0)]),
        *_game_object(40, "Props", [], children=(50,)),
        *_game_object(50, "Prop", [_object(52, "SkinnedMeshRenderer", m_Enabled=1)]),
    )
    exporter = model._Exporter(graph, "ch0145")
    exporter.visit(graph.objects[1], None, "", True)
    assert list(exporter.disabled) == [3]  # the node of Face02

    def meshes(renderers=None):  # what meshes() leaves on the nodes: a skinned mesh node under the root
        for node, _, _ in (exporter.renderers if renderers is None else renderers):
            exporter.nodes.append({"name": exporter.nodes[node]["name"] + "_mesh"})
            exporter.nodes[node].setdefault("extras", {})["renderer"] = len(exporter.nodes) - 1
    monkeypatch.setattr(exporter, "meshes", meshes)
    exporter.meshes()
    nodes = {path: i for i, path in exporter.path_of.items()}
    by_hash = {zlib.crc32(path.encode()): i for path, i in nodes.items()}
    enabled, active = zlib.crc32(b"m_Enabled"), zlib.crc32(b"m_IsActive")
    tt = {"m_MuscleClip": {"m_StartTime": 0.0}, "m_ClipBindingConstant": {"genericBindings": [
        {"typeID": 25, "attribute": enabled, "path": zlib.crc32(b"Face")},     # 1 all along: the rest state
        {"typeID": 25, "attribute": enabled, "path": zlib.crc32(b"Face01")},   # off
        {"typeID": 25, "attribute": enabled, "path": zlib.crc32(b"Face02")},   # on after 1 s
        {"typeID": 1, "attribute": active, "path": zlib.crc32(b"Props")},      # off after 0.5 s
    ]}}
    decoded = model.DecodedClip(1.5, [0.0, 0.5, 1.0, 1.5], {0: [1.0], 1: [0.0], 2: [0.0, 0.0, 1.0, 1.0], 3: [1.0, 0.0, 0.0, 0.0]})
    toggles = exporter.toggles(tt, decoded, by_hash)
    mesh = lambda name: exporter.nodes[nodes[name]]["extras"]["renderer"]  # noqa: E731
    assert toggles == [{"node": mesh("Face01"), "keys": [[0.0, 0]]}, {"node": mesh("Props/Prop"), "keys": [[0.0, 1], [0.5, 0]]},
                       {"node": mesh("Face02"), "keys": [[0.0, 0], [1.0, 1]]}]
    assert exporter.nodes[mesh("Face02")]["extras"] == {"hidden": True} and not exporter.disabled
    # a later clip does not export it twice
    assert exporter.toggles(tt, decoded, by_hash) == toggles


def _strict(data):
    """The JSON chunk of a GLB, parsed like the viewer's JSON.parse (no NaN or Infinity)."""
    def reject(token):
        raise ValueError(f"not JSON: {token}")
    return json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]], parse_constant=reject)


def test_glb_json_has_only_finite_numbers():
    # Saya's body material holds _CameraFadeParams = (0, inf, 0, 0)
    graph = SimpleNamespace(tree=lambda obj: obj.tree, deref=lambda obj, pointer: None)
    exporter = model._Exporter(graph, "saya_original")
    material = SimpleNamespace(assets_file=SimpleNamespace(name="CAB-A"), path_id=1, tree={
        "m_Name": "Saya_Body", "m_Shader": {"m_FileID": 0, "m_PathID": 0}, "m_SavedProperties": {
            "m_TexEnvs": [], "m_Floats": [["_Cull", 2.0], ["_Far", math.inf]],
            "m_Colors": [["_CameraFadeParams", {"r": 0.0, "g": math.inf, "b": 0.0, "a": 0.0}],
                         ["_Odd", {"r": math.nan, "g": -math.inf, "b": 1.0, "a": 1.0}]]}})
    exporter.material(material)
    exporter.nodes.append({"name": "root", "translation": [math.inf, 0.0, 0.0]})
    exporter.glb.json["scenes"][0]["nodes"].append(0)
    doc = _strict(exporter.glb.finish())
    extras = doc["materials"][0]["extras"]
    assert extras["colors"]["_CameraFadeParams"] == [0.0, model.FLT_MAX, 0.0, 0.0]
    assert extras["colors"]["_Odd"] == [0.0, -model.FLT_MAX, 1.0, 1.0]  # NaN becomes 0
    assert extras["floats"] == {"_Cull": 2.0, "_Far": model.FLT_MAX}
    assert doc["nodes"][0]["translation"] == [model.FLT_MAX, 0.0, 0.0]


def test_glb_writer_rejects_what_is_not_finite(monkeypatch):
    # without the clean-up a non-finite number fails the export instead of the viewer
    monkeypatch.setattr(model, "finite_json", lambda value: value)
    glb = model.GlbWriter()
    glb.json["nodes"].append({"name": "root", "scale": [math.nan, 1.0, 1.0]})
    with pytest.raises(ValueError):
        glb.finish()


# --- the hierarchy ---

class _Graph:
    """Objects by path id, read like BundleGraph."""

    def __init__(self, *objects):
        self.objects = {obj.path_id: obj for obj in objects}

    def tree(self, obj):
        return obj.tree

    def deref(self, obj, pointer):
        return self.objects.get(pointer["m_PathID"]) if obj is not None and pointer and pointer.get("m_PathID") else None

    def script(self, behaviour):
        return None


def _object(pid, kind, **tree):
    return SimpleNamespace(assets_file=SimpleNamespace(name="CAB-A"), path_id=pid, type=SimpleNamespace(name=kind), tree=tree)


def _game_object(pid, name, components, children=(), active=1):
    """A GameObject (pid), its Transform (pid + 1) and further components."""
    ref = lambda p: {"m_FileID": 0, "m_PathID": p}  # noqa: E731
    transform = _object(pid + 1, "Transform", m_LocalPosition={"x": 0, "y": 0, "z": 0},
                        m_LocalRotation={"x": 0, "y": 0, "z": 0, "w": 1}, m_LocalScale={"x": 1, "y": 1, "z": 1},
                        m_Children=[ref(c + 1) for c in children], m_GameObject=ref(pid))
    go = _object(pid, "GameObject", m_Name=name, m_IsActive=active,
                 m_Component=[{"component": ref(pid + 1)}] + [{"component": ref(c.path_id)} for c in components])
    return [go, transform, *components]


def test_visit_skips_disabled_and_hidden_renderers():
    # an alternative face the prefab keeps disabled (ch0189) and a renderer under an inactive object
    graph = _Graph(
        *_game_object(1, "CH0189", [], children=(10, 20, 30)),
        *_game_object(10, "CH0189_Face_Outline", [_object(12, "SkinnedMeshRenderer", m_Enabled=1)]),
        *_game_object(20, "CH0189_Face01_Outline", [_object(22, "SkinnedMeshRenderer", m_Enabled=0)]),
        *_game_object(30, "Off", [_object(32, "MeshRenderer", m_Enabled=1)], active=0),
    )
    exporter = model._Exporter(graph, "ch0189")
    exporter.visit(graph.objects[1], None, "", True)
    assert [graph.tree(go)["m_Name"] for _, _, go in exporter.renderers] == ["CH0189_Face_Outline"]
    names = {n["name"]: n.get("extras", {}).get("hidden", False) for n in exporter.nodes}
    # the disabled renderer's object stays a plain node (clips may move it), the inactive one is hidden
    assert names == {"CH0189": False, "CH0189_Face_Outline": False, "CH0189_Face01_Outline": False, "Off": True}


# --- CAB discovery ---

def _unityfs(names, *, version=7, at_end=False, compress=True):
    info = bytes(16) + struct.pack(">i", 1) + struct.pack(">IIH", 0, 0, 0) + struct.pack(">i", len(names))
    info += b"".join(struct.pack(">qqI", 0, 0, 4) + n.encode() + b"\0" for n in names)
    packed = compress_lz4(info) if compress else info
    flags = (2 if compress else 0) | (0x80 if at_end else 0)
    head = b"UnityFS\0" + struct.pack(">I", version) + b"5.x.x\0" + b"2021.3.0f1\0"
    head += struct.pack(">qIII", 0, len(packed), len(info), flags)
    if version >= 7:
        head += b"\0" * (-len(head) % 16)
    return head + b"DATA" + packed if at_end else head + packed + b"DATA"


@pytest.mark.parametrize("version,at_end,compress", [(7, False, True), (7, True, True), (6, False, True), (6, True, False)])
def test_cab_names_from_headers(tmp_path, version, at_end, compress):
    path = tmp_path / "a.bundle"
    path.write_bytes(_unityfs(["CAB-0123abcd", "CAB-0123abcd.resS"], version=version, at_end=at_end, compress=compress))
    assert cab_names(path) == ["cab-0123abcd", "cab-0123abcd.ress"]


def test_cab_names_rejects_other_files(tmp_path):
    other = tmp_path / "other.bundle"
    other.write_bytes(b"UnityWeb\0" + bytes(64))
    assert cab_names(other) == []
    broken = tmp_path / "broken.bundle"
    broken.write_bytes(b"UnityFS\0\0\0\0\x07")
    with pytest.raises(ValueError):
        cab_names(broken)


def _corrupt_unityfs(flags):
    """A UnityFS header whose compressed blocks info is garbage."""
    packed = b"\xff" * 40
    head = b"UnityFS\0" + struct.pack(">I", 7) + b"5.x.x\0" + b"2021.3.0f1\0" + struct.pack(">qIII", 0, len(packed), 200, flags)
    return head + b"\0" * (-len(head) % 16) + packed + b"DATA"


@pytest.mark.parametrize("flags", [1, 2, 3, 4])  # LZMA, LZ4, LZ4HC, LZHAM
def test_cab_names_wraps_decompression_errors(tmp_path, flags):
    path = tmp_path / "corrupt.bundle"
    path.write_bytes(_corrupt_unityfs(flags))
    with pytest.raises(ValueError):
        cab_names(path)
    with pytest.raises(OSError):
        cab_names(tmp_path / "missing.bundle")


def test_model_dependency_families():
    for name in ("character-ch0242-_mxload-2024-11-18_assets_all_1.bundle",
                 "assets-_mx-characters-ch0242-_mxdependency-2024-11-18_004_assets_all_2.bundle",
                 "prologdepengroup-assets-_mx-shaders-_mxprolog-2024-11-18_assets_all_3.bundle",
                 "prologdepengroup-assets-_mx-program-animators-_mxprolog-2024-11-18_assets_all_4.bundle",
                 "assets-_mx-npcs-np0024-_mxdependency-2024-11-18_000_assets_all_5.bundle"):
        assert is_model_dependency(Path(name))
    assert not is_model_dependency(Path("uis-01_common-14_charactercollect-_mxload-2024-11-18.bundle"))


# --- GameAssets ---

def _game(tmp_path, *names):
    resources = tmp_path / "Resource"
    resources.mkdir(exist_ok=True)
    for name in names:
        (resources / name).write_bytes(b"")
    return GameAssets([resources], AssetCache(root=tmp_path / "cache", allowed=True)), resources


def test_model_glb_is_memory_only_and_keyed_by_bundle_stamps(tmp_path, monkeypatch):
    prefab = "character-ch0242-_mxload-2024-11-18_assets_all_1.bundle"
    game, resources = _game(tmp_path, prefab, "character-hoshino_original-_mxload-2024-11-18_assets_all_2.bundle",
                            "character-Bad.Name-_mxload-2024-11-18_assets_all_3.bundle")
    assert game.model_cores() == {"ch0242", "hoshino_original"}
    calls = []

    def export(graph, bundles, dev, **kwargs):
        calls.append((dev, [p.name for p in bundles], graph.index))
        return b"glTF" + bytes(len(calls))

    monkeypatch.setattr(model, "export_chibi", export)
    assert game.model_glb("CH0242") == b"glTF\0"
    assert game.model_glb("ch0242") == b"glTF\0"
    assert calls == [("ch0242", [prefab], {})]  # empty files have no CAB names
    assert not (tmp_path / "cache").exists()  # never on disk, even with consent
    os.utime(resources / prefab, ns=(1, 1))
    assert game.model_glb("ch0242") == b"glTF\0\0"  # a changed prefab bundle exports again
    with pytest.raises(AssetNotFound):
        game.model_glb("ch9999")


def test_model_glb_exports_again_when_a_bundle_it_read_changes(tmp_path, monkeypatch):
    prefab = "character-ch0242-_mxload-2024-11-18_assets_all_1.bundle"
    dependency = "assets-_mx-characters-ch0242-_mxdependency-2024-11-18_004_assets_all_2.bundle"
    game, resources = _game(tmp_path, prefab, dependency)
    calls = []

    def export(graph, bundles, dev, **kwargs):
        graph.loaded.append(str(resources / dependency))  # the meshes, textures and clips
        calls.append(dev)
        return b"glTF" + bytes(len(calls))

    monkeypatch.setattr(model, "export_chibi", export)
    assert game.model_glb("ch0242") == game.model_glb("ch0242") == b"glTF\0"
    os.utime(resources / dependency, ns=(1, 1))  # a texture mod installed in place
    assert game.model_glb("ch0242") == game.model_glb("ch0242") == b"glTF\0\0"
    (resources / dependency).unlink()
    assert game.model_glb("ch0242") == b"glTF\0\0\0"
    assert len(calls) == 3 and not (tmp_path / "cache").exists()


def test_cab_index_skips_a_corrupt_bundle(tmp_path):
    # one damaged model-family bundle (an interrupted update) must not break every model
    game, resources = _game(tmp_path)
    good = "assets-_mx-characters-ch0242-_mxdependency-2024-11-18_004_assets_all_2.bundle"
    (resources / good).write_bytes(_unityfs(["CAB-good"]))
    (resources / "assets-_mx-characters-ch0243-_mxdependency-2024-11-18_004_assets_all_3.bundle").write_bytes(
        _corrupt_unityfs(2))
    assert {cab: Path(path).name for cab, path in game._cab_index().items()} == {"cab-good": good}


def test_model_graph_falls_back_to_every_bundle_once(tmp_path):
    asked = []
    loaded = []

    class Env:
        objects = []

    def opener(path):
        loaded.append(path.name)
        from contextlib import nullcontext
        return nullcontext(Env())

    graph = model.BundleGraph({}, fallback=lambda: asked.append(1) or {"cab-b": str(tmp_path / "b.bundle")}, opener=opener)
    owner = SimpleNamespace(assets_file=SimpleNamespace(name="CAB-A", externals=[SimpleNamespace(path="archive:/CAB-B/CAB-B")]))
    with graph:
        assert graph.deref(owner, {"m_FileID": 1, "m_PathID": 5}) is None  # loaded b.bundle, no such object
        assert graph.deref(owner, {"m_FileID": 1, "m_PathID": 6}) is None
        assert graph.deref(owner, {"m_FileID": 0, "m_PathID": 0}) is None
    assert asked == [1] and loaded == ["b.bundle"]


# --- catalog ---

def test_model_core_candidates():
    cores = {"hoshino_original", "ch0258_02", "ch0076", "ch0242", "ch0242_original"}
    assert model_core("ch0242", [], cores) == "ch0242"           # the key itself first
    assert model_core("hoshino", [], cores) == "hoshino_original"
    assert model_core("ch0258", ["CH0258_02", "hoshino_battle_tank"], cores) == "ch0258_02"
    assert model_core("erika", ["ch0076"], cores) == "ch0076"
    assert model_core("tsumugi", ["ch0252"], cores) is None


class ModelGame:
    def __init__(self, models=None):
        self.models = models

    def spine_cores(self, kind):
        return {"spr": {k + "_spr": [] for k in ("hoshino", "ch0010", "ch0020", "np0001")}, "lobby": {}}[kind]

    def collection_names(self):
        return {"bg": [], "portrait": []}

    def model_cores(self):
        return set(self.models)


def test_catalog_variant_model_mapping():
    game = ModelGame({"hoshino_original", "hoshino_swimsuit_original", "np0001"})
    catalog = Catalog(game, FIXTURES / "characters.csv", FIXTURES / "catalog.json")
    assert catalog.variant("hoshino").model == "hoshino_original"
    assert catalog.variant("ch0010").model == "hoshino_swimsuit_original"  # through its dev alias
    assert catalog.variant("ch0020").model is None
    assert catalog.variant("np0001").model == "np0001"
    assert catalog.variant("hoshino").to_json()["model"] == "hoshino_original"
    # a game source without models (older fakes, no install): no model anywhere
    plain = SimpleNamespace(spine_cores=game.spine_cores, collection_names=game.collection_names)
    assert Catalog(plain, None, FIXTURES / "catalog.json").variant("hoshino").model is None


# --- a local install (read only) ---

@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_chibi_exports(tmp_path):
    game = GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=tmp_path / "cache", allowed=True))
    assert {"hoshino_original", "ch0242"} <= game.model_cores()
    data = game.model_glb("hoshino_original")
    assert data[:4] == b"glTF" and struct.unpack_from("<I", data, 8)[0] == len(data)
    doc = _strict(data)
    assert doc["extras"]["prefab"] == "Echelon_Hoshino_Original" and "haloFollower" in doc["extras"]
    slots = [a["extras"]["slot"] for a in doc["animations"]]
    assert slots[0] == "Formation_Idle" and "Cafe_Reaction" in slots and len(slots) == len(set(slots))
    assert doc["skins"] and all(len(s["joints"]) > 0 for s in doc["skins"])
    kinds = {m["extras"]["kind"] for m in doc["materials"]}
    assert {"body", "face", "hair", "eyemouth", "halo"} <= kinds
    if "ch0145" in game.model_cores():  # Miyu: the idle turns her expression face off
        miyu = _strict(game.model_glb("ch0145"))
        idle = next(a for a in miyu["animations"] if a["extras"]["slot"] == "Formation_Idle")
        assert [miyu["nodes"][t["node"]]["name"] for t in idle["extras"]["toggles"]] == ["CH0145_Face01_Outline_mesh"]
        assert idle["extras"]["toggles"][0]["keys"] == [[0.0, 0]]
    if "saya_original" in game.model_cores():  # an infinite material constant
        fade = [m["extras"]["colors"].get("_CameraFadeParams") for m in _strict(game.model_glb("saya_original"))["materials"]]
        assert [0.0, model.FLT_MAX, 0.0, 0.0] in fade
    assert not (tmp_path / "cache").exists()
