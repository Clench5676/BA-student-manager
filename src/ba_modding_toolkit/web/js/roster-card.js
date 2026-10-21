// Share the game's actual card silhouette with the count band, including its clipped lower corner.
export async function clipRosterBand(view, root) {
  await Promise.all(view.images || []);
  const frame = view.nodes.get(`${root}/BG`)?.els[0];
  const band = view.nodes.get(`${root}/Sort/Sprite`)?.els[0];
  const portrait = view.nodes.get(`${root}/Char_Portrait`)?.els[0];
  if (!frame || !band) return;
  const x = parseFloat(frame.style.left) - parseFloat(band.style.left);
  const y = parseFloat(frame.style.top) - parseFloat(band.style.top);
  Object.assign(band.style, { webkitMaskImage: frame.style.backgroundImage, webkitMaskSize: `${frame.style.width} ${frame.style.height}`,
    webkitMaskPosition: `${x}px ${y}px`, webkitMaskRepeat: "no-repeat", maskImage: frame.style.backgroundImage, maskSize: `${frame.style.width} ${frame.style.height}`,
    maskPosition: `${x}px ${y}px`, maskRepeat: "no-repeat" });
  // Crop the texture's fractional last column instead of enlarging the tag beyond the frame.
  if (portrait) portrait.style.clipPath = "inset(0 0.5px 0 0)";
}
