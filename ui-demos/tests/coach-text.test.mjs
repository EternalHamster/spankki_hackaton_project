import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCoachText, formatInline } from '../public/coach-text.js';
import { insightPeriod } from '../public/insights.js';

test('coach replies render bold amounts, paragraphs and real lists', () => {
  assert.equal(formatCoachText('**Syyskuu**\n\n- Menot: **340 €**.\n- __Tarkista tilaukset__.\n\nAloita rauhassa.'),
    '<p><strong>Syyskuu</strong></p><ul><li>Menot: <strong>340 €</strong>.</li><li><strong>Tarkista tilaukset</strong>.</li></ul><p>Aloita rauhassa.</p>');
  assert.equal(formatCoachText('1. **Katso laskut.**\r\n2. Valitse *seuraava askel*.'),
    '<ol><li><strong>Katso laskut.</strong></li><li>Valitse <em>seuraava askel</em>.</li></ol>');
  assert.equal(formatCoachText('## Seuraavaksi\nTarkista summa.\nJatka tästä.'),
    '<p><strong>Seuraavaksi</strong></p><p>Tarkista summa.<br>Jatka tästä.</p>');
});

test('model formatting never creates executable HTML or links', () => {
  const result = formatCoachText('**<img src=x onerror=alert(1)>**\n\n<script>alert(1)</script>\n[avaa](javascript:alert(1))');
  assert.match(result, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
  assert.match(result, /&lt;script&gt;/);
  assert.doesNotMatch(result, /<img|<script|<a\b|onerror="/);
  assert.equal(formatInline('`**<tag>**` & **saldo**'), '<code>**&lt;tag&gt;**</code> &amp; <strong>saldo</strong>');
  assert.equal(formatInline('Kesken **merkintä'), 'Kesken **merkintä');
});

test('insight dates distinguish a weekly estimate from monthly and rolling-year evidence', () => {
  assert.deepEqual(insightPeriod('weekly', '2026-09-30'), {label: 'Viikkonosto', detail: 'Viikkoarvio 30.9.2026 tilanteesta'});
  assert.deepEqual(insightPeriod('monthly', '2026-09-30'), {label: 'Kuukausinosto', detail: '1.9.2026–30.9.2026'});
  assert.deepEqual(insightPeriod('yearly', '2026-09-30'), {label: 'Vuosinosto', detail: '1.10.2025–30.9.2026 · 12 kk'});
  assert.equal(insightPeriod('yearly', '2026-01-31').detail, '1.2.2025–31.1.2026 · 12 kk');
  assert.equal(insightPeriod('monthly', '2024-02-29').detail, '1.2.2024–29.2.2024');
  assert.throws(() => insightPeriod('daily', '2026-09-30'));
  assert.throws(() => insightPeriod('monthly', '2026-02-30'));
});
