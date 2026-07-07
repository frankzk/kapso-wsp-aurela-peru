// Test del rescate por anuncio Click-to-WhatsApp (fetch + KV mockeados).
// Correr: node functions/shopify-product-lookup/test/adrescue.test.cjs
require("../index.js");
const assert = require("assert");
const api = globalThis.__aurelaProductLookup;

const AD = {
  source_type: "ad",
  source_id: "120247343724380657",
  headline: "✨ Madera Como Nueva",
  body: "¿Tus muebles de madera perdieron su brillo? Con nuestra Cera de Abeja Natural puedes devolverles el color y la protección.",
};
const payload = {
  input: { message: "Precio", conversationId: "c1", phoneNumberId: "1241790819006805" },
  whatsapp_context: { messages: [{ text: { body: "Precio" }, referral: AD }] },
};

// unit: extractInlineReferral + adReferralText
const ref = api.extractInlineReferral(payload);
assert.ok(ref && ref.source_id === AD.source_id, "extrae referral inline");
assert.ok(/cera de abeja/i.test(api.adReferralText(ref)), "adReferralText incluye el cuerpo");

const CATALOG = { products: [
  { id: 1, handle: "cloudslides", title: "CloudSlides - Sandalias", tags: [], variants: [{ id: 11, available: true, price: "89.00", title: "Default" }], images: [{ src: "//x/a.jpg" }], options: [] },
  { id: 2, handle: "cera-de-abeja-natural-para-el-cuidado-de-los-muebles", title: "BeeWax™ - Cera de Abeja Natural para el Cuidado y Protección de Muebles 300 gramos", tags: [], variants: [{ id: 22, available: true, price: "79.00", title: "Default" }], images: [{ src: "//x/b.jpg" }], options: [] },
]};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/products.json")) return { ok: true, json: async () => CATALOG };
  if (u.includes("/products/") && u.endsWith(".js")) {
    // getPublicProductByHandle del handle mapeado
    if (u.includes("cera-de-abeja")) return { ok: true, json: async () => CATALOG.products[1] };
    return { ok: false, status: 404, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); } };
}
function req(body) { return { method: "POST", url: "http://x", text: async () => JSON.stringify(body) }; }

(async () => {
  // 1) Con mapa source_id->handle en KV: rescate PRECISO (no ambiguo).
  const kvMapped = fakeKV({ "ctwa:120247343724380657": "cera-de-abeja-natural-para-el-cuidado-de-los-muebles" });
  const r1 = await (await api.handleRequest(req(payload), { KV: kvMapped, sHOPIFYPUBLICSHOPDOMAIN: "aurela.pe" })).json();
  assert.strictEqual(r1.found, true, "mapa: debe encontrar producto");
  assert.strictEqual(r1.adRescued, true, "mapa: adRescued");
  assert.ok(/cera de abeja/i.test(r1.product.title), "mapa: es la cera BeeWax");

  // 2) Sin mapa (catalogo chico y limpio): cae al respaldo por texto y tambien halla la cera.
  const r2 = await (await api.handleRequest(req(payload), { KV: fakeKV(), sHOPIFYPUBLICSHOPDOMAIN: "aurela.pe" })).json();
  assert.ok(r2.found === true || r2.reason === "ambiguous", "sin mapa: respaldo por texto o ambiguo (no cae al arranque)");

  // 3) Sin anuncio ni producto: comportamiento previo (not_found), no rompe.
  const r3 = await (await api.handleRequest(req({ input: { message: "Precio" } }), { sHOPIFYPUBLICSHOPDOMAIN: "aurela.pe" })).json();
  assert.strictEqual(r3.found, false, "sin anuncio -> not_found");

  console.log("OK: rescate por anuncio (mapa + respaldo) pasa todos los asserts");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
