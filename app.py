import re, uuid, threading, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo
from pathlib import Path
import requests
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

app=FastAPI(title="KLAR INVEST")
JOBS={}
TZ=ZoneInfo("Europe/Stockholm")
class ScanOptions(BaseModel):
    market:str="SE"
    pattern:str="piercing"
    min_price:float=10
    max_price:float=800

def universe(market):
    if market=="US":
        r=requests.get("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",timeout=25)
        r.raise_for_status()
        tickers=[line.split("|")[0] for line in r.text.splitlines()[1:] if "|" in line]
        return [{"ticker":t,"symbol":t,"name":t} for t in tickers if re.fullmatch(r"[A-Z]{1,5}",t)]
    url="https://datasets-server.huggingface.co/rows"
    items=[]; offset=0
    while offset<5000:
        r=requests.get(url,params={"dataset":"kjhq/Sweden-Stock-Symbols-and-Metadata","config":"default","split":"train","offset":offset,"length":100},timeout=25)
        r.raise_for_status()
        data=r.json(); batch=data.get("rows",[])
        if not batch:break
        for row in batch:
            a=row.get("row",{});t=str(a.get("ticker","")).strip().upper()
            if a.get("market")=="OMXSTO" and re.fullmatch(r"[A-Z0-9._-]{1,20}",t):
                items.append({"ticker":t,"symbol":t.replace("_","-").replace(".","-")+".ST","name":str(a.get("name") or t)})
        offset+=len(batch)
        if offset>=data.get("num_rows_total",offset):break
    if not items:raise ValueError("Svensk aktielista kunde inte hämtas från datakällan.")
    return list({i["ticker"]:i for i in items}.values())

def history(item,market):
    url="https://query1.finance.yahoo.com/v8/finance/chart/"+requests.utils.quote(item["symbol"],safe="")
    r=requests.get(url,params={"range":"3mo","interval":"1d"},headers={"User-Agent":"Mozilla/5.0"},timeout=12)
    r.raise_for_status()
    result=r.json().get("chart",{}).get("result") or []
    if not result:raise ValueError("Inga kursdata")
    d=result[0]
    if d.get("meta",{}).get("currency")!=("SEK" if market=="SE" else "USD"):raise ValueError("Fel valuta")
    quote=d["indicators"]["quote"][0];bars=[]
    today=dt.datetime.now(TZ).date()
    for ix,t in enumerate(d.get("timestamp",[])):
        vals=[quote[k][ix] for k in ("open","high","low","close")]
        if any(v is None for v in vals):continue
        o,h,l,c=vals
        if min(vals)<=0 or h<max(o,c) or l>min(o,c):continue
        date=dt.datetime.fromtimestamp(t,TZ).date()
        # Exclude today's bar conservatively; never infer today's official daily close.
        if date>=today:continue
        bars.append({"date":str(date),"open":o,"high":h,"low":l,"close":c})
    if len(bars)<3:raise ValueError("Otillräckliga dagskurser")
    return bars

def detect(bars,pattern,low,high):
    a,b,c=bars[-3:]
    if not low<=b["close"]<=high:return None
    def pierce(x,y):
        return x["close"]<x["open"] and y["close"]>y["open"] and y["open"]<x["close"] and x["close"]<y["close"]<x["open"]
    if pattern=="piercing":
        confirmed=pierce(a,b) and c["close"]>a["open"]
        waiting=pierce(b,c)
        if not confirmed and not waiting:return None
        status="BEKRÄFTAD" if confirmed else "OBEKRÄFTAD – EJ KÖP"
        entry=a["open"] if confirmed else b["open"]
    elif pattern=="engulfing":
        if not (b["close"]<b["open"] and c["close"]>c["open"] and c["open"]<b["close"] and c["close"]>b["open"]):return None
        status="MÖNSTERTRÄFF";entry=b["open"]
    elif pattern=="hammer":
        body=abs(c["close"]-c["open"])
        if not(body>0 and min(c["open"],c["close"])-c["low"]>=2*body and c["high"]-max(c["open"],c["close"])<=body):return None
        status="MÖNSTERTRÄFF";entry=c["open"]
    else:return None
    return {"status":status,"date":c["date"],"entry":round(entry,4),"bars":bars[-3:]}

def do_scan(job_id,options):
    job=JOBS[job_id]
    try:
        items=universe(options.market)
        job["total"]=len(items)
        def scan_one(item):
            try:
                bars=history(item,options.market)
                return item,detect(bars,options.pattern,options.min_price,options.max_price),None
            except Exception as e:return item,None,str(e)[:100]
        with ThreadPoolExecutor(max_workers=5) as executor:
            for f in as_completed([executor.submit(scan_one,item) for item in items]):
                item,match,error=f.result()
                job["processed"]+=1
                if error:
                    job["errors"]+=1
                    if len(job["error_examples"])<12:job["error_examples"].append(item["ticker"]+": "+error)
                else:
                    job["checked"]+=1
                    if match:
                        match.update({"name":item["name"],"ticker":item["ticker"],"tv":"https://www.tradingview.com/chart/?symbol="+("OMXSTO:" if options.market=="SE" else "NASDAQ:")+item["ticker"]+"&interval=D"})
                        job["results"].append(match)
        job["state"]="done"
    except Exception as e:
        job["state"]="error";job["message"]=str(e)

@app.get("/",response_class=HTMLResponse)
def root():
    return Path("index.html").read_text(encoding="utf-8")

@app.post("/api/scan")
def start(o:ScanOptions):
    if o.market not in ("SE","US") or o.pattern not in ("piercing","engulfing","hammer"):
        return {"error":"Okända filter"}
    job=str(uuid.uuid4())
    JOBS[job]={"state":"running","total":0,"processed":0,"checked":0,"errors":0,"error_examples":[],"results":[],"message":""}
    threading.Thread(target=do_scan,args=(job,o),daemon=True).start()
    return {"job":job}

@app.get("/api/scan/{job}")
def progress(job:str):
    return JOBS.get(job,{"state":"error","message":"Skanningen hittades inte"})
