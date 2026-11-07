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
 const pnl=currencyMix?null:sum(trades);
 const totalCost=trades.reduce((a,b)=>a+b.cost,0);
 const avg=trades.length&&pnl!==null?pnl/trades.length:null;
 const profitFactor=losses.length&&sum(losses)<0?sum(wins)/Math.abs(sum(losses)):null;
 const averageWin=wins.length?sum(wins)/wins.length:null;
 const averageLoss=losses.length?sum(losses)/losses.length:null;
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
