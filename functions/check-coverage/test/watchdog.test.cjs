#!/usr/bin/env node
// Test del watchdog de clientes sin respuesta (KV + fetch mockeados).
// Correr: node functions/check-coverage/test/watchdog.test.cjs
const path = require("path");
require(path.join(__dirname, "..", "index.js"));
const assert = require("assert");
const { maybeRunWatchdog } = globalThis.__aurelaCheckCoverage;

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// Conversaciones simuladas: 1 candidata real, 1 respondida, 1 trivial, 1 reciente, 1 reaccion.
const CONVOS = [
  { id: "c-esperando", phone_number: "51911111111", kapso: { contact_name: "Daph", last_inbound_at: iso(25 * 60000), last_outbound_at: iso(60 * 60000), last_message_text: "o no vendes?" } },
  { id: "c-respondida", phone_number: "51922222222", kapso: { contact_name: "Ana", last_inbound_at: iso(30 * 60000), last_outbound_at: iso(20 * 60000), last_message_text: "quiero 2" } },
  { id: "c-trivial", phone_number: "51933333333", kapso: { contact_name: "Luis", last_inbound_at: iso(40 * 60000), last_outbound_at: iso(70 * 60000), last_message_text: "Ok gracias 😊" } },
  { id: "c-reciente", phone_number: "51944444444", kapso: { contact_name: "Mia", last_inbound_at: iso(5 * 60000), last_outbound_at: iso(50 * 60000), last_message_text: "y el precio?" } },
  { id: "c-reaccion", phone_number: "51955555555", kapso: { contact_name: "Leo", last_inbound_at: iso(30 * 60000), last_outbound_at: iso(45 * 60000), last_message_text: "Reacted with 👍 to message wamid.X" } },
];

let telegramSent = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/whatsapp/conversations")) {
    // Solo el primer numero devuelve datos; el segundo, vacio.
    const data = u.includes("1241790819006805") ? CONVOS : [];
    return { ok: true, json: async () => ({ data, paging: { cursors: { after: null } } }) };
  }
  if (u.includes("api.telegram.org")) {
    telegramSent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

(async () => {
  // 1) Sin credenciales -> no corre, no rompe.
  let kv = fakeKV();
  let r = await maybeRunWatchdog({ KV: kv }, { force: true });
  assert.strictEqual(r.reason, "missing_credentials");

  // 2) Con credenciales (via KV seed) -> alerta SOLO la candidata real.
  kv = fakeKV({ KAPSO_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" });
  telegramSent = [];
  r = await maybeRunWatchdog({ KV: kv }, { force: true });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.alerted, 1, `esperaba 1 alertada, hubo ${r.alerted}`);
  assert.strictEqual(telegramSent.length, 1);
  assert.ok(telegramSent[0].text.includes("Daph"), "la alerta debe incluir a Daph");
  assert.ok(telegramSent[0].text.includes("o no vendes?"), "la alerta debe incluir el texto");
  assert.ok(!telegramSent[0].text.includes("Luis"), "no debe alertar cierres triviales");
  assert.ok(!telegramSent[0].text.includes("Mia"), "no debe alertar silencios <15 min");

  // 3) Dedupe: segundo barrido no re-alerta la misma conversacion.
  telegramSent = [];
  r = await maybeRunWatchdog({ KV: kv }, { force: true });
  assert.strictEqual(r.alerted, 0, "dedupe debe evitar re-alertar");
  assert.strictEqual(telegramSent.length, 0);

  // 4) Compuerta: sin force, un barrido reciente bloquea el siguiente.
  r = await maybeRunWatchdog({ KV: kv });
  assert.ok(["gated", "quiet_hours"].includes(r.reason), `compuerta o silencio, hubo: ${r.reason}`);

  // 5) Sin KV -> no rompe.
  r = await maybeRunWatchdog({});
  assert.strictEqual(r.reason, "no_kv");

  console.log("OK: watchdog — todos los asserts pasaron");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
