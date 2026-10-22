// Runs before styles and the module graph. Recovery needs only the built-in document and local RPC.
(function () {
  "use strict";
  const config = window.BAMT_CONFIG || {}, strings = config.strings || {};
  const T = (key) => strings[key] || key;
  const began = Date.now(), pending = new Set(), timings = {}, seen = new Map(), sent = [];
  let phase = "modules", finished = false, failed = false, panel = null, status = null, reporting = null, presenter = null;
  let webgl = { supported: null, renderer: null, disabled: !!config.safeMode };
  const context = () => ({ page: location.hash || "#/roster", phase, timings,
    userAgent: navigator.userAgent, screen: { width: screen.width, height: screen.height, scale: devicePixelRatio }, webgl });
  async function rpc(method, params = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/rpc", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.code);
      return body.result;
    } finally { clearTimeout(timer); }
  }
  function forward(error, kind = "error", source = "") {
    const event = { kind, message: String(error?.message || error).slice(0, 8000),
      stack: String(error?.stack || "").slice(0, 8000), source: String(source).slice(0, 2000),
      page: location.hash, phase };
    const key = JSON.stringify(event), now = Date.now();
    for (const [k, time] of seen) if (now - time >= 60000) seen.delete(k);
    while (sent.length && now - sent[0] >= 60000) sent.shift();
    if (seen.has(key) || sent.length >= 10) return false;
    seen.set(key, now); sent.push(now);
    rpc("app.frontendError", { event, context: context() }).catch(() => {});
    return true;
  }
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  function button(parent, key, action) {
    const b = el("button", T(key)); b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try { await action(); } catch (error) { status.textContent = T("recovery.actionFailed"); forward(error, "recovery"); }
      finally { b.disabled = false; }
    };
    parent.appendChild(b);
  }
  function shell(title, hint) {
    if (!document.body) { document.addEventListener("DOMContentLoaded", () => shell(title, hint), { once: true }); return false; }
    panel?.remove();
    if (failed || config.safeMode) {
      const stage = document.getElementById?.("stage");
      if (stage) { stage.inert = true; stage.hidden = true; }
    }
    const style = el("style");
    style.textContent = `#bamt-recovery{position:fixed;inset:0;z-index:2147483647;background:#edf6fa;color:#243d52;font:18px system-ui,sans-serif;overflow:auto;padding:8vh 8vw;box-sizing:border-box;text-align:left;user-select:text}#bamt-recovery button{font:inherit;background:#d8f3ff;color:#243d52;border:1px solid #89b9d0;border-radius:5px;padding:12px 18px;margin:8px 12px 8px 0;cursor:pointer}#bamt-recovery p,#bamt-recovery pre{white-space:pre-wrap;overflow-wrap:anywhere}#bamt-recovery pre{max-height:50vh;overflow:auto;font:14px monospace}#bamt-recovery button:disabled{opacity:.5}`;
    panel = el("section"); panel.id = "bamt-recovery"; panel.setAttribute("role", "alert");
    panel.append(style, el("h1", title), el("p", hint));
    status = el("p"); status.setAttribute("role", "status");
    panel.appendChild(status); document.body.appendChild(panel);
    return true;
  }
  function actions() {
    button(panel, "recovery.report", report);
    button(panel, "recovery.logs", () => rpc("app.logFolder"));
  }
  function showFailure() {
    if (!document.body) { document.addEventListener("DOMContentLoaded", showFailure, { once: true }); return; }
    const separator = /^(zh|ja)/.test(config.language) ? "、" : ", ";
    const step = phase.split(", ").map((p) => T(`recovery.phases.${p}`)).join(separator);
    shell(T("recovery.failed"), `${T("recovery.step")}: ${step}`);
    actions();
    button(panel, "recovery.safeRestart", () => rpc("app.restartSafe"));
    button(panel, "recovery.retry", () => location.reload());
  }
  function fail(error, kind = "boot", source = "") {
    forward(error, kind, source);
    if (finished || failed) return;
    failed = true;
    clearTimeout(watchdog);
    showFailure();
  }
  async function report() {
    if (reporting) return reporting;
    reporting = rpc("app.report", { context: context() }).then(async (result) => {
      if (presenter && finished && !failed && !config.safeMode) {
        await presenter(result);
        return result;
      }
      if (!panel) shell(T("recovery.report"), "");
      status.textContent = `${T("recovery.saved")}\n${result.path}\n${T(result.copied ? "recovery.copied" : "recovery.copyFailed")}`;
      if (!result.copied) status.textContent += `\n${result.summary}`;
      if (!failed && !config.safeMode) button(panel, "picker.ok", () => { panel.remove(); panel = null; });
      return result;
    }).catch(async (error) => {
      if (presenter && finished && !failed && !config.safeMode) {
        forward(error, "report");
        await presenter(null);
        return;
      }
      if (!panel) shell(T("recovery.report"), "");
      status.textContent = T("recovery.actionFailed");
      if (!failed && !config.safeMode) button(panel, "picker.ok", () => { panel.remove(); panel = null; });
      forward(error, "report");
    }).finally(() => { reporting = null; });
    return reporting;
  }
  function safeSettings() {
    shell(T("settings.button"), T("recovery.safeHint"));
    actions();
    button(panel, "settings.log.open", async () => {
      const result = await rpc("app.log");
      panel.querySelector("pre")?.remove();
      panel.appendChild(el("pre", result.text));
    });
    button(panel, "picker.ok", safeStart);
  }
  function safeStart() {
    shell(T("recovery.safeOn"), T("recovery.safeHint"));
    actions();
    button(panel, "settings.button", safeSettings);
    location.hash = "#/settings";
    finished = true; phase = "ready"; clearTimeout(watchdog);
    rpc("app.ready", { timings: { boot: Date.now() - began } }).catch(() => {});
  }
  function probe() {
    if (config.safeMode) return;
    try {
      const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      webgl.supported = !!gl;
      if (!gl) return;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      webgl.renderer = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch (error) { webgl = { supported: false, renderer: null, error: String(error) }; }
  }
  const watchdog = setTimeout(() => fail(new Error(`Boot timeout: ${phase}`), "watchdog"), 45000);
  window.BAMTRecovery = {
    report, forward, fail, context, presentReport(fn) { presenter = fn; }, isBooting: () => !finished, failed: () => failed,
    begin(name) { if (finished || failed) return; pending.add(name); if (name !== "boot") phase = name; },
    end(name, elapsed) {
      timings[name] = elapsed; pending.delete(name);
      if (!finished && !failed) phase = [...pending].filter((p) => p !== "boot").join(", ") || name;
    },
    ready() {
      if (failed) return false;
      finished = true; phase = "ready"; clearTimeout(watchdog); probe();
      rpc("app.frontendError", { context: context() }).catch(() => {});
      return true;
    },
  };
  window.addEventListener("error", (event) => {
    const asset = event.target && event.target !== window;
    if (asset && event.target.rel === "icon") return;
    const source = asset ? event.target.src || event.target.href : event.filename;
    const error = event.error || new Error(event.message || `Asset load failed: ${source || "unknown"}`);
    if (!finished && (!asset || !["IMG", "VIDEO", "AUDIO"].includes(event.target.tagName))) fail(error, asset ? "asset" : "error", source);
    else forward(error, asset ? "asset" : "error", source);
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    if (!finished) fail(event.reason, "rejection");
    else forward(event.reason, "rejection");
  });
  if (config.safeMode) document.addEventListener("DOMContentLoaded", safeStart, { once: true });
})();
