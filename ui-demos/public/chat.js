const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

export function createChatDialog({ modal, detail, icon }) {
  let messages = [], draft = '', pending = false, error = '';

  function update() {
    const log = detail.querySelector('#chat-messages');
    if (!log) return;
    log.innerHTML = messages.map(m => `<div class="chat-message ${m.role}"><span>${m.role === 'user' ? 'Sinä' : 'Talousvalmentaja'}</span><p>${escape(m.content)}</p></div>`).join('');
    log.setAttribute('aria-busy', String(pending));
    detail.querySelector('#chat-progress').textContent = pending ? 'Valmentaja vastaa…' : '';
    const alert = detail.querySelector('#chat-error');
    alert.textContent = error;
    alert.hidden = !error;
    detail.querySelector('#chat-question').disabled = pending;
    detail.querySelector('.chat-send').disabled = pending || !draft.trim();
    detail.querySelector('#chat-reset').disabled = pending;
    detail.querySelector('.chat-suggestions').hidden = messages.length > 0;
    log.scrollTop = log.scrollHeight;
  }

  async function submit(event) {
    event.preventDefault();
    if (pending || !draft.trim()) return;
    const content = draft.trim();
    // Keep complete pairs within the server's conversation limits.
    let history = messages.slice(-10);
    while (history.reduce((n, m) => n + m.content.length, 0) + content.length > 14000) history = history.slice(2);
    const requestMessages = [...history, { role: 'user', content }];
    messages.push({ role: 'user', content });
    draft = ''; error = ''; pending = true;
    detail.querySelector('#chat-question').value = '';
    update();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: requestMessages }), signal: AbortSignal.timeout(45000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Vastausta ei saatu. Yritä uudelleen.');
      if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('Vastausta ei saatu. Yritä uudelleen.');
      messages.push({ role: 'assistant', content: result.answer });
    } catch (failure) {
      messages.pop(); draft = content;
      error = failure.name === 'TimeoutError' ? 'Vastaus viipyy. Yritä uudelleen.' :
        failure instanceof TypeError || failure instanceof SyntaxError ? 'Yhteys katkesi. Yritä uudelleen.' : failure.message;
    } finally {
      pending = false;
      const input = detail.querySelector('#chat-question');
      if (input) { input.value = draft; update(); input.focus(); }
    }
  }

  return function showChat() {
    modal('Talousvalmentaja', `
      <div class="chat-status">${icon('chat')}<div><strong>Oma taloutesi. Omat kysymyksesi.</strong><span>Keskustele tekoälyn kanssa</span></div></div>
      <div class="chat-intro"><div class="chat-greeting">Hei! Mistä haluaisit jutella?</div><p>Voin auttaa yleisissä raha-asioissa. Tilitietojasi tai tämän demon aineistoa ei ole vielä yhdistetty keskusteluun.</p></div>
      <div id="chat-messages" class="chat-messages" role="log" aria-label="Keskustelu" aria-live="polite" aria-relevant="additions text"></div>
      <div class="chat-suggestions">${['Miten aloitan budjetoinnin?', 'Mikä on puskurirahasto?', 'Anna kolme säästövinkkiä arkeen.'].map(q => `<button type="button" data-chat-question="${escape(q)}">${escape(q)}${icon('arrow')}</button>`).join('')}</div>
      <p id="chat-progress" class="chat-progress" role="status"></p>
      <p id="chat-error" class="chat-error" role="alert" hidden></p>
      <form id="chat-form" class="chat-composer"><label class="sr-only" for="chat-question">Kirjoita kysymyksesi</label><textarea id="chat-question" rows="2" placeholder="Kirjoita kysymyksesi…" maxlength="2000" required>${escape(draft)}</textarea><button type="submit" class="chat-send" aria-label="Lähetä kysymys">${icon('arrow')}</button></form>
      <div class="chat-footer"><span>Viestit lähetetään Claudelle. Keskustelu tyhjenee, kun päivität sivun.</span><button type="button" id="chat-reset">Uusi keskustelu</button></div>
    `, 'chat-dialog');
    const input = detail.querySelector('#chat-question');
    detail.querySelector('#chat-form').addEventListener('submit', submit);
    input.addEventListener('input', () => { draft = input.value; detail.querySelector('.chat-send').disabled = pending || !draft.trim(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); detail.querySelector('#chat-form').requestSubmit(); }
    });
    detail.querySelectorAll('[data-chat-question]').forEach(button => button.addEventListener('click', () => {
      if (pending) return;
      input.value = draft = button.dataset.chatQuestion;
      update(); input.focus();
    }));
    detail.querySelector('#chat-reset').addEventListener('click', () => {
      if (pending) return;
      messages = []; draft = ''; error = ''; input.value = ''; update(); input.focus();
    });
    update();
  };
}
