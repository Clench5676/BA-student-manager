// Ordinary LobbyCommon/ChatDialog/Talk balloon; original NGUI sprite, font and padding follow the clicked actor.
import * as NGUI from "./ngui.js";
import { rpc as defaultRpc } from "./api.js";
import { language } from "./i18n.js";
import { S } from "./util.js";
import { talkExpression } from "./student-hall-portraits.js";
import { spriteBorders, sliceAxis, slicePoint } from "./sprite-slices.js";

const LANGS = { "en-US": "en", "zh-CN": "zh-CN", "zh-TW": "zh-TW", "ja-JP": "ja", "ko-KR": "ko", "th-TH": "th" };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const PREPARE_TIMEOUT = 25000, TEXT_LIFETIME = 5000;
const UNAVAILABLE_BACKOFF = 30000;
const MISSING_DIALOGUE = new Set(["lines_unavailable", "catalog_variant_not_found", "variant_not_found"]);
// Common/Lobby_balloon's 136 x 146 atlas silhouette: the rounded body is [38,4]..[128,129] at half alpha.
// Its left-pointing tail and translucent outer shadow are outside this rectangle. These are geometry, not pixels.
const BALLOON_BODY = { width: 136, height: 146, rect: [38, 4, 128, 129],
  borderLeft: 80, borderRight: 50, borderTop: 84, borderBottom: 60 };

export function memoryMemo(maxBytes = 32 * 1024 * 1024, maxEntries = 128) {
  const values = new Map(), flights = new Map(); let bytes = 0, alive = true;
  return {
    async get(key, read, size = (value) => JSON.stringify(value).length * 2, signal = null) {
      const cached = values.get(key);
      if (cached && cached.expires > Date.now()) { values.delete(key); values.set(key, cached); return cached.value; }
      if (cached) { values.delete(key); bytes -= cached.size; }
      const running = flights.get(key);
      if (running && !running.signal?.aborted) return running.promise;
      const pending = Promise.resolve().then(() => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return read();
      }).then((value) => {
        const length = size(value);
        if (alive && !signal?.aborted && length <= maxBytes) {
          values.set(key, { value, size: length, expires: value?.pending || value?.animationPending ? Date.now() + 1500
            : value?.unavailable ? Date.now() + UNAVAILABLE_BACKOFF : Infinity }); bytes += length;
          while (bytes > maxBytes || values.size > maxEntries) {
            const first = values.keys().next().value; bytes -= values.get(first).size; values.delete(first);
          }
        }
        return value;
      }).finally(() => { if (flights.get(key)?.promise === pending) flights.delete(key); });
      flights.set(key, { promise: pending, signal }); return pending;
    },
    forgetPending(key) {
      const cached = values.get(key);
      if (cached?.value?.pending || cached?.value?.animationPending) { values.delete(key); bytes -= cached.size; }
    },
    clear() { alive = false; values.clear(); flights.clear(); bytes = 0; },
    size: () => bytes,
  };
}

export function wrapDialogue(text, fontSize, maxWidth, measure, lang = "en") {
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(lang, { granularity: "word" }) : null;
  const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(lang, { granularity: "grapheme" }) : null;
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    const words = segmenter ? [...segmenter.segment(paragraph)].map((item) => item.segment) : [...paragraph];
    let line = "";
    for (const word of words) {
      const parts = measure(word, fontSize) > maxWidth
        ? graphemes ? [...graphemes.segment(word)].map((item) => item.segment) : [...word] : [word];
      for (const part of parts) {
        if (line && measure(line + part, fontSize) > maxWidth && !/^[\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a,.!?;:)]/.test(part)) {
          lines.push(line.trimEnd()); line = part.trimStart();
        } else line += part;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function balloonPosition(rect, size, bounds = { left: 24, top: 36, right: 1896, bottom: 1044 }) {
  const right = bounds.right - rect.x - rect.width, left = rect.x - bounds.left;
  const flip = right < size.width + 16 && left > right;
  return { x: clamp(flip ? rect.x - size.width - 16 : rect.x + rect.width + 16, bounds.left, bounds.right - size.width),
    y: clamp(rect.y + rect.height * .28 - size.height * .25, bounds.top, bounds.bottom - size.height), flip };
}

export function balloonBody(sprite, meta = BALLOON_BODY) {
  const [top, right, bottom, left] = spriteBorders(meta);
  const x = sliceAxis(meta.width, left, right, sprite.w_ * S, S);
  const y = sliceAxis(meta.height, top, bottom, sprite.h_ * S, S);
  const [x0, y0, x1, y1] = BALLOON_BODY.rect;
  const box = { left: slicePoint(x0 * meta.width / BALLOON_BODY.width, x) / S,
    right: slicePoint(x1 * meta.width / BALLOON_BODY.width, x) / S,
    top: slicePoint(y0 * meta.height / BALLOON_BODY.height, y) / S,
    bottom: slicePoint(y1 * meta.height / BALLOON_BODY.height, y) / S };
  if ((sprite.flip || 0) & 1) [box.left, box.right] = [sprite.w_ - box.right, sprite.w_ - box.left];
  return box;
}

export function prepareBalloon(template, text, rect, { ui = NGUI, lang = "en", bounds } = {}) {
  const tree = structuredClone(template), spriteNode = ui.find(tree, "Sprite"), labelNode = ui.find(tree, "Label");
  const sprite = spriteNode.widgets.find((widget) => "sprite" in widget), label = labelNode.widgets.find((widget) => "text" in widget);
  const left = labelNode.pos[0] - spriteNode.pos[0], top = spriteNode.pos[1] - labelNode.pos[1];
  const right = sprite.w_ - left - label.w_, bottom = sprite.h_ - top - label.h_;
  const fontSize = label.fontSize;
  const lineHeight = Math.max(label.h_ / Math.max(1, String(label.text).split("\n").length),
    (ui.fontSizeFor?.(text, fontSize) || fontSize) * 1.15);
  const measure = ui.glyphWidth;
  const natural = Math.max(...String(text).split(/\r?\n/).map((line) => measure(line, fontSize)));
  let width = clamp(natural > 600 ? Math.ceil(natural / 2) : natural, 260, 840);
  let lines = wrapDialogue(text, fontSize, width, measure, lang);
  while (!String(text).includes("\n") && lines.length > 2 && width < 840 && natural <= 1680) {
    width = Math.min(840, width + fontSize); lines = wrapDialogue(text, fontSize, width, measure, lang);
  }
  const contentWidth = Math.max(90, ...lines.map((line) => measure(line, fontSize)));
  const contentHeight = Math.max(lineHeight, lineHeight * lines.length);
  label.text = lines.join("\n"); label.w_ = contentWidth; label.h_ = contentHeight; label.lang = lang;
  sprite.w_ = left + contentWidth + right; sprite.h_ = top + contentHeight + bottom;
  const size = { width: sprite.w_ * S, height: sprite.h_ * S };
  const position = balloonPosition(rect, size, bounds);
  sprite.flip = position.flip ? (sprite.flip || 0) ^ 1 : sprite.flip || 0;
  const body = balloonBody(sprite, ui.atlasIndex?.()?.[sprite.atlas]?.[sprite.sprite]);
  // A centred UILabel invokes NGUI's existing font-baseline correction. The original top-left pivot cannot
  // compensate for the browser's taller line box and leaves the visible text below the balloon's body centre.
  label.pivot = 4; label.align = 2;
  labelNode.pos = [spriteNode.pos[0] + (body.left + body.right) / 2,
    spriteNode.pos[1] - (body.top + body.bottom) / 2];
  tree.pos = [0, 0];
  return { tree, ...size, ...position };
}

export function createDialogue({ host, actorOf, choiceOf = () => null, info = () => ({}), prefs = () => ({}),
  onError = () => {}, signal, call = defaultRpc, ui = NGUI, audioFactory = (url) => new Audio(url),
  expressions = talkExpression, currentLanguage = language, bounds,
  onDiagnostic = (error, entry) => console.warn("Portrait dialogue unavailable", entry.variant, error) } = {}) {
  const linesCache = memoryMemo(4 * 1024 * 1024, 128), audioCache = memoryMemo(), turns = new Map();
  const unavailable = new Map();
  let token = 0, disposed = false, busy = false, audio = null, url = null, clearTimer = null, prepareTimer = null;
  let speaker = null, bubble = null, expressionKey = null;
  let template = null, layoutFlight = null, current = null, requests = null;
  const preferences = () => typeof prefs === "function" ? prefs() : prefs;
  const information = () => typeof info === "function" ? info() : info;
  const muted = () => information()?.mute || preferences()?.voiceMuted || (preferences()?.voiceVolume ?? 80) === 0;
  function releaseAudio() {
    if (audio) { audio.onended = audio.onerror = audio.ontimeupdate = audio.onseeked = null; audio.pause(); audio = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
  }
  function stop() {
    token++; busy = false; requests?.abort(); requests = null;
    clearTimeout(clearTimer); clearTimeout(prepareTimer); clearTimer = prepareTimer = null; releaseAudio();
    if (speaker) expressions(speaker, false);
    speaker = current = expressionKey = null; bubble?.remove(); bubble = null;
    host?.replaceChildren();
  }
  function finishText(talking = false) {
    // Cancel preparation without releasing the Hall-wide turn until the readable text expires.
    token++; requests?.abort(); requests = new AbortController();
    clearTimeout(prepareTimer); prepareTimer = null; releaseAudio();
    if (talking && current) applyExpression(current.row);
    else if (speaker) { expressions(speaker, false); expressionKey = null; }
    clearTimeout(clearTimer); clearTimer = setTimeout(stop, TEXT_LIFETIME);
  }
  function applyExpression(row, player = null) {
    const elapsed = Number(player?.currentTime) || 0;
    const cue = row.expressionCues?.filter((value) => Number.isFinite(value.time) && value.time <= elapsed).at(-1);
    const expression = cue?.motion || cue?.expression || row.expression;
    if (!expression || !speaker) return;
    const key = JSON.stringify(expression);
    if (key !== expressionKey) { expressions(speaker, true, expression); expressionKey = key; }
  }
  const actor = (entry) => {
    const found = actorOf?.(entry);
    return { actor: found?.actor || found, rect: found?.rect || { x: entry.x - 195 * entry.scale,
      y: entry.y - 850 * entry.scale, width: 390 * entry.scale, height: 850 * entry.scale } };
  };
  const waitPending = (milliseconds, requestSignal) => new Promise((resolve) => {
    if (requestSignal.aborted) { resolve(false); return; }
    let timer;
    const finish = () => {
      clearTimeout(timer); requestSignal.removeEventListener("abort", finish); resolve(!requestSignal.aborted);
    };
    timer = setTimeout(finish, milliseconds); requestSignal.addEventListener("abort", finish, { once: true });
  });
  async function draw(entry, row, my, requestSignal) {
    if (!template && (!layoutFlight || layoutFlight.signal?.aborted)) {
      const flight = { signal: requestSignal };
      flight.promise = Promise.resolve().then(() => call("hall.dialogueLayout", {}, { signal: requestSignal })).then((value) => {
        if (!requestSignal?.aborted) template = value;
        return value;
      }).finally(() => { if (layoutFlight === flight) layoutFlight = null; });
      layoutFlight = flight;
    }
    const saved = template || await layoutFlight.promise;
    if (my !== token || disposed || signal?.aborted) return;
    await ui.init?.();
    const lang = LANGS[currentLanguage()] || "en";
    const chosen = [lang, ...(lang === "zh-TW" ? ["zh-CN"] : []), "ja", "en", "zh-CN"].find((key) => row[key]);
    if (!chosen) return;
    const placement = prepareBalloon(saved, row[chosen], actor(entry).rect, { ui, lang: chosen, bounds });
    const scratch = document.createElement("div");
    Object.assign(scratch.style, { position: "absolute", left: `${placement.x}px`, top: `${placement.y}px`,
      width: `${placement.width}px`, height: `${placement.height}px`, pointerEvents: "none" });
    scratch.setAttribute("role", "status"); scratch.setAttribute("aria-label", row[chosen]);
    await ui.render(placement.tree, scratch, { scale: S, origin: [0, 0] });
    if (my !== token || disposed || signal?.aborted) return;
    bubble?.remove(); bubble = scratch; host.replaceChildren(scratch);
  }
  async function play(entry) {
    if (busy || disposed || signal?.aborted) return;
    const lang = LANGS[currentLanguage()] || "en", cacheKey = `${entry.variant}:${lang}`;
    if ((unavailable.get(cacheKey) || 0) > Date.now()) return;
    unavailable.delete(cacheKey);
    busy = true;
    const controller = requests = new AbortController(), requestSignal = controller.signal;
    const my = token, active = () => my === token && !disposed && !signal?.aborted && !requestSignal.aborted;
    const noDialogue = (error = null) => {
      unavailable.set(cacheKey, Date.now() + UNAVAILABLE_BACKOFF);
      while (unavailable.size > 128) unavailable.delete(unavailable.keys().next().value);
      stop(); if (error) onDiagnostic(error, entry);
    };
    // Network, image decoding and autoplay promises can all stall. Once audio has started only its end/error
    // releases the turn; stalled preparation retains any caption already obtained for one bounded reading period.
    prepareTimer = setTimeout(() => {
      if (!active()) return;
      if (current) finishText();
      else noDialogue({ code: "lines_unavailable", reason: "prepare_timeout" });
    }, PREPARE_TIMEOUT);
    try {
      const delays = [500, 1500, 4000, 9000];
      const caption = (value) => JSON.stringify(Object.values(LANGS).map((key) => value?.[key]));
      let clip = null, row = null, animationPending = false;
      for (let attempt = 0; ; attempt++) {
        let response;
        try {
          response = await linesCache.get(cacheKey,
            () => call("hall.lines", { variant: entry.variant, lang }, { signal: requestSignal }), undefined, requestSignal);
        } catch (error) { if (row && active()) break; throw error; }
        if (!active()) return;
        animationPending = !!response.animationPending;
        const table = response.lines || response, keys = Object.keys(table).filter((key) => /_lobby_\d/.test(key)
          && (table[key]?.voice || Object.values(LANGS).some((lang) => typeof table[key]?.[lang] === "string" && table[key][lang].trim())))
          .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
        if (!clip && keys.length) {
          const index = turns.get(entry.id) || 0;
          clip = keys[index % keys.length]; turns.set(entry.id, index + 1); speaker = actor(entry).actor;
        }
        if (clip && !table[clip]) {
          // Text-only official groups can acquire their actual voice-name prefix once the source finishes loading.
          const suffix = clip.match(/_lobby_\d+(?:_\d+)?$/)?.[0];
          const equivalent = keys.filter((key) => suffix && key.endsWith(suffix));
          if (equivalent.length === 1) clip = equivalent[0];
        }
        if (clip && table[clip]) {
          const next = table[clip], changed = !row || caption(row) !== caption(next);
          row = next; current = { entry, row, clip };
          if (changed) await draw(entry, row, my, requestSignal);
        }
        if (!active()) return;
        if (row?.voice || row && muted() || !response.pending || attempt >= delays.length) break;
        if (!await waitPending(delays[attempt], requestSignal) || !active()) return;
        // Recheck in-flight backend metadata, even while its short frontend pending TTL has not elapsed.
        linesCache.forgetPending(cacheKey);
      }
      if (!active()) return;
      if (!row) { noDialogue(); return; }
      if (!row.voice || muted()) { finishText(true); return; }
      let data;
      try {
        data = await audioCache.get(`${entry.variant}:${clip}`, async () => {
          const response = await call("hall.voice", { variant: entry.variant, clip }, { signal: requestSignal });
          return { bytes: Uint8Array.from(atob(response.audio), (char) => char.charCodeAt(0)), mime: response.mime };
        }, (value) => value.bytes.byteLength, requestSignal);
      } catch { if (active()) finishText(); return; }
      if (!active()) return;
      const now = preferences();
      if (muted()) { finishText(); return; }
      url = URL.createObjectURL(new Blob([data.bytes], { type: data.mime }));
      const player = audio = audioFactory(url);
      player.volume = clamp((now?.voiceVolume ?? 80) / 100, 0, 1);
      player.onended = () => { if (active()) stop(); };
      player.onerror = () => { if (active()) finishText(); };
      player.ontimeupdate = player.onseeked = () => { if (active()) applyExpression(current.row, player); };
      try {
        await player.play();
        if (!active()) { player.pause(); return; }
        clearTimeout(prepareTimer); prepareTimer = null;
        applyExpression(row, player);
        // Captions and local/Kivo audio may be ready before the Global animation metadata. Enrich this same
        // playing line without restarting its voice, replacing its bubble or consuming another dialogue turn.
        if (animationPending) void (async () => {
          for (const delay of delays) {
            if (!await waitPending(delay, requestSignal) || !active()) return;
            linesCache.forgetPending(cacheKey);
            const response = await linesCache.get(cacheKey,
              () => call("hall.lines", { variant: entry.variant, lang }, { signal: requestSignal }), undefined, requestSignal);
            if (!active()) return;
            const next = response.lines?.[clip];
            if (next) { current.row = { ...current.row, ...next }; applyExpression(current.row, player); }
            if (!response.animationPending) return;
          }
        })().catch((error) => { if (active()) onDiagnostic(error, entry); });
      } catch { if (active()) finishText(); }
    } catch (error) { if (active()) { if (MISSING_DIALOGUE.has(error?.code)) noDialogue(error); else { stop(); onError(error, entry); } } }
  }
  function dispose() {
    if (disposed) return;
    stop(); disposed = true; signal?.removeEventListener("abort", dispose);
    linesCache.clear(); audioCache.clear(); turns.clear(); unavailable.clear(); template = layoutFlight = null;
  }
  signal?.addEventListener("abort", dispose, { once: true });
  return { play, stop, dispose, relabel: async () => {
    if (!current) return;
    const shown = current, my = token, requestSignal = requests?.signal, lang = LANGS[currentLanguage()] || "en";
    try {
      const response = await linesCache.get(`${shown.entry.variant}:${lang}`,
        () => call("hall.lines", { variant: shown.entry.variant, lang }, { signal: requestSignal }), undefined, requestSignal);
      if (my !== token || disposed || requestSignal?.aborted) return;
      shown.row = response.lines?.[shown.clip] || shown.row;
      await draw(shown.entry, shown.row, my, requestSignal);
    } catch { /* The current line remains readable when another translation is unavailable. */ }
  },
    preferencesChanged() {
      const settings = preferences();
      if (busy && muted()) { if (current) finishText(); else stop(); }
      else if (audio) audio.volume = clamp((settings?.voiceVolume ?? 80) / 100, 0, 1);
    } };
}
