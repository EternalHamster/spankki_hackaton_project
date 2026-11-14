const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// Suggested questions. A template's [gaps] must be filled in by the user before it can be sent.
const SUGGESTIONS = [
  { text: 'Miten aloitan budjetoinnin?' },
  { text: 'Onko minulla varaa ostaa [tuote], joka maksaa [hinta] €?', label: 'Onko minulla varaa…?', hint: 'Lisää tuote ja hinta itse' },
  { text: 'Anna kolme säästövinkkiä arkeen.' },
];
const GAP = /\[(?:tuote|hinta)\]/;
const ready = draft => Boolean(draft.trim()) && !GAP.test(draft);

export function createChatDialog({ modal, detail, icon }) {
  const fresh = () => ({ messages: [], draft: '', pending: false, error: '', insight: null, controller: null });
  let session = fresh();

  function reset() { session.controller?.abort(); session = fresh(); }

  function update() {
    const log = detail.querySelector('#chat-messages');
    if (!log) return;
    log.innerHTML = session.messages.map(m => `<div class="chat-message ${m.role}"><span>${m.role === 'user' ? 'Sinä' : 'Talousvalmentaja'}</span><p>${escape(m.content)}</p></div>`).join('');
    log.setAttribute('aria-busy', String(session.pending));
    detail.querySelector('#chat-progress').textContent = session.pending ? 'Valmentaja vastaa…' : '';
    const alert = detail.querySelector('#chat-error');
    alert.textContent = session.error;
    alert.hidden = !session.error;
    detail.querySelector('#chat-question').disabled = session.pending;
    detail.querySelector('.chat-send').disabled = session.pending || !ready(session.draft);
    detail.querySelector('#chat-hint').hidden = !GAP.test(session.draft);
    detail.querySelector('.chat-suggestions').hidden = session.messages.length > 0 || Boolean(session.insight);
    log.scrollTop = log.scrollHeight;
  }

  async function send() {
    const current = session;
    if (current.pending || !ready(current.draft)) return;
    const content = current.draft.trim();
    let history = current.messages.slice(-10);
    while (history.reduce((n, m) => n + m.content.length, 0) + content.length > 14000) history = history.slice(2);
    const body = { messages: [...history, { role: 'user', content }] };
    if (current.insight) body.insight = { insight_id: current.insight.card.id };
    current.messages.push({ role: 'user', content });
    current.draft = ''; current.error = ''; current.pending = true;
    current.controller = new AbortController();
    detail.querySelector('#chat-question').value = '';
    update();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(45000), current.controller.signal]),
      });
      const result = await response.json();
      if (current !== session) return;
      if (!response.ok) throw new Error(result.error || 'Vastausta ei saatu. Yritä uudelleen.');
      if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('Vastausta ei saatu. Yritä uudelleen.');
      current.messages.push({ role: 'assistant', content: result.answer });
    } catch (failure) {
      if (current !== session) return;
      current.messages.pop(); current.draft = content;
      current.error = failure.name === 'TimeoutError' ? 'Vastaus viipyy. Yritä uudelleen.' :
        failure instanceof TypeError || failure instanceof SyntaxError ? 'Yhteys katkesi. Yritä uudelleen.' : failure.message;
    } finally {
      // A response from an old customer/card must never enter the new conversation.
      if (current === session) {
        current.pending = false;
        const input = detail.querySelector('#chat-question');
        if (input) { input.value = current.draft; update(); input.focus(); }
      }
    }
  }

  // autoSend: true sends the question right away (e.g. from Rahavuotesi's "Kysy valmentajalta" buttons).
  function showChat(question = '', { autoSend = false } = {}) {
    if (question) { reset(); session.draft = question; }
    const selected = session.insight;
    modal('Talousvalmentaja', `
      <div class="chat-status">${icon('chat')}<div><strong>Oma taloutesi. Omat kysymyksesi.</strong><span>${selected ? 'Keskustellaan havainnostasi' : 'Keskustele tekoälyn kanssa'}</span></div></div>
      ${selected ? `<div class="chat-insight"><span>Valittu havainto · ${escape(selected.asOf)}</span><strong>${escape(selected.card.title)}</strong><b>${escape(selected.card.headline_number)}</b><p>${escape(selected.card.explanation)}</p></div><p class="chat-context-note">Valmentaja näkee tämän demoasiakkaan havainnon ja sen taustaluvut. Tiedot ovat historiallisia.</p>` : `<div class="chat-intro"><div class="chat-greeting">Hei! Mistä haluaisit jutella?</div><p>Voin auttaa yleisissä raha-asioissa. Avaa etusivun havainto, jos haluat keskustella demoasiakkaan tilanteesta.</p></div>`}
      <div id="chat-messages" class="chat-messages" role="log" aria-label="Keskustelu" aria-live="polite" aria-relevant="additions text"></div>
      <div class="chat-suggestions">${SUGGESTIONS.map(q => `<button type="button" data-chat-question="${escape(q.text)}"><span>${escape(q.label || q.text)}${q.hint ? `<small>✎ ${escape(q.hint)}</small>` : ''}</span>${icon('arrow')}</button>`).join('')}</div>
      <p id="chat-progress" class="chat-progress" role="status"></p>
      <p id="chat-error" class="chat-error" role="alert" hidden></p>
      <form id="chat-form" class="chat-composer"><label class="sr-only" for="chat-question">Kirjoita kysymyksesi</label><textarea id="chat-question" rows="2" placeholder="Kirjoita kysymyksesi…" maxlength="2000" required>${escape(session.draft)}</textarea><button type="submit" class="chat-send" aria-label="Lähetä kysymys">${icon('arrow')}</button></form>
      <p id="chat-hint" class="chat-hint" hidden>Kirjoita ostoksen nimi ja hinta kohtiin [tuote] ja [hinta] ennen lähettämistä. Sarkain siirtää seuraavaan kohtaan.</p>
      <div class="chat-footer"><span>Viestit${selected ? ' ja valitun demoasiakkaan taustatiedot' : ''} lähetetään Claudelle. Keskustelu tyhjenee, kun aloitat uuden keskustelun tai päivität sivun.</span><button type="button" id="chat-reset">Uusi keskustelu</button></div>
    `, 'chat-dialog');
    const input = detail.querySelector('#chat-question');
    detail.querySelector('#chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
    // Select the next [gap] so typing replaces it.
    const selectGap = () => { const gap = input.value.match(GAP); if (gap) input.setSelectionRange(gap.index, gap.index + gap[0].length); return Boolean(gap); };
    input.addEventListener('input', () => { session.draft = input.value; update(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.shiftKey && GAP.test(input.value)) { event.preventDefault(); selectGap(); return; }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); detail.querySelector('#chat-form').requestSubmit(); }
    });
    detail.querySelectorAll('[data-chat-question]').forEach(button => button.addEventListener('click', () => {
      if (session.pending) return;
      input.value = session.draft = button.dataset.chatQuestion;
      update(); input.focus(); selectGap();
    }));
    detail.querySelector('#chat-reset').addEventListener('click', () => { reset(); showChat(); detail.querySelector('#chat-question').focus(); });
    update();
    if (autoSend && question) void send();
  }
  showChat.reset = reset;
  showChat.openInsight = ({ customerId, card, asOf }) => {
    reset();
    session.insight = { customerId, card, asOf };
    session.draft = `Auta minua ymmärtämään havainto ”${card.title}” ja kerro, mikä olisi hyvä seuraava askel.`;
    showChat();
    void send();
  };
  return showChat;
}
