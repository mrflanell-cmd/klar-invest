import re, uuid, threading, datetime as dt, json, time
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
    commodity_group:str="all"

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
            if a.get("market") == "OMXSTO" and re.fullmatch(r"[A-Z0-9._-]{1,20}", t):
                items.append({"ticker":t,
                              "symbol":t.replace("_","-").replace(".","-")+".ST",
                              "name":str(a.get("name") or t)})
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
    note = ("Öppen svensk instrumentlista; fullständigheten mot Nasdaq är inte verifierad."
            if full else "BEGRÄNSAD TÄCKNING: " + (error_text or "Aktielistan är ofullständig."))
    return list({item["ticker"]:item for item in items}.values()), note

def history(item,market):
    url="https://query1.finance.yahoo.com/v8/finance/chart/"+requests.utils.quote(item["symbol"],safe="")
    r=requests.get(url,params={"range":"3mo","interval":"1d"},headers={"User-Agent":"Mozilla/5.0"},timeout=12)
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
    return {"status":status,"date":c["date"],"entry":round(entry,4),"last_close":round(c["close"],4),"last_close_date":c["date"],"bars":bars[-3:]}

def do_scan(job_id,options):
    job=JOBS[job_id]
    try:
        items,note=(commodity_universe(options.commodity_group) if options.market=="COM"
                    else universe(options.market))
        job["source_note"]=note
        job["total"]=len(items)
        def scan_one(item):
            try:
                bars=history(item,options.market)
                min_price=0 if options.market=="COM" else options.min_price
                max_price=1e12 if options.market=="COM" else options.max_price
                return item,detect(bars,options.pattern,min_price,max_price),None
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
                        match.update({"name":item["name"],"ticker":item["ticker"],
                            "currency":"SEK" if options.market=="SE" else "USD",
                            "quote_unit":item.get("quote_unit","SEK" if options.market=="SE" else "USD"),
                            "tv":"https://www.tradingview.com/chart/?symbol="+
                            requests.utils.quote(item.get("tv_symbol",
                                ("OMXSTO:" if options.market=="SE" else "NASDAQ:")+item["ticker"]),safe="")+"&interval=D"})
                        job["results"].append(match)
        job["state"]="done"
    except Exception as e:
        job["state"]="error";job["message"]=str(e)

@app.get("/",response_class=HTMLResponse)
def root():
    return Path("index.html").read_text(encoding="utf-8")

@app.post("/api/scan")
def start(o:ScanOptions):
    if o.market not in ("SE","US","COM") or o.pattern not in ("piercing","engulfing","hammer"):
        return {"error":"Okända filter"}
    job=str(uuid.uuid4())
    JOBS[job]={"state":"running","total":0,"processed":0,"checked":0,"errors":0,"error_examples":[],"results":[],"message":"","source_note":""}
    threading.Thread(target=do_scan,args=(job,o),daemon=True).start()
    return {"job":job}

@app.get("/api/scan/{job}")
def progress(job:str):
    return JOBS.get(job,{"state":"error","message":"Skanningen hittades inte"})
