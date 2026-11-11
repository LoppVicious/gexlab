"""GEX Lab - servidor local. Ejecuta:  python3 server.py"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import traceback
import webbrowser
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import auth
import gex_engine

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")


def _range(v: str):
    """Ventana visible: 'auto' o un % entre 0,3 y 75."""
    if v == "auto":
        return "auto"
    return min(75.0, max(0.3, float(v.replace(",", "."))))


PUBLIC_PATHS = {"/login.html", "/api/login", "/favicon.ico"}
MAX_BODY = 100_000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):  # consola limpia
        pass

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")  # siempre la ultima version de la interfaz
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    # ------------------------------------------------------------ sesion
    def _token(self) -> str | None:
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c[auth.COOKIE].value if auth.COOKIE in c else None

    def _user(self) -> str | None:
        """Usuario de la peticion. Sin GEX_AUTH (uso local en el PC) siempre hay acceso."""
        if not auth.enabled():
            return "local"
        return auth.user_of(self._token())

    def _ip(self) -> str:
        ip = self.client_address[0]
        fwd = self.headers.get("X-Forwarded-For")
        if fwd and ip in ("127.0.0.1", "::1"):  # solo se confia en la cabecera del proxy local (Caddy)
            ip = fwd.split(",")[0].strip()
        return ip

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("Request too large")
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}

    def _guard(self, path: str) -> str | None:
        """Devuelve el usuario o responde 401 / redirige al login y devuelve None."""
        user = self._user()
        if user or path in PUBLIC_PATHS:
            return user or ""
        if path.startswith("/api/"):
            self._json(401, {"error": "Session expired: sign in again", "login": True})
        else:
            self.send_response(302)
            self.send_header("Location", "/login.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
        return None

    def _wl_path(self, user: str) -> str | None:
        return auth.watchlist_path(user) if auth.enabled() else None

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, OSError):
            # el navegador cancelo la peticion (cambio de ticker, recarga, pestana cerrada): no hay a quien responder
            self.close_connection = True

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        user = self._guard(url.path)
        if user is None:
            return
        if url.path == "/login.html" and auth.enabled() and user:
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if url.path == "/me.js":
            me = {"user": user, "prefs": auth.prefs(user)} if auth.enabled() else None
            body = ("window.GEX_ME = " + json.dumps(me) + ";").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/api/search":
            try:
                return self._json(200, {"results": gex_engine.search(q.get("q", ""))})
            except Exception as e:  # noqa: BLE001
                return self._json(200, {"results": [], "error": str(e)})
        if url.path == "/api/scan":
            syms = [x for x in q.get("symbols", "").replace(";", ",").split(",") if x.strip()][:40]
            dte = q.get("dte", "45")
            try:
                clean = []
                for x in syms:
                    try:
                        clean.append(gex_engine.normalize(x))
                    except ValueError:
                        continue
                rows = gex_engine.scan(clean, gex_engine.dte_arg(dte))
                return self._json(200, {"rows": rows, "computed_at": gex_engine.now_ny().strftime("%Y-%m-%d %H:%M")})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path == "/api/heatmap":
            try:
                dte = q.get("dte", "45")
                spot = q.get("spot")
                res = gex_engine.heatmap(q.get("symbol", "SPX"), max_dte=gex_engine.dte_arg(dte),
                                         window_pct=_range(q.get("range", "5")),
                                         spot_override=float(spot.replace(",", ".")) if spot else None,
                                         which=q.get("session", "auto") if q.get("session") in ("auto", "last", "next") else "auto",
                                         combine=q.get("combine") == "1",
                                         positioning="flow" if q.get("pos") == "flow" else "standard",
                                         model="gexbot" if q.get("model") == "gexbot" else "spotgamma",
                                         lens=q.get("lens", "gamma"))
                return self._json(200, res)
            except (LookupError, ValueError, ConnectionError) as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path == "/api/validation":
            clean = []
            for x in q.get("symbols", "").split(",")[:40]:
                try:
                    clean.append(gex_engine.normalize(x))
                except ValueError:
                    continue
            try:
                return self._json(200, gex_engine.validation(clean, gex_engine.dte_arg(q.get("dte", "45")), q.get("mode", "standard"),
                                                                   "gexbot" if q.get("model") == "gexbot" else "spotgamma"))
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path == "/api/watchlist":
            return self._json(200, gex_engine.load_watchlist(self._wl_path(user)))
        if url.path == "/api/collector":
            try:
                import recolector
                st = recolector.read_state()
                st["instalado"] = recolector.installed()
            except Exception as e:  # noqa: BLE001
                st = {"error": str(e)}
            return self._json(200, st)
        if url.path == "/api/compass":
            clean = []
            for x in q.get("symbols", "").split(",")[:40]:
                try:
                    clean.append(gex_engine.normalize(x))
                except ValueError:
                    continue
            try:
                return self._json(200, gex_engine.compass(clean))
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path == "/api/vol":
            try:
                import volatilidad
                return self._json(200, volatilidad.vol_data(q.get("symbol", "SPX")))
            except (LookupError, ValueError, ConnectionError) as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path == "/api/chain":
            try:
                return self._json(200, gex_engine.chain_payload(q.get("symbol", "SPX"), force=q.get("refresh") == "1"))
            except (LookupError, ValueError, ConnectionError) as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path == "/api/eventos":
            try:
                import eventos
                st = gex_engine.read_json(eventos.STATE, {}) or {}
                if not st.get("eventos") or q.get("refresh") == "1":
                    eventos.actualizar()
                return self._json(200, {"eventos": eventos.publicables()})
            except Exception as e:  # noqa: BLE001
                return self._json(200, {"eventos": [], "error": str(e)})
        if url.path in ("/api/vix", "/api/cot", "/api/cot_history", "/api/summary"):
            try:
                import macro
                if url.path == "/api/summary":
                    return self._json(200, macro.summary(refresh=q.get("refresh") == "1"))
                if url.path == "/api/vix":
                    if q.get("refresh") == "1":
                        macro._vix_cache.clear()
                    return self._json(200, macro.vix_curve())
                if url.path == "/api/cot":
                    return self._json(200, macro.cot(force=q.get("refresh") == "1"))
                return self._json(200, macro.cot_history(q.get("key", "ES")))
            except (LookupError, ValueError, ConnectionError) as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": f"Internal error: {e}"})
        if url.path != "/api/gex":
            return super().do_GET()
        try:
            dte = q.get("dte", "45")
            spot = q.get("spot")
            res = gex_engine.compute(
                q.get("symbol", "SPX"),
                max_dte=gex_engine.dte_arg(dte),
                window_pct=_range(q.get("range", "5")),
                spot_override=float(spot.replace(",", ".")) if spot else None,
                force=q.get("refresh") == "1",
                combine=q.get("combine") == "1",
                positioning="flow" if q.get("pos") == "flow" else "standard",
                model="gexbot" if q.get("model") == "gexbot" else "spotgamma",
            )
            self._json(200, res)
        except (LookupError, ValueError, ConnectionError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {"error": f"Internal error: {e}"})


def _do_post(self):
    path = urlparse(self.path).path
    try:
        if path == "/api/login":
            if not auth.enabled():
                return self._json(200, {"ok": True})
            b = self._body()
            token, err = auth.login(b.get("user", ""), b.get("password", ""), self._ip())
            if not token:
                return self._json(401, {"error": err})
            body = json.dumps({"ok": True}).encode("utf-8")
            self.send_response(200)
            secure = "; Secure" if os.environ.get("GEX_SECURE") == "1" else ""
            self.send_header("Set-Cookie", f"{auth.COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
                                           f"Max-Age={auth.SESSION_DAYS * 86400}{secure}")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        user = self._guard(path)
        if user is None:
            return
        if path == "/api/logout":
            auth.logout(self._token())
            auth.clear_cache()
            self.send_response(200)
            self.send_header("Set-Cookie", f"{auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/api/watchlist":
            return self._json(200, gex_engine.save_watchlist(self._body().get("symbols", []), path=self._wl_path(user)))
        if path == "/api/prefs":
            if not auth.enabled():
                return self._json(200, {})
            return self._json(200, auth.save_prefs(user, self._body().get("prefs", {})))
        return self._json(404, {"error": "not found"})
    except Exception as e:  # noqa: BLE001
        return self._json(400, {"error": str(e)})


Handler.do_POST = _do_post


def _do_head(self):
    if self._guard(urlparse(self.path).path) is None:
        return
    return SimpleHTTPRequestHandler.do_HEAD(self)


Handler.do_HEAD = _do_head


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys as _s
        if isinstance(_s.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # conexiones cortadas por el navegador: normales, sin traza en la consola
        super().handle_error(request, client_address)


def free_port(preferred: int = 8765) -> int:
    for p in [preferred] + list(range(8766, 8800)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0


def main():
    server_mode = "--server" in sys.argv  # servicio en el servidor: puerto fijo, sin navegador
    port = int(os.environ.get("GEX_PORT", "8765")) if server_mode else free_port(int(os.environ.get("GEX_PORT", "8765")))
    srv = Server(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    print(f"\n  GEX Lab en marcha  ->  {url}\n  Cierra esta ventana para detenerlo.\n")
    threading.Thread(target=gex_engine.load_symbols, daemon=True).start()  # precarga el buscador
    if "--no-browser" not in sys.argv and not server_mode:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
