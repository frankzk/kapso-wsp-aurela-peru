// send-buttons: envia un mensaje interactivo de WhatsApp con botones de respuesta
// rapida (hasta 3, 20 chars c/u) via la API de Kapso. Es una herramienta del
// agente: deriva el destinatario del contexto de la conversacion; el bot solo
// pasa el texto (body) y, opcionalmente, los botones (por defecto Lima/Provincia).
const DEFAULT_PHONE_NUMBER_ID = "1241790819006805";
const DEFAULT_API_VERSION = "v24.0";
const DEFAULT_BUTTONS = [
  { id: "loc_lima", title: "Lima" },
  { id: "loc_provincia", title: "Provincia" },
];

async function handler(request, env = globalThis) {
  return handleRequest(request, env || globalThis);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  try {
    const payload = await readJson(request);
    const input = isPlainObject(payload.input) ? { ...payload, ...payload.input } : payload;
    const ctx = isPlainObject(payload.execution_context) ? payload.execution_context : {};
    const ctxContext = isPlainObject(ctx.context) ? ctx.context : {};

    const body = String(input.body || input.text || input.message || "").trim();
    if (!body) return json({ ok: false, reason: "missing_body" });

    const to = normalizePhone(
      input.to || input.recipient || input.phone || ctxContext.phone_number || ctxContext.phone
      || findLatestInboundFrom(payload),
    );
    if (!to) return json({ ok: false, reason: "missing_recipient" });

    const buttons = normalizeButtons(input.buttons) || DEFAULT_BUTTONS;
    const phoneNumberId = input.phoneNumberId || input.phone_number_id || ctxContext.phone_number_id || DEFAULT_PHONE_NUMBER_ID;

    const message = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    };

    if (input.dryRun) return json({ ok: true, dryRun: true, to, message });

    const { apiKey, apiBase } = await getKapsoConfig(env);
    if (!apiKey) return json({ ok: false, reason: "missing_kapso_key" });

    const url = `${apiBase}/meta/whatsapp/${DEFAULT_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json({ ok: false, reason: "send_failed", status: response.status, error: data });
    return json({ ok: true, to, buttons: buttons.map((b) => b.title), messageId: data?.messages?.[0]?.id || null });
  } catch (error) {
    return json({ ok: false, reason: "error", error: safeError(error) });
  }
}

function normalizeButtons(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = [];
  for (const b of raw.slice(0, 3)) {
    const title = String((isPlainObject(b) ? (b.title || b.label || b.text) : b) || "").trim();
    if (!title) continue;
    const id = String((isPlainObject(b) && (b.id || b.value)) || `btn_${out.length + 1}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`).slice(0, 250);
    out.push({ id, title });
  }
  return out.length ? out : null;
}

function findLatestInboundFrom(payload) {
  const messages = payload?.whatsapp_context?.messages;
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    const dir = m?.kapso?.direction || m?.direction;
    if (dir === "inbound" && (m.from || m.phone_number)) return m.from || m.phone_number;
  }
  return "";
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits.length >= 8 ? digits : "";
}

async function getKapsoConfig(env = globalThis) {
  let apiKey = env.KAPSO_API_KEY || env.kAPSOAPIKEY || globalThis.KAPSO_API_KEY || globalThis.kAPSOAPIKEY;
  if (!apiKey && env?.KV?.get) {
    try { apiKey = await env.KV.get("KAPSO_API_KEY"); } catch { /* sin KV */ }
  }
  const apiBase = env.KAPSO_API_BASE || env.kAPSOAPIBASE || globalThis.KAPSO_API_BASE || "https://api.kapso.ai";
  return { apiKey, apiBase };
}

async function readJson(request) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return Object.fromEntries(url.searchParams.entries());
  }
  const text = await request.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }
function safeError(e) { return e instanceof Error ? e.message : String(e); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

globalThis.__aurelaSendButtons = { handleRequest, handler, normalizeButtons, normalizePhone };
