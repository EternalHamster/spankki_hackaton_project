import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerDepthSettings, LEVEL_KEY } from '../public/answer-depth.js';

function localStore(initial) {
  const values = new Map(initial === undefined ? [] : [[LEVEL_KEY, initial]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
}

test('the main setting preserves existing choices, survives new instances and sees other tabs', () => {
  const storage = localStore('simple');
  const settings = createAnswerDepthSettings({ storage: () => storage });
  assert.equal(settings.get(), 'simple');
  assert.deepEqual(settings.set('detailed'), { level: 'detailed', persisted: true });
  assert.equal(createAnswerDepthSettings({ storage: () => storage }).get(), 'detailed');
  storage.setItem(LEVEL_KEY, 'standard');
  assert.equal(settings.get(), 'standard');
  storage.removeItem(LEVEL_KEY);
  assert.equal(settings.get(), 'standard');
});

test('missing or corrupt preferences default to standard and invalid changes cannot overwrite them', () => {
  for (const initial of [undefined, 'unknown', '', '{"id":"simple"}']) {
    const storage = localStore(initial);
    const settings = createAnswerDepthSettings({ storage: () => storage });
    assert.equal(settings.get(), 'standard');
    for (const id of ['unknown', '', null, undefined, 0, { id: 'simple' }]) assert.throws(() => settings.set(id), RangeError);
    assert.equal(storage.getItem(LEVEL_KEY), initial ?? null);
  }
});

test('blocked storage retains the chosen depth for the current visit without claiming persistence', () => {
  const blocked = createAnswerDepthSettings({ storage: () => { throw new Error('Blocked getter'); } });
  assert.equal(blocked.get(), 'standard');
  assert.deepEqual(blocked.set('simple'), { level: 'simple', persisted: false });
  assert.equal(blocked.get(), 'simple');
  const storage = localStore('standard');
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  const readOnly = createAnswerDepthSettings({ storage: () => storage });
  assert.equal(readOnly.get(), 'standard');
  assert.equal(readOnly.set('detailed').persisted, false);
  assert.equal(readOnly.get(), 'detailed', 'an old readable value must not undo a choice that could not be saved');
});
