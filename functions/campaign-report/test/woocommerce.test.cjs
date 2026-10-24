// Test local (fetch mockeado) del reporte con STORE_BACKEND=woocommerce: pedidos de WooCommerce por la API REST,
// en dos paginas, mas los de Shopify de antes de la apertura (o un aviso si Shopify ya no responde).
// Ejecutar: node functions/campaign-report/test/woocommerce.test.cjs
require("../index.js");
const assert = require("assert");
const api = globalThis.__aurelaCampaignReport;

const meta = (pairs) => Object.entries(pairs).map(([key, value], i) => ({ id: i + 1, key, value }));
const PAGE1 = [
  { id: 11, status: "cod-pending", total: "238.00", currency: "PEN", date_created_gmt: "2026-10-28T15:00:00", meta_data: meta({ kapta_channel: "whatsapp_bot", source: "whatsapp-bot", ctwa_ad_id: "AD1", ctwa_headline: "Bividi" }) },
  { id: 12, status: "processing", total: "119.00", currency: "PEN", date_created_gmt: "2026-10-28T16:00:00", meta_data: meta({ kapta_channel: "web_formulario" }) },
];
const PAGE2 = [
  { id: 13, status: "cod-pending", total: "99.00", currency: "PEN", date_created_gmt: "2026-10-29T03:00:00", meta_data: meta({ source: "whatsapp-bot" }) },
  { id: 14, status: "failed", total: "500.00", currency: "PEN", date_created_gmt: "2026-10-28T17:00:00", meta_data: meta({ source: "whatsapp-bot", ctwa_ad_id: "AD1" }) },
];
const SHOPIFY = [
  { id: "1", name: "#AUR1", createdAt: "2026-10-27T15:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "219.00", currencyCode: "PEN" } }, customAttributes: [{ key: "source", value: "whatsapp-bot" }, { key: "ctwa_ad_id", value: "AD1" }] },
];

const calls = [];
let shopifyStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, auth: init.headers?.Authorization });
  if (u.includes("/wp-json/wc/v3/orders")) {
    const page = new URL(u).searchParams.get("page");
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === "x-wp-totalpages" ? "2" : null) }, json: async () => (page === "1" ? PAGE1 : PAGE2) };
  }
  if (u.includes("/admin/api/") && u.includes("graphql.json")) {
    if (shopifyStatus !== 200) return { ok: false, status: shopifyStatus, text: async () => "Unavailable Shop", json: async () => ({ errors: "Unavailable Shop" }) };
    return { ok: true, json: async () => ({ data: { orders: { nodes: SHOPIFY, pageInfo: { hasNextPage: false, endCursor: null } } } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const env = { sTOREBACKEND: "woocommerce", wOOSTOREURL: "https://aurela.pe/", wOOCONSUMERKEY: "ck_x", wOOCONSUMERSECRET: "cs_y", dASHBOARDACCESSKEY: "K" };
const req = { method: "GET", url: "https://x/?key=K&format=json&since=2026-10-27&until=2026-10-28", headers: { get: () => null } };

(async () => {
  // Solo WooCommerce (sin token de Shopify).
  let r = await (await api.handleRequest(req, env)).json();
  const woo = calls.filter((c) => c.url.includes("/wp-json/wc/v3/orders"));
  assert.strictEqual(woo.length, 2, "lee las 2 paginas");
  assert.strictEqual(woo[0].auth, `Basic ${Buffer.from("ck_x:cs_y").toString("base64")}`, "Basic auth con la clave");
  const q = new URL(woo[0].url).searchParams;
  assert.strictEqual(q.get("after"), "2026-10-27T00:00:00", "desde el primer dia (hora de la tienda)");
  assert.strictEqual(q.get("before"), "2026-10-29T00:00:00", "hasta el final del ultimo dia");
  assert.ok(woo[0].url.startsWith("https://aurela.pe/wp-json/"), "sin doble barra");
  assert.ok(!calls.some((c) => c.url.includes("graphql.json")), "sin token no llama a Shopify");
  assert.strictEqual(r.totals.ordersScanned, 3, "3 pedidos (el fallido no cuenta)");
  assert.strictEqual(r.totals.totalRevenue, 456, "238 + 119 + 99");
  assert.strictEqual(r.totals.attributedOrders, 1);
  assert.strictEqual(r.ads[0].adId, "AD1");
  assert.strictEqual(r.ads[0].revenue, 238);
  assert.strictEqual(r.ads[0].headline, "Bividi");
  assert.strictEqual(r.conversation.orders, 2, "2 pedidos del bot");
  assert.strictEqual(r.currency, "PEN");

  // Con token de Shopify: suma los pedidos de antes de la apertura.
  calls.length = 0;
  r = await (await api.handleRequest(req, { ...env, sHOPIFYADMINACCESSTOKEN: "shpat" })).json();
  assert.strictEqual(r.totals.ordersScanned, 4, "3 de WooCommerce + 1 de Shopify");
  assert.strictEqual(r.ads[0].orders, 2, "AD1: uno en cada tienda");
  assert.strictEqual(r.ads[0].revenue, 457, "238 + 219");

  // Shopify ya cerrado: el reporte sale igual, con un aviso.
  shopifyStatus = 402;
  r = await (await api.handleRequest(req, { ...env, sHOPIFYADMINACCESSTOKEN: "shpat" })).json();
  assert.strictEqual(r.totals.ordersScanned, 3, "solo WooCommerce");
  assert.ok(r.warnings.some((w) => w.includes("pedidos de Shopify")), "avisa que Shopify no respondio");

  // Sin las claves de WooCommerce: error claro.
  const sinClave = await api.handleRequest(req, { ...env, wOOCONSUMERKEY: undefined });
  assert.strictEqual(sinClave.status, 500);
  assert.ok((await sinClave.json()).message.includes("WOO_CONSUMER_KEY"));

  console.log("OK: todos los asserts de WooCommerce pasaron");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
