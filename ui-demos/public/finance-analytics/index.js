import { locale } from '../language.js';
import { prepareDataset, breakdown, annualSpending, spendingRhythm, historySeries, canShift, shiftAnchor, monthEnd, dateOf } from './model.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const money = (value, digits = 0) => value === null ? 'Ei aineistoa' : new Intl.NumberFormat(locale(), { style:'currency', currency:'EUR', minimumFractionDigits:digits, maximumFractionDigits:digits }).format(value || 0);
const number = (value, digits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits:digits }).format(value || 0);
const dateLabel = date => dateOf(date).toLocaleDateString(locale(), { day:'numeric', month:'numeric', year:'numeric', timeZone:'UTC' });
const monthLabel = month => { const value = dateOf(month + '-01').toLocaleDateString(locale(), { month:'long', year:'numeric', timeZone:'UTC' }); return value[0].toUpperCase() + value.slice(1); };
const monthShort = () => Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat(locale(), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, month, 1))));
const palette = ['#007e43','#42a77c','#81b9a4','#aecf61','#668f9d','#b6c9be','#58835c','#d4c77a','#637f75','#bac9a0'];
const chevron = direction => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction === 'left' ? 'm15 5-7 7 7 7' : direction === 'down' ? 'm5 9 7 7 7-7' : 'm9 5 7 7-7 7'}"/></svg>`;
const chartIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h19M8 17v-6m6 6V5m6 12V8"/></svg>';
const periodTitle = series => series.view === 'day' ? dateLabel(series.from) : series.view === 'month' ? monthLabel(series.anchor.slice(0,7)) : series.view === 'year' ? series.anchor.slice(0,4) : `${dateLabel(series.from)}–${dateLabel(series.to)}`;
const binTitle = (bin, view) => view === 'day' ? (bin.label === 'Ei aikaa' ? 'Kellonaika puuttuu' : `Klo ${bin.label}–${String(+bin.label + 1).padStart(2,'0')}`) : view === 'year' ? monthLabel(bin.from.slice(0,7)) : view === 'years' ? bin.from.slice(0,4) : dateLabel(bin.from);
let instanceCounter = 0;

function scaleMaximum(values) {
  const max = Math.max(1, ...values.filter(v => v !== null && Number.isFinite(v)));
  const power = 10 ** Math.floor(Math.log10(max));
  return [1,2,4,5,8,10].map(n => n * power).find(n => n >= max) || max;
}

// Shared SVG renderer. Lines break at unavailable periods; missing values never become zeros.
function plot({ bins, comparison = true, income = false, selected = -1, patternId = '', annual = false }) {
  const width = 360, height = 230, left = 5, right = 47, top = 17, bottom = 200;
  const plotWidth = width - left - right, step = plotWidth / bins.length;
  const max = scaleMaximum(bins.flatMap(b => [b.spending, comparison ? b.comparison : null, income ? b.income : null]));
  const x = i => left + step * (i + .5), y = value => bottom - (value || 0) / max * (bottom - top);
  function line(key, cls) {
    let path = '', open = false;
    bins.forEach((b, i) => { if (b[key] === null) { open = false; return; } path += `${open ? 'L' : 'M'}${x(i)},${y(b[key])} `; open = true; });
    return `<path class="${cls}" d="${path}"/>`;
  }
  let area = '';
  if (annual && comparison) {
    let segment = [];
    function flush() { if (!segment.length) return; area += `<path d="M${x(segment[0][0]) - step / 2},${bottom} L${segment.map(([i,v]) => `${x(i)},${y(v)}`).join(' L')} L${x(segment.at(-1)[0]) + step / 2},${bottom}Z" fill="url(#${patternId})"/>`; segment = []; }
    bins.forEach((b,i) => { if (b.comparison !== null) segment.push([i,b.comparison]); else flush(); }); flush();
  }
  return `<svg class="fa-plot" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    ${annual ? `<defs><pattern id="${patternId}" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 1h5" stroke="#b4d7c6" stroke-width="2"/></pattern></defs>` : ''}
    ${[0,.5,1].map(f => `<line class="fa-gridline" x1="${left}" x2="${width-right}" y1="${y(max*f)}" y2="${y(max*f)}"/><text class="fa-axis" x="${width-1}" y="${y(max*f)+4}" text-anchor="end">${number(max*f)}</text>`).join('')}
    <text class="fa-axis" x="${width-1}" y="10" text-anchor="end">€</text>${area}
    ${bins.map((b,i) => b.spending === null ? `<text class="fa-missing" x="${x(i)}" y="${bottom-7}" text-anchor="middle">–</text>` : `<rect class="fa-bar ${i === selected ? 'fa-selected-bar' : ''}" x="${x(i)-Math.min(18,step*.6)/2}" y="${y(b.spending)}" width="${Math.min(18,step*.6)}" height="${Math.max(b.spending ? 1 : 0,bottom-y(b.spending))}" rx="3"/>`).join('')}
    ${comparison ? line('comparison', annual ? 'fa-annual-line' : 'fa-comparison-line') : ''}${income ? line('income','fa-income-line') : ''}
    ${selected >= 0 ? `<line class="fa-selection-line" x1="${x(selected)}" x2="${x(selected)}" y1="${top}" y2="${bottom}"/>` : ''}
    ${bins.map((b,i) => (annual || bins.length <= 12 || i === 0 || i === bins.length-1 || (i+1)%5 === 0) ? `<text class="fa-axis ${i === selected ? 'fa-selected-label' : ''}" x="${x(i)}" y="222" text-anchor="middle">${annual ? monthShort()[i] : escape(b.label)}</text>` : '').join('')}
  </svg>`;
}

function donut(entries, total, caption) {
  let offset = 0;
  return `<div class="fa-donut"><svg viewBox="0 0 220 220" role="img" aria-label="${escape(caption)} ${escape(money(total))}. Kategoriat kaavion alla."><circle cx="110" cy="110" r="91" class="fa-donut-track"/>
    ${entries.map((entry,i) => { const arc = total ? entry.value / total * 100 : 0; const result = `<circle cx="110" cy="110" r="91" pathLength="100" fill="none" stroke="${palette[i%palette.length]}" stroke-width="15" stroke-dasharray="${Math.max(0,arc-(entries.length>1?.65:0))} 100" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"/>`; offset += arc; return result; }).join('')}</svg><div class="fa-donut-total"><span>${caption}</span><strong>${money(total)}</strong><small>yhteensä</small></div></div>`;
}

function halfDonut(entries, total, caption) {
  let offset = 0;
  const arcPath = 'M12 94 A78 78 0 0 1 168 94';
  return `<svg class="fa-half-donut" viewBox="0 0 180 112" role="img" aria-label="${escape(caption)} ${escape(money(total))}. Kategoriat kaavion vieressä."><path d="${arcPath}" fill="none" stroke="#e5eee7" stroke-width="18"/>
    ${entries.map((entry,i) => {
      const arc = total ? entry.value / total * 100 : 0;
      const segment = `<path d="${arcPath}" pathLength="100" fill="none" stroke="${palette[i]}" stroke-width="18" stroke-dasharray="${Math.max(0,arc - (entries.length > 1 ? .7 : 0))} 100" stroke-dashoffset="${-offset}"/>`;
      offset += arc; return segment;
    }).join('')}<text class="fa-half-caption" x="90" y="70" text-anchor="middle">${caption}</text><text class="fa-half-total" x="90" y="94" text-anchor="middle">${escape(money(total))}</text></svg>`;
}

/**
 * Mount the portable financial UI. No fetching, storage or app-global listeners.
 * @param {HTMLElement} host
 * @param {{data:object, selectedMonth:string, onSelectMonth?:function, onSelectCategory?:function}} options
 * @returns {{update:function, destroy:function}}
 */
export function createFinanceAnalytics(host, options) {
  if (!host || typeof host.replaceChildren !== 'function') throw new TypeError('A host element is required');
  const id = `finance-${++instanceCounter}`;
  let config = { ...options }, dataset = prepareDataset(config.data), destroyed = false, lastFocus = null;
  const state = { month: config.selectedMonth || dataset.coverage.to.slice(0,7), kind:'expense', allCategories:false, year:0, annualCompare:true, view:'month', anchor:'', selected:0, income:false, comparison:true, detailRows:[] };
  function syncMonth(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month + '-01' > dataset.coverage.to || monthEnd(month) < dataset.coverage.from) throw new RangeError('selectedMonth is outside coverage');
    state.month = month; state.year = +month.slice(0,4);
    const rows = dataset.transactions.filter(t => t.date.startsWith(month));
    state.anchor = rows.at(-1)?.date || month + '-01';
  }
  syncMonth(state.month);
  const root = document.createElement('div'); root.className = 'fa-widget';
  const main = document.createElement('div'); main.className = 'fa-main';
  const sheet = document.createElement('dialog'); sheet.className = 'fa-history-dialog'; sheet.setAttribute('aria-label','Menohistoria');
  const detail = document.createElement('dialog'); detail.className = 'fa-detail-dialog'; detail.setAttribute('aria-label','Tapahtumat');
  root.append(main, sheet, detail); host.replaceChildren(root);

  function breakdownCard() {
    const model = breakdown(dataset, state.month, state.kind);
    const showPercentages = config.showPercentages !== false;
    if (config.compactBreakdown) {
      const entries = model.entries.length <= 4 ? model.entries : [...model.entries.slice(0,3), {
        category: '__others', label: state.kind === 'expense' ? 'Muut menot' : 'Muut tulot',
        value: model.entries.slice(3).reduce((sum, entry) => sum + Math.round(entry.value * 100), 0) / 100,
        share: model.entries.slice(3).reduce((sum, entry) => sum + entry.share, 0),
      }];
      const categoryButton = (entry, index) => `<button type="button" data-fa="category" data-value="${escape(entry.category)}" aria-label="${escape(entry.label)}: ${escape(money(entry.value))}${showPercentages ? `, ${number(entry.share,1)} prosenttia` : ''}${entry.category === '__others' ? ', näytä kaikki kategoriat' : ', avaa tapahtumat'}"><i class="fa-dot" style="--swatch:${palette[index % palette.length]}"></i><span><span class="fa-compact-category">${escape(entry.label)}</span><strong>${money(entry.value)}</strong>${showPercentages ? `<small>${number(entry.share,1)} %</small>` : ''}</span></button>`;
      return `<section class="fa-section fa-compact-section" aria-label="Kuukauden tulojen ja menojen jakauma"><div class="fa-card fa-compact-breakdown"><div class="fa-segmented" role="group" aria-label="Jakauman sisältö">${[['expense','Menot'],['income','Tulot']].map(([kind,label])=>`<button type="button" data-fa="kind" data-value="${kind}" aria-pressed="${state.kind===kind}">${label}</button>`).join('')}</div><div class="fa-compact-visual">${halfDonut(entries, model.total, state.kind === 'expense' ? 'Menot yhteensä' : 'Tulot yhteensä')}<div class="fa-compact-legend">${entries.map(categoryButton).join('')}</div></div>${!model.total ? '<p class="fa-empty">Ei tapahtumia tässä ryhmässä.</p>' : ''}${model.entries.length > 4 ? `<button type="button" class="fa-text-button" data-fa="all-categories" aria-expanded="${state.allCategories}">${state.allCategories ? 'Piilota kategoriat' : 'Kaikki kategoriat'} ${chevron('down')}</button>${state.allCategories ? `<div class="fa-compact-expanded">${model.entries.map(categoryButton).join('')}</div>` : ''}` : ''}</div></section>`;
    }
    const entries = state.allCategories || model.entries.length <= 5 ? model.entries : [...model.entries.slice(0,4), { category:'__others', label:'Muut menot', value:model.entries.slice(4).reduce((n,e)=>n+e.value,0), share:model.entries.slice(4).reduce((n,e)=>n+e.share,0) }];
    return `<section class="fa-section"><div class="fa-section-heading"><h2>Mistä taloutesi koostuu?</h2><span>${monthLabel(state.month)}</span></div><div class="fa-card fa-breakdown-card">
      <div class="fa-segmented" role="group" aria-label="Jakauman sisältö">${[['expense','Menot'],['income','Tulot']].map(([kind,label])=>`<button type="button" data-fa="kind" data-value="${kind}" aria-pressed="${state.kind===kind}">${label}</button>`).join('')}</div>
      ${donut(entries,model.total,state.kind==='expense'?'Kuukauden menot':'Kuukauden tulot')}
      ${model.total ? `<div class="fa-ring-legend">${entries.map((e,i)=>`<button type="button" data-fa="category" data-value="${escape(e.category)}"><span class="fa-dot" style="--swatch:${palette[i%palette.length]}"></span><span class="fa-category-name">${escape(e.label)}${showPercentages ? `<small>${number(e.share,1)} %</small>` : ''}</span><strong>${money(e.value)}</strong>${chevron('right')}</button>`).join('')}</div>` : '<p class="fa-empty">Ei tapahtumia tässä ryhmässä.</p>'}
      ${model.entries.length>5?`<button type="button" class="fa-text-button" data-fa="all-categories">${state.allCategories?'Näytä tiivistelmä':'Näytä kaikki kategoriat'}</button>`:''}
    </div></section>`;
  }
  function annualCard() {
    const model = annualSpending(dataset,state.year);
    const bins = model.months.map(m=>({...m,comparison:m.previous.spending}));
    const available = model.months.filter(m=>m.available);
    const selected = state.year===+state.month.slice(0,4)?+state.month.slice(5)-1:-1;
    return `<section class="fa-section"><div class="fa-section-heading"><h2>Menot vuoden varrella</h2></div><div class="fa-card fa-annual-card">
      <div class="fa-period-nav"><button type="button" class="fa-icon-button" data-fa="year-prev" aria-label="Edellinen vuosi" ${state.year<=+dataset.coverage.from.slice(0,4)?'disabled':''}>${chevron('left')}</button><h3>${state.year}</h3><button type="button" class="fa-icon-button" data-fa="year-next" aria-label="Seuraava vuosi" ${state.year>=+dataset.coverage.to.slice(0,4)?'disabled':''}>${chevron('right')}</button></div>
      <div class="fa-year-total"><strong>${money(model.currentTotal)}</strong><span>${available.length ? dateLabel(available[0].start)+'–'+dateLabel(available.at(-1).end) : 'Ei aineistoa'}</span></div>
      <div class="fa-chart-wrap">${plot({bins,comparison:state.annualCompare,selected,annual:true,patternId:id+'-pattern'})}<div class="fa-chart-hits" style="--count:12">${bins.map(b=>`<button type="button" data-fa="month" data-value="${b.key}" aria-label="${monthLabel(b.key)}: ${money(b.spending)}${b.available?', avaa kuukausi':''}" ${b.available?'':'disabled'}></button>`).join('')}</div></div>
      <div class="fa-chart-legend"><span><i class="fa-dot" style="--swatch:var(--fa-green)"></i>Menot ${state.year}</span><button type="button" data-fa="annual-compare" aria-pressed="${state.annualCompare}"><i class="fa-dot fa-striped"></i>${state.year-1}${state.annualCompare?' ✓':''}</button></div>
      <p class="fa-chart-hint">Valitse kuukausi pylväästä. – = ei aineistoa.</p>
      ${model.change!==null?`<p class="fa-year-comparison"><b>${model.change>0?'+':''}${number(model.change,1)} %</b> edellisen vuoden samoihin ${model.comparableMonths} kuukauteen verrattuna.</p>`:'<p class="fa-chart-hint">Vuosivertailuun ei ole riittävästi yhteistä aineistoa.</p>'}
      <details class="fa-data-table"><summary>Näytä luvut taulukkona</summary><table><caption>Menot euroina, kalenterikuukausittain</caption><thead><tr><th>Kuukausi</th><th>${state.year}</th><th>${state.year-1}</th></tr></thead><tbody>${bins.map((b,i)=>`<tr><th>${monthShort()[i]}</th><td>${money(b.spending)}</td><td>${money(b.comparison)}</td></tr>`).join('')}</tbody></table></details>
    </div></section>`;
  }
  function historyLauncher() {
    return `<button type="button" class="fa-history-launcher" data-fa="history">${chartIcon}<span><strong>Menohistoria</strong><small>Päivästä vuoteen. Tutki omia menojasi.</small></span>${chevron('right')}</button>`;
  }
  function rhythmCard() {
    const { current, previous, previousMonth, change } = spendingRhythm(dataset,state.month);
    const share = current.shares[0], previousShare = previous.shares[0];
    const shareText = value=>value===null?'–':`${number(value)} %`;
    return `<section class="fa-section"><div class="fa-section-heading"><h2>Arki vai viikonloppu?</h2><span>${monthLabel(state.month)}</span></div><div class="fa-card fa-rhythm-card">
      <p>Mihin aikaan viikosta rahasi kuluvat?</p><div class="fa-split-labels"><div><strong>${shareText(share)}</strong><span>Arki <small>ma–pe</small></span></div><div><strong>${shareText(current.shares[1])}</strong><span>Viikonloppu <small>la–su</small></span></div></div>
      <div class="fa-split-bar ${share===null?'fa-split-empty':''}" role="img" aria-label="Arki ${shareText(share)}, viikonloppu ${shareText(current.shares[1])}"><i style="width:${share??0}%"></i></div>
      ${previous.complete&&previousShare!==null?`<div class="fa-split-bar fa-previous-split" role="img" aria-label="Edellinen kuukausi: arki ${shareText(previousShare)}, viikonloppu ${shareText(previous.shares[1])}"><i style="width:${previousShare}%"></i><b style="left:${previousShare}%"></b></div><p class="fa-split-reference">${monthLabel(previousMonth)} <strong>${shareText(previousShare)} / ${shareText(previous.shares[1])}</strong></p>`:'<p class="fa-chart-hint">Edellisen kuukauden vertailua ei ole saatavilla.</p>'}
      <div class="fa-daily-averages"><div><span>Arkipäivä keskimäärin</span><strong>${money(current.daily[0])}</strong></div><div><span>Viikonlopun päivä</span><strong>${money(current.daily[1])}</strong></div></div>
      ${change!==null?`<div class="fa-rhythm-insight"><strong>${change>0?'+':''}${number(change,1)} %</strong><p>Viikonloppuihin osuvat menot ${change<0?'laskivat':change>0?'kasvoivat':'pysyivät ennallaan'} edellisestä kuukaudesta.</p></div>`:'<p class="fa-chart-hint">Prosenttimuutosta ei lasketa ilman vertailukelpoista, nollaa suurempaa aiempaa summaa.</p>'}
      <details class="fa-method"><summary>Mihin vertailu perustuu?</summary><p>Vertailu on omiin menoihisi edellisessä kuussa. Osuudet kuvaavat käytettyjä euroja, eivät ostosten määrää. Arkipäiviä on ${current.days[0]} ja viikonlopun päiviä ${current.days[1]}; päiväkohtainen keskiarvo huomioi tämän. Myös laskut sisältyvät maksupäivänsä mukaan. Siirrot ja sijoitukset eivät sisälly menoihin.</p></details>
    </div></section>`;
  }
  function render() {
    const sections = { breakdown: breakdownCard, annual: annualCard, history: historyLauncher, rhythm: rhythmCard };
    main.innerHTML = (config.sections || Object.keys(sections)).map(name => sections[name]?.() || '').join('');
  }
  function currentSeries() { return historySeries(dataset,state.anchor,state.view); }
  function selectAnchor(series) {
    let index=series.bins.findIndex(b=>state.anchor>=b.from&&state.anchor<=b.to);
    if(state.view==='day') index=series.bins.findLastIndex(b=>b.rows.some(t=>t.kind!=='transfer'));
    state.selected=Math.max(0,index);
  }
  function renderHistory() {
    const series=currentSeries(), bin=series.bins[state.selected]||series.bins[0]; state.selected=Math.min(state.selected,series.bins.length-1);
    const availableRows=bin.rows.filter(t=>t.kind!=='transfer');
    sheet.innerHTML=`<header class="fa-sheet-heading">${chartIcon}<h2>Menohistoria</h2><button type="button" class="fa-icon-button" data-fa="close-history" aria-label="Sulje menohistoria">×</button></header><div class="fa-sheet-body">
      <div class="fa-period-nav"><button type="button" class="fa-icon-button" data-fa="history-prev" aria-label="Edellinen ajanjakso" ${canShift(dataset,state.anchor,state.view,-1)?'':'disabled'}>${chevron('left')}</button><h3>${periodTitle(series)}</h3><button type="button" class="fa-icon-button" data-fa="history-next" aria-label="Seuraava ajanjakso" ${canShift(dataset,state.anchor,state.view,1)?'':'disabled'}>${chevron('right')}</button></div>
      <div class="fa-period-tabs" role="group" aria-label="Aikaväli">${[['day','Päivä'],['week','Viikko'],['month','Kuukausi'],['year','Vuosi'],['years','Vuodet']].map(([view,label])=>`<button type="button" data-fa="view" data-value="${view}" aria-pressed="${state.view===view}">${label}</button>`).join('')}</div>
      <div class="fa-history-summary"><span>Menot yhteensä<strong>${money(series.spending)}</strong></span><span>Päiviltä<small>${dateLabel(series.start)}–${dateLabel(series.end)}</small></span></div>
      <div class="fa-history-toggles"><span><i class="fa-dot" style="--swatch:var(--fa-green)"></i>Menot</span><label><input type="checkbox" data-fa="income" ${state.income?'checked':''}>Tulot</label><label><input type="checkbox" data-fa="comparison" ${state.comparison?'checked':''} ${state.view==='years'?'disabled':''}>Edellinen jakso</label></div>
      <div class="fa-chart-wrap">${plot({bins:series.bins,comparison:state.comparison&&state.view!=='years',income:state.income,selected:state.selected})}<div class="fa-chart-hits" style="--count:${series.bins.length}">${series.bins.map((b,i)=>`<button type="button" data-fa="point" data-value="${i}" aria-label="${escape(binTitle(b,state.view))}: ${money(b.spending)}" tabindex="-1"></button>`).join('')}</div></div>
      <label class="fa-scrubber-label" for="${id}-point">Valitse ${state.view==='day'?'tunti':state.view==='year'?'kuukausi':state.view==='years'?'vuosi':'päivä'}</label><input id="${id}-point" class="fa-scrubber" data-fa="scrub" type="range" min="0" max="${series.bins.length-1}" step="1" value="${state.selected}" aria-valuetext="${escape(binTitle(bin,state.view))}">
      <div class="fa-selected-period" aria-live="polite"><h3>${escape(binTitle(bin,state.view))}${bin.available&&!bin.complete?' · osittainen':''}</h3><div class="fa-value-chips"><span class="fa-expense-chip">Menot <b>${money(bin.spending)}</b></span>${state.income?`<span class="fa-income-chip">Tulot <b>${money(bin.income)}</b></span>`:''}${state.comparison&&state.view!=='years'?`<span class="fa-previous-chip">Edellinen <b>${money(bin.comparison)}</b></span>`:''}</div><button type="button" class="fa-text-button" data-fa="point-transactions" ${!availableRows.length?'disabled':''}>${availableRows.length} ${availableRows.length===1?'tapahtuma':'tapahtumaa'} ${chevron('right')}</button></div>
      <p class="fa-chart-hint">${state.view==='day'?'Tunnit perustuvat aineiston kirjattuun kellonaikaan.':state.view==='month'?'Vertailu kohdistuu edellisen kuukauden samaan päivänumeroon.':state.view==='week'?'Vertailu kohdistuu edellisen viikon samaan viikonpäivään.':state.view==='year'?'Vertailu kohdistuu edellisen vuoden samaan kuukauteen.':'Osittaiset vuodet sisältävät vain aineiston kattamat päivät.'} Puuttuva jakso ei ole nolla. Siirrot ja sijoitukset on rajattu pois.</p>
      <details class="fa-data-table"><summary>Näytä luvut taulukkona</summary><table><caption>Menot ja tulot euroina</caption><thead><tr><th>Jakso</th><th>Menot</th><th>Tulot</th></tr></thead><tbody>${series.bins.map(b=>`<tr><th>${escape(binTitle(b,state.view))}</th><td>${money(b.spending)}</td><td>${money(b.income)}</td></tr>`).join('')}</tbody></table></details>
    </div>`;
  }
  function openTransactions(rows,title) {
    detail.innerHTML=`<header class="fa-sheet-heading"><h2>${escape(title)}</h2><button type="button" class="fa-icon-button" data-fa="close-detail" aria-label="Sulje tapahtumat">×</button></header><div class="fa-sheet-body"><p class="fa-chart-hint">${rows.length} ${rows.length===1?'tapahtuma':'tapahtumaa'}</p>${[...rows].reverse().map(t=>`<div class="fa-transaction"><span>${escape(t.label)}<small>${dateLabel(t.date)}${t.time?' · '+escape(t.time.slice(0,5)):''}${t.merchant?' · '+escape(t.merchant):''}</small></span><strong>${money(t.amount)}</strong></div>`).join('')}</div>`;
    detail.showModal();
  }
  function preserveFocus(action, value) { const target=[...root.querySelectorAll('[data-fa]')].find(el=>el.dataset.fa===action&&(value===undefined||el.dataset.value===value)); target?.focus({preventScroll:true}); }
  function click(event) {
    const button=event.target.closest('button[data-fa]'); if(!button||!root.contains(button)||button.disabled)return;
    const action=button.dataset.fa, value=button.dataset.value;
    if(action==='kind') { state.kind=value; state.allCategories=false; render(); }
    if(action==='all-categories'||(action==='category'&&value==='__others')) { state.allCategories=!state.allCategories; render(); }
    if(action==='category'&&value!=='__others') {
      if(config.onSelectCategory) config.onSelectCategory(value);
      else { const rows=breakdown(dataset,state.month,state.kind).rows.filter(t=>t.category===value&&t.kind===state.kind); openTransactions(rows,rows[0]?.label||value); }
    }
    if(action==='year-prev'||action==='year-next') { state.year+=action==='year-prev'?-1:1; render(); }
    if(action==='annual-compare') { state.annualCompare=!state.annualCompare; render(); }
    if(action==='month') { syncMonth(value); render(); config.onSelectMonth?.(value); }
    if(action==='history') { lastFocus=button; selectAnchor(currentSeries()); renderHistory(); sheet.showModal(); }
    if(action==='close-history') sheet.close();
    if(action==='close-detail') detail.close();
    if(action==='history-prev'||action==='history-next') { state.anchor=shiftAnchor(state.anchor,state.view,action==='history-prev'?-1:1); selectAnchor(currentSeries()); renderHistory(); }
    if(action==='view') { state.view=value; selectAnchor(currentSeries()); renderHistory(); }
    if(action==='point') { state.selected=+value; const bin=currentSeries().bins[state.selected]; if(bin.available)state.anchor=bin.start||bin.from; renderHistory(); }
    if(action==='point-transactions') { const bin=currentSeries().bins[state.selected]; openTransactions(bin.rows.filter(t=>t.kind!=='transfer'),binTitle(bin,state.view)); }
    if(!['history','category','point-transactions','close-detail','close-history','month'].includes(action)) preserveFocus(action,value);
  }
  function input(event) {
    if(event.target.dataset.fa!=='scrub')return;
    state.selected=+event.target.value;
    // Keep the range element alive during a drag; update the neighbouring chart/details only.
    const series=currentSeries(), bin=series.bins[state.selected];
    if(bin.available)state.anchor=bin.start||bin.from;
    event.target.setAttribute('aria-valuetext',binTitle(bin,state.view));
    sheet.querySelector('.fa-plot').outerHTML=plot({bins:series.bins,comparison:state.comparison&&state.view!=='years',income:state.income,selected:state.selected});
    const count=bin.rows.filter(t=>t.kind!=='transfer').length;
    sheet.querySelector('.fa-selected-period').innerHTML=`<h3>${escape(binTitle(bin,state.view))}${bin.available&&!bin.complete?' · osittainen':''}</h3><div class="fa-value-chips"><span class="fa-expense-chip">Menot <b>${money(bin.spending)}</b></span>${state.income?`<span class="fa-income-chip">Tulot <b>${money(bin.income)}</b></span>`:''}${state.comparison&&state.view!=='years'?`<span class="fa-previous-chip">Edellinen <b>${money(bin.comparison)}</b></span>`:''}</div><button type="button" class="fa-text-button" data-fa="point-transactions" ${count?'':'disabled'}>${count} ${count===1?'tapahtuma':'tapahtumaa'} ${chevron('right')}</button>`;
  }
  function change(event) {
    if(!['income','comparison'].includes(event.target.dataset.fa))return;
    const key=event.target.dataset.fa; state[key]=event.target.checked; renderHistory(); preserveFocus(key);
  }
  function closeHistory() { lastFocus?.isConnected&&lastFocus.focus({preventScroll:true}); }
  function backdrop(event) { if(event.target!==sheet&&event.target!==detail)return; const r=event.target.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close(); }
  root.addEventListener('click',click); root.addEventListener('input',input); root.addEventListener('change',change); root.addEventListener('click',backdrop); sheet.addEventListener('close',closeHistory);
  render();
  return {
    update(next={}) { if(destroyed)return; config={...config,...next}; if(next.data)dataset=prepareDataset(next.data); if(next.selectedMonth||next.data)syncMonth(next.selectedMonth||state.month); render(); if(sheet.open){selectAnchor(currentSeries());renderHistory();} },
    destroy() { if(destroyed)return; destroyed=true; sheet.close();detail.close();root.removeEventListener('click',click);root.removeEventListener('input',input);root.removeEventListener('change',change);root.removeEventListener('click',backdrop);sheet.removeEventListener('close',closeHistory);root.remove(); },
  };
}
