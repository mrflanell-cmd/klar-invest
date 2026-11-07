'use strict';
const $=id=>document.getElementById(id);
let allRows=[], allTrades=[], allEvents=[], importInfo={}, filesLoaded=0;
const norm=x=>String(x??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const money=(n,cur='SEK')=>Number.isFinite(n)?n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+cur:'–';
const numeric=s=>{
  if(s===null||s===undefined)return null;
  let t=String(s).replace(/\u00a0/g,' ').replace(/\s/g,'').replace(/[−–]/g,'-');
  if(!t||t==='-')return null;
  t=t.replace(/[^0-9.,+\-]/g,'');
  if(t.includes(',')&&t.includes('.')){
    if(t.lastIndexOf(',')>t.lastIndexOf('.'))t=t.replace(/\./g,'').replace(',','.');
    else t=t.replace(/,/g,'');
  }else if(t.includes(','))t=t.replace(',','.');
  else if((t.match(/\./g)||[]).length>1)t=t.replace(/\./g,'');
  const n=Number(t);return Number.isFinite(n)?n:null;
};
const dateValue=raw=>{
 const s=String(raw??'').trim();let m;
 if((m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)))return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
 if((m=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/)))return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
 return '';
};
const validDay=s=>/^\d{4}-\d\d-\d\d$/.test(s);
function parseCSV(text){
 const raw=text.replace(/^\ufeff/,'');
 const probe=raw.split(/\r?\n/).slice(0,8).join('\n');
 const choice=[';',',','\t'].map(ch=>({ch,count:(probe.match(new RegExp(ch==='\t'?'\t':ch===';'?';':',','g'))||[]).length}));
 const delimiter=choice.sort((a,b)=>b.count-a.count)[0].ch;
 let rows=[],line=[],value='',inQuote=false;
 for(let i=0;i<raw.length;i++){
  const c=raw[i];
  if(c==='"'){
   if(inQuote&&raw[i+1]==='"'){value+='"';i++}else inQuote=!inQuote;
  }else if(c===delimiter&&!inQuote){line.push(value);value=''}
  else if((c==='\n'||c==='\r')&&!inQuote){
   if(c==='\r'&&raw[i+1]==='\n')i++;
   line.push(value);value='';
   if(line.some(x=>x.trim()))rows.push(line);
   line=[];
  }else value+=c;
 }
 if(value||line.length){line.push(value);if(line.some(x=>x.trim()))rows.push(line)}
 const headIndex=rows.findIndex(r=>r.some(c=>norm(c)==='datum')&&r.some(c=>norm(c).includes('transaktion')));
 if(headIndex<0)throw Error('Hittade inte Avanzas rubriker. Välj exporten för transaktioner (inte innehav).');
 const headers=rows[headIndex].map(norm);
 const index=names=>headers.findIndex(h=>names.some(n=>h===n||h.includes(n)));
 const mapping={
  date:index(['datum','affarsdag']),account:index(['konto']),type:index(['typavtransaktion','transaktionstyp']),
  name:index(['vardepapperbeskrivning','vardepapper','instrumentnamn']),quantity:index(['antal']),
  amount:index(['belopp']),fee:index(['courtage']),currency:index(['transaktionsvaluta','valuta']),
  securityCurrency:index(['instrumentvaluta']),isin:index(['isin']),price:index(['kurs']),exchange:index(['valutakurs'])
 };
 if(mapping.date<0||mapping.type<0||mapping.name<0||mapping.amount<0)throw Error('CSV saknar nödvändiga kolumner: Datum, Typ av transaktion, Värdepapper eller Belopp.');
 let output=[];
 for(let j=headIndex+1;j<rows.length;j++){
  const r=rows[j];
  const field=k=>mapping[k]>=0?String(r[mapping[k]]??'').trim():'';
  const date=dateValue(field('date'));
  if(!validDay(date))continue;
  const row={date,account:field('account')||'Konto',
    type:field('type'),name:field('name')||'Okänt värdepapper',
    quantity:numeric(field('quantity')),amount:numeric(field('amount')),
    price:numeric(field('price')),fee:numeric(field('fee')),
    currency:field('currency').toUpperCase()||'SEK', isin:field('isin'),
    instrumentCurrency:field('securityCurrency').toUpperCase(),
    exchange:numeric(field('exchange')),line:j+1};
  row.category=category(row.type);
  output.push(row);
 }
 if(!output.length)throw Error('Inga giltiga transaktionsdatum hittades i filen.');
 return {rows:output,mapping,headers,skipped:rows.length-(headIndex+1)-output.length};
}
function category(type){
 const t=norm(type);
 if(t==='kop'||t.startsWith('kop'))return 'buy';
 if(t==='salj'||t.startsWith('salj'))return 'sell';
 if(t.includes('utdelning'))return 'dividend';
 if(t.includes('insattning')||t.includes('insatt'))return 'deposit';
 if(t.includes('uttag'))return 'withdraw';
 if(t.includes('ranta'))return 'interest';
 if(t.includes('skatt'))return 'tax';
 if(t.includes('avgift')||t.includes('courtage'))return 'fee';
 return 'other';
}
function buildAnalysis(rows){
 // FIFO matching by account/security/transaction currency. Net cash amount already contains trade charges.
 const sorted=[...rows].sort((a,b)=>a.date.localeCompare(b.date)||a.line-b.line);
 const lots=new Map(), trades=[],events=[];
 let unmatchedQty=0,unmatchedSales=0,invalidAmounts=0,invalidQty=0;
 let purchased=0,sold=0;
 for(const row of sorted){
  if(row.category!=='buy'&&row.category!=='sell')continue;
  const qty=Math.abs(row.quantity??0);
  const amount=row.amount;
  if(qty<=0){invalidQty++;continue}
  if(amount===null){invalidAmounts++;continue}
  const id=row.account+'|'+(row.isin||norm(row.name))+'|'+row.currency;
  if(!lots.has(id))lots.set(id,[]);
  const queue=lots.get(id);
  if(row.category==='buy'){
   purchased++;
   const cost=(amount<0?Math.abs(amount):amount);
   queue.push({qty,unit:cost/qty,date:row.date,name:row.name});
  }else{
   sold++;
   const proceeds=Math.abs(amount);
   let remaining=qty;
   let matched=0,cost=0;
   while(remaining>1e-9&&queue.length){
    const lot=queue[0];
    const used=Math.min(remaining,lot.qty);
    matched+=used;cost+=used*lot.unit;
    remaining-=used;lot.qty-=used;
    if(lot.qty<1e-9)queue.shift();
   }
   if(remaining>1e-9){unmatchedQty+=remaining;unmatchedSales++}
   if(matched>0){
    const value=proceeds*(matched/qty);
    const pnl=value-cost;
    trades.push({date:row.date,name:row.name,account:row.account,currency:row.currency,qty:matched,pnl,cost,proceeds:value,partial:remaining>1e-9});
   }
  }
 }
 return {trades,unmatchedQty,unmatchedSales,invalidQty,invalidAmounts,purchased,sold,lots};
}
function within(date,period){
 if(period==='all')return true;
 const today=new Date(), iso=new Date().toISOString().slice(0,10);
 if(period==='2026-11')return date.startsWith('2026-11');
 if(period==='thisyear')return date.startsWith(String(today.getFullYear()));
 if(period==='last30'){const cutoff=new Date(today);cutoff.setDate(today.getDate()-30);return date>=cutoff.toISOString().slice(0,10)&&date<=iso}
 return true;
}
function metric(label,value,hint='',cls=''){
 const div=document.createElement('div');div.className='metric';
 const span=document.createElement('span');span.textContent=label;
 const strong=document.createElement('strong');strong.className=cls;strong.textContent=value;
 const small=document.createElement('small');small.textContent=hint;
 div.append(span,strong,small);return div;
}
function barsInto(id,items,format=value=>money(value),colorize=true){
 const holder=$(id);holder.replaceChildren();
 if(!items.length){holder.textContent='Inga beräkningsbara uppgifter.';return}
 const max=Math.max(1,...items.map(x=>Math.abs(x.value)));
 for(const item of items){
  const outer=document.createElement('div');outer.className='bar-row';
  const row=document.createElement('div');row.className='bar-label';
  const label=document.createElement('span');label.textContent=item.label;
  const val=document.createElement('strong');val.textContent=format(item.value);
  val.style.color=item.value<0?'#ff9ca4':'#39dcaa';
  row.append(label,val);
  const track=document.createElement('div');track.className='bar-track';
  const bar=document.createElement('div');bar.className='bar-value'+(colorize&&item.value<0?' loss':'');
  bar.style.width=Math.max(1,Math.round(Math.abs(item.value)/max*100))+'%';
  track.append(bar);outer.append(row,track);holder.append(outer);
 }
}
function fmtSigned(n,cur){return (n>0?'+':'')+money(n,cur)}
function grouped(records,key,extract){
 const map=new Map();
 for(const r of records)map.set(key(r),(map.get(key(r))||0)+extract(r));
 return [...map].map(([label,value])=>({label,value}));
}
function renderPlot(trades,unit){
 const svg=$('equity-plot');svg.replaceChildren();
 const sorted=[...trades].sort((a,b)=>a.date.localeCompare(b.date));
 let sum=0;const values=[0,...sorted.map(t=>sum+=t.pnl)];
 if(values.length<2){$('line-caption').textContent='Ingen beräkningsbar vinstkurva.';return}
 const min=Math.min(0,...values),max=Math.max(0,...values),span=Math.max(1,max-min);
 const X=i=>18+i/Math.max(1,values.length-1)*414;
 const Y=v=>168-(v-min)/span*144;
 const ns='http://www.w3.org/2000/svg';
 const grid=document.createElementNS(ns,'line');
 grid.setAttribute('x1','18');grid.setAttribute('x2','432');
 grid.setAttribute('y1',String(Y(0)));grid.setAttribute('y2',String(Y(0)));
 grid.setAttribute('stroke','#527289');grid.setAttribute('stroke-dasharray','4 4');svg.append(grid);
 const path=document.createElementNS(ns,'polyline');
 path.setAttribute('points',values.map((v,i)=>X(i)+','+Y(v)).join(' '));
 path.setAttribute('fill','none');path.setAttribute('stroke',sum>=0?'#38dca8':'#ff9aa4');
 path.setAttribute('stroke-width','3');path.setAttribute('stroke-linejoin','round');svg.append(path);
 $('line-caption').textContent='Från '+sorted[0].date+' till '+sorted.at(-1).date+
  ' · Slutvärde '+fmtSigned(sum,unit)+' · Endast realiserade, matchade avslut.';
}

// Extra insights: all metrics depend on matched sales from the currently selected period.
let calendarOffset=0,calendarTrades=[],calendarUnit='SEK';
function simpleCard(label,value,note,cls=''){return metric(label,value,note,cls)}
function calcStreak(records){
 const recordsSorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
 let wins=0,losses=0,bestWin=0,bestLoss=0;
 for(const r of recordsSorted){
  if(r.pnl>0){wins++;losses=0}else if(r.pnl<0){losses++;wins=0}else{wins=0;losses=0}
  bestWin=Math.max(bestWin,wins);bestLoss=Math.max(bestLoss,losses);
 }
 return {win:bestWin,loss:bestLoss};
}
function drawdownFromTrades(records){
 const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
 let equity=0,peak=0,worst=0,underwater=0,maxDays=0,lastPeakDate=null;
 for(const r of sorted){
  equity+=r.pnl;
  if(equity>=peak){peak=equity;underwater=0;lastPeakDate=r.date}
  else{
   worst=Math.max(worst,peak-equity);
   underwater++;
   maxDays=Math.max(maxDays,underwater);
  }
 }
 return {max:worst,underwaterTrades:maxDays}; // drawdown measured in currency units, not % of capital.
}
function renderAdvanced(trades,unit,mixed){
 const host=$('advanced-metrics');host.replaceChildren();
 const win=trades.filter(t=>t.pnl>0),lose=trades.filter(t=>t.pnl<0);
 const total=trades.reduce((s,t)=>s+t.pnl,0);
 const grossW=win.reduce((s,t)=>s+t.pnl,0);
 const grossL=Math.abs(lose.reduce((s,t)=>s+t.pnl,0));
 const totalRisk=trades.reduce((s,t)=>s+t.cost,0);
 const ratio=lose.length&&win.length?(grossW/win.length)/(grossL/lose.length):null;
 const streak=calcStreak(trades),dd=drawdownFromTrades(trades);
 const sorted=[...trades].sort((a,b)=>b.pnl-a.pnl);
 const largest=sorted[0]?.pnl||0;
 const bottom=sorted.at(-1)?.pnl||0;
 const mid=sorted.map(x=>x.pnl).sort((a,b)=>a-b);
 const median=mid.length?mid.length%2?mid[(mid.length-1)/2]:(mid[mid.length/2-1]+mid[mid.length/2])/2:null;
 const profitable=trades.length?win.length/trades.length:0;
 const currencyText=mixed?'Flera valutor':unit;
 const countSymbols=new Set(trades.map(t=>t.name)).size;
 const distinctDays=new Set(trades.map(t=>t.date)).size;
 const fields=[
 ['Förväntat snitt/avslut',mixed||!trades.length?'–':fmtSigned(total/trades.length,unit),'Historiskt medelvärde per matchad försäljning'],
 ['Medianavslut',mixed||median===null?'–':fmtSigned(median,unit),'Mittenvärdet, mindre känsligt för extrema affärer'],
 ['Största nedgång från vinsttopp',mixed?'–':money(dd.max,unit),'Max drawdown i realiserat ackumulerat resultat – ej portföljens %'],
 ['Vinstsvit',streak.win+' avslut','Längsta följden av positiva matchade försäljningar'],
 ['Förlustsvit',streak.loss+' avslut','Längsta följden av negativa matchade försäljningar'],
 ['Snittvinst / |snittförlust|',ratio===null||mixed?'–':ratio.toFixed(2)+'×','Hur stor en genomsnittsvinst är mot genomsnittsförlust'],
 ['Realiserat / matchad kostnad',!totalRisk||mixed?'–':(total/totalRisk*100).toFixed(2)+' %','Inte kontots avkastning; försäljningar med känd FIFO-kostnad'],
 ['Vinstgivande affärsrader',trades.length?(profitable*100).toFixed(1)+' %':'–','Andel matchade försäljningar med plus'],
 ['Bruttovinster',mixed?'–':money(grossW,unit),'Summan av positiva avslut'],
 ['Bruttoförluster',mixed?'–':money(-grossL,unit),'Summan av negativa avslut'],
 ['Antal olika aktier',String(countSymbols),'Unika namn i matchade försäljningar'],
 ['Aktiva avslutsdagar',String(distinctDays),'Datum med minst ett matchat avslut']
 ];
 for(let i=0;i<fields.length;i++){const [label,value,note]=fields[i];host.append(simpleCard(label,value,note,i===8?'green':i===9?'red':''))}
 $('advanced-note').textContent='Drawdown och sviter bygger på avslutens datum, inte intradagshandel eller öppna positioners värdeförändring. Vid blandade valutor visas inte summerade penningbelopp.';
 const hero=$('hero-message');
 hero.textContent=mixed?'Flera valutor upptäckta – vi håller dem åtskilda för korrekta slutsatser.':
  !trades.length?'Ingen matchad försäljning i den valda perioden.':
  total>=0?'Din matchade tradinghistorik visar ett positivt realiserat resultat under vald period.':
  'Din matchade tradinghistorik visar ett negativt realiserat resultat under vald period.';
 $('hero-trades').textContent=trades.length+' matchade avslut';
 $('hero-days').textContent=distinctDays+' avslutsdagar';
 $('hero-win').textContent=win.length+' vinster · '+lose.length+' förluster';
}
function renderDistribution(trades,mixed){
 const host=$('distribution');host.replaceChildren();
 const buckets=[
  {label:'Stora vinster (+500 eller mer)',predicate:v=>v>=500},
  {label:'Vinster +100 till +499',predicate:v=>v>=100&&v<500},
  {label:'Vinster 0 till +99',predicate:v=>v>0&&v<100},
  {label:'Nollresultat',predicate:v=>v===0},
  {label:'Förluster −1 till −99',predicate:v=>v<0&&v>-100},
  {label:'Förluster −100 till −499',predicate:v=>v<=-100&&v>-500},
  {label:'Stora förluster (−500 eller mer)',predicate:v=>v<=-500}
 ];
 if(mixed){
  host.textContent='Välj en enda redovisningsvaluta för beloppsfördelningen.';
  return;
 }
 for(const b of buckets){
  const count=trades.filter(t=>b.predicate(t.pnl)).length;
  const box=document.createElement('div');box.className='dist-item';
  const val=document.createElement('div');val.className='dist-num';val.textContent=count;
  const label=document.createElement('div');label.className='dist-label';
  label.textContent=b.label+(trades.length?' · '+(100*count/trades.length).toFixed(1)+' %':'');
  box.append(val,label);host.append(box);
 }
}
function renderLeaders(trades,unit,mixed){
 for(const [target,descending] of [['top-wins',true],['top-losses',false]]){
  const holder=$(target);holder.replaceChildren();
  if(mixed){holder.textContent='Blandade valutor: filtrera till en valuta för jämförbara belopp.';continue}
  const pool=trades.filter(t=>descending?t.pnl>0:t.pnl<0);
  const sorted=[...pool].sort((a,b)=>descending?b.pnl-a.pnl:a.pnl-b.pnl).slice(0,10);
  if(!sorted.length){holder.textContent='Inga sådana avslut i perioden.';continue}
  for(const t of sorted){
   const row=document.createElement('div');row.className='leader-item';
   const left=document.createElement('span');
   left.textContent=t.name+' · '+t.date;
   const right=document.createElement('b');
   right.textContent=fmtSigned(t.pnl,unit);
   right.style.color=descending?'#45e4ae':'#ff9ca4';
   row.append(left,right);holder.append(row);
  }
 }
}
function renderBonus(trades,events,unit,mixed){
 const host=$('bonus-metrics');host.replaceChildren();
 const days=grouped(trades,t=>t.date,t=>t.pnl);
 const bestDay=!mixed&&days.length?[...days].sort((a,b)=>b.value-a.value)[0]:null;
 const worstDay=!mixed&&days.length?[...days].sort((a,b)=>a.value-b.value)[0]:null;
 const weekdays=['sön','mån','tis','ons','tor','fre','lör'];
 const dateDay=d=>weekdays[new Date(d+'T12:00:00Z').getUTCDay()];
 const byDay=grouped(trades,t=>dateDay(t.date),()=>1).sort((a,b)=>b.value-a.value);
 const biggestCount=byDay[0];
 const highestQty=trades.length?Math.max(...trades.map(t=>t.qty)):0;
 const names=new Map();
 for(const t of trades)names.set(t.name,(names.get(t.name)||0)+1);
 const mostFrequent=[...names].sort((a,b)=>b[1]-a[1])[0];
 const first=trades.length?[...trades].sort((a,b)=>a.date.localeCompare(b.date))[0]:null;
 const last=trades.length?[...trades].sort((a,b)=>b.date.localeCompare(a.date))[0]:null;
 const values=[
  ['Bästa dagen',bestDay?fmtSigned(bestDay.value,unit):'–',bestDay?.label||''],
  ['Tyngsta dagen',worstDay?fmtSigned(worstDay.value,unit):'–',worstDay?.label||''],
  ['Flest avslut på veckodag',biggestCount?biggestCount.label:'–',biggestCount?biggestCount.value+' stycken':''],
  ['Mest handlad aktie',mostFrequent?.[0]||'–',mostFrequent?mostFrequent[1]+' matchade säljrader':''],
  ['Största matchade antal',highestQty.toLocaleString('sv-SE'),'Aktier/andelar i en försäljning'],
  ['Första matchade avslut',first?.date||'–','I vald period'],
  ['Senaste matchade avslut',last?.date||'–','I vald period'],
  ['Handelsintensitet',days.length?(trades.length/days.length).toFixed(1):'–','Matchade avslut per aktiv avslutsdag']
 ];
 for(const [label,value,note] of values)host.append(simpleCard(label,value,note));
}
function initCalendar(){
 $('cal-prev').addEventListener('click',()=>{calendarOffset--;paintCalendar()});
 $('cal-next').addEventListener('click',()=>{calendarOffset++;paintCalendar()});
}
function paintCalendar(){
 const host=$('heatmap');host.replaceChildren();
 const today=new Date();
 const anchor=new Date(Date.UTC(today.getFullYear(),today.getMonth()+calendarOffset,1));
 const yr=anchor.getUTCFullYear(),mo=anchor.getUTCMonth();
 $('cal-month').textContent=new Intl.DateTimeFormat('sv-SE',{month:'long',year:'numeric',timeZone:'UTC'}).format(anchor);
 const weekdayNames=['M','T','O','T','F','L','S'];
 for(const n of weekdayNames){const h=document.createElement('div');h.className='heat-head';h.textContent=n;host.append(h)}
 const firstWeekday=(anchor.getUTCDay()+6)%7;
 for(let i=0;i<firstWeekday;i++){const empty=document.createElement('div');empty.className='heat-day out';host.append(empty)}
 const daysInMonth=new Date(Date.UTC(yr,mo+1,0)).getUTCDate();
 const key=d=>yr+'-'+String(mo+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
 const groupedDays=new Map();
 for(const t of calendarTrades){
  const r=groupedDays.get(t.date)||{pnl:0,count:0};
  r.pnl+=t.pnl;r.count++;
  groupedDays.set(t.date,r);
 }
 const amounts=[...groupedDays.values()].map(v=>Math.abs(v.pnl)).sort((a,b)=>a-b);
 const threshold=amounts[Math.floor(amounts.length*.7)]||1;
 for(let day=1;day<=daysInMonth;day++){
  const date=key(day),result=groupedDays.get(date);
  const btn=document.createElement('button');btn.type='button';btn.textContent=day;
  btn.className='heat-day '+(!result?'none':result.pnl>=0?(result.pnl>threshold?'bigwin':'win'):(Math.abs(result.pnl)>threshold?'bigloss':'loss'));
  btn.style.margin='0';btn.style.width='100%';btn.style.padding='0';
  btn.setAttribute('aria-label',date+(result?' '+money(result.pnl,calendarUnit):' inga matchade avslut'));
  btn.addEventListener('click',()=>{
   $('cal-details').textContent=result?date+': '+fmtSigned(result.pnl,calendarUnit)+' · '+result.count+' matchade avslut.':
     date+': Inga matchade avslut i importerad data.';
  });host.append(btn);
 }
}
initCalendar();

let weekTrades=[],weekCurrenciesMixed=false,weekCurrency='SEK';
function dateUTC(s){return new Date(s+'T12:00:00Z')}
function isoDay(d){return d.toISOString().slice(0,10)}
function startOfWeek(d){
 const x=new Date(d.getTime());
 const day=x.getUTCDay();
 x.setUTCDate(x.getUTCDate() - ((day+6)%7));
 return x;
}
function weekNumber(monday){
 const d=new Date(Date.UTC(monday.getUTCFullYear(),monday.getUTCMonth(),monday.getUTCDate()));
 d.setUTCDate(d.getUTCDate()+3);
 const weekYear=d.getUTCFullYear();
 const firstThursday=new Date(Date.UTC(weekYear,0,4));
 firstThursday.setUTCDate(firstThursday.getUTCDate()-((firstThursday.getUTCDay()+6)%7));
 return {week:1+Math.round((d-firstThursday)/604800000),year:weekYear};
}
function formatWeekDay(d){
 return new Intl.DateTimeFormat('sv-SE',{timeZone:'UTC',day:'numeric',month:'short'}).format(d);
}
function renderWeekly(trades,currency,mixed){
 const host=$('weekly-cards');host.replaceChildren();
 if(!trades.length){
  $('weekly-summary').textContent='Inga matchade försäljningar i vald period. Veckokorten visas så snart det finns resultat.';
 }else if(mixed){
  $('weekly-summary').textContent='Flera valutor i dessa affärer: vi visar antal avslut, men summerar inte SEK och USD utan valutakurs.';
 }else{
  $('weekly-summary').textContent='Varje veckosumma bygger på matchade försäljningar i den importerade filen. Insättningar räknas inte som vinst.';
 }
 const n=Number($('week-count').value)||6;
 // Anchor on most recent sale week within selected period. This avoids a wall of empty weeks for historical exports.
 const latest=trades.length?[...trades].sort((a,b)=>b.date.localeCompare(a.date))[0].date:null;
 const anchor=startOfWeek(latest?dateUTC(latest):dateUTC(new Date().toISOString().slice(0,10)));
 const weeks=[];
 for(let i=0;i<n;i++){
  const monday=new Date(anchor);monday.setUTCDate(anchor.getUTCDate()-7*i);
  const sunday=new Date(monday);sunday.setUTCDate(monday.getUTCDate()+6);
  const start=isoDay(monday),end=isoDay(sunday);
  const records=trades.filter(t=>t.date>=start&&t.date<=end);
  const pnl=records.reduce((total,t)=>total+t.pnl,0);
  const wins=records.filter(t=>t.pnl>0).length;
  const losses=records.filter(t=>t.pnl<0).length;
  const winRate=records.length?wins/records.length*100:0;
  weeks.push({monday,start,end,records,pnl,wins,losses,winRate});
 }
 const available=weeks.filter(w=>w.records.length);
 const summaryWon=available.filter(w=>w.pnl>0).length;
 const summaryLost=available.filter(w=>w.pnl<0).length;
 const summaryDeals=available.reduce((sum,w)=>sum+w.records.length,0);
 if(!mixed&&available.length){
  const total=weeks.reduce((sum,w)=>sum+w.pnl,0);
  $('weekly-summary').textContent='Senaste '+n+' veckorna fram till sista matchade avslutet: '+
      fmtSigned(total,currency)+' · '+summaryDeals+' avslut · '+summaryWon+' plusveckor · '+summaryLost+' minusveckor.';
 }
 const max=Math.max(1,...weeks.map(w=>Math.abs(w.pnl)));
 const fmtResult=v=>mixed?'—':fmtSigned(v,currency);
 for(const w of weeks){
  const iso=weekNumber(w.monday);
  const card=document.createElement('article');
  card.className='week-card '+(mixed||!w.records.length?'empty':w.pnl>=0?'positive':'negative');
  const head=document.createElement('div');head.className='week-top';
  const titleBox=document.createElement('div');
  const title=document.createElement('div');title.className='week-title';title.textContent='Vecka '+iso.week+' · '+iso.year;
  const range=document.createElement('div');range.className='week-range';range.textContent=formatWeekDay(w.monday)+' – '+formatWeekDay(dateUTC(w.end));
  titleBox.append(title,range);
  const amount=document.createElement('div');amount.className='week-value '+(!mixed&&w.pnl>0?'positive':!mixed&&w.pnl<0?'negative':'');
  amount.textContent=w.records.length?fmtResult(w.pnl):'Inga avslut';
  head.append(titleBox,amount);card.append(head);
  const row=document.createElement('div');row.className='week-stats';
  const stats=[
   w.records.length+' avslut',
   w.wins+' vinster / '+w.losses+' förluster',
   w.records.length?(w.winRate.toFixed(0)+' % träffar'):'Ingen träffprocent'
  ];
  for(const v of stats){const badge=document.createElement('span');badge.textContent=v;row.append(badge)}
  card.append(row);
  const days=document.createElement('div');days.className='week-days';
  const details=document.createElement('div');details.className='weekly-details';details.hidden=true;
  const weekdays=['Mån','Tis','Ons','Tor','Fre'];
  for(let i=0;i<5;i++){
   const day=new Date(w.monday);day.setUTCDate(day.getUTCDate()+i);
   const key=isoDay(day);
   const list=w.records.filter(t=>t.date===key);
   const daySum=list.reduce((sum,t)=>sum+t.pnl,0);
   const btn=document.createElement('button');btn.type='button';
   btn.className='week-day '+(!mixed&&list.length?(daySum>=0?'won':'lost'):'');
   btn.setAttribute('aria-label',weekdays[i]+' '+key+': '+list.length+' avslut');
   const label=document.createElement('span');label.textContent=weekdays[i];
   const val=document.createElement('b');val.textContent=!list.length?'—':mixed?list.length+' st':(daySum>0?'+':'')+daySum.toLocaleString('sv-SE',{maximumFractionDigits:0});
   btn.append(label,val);
   btn.addEventListener('click',()=>{
    details.replaceChildren();
    const title=document.createElement('strong');title.textContent=weekdays[i]+' '+key+' · '+
        (list.length?list.length+' matchade avslut':'Inga matchade avslut');
    details.append(title);
    if(list.length){
      const total=document.createElement('div');total.textContent='Summa: '+fmtResult(daySum);details.append(total);
      for(const t of list){
       const line=document.createElement('div');
       line.textContent=t.name+' · '+(mixed?fmtSigned(t.pnl,t.currency):fmtSigned(t.pnl,currency));
       line.style.borderTop='1px solid #2d5264';line.style.marginTop='8px';line.style.paddingTop='8px';
       details.append(line);
      }
    }
    details.hidden=false;
   });
   days.append(btn);
  }
  card.append(days);
  if(!mixed&&w.records.length){
    const bar=document.createElement('div');bar.className='week-bar';
    const fill=document.createElement('span');fill.style.width=Math.max(2,Math.round(Math.abs(w.pnl)/max*100))+'%';
    if(w.pnl<0)fill.className='red';bar.append(fill);card.append(bar);
  }
  card.append(details);
  host.append(card);
 }
}
$('week-count').addEventListener('change',()=>renderWeekly(weekTrades,weekCurrency,weekCurrenciesMixed));
function render(){
 if(!allRows.length)return;
 const account=$('account').value,period=$('period').value;
 // Match using ALL historical buys for selected account, THEN apply report period to sale dates.
 const rows=allRows.filter(r=>account==='all'||r.account===account);
 const analysis=buildAnalysis(rows);
 let trades=analysis.trades.filter(t=>within(t.date,period));
 let events=rows.filter(r=>within(r.date,period));
 const currencies=[...new Set(trades.map(t=>t.currency))];
 const currencyMix=currencies.length>1;
 const unit=currencyMix?'blandade valutor':(currencies[0]||'SEK');
 const sum=items=>items.reduce((a,b)=>a+b.pnl,0);
 const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0),flat=trades.filter(t=>Math.abs(t.pnl)<0.00001);
 weekTrades=trades;weekCurrenciesMixed=currencyMix;weekCurrency=unit;
 renderWeekly(trades,unit,currencyMix);
 const pnl=currencyMix?null:sum(trades);
 const totalCost=trades.reduce((a,b)=>a+b.cost,0);
 const avg=trades.length&&pnl!==null?pnl/trades.length:null;
 const profitFactor=losses.length&&sum(losses)<0?sum(wins)/Math.abs(sum(losses)):null;
 const averageWin=wins.length?sum(wins)/wins.length:null;
 const averageLoss=losses.length?sum(losses)/losses.length:null;
 renderAdvanced(trades,unit,currencyMix);
 renderDistribution(trades,currencyMix);
 renderLeaders(trades,unit,currencyMix);
 renderBonus(trades,events,unit,currencyMix);
 calendarTrades=currencyMix?[]:trades;calendarUnit=unit;calendarOffset=0;paintCalendar();
 const metrics=$('metrics');metrics.replaceChildren();
 metrics.append(metric('Realiserat resultat',pnl===null?'Flera valutor':fmtSigned(pnl,unit),'Köp/sälj som kunnat matchas',pnl>0?'green':pnl<0?'red':''),
 metric('Vinstträffar',trades.length?(wins.length/trades.length*100).toFixed(1)+' %':'–',wins.length+' vinster · '+losses.length+' förluster · '+flat.length+' noll'),
 metric('Matchade försäljningar',String(trades.length),'Per försäljningshändelse, inte per strategi'),
 metric('Genomsnitt per avslut',avg===null?'–':fmtSigned(avg,unit),'Avslut med känd inköpskostnad'),
 metric('Bästa avslut',trades.length&&!currencyMix?fmtSigned(Math.max(...trades.map(x=>x.pnl)),unit):'–','Matchade affärer'),
 metric('Sämsta avslut',trades.length&&!currencyMix?fmtSigned(Math.min(...trades.map(x=>x.pnl)),unit):'–','Matchade affärer'),
 metric('Profit factor',profitFactor===null?'–':profitFactor.toFixed(2),'Bruttovinster / bruttoförluster'),
 metric('Snittvinst / snittförlust',(!currencyMix&&averageWin!==null&&averageLoss!==null)?money(averageWin,unit)+' / '+money(averageLoss,unit):'–','Räknat på avsluten'));
 $('coverage').textContent=
  'Import: '+allRows.length+' transaktioner, '+analysis.purchased+' köp och '+analysis.sold+
  ' försäljningar på valda konton. '+analysis.unmatchedSales+
  ' försäljningar saknar helt eller delvis matchade köp (ej fullt beräkningsbara). '+
  (analysis.invalidQty+analysis.invalidAmounts)+' köp/sälj saknar användbart antal eller belopp. '+
  (currencyMix?'VARNING: Flera valutor förekommer. Vinstsummor blandas inte ihop. ':'')+
  'Resultaten använder FIFO och nettobelopp från CSV; Avanzas visade resultat kan skilja sig vid valutaomräkning och avgifter.';
 const winrate=wins.length+losses.length?(wins.length/(wins.length+losses.length)*100):0;
 $('donut').style.background='conic-gradient(#35dba8 0 '+winrate+'%, #f4929c '+winrate+'% 100%)';
 $('donutlabel').textContent=(wins.length+losses.length)?Math.round(winrate)+'%':'–';
 $('donutlegend').textContent='';
 for(const [text,color,count] of [['Vinster','#35dba8',wins.length],['Förluster','#f4929c',losses.length],['Nollresultat','#8ba7b8',flat.length]]){
  const line=document.createElement('div'),dot=document.createElement('i');dot.className='dot';dot.style.background=color;
  line.append(dot,document.createTextNode(text+': '+count));$('donutlegend').append(line);
 }
 if(currencyMix){
  for(const id of ['monthly','symbols','weekdays'])$(id).textContent='Välj ett konto eller använd CSV med en enda redovisningsvaluta för att summera resultat.';
  $('equity-plot').replaceChildren();$('line-caption').textContent='Blandade valutor kan inte summeras utan valutakurser.';
 }else{
  barsInto('monthly',grouped(trades,t=>t.date.slice(0,7),t=>t.pnl).sort((a,b)=>a.label.localeCompare(b.label)),v=>fmtSigned(v,unit));
  barsInto('symbols',grouped(trades,t=>t.name,t=>t.pnl).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)).slice(0,12),v=>fmtSigned(v,unit));
  const days=['Söndag','Måndag','Tisdag','Onsdag','Torsdag','Fredag','Lördag'];
  barsInto('weekdays',grouped(trades,t=>days[new Date(t.date+'T12:00:00Z').getUTCDay()],t=>t.pnl).sort((a,b)=>days.indexOf(a.label)-days.indexOf(b.label)),v=>fmtSigned(v,unit));
  renderPlot(trades,unit);
 }
 const sorted=[...trades].sort((a,b)=>b.date.localeCompare(a.date));
 const holding=analysis.lots;
 const unique=new Set(events.filter(x=>['buy','sell'].includes(x.category)).map(x=>x.isin||x.name));
 const activity=[...grouped(events.filter(x=>['buy','sell'].includes(x.category)),x=>x.date,()=>1)].sort((a,b)=>b.value-a.value);
 const top=activity[0];
 const facts=$('funfacts');facts.replaceChildren();
 const factsArr=[
  ['Mest aktiva handelsdagen',top?top.label+' ('+top.value+' transaktioner)':'–'],
  ['Unika värdepapper',String(unique.size)],
  ['Totala transaktionsrader',String(events.length)],
  ['Längsta följd av vinster',String((()=>{let best=0,current=0;for(const t of [...trades].sort((a,b)=>a.date.localeCompare(b.date))){current=t.pnl>0?current+1:0;best=Math.max(best,current)}return best})())],
  ['Dagar med köp eller sälj',String(new Set(events.filter(x=>['buy','sell'].includes(x.category)).map(x=>x.date)).size)],
  ['Senast noterade transaktion',events.length?[...events].sort((a,b)=>b.date.localeCompare(a.date))[0].date:'–'],
  ['Öppna lotter med känd kostnad',String([...holding.values()].reduce((a,b)=>a+b.length,0))],
  ['Andel avslut med vinst',trades.length?(wins.length/trades.length*100).toFixed(1)+' %':'–']
 ];
 for(const [label,value] of factsArr){const div=document.createElement('div');div.className='bar-label';div.style.padding='9px 0';div.style.borderBottom='1px solid #285066';const a=document.createElement('span'),b=document.createElement('b');a.textContent=label;b.textContent=value;div.append(a,b);facts.append(div)}
 const cash=$('cash-metrics');cash.replaceChildren();
 const cashSum=kind=>grouped(events.filter(x=>x.category===kind),x=>x.currency,x=>Math.abs(x.amount||0));
 const cashMetric=(name,kind)=>{const groupedCash=cashSum(kind);cash.append(metric(name,groupedCash.length?groupedCash.map(x=>money(x.value,x.label)).join(' / '):'–','Transaktioner med belopp'))};
 cashMetric('Insättningar','deposit');cashMetric('Uttag','withdraw');cashMetric('Utdelningar','dividend');cashMetric('Räntor','interest');
 const recent=$('recent');recent.replaceChildren();
 for(const t of sorted.slice(0,25)){const tr=document.createElement('tr');for(const v of [t.date,t.name,t.qty.toLocaleString('sv-SE'),fmtSigned(t.pnl,t.currency),t.currency]){const td=document.createElement('td');td.textContent=v;tr.append(td)}recent.append(tr)}
 const tx=$('transactions');tx.replaceChildren();
 for(const r of [...events].sort((a,b)=>b.date.localeCompare(a.date)||b.line-a.line).slice(0,100)){
  const tr=document.createElement('tr');
  for(const v of [r.date,r.type,r.name,r.amount===null?'–':money(r.amount,r.currency),r.currency]){const td=document.createElement('td');td.textContent=v;tr.append(td)}tx.append(tr);
 }
 $('dashboard').hidden=false;
}
$('csv').addEventListener('change',async event=>{
 const file=event.target.files?.[0];if(!file)return;
 $('status').textContent='Läser filen lokalt i Safari…';
 try{
  if(file.size>18*1024*1024)throw Error('Filen är större än 18 MB. Exportera en kortare period.');
  const buffer=await file.arrayBuffer();
  // Try UTF-8 first, fall back to Windows-1252 for older Avanza exports.
  let text=new TextDecoder('utf-8').decode(buffer);
  if(text.includes('\ufffd'))text=new TextDecoder('windows-1252').decode(buffer);
  const parsed=parseCSV(text);
  allRows=parsed.rows;importInfo=parsed;
  $('filename').textContent=file.name+' · '+parsed.rows.length+' transaktionsrader';
  const accounts=[...new Set(allRows.map(x=>x.account))].sort();
  const selector=$('account');selector.replaceChildren();
  const all=document.createElement('option');all.value='all';all.textContent='Alla konton';selector.append(all);
  for(const account of accounts){const opt=document.createElement('option');opt.value=account;opt.textContent=account.replace(/\d/g,'•');selector.append(opt)}
  $('status').textContent='✓ Filen är läst. Resultaten visas nedan. Ingen fil har skickats till servern.';
  render();
 }catch(error){$('status').textContent='Kunde inte läsa filen: '+error.message;$('dashboard').hidden=true;allRows=[]}
});
$('account').addEventListener('change',render);
$('period').addEventListener('change',render);
$('clear').addEventListener('click',()=>{
 allRows=[];allTrades=[];allEvents=[];$('csv').value='';$('filename').textContent='';
 $('dashboard').hidden=true;$('status').textContent='Analysen är rensad från sidan.';
});
