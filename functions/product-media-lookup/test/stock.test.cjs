// Variantes agotadas: sus fotos no se envian (caso Crucis+ 20-11, solo Negro).
// Correr: node functions/product-media-lookup/test/stock.test.cjs
const assert = require("assert");
require("../index.js");
const M = globalThis.__aurelaProductMediaLookup;
const product = {
  title: "Crucis+ Pulsera Magnetica de Cobre",
  options: [{ name: "Color", position: 1, values: ["Cobre clásico", "Negro"] }],
  variants: [
    { title: "Cobre clásico", option1: "Cobre clásico", available: false, featured_image: { src: "https://aurela.pe/u/crucis-cobre-clasico.jpg" } },
    { title: "Negro", option1: "Negro", available: true, featured_image: { src: "https://aurela.pe/u/crucis-negro.jpg" } },
  ],
  images: ["https://aurela.pe/u/crucis-negro.jpg", "https://aurela.pe/u/crucis-cobre-clasico-3x4.jpg", "https://aurela.pe/u/crucis-ambas.jpg"],
};
const stock = M.variantStock(product);
assert.deepStrictEqual(stock.disponibles, ["Negro"]);
assert.deepStrictEqual(stock.agotados, ["Cobre clásico"]);
const urls = M.buildMediaItems(product, { limit: 6, stock }).map((i) => i.url);
assert.ok(!urls.some((u) => /cobre-clasico/.test(u)), "sin fotos del color agotado: " + urls);
assert.ok(urls.some((u) => /crucis-negro/.test(u)));
assert.ok(!urls.some((u) => /crucis-ambas/.test(u)), "la foto de ambos colores tampoco");
// Pidio el agotado: no se manda su foto, se muestran las disponibles.
const pedido = M.buildMediaItems(product, { limit: 6, stock, requestedVariant: "cobre clasico" }).map((i) => i.url);
assert.ok(!pedido.some((u) => /cobre-clasico/.test(u)));
assert.match(M.stockNote(stock, true), /AGOTADO: Cobre clásico[\s\S]*pidio una opcion AGOTADA/);
// Sin agotados: nada cambia.
const lleno = { ...product, variants: product.variants.map((v) => ({ ...v, available: true })) };
assert.strictEqual(M.stockNote(M.variantStock(lleno), false), "");
assert.strictEqual(M.buildMediaItems(lleno, { limit: 6, stock: M.variantStock(lleno) }).length, 4, "con stock completo salen todas");
console.log("OK: fotos de variantes agotadas fuera");
