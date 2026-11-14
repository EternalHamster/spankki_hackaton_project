import { createPurchaseProjects, projectProgress, projectHint } from './purchase-projects.js';
import { createCustomerMemory } from './customer-memory.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = value => new Intl.NumberFormat('fi-FI', { style: 'currency', currency: 'EUR', maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
const dateLabel = value => new Date(value + 'T12:00:00Z').toLocaleDateString('fi-FI', { timeZone: 'UTC' });

export function createProjectUI({ getContainer, getSelection, onAsk, icon }) {
  const store = createPurchaseProjects();
  const memory = createCustomerMemory();
  let notice = '', noticeCustomer = null, noticeRevision = null, warning = false;
  const sameSelection = selected => getSelection()?.selection_id === selected.selection_id;

  function tipHTML(project, tip) {
    const impact = projectHint(project, tip);
    if (impact.extra_eur <= 0) return '';
    return `<li><div><strong>${esc(tip.label)}</strong><span>+ ${euro(impact.extra_eur)} tavoitteeseen</span></div><p>${esc(tip.text)}</p>${impact.days_faster > 0 ? `<small>Jos säästät tämän kuukausitavoitteen lisäksi, noin ${impact.days_faster} päivää nopeammin samalla kuukausivauhdilla.</small>` : '<small>Lisäsäästö auttaa eteenpäin, kun varaat sen kuukausitavoitteen lisäksi.</small>'}</li>`;
  }

  function cardHTML(project, remembered) {
    const progress = projectProgress(project);
    const needsReview = !remembered.available || project.memory_revision !== remembered.revision;
    const done = progress.remaining_eur === 0;
    const pace = project.monthly_eur > 0 ? `${euro(project.monthly_eur)} / kk` : 'Sovitaan yhdessä';
    const timeline = done ? 'Hienoa, olet kirjannut koko tavoitesumman säästöön.'
      : needsReview ? 'Suunnitelman säästövauhti odottaa tarkistusta.'
      : progress.months_remaining === null ? 'Sovitaan valmentajan kanssa sopiva säästövauhti.'
      : `Arviolta ${progress.months_remaining} kk jäljellä tavoitevauhdilla.`;
    return `<article class="purchase-project${done ? ' purchase-project-complete' : ''}${needsReview ? ' project-needs-review' : ''}" data-project-id="${esc(project.id)}" aria-labelledby="project-title-${esc(project.id)}">
      <div class="project-heading"><span>${done ? 'Tavoite saavutettu' : 'Oma tavoite'}</span>${icon(done ? 'check' : 'bag')}</div>
      <h4 id="project-title-${esc(project.id)}">${esc(project.title)}</h4>
      <p class="project-amount"><strong>${euro(project.saved_eur)}</strong><span>/ ${euro(project.price_eur)}</span></p>
      <label class="sr-only" for="project-progress-${esc(project.id)}">Tavoitteeseen kirjatut säästöt: ${esc(project.title)}</label>
      <progress id="project-progress-${esc(project.id)}" class="project-progress" value="${project.saved_eur}" max="${project.price_eur}" aria-valuetext="${esc(`${euro(project.saved_eur)} säästössä, tavoite ${euro(project.price_eur)}.`)}"></progress>
      <p class="project-timeline">${timeline}</p>
      ${needsReview ? `<p class="project-review-notice">${remembered.available ? 'Toiveesi ovat muuttuneet.' : 'Muistitiedot eivät ole käytettävissä.'} Tarkista suunnitelma valmentajan kanssa.</p>` : ''}
      <dl class="project-plan-facts"><div><dt>${needsReview ? 'Aiempi kuukausivauhti' : 'Kuukausivauhti'}</dt><dd>${pace}</dd></div><div><dt>Toivottu aika</dt><dd>${project.requested_months} kk</dd></div></dl>
      <details class="project-details"><summary>Vinkit ja säästöjen kirjaus ${icon('chevron')}</summary>
        ${!needsReview && project.conditions.length ? `<ul class="project-conditions">${project.conditions.map(condition => `<li>${esc(condition)}</li>`).join('')}</ul>` : ''}
        ${!needsReview && !done && project.tips.length ? `<section class="project-tips" aria-label="Tavoitettasi tukevat arjen valinnat"><h5>Pieniä askelia lähemmäs</h5><ul>${project.tips.map(tip => tipHTML(project, tip)).join('')}</ul><p class="project-footnote">Esimerkit perustuvat ${esc(dateLabel(project.as_of))} aineistoon. Kirjaa vain säästö, jonka olet itse varannut tavoitteeseen.</p></section>` : ''}
        <form class="project-savings-form" data-project-savings="${esc(project.id)}"><label for="project-saved-${esc(project.id)}">Kirjaa säästösi <small>Tähän tavoitteeseen varaamasi säästöt yhteensä (€)</small></label><div><input id="project-saved-${esc(project.id)}" name="saved" type="number" inputmode="decimal" min="0" max="${project.price_eur}" step="0.01" value="${project.saved_eur}" required><button type="submit">Päivitä säästöt</button></div><small>Voit myös korjata aiempaa kirjausta. Edistyminen perustuu omiin kirjauksiisi.</small></form>
        <p class="project-footnote">Suunnitelman pohjana ${esc(dateLabel(project.as_of))} taloustiedot. Tavoite ja kirjaukset säilyvät tässä selaimessa.</p>
        <div class="project-actions"><button type="button" data-project-chat="${esc(project.id)}">Jatka suunnittelua ${icon('arrow')}</button><button type="button" data-project-remove="${esc(project.id)}">Poista tavoite</button></div>
      </details>
    </article>`;
  }

  function resultNotice(result, success) {
    noticeRevision = result.revision;
    warning = !result.saved;
    notice = result.saved ? success
      : result.reason === 'conflict' ? 'Tavoite muuttui toisessa välilehdessä. Tarkista uudet tiedot ja yritä uudelleen.'
      : result.reason === 'invalid' ? 'Tarkista säästösumma. Sen pitää olla nollan ja tavoitehinnan välillä.'
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
    target.hidden = state.available && state.projects.length === 0 && !notice;
    target.innerHTML = `${state.projects.length ? `<div class="project-list-title"><span>Tavoitteesi</span><small>${state.projects.length} / 3</small></div>${state.projects.map(project => cardHTML(project, remembered)).join('')}` : ''}
      ${!state.available ? '<p class="project-status project-status-warning" role="status">Tallennettuja tavoitteita ei voitu avata tässä selaimessa.</p>' : ''}
      <p class="project-status${warning ? ' project-status-warning' : ''}" role="status" ${notice ? '' : 'hidden'}>${esc(notice)}</p>`;
    for (const card of target.querySelectorAll('[data-project-id]')) {
      if (opened.has(card.dataset.projectId)) card.querySelector('.project-details').open = true;
    }
    target.onsubmit = async event => {
      const form = event.target.closest('[data-project-savings]');
      if (!form) return;
      event.preventDefault();
      if (!sameSelection(selected) || !form.reportValidity() || form.dataset.pending) return;
      const id = form.dataset.projectSavings, saved = Number(new FormData(form).get('saved'));
      form.dataset.pending = 'true';
      form.querySelector('button').disabled = true;
      const result = await store.setSaved(selected.customer_id, id, saved, state.revision);
      if (!sameSelection(selected)) return;
      resultNotice(result, 'Säästösumma päivitetty. Näet edistymisesi tavoitteen palkista.');
      render();
      const details = target.querySelector(`[data-project-id="${id}"] .project-details`);
      if (details) {
        details.open = true;
        details.querySelector('input')?.focus({ preventScroll: true });
      }
    };
    target.onclick = async event => {
      const button = event.target.closest('[data-project-chat], [data-project-remove]');
      if (!button || !sameSelection(selected) || button.disabled) return;
      const id = button.dataset.projectChat || button.dataset.projectRemove;
      const project = state.projects.find(item => item.id === id);
      if (!project) return;
      if (button.hasAttribute('data-project-chat')) {
        const needsReview = !remembered.available || project.memory_revision !== remembered.revision;
        onAsk(`Jatketaan tavoitettani ”${project.title}”. Tavoite maksaa ${euro(project.price_eur)}, toiveaikani on ${project.requested_months} kuukautta ja olen itse kirjannut säästöön ${euro(project.saved_eur)}. ${needsReview ? 'Aiemman suunnitelman' : 'Suunnitelman'} kuukausivauhti on ${euro(project.monthly_eur)}. ${needsReview ? 'Tarkistetaan suunnitelma nykyisten toiveideni perusteella.' : 'Mikä olisi minulle sopiva seuraava askel?'}`);
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
