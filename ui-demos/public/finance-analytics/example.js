import { createFinanceAnalytics } from './index.js';

const transactions=[];
for(let year=2025;year<=2026;year++)for(let month=1;month<=(year===2026?9:12);month++){
  const date=`${year}-${String(month).padStart(2,'0')}-01`;
  transactions.push({date,time:'09:00:00',amount:2400,kind:'income',category:'salary',label:'Palkka'},
    {date,time:'12:00:00',amount:-800,kind:'expense',category:'housing',label:'Asuminen'},
    {date:date.slice(0,8)+'05',time:'17:00:00',amount:-100-month*10,kind:'expense',category:'food',label:'Ruokaostokset'});
}
const data={coverage:{from:'2025-01-01',to:'2026-09-30'},transactions};
let widget;
function mount(){widget?.destroy();widget=createFinanceAnalytics(document.querySelector('#analytics'),{data,selectedMonth:'2026-09'});document.querySelector('#status').textContent='Mounted: September 2026';}
document.querySelector('#update').onclick=()=>{widget?.update({selectedMonth:'2026-08'});document.querySelector('#status').textContent='Updated: August 2026';};
document.querySelector('#destroy').onclick=()=>{widget?.destroy();document.querySelector('#status').textContent='Destroyed';};
document.querySelector('#mount').onclick=mount;
mount();
