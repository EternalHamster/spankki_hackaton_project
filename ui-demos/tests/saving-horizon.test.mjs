import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAVING_HORIZON, SAVING_HORIZONS, isSavingHorizon, renderSavingHorizon } from '../public/saving-horizon.js';
import { translate } from '../public/translations.js';

test('saving timeframe choices have native radio keyboard behavior and one selected choice', () => {
  assert.equal(DEFAULT_SAVING_HORIZON, 'weekly');
  assert.deepEqual(SAVING_HORIZONS.map(option => option.id), ['weekly', 'monthly', 'yearly']);
  for (const { id } of SAVING_HORIZONS) {
    const markup = renderSavingHorizon(id);
    assert.match(markup, /<fieldset class="saving-horizon"><legend>Valitse muutoksen aikaväli<\/legend>/);
    const radios = [...markup.matchAll(/<input[^>]+>/g)].map(match => match[0]);
    assert.equal(radios.length, 3);
    assert.ok(radios.every(radio => /type="radio" name="saving-horizon"/.test(radio)));
    assert.deepEqual(radios.filter(radio => / checked/.test(radio)), [radios.find(radio => radio.includes(`value="${id}"`))]);
    assert.equal(isSavingHorizon(id), true);
  }
  for (const value of [undefined, null, '', 'daily', 'constructor', 0]) assert.equal(isSavingHorizon(value), false);
  assert.throws(() => renderSavingHorizon('daily'), TypeError);
});

test('saving timeframe labels and short coach questions are fully translated', () => {
  const labels = ['Weekly changes', 'Monthly changes', 'Yearly changes'];
  for (const [index, option] of SAVING_HORIZONS.entries()) {
    assert.equal(translate(option.label, 'en'), labels[index]);
    assert.equal(translate(option.label, 'fi'), option.label);
  }
  assert.equal(translate('Valitse muutoksen aikaväli', 'en'), 'Choose a timeframe for changes');
  for (const [finnish, english] of [['viikoittaisilla', 'weekly'], ['kuukausittaisilla', 'monthly'], ['vuosittaisilla', 'yearly']]) {
    const question = `Millaisilla ${finnish} muutoksilla voisin säästää enemmän?`;
    assert.equal(translate(question, 'en'), `What ${english} changes could help me save more?`);
    assert.equal(translate(`${question} Vinkkien pohjana ovat kuukauden 2026-09 tiedot.`, 'en'),
      `What ${english} changes could help me save more? Tips are based on data from 2026-09.`);
  }
});
