"""Prueba visual: abre la web en modo PC con datos reales de CBOE y guarda capturas e informe en salida_visual/."""
import asyncio, os
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8765"
OUT = "salida_visual"
os.makedirs(OUT, exist_ok=True)
log = []


async def shot(pg, name):
    await pg.wait_for_timeout(1500)
    await pg.screenshot(path=f"{OUT}/{name}.png")


async def cargar(pg, sym):
    await pg.fill("#symbol", sym)
    await pg.press("#symbol", "Enter")
    await pg.keyboard.press("Escape"); await pg.evaluate("() => { const u = document.getElementById('suggest'); if (u) u.hidden = true; document.activeElement.blur(); }")
    await pg.wait_for_function("() => typeof state !== 'undefined' && state.data && state.data.symbol === '%s'" % sym, timeout=180000)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1700, "height": 950}, accept_downloads=True)
        pg.on("console", lambda m: log.append(f"{m.type}: {m.text}"))
        pg.on("pageerror", lambda e: log.append(f"pageerror: {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(3000)
        log.append("auto: " + str(await pg.evaluate("[state.range, state.auto]")))
        # TRACE SPX
        await pg.click("#navTrace"); await cargar(pg, "SPX")
        await pg.wait_for_timeout(8000); await shot(pg, "1_trace_strike")
        await pg.click('#mapSeg button[data-v="total"]'); await shot(pg, "2_trace_total")
        # Equity Hub NDX
        await pg.click("#navHub"); await cargar(pg, "SPX"); await shot(pg, "3_hub_ndx")
        await pg.click("#tabStrike"); await shot(pg, "4_strike_ndx")
        await pg.evaluate("() => zoomSet('strike', 0.35, 0.65)"); await shot(pg, "4b_strike_zoom")
        await pg.click("#tabHistory"); await shot(pg, "4c_historico")
        log.append("historico filas: " + str(await pg.evaluate("() => (state.data.history || {rows: []}).rows.length")))
        await pg.evaluate("() => { const s = document.getElementById('modelSeg'); s.querySelector('[data-v=gexbot]').click(); }")
        await pg.wait_for_timeout(6000); await shot(pg, "4d_historico_gexbot")
        log.append("historico gexbot filas: " + str(await pg.evaluate("() => (state.data.history || {rows: []}).rows.length")))
        await pg.evaluate("() => { const s = document.getElementById('modelSeg'); s.querySelector('[data-v=spotgamma]').click(); }")
        await pg.wait_for_timeout(4000)
        await pg.click("#tabStrike")
        log.append("rango auto: " + await pg.inner_text("#rangeAuto"))
        # informe
        try:
            async with pg.expect_download(timeout=120000) as dl:
                await pg.click("#reportBtn")
            await (await dl.value).save_as(f"{OUT}/5_informe.png")
        except Exception as e:  # noqa: BLE001
            log.append(f"informe: {e}")
            # el SVG del informe, para ver por que no carga como imagen
            svg = await pg.evaluate("""() => new Promise((res) => { const o = window.svgToPng; window.svgToPng = (svg) => { window.svgToPng = o; res(svg); }; exportReport(); })""")
            open(f"{OUT}/informe.svg", "w").write(svg)
        # volatilidad NDX
        await pg.click("#navVol"); await pg.wait_for_timeout(15000); await shot(pg, "6_vol_ndx")
        # Compass: tamano antes y despues de ocultar
        await pg.click("#navCompass"); await pg.wait_for_selector("#compass svg", timeout=240000)
        await pg.wait_for_timeout(2000)
        size = "() => { const e = document.querySelector('#compass'), s = e.querySelector('svg'); return [e.clientWidth, e.clientHeight, s.getAttribute('viewBox')]; }"
        log.append("compass antes: " + str(await pg.evaluate(size)))
        await shot(pg, "7_compass")
        await pg.click("#cBody tr:nth-child(2) .eye"); await pg.wait_for_timeout(1500)
        log.append("compass despues: " + str(await pg.evaluate(size)))
        await shot(pg, "8_compass_oculto")
        await pg.click("#cBody tr:nth-child(2) .eye")
        await b.close()
    open(f"{OUT}/log.txt", "w").write("\n".join(log))
    print("\n".join(log[-60:]))

asyncio.run(main())
