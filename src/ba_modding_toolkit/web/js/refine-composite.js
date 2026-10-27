// The caller supplies the shipped Spine runtime. All posing uses its public API.
function load(S, atlasText, skeletonData) {
  const atlas = new S.TextureAtlas(atlasText);
  atlas.setTextures({ get: () => ({ getImage: () => ({ width: 1, height: 1 }), setFilters() {}, setWraps() {} }) });
  const loader = new S.AtlasAttachmentLoader(atlas);
  const data = ArrayBuffer.isView(skeletonData)
    ? new S.SkeletonBinary(loader).readSkeletonData(skeletonData)
    : new S.SkeletonJson(loader).readSkeletonData(skeletonData);
  return { atlas, data };
}

export function poseSetup(S, atlasText, skeletonData, replacements = {}) {
  const { atlas, data } = load(S, atlasText, skeletonData);
  const skeleton = new S.Skeleton(data);
  skeleton.setToSetupPose();
  for (const [slot, name] of Object.entries(replacements)) {
    if (!skeleton.findSlot(slot)) throw new Error(`Unknown slot: ${slot}`);
    skeleton.setAttachment(slot, name);
  }
  skeleton.updateWorldTransform(S.Physics.reset);
  return geometry(S, atlas, data, skeleton);
}

function idleAnimation(data) {
  return data.findAnimation('Idle_01') ?? data.animations.find(a => /^idle/i.test(a.name));
}

// Times are per-track seconds, including non-looping blink endpoints.
export function poseTracks(S, atlasText, skeletonData, tracks = null) {
  const { atlas, data } = load(S, atlasText, skeletonData);
  const skeleton = new S.Skeleton(data);
  skeleton.setToSetupPose();
  const state = new S.AnimationState(new S.AnimationStateData(data));
  tracks ??= defaultTracks(data);
  const seen = new Set();
  for (const { track, animation, time = 0, loop = track !== 2 } of tracks) {
    if (![0, 1, 2].includes(track) || seen.has(track)) throw new Error('Invalid or duplicate track');
    if (!Number.isFinite(time) || time < 0) throw new Error('Invalid track time');
    if (!data.findAnimation(animation)) throw new Error(`Unknown animation: ${animation}`);
    seen.add(track);
    state.setAnimation(track, animation, loop).trackTime = time;
  }
  state.apply(skeleton);
  skeleton.updateWorldTransform(S.Physics.update);
  return geometry(S, atlas, data, skeleton);
}

function defaultTracks(data, expression = '00', idleTime = 0) {
  const idle = idleAnimation(data), tracks = [];
  if (idle) tracks.push({ track: 0, animation: idle.name, time: idleTime, loop: true });
  if (data.findAnimation(expression)) tracks.push({ track: 1, animation: expression, time: 0, loop: true });
  return tracks;
}

export function listPoses(S, atlasText, skeletonData, { idleFrames = 8, blinkFrames = 3 } = {}) {
  for (const n of [idleFrames, blinkFrames]) {
    if (!Number.isInteger(n) || n < 0) throw new Error('Frame counts must be nonnegative integers');
  }
  const { data } = load(S, atlasText, skeletonData);
  const poses = [{ name: 'base', tracks: defaultTracks(data) }];
  for (const a of data.animations.filter(a => /^\d{2}$/.test(a.name) && a.name !== '00')
    .sort((a, b) => a.name.localeCompare(b.name))) {
    poses.push({ name: a.name, tracks: defaultTracks(data, a.name) });
  }
  const blink = data.findAnimation('Eye_Close_01');
  if (blink) for (let i = 0; i < blinkFrames; i++) {
    poses.push({ name: `blink-${i}`, tracks: [...defaultTracks(data), {
      track: 2, animation: blink.name, time: blinkFrames === 1 ? 0 : blink.duration * i / (blinkFrames - 1), loop: false,
    }] });
  }
  const idle = idleAnimation(data);
  if (idle) for (let i = 0; i < idleFrames; i++) {
    poses.push({ name: `idle-${i}`, tracks: defaultTracks(data, '00', idle.duration * i / idleFrames) });
  }
  return poses;
}

function geometry(S, atlas, data, skeleton) {
  const rgba = c => [c.r, c.g, c.b, c.a];
  const attachments = [], clip = new S.SkeletonClipping();
  for (const slot of skeleton.drawOrder) {
    const a = slot.getAttachment();
    if (!slot.bone.active || !a) { clip.clipEndWithSlot(slot); continue; }
    if (a instanceof S.ClippingAttachment) { clip.clipStart(slot, a); continue; }
    if (!(a instanceof S.RegionAttachment || a instanceof S.MeshAttachment)) {
      clip.clipEndWithSlot(slot); continue;
    }
    if (skeleton.color.a * slot.color.a * a.color.a <= 0) { clip.clipEndWithSlot(slot); continue; }
    let vertices = new Float32Array(a instanceof S.RegionAttachment ? 8 : a.worldVerticesLength);
    if (a instanceof S.RegionAttachment) a.computeWorldVertices(slot, vertices, 0, 2);
    else a.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
    let triangles = a instanceof S.RegionAttachment ? [0, 1, 2, 2, 3, 0] : Array.from(a.triangles);
    let uvs = Array.from(a.uvs);
    if (clip.isClipping()) {
      clip.clipTrianglesUnpacked(vertices, triangles, triangles.length, uvs);
      vertices = clip.clippedVertices.slice(); uvs = clip.clippedUVs.slice(); triangles = clip.clippedTriangles.slice();
    }
    if (!Array.from(vertices).every(Number.isFinite) || !uvs.every(Number.isFinite)) throw new Error('Non-finite posed geometry');
    if (triangles.length) attachments.push({ slot: slot.data.name, attachment: a.name,
      region: { page: a.region.page.name, name: a.region.name, index: a.region.index },
      vertices: Array.from(vertices), uvs, triangles, blend: slot.data.blendMode,
      slotColor: rgba(slot.color), attachmentColor: rgba(a.color), skeletonColor: rgba(skeleton.color) });
    clip.clipEndWithSlot(slot);
  }
  clip.clipEnd();
  // Define 1x from the largest drawn UV triangle, avoiding tiny halo trim rounding.
  let largest = 0, textureDensity = 1;
  for (const a of attachments) {
    const p = atlas.pages.find(p => p.name === a.region.page);
    for (let t = 0; t < a.triangles.length; t += 3) {
      const ids = a.triangles.slice(t, t + 3);
      const area = (v, sx, sy) => {
        const [i, j, k] = ids.map(i => i * 2);
        return Math.abs(((v[j] - v[i]) * (v[k + 1] - v[i + 1]) - (v[k] - v[i]) * (v[j + 1] - v[i + 1])) * sx * sy);
      };
      const uvArea = area(a.uvs, p.width, p.height), worldArea = area(a.vertices, 1, 1);
      if (uvArea > largest && worldArea > 0) { largest = uvArea; textureDensity = Math.sqrt(uvArea / worldArea); }
    }
  }
  return { version: 1, textureDensity, pages: atlas.pages.map(p => ({ name: p.name, width: p.width, height: p.height, pma: p.pma })),
    attachments, slotAttachments: Object.fromEntries(skeleton.slots.map(s => [s.data.name, s.getAttachment()?.name ?? null])), choices: (data.defaultSkin?.getAttachments() ?? []).map(e => ({ slot: data.slots[e.slotIndex].name, attachment: e.name })) };
}
