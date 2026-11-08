"""KLAR COMMUNITY account endpoints. SQLite requires a persistent disk for production."""
import os, re, sqlite3, secrets, hashlib, hmac, time, threading
from pathlib import Path
from fastapi import APIRouter, Request, Response, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/community")
DB_PATH = os.getenv("COMMUNITY_DB_PATH", "/tmp/klar-community.sqlite3")
COOKIE_SECURE = os.getenv("COMMUNITY_COOKIE_SECURE", "true").lower() == "true"
AVATARS = ("viking", "owl", "fox", "bear", "wolf", "eagle", "shield", "star", "bull_trader", "bear_trader", "candlestick", "diamond_hands", "trading_legend", "breakout_king")
ATTEMPTS = {}
LOCK = threading.Lock()

def connection():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.execute("PRAGMA busy_timeout=10000")
    db.execute("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, avatar TEXT NOT NULL, salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at INTEGER NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)")
    db.commit()
    return db

class Register(BaseModel):
    username: str = Field(min_length=3, max_length=20)
    password: str = Field(min_length=12, max_length=128)
    avatar: str

class Login(BaseModel):
    username: str
    password: str

class AvatarChange(BaseModel):
    avatar: str

def validate_origin(request):
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Otillåten begäran")

def throttle(request, category):
    ip = request.client.host if request.client else "unknown"
    key = (category, ip)
    now = time.time()
    with LOCK:
        times = [t for t in ATTEMPTS.get(key, []) if now-t < 900]
        if len(times) >= (10 if category == "login" else 5):
            raise HTTPException(429, "För många försök. Vänta 15 minuter.")
        times.append(now)
        ATTEMPTS[key] = times
        if len(ATTEMPTS)>10000:
            ATTEMPTS.clear()

def password_hash(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)

def set_session(response, db, uid):
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions VALUES (?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), uid, int(time.time())+604800))
    db.commit()
    response.set_cookie("klar_session", token, max_age=604800, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")

def current_user(request, db):
    token = request.cookies.get("klar_session", "")
    if not token:
        return None
    row = db.execute("""SELECT u.id,u.username,u.avatar FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?""", (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
    return {"id":row[0], "username":row[1], "avatar":row[2]} if row else None

@router.get("/me")
def me(request: Request):
    with connection() as db:
        return {"user": current_user(request, db), "avatars": AVATARS}

@router.post("/register", status_code=201)
def register(data: Register, request: Request, response: Response):
    validate_origin(request)
    throttle(request, "register")
    name = data.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", name):
        raise HTTPException(422, "Använd 3–20 bokstäver, siffror eller understreck (a-z).")
    if data.avatar not in AVATARS:
        raise HTTPException(422, "Välj en förvald profilbild.")
    if len(data.password.encode("utf-8")) > 256:
        raise HTTPException(422, "Lösenordet är för långt.")
    salt = secrets.token_bytes(16)
    digest = password_hash(data.password, salt)
    uid = secrets.token_hex(16)
    with connection() as db:
        try:
            db.execute("INSERT INTO users VALUES (?,?,?,?,?,?)", (uid,name,data.avatar,salt,digest,int(time.time())))
            db.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Användarnamnet är upptaget.")
        set_session(response, db, uid)
    return {"user":{"id":uid,"username":name,"avatar":data.avatar}}

@router.post("/login")
def login(data: Login, request: Request, response: Response):
    validate_origin(request)
    throttle(request, "login")
    with connection() as db:
        row = db.execute("SELECT id,username,avatar,salt,password_hash FROM users WHERE username=?", (data.username.strip(),)).fetchone()
        salt = row[3] if row else b"\0"*16
        digest = password_hash(data.password, salt)
        if not row or not hmac.compare_digest(digest,row[4]):
            raise HTTPException(401, "Fel användarnamn eller lösenord.")
        set_session(response, db, row[0])
        return {"user":{"id":row[0],"username":row[1],"avatar":row[2]}}

@router.post("/logout")
def logout(request: Request, response: Response):
    validate_origin(request)
    token = request.cookies.get("klar_session", "")
    if token:
        with connection() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
            db.commit()
    response.delete_cookie("klar_session", path="/")
    return {"ok":True}

@router.post("/avatar")
def change_avatar(data: AvatarChange, request: Request):
    validate_origin(request)
    if data.avatar not in AVATARS:
        raise HTTPException(422, "Ogiltig avatar")
    with connection() as db:
        user = current_user(request, db)
        if not user:
            raise HTTPException(401, "Logga in först.")
        db.execute("UPDATE users SET avatar=? WHERE id=?", (data.avatar,user["id"]))
        db.commit()
        user["avatar"] = data.avatar
        return {"user":user}
