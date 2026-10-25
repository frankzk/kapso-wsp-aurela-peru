// Con aurela.pe en WooCommerce (el catalogo publico trae woo_id) el respaldo de la API de Shopify no se usa: un
// producto que la tienda no tiene no se ofrece. Con el catalogo de Shopify, el respaldo sigue igual.
// Correr: node functions/shopify-product-lookup/test/woocommerce.test.cjs
require("../index.js");
const assert = require("assert");
const api = globalThis.__aurelaProductLookup;

const product = (extra) => ({ id: 1, handle: "cloudslides", title: "CloudSlides - Sandalias", tags: [], options: [],
  images: [{ src: "//x/a.jpg" }], variants: [{ id: 11, available: true, price: "89.00", title: "Default" }], ...extra });

let catalog = null;
let adminCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/admin/api/")) {
    adminCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { productByHandle: null, products: { nodes: [] } } }), json: async () => ({ data: { productByHandle: null, products: { nodes: [] } } }) };
  }
  if (u.includes("/products.json")) return { ok: true, json: async () => (u.includes("page=1") ? catalog : { products: [] }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};

const ask = async (env) => (await api.handleRequest(new Request("https://x/", { method: "POST", body: JSON.stringify({ input: { message: "tienen licuadora portatil?" } }) }), env)).json();

(async () => {
  const env = { SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_x" };

  // Catalogo de WooCommerce: no llama a Shopify.
  catalog = { products: [product({ woo_id: 25 })] };
  globalThis.__AURELA_PUBLIC_CATALOG_CACHE = null;
  adminCalls = 0;
  await ask(env);
  assert.strictEqual(adminCalls, 0, "con WooCommerce no se usa la API de Shopify");

  // Catalogo de Shopify (sin woo_id): el respaldo sigue.
  catalog = { products: [product({})] };
  globalThis.__AURELA_PUBLIC_CATALOG_CACHE = null;
  adminCalls = 0;
  await ask(env);
  assert.ok(adminCalls > 0, "con Shopify el respaldo de la API sigue");

  console.log("OK: respaldo de Shopify apagado con el catalogo de WooCommerce");
})().catch((e) => { console.error(e); process.exit(1); });
