// Preview failures also reach the session log in release builds.
import { rpc } from "./api.js";

export function previewError(error, url, step) {
  const cause = error instanceof Error ? error : new Error(String(error));
  if (cause.previewReported) return cause;
  cause.previewReported = true;
  const detail = { url: cause.url || url || "", step: cause.step || step, error: cause.stack || cause.message };
  console.error("Preview failed", detail, cause);
  rpc("preview.failed", detail, { timeout: 3000 }).catch((err) => console.error("Preview log failed", err));
  return cause;
}

export function atStep(error, url, step) {
  const cause = error instanceof Error ? error : new Error(String(error));
  cause.url ||= url;
  cause.step ||= step;
  return cause;
}
