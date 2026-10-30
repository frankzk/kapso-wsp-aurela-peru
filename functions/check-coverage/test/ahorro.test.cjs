#!/usr/bin/env node
// Ahorro de mensajes de servicio: origen de la conversacion (anuncio | organico) y silencio ante un acuse de cierre.
// Correr: node functions/check-coverage/test/ahorro.test.cjs
const path = require("path");
const assert = require("assert");
let HIST = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  let data = HIST;
  if (u.includes("direction=inbound")) data = HIST.filter((m) => m.kapso.direction === "inbound");
  return { ok: true, status: 200, json: async () => ({ data }) };
};
require(path.join(__dirname, "..", "index.js"));
const { isClosingAck, routeFollowup } = globalThis.__aurelaCheckCoverage;
function fakeKV() { const st = new Map(); return { st, async get(k) { return st.has(k) ? st.get(k) : null; }, async put(k, v) { st.set(k, String(v)); } }; }
const T = 1_790_000_000;
const inb = (t, txt, extra = {}) => ({ type: "text", text: { body: txt }, timestamp: String(T + t), kapso: { direction: "inbound", content: txt }, ...extra });
const out = (t, txt) => ({ type: "text", text: { body: txt }, timestamp: String(T + t), kapso: { direction: "outbound", content: txt } });
const payload = (edges, vars = {}, conv = "conv-1") => ({ available_edges: edges, execution_context: { vars, system: {}, context: {} }, whatsapp_context: { conversation: { id: conv, phone_number_id: "pn" }, messages: [] } });
async function edge(edges, hist, vars, conv, env) { HIST = hist; const r = await routeFollowup(payload(edges, vars, conv), env); return JSON.parse(await r.text()); }

(async () => {
  // Acuses de cierre
  for (const t of ["ok", "Ok gracias", "GRACIAS!!", "listo", "👍", "🙏💪", "Perfecto", "muchas gracias"]) assert.ok(isClosingAck(inb(0, t)), t);
  for (const t of ["si", "sí", "claro", "dale", "ok y el precio?", "Lima", "no gracias", "4", "quiero 2"]) assert.ok(!isClosingAck(inb(0, t)), t);
  assert.ok(isClosingAck({ type: "reaction", kapso: { direction: "inbound", content: "Reacted with ❤️ to message" } }));
  assert.ok(!isClosingAck({ type: "button", button: { text: "Lima" }, kapso: { direction: "inbound" } }), "boton nunca es acuse");

  const env = { KAPSO_API_KEY: "x", KV: fakeKV() };
  const G = ["responder", "callar"];
  let r = await edge(G, [out(0, "Listo, tu pedido quedo registrado. *Codigo de pedido:* #AUR900120"), inb(30, "gracias")], {}, "c1", env);
  assert.strictEqual(r.next_edge, "callar", "gracias tras el codigo: no se contesta");
  r = await edge(G, [out(0, "¿Me confirmas tu direccion?"), inb(30, "ok")], {}, "c1", env);
  assert.strictEqual(r.next_edge, "responder", "ok tras una pregunta: se contesta");
  r = await edge(G, [out(0, "Te lo enviamos mañana."), inb(30, "si")], {}, "c1", env);
  assert.strictEqual(r.next_edge, "responder", "un si nunca se calla");
  r = await edge(G, [out(0, "Va 1 unidad por S/ 79."), inb(30, "ok")], { stage: "esperando_confirmacion" }, "c1", env);
  assert.strictEqual(r.next_edge, "responder", "en etapa de cierre siempre se contesta");
  r = await edge(G, [out(0, "Te lo enviamos mañana."), inb(20, "ok"), inb(30, "y cuanto demora?")], {}, "c1", env);
  assert.strictEqual(r.next_edge, "responder", "el ultimo mensaje es una pregunta");
  r = await edge(G, [inb(0, "ok")], {}, "c1", env);
  assert.strictEqual(r.next_edge, "responder", "sin mensaje previo del bot");

  // Origen
  const O = ["anuncio", "organico"];
  r = await edge(O, [inb(0, "¡Hola! Quiero más información", { referral: { source_type: "ad", source_id: "1" } }), out(5, "hola")], {}, "c-ad", env);
  assert.strictEqual(r.next_edge, "anuncio");
  r = await edge(O, [inb(0, "Tengo una consulta | Aurela https://aurela.pe/products/x"), out(5, "hola")], {}, "c-web", env);
  assert.strictEqual(r.next_edge, "organico");
  assert.strictEqual(env.KV.st.get("origen:c-web"), "organico", "se guarda en KV");
  globalThis.fetch = async () => { throw new Error("caido"); };
  r = await edge(O, [], {}, "c-nueva", { KAPSO_API_KEY: "x", KV: fakeKV() });
  assert.strictEqual(r.next_edge, "anuncio", "si falla, no recorta nada");
  console.log("ahorro.test: ok");
})().catch((e) => { console.error(e); process.exit(1); });
