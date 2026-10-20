"""The materials a memorial lobby skeleton is drawn with, as the game's spine-unity sets them, for web/js/skeleton-materials.js.

spine-unity draws every submesh with the material of its atlas page (the SpineAtlasAsset's materials, matched by their
main texture). Most pages use the plain spine shaders, which the web UI's spine-player reproduces; some use other
shaders: Aru's third page multiplies (Spine/Blend Modes/Skeleton PMA Multiply), water and river pages of three lobbies
scroll a noise distortion (Spine/Skeleton MX Standard - NoiseFlowAnimation) and one game screen glitches
(Spine/Skeleton MX Portrait Noise). Those pages are described here ("pages"), by the page's file name without its
extension, with the shader's blend and the material's own values; the plain pages are left out.

A slot's blend mode reaches the screen only through materials: with SkeletonDataAsset.blendModeMaterials
.requiresBlendModeMaterials set, BlendModeMaterials.ApplyMaterials gives the attachments of Multiply and Screen slots
(and Additive ones with applyAdditiveMaterial) a copy of their page with the replacement material listed for that page;
without it, or without a list for the mode, they keep their page's material and draw as Normal (ch0163's light_01,
Hiyori's R_eye_ligth_02). An Additive slot always adds: the mesh generator writes its premultiplied vertex colour with
alpha 0 (pmaVertexColors). "blend" lists the modes that have replacement materials, by page; a replacement that is not
set (a null reference) is None.

The renderer never writes the dark colour (SkeletonRenderer.tintBlack is off in every lobby prefab), and none of these
shaders reads it: "tintBlack" says whether it applies.

Everything here works on plain typetrees and material descriptions, so it runs without game files; the service reads
the bundles.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any

# the shaders the web UI ports (skeleton-materials.js PROGRAMS), by ShaderLab name; the others draw as spine-player's
# own (Spine/Skeleton, Spine/Skeleton MX Standard: the texture premultiplied, times the vertex colour, One
# OneMinusSrcAlpha)
PROGRAMS = {
    "Spine/Blend Modes/Skeleton PMA Multiply": "pma",
    "Spine/Blend Modes/Skeleton PMA Screen": "pma",
    "Spine/Blend Modes/Skeleton PMA Additive": "pma",
    "Spine/Skeleton MX Standard - NoiseFlowAnimation": "noiseFlow",
    "Spine/Skeleton MX Portrait Noise": "portraitNoise",
}
# the replacement material lists of BlendModeMaterials, by the slot blend mode they serve
_BLEND_LISTS = (("multiply", "multiplyMaterials"), ("screen", "screenMaterials"), ("additive", "additiveMaterials"))


def program(shader: str | None) -> str | None:
    """The web UI's program for a page shader, None for the shaders spine-player already draws as the game does."""
    return PROGRAMS.get(shader or "")


def page_name(name: str | None) -> str | None:
    """A page by the name the web UI knows it: the atlas page's file name without its extension."""
    return name.rsplit(".", 1)[0] if name and "." in name else name


def blend_state(form: Mapping[str, Any] | None, floats: Mapping[str, float]) -> dict[str, int]:
    """The colour and alpha blend factors (UnityEngine.Rendering.BlendMode) of a shader's first pass for a material:
    a factor names a material property (_SrcBlend ...) or is fixed in the pass ("<noninit>": Hina's multiply page
    keeps a stray float of that name, which the pass does not read)."""
    def value(entry: Mapping[str, Any], default: int) -> int:
        name = entry.get("name", "")
        if name and name != "<noninit>" and name in floats:
            return int(floats[name])
        return int(entry.get("val", default))

    try:
        state = form["m_SubShaders"][0]["m_Passes"][0]["m_State"]
        blend = state.get("rtBlend0") or state["rtBlend"][0]
        return {"src": value(blend["srcBlend"], 1), "dst": value(blend["destBlend"], 10),
                "srcA": value(blend["srcBlendAlpha"], 1), "dstA": value(blend["destBlendAlpha"], 10)}
    except (KeyError, TypeError, IndexError, ValueError):
        return {"src": 1, "dst": 10, "srcA": 1, "dstA": 10}


def material(shader: str | None, form: Mapping[str, Any] | None, tree: Mapping[str, Any],
             textures: Mapping[str, dict]) -> dict:
    """A page or replacement material: its program, blend, keywords that change the program (_STRAIGHT_ALPHA_INPUT:
    the shader premultiplies the texture), its Float and Color properties as stored (the shader's defaults filling what
    the material lacks; Colors are converted to linear light by the front end) and its textures but the page's own
    (textures: property -> particles.texture, an empty slot naming the shader's default texture)."""
    saved = tree.get("m_SavedProperties") or {}
    floats = {k: round(float(v), 6) + 0.0 for k, v in saved.get("m_Floats", []) if isinstance(v, (int, float))}
    colors = {k: [round(float(v.get(c, 0.0)), 6) + 0.0 for c in "rgba"] for k, v in saved.get("m_Colors", [])}
    defaults = {}
    for p in ((form or {}).get("m_PropInfo") or {}).get("m_Props", []):
        name, kind = p.get("m_Name"), p.get("m_Type")
        value = [p.get(f"m_DefValue[{i}]", 0.0) for i in range(4)]
        if kind in (2, 3):
            floats.setdefault(name, round(float(value[0]), 6))
        elif kind in (0, 1):
            colors.setdefault(name, [round(float(v), 6) for v in value])
        elif kind == 4:
            defaults[name] = ((p.get("m_DefTexture") or {}).get("m_DefaultName") or "white").lower()
    keywords = set(tree.get("m_ValidKeywords") or []) | set((tree.get("m_ShaderKeywords") or "").split())
    tex = {}
    for name, default in defaults.items():
        if name == "_MainTex":
            continue
        tex[name] = {**textures[name]} if name in textures else {"default": default}
    return {"program": program(shader), "shader": shader, **blend_state(form, floats),
            "straight": 1 if "_STRAIGHT_ALPHA_INPUT" in keywords else 0,
            "floats": floats, "colors": colors, "tex": tex}


def skeleton(atlas_materials: Iterable[tuple[str | None, dict]], blend_modes: Mapping[str, Any],
             replacement: Callable[[dict], tuple[str | None, dict] | None], scale: float = 0.01) -> dict:
    """The materials of one SkeletonDataAsset: atlas_materials are (page texture name, material) of its atlas assets'
    materials (material as above), blend_modes its blendModeMaterials typetree, replacement(pointer) a replacement
    material's (page texture name, material), or None for a null reference. {"pages": {page: material} (only the
    pages a ported program draws), "blend": {mode: {page: material or None}}, "scale": the data asset's scale}."""
    pages = {}
    for name, mat in atlas_materials:
        page = page_name(name)
        if page and mat.get("program") and page not in pages:
            pages[page] = mat
    blend: dict[str, dict[str, Any]] = {}
    if blend_modes.get("requiresBlendModeMaterials"):
        for mode, key in _BLEND_LISTS:
            if mode == "additive" and not blend_modes.get("applyAdditiveMaterial"):
                continue  # additive slots keep their page's material (and add through their vertex alpha 0)
            entries = blend_modes.get(key) or []
            if not entries:
                continue
            out = {}
            for entry in entries:
                found = replacement(entry.get("material") or {}) if (entry.get("material") or {}).get("m_PathID") else None
                out[page_name(entry.get("pageName")) or ""] = found[1] if found else None
            blend[mode] = out
    return {"pages": pages, "blend": blend, "scale": round(float(scale), 6)}


def layer(resolve: Callable[[str, int, dict], tuple[str, Any] | None] | None, sa_pid: int, sa: Mapping[str, Any]) -> dict:
    """What a lobby layer (lobby.read_prefab) carries for skeleton-materials.js: {"materials": {"pages", "blend",
    "scale", "tintBlack"}} from the SkeletonAnimation's data asset (scale: Unity units per skeleton unit, which the
    noise programs' centres are in); empty pages and blend when it cannot be read."""
    pointer = sa.get("skeletonDataAsset") or {}
    found = resolve("skeleton", sa_pid, pointer) if resolve is not None and pointer.get("m_PathID") else None
    data = found[1] if found else {}
    return {"materials": {"pages": dict(data.get("pages") or {}), "blend": dict(data.get("blend") or {}),
                          "scale": data.get("scale", 0.01), "tintBlack": bool(sa.get("tintBlack"))}}


def textures(layers: Iterable[Mapping[str, Any]]) -> dict[str, dict]:
    """The textures the layers' materials sample besides their pages (lobby.json fx.textures entries, served like the
    particles' own)."""
    out = {}
    for l in layers:
        mats = (l.get("materials") or {})
        found = list((mats.get("pages") or {}).values())
        for by_page in (mats.get("blend") or {}).values():
            found += [m for m in by_page.values() if m]
        for mat in found:
            for tex in (mat.get("tex") or {}).values():
                if "id" in tex:
                    out[tex["id"]] = dict(tex)
    return out
