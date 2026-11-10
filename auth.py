"""GEX Lab - usuarios, contrasenas y sesiones (solo en el servidor publicado).

Se activa con la variable de entorno GEX_AUTH=1. En el PC (sin esa variable) la app funciona como siempre,
sin inicio de sesion y con la lista de seguimiento en watchlist.json.

Datos en data/:
  users.json       usuarios: sal + hash PBKDF2-SHA256 de la contrasena, nunca la contrasena
  sessions.json    sesiones activas (se guarda el hash del token, no el token)
  users/<usuario>/ lista de seguimiento y preferencias de cada usuario
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
USERS_PATH = os.path.join(DATA, "users.json")
SESSIONS_PATH = os.path.join(DATA, "sessions.json")
ITERATIONS = 310_000
SESSION_DAYS = 30
MAX_FAILS = 5            # intentos fallidos seguidos permitidos...
LOCK_SECONDS = 15 * 60   # ...antes de bloquear 15 minutos (por usuario y por IP)
COOKIE = "gex_session"
USER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")

_lock = threading.Lock()
_fails: dict[str, list] = {}   # clave (usuario o ip) -> [fallos, bloqueado_hasta]


def enabled() -> bool:
    return os.environ.get("GEX_AUTH") == "1"


def _read(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def _write(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS).hex()


def user_dir(user: str) -> str:
    return os.path.join(DATA, "users", user)


# ---------------------------------------------------------------- gestion de usuarios (usuarios.py)
def list_users() -> dict:
    return _read(USERS_PATH, {})


def set_password(user: str, password: str, create: bool = False) -> None:
    if not USER_RE.match(user):
        raise ValueError("Invalid username: lowercase letters, digits, dot, hyphen or underscore (2-32 characters)")
    if len(password) < 10:
        raise ValueError("The password must be at least 10 characters long")
    with _lock:
        users = list_users()
        if create and user in users:
            raise ValueError(f"User {user} already exists")
        if not create and user not in users:
            raise ValueError(f"User {user} does not exist")
        salt = secrets.token_bytes(16)
        rec = users.get(user, {"created": time.strftime("%Y-%m-%d %H:%M")})
        rec.update(salt=salt.hex(), hash=_hash(password, salt), disabled=False,
                   changed=time.strftime("%Y-%m-%d %H:%M"))
        users[user] = rec
        _write(USERS_PATH, users)
    os.makedirs(user_dir(user), exist_ok=True)
    revoke_sessions(user)  # una contrasena nueva cierra las sesiones abiertas


def set_disabled(user: str, disabled: bool) -> None:
    with _lock:
        users = list_users()
        if user not in users:
            raise ValueError(f"User {user} does not exist")
        users[user]["disabled"] = disabled
        _write(USERS_PATH, users)
    if disabled:
        revoke_sessions(user)


def delete_user(user: str) -> None:
    with _lock:
        users = list_users()
        users.pop(user, None)
        _write(USERS_PATH, users)
    revoke_sessions(user)


# ---------------------------------------------------------------- sesiones
def _sessions() -> dict:
    s = _read(SESSIONS_PATH, {})
    now = time.time()
    return {k: v for k, v in s.items() if v.get("exp", 0) > now}


def revoke_sessions(user: str) -> None:
    with _lock:
        s = _sessions()
        _write(SESSIONS_PATH, {k: v for k, v in s.items() if v.get("user") != user})


def _blocked(key: str) -> float:
    f = _fails.get(key)
    if f and f[1] > time.time():
        return f[1] - time.time()
    return 0.0


def _fail(key: str) -> None:
    f = _fails.setdefault(key, [0, 0.0])
    if f[1] and f[1] <= time.time():
        f[0], f[1] = 0, 0.0
    f[0] += 1
    if f[0] >= MAX_FAILS:
        f[1] = time.time() + LOCK_SECONDS


def login(user: str, password: str, ip: str) -> tuple[str | None, str]:
    """Devuelve (token, '') si es correcto o (None, motivo)."""
    user = (user or "").strip().lower()
    for key in (f"u:{user}", f"ip:{ip}"):
        wait = _blocked(key)
        if wait:
            return None, f"Too many attempts. Try again in {int(wait // 60) + 1} min."
    rec = list_users().get(user)
    ok = False
    if rec and not rec.get("disabled"):
        ok = hmac.compare_digest(_hash(password or "", bytes.fromhex(rec["salt"])), rec["hash"])
    else:
        _hash(password or "", b"x" * 16)  # mismo coste aunque el usuario no exista
    if not ok:
        _fail(f"u:{user}")
        _fail(f"ip:{ip}")
        return None, "Wrong username or password"
    _fails.pop(f"u:{user}", None)
    _fails.pop(f"ip:{ip}", None)
    token = secrets.token_urlsafe(32)
    with _lock:
        s = _sessions()
        s[hashlib.sha256(token.encode()).hexdigest()] = {"user": user, "exp": time.time() + SESSION_DAYS * 86400,
                                                          "created": time.strftime("%Y-%m-%d %H:%M"), "ip": ip}
        _write(SESSIONS_PATH, s)
    return token, ""


def logout(token: str) -> None:
    if not token:
        return
    with _lock:
        s = _sessions()
        s.pop(hashlib.sha256(token.encode()).hexdigest(), None)
        _write(SESSIONS_PATH, s)


_cache: dict[str, tuple[float, str | None]] = {}


def user_of(token: str | None) -> str | None:
    if not token:
        return None
    h = hashlib.sha256(token.encode()).hexdigest()
    hit = _cache.get(h)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    rec = _sessions().get(h)
    user = rec["user"] if rec else None
    if user:
        u = list_users().get(user)
        if not u or u.get("disabled"):
            user = None
    _cache[h] = (time.time(), user)
    return user


def clear_cache() -> None:
    _cache.clear()


# ---------------------------------------------------------------- datos por usuario
def prefs(user: str) -> dict:
    return _read(os.path.join(user_dir(user), "prefs.json"), {})


def save_prefs(user: str, data: dict) -> dict:
    clean = {str(k)[:40]: str(v)[:2000] for k, v in (data or {}).items()}
    if len(json.dumps(clean)) > 50_000:
        raise ValueError("Preferences too large")
    _write(os.path.join(user_dir(user), "prefs.json"), clean)
    return clean


def watchlist_path(user: str | None) -> str | None:
    return os.path.join(user_dir(user), "watchlist.json") if user else None


def all_watchlist_paths() -> list[str]:
    """Listas de todos los usuarios activos (las usa el recolector)."""
    out = []
    for u, rec in list_users().items():
        if not rec.get("disabled"):
            out.append(watchlist_path(u))
    return out
