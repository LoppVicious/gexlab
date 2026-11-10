"""
GEX Lab - recolector diario.

Guarda cada dia, para cada ticker de la lista de seguimiento (watchlist.json):
  - los niveles ex ante (antes de la apertura, con el open interest nuevo) -> validacion sin mirar al futuro
  - los niveles en los dos modos (estandar y flujo) -> historial y validacion
  - el flujo por contrato (OI, volumen, lado de la ultima operacion) -> modelo de flujo
  - la volatilidad (IV30, risk reversal, realizada) -> Compass
  - la copia de la cadena con el 0DTE vivo -> repetir el mapa

Uso:
  python recolector.py              decide segun la hora de Nueva York si toca recoger (lo llama Windows)
  python recolector.py --forzar     recoge ahora, sea la hora que sea
  python recolector.py --instalar   registra las tareas en el Programador de tareas de Windows
  python recolector.py --desinstalar
  python recolector.py --estado
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

import gex_engine as g  # noqa: E402

STATE_PATH = os.path.join(g.HIST_DIR, "recolector_state.json")
LOG_PATH = os.path.join(g.HIST_DIR, "recolector.log")
TASK_MAIN = r"GEX Lab\Recolector"
TASK_WAKE = r"GEX Lab\Recolector (despertar)"
OPEN_WINDOW = ((8, 30), (9, 45))  # recogida ex ante: open interest nuevo y precio de antes de la apertura
INTRADAY_BEFORE_CLOSE = 30   # minutos antes del cierre: recogida con el 0DTE aun vivo
CLOSE_DELAY = 15             # minutos tras el cierre: recogida con volumenes finales
REMOVED_PURGE_DAYS = 30


# ---------------------------------------------------------------- utilidades
def log(msg: str) -> None:
    os.makedirs(g.HIST_DIR, exist_ok=True)
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1_000_000:
            os.replace(LOG_PATH, LOG_PATH + ".1")
    except OSError:
        pass
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    if sys.stdout and not sys.executable.lower().endswith("pythonw.exe"):
        print(line)


def read_state() -> dict:
    return g.read_json(STATE_PATH, {}) or {}


def write_state(st: dict) -> None:
    g.write_json(STATE_PATH, st)


# ---------------------------------------------------------------- decision
def decide(now: datetime, st: dict) -> tuple[str | None, str | None]:
    """Devuelve (tipo, sesion) si toca recoger: 'intradia' con el mercado abierto en la ultima media hora,
    'cierre' tras el cierre (o al encender el PC mientras CBOE aun tenga los datos de esa sesion)."""
    today = now.strftime("%Y-%m-%d")
    if g.is_trading_day(now) and OPEN_WINDOW[0] <= (now.hour, now.minute) < OPEN_WINDOW[1] and st.get("apertura") != today:
        return "apertura", today
    if g.market_open(now):
        if now >= g.close_time(now) - timedelta(minutes=INTRADAY_BEFORE_CLOSE) and st.get("intradia") != today:
            return "intradia", today
        return None, None
    lc = g.last_close(now)
    if now < lc + timedelta(minutes=CLOSE_DELAY):
        return None, None
    sess = lc.strftime("%Y-%m-%d")
    if st.get("cierre") != sess:
        return "cierre", sess
    pend = st.get("pendientes") or {}
    if not pend and st.get("abandonados") != sess:  # recogidas antiguas sin lista de pendientes
        last = st.get("ultima_recogida") or {}
        retry = [k for k, v in (last.get("errores") or {}).items() if _retryable(v)]
        if last.get("sesion") == sess and retry:
            pend = st["pendientes"] = {"tipo": "cierre", "sesion": sess, "tickers": retry, "intentos": 1}
    if pend.get("sesion") == sess and pend.get("tickers") and pend.get("tipo") == "cierre":
        return "reintento", sess
    return None, None


# ---------------------------------------------------------------- recogida
def _retryable(err: str) -> bool:
    """Solo se reintentan los fallos de conexion o de limite de peticiones, no un ticker sin opciones."""
    e = err.lower()
    return not ("no options data" in e or "does not publish" in e or "invalid ticker" in e or "no underlying price" in e)


def _collect_one(sym: str) -> str:
    try:
        g.compute(sym, max_dte=45, window_pct=5.0, force=True)                       # estandar
        g.compute(sym, max_dte=45, window_pct=5.0, positioning="flow")               # flujo
        return "ok"
    except Exception as e:  # noqa: BLE001
        return str(e)[:160]


def universe() -> list[str]:
    """Tickers a recoger: la lista del PC o, en el servidor publicado, la union de las listas de todos los usuarios."""
    import auth
    paths = auth.all_watchlist_paths() if auth.enabled() else [None]
    out = []
    for p in paths:
        for s in g.load_watchlist(p)["symbols"]:
            if s not in out:
                out.append(s)
    return out


def collect(kind: str, session: str, only: list[str] | None = None) -> dict:
    allsyms = universe()
    symbols = [s for s in allsyms if not only or s in only]
    t0 = time.time()
    results = {}
    for sym in symbols:
        results[sym] = _collect_one(sym)
        time.sleep(1.0)  # ritmo tranquilo para no saturar CBOE
    failed = [s for s, v in results.items() if v != "ok" and _retryable(v)]
    if failed:  # segundo intento tras una pausa
        log(f"  reintentando en 30 s: {', '.join(failed)}")
        time.sleep(30)
        for sym in failed:
            results[sym] = _collect_one(sym)
            time.sleep(2.0)
    for sym, v in results.items():
        if v != "ok":
            log(f"  {sym}: error {v}")
    if kind != "apertura":
        try:
            g.compass(symbols)  # guarda IV30, risk reversal y volatilidad realizada
        except Exception as e:  # noqa: BLE001
            log(f"  compass: error {e}")
    purged = purge_removed(allsyms)
    ok = sum(1 for v in results.values() if v == "ok")
    if kind == "reintento":
        log(f"reintento {session}: {ok}/{len(symbols)} recuperados")
        return {"ok": ok, "total": len(symbols), "results": results, "seconds": round(time.time() - t0, 1)}
    log(f"{kind} {session}: {ok}/{len(symbols)} tickers en {time.time() - t0:.0f} s" + (f"; limpiados {purged}" if purged else ""))
    return {"ok": ok, "total": len(symbols), "results": results, "seconds": round(time.time() - t0, 1)}


def purge_removed(current: list[str]) -> list[str]:
    """Borra el flujo y las copias de la cadena de los tickers que llevan mas de 30 dias fuera de todas las listas.
    El historial de niveles y de volatilidad se conserva por si se vuelven a anadir."""
    path = os.path.join(g.HIST_DIR, "universo.json")
    seen = g.read_json(path, {}) or {}
    today = datetime.now().strftime("%Y-%m-%d")
    for s in current:
        seen[s] = today
    purged = []
    for sym, date in list(seen.items()):
        try:
            if (datetime.now() - datetime.strptime(date, "%Y-%m-%d")).days < REMOVED_PURGE_DAYS:
                continue
        except ValueError:
            continue
        safe = sym.replace(".", "_")
        for p in (os.path.join(g.HIST_DIR, f"flow_{safe}.json.gz"), os.path.join(g.HIST_DIR, f"flow_{safe}.json")):
            if os.path.exists(p):
                os.remove(p)
        cdir = os.path.join(g.HIST_DIR, "chains")
        if os.path.isdir(cdir):
            for x in os.listdir(cdir):
                if x.startswith(safe + "_20"):
                    os.remove(os.path.join(cdir, x))
        seen.pop(sym)
        purged.append(sym)
    g.write_json(path, seen)
    return purged


def run(force: bool = False) -> None:
    now = g.now_ny()
    st = read_state()
    st["ultima_comprobacion"] = now.strftime("%Y-%m-%d %H:%M ET")
    if force:
        kind = "intradia" if g.market_open(now) else "cierre"
        sess = now.strftime("%Y-%m-%d") if kind == "intradia" else g.last_close(now).strftime("%Y-%m-%d")
    else:
        kind, sess = decide(now, st)
    if not kind:
        write_state(st)
        return
    log(f"Recogida {kind} de la sesion {sess} ({now:%H:%M} ET)")
    if kind == "reintento":
        pend = st["pendientes"]
        res = collect("reintento", sess, only=pend["tickers"])
        prev = st.get("ultima_recogida") or {}
        errs = {k: v for k, v in res["results"].items() if v != "ok"}
        prev_err = {k: v for k, v in (prev.get("errores") or {}).items() if k not in res["results"]}
        prev["errores"] = {**prev_err, **errs}
        prev["ok"] = (prev.get("total") or res["total"]) - len(prev["errores"])
        st["ultima_recogida"] = prev
        pend["tickers"] = [k for k, v in errs.items() if _retryable(v)]
        pend["intentos"] = pend.get("intentos", 1) + 1
        if not pend["tickers"] or pend["intentos"] >= 6:
            st.pop("pendientes", None)
            if pend["tickers"]:
                st["abandonados"] = sess
                log(f"  se deja de reintentar {', '.join(pend['tickers'])} para la sesion {sess}")
        write_state(st)
        return
    res = collect(kind, sess)
    st[kind] = sess
    errs = {k: v for k, v in res["results"].items() if v != "ok"}
    st["ultima_recogida"] = {"tipo": kind, "sesion": sess, "hora": now.strftime("%Y-%m-%d %H:%M ET"),
                             "ok": res["ok"], "total": res["total"], "segundos": res["seconds"], "errores": errs}
    retry = [k for k, v in errs.items() if _retryable(v)]
    if retry and kind == "cierre":
        st["pendientes"] = {"tipo": "cierre", "sesion": sess, "tickers": retry, "intentos": 1}
    else:
        st.pop("pendientes", None)
    write_state(st)


# ---------------------------------------------------------------- Programador de tareas de Windows
def _user() -> str:
    return f"{os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}".strip("\\")


def _task_xml(triggers: str, wake: bool) -> str:
    pyw = os.path.join(ROOT, ".venv", "Scripts", "pythonw.exe")
    if not os.path.exists(pyw):
        pyw = sys.executable.replace("python.exe", "pythonw.exe")
    user = _user()
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>GEX Lab: guarda cada dia los datos de opciones de la lista de seguimiento.</Description></RegistrationInfo>
  <Triggers>{triggers}</Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <WakeToRun>{"true" if wake else "false"}</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>{pyw}</Command><Arguments>"{os.path.join(ROOT, 'recolector.py')}"</Arguments><WorkingDirectory>{ROOT}</WorkingDirectory></Exec></Actions>
</Task>"""


def _register(name: str, xml: str) -> bool:
    fd, path = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    with open(path, "w", encoding="utf-16") as f:
        f.write(xml)
    try:
        r = subprocess.run(["schtasks", "/Create", "/TN", name, "/XML", path, "/F"], capture_output=True, text=True)
        print((r.stdout or r.stderr).strip())
        return r.returncode == 0
    finally:
        os.remove(path)


def install() -> None:
    if os.name != "nt":
        print("El instalador automatico es para Windows. En Mac/Linux programa 'python recolector.py' cada 30 min con cron.")
        return
    start = datetime.now().strftime("%Y-%m-%dT00:05:00")
    every30 = f"""
    <CalendarTrigger><StartBoundary>{start}</StartBoundary><Enabled>true</Enabled>
      <Repetition><Interval>PT30M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"""
    logon = f"""
    <LogonTrigger><Enabled>true</Enabled><UserId>{_user()}</UserId><Delay>PT2M</Delay></LogonTrigger>"""
    wake = f"""
    <CalendarTrigger><StartBoundary>{datetime.now().strftime('%Y-%m-%dT22:40:00')}</StartBoundary><Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"""
    with_logon = _register(TASK_MAIN, _task_xml(every30 + logon, wake=False))
    ok1 = with_logon
    if not with_logon:
        # sin permisos para el disparador de inicio de sesion: la tarea sigue recuperando lo pendiente
        # gracias a StartWhenAvailable (ejecuta en cuanto puede si se salto una ejecucion)
        print("Reintentando sin el disparador de inicio de sesion...")
        ok1 = _register(TASK_MAIN, _task_xml(every30, wake=False))
    ok2 = _register(TASK_WAKE, _task_xml(wake, wake=True))
    print()
    if ok1:
        print("Recolector instalado.")
        print("- Comprueba cada 30 min con el PC encendido" + (" y al iniciar sesion." if with_logon else
              "; si el PC estuvo apagado, recupera lo pendiente en cuanto se enciende."))
        if ok2:
            print("- Despierta el PC a las 22:40 si esta en suspension (si Windows permite temporizadores de activacion).")
        else:
            print("- No se pudo crear la tarea de despertar: recogera al encender el PC.")
        print("Recogiendo ahora la ultima sesion para empezar (unos segundos por ticker)...")
        run(force=True)
        st = read_state().get("ultima_recogida", {})
        if st:
            print(f"Hecho: {st.get('ok')}/{st.get('total')} tickers de la sesion {st.get('sesion')}.")
            for k, v in (st.get("errores") or {}).items():
                print(f"  {k}: {v}")
    else:
        print("No se pudo registrar la tarea principal. Copia el mensaje de error de arriba y pasamelo.")


def uninstall() -> None:
    for name in (TASK_MAIN, TASK_WAKE):
        r = subprocess.run(["schtasks", "/Delete", "/TN", name, "/F"], capture_output=True, text=True)
        print((r.stdout or r.stderr).strip())


def installed() -> bool | None:
    if os.name != "nt":  # servidor Linux: tarea en el crontab del usuario
        try:
            r = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=5)
            return "recolector.py" in (r.stdout or "")
        except Exception:  # noqa: BLE001
            return None
    try:
        r = subprocess.run(["schtasks", "/Query", "/TN", TASK_MAIN], capture_output=True, text=True,
                           creationflags=0x08000000)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if arg == "--instalar":
            install()
        elif arg == "--desinstalar":
            uninstall()
        elif arg == "--estado":
            print(json.dumps(read_state(), indent=2, ensure_ascii=False))
        else:
            run(force=arg == "--forzar")
    except Exception:  # noqa: BLE001
        log("Error inesperado:\n" + traceback.format_exc())
        raise
