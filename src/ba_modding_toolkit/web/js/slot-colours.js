// The slot colours of a lobby skeleton as the shaders of its atlas pages take them (lobby.json layer "shaders", each
// page's shader by the page's name). spine-unity hands every shader the slot colour as a premultiplied vertex colour
// in gamma space (an additive slot with alpha 0, PMA vertex colours being on in every lobby prefab); what the shader
// does with it in Unity's linear colour space is in its compiled vertex program (D3D11, the PC client's shader bundles):
// - Spine/Skeleton and spine-unity's blend-mode shaders convert it with PMAGammaToTargetSpace: the colour divided by
//   its alpha, decoded to linear and multiplied by the alpha again; a colour with alpha 0 (additive) decoded as a whole.
// - Spine/Skeleton MX Standard (the pages of 97 lobbies) and its NoiseFlowAnimation variant pass it on as it is
//   (mov o2, v2): their fragment program multiplies the texel, premultiplied by its own alpha, by the colour, gamma
//   values and all. A slot at 50 % grey darkens its texture to 0.5 in linear light (188 of 255 on screen, not 128),
//   and an additive slot at alpha 0.42 adds 0.42 of its texture (not 0.15): Takane's aurora, Yakumo's halo.
// Without the page's shader (no prefab data, or one not read here) a slot is decoded.
import { pageOf } from "./skeleton-parts.js";

const exact = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const asIs = (c) => c;
export const CURVES = Object.freeze({ exact, asIs });

const BY_SHADER = Object.freeze({
  "Spine/Skeleton MX Standard": asIs,
  "Spine/Skeleton MX Standard - NoiseFlowAnimation": asIs,
});

// the curve a shader decodes the vertex colours with
export const curveOf = (shader) => BY_SHADER[shader] || exact;

export let byShader = true; // for checks: false decodes every slot, whatever its page's shader
export const setByShader = (on) => { byShader = !!on; };

// a layer's curve for an attachment, by the page it lies on (linear.js setCurves); null when the layer has no page
// shaders, which keeps every slot decoded
export function curvesOf(layer) {
  const byPage = new Map(Object.entries(layer?.shaders || {}).map(([page, shader]) => [page, curveOf(shader)]));
  if (!byPage.size) return null;
  return (attachment) => (byShader && byPage.get(pageOf(attachment))) || exact;
}
