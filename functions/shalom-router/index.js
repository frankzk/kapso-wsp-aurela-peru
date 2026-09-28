// shalom-router: ruteo deterministico del workflow de cobros del Kenku 600.
//
// Lo llama un nodo Decide. NO usa ningun LLM: mira el ultimo mensaje entrante y
// devuelve por que arista seguir. En un flujo de plata eso importa mas que la
// flexibilidad: el mismo mensaje siempre toma el mismo camino.
//
// NO se reuso check-coverage a proposito: esa funcion rutea por
// `available_edges` y cae en routeFollowup, que es la escalera de VENTAS. El
// cobro de saldos necesita su propia logica, y mezclarlas ataria los dos flujos.
//
// Dos decisiones, segun las aristas disponibles:
//   entrada  (boton | voucher | texto)  -> que llego
//   recordar (recordar | fin)           -> si corresponde el recordatorio de 6h

// Botones de la plantilla guias_shalom. Los contesta el DASHBOARD con las
// cuentas de cobro; el bot no responde nada. Se listan las dos redacciones del
// boton del medio porque difieren entre guias_shalom ("Transferencia Deposito")
// y guias_shalom_imagen ("Transferencia / Deposito").
const BOTONES = new Set([
  "pagar con yape",
  "transferencia deposito",
  "transferencia / deposito",
  "link de pago",
]);

function limpiar(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function esBoton(texto) {
  return BOTONES.has(limpiar(texto));
}

// Cierres triviales que NO necesitan respuesta: "ok", "gracias", "listo",
// "buenas noches", o solo emojis. El sistema ya le repitio su saldo y el Yape;
// contestarlos solo agrega ruido. Se filtran aca, sin gastar una llamada al
// modelo para decidir callarse.
//
// ESTA LISTA TIENE QUE SER IGUAL A LA DE ACUSES DE KAPTA. Donde el router
// calla, Kapta contesta con el saldo y el Yape; donde el router habla, Kapta
// calla. Una palabra que este aca y no alla deja a la clienta sin NINGUNA
// respuesta; una que este alla y no aca le manda DOS. Si cambia una, avisar y
// cambiar la otra.
//
// "no" NO va aca a proposito, ni "nunca", "cancelar", "anular" ni "devolver":
// despues de pedirle un saldo, un "no" o un "no gracias" no es un cierre, es
// un rechazo del pago, y eso abre el flujo de devolucion. Mandarlo a "fin" en
// silencio pierde la senal justo cuando mas vale.
const TRIVIALES = new Set([
  "ok","oka","okey","oki","okis","ya","listo","lista","gracias","muchas","mil",
  "si","buenas","buenos","noches","dias","dia","buen","buena","tardes",
  "de","nada","bien","vale","perfecto","entendido","amable","muy","ah","aah",
  "bueno","genial","excelente","correcto","claro","dale","conforme","acuerdo",
]);

// Un numero suelto NUNCA es trivial: puede ser el DNI, el celular, el numero de
// operacion del Yape o una cantidad. Medido en el 981: entre los entrantes que
// se ven como acuse aparecen "950558781" y "00514186". Callarse ahi es el peor
// error posible, porque es justo el dato que la clienta esta mandando.
function esTrivial(texto) {
  const base = limpiar(texto);
  if (/\d/.test(base)) return false;
  const limpio = base.replace(/[^a-z\s]/g, " ").trim();
  if (!limpio) return true;            // solo emojis o signos
  return limpio.split(/\s+/).every((w) => TRIVIALES.has(w));
}

// El texto visible de un entrante, venga como boton de plantilla (type
// "button"), boton interactivo o texto suelto.
function textoEntrante(m) {
  return String(
    m?.button?.text
    || m?.interactive?.button_reply?.title
    || m?.interactive?.list_reply?.title
    || m?.text?.body
    || m?.kapso?.content
    || ""
  );
}

function contexto(payload) {
  const c = payload.whatsapp_context?.conversation || {};
  return {
    conversationId: c.id || payload.execution_context?.context?.conversation_id || "",
    phoneNumberId: c.phone_number_id
      || payload.execution_context?.system?.whatsapp_config?.phone_number_id
      || payload.execution_context?.context?.phone_number_id || "",
  };
}

async function mensajes(payload, env) {
  const apiKey = env.KAPSO_API_KEY || env.kAPSOAPIKEY || globalThis.KAPSO_API_KEY || "";
  const { conversationId, phoneNumberId } = contexto(payload);
  if (!apiKey || !conversationId || !phoneNumberId) return [];
  try {
    const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${encodeURIComponent(phoneNumberId)}/messages`
      + `?conversation_id=${encodeURIComponent(conversationId)}&limit=20`;
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!res.ok) return [];
    return (await res.json())?.data || [];
  } catch { return []; }
}

// El endpoint devuelve del mas nuevo al mas viejo.
function ultimoEntrante(lista) {
  let mejor = null, t = -1;
  for (const m of lista) {
    if (m?.kapso?.direction !== "inbound") continue;
    const ts = Number(m?.timestamp || 0);
    if (ts >= t) { t = ts; mejor = m; }
  }
  return mejor;
}

function ultimoSaliente(lista) {
  let t = 0;
  for (const m of lista) {
    if (m?.kapso?.direction === "outbound") t = Math.max(t, Number(m?.timestamp || 0));
  }
  return t;
}

async function handleRequest(request, env = globalThis) {
  const payload = await readJson(request);
  const edges = Array.isArray(payload.available_edges) ? payload.available_edges : [];
  const lista = await mensajes(payload, env);
  const entrante = ultimoEntrante(lista);
  const texto = textoEntrante(entrante);

  // --- Decision 2: la compuerta despues de las 6h de espera ---
  // Reclasifica desde cero en vez de asumir que el cliente sigue callado: si
  // mando el voucher o escribio DURANTE la espera, hay que atenderlo, no
  // mandarle un recordatorio de pago que ya no corresponde.
  if (edges.includes("recordar")) {
    const tIn = Number(entrante?.timestamp || 0);
    const tOut = ultimoSaliente(lista);
    // Alguien ya le escribio despues de su ultimo mensaje (el dashboard le
    // mando las cuentas, o una asesora entro): el recordatorio sobra.
    if (tOut > tIn) return json({ next_edge: "fin", reason: "ya_le_respondieron" });

    const tipo = entrante?.type || "";
    if (tipo === "image" || tipo === "document") {
      return json({ next_edge: "voucher", reason: `mando_voucher_durante_la_espera_${tipo}` });
    }
    if (entrante && !esBoton(texto)) {
      return json({ next_edge: "texto", reason: "escribio_durante_la_espera" });
    }

    // Sigue callado desde el boton. Ventana de WhatsApp: pasadas ~24h del
    // ultimo entrante no se puede mandar texto libre (131026 / 131047), asi
    // que no se intenta.
    const horas = tIn ? (Date.now() / 1000 - tIn) / 3600 : 99;
    if (horas >= 23) return json({ next_edge: "fin", reason: "ventana_24h_cerrada" });
    return json({ next_edge: "recordar", reason: `sin_respuesta_${horas.toFixed(1)}h` });
  }

  // --- Decision 1: que llego ---
  if (!entrante) return json({ next_edge: "texto", reason: "sin_mensaje_legible" });
  if (esBoton(texto)) return json({ next_edge: "boton", reason: "boton_de_cobro" });
  const tipo = entrante.type || "";
  if (tipo === "image" || tipo === "document") {
    return json({ next_edge: "voucher", reason: `adjunto_${tipo}` });
  }
  if (edges.includes("trivial") && esTrivial(texto)) {
    return json({ next_edge: "trivial", reason: "cierre_trivial" });
  }
  return json({ next_edge: "texto", reason: "texto_libre" });
}

async function handler(request, env = globalThis) { return handleRequest(request, env); }
if (typeof addEventListener === "function") {
  addEventListener("fetch", (e) => e.respondWith(handleRequest(e.request, globalThis)));
}
async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
globalThis.__kenkuShalomRouter = { handler, handleRequest, esBoton, esTrivial, textoEntrante, ultimoEntrante };
