import { createChatDialog } from './chat.js';
import { createWrapped } from './wrapped.js';
import { metrics, basketTotals, scenarioSavings, transactionKind } from './model.js';
import { createFinanceAnalytics } from './finance-analytics/index.js';
import { moveMonth } from './finance-analytics/model.js';
import { projectFinanceData } from './adapters/project-finance.js';

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
let data,profile,m,selectedMonth='2026-09',lastFocus,analytics;
const months=[];
const basketInfo=[['Säännölliset tarpeet','Asuminen, ruoka, laskut ja liikkuminen','home'],['Yllättävät tarpeet','Terveys sekä koti ja tekniikka','shield'],['Arjen valinnat','Ravintolat, ostokset ja vapaa-aika','coffee']];

async function init(){try{const res=await fetch('demo-data.json');if(!res.ok)throw new Error('Aineisto ei latautunut.');data=await res.json();await wrapped.load().catch(()=>{});profile=data.profiles[0];selectedMonth=data.summary.to.slice(0,7);for(let month=selectedMonth;month>=data.summary.from.slice(0,7);month=moveMonth(month,-1))months.push(month);render();openFromLink();}catch(error){root.innerHTML=`<div class="load-error"><h1>Demo ei latautunut</h1><p>${esc(error.message)}</p><button data-action="reload">Yritä uudelleen</button></div>`;}}
function section(title,action='',label='Näytä kaikki'){return `<div class="section-title"><h2>${title}</h2>${action?`<button class="text-button" data-action="${action}">${label}</button>`:''}</div>`;}
function render(){
  analytics?.destroy();m=metrics(profile,selectedMonth);const baskets=basketTotals(m.categories);
  root.innerHTML=`<div class="app-shell"><header class="topbar"><span class="demo-pill">DEMO</span><h1>Oma talous</h1><button class="icon-button" data-action="about" aria-label="Tietoa demoaineistosta">${icon('info')}</button></header>
    <main id="main-content" class="mint-content"><div class="period-row"><span>${icon('calendar')}<label class="sr-only" for="month">Tarkasteltava kuukausi</label><select id="month">${months.map(d=>`<option value="${d}" ${d===selectedMonth?'selected':''}>${capitalize(monthName(d))}</option>`).join('')}</select></span><button class="sample-button" data-action="dataset" aria-label="Vaihda demoasiakasta">${icon('person')}<span>Demoasiakas ${data.profiles.indexOf(profile)+1}</span></button></div>
    ${section('Kuukauden yhteenveto')}<section class="white-card month-card"><div class="month-head"><span class="month-symbol">${icon('chart')}</span><div><h3>Tuloista jäljellä</h3><p>Arjen menojen jälkeen</p></div><button class="icon-button" data-action="cashflow" aria-label="Miten summa lasketaan?">${icon('info')}</button></div><strong class="month-amount ${m.margin<0?'negative':''}">${euro(m.margin)}</strong><div class="income-expenses"><button data-action="income"><span>Tulot</span><strong>${euro(m.income)}</strong></button><button data-action="spending"><span>Menot</span><strong>${euro(m.spending)}</strong></button></div><button class="card-footer" data-action="cashflow">Katso yhteenveto ${icon('chevron')}</button></section>
    ${wrapped.has(profile.customer_id)?wrapped.teaser():''}
    <button class="account-row white-card" data-action="account"><span class="account-icon">${icon('account')}</span><span><strong>Tilin saldo</strong><small>Viimeisin aineiston saldo</small></span><b>${euro(m.balance)}</b>${icon('chevron')}</button>
    <div id="financial-analytics"></div>
    ${section('Kolme menokoria','baskets','Mitä nämä ovat?')}<section class="white-card basket-card">${basketInfo.map(([name,copy,glyph],i)=>`<button class="basket-row" data-basket="${i}"><span class="basket-icon">${icon(glyph)}</span><span><strong>${name}</strong><small>${Math.round(baskets[i]/Math.max(1,m.spending)*100)} % menoista</small></span><b>${euro(baskets[i])}</b>${icon('chevron')}</button>`).join('')}</section>
    ${section('Pienestä muutoksesta alku')}<section class="white-card saving-card"><div class="saving-intro">${icon('coffee')}<h3>Entä jos käyttäisit ravintoloihin 20 % vähemmän?</h3></div><p>Valitun kuukauden perusteella säästöä voisi kertyä</p><strong>${euro(scenarioSavings(m.categories,{Restaurants:20}))}<span> / kk</span></strong><button class="green-link" data-action="savings">Kokeile omaa muutostasi ${icon('chevron')}</button></section>
    ${section('Viimeisimmät tapahtumat','account')}<section class="white-card transactions-card">${transactionsHTML([...m.transactions].reverse().slice(0,4))}</section>
    <p class="demo-note">Synteettinen demoaineisto · ${capitalize(monthName(selectedMonth))}<br>Ei yhteyttä oikeaan pankkitiliin.</p></main>
    <button class="chat-fab" data-action="chat" aria-label="Avaa talousvalmentaja" title="Kysy taloudestasi">${icon('chat')}<span>Kysy</span></button>
    <nav class="bottom-nav" aria-label="Päävalikko">${[['Koti','home'],['S-Etukortti','s'],['Pankki','wallet']].map(([label,glyph])=>`<button class="nav-item" data-context="${label}">${glyph==='s'?sMark():icon(glyph)}<span>${label}</span></button>`).join('')}<button class="nav-item active" data-action="top" aria-current="page">${icon('chart')}<span>Oma talous</span></button><button class="nav-item" data-context="Minä">${icon('person')}<span>Minä</span></button></nav></div>`;
  analytics=createFinanceAnalytics(document.querySelector('#financial-analytics'),{data:projectFinanceData(profile,data.summary,names),selectedMonth,onSelectCategory:category=>showTransactions(category),onSelectMonth:month=>{selectedMonth=month;render();window.scrollTo({top:0,behavior:'smooth'});}});
}
function categoryRow(category,value){return `<button class="category-row" data-category="${category}"><span class="row-icon">${icon(categoryIcon(category))}</span><span class="category-copy"><strong>${names[category]}</strong><span class="category-track"><i style="width:${value/Math.max(1,m.spending)*100}%"></i></span></span><b>${euro(value)}</b>${icon('chevron','row-chevron')}</button>`;}
function transactionsHTML(rows){return rows.length?rows.map(t=>`<div class="transaction-row"><span class="row-icon">${icon(categoryIcon(t.category))}</span><span><strong>${names[t.category]||esc(t.category)}</strong><small>${new Date(t.date+'T12:00:00Z').toLocaleDateString('fi-FI',{day:'numeric',month:'numeric',timeZone:'UTC'})}${t.merchant?' · '+esc(t.merchant):''}</small></span><b class="${t.amount>0?'positive':''}">${t.amount>0?'+':''}${euro(t.amount)}</b></div>`).join(''):'<p class="empty-state">Ei tapahtumia valitulla ajanjaksolla.</p>';}
function modal(title,body,kind=''){
  if(!detail.open)lastFocus=document.activeElement;detail.className=kind;
  detail.innerHTML=`<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Sulje">${icon('close')}</button></div><div class="dialog-content">${body}</div>`;
  detail.setAttribute('aria-labelledby','dialog-title');if(!detail.open)detail.showModal();
}
function showTransactions(kind='all'){
  const rows=kind==='all'?m.transactions:kind==='income'?m.transactions.filter(t=>transactionKind(t)==='income'):kind==='spending'?m.spend:m.transactions.filter(t=>t.category===kind);
  const title=({all:'Tilin tapahtumat',income:'Tulot',spending:'Arjen menot'})[kind]||names[kind];
  modal(title,`${kind==='all'?`<div class="account-summary"><span>Demoasiakas ${data.profiles.indexOf(profile)+1}</span><strong>${euro(m.balance)}</strong><small>Viimeisin aineiston saldo · ${m.asOf}</small></div>`:''}<p class="period-caption">${capitalize(monthName(selectedMonth))} · ${rows.length} tapahtumaa</p>${transactionsHTML([...rows].reverse())}<p class="fine-print">Kauppiaiden tunnisteet tulevat aineistosta. Kauppiaiden nimiä ei ole saatavilla.</p>`);
}
function showBaskets(selected){const totals=basketTotals(m.categories);modal(selected===undefined?'Kolme menokoria':basketInfo[selected][0],`<p>Menokorit auttavat hahmottamaan, mihin rahat menevät.</p>${basketInfo.map(([title,copy,glyph],i)=>selected!==undefined&&selected!==i?'':`<section class="basket-summary">${icon(glyph)}<div><h3>${title}</h3><p>${copy}.</p><strong>${euro(totals[i])}</strong></div></section>`).join('')}<p class="fine-print">Luokittelu on esimerkki. Aineistosta ei voi päätellä, mitkä yksittäiset ostokset olivat sinulle välttämättömiä. Matkailu sisältyy arjen valintoihin.</p>`);}
const showChat = createChatDialog({ modal, detail, icon });
// The year-in-review story; its "ask the coach" buttons open the chat with the question filled in.
const wrapped = createWrapped({ onAsk: question => showChat(question) });
// Deep link, e.g. from a push notification: #rahavuosi opens the story, #rahavuosi/3 opens card 3.
function openFromLink(){const match=location.hash.match(/^#rahavuosi(?:\/(\d+))?$/);if(match)wrapped.open(profile.customer_id,null,Math.max(0,(+match[1]||1)-1));}
function action(name){
  if(name==='reload'){location.reload();return;}
  if(name==='close'){detail.close();return;}
  if(name==='top'){window.scrollTo({top:0,behavior:'smooth'});return;}
  if(name==='chat'){showChat();return;}
  if(name==='wrapped'){wrapped.open(profile.customer_id);return;}
  if(name==='account'){showTransactions();return;}
  if(name==='income'||name==='spending'){showTransactions(name);return;}
  if(name==='categories'){modal('Mihin rahani menivät?',`<p>${capitalize(monthName(selectedMonth))}</p><div class="dialog-categories">${Object.entries(m.categories).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([c,v])=>categoryRow(c,v)).join('')}</div>`);return;}
  if(name==='baskets'){showBaskets();return;}
  if(name==='savings'){modal('Kokeile pientä muutosta',`<p>Ravintoloihin kului valitussa kuussa yhteensä <strong>${euro(m.categories.Restaurants)}</strong>.</p><label class="savings-label" for="saving-cut">Entä jos käyttäisit vähemmän? <b id="saving-percent">20 %</b></label><input id="saving-cut" type="range" min="0" max="50" step="5" value="20"><div class="savings-result"><span>Laskennallinen säästö kuukaudessa</span><strong id="saving-result">${euro(scenarioSavings(m.categories,{Restaurants:20}))}</strong></div><p class="fine-print">Esimerkkilaskelma perustuu valittuun historialliseen kuukauteen. Se ei siirrä rahaa eikä ennusta tulevia menoja.</p>`);return;}
  if(name==='cashflow'){modal('Kuukauden yhteenveto',`<p>${capitalize(monthName(selectedMonth))}</p><div class="financial-summary">${[['Tulot',m.income],['Arjen menot',-m.spending],['Tuloista jäljellä',m.margin],['Siirrot sijoituksiin',-m.deposits],['Palkkasiirrot',-m.sweeps],['Nostot sijoituksista',m.withdrawals],...(m.otherFlow?[['Muut tilitapahtumat',m.otherFlow]]:[]),['Kaikkien tapahtumien nettomuutos',m.netFlow]].map(([label,value])=>`<span>${label}<strong>${euro(value)}</strong></span>`).join('')}</div><p class="fine-print">Tuloista jäljellä = palkka ja muut tulot − arjen menot. Summa ei ole tilin saldo eikä arvio turvallisesta käyttörahasta. Sijoitus- ja palkkasiirrot esitetään erikseen.</p>`);return;}
  if(name==='dataset'){modal('Demoasiakas',`<p>Vaihda synteettistä asiakasta. Talouden yhteenveto ja tapahtumat päivittyvät valintasi mukaan.</p><form id="dataset-form" class="stacked-form"><label>Esimerkkiasiakas<select name="profile" aria-label="Esimerkkiasiakas">${data.profiles.slice(0,3).map((p,i)=>`<option value="${p.customer_id}" ${p.customer_id===profile.customer_id?'selected':''}>Demoasiakas ${i+1} · ${p.customer_id}</option>`).join('')}</select></label><button class="primary-button" type="submit">Käytä valintaa ${icon('check')}</button></form><p class="fine-print">Kaikki asiakastiedot ovat synteettisiä. Näyttökuvien henkilö- ja tilitietoja ei käytetä.</p>`);return;}
  if(name==='about'){modal('Tietoa demoaineistosta',`<p>Tämä on uusi <strong>Oma talous</strong> -välilehti S-mobiilin kuvakaappausten mukaisessa tyylissä. Muut alapalkin välilehdet havainnollistavat paikan nykyisessä sovelluksessa.</p><h3>Projektin aineisto</h3><p>3 626 755 synteettistä tapahtumaa ja 5 100 asiakasta. Aikaväli 1.10.2024–30.9.2026. Tässä demossa voi tarkastella kolmea esimerkkiasiakasta.</p><h3>Mitä näet?</h3><p>Tuloja, menoja, kategorioita, tapahtumia ja historiallisia saldoja. Menokorit ovat esimerkkiluokittelu. Säästölaskuri käyttää valitun kuukauden menoja.</p><h3>Talousvalmentaja</h3><p>Keskustelu käyttää Claude-tekoälyä. Vain kirjoittamasi viestit ja keskustelun viimeisimmät vastaukset lähetetään palveluun. Demoasiakkaan tietoja, tilin saldoa tai tapahtumia ei lähetetä.</p><p class="fine-print">Hackathon-demo. Ei S-Pankin virallinen palvelu eikä yhteyttä oikeaan pankkitiliin.</p>`);}
}
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.action)action(button.dataset.action);if(button.dataset.category)showTransactions(button.dataset.category);if(button.dataset.basket!==undefined)showBaskets(+button.dataset.basket);if(button.dataset.context)modal(button.dataset.context,`<p>Tämä on nykyisen S-mobiilin välilehden paikka. Tässä esittelyssä voit tutustua uuteen <strong>Oma talous</strong> -välilehteen.</p><button class="primary-button full-width" data-action="close">Takaisin omaan talouteen</button>`);});
document.addEventListener('change',event=>{if(event.target.id==='month'){selectedMonth=event.target.value;render();}});
document.addEventListener('input',event=>{if(event.target.id==='saving-cut'){document.querySelector('#saving-percent').textContent=`${event.target.value} %`;document.querySelector('#saving-result').textContent=euro(scenarioSavings(m.categories,{Restaurants:+event.target.value}));}});
document.addEventListener('submit',event=>{event.preventDefault();if(event.target.id==='dataset-form'){const form=new FormData(event.target);profile=data.profiles.find(p=>p.customer_id===form.get('profile'))||data.profiles[0];detail.close();render();}});
detail.addEventListener('click',event=>{if(event.target===detail){const r=detail.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)detail.close();}});
detail.addEventListener('close',()=>{if(lastFocus?.isConnected)lastFocus.focus();else document.querySelector('.nav-item.active')?.focus();});
init();
