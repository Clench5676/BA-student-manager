"""Unity ParticleSystem effects of a memorial lobby prefab, as plain data for the web UI's particle player.

Almost every lobby prefab carries particle systems: bokeh and dust over the scene, stars, petals, Michiru's sparkler.
This module turns their typetrees (ParticleSystem, ParticleSystemRenderer, the material, its shader and textures)
into compact JSON that web/js/particles.js simulates and draws. It works on plain typetrees, so it runs without game
files; the service resolves the materials, textures and meshes, which live in other bundles.

Values keep Unity's units and conventions: lengths in the system's own space (scaled as its scaling mode says),
angles in radians as serialized, colours as stored (sRGB, converted by the front end), curve keys as
[time, value, inSlope, outSlope], a slope null where it is infinite (a Constant tangent: Unity holds the left key's
value over a segment with one). Matrices are 3 x 4 row-major affine transforms [r00 r01 r02 tx r10 ... tz].

A MinMaxCurve becomes a number (constant), {"r": [min, max]} (random between two constants), {"c": keys, "k": k}
(a curve times k) or {"c": max keys, "c0": min keys, "k": k} (random between two curves). A MinMaxGradient becomes
{"col": rgba}, {"r": [rgba, rgba]}, {"g": gradient}, {"g": max, "g0": min} or {"g": gradient, "pick": 1} (a random
colour of the gradient), a gradient being {"c": [[t, r, g, b]...], "a": [[t, a]...], "fixed": 0 | 1}.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from typing import Any

# DSFX shaders the player ports (web/js/particles.js PROGRAMS), by the shader name the material points at
PROGRAMS = {
    "DSFX/FX_SHADER_Additive_0": "additive",
    "DSFX/FX_SHADER_AlphaBlend_0": "alphaBlend",
    "DSFX/FX_SHADER_AlphaBlend_Add": "alphaBlendAdd",
    "DSFX/FX_SHADER_AlphaBlend_Add_Mask_0": "mask",
    "DSFX/FX_SHADER_AlphaBlend_Add_Distort_0": "distort",
    "DSFX/FX_SHADER_AlphaBlend_Add_Distort_1a": "distort1a",
    "DSFX/FX_SHADER_AlphaBlend_Add_Double_Distort_1a": "doubleDistort",
    "DSFX/FX_SHADER_Step_0": "step",
    "DSFX/FX_SHADER_Step_0_MXChar": "step",
    "DSFX/FX_SHADER_Step_Distort_0": "stepDistort",
    "DSFX/FX_SHADER_AlphaBlend_2_Roz": "alphaBlend2",
    "DSFX/FX_SHADER_AlwaysView_Add": "alwaysViewAdd",
    "DSFX/FX_SHADER_Matcap_0": "matcap",
    "FX/General Unlit VertexColor": "vertexColor",
    "FX/FX_SHADER_Lobby_Order": "lobbyOrder",  # the lens-dirt and light quads (meshfx.py)
    # Unity's built-in sprite and mobile particle shaders: the intro's flash and fade sprites (intro.sprite)
    "Sprites/Default": "sprite",
    "Mobile/Particles/Additive": "particleAdd",
}
# ParticleSystemVertexStream -> component count, for packing custom vertex streams into TEXCOORD0..n as Unity does
_STREAM_SIZE = {4: 2, 5: 2, 6: 2, 7: 2, 8: 1, 9: 1, 10: 3, 11: 1, 12: 1, 13: 2, 14: 3, 15: 1, 16: 3, 17: 1, 18: 3,
                19: 3, 20: 1, 21: 1, 22: 1, 23: 1, 24: 2, 25: 3, 26: 4, 27: 1, 28: 2, 29: 3, 30: 4,
                31: 1, 32: 2, 33: 3, 34: 4, 35: 1, 36: 2, 37: 3, 38: 4}
# the streams the player fills: UV, UV2 (the texture sheet's next frame, here the same frame) and the custom data
_STREAM_NAME = {4: "uv", 5: "uv2", 31: "c1", 32: "c1", 33: "c1", 34: "c1", 35: "c2", 36: "c2", 37: "c2", 38: "c2"}
IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def _r(value: float, digits: int = 5) -> float:
    v = round(float(value), digits) + 0.0
    return v if math.isfinite(v) else 0.0


# --- matrices -------------------------------------------------------------------------------------------------------

def trs(t: Mapping[str, Any]) -> list[float]:
    """A Transform's local matrix (3 x 4, row-major): translation, rotation (quaternion), scale."""
    p, q, s = t["m_LocalPosition"], t["m_LocalRotation"], t["m_LocalScale"]
    x, y, z, w = q.get("x", 0.0), q.get("y", 0.0), q.get("z", 0.0), q.get("w", 1.0)
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    r = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
         2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
         2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    sx, sy, sz = s.get("x", 1.0), s.get("y", 1.0), s.get("z", 1.0)
    return [r[0] * sx, r[1] * sy, r[2] * sz, p.get("x", 0.0),
            r[3] * sx, r[4] * sy, r[5] * sz, p.get("y", 0.0),
            r[6] * sx, r[7] * sy, r[8] * sz, p.get("z", 0.0)]


def mul(a: list[float], b: list[float]) -> list[float]:
    """a * b for 3 x 4 affine matrices."""
    out = []
    for i in range(3):
        row = a[i * 4:i * 4 + 4]
        for j in range(4):
            v = row[0] * b[j] + row[1] * b[4 + j] + row[2] * b[8 + j]
            out.append(v + (row[3] if j == 3 else 0.0))
    return out


def rounded(m: list[float]) -> list[float]:
    return [_r(v, 6) for v in m]


# --- curves and gradients -------------------------------------------------------------------------------------------

def _slope(v: float) -> float | None:
    # an infinite tangent (Constant: the curve is stepped) is None: its segment holds the left key's value
    return None if math.isinf(v) else _r(v)


def _keys(curve: Mapping[str, Any] | None) -> list[list[float | None]]:
    out = []
    for k in (curve or {}).get("m_Curve", []):
        out.append([_r(k["time"]), _r(k["value"]), _slope(k.get("inSlope", 0.0)), _slope(k.get("outSlope", 0.0))])
    return out or [[0.0, 1.0, 0.0, 0.0]]


def curve(c: Mapping[str, Any] | float | None, default: float = 0.0) -> Any:
    """A MinMaxCurve (see the module docstring)."""
    if c is None:
        return default
    if not isinstance(c, Mapping):
        return _r(c)
    state = c.get("minMaxState", 0)
    k = _r(c.get("scalar", 0.0))
    if state == 0:
        return k
    if state == 3:
        lo = _r(c.get("minScalar", 0.0))
        return lo if lo == k else {"r": [lo, k]}
    if state == 1:
        return {"c": _keys(c.get("maxCurve")), "k": k}
    return {"c": _keys(c.get("maxCurve")), "c0": _keys(c.get("minCurve")), "k": k}


def _rgba(c: Mapping[str, float]) -> list[float]:
    return [_r(c.get("r", 0.0)), _r(c.get("g", 0.0)), _r(c.get("b", 0.0)), _r(c.get("a", 0.0))]


def _gradient(g: Mapping[str, Any]) -> dict:
    nc, na = g.get("m_NumColorKeys", 2), g.get("m_NumAlphaKeys", 2)
    colors = [[_r(g[f"ctime{i}"] / 65535)] + _rgba(g[f"key{i}"])[:3] for i in range(nc)]
    alphas = [[_r(g[f"atime{i}"] / 65535), _r(g[f"key{i}"]["a"])] for i in range(na)]
    return {"c": colors or [[0.0, 1.0, 1.0, 1.0]], "a": alphas or [[0.0, 1.0]], "fixed": 1 if g.get("m_Mode") == 1 else 0}


def gradient(c: Mapping[str, Any] | None) -> dict:
    """A MinMaxGradient (see the module docstring)."""
    if not c:
        return {"col": [1.0, 1.0, 1.0, 1.0]}
    state = c.get("minMaxState", 0)
    if state == 0:
        return {"col": _rgba(c["maxColor"])}
    if state == 2:
        return {"r": [_rgba(c["minColor"]), _rgba(c["maxColor"])]}
    if state == 1:
        return {"g": _gradient(c["maxGradient"])}
    if state == 3:
        return {"g": _gradient(c["maxGradient"]), "g0": _gradient(c["minGradient"])}
    return {"g": _gradient(c["maxGradient"]), "pick": 1}


def _vec(v: Mapping[str, float] | None, default: float = 0.0) -> list[float]:
    v = v or {}
    return [_r(v.get("x", default)), _r(v.get("y", default)), _r(v.get("z", default))]


# --- modules --------------------------------------------------------------------------------------------------------

def _shape(m: Mapping[str, Any]) -> dict | None:
    if not m.get("enabled"):
        return None
    radius, arc = m.get("radius") or {}, m.get("arc") or {}
    rad = radius.get("value", 1.0) if isinstance(radius, Mapping) else radius
    out = {
        "type": m.get("type", 4), "angle": _r(m.get("angle", 25.0)), "length": _r(m.get("length", 5.0)),
        "radius": _r(rad), "thickness": _r(m.get("radiusThickness", 1.0)), "box": _vec(m.get("boxThickness")),
        "donut": _r(m.get("donutRadius", 0.2)),
        "arc": _r(arc.get("value", 360.0) if isinstance(arc, Mapping) else arc),
        "arcMode": arc.get("mode", 0) if isinstance(arc, Mapping) else 0,
        "arcSpread": _r(arc.get("spread", 0.0)) if isinstance(arc, Mapping) else 0.0,
        "arcSpeed": curve(arc.get("speed"), 1.0) if isinstance(arc, Mapping) else 1.0,
        # an edge spreads its particles along its length by the radius's mode (random, loop, ping-pong or burst
        # spread), spread and speed, as an arc does around the arc with its own
        "radiusMode": radius.get("mode", 0) if isinstance(radius, Mapping) else 0,
        "radiusSpread": _r(radius.get("spread", 0.0)) if isinstance(radius, Mapping) else 0.0,
        "radiusSpeed": curve(radius.get("speed"), 1.0) if isinstance(radius, Mapping) else 1.0,
        "pos": _vec(m.get("m_Position")), "rot": _vec(m.get("m_Rotation")), "scale": _vec(m.get("m_Scale"), 1.0),
        "randomDir": _r(m.get("randomDirectionAmount", 0.0)), "spherical": _r(m.get("sphericalDirectionAmount", 0.0)),
        "randomPos": _r(m.get("randomPositionAmount", 0.0)), "align": 1 if m.get("alignToDirection") else 0,
    }
    if m.get("type") in (6, 13, 14, 19, 20):  # mesh, renderer and sprite shapes: emitted from the shape origin
        out["unsupported"] = 1
    return out


def _emission(m: Mapping[str, Any]) -> dict:
    if not m.get("enabled"):
        return {"rate": 0.0, "dist": 0.0, "bursts": []}
    bursts = []
    for b in m.get("m_Bursts", [])[: max(0, int(m.get("m_BurstCount", len(m.get("m_Bursts", [])))))]:
        bursts.append({"t": _r(b.get("time", 0.0)), "n": curve(b.get("countCurve"), 0.0),
                       "cycles": int(b.get("cycleCount", 1)), "interval": _r(max(0.01, b.get("repeatInterval", 0.01))),
                       "p": _r(b.get("probability", 1.0))})
    return {"rate": curve(m.get("rateOverTime")), "dist": curve(m.get("rateOverDistance")), "bursts": bursts}


def _modules(ps: Mapping[str, Any]) -> dict:
    out: dict[str, Any] = {}
    m = ps.get("SizeModule") or {}
    if m.get("enabled"):
        out["size"] = {"x": curve(m.get("curve"), 1.0), "sep": 1 if m.get("separateAxes") else 0}
        if m.get("separateAxes"):
            out["size"].update(y=curve(m.get("y"), 1.0), z=curve(m.get("z"), 1.0))
    m = ps.get("RotationModule") or {}
    if m.get("enabled"):
        out["rotation"] = {"z": curve(m.get("curve")), "sep": 1 if m.get("separateAxes") else 0}
        if m.get("separateAxes"):
            out["rotation"].update(x=curve(m.get("x")), y=curve(m.get("y")))
    m = ps.get("ColorModule") or {}
    if m.get("enabled"):
        out["color"] = gradient(m.get("gradient"))
    m = ps.get("ColorBySpeedModule") or {}
    if m.get("enabled"):
        # the gradient over the particle's speed between range x and y (CH0318's dust fades out towards 7 and 8 units
        # a second)
        rng = m.get("range") or {}
        out["colorBySpeed"] = {"color": gradient(m.get("gradient")),
                               "range": [_r(rng.get("x", 0.0)), _r(rng.get("y", 1.0))]}
    m = ps.get("VelocityModule") or {}
    if m.get("enabled"):
        out["velocity"] = {k: curve(m.get(k)) for k in ("x", "y", "z", "orbitalX", "orbitalY", "orbitalZ",
                                                         "orbitalOffsetX", "orbitalOffsetY", "orbitalOffsetZ",
                                                         "radial")}
        out["velocity"]["speed"] = curve(m.get("speedModifier"), 1.0)
        out["velocity"]["world"] = 1 if m.get("inWorldSpace") else 0
    m = ps.get("ForceModule") or {}
    if m.get("enabled"):
        out["force"] = {k: curve(m.get(k)) for k in ("x", "y", "z")}
        out["force"]["world"] = 1 if m.get("inWorldSpace") else 0
    m = ps.get("ClampVelocityModule") or {}
    if m.get("enabled"):
        out["limit"] = {"speed": curve(m.get("magnitude"), 1.0), "dampen": _r(m.get("dampen", 1.0)),
                        "drag": curve(m.get("drag")), "sep": 1 if m.get("separateAxis") else 0,
                        "world": 1 if m.get("inWorldSpace") else 0}
        if m.get("separateAxis"):
            out["limit"].update(x=curve(m.get("x"), 1.0), y=curve(m.get("y"), 1.0), z=curve(m.get("z"), 1.0))
    m = ps.get("UVModule") or {}
    if m.get("enabled") and m.get("mode", 0) == 0:
        out["sheet"] = {"x": max(1, int(m.get("tilesX", 1))), "y": max(1, int(m.get("tilesY", 1))),
                        "type": m.get("animationType", 0), "rowMode": m.get("rowMode", 1),
                        "row": m.get("rowIndex", 0), "frame": curve(m.get("frameOverTime")),
                        "start": curve(m.get("startFrame")), "cycles": _r(m.get("cycles", 1.0)),
                        "time": m.get("timeMode", 0), "fps": _r(m.get("fps", 30.0))}
    m = ps.get("CustomDataModule") or {}
    if m.get("enabled"):
        custom = []
        for i in (0, 1):
            mode = m.get(f"mode{i}", 0)
            if mode == 1:
                n = int(m.get(f"vectorComponentCount{i}", 4))
                custom.append({"v": [curve(m.get(f"vector{i}_{k}")) for k in range(n)]})
            elif mode == 2:
                custom.append({"col": gradient(m.get(f"color{i}"))})
            else:
                custom.append(None)
        out["custom"] = custom
    m = ps.get("TrailModule") or {}
    if m.get("enabled") and m.get("mode", 0) == 0:
        # a trail behind each particle (Particles mode; Ribbon mode is used by no lobby): the points it leaves every
        # minVertexDistance, each living lifetime x its particle's lifetime, drawn with the renderer's second material
        out["trail"] = {
            "ratio": _r(m.get("ratio", 1.0)), "life": curve(m.get("lifetime"), 1.0),
            "minDist": _r(m.get("minVertexDistance", 0.2)), "texMode": m.get("textureMode", 0),
            "world": 1 if m.get("worldSpace") else 0, "die": 1 if m.get("dieWithParticles", True) else 0,
            "sizeWidth": 1 if m.get("sizeAffectsWidth", True) else 0,
            "sizeLife": 1 if m.get("sizeAffectsLifetime") else 0,
            "inherit": 1 if m.get("inheritParticleColor", True) else 0,
            "color": gradient(m.get("colorOverLifetime")), "width": curve(m.get("widthOverTrail"), 1.0),
            "colorTrail": gradient(m.get("colorOverTrail")),
        }
    return out


def _main(ps: Mapping[str, Any]) -> dict:
    im = ps.get("InitialModule") or {}
    size3 = bool(im.get("size3D"))
    rot3 = bool(im.get("rotation3D"))
    out = {
        "duration": _r(max(0.05, ps.get("lengthInSec", 5.0))), "loop": 1 if ps.get("looping") else 0,
        "prewarm": 1 if ps.get("prewarm") else 0, "delay": curve(ps.get("startDelay")),
        "speedScale": _r(ps.get("simulationSpeed", 1.0)), "space": ps.get("moveWithTransform", 0),
        "scaling": ps.get("scalingMode", 1),
        "life": curve(im.get("startLifetime"), 5.0), "speed": curve(im.get("startSpeed"), 5.0),
        "size": [curve(im.get("startSize"), 1.0)] + ([curve(im.get("startSizeY"), 1.0),
                                                       curve(im.get("startSizeZ"), 1.0)] if size3 else []),
        "rotation": ([curve(im.get("startRotationX")), curve(im.get("startRotationY"))] if rot3 else [])
        + [curve(im.get("startRotation"))],
        "flipRotation": _r(im.get("randomizeRotationDirection", 0.0)),
        "color": gradient(im.get("startColor")), "gravity": curve(im.get("gravityModifier")),
        "max": int(im.get("maxNumParticles", 1000)),
    }
    # the ring buffer keeps particles past their lifetime until max particles needs their place: 1 holds them at
    # their end (pause until replaced), 2 plays the loop range of their lifetime over and over (loop until replaced)
    ring = int(ps.get("ringBufferMode", 0) or 0)
    if ring in (1, 2):
        loop_range = ps.get("ringBufferLoopRange") or {}
        out.update(ring=ring, ringRange=[_r(loop_range.get("x", 0.0)), _r(loop_range.get("y", 1.0))])
    return out


def _streams(renderer: Mapping[str, Any]) -> dict[str, list[int]]:
    """Where UV, UV2 and the custom data land in TEXCOORD0.. (component offsets), as Unity packs the renderer's
    vertex streams; without custom streams only UV is there (TEXCOORD0.xy) and the rest reads 0."""
    if not renderer.get("m_UseCustomVertexStreams"):
        return {"uv": [0, 2]}
    out, offset = {}, 0
    for s in renderer.get("m_VertexStreams", []):
        size = _STREAM_SIZE.get(s)
        if size is None:  # position, normal, tangent, colour: their own semantics
            continue
        name = _STREAM_NAME.get(s)
        if name and name not in out:
            out[name] = [offset, size]
        offset += size
    return out


def _renderer(r: Mapping[str, Any]) -> dict:
    return {
        "mode": r.get("m_RenderMode", 0), "align": r.get("m_RenderAlignment", 0), "sort": r.get("m_SortMode", 0),
        "minSize": _r(r.get("m_MinParticleSize", 0.0)), "maxSize": _r(r.get("m_MaxParticleSize", 0.5)),
        "lengthScale": _r(r.get("m_LengthScale", 2.0)), "velocityScale": _r(r.get("m_VelocityScale", 0.0)),
        "pivot": _vec(r.get("m_Pivot")), "flip": _vec(r.get("m_Flip")), "streams": _streams(r),
        "rotateWithStretch": 1 if r.get("m_RotateWithStretchDirection", True) else 0,
        # Apply Active Color Space: in the game's linear colour space Unity converts the particle colours from gamma
        # to linear before they reach the vertex stream; with it off (116 systems in 30 lobbies: Michiru's, Nodoka's)
        # the shader gets them as stored
        "colorSpace": 1 if r.get("m_ApplyActiveColorSpace", True) else 0,
    }


def system(ps: Mapping[str, Any], renderer: Mapping[str, Any] | None) -> dict:
    """One ParticleSystem with its renderer, without its place, material or sub-emitters (see lobby.read_prefab)."""
    renderer = renderer or {}
    return {"main": _main(ps), "emission": _emission(ps.get("EmissionModule") or {}),
            "shape": _shape(ps.get("ShapeModule") or {}), "modules": _modules(ps), "renderer": _renderer(renderer),
            "playOnAwake": 1 if ps.get("playOnAwake", True) else 0}


def sub_emitters(ps: Mapping[str, Any]) -> list[tuple[int, int, int, float]]:
    """(type, emitter ParticleSystem path id, inherit properties, probability) of the enabled sub-emitter module."""
    m = ps.get("SubModule") or {}
    if not m.get("enabled"):
        return []
    out = []
    for e in m.get("subEmitters", []):
        pid = (e.get("emitter") or {}).get("m_PathID", 0)
        if pid:
            out.append((int(e.get("type", 0)), pid, int(e.get("properties", 0)), float(e.get("emitProbability", 1.0))))
    return out


def program(shader: str | None) -> str | None:
    """The player's program for a shader name, None for shaders it does not port."""
    return PROGRAMS.get(shader or "")


def material(shader: str | None, tree: Mapping[str, Any], state: Mapping[str, Any], shader_props: Iterable[Mapping],
             textures: Mapping[str, dict]) -> dict:
    """A particle material: its program, blend and queue, the textures by property (id, size, sampler, sRGB, tiling;
    an empty slot names the shader's default texture, "white", "black" ...) and its Float, Color and Vector properties
    as stored, the shader's defaults filling what the material lacks. Colors are converted to linear light by the
    front end, Vector properties not ("vectors" lists them)."""
    saved = tree.get("m_SavedProperties") or {}
    floats = {k: _r(v) for k, v in saved.get("m_Floats", []) if isinstance(v, (int, float))}
    colors = {k: _rgba(v) for k, v in saved.get("m_Colors", [])}
    defaults, vectors = {}, set()
    for p in shader_props:
        name, kind = p.get("m_Name"), p.get("m_Type")
        value = [p.get(f"m_DefValue[{i}]", 0.0) for i in range(4)]
        if kind in (2, 3):
            floats.setdefault(name, _r(value[0]))
        elif kind in (0, 1):
            colors.setdefault(name, [_r(v) for v in value])
            if kind == 1:
                vectors.add(name)
        elif kind == 4:
            defaults[name] = ((p.get("m_DefTexture") or {}).get("m_DefaultName") or "white").lower()
    tex = {}
    for name, env in saved.get("m_TexEnvs", []):
        s, o = env.get("m_Scale", {}), env.get("m_Offset", {})
        st = [_r(s.get("x", 1.0)), _r(s.get("y", 1.0)), _r(o.get("x", 0.0)), _r(o.get("y", 0.0))]
        tex[name] = {**textures[name], "st": st} if name in textures else {"default": defaults.get(name, "white"), "st": st}
    for name, default in defaults.items():
        tex.setdefault(name, {"default": default, "st": [1.0, 1.0, 0.0, 0.0]})
    return {"shader": shader, "program": program(shader), "src": state.get("src", 1), "dst": state.get("dst", 0),
            "queue": state.get("queue", 3000), "tex": tex, "floats": floats, "colors": colors,
            "vectors": sorted(v for v in vectors if v in colors)}


def texture(tree: Mapping[str, Any], tex_id: str) -> dict:
    """A texture's id and how the game samples it: size, filter (0 point, 1 bilinear, 2 trilinear), mipmaps, wrap per
    axis (0 repeat, 1 clamp, 2 mirror, 3 mirror once) and whether it is sRGB (m_ColorSpace 1)."""
    s = tree.get("m_TextureSettings") or {}
    wrap = s.get("m_WrapMode", 0)
    return {"id": tex_id, "name": tree.get("m_Name", ""), "w": tree.get("m_Width", 0), "h": tree.get("m_Height", 0),
            "filter": s.get("m_FilterMode", 1), "mips": 1 if (tree.get("m_MipCount") or 1) > 1 else 0,
            "wrap": [s.get("m_WrapU", wrap), s.get("m_WrapV", wrap)], "srgb": 0 if tree.get("m_ColorSpace", 1) == 0 else 1}


def mesh(vertices: list, uv: list | None, normals: list | None, triangles: Iterable[tuple[int, int, int]],
         colors: list | None = None) -> dict:
    """A particle mesh: positions, UVs, normals and colours flattened, triangles as indices."""
    flat = lambda rows, n: [_r(x) for row in rows for x in list(row)[:n]]  # noqa: E731
    out = {"v": flat(vertices, 3), "i": [int(i) for tri in triangles for i in tri]}
    if uv:
        out["uv"] = flat(uv, 2)
    if normals:
        out["n"] = flat(normals, 3)
    if colors:
        out["c"] = flat(colors, 4)
    return out


# a mesh renderer's meshes and their weights
_MESH_SLOTS = (("m_Mesh", "m_MeshWeighting"), ("m_Mesh1", "m_MeshWeighting1"), ("m_Mesh2", "m_MeshWeighting2"),
               ("m_Mesh3", "m_MeshWeighting3"))


def _mesh_choice(ids: list[tuple[str, float]], distribution: int) -> dict:
    """What a mesh renderer draws: "mesh", the first of its meshes, and with more than one "meshes", all of them in
    their slots' order (the empty slots left out): Unity picks one per particle, uniformly at random, or with
    m_MeshDistribution 1 (non-uniform random) by their weights ("weights")."""
    out: dict[str, Any] = {"mesh": ids[0][0]}
    if len(ids) > 1:
        out["meshes"] = [i for i, _ in ids]
        if distribution == 1:
            out["weights"] = [w for _, w in ids]
    return out


def anchor_of(n: dict, by_go: Mapping[int, dict], skeleton_of_go: Callable[[int], str | None],
              data_scale: Callable[[str], float]) -> tuple[dict | None, list[dict]]:
    """Where a prefab node (lobby.read_prefab) is placed: the nearest SkeletonUtilityBone above (or on) it, when it
    follows its bone (Follow), as {"skeleton", "bone", "go" (the skeleton GameObject's matrix), "ds" (its data
    scale)}, else None; and the nodes below that bone down to the node itself, top first (with no bone: up to the
    root, or up to an Override bone)."""
    chain, cur, anchor = [], n, None
    while cur is not None:
        utility = cur["first"].get("SkeletonUtilityBone")
        if utility is not None:
            skel_go = cur
            while skel_go is not None and "SkeletonAnimation" not in skel_go["first"]:
                skel_go = by_go.get(skel_go["parent"])
            skeleton = skeleton_of_go(skel_go["go"]) if skel_go else None
            if skeleton and utility.get("mode", 0) == 0:
                anchor = {"skeleton": skeleton, "bone": utility.get("boneName") or cur["name"],
                          "go": rounded(skel_go["m3"]), "ds": _r(data_scale(skeleton), 6)}
            break
        chain.append(cur)
        cur = by_go.get(cur["parent"])
    return anchor, chain[::-1]


# the lobby script that switches GameObjects on and off by Spine events (ch0217's fish and bubbles; the player reads
# the events, particles.js spineEvent)
TOGGLE_SCRIPT = "SpineEventToggleObjects"


def toggle_groups(nodes: list[dict], skeleton_of_go: Callable[[int], str | None]
                  ) -> tuple[list[dict], dict[int, list[list[int]]]]:
    """The prefab's SpineEventToggleObjects components: each one listens to the Spine events of the skeleton on its
    GameObject (or the nearest one above) and sets toggleObjects[event int] active on "EnableObject", inactive on
    "DisableObject". CH0217_home's Idle_01 switches fish 0 on at 5 s and off at 13.3 s, fish 1 at 23.3 to 30 s and
    the bubbles 5 and 6 twice, its BG_Loop_00_R fish 2 and 3, Talk_04_M bubble 4: seven indices, the seven entries of
    its list. Returns the groups, {"skeleton", "on": the objects' own activity in the prefab, 1 or 0}, and for each
    listed GameObject its [group, index] pairs."""
    by_go = {n["go"]: n for n in nodes}
    groups: list[dict] = []
    listed: dict[int, list[list[int]]] = {}
    for n in nodes:
        for cls, _, tree in n.get("all", ()):
            if cls != TOGGLE_SCRIPT:
                continue
            cur, skeleton = n, None
            while cur is not None and skeleton is None:
                skeleton = skeleton_of_go(cur["go"])
                cur = by_go.get(cur["parent"])
            on = []
            for i, pointer in enumerate(tree.get("toggleObjects") or []):
                target = by_go.get((pointer or {}).get("m_PathID", 0))
                on.append(1 if target is not None and target.get("own", target["active"]) else 0)
                if target is not None:
                    listed.setdefault(target["go"], []).append([len(groups), i])
            groups.append({"skeleton": skeleton, "on": on})
    return groups, listed


def build(nodes: list[dict], skeleton_of_go: Callable[[int], str | None], data_scale: Callable[[str], float],
          resolve: Callable[[str, int, dict], Any] | None, gates: Iterable[int] = ()) -> dict:
    """The particle systems of a prefab walk (lobby.read_prefab nodes, in hierarchy order), with their place: under a
    SkeletonUtilityBone (Follow) the bone GameObject moves with the bone, so a system there is anchored on that bone
    of its skeleton ("anchor") and placed by the transforms below it ("rel", Unity units of the bone GameObject);
    every system also keeps its place in the prefab's own pose ("static", NGUI units around the prefab root).
    resolve(kind, owner path id, pointer) reads the materials ("material") and meshes ("mesh") the renderers point
    at; without it no system has a material. Systems below a GameObject a SpineEventToggleObjects switches
    (toggle_groups) are kept even while it is off, with the [group, index] pairs above them ("toggle"): they play
    while every one is on. gates: GameObjects the lobby's intro switches on (intro.py): a system off at rest is kept
    when only they (and toggles) keep it off ("rest" 0). Each system has its GameObject as "_go" (for the intro, which
    lobby.read_prefab removes)."""
    systems, materials, textures, meshes = [], {}, {}, {}
    index_of_ps: dict[int, int] = {}
    pending_subs: list[tuple[int, list[tuple[int, int, int, float]]]] = []
    by_go = {n["go"]: n for n in nodes}
    gates = set(gates)
    groups, listed = toggle_groups(nodes, skeleton_of_go)
    for n in nodes:
        ps = n["first"].get("ParticleSystem")
        if ps is None:
            continue
        # active, or inactive only by GameObjects a toggle switches and GameObjects the intro switches on (gated: off
        # at rest)
        switched, cur, off, gated = [], n, False, False
        while cur is not None:
            if cur["go"] in listed:
                switched += listed[cur["go"]]
            elif not cur.get("own", cur["active"]):
                if cur["go"] in gates:
                    gated = True
                else:
                    off = True
            cur = by_go.get(cur["parent"])
        if off or (not n["active"] and not switched and not gated):
            continue
        ps_pid = n["pids"]["ParticleSystem"]
        rend = n["first"].get("ParticleSystemRenderer") or {}
        rend_pid = n["pids"].get("ParticleSystemRenderer", 0)
        item = system(ps, rend)

        def drawn_with(pointer: dict | None) -> str | None:
            # a material the player ports (its id), with its textures
            if not (pointer or {}).get("m_PathID"):
                return None
            found = resolve("material", rend_pid, pointer)
            if not found or not found[1].get("program"):
                return None
            materials[found[0]] = found[1]
            for tex in found[1].get("tex", {}).values():
                if "id" in tex:
                    textures[tex["id"]] = {k: v for k, v in tex.items() if k != "st"}
            return found[0]
        mat_id = trail_id = None
        pointers = (rend.get("m_Materials") or []) if resolve is not None and rend and rend.get("m_Enabled", 0) else []
        if pointers and item["renderer"]["mode"] != 5:
            mat_id = drawn_with(pointers[0])
            if mat_id and item["renderer"]["mode"] == 4:
                ids = []
                for slot, weight in _MESH_SLOTS:
                    pointer = rend.get(slot) or {}
                    mesh_found = resolve("mesh", rend_pid, pointer) if pointer.get("m_PathID") else None
                    if mesh_found:
                        meshes[mesh_found[0]] = mesh_found[1]
                        ids.append((mesh_found[0], _r(rend.get(weight, 1.0))))
                if ids:
                    item["renderer"].update(_mesh_choice(ids, rend.get("m_MeshDistribution", 0)))
                else:
                    mat_id = None
        if "trail" in item["modules"]:
            # the trails are the renderer's second submesh, with its second material and sorted by that one's queue
            # (CH0172's oil drops at 3100, their dirt trails at 2950); even a renderer that draws no particles has them
            trail_id = drawn_with(pointers[1]) if len(pointers) > 1 else None
            if trail_id:
                item.update(trailMaterial=trail_id, trailQueue=materials[trail_id]["queue"])
            else:
                del item["modules"]["trail"]
        item["material"] = mat_id
        item["queue"] = materials[mat_id]["queue"] if mat_id else 3000
        item["order"] = int(rend.get("m_SortingOrder", 0)) if rend else 0
        # the sorting layer's value (m_SortingLayer; m_SortingLayerID is its id), which Unity sorts by before the order:
        # Default is 0, and every renderer of the one other layer the game uses (id 896108637: Aru's and Iori's dust,
        # 941 renderers of the effect bundles) has 2, so it draws over everything on Default
        item["sortingLayer"] = int(rend.get("m_SortingLayer", 0)) if rend else 0
        # Unity world units added to its distance from the camera when transparents of the same queue are sorted back
        # to front: above 0 it draws earlier (behind), below 0 later (Hibiki's river surface 50, her bokeh -10)
        item["fudge"] = _r(rend.get("m_SortingFudge", 0.0)) if rend else 0.0
        anchor, chain = anchor_of(n, by_go, skeleton_of_go, data_scale)
        rel = IDENTITY
        for c in chain:
            rel = mul(rel, c["local3"])
        item.update(name=n["name"], path=n["path"], anchor=anchor, rel=rounded(rel), static=rounded(n["m3"]),
                    ls=_vec(n["t"].get("m_LocalScale"), 1.0), z=_r(n["m3"][11]), _go=n["go"])
        if switched:
            item["toggle"] = switched
        if gated:
            item["rest"] = 0  # off until the intro switches it on
        index_of_ps[ps_pid] = len(systems)
        systems.append(item)
        subs = sub_emitters(ps)
        if subs:
            pending_subs.append((len(systems) - 1, subs))
    for i, subs in pending_subs:
        resolved = []
        for kind, pid, props, p in subs:
            j = index_of_ps.get(pid)
            if j is not None and j != i:
                resolved.append({"type": kind, "system": j, "inherit": props, "p": _r(p)})
                systems[j]["isSub"] = 1
        if resolved:
            systems[i]["subs"] = resolved
    # what the player keeps: systems that draw, and the systems that spawn them
    keep = [bool(s["material"] or s.get("trailMaterial")) for s in systems]
    for _ in range(4):
        for i, s in enumerate(systems):
            if not keep[i] and any(keep[e["system"]] for e in s.get("subs", [])):
                keep[i] = True
    remap, out = {}, []
    for i, s in enumerate(systems):
        if keep[i]:
            remap[i] = len(out)
            out.append(s)
    for s in out:
        if "subs" in s:
            s["subs"] = [{**e, "system": remap[e["system"]]} for e in s["subs"] if e["system"] in remap]
    used_meshes = {m for s in out for m in s["renderer"].get("meshes", [s["renderer"].get("mesh")])}
    return {"systems": out, "materials": materials, "textures": textures,
            "meshes": {k: v for k, v in meshes.items() if k in used_meshes},
            "toggles": groups if any("toggle" in s for s in out) else []}
