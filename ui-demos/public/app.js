import { createChatDialog } from './chat.js';
import { createWrapped } from './wrapped.js';
import { metrics, basketTotals, scenarioSavings, transactionKind } from './model.js';
import { createFinanceAnalytics } from './finance-analytics/index.js';
import { moveMonth } from './finance-analytics/model.js';
import { projectFinanceData } from './adapters/project-finance.js';
import { explorationTopics, createExplorationSummaries, affordQuestion } from './exploration.js';
import { formatInline } from './coach-text.js';
import { insightPeriod } from './insights.js';
import { setDisclosure } from './disclosure.js';

// Appearance follows the user's references; all money data is synthetic.
const paths={
  home:'<path d="m2 11 10-9 10 9M5 9v13h5v-7h4v7h5V9"/>',
  wallet:'<path d="M20 7H4V3h14v4M4 7H2v15h20V7ZM17 14h.01"/>',
  person:'<circle cx="12" cy="6" r="4"/><path d="M3 22c0-7 4-11 9-11s9 4 9 11Z"/>',
  chat:'<path d="M3 3h18v13H9l-6 5Z"/><path d="M7 8h10M7 12h6"/>',
  chart:'<path d="M3 2v20h19M8 17V9m6 8V4m6 13v-5"/>',
  account:'<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M4 19h16M14 6c-4 0-6 2-6 6v3m8-7c-3 0-5 1-5 5v3m3-6v4c0 2-1 3-3 3"/>',
  bag:'<path d="M5 7h14l2 15H3ZM9 8V5a3 3 0 0 1 6 0v3"/><path d="M12 17s-5-3-3-5c1-1 3 0 3 1 0-1 2-2 3-1 2 2-3 5-3 5Z" fill="currentColor" stroke="none"/>',
  receipt:'<path d="M5 2h14v20l-4-2-3 2-3-2-4 2ZM8 7h8M8 11h8M8 15h6"/>',
  calendar:'<rect x="3" y="5" width="18" height="17" rx="1"/><path d="M7 2v6m10-6v6M3 11h18m-13 5h3m3 0h3"/>',
  coffee:'<path d="M3 7h14v10a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5ZM17 9h2c5 0 5 8 0 8h-2M7 1v3m6-3v3"/>',
  train:'<rect x="5" y="2" width="14" height="16" rx="4"/><path d="M5 9h14M9 22l2-4m4 4-2-4M8 14h1m6 0h1"/>',
  shield:'<path d="m12 2 9 4v7c0 5-9 9-9 9s-9-4-9-9V6Z"/><path d="m7 11 3 3 7-7"/>',
  bolt:'<path d="m13 2-9 12h7l-1 8 10-13h-8Z"/>',
  plus:'<path d="M12 3v18M3 12h18"/>',
  close:'<path d="m5 5 14 14M5 19 19 5"/>',
  chevron:'<path d="m9 4 8 8-8 8"/>',
  arrow:'<path d="M3 12h18m-7-7 7 7-7 7"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 10v7m0-11v1"/>',
  check:'<path d="m3 12 6 6L21 4"/>',
};
const icon=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.receipt}</svg>`;
const sMark=()=>'<svg class="s-mark" viewBox="0 0 35 48" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M29 3C13 3 9 12 9 25c0 9-2 14-7 14v6c12 0 14-9 14-20 0-10 3-15 13-15Z"/><path d="M29 16c-6 0-7 3-7 12 0 12-5 17-14 17"/></svg>';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const euro=(n,digits=2)=>new Intl.NumberFormat('fi-FI',{style:'currency',currency:'EUR',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n===0?0:n);
const monthName=value=>new Date(value+'-15T12:00:00Z').toLocaleDateString('fi-FI',{month:'long',year:'numeric',timeZone:'UTC'});
const capitalize=s=>s.charAt(0).toUpperCase()+s.slice(1);
const names={Housing:'Asuminen',Utilities:'Laskut ja palvelut',Groceries:'Ruokaostokset',Health:'Terveys','Home & Tech':'Koti ja tekniikka',Transportation:'Liikkuminen',Restaurants:'Ravintolat',Lifestyle:'Ostokset',Entertainment:'Vapaa-aika',Travel:'Matkailu',Salary:'Palkka','Other Income':'Muut tulot','Invest Deposit':'Siirto sijoituksiin','Invest Withdraw':'Nosto sijoituksista','Salary Sweep':'Palkkasiirto'};
const categoryIcon=c=>({Housing:'home',Utilities:'bolt',Groceries:'bag',Transportation:'train',Restaurants:'coffee',Health:'shield',Salary:'plus'}[c]||'receipt');
const root=document.querySelector('#root'),detail=document.querySelector('#detail');
let data,profile,m,lastFocus,analytics;
const selectedMonths = { spending: null, saving: null, transactions: null };
let transactionFilter = 'all';
const months=[];
let insightsPromise = null, activeInsights = null, insightController = null;
let customerSession = null, customerController = null, customerEpoch = 0, synchronizingSession = false;
const explorationSummaries = createExplorationSummaries();
let activeTopic = null, activeTopicResult = null;
const basketInfo=[['Säännölliset tarpeet','Asuminen, ruoka, laskut ja liikkuminen','home'],['Yllättävät tarpeet','Terveys sekä koti ja tekniikka','shield'],['Arjen valinnat','Ravintolat, ostokset ja vapaa-aika','coffee']];

class StaleSelectionError extends Error {}
const selectionHeaders = selected => ({ 'X-Demo-Selection': selected.selection_id });
const customerLabel = () => customerSession?.customers.find(customer => customer.id === customerSession.customer_id)?.label || 'Demoasiakas';
const topicMonth = topic => selectedMonths[topic] || customerSession?.as_of?.slice(0, 7) || data?.summary.to.slice(0, 7);
const dateLabel = date => new Date(date + 'T12:00:00Z').toLocaleDateString('fi-FI', { timeZone: 'UTC' });
function monthPicker(scope) {
  return `<label class="section-month-picker" for="month-${scope}"><span>${icon('calendar')}Kuukausi</span><select id="month-${scope}" data-month-scope="${scope}">${months.map(month=>`<option value="${month}" ${month===selectedMonths[scope]?'selected':''}>${capitalize(monthName(month))}</option>`).join('')}</select></label>`;
}

async function loadCustomer(customerId) {
  const epoch = ++customerEpoch;
  customerController?.abort(); insightController?.abort();
  explorationSummaries.reset(); activeTopic = null; activeTopicResult = null;
  for (const scope of Object.keys(selectedMonths)) selectedMonths[scope] = null;
  transactionFilter = 'all';
  customerController = new AbortController();
  const signal = customerController.signal;
  customerSession = null;
  showChat.reset(); wrapped.reset(); analytics?.destroy();
  if (detail.open) detail.close();
  detail.innerHTML = '';
  data = null; profile = null; m = null; analytics = null; activeInsights = null; insightsPromise = null;
  root.innerHTML = '<div class="loading" role="status"><h1>Avataan omaa taloutta…</h1><p>Haetaan valitun demoasiakkaan tietoja.</p></div>';
  try {
    const response = await fetch('/api/session', { method: customerId ? 'POST' : 'GET', signal,
      ...(customerId ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: customerId }) } : {}) });
    if (!response.ok) throw new Error('Demoasiakasta ei voitu avata. Yritä uudelleen.');
    const selected = await response.json();
    if (epoch !== customerEpoch) return;
    if (typeof selected.customer_id !== 'string' || !selected.customer_id || typeof selected.selection_id !== 'string' ||
        !selected.selection_id || !Array.isArray(selected.customers) ||
        !selected.customers.some(customer => customer.id === selected.customer_id)) throw new Error('Demoasiakkaan tiedot eivät kelpaa.');
    customerSession = selected;
    const headers = selectionHeaders(selected);
    // Financial charts and the model's insight generation load independently.
    insightController = new AbortController();
    insightsPromise = pollInsights(selected, AbortSignal.any([signal, insightController.signal]));
    // The chart may still be loading when generation fails; its card view will show the error.
    void insightsPromise.catch(() => {});
    const recap = wrapped.load({ headers, signal, customerId: selected.customer_id, selectionId: selected.selection_id }).then(result => {
      if (epoch !== customerEpoch || !result) return;
      if (result.selection_id && result.selection_id !== selected.selection_id) throw new StaleSelectionError();
      if (Object.keys(result.recaps || {}).some(id => id !== selected.customer_id)) throw new Error('Virheellinen rahavuosi.');
      if (profile) { document.querySelector('#recap-teaser').innerHTML = recapTeaser(); openFromLink(); }
    }).catch(error => { if (epoch === customerEpoch && ([401, 409].includes(error.status) || error instanceof StaleSelectionError)) void loadCustomer(); });
    const finance = await fetch('/demo-data.json', { headers, signal });
    if ([401, 409].includes(finance.status)) throw new StaleSelectionError();
    if (!finance.ok) throw new Error('Aineisto ei latautunut.');
    const loaded = await finance.json();
    if (epoch !== customerEpoch) return;
    if (loaded.selection_id !== selected.selection_id || loaded.profiles?.length !== 1 ||
        loaded.profiles[0].customer_id !== selected.customer_id) throw new StaleSelectionError();
    data = loaded; profile = loaded.profiles[0];
    const latestMonth = data.summary.to.slice(0, 7);
    for (const scope of Object.keys(selectedMonths)) selectedMonths[scope] = latestMonth;
    months.length = 0;
    for (let month = latestMonth; month >= data.summary.from.slice(0, 7); month = moveMonth(month, -1)) months.push(month);
    void Promise.resolve(explorationSummaries.warm?.(selected, latestMonth)).catch(error => {
      if (epoch === customerEpoch && error.staleSelection) void loadCustomer();
    });
    render(); openFromLink();
    void recap;
  } catch (error) {
    if (epoch !== customerEpoch || signal.aborted) return;
    if (error instanceof StaleSelectionError) { void loadCustomer(); return; }
    customerController.abort(); insightController?.abort(); insightsPromise = null;
    customerSession = null;
    root.innerHTML = `<div class="load-error"><h1>Demo ei latautunut</h1><p>${esc(error.message)}</p><button data-action="reload">Yritä uudelleen</button></div>`;
  }
}

async function synchronizeSession() {
  if (!profile || !customerSession || synchronizingSession || document.hidden) return;
  synchronizingSession = true;
  const epoch = customerEpoch;
  try {
    const response = await fetch('/api/session', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return;
    const selected = await response.json();
    if (epoch === customerEpoch && selected.selection_id !== customerSession?.selection_id) void loadCustomer();
  } catch { /* The next data/chat request also checks the selection. */ }
  finally { synchronizingSession = false; }
}
function render(){
  analytics?.destroy(); analytics = null; m=metrics(profile,topicMonth(activeTopic));
  root.innerHTML=`<div class="app-shell"><header class="topbar"><span class="demo-pill">DEMO</span><h1>Oma talous</h1><button class="icon-button" data-action="about" aria-label="Tietoa demoaineistosta">${icon('info')}</button></header>
    <main id="main-content" class="mint-content"><label class="customer-picker" for="customer-selector"><span>${icon('person')}Valittu demoasiakas</span><select id="customer-selector">${customerSession.customers.map(customer=>`<option value="${esc(customer.id)}" ${customer.id===customerSession.customer_id?'selected':''}>${esc(customer.label)}</option>`).join('')}</select></label>
    <section class="trainer-intro" aria-label="Kysy talousvalmentajalta"><form id="explore-form" class="explore-composer"><label class="sr-only" for="explore-question">Kysy omasta taloudestasi</label><input id="explore-question" type="text" placeholder="Kysy omasta taloudestasi…" maxlength="2000" required><button type="submit" aria-label="Lähetä kysymys valmentajalle">${icon('arrow')}</button></form><span class="trainer-note">AI-valmentaja · vastaukset perustuvat demoasiakkaan tietoihin</span></section>
    <section class="explore-topics" aria-label="Tutki talouttasi kysymys kerrallaan">${explorationTopics.map(topic=>`<section class="explore-topic"><h3><button type="button" id="topic-${topic.id}" class="topic-toggle" data-topic="${topic.id}" aria-expanded="false" aria-controls="panel-${topic.id}"><span class="topic-icon">${icon(topic.icon)}</span><span><strong>${topic.title}</strong><small>${topic.hint}</small></span>${icon('plus','topic-indicator')}</button></h3><div id="panel-${topic.id}" class="topic-panel" role="region" aria-labelledby="topic-${topic.id}" hidden></div></section>`).join('')}</section>
    <div class="section-title insights-title"><h2>Tärkeimmät havainnot</h2><span class="ai-label">AI:n tuottama</span></div><section id="key-insights" class="key-insights" aria-label="Asiakkaan tärkeimmät AI-havainnot" aria-live="polite"><p class="insights-loading" role="status">Havaintoja ladataan…</p></section>
    <div id="recap-teaser">${recapTeaser()}</div>
    <div class="explore-shortcuts"><button class="utility-row" data-action="chat" aria-label="Avaa talousvalmentaja">${icon('chat')}<span><strong>Jatka keskustelua</strong><small>Kysy lisää valmentajaltasi</small></span>${icon('chevron')}</button><button class="utility-row" data-action="account">${icon('receipt')}<span><strong>Tilin tapahtumat</strong><small id="transactions-period">${capitalize(monthName(selectedMonths.transactions))}</small></span>${icon('chevron')}</button></div>
    <p class="demo-note">Synteettinen demoaineisto · tiedot ${esc(dateLabel(customerSession.as_of))} asti<br>Ei yhteyttä oikeaan pankkitiliin.</p></main>
    <nav class="bottom-nav" aria-label="Päävalikko">${[['Koti','home'],['S-Etukortti','s'],['Pankki','wallet']].map(([label,glyph])=>`<button class="nav-item" data-context="${label}">${glyph==='s'?sMark():icon(glyph)}<span>${label}</span></button>`).join('')}<button class="nav-item active" data-action="top" aria-current="page">${icon('chart')}<span>Oma talous</span></button><button class="nav-item" data-context="Minä">${icon('person')}<span>Minä</span></button></nav></div>`;
  void loadInsights();
  if (activeTopic) openTopic(activeTopic, false);
}
function recapTeaser() {
  return wrapped.has(profile.customer_id) ? wrapped.teaser() : '';
}
function openTopic(topicId, toggle = true) {
  const topic = explorationTopics.find(item=>item.id === topicId);
  if (!topic) return;
  const close = toggle && activeTopic === topicId;
  const previousAnalytics = analytics;
  analytics = null; activeTopicResult = null;
  const previousPanel = activeTopic && document.querySelector(`#panel-${activeTopic}`);
  if (previousPanel && (close || activeTopic !== topicId)) {
    void setDisclosure(previousPanel, false).then(finished => {
      previousAnalytics?.destroy();
      if (finished) previousPanel.innerHTML = '';
    });
  } else previousAnalytics?.destroy();
  document.querySelectorAll('[data-topic]').forEach(button=>button.setAttribute('aria-expanded', 'false'));
  activeTopic = close ? null : topicId;
  if (close) return;
  const month = topicMonth(topicId);
  m = metrics(profile, month);
  const panel = document.querySelector(`#panel-${topicId}`);
  document.querySelector(`#topic-${topicId}`).setAttribute('aria-expanded', 'true');
  if (topicId === 'afford') {
    panel.innerHTML = `<p class="afford-intro">Uusi pyörä, lomamatka vai jotain ihan muuta? Katsotaan, mitä toiveesi vaatisi ja millaiset muutokset voisivat auttaa.</p>
      <form id="afford-form" class="afford-form">
        <label for="afford-purchase">Mitä haluaisit hankkia?<input id="afford-purchase" name="purchase" type="text" placeholder="Esim. sähköpyörä" maxlength="120" required></label>
        <div class="afford-fields"><label for="afford-price">Hinta (€)<input id="afford-price" name="price" type="number" inputmode="decimal" min="0.01" max="1000000" step="0.01" placeholder="Esim. 1 500" required></label>
        <label for="afford-months">Aikaa (kuukautta)<input id="afford-months" name="months" type="number" inputmode="numeric" min="1" max="60" step="1" value="6" required></label></div>
        <button type="submit" class="primary-button full-width">Katso, mitä se vaatisi ${icon('arrow')}</button>
        <p class="afford-error" role="alert" hidden></p>
      </form><p class="topic-caption">Saat valmentajalta arvion kuukausisummasta ja tarvittavista muutoksista. Arvio perustuu ${esc(dateLabel(customerSession.as_of))} tilanteeseen.</p>`;
    void setDisclosure(panel, true, !toggle);
    return;
  }
  const summary = `<div class="topic-summary" aria-live="polite"></div><button class="topic-followup" data-topic-chat="${topicId}">Kysy tästä valmentajalta ${icon('arrow')}</button>`;
  panel.innerHTML = `<div class="topic-body">${topicId === 'week' ? `<p class="topic-caption">Arvio käytettävissä olevasta rahasta · ${esc(dateLabel(customerSession.as_of))}</p>` : monthPicker(topicId)}${topicId === 'spending' ? `<div id="spending-breakdown"></div>${summary}<details class="spending-details"><summary>Vertaile kuukausia ja tutki tapahtumia ${icon('chevron')}</summary><div id="spending-history"></div><button class="utility-row" data-action="baskets">${icon('bag')}<span><strong>Kolme menokoria</strong><small>Tarpeet ja arjen valinnat</small></span>${icon('chevron')}</button></details>` : summary}</div>`;
  if (topicId === 'spending') {
    const shared = { data: projectFinanceData(profile, data.summary, names), selectedMonth: month,
      onSelectCategory: category=>showTransactions(category, topicMonth(topicId)),
      onSelectMonth: month=>changeTopicMonth(topicId, month) };
    const chart = createFinanceAnalytics(panel.querySelector('#spending-breakdown'), {
      ...shared, sections: ['breakdown'], compactBreakdown: true,
    });
    const history = createFinanceAnalytics(panel.querySelector('#spending-history'), {
      ...shared, sections: ['annual', 'history'],
    });
    analytics = { destroy() { chart.destroy(); history.destroy(); } };
  }
  void setDisclosure(panel, true, !toggle);
  void loadTopicSummary(panel.querySelector('.topic-summary'), topicId);
}
function changeTopicMonth(topic, month) {
  if (!['spending', 'saving'].includes(topic) || !months.includes(month)) return;
  selectedMonths[topic] = month;
  if (activeTopic === topic) {
    openTopic(topic, false);
    document.querySelector(`#month-${topic}`)?.focus({preventScroll:true});
  }
}
async function loadTopicSummary(target, topic) {
  const epoch = customerEpoch, selected = customerSession, month = topicMonth(topic);
  const label = topic === 'spending' ? 'AI-nosto menoistasi' : 'AI:n tuottama yhteenveto';
  target.setAttribute('aria-busy', 'true');
  target.innerHTML = `<span class="ai-label">${label}</span><p class="summary-pending" role="status"><span class="insights-pulse" aria-hidden="true"></span>Yhteenvetoa ladataan…</p>`;
  try {
    const result = await explorationSummaries.load({topic, month, selection:selected});
    if (!target.isConnected || epoch !== customerEpoch || activeTopic !== topic) return;
    if (result.selectionId !== selected.selection_id) throw Object.assign(new Error('Demoasiakas vaihtui.'), {staleSelection:true});
    if (!Array.isArray(result.bullets) || result.bullets.length < 2 || result.bullets.length > 3 ||
        result.bullets.some(bullet=>typeof bullet !== 'string' || !bullet.trim())) throw new Error('Yhteenveto puuttuu.');
    activeTopicResult = result;
    target.innerHTML = `<span class="ai-label">${label}</span><ul class="summary-bullets">${result.bullets.map(bullet=>`<li>${formatInline(bullet)}</li>`).join('')}</ul>`;
  } catch (error) {
    if (!target.isConnected || epoch !== customerEpoch || activeTopic !== topic) return;
    if (error.staleSelection) { void loadCustomer(); return; }
    target.innerHTML = `<span class="ai-label">AI-yhteenveto ei ole saatavilla</span><p>Voit silti tutkia lukuja tai kysyä valmentajalta.</p><button class="text-button" data-topic-retry="${topic}">Yritä uudelleen</button>`;
  } finally {
    if (target.isConnected) target.setAttribute('aria-busy', 'false');
  }
}
async function loadInsights(retry = false) {
  const target = document.querySelector('#key-insights');
  if (!target || !customerSession) return;
  const epoch = customerEpoch, selected = customerSession;
  if (retry) { insightController?.abort(); insightsPromise = null; activeInsights = null; }
  if (!insightsPromise) {
    insightController = new AbortController();
    const signal = AbortSignal.any([customerController.signal, insightController.signal]);
    insightsPromise = pollInsights(selected, signal, retry);
  }
  const pending = insightsPromise;
  if (!activeInsights) target.innerHTML = '<div class="insights-loading" role="status"><span class="insights-pulse" aria-hidden="true"></span><div><strong>Valmentaja muodostaa havaintojasi</strong><p>Voit tutkia talouttasi sillä aikaa. Havainnot ilmestyvät tähän, kun ne ovat valmiit.</p></div></div>';
  try {
    const result = await pending;
    if (!target.isConnected || epoch !== customerEpoch || pending !== insightsPromise) return;
    activeInsights = result;
    const date = new Date(result.as_of + 'T12:00:00Z').toLocaleDateString('fi-FI', { timeZone: 'UTC' });
    target.innerHTML = `<p class="insights-caption">Seuraavat askeleesi · tiedot ${esc(date)} asti</p>${result.insights.map(card => {
      const period = insightPeriod(card.period, result.as_of);
      return `<button class="insight-card" data-insight="${esc(card.id)}" aria-label="${esc(period.label)}: ${esc(card.title)}. Suunnittele seuraava askel"><span class="insight-period"><span>${esc(period.label)}</span><small>${esc(period.detail)}</small></span><span class="insight-copy"><strong>${esc(card.title)}</strong><span class="insight-evidence">${formatInline(card.explanation)}</span></span><span class="insight-value">${esc(card.headline_number)}</span><span class="insight-action"><b>Kokeile tätä</b>${formatInline(card.action)}</span><span class="insight-cta">Suunnittele valmentajan kanssa ${icon('arrow')}</span></button>`;
    }).join('')}<p class="insights-footnote">Viikkoarvio perustuu yllä olevaan tilanteeseen. Kuukausinosto koskee viimeisintä kuukautta ja vuosinosto viimeistä 12 kuukautta.</p>`;
  } catch (error) {
    if (!target.isConnected || epoch !== customerEpoch || pending !== insightsPromise) return;
    if (error instanceof StaleSelectionError) { void loadCustomer(); return; }
    insightsPromise = null;
    activeInsights = null;
    target.innerHTML = '<div class="insights-error" role="alert"><p>Havaintoja ei voitu ladata.</p><button class="text-button" data-action="retry-insights">Yritä uudelleen</button></div>';
  }
}
async function pollInsights(selected, signal, retry = false) {
  const deadline = Date.now() + 120000;
  while (!signal.aborted && Date.now() < deadline) {
    const response = await fetch('/api/insights' + (retry ? '?retry=1' : ''), { headers: selectionHeaders(selected), signal });
    retry = false;
    if ([401, 409].includes(response.status)) throw new StaleSelectionError();
    if (!response.ok) throw new Error('Havaintoja ei voitu ladata.');
    const result = await response.json();
    if (result.customer_id !== selected.customer_id || result.selection_id !== selected.selection_id) throw new StaleSelectionError();
    if (response.status === 202 || result.status === 'generating') {
      await new Promise((resolve, reject) => {
        const done = () => { signal.removeEventListener('abort', abort); resolve(); };
        const timeout = setTimeout(done, Math.max(500, Math.min(3000, Number(result.retry_after_ms) || 1000)));
        const abort = () => { clearTimeout(timeout); reject(new DOMException('Aborted', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      continue;
    }
    if (!Array.isArray(result.insights) || result.insights.length !== 3) throw new Error('Havaintoja ei voitu ladata.');
    return result;
  }
  throw new Error('Havaintojen muodostaminen viipyy.');
}
function categoryRow(category,value){return `<button class="category-row" data-category="${category}"><span class="row-icon">${icon(categoryIcon(category))}</span><span class="category-copy"><strong>${names[category]}</strong><span class="category-track"><i style="width:${value/Math.max(1,m.spending)*100}%"></i></span></span><b>${euro(value)}</b>${icon('chevron','row-chevron')}</button>`;}
function transactionsHTML(rows){return rows.length?rows.map(t=>`<div class="transaction-row"><span class="row-icon">${icon(categoryIcon(t.category))}</span><span><strong>${names[t.category]||esc(t.category)}</strong><small>${new Date(t.date+'T12:00:00Z').toLocaleDateString('fi-FI',{day:'numeric',month:'numeric',timeZone:'UTC'})}${t.merchant?' · '+esc(t.merchant):''}</small></span><b class="${t.amount>0?'positive':''}">${t.amount>0?'+':''}${euro(t.amount)}</b></div>`).join(''):'<p class="empty-state">Ei tapahtumia valitulla ajanjaksolla.</p>';}
function modal(title,body,kind=''){
  if(!detail.open)lastFocus=document.activeElement;detail.className=kind;
  detail.innerHTML=`<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Sulje">${icon('close')}</button></div><div class="dialog-content">${body}</div>`;
  detail.setAttribute('aria-labelledby','dialog-title');if(!detail.open)detail.showModal();
}
function showTransactions(kind='all', month=selectedMonths.transactions){
  if (!months.includes(month)) return;
  selectedMonths.transactions = month;
  transactionFilter = kind;
  const current = metrics(profile, month);
  const rows=kind==='all'?current.transactions:kind==='income'?current.transactions.filter(t=>transactionKind(t)==='income'):kind==='spending'?current.spend:current.transactions.filter(t=>t.category===kind);
  const title=({all:'Tilin tapahtumat',income:'Tulot',spending:'Arjen menot'})[kind]||names[kind];
  modal(title,`${monthPicker('transactions')}${kind==='all'?`<div class="account-summary"><span>${esc(customerLabel())}</span><strong>${euro(current.balance)}</strong><small>Tilin saldo · ${current.asOf ? esc(dateLabel(current.asOf)) : 'Ei saldotietoa'}</small></div>`:''}<p class="period-caption">${capitalize(monthName(month))} · ${rows.length} tapahtumaa</p>${transactionsHTML([...rows].reverse())}<p class="fine-print">Kauppiaista näkyy tunniste, koska nimiä ei ole aineistossa.</p>`);
  const shortcut = document.querySelector('#transactions-period');
  if (shortcut) shortcut.textContent = capitalize(monthName(month));
}
function showBaskets(selected){const totals=basketTotals(m.categories);modal(selected===undefined?'Kolme menokoria':basketInfo[selected][0],`<p>Menokorit auttavat hahmottamaan, mihin rahat menevät.</p>${basketInfo.map(([title,copy,glyph],i)=>selected!==undefined&&selected!==i?'':`<section class="basket-summary">${icon(glyph)}<div><h3>${title}</h3><p>${copy}.</p><strong>${euro(totals[i])}</strong></div></section>`).join('')}<p class="fine-print">Luokittelu on esimerkki. Aineistosta ei voi päätellä, mitkä yksittäiset ostokset olivat sinulle välttämättömiä. Matkailu sisältyy arjen valintoihin.</p>`);}
const showChat = createChatDialog({ modal, detail, icon,
  getSelection: () => customerSession ? { ...customerSession, label: customerLabel() } : null,
  onSelectionStale: () => { void loadCustomer(); },
});
// The year-in-review story; its "ask the coach" buttons open the chat with the question filled in.
const wrapped = createWrapped({ onAsk: question => showChat(question, { autoSend: true })});
// Deep link, e.g. from a push notification: #rahavuosi opens the story, #rahavuosi/3 opens card 3.
function openFromLink(){const match=location.hash.match(/^#rahavuosi(?:\/(\d+))?$/);if(match)wrapped.open(profile.customer_id,null,Math.max(0,(+match[1]||1)-1));}
function action(name){
  const selectedMonth = topicMonth(activeTopic);
  if(name==='retry-insights'){void loadInsights(true);return;}
  if(name==='reload'){location.reload();return;}
  if(name==='close'){detail.close();return;}
  if(name==='top'){window.scrollTo({top:0,behavior:'smooth'});return;}
  if(name==='chat'){showChat();return;}
  if(name==='wrapped'){wrapped.open(profile.customer_id);return;}
  if(name==='account'){showTransactions();return;}
  if(name==='income'||name==='spending'){showTransactions(name,selectedMonth);return;}
  if(name==='categories'){modal('Mihin rahani menivät?',`<p>${capitalize(monthName(selectedMonth))}</p><div class="dialog-categories">${Object.entries(m.categories).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([c,v])=>categoryRow(c,v)).join('')}</div>`);return;}
  if(name==='baskets'){showBaskets();return;}
  if(name==='savings'){modal('Kokeile pientä muutosta',`<p>Ravintoloihin kului valitussa kuussa yhteensä <strong>${euro(m.categories.Restaurants)}</strong>.</p><label class="savings-label" for="saving-cut">Entä jos käyttäisit vähemmän? <b id="saving-percent">20 %</b></label><input id="saving-cut" type="range" min="0" max="50" step="5" value="20"><div class="savings-result"><span>Olisi jäänyt säästöön</span><strong id="saving-result">${euro(scenarioSavings(m.categories,{Restaurants:20}))}</strong></div><p class="fine-print">Esimerkki kuukauden ${capitalize(monthName(selectedMonth))} menoista.</p>`);return;}
  if(name==='cashflow'){modal('Kuukauden yhteenveto',`<p>${capitalize(monthName(selectedMonth))}</p><div class="financial-summary">${[['Tulot',m.income],['Arjen menot',-m.spending],['Tuloista jäljellä',m.margin],['Siirrot sijoituksiin',-m.deposits],['Palkkasiirrot',-m.sweeps],['Nostot sijoituksista',m.withdrawals],...(m.otherFlow?[['Muut tilitapahtumat',m.otherFlow]]:[]),['Kaikkien tapahtumien nettomuutos',m.netFlow]].map(([label,value])=>`<span>${label}<strong>${euro(value)}</strong></span>`).join('')}</div><p class="fine-print">Tuloista jäljellä = palkka ja muut tulot − arjen menot. Summa ei ole tilin saldo eikä arvio turvallisesta käyttörahasta. Sijoitus- ja palkkasiirrot esitetään erikseen.</p>`);return;}
  if(name==='about'){modal('Tietoa demoaineistosta',`<p>Tämä on uusi <strong>Oma talous</strong> -välilehti S-mobiilin kuvakaappausten mukaisessa tyylissä. Muut alapalkin välilehdet havainnollistavat paikan nykyisessä sovelluksessa.</p><h3>Projektin aineisto</h3><p>3 626 755 synteettistä tapahtumaa ja 5 100 asiakasta. Aikaväli 1.10.2024–30.9.2026. Voit vaihtaa synteettistä esimerkkiasiakasta etusivulta. Näytämme kerrallaan vain valitun asiakkaan tiedot.</p><h3>Mitä näet?</h3><p>Tuloja, menoja, kategorioita, tapahtumia ja historiallisia saldoja. Menokorit ovat esimerkkiluokittelu. Säästölaskuri käyttää valitun kuukauden menoja.</p><h3>Talousvalmentaja</h3><p>Keskustelu käyttää Claude-tekoälyä. Claude muodostaa etusivun havainnot valitun asiakkaan tiedoista. Havainnon avaaminen aloittaa keskustelun siitä. Myös Kysy-keskustelu käyttää valitun demoasiakkaan taloustietoja. Claudelle lähetetään viestit sekä vain kysymykseen tarvittavat tämän asiakkaan tiedot. Muiden asiakkaiden yksilöllisiä tietoja ei lähetetä. Vertailut perustuvat ryhmätason lukuihin.</p><p class="fine-print">Hackathon-demo. Ei S-Pankin virallinen palvelu eikä yhteyttä oikeaan pankkitiliin.</p>`);}
}
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.action)action(button.dataset.action);if(button.dataset.insight&&activeInsights){const card=activeInsights.insights.find(item=>item.id===button.dataset.insight);if(card)showChat.openInsight({customerId:profile.customer_id,card,asOf:activeInsights.as_of});}if(button.dataset.category)showTransactions(button.dataset.category,topicMonth(activeTopic));if(button.dataset.basket!==undefined)showBaskets(+button.dataset.basket);if(button.dataset.context)modal(button.dataset.context,`<p>Tämä on nykyisen S-mobiilin välilehden paikka. Tässä esittelyssä voit tutustua uuteen <strong>Oma talous</strong> -välilehteen.</p><button class="primary-button full-width" data-action="close">Takaisin omaan talouteen</button>`);});
document.addEventListener('click', event=>{
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.topic) openTopic(button.dataset.topic);
  if (button.dataset.topicRetry) void loadTopicSummary(button.closest('.topic-summary'), button.dataset.topicRetry);
  if (button.dataset.topicChat) {
    if (activeTopicResult) showChat.openExploration(activeTopicResult);
    else {
      const topic = explorationTopics.find(item=>item.id === button.dataset.topicChat);
      const period = topic.id === 'week' ? `Tiedot ${customerSession.as_of} asti.` : `Tarkasteltava kuukausi: ${topicMonth(topic.id)}.`;
      showChat(`${topic.title} ${period}`, {autoSend:true});
    }
  }
});
document.addEventListener('submit', event=>{
  if (event.target.id === 'afford-form') {
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    try {
      const question = affordQuestion(Object.fromEntries(new FormData(form)));
      form.querySelector('.afford-error').hidden = true;
      showChat(question, {autoSend:true});
    } catch (error) {
      const alert = form.querySelector('.afford-error');
      alert.textContent = error.message; alert.hidden = false;
    }
    return;
  }
  if (event.target.id !== 'explore-form') return;
  event.preventDefault();
  const input = document.querySelector('#explore-question');
  const question = input.value.trim();
  if (!question) { input.focus(); return; }
  showChat(question, {autoSend:true});
});
document.addEventListener('change',event=>{
  if(event.target.id==='customer-selector'){void loadCustomer(event.target.value);return;}
  const scope = event.target.dataset.monthScope;
  if (scope === 'transactions') {
    showTransactions(transactionFilter, event.target.value);
    document.querySelector('#month-transactions')?.focus({preventScroll:true});
  } else if (scope) changeTopicMonth(scope, event.target.value);
});
document.addEventListener('input',event=>{if(event.target.id==='saving-cut'){document.querySelector('#saving-percent').textContent=`${event.target.value} %`;document.querySelector('#saving-result').textContent=euro(scenarioSavings(m.categories,{Restaurants:+event.target.value}));}});
detail.addEventListener('click',event=>{if(event.target===detail){const r=detail.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)detail.close();}});
detail.addEventListener('close',()=>{if(lastFocus?.isConnected)lastFocus.focus();else document.querySelector('.nav-item.active')?.focus();});
window.addEventListener('focus', () => { void synchronizeSession(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void synchronizeSession(); });
void loadCustomer();
