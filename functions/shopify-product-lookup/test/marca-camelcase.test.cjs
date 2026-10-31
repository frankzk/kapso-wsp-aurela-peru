// Regresion: el anuncio de RestPro ("Con RestPro™ ...") se mapeaba a SunnyRoll Pro porque "RestPro" se partia en
// "rest" + "pro" y el producto con "con ... pro" en el titulo ganaba.
const assert = require("node:assert");
require("../index.js");
const L = globalThis.__aurelaProductLookup;
const catalog = [
  { title: "RestPro: Almohada de Tracción Inversa Ergonómica para un Descanso Óptimo", handle: "restpro-almohada-de-traccion-inversa" },
  { title: "SunnyRoll Pro® - Aplicador de Protector Solar y Loción Recargable con Rodillo de Esponja", handle: "sunnyroll-pro-aplicador-de-protector-solar-y-locion-recargable-con-rodillo-de-esponja" },
  { title: "CabinRack™ - Organizador Deslizante para Platos y Tazones de Acero Inoxidable para Gabinetes", handle: "cabinrack-organizador-deslizante-para-platos-y-tazones-de-acero-inoxidable-para-gabinetes" },
  { title: "FlexiNap™-Almohada de viaje ergonómica de felpa azul, rellenable con ropa para mayor comodidad y practicidad.", handle: "flexinap-almohada-de-viaje" },
];
for (const q of ["RestPro", "Con RestPro", "restpro"]) {
  const r = L.searchCatalogProducts(catalog, q, []);
  assert.strictEqual(r.product && r.product.handle, "restpro-almohada-de-traccion-inversa", q);
}
assert.strictEqual(L.searchCatalogProducts(catalog, "SunnyRoll", []).product.handle, catalog[1].handle);
// Una palabra suelta tambien se prueba como handle ("restpro", "rest-pro"): los pedazos no deben volver por ahi.
for (const q of ["RestPro", "CabinRack"]) {
  const r = L.searchCatalogProducts(catalog, q, L.extractHandleCandidates(q));
  assert.strictEqual(r.product && r.product.handle, q === "RestPro" ? catalog[0].handle : catalog[2].handle, `${q} con handles`);
}
const cands = L.extractProductNameCandidates("😴 Descansa con mayor comodidad", "¿Buscas una almohada? 😴💤 Con RestPro™, disfruta");
assert.ok(cands.includes("RestPro"));
assert.ok(cands.every((c) => !/[\uD800-\uDFFF]/.test(c)), "sin emojis partidos");
console.log("OK: marcas en camelCase no se parten (RestPro no cae en SunnyRoll Pro)");
