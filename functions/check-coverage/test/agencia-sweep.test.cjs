// Disparador del barrido de pedidos por agencia: solo con pendientes, como maximo cada 10 minutos.
// Correr: node functions/check-coverage/test/agencia-sweep.test.cjs
const assert = require("assert");
const calls = [];
globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null }); return new Response("{}"); };
require("../index.js");
const { maybeSweepAgencia } = globalThis.__aurelaCheckCoverage;
const kv = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, m }; };

(async () => {
  let env = { KAPSO_API_KEY: "k", KV: kv() };
  await maybeSweepAgencia(env);
  assert.strictEqual(calls.length, 0, "sin pendientes no llama");
  await env.KV.put("agencia_pend_index", JSON.stringify(["c1"]));
  await maybeSweepAgencia(env);
  assert.strictEqual(calls.length, 1, "con pendientes llama");
  assert.match(calls[0].url, /\/functions\/7b63c9c1-4405-4e86-876a-f7fccf7daa12\/invoke$/);
  assert.deepStrictEqual(calls[0].body, { agenciaSweep: true });
  await maybeSweepAgencia(env);
  assert.strictEqual(calls.length, 1, "no repite antes de 10 minutos");
  await env.KV.put("agencia_sweep_at", String(Date.now() - 11 * 60 * 1000));
  await maybeSweepAgencia(env);
  assert.strictEqual(calls.length, 2, "despues de 10 minutos vuelve a llamar");
  console.log("OK: disparador del barrido de agencia");
})().catch((e) => { console.error("FALLO:", e && e.stack || e); process.exit(1); });
