// Contacto sin numero (usuario de WhatsApp): la respuesta avisa al agente que pida el celular con los datos de envio.
// Correr: node functions/shopify-product-lookup/test/sin-numero.test.cjs
const assert = require("assert");
require("../index.js");
const L = globalThis.__aurelaProductLookup;

// Caso real 10-11 (Giuliana, IceFit): sin phone_number, solo el ID de usuario.
const sinNumero = { execution_context: { context: { phone_number: null, whatsapp_business_scoped_user_id: "PE.2303713383811614" } } };
assert.strictEqual(L.contactWithoutNumber(sinNumero), true);
assert.strictEqual(L.contactWithoutNumber({ execution_context: { context: { phone_number: "51947071569", whatsapp_business_scoped_user_id: "PE.1" } } }), false);
assert.strictEqual(L.contactWithoutNumber({ whatsapp_context: { messages: [{ from: "51947071569", from_user_id: "PE.1" }] } }), false, "numero en los mensajes");
assert.strictEqual(L.contactWithoutNumber({ input: { query: "x" } }), false, "sin contexto no se asume nada");

(async () => {
  // La respuesta del lookup (aunque no encuentre producto) lleva el aviso.
  const req = (body) => new Request("https://x/", { method: "POST", body: JSON.stringify(body) });
  const r = await (await L.handleRequest(req({ ...sinNumero, input: {} }), {})).json();
  assert.strictEqual(r.contactoSinNumero, true);
  assert.match(r.pedirCelular, /numero de celular/);
  const r2 = await (await L.handleRequest(req({ execution_context: { context: { phone_number: "51947071569" } }, input: {} }), {})).json();
  assert.strictEqual(r2.contactoSinNumero, undefined, "con numero no agrega nada");
  console.log("OK: aviso de contacto sin numero");
})().catch((e) => { console.error("FALLO:", e && e.stack || e); process.exit(1); });
