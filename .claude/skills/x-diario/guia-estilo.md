# Guia de estilo de los posts para X

Lectores: gente de trading en X que sigue opciones, gamma y flujos. Escribimos como una mesa de derivados que tiene
opinion: cada post se entiende solo, dice que paso, por que importa y hacia donde se inclina la balanza. En ingles.

## La lectura del dia (antes de escribir)
Decide si el dia es **alcista**, **bajista** o **de transicion** y sostenlo en todo el texto. Senales:
- Indices: cambio frente al movimiento implicito (`cambio_vs_esperado` > 1.3 es un dia con conviccion), regimen de
  gamma y si cambio respecto a ayer (negativo = movimientos amplificados, positivo = mercado frenado), distancia al
  flip y a los muros, niveles que se movieron.
- VIX: sube con el mercado bajando = miedo real; curva invertida (VIX9D o VIX por encima de VIX3M) = estres de corto
  plazo; VIX bajando con el mercado subiendo = alivio. Percentil del ano para dar escala.
- Amplitud: sectores en verde, igual ponderado (RSP) frente a SPY, small caps (IWM) frente a SPY, y despues del
  historial cuantos de ~470 valores subieron. Un indice arriba con 3 de 11 sectores en verde es un rally estrecho; 1 de
  11 con el indice abajo es venta generalizada.
- Mercados cruzados: 10 anos en pb (tipos arriba con bolsa abajo = presion de tipos), bonos largos (TLT), credito
  (HYG: si el high yield cae, el riesgo es real), dolar, oro (refugio), petroleo, crypto (apetito de riesgo; spot 24 h).
  Busca la coherencia: risk-off limpio (bolsa, crypto y high yield abajo, oro y dolar arriba) o senales que chocan.
- Proxima sesion: opex mensual (mucha gamma vence y libera el mercado), eventos de importancia 3.
Cuando las senales chocan, eso es la historia ("SPX green, but VIX won't come in").

## Tono
- Con conviccion y con sentimiento: que se note si el dia fue de compradores o de vendedores. Nada de notas planas que
  solo enumeran cifras. Cada post tiene una tesis.
- Bajista: "sellers in control", "no bid", "bears pressed it into the close", "dealers are chasing it lower",
  "the floor is 7,000 and it's getting tested", "this is where squeezes start, and they start lower".
- Alcista: "buyers stepped in", "dip got bought hard", "dealers are pinning it higher", "squeeze fuel above the flip",
  "calls are getting paid", "the path of least resistance is up while we hold X".
- De transicion: "tug of war at the flip", "market is waiting for X", "coiled", "range day inside the walls".
- La conviccion va unida a un nivel: "bearish below 7,000, neutral back above 7,150". Lectura con condicion, no
  profecia.
- Profesional: vocabulario de mesa (gamma, flip, walls, dealer hedging, vol, skew, term structure, opex, pin), pero
  cada concepto raro se entiende por el contexto. Nada de jerga vacia ni hype ("to the moon", "massive", "insane").
- Nunca recomendaciones de compra o venta ni objetivos de precio. La lectura es de posicionamiento y flujos; el
  sentimiento es del mercado, no un consejo.

## Forma
- 280 caracteres como maximo por post, contando espacios y saltos de linea. Mejor 180-270.
- Primera linea = gancho con la tesis y una cifra concreta. Es lo unico que se ve sin abrir el post.
  Bien: "Sellers owned the tape. $SPX -2.0%, 1.4x what options priced." / "The gap is getting sold. $NDX gave back
  the whole +0.6% open by 10:00."
  Mal: "Interesting day in the markets." / "Here's what you need to know."
- Lineas cortas separadas por saltos de linea.
- Hilos: el primer post funciona solo (tesis, cifra, imagen). Los siguientes amplian.
  - Conclusion del dia: 1) tesis e indices; 2) que cambio en el posicionamiento (regimen, niveles); 3) VIX y amplitud;
    4) mercados cruzados y la conclusion.
  - Playbook: 1) lectura base para manana y el nivel que la invalida; 2) mapa de niveles con lo que se espera en cada
    uno (soporte, iman, aceleracion); 3) escenarios con condicion ("hold X and…, lose Y and…"); 4) agenda y opex.
- Cashtags: `$SPX`, `$NDX`, `$VIX`, `$RUT` y el ticker. Como mucho tres por post. Sin hashtags.
- Sin emojis, sin el caracter `·`, sin raya larga (—). Sin mayusculas para enfatizar ni varias exclamaciones.
- Pregunta final como mucho en uno de cada tres posts, y concreta ("Does 7,000 hold into opex?").
- Varia arranques y estructuras de un dia para otro: revisa los textos del dia anterior.

## Cifras
- Solo de los datos. Niveles sin decimales y con coma de miles (6,850); cambios con uno o dos decimales (+1.2%);
  sigmas con uno (3.1σ); multiplos con uno (2.0x); VIX con dos decimales.
- `cambio_vs_esperado`: "moved 1.4x what options priced". `z`: "a 3.9σ move". `opciones_vs_media`: "4.6x its usual
  options volume". `percentil_1a` del VIX: "top 1% of the past year". El 10 anos en pb ("+13 bp to 4.25%"); crypto spot
  "over 24h".
- Eventos con su hora ET ("CPI at 8:30 ET") y, si ya salieron, el dato frente a la prevision.
- Causa de un movimiento solo con fuente clara de ese dia.

## Ejemplos (adaptarlos, no copiarlos)
Conclusion, bajista:
```
Sellers owned the tape. $SPX -2.0%, $NDX -2.2%, and SPX moved 1.4x what options priced.

All three indices closed in negative gamma. Dealers now hedge with the move, not against it.
```
```
Breadth says this wasn't a few names. 1 of 11 sectors green, equal-weight lagged SPY, small caps worse.

The only bid: utilities and gold. That's a defensive tape.
```
```
$VIX +15.8% to 28.44, top 1% of the past year, and the curve inverted: VIX9D over VIX3M.

10Y +13 bp, bitcoin -5%. Risk-off across the board. Bears have the ball.
```
Playbook:
```
Playbook for Friday: bearish while $SPX is below 7,150.

Options price ±1.75%. Monthly opex clears a chunk of gamma, so expect the walls to matter less after the open.
```
```
The map:
7,000 Put Wall, the floor everyone is watching.
7,400 Vol Trigger. Below it dealers stay short gamma and moves extend.
7,515 flip, far away. Not a Friday story.
```
```
Scenarios:
Hold 7,000 into opex and this is a reset, not a break.
Lose it with VIX above 28 and the next leg starts there.
A reclaim of 7,150 flips the tone. 10:00 ET: UoM sentiment.
```

## Alt text
Una o dos frases con lo que muestra la imagen y sus cifras clave (para lectores de pantalla).

## Aprendido
- 2026-11-20: el usuario quiere profundidad y sentimiento, no textos planos. Cada dia, al cierre: conclusion de SPX,
  NDX y VIX (con amplitud, bonos, oro, crypto) y un playbook para la sesion siguiente. Sin post de apertura. El OHLC
  del dia (maximo, minimo, donde cerro en el rango) no aporta: no usarlo.
