import { locale } from './language.js';
const monthLabel = month => new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' })
  .format(new Date(Date.UTC(2026, month - 1, 15)));
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const label = value => `${capitalize(monthLabel(Number(value.slice(5))))} ${value.slice(0, 4)}`;

// Wheel positions refer only to recorded months, including partial first/last years.
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

const wheelLabel = (kind, value) => kind === 'month' ? capitalize(monthLabel(value)) : String(value);
const wheelId = (scope, kind, value) => `month-wheel-${scope}-${kind}-${value}`;
function wheelOptions(scope, kind, values, selected) {
  const index = values.indexOf(selected);
  return values.map((value, i) => `<div id="${wheelId(scope, kind, value)}" role="option" aria-selected="${value === selected}" data-wheel-index="${i}" style="--wheel-distance:${Math.min(3, Math.abs(i - index))}">${wheelLabel(kind, value)}</div>`).join('');
}
function renderWheel(scope, kind, values, selected) {
  return `<div class="month-picker-wheel" data-month-wheel="${kind}" data-wheel-values="${values.join(',')}" role="listbox" aria-label="${kind === 'month' ? 'Kuukausi' : 'Vuosi'}" aria-orientation="vertical" aria-activedescendant="${wheelId(scope, kind, selected)}" tabindex="0">${wheelOptions(scope, kind, values, selected)}</div>`;
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
        <div class="month-picker-wheel-labels" aria-hidden="true"><span>Kuukausi</span><span>Vuosi</span></div>
        <div class="month-picker-wheels">
          ${renderWheel(scope, 'month', state.months, state.month)}
          ${renderWheel(scope, 'year', state.years, state.year)}
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
  const rowHeight = wheel => wheel.firstElementChild?.offsetHeight || 48;
  const paint = (picker, state, scrollingWheel = null) => {
    drafts.set(picker, state);
    for (const [kind, values, value] of [
      ['month', state.months, state.month],
      ['year', state.years, state.year],
    ]) {
      const wheel = picker.querySelector(`[data-month-wheel="${kind}"]`), index = values.indexOf(value);
      const changed = wheel.dataset.wheelValues !== values.join(',');
      if (changed) {
        wheel.dataset.wheelValues = values.join(',');
        wheel.innerHTML = wheelOptions(picker.dataset.monthPicker, kind, values, value);
      }
      wheel.setAttribute('aria-activedescendant', wheelId(picker.dataset.monthPicker, kind, value));
      Array.from(wheel.children).forEach((option, i) => {
        option.setAttribute('aria-selected', String(i === index));
        option.style.setProperty('--wheel-distance', String(Math.min(3, Math.abs(i - index))));
      });
      if (changed || wheel !== scrollingWheel) wheel.scrollTop = index * rowHeight(wheel);
    }
  };
  const select = (wheel, index, scrolling = false) => {
    const picker = wheel.closest('[data-month-picker]'), state = drafts.get(picker);
    if (!state || !Number.isInteger(index)) return;
    const kind = wheel.dataset.monthWheel, values = kind === 'month' ? state.months : state.years;
    const value = values[index];
    if (value === undefined) return;
    if (scrolling && value === state[kind]) return;
    const available = picker.dataset.monthOptions.split(',');
    const next = kind === 'year' ? monthPickerState(available, state.value, value)
      : monthPickerState(available, `${state.year}-${String(value).padStart(2, '0')}`);
    paint(picker, next, scrolling ? wheel : null);
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
      disclosure.open = true;
      paint(picker, monthPickerState(picker.dataset.monthOptions.split(','), picker.dataset.selectedMonth));
      picker.querySelector('[data-month-wheel]').focus({ preventScroll: true });
      picker.querySelector('.month-picker-panel').scrollIntoView({ block: 'nearest' });
    } else if (event.target.closest('[data-wheel-index]')) {
      const option = event.target.closest('[data-wheel-index]'), wheel = option.closest('[data-month-wheel]');
      select(wheel, Number(option.dataset.wheelIndex));
      wheel.focus({ preventScroll: true });
    } else if (event.target.closest('[data-month-cancel]')) {
      close(picker, true);
    } else if (event.target.closest('[data-month-apply]')) {
      const state = drafts.get(picker);
      if (!state || !picker.dataset.monthOptions.split(',').includes(state.value)) return;
      close(picker);
      if (state.value !== picker.dataset.selectedMonth) onSelect(picker.dataset.monthPicker, state.value);
      root.querySelector(`#month-${picker.dataset.monthPicker}`)?.focus({ preventScroll: true });
    }
  });
  root.addEventListener('scroll', event => {
    const wheel = event.target;
    if (!wheel.matches?.('[data-month-wheel]')) return;
    select(wheel, Math.round(wheel.scrollTop / rowHeight(wheel)), true);
  }, true);
  root.addEventListener('keydown', event => {
    const picker = event.target.closest('[data-month-picker]');
    if (event.key === 'Escape' && picker?.querySelector('details').open) {
      event.preventDefault(); event.stopPropagation(); close(picker, true);
      return;
    }
    const wheel = event.target.closest('[data-month-wheel]'), state = drafts.get(picker);
    if (!wheel || !state) return;
    const kind = wheel.dataset.monthWheel, values = kind === 'month' ? state.months : state.years;
    const index = values.indexOf(state[kind]);
    const next = { ArrowUp: index - 1, ArrowDown: index + 1, PageUp: index - 3, PageDown: index + 3, Home: 0, End: values.length - 1 }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      select(wheel, Math.max(0, Math.min(values.length - 1, next)));
    }
  }, true);
  root.addEventListener('focusout', event => {
    const picker = event.target.closest('[data-month-picker]');
    if (picker && event.relatedTarget && !picker.contains(event.relatedTarget)) close(picker);
  });
}
