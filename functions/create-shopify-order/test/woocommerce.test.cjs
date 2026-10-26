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
  // Escalera de regalos de EggMixer (GIFT_LADDERS): el producto y su primer regalo.
  { id: 8000000000001, woo_id: 60, handle: "batidor-de-huevos-de-mano", title: "Batidor de Huevos EggMixer", options: [],
    variants: [{ id: 44255967740124, woo_id: 60, title: "Default Title", available: true, price: "39.00" }] },
  { id: 8000000000002, woo_id: 61, handle: "regalo-eggmixer", title: "Regalo EggMixer", options: [],
    variants: [{ id: 43391484657884, woo_id: 61, title: "Default Title", available: true, price: "15.00" }] },
  // SunTent sin sus regalos en el catalogo publico.
  { id: 8000000000003, woo_id: 70, handle: "suntent", title: "SunTent", options: [],
    variants: [{ id: 44036950622428, woo_id: 70, title: "Default Title", available: true, price: "89.00" }] },
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
  // Como lo manda el bot en la practica (pedidos reales del 22 al 24-10): a veces solo el distrito.
  assert.strictEqual(api.wooLocation({ coverage: { district: "Tambopata", shippingMode: "contraentrega" }, customer: { district: "Tambopata" } }).state, "MDD");
  assert.strictEqual(api.wooLocation({ customer: { district: "La Molina" } }).state, "LMA");
  assert.strictEqual(api.wooLocation({ customer: { district: "Cercado de Lima" } }).state, "LMA");
  assert.strictEqual(api.wooLocation({ customer: { district: "Callao", region: "Lima" } }).state, "CAL", "Callao no es LMA");
  const soloCoverage = api.wooLocation({ coverage: { district: "Miraflores", province: "Lima" }, customer: {} });
  assert.deepStrictEqual([soloCoverage.state, soloCoverage.district], ["LMA", "Miraflores"], "distrito desde coverage");
  assert.strictEqual(api.wooLocation({ coverage: { region: "junin", district: "huancayo", province: "junin" }, customer: { district: "El Tambo", region: "Junin" } }).state, "JUN");
  assert.strictEqual(api.wooLocation({ customer: { district: "Cercado", region: "Arequipa", province: "Arequipa" } }).state, "ARE");
  assert.strictEqual(api.wooLocation({ customer: { district: "Distrito Desconocido" } }).state, "", "sin datos: vacio, no inventa");
  // Precio prometido por el bot distinto del que cobra la tienda (caso real 24-10: Fat-Burn a S/ 116.10 de anuncio).
  assert.match(api.wooQuoteMismatchNote({ total: 116.1 }, 129), /OJO PRECIO: el bot le cotizo S\/ 116\.10 y el pedido suma S\/ 129\.00/);
  assert.strictEqual(api.wooQuoteMismatchNote({ total: 158 }, 158), "", "mismo total: sin aviso");
  assert.strictEqual(api.wooQuoteMismatchNote({}, 79), "", "sin cotizacion: sin aviso");
  // Celular: el de WhatsApp o el que dio el cliente; el ID de un usuario sin numero ("PE.xxx") no sirve.
  assert.strictEqual(api.wooCustomerPhone({ customer: { phone: "51987654321" } }, {}), "+51987654321");
  assert.strictEqual(api.wooCustomerPhone({ customer: { phone: "987 654 321" } }, {}), "+51987654321");
  assert.strictEqual(api.wooCustomerPhone({ customer: { phone: "PE.2139879713270788" } }, {}), "");
  assert.strictEqual(api.wooCustomerPhone({ customer: {} }, {}), "");
  assert.strictEqual(api.wooCustomerPhone({ customer: { phone: "PE.2139879713270788" }, phone: "912345678" }, {}), "+51912345678");
  const sinCelular = await call({ dryRun: true, items: [{ quantity: 1, handle: "rodillera-x-pro" }], customer: { name: "Soli", phone: "PE.1571967204683218", address: "Calle 1 123", district: "Cayma", reference: "x" }, coverage: { normalized: { district: "cayma", province: "arequipa", region: "arequipa" } } });
  assert.deepStrictEqual([sinCelular.ok, sinCelular.reason], [false, "missing_phone"]);

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
  assert.ok(dry.internalNote.includes("3 x Bividi Camiseta de Alta Compresión - L"), dry.internalNote);
  // Nota corta de octubre (d888c18): sin el total, que el pedido ya muestra.
  assert.ok(dry.internalNote.startsWith("Pedido WhatsApp/Kapso · Contraentrega"), dry.internalNote);

  const res = await call(input);
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.order.name, "#AUR900123");
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"));
  assert.ok(post.headers.Authorization.startsWith("Basic "), "clave por Basic Auth");

  // Producto que no existe: no crea el pedido.
  const missing = await call({ ...input, items: [{ handle: "no-existe", quantity: 1 }] });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, "products_not_found");

  // Regalos: EggMixer x1 -> su regalo a S/ 0, sin contar en el precio ni en el descuento.
  const egg = await call({ ...input, items: [{ handle: "batidor-de-huevos-de-mano", quantity: 1 }], dryRun: true });
  assert.ok(egg.ok, JSON.stringify(egg));
  const gift = egg.orderPreview.line_items.find((l) => l.product_id === 61);
  assert.deepStrictEqual(gift, { product_id: 61, quantity: 1, subtotal: "0.00", total: "0.00" });
  assert.strictEqual(egg.pricing.subtotal, 39, "el regalo no suma al precio");
  assert.ok(egg.orderPreview.meta_data.some((m) => m.key === "kapta_tags" && m.value.includes("regalo-eggmixer")));
  assert.ok(egg.internalNote.includes("Regalo(s): 1 x Regalo EggMixer"), egg.internalNote);
  // SunTent: sus regalos no estan en la tienda -> el pedido sale igual y la nota pide agregarlos.
  const tent = await call({ ...input, items: [{ handle: "suntent", quantity: 1 }], dryRun: true });
  assert.ok(tent.ok, JSON.stringify(tent));
  assert.strictEqual(tent.orderPreview.line_items.length, 1);
  assert.ok(tent.internalNote.includes("REGALO POR AGREGAR A MANO"), tent.internalNote);

  // Envio S/ 10 con S/ 40 o menos.
  const cheap = await call({ ...input, items: [{ handle: "rodillera-x-pro", quantity: 1 }], dryRun: true });
  assert.deepStrictEqual(cheap.orderPreview.shipping_lines[0], { method_id: "flat_rate", method_title: "Envio", total: "10.00" });

  console.log("woocommerce.test: ok");
})().catch((e) => { console.error(e); process.exit(1); });
