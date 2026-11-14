export const SAVING_HORIZONS = Object.freeze([
  Object.freeze({ id: 'weekly', label: 'Viikoittaiset muutokset' }),
  Object.freeze({ id: 'monthly', label: 'Kuukausittaiset muutokset' }),
  Object.freeze({ id: 'yearly', label: 'Vuosittaiset muutokset' }),
]);

export const DEFAULT_SAVING_HORIZON = 'weekly';
export const isSavingHorizon = value => SAVING_HORIZONS.some(option => option.id === value);

export function renderSavingHorizon(selected = DEFAULT_SAVING_HORIZON) {
  if (!isSavingHorizon(selected)) throw new TypeError('Unknown saving horizon');
  return `<fieldset class="saving-horizon"><legend>Valitse muutoksen aikaväli</legend>
    <div class="saving-horizon-options">${SAVING_HORIZONS.map(({ id, label }) => `<label><input type="radio" name="saving-horizon" data-saving-horizon="${id}" value="${id}"${id === selected ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div>
  </fieldset>`;
}
