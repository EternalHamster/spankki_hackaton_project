const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only these inline marks produce HTML. Model text, raw HTML and links stay escaped.
export function formatInline(text) {
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

export function formatCoachText(text) {
  const blocks = [];
  let paragraph = [], list = [], listType = '', listStart = 1;
  const flushParagraph = () => {
    // Parse the entire block so a model's line wrapping cannot split a bold span.
    if (paragraph.length) blocks.push(`<p>${formatInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<${listType}${listType === 'ol' && listStart !== 1 ? ` start="${listStart}"` : ''}>${list.map(item => `<li>${formatInline(item)}</li>`).join('')}</${listType}>`);
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
      flushParagraph(); flushList(); blocks.push(`<p><strong>${formatInline(heading[1])}</strong></p>`);
    } else if (list.length) {
      // Markdown list items can continue on the following line, with or without indentation.
      list[list.length - 1] += '\n' + line.trim();
    } else { paragraph.push(line); }
  }
  flushParagraph(); flushList();
  return blocks.join('');
}
