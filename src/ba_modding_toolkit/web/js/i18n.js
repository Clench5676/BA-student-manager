// UI strings come from the locale files (webui.* keys, via i18n.strings); names come with the data per language.

let strings = {};
let lang = "zh-CN";

// the app's language -> the key used in name data ({"zh-CN", "zh-TW", "en", "ja", "ko"})
export const NAME_LANG = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja", "ko-KR": "ko" };

export function setStrings(appLang, table) {
  lang = appLang || "zh-CN";
  strings = table || {};
  document.documentElement.lang = lang;
}

export const language = () => lang;

export function T(key, vars = {}) {
  const s = strings[`webui.${key}`] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// the name keys to try for a UI language: its own, then zh-CN for Simplified Chinese and en for the others
// (Traditional Chinese included: a Simplified name in a Traditional screen reads as wrong, like the UI strings,
// i18n.fallback_language), then whatever there is
export function nameKeys(appLang) {
  const own = NAME_LANG[appLang] || appLang;
  const simplified = /^zh(-|$)/i.test(appLang) && !/^zh-(hant|tw|hk|mo)\b/i.test(appLang);
  return [...new Set([own, simplified ? "zh-CN" : "en", "en", "zh-CN"])];
}

// {lang: value} -> the value for the UI language (see nameKeys)
export function L(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of nameKeys(lang)) if (value[key] != null) return value[key];
  return Object.values(value)[0];
}

// the platform decides the file manager's name
export const platform = /Mac/i.test(navigator.platform) ? "mac" : "win";
