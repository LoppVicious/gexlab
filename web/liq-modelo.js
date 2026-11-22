"use strict";
/* ============================================================ Modelo del mapa de liquidaciones (Crypto)
   Estima donde estan los precios de liquidacion de las posiciones apalancadas abiertas, como Coinglass o Hyblock:
   1. Posiciones nuevas de cada vela: la subida del open interest (USD, suma de los exchanges elegidos). Antes del
      primer dato de OI, el volumen de la vela por un factor calibrado con el tramo que si tiene OI.
   2. Largos y cortos: la parte del volumen agresor comprador (bv / v) son largos; el resto, cortos.
   3. Apalancamiento: cada posicion se reparte entre APAL (pesos supuestos). Liquidacion de un largo:
      precio * (1 - 1/L + MM); de un corto, precio * (1 + 1/L - MM). Precio de entrada: (max + min + cierre) / 3, y
      con la opcion `ancho`, la cantidad se reparte entre las entradas posibles (parte central del rango de la vela).
   4. Un nivel vive hasta que el precio lo toca (min de una vela por debajo de un largo, max por encima de un corto):
      entonces cuenta como liquidacion prevista en esa vela y desaparece.
   5. Cuando el OI baja, todos los niveles vivos se reducen en la fraccion del OI total que desaparece (posiciones
      cerradas; opcion `nivel`, el OI de cada vela), y todos pierden
      fuerza con el tiempo (vida media en velas): una posicion de hace meses casi seguro que ya no existe.
   El calor de cada casilla (precio x vela) es lo vivo en ese tramo de precio en esa vela. Rejilla de precios
   logaritmica, para que sirva igual en 5 min que en diario desde 2019.
   Opcion `ver` (lista de apalancamientos): el reparto, la escala al OI y la escala de color se calculan siempre con
   todos los de `levs`; los que no estan en `ver` solo se quitan de lo que se dibuja y de la lectura (rejillas, perfil,
   niveles), asi ocultar uno no cambia el tamano ni el color de los demas. Las liquidaciones previstas cuentan todos.
   Lo dibuja web/liq.js; lo prueba pruebas/test_liq.mjs con node (module.exports). */

const LQ_MODELO = (() => {
  const APAL = [{ L: 5, w: 0.1 }, { L: 10, w: 0.3 }, { L: 25, w: 0.3 }, { L: 50, w: 0.2 }, { L: 100, w: 0.1 }];
  const MM = 0.005;   // margen de mantenimiento aproximado
  const VIVO_MIN = 0.25;   // un nivel se da por cerrado cuando le queda menos de esta fraccion (memoria y OI cerrado)
  const K_DEFECTO = 0.05;   // posiciones nuevas por USD negociado si no hay tramo con OI para calibrar

  // suma por tiempo la historia de varios simbolos de una respuesta de Coinalyze: campo de cada punto
  function sumar(resp, campo) {
    const m = new Map();
    for (const s of resp || []) for (const p of s.history || []) {
      const v = p[campo];
      if (v == null || !isFinite(v)) continue;
      m.set(p.t, (m.get(p.t) || 0) + v);
    }
    return m;
  }

  function calcular(velas, oi, o = {}) {
    const n = velas.length;
    const B = o.bins || 240, levs = (o.levs || APAL).filter((x) => x.w > 0), mm = o.mm ?? MM;
    const vida = Math.max(1, o.vida || 90), dec = Math.pow(0.5, 1 / vida);
    // o.ancho: fraccion del rango de la vela (a cada lado del precio medio) en que se reparte cada nivel; 0 (por
    // defecto) lo deja en un solo tramo: niveles nitidos
    const ancho = o.ancho || 0;
    const ver = o.ver ? new Set(o.ver.map(Number)) : null, visible = (L) => !ver || ver.has(L);
    if (!n || !levs.length || !levs.some((x) => visible(x.L))) return null;
    const pw = levs.reduce((a, x) => a + x.w, 0);
    const tip = velas.map((v) => (v.h + v.l + v.c) / 3);

    // calibracion del metodo por volumen con el tramo que tiene OI
    let sOI = 0, sVol = 0, desdeOI = -1;
    for (let i = 1; i < n; i++) {
      if (oi[i] == null || oi[i - 1] == null) continue;
      if (desdeOI < 0) desdeOI = i - 1;
      sOI += Math.max(0, oi[i] - oi[i - 1]); sVol += velas[i].v * tip[i];
    }
    const k = sOI > 0 && sVol > 0 ? sOI / sVol : K_DEFECTO;

    // rejilla de precios logaritmica que cubre los niveles posibles
    const minL = Math.min(...levs.map((x) => x.L));
    let lo = Infinity, hi = -Infinity;
    for (const v of velas) { if (v.l > 0 && v.l < lo) lo = v.l; if (v.h > hi) hi = v.h; }
    lo *= 1 - 1 / minL; hi *= 1 + 1 / minL;
    const lLo = Math.log(lo), lHi = Math.log(hi), paso = (lHi - lLo) / B;
    const bordes = Float64Array.from({ length: B + 1 }, (_, b) => Math.exp(lLo + b * paso));
    const binDe = (p) => { const b = Math.floor((Math.log(p) - lLo) / paso); return b >= 0 && b < B ? b : -1; };

    // posiciones nuevas y su lado
    const nuevo = new Float64Array(n), dOI = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i > 0 && oi[i] != null && oi[i - 1] != null) {
        dOI[i] = oi[i] - oi[i - 1];
        nuevo[i] = Math.max(0, dOI[i]);
      } else if (desdeOI < 0 || i < desdeOI) {
        nuevo[i] = velas[i].v * tip[i] * k;   // sin OI: volumen calibrado
      }
    }

    // niveles: altas por vela y bajas (vela en que el precio los toca)
    const altas = Array.from({ length: n }, () => []), bajas = Array.from({ length: n }, () => []), lista_ = [];
    for (let i = 0; i < n; i++) {
      if (!(nuevo[i] > 0)) continue;
      const v = velas[i], fc = v.v > 0 ? Math.min(1, Math.max(0, v.bv / v.v)) : 0.5;
      const largos = [], cortos = [];
      for (const x of levs) {
        const w = x.w / pw;
        const fL = 1 - 1 / x.L + mm, fS = 1 + 1 / x.L - mm;
        largos.push({ p: tip[i] * fL, a: nuevo[i] * fc * w, f: fL, vis: visible(x.L), L: x.L });
        cortos.push({ p: tip[i] * fS, a: nuevo[i] * (1 - fc) * w, f: fS, vis: visible(x.L), L: x.L });
      }
      // largos: el mas alto cae antes; se recorre hacia delante una vez con el minimo acumulado
      largos.sort((p, q) => q.p - p.p);
      let j = i + 1, mn = Infinity, kL = 0;
      while (kL < largos.length && j < n) {
        mn = Math.min(mn, velas[j].l);
        while (kL < largos.length && largos[kL].p >= mn) { largos[kL].fin = j; kL++; }
        j++;
      }
      cortos.sort((p, q) => p.p - q.p);
      let mx = -Infinity, kS = 0; j = i + 1;
      while (kS < cortos.length && j < n) {
        mx = Math.max(mx, velas[j].h);
        while (kS < cortos.length && cortos[kS].p <= mx) { cortos[kS].fin = j; kS++; }
        j++;
      }
      // con o.ancho, cada nivel se reparte en la franja de precios de entrada posibles (no todos entraron al precio
      // medio): bandas suaves; sin el, un solo tramo
      const eLo = tip[i] - (tip[i] - v.l) * ancho, eHi = tip[i] + (v.h - tip[i]) * ancho;
      for (const [lado, lista] of [[0, largos], [1, cortos]]) for (const x of lista) {
        if (!(x.a > 0)) continue;
        let b0 = binDe(eLo * x.f), b1 = binDe(eHi * x.f);
        const bc = binDe(x.p);
        if (bc < 0 && b0 < 0 && b1 < 0) continue;
        if (b0 < 0) b0 = bc >= 0 ? bc : 0;
        if (b1 < 0) b1 = bc >= 0 ? bc : B - 1;
        altas[i].push([lado, b0, b1, x.a, x.vis]);
        if (x.fin != null) bajas[x.fin].push([lado, b0, b1, x.a, i, x.vis]);
        lista_.push([i, x.fin ?? n, x.p, lado, x.a, x.vis, x.L]);
      }
    }

    // recurrencia por tramo de precio: decae, se reduce si baja el OI, suma altas y resta las tocadas
    const gL = new Float32Array(B * n), gS = new Float32Array(B * n);
    const SL = new Float64Array(B), SS = new Float64Array(B), M = new Float64Array(n);
    const predL = new Float64Array(n), predS = new Float64Array(n), escala = new Float64Array(n);
    let m = 1, total = 0;
    for (let t = 0; t < n; t++) {
      // posiciones cerradas: la fraccion del OI total que desaparece (o.nivel: OI de la vela anterior; sin el, lo
      // vivo del modelo). Suelo de 0,05: con 0 el factor acumulado seria 0 y los niveles posteriores no se podrian restar
      const base = o.nivel && o.nivel[t - 1] > 0 ? o.nivel[t - 1] : total;
      const r = dOI[t] < 0 && base > 0 ? Math.max(0.05, 1 - -dOI[t] / base) : 1;
      const f = dec * r;
      m *= f; M[t] = m;
      // total: lo vivo de todos los apalancamientos (para la escala); SL y SS: solo los visibles
      for (let b = 0; b < B; b++) { SL[b] *= f; SS[b] *= f; }
      total *= f;
      for (const [lado, b0, b1, a, vis] of altas[t]) {
        total += a;
        if (!vis) continue;
        const S = lado ? SS : SL, q = a / (b1 - b0 + 1);
        for (let b = b0; b <= b1; b++) S[b] += q;
      }
      for (const [lado, b0, b1, a, i, vis] of bajas[t]) {
        const vivo = M[i] > 0 ? (a * m) / M[i] : 0;
        total = Math.max(0, total - vivo);
        if (lado) predS[t] += vivo; else predL[t] += vivo;
        if (!vis) continue;
        const S = lado ? SS : SL, q = vivo / (b1 - b0 + 1);
        for (let b = b0; b <= b1; b++) S[b] = Math.max(0, S[b] - q);
      }
      for (let b = 0; b < B; b++) { gL[b * n + t] = SL[b]; gS[b * n + t] = SS[b]; }
      // escala: el cambio de OI de una vela es neto (lo que se abre y se cierra dentro se anula), asi que el modelo
      // acierta la forma pero no el tamano. Cada posicion abierta tiene su precio de liquidacion: con el OI de la vela
      // (o.nivel), lo vivo se escala para sumar ese OI
      escala[t] = o.nivel && o.nivel[t] > 0 && total > 0 ? o.nivel[t] / total : NaN;
    }
    // sin OI (antes de su primer dato): la escala mediana del tramo con OI, para que el calor no salte
    const conE = Array.from(escala).filter((x) => isFinite(x)).sort((a, b) => a - b);
    const med = conE.length ? conE[Math.floor(conE.length / 2)] : 1;
    for (let t = 0; t < n; t++) {
      const e = isFinite(escala[t]) ? escala[t] : med;
      escala[t] = e;
      if (e === 1) continue;
      predL[t] *= e; predS[t] *= e;
      for (let b = 0; b < B; b++) { gL[b * n + t] *= e; gS[b * n + t] *= e; }
    }
    const eF = escala[n - 1] || 1;
    // niveles sueltos para dibujarlos como franjas de color fijo: inicio, fin (vela en que el precio lo toca o en que
    // la memoria lo da por cerrado: le queda menos de VIVO_MIN de lo que nacio), precio, lado y tamano al nacer (USD,
    // con la escala del OI). M solo baja: el fin por memoria sale de una busqueda binaria
    const vis_ = lista_.filter((x) => x[5]);
    const N = vis_.length, nivI = new Int32Array(N), nivFin = new Int32Array(N), nivP = new Float64Array(N),
      nivLado = new Uint8Array(N), nivA = new Float64Array(N), nivToque = new Int32Array(N), nivL = new Uint8Array(N);
    vis_.forEach(([i, fin, pr, lado, a, , L], k) => {
      nivToque[k] = fin; nivL[k] = L;
      const corte = M[i] * VIVO_MIN;
      let lo = i + 1, hi = n;   // primera vela con M < corte
      while (lo < hi) { const mid = (lo + hi) >> 1; if (M[mid] < corte) hi = mid; else lo = mid + 1; }
      nivI[k] = i; nivFin[k] = Math.min(fin, lo); nivP[k] = pr; nivLado[k] = lado; nivA[k] = a * (escala[i] || 1);
    });
    // rejilla de dibujo: en cada tramo y vela, la suma de los niveles vivos. En el mapa un nivel solo desaparece
    // cuando el precio lo toca (la memoria cuenta para el perfil y la lectura, no aqui), con su tamano al nacer
    // limitado por el OI: si el OI total ha llegado a bajar a una fraccion del que habia al nacer, como mucho esa
    // fraccion de sus posiciones sigue abierta (minimo desde que nacio; una vela suelta a la baja no cuenta, suele ser
    // un hueco de datos). Sin ese tope, los niveles de una epoca de OI alto (que nunca se tocaron) dominaban la escala
    const oiEf = o.nivel ? Float64Array.from({ length: n }, (_, t) => Math.max(o.nivel[t] || 0, o.nivel[t + 1] || 0)) : null;
    const desdeE = Math.min(Math.max(0, o.escalaDesde || 0), n - 1);
    const cada = Math.max(1, Math.floor((B * (n - desdeE)) / 60000));
    const rejilla = (niveles, muestra) => {
      const g = new Float32Array(B * n);
      for (const [i, toque, pr, , a] of niveles) {
        const b = binDe(pr), aE = a * (escala[i] || 1), base = oiEf && oiEf[i] > 0 ? oiEf[i] : 0;
        if (b < 0) continue;
        let f = 1;
        for (let t = i; t < toque; t++) {
          if (base && oiEf[t] > 0 && oiEf[t] < base * f) f = oiEf[t] / base;
          g[b * n + t] += aE * f;
        }
      }
      if (muestra) for (let b = 0; b < B; b++) for (let t = desdeE; t < n; t++) {
        const v = g[b * n + t];
        if (v > 0 && (b * n + t) % cada === 0) muestra.push(v);
      }
      return g;
    };
    // escala fija del mapa (percentil 99,9 de las casillas con algo, con todos los apalancamientos, desde
    // o.escalaDesde: la ventana que se ve al abrir): no depende del zoom ni de los apalancamientos que se ven
    const muestra = [];
    const gTodo = rejilla(lista_, muestra);
    const gV = vis_.length === lista_.length ? gTodo : rejilla(vis_, null);
    muestra.sort((x, y) => x - y);
    const topeV = muestra.length ? muestra[Math.min(muestra.length - 1, Math.floor(muestra.length * 0.999))] : 1;
    return { n, B, bordes, gL, gS, gV, topeV, predL, predS, finL: Float64Array.from(SL, (x) => x * eF), finS: Float64Array.from(SS, (x) => x * eF),
      niveles: { N, i: nivI, fin: nivFin, p: nivP, lado: nivLado, a: nivA, toque: nivToque, L: nivL }, oiEf,
      desdeOI, k, calibrado: sOI > 0, escalado: conE.length > 0 };
  }

  // tamano en el mapa del nivel k en la vela t (el de la rejilla gV): al nacer, por el tope del OI que sigue abierto
  function enMapa(res, k, t) {
    const nv = res.niveles, i = nv.i[k];
    if (t < i || t >= nv.toque[k]) return 0;
    const o = res.oiEf, base = o && o[i] > 0 ? o[i] : 0;
    let f = 1;
    if (base) for (let s = i; s <= t; s++) if (o[s] > 0 && o[s] < base * f) f = o[s] / base;
    return nv.a[k] * f;
  }

  // lo que el mapa pinta ahora: la ultima columna de gV por tramo (niveles vivos de los apalancamientos que se ven),
  // sin lo que no pasa `umbral` (USD; la intensidad minima). Lectura, lineas y perfil salen de aqui, asi que nunca
  // senalan un precio sin franja. Por encima del precio solo quedan cortos y por debajo largos: un nivel que el precio
  // cruza ya esta tocado
  function ahora(res, umbral = 0) {
    const v = new Float64Array(res.B), t = res.n - 1;
    for (let b = 0; b < res.B; b++) { const x = res.gV[b * res.n + t]; if (x > umbral) v[b] = x; }
    return v;
  }

  // liquidez pendiente cerca del precio: cortos por encima y largos por debajo dentro de +-pct
  function presion(res, precio, pct, umbral = 0) {
    const v = ahora(res, umbral);
    let arriba = 0, abajo = 0;
    for (let b = 0; b < res.B; b++) {
      const p = Math.sqrt(res.bordes[b] * res.bordes[b + 1]);
      if (p > precio && p <= precio * (1 + pct)) arriba += v[b];
      else if (p < precio && p >= precio * (1 - pct)) abajo += v[b];
    }
    return { arriba, abajo, ratio: abajo > 0 ? arriba / abajo : null };
  }

  // grupos mas cargados por encima y por debajo del precio (maximos locales del perfil suavizado, en el precio del tramo
  // mas cargado del pico, que siempre tiene franja). `lejos`: solo a menos de esa fraccion del precio; los picos de
  // menos del 2 % del mayor no cuentan
  function grupos(res, precio, cuantos = 3, lejos = Infinity, umbral = 0) {
    const v = ahora(res, umbral);
    const s = v.map((_, b) => (v[b - 1] || 0) * 0.25 + v[b] * 0.5 + (v[b + 1] || 0) * 0.25);
    let picos = [];
    for (let b = 1; b < res.B - 1; b++) {
      if (!(s[b] > 0 && s[b] >= s[b - 1] && s[b] >= s[b + 1])) continue;
      const c = v[b] >= v[b - 1] && v[b] >= v[b + 1] ? b : v[b - 1] >= v[b + 1] ? b - 1 : b + 1;
      const p = Math.sqrt(res.bordes[c] * res.bordes[c + 1]);
      if (Math.abs(p / precio - 1) > lejos || picos.some((x) => x.c === c)) continue;
      picos.push({ p, c, a: v[b - 1] + v[b] + v[b + 1] });
    }
    const mx = Math.max(0, ...picos.map((x) => x.a));
    picos = picos.filter((x) => x.a >= mx * 0.02);
    const arriba = picos.filter((x) => x.p > precio).sort((p, q) => q.a - p.a).slice(0, cuantos).sort((p, q) => p.p - q.p);
    const abajo = picos.filter((x) => x.p < precio).sort((p, q) => q.a - p.a).slice(0, cuantos).sort((p, q) => q.p - p.p);
    return { arriba, abajo };
  }

  // acierto: correlacion (log) entre liquidaciones previstas y reales por vela, solo velas con dato real
  function ajuste(pred, real) {
    const xs = [], ys = [];
    for (let i = 0; i < pred.length; i++) {
      if (real[i] == null) continue;
      xs.push(Math.log1p(pred[i])); ys.push(Math.log1p(real[i]));
    }
    const n = xs.length;
    if (n < 20) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx > 0 && syy > 0 ? { r: sxy / Math.sqrt(sxx * syy), n } : null;
  }

  return { APAL, MM, sumar, calcular, enMapa, ahora, presion, grupos, ajuste };
})();

if (typeof module !== "undefined") module.exports = LQ_MODELO;
