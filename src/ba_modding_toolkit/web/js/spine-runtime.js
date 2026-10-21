import { rpc } from "./api.js";

const ROOT = "vendor/spine-player-4.2.120/";
let choice, reading = null, loading = null, started = false;

// A loaded script cannot be unloaded safely while players are alive. Withdrawal applies at the next start.
export function setSpineConsent(value) {
  choice = typeof value === "boolean" ? value : null;
}

export const spineAllowed = () => started || choice === true;
export const runtimeLoaded = () => started;

// Every preview entry awaits this before using the runtime, including readers that do not create a player.
export async function ensureSpine() {
  if (choice === undefined) {
    reading ||= rpc("app.spineConsent").then((value) => {
      if (choice === undefined) setSpineConsent(value);
    }).finally(() => { reading = null; });
    await reading;
  }
  if (!spineAllowed()) return false;
  if (globalThis.spine) { started = true; return true; }
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const css = document.createElement("link"), script = document.createElement("script");
      css.rel = "stylesheet";
      css.href = `${ROOT}spine-player.css`;
      script.src = `${ROOT}spine-player.min.js`;
      const fail = (message) => {
        script.remove(); css.remove();
        reject(new Error(message));
      };
      script.onload = () => globalThis.spine ? resolve(true) : fail("Spine runtime unavailable");
      script.onerror = () => fail("Spine runtime failed to load");
      started = true;
      document.head.appendChild(css);
      document.head.appendChild(script);
    }).catch((err) => { loading = null; throw err; });
  }
  return loading;
}
