#!/usr/bin/env node
// Test del ruteo de cobros del Kenku 600 (fetch mockeado).
// Correr: node functions/shalom-router/test/router.test.cjs
//
// Lo que se protege aca es que el mismo mensaje tome SIEMPRE el mismo camino.
// Es un flujo de plata: un boton contestado por el bot pisa las cuentas que
// manda el dashboard, y un "gracias" contestado gasta una respuesta de mas.
const path = require("path");
require(path.join(__dirname, "..", "index.js"));
const assert = require("assert");
const { handleRequest } = globalThis.__kenkuShalomRouter;

const AHORA = Math.floor(Date.now() / 1000);
const hace = (horas) => String(AHORA - Math.round(horas * 3600));

const ENV = { KAPSO_API_KEY: "k-test" };
const CTX = { whatsapp_context: { conversation: { id: "conv-1", phone_number_id: "1117623181444547" } } };

// El endpoint de mensajes devuelve del mas nuevo al mas viejo.
function conMensajes(lista) {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("/whatsapp/conversations") === false);
    assert.ok(String(url).includes("conversation_id=conv-1"), "filtra por la conversacion");
    return { ok: true, json: async () => ({ data: lista }) };
  };
}

const entrante = (extra, horas = 0.1) => ({ kapso: { direction: "inbound" }, timestamp: hace(horas), ...extra });
const saliente = (horas) => ({ kapso: { direction: "outbound" }, timestamp: hace(horas), type: "text" });

const boton = (texto) => entrante({ type: "button", button: { text: texto } });
const texto = (cuerpo, horas) => entrante({ type: "text", text: { body: cuerpo } }, horas);
const adjunto = (tipo) => entrante({ type: tipo });

const ENTRADA = ["boton", "trivial", "voucher", "texto"];
const COMPUERTA = ["voucher", "texto", "recordar", "fin"];

async function ruta(mensajes, edges) {
  conMensajes(mensajes);
  const req = { json: async () => ({ ...CTX, available_edges: edges }) };
  const res = await handleRequest(req, ENV);
  return JSON.parse(await res.text());
}

const casos = [
  // --- Decision 1: que llego ---
  ["boton de plantilla", [boton("Pagar con Yape")], ENTRADA, "boton"],
  ["boton con otra redaccion", [boton("Transferencia / Deposito")], ENTRADA, "boton"],
  ["boton sin tildes ni mayusculas", [boton("TRANSFERENCIA DEPOSITO")], ENTRADA, "boton"],
  ["captura de pago", [adjunto("image")], ENTRADA, "voucher"],
  ["voucher en PDF", [adjunto("document")], ENTRADA, "voucher"],
  ["cierre seco", [texto("ok")], ENTRADA, "trivial"],
  ["agradecimiento", [texto("Ok, muchas gracias 😊")], ENTRADA, "trivial"],
  ["saludo de cortesia", [texto("Buenas noches")], ENTRADA, "trivial"],
  ["solo emojis", [texto("👍👍")], ENTRADA, "trivial"],
  ["de acuerdo (acuse de Kapta)", [texto("De acuerdo")], ENTRADA, "trivial"],
  // Un numero suelto es un dato, no un acuse: DNI, celular, nro de operacion
  // o una cantidad. Los dos primeros son entrantes reales del 981.
  ["manda su celular", [texto("950558781")], ENTRADA, "texto"],
  ["manda su DNI", [texto("00514186")], ENTRADA, "texto"],
  ["nro de operacion", [texto("Ok 00514186")], ENTRADA, "texto"],
  ["una cantidad", [texto("2")], ENTRADA, "texto"],
  ["aviso de pago", [texto("ya pague")], ENTRADA, "texto"],
  ["consulta", [texto("donde lo recojo?")], ENTRADA, "texto"],
  // Un "no" despues de pedirle el saldo es rechazo del pago, no cierre: tiene
  // que llegar al agente para que derive, nunca irse a "fin" en silencio.
  ["rechazo seco", [texto("no")], ENTRADA, "texto"],
  ["rechazo cortes", [texto("No gracias")], ENTRADA, "texto"],
  ["no quiere el pedido", [texto("ya no lo quiero")], ENTRADA, "texto"],
  ["quiere cancelar", [texto("cancelar")], ENTRADA, "texto"],
  ["quiere devolver", [texto("devolver")], ENTRADA, "texto"],
  ["nunca", [texto("nunca")], ENTRADA, "texto"],
  ["anular", [texto("anular")], ENTRADA, "texto"],
  ["sin mensaje legible", [], ENTRADA, "texto"],
  // Compatibilidad: contra la definicion vieja, sin arista "trivial", un
  // cierre trivial tiene que caer en "texto" y no romper la ejecucion.
  ["trivial sin arista trivial", [texto("gracias")], ["boton", "voucher", "texto"], "texto"],

  // --- Decision 2: la compuerta de las 6h ---
  // El dashboard le mando las cuentas despues del boton: el recordatorio sobra.
  ["ya le respondieron", [entrante({ type: "button", button: { text: "Pagar con Yape" } }, 6), saliente(5.9)], COMPUERTA, "fin"],
  ["mando el voucher durante la espera", [adjunto("image")], COMPUERTA, "voucher"],
  ["escribio durante la espera", [texto("cuanto es el saldo?")], COMPUERTA, "texto"],
  ["sigue callado, ventana abierta", [boton("Link de pago")], COMPUERTA, "recordar"],
  ["ventana de 24h cerrada", [entrante({ type: "button", button: { text: "Link de pago" } }, 23.5)], COMPUERTA, "fin"],
];

let fallos = 0;
(async () => {
  for (const [nombre, mensajes, edges, esperado] of casos) {
    const out = await ruta(mensajes, edges);
    const ok = out.next_edge === esperado;
    if (!ok) fallos += 1;
    console.log(`${ok ? "ok  " : "FALLA"} ${nombre.padEnd(34)} -> ${out.next_edge} (${out.reason})`);
  }
  console.log(`\n${casos.length - fallos}/${casos.length}`);
  process.exit(fallos ? 1 : 0);
})();
