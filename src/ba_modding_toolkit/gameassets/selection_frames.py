"""Particle mesh data embedded in UIPopup_Mulligan's selected starting-skill cards."""

from . import particles

ROOT = "UIPopup_Mulligan"
SLOT = "Center/Popup/01/UIMulliganSlot"


def export_effects(env, resolve):
    """Return each selected frame's UV mesh, material and particle timing by GameObject id."""
    transforms, parents, names, components = {}, {}, {}, {}
    for obj in env.objects:
        if obj.type.name == "GameObject":
            names[obj.path_id] = obj.read().m_Name
        elif obj.type.name == "Transform":
            tree = obj.read_typetree()
            go = tree["m_GameObject"]["m_PathID"]
            transforms[obj.path_id] = go
            parents[go] = tree["m_Father"]["m_PathID"]
        elif obj.type.name in ("ParticleSystem", "ParticleSystemRenderer"):
            tree = obj.read_typetree()
            components.setdefault(tree["m_GameObject"]["m_PathID"], {})[obj.type.name] = (obj.path_id, tree)

    def path(go):
        parts = [names[go]]
        while parents.get(go) in transforms:
            go = transforms[parents[go]]
            parts.append(names[go])
        return "/".join(reversed(parts))

    result = {}
    for go, comps in components.items():
        location = path(go)
        if not (location.startswith(f"{ROOT}/{SLOT}/SelectLine") and location.endswith("/UV")):
            continue
        ps = comps.get("ParticleSystem")
        renderer = comps.get("ParticleSystemRenderer")
        if not ps or not renderer or not renderer[1].get("m_Enabled"):
            continue
        pid, tree = renderer
        material = resolve("material", pid, tree["m_Materials"][0])
        mesh = resolve("mesh", pid, tree["m_Mesh"])
        if not material or not mesh:
            continue
        # This NGUIClip shader uses the existing mask program; the list's scroll viewport supplies clipping.
        if material[1].get("shader") != "DSFX/FX_SHADER_AlphaBlend_Add_Mask_0_NGUIClip":
            continue
        result[go] = {"system": particles.system(ps[1], tree), "material": material[1], "mesh": mesh[1]}
    return result
