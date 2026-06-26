// Test local (fetch mockeado) de la seccion de conversion conversaciones -> pedidos.
// Ejecutar: node functions/campaign-report/test/conversion.test.cjs
require("../index.js");
const assert = require("assert");
const api = globalThis.__aurelaCampaignReport;

const ORDERS = [
  { id: "1", name: "#AUR1", createdAt: "2026-06-25T15:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "219.00", currencyCode: "PEN" } }, customAttributes: [{ key: "source", value: "whatsapp-bot" }, { key: "ctwa_ad_id", value: "AD1" }] },
  { id: "2", name: "#AUR2", createdAt: "2026-06-25T18:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "99.00", currencyCode: "PEN" } }, customAttributes: [{ key: "source", value: "whatsapp-bot" }] },
  { id: "3", name: "#AUR3", createdAt: "2026-06-26T02:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "129.00", currencyCode: "PEN" } }, customAttributes: [{ key: "source", value: "whatsapp-bot" }] },
  { id: "4", name: "#WEB1", createdAt: "2026-06-25T16:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "PEN" } }, customAttributes: [] },
];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/admin/api/") && u.includes("graphql.json")) {
    return { ok: true, json: async () => ({ data: { orders: { nodes: ORDERS, pageInfo: { hasNextPage: false, endCursor: null } } } }) };
  }
  if (u.includes("/meta/whatsapp/") && u.includes("/conversations")) {
    if (u.includes("1241790819006805")) {
      return { ok: true, json: async () => ({ data: [
        { id: "a1", created_at: "2026-06-25T12:00:00Z" }, { id: "a2", created_at: "2026-06-25T13:00:00Z" },
        { id: "a3", created_at: "2026-06-25T14:00:00Z" }, { id: "a4", created_at: "2026-06-25T20:00:00Z" },
        { id: "a5", created_at: "2026-06-26T01:00:00Z" }, { id: "a6", created_at: "2026-06-26T03:00:00Z" },
        { id: "old", created_at: "2026-06-01T03:00:00Z" }, // fuera de rango: NO cuenta
      ], paging: { cursors: { after: null } } }) };
    }
    return { ok: true, json: async () => ({ data: [
      { id: "b1", created_at: "2026-06-25T09:00:00Z" }, { id: "b2", created_at: "2026-06-25T10:00:00Z" },
      { id: "b3", created_at: "2026-06-25T11:00:00Z" }, { id: "b4", created_at: "2026-06-25T22:00:00Z" },
    ], paging: { cursors: { after: null } } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const env = { sHOPIFYADMINACCESSTOKEN: "x", sHOPIFYSHOPDOMAIN: "aurela-peru.myshopify.com", sHOPIFYAPIVERSION: "2026-04", dASHBOARDACCESSKEY: "K", kAPSOAPIKEY: "kap" };

(async () => {
  const req = { method: "GET", url: "https://x/?key=K&format=json&since=2026-06-25&until=2026-06-26", headers: { get: () => null } };
  const r = await (await api.handleRequest(req, env)).json();
  const c = r.conversation;

  assert.strictEqual(c.configured, true, "debe estar configurado");
  assert.strictEqual(c.conversations, 10, "10 conversaciones en rango (excluye la del 1-jun)");
  assert.strictEqual(c.orders, 3, "3 pedidos del bot (excluye el web)");
  assert.strictEqual(c.revenue, 447, "ingreso bot = 219+99+129");
  assert.strictEqual(c.rate, 0.3, "tasa = 3/10");
  // Hora Lima (-5h): todo cae en 2026-06-25.
  assert.strictEqual(c.byDay.length, 2);
  assert.deepStrictEqual(c.byDay[0], { day: "2026-06-25", conversations: 10, orders: 3, rate: 0.3 });
  assert.deepStrictEqual(c.byDay[1], { day: "2026-06-26", conversations: 0, orders: 0, rate: null });
  assert.strictEqual(r.totals.ordersScanned, 4, "ordersScanned cuenta todas (incluye web)");

  // Rango largo -> se omite la conversion (evita timeout).
  const long = await (await api.handleRequest({ method: "GET", url: "https://x/?key=K&format=json&days=30", headers: { get: () => null } }, env)).json();
  assert.strictEqual(long.conversation.skipped, true, "rango > MAX_CONV_DAYS debe omitirse");

  // Sin KAPSO_API_KEY -> no configurado, pero ventas siguen.
  const noKey = await (await api.handleRequest(req, { ...env, kAPSOAPIKEY: undefined })).json();
  assert.strictEqual(noKey.conversation.configured, false);
  assert.strictEqual(noKey.totals.ordersScanned, 4, "ventas siguen sin la key de Kapso");

  console.log("OK: todos los asserts de conversion pasaron");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
