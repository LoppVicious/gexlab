"use strict";
/* ============================================================ Modelo del mapa de liquidaciones (Crypto)
   Estima donde estan los precios de liquidacion de las posiciones apalancadas abiertas, como Coinglass o Hyblock:
   1. Posiciones nuevas de cada vela: la subida del open interest (USD, suma de los exchanges elegidos). Antes del
      primer dato de OI, el volumen de la vela por un factor calibrado con el tramo que si tiene OI.
   2. Largos y cortos: la parte del volumen agresor comprador (bv / v) son largos; el resto, cortos.
   3. Apalancamiento: cada posicion se reparte entre APAL (pesos supuestos). Liquidacion de un largo:
      precio * (1 - 1/L + MM); de un corto, precio * (1 + 1/L - MM). Precio de entrada: (max + min + cierre) / 3, y
      la cantidad se reparte entre las entradas posibles (la mitad central del rango de la vela).
   4. Un nivel vive hasta que el precio lo toca (min de una vela por debajo de un largo, max por encima de un corto):
      entonces cuenta como liquidacion prevista en esa vela y desaparece.
   5. Cuando el OI baja, todos los niveles vivos se reducen en la fraccion del OI total que desaparece (posiciones
      cerradas; opcion `nivel`, el OI de cada vela), y todos pierden
      fuerza con el tiempo (vida media en velas): una posicion de hace meses casi seguro que ya no existe.
   El calor de cada casilla (precio x vela) es lo vivo en ese tramo de precio en esa vela. Rejilla de precios
   logaritmica, para que sirva igual en 5 min que en diario desde 2019.
   Lo dibuja web/liq.js; lo prueba pruebas/test_liq.mjs con node (module.exports). */

const LQ_MODELO = (() => {
  const APAL = [{ L: 5, w: 0.1 }, { L: 10, w: 0.3 }, { L: 25, w: 0.3 }, { L: 50, w: 0.2 }, { L: 100, w: 0.1 }];
  const MM = 0.005;   // margen de mantenimiento aproximado
  const K_DEFECTO = 0.05;   // posiciones nuevas por USD negociado si no hay tramo con OI para calibrar
  const ANCHO = 0.5;   // fraccion del rango de la vela (a cada lado del precio medio) donde se reparten las entradas

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
    if (!n || !levs.length) return null;
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
    const altas = Array.from({ length: n }, () => []), bajas = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      if (!(nuevo[i] > 0)) continue;
      const v = velas[i], fc = v.v > 0 ? Math.min(1, Math.max(0, v.bv / v.v)) : 0.5;
      const largos = [], cortos = [];
      for (const x of levs) {
        const w = x.w / pw;
        const fL = 1 - 1 / x.L + mm, fS = 1 + 1 / x.L - mm;
        largos.push({ p: tip[i] * fL, a: nuevo[i] * fc * w, f: fL });
        cortos.push({ p: tip[i] * fS, a: nuevo[i] * (1 - fc) * w, f: fS });
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
      // cada nivel se reparte en la franja de precios de entrada posibles (la mitad central del rango de la vela):
      // no todos entraron al precio medio, y el mapa sale con bandas suaves en vez de escalones
      const eLo = tip[i] - (tip[i] - v.l) * ANCHO, eHi = tip[i] + (v.h - tip[i]) * ANCHO;
      for (const [lado, lista] of [[0, largos], [1, cortos]]) for (const x of lista) {
        if (!(x.a > 0)) continue;
        let b0 = binDe(eLo * x.f), b1 = binDe(eHi * x.f);
        const bc = binDe(x.p);
        if (bc < 0 && b0 < 0 && b1 < 0) continue;
        if (b0 < 0) b0 = bc >= 0 ? bc : 0;
        if (b1 < 0) b1 = bc >= 0 ? bc : B - 1;
        altas[i].push([lado, b0, b1, x.a]);
        if (x.fin != null) bajas[x.fin].push([lado, b0, b1, x.a, i]);
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
      for (let b = 0; b < B; b++) { SL[b] *= f; SS[b] *= f; }
      for (const [lado, b0, b1, a] of altas[t]) {
        const S = lado ? SS : SL, q = a / (b1 - b0 + 1);
        for (let b = b0; b <= b1; b++) S[b] += q;
      }
      for (const [lado, b0, b1, a, i] of bajas[t]) {
        const vivo = M[i] > 0 ? (a * m) / M[i] : 0, S = lado ? SS : SL, q = vivo / (b1 - b0 + 1);
        for (let b = b0; b <= b1; b++) S[b] = Math.max(0, S[b] - q);
        if (lado) predS[t] += vivo; else predL[t] += vivo;
      }
      total = 0;
      for (let b = 0; b < B; b++) { gL[b * n + t] = SL[b]; gS[b * n + t] = SS[b]; total += SL[b] + SS[b]; }
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
    return { n, B, bordes, gL, gS, predL, predS, finL: Float64Array.from(SL, (x) => x * eF), finS: Float64Array.from(SS, (x) => x * eF),
      desdeOI, k, calibrado: sOI > 0, escalado: conE.length > 0 };
  }

  // liquidez pendiente cerca del precio: cortos por encima y largos por debajo dentro de +-pct
  function presion(res, precio, pct) {
    let arriba = 0, abajo = 0;
    for (let b = 0; b < res.B; b++) {
      const p = Math.sqrt(res.bordes[b] * res.bordes[b + 1]);
      if (p > precio && p <= precio * (1 + pct)) arriba += res.finS[b] + res.finL[b];
      else if (p < precio && p >= precio * (1 - pct)) abajo += res.finL[b] + res.finS[b];
    }
    return { arriba, abajo, ratio: abajo > 0 ? arriba / abajo : null };
  }

  // grupos mas cargados por encima y por debajo del precio (maximos locales del perfil suavizado)
  // `lejos`: solo a menos de esa fraccion del precio; los picos de menos del 2 % del mayor no cuentan
  function grupos(res, precio, cuantos = 3, lejos = Infinity) {
    const v = Array.from({ length: res.B }, (_, b) => res.finL[b] + res.finS[b]);
    const s = v.map((_, b) => (v[b - 1] || 0) * 0.25 + v[b] * 0.5 + (v[b + 1] || 0) * 0.25);
    let picos = [];
    for (let b = 1; b < res.B - 1; b++) {
      const p = Math.sqrt(res.bordes[b] * res.bordes[b + 1]);
      if (Math.abs(p / precio - 1) > lejos) continue;
      if (s[b] > 0 && s[b] >= s[b - 1] && s[b] >= s[b + 1]) picos.push({ p, a: v[b - 1] + v[b] + v[b + 1] });
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

  return { APAL, MM, sumar, calcular, presion, grupos, ajuste };
})();

if (typeof module !== "undefined") module.exports = LQ_MODELO;
