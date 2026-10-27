// Setup geometry only. The caller supplies the App's shipped Spine 4.2 runtime.
// No DOM, texture upload, animation sampling, or runtime implementation is needed.
export function poseSetup(S, atlasText, skeletonData, replacements = {}) {
  const atlas = new S.TextureAtlas(atlasText);
  const loader = new S.AtlasAttachmentLoader(atlas);
  const binary = ArrayBuffer.isView(skeletonData);
  const data = binary ? new S.SkeletonBinary(loader).readSkeletonData(skeletonData)
    : new S.SkeletonJson(loader).readSkeletonData(skeletonData);
  const skeleton = new S.Skeleton(data);
  skeleton.setToSetupPose();
  for (const [slot, name] of Object.entries(replacements)) {
    if (!skeleton.findSlot(slot)) throw new Error(`Unknown slot: ${slot}`);
    skeleton.setAttachment(slot, name);
  }
  skeleton.updateWorldTransform(S.Physics.reset);
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
    if (!Array.from(vertices).every(Number.isFinite) || !uvs.every(Number.isFinite)) throw new Error('Non-finite setup geometry');
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
    attachments, choices: (data.defaultSkin?.getAttachments() ?? []).map(e => ({ slot: data.slots[e.slotIndex].name, attachment: e.name })) };
}
