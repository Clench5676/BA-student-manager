// UI strings come from the locale files (webui.* keys, via i18n.strings); names come with the data per language.

let strings = {};
let lang = "zh-CN";

// the app's language -> the key used in name data ({"zh-CN", "zh-TW", "en", "ja"})
const NAME_LANG = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja" };

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

// {lang: value} -> the value for the UI language (falls back to zh-CN, then en, then any)
export function L(value) {
  if (!value || typeof value !== "object") return value;
  const key = NAME_LANG[lang] || (lang.startsWith("zh") ? "zh-CN" : "en");
  return value[key] ?? value[lang] ?? value["zh-CN"] ?? value.en ?? Object.values(value)[0];
}

// the platform decides the file manager's name
export const platform = /Mac/i.test(navigator.platform) ? "mac" : "win";
