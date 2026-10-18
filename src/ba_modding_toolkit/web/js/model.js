// 3D chibi for the detail screen's third tab. The GLB is exported from the user's game files in memory
// (gameassets/model.py): the game's material constants are in the material extras, the halo follower (FxFollower)
// in the root extras, and each clip's slot, loop flag, SetMouthTile events and renderer switches in the animation
// extras. The look
// approximates the game's toon shaders (one light, a shadow tint below a threshold, inverted-hull outlines), the
// camera the formation screen's. One view at a time; hide() frees its WebGL context at once.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const srgb = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
const lin = (c) => new THREE.Vector3(c[0], c[1], c[2]);
const ease = (t) => 1 - Math.pow(1 - t, 3);

// one light for every toon material, in view space (a studio light that follows the camera)
const LIGHT = { value: new THREE.Vector3(-0.3, 0.75, 0.6).normalize() };
const FLAT = ["eyemouth", "eyebrow", "halo", "unlit", "transparent"];
// where the chibi stands on the host (its centre, in stage pixels) and how much of the host's height it takes (halo
// included): beside the panel it stays above the nameplate; fullscreen it stands in the middle. Pixels, not
// fractions, so it does not jump when the host widens for fullscreen.
const FRAMES = { left: { x: 490, y: 390, fill: 0.55 }, full: { x: 960, y: 540, fill: 0.8 } };
const FOV = 26, ELEVATION = 12, TWEEN = 450;
// the tab's actions: the clip slots they play, in order of preference; "next" follows a clip that plays once,
// "then" is the action after it
const ACTIONS = {
  idle: { slots: ["Formation_Idle", "Cafe_Idle", "Idle"] },
  reaction: { slots: ["Cafe_Reaction"], then: "idle" },
  walk: { slots: ["Cafe_Walk"] },
  victory: { slots: ["Victory_Start"], next: "Victory_End" },
  pickup: { slots: ["Formation_Pickup"] },
};

function toonMaterial(src, ex, textures, mouth) {
  const kind = ex.kind || "general";
  const c = ex.colors || {}, f = ex.floats || {};
  const mat = new THREE.MeshBasicMaterial({ map: src.map || null, color: 0xffffff, side: f._Cull === 0 ? THREE.DoubleSide : THREE.FrontSide });
  mat.name = src.name;
  if (kind === "eyebrow") { mat.color = srgb(c._Tint || [0.5, 0.3, 0.3]); mat.map = null; }
  const uniforms = {
    toonLight: LIGHT,
    toonTint: { value: lin(c._ShadowTint || [0.8, 0.8, 0.85]) },
    toonThreshold: { value: f._ShadowThreshold ?? 0.5 },
    layerR: { value: new THREE.Vector4(...(c._ShadowTintR4 || [0.8, 0.8, 0.8, 0.8])) },
    layerG: { value: new THREE.Vector4(...(c._ShadowTintG4 || [0.8, 0.8, 0.8, 0.8])) },
    layerB: { value: new THREE.Vector4(...(c._ShadowTintB4 || [0.85, 0.85, 0.85, 0.85])) },
    layerT: { value: new THREE.Vector4(...(c._ShadowThreshold4 || [0.5, 0.5, 0.5, 0.5])) },
    maskMap: { value: textures._MaskTex || null },
    maskG: { value: f._MaskGSensitivity ?? 1 },
    zCorrection: { value: f._ZCorrection ?? 0 },
  };
  const defines = [];
  if (kind === "body" && textures._MaskTex) defines.push("#define TOON_LAYER4");
  else if (textures._MaskTex && kind !== "face") defines.push("#define TOON_MASK");
  if (FLAT.includes(kind)) defines.push("#define TOON_FLAT");
  if (kind === "transparent") { mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide; }
  if (kind === "eyebrow") defines.push("#define Z_CORRECTION");
  if (kind === "eyemouth" && mouth) defines.push("#define MOUTH_TILE");
  if (kind === "halo") {
    defines.push("#define HALO");
    uniforms.haloTint = { value: lin(c._Tint || [1, 1, 1]) };
    // the glow replacement only runs with the material's _GLOW_0 keyword and a strength above zero
    const glow = (ex.keywords || []).includes("_GLOW_0") && (f._GlowStrength0 ?? 0) > 0;
    uniforms.haloGlow = { value: lin(c._GlowTint0 || [1, 1, 1]).multiplyScalar(f._GlowStrength0 ?? 1) };
    uniforms.haloMask = { value: glow ? lin(c._GlowMaskColor0 || [2, 2, 2]) : new THREE.Vector3(9, 9, 9) }; // 9: never matches
    mat.side = THREE.DoubleSide;
    mat.toneMapped = false;
    // an untextured halo (MX/C-Halo/Simple) is one flat colour
    if (!mat.map) mat.color = srgb(c._SimpleBaseColor || c._Tint || [1, 1, 1]);
  }
  if (mouth && kind === "eyemouth") {
    uniforms.mouthMap = { value: mouth.texture };
    uniforms.mouthOffset = mouth.offset; // shared, set by SetMouthTile
    uniforms.mouthScale = { value: new THREE.Vector2(...mouth.scale) };
    mat.alphaTest = 0.5;
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const head = defines.join("\n") + "\n";
    shader.vertexShader = head + shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vToonN;\nuniform float zCorrection;")
      .replace("#include <fog_vertex>", [
        "#include <fog_vertex>",
        "#if defined( USE_ENVMAP ) || defined( USE_SKINNING )",
        "  vToonN = normalize( transformedNormal );",
        "#else",
        "  vToonN = normalize( normalMatrix * normal );",
        "#endif",
        "#ifdef Z_CORRECTION",
        // eyebrows are drawn over the fringe: pull them toward the camera in view space
        "  vec4 zc = mvPosition; zc.z += zCorrection * 0.6;",
        "  gl_Position.z = ( projectionMatrix * zc ).z / ( projectionMatrix * zc ).w * gl_Position.w;",
        "#endif",
      ].join("\n"));
    shader.fragmentShader = head + shader.fragmentShader
      .replace("#include <common>", [
        "#include <common>",
        "varying vec3 vToonN;",
        "uniform vec3 toonLight; uniform vec3 toonTint; uniform float toonThreshold;",
        "uniform vec4 layerR; uniform vec4 layerG; uniform vec4 layerB; uniform vec4 layerT;",
        "uniform sampler2D maskMap; uniform float maskG;",
        "#ifdef HALO\nuniform vec3 haloTint; uniform vec3 haloGlow; uniform vec3 haloMask;\n#endif",
        "#ifdef MOUTH_TILE\nuniform sampler2D mouthMap; uniform vec2 mouthOffset; uniform vec2 mouthScale;\n#endif",
      ].join("\n"))
      .replace("#include <map_fragment>", [
        "#include <map_fragment>",
        "#ifdef MOUTH_TILE",
        // Unity uv (origin bottom-left); the mouth is the bottom-left quarter of the EyeMouth atlas
        "{ vec2 u = vec2( vMapUv.x, 1.0 - vMapUv.y );",
        "  if ( u.x < 0.25 && u.y < 0.375 ) {",
        "    vec2 t = u * mouthScale;",
        "    if ( t.x > 0.125 || t.y > 0.125 ) discard;",
        "    vec4 m = texture2D( mouthMap, vec2( t.x + mouthOffset.x, 1.0 - ( t.y + mouthOffset.y ) ) );",
        "    diffuseColor = vec4( m.rgb, m.a );",
        "  } }",
        "#endif",
        // the glow replacement reads the texture (map_fragment declares sampledDiffuseColor only with a map)
        "#if defined( HALO ) && defined( USE_MAP )",
        "{ vec3 s = pow( max( sampledDiffuseColor.rgb, 0.0 ), vec3( 1.0 / 2.2 ) );",
        "  float g = 1.0 - smoothstep( 0.06, 0.22, distance( s, haloMask ) );",
        "  diffuseColor.rgb = mix( diffuseColor.rgb * haloTint, haloGlow, g ); }",
        "#endif",
      ].join("\n"))
      .replace("#include <opaque_fragment>", [
        "#ifndef TOON_FLAT",
        "{ vec3 n = normalize( vToonN ); if ( ! gl_FrontFacing ) n = -n;",
        "  float hl = dot( n, toonLight ) * 0.5 + 0.5;",
        "  vec3 tint = toonTint; float th = toonThreshold;",
        "  #if defined( TOON_LAYER4 ) || defined( TOON_MASK )",
        "  vec4 mk = texture2D( maskMap, vMapUv );",
        "  hl += ( mk.g - 0.5 ) * maskG;",
        "  #endif",
        "  #ifdef TOON_LAYER4",
        "  int l = int( clamp( floor( mk.a * 5.0 + 0.5 ), 0.0, 3.0 ) );",
        "  tint = vec3( layerR[ l ], layerG[ l ], layerB[ l ] ); th = layerT[ l ];",
        "  #endif",
        "  float lit = smoothstep( th - 0.02, th + 0.02, hl );",
        "  outgoingLight *= mix( tint, vec3( 1.0 ), lit ); }",
        "#endif",
        "#include <opaque_fragment>",
      ].join("\n"));
  };
  mat.customProgramCacheKey = () => "bamt-chibi-" + defines.join("|");
  return mat;
}

// inverted hull along the smoothed outline normal (_OUTLINE), width from the vertex colour alpha, constant on screen
function outlineMaterial(ex, map) {
  const c = ex.colors || {}, f = ex.floats || {};
  const mat = new THREE.MeshBasicMaterial({ map, color: srgb(c._OutlineTint || [0.5, 0.5, 0.5]), side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: f._OutlineThickness ?? 0.003 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 _outline;\nattribute vec4 color;\nuniform float outlineWidth;")
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = length( _outline ) > 0.0 ? _outline : normal;")
      .replace("#include <project_vertex>", [
        "#include <project_vertex>",
        "{ vec3 vn = normalize( normalMatrix * objectNormal );",
        "  vec2 d = normalize( ( projectionMatrix * vec4( vn, 0.0 ) ).xy + 1e-6 );",
        "  float aspect = projectionMatrix[ 1 ][ 1 ] / projectionMatrix[ 0 ][ 0 ];",
        "  gl_Position.xy += d * vec2( 1.0 / aspect, 1.0 ) * outlineWidth * 2.2 * color.a * gl_Position.w; }",
      ].join("\n"));
  };
  mat.customProgramCacheKey = () => "bamt-chibi-outline";
  return mat;
}

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
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.canvas);
    // no panning; between a little from below and well from above, between the bust and a step back
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, enablePan: false, zoomSpeed: 0.8,
      minPolarAngle: Math.PI * 0.30, maxPolarAngle: Math.PI * 0.56 });
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
    const json = gltf.parser.json;
    const ex = json.extras || {};
    const textures = await Promise.all((json.textures || []).map((_, i) => gltf.parser.getDependency("texture", i)));
    const nodes = await Promise.all((json.nodes || []).map((_, i) => gltf.parser.getDependency("node", i)));
    if (this.disposed) { for (const t of textures) t.dispose(); return; }
    for (const t of textures) { t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; }
    this.textures = textures; // some are only in shader uniforms (mask, mouth): disposed by hand
    // the mouth atlas comes as a texture of the EyeMouth material (_MouthTileTex)
    const mats = json.materials || [];
    const eye = mats.find((m) => m.extras?.kind === "eyemouth" && m.extras.textures?._MouthTileTex);
    if (eye) {
      const t = eye.extras.textures._MouthTileTex;
      this.mouth = { texture: textures[t.index], scale: t.scale, offset: { value: new THREE.Vector2(...t.offset) },
        cols: eye.extras.floats?._MouthTileCols || 8, rows: eye.extras.floats?._MouthTileRows || 8 };
    }
    const root = gltf.scene;
    const outlines = [];
    root.traverse((o) => {
      const node = json.nodes[gltf.parser.associations.get(o)?.nodes];
      if (node?.extras?.hidden) o.visible = false;
      if (!o.isMesh) return;
      o.frustumCulled = false;
      const mex = mats[gltf.parser.associations.get(o.material)?.materials]?.extras || {};
      const texs = {};
      for (const [k, v] of Object.entries(mex.textures || {})) texs[k] = textures[v.index];
      o.material = toonMaterial(o.material, mex, texs, this.mouth);
      if (o.isSkinnedMesh && o.geometry.attributes._outline && !FLAT.includes(mex.kind)) {
        const ol = new THREE.SkinnedMesh(o.geometry, outlineMaterial(mex, o.material.map));
        ol.bind(o.skeleton, o.bindMatrix);
        ol.frustumCulled = false;
        ol.name = `${o.name}_outline`;
        outlines.push([o, ol]);
      }
    });
    for (const [o, ol] of outlines) o.add(ol); // shown and hidden with its mesh
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
    this.addShadow();
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
  // (where the character stands, as on the formation screen; weapons and props would pull a box centre aside) at
  // half the height, and rises to the face as the camera closes in.
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
    this.target = new THREE.Vector3(origin.x, all.getCenter(new THREE.Vector3()).y, origin.z);
    this.faceY = body.min.y + (body.max.y - body.min.y) * 0.78; // a chibi's face sits in the top quarter
    this.controls.target.copy(this.target);
    if (this.shadow) {
      this.shadow.position.set(origin.x, body.min.y + 0.002, origin.z);
      this.shadow.scale.setScalar(body.getSize(new THREE.Vector3()).y * 0.62);
    }
  }

  fitDistance(fill) {
    return (this.size.y / fill) / 2 / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  }

  // the front view, a little from above
  homeDirection() {
    const el = THREE.MathUtils.degToRad(ELEVATION);
    return new THREE.Vector3(0, Math.sin(el), Math.cos(el));
  }

  // switch between the framing beside the panel and fullscreen; the orbit angle and the zoom (relative to the
  // fit) stay as they were
  frameTo(mode, snap = false) {
    this.mode = FRAMES[mode] ? mode : "left";
    const f = FRAMES[this.mode];
    if (!this.size) { this.view = { x: f.x, y: f.y }; this.applyView(); return; }
    const fit = this.fitDistance(f.fill);
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

  // a soft round shadow under the feet, as on the formation screen
  addShadow() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d"), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(20,30,50,.28)");
    grad.addColorStop(0.65, "rgba(20,30,50,.16)");
    grad.addColorStop(1, "rgba(20,30,50,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = -1;
    this.scene.add(m);
    this.shadow = m;
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
    this.mouth.offset.value.set((tile % 100) / this.mouth.cols, Math.floor(tile / 100) / this.mouth.rows);
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
    this.renderer.render(this.scene, this.camera);
  }

  // a still of the upper body for the switch card (rendered and read in one go: the drawing buffer is not kept)
  snapshot(aspect = 450 / 253) {
    if (!this.root) return null;
    this.renderer.render(this.scene, this.camera);
    const W = this.canvas.width, H = this.canvas.height, px = W / (this.host.clientWidth || 1);
    const fill = FRAMES[this.mode].fill;
    const ch = H * fill * 0.5, cw = ch * aspect, cy = this.view.y * px - H * fill * 0.18;
    const x0 = Math.max(0, Math.min(W - cw, this.view.x * px - cw / 2)), y0 = Math.max(0, Math.min(H - ch, cy - ch / 2));
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
