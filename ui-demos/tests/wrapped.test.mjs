import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderSlide, formatCount } from '../public/wrapped.js';

const wrapped = JSON.parse(fs.readFileSync(new URL('../server-data/wrapped-data.json', import.meta.url)));
const demo = JSON.parse(fs.readFileSync(new URL('../server-data/demo-data.json', import.meta.url)));
const layouts = new Set(['intro', 'hero', 'split', 'list', 'outro']);

test('every demo customer has a recap that starts with the intro and ends with the tip', () => {
  for (const profile of demo.profiles) {
    const cards = wrapped.recaps[profile.customer_id];
    assert.ok(cards, `missing recap for ${profile.customer_id}`);
    assert.ok(cards.length >= 8 && cards.length <= 12, `${profile.customer_id}: ${cards.length} cards`);
    assert.equal(cards[0].id, 'intro');
    assert.equal(cards.at(-1).id, 'outro');
  }
  assert.equal(wrapped.period.from, '2025-10-01');
  assert.equal(wrapped.period.to, '2026-09-30');
});

test('cards are complete and render without placeholders', () => {
  for (const [customer, cards] of Object.entries(wrapped.recaps)) {
    cards.forEach((card, i) => {
      assert.ok(layouts.has(card.layout), `${customer} ${card.id}`);
      assert.ok(card.kicker && card.theme, `${customer} ${card.id}`);
      if (card.count !== null) assert.ok(Number.isFinite(card.count), `${customer} ${card.id} count`);
      if (card.layout === 'list') assert.ok(card.items.length >= 3 && card.items.every(item => item.share > 0));
      const html = renderSlide(card, i, cards.length);
      assert.doesNotMatch(html, /undefined|NaN|\[object/, `${customer} ${card.id}`);
    });
  }
});

test('text is escaped and counts use Finnish number formatting', () => {
  const html = renderSlide({ id: 'x', layout: 'hero', theme: 'forest', kicker: '<script>', title: 'a"b', body: '', count: 1234, suffix: ' €', items: [], ask: 'Mitä <b>?', note: null }, 0, 1);
  assert.doesNotMatch(html, /<script>|<b>/);
  assert.match(formatCount(1234), /^1\s234$/);
});
