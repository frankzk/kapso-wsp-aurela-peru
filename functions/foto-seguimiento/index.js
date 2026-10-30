// foto-seguimiento: la foto o el video que acompana a los seguimientos 3 a 6 de la escalera, SIN modelo de IA.
// Reemplaza a los mini-agentes fu-m3..fu-m6 (3 a 4 llamadas a gpt-4.1 cada uno solo para mandar una foto).
//
// Mismo orden que antes: 3ra foto, video, 4ta foto, 5ta foto. Cada llamada manda la siguiente pieza de la lista; si
// esa pieza no existe (el producto tiene menos fotos o no tiene video), no manda nada, igual que los mini-agentes.
// El producto sale de KV (last_product:<conversationId>, lo guarda presentar-producto) o de las variables
// last_product_handle / last_product_title del flujo; sin producto no manda nada.

const STORE_URL_DEFAULT = "https://aurela.pe";
const DEFAULT_PHONE_NUMBER_ID = "1241790819006805";
const API_VERSION = "v24.0";
const SEQUENCE = [
  { kind: "image", index: 2 },
  { kind: "video" },
  { kind: "image", index: 3 },
  { kind: "image", index: 4 },
];

async function handler(request, env) {
  return handleRequest(request, env || globalThis);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => event.respondWith(handleRequest(event.request, globalThis)));
}

async function handleRequest(request, env = globalThis) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  try {
    return json(await enviarSiguiente(payload, env));
  } catch (error) {
    return json({ ok: false, sent: null, error: String(error && error.message || error) });
  }
}

async function enviarSiguiente(payload, env) {
  const input = isObj(payload.input) ? { ...payload, ...payload.input } : payload;
  const ctx = isObj(payload.execution_context) ? payload.execution_context : {};
  const c = isObj(ctx.context) ? ctx.context : {};
  const vars = isObj(ctx.vars) ? ctx.vars : {};
  const conversationId = input.conversationId || c.conversation_id || payload.whatsapp_context?.conversation?.id || "";
  const phoneNumberId = input.phoneNumberId || c.phone_number_id || payload.whatsapp_context?.conversation?.phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  if (!conversationId) return { ok: true, sent: null, reason: "sin_conversacion" };

  let product = null;
  try { const raw = env?.KV ? await env.KV.get(`last_product:${conversationId}`) : null; product = raw ? JSON.parse(raw) : null; } catch { product = null; }
  if (!product && (vars.last_product_handle || vars.last_product_title)) {
    product = await productFromStore(env, vars.last_product_handle, vars.last_product_title);
  }
  if (!product || (!product.images?.length && !product.video)) return { ok: true, sent: null, reason: "sin_producto" };

  if (input.dryRun || input.dry_run) return { ok: true, dryRun: true, product: product.title, images: (product.images || []).length, video: Boolean(product.video) };
  const idxKey = `fu_media_idx:${conversationId}`;
  let idx = 0;
  try { idx = Number(env?.KV ? await env.KV.get(idxKey) : 0) || 0; } catch { idx = 0; }
  try { if (env?.KV) await env.KV.put(idxKey, String(idx + 1), { expirationTtl: 3 * 24 * 3600 }); } catch { /* KV opcional */ }
  const step = SEQUENCE[idx];
  if (!step) return { ok: true, sent: null, reason: "secuencia_terminada" };
  const link = step.kind === "video" ? product.video : (product.images || [])[step.index];
  if (!link) return { ok: true, sent: null, reason: `sin_${step.kind}` };

  const apiKey = await getEnv(env, "KAPSO_API_KEY");
  const apiBase = (await getEnv(env, "KAPSO_API_BASE")) || "https://api.kapso.ai";
  if (!apiKey) return { ok: false, sent: null, reason: "missing_kapso_key" };
  const recipient = await recipientFor(c, { apiKey, apiBase, phoneNumberId }, conversationId);
  if (!recipient) return { ok: false, sent: null, reason: "missing_recipient" };

  const caption = String(product.title || "").slice(0, 1024);
  const msg = { messaging_product: "whatsapp", ...recipient, type: step.kind, [step.kind]: { link, ...(caption ? { caption } : {}) } };
  const r = await fetch(`${apiBase}/meta/whatsapp/${API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(msg),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.messages?.[0]?.id) return { ok: false, sent: null, error: JSON.stringify(data?.error || data).slice(0, 300) };
  return { ok: true, sent: step.kind, index: idx };
}

async function productFromStore(env, handle, title) {
  const h = String(handle || "").trim();
  if (!h) return null;
  try {
    const storeUrl = String((await getEnv(env, "STORE_PUBLIC_URL")) || STORE_URL_DEFAULT).replace(/\/+$/, "");
    const r = await fetch(`${storeUrl}/products/${encodeURIComponent(h)}.js`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const p = await r.json();
    const images = (p.images || []).map((s) => (typeof s === "string" ? s : s?.src)).filter(Boolean);
    let video = "";
    for (const m of p.media || []) {
      if (m?.media_type !== "video") continue;
      const srcs = (m.sources || []).filter((s) => s?.url).sort((a, b) => (Number(a.height) || 1e9) - (Number(b.height) || 1e9));
      if (srcs[0]) { video = srcs[0].url; break; }
    }
    return { handle: h, title: p.title || title || "", images, video };
  } catch {
    return null;
  }
}

async function recipientFor(c, kapso, conversationId) {
  const digits = (v) => String(v || "").replace(/\D/g, "");
  const phone = digits(c.phone_number || c.wa_id);
  if (phone.length >= 9) return { to: phone };
  try {
    const r = await fetch(`${kapso.apiBase}/meta/whatsapp/${API_VERSION}/${encodeURIComponent(kapso.phoneNumberId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&direction=inbound&limit=5`, { headers: { "X-API-Key": kapso.apiKey } });
    const data = (await r.json())?.data || [];
    for (const m of data) {
      const p = digits(m?.kapso?.phone_number || m?.from);
      if (p.length >= 9) return { to: p };
    }
    const bsuid = c.whatsapp_business_scoped_user_id || data.map((m) => m?.from_user_id).find(Boolean);
    return bsuid ? { recipient: bsuid } : null;
  } catch {
    return c.whatsapp_business_scoped_user_id ? { recipient: c.whatsapp_business_scoped_user_id } : null;
  }
}

async function getEnv(env, name) {
  const alt = name.replace(/_/g, "").replace(/^./, (x) => x.toLowerCase());
  const direct = env?.[name] || env?.[alt] || globalThis[name] || globalThis[alt];
  if (direct) return String(direct);
  try { const v = env?.KV ? await env.KV.get(name) : null; if (v) return String(v); } catch { /* KV opcional */ }
  return "";
}

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.__aurelaFotoSeguimiento = { handleRequest, enviarSiguiente, SEQUENCE };
