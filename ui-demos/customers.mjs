import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEMO_CUSTOMERS = Object.freeze([
  { id: 'CUST00207', label: 'Demoasiakas 1 · Arjen valinnat' },
  { id: 'CUST00127', label: 'Demoasiakas 2 · Menot ja tulot' },
  { id: 'CUST00103', label: 'Demoasiakas 3 · Säästäminen' },
]);
const ids = new Set(DEMO_CUSTOMERS.map(row => row.id));
export const isDemoCustomer = id => ids.has(id);
const COOKIE = 'oma_demo_session';

export function createSessions({ secret = process.env.DEMO_SESSION_SECRET, now = Date.now,
  secure = process.env.NODE_ENV === 'production', ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('DEMO_SESSION_SECRET must be configured');
  const key = secret || randomBytes(32).toString('base64url');
  if (key.length < 32) throw new Error('Session signing key must be at least 32 characters');
  const sign = value => createHmac('sha256', key).update(value).digest('base64url');
  function read(req) {
    const token = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!token || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = Buffer.from(sign(payload)), supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return isDemoCustomer(session.customer_id) && typeof session.selection_id === 'string' &&
        /^[a-f0-9]{32}$/.test(session.selection_id) && Number.isFinite(session.expires) && session.expires > now() ? session : null;
    } catch { return null; }
  }
  function create(customerId, res) {
    if (!isDemoCustomer(customerId)) throw new Error('Unknown demo customer');
    const session = { customer_id: customerId, selection_id: randomBytes(16).toString('hex'), expires: now() + ttlMs };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`);
    return session;
  }
  return { read, create };
}

export function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
