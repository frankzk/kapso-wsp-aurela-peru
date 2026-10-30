// foto-seguimiento: misma secuencia que los mini-agentes (3ra foto, video, 4ta, 5ta). Correr: node functions/foto-seguimiento/test/foto.test.cjs
const assert = require("assert");
let SENT = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/products/x.js")) return { ok: true, json: async () => ({ title: "Producto X", images: ["i1", "i2", "i3"], media: [] }) };
  if (u.includes("/messages?conversation_id=")) return { ok: true, json: async () => ({ data: [] }) };
  if (u.endsWith("/messages") && opts.method === "POST") { SENT.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ messages: [{ id: "w" }] }) }; }
  return { ok: false, json: async () => ({}) };
};
require("../index.js");
const { handleRequest } = globalThis.__aurelaFotoSeguimiento;
function kv(init = {}) { const st = new Map(Object.entries(init)); return { st, get: async (k) => st.get(k) ?? null, put: async (k, v) => st.set(k, String(v)) }; }
const call = async (env, vars = {}, conv = "c1") => JSON.parse(await (await handleRequest(new Request("https://x/", { method: "POST", body: JSON.stringify({ execution_context: { context: { conversation_id: conv, phone_number: "51987654321" }, vars } }) }), env)).text());
(async () => {
  const lp = JSON.stringify({ title: "BeeWax", images: ["a", "b", "c", "d"], video: "v.mp4" });
  const env = { KAPSO_API_KEY: "k", KV: kv({ "last_product:c1": lp }) };
  const seq = [];
  for (let i = 0; i < 5; i++) { const r = await call(env); seq.push(r.sent); }
  assert.deepStrictEqual(seq, ["image", "video", "image", null, null], "3ra foto, video, 4ta foto; no hay 5ta ni mas");
  assert.deepStrictEqual(SENT.map((s) => s.image?.link || s.video?.link), ["c", "v.mp4", "d"]);
  assert.strictEqual(SENT[0].image.caption, "BeeWax"); assert.strictEqual(SENT[0].to, "51987654321");
  // Sin KV pero con las variables del flujo (como los mini-agentes)
  SENT = []; const env2 = { KAPSO_API_KEY: "k", KV: kv() };
  let r = await call(env2, { last_product_handle: "x", last_product_title: "Producto X" }, "c2");
  assert.deepStrictEqual([r.sent, SENT[0].image.link], ["image", "i3"]);
  // Sin producto: no manda nada
  SENT = []; r = await call({ KAPSO_API_KEY: "k", KV: kv() }, {}, "c3"); assert.deepStrictEqual([r.ok, r.sent, SENT.length], [true, null, 0]);
  console.log("foto.test: ok");
})().catch((e) => { console.error(e); process.exit(1); });
