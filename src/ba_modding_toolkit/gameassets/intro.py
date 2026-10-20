"""A memorial lobby's intro: the Timeline its prefab's PlayableDirector plays when the lobby is entered.

Every lobby prefab has one PlayableDirector (on its Timeline GameObject) with InitialState Paused: the lobby plays it
when it is shown. Its TimelineAsset holds:

- SpineAnimationStateTracks (spine-unity's Timeline extension), bound to a SkeletonAnimation: the Start_Idle_*
  animations, then Idle_01, set on one AnimationState track as each clip starts;
- AnimationTracks bound to an Animator, each with a recorded (infinite) AnimationClip: the flash sprite's colour, the
  post-processing volumes' weights, GameObjects switched on and off, moving transforms, particle and renderer
  properties;
- ControlTracks: particle effects that play only during the intro (ParticleControlPlayable, ActivationControlPlayable);
- ActivationTracks, and PlayableTracks of the game's own clips: sounds (TimeLineAudioController), the lobby icons
  hidden and shown again (TimeLineUILobbyController), audio mixer snapshots (TimeLineAudioMixerSnapshotsController).

The director's wrap mode says what stays once it ends: None (every lobby but one) stops it, and Unity puts back what
its tracks changed; Hold (Shiroko) keeps the last frame.

A built AnimationClip keeps its curves in its muscle clip (m_MuscleClip.m_Clip): a streamed clip (cubic segments, one
key per curve and segment), a dense clip (frames at a sample rate) and a constant clip, in that order of curve index,
bound in order by m_ClipBindingConstant (a transform's position, scale and euler angles take three curves, its rotation
four, anything else one). A binding names its GameObject by the CRC-32 of its path below the Animator and its property
by the CRC-32 of the property path; a material property (custom type 22) by the low 28 bits of the CRC-32 of its name,
with its component (4 to 7: x / r to w / a) in the top 4 bits.

Plain typetrees in, plain data out: read_timeline() follows the timeline's pointers through a graph (tree(obj),
deref(obj, pointer); model.BundleGraph), build() places it in the prefab (lobby.read_prefab's walk).
"""

from __future__ import annotations

import math
import struct
import zlib
from collections.abc import Callable, Iterable, Mapping
from typing import Any

FLT_MAX = 3.4028234663852886e38
# DirectorWrapMode
WRAP_HOLD, WRAP_LOOP, WRAP_NONE = 0, 1, 2
# a transform binding's attribute: its curves
_TRANSFORM_ATTR = {1: ("position", 3), 2: ("rotation", 4), 3: ("scale", 3), 4: ("euler", 3)}
_MATERIAL = 22  # GenericBinding.customType of a renderer's material property
# ClassIDType of the bound component
TYPE_NAMES = {1: "GameObject", 4: "Transform", 23: "MeshRenderer", 114: "MonoBehaviour", 198: "ParticleSystem",
              199: "ParticleSystemRenderer", 212: "SpriteRenderer", 224: "RectTransform"}


def _r(value: float, digits: int = 5) -> float:
    v = round(float(value), digits) + 0.0
    return v if math.isfinite(v) else 0.0


def crc(text: str) -> int:
    return zlib.crc32(text.encode("utf-8")) & 0xFFFFFFFF


# --- curves --------------------------------------------------------------------------------------------------------

def streamed(data: Iterable[int], count: int) -> list[list[list[float]]]:
    """A StreamedClip's keys by curve: [time, a, b, c, d], the segment from time on being ((a x + b) x + c) x + d with x
    the time since the key (Unity stores each key with its segment's cubic). The stream is frames of (time, key count,
    keys of (curve index, a, b, c, d)) in 32-bit words; the first frame (at -FLT_MAX) holds every curve's value before
    its first key, the last one (at +FLT_MAX) none. A time beyond float range becomes -1e9 / 1e9."""
    words = list(data)
    buf = struct.pack(f"<{len(words)}I", *words)
    curves: list[list[list[float]]] = [[] for _ in range(count)]
    pos = 0
    while pos + 8 <= len(buf):
        time, n = struct.unpack_from("<fi", buf, pos)
        pos += 8
        if n < 0 or pos + 20 * n > len(buf):
            break
        t = -1e9 if time <= -FLT_MAX * 0.5 else 1e9 if time >= FLT_MAX * 0.5 else time
        for _ in range(n):
            index, a, b, c, d = struct.unpack_from("<i4f", buf, pos)
            pos += 20
            if 0 <= index < count:
                curves[index].append([t, a, b, c, d])
    return curves


def _streamed_curve(keys: list[list[float]]) -> dict:
    """One streamed curve as the player evaluates it ({"s": keys}); a curve that never changes is a constant."""
    if not keys:
        return {"k": 0.0}
    if all(k[1] == 0 and k[2] == 0 and k[3] == 0 for k in keys) and len({k[4] for k in keys}) == 1:
        return {"k": _r(keys[0][4], 6)}
    out = []
    for t, a, b, c, d in keys:
        # a key at -FLT_MAX is constant up to the first real key (its cubic is never used beyond that): any time
        # before the clip's start does
        out.append([_r(t, 6), _r(a, 6), _r(b, 6), _r(c, 6), _r(d, 6)])
    return {"s": out}


def evaluate(curve: Mapping[str, Any], t: float) -> float:
    """A curve at time t (seconds in the clip): a streamed curve's last key at or before t, a dense curve's frames
    lerped (clamped), a constant. As web/js/lobby-intro.js evaluates it."""
    if "k" in curve:
        return float(curve["k"])
    if "s" in curve:
        keys = curve["s"]
        key = keys[0]
        for k in keys:
            if k[0] <= t:
                key = k
            else:
                break
        x = max(0.0, t - key[0]) if key[0] > -1e8 else 0.0
        return ((key[1] * x + key[2]) * x + key[3]) * x + key[4]
    begin, rate, values = curve["d"]
    if not values:
        return 0.0
    f = min(max((t - begin) * rate, 0.0), len(values) - 1.0)
    i = int(math.floor(f))
    j = min(i + 1, len(values) - 1)
    return values[i] + (values[j] - values[i]) * (f - i)


def clip_curves(clip: Mapping[str, Any]) -> dict:
    """A built AnimationClip's bindings with their curves: {"length", "bindings": [{"path" (CRC-32 below the Animator),
    "type" (class id), "attr", "custom", "script" (the MonoScript pointer of a behaviour property), "pptr",
    "curves": [curve per component]}]}; object-reference (pptr) curves are left without curves."""
    mc = clip.get("m_MuscleClip") or {}
    data = (mc.get("m_Clip") or {}).get("data") or {}
    s = data.get("m_StreamedClip") or {}
    curves = [_streamed_curve(k) for k in streamed(s.get("data") or [], int(s.get("curveCount", 0)))]
    d = data.get("m_DenseClip") or {}
    n, frames = int(d.get("m_CurveCount", 0)), int(d.get("m_FrameCount", 0))
    samples = d.get("m_SampleArray") or []
    for i in range(n):
        values = [_r(samples[f * n + i], 6) for f in range(frames) if f * n + i < len(samples)]
        curves.append({"d": [_r(d.get("m_BeginTime", 0.0), 6), _r(d.get("m_SampleRate", 30.0), 6), values]})
    curves += [{"k": _r(v, 6)} for v in (data.get("m_ConstantClip") or {}).get("data") or []]
    out, index = [], 0
    for b in (clip.get("m_ClipBindingConstant") or {}).get("genericBindings") or []:
        tid = int(b.get("typeID", 0))
        attr = int(b.get("attribute", 0)) & 0xFFFFFFFF
        size = _TRANSFORM_ATTR.get(attr, (None, 1))[1] if tid == 4 else 1
        pptr = bool(b.get("isPPtrCurve"))
        entry = {"path": int(b.get("path", 0)) & 0xFFFFFFFF, "type": tid, "attr": attr,
                 "custom": int(b.get("customType", 0)), "script": b.get("script") or {}, "pptr": pptr}
        if not pptr:
            entry["curves"] = curves[index:index + size]
            index += size
        out.append(entry)
    length = float(mc.get("m_StopTime", 0.0)) - float(mc.get("m_StartTime", 0.0))
    return {"length": _r(max(0.0, length), 6), "bindings": out}


# --- reading the timeline ------------------------------------------------------------------------------------------

def _script(g: Any, obj: Any) -> str | None:
    try:
        script = g.deref(obj, g.tree(obj).get("m_Script"))
        return g.tree(script).get("m_ClassName") if script is not None else None
    except Exception:  # an unreadable script: an unknown class
        return None


def _timeline_clip(c: Mapping[str, Any]) -> dict:
    return {"start": _r(c.get("m_Start", 0.0), 6), "dur": _r(c.get("m_Duration", 0.0), 6),
            "clipIn": _r(c.get("m_ClipIn", 0.0), 6), "scale": _r(c.get("m_TimeScale", 1.0), 6),
            "easeIn": _r(c.get("m_EaseInDuration", 0.0), 6), "easeOut": _r(c.get("m_EaseOutDuration", 0.0), 6),
            "blendIn": _r(c.get("m_BlendInDuration", -1.0), 6), "blendOut": _r(c.get("m_BlendOutDuration", -1.0), 6),
            "pre": int(c.get("m_PreExtrapolationMode", 0)), "post": int(c.get("m_PostExtrapolationMode", 0)),
            "name": c.get("m_DisplayName") or ""}


def read_timeline(g: Any, timeline: Any, sound: Callable[[Any, dict], dict | None] | None = None) -> dict:
    """A TimelineAsset's tracks as plain data: {"name", "tracks": [{"pid", "class", "name", "muted", "depth", "clips":
    [clip timing and "asset"], "infinite" (clip_curves of a recorded clip), "trackIndex" (spine), "post" (activation
    tracks' PostPlaybackState)}]}, groups' children after their group. g: tree(obj), deref(obj, pointer).
    sound(owner, AudioData) turns a TimeLineAudioController's audio data into a sound event (lobby.sound_event)."""
    tt = g.tree(timeline)
    tracks: list[dict] = []

    def asset_of(owner: Any, cls: str | None, a: Any) -> dict:
        at = g.tree(a)
        out: dict[str, Any] = {"class": cls}
        if cls == "SpineAnimationStateClip":
            tpl = at.get("template") or {}
            # the reference is the game's SpineClip (an AnimationReferenceAsset): its animationName is empty and its
            # ClipName names the animation
            ref = g.deref(a, tpl.get("animationReference"))
            name = None
            if ref is not None:
                try:
                    rt = g.tree(ref)
                    name = rt.get("animationName") or rt.get("ClipName") or None
                except Exception:
                    name = None
            out.update(anim=name, loop=bool(tpl.get("loop")), customDuration=bool(tpl.get("customDuration")),
                       useBlendDuration=bool(tpl.get("useBlendDuration", 1)), mix=_r(tpl.get("mixDuration", 0.1), 6),
                       holdPrevious=bool(tpl.get("holdPrevious")), endWithClip=not tpl.get("dontEndWithClip"),
                       endMix=_r(tpl.get("endMixOutDuration", 0.1), 6), alpha=_r(tpl.get("alpha", 1.0), 6),
                       thresholds=[_r(tpl.get(k, 0.5), 4) for k in ("attachmentThreshold", "drawOrderThreshold",
                                                                    "eventThreshold")])
        elif cls == "ControlPlayableAsset":
            src = at.get("sourceGameObject") or {}
            out.update(exposed=str(src.get("exposedName", "")), default=(src.get("defaultValue") or {}).get("m_PathID", 0),
                       prefab=bool((at.get("prefabGameObject") or {}).get("m_PathID")),
                       particles=bool(at.get("updateParticle", 1)), seed=int(at.get("particleRandomSeed", 0)),
                       directors=bool(at.get("updateDirector", 1)), timeControl=bool(at.get("updateITimeControl", 1)),
                       hierarchy=bool(at.get("searchHierarchy", 0)), active=bool(at.get("active", 1)),
                       post=int(at.get("postPlayback", 2)))
        elif cls == "TimeLineAudioController":
            data = at.get("AudioData") or {}
            out.update(sound=sound(a, data) if sound else None, voice=at.get("VoiceId") or "",
                       manager=bool(at.get("PlaySoundManager")), loop=bool(data.get("Loop")),
                       delay=_r(data.get("Delay", 0.0), 6), syncEnd=bool(at.get("SyncEndTimeByClipLength")))
        elif cls == "TimeLineUILobbyController":
            out["icons"] = bool(at.get("IsShowLobbyIcons"))
        elif cls == "TimeLineAudioMixerSnapshotsController":
            out["defaultSnapshot"] = bool(at.get("DefaultSnapShot"))
        elif cls == "AnimationPlayableAsset":
            clip = g.deref(a, at.get("m_Clip"))
            out["clip"] = clip_curves(g.tree(clip)) if clip is not None else None
        return out

    def track(pointer: Mapping[str, Any], depth: int) -> None:
        tr = g.deref(timeline, pointer)
        if tr is None:
            return
        t = g.tree(tr)
        cls = _script(g, tr)
        item: dict[str, Any] = {"pid": tr.path_id, "class": cls, "name": t.get("m_Name") or "",
                                "muted": bool(t.get("m_Muted")), "depth": depth, "clips": []}
        if "trackIndex" in t:
            item["trackIndex"] = int(t.get("trackIndex", 0))
        if "m_PostPlaybackState" in t:
            item["post"] = int(t.get("m_PostPlaybackState", 3))
        for c in t.get("m_Clips") or []:
            entry = _timeline_clip(c)
            a = g.deref(tr, c.get("m_Asset"))
            entry["asset"] = asset_of(tr, _script(g, a), a) if a is not None else {"class": None}
            item["clips"].append(entry)
        infinite = g.deref(tr, t.get("m_InfiniteClip"))
        if infinite is not None:
            item["infinite"] = clip_curves(g.tree(infinite))
            item["pre"] = int(t.get("m_InfiniteClipPreExtrapolation", 1))
            item["post"] = int(t.get("m_InfiniteClipPostExtrapolation", 1))
            item["loop"] = bool(t.get("mInfiniteClipLoop"))
        tracks.append(item)
        for child in t.get("m_Children") or []:
            track(child, depth + 1)

    for pointer in tt.get("m_Tracks") or []:
        track(pointer, 0)
    return {"name": tt.get("m_Name") or "", "durationMode": int(tt.get("m_DurationMode", 0)),
            "fixedDuration": _r(tt.get("m_FixedDuration", 0.0), 6), "tracks": tracks}


def duration(raw: Mapping[str, Any]) -> float:
    """The timeline's duration (TimelineAsset.duration): fixed, or (BasedOnClips) the end of its last clip, a recorded
    clip counting its length; muted tracks count too."""
    if raw.get("durationMode") == 1:
        return float(raw.get("fixedDuration", 0.0))
    end = 0.0
    for t in raw.get("tracks", []):
        for c in t.get("clips", []):
            end = max(end, c["start"] + c["dur"])
        if t.get("infinite"):
            end = max(end, t["infinite"]["length"])
    return _r(end, 6)


# --- placing it in the prefab ----------------------------------------------------------------------------------------

# a ParticleSystem property the timeline animates (custom type 27) as the player overrides it: [what, component]
_PS_PROPS = {"InitialModule.startColor.maxColor.r": ("startColor", 0), "InitialModule.startColor.maxColor.g": ("startColor", 1),
             "InitialModule.startColor.maxColor.b": ("startColor", 2), "InitialModule.startColor.maxColor.a": ("startColor", 3),
             "simulationSpeed": ("speed", 0)}
_COLOR = {"m_Color.r": 0, "m_Color.g": 1, "m_Color.b": 2, "m_Color.a": 3}
# the colour properties a renderer's material binding can name (those of the lobbies' sprite, particle and quad shaders)
MATERIAL_NAMES = ("_Color", "_TintColor", "_Color0", "_BaseColor", "_MainColor", "_EmissionColor")


def material_attribute(attr: int, names: Iterable[str] = MATERIAL_NAMES) -> tuple[str, int] | None:
    """A material binding's property and component: the low 28 bits are those of the property name's CRC-32, the top
    4 bits 4 + its component (x / r to w / a); a float property (other top bits) has component -1."""
    low, top = attr & 0x0FFFFFFF, attr >> 28
    for name in names:
        if crc(name) & 0x0FFFFFFF == low:
            return name, top - 4 if 4 <= top <= 7 else -1
    return None


def chain(n: dict, by_go: Mapping[int, dict]) -> list[dict]:
    """A node and its ancestors, the node first."""
    out = []
    while n is not None:
        out.append(n)
        n = by_go.get(n["parent"])
    return out


def kept(n: dict, by_go: Mapping[int, dict], gates: Iterable[int]) -> bool:
    """Whether a node can be active at some point of the intro or after it: active at rest, or every GameObject that
    keeps it off at rest (inactive itself) is one the intro switches on."""
    gates = set(gates)
    return all(x["own"] or x["go"] in gates for x in chain(n, by_go))


class Plan:
    """What a lobby's intro changes in its prefab: the GameObjects it switches or moves, the components whose properties
    it animates, its control and activation clips, the Spine tracks it drives and its sounds, by the prefab's path ids
    (build() turns them into the player's indices). raw: read_timeline; director: the PlayableDirector's typetree;
    nodes: lobby.read_prefab's walk (go, name, parent, own, all: [(class, path id, tree)])."""

    def __init__(self, raw: Mapping[str, Any], director: Mapping[str, Any], nodes: list[dict], kinds: Mapping[int, str]):
        self.raw, self.nodes = raw, nodes
        self.duration = duration(raw)
        self.wrap = {WRAP_HOLD: "hold", WRAP_LOOP: "loop"}.get(int(director.get("m_WrapMode", WRAP_NONE)), "none")
        self.by_go = {n["go"]: n for n in nodes}
        self.by_comp = {pid: n for n in nodes for _, pid, _ in n["all"]}
        self.children: dict[int, list[dict]] = {}
        for n in nodes:
            self.children.setdefault(n["parent"], []).append(n)
        # the tracks' bindings (the timeline's file, by path id) and the control clips' exposed GameObjects
        file_id = (director.get("m_PlayableAsset") or {}).get("m_FileID", 0)
        binds = {(b.get("key") or {}).get("m_PathID"): (b.get("value") or {}).get("m_PathID", 0)
                 for b in director.get("m_SceneBindings") or [] if (b.get("key") or {}).get("m_FileID", 0) == file_id}
        exposed = {str(k): (v or {}).get("m_PathID", 0)
                   for k, v in (director.get("m_ExposedReferences") or {}).get("m_References", [])}
        self.spine: list[dict] = []        # {"sa": SkeletonAnimation path id, "track", "clips"}
        self.props: list[dict] = []        # {"target": ("go" | "comp", path id), "kind", "attr", "k", "c"}
        self.control: list[dict] = []      # {"go", "t", "d", "in", "particles"}
        self.activation: list[dict] = []   # {"go", "clips": [[t, d]], "post"}
        self.sounds: list[dict] = []       # {"t", "sound": event or None}
        self.icons: list[list[Any]] = []   # [time, shown]
        self.gates: set[int] = set()       # GameObjects whose own activity the intro sets
        self.moved: set[int] = set()       # GameObjects whose transform it animates
        self.skipped: dict[str, int] = {}  # what it does that the player leaves out, counted
        for t in raw.get("tracks", []):
            if t.get("muted"):
                continue
            cls, bound = t.get("class"), binds.get(t["pid"], 0)
            if cls == "SpineAnimationStateTrack":
                if bound and kinds.get(bound) == "MonoBehaviour":
                    self.spine.append({"sa": bound, "track": t.get("trackIndex", 0), "clips": t.get("clips", [])})
            elif cls == "AnimationTrack":
                root = self.by_comp.get(bound) if bound else None
                if root is not None and t.get("infinite"):
                    self._animate(root, t["infinite"]["bindings"])
                if any((c.get("asset") or {}).get("class") == "AnimationPlayableAsset" for c in t.get("clips", [])):
                    self._skip("animation clips")
            elif cls == "ControlTrack":
                for c in t.get("clips", []):
                    a = c.get("asset") or {}
                    go = exposed.get(a.get("exposed", "")) or a.get("default") or 0
                    if go not in self.by_go or a.get("prefab"):
                        self._skip("control prefab" if a.get("prefab") else "control without target")
                        continue
                    if not a.get("active"):
                        self._skip("control without activation")
                        continue
                    self.control.append({"go": go, "t": c["start"], "d": c["dur"], "in": c["clipIn"],
                                         "particles": bool(a.get("particles"))})
                    self.gates.add(go)
            elif cls == "ActivationTrack":
                n = self.by_go.get(bound) or self.by_comp.get(bound)
                if n is not None:
                    self.activation.append({"go": n["go"], "clips": [[c["start"], c["dur"]] for c in t.get("clips", [])],
                                            "post": t.get("post", 3)})
                    self.gates.add(n["go"])
            elif cls == "PlayableTrack":
                for c in t.get("clips", []):
                    a = c.get("asset") or {}
                    if a.get("class") == "TimeLineAudioController":
                        if a.get("voice"):
                            self._skip("voice")
                        else:
                            self.sounds.append({"t": c["start"], "sound": a.get("sound")})
                    elif a.get("class") == "TimeLineUILobbyController":
                        self.icons.append([c["start"], bool(a.get("icons"))])
                    elif a.get("class") == "TimeLineAudioMixerSnapshotsController":
                        self._skip("mixer snapshot")

    def _skip(self, what: str) -> None:
        self.skipped[what] = self.skipped.get(what, 0) + 1

    def touches(self, n: dict, pid: int) -> bool:
        """Whether the intro changes a component (pid, on node n): one of its properties, or the activity of its chain."""
        return any(p["target"] == ("comp", pid) for p in self.props) or any(x["go"] in self.gates
                                                                             for x in chain(n, self.by_go))

    def _animate(self, root: dict, bindings: list[dict]) -> None:
        """A recorded clip's bindings below the Animator's GameObject (root), found by their path CRC."""
        below: dict[int, dict] = {}
        stack = [(root, "")]
        while stack:
            n, path = stack.pop()
            below.setdefault(crc(path), n)
            stack += [(c, f"{path}/{c['name']}" if path else c["name"]) for c in self.children.get(n["go"], [])]
        for b in bindings:
            n = below.get(b["path"])
            if n is None or b.get("pptr"):
                self._skip("unbound" if n is None else "object curves")
                continue
            curves, tid, attr = b.get("curves") or [], b["type"], b["attr"]
            if tid == 1:
                if attr != crc("m_IsActive") or not curves:
                    self._skip("GameObject property")
                    continue
                self.props.append({"target": ("go", n["go"]), "kind": "active", "attr": "active", "k": 0, "c": curves[0]})
                self.gates.add(n["go"])
            elif tid == 4:
                name = _TRANSFORM_ATTR.get(attr, (None, 0))[0]
                if name is None:
                    self._skip("transform property")
                    continue
                for k, c in enumerate(curves):
                    self.props.append({"target": ("go", n["go"]), "kind": "transform", "attr": name, "k": k, "c": c})
                self.moved.add(n["go"])
            else:
                kind = TYPE_NAMES.get(tid)
                comp = next(((pid, t) for cls, pid, t in n["all"]
                             if (("sharedProfile" in t) if kind == "MonoBehaviour" else cls == kind)), None)
                prop = self._property(kind, attr, b.get("custom", 0)) if comp and curves else None
                if prop is None:
                    self._skip(f"{kind or tid} property")
                    continue
                self.props.append({"target": ("comp", comp[0]), **prop, "c": curves[0]})

    @staticmethod
    def _property(kind: str | None, attr: int, custom: int) -> dict | None:
        if kind == "MonoBehaviour":  # a URP Volume
            name = {crc("weight"): "weight", crc("m_Enabled"): "enabled"}.get(attr)
            return {"kind": "volume", "attr": name, "k": 0} if name else None
        if kind == "SpriteRenderer" and custom != _MATERIAL:
            k = next((k for name, k in _COLOR.items() if attr == crc(name)), None)
            return {"kind": "sprite", "attr": "color", "k": k} if k is not None else None
        if kind == "ParticleSystem":
            found = next((v for name, v in _PS_PROPS.items() if attr == crc(name)), None)
            return {"kind": "ps", "attr": found[0], "k": found[1]} if found else None
        if custom == _MATERIAL and kind in ("SpriteRenderer", "ParticleSystemRenderer", "MeshRenderer"):
            found = material_attribute(attr)
            if found is None or found[1] < 0:
                return None
            return {"kind": {"SpriteRenderer": "sprite", "ParticleSystemRenderer": "psr"}.get(kind, "mesh"),
                    "attr": "material", "name": found[0], "k": found[1]}
        return None


def _rounded(m: Iterable[float]) -> list[float]:
    return [_r(v, 6) for v in m]


def _identity() -> list[float]:
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def _mul(a: list[float], b: list[float]) -> list[float]:
    out = []
    for i in range(3):
        row = a[i * 4:i * 4 + 4]
        for j in range(4):
            v = row[0] * b[j] + row[1] * b[4 + j] + row[2] * b[8 + j]
            out.append(v + (row[3] if j == 3 else 0.0))
    return out


def moves(n: dict, by_go: Mapping[int, dict], moved: Mapping[int, int], stop: int | None = None) -> dict | None:
    """How a drawable's matrix follows the transforms the intro animates on its chain (below the GameObject `stop`,
    the anchor bone's, when it hangs on a bone; else from the prefab root): {"m": [M0 .. Mk], "nodes": [i1 .. ik]} for
    M0 L(i1) M1 L(i2) ... L(ik) Mk, L the animated node's local matrix this frame and the M's fixed (3 x 4, row-major).
    moved: animated GameObject -> its index in the intro's nodes. None when nothing on the chain moves."""
    path = []
    for x in chain(n, by_go):
        if stop is not None and x["go"] == stop:
            break
        path.append(x)
    path.reverse()
    if not any(x["go"] in moved for x in path):
        return None
    mats, nodes, cur = [], [], None
    first = path[0]
    # from the prefab root: the world matrix above the chain's top (its parent's), else identity below the bone
    cur = list(by_go[first["parent"]]["m3"]) if stop is None and first["parent"] in by_go else _identity()
    for x in path:
        if x["go"] in moved:
            mats.append(_rounded(cur))
            nodes.append(moved[x["go"]])
            cur = _identity()
        else:
            cur = _mul(cur, x["local3"])
    mats.append(_rounded(cur))
    return {"m": mats, "nodes": nodes}


def _trs(t: Mapping[str, Any]) -> list[float]:
    """A transform's rest local position, rotation (quaternion) and scale, [px py pz qx qy qz qw sx sy sz]."""
    p, q, s = t["m_LocalPosition"], t["m_LocalRotation"], t["m_LocalScale"]
    return [_r(v, 6) for v in (p.get("x", 0.0), p.get("y", 0.0), p.get("z", 0.0), q.get("x", 0.0), q.get("y", 0.0),
                               q.get("z", 0.0), q.get("w", 1.0), s.get("x", 1.0), s.get("y", 1.0), s.get("z", 1.0))]


def bone_go(n: dict, by_go: Mapping[int, dict]) -> int | None:
    """The GameObject of the SkeletonUtilityBone a node hangs on (the nearest on its chain), as particles.build anchors
    a system."""
    return next((x["go"] for x in chain(n, by_go) if "SkeletonUtilityBone" in x["first"]), None)


# the volume components the player blends (web/js/lobby-intro.js), with the parameters it reads
VOLUME_PARAMS = {
    "ChromaticAberration": ("intensity",),
    "LiftGammaGain": ("lift", "gamma", "gain"),
    "PaniniProjection": ("distance", "cropToFit"),
    "ColorAdjustments": ("postExposure", "contrast", "colorFilter", "hueShift", "saturation"),
    "DepthOfField": ("mode", "gaussianStart", "gaussianEnd", "gaussianMaxRadius", "highQualitySampling",
                     "focusDistance", "aperture", "focalLength"),
}


def volume_components(components: Iterable[Mapping[str, Any]]) -> list[dict]:
    """A volume profile's components as the player blends them: [{"name", "active", "params": {overridden: value}}],
    values as lobby.py reads them (a colour or vector as a list)."""
    out = []
    for comp in components or []:
        name = comp.get("m_Name", "")
        keys = VOLUME_PARAMS.get(name)
        if keys is None:
            continue
        params = {}
        for key in keys:
            field = comp.get(key)
            if isinstance(field, Mapping) and field.get("m_OverrideState") and "m_Value" in field:
                raw = field["m_Value"]
                if isinstance(raw, Mapping):
                    params[key] = [_r(raw.get(k, 0.0), 6) for k in (("r", "g", "b", "a") if "r" in raw else ("x", "y", "z", "w"))]
                else:
                    params[key] = _r(raw, 6)
        out.append({"name": name, "active": bool(comp.get("active", 1)), "params": params})
    return out


def sprite(n: dict, renderer_pid: int, renderer: Mapping[str, Any], resolve: Callable[[str, int, dict], Any] | None,
           by_go: Mapping[int, dict], skeleton_of_go: Callable[[int], str | None],
           data_scale: Callable[[str], float]) -> tuple[dict, dict, dict] | None:
    """A SpriteRenderer as a drawable of the effects player: its quad (the sprite's rect around its pivot, in the
    GameObject's units), UVs, colour, material (the renderer's, the sprite's texture as _MainTex, as the renderer's
    property block sets it) and place; and its material and texture for the fx tables. None without a sprite, a
    material or a ported shader. Simple draw mode only (every lobby's)."""
    if resolve is None or not renderer.get("m_Enabled", 1):
        return None
    mats = renderer.get("m_Materials") or []
    found_mat = resolve("material", renderer_pid, mats[0]) if mats and mats[0].get("m_PathID") else None
    found_sprite = resolve("sprite", renderer_pid, renderer.get("m_Sprite") or {}) if (
        renderer.get("m_Sprite") or {}).get("m_PathID") else None
    if not found_mat or not found_sprite or not found_mat[1].get("program") or not found_sprite[1]:
        return None
    mat_id, mat = found_mat
    _, sp = found_sprite
    tex = sp["tex"]
    mat = {**mat, "tex": {**mat.get("tex", {}), "_MainTex": {**tex, "st": [1.0, 1.0, 0.0, 0.0]}}}
    material_id = f"{mat_id}~{tex['id']}"
    w, h = sp["size"]
    px, py = sp["pivot"]
    x, y, rw, rh = sp["rect"]
    tw, th = max(1, tex.get("w") or 1), max(1, tex.get("h") or 1)
    c = renderer.get("m_Color") or {}
    item = {"name": n["name"], "path": n["path"], "material": material_id, "queue": mat.get("queue", 3000),
            "order": int(renderer.get("m_SortingOrder", 0)), "layer": int(renderer.get("m_SortingLayerID", 0)),
            "z": _r(n["m3"][11], 6), "color": [_r(c.get(k, 1.0), 6) for k in "rgba"],
            "quad": [_r(-px * w, 6), _r(-py * h, 6), _r((1 - px) * w, 6), _r((1 - py) * h, 6)],
            "uv": [_r(x / tw, 6), _r(y / th, 6), _r((x + rw) / tw, 6), _r((y + rh) / th, 6)],
            "flip": [1 if renderer.get("m_FlipX") else 0, 1 if renderer.get("m_FlipY") else 0],
            "static": _rounded(n["m3"]), "anchor": None, "_node": n, "_renderer": renderer_pid}
    bone = bone_go(n, by_go)
    if bone is not None:
        utility = by_go[bone]["first"]["SkeletonUtilityBone"]
        skel = by_go.get(bone)
        while skel is not None and "SkeletonAnimation" not in skel["first"]:
            skel = by_go.get(skel["parent"])
        name = skeleton_of_go(skel["go"]) if skel else None
        if name and utility.get("mode", 0) == 0:
            rel = _identity()
            for x in reversed(chain(n, by_go)[:[x["go"] for x in chain(n, by_go)].index(bone)]):
                rel = _mul(rel, x["local3"])
            item.update(anchor={"skeleton": name, "bone": utility.get("boneName") or by_go[bone]["name"],
                                "go": _rounded(skel["m3"]), "ds": _r(data_scale(name), 6)}, rel=_rounded(rel),
                        _anchor_go=bone)
    return item, {material_id: mat}, {tex["id"]: {k: v for k, v in tex.items() if k != "st"}}


def _custom_mix(c: Mapping[str, Any]) -> float | None:
    """The mix a Spine clip starts with (SpineAnimationStateMixerBehaviour.GetCustomMixDuration): with a custom
    duration the timeline clip's blend-in or ease-in (useBlendDuration) or the clip's own; else the skeleton's default
    (None)."""
    a = c["asset"]
    if not a.get("customDuration"):
        return None
    return _r(max(c.get("blendIn", -1.0), c.get("easeIn", 0.0), 0.0) if a.get("useBlendDuration") else a.get("mix", 0.0), 6)


def build(plan: Plan, *, layers: list[dict], layer_nodes: Mapping[str, dict], skeleton_of_sa: Mapping[int, str],
          volumes: list[dict], fx: dict, sprites: list[dict]) -> dict:
    """The intro as the player plays it (web/js/lobby-intro.js), and its marks on the lobby's other data:
    - nodes: [{"path", "own", "trs" (moved ones)}], the GameObjects it switches or moves;
    - spine: [{"skeleton", "track", "clips": [{"t", "d", "in", "speed", "anim", "loop", "mix", "endMix", "end",
      "hold", "alpha"}]}];
    - props: [{"on": "node" | "volume" | "system" | "sprite", "i", "attr", "k", ("name"), "c"}], one per curve;
    - control: [{"node", "t", "d", "in", "particles"}], activation: [{"node", "clips", "post"}];
    - sounds: [{"t", "id"}], icons: [[t, shown]], volumes (when it changes any): [{"gate", "base", "weight",
      "priority", "global", "enabled", "layer", "components"}];
    and on the layers, the fx systems and fx sprites it can switch: "gate" (its nodes on the drawable's chain), "base"
    (whether the rest of the chain is active), "rest" 0 for those off at rest, "moves" for those it moves.
    layer_nodes: skeleton -> its SkeletonAnimation's node; volumes: lobby.read_prefab's (with "_node"); fx: particles
    build's (systems with "_go"); sprites: sprite drawables with "_node"."""
    gates, moved = set(plan.gates), set(plan.moved)
    order = [n["go"] for n in plan.nodes if n["go"] in gates or n["go"] in moved]
    index = {go: i for i, go in enumerate(order)}
    nodes_out = []
    for go in order:
        n = plan.by_go[go]
        entry = {"path": n["path"], "own": bool(n["own"])}
        if go in moved:
            entry["trs"] = _trs(n["t"])
        nodes_out.append(entry)
    moved_index = {go: index[go] for go in moved}

    def mark(item: dict, n: dict, anchor_go: int | None = None) -> None:
        ch = chain(n, plan.by_go)
        gate = [index[x["go"]] for x in ch if x["go"] in gates]
        if gate:
            item["gate"] = gate
            item["base"] = all(x["own"] for x in ch if x["go"] not in gates)
            if not n["active"]:
                item["rest"] = 0
        mv = moves(n, plan.by_go, moved_index, anchor_go)
        if mv:
            item["moves"] = {**mv, "of": "rel" if anchor_go is not None else "static"}

    # the drawables: skeletons, particle systems, sprites
    for layer in layers:
        n = layer_nodes.get(layer["name"])
        if n is not None:
            mark(layer, n)
    bound = {skeleton_of_sa.get(s["sa"]) for s in plan.spine}
    for layer in layers:
        if not layer["active"] and (layer.get("gate") or layer["name"] in bound) and kept(layer_nodes[layer["name"]], plan.by_go, gates):
            layer["intro"] = True
    system_index = {}
    for i, s in enumerate(fx.get("systems", [])):
        n = plan.by_go.get(s.get("_go"))
        if n is None:
            continue
        system_index.setdefault(n["go"], []).append(i)
        mark(s, n, bone_go(n, plan.by_go) if s.get("anchor") else None)
    sprite_index = {}
    for i, sp in enumerate(sprites):
        n = sp.pop("_node")
        sprite_index[sp.pop("_renderer")] = i
        mark(sp, n, sp.pop("_anchor_go", None))
    volume_index = {v["_pid"]: i for i, v in enumerate(volumes)}
    by_comp_go = {pid: n["go"] for pid, n in plan.by_comp.items()}

    def base(material_id: str | None, name: str) -> list[float]:
        # an animated material colour's other components stay the material's own
        return list((fx.get("materials", {}).get(material_id) or {}).get("colors", {}).get(name) or [1.0, 1.0, 1.0, 1.0])

    props, touches_volumes = [], False
    for p in plan.props:
        what, pid = p["target"]
        entry = {k: v for k, v in p.items() if k in ("attr", "k", "name", "c")}
        if what == "go":
            entry.update(on="node", i=index[pid])
        elif p["kind"] == "volume" and pid in volume_index:
            entry.update(on="volume", i=volume_index[pid])
            touches_volumes = True
        elif p["kind"] in ("ps", "psr"):
            go = by_comp_go.get(pid)
            for i in system_index.get(go, []):
                extra = {"base": base(fx["systems"][i].get("material"), p["name"])} if p["attr"] == "material" else {}
                props.append({**entry, **extra, "on": "system", "i": i})
            continue
        elif p["kind"] == "sprite" and pid in sprite_index:
            entry.update(on="sprite", i=sprite_index[pid])
            if p["attr"] == "material":
                entry["base"] = base(sprites[sprite_index[pid]]["material"], p["name"])
        else:
            continue
        props.append(entry)

    spine = []
    for s in plan.spine:
        name = skeleton_of_sa.get(s["sa"])
        if name is None:
            continue
        clips = []
        for c in sorted(s["clips"], key=lambda c: c["start"]):
            a = c.get("asset") or {}
            if a.get("class") != "SpineAnimationStateClip":
                continue
            clips.append({"t": c["start"], "d": c["dur"], "in": c["clipIn"], "speed": c["scale"], "anim": a.get("anim"),
                          "loop": a.get("loop", False), "mix": _custom_mix(c), "endMix": a.get("endMix", 0.1),
                          "end": a.get("endWithClip", True), "hold": a.get("holdPrevious", False),
                          "alpha": a.get("alpha", 1.0)})
        spine.append({"skeleton": name, "track": s["track"], "clips": clips})

    out: dict[str, Any] = {
        "duration": plan.duration, "wrap": plan.wrap, "nodes": nodes_out, "spine": spine, "props": props,
        "control": [{"node": index[c["go"]], "t": c["t"], "d": c["d"], "in": c["in"], "particles": c["particles"]}
                    for c in plan.control],
        "activation": [{"node": index[a["go"]], "clips": a["clips"], "post": a["post"]} for a in plan.activation],
        "sounds": [{"t": s["t"], "id": s["sound"]["id"]} for s in plan.sounds if s.get("sound")],
        "icons": sorted(plan.icons),
        # the sounds' events, which lobby.lobby_info adds to the lobby's sound events
        "events": {s["sound"]["id"]: {k: v for k, v in s["sound"].items() if k != "id"} for s in plan.sounds
                   if s.get("sound")},
    }
    # the idle's start on the character's track: when the intro has handed over (informative, for checks)
    idle = [c["t"] for s in spine for c in s["clips"] if (c["anim"] or "").lower().startswith("idle")]
    out["idle"] = min(idle) if idle else None
    gated_volumes = False
    for v in volumes:
        n = v["_node"]
        item = {"weight": _r(v["weight"], 6), "priority": _r(v["priority"], 6), "global": v["global"],
                "enabled": v["enabled"], "active": bool(n["active"]), "layer": v["layer_ok"],
                "components": volume_components(v.get("components") or [])}
        mark(item, n)
        gated_volumes = gated_volumes or "gate" in item
        v["_out"] = item
    if touches_volumes or gated_volumes:
        out["volumes"] = [v.pop("_out") for v in volumes]
    for v in volumes:
        v.pop("_out", None)
    if plan.skipped:
        out["skipped"] = dict(sorted(plan.skipped.items()))
    return out
