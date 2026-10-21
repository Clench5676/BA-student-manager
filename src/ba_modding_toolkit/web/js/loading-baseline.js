// Range fallback uses measured font metrics only. The normal browser path uses
// a zero-height inline block whose bottom is the text's actual alphabetic baseline.
export const rangeBaseline = (rect, metrics) => rect.top
  + (rect.height - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;

export function domBaseline(root) {
  const label = root.querySelector?.(".ngui span") || root.querySelector?.(".ngui") || root;
  const probe = document.createElement("span");
  Object.assign(probe.style, { display: "inline-block", width: "0", height: "0", padding: "0", margin: "0", border: "0",
    fontSize: "0", lineHeight: "0", verticalAlign: "baseline" });
  label.appendChild(probe);
  try { return probe.getBoundingClientRect().top; } finally { probe.remove(); }
}

export function alignBaseline(element, target, stage, measure = domBaseline) {
  const rect = stage.getBoundingClientRect(), scale = rect.width / 1920;
  if (!(scale > 0)) return false;
  const baseline = measure(element);
  if (!Number.isFinite(baseline)) return false;
  const delta = (rect.top + target * scale - baseline) / scale;
  element.baselineShift = (element.baselineShift || 0) + delta;
  element.style.transform = `translateY(${element.baselineShift}px)`;
  return true;
}

export function publishAligned(host, next, target, stage, measure = domBaseline) {
  if (!alignBaseline(next, target, stage, measure)) return false;
  next.style.visibility = "";
  host.replaceChildren(next);
  return true;
}
