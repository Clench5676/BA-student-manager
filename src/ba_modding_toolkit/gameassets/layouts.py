"""Export NGUI prefab trees using the prototype layout schema."""

from __future__ import annotations

import logging
import math

from UnityPy.environment import Environment
from UnityPy.files import ObjectReader

from .errors import AssetNotFound
from .unity import reference, ref_key

logger = logging.getLogger(__name__)

# The game's buttons (MXButton) carry no NGUI UIButtonColor colours, and no prefab has a UIButton or UIButtonColor:
# a disabled or locked button is a node of its own (its sprites tinted, often with a lock) that one of these
# controllers shows in place of the normal one. Exported as "states": each field's node, as a path relative to the
# controller's node ("" for the node itself; None when unset, in another file or outside the controller's node).
STATE_FIELDS = {
    "OpenConditionButtonController": ("Enable", "Disable", "Prohibited"),
    "UIButtonEnableSwitch": ("enableButton", "disableButton"),
    "MXDualStateButton": ("NormalButton", "DisabledButton"),
    "ButtonActivator": ("activeObject", "inactiveObject", "button", "contentsLockObject"),
}


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
        if tree.get("mApplyGradient"):
            widget["gradient"] = ["#%02x%02x%02x/%.2f" % (
                round(tree[key]["r"] * 255), round(tree[key]["g"] * 255),
                round(tree[key]["b"] * 255), tree[key]["a"])
                for key in ("mGradientTop", "mGradientBottom")]
    if "mTexture" in tree and "mWidth" in tree:
        pointer = tree["mTexture"]
        cab, pid = reference(obj, pointer)
        fallback = ("self" if not pointer["m_FileID"] else cab, pid)
        widget.update(cls=cls or "UITexture", texture=names.get(ref_key(cab, pid), str(fallback)))
    if "mText" in tree:
        widget.update(text=tree["mText"][:60], fontSize=tree.get("mFontSize"),
                      overflow=tree.get("mOverflow"), align=tree.get("mAlignment"),
                      spacingX=tree.get("mSpacingX"), effect=tree.get("mEffectStyle"))
        effect_color = tree.get("mEffectColor")
        if effect_color:
            widget["effectColor"] = "#%02x%02x%02x/%.2f" % (
                round(effect_color["r"] * 255), round(effect_color["g"] * 255),
                round(effect_color["b"] * 255), effect_color["a"])
        distance = tree.get("mEffectDistance")
        if distance:
            widget["effectDistance"] = [distance["x"], distance["y"]]
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


def export_layout(env: Environment, root: str, names: dict[str, str], *, effects: dict | None = None) -> dict:
    """Return a prefab root with ordered children and rounded widget transforms."""
    objects = list(env.objects)
    gos, transforms, scripts, components = {}, {}, {}, {}
    owners = {}  # path id of a GameObject, Transform or MonoBehaviour -> its GameObject's path id
    for obj in objects:
        if obj.type.name == "GameObject":
            gos[obj.path_id] = obj.read()
            owners[obj.path_id] = obj.path_id
        elif obj.type.name in ("Transform", "RectTransform"):
            transform = obj.read()
            transforms[transform.m_GameObject.path_id] = transform
            owners[obj.path_id] = transform.m_GameObject.path_id
        elif obj.type.name == "MonoScript":
            scripts[obj.path_id] = obj.read().m_ClassName
    controllers = []
    for obj in objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except (ValueError, TypeError):
            logger.debug("Cannot read prefab component %s", obj.path_id, exc_info=True)
            continue
        gid = tree.get("m_GameObject", {}).get("m_PathID")
        owners[obj.path_id] = gid
        widget = _widget(obj, tree, names, scripts)
        components.setdefault(gid, []).append(widget)
        if widget["cls"] in STATE_FIELDS:
            controllers.append((gid, widget, tree))
    parents = {gid: owners.get(transform.m_Father.path_id) for gid, transform in transforms.items()
               if transform.m_Father.path_id}

    def relative(base: int, pointer: dict) -> str | None:
        """The path from node `base` down to the node a pointer names, or None outside it or unset."""
        if pointer.get("m_FileID") or not pointer.get("m_PathID"):
            return None
        gid, parts = owners.get(pointer["m_PathID"]), []
        while gid in gos and gid != base:
            parts.append(gos[gid].m_Name)
            gid = parents.get(gid)
        return "/".join(reversed(parts)) if gid == base else None

    # References are resolved once every component is read: a controller may name a component read after it.
    for gid, widget, tree in controllers:
        widget["states"] = {field: relative(gid, tree.get(field) or {}) for field in STATE_FIELDS[widget["cls"]]}

    def node(gid: int) -> dict:
        game_object, transform = gos[gid], transforms[gid]
        q = transform.m_LocalRotation
        rotation = math.degrees(2 * math.atan2(q.z, q.w)) if abs(q.w) > 1e-6 or abs(q.z) > 1e-6 else 0
        result = {"name": game_object.m_Name, "active": bool(game_object.m_IsActive),
                  "pos": [round(transform.m_LocalPosition.x, 1), round(transform.m_LocalPosition.y, 1)],
                  "scale": [round(transform.m_LocalScale.x, 3), round(transform.m_LocalScale.y, 3)],
                  "rotZ": round(rotation, 2), "widgets": components.get(gid, [])}
        if effects and gid in effects:
            result["frameEffect"] = effects[gid]
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
