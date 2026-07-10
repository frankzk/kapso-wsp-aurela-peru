#!/usr/bin/env node
// Test del freno de recordatorios por numero (cross-conversacion).
// Correr: node functions/check-coverage/test/throttle.test.cjs
const path = require("path");
require(path.join(__dirname, "..", "index.js"));
const assert = require("assert");
const { followupThrottleAllows, extractConversationId, extractCustomerPhone } = globalThis.__aurelaCheckCoverage;

function fakeKV(init = {}) {
  const store = new Map(Object.entries(init));
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, String(v)); } };
}

const PHONE = "51999888777";
const HOUR = 60 * 60 * 1000;

(async () => {
  // 1) Modelo de titularidad: la duena (convA) manda; convB (mismo numero) se suprime.
  let kv = fakeKV();
  let t = 1_000_000_000_000;
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "convA", t), true, "convA (primera) puede enviar");
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "convB", t + 60_000), false, "convB se suprime (convA es la duena)");
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "convA", t + 40 * 60_000), true, "convA sigue enviando su escalera");
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "convC", t + 41 * 60_000), false, "convC tambien se suprime");

  // 2) La titularidad caduca tras 8h de silencio de la duena -> otro hilo puede tomarla.
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "convB", t + 8 * HOUR + 42 * 60_000), true, "tras 8h de silencio, convB toma la titularidad");
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "convA", t + 8 * HOUR + 43 * 60_000), false, "ahora convA (la vieja duena) se suprime");

  // 3) Numeros distintos no se frenan entre si.
  kv = fakeKV();
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, "51111", "x", t), true);
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, "52222", "y", t + 1000), true, "otro numero envia libre");

  // 4) Sin id de conversacion: anti-rafaga (no dos en <10 min al mismo numero).
  kv = fakeKV();
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "", t), true, "sin id: primero pasa");
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "", t + 5 * 60_000), false, "sin id: 5 min despues se frena");
  assert.strictEqual(await followupThrottleAllows({ KV: kv }, PHONE, "", t + 12 * 60_000), true, "sin id: pasados 10 min vuelve a pasar");

  // 5) Sin KV o sin telefono -> no frena (comportamiento previo).
  assert.strictEqual(await followupThrottleAllows({}, PHONE, "convA", t), true, "sin KV no frena");
  assert.strictEqual(await followupThrottleAllows({ KV: fakeKV() }, "", "convA", t), true, "sin telefono no frena");

  // 6) Extraccion de telefono y id de conversacion desde el payload.
  const payload = {
    execution_context: { context: { phone_number: "51 987 654 321" } },
    whatsapp_context: { messages: [{ direction: "inbound", from: "51987654321", kapso: { whatsapp_conversation_id: "conv-xyz" } }] },
  };
  assert.strictEqual(extractCustomerPhone(payload, payload.execution_context), "51987654321", "extrae telefono (solo digitos)");
  assert.strictEqual(extractConversationId(payload, payload.execution_context), "conv-xyz", "extrae id desde whatsapp_conversation_id");
  const payload2 = { execution_context: { context: { phone_number: "519", conversation_id: "c-directo" } } };
  assert.strictEqual(extractConversationId(payload2, payload2.execution_context), "c-directo", "extrae id desde context.conversation_id");

  console.log("OK: freno de recordatorios por numero — todos los asserts pasan");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
