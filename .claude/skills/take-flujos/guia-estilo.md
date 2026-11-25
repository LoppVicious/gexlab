# Guia de estilo de la nota diaria de flujos

Lectores: los usuarios de GEX Lab, que conocen gamma, walls, flip y vol. Texto en ingles (la web esta en ingles).
Es una nota de estratega de flujos: dice que van a hacer los participantes mecanicos (dealers, ETFs apalancados,
vol-control, CTAs) segun por donde vaya el mercado, y que conclusion saca de eso. No resume el dia.

## Estructura
- Titulo: `Flows: <la conclusion en pocas palabras>` (por ejemplo `Flows: the downside is still the fragile side`).
- Entrada de dos o tres frases: la conclusion y la cifra que la sostiene. Si la tesis de ayer fallo o se cumplio
  con claridad, empieza por ahi.
- Tres a cinco secciones con encabezado `##` que ya diga la conclusion, no el nombre del bloque
  (`## Dealers sell every dip below 6,950`, no `## Dealer positioning`). Orden: de lo que mas pesa a lo que menos.
  Candidatas:
  - La asimetria: cuanto se venderia en una caida del 5 % frente a lo que se compraria en una subida igual, y quien
    lo hace. Es la idea central casi siempre.
  - Dealers: regimen de gamma, donde cambia (zero gamma), y que significa en la practica (venden en las caidas y
    compran en las subidas, o al reves).
  - El nivel clave: strikes con muchas puts encima o cerca del precio, a que vencimiento, y que pasa si el indice
    los supera y se mantiene (recompra de coberturas). Si las coberturas son largas (diciembre), decir que no se
    resuelve con el vencimiento mensual.
  - ETFs apalancados: lo que rebalancearon hoy al cierre y lo que suma cada 1 % mas.
  - Sistematicos: vol-control y CTAs, donde estan frente a su historia, que nivel de vol o de precio los haria
    comprar o vender. Si estan casi sin posicion, el riesgo tambien es al alza (tendrian que recomprar).
- Escenarios en los dos sentidos: que pasa si los catalizadores salen bien (vol cae, el indice recupera el nivel) y
  que pasa si no. Y que seria una senal preocupante (por ejemplo, que no rebote pese a tener todos los flujos a
  favor: entonces la venta no es solo tecnica).
- Cierre "What to watch": 3-5 puntos con niveles concretos del paquete y la fecha de los eventos que importan.
- 400-900 palabras.

## Tono
- Directo, con frases cortas y una conclusion clara en cada seccion. Explica la mecanica en una frase sencilla
  antes de dar la cifra ("To keep 3x exposure, these funds sell at the close when the index falls").
- Cifras redondeadas en dolares (`$8.2B`), con su percentil y su ventana cuando lo hay.
- Propio: nada que imite a un banco, a un analista concreto o su firma. No citar a terceros como si fueran fuente
  de los datos; las cifras son de GEX Lab.
- Sin recomendaciones de compra o venta: lectura de posicionamiento y flujos.
- Sin exageraciones ni mayusculas para enfatizar; sin emojis. No uses el caracter `·` como separador.

## Datos
- Solo cifras del paquete. Si un dato no esta, no se menciona.
- Lo que es estimacion se dice: vol-control (AUM supuesto), CTAs (modelo generico, sin dolares), dealers (convencion
  de posicionamiento del motor), escenarios de ETFs (mismo movimiento en todos los subyacentes).
- Noticias solo con enlace a la fuente, en Markdown `[texto](url)`.
- Markdown de Takes: encabezados, negrita, cursiva, listas y enlaces. No hay tablas: las tablas van en los graficos.
