export const LANGUAGE_KEY = 'oma-talous-language';
export const isLanguage = value => value === 'fi' || value === 'en';
let fallback = 'fi', unsaved = false;
export function getLanguage() {
  if (!unsaved) {
    try { const saved = globalThis.localStorage?.getItem(LANGUAGE_KEY); fallback = isLanguage(saved) ? saved : 'fi'; }
    catch { /* Keep the current visit's choice when storage is unavailable. */ }
  }
  return fallback;
}
export function setLanguage(language) {
  if (!isLanguage(language)) throw new TypeError('Unknown language');
  fallback = language;
  try { globalThis.localStorage.setItem(LANGUAGE_KEY, language); unsaved = false; }
  catch { unsaved = true; }
  return { language, persisted: !unsaved };
}
export const locale = () => getLanguage() === 'en' ? 'en-GB' : 'fi-FI';
export const LANGUAGE_RULES = Object.freeze({
  fi: 'APPLICATION LANGUAGE: FINNISH. Every user-visible answer, heading, explanation, suggestion and generated goal title must be entirely in Finnish. This explicit application setting overrides the language of the question, history, source material and other default language instructions. Translate quoted explanations instead of repeating another language. Keep proper names, factual figures, dates and internal JSON keys unchanged.',
  en: 'APPLICATION LANGUAGE: ENGLISH (British English). Every user-visible answer, heading, explanation, suggestion and generated goal title must be entirely in English. This explicit application setting overrides the language of the question, history, source material and other default language instructions. Translate Finnish source text, category names, labels and units; never copy Finnish prose into the answer. Keep proper names, factual figures, dates and internal JSON keys unchanged.',
});
