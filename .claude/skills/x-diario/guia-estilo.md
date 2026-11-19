# Guia de estilo de los posts para X

Lectores: gente de trading en X que sigue opciones, gamma y flujos. No todos saben que es un Call Wall: cada post se
entiende solo. En ingles.

## Forma
- 280 caracteres como maximo, contando espacios y saltos de linea. Mejor 180-260.
- Primera linea = gancho: la cifra o el hecho mas llamativo del dia, concreto. Es lo unico que se ve sin abrir el post.
  Bien: "$SPX moved 2x what options priced today." / "Dealers just flipped short gamma on $NDX."
  Mal: "Interesting day in the markets." / "Here's what you need to know."
- Lineas cortas separadas por saltos de linea. Nada de bloques densos.
- Cierra con lo que viene: un nivel para manana, el rango esperado o una pregunta concreta (no en todos los posts;
  como mucho uno de cada tres con pregunta).
- Cashtags: `$SPX`, `$NDX`, `$RUT`, `$VIX` y el ticker de la accion. Como mucho tres por post. Sin hashtags.
- Sin emojis, sin el caracter `·`, sin raya larga (—). Sin mayusculas para enfatizar ni signos de exclamacion seguidos.
- Varia el arranque de un dia para otro y entre posts del mismo dia.

## Contenido
- Cifras solo del paquete, redondeadas como se leen: niveles sin decimales con coma de miles (6,850), cambios con un
  decimal o dos (+1.2%), sigmas con uno (3.1σ), multiplos con uno (2.0x).
- Explica la mecanica en una frase cuando ayude: gamma positiva = los dealers frenan el movimiento (compran caidas,
  venden subidas); gamma negativa = lo amplifican. El flip es la frontera entre las dos zonas.
- `cambio_vs_esperado`: "moved 2.0x its implied move". `z` de acciones: "a 3.1σ move vs what options priced".
  `opciones_vs_media`: "5x its usual options volume". `percentil_1a` del VIX: "highest X% of the past year".
- `manana`: vencimiento mensual ("monthly opex Friday") y eventos con su hora ET ("CPI at 8:30 ET").
- Nunca recomendaciones de compra o venta ni objetivos de precio: posicionamiento, niveles y lo que se vigila.
- Si citas la causa de un movimiento, solo con fuente clara (paso 4 del skill); sin fuente, no se especula.
- Una idea por post. Si hay dos cosas fuertes, dos posts.

## Plantillas de partida (adaptarlas, no copiarlas)
Indices:
```
$SPX +1.2% today, 2.0x the move options priced.

Dealers are short gamma below 6,850, so moves get bigger there.

Friday: Call Wall 6,900, Put Wall 6,700.
Implied range ±0.8%.
```
Accion:
```
$NVDA +6.2% today. That's a 3.1σ move vs what options priced.

Options volume ran 5x its 20-day average.

Positive gamma above 190 could slow it down from here.
```
VIX:
```
$VIX +15.8% to 22.0 and the curve inverted: VIX9D 24 above VIX3M 21.

Near-term fear priced over long-term. That usually means hedging demand, not calm.
```

## Alt text
Una o dos frases que digan que muestra la imagen y sus cifras clave (para lectores de pantalla).
