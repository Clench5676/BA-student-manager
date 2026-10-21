// Shared student identity and job wording for batch and detail actions.
import { L, T } from "./i18n.js";
import { studentName } from "./names.js";

export function progressName(variant, kind, fallback = "", family = variant?.family) {
  const full = L(variant?.names)?.full || fallback;
  const match = full.match(/^(.*?)\s*[（(](.*)[）)]$/u);
  const base = studentName(family, match ? match[1] : full);
  const parts = [match?.[2], kind].filter(Boolean).join(T("progress.comma"));
  return parts ? T("progress.subject", { name: base, parts }) : base;
}

export function jobProgress({ action, name, current = 1, total = 1, step = "" }) {
  const phase = T(action);
  const detail = step && T(step);
  // These phases and steps express the same work even where their grammatical forms differ.
  const repeated = { "import.phase.add": "import.step.add", "import.phase.apply": "import.step.apply",
    "progress.actionApply": "import.step.apply", "progress.actionExtract": "import.step.extract" };
  const suffix = detail && detail !== phase && repeated[action] !== step ? T("progress.step", { step: detail }) : "";
  return T("progress.job", { action: phase.replace(/\{name\}/g, "").replace(/[:：]\s*$/u, "").trim(), name, current, total }) + suffix;
}
