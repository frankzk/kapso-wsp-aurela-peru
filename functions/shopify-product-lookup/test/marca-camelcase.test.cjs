// Regresion: el anuncio de RestPro ("Con RestPro™ ...") se mapeaba a SunnyRoll Pro porque "RestPro" se partia en
// "rest" + "pro" y el producto con "con ... pro" en el titulo ganaba.
const assert = require("node:assert");
require("../index.js");
const L = globalThis.__aurelaProductLookup;
const catalog = [
  { title: "RestPro: Almohada de Tracción Inversa Ergonómica para un Descanso Óptimo", handle: "restpro-almohada-de-traccion-inversa" },
  { title: "SunnyRoll Pro® - Aplicador de Protector Solar y Loción Recargable con Rodillo de Esponja", handle: "sunnyroll-pro-aplicador-de-protector-solar-y-locion-recargable-con-rodillo-de-esponja" },
  { title: "FlexiNap™-Almohada de viaje ergonómica de felpa azul, rellenable con ropa para mayor comodidad y practicidad.", handle: "flexinap-almohada-de-viaje" },
];
for (const q of ["RestPro", "Con RestPro", "restpro"]) {
  const r = L.searchCatalogProducts(catalog, q, []);
  assert.strictEqual(r.product && r.product.handle, "restpro-almohada-de-traccion-inversa", q);
}
assert.strictEqual(L.searchCatalogProducts(catalog, "SunnyRoll", []).product.handle, catalog[1].handle);
const cands = L.extractProductNameCandidates("😴 Descansa con mayor comodidad", "¿Buscas una almohada? 😴💤 Con RestPro™, disfruta");
assert.ok(cands.includes("RestPro"));
assert.ok(cands.every((c) => !/[\uD800-\uDFFF]/.test(c)), "sin emojis partidos");
console.log("OK: marcas en camelCase no se parten (RestPro no cae en SunnyRoll Pro)");
