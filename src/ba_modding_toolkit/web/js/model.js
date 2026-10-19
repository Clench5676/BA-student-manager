// 3D chibi for the detail screen's third tab. The GLB is exported from the user's game files in memory
// (gameassets/model.py): the game's material constants are in the material extras, the halo follower (FxFollower)
// in the root extras, and each clip's slot, loop flag, SetMouthTile events and renderer switches in the animation
// extras. The materials are ports of the game's character shaders (chibi-materials.js), the camera starts at the
// formation screen's view of one character (FORMATION_VIEW) and orbits freely. One view at a time; hide() frees its
// WebGL context at once.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { chibiMaterial, disposeDefaults, outlineMaterial, setOutlineScale } from "./chibi-materials.js";

const ease = (t) => 1 - Math.pow(1 - t, 3);

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
const FRAMES = { left: { x: 490, y: 500, w: 1000, h: 1080, floor: 700 }, full: { x: 960, y: 540, w: 1920, h: 1080, floor: 1056 } };
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

class ChibiView {
  constructor(host, key) {
    this.host = host;
    this.key = key;
    this.onAction = null;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "model-view";
    host.appendChild(this.canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FORMATION_VIEW.fov, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.canvas);
    // no panning, any angle (straight from above to straight from below); the zoom stays between the bust and a
    // step back (frameTo)
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, enablePan: false, zoomSpeed: 0.8,
      minPolarAngle: 0, maxPolarAngle: Math.PI });
    this.clock = new THREE.Clock();
    this.mode = "left";
    this.view = { ...FRAMES.left };
    this.tween = null;
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
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.camera.setViewOffset(w, h, w / 2 - this.view.x, h / 2 - this.view.y, w, h);
    this.camera.updateProjectionMatrix();
  }

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (this.disposed) return;
    const json = gltf.parser.json, parser = gltf.parser;
    const ex = json.extras || {};
    const textures = await Promise.all((json.textures || []).map((_, i) => parser.getDependency("texture", i)));
    const nodes = await Promise.all((json.nodes || []).map((_, i) => parser.getDependency("node", i)));
    if (this.disposed) { for (const t of textures) t.dispose(); return; }
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
    return new THREE.Vector3(0, 0, 1);
  }

  // switch between the framing beside the panel and fullscreen; the orbit angle and the zoom (relative to the
  // fit) stay as they were
  frameTo(mode, snap = false) {
    this.mode = FRAMES[mode] ? mode : "left";
    const f = FRAMES[this.mode];
    if (!this.size) { this.view = { x: f.x, y: f.y }; this.applyView(); return; }
    const fit = frameDistance(this.box, f);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const ratio = this.fit ? THREE.MathUtils.clamp(offset.length() / this.fit, 0.45, 1.3) : 1;
    this.fit = fit;
    this.limits = { min: fit * 0.45, max: fit * 1.3 }; // about the bust, a step back
    this.camera.near = fit / 50;
    this.camera.far = fit * 20;
    const keep = !snap && offset.lengthSq() > 0;
    this.moveTo(keep ? offset.normalize() : this.homeDirection(), fit * (keep ? ratio : 1), f, snap);
  }

  // double-click: back to the front view at the fit distance
  home() {
    if (this.limits) this.moveTo(this.homeDirection(), this.fit, FRAMES[this.mode], false);
  }

  // the camera as a direction and distance from the orbit target, so the target can rise while it moves
  moveTo(direction, distance, view, snap) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const tw = (this.tween = { t0: performance.now(), dir0: offset.lengthSq() ? offset.clone().normalize() : direction.clone(), dist0: offset.length() || distance,
      dir1: direction.clone(), dist1: distance, view0: { ...this.view }, view1: { x: view.x, y: view.y } });
    if (snap) tw.t0 = -Infinity;
    // the orbit controls clamp the distance on every update: while the camera glides, the zoom limits take in both
    // ends, and the new fit's limits apply once it arrives
    Object.assign(this.controls, { minDistance: Math.min(this.limits.min, tw.dist0, tw.dist1), maxDistance: Math.max(this.limits.max, tw.dist0, tw.dist1) });
    this.stepTween();
    if (snap) { this.liftTarget(); this.controls.update(); }
  }

  stepTween() {
    const tw = this.tween;
    if (!tw) return;
    const t = Math.min(1, (performance.now() - tw.t0) / TWEEN), k = ease(t);
    const dir = new THREE.Vector3().lerpVectors(tw.dir0, tw.dir1, k);
    if (dir.lengthSq() < 1e-8) dir.copy(tw.dir1);
    this.camera.position.copy(this.controls.target).add(dir.normalize().multiplyScalar(tw.dist0 + (tw.dist1 - tw.dist0) * k));
    this.view = { x: tw.view0.x + (tw.view1.x - tw.view0.x) * k, y: tw.view0.y + (tw.view1.y - tw.view0.y) * k };
    this.applyView();
    if (t >= 1) {
      this.tween = null;
      Object.assign(this.controls, { minDistance: this.limits.min, maxDistance: this.limits.max });
    }
  }

  // closing in moves the orbit target from the body's centre up to the face, so the closest view is the bust;
  // the camera keeps its offset from the target
  liftTarget() {
    if (!this.fit) return;
    const o = this.controls, offset = this.camera.position.clone().sub(o.target);
    const t = THREE.MathUtils.clamp((this.fit - offset.length()) / (this.fit - this.limits.min), 0, 1);
    o.target.set(this.target.x, this.target.y + (this.faceY - this.target.y) * ease(t), this.target.z);
    this.camera.position.copy(o.target).add(offset);
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

  // a tap on the character plays the cafe touch reaction, then the idle again; a drag still orbits
  enableTap() {
    let down = null;
    this.canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    this.canvas.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 400) return;
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
    this.liftTarget();
    this.controls.update();
    this.root?.updateMatrixWorld();
    this.updateSpaces();
    this.renderer.render(this.scene, this.camera);
  }

  // a still of the upper body for the switch card (rendered and read in one go: the drawing buffer is not kept)
  snapshot(aspect = 450 / 253) {
    if (!this.root) return null;
    this.renderer.render(this.scene, this.camera);
    const W = this.canvas.width, H = this.canvas.height;
    // the chibi's box on the canvas (its height, its centre over the root), as rendered
    const at = (y) => new THREE.Vector3(this.target.x, this.target.y + y, this.target.z).project(this.camera);
    const top = at(this.box.max.y), bottom = at(this.box.min.y);
    const h = ((top.y - bottom.y) / 2) * H, x = ((top.x + 1) / 2) * W, y = ((1 - (top.y + bottom.y) / 2) / 2) * H;
    const ch = h * 0.5, cw = ch * aspect, cy = y - h * 0.18;
    const x0 = Math.max(0, Math.min(W - cw, x - cw / 2)), y0 = Math.max(0, Math.min(H - ch, cy - ch / 2));
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = Math.round(900 / aspect);
    c.getContext("2d").drawImage(this.canvas, x0, y0, cw, ch, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  reveal() { this.canvas.classList.add("ready"); }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.drawn?.();
    this.observer.disconnect();
    removeEventListener("resize", this.onWindow);
    this.dpr.removeEventListener("change", this.onPixelRatio);
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
    disposeDefaults();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

let view = null, token = 0;

// show(variantKey, host, {frame, onAction}): load and show a variant's chibi; resolves with the action names once
// the first frame is drawn, or null when another show or a hide came first. onAction(name) follows the current
// action when it changes by itself (a tap, a reaction ending). The shown view is kept for the same variant of the
// same install (version: the game's resource version; another game folder or file source loads it again).
export async function show(key, host, { frame: mode = "left", onAction = null, version = null } = {}) {
  if (view?.key === key && view.host === host && view.version === version) {
    view.onAction = onAction;
    if (view.mode !== mode) view.frameTo(mode);
    return view.ready;
  }
  hide(host);
  const my = ++token;
  const v = (view = new ChibiView(host, key));
  v.version = version;
  v.onAction = onAction;
  v.frameTo(mode); // before the load this only records the framing
  v.ready = (async () => {
    try {
      await v.load(`/asset/model/${encodeURIComponent(key)}.glb`);
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
