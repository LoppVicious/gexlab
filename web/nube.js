// GEX Lab - adaptador de la version en la nube. Solo actua si el servidor es el de Cloudflare (GEX_ME.nube).
// La app sigue llamando a las mismas rutas /api/... que en el PC; aqui se traducen:
//   - niveles y mapa: lo precalculado por el motor si existe; si no, se calcula en el navegador (motor-web.js)
//   - escaner, validacion, compass: los archivos de la lista del usuario
//   - curva VIX, COT, resumen, recolector: los archivos publicados por el motor
"use strict";
(function () {
  const ME = window.GEX_ME;
  if (!ME || !ME.nube) return;
  const realFetch = window.fetch.bind(window);
  const PROXY = { SPX: "SPY", XSP: "SPY", NDX: "QQQ", RUT: "IWM", DJX: "DIA" };
  const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
  const status = (t) => { try { if (typeof setStatus === "function") setStatus("", t); } catch { /* sin barra de estado */ } };

  function normalize(s) {
    s = String(s || "").toUpperCase().trim().replace(/^[_^$]+/, "").replace(/[-/]/g, ".");
    return /^[A-Z][A-Z0-9.]{0,9}$/.test(s) ? s : null;
  }
  // mismo criterio que motor.py (rango_canon / vista_canon)
  function rango(r) {
    r = String(r == null ? "5" : r).trim().toLowerCase().replace(",", ".");
    if (r === "auto") return "auto";
    const v = Math.min(75, Math.max(0.3, parseFloat(r) || 5));
    return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  function vista(q, sym) {
    let dte = q.get("dte") || "45";
    if (!["0", "1", "7", "14", "30", "45", "all"].includes(dte)) dte = "45";
    const combo = q.get("combine") === "1" && PROXY[sym] ? "1" : "0";
    const pos = q.get("pos") === "flow" && combo === "0" ? "flow" : "standard";
    const s = q.get("session");
    const sess = ["auto", "last", "next"].includes(s) ? s : "auto";
    const model = q.get("model") === "gexbot" ? "gexbot" : "spotgamma";
    const lens = ["delta", "charm"].includes(q.get("lens")) ? q.get("lens") : "gamma";
    return { dte, range: rango(q.get("range")), pos, combo, sess, model, lens };
  }

  // ------------------------------------------------------------ motor del navegador
  let worker = null, seq = 0, warmed = false;
  const pending = new Map();
  function motor(op, args, paquetes) {
    if (!worker) {
      worker = new Worker("/motor-web.js");
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        e.data.ok ? p.resolve(e.data.json) : p.reject(new Error(e.data.error));
      };
      worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error("The in-browser engine could not start")); pending.clear(); worker = null; console.error(e); };
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, args, paquetes });
    });
  }

  // ------------------------------------------------------------ paquetes de cada ticker
  const paqMem = {};
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

  // datos viejos: los tickers de alguna lista se renuevan en cada ciclo; los demas solo cuando alguien los mira.
  // Si lo publicado es antiguo se ensena igualmente y se pide a la nube una version nueva en segundo plano.
  function viejo(edadS) {
    if (edadS == null || isNaN(edadS)) return false;
    const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const o = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const min = parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10);
    const lab = !["Sat", "Sun"].includes(o.weekday);
    if (lab && min >= 9 * 60 && min <= 16 * 60 + 45) return edadS > 25 * 60;
    // fuera de sesion no hay datos mas nuevos que los del ultimo cierre (16:00 ET del ultimo dia laborable): lo
    // publicado despues del cierre (el motor corre hasta las 17:15, a las 18:00 y a las 20:00) sigue valiendo
    const atras = { Mon: 3, Sun: 2, Sat: 1 }[o.weekday] || 1;
    const desdeCierre = lab && min >= 16 * 60 ? min - 16 * 60 : atras * 1440 + min - 16 * 60;
    return edadS / 60 > desdeCierre - 10;
  }
  const renovando = {};
  async function renovar(sym) {
    if (renovando[sym]) return;
    renovando[sym] = true;
    try {
      const antes = paqMem[sym] && paqMem[sym].data.generado;
      const pr = await realFetch("/api/pedir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: [sym] }) });
      if (!pr.ok) return;
      for (let i = 0; i < 16; i++) {          // hasta 4 min
        await sleep(15000);
        const r = await realFetch(`/api/pub/t/${encodeURIComponent(sym)}/paquete.json`);
        if (!r.ok) continue;
        const data = await r.json();
        if (data.generado === antes) continue;
        paqMem[sym] = { data, at: Date.now() };
        // si sigue en pantalla, se recarga en silencio con los datos nuevos
        try { if (typeof state !== "undefined" && state.symbol === sym && state.mode === "analysis" && typeof load === "function") load(false, true); } catch { /* */ }
        return;
      }
    } finally { renovando[sym] = false; }
  }

  async function paquete(sym, signal, fresh) {
    const hit = paqMem[sym];
    if (hit && !fresh && Date.now() - hit.at < 60000) return hit.data;
    let pedido = false;
    const t0 = Date.now();
    for (;;) {
      const r = await realFetch(`/api/pub/t/${encodeURIComponent(sym)}/paquete.json`, { signal });
      if (r.ok) {
        const data = await r.json();
        paqMem[sym] = { data, at: Date.now() };
        if (viejo(parseInt(r.headers.get("X-Edad"), 10))) renovar(sym);
        return data;
      }
      if (r.status !== 404) throw new Error((await r.json().catch(() => ({}))).error || "Could not read the data");
      if (!pedido) {
        const pr = await realFetch("/api/pedir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: [sym] }), signal });
        const d = await pr.json().catch(() => ({}));
        if (!pr.ok || d.ok === false) throw new Error(d.error || "Could not request the calculation in the cloud");
        pedido = true;
      }
      if (Date.now() - t0 > 240000) throw new Error(`The cloud calculation for ${sym} is taking longer than usual. Try again in a couple of minutes.`);
      status(`Downloading ${sym} in the cloud (the first time takes 1–2 min)…`);
      await sleep(8000, signal);
    }
  }

  const heatMemo = new Map();
  async function analisis(kind, q, signal) {
    const sym = normalize(q.get("symbol"));
    if (!sym) return json(400, { error: "Invalid ticker" });
    const v = vista(q, sym);
    const spot = q.get("spot");
    const refresh = q.get("refresh") === "1";
    if (!spot && !refresh) {
      const key = `${v.dte}_${v.range}_${v.pos}_${v.combo}` + (v.model === "gexbot" ? "_gb" : "") + (kind === "heat" ? `_${v.sess}` + (v.lens !== "gamma" ? `_${v.lens}` : "") : "");
      const r = await realFetch(`/api/pub/t/${encodeURIComponent(sym)}/${kind === "heat" ? "mapa" : "niveles"}/${key}.json`, { signal });
      if (r.ok) {
        // una vista precalculada antigua no se usa: se recalcula aqui con el paquete (y se pide renovarlo)
        if (!viejo(parseInt(r.headers.get("X-Edad"), 10))) return r;
        renovar(sym);
      }
    }
    const paqs = [await paquete(sym, signal, refresh)];
    if (v.combo === "1") paqs.push(await paquete(PROXY[sym], signal, refresh));
    const args = {
      symbol: sym, max_dte: v.dte === "all" ? null : parseInt(v.dte, 10), window_pct: v.range === "auto" ? "auto" : parseFloat(v.range),
      spot_override: spot ? parseFloat(spot) : null, combine: v.combo === "1", positioning: v.pos, model: v.model,
    };
    if (kind === "heat") { args.which = v.sess; args.lens = v.lens; }
    // el mapa (sobre todo Delta y Charm, que el motor no precalcula) no se repite con el mismo paquete: la recarga de
    // cada minuto solo lo recalcula cuando el motor publica datos nuevos
    const memo = kind === "heat" ? JSON.stringify(args) + "|" + paqs.map((p) => p.generado).join("|") : null;
    if (memo && heatMemo.has(memo)) return new Response(heatMemo.get(memo), { headers: { "Content-Type": "application/json" } });
    if (!warmed) status("Preparing the in-browser calculation (first time only)…");
    try {
      const out = await motor(kind === "heat" ? "heatmap" : "compute", args, paqs);
      warmed = true;
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (memo) {
        heatMemo.set(memo, out);
        if (heatMemo.size > 6) heatMemo.delete(heatMemo.keys().next().value);
      }
      return new Response(out, { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return json(400, { error: e.message });
    }
  }

  async function lista(file, signal, what) {
    const r = await realFetch(`/api/lista/${file}`, { signal });
    if (r.status === 404) return json(503, { error: `${what}: it is calculated with your list in the next engine cycle (15 min at most).` });
    return r;
  }
  // Escaner: el archivo del ultimo ciclo y, para los tickers de la lista que aun no estan (recien anadidos), su fila
  // calculada en el navegador con su paquete; el siguiente ciclo del motor ya los incluye
  async function escaner(q, signal) {
    const dte = q.get("dte") || "45";
    const r = await realFetch(`/api/lista/escaner_${dte}.json`, { signal });
    let d = { rows: [], computed_at: null };
    if (r.ok) d = await r.json();
    else if (r.status !== 404) return r;
    const want = (q.get("symbols") || "").split(",").map(normalize).filter(Boolean);
    const have = new Set(d.rows.map((x) => x.symbol));
    for (const sym of want.filter((x) => !have.has(x))) {
      try {
        status(`Scanner: calculating ${sym}…`);
        const p = await paquete(sym, signal, false);
        const out = await motor("scan_row", { symbol: sym, max_dte: dte === "all" ? null : parseInt(dte, 10) }, [p]);
        d.rows.push(JSON.parse(out));
      } catch (e) {
        if (e.name === "AbortError") throw e;
        d.rows.push({ symbol: sym, error: e.message });
      }
    }
    return json(200, d);
  }
  async function pub(file, signal, what) {
    const r = await realFetch(`/api/pub/${file}`, { signal });
    if (r.status === 404) return json(503, { error: `${what}: no engine data yet.` });
    return r;
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const q = url.searchParams, s = init.signal;
    switch (url.pathname) {
      case "/api/gex": return analisis("gex", q, s);
      case "/api/heatmap": return analisis("heat", q, s);
      case "/api/scan": return escaner(q, s);
      case "/api/validation": return lista(`validacion_${q.get("dte") || "45"}_${q.get("mode") === "flow" ? "flow" : "standard"}_${q.get("model") === "gexbot" ? "gexbot" : "spotgamma"}.json`, s, "Validation");
      case "/api/compass": return lista("compass.json", s, "Compass");
      case "/api/vix": return pub("vix.json", s, "VIX curve");
      case "/api/corr": return pub("correlacion.json", s, "Correlation");
      case "/api/cot": return pub("cot.json", s, "COT");
      case "/api/cot_history": return pub(`cot_hist/${encodeURIComponent(q.get("key") || "ES")}.json`, s, "COT");
      case "/api/summary": return pub("resumen.json", s, "Summary");
      case "/api/eventos": return pub("eventos.json", s, "Calendar");
      case "/api/vol": {
        const sym = normalize(q.get("symbol"));
        if (!sym) return json(400, { error: "Invalid ticker" });
        const url = `/api/pub/t/${encodeURIComponent(sym)}/vol.json`;
        let r = await realFetch(url, { signal: s });
        if (r.status === 404) {
          await paquete(sym, s, true);
          for (let i = 0; i < 4 && r.status === 404; i++) { await sleep(i ? 3000 : 0, s); r = await realFetch(url, { signal: s }); }
        }
        if (r.ok && viejo(parseInt(r.headers.get("X-Edad"), 10))) renovar(sym);
        return r;
      }
      case "/api/chain": {
        // cadena completa para Open Interest, Risk Engine y la calculadora: sale del paquete del ticker
        const sym = normalize(q.get("symbol"));
        if (!sym) return json(400, { error: "Invalid ticker" });
        const p = await paquete(sym, s, q.get("refresh") === "1");
        const f = p.files || {};
        const chain = f[`fx/${sym}.min.json`];
        if (!chain) return json(503, { error: `No option chain for ${sym} yet. Try again in a minute.` });
        return json(200, { symbol: sym, name: p.name || sym, generado: p.generado, chain,
          oiprev: f[`fx/oiprev_${sym.replace(".", "_")}.json`] || null, rate: f["fx/rate.json"] || null });
      }
      case "/api/collector": return pub("recolector.json", s, "Collector");
      default: return realFetch(input, init);
    }
  };

  // la administracion (usuarios, historial, estado) esta en /admin (admin.html y admin.js)
})();
