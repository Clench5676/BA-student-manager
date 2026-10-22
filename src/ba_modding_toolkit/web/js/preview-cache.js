// Default-on, revision-addressed PNG persistence with an explicit opt-out. Only the authenticated backend
// writes user-space files; browser HTTP/storage caches never retain heavy art.
import { rpc } from "./api.js";
import { withTimeout } from "./async.js";

const MAX_PNG = 2 * 1024 * 1024;
async function hashKey(key) {
  const bytes = new TextEncoder().encode(`preview-stills-v1:${key}`);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function encode(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

export function createPreviewCache({ request = rpc, digest = hashKey, fetchImage = (url) => fetch(url), timeout = 15000,
  makeUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/png" })) } = {}) {
  let enabled = false, generation = "", epoch = 0;
  // Optional storage must never hold visible thumbnail readiness indefinitely.
  // The transport aborts its HTTP request; the outer bound also covers injected transports.
  const call = (method, args) => withTimeout(request(method, args, { timeout }), timeout, method);
  const valid = (ticket) => !!ticket && enabled && ticket.epoch === epoch && ticket.generation === generation;
  const configure = (prefs) => {
    const next = prefs?.previewCache !== false, token = prefs?.previewCacheGeneration || "";
    if (enabled !== next || generation !== token) { enabled = next; generation = token; epoch++; }
  };
  const ticket = (key) => enabled && generation ? { key, generation, epoch } : null;
  const keyOf = (item) => item.hash ||= Promise.resolve().then(() => digest(item.key));
  const observe = (reply) => {
    if (reply?.generation) configure({ previewCache: typeof reply.allowed === "boolean" ? reply.allowed : enabled, previewCacheGeneration: reply.generation });
  };
  return {
    configure, ticket,
    async assetTicket(current, paths) {
      if (!valid(current)) return null;
      if (!paths.length) return current;
      try {
        const reply = await call("preview.assetRevision", { paths });
        if (!valid(current)) return null;
        observe(reply);
        if (!valid(current) || !/^[a-f0-9]{64}$/.test(reply?.revision || "")) return null;
        return { ...ticket(JSON.stringify([current.key, reply.revision])), dependencies: paths, dependencyRevision: reply.revision };
      } catch { return null; }
    },
    async modelTicket(key, variant, source) {
      const current = ticket(key);
      if (!current) return null;
      try {
        const reply = await call("preview.modelRevision", { variant, source });
        if (!valid(current)) return null;
        observe(reply);
        if (!valid(current) || !/^[a-f0-9]{64}$/.test(reply?.revision || "")) return null;
        return { ...ticket(JSON.stringify([key, reply.revision])), model: { variant, source }, modelRevision: reply.revision };
      } catch { return null; }
    },
    async get(current, { signal } = {}) {
      if (!valid(current) || signal?.aborted) return null;
      try {
        const key = await keyOf(current);
        if (!valid(current) || signal?.aborted) return null;
        const reply = await call("preview.cacheGet", { key });
        if (!valid(current) || signal?.aborted) return null;
        observe(reply);
        if (!valid(current) || signal?.aborted || !reply?.allowed || typeof reply.data !== "string"
            || reply.data.length > Math.ceil(MAX_PNG / 3) * 4) return null;
        const binary = atob(reply.data);
        if (!binary.length || binary.length > MAX_PNG) return null;
        return makeUrl(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
      } catch { return null; }
    },
    async put(current, url) {
      if (!valid(current) || !url?.startsWith("blob:")) return false;
      try {
        const key = await keyOf(current);
        if (!valid(current)) return false;
        const response = await fetchImage(url), blob = await response.blob();
        // Oversized lossless pictures remain memory-only; never reduce quality to fit.
        if (!valid(current) || blob.type !== "image/png" || !blob.size || blob.size > MAX_PNG) return false;
        const data = encode(new Uint8Array(await blob.arrayBuffer()));
        if (!valid(current)) return false;
        if (current.dependencies || current.model) {
          const reply = await call(current.model ? "preview.modelRevision" : "preview.assetRevision",
            current.model || { paths: current.dependencies });
          if (!valid(current) || reply?.generation !== current.generation
              || reply?.revision !== (current.modelRevision || current.dependencyRevision)) return false;
        }
        return !!await call("preview.cachePut", { key, data, generation: current.generation });
      } catch { return false; }
    },
  };
}

export const previewCache = createPreviewCache();
