// Pedido en WooCommerce (STORE_BACKEND=woocommerce) con fetch mockeado: catalogo publico de la tienda en formato
// Shopify (cod-core) + API REST de WooCommerce.
// Correr: node functions/create-shopify-order/test/woocommerce.test.cjs
const assert = require("assert");

const CATALOG = { products: [
  { id: 9612721488092, woo_id: 25, handle: "bividi-camiseta-de-alta-compresion", title: "Bividi Camiseta de Alta Compresión",
    options: [{ name: "Talla", position: 1, values: ["M", "L"] }],
    variants: [
      { id: 52484401955036, woo_id: 26, title: "M", option1: "M", sku: "36710849", available: true, price: "119.00" },
      { id: 52484401987804, woo_id: 27, title: "L", option1: "L", sku: "36710850", available: true, price: "119.00" },
    ] },
  { id: 7628322373852, woo_id: 46, handle: "rodillera-x-pro", title: "Rodillera X Pro", options: [],
    variants: [{ id: 42775201251548, woo_id: 46, title: "Default Title", sku: "81852859", available: true, price: "35.00" }] },
] };

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
  if (u.startsWith("https://tienda.test/products.json")) return new Response(JSON.stringify(u.includes("page=1") ? CATALOG : { products: [] }));
  if (u === "https://tienda.test/wp-json/wc/v3/orders" && opts.method === "POST") {
    return new Response(JSON.stringify({ id: 501, number: "AUR900123", total: "288.00" }), { status: 201 });
  }
  if (u === "https://tienda.test/wp-json/wc/v3/orders/501/notes") return new Response("{}", { status: 201 });
  return new Response("{}", { status: 404 });
};

require("../index.js");
const api = globalThis.__aurelaCreateShopifyOrder;
const env = { STORE_BACKEND: "woocommerce", WOO_STORE_URL: "https://tienda.test/", WOO_CONSUMER_KEY: "ck_x", WOO_CONSUMER_SECRET: "cs_y" };
const call = async (input, e = env) => (await api.handleRequest(new Request("https://x/", { method: "POST", body: JSON.stringify({ input }) }), e)).json();

(async () => {
  // Ubicacion -> codigo de WooCommerce.
  assert.deepStrictEqual(api.wooLocation({ coverage: { normalized: { district: "santiago de surco", province: "lima", region: "lima" } } }).state, "LMA");
  assert.strictEqual(api.wooLocation({ coverage: { normalized: { district: "huacho", province: "huaura", region: "lima" } } }).state, "LIM");
  assert.strictEqual(api.wooLocation({ coverage: { normalized: { district: "ventanilla", province: "callao", region: "callao" } } }).state, "CAL");
  assert.strictEqual(api.wooLocation({ customer: { district: "Cerro Colorado", region: "Arequipa" } }).state, "ARE");
  assert.strictEqual(api.wooLocation({ coverage: { normalized: { district: "san juan de lurigancho", province: "lima", region: "lima" } } }).district, "San Juan de Lurigancho");

  // Reparto del descuento: suma exacta.
  const t = api.spreadWooDiscount([{ price: 119, quantity: 3 }, { price: 35, quantity: 1 }], 119);
  assert.strictEqual(Math.round(t.reduce((s, x) => s + (x.subtotal - x.total), 0) * 100), 11900);

  // Sin STORE_BACKEND: Shopify (no toca la tienda nueva).
  assert.strictEqual(await api.getStoreBackend({}, {}), "shopify");
  assert.strictEqual(await api.getStoreBackend({}, { storeBackend: "woocommerce" }), "woocommerce");

  const input = {
    conversationId: "c1",
    customer: { name: "Rosa Pérez", phone: "987654321", district: "Lince", address: "Av. Arequipa 2450", reference: "Frente al colegio" },
    coverage: { shippingMode: "contraentrega", normalized: { district: "lince", province: "lima", region: "lima" } },
    items: [
      { variantId: "gid://shopify/ProductVariant/52484401987804", quantity: 3 },
      { handle: "rodillera-x-pro", quantity: 1 },
    ],
  };

  const dry = await call({ ...input, dryRun: true });
  assert.ok(dry.ok && dry.dryRun, "dryRun ok");
  assert.deepStrictEqual(dry.orderPreview.line_items.map((l) => [l.product_id, l.variation_id, l.quantity, l.subtotal]), [[25, 27, 3, "357.00"], [46, undefined, 1, "35.00"]]);
  assert.strictEqual(dry.pricing.discountTotal, 119, "3x2: una unidad gratis");
  assert.strictEqual(dry.orderPreview.shipping_lines[0].method_id, "free_shipping");
  assert.strictEqual(dry.orderPreview.status, "cod-pending");
  assert.strictEqual(dry.orderPreview.payment_method, "cod");
  assert.strictEqual(dry.orderPreview.billing.state, "LMA");
  assert.strictEqual(dry.orderPreview.billing.phone, "+51987654321");
  assert.ok(dry.orderPreview.meta_data.some((m) => m.key === "kapta_channel" && m.value === "whatsapp_bot"));
  assert.ok(dry.orderPreview.meta_data.some((m) => m.key === "cod_core_cupon"));
  assert.ok(!calls.some((c) => c.method === "POST"), "dryRun no crea nada");

  const res = await call(input);
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.order.name, "#AUR900123");
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"));
  assert.ok(post.headers.Authorization.startsWith("Basic "), "clave por Basic Auth");

  // Producto que no existe: no crea el pedido.
  const missing = await call({ ...input, items: [{ handle: "no-existe", quantity: 1 }] });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, "products_not_found");

  // Envio S/ 10 con S/ 40 o menos.
  const cheap = await call({ ...input, items: [{ handle: "rodillera-x-pro", quantity: 1 }], dryRun: true });
  assert.deepStrictEqual(cheap.orderPreview.shipping_lines[0], { method_id: "flat_rate", method_title: "Envio", total: "10.00" });

  console.log("woocommerce.test: ok");
})().catch((e) => { console.error(e); process.exit(1); });
