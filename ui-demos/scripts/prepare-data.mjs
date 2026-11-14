import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../Data');
function parse(line) {
  const values = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { values.push(value); value = ''; }
    else value += c;
  }
  values.push(value); return values;
}
async function read(name, visit) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(source, name), { encoding: 'utf8' }), crlfDelay: Infinity });
  let headers;
  for await (const line of lines) {
    if (!headers) { headers = parse(line.replace(/^\uFEFF/, '')); continue; }
    if (line) visit(Object.fromEntries(parse(line).map((value, i) => [headers[i], value])));
  }
}
const customers = [], mortgages = [], history = [];
await read('tx_customers_junction.csv', r => customers.push(r));
await read('mtg_tx_customer_link_and_final_mtg_infio.csv', r => mortgages.push(r));
await read('mtg_negotiation_history.csv', r => history.push(r));
const ids = ['CUST00207', 'CUST00127', 'CUST00103', 'CUST04457'];
const candidates = ids.map(id => customers.find(c => c.customer_id === id));
const selected = new Map(candidates.map(c => [c.customer_id, { ...c, transactions: [] }]));
const categories = {}, types = {}; let count = 0, from = '9999', to = '';
await read('tx_junction_transactions.csv', r => {
  count++; categories[r.category] = (categories[r.category] || 0) + 1;
  types[r.transaction_type] = (types[r.transaction_type] || 0) + 1;
  if (r.tx_date < from) from = r.tx_date;
  if (r.tx_date > to) to = r.tx_date;
  const p = selected.get(r.customer_id);
  if (p) p.transactions.push({ date: r.tx_date, time: r.tx_timestamp.slice(8), category: r.category, amount: +r.tx_amount_eur, balance: +r.balance_after_eur, type: r.transaction_type, merchant: r.merchant_id, mcc: r.mcc_code, account: r.bank_account_id });
});
const profiles = [...selected.values()];
for (const p of profiles) p.transactions.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
const summary = { count, customerCount: customers.length, from, to, categories, types, mortgageCount: mortgages.length, mortgageEventCount: history.length };
fs.mkdirSync(path.join(root, 'server-data'), { recursive: true });
fs.writeFileSync(path.join(root, 'server-data/demo-data.json'), JSON.stringify({ summary, profiles, mortgage: mortgages.find(m => m.customer_id === 'CUST04457'), history: history.filter(e => e.mortgage_customer_id === 'C0004') }));
console.log(JSON.stringify({ summary, profiles: profiles.map(p => ({ id: p.customer_id, rows: p.transactions.length })) }, null, 2));
