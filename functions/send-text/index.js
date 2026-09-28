// Envia un mensaje de texto al cliente SANITIZANDO la narracion interna del
// agente. Reemplaza a send_notification_to_user.
//
// Por que existe: el agente corre con message_delivery_mode="tool_only", asi que
// su texto suelto nunca se entrega y la UNICA salida es la herramienta de envio.
// Un modelo chico (gpt-4.1-mini) que "piensa en voz alta" mete su plan en el
// argumento de la herramienta y el cliente termina leyendo cosas como
// "Ambos valores existen, asi que procedo con el product_media_lookup" o
// "Ahora completo la tarea". La regla del prompt que lo prohibe (con esas frases
// textuales, en prioridad maxima) NO alcanzo: siguio filtrando. Asi que se
// bloquea por codigo, no por instruccion.
//
// Estrategia: se limpia frase por frase. Si queda contenido util, se envia solo
// eso; si el mensaje era pura narracion, no se envia nada y se le devuelve al
// agente una instruccion para que mande contenido real.
//
// SEGURIDAD: si el sanitizador falla por cualquier motivo, se envia el texto
// ORIGINAL. Degradar a "puede filtrarse algo" es mucho menos grave que dejar al
// bot mudo con todos los clientes.

// Nombres de herramientas internas. Jamas aparecen en un mensaje legitimo al
// cliente, asi que son la senal mas confiable de narracion.
const TOOL_NAMES = [
  "complete_task", "handoff_to_human", "save_variable", "get_variable",
  "enter_waiting", "send_media", "send_notification_to_user", "send_text",
  "get_whatsapp_context", "get_current_datetime", "get_execution_metadata",
  "product_media_lookup", "shopify_product_lookup", "check_coverage",
  "create_shopify_order", "customer_lookup", "send_buttons", "send_payment",
  "quote_order", "notify_team", "loop_guard", "campaign_report",
  "send_presentation",
];

// Frases de proceso/estado. Ancladas a proposito para no pisar texto legitimo:
// "te paso el precio" o "te vamos a llamar a tu numero" NO deben caer aca.
// Se prueban contra el texto SIN acentos (ver stripAccents): escribirlos aca sin
// tilde alcanza para las dos formas. Antes habia que duplicar cada patron
// ("dejame"/"déjame") y el que se olvidaba se colaba: asi paso
// "El producto no fue encontrado en la busqueda de medios" (con tilde en
// "búsqueda") entera al cliente.
const PROCESS_PATTERNS = [
  /\bprocedo\s+con\b/i,
  /\bahora\s+(procedo|llamo|completo|envio|uso)\b/i,
  /\bvoy\s+a\s+(llamar|usar|ejecutar|invocar)\b/i,
  /\bprimero\s+(llamo|voy\s+a\s+llamar)\b/i,
  /\bpaso\s+\d+\s*:/i,
  /\bel\s+resultado\s+(muestra|devolvio|indica)\b/i,
  /\bambos\s+valores\s+existen\b/i,
  /\bla\s+herramienta\s+(devolvio|indica|dice)\b/i,
  /\b(el\s+)?lookup\s+(devolvio|muestra)\b/i,
  /\bhago\s+el\s+lookup\b/i,
  /\bdejame\s+revisar\b/i,
  /\bcompleto\s+la\s+tarea\b/i,
  /\bfinalizar\s+la\s+tarea\b/i,
  // Narracion de resultados internos de herramientas.
  /\bsegun\s+(las\s+)?instrucciones\b/i,
  /\bdebo\s+(llamar|usar|ejecutar|invocar|enviar)\b/i,
  /\bno\s+fue\s+encontrado\s+en\s+la\s+busqueda\b/i,
  /\bbusqueda\s+de\s+medios\b/i,
  /\bno\s+(devolvio|arrojo)\s+(resultados|nada|datos)\b/i,
  /\b(la\s+)?(busqueda|consulta)\s+no\s+(devolvio|arrojo|encontro)\b/i,
];

function stripAccents(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function looksLikeNarration(fragment) {
  const text = stripAccents(fragment);
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  for (const tool of TOOL_NAMES) {
    if (lower.includes(tool)) return true;
  }
  for (const re of PROCESS_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// Corta en frases conservando el separador, para poder descartar solo la parte
// narrada y conservar el resto del mensaje.
function splitFragments(text) {
  const parts = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) { parts.push(line); continue; }
    const chunks = line.match(/[^.!?]+[.!?]*\s*/g) || [line];
    for (const c of chunks) parts.push(c);
    parts.push("\n");
  }
  return parts;
}

// true si el texto no tiene letras/numeros suficientes para ser un mensaje real
// (queda solo puntuacion, espacios o emojis).
function hasNoRealContent(text) {
  const letters = String(text || "").replace(/[^\p{L}\p{N}]/gu, "");
  return letters.length < 3;
}

// Devuelve { clean, removed }. Nunca lanza: ante cualquier problema devuelve el
// texto original sin tocar (fail-open deliberado, ver cabecera).
function sanitize(text) {
  try {
    const original = String(text == null ? "" : text);
    if (!original.trim()) return { clean: "", removed: [] };

    const removed = [];
    let clean = splitFragments(original)
      .map((frag) => {
        if (frag === "\n" || !frag.trim()) return frag;
        if (looksLikeNarration(frag)) { removed.push(frag.trim()); return ""; }
        return frag;
      })
      .join("");

    clean = clean.replace(/\n{3,}/g, "\n\n").trim();
    // Si tras limpiar solo quedan emojis/signos sueltos, no vale la pena enviar
    // nada: se trata como bloqueado para no mandar un "." o un "🙌" solitario.
    if (hasNoRealContent(clean)) return { clean: "", removed: removed.length ? removed : [original.trim()] };
    return { clean, removed };
  } catch {
    return { clean: String(text == null ? "" : text), removed: [], failed: true };
  }
}

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  try {
    const payload = await readJson(request);
    const input = isPlainObject(payload.input) ? payload.input : payload;

    const raw = input.text ?? input.body ?? input.message ?? input.content ?? "";
    const { clean, removed } = sanitize(raw);

    if (!clean.trim()) {
      // Todo el mensaje era narracion: no se envia nada.
      return json({
        ok: false,
        reason: "narration_blocked",
        removed,
        message: "NO se envio nada: ese texto era narracion de tu proceso interno, no contenido para el cliente. El cliente jamas debe leer que vas a llamar una herramienta, en que paso vas, ni que devolvio un lookup. Si necesitas una herramienta, USALA directo. Si te toca escribirle, manda SOLO contenido util (producto, precio, promo, una pregunta o el cierre).",
      });
    }

    const apiKey = env.KAPSO_API_KEY || env.kAPSOAPIKEY || globalThis.KAPSO_API_KEY || "";
    const conv = payload.whatsapp_context?.conversation || {};
    const phoneNumberId =
      input.phoneNumberId ||
      conv.phone_number_id ||
      payload.whatsapp_context?.phone_number_id ||
      payload.execution_context?.system?.whatsapp_config?.phone_number_id ||
      payload.execution_context?.context?.phone_number_id;
    const to =
      input.to ||
      conv.phone_number ||
      payload.execution_context?.context?.phone_number;

    // Los leads que entran por username no tienen phone_number, solo un BSUID
    // ("PE.948592654941065"). Meta NO los direcciona por `to`: para ellos el
    // campo es `recipient`. Mandar el BSUID en `to` parece funcionar (responde
    // 200 con un messageId) pero Meta le quita el prefijo de pais y lo trata
    // como telefono, asi que el mensaje termina en 131026 "Message
    // undeliverable" y el cliente no recibe nada. Se ve en la respuesta:
    // con `to` el eco vuelve como "wa_id":"948592654941065", con `recipient`
    // vuelve como "user_id":"PE.948592654941065", que es el que llega.
    const bsuid =
      input.recipient ||
      conv.business_scoped_user_id ||
      payload.execution_context?.context?.business_scoped_user_id ||
      conv.businessScopedUserId ||
      payload.execution_context?.context?.businessScopedUserId;

    if (!apiKey || !phoneNumberId || !(to || bsuid)) {
      return json({
        ok: false,
        reason: "missing_context",
        text: clean,
        message: "No pude enviar por falta de contexto. Envia EXACTAMENTE el texto del campo `text` y nada mas.",
      });
    }

    const response = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Si hay telefono se usa `to`; si el lead entro por username, `recipient`.
        ...(to ? { to } : { recipient: bsuid }),
        type: "text",
        text: { body: clean },
      }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return json({
        ok: false,
        reason: "send_failed",
        status: response.status,
        text: clean,
        error: JSON.stringify(result).slice(0, 300),
        message: "Fallo el envio. Envia EXACTAMENTE el texto del campo `text` y nada mas.",
      });
    }

    return json({
      ok: true,
      sent: true,
      sanitized: removed.length > 0,
      removed,
      messageId: (result.messages && result.messages[0] && result.messages[0].id) || null,
      message: removed.length
        ? "Mensaje enviado, pero se DESCARTO narracion interna que habias incluido. No vuelvas a escribir lo que vas a hacer: usa la herramienta directo."
        : "Mensaje enviado al cliente.",
    });
  } catch (error) {
    return json({ ok: false, reason: "send_text_error", error: safeError(error) });
  }
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

globalThis.__kenkuSendText = { sanitize, looksLikeNarration, handleRequest, handler };
