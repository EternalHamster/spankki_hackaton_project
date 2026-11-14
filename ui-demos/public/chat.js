import { locale } from './language.js';
import { getLanguage } from './language.js';
import { translate } from './translations.js';
import { formatCoachText, formatInline, roundEuroText } from './coach-text.js';
import { insightPeriod } from './insights.js';
import { affordTemplate } from './exploration.js';
import { createCustomerMemory } from './customer-memory.js';
import { createPurchaseProjects, validProjectProposal } from './purchase-projects.js';
import { LEVELS, levelIndex, getAnswerLevel } from './answer-depth.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// Suggested questions. A template's [gaps] must be filled in by the user before it can be sent.
const SUGGESTIONS = [
  { text: affordTemplate, label: 'Onko minulla varaa tähän?', hint: 'Kerro omin sanoin, mitä haluaisit toteuttaa' },
  { text: 'Miten aloitan budjetoinnin?' },
  { text: 'Anna kolme säästövinkkiä arkeen.' },
];
const GAP = /\[(?:tuote|hinta|kuukaudet|item|price|months)\]/;

const ready = draft => Boolean(draft.trim()) && !GAP.test(draft);

export function createChatDialog({ modal, detail, icon, getSelection = () => null, onSelectionStale = () => {}, onProjectsChanged = () => {} }) {
  const memory = createCustomerMemory();
  const projects = createPurchaseProjects();
  const fresh = () => ({ messages: [], draft: '', pending: false, rewriting: null, error: '', memoryPending: false, memoryNotice: '', memoryWarning: false,
    projectProposal: null, projectBaseline: [], projectRevision: '', projectMemoryRevision: '', projectSaving: false, projectError: '',
    insight: null, exploration: null, explorationBullets: null, presentationLevel: null, controller: null, selection: getSelection() });
  let session = fresh();
  let displayedMemory = null;

  function reset() { session.controller?.abort(); session = fresh(); }

  function updateProjectProposal() {
    const target = detail.querySelector('#chat-project-proposal');
    if (!target) return;
    const proposal = session.projectProposal;
    if (!proposal) { target.innerHTML = ''; return; }
    const euros = value => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(value);
    // Use the same commitments as the calculation, even if another tab changes storage.
    const previous = session.projectBaseline.find(project => project.id === proposal.id);
    const otherMonthlyCents = session.projectBaseline
      .filter(project => project.id !== proposal.id && project.saved_eur < project.price_eur)
      .reduce((sum, project) => sum + Math.round(project.monthly_eur * 100), 0);
    const goalMonthlyCents = proposal.projected_months === 0 ? 0 : Math.round(proposal.monthly_eur * 100);
    const savingsNote = goalMonthlyCents === 0
      ? 'Tavoitetilisi demosaldo kattaa tämän tavoitteen. Siihen ei tarvita lisää kuukausisäästöä.'
      : previous ? 'Tämän tavoitteen uusi kuukausisumma korvaa aiemman. Muiden tavoitteiden säästöt jatkuvat ennallaan.'
      : otherMonthlyCents > 0 ? 'Muille tavoitteillesi on jo suunniteltu kuukausisäästö. Jos haluat myös tämän tavoitteen, säästä siihen lisäksi alla oleva summa.'
      : 'Jos haluat toteuttaa tämän tavoitteen, laita sitä varten alla oleva summa säästöön joka kuukausi.';
    const busy = session.pending || session.projectSaving;
    target.innerHTML = `<section class="chat-project-proposal" aria-labelledby="project-proposal-title">
      <span class="project-proposal-label">${previous ? 'Päivitetäänkö tavoitettasi?' : 'Avataanko tavoitteellesi Tavoitetili?'}</span><h3 id="project-proposal-title">${escape(proposal.title)}</h3>
      <dl class="project-proposal-figures"><div><dt>Tavoitesumma</dt><dd>${euros(proposal.price_eur)}</dd></div><div><dt>Aikaa tällä vauhdilla</dt><dd>${proposal.projected_months} kk</dd></div></dl>
      <div class="project-proposal-savings">
        <h4>Kuukausisäästösi</h4><p>${savingsNote}</p>
        <dl>
          ${otherMonthlyCents > 0 ? `<div><dt>Muille tavoitteille jo suunniteltu</dt><dd>${euros(otherMonthlyCents / 100)} / kk</dd></div>` : ''}
          <div><dt>${previous ? 'Tälle tavoitteelle jatkossa' : otherMonthlyCents > 0 ? 'Lisäksi tähän tavoitteeseen' : 'Tähän tavoitteeseen'}</dt><dd>${!previous && otherMonthlyCents > 0 && goalMonthlyCents > 0 ? '+ ' : ''}${euros(goalMonthlyCents / 100)} / kk</dd></div>
          ${otherMonthlyCents > 0 ? `<div class="project-proposal-total"><dt>Tavoitteisiin yhteensä</dt><dd>${euros((otherMonthlyCents + goalMonthlyCents) / 100)} / kk</dd></div>` : ''}
        </dl>
      </div>
      ${proposal.projected_months !== proposal.requested_months ? `<p class="project-proposal-note">Toivomasi aikataulu: ${proposal.requested_months} kk.</p>` : ''}
      ${previous ? `<p class="project-proposal-note">Tavoitetilisi demosaldo säilyy: ${euros(previous.saved_eur)}.</p>` : '<p class="project-proposal-note">Avaan sinulle S-Pankki Tavoitetilin tätä tavoitetta varten. Näet tilin saldon ja edistymisesi tavoitekortissa.</p>'}
      ${proposal.conditions.length ? `<ul class="project-proposal-conditions">${proposal.conditions.map(note => `<li>${escape(note)}</li>`).join('')}</ul>` : ''}
      <p class="project-proposal-note">${(session.presentationLevel ?? getAnswerLevel()) === 'simple' ? 'Arvio aiemmista tiedoista. Demotili tallentuu selaimeen; oikeaa tiliä ei avata.' : `Arvio perustuu ${new Date(proposal.as_of + 'T12:00:00Z').toLocaleDateString(locale(), { timeZone: 'UTC' })} tietoihin. Demo: simuloitu tili tallentuu tähän selaimeen, eikä oikeaa pankkitiliä avata.`}</p>
      <div class="project-proposal-actions"><button type="button" class="primary-button" data-project-confirm ${busy ? 'disabled' : ''}>${session.projectSaving ? 'Tallennetaan…' : previous ? 'Päivitä tavoite' : 'Avaa Tavoitetili'}</button><button type="button" data-project-dismiss ${busy ? 'disabled' : ''}>Jatka pohdintaa</button></div>
      ${session.projectError ? `<p class="project-proposal-error" role="alert">${escape(session.projectError)}</p>` : ''}
    </section>`;
  }

  function memoryResult(result, success) {
    session.memoryWarning = !result.saved;
    session.memoryNotice = result.saved ? success
      : result.reason === 'conflict' ? 'Muisti muuttui toisessa välilehdessä. Tätä muutosta ei tallennettu. Tarkista muisti ja yritä uudelleen.'
      : result.reason === 'full' ? 'Muisti on täynnä. Poista ensin tarpeeton asia, jotta uusi toive voidaan tallentaa.'
      : result.reason === 'invalid' ? 'Muistiin ehdotettua muutosta ei voitu tallentaa. Voit kertoa toiveesi uudelleen.'
      : 'Muistia ei voitu tallentaa tähän selaimeen. Muutos ei säily seuraavaan keskusteluun.';
  }

  function updateMemory() {
    const panel = detail.querySelector('#chat-memory');
    if (!panel || !session.selection?.customer_id) return;
    const state = memory.read(session.selection.customer_id);
    displayedMemory = { ...state, customerId: session.selection.customer_id };
    panel.querySelector('#chat-memory-count').textContent = state.available ? `${state.facts.length} muistissa` : 'Ei käytettävissä';
    const list = panel.querySelector('#chat-memory-facts');
    const busy = session.pending || session.memoryPending;
    const signature = JSON.stringify([state.facts, state.available, busy]);
    if (list.dataset.state !== signature) {
      list.dataset.state = signature;
      list.innerHTML = state.facts.length
        ? `<ul>${state.facts.map(fact => `<li><span>${escape(fact.text)}</span><button type="button" data-memory-forget="${escape(fact.key)}" aria-label="Unohda: ${escape(fact.text)}" ${busy ? 'disabled' : ''}>Unohda</button></li>`).join('')}</ul>`
        : state.available ? '' : '<p class="chat-memory-empty">Selaimen muisti ei ole käytettävissä. Voit silti jatkaa keskustelua.</p>';
    }
    const clear = panel.querySelector('[data-memory-clear]');
    clear.hidden = !state.facts.length;
    clear.disabled = busy || !state.available;
    const notice = detail.querySelector('#chat-memory-status');
    notice.textContent = session.memoryPending ? 'Päivitetään valmentajan muistia…' : session.memoryNotice || (!state.available ? 'Valmentajan muisti ei ole käytettävissä tässä selaimessa. Uusia asioita ei voida muistaa keskustelujen välillä.' : '');
    notice.hidden = !notice.textContent;
    notice.classList.toggle('chat-memory-warning', session.memoryWarning || !state.available);
  }

  // One listener for this dialog controller, rather than another on every reopening.
  globalThis.addEventListener('storage', event => {
    if (!detail.open || !session.selection || (event.key !== null && event.key !== `oma-talous-memory-v1:${session.selection.customer_id}`)) return;
    session.memoryNotice = 'Valmentajan muisti päivitettiin toisessa välilehdessä.';
    session.memoryWarning = false;
    updateMemory();
  });

  function update({ followLatest = true } = {}) {
    const log = detail.querySelector('#chat-messages');
    if (!log) return;
    const scrollTop = log.scrollTop;
    const busy = session.pending || session.memoryPending || session.projectSaving;
    const latestAnswer = session.messages.findLastIndex(message => message.role === 'assistant');
    log.innerHTML = session.messages.map((m, i) => {
      // Older answers keep their content and depth, but only the latest has controls.
      const actions = m.role === 'assistant' && i === latestAnswer ? `<div class="chat-depth-actions" role="group" aria-label="Muokkaa tätä vastausta">
        <button type="button" data-depth="simpler" data-answer-index="${i}" ${busy ? 'disabled' : ''}>Selitä yksinkertaisemmin</button>
        <button type="button" data-depth="deeper" data-answer-index="${i}" ${busy ? 'disabled' : ''}>Kerro tarkemmin</button>
        ${session.rewriting === i ? '<span class="chat-rewrite-status" role="status">Muokataan vastausta…</span>' : ''}</div>` : '';
      return `<div class="chat-message ${m.role}" data-message-index="${i}" ${m.role === 'assistant' ? 'tabindex="-1"' : ''}><span>${m.role === 'user' ? 'Sinä' : 'Talousvalmentaja'}</span>${i === 1 && session.explorationBullets ? `<ul class="summary-bullets">${session.explorationBullets.map(bullet=>`<li>${formatInline(bullet)}</li>`).join('')}</ul>` : m.role === 'assistant' ? `<div class="coach-response">${formatCoachText(m.content, { keepCents: Boolean(m.keepCents || m.accountReceipt) })}</div>` : `<p>${escape(i === 0 && session.exploration ? session.exploration : m.content)}</p>`}${m.accountReceipt ? `<button type="button" class="chat-account-link" data-project-view="${escape(m.accountReceipt)}">Näytä Tavoitetili ${icon('arrow')}</button>` : ''}${actions}</div>`;
    }).join('');
    log.setAttribute('aria-busy', String(session.pending));
    detail.querySelector('#chat-progress').textContent = session.pending && session.rewriting === null ? 'Valmentaja vastaa…' : '';
    const alert = detail.querySelector('#chat-error');
    alert.textContent = session.error;
    alert.hidden = !session.error;
    detail.querySelector('#chat-question').disabled = session.pending;
    detail.querySelector('.chat-send').disabled = session.pending || session.memoryPending || session.projectSaving || !ready(session.draft);
    detail.querySelector('#chat-hint').hidden = !GAP.test(session.draft);
    detail.querySelector('.chat-suggestions').hidden = session.messages.length > 0 || Boolean(session.insight);
    updateMemory();
    updateProjectProposal();
    log.scrollTop = followLatest ? log.scrollHeight : scrollTop;
  }

  // Typed questions use the main-menu default. Boundary follow-ups keep the
  // latest answer's level and leave any unfinished typed question in place.
  async function send({ content: followup, level, preserveDraft = false } = {}) {
    const current = session;
    const content = (followup ?? current.draft).trim();
    if (current.pending || current.memoryPending || current.projectSaving || !ready(content)) return;
    if (!current.selection?.selection_id || current.selection.selection_id !== getSelection()?.selection_id) {
      reset(); onSelectionStale(); return;
    }
    const depth = level ?? getAnswerLevel();
    const draftBefore = current.draft;
    let history = current.messages.slice(-10).map(({ role, content }) => ({ role, content }));
    while (history.reduce((n, m) => n + m.content.length, 0) + content.length > 14000) history = history.slice(2);
    const memoryBefore = memory.read(current.selection.customer_id);
    const projectsBefore = projects.read(current.selection.customer_id);
    let expectedMemoryRevision = memoryBefore.revision;
    const body = { messages: [...history, { role: 'user', content }], level: depth, language: getLanguage(),
      ...(memoryBefore.available ? { memory: memoryBefore.facts } : {}),
      ...(projectsBefore.available ? { projects: projectsBefore.projects } : {}),
      ...(current.projectProposal ? { pending_project: current.projectProposal } : {}) };
    if (current.insight) body.insight = { insight_id: current.insight.card.id };
    current.messages.push({ role: 'user', content });
    current.draft = preserveDraft ? draftBefore : ''; current.error = ''; current.pending = true;
    current.memoryNotice = ''; current.memoryWarning = false;
    current.projectProposal = null; current.projectError = '';
    current.controller = new AbortController();
    detail.querySelector('#chat-question').value = current.draft;
    update();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Selection': current.selection.selection_id }, body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(90000), current.controller.signal]),
      });
      const result = await response.json();
      if (current !== session || current.selection.selection_id !== getSelection()?.selection_id) return;
      if ([401, 409].includes(response.status) || (response.ok && result.selection_id !== current.selection.selection_id)) {
        reset(); onSelectionStale(); return;
      }
      if (!response.ok) throw new Error(result.error || 'Vastausta ei saatu. Yritä uudelleen.');
      if (typeof result.answer !== 'string' || !result.answer.trim() || (result.language ?? 'fi') !== body.language) throw new Error('Vastausta ei saatu. Yritä uudelleen.');
      current.messages.push({ role: 'assistant', content: result.answer, level: depth, keepCents: validProjectProposal(result.project_proposal) });
      if (result.memory_updates !== undefined && !(Array.isArray(result.memory_updates) && result.memory_updates.length === 0)) {
        const saved = await memory.apply(current.selection.customer_id, result.memory_updates, memoryBefore.revision,
          { signal: current.controller.signal });
        if (current !== session || current.selection.selection_id !== getSelection()?.selection_id) return;
        if (saved.saved) expectedMemoryRevision = saved.revision;
        memoryResult(saved, 'Valmentajan muisti päivitetty. Muistetut asiat säilyvät myös seuraavassa keskustelussa.');
        if (saved.saved) onProjectsChanged();
      }
      if (validProjectProposal(result.project_proposal)) {
        current.projectProposal = result.project_proposal;
        current.projectBaseline = projectsBefore.projects;
        current.projectRevision = projectsBefore.revision;
        current.projectMemoryRevision = expectedMemoryRevision;
      }
    } catch (failure) {
      if (current !== session) return;
      current.messages.pop(); current.draft = preserveDraft ? draftBefore : content;
      current.error = failure.name === 'TimeoutError' ? 'Vastaus viipyy. Yritä uudelleen.' :
        failure instanceof TypeError || failure instanceof SyntaxError ? 'Yhteys katkesi. Yritä uudelleen.' : failure.message;
    } finally {
      // A response from an old customer/card must never enter the new conversation.
      if (current === session && current.selection.selection_id === getSelection()?.selection_id) {
        current.pending = false;
        const input = detail.querySelector('#chat-question');
        // Leave focus alone so the reply can be read without reopening the mobile keyboard.
        if (input) { input.value = current.draft; update(); }
      }
    }
  }

  async function rewriteAnswer(index, direction) {
    const current = session;
    const message = current.messages[index];
    if (current.pending || current.memoryPending || current.projectSaving || message?.role !== 'assistant' ||
        index !== current.messages.findLastIndex(row => row.role === 'assistant') ||
        !['simpler', 'deeper'].includes(direction)) return;
    if (!current.selection?.selection_id || current.selection.selection_id !== getSelection()?.selection_id) {
      reset(); onSelectionStale(); return;
    }
    const from = Math.max(0, levelIndex(message.level ?? 'simple'));
    const target = from + (direction === 'deeper' ? 1 : -1);
    if (target < 0 || target >= LEVELS.length) {
      const english = getLanguage() === 'en';
      const content = direction === 'simpler'
        ? english ? 'Explain this even more simply.' : 'Selitä tämä vielä yksinkertaisemmin.'
        : english ? 'Give me more detail about this.' : 'Kerro tästä vielä tarkemmin.';
      await send({ content, level: LEVELS[from].id, preserveDraft: true });
      return;
    }
    const depth = LEVELS[target].id;
    // Rewrite the latest answer using its original question and full source text.
    let history = current.messages.slice(0, index).slice(-11).map(({ role, content }) => ({ role, content }));
    while (history.length > 1 && history.reduce((n, m) => n + m.content.length, 0) > 14000) history = history.slice(2);
    const remembered = memory.read(current.selection.customer_id);
    // Retain the original detail so repeated changes do not progressively lose information.
    const original = message.originalContent ?? message.content;
    const body = { messages: history, level: depth, language: getLanguage(), rewrite: { answer: original },
      ...(remembered.available ? { memory: remembered.facts } : {}) };
    if (current.insight) body.insight = { insight_id: current.insight.card.id };
    // Count the full UTF-8 request, including the source answer. Keep its question intact.
    const requestBytes = () => new TextEncoder().encode(JSON.stringify(body)).length;
    while (body.messages.length > 1 && requestBytes() > 32768) body.messages = body.messages.slice(2);
    if (requestBytes() > 32768) delete body.memory;
    current.pending = true; current.rewriting = index; current.error = '';
    current.controller = new AbortController();
    update({ followLatest: false });
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Selection': current.selection.selection_id },
        body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(90000), current.controller.signal]),
      });
      const result = await response.json();
      if (current !== session || current.selection.selection_id !== getSelection()?.selection_id) return;
      if ([401, 409].includes(response.status) || (response.ok && result.selection_id !== current.selection.selection_id)) {
        reset(); onSelectionStale(); return;
      }
      if (!response.ok) throw new Error(result.error || 'Vastausta ei voitu muokata. Yritä uudelleen.');
      if (typeof result.answer !== 'string' || !result.answer.trim() || (result.language ?? 'fi') !== body.language) throw new Error('Vastausta ei voitu muokata. Yritä uudelleen.');
      message.originalContent = original;
      message.content = result.answer;
      message.level = depth;
      if (index === 1) current.explorationBullets = null;
      // Rewording an answer never applies memory changes or creates a goal.
    } catch (failure) {
      if (current !== session) return;
      current.error = (failure.name === 'TimeoutError' ? 'Vastauksen muokkaus viipyy. Yritä uudelleen.' :
        failure instanceof TypeError || failure instanceof SyntaxError ? 'Yhteys katkesi. Yritä uudelleen.' : failure.message) +
        ' Aiempi vastaus säilytettiin.';
    } finally {
      if (current === session && current.selection.selection_id === getSelection()?.selection_id) {
        current.pending = false; current.rewriting = null;
        update({ followLatest: false });
        detail.querySelector(`[data-message-index="${index}"]`)?.focus({ preventScroll: true });
      }
    }
  }

  // autoSend: true sends the question right away (e.g. from Rahavuotesi's "Kysy valmentajalta" buttons).
  function showChat(question = '', { autoSend = false, displayQuestion } = {}) {
    const customer = getSelection();
    if (!customer) return;
    if (session.selection?.selection_id !== customer.selection_id) reset();
    if (question) { reset(); session.draft = question; session.exploration = displayQuestion; }
    const simple = (session.presentationLevel ?? getAnswerLevel()) === 'simple';
    const selected = session.insight;
    const period = selected ? insightPeriod(selected.card.period, selected.asOf) : null;
    const date = !simple && customer.as_of ? new Date(customer.as_of + 'T12:00:00Z').toLocaleDateString(locale(), { timeZone: 'UTC' }) : '';
    const privacy = 'Viestit, muistetut toiveet ja kysymykseen tarvittavat valitun demoasiakkaan tiedot lähetetään Claudelle. Keskustelu tyhjenee, kun vaihdat asiakasta, aloitat uuden keskustelun tai päivität sivun. Muistetut asiat säilyvät tässä selaimessa, kunnes poistat ne.';
    modal('Talousvalmentaja', `
      <div class="chat-status">${icon('chat')}<div><strong>Oma taloutesi. Omat kysymyksesi.</strong><span>${escape(customer.label || 'Demoasiakas')}${date ? ' · aineisto ' + escape(date) : ''}</span></div></div>
      <details id="chat-memory" class="chat-memory"><summary><span>Valmentajan muisti</span><small id="chat-memory-count"></small>${icon('chevron')}</summary>
        <div id="chat-memory-facts"></div><button type="button" class="chat-memory-clear" data-memory-clear hidden>Tyhjennä muisti</button>
      </details>
      ${selected ? `<div class="chat-insight"><span>${escape(period.label)}${simple ? '' : ' · ' + escape(period.detail)}</span><strong>${escape(roundEuroText(selected.card.title))}</strong><b>${escape(roundEuroText(selected.card.headline_number))}</b><p>${formatInline(selected.card.explanation)}</p><p><strong>Kokeile tätä:</strong> ${formatInline(selected.card.action)}</p></div>${simple ? '' : '<p class="chat-context-note">Voit suunnitella seuraavan askeleen valmentajan kanssa. Tiedot ovat historiallisia.</p>'}` : session.messages.length ? '' : `<div class="chat-intro"><div class="chat-greeting">Hei! Mistä haluaisit jutella?</div><p>${simple ? 'Kysy menoista, säästämisestä tai omasta tavoitteestasi.' : 'Voin auttaa valitun demoasiakkaan tuloissa, menoissa ja talouden suunnittelussa. Käytän vain tämän asiakkaan historiallisia tietoja ja ryhmätason vertailuja.'}</p></div>`}
      <div id="chat-messages" class="chat-messages" role="log" aria-label="Keskustelu" aria-live="polite" aria-relevant="additions text"></div>
      <div id="chat-project-proposal" aria-live="polite"></div>
      <div class="chat-suggestions">${SUGGESTIONS.map(q => `<button type="button" data-chat-question="${escape(q.text)}"><span>${escape(q.label || q.text)}${q.hint ? `<small>✎ ${escape(q.hint)}</small>` : ''}</span>${icon('arrow')}</button>`).join('')}</div>
      <p id="chat-progress" class="chat-progress" role="status"></p>
      <p id="chat-memory-status" class="chat-memory-status" role="status" hidden></p>
      <p id="chat-error" class="chat-error" role="alert" hidden></p>
      <form id="chat-form" class="chat-composer"><label class="sr-only" for="chat-question">Kirjoita kysymyksesi</label><textarea id="chat-question" rows="2" placeholder="Kirjoita kysymyksesi…" maxlength="2000" required>${escape(session.draft)}</textarea><button type="submit" class="chat-send" aria-label="Lähetä kysymys">${icon('arrow')}</button></form>
      <p id="chat-hint" class="chat-hint" hidden>Lisää [tuote], [hinta] ja [kuukaudet] ennen lähettämistä. Sarkain siirtää seuraavaan kohtaan.</p>
      <div class="chat-footer">${simple ? `<details class="chat-data-note"><summary>Tietoa keskustelusta</summary><p>${privacy}</p></details>` : `<span>${privacy}</span>`}<button type="button" id="chat-reset">Uusi keskustelu</button></div>
    `, 'chat-dialog');
    const input = detail.querySelector('#chat-question');
    detail.querySelector('#chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
    detail.querySelector('#chat-project-proposal').addEventListener('click', async event => {
      const current = session;
      const host = event.currentTarget;
      if (current.pending || current.projectSaving) return;
      if (event.target.closest('[data-project-dismiss]')) { current.projectProposal = null; update(); input.focus(); return; }
      if (!event.target.closest('[data-project-confirm]') || !current.projectProposal) return;
      if (current.selection?.selection_id !== getSelection()?.selection_id) { reset(); onSelectionStale(); return; }
      if (memory.read(current.selection.customer_id).revision !== current.projectMemoryRevision) {
        current.projectError = 'Muistetut toiveesi muuttuivat. Pyydä valmentajaa tarkistamaan suunnitelma ennen aloittamista.';
        updateProjectProposal(); return;
      }
      current.projectSaving = true; current.projectError = ''; update();
      try {
        const proposal = current.projectProposal;
        const alreadyOpen = projects.read(current.selection.customer_id).projects.some(project => project.id === proposal.id);
        const result = await projects.confirm(current.selection.customer_id, current.projectProposal, current.projectRevision,
          { signal: current.controller?.signal, memoryRevision: current.projectMemoryRevision });
        if (current !== session || current.selection?.selection_id !== getSelection()?.selection_id) return;
        if (!result.saved) {
          current.projectError = result.reason === 'full' ? 'Sinulla on jo kolme tavoitetta. Poista ensin yksi, jos haluat aloittaa uuden.'
            : result.reason === 'conflict' ? 'Tavoitteesi muuttuivat. Pyydä valmentajaa päivittämään suunnitelma.'
            : 'Tavoitetta ei voitu tallentaa tähän selaimeen. Yritä uudelleen.';
          return;
        }
        const opened = result.projects.find(project => project.id === proposal.id);
        const balance = new Intl.NumberFormat(locale(), { style: 'currency', currency: 'EUR' }).format(opened.saved_eur);
        const english = getLanguage() === 'en';
        current.messages.push({ role: 'user', content: english
          ? alreadyOpen ? `Update my goal “${opened.title}”.` : `Open a demo S-Pankki Goal Account for my goal “${opened.title}”.`
          : alreadyOpen ? `Päivitä tavoite ”${opened.title}”.` : `Avaa S-Pankki Tavoitetili tavoitteelleni ”${opened.title}” demossa.` },
          { role: 'assistant', level: getAnswerLevel(), accountReceipt: opened.id,
            content: english
              ? `${alreadyOpen ? 'I updated your goal. Your S-Pankki Goal Account remains open.' : `I opened an S-Pankki Goal Account for your goal “${opened.title}”.`}\n\nYour account now holds **${balance}**. See your balance and progress on the goal card.\n\nDemo: the account and balance are simulated.`
              : `${alreadyOpen ? 'Päivitin tavoitteesi. S-Pankki Tavoitetilisi säilyy käytössä.' : `Avasin sinulle S-Pankki Tavoitetilin tavoitettasi ”${opened.title}” varten.`}\n\nTililläsi on nyt **${balance}**. Näet saldon ja etenemisesi tavoitekortissa.\n\nDemo: tili ja saldo ovat simuloituja.` });
        current.projectProposal = null;
        onProjectsChanged({ reveal: host.isConnected });
      } finally {
        if (current === session) { current.projectSaving = false; update(); }
      }
    });
    detail.querySelector('#chat-memory').addEventListener('click', async event => {
      const button = event.target.closest('[data-memory-forget], [data-memory-clear]');
      const current = session, shown = displayedMemory;
      if (!button || current.pending || current.memoryPending || !shown) return;
      if (shown.customerId !== getSelection()?.customer_id || current.selection?.selection_id !== getSelection()?.selection_id) {
        reset(); onSelectionStale(); return;
      }
      const clearing = button.hasAttribute('data-memory-clear');
      const key = button.dataset.memoryForget;
      current.memoryPending = true; current.memoryNotice = ''; current.memoryWarning = false;
      update();
      try {
        // Explicit deletion remains scoped to the selected customer even if the dialog is reset while waiting.
        const result = clearing ? await memory.clear(shown.customerId, shown.revision)
          : await memory.remove(shown.customerId, key, shown.revision);
        if (current !== session || current.selection.selection_id !== getSelection()?.selection_id) return;
        memoryResult(result, clearing ? 'Valmentajan muisti tyhjennetty.' : 'Asia poistettu valmentajan muistista.');
        if (result.saved) onProjectsChanged();
      } catch {
        if (current === session && current.selection.selection_id === getSelection()?.selection_id) {
          memoryResult({ saved: false, reason: 'unavailable' });
        }
      } finally {
        current.memoryPending = false;
        if (current === session && current.selection.selection_id === getSelection()?.selection_id) {
          update();
          detail.querySelector('#chat-memory summary')?.focus();
        }
      }
    });
    // Select the next [gap] so typing replaces it.
    const selectGap = () => { const gap = input.value.match(GAP); if (gap) input.setSelectionRange(gap.index, gap.index + gap[0].length); return Boolean(gap); };
    input.addEventListener('input', () => { session.draft = input.value; update(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.shiftKey && GAP.test(input.value)) { event.preventDefault(); selectGap(); return; }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); detail.querySelector('#chat-form').requestSubmit(); }
    });
    detail.querySelectorAll('[data-chat-question]').forEach(button => button.addEventListener('click', () => {
      if (session.pending) return;
      input.value = session.draft = translate(button.dataset.chatQuestion, getLanguage());
      update(); input.focus(); selectGap();
    }));
    detail.querySelector('#chat-messages').addEventListener('click', event => {
      const account = event.target.closest('[data-project-view]');
      if (account?.dataset.projectView && session.selection?.selection_id === getSelection()?.selection_id) {
        onProjectsChanged({ reveal: true });
        detail.close();
        const card = document.querySelector(`[data-project-id="${account.dataset.projectView}"]`);
        if (card) {
          card.querySelector('.project-details').open = true;
          card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
          card.querySelector('.project-details summary')?.focus({ preventScroll: true });
        }
        return;
      }
      const button = event.target.closest('[data-depth]');
      if (!button || button.disabled) return;
      void rewriteAnswer(Number(button.dataset.answerIndex), button.dataset.depth);
    });
    detail.querySelector('#chat-reset').addEventListener('click', () => { reset(); showChat(); detail.querySelector('#chat-question').focus(); });
    update();
    if (autoSend && question) void send();
  }
  showChat.reset = reset;
  showChat.refreshPresentation = () => {
    session.presentationLevel = getAnswerLevel();
    if (detail.open && detail.classList.contains('chat-dialog')) showChat();
  };
  showChat.openExploration = ({ question, displayQuestion, answer, bullets, selectionId, level }) => {
    if (selectionId !== getSelection()?.selection_id) { onSelectionStale(); return; }
    reset();
    session.exploration = displayQuestion;
    session.explorationBullets = Array.isArray(bullets) && bullets.length >= 2 && bullets.length <= 3 && bullets.every(bullet=>typeof bullet === 'string') ? bullets : null;
    const depth = levelIndex(level) >= 0 ? level : 'simple';
    session.presentationLevel = depth;
    session.messages = [{ role: 'user', content: question }, { role: 'assistant', content: answer, level: depth }];
    showChat();
  };
  showChat.openInsight = ({ customerId, card, asOf, level = getAnswerLevel() }) => {
    if (customerId !== getSelection()?.customer_id) { onSelectionStale(); return; }
    reset();
    session.presentationLevel = levelIndex(level) >= 0 ? level : getAnswerLevel();
    session.insight = { customerId, card, asOf };
    session.draft = getLanguage() === 'en' ? `Help me take this step: ${card.action} Give me a brief practical plan for “${card.title}”.`
      : `Auta minua toteuttamaan tämä askel: ${card.action} Anna lyhyt käytännön suunnitelma havaintoon ”${card.title}”.`;
    showChat();
    void send();
  };
  return showChat;
}
