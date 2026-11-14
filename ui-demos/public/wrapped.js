import { locale } from './language.js';
import { getLanguage } from './language.js';
import { translate } from './translations.js';
// "Rahavuotesi": a Spotify Wrapped-style story of the customer's last 12 months, plus the same story
// for the year before it. The latest story has a "Mikä muuttui" card with the drastic changes between the two;
// its button is the only way to open the older story.
// Cards come from wrapped-data.json (built by wrapped/export_ui.py); all numbers are precomputed.
const AUTO_MS = 14000;
const HOLD_MS = 220;
const SWIPE_PX = 45;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function formatCount(value) {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value);
}

function shapes(theme) {
  return `<div class="wr-shapes" aria-hidden="true"><i class="wr-shape wr-s1"></i><i class="wr-shape wr-s2"></i><i class="wr-shape wr-s3"></i><svg class="wr-squiggle" viewBox="0 0 200 60"><path d="M4 40c20-30 40-30 60 0s40 30 60 0 40-30 60 0" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg></div>`;
}

export function renderSlide(card, index, total) {
  const count = card.count === null || card.count === undefined ? '' :
    `<p class="wr-count wr-anim"><span data-count="${Number(card.count)}">${formatCount(card.count)}</span><small>${escape(card.suffix)}</small></p>`;
  const items = card.layout === 'list' ? `<ol class="wr-list">${card.items.map((item, i) => `<li class="wr-anim" style="--d:${i}"><span class="wr-rank">${i + 1}</span><span class="wr-label">${escape(item.label)}<i class="wr-bar" style="--w:${Math.max(6, Math.round(100 * item.share / card.items[0].share))}%"></i></span><b>${escape(item.value)}</b></li>`).join('')}</ol>`
    : card.layout === 'changes' ? `<ul class="wr-deltas">${card.items.map((item, i) => `<li class="wr-anim" style="--d:${i}"><span class="wr-label">${escape(item.label)}</span><b>${escape(item.value)}</b></li>`).join('')}</ul>`
    : card.layout === 'split' ? `<dl class="wr-split">${card.items.map((item, i) => `<div class="wr-anim" style="--d:${i}"><dt>${escape(item.label)}</dt><dd>${escape(item.value)}</dd></div>`).join('')}</dl>`
    : card.layout === 'comparison' ? `<table class="wr-comparison-table wr-anim"><thead><tr><th scope="col">Vuoden luvut</th><th scope="col">Sinä</th><th scope="col">Ryhmän keskiarvo</th></tr></thead><tbody>${card.items.map(item => `<tr><th scope="row">${escape(item.label)}</th><td>${escape(item.own)}</td><td>${escape(item.peer)}</td></tr>`).join('')}</tbody></table>` : '';
  const ask = card.ask && card.layout !== 'outro' ? `<button type="button" class="wr-ask wr-anim" data-wr-ask="${escape(card.ask)}">Kysy valmentajalta<span aria-hidden="true">→</span></button>` : '';
  const outro = card.layout === 'outro' ? `<div class="wr-actions wr-anim">${card.ask ? `<button type="button" class="wr-primary" data-wr-ask="${escape(card.ask)}">Kysy valmentajalta</button>` : ''}<button type="button" class="wr-secondary" data-wr="restart">Katso alusta</button></div>` : '';
  return `<section class="wr-slide wr-${escape(card.layout)} theme-${escape(card.theme)}" role="group" aria-roledescription="dia" aria-label="${index + 1} / ${total}: ${escape(card.kicker)}" data-index="${index}">
    ${shapes(card.theme)}
    <div class="wr-content">
      <p class="wr-kicker wr-anim">${escape(card.kicker)}</p>
      ${card.layout === 'intro' ? `<h2 class="wr-hero-title wr-anim">${escape(card.title)}</h2>${count}` : `${count}<h2 class="wr-title wr-anim">${escape(card.title)}</h2>`}
      ${items}
      ${card.body ? `<p class="wr-body wr-anim">${escape(card.body)}</p>` : ''}
      ${card.note ? `<p class="wr-note wr-anim">${escape(card.note)}</p>` : ''}
      ${outro}${ask}
    </div>
  </section>`;
}

export function createWrapped({ url = 'wrapped-data.json', onAsk } = {}) {
  let data = null, cards = [], index = 0, paused = false, elapsed = 0, last = 0, frame = 0;
  let dialog = null, opener = null, press = null, customer = null;
  let loadVersion = 0;

  async function load({ headers, signal, customerId, selectionId } = {}) {
    const version = ++loadVersion;
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw Object.assign(new Error('Rahavuotta ei voitu ladata.'), { status: response.status });
    const result = await response.json();
    if (version !== loadVersion || signal?.aborted) return null;
    if ((customerId && [result.recaps, result.previous?.recaps].some(recaps => Object.keys(recaps || {}).some(id => id !== customerId))) ||
        (selectionId && result.selection_id && result.selection_id !== selectionId)) {
      throw Object.assign(new Error('Demoasiakas vaihtui.'), { status: 409 });
    }
    data = result;
    return data;
  }
  function reset() {
    loadVersion++;
    close(); cancelAnimationFrame(frame);
    data = null; cards = []; press = null; opener = null;
    if (dialog) dialog.innerHTML = '';
  }
  // year: 'current' (the latest recap year) or 'previous' (the year before it).
  const recapsOf = year => (year === 'previous' ? data?.previous : data)?.recaps;
  const has = (customerId, year = 'current') => Boolean(recapsOf(year)?.[customerId]?.length);

  function teaser() {
    return `<button class="wrapped-teaser" data-action="wrapped"><span class="wt-shapes" aria-hidden="true"><i></i><i></i><i></i></span><span class="wt-copy"><small>Lokakuu 2025 – syyskuu 2026</small><strong>Rahavuotesi on valmis</strong><span>Katso vuotesi tarinana</span></span><span class="wt-play" aria-hidden="true">▶</span></button>`;
  }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'wrapped-dialog';
    dialog.setAttribute('aria-label', 'Rahavuotesi');
    document.body.append(dialog);
    dialog.addEventListener('close', stop);
    dialog.addEventListener('cancel', () => stop());
    dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
      else if (event.key === ' ' && !event.target.closest('button')) { event.preventDefault(); togglePause(); }
    });
    dialog.addEventListener('click', event => {
      const ask = event.target.closest('[data-wr-ask]');
      if (ask) { const question = translate(ask.dataset.wrAsk, getLanguage()); close(); onAsk?.(question); return; }
      const control = event.target.closest('[data-wr]')?.dataset.wr;
      if (control === 'close') close();
      else if (control === 'pause') togglePause();
      else if (control === 'restart') go(0);
      else if (control === 'previous') open(customer, opener, 0, 'previous');
      // Back from the older story: return to the comparison card it was opened from.
      else if (control === 'latest') open(customer, opener, Math.max(0, recapsOf('current')[customer].findIndex(card => card.id === 'changes')), 'current');
      else if (control === 'prev') go(index - 1);
      else if (control === 'next') go(index + 1);
    });
    dialog.addEventListener('pointerdown', event => {
      if (event.target.closest('button') || !event.target.closest('.wr-stage')) return;
      press = { x: event.clientX, y: event.clientY, t: performance.now(), wasPaused: paused };
      paused = true;
      dialog.querySelector('.wr-stage')?.classList.add('is-holding');
    });
    dialog.addEventListener('pointerup', event => {
      if (!press) return;
      const dx = event.clientX - press.x, dy = event.clientY - press.y, held = performance.now() - press.t;
      paused = press.wasPaused;
      dialog.querySelector('.wr-stage')?.classList.remove('is-holding');
      press = null;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) { go(index + (dx < 0 ? 1 : -1)); return; }
      if (dy > 120 && Math.abs(dy) > Math.abs(dx)) { close(); return; }
      if (held > HOLD_MS) return; // a long press only pauses, like stories
      const rect = dialog.querySelector('.wr-stage').getBoundingClientRect();
      go(index + (event.clientX - rect.left < rect.width * 0.3 ? -1 : 1));
    });
    dialog.addEventListener('pointercancel', () => { if (press) { paused = press.wasPaused; press = null; } });
    document.addEventListener('visibilitychange', () => { if (document.hidden && dialog?.open) { paused = true; syncPause(); } });
  }

  function open(customerId, from, start = 0, year = 'current') {
    if (!has(customerId, year)) return;
    ensureDialog();
    if (!dialog.open) opener = from || document.activeElement;
    customer = customerId;
    cards = recapsOf(year)[customerId];
    const label = year === 'previous' ? 'Edellinen rahavuotesi' : 'Rahavuotesi';
    dialog.setAttribute('aria-label', label);
    paused = reducedMotion(); // no auto-advance for people who asked for less motion
    dialog.innerHTML = `<div class="wr-stage">
      <div class="wr-progress" aria-hidden="true">${cards.map(() => '<span><i></i></span>').join('')}</div>
      <div class="wr-top"><span class="wr-brand">${label}</span>
        <button type="button" class="wr-icon" data-wr="pause" aria-label="Keskeytä">❚❚</button>
        <button type="button" class="wr-icon" data-wr="close" aria-label="Sulje">✕</button></div>
      <div class="wr-slides" aria-live="polite">${cards.map((card, i) => renderSlide(card, i, cards.length)).join('')}</div>
      <div class="wr-nav"><button type="button" class="wr-icon" data-wr="prev" aria-label="Edellinen">‹</button><span class="wr-counter" aria-hidden="true"></span><button type="button" class="wr-icon" data-wr="next" aria-label="Seuraava">›</button></div>
    </div>`;
    // The comparison card is the only way into the older story, and the older story ends by handing back.
    if (year === 'previous' && has(customerId)) dialog.querySelector('.wr-outro .wr-actions')?.insertAdjacentHTML('afterbegin',
      '<button type="button" class="wr-primary" data-wr="latest">Takaisin tuoreimpaan rahavuoteen</button>');
    else if (year !== 'previous' && has(customerId, 'previous')) dialog.querySelector('.wr-changes .wr-content')?.insertAdjacentHTML('beforeend',
      '<button type="button" class="wr-ask wr-anim" data-wr="previous">Katso edellinen rahavuotesi<span aria-hidden="true">→</span></button>');
    if (!dialog.open) dialog.showModal();
    go(start);
    syncPause();
    last = performance.now();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  }

  function close() { if (dialog?.open) dialog.close(); }
  function stop() {
    cancelAnimationFrame(frame);
    if (opener?.isConnected) opener.focus();
  }

  function go(next) {
    if (!dialog) return;
    index = Math.max(0, Math.min(cards.length - 1, next));
    elapsed = 0;
    dialog.querySelectorAll('.wr-slide').forEach((slide, i) => {
      slide.classList.toggle('is-active', i === index);
      slide.classList.toggle('is-past', i < index);
      slide.setAttribute('aria-hidden', String(i !== index));
      slide.inert = i !== index;
    });
    dialog.querySelectorAll('.wr-progress span').forEach((bar, i) => {
      bar.firstElementChild.style.width = i < index ? '100%' : '0%';
    });
    dialog.querySelector('.wr-counter').textContent = `${index + 1} / ${cards.length}`;
    dialog.querySelector('[data-wr="prev"]').disabled = index === 0;
    dialog.querySelector('[data-wr="next"]').disabled = index === cards.length - 1;
    const slide = dialog.querySelector(`.wr-slide[data-index="${index}"]`);
    // Controls on top of the slide take the slide's text colour, so they stay visible on light themes.
    dialog.querySelector('.wr-stage').style.setProperty('--ui', getComputedStyle(slide).getPropertyValue('--fg').trim() || '#fff');
    countUp(slide);
  }

  function countUp(slide) {
    const target = slide?.querySelector('[data-count]');
    if (!target) return;
    const value = Number(target.dataset.count);
    if (reducedMotion() || !Number.isFinite(value)) { target.textContent = formatCount(value); return; }
    const start = performance.now(), duration = 1100;
    const step = now => {
      const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 3);
      target.textContent = formatCount(Math.round(value * eased));
      if (t < 1 && slide.classList.contains('is-active')) requestAnimationFrame(step);
      else target.textContent = formatCount(value);
    };
    requestAnimationFrame(step);
  }

  function togglePause() { paused = !paused; syncPause(); }
  function syncPause() {
    const button = dialog?.querySelector('[data-wr="pause"]');
    if (!button) return;
    button.textContent = paused ? '▶' : '❚❚';
    button.setAttribute('aria-label', paused ? 'Jatka' : 'Keskeytä');
  }

  function tick(now) {
    if (!dialog?.open) return;
    const dt = now - last;
    last = now;
    const lastCard = index === cards.length - 1;
    if (!paused && !lastCard) {
      elapsed += dt;
      if (elapsed >= AUTO_MS) go(index + 1);
    }
    const fill = dialog.querySelectorAll('.wr-progress span')[index]?.firstElementChild;
    if (fill) fill.style.width = `${lastCard ? 100 : Math.min(100, (elapsed / AUTO_MS) * 100)}%`;
    frame = requestAnimationFrame(tick);
  }

  return { load, has, teaser, open, close, reset };
}
