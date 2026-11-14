import { locale } from './language.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only round recognisable euro amounts for display; keep source answers and
// request history intact, including dates, percentages and non-money decimals.
export function roundEuroText(text) {
  const amount = String.raw`[+−-]?(?:\d{1,3}(?:[., \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
  const unit = String.raw`(?:€|EUR\b|euro(?:s|a|n|lla|on|sta)?\b)`;
  const rounded = raw => {
    const decimal = /[.,](\d{1,2})$/.exec(raw);
    if (!decimal) return raw;
    const value = Number(raw.slice(0, decimal.index).replace(/[.,\s]/g, '').replace('−', '-') + '.' + decimal[1]);
    if (!Number.isFinite(value)) return raw;
    const whole = Math.sign(value) * Math.round(Math.abs(value));
    return (raw.startsWith('+') && whole !== 0 ? '+' : '') + new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(whole || 0);
  };
  return String(text)
    .replace(new RegExp(`(${unit}[ \\u00a0\\u202f]*)(${amount})(?!\\d|[.,]\\d)`, 'g'), (_, prefix, value) => prefix + rounded(value))
    .replace(new RegExp(`(?<![\\w.,])(${amount})([ \\u00a0\\u202f]*(?:\\*\\*|__)?[ \\u00a0\\u202f]*${unit})`, 'g'), (_, value, suffix) => rounded(value) + suffix);
}

// Only these inline marks produce HTML. Model text, raw HTML and links stay escaped.
export function formatInline(text, { keepCents = false } = {}) {
  if (!keepCents) text = roundEuroText(text);
  const tokens = /`([^`\n]+)`|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let html = '', start = 0;
  for (const match of String(text).matchAll(tokens)) {
    html += escape(String(text).slice(start, match.index));
    const tag = match[1] !== undefined ? 'code' : match[2] !== undefined || match[3] !== undefined ? 'strong' : 'em';
    html += `<${tag}>${escape(match.slice(1).find(value => value !== undefined))}</${tag}>`;
    start = match.index + match[0].length;
  }
  return (html + escape(String(text).slice(start))).replace(/\r\n?|\n/g, '<br>');
}

export function formatCoachText(text, options = {}) {
  const blocks = [];
  let paragraph = [], list = [], listType = '', listStart = 1;
  const flushParagraph = () => {
    // Parse the entire block so a model's line wrapping cannot split a bold span.
    if (paragraph.length) blocks.push(`<p>${formatInline(paragraph.join('\n'), options)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<${listType}${listType === 'ol' && listStart !== 1 ? ` start="${listStart}"` : ''}>${list.map(item => `<li>${formatInline(item, options)}</li>`).join('')}</${listType}>`);
    list = []; listType = '';
  };
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const item = /^\s*(?:([-*+•])\s+|(\d{1,3})[.)]\s+)(.+)$/.exec(line);
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushList(); }
    else if (item) {
      flushParagraph();
      const type = item[1] ? 'ul' : 'ol';
      if (listType !== type) { flushList(); listStart = Number(item[2] || 1); }
      listType = type; list.push(item[3]);
    } else if (heading) {
      flushParagraph(); flushList(); blocks.push(`<p><strong>${formatInline(heading[1], options)}</strong></p>`);
    } else if (list.length) {
      // Markdown list items can continue on the following line, with or without indentation.
      list[list.length - 1] += '\n' + line.trim();
    } else { paragraph.push(line); }
  }
  flushParagraph(); flushList();
  return blocks.join('');
}
