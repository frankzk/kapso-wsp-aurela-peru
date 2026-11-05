// Pedidos por agencia (Shalom/Olva): guardar pendiente, crear con voucher, crear solo a las 12 h sin voucher.
// fetch y KV mockeados. Correr: node functions/create-shopify-order/test/agencia.test.cjs
const assert = require("assert");

const CATALOG = { products: [
  { id: 9001, woo_id: 80, handle: "airclip-360", title: "AirClip 360™ – Mini Ventilador Recargable", options: [],
    variants: [{ id: 9101, woo_id: 80, title: "Default Title", available: true, price: "89.00" }] },
] };

const HOUR = 3600 * 1000;
let lastInboundTs = Date.now();
let inboundImage = false;
let stage = "esperando_voucher";
let nextOrder = 700;
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, method, body });
  if (u.startsWith("https://tienda.test/products.json")) return new Response(JSON.stringify(u.includes("page=1") ? CATALOG : { products: [] }));
  if (u === "https://tienda.test/wp-json/wc/v3/orders" && method === "POST") {
    nextOrder += 1;
    return new Response(JSON.stringify({ id: nextOrder, number: `AUR9${nextOrder}`, total: "89.00" }), { status: 201 });
  }
  if (/wc\/v3\/orders\/\d+\/notes$/.test(u)) return new Response("{}", { status: 201 });
  if (/wc\/v3\/orders\/\d+$/.test(u) && method === "GET") return new Response(JSON.stringify({ meta_data: [{ key: "kapta_tags", value: "kapso,agencia-shalom,adelanto-pendiente" }] }));
  if (/wc\/v3\/orders\/\d+$/.test(u) && method === "PUT") return new Response("{}");
  if (u.includes("/meta/whatsapp/v24.0/") && u.includes("direction=inbound")) {
    const data = [{ timestamp: String(Math.floor(lastInboundTs / 1000)), type: inboundImage ? "image" : "text", kapso: { phone_number: "51947071569" } }];
    return new Response(JSON.stringify({ data }));
  }
  if (u.includes("/executions?whatsapp_conversation_id=")) {
    const conv = decodeURIComponent(u.split("whatsapp_conversation_id=")[1].split("&")[0]);
    return new Response(JSON.stringify({ data: [{ id: `ex-${conv}`, status: "waiting", whatsapp_conversation_id: conv }] }));
  }
  if (u.includes("/workflow_executions/") && method === "GET") return new Response(JSON.stringify({ data: { execution_context: { vars: { stage } } } }));
  if (u.includes("/workflow_executions/") && method === "PATCH") return new Response(JSON.stringify({ data: { status: "ended" } }));
  if (u.includes("/functions/") && u.endsWith("/invoke")) return new Response(JSON.stringify({ ok: true }));
  return new Response("{}", { status: 404 });
};

function fakeKV() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, _m: m };
}

require("../index.js");
const api = globalThis.__aurelaCreateShopifyOrder;
const baseEnv = () => ({ STORE_BACKEND: "woocommerce", WOO_STORE_URL: "https://tienda.test/", WOO_CONSUMER_KEY: "ck", WOO_CONSUMER_SECRET: "cs", KAPSO_API_KEY: "k", KV: fakeKV() });
// Simula que los datos se guardaron hace `hours` horas (el reloj cuenta desde lo mas reciente: el ultimo mensaje del
// cliente o el guardado).
const ageEntry = async (env, conv, hours) => {
  const e = JSON.parse(await env.KV.get(`agencia_pend:${conv}`));
  e.savedAt = Date.now() - hours * HOUR;
  await env.KV.put(`agencia_pend:${conv}`, JSON.stringify(e));
};
const call = async (input, env) => (await api.handleRequest(new Request("https://x/", { method: "POST", body: JSON.stringify({ input }) }), env)).json();

const shalom = (conv, extra = {}) => ({
  conversationId: conv,
  courier: "shalom",
  customer: { name: "Diana Ramos Castro", phone: "947071569", agencia: "Shalom Pisco - Av. Fermin Tanguis", dni: "73700406", ...(extra.customer || {}) },
  items: [{ handle: "airclip-360", quantity: 1 }],
  coverage: { shippingMode: "agencia", district: "Pisco", province: "Pisco", region: "Ica" },
  ...extra.top,
});

(async () => {
  // Faltan datos: los pide, no guarda nada.
  let env = baseEnv();
  let r = await call(shalom("c-falta", { customer: { dni: "" } }), env);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "missing_fields");
  assert.ok(r.missing.some((m) => /DNI/.test(m)), "pide el DNI");
  assert.strictEqual(env.KV._m.size, 0, "sin datos completos no guarda");

  // Datos completos sin voucher: queda PENDIENTE (no crea pedido) y entra al indice.
  env = baseEnv();
  r = await call(shalom("c1"), env);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pending, true);
  assert.ok(!calls.some((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST"), "no crea el pedido todavia");
  assert.deepStrictEqual(JSON.parse(await env.KV.get("agencia_pend_index")), ["c1"]);

  // Barrido antes de las 12 h: no crea.
  lastInboundTs = Date.now() - 3 * HOUR;
  await ageEntry(env, "c1", 3);
  let sw = await call({ agenciaSweep: true }, env);
  assert.strictEqual(sw.ok, true);
  assert.ok(sw.results[0].dueInMin > 500, "faltan ~9 h");
  assert.ok(!calls.some((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST"));

  // 12 h desde el ultimo mensaje del cliente: crea SIN ADELANTO, corta el bot y avisa (sin dashboard).
  await ageEntry(env, "c1", 13);
  lastInboundTs = Date.now() - 12.5 * HOUR; // una imagen media hora despues de los datos del Yape
  inboundImage = true;
  sw = await call({ agenciaSweep: true }, env);
  assert.ok(sw.results[0].created, "crea el pedido: " + JSON.stringify(sw));
  const post = calls.filter((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST").pop().body;
  assert.strictEqual(post.status, "cod-pending", "mismo estado que los pedidos del bot");
  const tags = post.meta_data.find((m) => m.key === "kapta_tags").value;
  assert.match(tags, /agencia-shalom/);
  assert.match(tags, /adelanto-pendiente/);
  assert.doesNotMatch(tags, /contraentrega/);
  assert.match(post.billing.address_1, /Agencia Shalom: Shalom Pisco/);
  assert.strictEqual(post.billing.address_2, "DNI 73700406");
  const note = calls.filter((c) => /orders\/\d+\/notes$/.test(c.url)).pop().body.note;
  assert.match(note, /^SIN ADELANTO: 12 h sin voucher/);
  assert.match(note, /OJO: el cliente envio una imagen/);
  assert.ok(calls.some((c) => c.url.includes("/workflow_executions/ex-c1") && c.method === "PATCH"), "cierra el proceso del bot");
  const notify = calls.filter((c) => c.url.includes("/invoke")).pop().body;
  assert.strictEqual(notify.noDashboard, true);
  assert.match(notify.reason, /SIN ADELANTO/);
  assert.deepStrictEqual(JSON.parse(await env.KV.get("agencia_pend_index")), [], "sale del indice");

  // Si despues llega el voucher: no crea otro pedido, marca el existente.
  const before = calls.filter((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST").length;
  r = await call(shalom("c1", { top: { voucherReportado: true } }), env);
  assert.strictEqual(r.alreadyCreated, true);
  assert.strictEqual(calls.filter((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST").length, before, "sin duplicado");
  assert.ok(calls.some((c) => c.method === "PUT" && /voucher-reportado/.test(JSON.stringify(c.body))), "etiqueta voucher-reportado");

  // Voucher con datos completos: crea al instante con voucher-reportado.
  env = baseEnv();
  inboundImage = false;
  r = await call(shalom("c2", { top: { voucherReportado: true } }), env);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conversionType, "agencia");
  const post2 = calls.filter((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST").pop().body;
  assert.match(post2.meta_data.find((m) => m.key === "kapta_tags").value, /voucher-reportado/);
  assert.match(calls.filter((c) => /orders\/\d+\/notes$/.test(c.url)).pop().body.note, /^VOUCHER REPORTADO: validar el adelanto de S\/30/);

  // El cliente desiste: el agente lo anula y el barrido no lo crea.
  env = baseEnv();
  await call(shalom("c3"), env);
  r = await call({ conversationId: "c3", courier: "shalom", cancelarPendiente: true }, env);
  assert.strictEqual(r.cancelled, true);
  lastInboundTs = Date.now() - 20 * HOUR;
  const n = calls.filter((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST").length;
  await call({ agenciaSweep: true }, env);
  assert.strictEqual(calls.filter((c) => c.url.endsWith("/wc/v3/orders") && c.method === "POST").length, n, "anulado no se crea");

  // Etapa no_interesado en el bot: se descarta en vez de crearse.
  env = baseEnv();
  await call(shalom("c4"), env);
  await ageEntry(env, "c4", 20);
  stage = "no_interesado";
  sw = await call({ agenciaSweep: true }, env);
  assert.strictEqual(sw.results[0].discarded, "no_interesado");

  // Olva pide la direccion exacta.
  env = baseEnv();
  r = await call({ conversationId: "c5", courier: "olva", customer: { name: "Ana Perez", phone: "987654321" }, items: [{ handle: "airclip-360", quantity: 1 }] }, env);
  assert.ok(r.missing.includes("direccion exacta"));

  console.log("OK: pedidos por agencia (pendiente, voucher, 12 h, anulado, descartado)");
})().catch((e) => { console.error("FALLO:", e && e.stack || e); process.exit(1); });
