// Regresion: producto nombrado con "2en1" pegado + relleno de saludo/envio no
// debe romper la busqueda (caso real: "hacen envios a provincia el pelador 2en1").
// Correr: node functions/shopify-product-lookup/test/tokenize.test.cjs
require("../index.js");
const assert = require("assert");
const api = globalThis.__aurelaProductLookup;

const CAT = { products: [
  { id: 1, handle: "pelador-de-papas-destapador", title: "Pelador de Papas + Destapador de Botellas", product_type: "Cocina", tags: ["cocina", "pelador"], variants: [{ id: 11, available: true, price: "39.00", title: "Default" }], images: [{ src: "//x/p.jpg" }], options: [] },
  { id: 2, handle: "cloudslides", title: "CloudSlides - Sandalias", tags: [], variants: [{ id: 21, available: true, price: "89.00", title: "Default" }], images: [{ src: "//x/c.jpg" }], options: [] },
  { id: 3, handle: "organizador", title: "Organizador Multiuso para Provincia", tags: [], variants: [{ id: 41, available: true, price: "49.00", title: "Default" }], images: [{ src: "//x/o.jpg" }], options: [] },
]};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/products.json")) return { ok: true, json: async () => CAT };
  if (u.includes("/products/") && u.endsWith(".js")) {
    const h = decodeURIComponent(u.split("/products/")[1].replace(".js", "").split("?")[0]);
    const p = CAT.products.find((x) => x.handle === h);
    return p ? { ok: true, json: async () => p } : { ok: false, status: 404, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const req = (m) => ({ method: "POST", url: "http://x", text: async () => JSON.stringify({ input: { message: m } }) });
const run = async (m) => (await api.handleRequest(req(m), { sHOPIFYPUBLICSHOPDOMAIN: "aurela.pe" })).json();

(async () => {
  // 1) Mensaje real completo: saludo + envio + provincia + "pelador 2en1" -> halla el pelador.
  let r = await run("Hola buenas tardes por favor dime si hacen envíos a provincia el pelador 2en1");
  assert.strictEqual(r.found, true, "mensaje real completo debe hallar el pelador");
  assert.ok(/pelador/i.test(r.product.title), "es el pelador");

  // 2) "2en1" pegado no rompe.
  r = await run("el pelador 2en1");
  assert.strictEqual(r.found, true, "'pelador 2en1' pegado debe hallar");

  // 3) Regresion: nombres sin digitos siguen funcionando.
  r = await run("cloudslides");
  assert.ok(r.found && /cloudslides/i.test(r.product.title), "cloudslides sigue OK");

  // 4) Solo saludo -> NO debe matchear un producto al azar (ni el que dice "Provincia").
  r = await run("hola buenas tardes");
  assert.strictEqual(r.found, false, "solo saludo no debe matchear producto");

  console.log("OK: tokenizacion 2en1 + relleno de envio/saludo — todos los asserts pasan");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
