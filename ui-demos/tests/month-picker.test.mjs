import test from 'node:test';
import assert from 'node:assert/strict';
import { monthPickerState } from '../public/month-picker.js';

const available = ['2024-10', '2024-11', '2024-12', ...Array.from({ length: 12 }, (_, n) => `2025-${String(n + 1).padStart(2, '0')}`),
  ...Array.from({ length: 9 }, (_, n) => `2026-${String(n + 1).padStart(2, '0')}`)];

test('year slider preserves the month where recorded and clamps partial years to available data', () => {
  assert.equal(monthPickerState(available, '2026-09', 2025).value, '2025-09');
  assert.equal(monthPickerState(available, '2026-09', 2024).value, '2024-10');
  assert.equal(monthPickerState(available, '2025-12', 2026).value, '2026-09');
  assert.deepEqual(monthPickerState(available, '2024-10').months, [10, 11, 12]);
  assert.deepEqual(monthPickerState(available, '2026-09').years, [2024, 2025, 2026]);
});

test('slider choices stay valid with sparse data, a single month, and invalid selections', () => {
  assert.equal(monthPickerState(['2024-02', '2025-01', '2025-03'], '2024-02', 2025).value, '2025-01');
  assert.deepEqual(monthPickerState(['2026-09', '2026-09', '2026-13'], '2026-09').months, [9]);
  assert.throws(() => monthPickerState(available, '2026-10'));
  assert.throws(() => monthPickerState(available, '2026-09', 2027));
  assert.throws(() => monthPickerState([], '2026-09'));
});
