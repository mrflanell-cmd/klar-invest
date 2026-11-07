import re, uuid, threading, datetime as dt, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo
from pathlib import Path
import requests
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

app=FastAPI(title="KLAR INVEST")
JOBS={}
TZ=ZoneInfo("Europe/Stockholm")
class ScanOptions(BaseModel):
    market:str="SE"
    pattern:str="piercing"
    min_price:float=10
    max_price:float=800
    commodity_group:str="all"
    checkpoint:dict|None=None

# Curated exchange-traded futures universe. Price quotation units differ by contract.
COMMODITIES = [
    ("GC=F","Guld","metals","COMEX:GC1!","USD/oz"),
    ("SI=F","Silver","metals","COMEX:SI1!","USD/oz"),
    ("PL=F","Platina","metals","NYMEX:PL1!","USD/oz"),
    ("PA=F","Palladium","metals","NYMEX:PA1!","USD/oz"),
    ("HG=F","Koppar","metals","COMEX:HG1!","USD/lb"),
    ("CL=F","WTI råolja","energy","NYMEX:CL1!","USD/fat"),
    ("BZ=F","Brentolja","energy","ICEEUR:BRN1!","USD/fat"),
    ("NG=F","Naturgas","energy","NYMEX:NG1!","USD/MMBtu"),
    ("RB=F","Bensin RBOB","energy","NYMEX:RB1!","USD/gallon"),
    ("HO=F","Eldningsolja","energy","NYMEX:HO1!","USD/gallon"),
    ("ZW=F","Vete","grains","CBOT:ZW1!","US¢/bushel"),
    ("ZC=F","Majs","grains","CBOT:ZC1!","US¢/bushel"),
    ("ZS=F","Sojabönor","grains","CBOT:ZS1!","US¢/bushel"),
    ("ZO=F","Havre","grains","CBOT:ZO1!","US¢/bushel"),
    ("ZR=F","Ris","grains","CBOT:ZR1!","USD/cwt"),
    ("ZM=F","Sojamjöl","grains","CBOT:ZM1!","USD/short ton"),
    ("ZL=F","Sojaolja","grains","CBOT:ZL1!","US¢/lb"),
    ("KC=F","Kaffe","softs","ICEUS:KC1!","US¢/lb"),
    ("CC=F","Kakao","softs","ICEUS:CC1!","USD/ton"),
    ("SB=F","Socker","softs","ICEUS:SB1!","US¢/lb"),
    ("CT=F","Bomull","softs","ICEUS:CT1!","US¢/lb"),
    ("OJ=F","Apelsinjuice","softs","ICEUS:OJ1!","US¢/lb"),
    ("LE=F","Levande nötkreatur","livestock","CME:LE1!","US¢/lb"),
    ("GF=F","Ungnöt","livestock","CME:GF1!","US¢/lb"),
    ("HE=F","Grisar","livestock","CME:HE1!","US¢/lb"),
]

def commodity_universe(group="all"):
    if group not in ("all","metals","energy","grains","softs","livestock"):
        raise ValueError("Okänd råvarugrupp.")
    instruments = [
        {"ticker":ticker,"symbol":ticker,"name":name,"group":category,
         "tv_symbol":tv_symbol,"quote_unit":unit}
        for ticker,name,category,tv_symbol,unit in COMMODITIES
        if group=="all" or category==group
    ]
    return instruments, ("Utvalda råvaruterminer: "+str(len(instruments))+
        " instrument. Inte samtliga terminskontrakt på marknaden.")

def get_json_with_retries(url, params):
    last_error = None
    for attempt in range(4):
        try:
            response = requests.get(url, params=params, timeout=25)
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(attempt + 1)
    raise last_error

def first_north_sweden_universe():
    """Best-effort live Nasdaq First North Sweden discovery, never guess country."""
    items = []
    errors = []
    url = "https://api.nasdaq.com/api/nordic/screener/shares"
    headers = {"User-Agent":"Mozilla/5.0", "Accept":"application/json"}
    for page in range(1, 11):
        try:
            r = requests.get(url, params={"category":"FIRST_NORTH","tableonly":"true",
                             "page":page,"size":100,"lang":"en"},headers=headers,timeout=18)
            r.raise_for_status()
            data = r.json().get("data") or {}
            listing = data.get("instrumentListing") or {}
            rows = listing.get("rows") or []
            if not isinstance(rows,list):raise ValueError("Okänt Nasdaq-format")
            if not rows:break
            for row in rows:
                if not isinstance(row,dict):continue
                country = " ".join(str(row.get(k) or "") for k in
                    ("market","marketName","marketSegment","marketSegmentName",
                     "exchange","exchangeName","country","countryName"))
                # Other Nordic First North listings must never be treated as Swedish.
                if not any(tag in country.lower() for tag in ("sweden","stockholm","first north sweden")):
                    continue
                t = str(row.get("symbol") or row.get("ticker") or "").strip().upper()
                if not re.fullmatch(r"[A-Z0-9._ -]{1,24}",t):continue
                symbol = t.replace(" ","-").replace("_","-").replace(".","-")+".ST"
                items.append({"ticker":t,"symbol":symbol,
                              "name":str(row.get("name") or row.get("companyName") or t),
                              "exchange":"FIRST_NORTH"})
            if len(rows)<100:break
        except (requests.RequestException,ValueError,TypeError) as exc:
            errors.append(str(exc)[:90])
            break
    return items, errors

def universe(market):
    if market == "COM":
        return commodity_universe("all")
    if market == "US":
        r = requests.get("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt", timeout=25)
        r.raise_for_status()
        tickers = [line.split("|")[0] for line in r.text.splitlines()[1:] if "|" in line]
        return ([{"ticker":t,"symbol":t,"name":t} for t in tickers if re.fullmatch(r"[A-Z]{1,5}",t)],
                "Nasdaq-lista; NYSE och NYSE American ingår ännu inte.")
    items = []
    offset = 0
    expected = None
    error_text = ""
    while offset < 5000:
        try:
            data = get_json_with_retries(
                "https://datasets-server.huggingface.co/rows",
                {"dataset":"kjhq/Sweden-Stock-Symbols-and-Metadata",
                 "config":"default","split":"train","offset":offset,"length":100})
        except Exception as exc:
            error_text = "Datakällan misslyckades vid rad " + str(offset) + ": " + str(exc)[:90]
            break
        batch = data.get("rows", [])
        if not batch:
            break
        expected = data.get("num_rows_total")
        for row in batch:
            a = row.get("row", {})
            t = str(a.get("ticker", "")).strip().upper()
            if a.get("market") in ("OMXSTO", "NGM") and re.fullmatch(r"[A-Z0-9._-]{1,20}", t):
                items.append({"ticker":t,
                              "symbol":t.replace("_","-").replace(".","-")+".ST",
                              "name":str(a.get("name") or t), "exchange":a.get("market")})
        offset += len(batch)
        if expected is not None and offset >= expected:
            break
    full = not error_text and expected is not None and offset >= expected
    cache = Path("/tmp/klar_invest_se_universe.json")
    if full and items:
        try:
            cache.write_text(json.dumps(items,ensure_ascii=False),encoding="utf-8")
        except OSError:
            pass
    elif cache.exists():
        try:
            saved = json.loads(cache.read_text(encoding="utf-8"))
            if len(saved) > len(items):
                items = saved
                error_text += " Använder senast sparade instrumentlista."
        except (OSError, ValueError):
            pass
    if not items:
        # Older reference list; mark its limited coverage prominently.
        try:
            raw = requests.get("https://gist.githubusercontent.com/mtornwall/c015f508d6f08578797dbf2e596e4bea/raw/",timeout=18)
            raw.raise_for_status()
            for line in raw.text.splitlines():
                t = line.strip().lstrip("|").strip().upper()
                if re.fullmatch(r"[A-Z0-9-]{1,24}\.ST",t):
                    items.append({"ticker":t[:-3],"symbol":t,"name":t[:-3]})
            if items:
                error_text += " Reservlista från 2024, ej komplett."
        except requests.RequestException:
            pass
    if not items:
        raise ValueError("Kunde inte hämta någon aktielista. Försök igen senare.")
    # Augment with Nasdaq's live First North listings when the feed identifies Sweden.
    first_north, fn_errors = first_north_sweden_universe()
    existing = {item["symbol"] for item in items}
    for item in first_north:
        if item["symbol"] not in existing:
            items.append(item)
            existing.add(item["symbol"])
    if fn_errors or not first_north:
        error_text += " First North kunde inte verifieras via Nasdaq-flödet."
    note = ("Automatiskt hämtad OMXSTO- och NGM-lista (inklusive vissa tillväxtbolag); First North hämtas från Nasdaq när svensk marknad kan verifieras; Spotlight och fullständig täckning är INTE verifierade. Yahoo-kursdata kan saknas för NGM."
            if full else "BEGRÄNSAD TÄCKNING (OMXSTO/NGM): " + (error_text or "Aktielistan är ofullständig."))
    return list({item["symbol"]:item for item in items}.values()), note + " First North-tillägg: " + str(len(first_north)) + " instrument. " + error_text

def history(item,market):
    url="https://query1.finance.yahoo.com/v8/finance/chart/"+requests.utils.quote(item["symbol"],safe="")
    r=requests.get(url,params={"range":"1y" if item.get("nova") else "3mo","interval":"1d"},headers={"User-Agent":"Mozilla/5.0"},timeout=12)
    r.raise_for_status()
    result=r.json().get("chart",{}).get("result") or []
    if not result:raise ValueError("Inga kursdata")
    d=result[0]
    raw_currency=d.get("meta",{}).get("currency")
    if market=="SE" and raw_currency!="SEK":raise ValueError("Fel valuta")
    if market=="US" and raw_currency!="USD":raise ValueError("Fel valuta")
    if market=="COM" and raw_currency not in ("USD","USX","USd"):raise ValueError("Råvaruvaluta ej verifierad: "+str(raw_currency))
    quote=d["indicators"]["quote"][0];bars=[]
    zone=ZoneInfo("Europe/Stockholm" if market=="SE" else "America/New_York")
    now=dt.datetime.now(zone)
    close_time=dt.time(18,15) if market=="SE" else dt.time(16,15)
    for ix,t in enumerate(d.get("timestamp",[])):
        vals=[quote[k][ix] for k in ("open","high","low","close")]
        if any(v is None for v in vals):continue
        o,h,l,c=vals
        if min(vals)<=0 or h<max(o,c) or l>min(o,c):continue
        date=dt.datetime.fromtimestamp(t,zone).date()
        # Futures can have overnight sessions; wait until the next calendar day
        # rather than mistaking a partially formed futures daily bar for a close.
        if market=="COM" and date>=now.date():
            continue
        if date>now.date() or (date==now.date() and now.time()<close_time):
            continue
        bars.append({"date":str(date),"open":o,"high":h,"low":l,"close":c})
    if len(bars)<3:raise ValueError("Otillräckliga dagskurser")
    return bars

def detect(bars,pattern,low,high):
    a,b,c=bars[-3:]
    if not low<=b["close"]<=high:return None
    def pierce(x,y):
        return x["close"]<x["open"] and y["close"]>y["open"] and y["open"]<x["close"] and y["close"]>x["close"] and y["close"]<x["open"]
    if pattern=="hidden_gate":
        # KLAR INVEST prototype, NOT Flux Charts CRT/FVG/OB implementation.
        # Reference candle a; candle b sweeps its low and reclaims the range;
        # candle c closes above b high. Entry is next-session limit at c close.
        if not (b["low"]<a["low"] and b["close"]>a["low"] and c["close"]>b["high"]):return None
        entry=c["close"]
        stop=b["low"]
        if entry<=stop:return None
        status="BEKRÄFTAD"
    elif pattern=="nova":
        # NOVA v1.0: a fixed, experimental 3-candle reversal with SMA200 filter.
        if len(bars)<203:return None
        sma200=sum(x["close"] for x in bars[-200:])/200
        if c["close"]<=sma200:return None
        ar=a["high"]-a["low"];br=b["high"]-b["low"]
        if ar<=0 or br<=0:return None
        red=a["close"]<a["open"] and (a["open"]-a["close"])/ar>=0.50
        pause=abs(b["close"]-b["open"])/br<=0.35
        confirm=c["close"]>c["open"] and c["close"]>(a["open"]+a["close"])/2 and c["close"]>b["high"]
        if not (red and pause and confirm):return None
        entry=c["close"]
        stop=min(a["low"],b["low"],c["low"])
        if entry<=stop:return None
        status="BEKRÄFTAD"
    elif pattern=="piercing":
        confirmed=pierce(a,b) and c["close"]>c["open"] and c["close"]>a["open"]
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
    return {"status":status,"date":c["date"],"stop":round(stop,4) if pattern in ("nova","hidden_gate") else round(b["low"],4),"strategy":pattern,"sma200":round(sma200,4) if pattern=="nova" else None,"entry":round(entry,4),"last_close":round(c["close"],4),"last_close_date":c["date"],"bars":bars[-3:]}

def do_scan(job_id,options):
    job=JOBS[job_id]
    try:
        if not job["items"]:
            items,note=(commodity_universe(options.commodity_group) if options.market=="COM"
                        else universe(options.market))
            job["items"]=items
            job["total"]=len(items)
            job["source_note"]=note
        already=set(job["completed_symbols"])
        pending=[it for it in job["items"] if it["ticker"] not in already]
        def scan_one(item):
            try:
                bars=history({**item,"nova":options.pattern=="nova"},options.market)
                lo=0 if options.market=="COM" else options.min_price
                hi=1e12 if options.market=="COM" else options.max_price
                return item,detect(bars,options.pattern,lo,hi),None
            except Exception as exc:
                return item,None,str(exc)[:100]
        with ThreadPoolExecutor(max_workers=5) as pool:
            for start in range(0,len(pending),5):
                if job["pause_requested"]:
                    job["state"]="paused"
                    break
                batch=pending[start:start+5]
                for f in as_completed([pool.submit(scan_one,item) for item in batch]):
                    item,match,error=f.result()
                    ticker=item["ticker"]
                    if ticker in already:continue
                    already.add(ticker)
                    job["completed_symbols"].append(ticker)
                    job["processed"]+=1
                    if error:
                        job["errors"]+=1
                        if len(job["error_examples"])<12:
                            job["error_examples"].append(ticker+": "+error)
                    else:
                        job["checked"]+=1
                        if match:
                            match.update({"name":item["name"],"ticker":ticker,
                                "currency":"SEK" if options.market=="SE" else "USD",
                                "quote_unit":item.get("quote_unit","SEK" if options.market=="SE" else "USD"),
                                "tv":"https://www.tradingview.com/chart/?symbol="+
                                requests.utils.quote(item.get("tv_symbol",
                                    ("OMXSTO:" if options.market=="SE" else "NASDAQ:")+ticker),safe="")+"&interval=D"})
                            job["results"].append(match)
            else:
                job["state"]="done"
        if job["pause_requested"] and job["state"]!="done":
            job["state"]="paused"
    except Exception as exc:
        job["state"]="error"
        job["message"]=str(exc)

def new_job(options):
    cp=options.checkpoint if isinstance(options.checkpoint,dict) else {}
    items=cp.get("items",[])
    if not isinstance(items,list) or len(items)>15000:items=[]
    items=[{k:v for k,v in item.items() if k in ("ticker","symbol","name","quote_unit","tv_symbol","group")}
           for item in items if isinstance(item,dict) and isinstance(item.get("ticker"),str)
           and isinstance(item.get("symbol"),str) and len(item.get("symbol",""))<45]
    completed=cp.get("completed_symbols",[])
    known={item["ticker"] for item in items}
    completed=list(dict.fromkeys(x for x in completed if isinstance(x,str) and x in known)) if isinstance(completed,list) else []
    errors=max(0,min(len(completed),int(cp.get("errors",0) or 0)))
    results=cp.get("results",[])
    results=[r for r in results if isinstance(r,dict) and r.get("ticker") in known] if isinstance(results,list) else []
    examples=cp.get("error_examples",[])
    examples=[str(x)[:110] for x in examples[:12]] if isinstance(examples,list) else []
    job=str(uuid.uuid4())
    JOBS[job]={"state":"running","pause_requested":False,"total":len(items),
        "items":items,"completed_symbols":completed,"processed":len(completed),
        "checked":len(completed)-errors,"errors":errors,"error_examples":examples,
        "results":results,"message":"","source_note":str(cp.get("source_note",""))[:500],
        "options":options.model_dump(exclude={"checkpoint"})}
    threading.Thread(target=do_scan,args=(job,options),daemon=True).start()
    return job

@app.get("/",response_class=HTMLResponse)
def root():
    return Path("index.html").read_text(encoding="utf-8")

@app.get("/avanza", response_class=HTMLResponse)
def avanza_dashboard():
    return Path("avanza.html").read_text(encoding="utf-8")

@app.get("/avanza.js")
def avanza_js():
    return FileResponse("avanza.js",media_type="application/javascript",headers={"Cache-Control":"no-store"})


@app.post("/api/scan")
def start(o:ScanOptions):
    if o.market not in ("SE","US","COM") or o.pattern not in ("piercing","engulfing","hammer","nova","hidden_gate"):
        return {"error":"Okända filter"}
    return {"job":new_job(o)}

@app.post("/api/scan/{job}/pause")
def pause(job:str):
    entry=JOBS.get(job)
    if entry is None:return {"state":"missing"}
    if entry["state"]=="running":
        entry["pause_requested"]=True
    return {"state":entry["state"],"pause_requested":entry["pause_requested"]}

@app.post("/api/scan/{job}/resume")
def resume(job:str):
    entry=JOBS.get(job)
    if entry is None:return {"state":"missing"}
    if entry["state"]=="paused":
        entry["pause_requested"]=False
        entry["state"]="running"
        o=ScanOptions(**entry["options"])
        threading.Thread(target=do_scan,args=(job,o),daemon=True).start()
    return {"state":entry["state"]}

@app.get("/api/scan/{job}")
def progress(job:str):
    return JOBS.get(job,{"state":"missing","message":"Sökningen finns inte på servern"})
