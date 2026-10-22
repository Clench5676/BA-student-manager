// 3D chibi for the detail screen's third tab. The GLB is exported from the user's game files in memory
// (gameassets/model.py): the game's material constants are in the material extras, the halo follower (FxFollower)
// in the root extras, and each clip's slot, loop flag, SetMouthTile events and renderer switches in the animation
// extras. The materials are ports of the game's character shaders (chibi-materials.js), the camera starts at the
// formation screen's view of one character (FORMATION_VIEW) and orbits freely; the wheel, pinches and swipes are read
// as the fullscreen lobby reads them (attachInput). One view at a time; hide() frees its WebGL context at once.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { chibiMaterial, disposeDefaults, outlineMaterial, setOutlineScale } from "./chibi-materials.js";
import { wheelKind, wheelStep } from "./lobby-touch.js";
import { modelUrl } from "./switch-sources.js";

const ease = (t) => 1 - Math.pow(1 - t, 3);
const clamp = THREE.MathUtils.clamp;

const ZOOM_TAU = 0.08;   // s: a zoom or pan eases to its goal, as in the lobby
const NOTCH = 100;       // px: a wheel notch zooms at least as far as one of Chromium's (a slow notch on macOS is 4 px)
const NOTCHES = 5;       // notches from the front view to the bust
const PINCH = 1.5;       // a pinch zooms half as far again as the fingers spread: one pinch from the front view to the bust
const CTRL_PINCH = 0.01; // Chromium's pinch as ctrl + wheel: the fingers' scale is exp(-deltaY / 100)
const SCROLL_MS = 120;   // wheel events this close together belong to one scroll
const PINCH_HOLD = 300;  // ms: WebKit's ctrl + wheel events beside its gesture events are left to the gesture

// The formation screen's view of one character (UIFormation under GameMain's camera): the game camera (vertical
// field of view 10, at the origin, level) shows the NGUI root 11.43 ahead, 2 units high (2 / 1665 of a unit per NGUI
// unit at 16:9), and each character at its slot (UnitPositions/Position1-4): 630 NGUI units to the character's unit,
// 316.4 toward the camera and 222.6 below Position_Set, whose anchors put it 56.25 below the screen's centre. In the
// character's units the camera stands 14.6 away and 0.44 above its feet, looking level: the screen's centre lies at
// that height, and a character takes the same share of the screen's height whatever its size.
export const FORMATION_VIEW = (() => {
  const s = 2 / 1665, k = 630 * s;
  return { fov: 10, distance: (11.43 - 316.4 * s) / k, eye: ((222.6 + 56.25) * s) / k };
})();

// where the formation view's centre (the point 0.44 above the feet) lands on the host, in stage pixels, for a host of
// w x h: beside the panel the feet stay above the nameplate (floor); fullscreen it is the formation screen's centre.
// Pixels, not fractions, so the chibi does not jump when the host widens for fullscreen.
const FRAMES = { left: { x: 490, y: 500, w: 1000, h: 1080, floor: 700 }, full: { x: 960, y: 540, w: 1920, h: 1080, floor: 1056 },
  still: { x: 320, y: 320, w: 640, h: 640, floor: 616 } };
const TWEEN = 450;

// The camera distance (character units) for a frame: the formation screen's, or further back where the chibi's box
// (halo and props included; relative to the orbit target, x across and y up) would leave the host around the frame
// point (stage px, a margin kept) or reach below its floor.
export function frameDistance(box, frame, fov = FORMATION_VIEW.fov, base = FORMATION_VIEW.distance, margin = 24) {
  const t = 2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2); // the visible height per unit of distance
  const at = (units, px) => (units > 0 ? (units * frame.h) / (t * Math.max(px, 1)) : 0); // `units` over `px`
  const side = Math.min(frame.x, frame.w - frame.x) - margin;
  return Math.max(base, at(box.max.y, frame.y - margin), at(-box.min.y, Math.min(frame.floor, frame.h - margin) - frame.y),
    at(Math.max(box.max.x, -box.min.x), side));
}

// The closest camera distance for a frame: the bust. Closing in lifts the orbit target to the face (`face`: its
// height above the target), which then lies on the frame point; the bust is where the box's top (the halo) reaches
// the host's top edge, a margin kept. Between a tenth and 0.45 of the frame's distance (`fit`), so a box whose top
// lies at or below the face still closes in.
export function bustDistance(box, face, frame, fit, fov = FORMATION_VIEW.fov, margin = 24) {
  const t = 2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const d = ((box.max.y - face) * frame.h) / (t * Math.max(frame.y - margin, 1));
  return THREE.MathUtils.clamp(d, fit * 0.1, fit * 0.45);
}

// The zoom's place between the fit (0) and the bust (1) of a zoom range {fit, min}, in the zoom's own steps (a notch
// or a pinch multiplies the distance); below 0 further back than the fit.
export function zoomShare(distance, { fit, min }) {
  return fit > min && distance > 0 ? Math.log(fit / distance) / Math.log(fit / min) : 0;
}

// How far the orbit target has risen to the face (0 at the fit and further back, 1 at the bust): the face comes to the
// frame point evenly, a notch or a pinch at a time, so closing in zooms towards the face instead of first dropping the
// chibi (an eased lift by distance did two thirds of it in the first fifth of the zoom).
export function liftShare(distance, range) {
  const s = clamp(zoomShare(distance, range), 0, 1);
  return clamp(1 - ((1 - s) * distance) / range.fit, 0, 1);
}

// A distance carried over to another framing: closer than the fit, as the same share of the way to the bust (the
// target's lift goes on from where it was); further back, as the same multiple of the fit (up to 1.3).
export function carryZoom(distance, from, to) {
  if (distance < from.fit) return to.fit * Math.pow(to.min / to.fit, Math.min(1, zoomShare(distance, from)));
  return to.fit * Math.min(distance / from.fit, 1.3);
}

// The camera distance's factor for a wheel step of `px` pixels (> 0 backs away) in a zoom range whose bust is `span`
// = ln(fit / bust) in: a notch is at least NOTCH px, NOTCHES of them from the fit to the bust; a faster spin's bigger
// steps zoom further.
export function wheelZoom(px, span) {
  return px ? Math.exp((Math.sign(px) * Math.max(Math.abs(px), NOTCH) * span) / (NOTCH * NOTCHES)) : 1;
}

// The camera distance's factor for a pinch whose fingers spread by `scale` (> 1 closes in)
export const pinchZoom = (scale) => (scale > 0 ? Math.pow(scale, -PINCH) : 1);

// The pan (the orbit target's offset from the lifted target, world units) kept inside the chibi's box as far as the
// zoom allows: none at the fit and further back, the whole box at the bust. `box` lies around the formation target,
// `lift` is the target's rise above it. Clamps `pan` in place.
export function clampPan(pan, share, box, lift) {
  const s = clamp(share, 0, 1);
  pan.x = clamp(pan.x, s * box.min.x, s * box.max.x);
  pan.y = clamp(pan.y, s * (box.min.y - lift), s * (box.max.y - lift));
  pan.z = clamp(pan.z, s * box.min.z, s * box.max.z);
  return pan;
}

// The view's wheel, pinch and pan input, read as the fullscreen lobby reads it (lobby-touch.js):
// - a mouse wheel zooms (wheelZoom); a trackpad swipe, a Magic Mouse scroll or a horizontal wheel pans while zoomed in
//   (as far as the fingers moved); a scroll that starts like a notch and turns out a swipe takes its zoom back.
// - a pinch zooms (pinchZoom): ctrl + wheel in Chromium and WebView2 (ctrl + a mouse wheel zooms by notches), gesture
//   events in WebKit (the macOS app), two fingers on a touch screen.
// - a right- or middle-button drag pans.
// `sink`: zoom(factor) multiplies the distance the zoom heads for, zoomSave() and zoomRestore(saved) take and put back
// the zoom's state (saveZoom), span() is the zoom range's (wheelZoom), pan(dx, dy) moves the chibi by CSS px. Returns
// the detach function.
// the zoom's state before a scroll that may turn out a swipe (attachInput), and putting it back: during a glide its
// own easing of the distance resumes (a glide the swipe outlived ends where it headed); a glide begun since owns the
// distance. `view`: goal (the distance a zoom eases to, or null), tween (the glide, or null), distance(), setZoomGoal(d).
export function saveZoom(view) {
  return { goal: view.goal, tween: view.tween, zoomed: !!view.tween?.zoomed, distance: view.distance() };
}
export function restoreZoom(view, saved) {
  if (view.tween && view.tween === saved.tween) {
    view.goal = saved.goal;
    view.tween.zoomed = saved.zoomed;
  } else if (!view.tween) view.setZoomGoal(saved.goal ?? saved.tween?.dist1 ?? saved.distance);
}

export function attachInput(el, sink) {
  let scroll = { kind: null, at: -Infinity }, pinchUntil = -Infinity, gesture = 1, gesturing = false, drag = null;
  const touches = new Map();
  const wheel = (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1, now = performance.now(), step = wheelStep(e);
    if (e.ctrlKey) {
      scroll = { kind: null, at: -Infinity };
      if (now < pinchUntil) return;
      sink.zoom(step === "smooth" ? pinchZoom(Math.exp(-e.deltaY * unit * CTRL_PINCH)) : wheelZoom(e.deltaY * unit, sink.span()));
      return;
    }
    const fresh = !(now - scroll.at < SCROLL_MS && scroll.kind), kind = wheelKind(e, now, scroll);
    if (fresh) {
      // a scroll that starts like a wheel zooming in pixels keeps the zoom it started from, to go back to if it turns
      // out a trackpad (lobby-touch.js); a second notch confirms the wheel
      const zooms = kind === "mouse" && !e.deltaMode && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      scroll = { kind, at: now, from: zooms ? sink.zoomSave() : null };
    } else {
      if (scroll.kind === "mouse" && kind === "trackpad" && scroll.from != null) sink.zoomRestore(scroll.from);
      if (step === "notch" || kind === "trackpad") scroll.from = null;
      scroll.kind = kind;
      scroll.at = now;
    }
    if (kind === "mouse" && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) sink.zoom(wheelZoom(e.deltaY * unit, sink.span()));
    else sink.pan(-e.deltaX * unit, kind === "mouse" ? 0 : -e.deltaY * unit);
  };
  // WebKit's trackpad pinch (and its touch pinch, which also comes as pointers)
  const gestureStart = (e) => { e.preventDefault(); gesture = 1; gesturing = true; pinchUntil = performance.now() + PINCH_HOLD; };
  const gestureChange = (e) => {
    e.preventDefault();
    pinchUntil = performance.now() + PINCH_HOLD;
    if (!(e.scale > 0)) return;
    sink.zoom(pinchZoom(e.scale / gesture));
    gesture = e.scale;
  };
  const gestureEnd = (e) => { e.preventDefault(); gesturing = false; pinchUntil = performance.now() + PINCH_HOLD; };
  const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const down = (e) => {
    if (e.pointerType === "touch") touches.set(e.pointerId, [e.clientX, e.clientY]);
    else if ((e.button === 1 || e.button === 2) && !drag) {
      e.preventDefault();
      drag = { id: e.pointerId, at: [e.clientX, e.clientY] };
    }
  };
  const move = (e) => {
    if (drag?.id === e.pointerId) {
      sink.pan(e.clientX - drag.at[0], e.clientY - drag.at[1]);
      drag.at = [e.clientX, e.clientY];
      return;
    }
    if (!touches.has(e.pointerId)) return;
    const before = touches.size === 2 ? spread() : 0;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (before > 0 && !gesturing) {
      const after = spread();
      if (after > 0) sink.zoom(pinchZoom(after / before));
    }
  };
  const up = (e) => {
    touches.delete(e.pointerId);
    if (drag?.id === e.pointerId) drag = null;
  };
  const handlers = [["wheel", wheel, { passive: false }], ["gesturestart", gestureStart], ["gesturechange", gestureChange],
    ["gestureend", gestureEnd], ["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]];
  for (const [type, fn, opts] of handlers) el.addEventListener(type, fn, opts);
  return () => { for (const [type, fn, opts] of handlers) el.removeEventListener(type, fn, opts); };
}

// the front view, level, as on the formation screen
const HOME = new THREE.Vector3(0, 0, 1);

// The switch card's still is taken from its own camera: the live one's lens, at the front view at the fit distance
// from the orbit target, the target on the frame's point of a w x h host. The live camera's orbit and zoom do not
// matter (seen from straight above, the box's height shrinks to nothing on the canvas).
export function stillCamera(camera, target, fit, frame, w, h) {
  const c = camera.clone();
  c.position.copy(target).addScaledVector(HOME, fit);
  c.up.set(0, 1, 0);
  c.lookAt(target);
  c.setViewOffset(w, h, w / 2 - frame.x, h / 2 - frame.y, w, h);
  c.updateMatrixWorld();
  return c;
}

// the still's crop of a W x H canvas rendered by `camera`: the upper body, from the chibi's box (around the target)
// as projected: its height, its centre over the root
export function stillCrop(camera, target, box, W, H, aspect) {
  const at = (y) => new THREE.Vector3(target.x, target.y + y, target.z).project(camera);
  const top = at(box.max.y), bottom = at(box.min.y);
  const h = ((top.y - bottom.y) / 2) * H, x = ((top.x + 1) / 2) * W, y = ((1 - (top.y + bottom.y) / 2) / 2) * H;
  const ch = h * 0.5, cw = ch * aspect, cy = y - h * 0.18;
  return { x: Math.max(0, Math.min(W - cw, x - cw / 2)), y: Math.max(0, Math.min(H - ch, cy - ch / 2)), w: cw, h: ch };
}

// the tab's actions: the clip slots they play, in order of preference; "next" follows a clip that plays once,
// "then" is the action after it
const ACTIONS = {
  idle: { slots: ["Formation_Idle", "Cafe_Idle", "Idle"] },
  reaction: { slots: ["Cafe_Reaction"], then: "idle" },
  walk: { slots: ["Cafe_Walk"] },
  victory: { slots: ["Victory_Start"], next: "Victory_End" },
  pickup: { slots: ["Formation_Pickup"] },
};

const stageScale = () => (document.getElementById("stage")?.getBoundingClientRect().width || 1920) / 1920;

let viewCount = 0;
class ChibiView {
  constructor(host, key, { still = false, renderer = null } = {}) {
    this.host = host;
    this.key = key;
    this.onAction = null;
    this.renderer = renderer || new THREE.WebGLRenderer({ antialias: true, alpha: true });
    viewCount++;
    this.still = still;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "model-view";
    host?.appendChild(this.canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FORMATION_VIEW.fov, 1, 0.01, 100);
    this.controls = still ? { target: new THREE.Vector3(), update() {}, dispose() {} } : new OrbitControls(this.camera, this.canvas);
    // the controls orbit, at any angle (straight from above to straight from below), with one finger or the left
    // button; zoom and pan are attachInput's, between the bust and a step back (frameTo, bustDistance). The controls'
    // own zoom took 58 Chromium notches or about 1430 slow macOS ones (on a 2x screen) to the bust, and WebKit's
    // pinch never reached them.
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, enablePan: false, enableZoom: false,
      minPolarAngle: 0, maxPolarAngle: Math.PI });
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: null }; // a second finger pinches (attachInput)
    this.clock = new THREE.Clock();
    this.mode = "left";
    this.view = { ...FRAMES.left };
    this.tween = null;
    this.goal = null; // the camera distance a zoom eases to
    this.pan = new THREE.Vector3(); // the orbit target's offset from the lifted target, and the one it eases to
    this.panGoal = new THREE.Vector3();
    if (still) {
      this.mode = "still";
      this.view = { ...FRAMES.still };
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(640, 640, false);
      return;
    }
    this.detachInput = attachInput(this.canvas, {
      zoom: (f) => this.zoomBy(f), zoomSave: () => saveZoom(this), zoomRestore: (saved) => restoreZoom(this, saved),
      span: () => this.span(), pan: (dx, dy) => this.panBy(dx, dy),
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    // a window resize only rescales the stage (the host keeps its layout size), a move to another screen or a
    // browser zoom changes the pixel ratio: both change the canvas resolution
    this.onWindow = () => this.resize();
    addEventListener("resize", this.onWindow);
    this.watchPixelRatio();
    this.canvas.addEventListener("dblclick", () => this.home());
    this.enableTap();
    this.resize();
  }

  // the canvas at the stage's on-screen size: the stage is a 1920 x 1080 box scaled by CSS
  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1, scale = stageScale();
    this.renderer.setPixelRatio(Math.min(2, (window.devicePixelRatio || 1) * scale));
    this.renderer.setSize(w, h, false);
    setOutlineScale(w, h); // the game's outline is 0.1 % of its screen width: here the stage's
    this.controls.rotateSpeed = 0.7 / Math.max(0.25, scale); // pointer moves are in screen pixels
    this.applyView();
  }

  // a media query matches the current pixel ratio only, so it is renewed on every change
  watchPixelRatio() {
    this.dpr?.removeEventListener("change", this.onPixelRatio);
    this.dpr = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.onPixelRatio = () => { this.watchPixelRatio(); this.resize(); };
    this.dpr.addEventListener("change", this.onPixelRatio);
  }

  // the orbit target projects to the host's centre; shift the view so it lands on the frame's point instead
  applyView() {
    const w = this.still ? 640 : this.host.clientWidth || 1, h = this.still ? 640 : this.host.clientHeight || 1;
    this.camera.setViewOffset(w, h, w / 2 - this.view.x, h / 2 - this.view.y, w, h);
    this.camera.updateProjectionMatrix();
  }

  async load(url, { signal } = {}) {
    const loader = new GLTFLoader();
    const gltf = signal ? await (async () => {
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      return loader.parseAsync(bytes, "");
    })() : await loader.loadAsync(url);
    const discard = () => gltf.scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose();
      }
    });
    if (this.disposed) { discard(); return; }
    const json = gltf.parser.json, parser = gltf.parser;
    const ex = json.extras || {};
    const textures = await Promise.all((json.textures || []).map((_, i) => parser.getDependency("texture", i)));
    const nodes = await Promise.all((json.nodes || []).map((_, i) => parser.getDependency("node", i)));
    if (this.disposed) { discard(); for (const t of textures) t.dispose(); return; }
    // colour textures are decoded from sRGB, masks and direction maps are data (the game's linear colour space)
    textures.forEach((t, i) => {
      t.colorSpace = json.textures[i].extras?.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      t.flipY = false;
    });
    this.textures = textures; // they are only in shader uniforms: disposed by hand
    // the mouth atlas comes as a texture of the EyeMouth material (_MouthTileTex); SetMouthTile moves its offset
    const mats = json.materials || [];
    const eye = mats.find((m) => m.extras?.kind === "eyemouth" && m.extras.textures?._MouthTileTex);
    if (eye) {
      const t = eye.extras.textures._MouthTileTex;
      this.mouth = { st: { value: new THREE.Vector4(t.scale[0], t.scale[1], t.offset[0], t.offset[1]) },
        cols: eye.extras.floats?._MouthTileCols || 8, rows: eye.extras.floats?._MouthTileRows || 8 };
    }
    // the node of a mesh object: a node of one primitive is the mesh, of several a group around them
    const nodeOf = (o) => {
      for (let q = o; q; q = q.parent) {
        const i = parser.associations.get(q)?.nodes;
        if (i !== undefined) return i;
      }
      return undefined;
    };
    const root = gltf.scene;
    const meshes = [];
    root.traverse((o) => {
      const node = json.nodes[parser.associations.get(o)?.nodes];
      if (node?.extras?.hidden) o.visible = false;
      if (o.isMesh) meshes.push(o);
    });
    this.spaces = []; // [material, the object whose space its shader reads directions in]
    for (const o of meshes) {
      o.frustumCulled = false;
      const gltfMaterial = o.material;
      const mex = mats[parser.associations.get(gltfMaterial)?.materials]?.extras || {};
      const texs = {};
      for (const [k, v] of Object.entries(mex.textures || {})) texs[k] = textures[v.index];
      const { material, objectSpace, outline, queue } = chibiMaterial(mex, texs, this.mouth);
      material.name = gltfMaterial.name;
      o.material = material;
      o.renderOrder = queue; // the game's render queue: geometry, then the eyes over the face, then transparents
      gltfMaterial.dispose();
      if (objectSpace) {
        // a skinned renderer draws in its root bone's space (Unity's unity_ObjectToWorld), a static one in its own
        const def = json.nodes[nodeOf(o)];
        const skeleton = def?.skin !== undefined ? json.skins[def.skin].skeleton : undefined;
        this.spaces.push([material, o.isSkinnedMesh && skeleton !== undefined ? nodes[skeleton] : o]);
      }
      if (outline && o.geometry.attributes._outline) {
        const ol = o.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, outlineMaterial(mex, texs._MainTex))
          : new THREE.Mesh(o.geometry, outlineMaterial(mex, texs._MainTex));
        if (o.isSkinnedMesh) ol.bind(o.skeleton, o.bindMatrix);
        ol.frustumCulled = false;
        ol.name = `${o.name}_outline`;
        ol.renderOrder = queue;
        o.add(ol); // shown and hidden with its mesh
      }
    }
    this.scene.add(root);
    this.root = root;
    this.gltf = gltf;
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener("finished", (e) => this.finished(e.action));
    this.clips = new Map();
    // renderers a clip switches (an expression's alternative face), each with its state at rest
    this.switches = new Map();
    gltf.animations.forEach((clip, i) => {
      const extras = json.animations[i]?.extras || {};
      for (const t of extras.toggles || []) {
        const object = nodes[t.node];
        if (object && !this.switches.has(t.node)) this.switches.set(t.node, { object, rest: object.visible });
      }
      if (extras.slot && !this.clips.has(extras.slot)) this.clips.set(extras.slot, { clip, ...extras });
    });
    // without a clip (NPC placeholders) the rest pose shows the props and the weapon where their bones rest, beside
    // the character; the game's clips scale them away, so fold them here
    if (!this.clips.size) root.traverse((o) => { if (/^(prop_root|Bip001_Weapon)$/i.test(o.name)) o.scale.setScalar(0); });
    await this.setupHalo(ex.haloFollower);
    if (this.disposed) return;
    this.act("idle", { fade: 0, quiet: true });
    this.measure();
  }

  // the renderers the playing clip switches on or off at its time (step keys); the others as at rest, as the
  // game's animator writes the defaults of what a state does not animate
  applySwitches() {
    if (!this.switches?.size) return;
    const states = new Map();
    const t = this.action?.time ?? 0;
    for (const s of this.slot?.toggles || []) {
      let on = !!s.keys[0][1];
      for (const [time, state] of s.keys) if (time <= t + 1e-4) on = !!state;
      states.set(s.node, on);
    }
    for (const [node, s] of this.switches) s.object.visible = states.has(node) ? states.get(node) : s.rest;
  }

  // the face and hair shaders read directions in their renderer's space (Unity's unity_ObjectToWorld)
  updateSpaces() {
    for (const [material, object] of this.spaces || []) material.uniforms.objectToWorld.value.setFromMatrix4(object.matrixWorld);
  }

  // FxFollower: the halo eases toward a point and rotation fixed to the head bone, clamped in head space
  async setupHalo(f) {
    if (!f || f.node == null || f.target == null) return;
    const p = this.gltf.parser;
    const [halo, head] = await Promise.all([p.getDependency("node", f.node), p.getDependency("node", f.target)]);
    this.halo = { halo, head, f, pos: null, rot: null, rel: new THREE.Vector3(...f.relativePosition),
      relQ: new THREE.Quaternion(...f.relativeRotation), min: new THREE.Vector3(...f.clampMin), max: new THREE.Vector3(...f.clampMax) };
  }

  followHalo(dt, snap = false) {
    const h = this.halo;
    if (!h) return;
    h.head.updateWorldMatrix(true, false);
    const want = h.rel.clone().applyMatrix4(h.head.matrixWorld);
    const wantQ = h.head.getWorldQuaternion(new THREE.Quaternion()).multiply(h.relQ);
    if (!h.pos || snap) { h.pos = want.clone(); h.rot = wantQ.clone(); }
    const k = (p) => 1 - Math.pow(1 - p, dt * 60);
    h.pos.lerp(want, k(h.f.positionPower));
    h.rot.slerp(wantQ, k(h.f.rotationPower));
    const local = h.head.worldToLocal(h.pos.clone()).clamp(h.min, h.max);
    h.pos.copy(h.head.localToWorld(local));
    const parent = h.halo.parent;
    parent.updateWorldMatrix(true, false);
    h.halo.position.copy(parent.worldToLocal(h.pos.clone()));
    h.halo.quaternion.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(h.rot));
  }

  // the size of the chibi in its first idle frame (halo included). The orbit target stands over the prefab's root
  // (where the character stands, as on the formation screen; weapons and props would pull a box centre aside) at the
  // formation camera's height, and rises to the face as the camera closes in.
  measure() {
    this.mixer.update(0);
    this.applySwitches();
    this.followHalo(0, true);
    this.root.updateMatrixWorld(true);
    const all = new THREE.Box3(), body = new THREE.Box3();
    this.root.traverse((o) => {
      if (!o.isMesh || o.name.endsWith("_outline")) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      let box;
      if (o.isSkinnedMesh) { o.computeBoundingBox(); box = o.boundingBox.clone().applyMatrix4(o.matrixWorld); }
      else { o.geometry.computeBoundingBox(); box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); }
      all.union(box);
      if (o.isSkinnedMesh) body.union(box);
    });
    if (body.isEmpty()) body.copy(all);
    if (all.isEmpty()) all.set(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1, 0.3));
    const origin = this.root.getWorldPosition(new THREE.Vector3());
    this.size = all.getSize(new THREE.Vector3());
    this.target = new THREE.Vector3(origin.x, origin.y + FORMATION_VIEW.eye, origin.z);
    this.box = { min: all.min.clone().sub(this.target), max: all.max.clone().sub(this.target) };
    this.faceY = body.min.y + (body.max.y - body.min.y) * 0.78; // a chibi's face sits in the top quarter
    this.controls.target.copy(this.target);
  }

  // the front view, level, as on the formation screen
  homeDirection() {
    return HOME.clone();
  }

  // switch between the framing beside the panel and fullscreen; the orbit angle and the zoom (its place between
  // the bust and the fit, or beyond the fit) stay as they were
  frameTo(mode, snap = false) {
    this.mode = FRAMES[mode] ? mode : "left";
    const f = FRAMES[this.mode];
    if (!this.size) { this.view = { x: f.x, y: f.y }; this.applyView(); return; }
    const fit = frameDistance(this.box, f);
    const range = { fit, min: bustDistance(this.box, this.faceY - this.target.y, f, fit) };
    const offset = this.camera.position.clone().sub(this.controls.target);
    const keep = !snap && !!this.fit && offset.lengthSq() > 0;
    const from = this.range(); // gliding: where it is now
    const distance = keep ? carryZoom(this.goal ?? offset.length(), from, range) : fit; // a zoom under way: where it heads
    this.fit = fit;
    this.limits = { min: range.min, max: fit * 1.3 }; // the bust, a step back
    this.camera.near = fit / 50;
    this.camera.far = fit * 20;
    this.moveTo(keep ? offset.normalize() : this.homeDirection(), distance, f, snap, keep ? from : null);
  }

  // double-click: back to the front view at the fit distance, unpanned (from where a change of framing has brought
  // the zoom range so far)
  home() {
    if (!this.limits) return;
    this.panGoal.set(0, 0, 0);
    this.moveTo(this.homeDirection(), this.fit, FRAMES[this.mode], false, this.range());
  }

  // the zoom range the target's lift spans, {fit, min}; while the camera glides to another framing it goes from the
  // old range to the new one with the camera, so the lift (and the target) does not jump
  range() {
    const r = { fit: this.fit, min: this.limits?.min ?? this.fit }, tw = this.tween;
    if (!tw?.range0) return r;
    const k = ease(THREE.MathUtils.clamp((performance.now() - tw.t0) / TWEEN, 0, 1));
    return { fit: tw.range0.fit + (r.fit - tw.range0.fit) * k, min: tw.range0.min + (r.min - tw.range0.min) * k };
  }

  // the camera as a direction and distance from the orbit target, so the target can rise while it moves; range0:
  // the zoom range it leaves (a change of framing). The glide takes the distance over from a zoom under way; the
  // limits hold as the zoom's goal is clamped (setZoomGoal) and both ends of a glide lie inside them.
  moveTo(direction, distance, view, snap, range0 = null) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.goal = null;
    const tw = (this.tween = { t0: performance.now(), dir0: offset.lengthSq() ? offset.clone().normalize() : direction.clone(), dist0: offset.length() || distance,
      dir1: direction.clone(), dist1: distance, view0: { ...this.view }, view1: { x: view.x, y: view.y }, range0 });
    if (snap) tw.t0 = -Infinity;
    this.stepTween();
    if (snap) { this.pan.copy(this.panGoal); this.liftTarget(); this.controls.update(); }
  }

  // the glide's step; an orbit (turned) or a zoom (zoomed) under way since it began keeps its part, and the framing
  // glides on
  stepTween() {
    const tw = this.tween;
    if (!tw) return;
    const t = Math.min(1, (performance.now() - tw.t0) / TWEEN), k = ease(t);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dir = tw.turned ? offset.clone() : new THREE.Vector3().lerpVectors(tw.dir0, tw.dir1, k);
    if (dir.lengthSq() < 1e-8) dir.copy(tw.dir1);
    const distance = tw.zoomed ? offset.length() : tw.dist0 + (tw.dist1 - tw.dist0) * k;
    this.camera.position.copy(this.controls.target).add(dir.normalize().multiplyScalar(distance));
    this.view = { x: tw.view0.x + (tw.view1.x - tw.view0.x) * k, y: tw.view0.y + (tw.view1.y - tw.view0.y) * k };
    this.applyView();
    if (t >= 1) this.tween = null;
  }

  // closing in moves the orbit target from the formation camera's height up to the face (liftShare), so the closest
  // view is the bust, plus the pan; the camera keeps its offset from the target
  liftTarget() {
    if (!this.fit) return;
    const o = this.controls, offset = this.camera.position.clone().sub(o.target);
    o.target.set(this.target.x, this.target.y + this.lift(offset.length()), this.target.z).add(this.pan);
    this.camera.position.copy(o.target).add(offset);
  }

  // the target's rise above the formation target at a camera distance
  lift(distance, range = this.range()) {
    return (this.faceY - this.target.y) * liftShare(distance, range);
  }

  // --- zoom and pan (attachInput) ---
  distance() { return this.camera.position.distanceTo(this.controls.target); }

  // the distance a zoom goes on from: where a zoom under way heads, or where the camera is
  zoomGoal() { return this.goal ?? this.distance(); }

  zoomBy(factor) {
    if (factor > 0 && factor !== 1) this.setZoomGoal(this.zoomGoal() * factor);
  }

  // a zoom during a glide takes the distance over from it (the direction and the framing glide on)
  setZoomGoal(distance) {
    if (!this.limits || !(distance > 0)) return;
    if (this.tween) this.tween.zoomed = true;
    this.goal = clamp(distance, this.limits.min, this.limits.max);
  }

  // ln(fit / bust): the zoom's span from the front view to the bust (wheelZoom)
  span() {
    const { fit, min } = this.range();
    return fit > min ? Math.log(fit / min) : 0;
  }

  // the chibi moves by dx, dy CSS px across the view (the target the other way, at its distance), as far as the zoom
  // lets it (clampPan)
  panBy(dx, dy) {
    if (!this.limits || (!dx && !dy)) return;
    const r = this.canvas.getBoundingClientRect(), d = this.distance();
    const unit = (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(r.height, 1);
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements; // the camera's right (x) and up (y) axes
    this.panGoal.x += (-dx * e[0] + dy * e[4]) * unit;
    this.panGoal.y += (-dx * e[1] + dy * e[5]) * unit;
    this.panGoal.z += (-dx * e[2] + dy * e[6]) * unit;
    clampPan(this.panGoal, zoomShare(d, this.range()), this.box, this.lift(d));
  }

  // every frame: the distance eases to the zoom's goal (in steps of the zoom, as a notch or a pinch makes them) and the
  // pan to its own, which zooming out draws in
  stepZoom(dt) {
    if (!this.limits) return;
    const k = 1 - Math.exp(-dt / ZOOM_TAU);
    if (this.goal != null) {
      const offset = this.camera.position.clone().sub(this.controls.target), d = offset.length(), g = this.goal;
      const next = Math.abs(Math.log(g / d)) < 1e-4 ? g : d * Math.pow(g / d, k);
      if (next === g) this.goal = null;
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), next);
    }
    const range = this.range(), d = this.distance(), s = zoomShare(d, range), lift = this.lift(d, range);
    clampPan(this.panGoal, s, this.box, lift);
    this.pan.lerp(this.panGoal, k);
    clampPan(this.pan, s, this.box, lift);
  }

  // --- actions ---
  actions() {
    return Object.keys(ACTIONS).filter((name) => ACTIONS[name].slots.some((s) => this.clips?.has(s)));
  }

  act(name, { fade = 0.3, quiet = false } = {}) {
    const def = ACTIONS[name];
    const slot = def?.slots.find((s) => this.clips?.has(s));
    if (!slot) return false;
    this.current = name;
    this.playSlot(slot, { fade, once: !!(def.then || def.next) });
    if (!quiet) this.onAction?.(name);
    return true;
  }

  playSlot(slot, { fade = 0.3, once = false } = {}) {
    const entry = this.clips.get(slot);
    const a = this.mixer.clipAction(entry.clip);
    const looping = !once && entry.loop !== false;
    a.reset().setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, looping ? Infinity : 1);
    a.clampWhenFinished = !looping;
    if (this.action && this.action !== a && fade > 0) { a.play(); a.crossFadeFrom(this.action, fade, false); }
    else { if (this.action && this.action !== a) this.action.stop(); a.play(); }
    this.action = a;
    this.slot = entry;
  }

  // a clip that plays once has ended: its follow-up clip, or the action after it
  finished(action) {
    if (action !== this.action) return;
    const def = ACTIONS[this.current];
    if (def?.next && this.clips.has(def.next) && this.slot !== this.clips.get(def.next)) this.playSlot(def.next, { fade: 0.2 });
    else if (def?.then) this.act(def.then, { fade: 0.35 });
  }

  updateMouth() {
    if (!this.mouth || !this.action || !this.slot) return;
    let tile = this.mouthTile;
    const t = this.action.time;
    for (const e of this.slot.events || []) if (e.function === "SetMouthTile" && e.time <= t + 1e-4) tile = e.int;
    if (tile == null || tile === this.mouthTile) return;
    this.mouthTile = tile; // kept between clips, like the game
    // int = row * 100 + col; offsets in Unity uv (rows from the bottom)
    const st = this.mouth.st.value;
    st.set(st.x, st.y, (tile % 100) / this.mouth.cols, Math.floor(tile / 100) / this.mouth.rows);
  }

  // a tap on the character plays the cafe touch reaction, then the idle again; a drag still orbits, and during a glide
  // takes the direction over from it. Only a lone press of the left button or one finger taps or orbits.
  enableTap() {
    let down = null;
    const pressed = new Set();
    const moved = (e) => Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6;
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.isPrimary) pressed.clear(); // the first finger, or a mouse: nothing else is down (a lost release)
      pressed.add(e.pointerId);
      down = pressed.size === 1 && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (down?.id === e.pointerId && this.tween && moved(e)) this.tween.turned = true;
    });
    const lift = (e) => pressed.delete(e.pointerId);
    this.canvas.addEventListener("pointercancel", (e) => { lift(e); down = null; });
    this.canvas.addEventListener("pointerup", (e) => {
      lift(e);
      if (down?.id !== e.pointerId || moved(e) || performance.now() - down.t > 400) { down = null; return; }
      down = null;
      if (this.root && this.current !== "reaction" && this.hit(e)) this.act("reaction", { fade: 0.2 });
    });
  }

  hit(e) {
    const r = this.canvas.getBoundingClientRect(); // includes the stage's CSS scale
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(p, this.camera);
    const visible = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
    return ray.intersectObjects(this.root.children, true).some((h) => !h.object.name.endsWith("_outline") && visible(h.object));
  }

  // the render loop; resolves once the first frame is on the canvas (or the view is disposed first)
  start() {
    this.clock.getDelta();
    return new Promise((drawn) => {
      this.drawn = drawn;
      this.renderer.setAnimationLoop(() => { this.tick(); drawn(); });
    });
  }

  // shaders before the first frame, in the background where the GPU driver can. Polled here rather than with
  // renderer.compileAsync, whose timer throws (and never settles) once the view is disposed meanwhile.
  async compile() {
    const r = this.renderer;
    let pending;
    try {
      pending = r.compile(this.scene, this.camera);
    } catch { return; } // compiled on the first frame instead
    if (!r.extensions.has("KHR_parallel_shader_compile")) return;
    // isReady() is false while the driver compiles (null once the context is lost: nothing to wait for)
    while (pending.size && !this.disposed) {
      for (const m of pending) if (r.properties.get(m).currentProgram?.isReady() !== false) pending.delete(m);
      if (pending.size) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  tick() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.mixer?.update(dt);
    this.applySwitches();
    this.updateMouth();
    this.followHalo(dt);
    this.stepTween();
    this.stepZoom(dt);
    this.liftTarget();
    this.controls.update();
    this.root?.updateMatrixWorld();
    this.updateSpaces();
    setOutlineScale(this.host.clientWidth || 1, this.host.clientHeight || 1);
    this.renderer.render(this.scene, this.camera);
  }

  // The live tab's shaders, idle, halo and formation camera with an explicit off-screen clock.
  // Freeze and validate before encoding: no RAF, blank cached frames or disk writes.
  async renderStill(signal) {
    this.frameTo("still", true);
    this.camera.lookAt(this.controls.target);
    await this.compile();
    signal.throwIfAborted();
    this.mixer.update(0);
    this.applySwitches();
    this.updateMouth();
    this.followHalo(0, true);
    this.root.updateMatrixWorld(true);
    this.updateSpaces();
    setOutlineScale(640, 640, 640);
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext(), pixels = new Uint8Array(640 * 640 * 4);
    if (gl.isContextLost()) throw new Error("3D still: WebGL context lost");
    gl.readPixels(0, 0, 640, 640, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (!pixels.some((value, i) => i % 4 === 3 && value > 0)) throw new Error("3D still: no visible pixels");
    const frozen = document.createElement("canvas");
    frozen.width = frozen.height = 640;
    frozen.getContext("2d").drawImage(this.canvas, 0, 0);
    return new Promise((resolve, reject) => frozen.toBlob((blob) => {
      if (signal.aborted) resolve(null);
      else if (!blob) reject(new Error("3D still: PNG encoding failed"));
      else resolve(URL.createObjectURL(blob));
    }, "image/png"));
  }

  // a still of the upper body for the switch card, from the front view at the fit distance in the current framing
  // whatever the orbit and the zoom (stillCamera), cropped from the box as rendered (stillCrop). Rendered and read
  // in one go (the drawing buffer is not kept), then the live view is drawn again before the canvas is shown.
  snapshot(aspect = 450 / 253) {
    if (!this.root || !this.fit) return null;
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const camera = stillCamera(this.camera, this.target, this.fit, FRAMES[this.mode], w, h);
    this.renderer.render(this.scene, camera);
    const { x, y, w: cw, h: ch } = stillCrop(camera, this.target, this.box, this.canvas.width, this.canvas.height, aspect);
    let still = null;
    if (ch >= 1) {
      const c = document.createElement("canvas");
      c.width = 900;
      c.height = Math.round(900 / aspect);
      c.getContext("2d").drawImage(this.canvas, x, y, cw, ch, 0, 0, c.width, c.height);
      still = c.toDataURL("image/png");
    }
    this.renderer.render(this.scene, this.camera);
    return still;
  }

  reveal() { this.canvas.classList.add("ready"); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.drawn?.();
    this.observer?.disconnect();
    if (this.onWindow) removeEventListener("resize", this.onWindow);
    this.dpr?.removeEventListener("change", this.onPixelRatio);
    this.detachInput?.();
    this.controls.dispose();
    this.mixer?.stopAllAction();
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose();
      }
    });
    for (const t of this.textures || []) t.dispose();
    if (--viewCount === 0) disposeDefaults();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

export const createStillView = (options = {}) => new ChibiView(null, null, { ...options, still: true });

let view = null, token = 0;

// show(variantKey, host, {frame, onAction}): load and show a variant's chibi; resolves with the action names once
// the first frame is drawn, or null when another show or a hide came first. onAction(name) follows the current
// action when it changes by itself (a tap, a reaction ending). The shown view is kept for the same variant of the
// same install (version: the game's resource version; another game folder or file source loads it again).
export async function show(key, host, { frame: mode = "left", onAction = null, version = null, source = "live" } = {}) {
  if (view?.key === key && view.host === host && view.version === version && view.source === source) {
    view.onAction = onAction;
    if (view.mode !== mode) view.frameTo(mode);
    return view.ready;
  }
  hide(host);
  const my = ++token;
  const v = (view = new ChibiView(host, key));
  v.version = version;
  v.source = source;
  v.onAction = onAction;
  v.frameTo(mode); // before the load this only records the framing
  v.ready = (async () => {
    try {
      await v.load(modelUrl(key, source));
    } catch (err) {
      if (my !== token) return null;
      hide(host);
      throw err;
    }
    if (my !== token) return null;
    // the framing asked for last: fullscreen may have been entered or left while the model loaded
    v.frameTo(v.mode, true);
    await v.compile();
    if (my !== token) return null;
    await v.start();
    if (my !== token) return null;
    v.reveal();
    return v.actions();
  })();
  return v.ready;
}

// free the view and its WebGL context
export function hide(host) {
  token += 1;
  if (view) { view.dispose(); view = null; }
  if (host) host.replaceChildren();
}

export function frame(mode) { view?.frameTo(mode); }
// resolves once the camera has arrived at its framing (a change of framing glides there)
export function settled() {
  return new Promise((resolve) => { const check = () => (view?.tween ? requestAnimationFrame(check) : resolve()); check(); });
}
export const actions = () => view?.actions() || [];
export const current = () => view?.current || null;
export function play(name) { return view?.act(name, { quiet: true }) || false; }
export const snapshot = () => view?.snapshot() || null;
// for checks: the camera's distance, the zoom's goal, range and place, the target's lift and the pan
export function zoomState() {
  if (!view?.limits) return null;
  const d = view.distance(), range = view.range();
  return { distance: d, goal: view.goal, fit: view.fit, min: view.limits.min, max: view.limits.max, share: zoomShare(d, range),
    lift: view.lift(d, range), pan: view.pan.toArray(), panGoal: view.panGoal.toArray(), gliding: !!view.tween };
}
