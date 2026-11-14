import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepareDataset, periodStats, breakdown, annualSpending, spendingRhythm, historySeries, canShift, shiftAnchor, percentChange } from '../public/finance-analytics/model.js';
import { projectFinanceData } from '../public/adapters/project-finance.js';
import { metrics } from '../public/model.js';

const raw = JSON.parse(fs.readFileSync(new URL('../public/demo-data.json',import.meta.url)));
const near=(a,b)=>assert.ok(Math.abs(a-b)<.00001,`${a} != ${b}`);
const fixture=prepareDataset({coverage:{from:'2024-01-01',to:'2024-03-31'},transactions:[
  {date:'2024-02-01',time:'08:00:00',category:'Salary',kind:'income',amount:1000},
  {date:'2024-02-02',time:'09:00:00',category:'Food',kind:'expense',amount:-30},
  {date:'2024-02-03',time:'23:10:00',category:'Food',kind:'expense',amount:-20},
  {date:'2024-02-04',category:'Fun',kind:'expense',amount:-10},
  {date:'2024-02-29',time:'12:00:00',category:'Food',kind:'expense',amount:-40},
  {date:'2024-02-29',time:'12:00:00',category:'Savings',kind:'transfer',amount:-900},
]});

test('portable adapter reconciles charts with existing monthly totals across the full sample',()=>{
  for(const profile of raw.profiles){
    const dataset=prepareDataset(projectFinanceData(profile,raw.summary));
    const months=[...new Set(profile.transactions.map(t=>t.date.slice(0,7)))];
    for(const month of months){
      const baseline=metrics(profile,month), series=historySeries(dataset,month+'-15','month');
      near(series.spending,baseline.spending);near(series.income,baseline.income);
      near(series.bins.reduce((n,b)=>n+b.spending,0),baseline.spending);
      near(breakdown(dataset,month).entries.reduce((n,e)=>n+e.value,0),baseline.spending);
      near(breakdown(dataset,month,'income').total,baseline.income);
    }
  }
});

test('refunds and income reversals share one summary/chart policy and still reconcile cash flow',()=>{
  const profile={transactions:[
    {date:'2024-02-01',category:'Salary',amount:1000,balance:1000,account:'A'},
    {date:'2024-02-02',category:'Salary',amount:-100,balance:900,account:'A'},
    {date:'2024-02-03',category:'Groceries',amount:-20,balance:880,account:'A'},
    {date:'2024-02-04',category:'Groceries',amount:5,balance:885,account:'A'},
  ]};
  const summary=metrics(profile,'2024-02');
  const dataset=prepareDataset(projectFinanceData(profile,{from:'2024-02-01',to:'2024-02-29'}));
  assert.equal(summary.income,1000);
  assert.equal(summary.spending,20);
  assert.equal(summary.otherFlow,-95);
  assert.equal(summary.margin+summary.otherFlow,summary.netFlow);
  assert.equal(breakdown(dataset,'2024-02','income').total,summary.income);
  assert.equal(breakdown(dataset,'2024-02','expense').total,summary.spending);
});

test('unknown hours are retained and transfers never enter the spending chart',()=>{
  const unknown=historySeries(fixture,'2024-02-04','day');
  assert.equal(unknown.bins.length,25);assert.equal(unknown.bins[24].label,'Ei aikaa');near(unknown.bins[24].spending,10);
  const leapDay=historySeries(fixture,'2024-02-29','day');
  near(leapDay.spending,40);near(leapDay.bins.reduce((n,b)=>n+b.spending,0),40);
  assert.equal(leapDay.bins.length,24);
});

test('malformed timestamps stay in the unknown-time bucket',()=>{
  const dataset=prepareDataset({coverage:{from:'2024-02-01',to:'2024-02-01'},transactions:
    ['10:30:99','10:30:00garbage','10:30','24:00:00','09:15:00'].map(time=>({date:'2024-02-01',time,amount:-1,kind:'expense',category:'Food'}))});
  const series=historySeries(dataset,'2024-02-01','day');
  assert.equal(series.bins[9].spending,1);
  assert.equal(series.bins[24].spending,4);
  assert.equal(series.spending,5);
});

test('week boundaries are Monday–Sunday and month history includes leap day',()=>{
  const week=historySeries(fixture,'2024-02-04','week');
  assert.equal(week.from,'2024-01-29');assert.equal(week.to,'2024-02-04');near(week.spending,60);
  const month=historySeries(fixture,'2024-02-15','month');assert.equal(month.bins.length,29);near(month.spending,100);
  const march=historySeries(fixture,'2024-03-31','month');assert.equal(march.bins[30].comparison,null);assert.equal(march.bins[28].comparison,40);
});

test('missing periods differ from covered zero-spending periods',()=>{
  assert.equal(periodStats(fixture,'2024-04-01','2024-04-30').spending,null);
  assert.equal(periodStats(fixture,'2024-01-01','2024-01-31').spending,0);
  assert.equal(historySeries(fixture,'2024-01-15','month').bins[0].comparison,null);
  const partial=historySeries(fixture,'2024-03-31','week');assert.equal(partial.complete,true);
  const edge=historySeries(fixture,'2024-04-01','week');assert.equal(edge.available,false);
  assert.equal(canShift(fixture,'2024-03-01','month',1),false);
  assert.equal(canShift(fixture,'2024-01-01','month',-1),false);
  assert.equal(shiftAnchor('2024-01-31','month',1),'2024-02-01');
});

test('annual comparison matches covered months rather than full previous year',()=>{
  const dataset=prepareDataset(projectFinanceData(raw.profiles[0],raw.summary));
  const yearly=annualSpending(dataset,2026);
  assert.equal(yearly.comparableMonths,9);
  assert.equal(yearly.months[9].spending,null);
  const previousJanSep=dataset.transactions.filter(t=>t.date>='2025-01-01'&&t.date<='2025-09-30'&&t.kind==='expense').reduce((n,t)=>n-t.amount,0);
  near(yearly.previousTotal,previousJanSep);
  near(yearly.change,(yearly.currentTotal-previousJanSep)/previousJanSep*100);
  assert.equal(annualSpending(dataset,2024).comparableMonths,0);
  assert.equal(annualSpending(dataset,2024).change,null);
});

test('weekday/weekend split counts all calendar days and reconciles euros',()=>{
  const rhythm=spendingRhythm(fixture,'2024-02');
  assert.deepEqual(rhythm.current.days,[21,8]);
  assert.deepEqual(rhythm.current.amounts,[70,30]);
  assert.deepEqual(rhythm.current.shares,[70,30]);
  near(rhythm.current.daily[0],70/21);near(rhythm.current.daily[1],30/8);
  assert.equal(rhythm.change,null);assert.equal(percentChange(10,0),null);
  assert.deepEqual(spendingRhythm(fixture,'2024-01').current.shares,[null,null]);
});

test('partial years and every history aggregation preserve source totals',()=>{
  const dataset=prepareDataset(projectFinanceData(raw.profiles[0],raw.summary));
  const years=historySeries(dataset,'2026-09-15','years');
  assert.equal(years.bins.length,3);assert.equal(years.bins[0].complete,false);assert.equal(years.bins[1].complete,true);assert.equal(years.bins[2].complete,false);
  near(years.spending,years.bins.reduce((n,b)=>n+b.spending,0));
  const year=historySeries(dataset,'2026-09-15','year');near(year.spending,annualSpending(dataset,2026).currentTotal);
});

test('integration boundary rejects malformed dates, signs, nonfinite values and coverage',()=>{
  const one=t=>({coverage:{from:'2024-01-01',to:'2024-03-31'},transactions:[t]});
  assert.throws(()=>prepareDataset(one({date:'2024-02-30',amount:-1,kind:'expense'})),TypeError);
  assert.throws(()=>prepareDataset(one({date:'2024-02-01',amount:NaN,kind:'expense'})),TypeError);
  assert.throws(()=>prepareDataset(one({date:'2024-02-01',amount:1,kind:'expense'})),TypeError);
  assert.throws(()=>prepareDataset(one({date:'2024-04-01',amount:-1,kind:'expense'})),RangeError);
});
