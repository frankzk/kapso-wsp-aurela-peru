// presentar-producto con fetch simulado (tienda + proxy de Kapso). Correr: node functions/presentar-producto/test/presentar.test.cjs
const assert = require("assert");
const PRODUCTS = {
  "cera-de-abeja-natural-para-el-cuidado-de-los-muebles": { handle: "cera-de-abeja-natural-para-el-cuidado-de-los-muebles", title: "BeeWax™ - Cera de Abeja Natural para el Cuidado y Protección de Muebles 300 gramos - IdeasLabCo.™", price: 7900, compare_at_price: 9900,
    options: [{ name: "Title", position: 1, values: ["Default Title"] }], variants: [{ id: 1, available: true, option1: "Default Title", price: 7900 }],
    images: ["https://aurela.pe/a.png", "https://aurela.pe/b.png", "https://aurela.pe/c.png"], media: [{ media_type: "video", sources: [{ url: "https://aurela.pe/v.mp4", format: "mp4", height: 480 }] }] },
  "fat-burn": { handle: "fat-burn", title: "Fat‑Burn Shorts - Shorts para Quemar Grasa", price: 12900, compare_at_price: null,
    options: [{ name: "Color", position: 1, values: ["Negro", "Beige"] }, { name: "Talla", position: 2, values: ["L", "XL", "XXL"] }],
    variants: [{ id: 1, available: false, option1: "Negro", option2: "L" }, { id: 2, available: true, option1: "Negro", option2: "XXL" }, { id: 3, available: true, option1: "Beige", option2: "XXL" }],
    images: ["https://aurela.pe/f1.jpg", "https://aurela.pe/f2.jpg"], media: [] },
  "agotado": { handle: "agotado", title: "Agotado", price: 5000, options: [], variants: [{ id: 1, available: false }], images: [], media: [] },
};
let HIST = [], SENT = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/\/products\/([^/]+)\.js$/);
  if (m) { const p = PRODUCTS[decodeURIComponent(m[1])]; return { ok: Boolean(p), json: async () => p }; }
  if (u.includes("/messages?conversation_id=")) return { ok: true, json: async () => ({ data: HIST }) };
  if (u.endsWith("/messages") && opts.method === "POST") { SENT.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ messages: [{ id: "wamid.x" + SENT.length }] }) }; }
  return { ok: false, json: async () => ({}) };
};
require("../index.js");
const api = globalThis.__aurelaPresentarProducto;
function kv() { const st = new Map(); return { st, get: async (k) => st.get(k) ?? null, put: async (k, v) => st.set(k, String(v)) }; }
const call = async (input, env, ctx = { phone_number: "51987654321", conversation_id: "conv-1" }) =>
  JSON.parse(await (await api.handleRequest(new Request("https://x/", { method: "POST", body: JSON.stringify({ input, execution_context: { context: ctx } }) }), env)).text());
const inbAd = { kapso: { direction: "inbound", phone_number: "51987654321" }, referral: { source_type: "ad", source_id: "9" }, timestamp: "1" };
const inbWeb = { kapso: { direction: "inbound", phone_number: "51987654321" }, timestamp: "1" };
(async () => {
  const env = { KAPSO_API_KEY: "k", KV: kv() };
  // Anuncio, primer contacto, BeeWax: video, precio reforzado, 2 fotos, promos con botones (4+1 mensajes, 1 llamada)
  HIST = [inbAd]; SENT = [];
  let r = await call({ handle: "cera-de-abeja-natural-para-el-cuidado-de-los-muebles", conversationId: "c-ad" }, env);
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.origen, "anuncio");
  assert.deepStrictEqual(SENT.map((s) => s.type), ["video", "text", "image", "image", "interactive"]);
  assert.match(SENT[1].text.body, /^¡Hola! Soy \*Akemi\*/); assert.match(SENT[1].text.body, /Sí, es la \*BeeWax™/); assert.match(SENT[1].text.body, /Antes \*S\/ 99\*, hoy \*S\/ 79\*/);
  assert.match(SENT[4].interactive.body.text, /Aprovecha hoy[\s\S]*3 por \*S\/ 158\*[\s\S]*Lima\* o de \*Provincia/);
  assert.deepStrictEqual(SENT[4].interactive.action.buttons.map((b) => b.reply.title), ["Lima", "Provincia"]);
  assert.ok(env.KV.st.get("last_product:c-ad").includes("c.png"), "guarda el producto para los seguimientos");
  // Organica desde la web, no es el primer contacto: 2 mensajes (video con precio + botones con foto)
  HIST = [inbWeb, { kapso: { direction: "outbound" }, timestamp: "2" }]; SENT = [];
  r = await call({ url: "https://aurela.pe/products/cera-de-abeja-natural-para-el-cuidado-de-los-muebles/", conversationId: "c-web" }, env);
  assert.strictEqual(r.origen, "organico"); assert.deepStrictEqual(r.sent, ["video+precio", "promos+foto"]);
  assert.strictEqual(SENT.length, 2); assert.strictEqual(SENT[0].type, "video"); assert.ok(!SENT[0].video.caption.startsWith("¡Hola"), "sin saludo si no es el primer contacto");
  assert.strictEqual(SENT[1].interactive.header.image.link, "https://aurela.pe/a.png");
  // Producto con colores/tallas, organico sin video: foto con precio + botones con la 2da foto y solo tallas con stock
  HIST = [inbWeb]; SENT = [];
  r = await call({ handle: "fat-burn", conversationId: "c-fb" }, env);
  assert.deepStrictEqual(r.sent, ["foto+precio", "promos+foto"]); assert.strictEqual(SENT[1].interactive.header.image.link, "https://aurela.pe/f2.jpg");
  assert.match(SENT[1].interactive.body.text, /Color: Negro, Beige · Talla: XXL/); assert.match(SENT[1].interactive.body.text, /5 unidades por \*S\/ 387\*/);
  // Sin numero (usuario de WhatsApp): manda con recipient (BSUID)
  HIST = [{ kapso: { direction: "inbound" }, from_user_id: "PE.123", timestamp: "1" }]; SENT = [];
  r = await call({ handle: "fat-burn", conversationId: "c-bsuid" }, env, { conversation_id: "c-bsuid" });
  assert.ok(r.ok); assert.strictEqual(SENT[0].recipient, "PE.123"); assert.ok(!SENT[0].to);
  // Agotado / inexistente: no manda nada y el agente presenta como antes
  SENT = []; r = await call({ handle: "agotado", conversationId: "c-x" }, env); assert.deepStrictEqual([r.ok, r.reason, SENT.length], [false, "out_of_stock", 0]);
  r = await call({ handle: "no-existe", conversationId: "c-x" }, env); assert.deepStrictEqual([r.ok, r.reason], [false, "product_not_found"]);
  console.log("presentar.test: ok");
})().catch((e) => { console.error(e); process.exit(1); });
