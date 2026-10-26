// Measure with the browser's text layout, including trailing letter spacing and
// script shaping. Canvas font shorthand and glyph counts cannot reproduce it.
export function naturalTextWidth(element, scale = 1, doc = document, styleOf = getComputedStyle) {
  const style = styleOf(element), probe = doc.createElement('span');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
    'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'fontOpticalSizing',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textRendering', 'direction']) probe.style[key] = style[key];
  Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    whiteSpace: 'nowrap', width: 'max-content', maxWidth: 'none', padding: '0', border: '0' });
  probe.lang = element.lang || doc.documentElement.lang;
  probe.textContent = element.textContent;
  doc.body.append(probe);
  try { return Math.ceil(probe.getBoundingClientRect().width * scale); }
  finally { probe.remove(); }
}
