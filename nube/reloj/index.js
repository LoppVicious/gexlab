// GEX Lab - reloj: lanza el motor en GitHub Actions cada 15 minutos cuando hay algo que recoger.
// Dias de mercado (hora de Nueva York): 07:45-17:15 cada 15 min (pre-mercado, sesion y cierre) y 18:00, 20:00
// para reintentos del cierre. Sabado a las 10:00 un ciclo para dejar el estado del fin de semana al dia.
const REPO = "LoppVicious/gexlab";

function nyParts(d) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { wd: o.weekday, min: parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10) };
}

export function toca(d) {
  const { wd, min } = nyParts(d);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd);
  if (weekday && min >= 7 * 60 + 45 && min <= 17 * 60 + 15) return true;
  if (weekday && (min === 18 * 60 || min === 20 * 60)) return true;
  if (wd === "Sat" && min === 10 * 60) return true;
  return false;
}

async function lanzar(env) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/motor.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
      "User-Agent": "gexlab-reloj", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { modo: "ciclo" } }),
  });
  if (r.status !== 204) throw new Error(`GitHub respondio ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export default {
  async scheduled(event, env, ctx) {
    // el minuto programado (no el de ejecucion, que puede llegar unos segundos tarde)
    const d = new Date(event.scheduledTime);
    d.setUTCSeconds(0, 0);
    if (toca(d)) ctx.waitUntil(lanzar(env));
  },
};
