import { locale } from './language.js';
const monthLabel = month => new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' })
  .format(new Date(Date.UTC(2026, month - 1, 15)));
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const label = value => `${capitalize(monthLabel(Number(value.slice(5))))} ${value.slice(0, 4)}`;

// Slider positions refer only to recorded months, including partial first/last years.
export function monthPickerState(available, selected, year = Number(selected?.slice(0, 4))) {
  const values = [...new Set(available.filter(value => typeof value === 'string' && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)))].sort();
  if (!values.length || !values.includes(selected)) throw new TypeError('Invalid month selection');
  const years = [...new Set(values.map(value => Number(value.slice(0, 4))))];
  if (!years.includes(year)) throw new TypeError('Unavailable year');
  const months = values.filter(value => Number(value.slice(0, 4)) === year).map(value => Number(value.slice(5)));
  const desired = Number(selected.slice(5));
  const month = months.reduce((nearest, candidate) => Math.abs(candidate - desired) < Math.abs(nearest - desired) ? candidate : nearest);
  return { years, months, year, month, value: `${year}-${String(month).padStart(2, '0')}` };
}

export function renderMonthPicker({ scope, selected, available, calendarIcon, chevronIcon }) {
  if (!['spending', 'saving', 'transactions'].includes(scope)) throw new TypeError('Unknown month scope');
  const state = monthPickerState(available, selected);
  const values = [...new Set(available)].filter(value => /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)).sort();
  return `<div class="section-month-picker" data-month-picker="${scope}" data-selected-month="${selected}" data-month-options="${values.join(',')}">
    <span>${calendarIcon}Kuukausi</span>
    <details class="month-picker-disclosure">
      <summary id="month-${scope}" class="month-picker-trigger" aria-label="Valitse kuukausi, ${label(selected)}"><span>${label(selected)}</span>${chevronIcon}</summary>
      <div class="month-picker-panel" role="group" aria-label="Valitse kuukausi ja vuosi">
        <div class="month-picker-preview"><span>Tarkasteltava ajanjakso</span><strong data-month-preview>${label(selected)}</strong></div>
        <div class="month-picker-control">
          <label for="month-slider-${scope}">Kuukausi <output for="month-slider-${scope}" data-month-output>${capitalize(monthLabel(state.month))}</output></label>
          <input id="month-slider-${scope}" data-month-slider type="range" min="0" max="${state.months.length - 1}" step="1" value="${state.months.indexOf(state.month)}" aria-valuetext="${capitalize(monthLabel(state.month))}">
          <div class="month-picker-scale" aria-hidden="true"><span data-month-first></span><span data-month-last></span></div>
        </div>
        <div class="month-picker-control">
          <label for="year-slider-${scope}">Vuosi <output for="year-slider-${scope}" data-year-output>${state.year}</output></label>
          <input id="year-slider-${scope}" data-year-slider type="range" min="0" max="${state.years.length - 1}" step="1" value="${state.years.indexOf(state.year)}" aria-valuetext="${state.year}">
          <div class="month-picker-years" aria-hidden="true">${state.years.map(year => `<span>${year}</span>`).join('')}</div>
        </div>
        <p class="month-picker-hint">Valittavissa ovat kuukaudet, joilta on tietoja.</p>
        <div class="month-picker-actions"><button type="button" data-month-cancel>Peruuta</button><button type="button" data-month-apply>Näytä kuukausi</button></div>
      </div>
    </details>
  </div>`;
}

export function installMonthPickers({ onSelect, root = document }) {
  const drafts = new WeakMap();
  const close = (picker, focus = false) => {
    picker.querySelector('details').open = false;
    drafts.delete(picker);
    if (focus && picker.isConnected) picker.querySelector('summary').focus({ preventScroll: true });
  };
  const paint = (picker, state) => {
    drafts.set(picker, state);
    picker.querySelector('[data-month-preview]').textContent = label(state.value);
    picker.querySelector('[data-month-output]').textContent = capitalize(monthLabel(state.month));
    picker.querySelector('[data-year-output]').textContent = state.year;
    picker.querySelector('[data-month-first]').textContent = capitalize(monthLabel(state.months[0]));
    picker.querySelector('[data-month-last]').textContent = state.months.length > 1 ? capitalize(monthLabel(state.months.at(-1))) : '';
    for (const [selector, values, value, text] of [
      ['[data-month-slider]', state.months, state.month, capitalize(monthLabel(state.month))],
      ['[data-year-slider]', state.years, state.year, String(state.year)],
    ]) {
      const input = picker.querySelector(selector);
      input.max = String(values.length - 1); input.value = String(values.indexOf(value)); input.disabled = values.length < 2;
      input.setAttribute('aria-valuetext', text);
      input.style.setProperty('--range-progress', `${values.length > 1 ? values.indexOf(value) / (values.length - 1) * 100 : 0}%`);
    }
  };
  root.addEventListener('click', event => {
    const picker = event.target.closest('[data-month-picker]');
    root.querySelectorAll('[data-month-picker] details[open]').forEach(open => {
      if (!picker || !picker.contains(open)) close(open.closest('[data-month-picker]'));
    });
    if (!picker) return;
    const disclosure = picker.querySelector('details');
    if (event.target.closest('.month-picker-trigger')) {
      event.preventDefault();
      if (disclosure.open) { close(picker); return; }
      paint(picker, monthPickerState(picker.dataset.monthOptions.split(','), picker.dataset.selectedMonth));
      disclosure.open = true;
      picker.querySelector('[data-month-slider]').focus({ preventScroll: true });
      picker.querySelector('.month-picker-panel').scrollIntoView({ block: 'nearest' });
    } else if (event.target.closest('[data-month-cancel]')) {
      close(picker, true);
    } else if (event.target.closest('[data-month-apply]')) {
      const state = drafts.get(picker);
      if (!state) return;
      close(picker);
      if (state.value !== picker.dataset.selectedMonth) onSelect(picker.dataset.monthPicker, state.value);
      root.querySelector(`#month-${picker.dataset.monthPicker}`)?.focus({ preventScroll: true });
    }
  });
  root.addEventListener('input', event => {
    const input = event.target;
    if (!input.matches('[data-month-slider], [data-year-slider]')) return;
    const picker = input.closest('[data-month-picker]'), state = drafts.get(picker);
    if (!state) return;
    const index = Number(input.value);
    if (!Number.isInteger(index)) return;
    const available = picker.dataset.monthOptions.split(',');
    if (input.hasAttribute('data-year-slider') && state.years[index] !== undefined) {
      paint(picker, monthPickerState(available, state.value, state.years[index]));
    } else if (input.hasAttribute('data-month-slider') && state.months[index] !== undefined) {
      paint(picker, monthPickerState(available, `${state.year}-${String(state.months[index]).padStart(2, '0')}`));
    }
  });
  root.addEventListener('keydown', event => {
    const picker = event.target.closest('[data-month-picker]');
    if (event.key === 'Escape' && picker?.querySelector('details').open) {
      event.preventDefault(); event.stopPropagation(); close(picker, true);
    }
  }, true);
  root.addEventListener('focusout', event => {
    const picker = event.target.closest('[data-month-picker]');
    if (picker && event.relatedTarget && !picker.contains(event.relatedTarget)) close(picker);
  });
}
