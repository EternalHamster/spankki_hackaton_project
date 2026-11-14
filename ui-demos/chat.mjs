import { LEVELS, validAnswerRewrite } from './coach.mjs';
import { validMemoryFacts } from './public/customer-memory.js';
import { validProjectContext, validProjectProposal } from './public/purchase-projects.js';
import { isLanguage } from './public/language.js';

// Validates and bounds browser conversation before the customer-scoped coach runs.
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
  if (!body || Object.keys(body).some(key => !['messages', 'insight', 'level', 'language', 'memory', 'projects', 'pending_project', 'rewrite'].includes(key)) || !Array.isArray(messages) ||
      !messages.length || messages.length > 11 || messages.length % 2 !== 1 ||
      messages.some((m, i) => !m || Object.keys(m).length !== 2 ||
        m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' ||
        !m.content.trim() || m.content.length > (i % 2 ? 6000 : 2000)) ||
      messages.reduce((n, m) => n + m.content.length, 0) > 14000) {
    throw new ChatError(400, 'Kysymys on liian pitkä tai keskustelu ei kelpaa. Aloita tarvittaessa uusi keskustelu.');
  }
  const insight = body.insight;
  if (body.language !== undefined && !isLanguage(body.language)) throw new ChatError(400, 'Valitse kieli.');
  if (insight !== undefined && (!insight || Object.keys(insight).length !== 1 || typeof insight.insight_id !== 'string')) {
    throw new ChatError(400, 'Valitse havainto etusivulta.');
  }
  if (body.level !== undefined && !(typeof body.level === 'string' && Object.hasOwn(LEVELS, body.level))) {
    throw new ChatError(400, 'Valitse vastausten taso.');
  }
  if (body.rewrite !== undefined && !validAnswerRewrite(body.rewrite)) throw new ChatError(400, 'Valitse muokattava vastaus uudelleen.');
  if (body.memory !== undefined && !validMemoryFacts(body.memory)) throw new ChatError(400, 'Valmentajan muistitiedot eivät kelpaa.');
  if ((body.projects !== undefined && !validProjectContext(body.projects)) ||
      (body.pending_project !== undefined && body.pending_project !== null && !validProjectProposal(body.pending_project))) {
    throw new ChatError(400, 'Tavoitteiden tiedot eivät kelpaa.');
  }
  return { messages: messages.map(({ role, content }) => ({ role, content: content.trim() })), insight, level: body.level, language: body.language ?? 'fi',
    memory: body.memory || [], projects: body.projects || [], pendingProject: body.pending_project || null,
    rewrite: body.rewrite === undefined ? undefined : { answer: body.rewrite.answer.trim() } };
}

export function createChatHandler({ answer, now = Date.now, requestsPerMinute = 30, maxConcurrent = 4 } = {}) {
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
        throw new ChatError(405, 'Use POST for chat.');
      }
      const { messages, insight, level, language, memory, projects, pendingProject, rewrite } = await readMessages(req);
      const time = now();
      recent = recent.filter(t => time - t < 60000);
      if (active >= maxConcurrent || recent.length >= requestsPerMinute) throw new ChatError(429, 'Keskustelussa on ruuhkaa. Yritä hetken kuluttua uudelleen.');
      recent.push(time); active++; claimed = true;
      const result = await answer(req.demoSession, messages, insight, level, memory, projects, pendingProject, rewrite, language);
      if (typeof result?.answer !== 'string' || !result.answer.trim()) throw new ChatError(502, 'Vastausta ei saatu. Yritä uudelleen.');
      send(200, { ...result, selection_id: req.demoSession.selection_id });
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      const status = error.status >= 400 && error.status < 600 ? error.status : timeout ? 504 : 502;
      send(status, { error: error.status ? error.message : timeout ? 'Vastaus viipyy. Yritä uudelleen.' : 'Yhteys katkesi. Yritä hetken kuluttua uudelleen.' });
    } finally { if (claimed) active--; }
  };
}
