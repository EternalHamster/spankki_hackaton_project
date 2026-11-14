// Text-only chat. This module never reads the demo data or calls financial tools.
const SYSTEM = `You are a friendly, concise assistant in the Oma talous demo. Reply in the user's language, defaulting to Finnish. You can discuss general budgeting and everyday questions. You have no access to accounts, balances, transactions, customer profiles, or project data. If asked about the user's finances, explain that account data is not connected yet; never invent personal figures. Only the conversation below is available. Keep answers brief and readable, using plain text.`;

class ChatError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readMessages(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ChatError(415, 'Lähetä kysymys JSON-muodossa.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) throw new ChatError(413, 'Keskustelu on liian pitkä. Aloita uusi keskustelu.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ChatError(400, 'Kysymystä ei voitu lukea.'); }
  const messages = body?.messages;
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(messages) ||
      !messages.length || messages.length > 11 || messages.length % 2 !== 1 ||
      messages.some((m, i) => !m || Object.keys(m).length !== 2 ||
        m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' ||
        !m.content.trim() || m.content.length > (i % 2 ? 6000 : 2000)) ||
      messages.reduce((n, m) => n + m.content.length, 0) > 14000) {
    throw new ChatError(400, 'Kysymys on liian pitkä tai keskustelu ei kelpaa. Aloita tarvittaessa uusi keskustelu.');
  }
  return messages.map(({ role, content }) => ({ role, content: content.trim() }));
}

export function createChatHandler({ apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.CLAUDE_MODEL || 'claude-haiku-5-5', fetchImpl = fetch,
  now = Date.now, requestsPerMinute = 30, maxConcurrent = 4 } = {}) {
  let active = 0, recent = [];
  return async function chat(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(JSON.stringify(body));
    };
    let claimed = false;
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new ChatError(405, 'Käytä POST-pyyntöä.');
      }
      // Same-origin browser requests only; credentials never enter the public bundle.
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new ChatError(403, 'Avaa keskustelu sovelluksesta.');
      if (req.headers.origin) {
        let host;
        try { host = new URL(req.headers.origin).host; } catch { /* reject below */ }
        if (host !== req.headers.host) throw new ChatError(403, 'Avaa keskustelu sovelluksesta.');
      }
      if (!apiKey?.trim()) throw new ChatError(503, 'Keskustelu ei ole juuri nyt käytettävissä. Yritä myöhemmin uudelleen.');
      const messages = await readMessages(req);
      const time = now();
      recent = recent.filter(t => time - t < 60000);
      if (active >= maxConcurrent || recent.length >= requestsPerMinute) {
        throw new ChatError(429, 'Keskustelussa on ruuhkaa. Odota hetki ja yritä uudelleen.');
      }
      recent.push(time); active++; claimed = true;
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000),
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
          'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 800, thinking: { type: 'disabled' }, system: SYSTEM, messages }),
      });
      if (!response.ok) {
        // Log only status codes, never provider bodies, prompts or credentials.
        console.warn(JSON.stringify({ severity: 'WARNING', message: 'Chat provider request failed', status: response.status }));
        await response.body?.cancel();
        throw new ChatError(response.status === 429 ? 429 : 502, 'Vastausta ei saatu juuri nyt. Yritä hetken kuluttua uudelleen.');
      }
      const result = await response.json();
      const answer = result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!answer || answer.length > 6000) throw new ChatError(502, 'Vastausta ei saatu. Yritä lyhyemmällä kysymyksellä.');
      send(200, { answer });
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      send(error instanceof ChatError ? error.status : timeout ? 504 : 502,
        { error: error instanceof ChatError ? error.message : timeout ?
          'Vastauksen saaminen kesti liian kauan. Yritä uudelleen.' : 'Yhteys katkesi. Yritä hetken kuluttua uudelleen.' });
    } finally { if (claimed) active--; }
  };
}
