// Prove atlas density behavior with the shipped runtime, without DOM, GPU or game art.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const context = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array,
  Uint16Array, Int16Array, Int32Array, ArrayBuffer, DataView });
vm.runInContext(readFileSync(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), context);
const S = context.spine;

for (const degrees of [0, 90, 180, 270]) {
  test(`unchanged atlas retains UVs and attachment geometry on 2x textures, rotation ${degrees}`, () => {
    const text = `page.png\nsize: 32,24\nbody\n bounds: 4,3,6,4\n offsets: 1,2,9,12\n rotate: ${degrees}\n`;
    function load(scale) {
      const atlas = new S.TextureAtlas(text);
      atlas.setTextures({ get: () => ({ getImage: () => ({ width: 32 * scale, height: 24 * scale }),
        setFilters() {}, setWraps() {} }) });
      const data = new S.SkeletonJson(new S.AtlasAttachmentLoader(atlas)).readSkeletonData({
        skeleton: { spine: "4.2.33" }, bones: [{ name: "root" }],
        slots: [{ name: "body", bone: "root", attachment: "body" },
          { name: "mesh", bone: "root", attachment: "mesh" }],
        skins: [{ name: "default", attachments: {
          body: { body: { width: 9, height: 12 } },
          mesh: { mesh: { type: "mesh", path: "body", width: 9, height: 12,
            uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0],
            vertices: [-4.5, -6, 4.5, -6, 4.5, 6, -4.5, 6], hull: 4 } },
        } }],
      });
      const skeleton = new S.Skeleton(data);
      return { atlas, attachment: skeleton.slots[0].getAttachment(), mesh: skeleton.slots[1].getAttachment() };
    }
    const a = load(1), b = load(2);
    assert.equal(b.atlas.pages[0].width, 32);
    assert.equal(b.atlas.pages[0].height, 24);
    for (const field of ["u", "v", "u2", "v2", "width", "height", "originalWidth", "originalHeight", "offsetX", "offsetY"])
      assert.equal(a.atlas.regions[0][field], b.atlas.regions[0][field], field);
    assert.equal(b.atlas.regions[0].u, 4 / 32);
    assert.equal(b.atlas.regions[0].v, 3 / 24);
    assert.deepEqual(Array.from(a.attachment.uvs), Array.from(b.attachment.uvs));
    assert.deepEqual(Array.from(a.attachment.offset), Array.from(b.attachment.offset));
    assert.deepEqual(Array.from(a.mesh.uvs), Array.from(b.mesh.uvs));
    assert.deepEqual(Array.from(a.mesh.vertices), Array.from(b.mesh.vertices));
  });
}
