import { money, monthLabel, metrics, basketTotals, defaultBaskets, scenarioSavings, mortgagePayment, weeklyBudget } from './model.js';

const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 3v4m-2-2h4"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/><path d="M7 10h10M7 14h6"/>',
  basket: '<path d="m3 9 2 11h14l2-11ZM8 9l4-6 4 6M9 13v3m6-3v3"/>',
  goal: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 8-8m-1-2 3 0v3"/>',
  chart: '<path d="M4 3v17h17M8 16v-4m5 4V7m5 9v-6"/>',
  wallet: '<path d="M19 7V4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h16V7H5a1 1 0 0 1 0-2"/><path d="M21 12h-6v5h6m-3-2.5h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  coffee: '<path d="M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4ZM16 9h2a3 3 0 0 1 0 6h-2M7 3v2m5-2v2"/>',
  leaf: '<path d="M20 3C10 2 3 6 4 14c1 8 17 7 16-11ZM3 21 15 9"/>',
  bag: '<path d="M5 7h14l2 14H3ZM9 8V6a3 3 0 0 1 6 0v2"/>',
  train: '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 10h14M9 21l2-3m4 3-2-3M8 14h1m6 0h1"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-8z"/>',
  health: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  external: '<path d="M14 3h7v7m0-7L10 14m0-11H3v18h18v-7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 11h18"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.wallet}</svg>`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const concepts = [
  { id: 'everyday', number: '01', name: 'Everyday clarity', icon: 'home', eyebrow: 'THE EVERYDAY COMPANION', title: 'A familiar place.\nA fresh perspective.', description: 'A calm, bank-like home for your money. See the month clearly and turn a small insight into a useful next step.', focus: ['Monthly cash flow', 'Spending insights', 'Weekly budget sandbox'], color: '#007c3b' },
  { id: 'coach', number: '02', name: 'Money conversations', icon: 'chat', eyebrow: 'THE CONVERSATIONAL COACH', title: 'Good questions.\nClearer answers.', description: 'Start with a question, not a chart. A conversational experience that explains the numbers and lets you inspect the transactions behind them.', focus: ['Ask about your spending', 'Evidence behind answers', 'Contextual next steps'], color: '#36735b' },
  { id: 'baskets', number: '03', name: 'Three little baskets', icon: 'basket', eyebrow: 'THE FINANCIAL LITERACY LENS', title: 'Understand the why\nbehind the spend.', description: 'An approachable way to explore the challenge’s three spending baskets. Move categories yourself: your life defines what is essential.', focus: ['Three spending baskets', 'Editable categorisation', 'Transaction explorer'], color: '#a87638' },
  { id: 'possibilities', number: '04', name: 'Small steps, big plans', icon: 'goal', eyebrow: 'THE WHAT-IF PLAYGROUND', title: 'A little less here.\nA little more possible.', description: 'Make trade-offs tangible. Turn small changes in everyday spending into an adjustable, personal savings plan.', focus: ['Live spending sliders', 'Goal progress projection', 'Save a local demo plan'], color: '#193f34' },
  { id: 'home', number: '05', name: 'The way home', icon: 'home', eyebrow: 'THE LIFE-MOMENT GUIDE', title: 'Big life decisions.\nOne step at a time.', description: 'A reassuring home-buying journey that connects the mortgage event history with a simple, transparent payment simulator.', focus: ['Mortgage case timeline', 'Deposit and rate simulator', 'Plain-language explanations'], color: '#547c88' },
];
const params = new URLSearchParams(location.search);
let concept = concepts.find(c => c.id === params.get('concept')) || concepts[0];
const embedded = params.has('embed');
let data, profile, month = '2026-09', m;
let basketMapping = { ...defaultBaskets }, basketFilter = 'all';
let cuts = { Restaurants: 20, Lifestyle: 10, Entertainment: 10 };
let goalAmount = 2000, baseSaving = 100;
let homePrice, homeEquity, homeRate = 4, homeYears = 25;
let chatMessages = [], lastEvidenceCategory = 'all';
const root = document.querySelector('#root');
const details = document.querySelector('#detail');
const nameFor = { CUST00207: 'Everyday planner', CUST00127: 'A busier month', CUST00103: 'Money on the move', CUST04457: 'Home-buyer sample' };
const categoryIcon = c => ({ Housing: 'home', Utilities: 'bolt', Groceries: 'basket', Transportation: 'train', Restaurants: 'coffee', Health: 'health', 'Home & Tech': 'home', Lifestyle: 'bag', Entertainment: 'spark', Travel: 'train' }[c] || 'wallet');
const brand = () => `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 36 36"><path d="M26 9H14c-8 0-8 9 0 9h8c8 0 8 9 0 9H10"/></svg></span><span class="brand-copy">Oma talous<span>YOUR ECONOMIC TRAINER</span></span>`;

async function init() {
  try {
    const res = await fetch('demo-data.json'); if (!res.ok) throw new Error('Data could not be loaded'); data = await res.json();
    profile = data.profiles.find(p => p.customer_id === params.get('profile')) || data.profiles[0];
    homePrice = +data.mortgage.final_property_price_eur; homeEquity = +data.mortgage.final_equity_amount_eur;
    if (embedded) { document.body.classList.add('embedded'); renderApp(); }
    else renderStudio();
  } catch (e) { root.innerHTML = `<div class="loading"><h1>The demo couldn’t load.</h1><p>${esc(e.message)}</p><p>Run <code>node server.mjs</code> from the ui-demos folder, then open localhost:4173.</p></div>`; }
}
function renderStudio() {
  document.title = 'Oma talous — Five ways to make money feel simpler';
  root.innerHTML = `<div class="studio">
    <header class="studio-header"><a class="brand" href="/">${brand()}</a><div class="studio-label">JUNCTION 2026 <span>/</span> CONCEPT STUDIO</div><span class="local-status"><i></i> Running locally</span></header>
    <aside class="studio-sidebar"><p class="eyebrow">FIVE WAYS FORWARD</p><h1>Money made<br>more human<span>.</span></h1><p class="studio-intro">One dataset. Five different ways to feel more in control.</p>
    <nav class="concept-nav" aria-label="Design concepts">${concepts.map(c => `<button class="concept-link ${c.id === concept.id ? 'selected' : ''}" data-concept="${c.id}"><span class="concept-number">${c.number}</span><span>${c.name}<small>${c.focus[0]}</small></span>${icon('chevron')}</button>`).join('')}</nav>
    <div class="studio-data"><span class="data-symbol">${icon('shield')}</span><strong>Real patterns. Synthetic data.</strong><p>3.63M transactions · 5,100 customers<br>Oct 2024 – Sep 2026</p><button class="text-button" data-action="sources">Explore the data ${icon('arrow')}</button></div>
    <div class="studio-foot">S-mobiili-inspired design study.<br>Independent hackathon prototype.</div></aside>
    <main class="studio-main"><div class="concept-heading"><div><p class="eyebrow" id="concept-eyebrow">${concept.eyebrow}</p><h2 id="concept-title">${concept.title.replace('\n', ' ')}</h2></div><span class="concept-counter" id="concept-counter">${concept.number} <span>/ 05</span></span></div>
    <div class="preview-toolbar"><div class="preview-caption"><i></i> Interactive prototype <span>•</span> <span id="preview-name">${concept.name}</span></div><div class="preview-actions"><div class="segmented"><button data-device="desktop" class="active" aria-label="Desktop preview" title="Desktop preview">${icon('desktop')}</button><button data-device="mobile" aria-label="Mobile preview" title="Mobile preview">${icon('phone')}</button></div><a id="standalone" class="icon-button" href="?concept=${concept.id}&embed=1" target="_blank" aria-label="Open standalone demo" title="Open standalone demo">${icon('external')}</a></div></div>
    <div class="preview-stage"><iframe id="preview" title="${concept.name} interactive demo" src="?concept=${concept.id}&embed=1"></iframe></div>
    <div class="concept-summary"><p id="concept-description">${concept.description}</p><div id="concept-features">${concept.focus.map(f => `<span>${icon('check')}${f}</span>`).join('')}</div></div>
    <footer class="studio-bottom"><span>Built for a mobile WebView. Designed around everyday life.</span><span>UI DEMOS / EN</span></footer></main></div>`;
}
function switchConcept(id) {
  concept = concepts.find(c => c.id === id) || concepts[0];
  if (embedded) { chatMessages = []; renderApp(); return; }
  document.querySelectorAll('[data-concept]').forEach(el => el.classList.toggle('selected', el.dataset.concept === id));
  document.querySelector('#concept-eyebrow').textContent = concept.eyebrow;
  document.querySelector('#concept-title').textContent = concept.title.replace('\n', ' ');
  document.querySelector('#concept-counter').innerHTML = `${concept.number} <span>/ 05</span>`;
  document.querySelector('#preview-name').textContent = concept.name;
  document.querySelector('#concept-description').textContent = concept.description;
  document.querySelector('#concept-features').innerHTML = concept.focus.map(f => `<span>${icon('check')}${f}</span>`).join('');
  document.querySelector('#preview').src = `?concept=${id}&embed=1`;
  document.querySelector('#preview').title = `${concept.name} interactive demo`;
  document.querySelector('#standalone').href = `?concept=${id}&embed=1`;
  history.replaceState({}, '', `?concept=${id}`);
}
function renderApp() {
  m = metrics(profile, month);
  document.title = `${concept.name} — Oma talous`;
  root.innerHTML = `<div class="app app-${concept.id}"><header class="app-header"><a class="brand" href="/" target="_top">${brand()}</a><nav class="app-nav" aria-label="App navigation"><button data-concept="everyday" class="${concept.id === 'everyday' ? 'active' : ''}">My money</button><button data-concept="coach" class="${concept.id === 'coach' ? 'active' : ''}">My coach ${icon('spark')}</button><button data-concept="possibilities" class="${concept.id === 'possibilities' ? 'active' : ''}">My plans</button></nav><button class="avatar" data-action="sources" title="About this sample" aria-label="About this sample">${icon('leaf')}</button></header>
    <div class="app-context"><span><i></i> SYNTHETIC DATA DEMO</span><div><label class="sr-only" for="profile">Sample customer</label><select id="profile">${data.profiles.slice(0, 3).map(p => `<option value="${p.customer_id}" ${profile.customer_id === p.customer_id ? 'selected' : ''}>${nameFor[p.customer_id]}</option>`).join('')}</select><label class="sr-only" for="month">Month</label><select id="month">${['2026-09','2026-08','2026-07','2026-06','2026-05','2026-04'].map(d => `<option value="${d}" ${d === month ? 'selected' : ''}>${monthLabel(d)}</option>`).join('')}</select></div></div>
    <main class="app-main">${({everyday: everydayView,coach: coachView,baskets: basketsView,possibilities: possibilitiesView,home: homeView}[concept.id])()}</main>
    <footer class="app-footer"><span>${icon('shield')} Your data. Your understanding. Your next step.</span><button data-action="sources">About this demo</button></footer>
    <nav class="mobile-nav" aria-label="Mobile navigation">${concepts.map(c => `<button data-concept="${c.id}" class="${c.id === concept.id ? 'active' : ''}">${icon(c.icon)}<span>${({everyday:'Home',coach:'Coach',baskets:'Baskets',possibilities:'Goals',home:'My home'})[c.id]}</span></button>`).join('')}</nav></div>`;
  if (concept.id === 'home') document.querySelector('.app-context>div').innerHTML = '<span class="case-context">Sample case C0004 · May–July 2026</span>';
  if (concept.id === 'coach') renderMessages();
  if (concept.id === 'possibilities') {
    updateScenario();
    document.querySelector('.goal-projection').insertAdjacentHTML('beforeend','<button class="text-button load-plan" data-action="load-plan">Load saved plan</button>');
  }
  if (concept.id === 'home') updateHome();
}
const heading = (kicker, title, subtitle, extra = '') => `<div class="page-heading"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p>${subtitle}</p></div>${extra}</div>`;
function chart() {
  const periods = ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'].filter(p => p <= month);
  const series = periods.map(p => ({ label: monthLabel(p, true), ...metrics(profile, p) }));
  const max = Math.max(...series.flatMap(s => [s.income, s.spending]), 1);
  return `<div class="chart-legend"><span><i></i> Income</span><span><i></i> Spending</span></div><div class="bar-chart" role="img" aria-label="Monthly income and spending comparison">${series.map(s => `<div class="bar-group" title="${s.label}: income ${money(s.income)}, spending ${money(s.spending)}"><div class="bars"><div class="bar income-bar" style="height:${s.income / max * 100}%"></div><div class="bar spend-bar" style="height:${s.spending / max * 100}%"></div></div><span>${s.label}</span></div>`).join('')}</div><div class="chart-baseline">Monthly totals in euros <button class="text-button" data-action="chart-data">View figures ${icon('arrow')}</button></div>`;
}
function everydayView() {
  const top = Object.entries(m.categories).sort((a,b) => b[1]-a[1]).slice(0,4);
  const restaurantSaving = m.categories.Restaurants * .2;
  return `${heading('A LITTLE CLARITY, EVERY DAY', 'Your money. A clearer picture.', 'A moment to check in, understand, and look ahead.', `<button class="quiet-button" data-action="transactions">${icon('calendar')} ${monthLabel(month)}</button>`)}
    <div class="overview-grid"><section class="balance-hero"><div class="hero-top"><span>${icon('wallet')} YOUR MONTH IN FOCUS</span><span class="light-chip">${monthLabel(month, true)} ’26</span></div><div class="balance-copy"><p>Income after everyday spending</p><h2>${money(m.margin, 2)}</h2><span>${m.margin >= 0 ? 'A little room to plan your next step.' : 'A useful moment to take a closer look.'}</span></div><div class="hero-stats"><div><span>Money in</span><strong>${money(m.income)}</strong></div><div><span>Everyday spending</span><strong>${money(m.spending)}</strong></div></div><button class="hero-link" data-action="cashflow">See how it adds up ${icon('arrow')}</button><div class="hero-orbit orbit-one"></div><div class="hero-orbit orbit-two"></div></section>
    <section class="insight-card"><div class="insight-label">${icon('spark')} A SMALL POSSIBILITY</div><h2>Less on dining.<br>More for your plans.</h2><p>What would 20% less on restaurants look like for you?</p><div class="insight-amount">${money(restaurantSaving, 2)}<span> extra each month*</span></div><button class="primary-button" data-concept="possibilities">Try a what-if ${icon('arrow')}</button><small>*Based on ${monthLabel(month)} spending.</small><div class="mini-leaves" aria-hidden="true">${icon('leaf')}${icon('leaf')}</div></section>
    <section class="panel cashflow-panel"><div class="section-heading"><div><h2>The bigger picture</h2><p>A little perspective on your cash flow.</p></div>${icon('chart')}</div>${chart()}</section>
    <section class="panel spending-panel"><div class="section-heading"><h2>Where it went</h2><button class="text-button" data-concept="baskets">Explore ${icon('arrow')}</button></div><div class="category-list">${top.map(([c,v],i) => `<button class="category-row" data-category="${c}"><span class="category-badge tone-${i}">${icon(categoryIcon(c))}</span><span class="category-detail"><strong>${c}</strong><span class="mini-track"><i style="width:${v / Math.max(m.spending,1) * 100}%"></i></span></span><strong>${money(v)}</strong></button>`).join('')}</div></section></div>
    <section class="coach-strip"><span class="coach-star">${icon('spark')}</span><div><h3>A question is a good place to start.</h3><p>“Where did my money go this month?”</p></div><button class="text-button" data-concept="coach">Ask your coach ${icon('arrow')}</button></section>
    <div class="small-actions"><button data-action="weekly">${icon('wallet')} Try a weekly budget</button><span>Spending excludes investment transfers and salary sweeps.</span></div>`;
}
function coachView() {
  return `<div class="coach-layout"><aside class="coach-sidebar"><p class="eyebrow">YOUR MONEY, IN YOUR WORDS</p><h1>Let’s talk<br> about money<span>.</span></h1><p>Every question deserves a simple answer. Start wherever you are.</p><div class="coach-context-card"><span>${monthLabel(month)}</span><strong>${money(m.spending)}</strong><p>in everyday spending</p><div class="divider"></div><span>${m.spend.length} transactions to explore</span><button class="text-button" data-action="transactions">See the source ${icon('arrow')}</button></div><div class="coach-trust">${icon('shield')}<p>Answers use this sample’s transactions. You can always see the numbers behind them.</p></div><button class="text-button" data-action="reset-chat">Start a new conversation ${icon('plus')}</button></aside>
    <section class="conversation"><div class="conversation-header"><div class="coach-avatar">${icon('spark')}</div><div><strong>Your economic trainer</strong><span><i></i> Here to make things clearer</span></div><span class="demo-chip">DEMO</span></div><div class="messages" id="messages" aria-live="polite"></div><div class="suggestions"><button data-prompt="Where did my money go this month?">Where did my money go? ${icon('arrow')}</button><button data-prompt="What if I spent 20% less on restaurants?">20% less on dining? ${icon('arrow')}</button><button data-prompt="How much did I spend on taxis?">How much on taxis? ${icon('arrow')}</button><button data-prompt="Compare my spending with last month">Compare with last month ${icon('arrow')}</button></div><form id="chat-form"><label class="sr-only" for="chat-input">Ask about your money</label><input id="chat-input" placeholder="Ask about your money…" maxlength="500" autocomplete="off" required><button class="send-button" type="submit" aria-label="Send question">${icon('arrow')}</button></form><p class="chat-note">Demo coach · prewritten explanations with calculated sample figures</p></section></div>`;
}
function renderMessages() {
  const container = document.querySelector('#messages');
  if (!container) return;
  container.innerHTML = `<div class="message coach-message"><span class="message-label">YOUR COACH</span><p>Hi there. Let’s make your money a little easier to understand.</p><p>I’ve brought together your <strong>${monthLabel(month)}</strong> transactions. What would you like to explore?</p><div class="chat-summary"><span>Money in<strong>${money(m.income)}</strong></span><span>Everyday spending<strong>${money(m.spending)}</strong></span></div></div>${chatMessages.map(x => `<div class="message ${x.role === 'user' ? 'user-message' : 'coach-message'}">${x.role === 'coach' ? '<span class="message-label">YOUR COACH</span>' : ''}${x.html}</div>`).join('')}`;
  container.scrollTop = container.scrollHeight;
}
function answerChat(question) {
  const q = question.toLowerCase(); let answer, category = 'all';
  if (/\bless\b|\bsave\b|\bsaving|\bwhat if\b|\d+\s*%/.test(q)) {
    const percent = Math.min(100, +(q.match(/(\d+)\s*%/)?.[1] || 20));
    category = /grocer/.test(q) ? 'Groceries' : /entertain/.test(q) ? 'Entertainment' : /lifestyle|shop/.test(q) ? 'Lifestyle' : 'Restaurants';
    answer = `<p>You spent <strong>${money(m.categories[category], 2)}</strong> on ${category.toLowerCase()} in ${monthLabel(month)}.</p><div class="answer-number">${money(m.categories[category] * percent / 100, 2)}<span>potential monthly saving at ${percent}% less</span></div><p>Over 12 similar months, that’s ${money(m.categories[category] * percent / 100 * 12, 2)}. It’s a scenario based on this month, so your actual savings may vary.</p><button class="text-button" data-concept="possibilities">Make it your own ${icon('arrow')}</button>`;
  } else if (/taxi/.test(q)) {
    const taxis = m.spend.filter(t => t.mcc === '4121');
    answer = `<p>The sample contains <strong>${taxis.length} taxi transactions</strong> in ${monthLabel(month)}, totalling <strong>${money(-taxis.reduce((a,t) => a+t.amount,0),2)}</strong>.</p><p>I used merchant category code 4121 (taxicabs), rather than treating all transportation as taxis.</p>`;
    category = 'taxi';
  } else if (/compar|last month|change/.test(q)) {
    const d = new Date(month + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); const previous = metrics(profile, d.toISOString().slice(0,7));
    const difference = m.spending - previous.spending;
    answer = `<p>Your everyday spending was <strong>${money(m.spending,2)}</strong> in ${monthLabel(month)}, compared with <strong>${money(previous.spending,2)}</strong> in ${monthLabel(d.toISOString().slice(0,7))}.</p><div class="answer-number">${money(Math.abs(difference),2)}<span>${difference >= 0 ? 'more' : 'less'} than the previous month</span></div><p>This comparison leaves out investment transfers and salary sweeps.</p>`;
  } else if (/safe|week|budget|afford/.test(q)) {
    answer = `<p>Your last recorded account balance for this period is <strong>${money(m.balance,2)}</strong>.</p><p>A balance alone doesn’t tell us what is safe to spend. Add your upcoming bills, buffer, and planning horizon to try an illustrative weekly budget.</p><button class="text-button" data-action="weekly">Set my assumptions ${icon('arrow')}</button>`;
  } else if (/balance|account/.test(q)) {
    answer = `<p>The latest recorded balance across this sample’s accounts is <strong>${money(m.balance,2)}</strong>, as of ${m.asOf}.</p><p>This is a historical dataset balance, not a live bank balance.</p>`;
  } else if (/grocer|restaurant|dining|transport|entertain|housing|utilit|lifestyle|health|travel/.test(q)) {
    category = /grocer/.test(q) ? 'Groceries' : /restaurant|dining/.test(q) ? 'Restaurants' : /transport/.test(q) ? 'Transportation' : /entertain/.test(q) ? 'Entertainment' : /housing/.test(q) ? 'Housing' : /utilit/.test(q) ? 'Utilities' : /health/.test(q) ? 'Health' : /travel/.test(q) ? 'Travel' : 'Lifestyle';
    answer = `<p>In ${monthLabel(month)}, your ${category.toLowerCase()} spending was <strong>${money(m.categories[category],2)}</strong> across ${m.spend.filter(t => t.category === category).length} transactions.</p><p>That’s ${m.spending ? (m.categories[category] / m.spending * 100).toFixed(1) : '0'}% of your everyday spending. You can explore each transaction below.</p>`;
  } else if (/where|spen|month|basket|money go/.test(q)) {
    const top = Object.entries(m.categories).sort((a,b) => b[1]-a[1]).slice(0,3);
    answer = `<p>You spent <strong>${money(m.spending,2)}</strong> across ${m.spend.length} everyday transactions in ${monthLabel(month)}. Here are the biggest categories:</p><div class="answer-breakdown">${top.map(([c,v])=>`<span>${c}<strong>${money(v,2)}</strong></span>`).join('')}</div><p>Grouping spending into three baskets can help you see what’s regular, what needs a buffer, and where you have choices.</p><button class="text-button" data-concept="baskets">Explore my baskets ${icon('arrow')}</button>`;
  } else {
    answer = '<p>This demo can explain spending categories, compare months, show taxi spending, explore savings, and help you try a weekly budget.</p><p>Try “How much did I spend on groceries?” or choose one of the questions below. A live AI model is not connected to this prototype.</p>';
  }
  lastEvidenceCategory = category;
  chatMessages.push({ role:'user', html:`<p>${esc(question)}</p>` }, {role:'coach', html: answer + `<button class="evidence-link" data-evidence="${category}">${icon('eye')} View the transactions</button>` });
  renderMessages();
}
const basketInfo = [
  {name:'Everyday essentials',subtitle:'Mandatory & regular',copy:'The things that keep life running. Plan for these first.',icon:'home',class:'essential'},
  {name:'Life happens',subtitle:'Mandatory & irregular',copy:'The less predictable things. A buffer can soften the landing.',icon:'shield',class:'irregular'},
  {name:'Little everyday choices',subtitle:'Flexible everyday spending',copy:'The things you enjoy. Small choices can create room for a goal.',icon:'coffee',class:'flexible'},
];
function basketsView() {
  const totals = basketTotals(m.categories, basketMapping);
  return `${heading('A SIMPLE WAY TO UNDERSTAND', 'One month. Three little baskets.', 'Every euro has a story. Find out which ones you can shape.', `<span class="outlined-chip">${money(m.spending)} total spending</span>`)}
    <div class="basket-intro"><div class="distribution-bar" role="img" aria-label="Spending split across three baskets">${totals.map((t,i)=>`<span class="segment-${i}" style="width:${t / Math.max(m.spending,1) * 100}%"></span>`).join('')}</div><span>${monthLabel(month)} · ${m.spend.length} transactions</span></div>
    <div class="basket-grid">${basketInfo.map((b,i)=>`<section class="basket-card ${b.class}"><div class="basket-card-top"><span class="basket-illustration">${icon(b.icon)}</span><span class="basket-index">0${i+1}</span></div><p class="eyebrow">${b.subtitle}</p><h2>${b.name}</h2><div class="basket-total">${money(totals[i])}<span>${m.spending ? Math.round(totals[i]/m.spending*100) : 0}% of spending</span></div><p>${b.copy}</p><div class="basket-categories">${Object.entries(m.categories).filter(([c])=>basketMapping[c]===i).map(([c,v])=>`<button data-category="${c}"><span>${c}</span><strong>${money(v)}</strong></button>`).join('')}</div><button class="basket-explore" data-basket="${i}">Explore this basket ${icon('arrow')}</button></section>`).join('')}</div>
    <div class="basket-note">${icon('info')}<p>These are starting suggestions. Groceries and transport are grouped as regular essentials; health and home purchases as irregular needs. Your situation may be different.</p><button class="text-button" data-action="edit-baskets">Make it yours ${icon('arrow')}</button></div>
    <section class="panel transaction-panel"><div class="section-heading"><div><h2>The small details</h2><p>A closer look at the transactions behind your baskets.</p></div><label class="sr-only" for="basket-filter">Filter basket</label><select id="basket-filter"><option value="all">All baskets</option>${basketInfo.map((b,i)=>`<option value="${i}" ${basketFilter === String(i) ? 'selected' : ''}>${b.name}</option>`).join('')}</select></div><div id="basket-transactions">${transactionRows(m.spend.filter(t=>basketFilter === 'all' || basketMapping[t.category]===+basketFilter).slice(-5).reverse())}</div><button class="text-button" data-action="transactions">See all transactions ${icon('arrow')}</button></section>`;
}
function possibilitiesView() {
  return `${heading('SMALL STEPS, BIG POSSIBILITIES', 'What could a little change make?', 'Explore a possibility. Keep the things that matter to you.')}
    <div class="possibilities-grid"><section class="goal-hero"><span class="light-chip">YOUR NEXT CHAPTER</span><h2>Make room<br>for a little<br><em>more possibility.</em></h2><div class="goal-art" aria-hidden="true"><div class="art-sun"></div><div class="art-hill hill-back"></div><div class="art-hill hill-front"></div><div class="art-path"></div><div class="art-flag"><span></span></div><div class="art-plant plant-one">${icon('leaf')}</div><div class="art-plant plant-two">${icon('leaf')}</div></div><div class="goal-caption"><span>${icon('goal')} A goal of your own</span><strong id="goal-hero-value">${money(goalAmount)}</strong></div></section>
    <section class="panel scenario-controls"><div class="section-heading"><div><p class="eyebrow">YOUR WHAT-IF MIX</p><h2>Small changes, on your terms.</h2></div>${icon('spark')}</div><p class="muted">Use ${monthLabel(month)} as a starting point. Adjust a little, see what changes.</p>${Object.entries(cuts).map(([c,v])=>`<div class="slider-group"><div><span>${icon(categoryIcon(c))}<strong>${c === 'Lifestyle' ? 'Lifestyle & shopping' : c}</strong></span><strong id="cut-label-${c}">${v}% less</strong></div><input type="range" min="0" max="50" step="5" value="${v}" data-cut="${c}" aria-label="Reduce ${c} spending"><div class="slider-endpoints"><span>${money(m.categories[c],2)} this month</span><span id="cut-saving-${c}"></span></div></div>`).join('')}<div class="goal-inputs"><label>My savings goal (€)<input id="goal-amount" type="number" min="100" max="1000000" step="100" value="${goalAmount}"></label><label>Base saving / month (€)<input id="base-saving" type="number" min="0" max="10000" step="10" value="${baseSaving}"></label></div></section>
    <section class="scenario-result"><div><span class="eyebrow">A LITTLE CHANGE ADDS UP</span><h2 id="scenario-monthly"></h2><p>extra each month</p></div><div class="result-divider"></div><div><span class="eyebrow">OVER 12 SIMILAR MONTHS</span><h2 id="scenario-yearly"></h2><p>towards your next chapter</p></div><div class="scenario-flower" aria-hidden="true">${icon('spark')}</div></section>
    <section class="panel goal-projection"><div class="section-heading"><div><h2>Your goal, a little closer.</h2><p id="goal-time"></p></div>${icon('goal')}</div><div class="projection-lines"><div><span>Base saving</span><div class="projection-track"><i id="base-progress"></i></div><strong id="base-yearly"></strong></div><div><span>With your changes</span><div class="projection-track"><i id="new-progress"></i></div><strong id="new-yearly"></strong></div></div><button class="primary-button" data-action="save-plan">Save my demo plan ${icon('arrow')}</button><span id="plan-status" role="status"></span></section></div><p class="method-note">Illustration starts at €0 saved. Repeats this month’s spending for 12 months, with no interest or returns. Base savings are an editable assumption. Nothing is transferred.</p>`;
}
function updateScenario() {
  const status = document.querySelector('#plan-status'); if (status) status.textContent = '';
  const saving = scenarioSavings(m.categories, cuts);
  Object.entries(cuts).forEach(([c,v])=>{document.querySelector(`#cut-label-${c}`).textContent = `${v}% less`;document.querySelector(`#cut-saving-${c}`).textContent = `${money(m.categories[c]*v/100,2)} saved`;});
  document.querySelector('#scenario-monthly').textContent = `+${money(saving,2)}`;
  document.querySelector('#scenario-yearly').textContent = money(saving*12);
  document.querySelector('#goal-hero-value').textContent = money(goalAmount);
  const months = baseSaving+saving > 0 ? Math.ceil(goalAmount/(baseSaving+saving)) : null;
  document.querySelector('#goal-time').textContent = months ? `Around ${months} month${months === 1 ? '' : 's'} at ${money(baseSaving+saving,2)} per month.` : 'Add a monthly saving to start your plan.';
  document.querySelector('#base-progress').style.width = `${Math.min(100,baseSaving*12/goalAmount*100)}%`;
  document.querySelector('#new-progress').style.width = `${Math.min(100,(baseSaving+saving)*12/goalAmount*100)}%`;
  document.querySelector('#base-yearly').textContent = money(baseSaving*12);
  document.querySelector('#new-yearly').textContent = money((baseSaving+saving)*12);
}
function houseArt() {
  return `<svg class="house-art" viewBox="0 0 500 290" fill="none" aria-hidden="true"><circle cx="365" cy="80" r="47" fill="#f4e3ae"/><path d="M0 256c90-60 160-36 235-55 105-29 170-10 265 39v50H0Z" fill="#c4d9c7"/><path d="m132 124 120-92 120 92" stroke="#41685d" stroke-width="16" stroke-linejoin="round"/><path d="M147 120 252 41l105 80v136H147Z" fill="#fffdf3"/><path d="M252 41v216h105V121Z" fill="#e4eade"/><path d="M178 146h43v48h-43zM283 139h43v42h-43z" fill="#b9d4d0"/><path d="M199 146v48m-21-24h43m84-31v42m-22-21h43" stroke="#fffdf3" stroke-width="4"/><path d="M241 198h38v59h-38z" fill="#709885"/><circle cx="268" cy="229" r="3" fill="#f4e3ae"/><path d="M121 257H40m390 0h50" stroke="#87ab90" stroke-width="3"/><path d="M93 246V147m0 78-25-24m25-7 25-25" stroke="#5c8167" stroke-width="5"/><ellipse cx="94" cy="147" rx="31" ry="54" fill="#88ad84"/><path d="M405 257v-46" stroke="#5c8167" stroke-width="4"/><circle cx="405" cy="202" r="25" fill="#739b77"/><path d="m241 257-22 33h98l-38-33" fill="#e1d6bd"/></svg>`;
}
function homeView() {
  return `${heading('A LITTLE GUIDANCE FOR A BIG STEP', 'Your next chapter starts at home.', 'Understand the journey, explore the numbers, and take it one step at a time.')}
    <section class="home-banner"><div><span class="outlined-chip">A JOURNEY FROM THE DATA</span><h2>From “one day”<br>to a place of your own.</h2><p>A closer look at one synthetic mortgage case.<br>Every step, with a little more clarity.</p><button class="dark-button" data-action="mortgage-story">Explore the sample journey ${icon('arrow')}</button></div>${houseArt()}</section>
    <div class="home-grid"><section class="panel mortgage-simulator"><div class="section-heading"><div><p class="eyebrow">LET’S EXPLORE THE NUMBERS</p><h2>What might the payment look like?</h2></div>${icon('home')}</div><div class="slider-group"><div><label for="home-price">Home price</label><strong id="home-price-label"></strong></div><input id="home-price" type="range" min="100000" max="600000" step="1000" value="${homePrice}"><div class="slider-endpoints"><span>€100,000</span><span>€600,000</span></div></div><div class="slider-group"><div><label for="home-equity">Your deposit</label><strong id="home-equity-label"></strong></div><input id="home-equity" type="range" min="10000" max="100000" step="500" value="${homeEquity}"><div class="slider-endpoints"><span>€10,000</span><span>€100,000</span></div></div><div class="goal-inputs"><label>Annual interest (%)<input id="home-rate" type="number" min="0" max="15" step="0.1" value="${homeRate}"></label><label>Loan period (years)<select id="home-years">${[15,20,25,30].map(y=>`<option ${y===homeYears?'selected':''}>${y}</option>`).join('')}</select></label></div><p class="method-note">Illustrative annuity payment. Constant rate, monthly payments, no fees or taxes. Starting price and deposit come from sample case C0004; rate and term are assumptions.</p></section>
    <section class="home-payment"><span class="eyebrow">YOUR MONTHLY ILLUSTRATION</span><div class="payment-number" id="home-payment"></div><p>estimated loan payment / month</p><div class="payment-breakdown"><span>Loan amount<strong id="home-loan"></strong></span><span>Deposit share<strong id="home-deposit-share"></strong></span><span>Rate + 2 percentage points<strong id="home-stress"></strong></span></div><div class="home-coach-note">${icon('spark')}<p>A home costs more than its loan payment. Leave room for maintenance, utilities, and life’s surprises.</p></div><button class="text-button" data-action="home-costs">Explore recorded home costs ${icon('arrow')}</button></section></div>
    <section class="panel journey-panel"><div class="section-heading"><div><h2>Every journey has a few milestones.</h2><p>Recorded history · sample case C0004 · linked customer CUST04457</p></div><span class="success-chip">${icon('check')} Historical case: approved</span></div><div class="journey-steps">${[['application_created','Application','The starting point'],['loan_calculation','The numbers','Price, deposit & loan'],['collateral_valuation','The details','Property valuation'],['loan_decision','The decision','Recorded in the dataset']].map(([event,label,copy],i)=>{const e=data.history.find(e=>e.event_type===event);return `<button data-event="${event}"><span class="step-dot">${i+1}</span><strong>${label}</strong><span>${copy}</span><small>${e ? formatSas(e.timestamp) : 'Not recorded'}</small></button>`;}).join('')}</div></section><p class="method-note">The mortgage view uses its own linked sample case. The example outcome is historical; the simulator does not predict approval or provide a loan offer.</p>`;
}
function updateHome() {
  const principal = Math.max(0,homePrice-homeEquity);
  document.querySelector('#home-price-label').textContent = money(homePrice);
  document.querySelector('#home-equity-label').textContent = money(homeEquity);
  document.querySelector('#home-payment').textContent = money(mortgagePayment(principal,homeRate,homeYears));
  document.querySelector('#home-loan').textContent = money(principal);
  document.querySelector('#home-deposit-share').textContent = `${(homeEquity/homePrice*100).toFixed(1)}%`;
  document.querySelector('#home-stress').textContent = `${money(mortgagePayment(principal,homeRate+2,homeYears))} / month`;
}
function formatSas(s) { return `${s.slice(0,2)} ${s.slice(2,5).toLowerCase().replace(/^./,c=>c.toUpperCase())} 20${s.slice(5,7)}`; }
function transactionRows(rows) {
  if (!rows.length) return '<p class="empty-state">No matching transactions in this period. Try another month or basket.</p>';
  return rows.map(t=>`<div class="transaction-row"><span class="category-badge">${icon(categoryIcon(t.category))}</span><div><strong>${esc(t.category)}</strong><span>${new Date(t.date+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'})}${t.merchant ? ' · '+esc(t.merchant) : ' · '+esc(t.type.replaceAll('_',' '))}</span></div><strong class="${t.amount>0?'positive':''}">${t.amount>0?'+':''}${money(t.amount,2)}</strong></div>`).join('');
}
let focusBeforeDialog;
function modal(title, body) {
  focusBeforeDialog = document.activeElement;
  details.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;
  details.setAttribute('aria-labelledby','dialog-title');
  if (!details.open) details.showModal();
}
function showTransactions(category='all') {
  const rows = category==='taxi' ? m.transactions.filter(t=>t.mcc==='4121') : category==='all' ? m.transactions : m.transactions.filter(t=>t.category===category);
  modal(category==='all' ? 'Your month, in detail' : category==='taxi' ? 'Taxi transactions · MCC 4121' : `${esc(category)} transactions`, `<p class="muted">${monthLabel(month)} · ${profile.customer_id} · ${rows.length} transactions</p>${transactionRows([...rows].reverse())}<p class="method-note">Merchant codes are shown as supplied. Merchant names are not included in this dataset.</p>`);
}
function showSources() {
  modal('A little about this demo', `<p>Five independent UI concepts inspired by S-mobiili, built for the S-Pankki Personal Economic Trainer challenge. This is a local hackathon prototype, not a bank service.</p><div class="source-grid"><div><strong>${data.summary.count.toLocaleString('en-GB')}</strong><span>synthetic transactions</span></div><div><strong>5,100</strong><span>sample customers</span></div><div><strong>200</strong><span>mortgage cases</span></div><div><strong>3,452</strong><span>mortgage events</span></div></div><h3>What comes from the data?</h3><p>Customer samples, transaction amounts, dates, categories, balances, merchant category codes, and the mortgage case timeline. Transaction coverage: ${data.summary.from} to ${data.summary.to}.</p><h3>What is illustrative?</h3><p>The coach uses scripted explanations with calculated figures. Basket assignments are editable heuristics. Savings projections repeat a historical month. Weekly budgets, interest rates, and goals use explicit assumptions. No live bank, AI, or payments are connected.</p><h3>How spending is counted</h3><p>Housing, utilities, groceries, health, transport, home purchases, dining, lifestyle, entertainment, and travel count as everyday spending. Salary and other income count as income. Investment deposits, withdrawals, and salary sweeps are reported separately.</p><h3>Sources</h3><ul class="source-list"><li>tx_junction_transactions.csv</li><li>tx_customers_junction.csv</li><li>mtg_tx_customer_link_and_final_mtg_infio.csv</li><li>mtg_negotiation_history.csv</li></ul><p><a href="https://www.s-pankki.fi/fi/verkkopalvelut/s-mobiili/" target="_blank" rel="noreferrer">S-Pankki’s S-mobiili reference</a> · <a href="https://github.com/hackjunction/Junction-2026-S-pankki" target="_blank" rel="noreferrer">Challenge dataset</a></p><button class="quiet-button" data-action="export-data">${icon('download')} Download this demo’s data</button>`);
}
function showWeekly() {
  const reserved = m.categories.Housing + m.categories.Utilities;
  modal('A little room for the week', `<p>Try a planning estimate using your latest recorded balance. Adjust the money you want to keep aside.</p><p class="muted">Historical balance: ${money(m.balance,2)} · ${m.asOf}</p><div class="weekly-inputs"><label>Upcoming bills and essentials (€)<input id="weekly-reserved" type="number" min="0" value="${Math.round(reserved)}"></label><label>Keep-aside buffer (€)<input id="weekly-buffer" type="number" min="0" value="500"></label><label>Spread over how many weeks?<input id="weekly-weeks" type="number" min="1" max="52" value="4"></label></div><div class="weekly-result"><span>Illustrative weekly amount</span><strong id="weekly-result"></strong></div><p class="method-note">Formula: max(0, balance − reserved essentials − buffer) ÷ weeks. The initial reserve uses this month’s housing and utilities as a placeholder; it is not a bill forecast. This estimate excludes future income.</p>`);
  updateWeekly();
}
function updateWeekly() {
  document.querySelector('#weekly-result').textContent = money(weeklyBudget(m.balance,Math.max(0,+document.querySelector('#weekly-reserved').value),Math.max(0,+document.querySelector('#weekly-buffer').value),+document.querySelector('#weekly-weeks').value),2);
}
function toast(message) { const t=document.querySelector('#toast');t.textContent=message;t.classList.add('visible');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove('visible'),3200); }
function action(name) {
  if(name==='close-dialog') details.close();
  if(name==='sources') showSources();
  if(name==='transactions') showTransactions();
  if(name==='weekly') showWeekly();
  if(name==='reset-chat'){chatMessages=[];renderMessages();}
  if(name==='cashflow') modal('How your month adds up', `<p class="muted">${monthLabel(month)} · ${profile.customer_id}</p><div class="answer-breakdown"><span>Salary + other income<strong>${money(m.income,2)}</strong></span><span>Everyday spending<strong>−${money(m.spending,2)}</strong></span><span>Income after spending<strong>${money(m.margin,2)}</strong></span><span>Investment deposits<strong>−${money(m.deposits,2)}</strong></span><span>Salary sweeps<strong>−${money(m.sweeps,2)}</strong></span><span>Investment withdrawals<strong>+${money(m.withdrawals,2)}</strong></span><span>Net cash flow · all transactions<strong>${money(m.netFlow,2)}</strong></span></div><p>The headline is income minus everyday spending. It isn’t your account balance or a safe-to-spend promise. Transfers can change how much money is actually left in an account.</p>`);
  if(name==='chart-data') modal('The figures behind the chart', `<div class="data-table"><table><thead><tr><th>Month</th><th>Income</th><th>Spending</th></tr></thead><tbody>${['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'].filter(d=>d<=month).map(d=>{const s=metrics(profile,d);return `<tr><th>${monthLabel(d)}</th><td>${money(s.income,2)}</td><td>${money(s.spending,2)}</td></tr>`;}).join('')}</tbody></table></div>`);
  if(name==='edit-baskets') modal('Your life. Your baskets.', `<p>Choose where each category belongs for you. These changes last until you refresh the demo.</p><div class="basket-edit">${Object.keys(basketMapping).map(c=>`<label>${c}<select data-map="${c}">${basketInfo.map((b,i)=>`<option value="${i}" ${basketMapping[c]===i?'selected':''}>${b.name}</option>`).join('')}</select></label>`).join('')}</div><button class="primary-button" data-action="apply-baskets">Apply my choices ${icon('check')}</button>`);
  if(name==='apply-baskets'){details.querySelectorAll('[data-map]').forEach(s=>basketMapping[s.dataset.map]=+s.value);details.close();renderApp();toast('Your baskets have been updated.');}
  if(name==='save-plan'){
    const plan={profile:profile.customer_id,month,cuts,goalAmount,baseSaving,saving:scenarioSavings(m.categories,cuts)};
    try{localStorage.setItem('oma-talous-demo-plan',JSON.stringify(plan));document.querySelector('#plan-status').textContent='Saved on this device';toast('Demo plan saved on this device. No money was moved.');}catch{toast('Device storage is unavailable. Your plan is still visible.');}
  }
  if(name==='load-plan'){
    try {
      const saved = JSON.parse(localStorage.getItem('oma-talous-demo-plan'));
      const savedProfile = data.profiles.find(p => p.customer_id === saved?.profile);
      if (!savedProfile || !/^2026-0[4-9]$/.test(saved.month) || !Number.isFinite(saved.goalAmount) || !Number.isFinite(saved.baseSaving)) { toast('No saved demo plan yet. Create one with the controls above.'); return; }
      profile=savedProfile; month=saved.month;
      for (const c of Object.keys(cuts)) cuts[c]=Math.max(0,Math.min(50,Number(saved.cuts?.[c]) || 0));
      goalAmount=Math.max(100,Math.min(1000000,saved.goalAmount));baseSaving=Math.max(0,Math.min(10000,saved.baseSaving));
      renderApp();document.querySelector('#plan-status').textContent='Saved plan restored';toast('Your saved demo plan is back.');
    } catch { toast('No saved plan is available on this device.'); }
  }
  if(name==='mortgage-story') modal('A home-buying journey', `<p>Sample case C0004 is linked to transaction customer CUST04457. These are historical events from the supplied mortgage log.</p><div class="event-history">${data.history.map(e=>`<article><span>${formatSas(e.timestamp)}</span><h3>${esc(e.event_type.replaceAll('_',' '))}</h3><p>${esc(e.note)}</p></article>`).join('')}</div>`);
  if(name==='home-costs') modal('The costs around a home', `<p>Recorded expenses in sample case C0004. They are shown as events, not summed into a monthly budget: the dataset mixes one-off and recurring costs.</p>${data.history.filter(e=>e.event_type==='expense_recorded').map(e=>`<div class="transaction-row"><span class="category-badge">${icon('home')}</span><div><strong>${esc(e.expense_type.replaceAll('_',' '))}</strong><span>${formatSas(e.timestamp)}</span></div><strong>${money(+e.expense_amount)}</strong></div>`).join('')}<p class="method-note">No row is assumed to be a complete list of future costs.</p>`);
  if(name==='export-data'){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='oma-talous-synthetic-demo-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('The sample data is ready to download.');}
}
document.addEventListener('click',e=>{
  const el=e.target.closest('button,a'); if(!el)return;
  if(el.dataset.concept){e.preventDefault();switchConcept(el.dataset.concept);}
  if(el.dataset.device){document.querySelector('.preview-stage').classList.toggle('mobile-preview',el.dataset.device==='mobile');document.querySelectorAll('[data-device]').forEach(b=>b.classList.toggle('active',b===el));}
  if(el.dataset.action)action(el.dataset.action);
  if(el.dataset.category)showTransactions(el.dataset.category);
  if(el.dataset.evidence)showTransactions(el.dataset.evidence);
  if(el.dataset.prompt)answerChat(el.dataset.prompt);
  if(el.dataset.basket){basketFilter=el.dataset.basket;renderApp();document.querySelector('.transaction-panel').scrollIntoView({behavior:'smooth',block:'start'});}
  if(el.dataset.event){const events=data.history.filter(x=>x.event_type===el.dataset.event);modal('A step in the journey',events.map(x=>`<p class="eyebrow">${formatSas(x.timestamp)}</p><h3>${esc(x.event_type.replaceAll('_',' '))}</h3><p>${esc(x.note)}</p>`).join(''));}
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='profile'){profile=data.profiles.find(p=>p.customer_id===t.value);chatMessages=[];renderApp();}
  if(t.id==='month'){month=t.value;chatMessages=[];renderApp();}
  if(t.id==='basket-filter'){basketFilter=t.value;document.querySelector('#basket-transactions').innerHTML=transactionRows(m.spend.filter(x=>basketFilter==='all'||basketMapping[x.category]===+basketFilter).slice(-5).reverse());}
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.dataset.cut){cuts[t.dataset.cut]=+t.value;updateScenario();}
  if(t.id==='goal-amount'){goalAmount=Math.min(1000000,Math.max(100,+t.value));updateScenario();}
  if(t.id==='base-saving'){baseSaving=Math.min(10000,Math.max(0,+t.value));updateScenario();}
  if(t.id==='home-price'){homePrice=+t.value;homeEquity=Math.min(homeEquity,homePrice);updateHome();}
  if(t.id==='home-equity'){homeEquity=Math.min(+t.value,homePrice);updateHome();}
  if(t.id==='home-rate'){homeRate=Math.min(15,Math.max(0,+t.value));updateHome();}
  if(t.id==='home-years'){homeYears=+t.value;updateHome();}
  if(t.id.startsWith('weekly-'))updateWeekly();
});
document.addEventListener('submit',e=>{if(e.target.id==='chat-form'){e.preventDefault();const input=document.querySelector('#chat-input');const q=input.value.trim();if(q){answerChat(q);input.value='';input.focus();}}});
details.addEventListener('click',e=>{if(e.target===details){const r=details.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)details.close();}});
details.addEventListener('close',()=>focusBeforeDialog?.focus());
init();
