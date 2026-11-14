// Billable check of the three answer levels: asks the same questions at every level with the real coach
// and prints the answers side by side, with token usage. Needs ANTHROPIC_API_KEY and the DuckDB runtime.
//   node scripts/compare-levels.mjs                 # first demo customer, 3 questions x 3 levels = 9 chats
//   node scripts/compare-levels.mjs CUST00127 "Oma kysymys?"
import { createDataSource } from '../data-source.mjs';
import { createCoach, LEVELS } from '../coach.mjs';
import { DEMO_CUSTOMERS } from '../customers.mjs';

const [customer = DEMO_CUSTOMERS[0].id, ...custom] = process.argv.slice(2);
const questions = custom.length ? custom : [
  'Miksi rahat loppuvat ennen palkkapäivää?',
  'Paljonko voin käyttää tällä viikolla?',
  'Kulutanko ravintoloihin paljon?',
];
if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY first. This script makes paid API calls.'); process.exit(1); }

const dataSource = createDataSource();
const coach = createCoach({ dataSource, logger: () => {} });
const totals = Object.fromEntries(Object.keys(LEVELS).map(level => [level, { output: 0, input: 0, cached: 0, chars: 0, n: 0 }]));
try {
  for (const question of questions) {
    console.log(`\n${'='.repeat(80)}\n${question}`);
    for (const level of Object.keys(LEVELS)) {
      const result = await coach.chat(customer, { messages: [{ role: 'user', content: question }], level });
      const total = totals[level];
      total.output += result.usage.output_tokens; total.input += result.usage.input_tokens;
      total.cached += result.usage.cache_read_input_tokens; total.chars += result.answer.length; total.n++;
      console.log(`\n--- ${level} (${result.answer.length} chars, ${result.usage.output_tokens} output tokens, tools: ${result.tools_used.join(', ') || 'none'})\n${result.answer}`);
    }
  }
  console.log(`\n${'='.repeat(80)}\nAverages per answer`);
  for (const [level, t] of Object.entries(totals)) {
    console.log(`${level.padEnd(9)} ${Math.round(t.chars / t.n)} chars, ${Math.round(t.output / t.n)} output tokens, ` +
      `${Math.round(t.input / t.n)} uncached + ${Math.round(t.cached / t.n)} cached input tokens`);
  }
} finally { dataSource.close?.(); }
