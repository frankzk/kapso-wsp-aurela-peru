// notify-team: alerta interna al equipo por Telegram.
// Se invoca cuando un cliente envia el voucher/adelanto (flujo Shalom/Olva) y el
// bot deriva a validacion logistica. NUNCA escribe al cliente: solo manda un push
// al chat de Telegram del dueno via la Bot API.

const TELEGRAM_API_BASE = "https://api.telegram.org";

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  const payload = await readJson(request);
  const config = getConfig(env);

  if (!config.token || !config.chatId) {
    // Falta credencial: no rompas el flujo, solo reporta ok=false (sin filtrar el token).
    return json({ ok: false, reason: "missing_telegram_config" });
  }

  const text = buildMessage(payload);

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      let description = "";
      try {
        const data = await res.json();
        description = data && data.description ? String(data.description) : "";
      } catch {
        // ignore parse errors
      }
      return json({ ok: false, reason: "telegram_error", status: res.status, description });
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, reason: "request_failed", error: String(err && err.message ? err.message : err) });
  }
}

function headerFor(reason) {
  const r = String(reason || "").trim().toLowerCase();
  if (r.includes("reclamo") || r.includes("queja")) return "🔴 <b>RECLAMO — atender URGENTE</b>";
  if (r.includes("mayorista")) return "📦 <b>Pedido mayorista — coordinar</b>";
  if (r) return `🔔 <b>${escapeHtml(String(reason).trim())}</b>`;
  // Sin reason: comportamiento previo (flujo de voucher Shalom/Olva).
  return "🟢 <b>Voucher recibido — validar y enviar</b>";
}

function buildMessage(payload) {
  const p = payload || {};
  const lines = [];
  lines.push(headerFor(p.reason));

  const rows = [
    ["Cliente", p.customerName],
    ["Telefono", p.phone],
    ["Producto", p.product],
    ["Total", formatTotal(p.total)],
    ["Courier", p.courier],
    ["Agencia/Direccion", p.destination],
    ["DNI", p.dni],
    ["Pago reportado", p.paymentReported],
    ["Nota", p.note],
  ];

  for (const [label, value] of rows) {
    const clean = cleanValue(value);
    if (clean) lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(clean)}`);
  }

  return lines.join("\n");
}

function formatTotal(total) {
  if (total === undefined || total === null || total === "") return "";
  if (typeof total === "number") return `S/ ${total}`;
  const str = String(total).trim();
  if (!str) return "";
  return /^s\/?/i.test(str) ? str : `S/ ${str}`;
}

function cleanValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getConfig(env = globalThis) {
  const token =
    env.TELEGRAM_BOT_TOKEN ||
    env.tELEGRAMBOTTOKEN ||
    globalThis.TELEGRAM_BOT_TOKEN ||
    globalThis.tELEGRAMBOTTOKEN;
  const chatId =
    env.TELEGRAM_CHAT_ID ||
    env.tELEGRAMCHATID ||
    globalThis.TELEGRAM_CHAT_ID ||
    globalThis.tELEGRAMCHATID;
  return { token, chatId };
}

async function readJson(request) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return Object.fromEntries(url.searchParams.entries());
  }

  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { note: text };
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

globalThis.__aurelaNotifyTeam = {
  buildMessage,
  getConfig,
  handleRequest,
  handler,
};
