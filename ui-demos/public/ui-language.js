import { getLanguage, setLanguage, LANGUAGE_KEY } from './language.js';
import { translate } from './translations.js';

const flag = language => language === 'fi'
  ? '<svg class="language-flag" viewBox="0 0 36 22" aria-hidden="true"><rect width="36" height="22" fill="#fff"/><path d="M0 11h36M11 0v22" stroke="#003580" stroke-width="6"/></svg>'
  : '<svg class="language-flag" viewBox="0 0 36 22" aria-hidden="true"><rect width="36" height="22" fill="#012169"/><path d="m0 0 36 22m0-22L0 22" stroke="#fff" stroke-width="5"/><path d="m0 0 36 22m0-22L0 22" stroke="#c8102e" stroke-width="2"/><path d="M18 0v22M0 11h36" stroke="#fff" stroke-width="8"/><path d="M18 0v22M0 11h36" stroke="#c8102e" stroke-width="4"/></svg>';
export const languageButton = () => `<button type="button" class="nav-item language-nav" data-language-menu aria-label="${getLanguage() === 'en' ? 'Choose language' : 'Valitse kieli'}">${flag(getLanguage())}<span>${getLanguage() === 'en' ? 'Language' : 'Kieli'}</span></button>`;

// Localise the rendering boundary, including dynamically inserted dialogs and SVG labels.
// User-written questions, saved personal notes and goal names remain the user's own text.
export function localizeUI(root = document.body) {
  if (getLanguage() !== 'en' || !root) return;
  const skip = 'script, style, [data-no-translate], .chat-message.user p, .coach-response, #chat-memory-facts li>span, .purchase-project h4, #project-proposal-title';
  // A textarea's contents belong to the user; its placeholder and ARIA labels belong to the UI.
  const skipText = `textarea, ${skip}`;
  const translateNode = node => {
    if (!node.parentElement?.closest(skipText)) {
      const value = translate(node.nodeValue, 'en');
      if (value !== node.nodeValue) node.nodeValue = value;
    }
  };
  if (root.nodeType === 3) { translateNode(root); return; }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) translateNode(walker.currentNode);
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!element.getAttribute || element.closest(skip)) continue;
    for (const name of ['aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'title', 'placeholder']) {
      if (element.hasAttribute(name)) {
        const value = translate(element.getAttribute(name), 'en');
        if (value !== element.getAttribute(name)) element.setAttribute(name, value);
      }
    }
  }
}

export function installLanguageUI(onChange) {
  let shownLanguage = getLanguage();
  const metadata = () => {
    document.documentElement.lang = shownLanguage;
    document.title = shownLanguage === 'en' ? 'My finances · Demo' : 'Oma talous · UI-demo';
    document.querySelector('meta[name="description"]')?.setAttribute('content', shownLanguage === 'en'
      ? 'Explore your finances with an AI coach. Ask about spending, your allowance and saving.'
      : 'Tutki omaa talouttasi AI-valmentajan kanssa. Kysy menoista, käyttövarasta ja säästämisestä.');
  };
  const change = language => {
    if (shownLanguage === language) return;
    shownLanguage = language;
    metadata(); onChange();
  };
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-language-menu]')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'language-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><h2>${shownLanguage === 'en' ? 'Language' : 'Kieli'}</h2><button type="button" class="icon-button" data-language-close aria-label="${shownLanguage === 'en' ? 'Close' : 'Sulje'}">×</button></div><div class="language-options" role="group" aria-label="${shownLanguage === 'en' ? 'Choose language' : 'Valitse kieli'}">${[['fi', 'Suomi'], ['en', 'English']].map(([language, name]) => `<button type="button" data-language="${language}" aria-pressed="${shownLanguage === language}" lang="${language}" data-no-translate>${flag(language)}<span>${name}</span></button>`).join('')}</div>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.addEventListener('click', event => {
      const language = event.target.closest('[data-language]')?.dataset.language;
      if (language) { setLanguage(language); dialog.close(); change(language); }
      else if (event.target.closest('[data-language-close]')) dialog.close();
    });
    dialog.showModal();
  });
  window.addEventListener('storage', event => { if (event.key === null || event.key === LANGUAGE_KEY) change(getLanguage()); });
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(node => { if ([1, 3].includes(node.nodeType)) localizeUI(node); });
      else localizeUI(record.target);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'title', 'placeholder'] });
  metadata(); localizeUI();
}
