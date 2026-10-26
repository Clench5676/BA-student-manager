// Chinese captions may share the other Chinese script, never an unrelated spoken language.
export function dialogueText(row, language) {
  const keys = language === "zh-CN" ? ["zh-CN", "zh-TW"]
    : language === "zh-TW" ? ["zh-TW", "zh-CN"] : [language, "ja", "en", "zh-CN"];
  for (const key of keys) {
    const text = row?.[key];
    if (typeof text === "string" && text.trim()) return { text, language: key };
  }
  return null;
}
