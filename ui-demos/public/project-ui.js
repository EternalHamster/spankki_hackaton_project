import { locale, getLanguage } from './language.js';
import { createPurchaseProjects, projectProgress, projectHint } from './purchase-projects.js';
import { createCustomerMemory } from './customer-memory.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = value => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);

export function createProjectUI({ getContainer, getSelection, onAsk, icon, isExpanded = () => true }) {
  const store = createPurchaseProjects();
  const memory = createCustomerMemory();
  let notice = '', noticeCustomer = null, noticeRevision = null, warning = false;
  const sameSelection = selected => getSelection()?.selection_id === selected.selection_id;

  function tipHTML(project, tip) {
    const impact = projectHint(project, tip);
    if (impact.extra_eur <= 0) return '';
    const time = project.monthly_eur <= 0 ? 'Aika-arvio odottaa säästövauhtia'
      : impact.days_faster === 0 ? 'Alle päivä aiemmin'
      : `Noin ${impact.days_faster} ${impact.days_faster === 1 ? 'päivä' : 'päivää'} aiemmin`;
    const condition = project.monthly_eur <= 0
      ? 'Sovitaan ensin kuukausittainen säästövauhti, jotta ajansäästö voidaan arvioida. Varaa tämä säästö kuukausitavoitteen lisäksi.' : '';
    // Previously saved goals may still contain the old observation-date suffix.
    const text = tip.text.replace(/\s*Havainto kuukaudelta \d{4}-\d{2}\.\s*$/u, '');
    return `<li><div><strong>${esc(tip.label)}</strong><span>${time}</span></div><p>${esc(text)}</p>${condition ? `<small>${condition}</small>` : ''}</li>`;
  }

  function cardHTML(project, remembered) {
    const progress = projectProgress(project);
    const needsReview = !remembered.available || project.memory_revision !== remembered.revision;
    const done = progress.remaining_eur === 0;
    const pace = project.monthly_eur > 0 ? `${euro(project.monthly_eur)} / kk` : 'Sovitaan yhdessä';
    const timeline = done ? 'Hienoa, Tavoitetililläsi on koko tavoitesumma.'
      : needsReview ? 'Suunnitelman säästövauhti odottaa tarkistusta.'
      : progress.months_remaining === null ? 'Sovitaan valmentajan kanssa sopiva säästövauhti.'
      : `Arviolta ${progress.months_remaining} kk jäljellä tavoitevauhdilla.`;
    return `<article class="purchase-project${done ? ' purchase-project-complete' : ''}${needsReview ? ' project-needs-review' : ''}" data-project-id="${esc(project.id)}" aria-labelledby="project-title-${esc(project.id)}">
      <div class="project-heading"><span>${done ? 'Tavoite saavutettu' : 'Oma tavoite'}</span>${icon(done ? 'check' : 'bag')}</div>
      <h4 id="project-title-${esc(project.id)}">${esc(project.title)}</h4>
      <p class="project-balance-label">Tavoitetilin saldo <span class="project-demo-badge">Demo</span></p>
      <p class="project-amount"><strong>${euro(project.saved_eur)}</strong><span>/ ${euro(project.price_eur)}</span></p>
      <label class="sr-only" for="project-progress-${esc(project.id)}">Tavoitetilin demosaldo suhteessa tavoitteeseen: ${esc(project.title)}</label>
      <progress id="project-progress-${esc(project.id)}" class="project-progress" value="${Math.min(project.saved_eur, project.price_eur)}" max="${project.price_eur}" aria-valuetext="${esc(`${euro(project.saved_eur)} Tavoitetilillä (demo), tavoite ${euro(project.price_eur)}.`)}"></progress>
      <p class="project-timeline">${timeline}</p>
      ${needsReview ? `<p class="project-review-notice">${remembered.available ? 'Toiveesi ovat muuttuneet.' : 'Muistitiedot eivät ole käytettävissä.'} Tarkista suunnitelma valmentajan kanssa.</p>` : ''}
      <dl class="project-plan-facts"><div><dt>${needsReview ? 'Aiempi kuukausivauhti' : 'Kuukausivauhti'}</dt><dd>${pace}</dd></div><div><dt>Toivottu aika</dt><dd>${project.requested_months} kk</dd></div></dl>
      <details class="project-details"><summary>Tavoitetili ja vinkit ${icon('chevron')}</summary>
        ${!needsReview && project.conditions.length ? `<ul class="project-conditions">${project.conditions.map(condition => `<li>${esc(condition)}</li>`).join('')}</ul>` : ''}
        ${!needsReview && !done && project.tips.length ? `<section class="project-tips" aria-label="Tavoitettasi tukevat arjen valinnat"><h5>Pieniä askelia lähemmäs</h5><ul>${project.tips.map(tip => tipHTML(project, tip)).join('')}</ul></section>` : ''}
        <section class="project-account" aria-labelledby="project-account-${esc(project.id)}">
          <div class="project-account-heading"><h5 id="project-account-${esc(project.id)}">S-Pankki Tavoitetili</h5><span class="project-demo-badge">Demo</span></div>
          <p>Valmentajasi avasi tämän tilin tavoitettasi varten.</p>
          <dl class="project-account-balance"><dt>Tilillä nyt</dt><dd>${euro(project.saved_eur)}</dd></dl>
          ${!done && !needsReview && project.monthly_eur > 0 ? `<button type="button" data-project-deposit="${esc(project.id)}">Simuloi kuukausisäästö ${icon('plus')}</button><small>Lisää tilille ${euro(Math.min(project.monthly_eur, progress.remaining_eur))} demorahaa.</small>` : ''}
        </section>
        <div class="project-actions"><button type="button" data-project-chat="${esc(project.id)}">Jatka suunnittelua ${icon('arrow')}</button><button type="button" data-project-remove="${esc(project.id)}">Poista tavoite</button></div>
      </details>
    </article>`;
  }

  function resultNotice(result, success) {
    noticeRevision = result.revision;
    warning = !result.saved;
    notice = result.saved ? success
      : result.reason === 'conflict' ? 'Tavoite muuttui toisessa välilehdessä. Tarkista uudet tiedot ja yritä uudelleen.'
      : result.reason === 'invalid' ? 'Kuukausisäästöä ei voitu lisätä. Tarkista suunnitelma valmentajan kanssa.'
      : 'Muutosta ei voitu tallentaa tähän selaimeen. Yritä uudelleen.';
  }

  function render() {
    const target = getContainer(), selected = getSelection();
    if (!target || !selected) return;
    const opened = new Set([...target.querySelectorAll('.project-details[open]')].map(details => details.closest('[data-project-id]').dataset.projectId));
    const state = store.read(selected.customer_id);
    const remembered = memory.read(selected.customer_id);
    if (noticeCustomer !== selected.customer_id || (notice && noticeRevision !== state.revision)) {
      notice = ''; warning = false; noticeCustomer = selected.customer_id; noticeRevision = state.revision;
    }
    target.hidden = !isExpanded() || (state.available && state.projects.length === 0 && !notice);
    target.innerHTML = `${state.projects.length ? `<div class="project-list-title"><span>Tavoitteesi</span><small>${state.projects.length} / 3</small></div>${state.projects.map(project => cardHTML(project, remembered)).join('')}` : ''}
      ${!state.available ? '<p class="project-status project-status-warning" role="status">Tallennettuja tavoitteita ei voitu avata tässä selaimessa.</p>' : ''}
      <p class="project-status${warning ? ' project-status-warning' : ''}" role="status" ${notice ? '' : 'hidden'}>${esc(notice)}</p>`;
    for (const card of target.querySelectorAll('[data-project-id]')) {
      if (opened.has(card.dataset.projectId)) card.querySelector('.project-details').open = true;
    }
    target.onclick = async event => {
      const button = event.target.closest('[data-project-chat], [data-project-remove], [data-project-deposit]');
      if (!button || !sameSelection(selected) || button.disabled) return;
      const id = button.dataset.projectChat || button.dataset.projectRemove || button.dataset.projectDeposit;
      const project = state.projects.find(item => item.id === id);
      if (!project) return;
      if (button.hasAttribute('data-project-deposit')) {
        const latestMemory = memory.read(selected.customer_id);
        if (!latestMemory.available || project.memory_revision !== latestMemory.revision) { render(); return; }
        button.disabled = true;
        const result = await store.simulateMonthlyDeposit(selected.customer_id, id, state.revision);
        if (!sameSelection(selected)) return;
        resultNotice(result, 'Kuukausisäästö lisätty Tavoitetilille demossa. Saldo ja tavoitteen edistyminen on päivitetty.');
        render();
        const card = target.querySelector(`[data-project-id="${id}"]`);
        (card?.querySelector('[data-project-deposit]') || card?.querySelector('.project-details summary'))?.focus({ preventScroll: true });
        return;
      }
      if (button.hasAttribute('data-project-chat')) {
        const needsReview = !remembered.available || project.memory_revision !== remembered.revision;
        onAsk(getLanguage() === 'en'
          ? `Let's continue planning my goal “${project.title}”. You opened a demo S-Pankki Goal Account for it. Its demo balance is now ${euro(project.saved_eur)}. The goal costs ${euro(project.price_eur)} and my preferred timeframe is ${project.requested_months} months. The ${needsReview ? 'previous ' : ''}plan saves ${euro(project.monthly_eur)} a month. ${needsReview ? 'Let’s review the plan using my current preferences.' : 'What would be a suitable next step for me?'}`
          : `Jatketaan tavoitettani ”${project.title}”. Avasit minulle tätä varten S-Pankki Tavoitetilin demossa. Tilin demosaldo on nyt ${euro(project.saved_eur)}. Tavoite maksaa ${euro(project.price_eur)} ja toiveaikani on ${project.requested_months} kuukautta. ${needsReview ? 'Aiemman suunnitelman' : 'Suunnitelman'} kuukausivauhti on ${euro(project.monthly_eur)}. ${needsReview ? 'Tarkistetaan suunnitelma nykyisten toiveideni perusteella.' : 'Mikä olisi minulle sopiva seuraava askel?'}`);
        return;
      }
      button.disabled = true;
      const result = await store.remove(selected.customer_id, id, state.revision);
      if (!sameSelection(selected)) return;
      resultNotice(result, 'Tavoite poistettu.'); render();
      target.parentElement.querySelector('[data-topic="afford"]')?.focus({ preventScroll: true });
    };
  }
  return { render };
}
