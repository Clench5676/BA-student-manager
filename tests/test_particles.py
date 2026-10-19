"""The lobby particle export (gameassets/particles.py) on synthetic typetrees: curves, gradients, matrices, materials,
textures, vertex streams and the modules a system carries. The prefab walk that places the systems is tested in
test_lobby.py; the simulation and drawing in test_particles_player.py."""

from __future__ import annotations

import math

from ba_modding_toolkit.gameassets import particles


def key(time: float, value: float, slope: float = 0.0) -> dict:
    return {"time": time, "value": value, "inSlope": slope, "outSlope": slope}


def mm(state: int, scalar: float = 1.0, lo: float = 0.0, hi_keys=None, lo_keys=None) -> dict:
    return {"minMaxState": state, "scalar": scalar, "minScalar": lo,
            "maxCurve": {"m_Curve": hi_keys or []}, "minCurve": {"m_Curve": lo_keys or []}}


def color(r: float, g: float, b: float, a: float = 1.0) -> dict:
    return {"r": r, "g": g, "b": b, "a": a}


def unity_gradient(colors, alphas, mode: int = 0) -> dict:
    g = {"m_NumColorKeys": len(colors), "m_NumAlphaKeys": len(alphas), "m_Mode": mode}
    for i in range(8):
        c = colors[i][1] if i < len(colors) else (0.0, 0.0, 0.0)
        a = alphas[i][1] if i < len(alphas) else 0.0
        g[f"key{i}"] = color(*c, a)
        g[f"ctime{i}"] = round(colors[i][0] * 65535) if i < len(colors) else 0
        g[f"atime{i}"] = round(alphas[i][0] * 65535) if i < len(alphas) else 0
    return g


def test_min_max_curves():
    assert particles.curve(None, 5.0) == 5.0
    assert particles.curve(2.5) == 2.5
    assert particles.curve(mm(0, 3.0)) == 3.0
    # random between two constants; equal bounds are a constant
    assert particles.curve(mm(3, 4.0, 1.0)) == {"r": [1.0, 4.0]}
    assert particles.curve(mm(3, 2.0, 2.0)) == 2.0
    # a curve times its multiplier, keys [time, value, in slope, out slope]; a stepped key's infinite slope is flat
    c = particles.curve(mm(1, 2.0, hi_keys=[key(0.0, 0.0, 1.0), {**key(1.0, 1.0), "inSlope": math.inf}]))
    assert c == {"c": [[0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 0.0, 0.0]], "k": 2.0}
    both = particles.curve(mm(2, 1.0, hi_keys=[key(0.0, 1.0)], lo_keys=[key(0.0, 0.5)]))
    assert both == {"c": [[0.0, 1.0, 0.0, 0.0]], "c0": [[0.0, 0.5, 0.0, 0.0]], "k": 1.0}
    # a curve without keys reads 1
    assert particles.curve(mm(1, 0.5)) == {"c": [[0.0, 1.0, 0.0, 0.0]], "k": 0.5}


def test_min_max_gradients():
    assert particles.gradient(None) == {"col": [1.0, 1.0, 1.0, 1.0]}
    assert particles.gradient({"minMaxState": 0, "maxColor": color(1.0, 0.5, 0.25, 0.75)}) == {"col": [1.0, 0.5, 0.25, 0.75]}
    two = particles.gradient({"minMaxState": 2, "minColor": color(0, 0, 0), "maxColor": color(1, 1, 1)})
    assert two == {"r": [[0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]]}
    g = unity_gradient([(0.0, (1.0, 0.0, 0.0)), (1.0, (0.0, 0.0, 1.0))], [(0.0, 0.0), (0.25, 1.0), (1.0, 0.0)], mode=1)
    out = particles.gradient({"minMaxState": 1, "maxGradient": g})
    # key times are stored in 1/65535 steps; fixed mode is kept
    assert out == {"g": {"c": [[0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0]], "a": [[0.0, 0.0], [0.25, 1.0], [1.0, 0.0]],
                         "fixed": 1}}
    assert set(particles.gradient({"minMaxState": 3, "maxGradient": g, "minGradient": g})) == {"g", "g0"}
    assert particles.gradient({"minMaxState": 4, "maxGradient": g})["pick"] == 1


def test_transform_matrices():
    half = math.radians(90) / 2
    t = {"m_LocalPosition": {"x": 10.0, "y": 20.0, "z": 3.0}, "m_LocalScale": {"x": 2.0, "y": 2.0, "z": 1.0},
         "m_LocalRotation": {"x": 0.0, "y": 0.0, "z": math.sin(half), "w": math.cos(half)}}
    m = particles.trs(t)
    apply = lambda m, p: [m[i * 4] * p[0] + m[i * 4 + 1] * p[1] + m[i * 4 + 2] * p[2] + m[i * 4 + 3] for i in range(3)]  # noqa: E731
    # scaled, turned 90 degrees anticlockwise, then moved
    assert [round(v, 6) for v in apply(m, [1.0, 0.0, 0.0])] == [10.0, 22.0, 3.0]
    parent = particles.trs({"m_LocalPosition": {"x": 0.0, "y": -962.0, "z": 0.0}, "m_LocalScale": {"x": 100.0, "y": 100.0, "z": 100.0},
                            "m_LocalRotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}})
    world = particles.mul(parent, m)
    assert [round(v, 4) for v in apply(world, [1.0, 0.0, 0.0])] == [1000.0, 1238.0, 300.0]
    assert particles.mul(particles.IDENTITY, m) == m


def test_modules_and_main():
    ps = {
        "lengthInSec": 2.0, "looping": 1, "prewarm": 1, "startDelay": mm(0, 0.5), "moveWithTransform": 1,
        "scalingMode": 0, "simulationSpeed": 1.5, "playOnAwake": 0,
        "InitialModule": {"startLifetime": mm(3, 3.0, 1.0), "startSpeed": mm(0, 0.0), "startSize": mm(0, 2.0),
                          "size3D": 0, "rotation3D": 0, "startRotation": mm(0, 0.5),
                          "startColor": {"minMaxState": 0, "maxColor": color(1, 1, 1, 0.5)},
                          "gravityModifier": mm(0, 0.0), "maxNumParticles": 50, "randomizeRotationDirection": 0.5},
        "EmissionModule": {"enabled": 1, "rateOverTime": mm(0, 10.0), "rateOverDistance": mm(0, 0.0), "m_BurstCount": 1,
                           "m_Bursts": [{"time": 0.25, "countCurve": mm(0, 3.0), "cycleCount": 2, "repeatInterval": 0.5,
                                         "probability": 1.0}, {"time": 1.0, "countCurve": mm(0, 9.0)}]},
        "ShapeModule": {"enabled": 1, "type": 5, "m_Scale": {"x": 3.0, "y": 2.0, "z": 1.0}, "radius": {"value": 1.0},
                        "arc": {"value": 360.0, "mode": 0, "spread": 0.0, "speed": mm(0, 1.0)}},
        "SizeModule": {"enabled": 1, "separateAxes": 1, "curve": mm(1, 1.0, hi_keys=[key(0, 0), key(1, 1)]),
                       "y": mm(0, 2.0), "z": mm(0, 3.0)},
        "ColorModule": {"enabled": 0},
        "VelocityModule": {"enabled": 1, "x": mm(0, 0.0), "y": mm(0, -0.05), "z": mm(0, 0.0), "orbitalX": mm(0, 0.5),
                           "orbitalY": mm(0, 0.0), "orbitalZ": mm(0, 0.0), "orbitalOffsetX": mm(0, -0.5),
                           "orbitalOffsetY": mm(0, 0.0), "orbitalOffsetZ": mm(0, 0.0), "radial": mm(0, 0.0),
                           "speedModifier": mm(0, 0.12), "inWorldSpace": 1},
        "UVModule": {"enabled": 1, "mode": 0, "tilesX": 2, "tilesY": 2, "animationType": 0, "rowMode": 1,
                     "frameOverTime": mm(1, 0.25, hi_keys=[key(0, 1), key(1, 1)]), "startFrame": mm(0, 0.25),
                     "cycles": 1.0, "timeMode": 0},
    }
    renderer = {"m_RenderMode": 0, "m_MaxParticleSize": 0.5, "m_SortMode": 2, "m_UseCustomVertexStreams": 1,
                "m_VertexStreams": [0, 3, 4, 5, 34, 38]}
    s = particles.system(ps, renderer)
    main = s["main"]
    assert (main["duration"], main["loop"], main["prewarm"], main["delay"], main["space"], main["speedScale"]) == (2.0, 1, 1, 0.5, 1, 1.5)
    assert main["life"] == {"r": [1.0, 3.0]} and main["size"] == [2.0] and main["rotation"] == [0.5]
    assert main["color"] == {"col": [1.0, 1.0, 1.0, 0.5]} and main["max"] == 50 and main["flipRotation"] == 0.5
    assert s["playOnAwake"] == 0
    # the burst count limits the bursts read; a burst without an interval repeats no sooner than every 0.01 s
    assert s["emission"] == {"rate": 10.0, "dist": 0.0, "bursts": [
        {"t": 0.25, "n": 3.0, "cycles": 2, "interval": 0.5, "p": 1.0}]}
    assert s["shape"]["type"] == 5 and s["shape"]["scale"] == [3.0, 2.0, 1.0] and "unsupported" not in s["shape"]
    mods = s["modules"]
    assert mods["size"]["sep"] == 1 and mods["size"]["y"] == 2.0 and mods["size"]["z"] == 3.0
    assert "color" not in mods
    assert mods["velocity"]["orbitalX"] == 0.5 and mods["velocity"]["speed"] == 0.12 and mods["velocity"]["world"] == 1
    assert mods["sheet"]["x"] == 2 and mods["sheet"]["start"] == 0.25
    assert s["renderer"]["sort"] == 2 and s["renderer"]["streams"] == {"uv": [0, 2], "uv2": [2, 2], "c1": [4, 4], "c2": [8, 4]}
    # a renderer without custom streams has only the UV, a mesh shape is emitted from its origin
    assert particles.system({}, {})["renderer"]["streams"] == {"uv": [0, 2]}
    assert particles.system({"ShapeModule": {"enabled": 1, "type": 6}}, {})["shape"]["unsupported"] == 1
    assert particles.system({}, None)["emission"] == {"rate": 0.0, "dist": 0.0, "bursts": []}


def test_sub_emitters():
    ps = {"SubModule": {"enabled": 1, "subEmitters": [
        {"emitter": {"m_FileID": 0, "m_PathID": 77}, "type": 2, "properties": 6, "emitProbability": 0.5},
        {"emitter": {"m_FileID": 0, "m_PathID": 0}, "type": 0}]}}
    assert particles.sub_emitters(ps) == [(2, 77, 6, 0.5)]
    assert particles.sub_emitters({"SubModule": {"enabled": 0, "subEmitters": [{"emitter": {"m_PathID": 5}}]}}) == []


def test_material_and_texture():
    props = [{"m_Name": "_Color", "m_Type": 0, "m_DefValue[0]": 1.0, "m_DefValue[1]": 1.0, "m_DefValue[2]": 1.0, "m_DefValue[3]": 1.0},
             {"m_Name": "_UV_Add_TilingOffset", "m_Type": 1, "m_DefValue[0]": 1.0, "m_DefValue[1]": 1.0},
             {"m_Name": "_Multiply", "m_Type": 2, "m_DefValue[0]": 1.0},
             {"m_Name": "_Tex_Main", "m_Type": 4, "m_DefTexture": {"m_DefaultName": "white"}},
             {"m_Name": "_Tex_Mask", "m_Type": 4, "m_DefTexture": {"m_DefaultName": "gray"}}]
    tex_tree = {"m_Name": "FX_TEX_Glow", "m_Width": 128, "m_Height": 64, "m_MipCount": 8, "m_ColorSpace": 0,
                "m_TextureSettings": {"m_FilterMode": 2, "m_WrapMode": 0, "m_WrapU": 1, "m_WrapV": 0}}
    tex = particles.texture(tex_tree, "cab-1_5")
    assert tex == {"id": "cab-1_5", "name": "FX_TEX_Glow", "w": 128, "h": 64, "filter": 2, "mips": 1, "wrap": [1, 0], "srgb": 0}
    tree = {"m_SavedProperties": {
        "m_Floats": [["_Step_Power", 0.25]],
        "m_Colors": [["_Color", color(2.0, 2.0, 2.0, 1.0)]],
        "m_TexEnvs": [["_Tex_Main", {"m_Scale": {"x": 3.0, "y": 1.0}, "m_Offset": {"x": 0.5, "y": 0.0}}],
                      ["_Tex_Mask", {"m_Scale": {"x": 1.0, "y": 1.0}, "m_Offset": {"x": 0.0, "y": 0.0}}]]}}
    mat = particles.material("DSFX/FX_SHADER_Step_0", tree, {"src": 1, "dst": 10, "queue": 3100}, props,
                             {"_Tex_Main": tex})
    assert mat["program"] == "step" and (mat["src"], mat["dst"], mat["queue"]) == (1, 10, 3100)
    assert mat["tex"]["_Tex_Main"] == {**tex, "st": [3.0, 1.0, 0.5, 0.0]}
    # an empty slot names the shader's default texture
    assert mat["tex"]["_Tex_Mask"] == {"default": "gray", "st": [1.0, 1.0, 0.0, 0.0]}
    # the shader's defaults fill what the material does not store; Vector properties are listed (no sRGB decoding)
    assert mat["floats"] == {"_Step_Power": 0.25, "_Multiply": 1.0}
    assert mat["colors"]["_Color"] == [2.0, 2.0, 2.0, 1.0] and mat["colors"]["_UV_Add_TilingOffset"] == [1.0, 1.0, 0.0, 0.0]
    assert mat["vectors"] == ["_UV_Add_TilingOffset"]
    assert particles.program("DSFX/FX_SHADER_Matcap_0") == "matcap"
    assert particles.program("DSFX/FX_SHADER_AlphaBlend_Add_Distort_1a") is None and particles.program(None) is None


def test_mesh():
    out = particles.mesh([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [(0, 0), (1, 0), (0, 1)], None, [(0, 1, 2)],
                         [(1, 1, 1, 1)] * 3)
    assert out == {"v": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], "i": [0, 1, 2], "uv": [0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                   "c": [1.0] * 12}
