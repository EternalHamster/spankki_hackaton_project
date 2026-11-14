import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';

const data = JSON.parse(readFileSync(new URL('../server-data/demo-data.json', import.meta.url), 'utf8'));
export const stubDataSource = () => ({
  ready: async () => ({ as_of: '2026-09-30', version: 'test-snapshot' }),
  bootstrap: async customer => ({ summary: data.summary, profiles: [data.profiles.find(p => p.customer_id === customer)] }),
  context: async () => ({ profile: 'Own profile', insight_context: 'Own insights', as_of: '2026-09-30', version: 'test-snapshot' }),
  toolDefinitions: async () => [], execute: async () => ({ error: 'not_available' }), close() {},
});
export const stubCoach = (overrides = {}) => ({
  insights: async customer => ({ status: 'ready', as_of: '2026-09-30', insights: [1, 2, 3].map(n => ({
    id: `${customer}-${n}`, title: `Havainto ${n}`, headline_number: '250 €', explanation: 'Testihavainto.', action: 'Tutustu menoihisi.',
  })) }),
  chat: async () => ({ answer: 'Hei! Miten voin auttaa?' }), ...overrides,
});
export async function serve(t, options = {}) {
  const server = createAppServer({ dataSource: stubDataSource(), coach: stubCoach(), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, session: customer => openSession(base, customer) };
}
export async function openSession(base, customer) {
  const response = await fetch(base + '/api/session', customer ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: customer }) } : {});
  if (!response.ok) throw new Error('Could not initialize test session');
  const state = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Demo-Selection': state.selection_id };
  return { ...state, cookie, headers,
    get: (route, extra = {}) => fetch(base + route, { headers: { ...headers, ...extra } }),
    post: (body = { messages: [{ role: 'user', content: 'Hei' }] }, extra = {}) => fetch(base + '/api/chat', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
    }),
  };
}
