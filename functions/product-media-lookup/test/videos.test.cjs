// Videos: primero el del catalogo publico ("media" de /products/<handle>.js, que publican Shopify y la tienda
// WooCommerce), sin la API de administracion; y el modo exportVideos para pasarlos a la tienda antes del cierre.
// Correr: node functions/product-media-lookup/test/videos.test.cjs
require("../index.js");
const assert = require("assert");
const api = globalThis.__aurelaProductMediaLookup;

let adminCalls = 0;
let adminPages = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/admin/api/")) {
    adminCalls += 1;
    const data = adminPages.shift() || { data: { product: null } };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};

(async () => {
  const config = { adminToken: "shpat_x", adminShopDomain: "x.myshopify.com", adminApiVersion: "2026-04", publicShopDomain: "aurela.pe" };

  // Catalogo con video (formato Ajax de Shopify / cod-core): la version MP4 mas chica, sin llamar a la API.
  const product = { id: 5, handle: "bolso", title: "Bolso", media: [
    { media_type: "image", src: "https://x/a.jpg" },
    { media_type: "video", sources: [
      { format: "m3u8", mime_type: "application/x-mpegURL", url: "https://cdn/x.m3u8", height: 1080 },
      { format: "mp4", mime_type: "video/mp4", url: "https://cdn/x-720.mp4", height: 720 },
      { format: "mp4", mime_type: "video/mp4", url: "https://cdn/x-480.mp4", height: 480 },
    ] },
  ] };
  const r = await api.fetchProductVideo(config, product);
  assert.strictEqual(r.item.url, "https://cdn/x-480.mp4");
  assert.strictEqual(r.debug.source, "public.media");
  assert.strictEqual(adminCalls, 0, "sin llamar a la API de Shopify");

  // Sin video en el catalogo: sigue con la API de administracion (mientras Shopify responda).
  adminCalls = 0;
  await api.fetchProductVideo(config, { id: 6, handle: "otro", title: "Otro", media: [] });
  assert.ok(adminCalls > 0, "sin video publico, respaldo de la API");

  // exportVideos: galeria primero, despues custom.video; los productos sin video no salen.
  adminCalls = 0;
  adminPages = [{ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { handle: "con-galeria", media: { nodes: [{ __typename: "Video", sources: [{ url: "https://cdn/g-480.mp4", mimeType: "video/mp4", format: "mp4", height: 480 }] }] }, metafield: null },
    { handle: "con-metacampo", media: { nodes: [] }, metafield: { reference: { __typename: "Video", sources: [{ url: "https://cdn/m-720.mp4", mimeType: "video/mp4", format: "mp4", height: 720 }, { url: "https://cdn/m-360.mp4", mimeType: "video/mp4", format: "mp4", height: 360 }] } } },
    { handle: "sin-video", media: { nodes: [] }, metafield: null },
  ] } } }];
  const exp = await api.exportVideos(config, {});
  assert.ok(exp.ok && exp.complete);
  assert.deepStrictEqual(exp.productos, {
    "con-galeria": { url: "https://cdn/g-480.mp4", alto: 480, fuente: "galeria" },
    "con-metacampo": { url: "https://cdn/m-360.mp4", alto: 360, fuente: "custom.video" },
  });

  console.log("OK: videos del catalogo y exportVideos");
})().catch((e) => { console.error(e); process.exit(1); });
