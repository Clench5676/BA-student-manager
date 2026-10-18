"""Export NGUI prefab trees using the prototype layout schema."""

from __future__ import annotations

import logging
import math

from UnityPy.environment import Environment
from UnityPy.files import ObjectReader

from .errors import AssetNotFound
from .unity import reference, ref_key

logger = logging.getLogger(__name__)


def _widget(obj: ObjectReader, tree: dict, names: dict[str, str], scripts: dict) -> dict:
    script = tree.get("m_Script", {})
    cls = scripts.get(script.get("m_PathID")) if not script.get("m_FileID") else None
    widget = {"cls": cls}
    if "mSpriteName" in tree:
        widget.update(cls=cls or "UISprite", sprite=tree["mSpriteName"],
                      atlas=names.get(ref_key(*reference(obj, tree["mAtlas"]))),
                      type=tree["mType"], flip=tree["mFlip"], incline=tree.get("inclineAngle"),
                      fillDir=tree.get("mFillDirection"), fill=tree.get("mFillAmount"),
                      fillCenter=tree.get("mFillCenter"))
    if "mTexture" in tree and "mWidth" in tree:
        pointer = tree["mTexture"]
        cab, pid = reference(obj, pointer)
        fallback = ("self" if not pointer["m_FileID"] else cab, pid)
        widget.update(cls=cls or "UITexture", texture=names.get(ref_key(cab, pid), str(fallback)))
    if "mText" in tree:
        widget.update(text=tree["mText"][:60], fontSize=tree.get("mFontSize"),
                      overflow=tree.get("mOverflow"), align=tree.get("mAlignment"),
                      spacingX=tree.get("mSpacingX"), effect=tree.get("mEffectStyle"))
    if "mWidth" in tree:
        color = tree.get("mColor")
        widget.update(w_=tree["mWidth"], h_=tree["mHeight"], pivot=tree.get("mPivot"),
                      depth=tree.get("mDepth"), color=("#%02x%02x%02x/%.2f" % (
                          round(color["r"] * 255), round(color["g"] * 255),
                          round(color["b"] * 255), color["a"]) if color else None))
        anchors = {key: [tree[key]["relative"], tree[key]["absolute"]]
                   for key in ("leftAnchor", "rightAnchor", "bottomAnchor", "topAnchor")
                   if tree.get(key, {}).get("target", {}).get("m_PathID")}
        if anchors:
            widget["anchors"] = anchors
    if cls in ("UIGrid", "UITable") or "cellWidth" in tree:
        widget.update({key: tree.get(key) for key in (
            "cellWidth", "cellHeight", "maxPerLine", "arrangement", "columns", "padding")})
    if cls is None and "mSpriteName" not in tree and "mTexture" not in tree:
        widget["keys"] = [key for key in tree if key not in (
            "m_GameObject", "m_Enabled", "m_Script", "m_Name")][:8]
    return widget


def export_layout(env: Environment, root: str, names: dict[str, str]) -> dict:
    """Return a prefab root with ordered children and rounded widget transforms."""
    objects = list(env.objects)
    gos, transforms, scripts, components = {}, {}, {}, {}
    for obj in objects:
        if obj.type.name == "GameObject":
            gos[obj.path_id] = obj.read()
        elif obj.type.name in ("Transform", "RectTransform"):
            transform = obj.read()
            transforms[transform.m_GameObject.path_id] = transform
        elif obj.type.name == "MonoScript":
            scripts[obj.path_id] = obj.read().m_ClassName
    for obj in objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except (ValueError, TypeError):
            logger.debug("Cannot read prefab component %s", obj.path_id, exc_info=True)
            continue
        gid = tree.get("m_GameObject", {}).get("m_PathID")
        components.setdefault(gid, []).append(_widget(obj, tree, names, scripts))

    def node(gid: int) -> dict:
        game_object, transform = gos[gid], transforms[gid]
        q = transform.m_LocalRotation
        rotation = math.degrees(2 * math.atan2(q.z, q.w)) if abs(q.w) > 1e-6 or abs(q.z) > 1e-6 else 0
        result = {"name": game_object.m_Name, "active": bool(game_object.m_IsActive),
                  "pos": [round(transform.m_LocalPosition.x, 1), round(transform.m_LocalPosition.y, 1)],
                  "scale": [round(transform.m_LocalScale.x, 3), round(transform.m_LocalScale.y, 3)],
                  "rotZ": round(rotation, 2), "widgets": components.get(gid, [])}
        children = [node(child.read().m_GameObject.path_id) for child in transform.m_Children]
        if children:
            result["children"] = children
        return result

    for gid, transform in transforms.items():
        if not transform.m_Father.path_id and gos[gid].m_Name == root:
            return node(gid)
    raise AssetNotFound(root)


def subtree(tree: dict, subpath: str) -> dict:
    """Select an exact, slash-separated child path relative to a prefab root."""
    for part in filter(None, subpath.split("/")):
        tree = next((child for child in tree.get("children", []) if child["name"] == part), None)
        if tree is None:
            raise AssetNotFound(subpath)
    return tree
