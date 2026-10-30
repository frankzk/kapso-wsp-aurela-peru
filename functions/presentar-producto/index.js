// presentar-producto: envia la presentacion completa de un producto (video/fotos + precio + promos con botones
// Lima/Provincia) en UNA sola llamada del agente. Antes el agente la armaba con 8-9 llamadas al modelo
// (product_media_lookup, send_media x3, send_buttons, save_variable...): eran el 71% de los tokens del bot
// (medido del 28 al 30-10-2026). El texto es el mismo que pedia el prompt; aqui ya no depende del modelo.
//
// Formato segun el origen de la conversacion (misma clave de KV que check-coverage: origen:<conversationId>):
//   anuncio  (Click-to-WhatsApp, mensajes gratis): video, texto de precio, hasta 2 fotos, promos con botones.
//   organico (web/directo, cada mensaje se cobra): video o foto con el precio en el caption + botones con foto.
//
// Datos del producto: /products/<handle>.js de la tienda (WooCommerce con cod-core, formato Shopify).
// Guarda el producto en KV (last_product:<conversationId>) para las fotos de los seguimientos.

const STORE_URL_DEFAULT = "https://aurela.pe";
const DEFAULT_PHONE_NUMBER_ID = "1241790819006805";
const API_VERSION = "v24.0";
const FREE_SHIPPING_FROM = 40;
const KV_TTL_S = 3 * 24 * 3600;
const SEND_GAP_MS = 1200;
const LIMA_PROVINCIA = [
  { id: "loc_lima", title: "Lima" },
  { id: "loc_provincia", title: "Provincia" },
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
  const input = isObj(payload.input) ? { ...payload, ...payload.input } : payload;
  try {
    return json(await presentar(input, payload, env));
  } catch (error) {
    return json({ ok: false, reason: "error", sent: [], error: String(error && error.message || error) });
  }
}

async function presentar(input, payload, env) {
  const ctx = isObj(payload.execution_context) ? payload.execution_context : {};
  const c = isObj(ctx.context) ? ctx.context : {};
  const conversationId = input.conversationId || input.conversation_id || c.conversation_id || payload.whatsapp_context?.conversation?.id || "";
  const phoneNumberId = input.phoneNumberId || input.phone_number_id || c.phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  const handle = handleFrom(input.handle || input.url || input.productUrl || "");
  if (!handle) return { ok: false, reason: "missing_handle", sent: [] };

  const storeUrl = String((await getEnv(env, "STORE_PUBLIC_URL")) || STORE_URL_DEFAULT).replace(/\/+$/, "");
  const res = await fetch(`${storeUrl}/products/${encodeURIComponent(handle)}.js`, { headers: { Accept: "application/json", "User-Agent": "Aurela-Kapso-Bot/1.0" } });
  if (!res.ok) return { ok: false, reason: "product_not_found", handle, sent: [] };
  const product = await res.json();
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (!variants.some((v) => v.available)) return { ok: false, reason: "out_of_stock", handle, sent: [] };

  const apiKey = await getEnv(env, "KAPSO_API_KEY");
  const apiBase = (await getEnv(env, "KAPSO_API_BASE")) || "https://api.kapso.ai";
  if (!apiKey) return { ok: false, reason: "missing_kapso_key", sent: [] };
  const kapso = { apiKey, apiBase, phoneNumberId };

  const history = conversationId ? await conversationMessages(kapso, conversationId) : null;
  const recipient = recipientFrom(input, c, history);
  if (!recipient) return { ok: false, reason: "missing_recipient", sent: [] };
  const firstContact = history ? !history.some((m) => dir(m) === "outbound") : false;
  const origen = await conversationOrigin(env, conversationId, history);

  const copy = buildCopy(product, { firstContact });
  const media = productMedia(product);
  const plan = origen === "organico" ? planOrganico(copy, media) : planAnuncio(copy, media);

  if (input.dryRun || input.dry_run) {
    return { ok: true, dryRun: true, origen, firstContact, recipient: recipient.to ? "telefono" : "usuario", plan, followupHint: `te quedó pendiente el *${copy.shortTitle}*` };
  }

  const sent = [];
  for (const [i, step] of plan.entries()) {
    // Pausa corta entre mensajes: enviados de corrido, WhatsApp a veces los entrega desordenados (botones antes que
    // la ultima foto).
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
    const r = await sendMessage(kapso, recipient, step);
    if (!r.ok) return { ok: false, reason: "send_failed", step: step.kind, error: r.error, sent, origen };
    sent.push(step.kind);
  }

  if (env?.KV && conversationId) {
    const lp = { handle: product.handle || handle, title: product.title, images: media.images.slice(0, 6), video: media.video || null, at: Date.now() };
    try { await env.KV.put(`last_product:${conversationId}`, JSON.stringify(lp), { expirationTtl: KV_TTL_S }); } catch { /* KV opcional */ }
    // Producto nuevo: las fotos de los seguimientos vuelven a empezar por la 3ra.
    try { await env.KV.put(`fu_media_idx:${conversationId}`, "0", { expirationTtl: KV_TTL_S }); } catch { /* KV opcional */ }
  }

  return {
    ok: true,
    origen,
    sent,
    product: { handle: product.handle || handle, title: product.title, price: money(product.price), compareAt: product.compare_at_price ? money(product.compare_at_price) : null, options: copy.options },
    followupHint: `te quedó pendiente el *${copy.shortTitle}* — recuerda que en la mayoría de zonas pagas al recibir y el envío es gratis 🙌`,
    instrucciones: "La presentacion YA se envio al cliente. No escribas texto ni mandes fotos ni botones. Guarda followup_hint (save_variable) con followupHint y llama complete_task.",
  };
}

// ----- Texto -----

function buildCopy(product, { firstContact }) {
  const title = String(product.title || "").trim();
  const shortTitle = title.split(/\s[-–—]\s/)[0].trim() || title;
  const price = money(product.price);
  const compare = product.compare_at_price ? money(product.compare_at_price) : 0;
  const footwear = /\b(sandalia|pantufla|slide|zapat|calzado|chancla)/i.test(title);
  const unit = footwear ? "par" : "unidad";
  const units = footwear ? "pares" : "unidades";
  const hola = firstContact ? "¡Hola! Soy *Akemi* de Aurela 😊\n\n" : "";
  const envio = price > FREE_SHIPPING_FROM ? " con *envío gratis* 📦" : "";
  const ancla = compare > price ? `\nAntes *S/ ${fmt(compare)}*, hoy *S/ ${fmt(price)}* 🔥` : "";
  const options = (product.options || [])
    .filter((o) => o && o.name && !/^title$/i.test(o.name) && Array.isArray(o.values) && o.values.length > 1)
    .map((o) => ({ name: o.name, values: availableValues(product, o) }))
    .filter((o) => o.values.length);
  const opciones = options.length ? "\n\n" + options.map((o) => `${o.name}: ${o.values.join(", ")}`).join(" · ") : "";
  const pregunta = "\n\nPara dejártelo listo, ¿eres de *Lima* o de *Provincia*? 😊";
  const key = productKey(title, product.handle);

  let precio;
  let promos;
  if (key === "beewax") {
    precio = `${hola}Sí, es la *BeeWax™ – Cera de Abeja Natural para Muebles* 🪵✨\n\n`
      + "Con una sola pasada la madera reseca vuelve a lucir *como nueva*: la nutre, la protege de rayones y humedad, y deja un *brillo natural que dura semanas*. Y rinde muchísimo — un pote de 300g te alcanza para varios muebles.\n\n"
      + `Queda en *S/ ${fmt(price)}*${envio} y en la mayoría de zonas *pagas al recibir* (revisas tu producto en la puerta antes de pagar 🙌).${ancla}`;
    promos = `🔥 *Aprovecha hoy:*\n• 1 unidad (300g): *S/ ${fmt(price)}*\n• *3x2*: llevas 3 por *S/ ${fmt(price * 2)}* (pagas 2) — para dejar *toda la casa* impecable\n• *5x3*: llevas 5 por *S/ ${fmt(price * 3)}* (pagas 3)${pregunta}`;
  } else {
    precio = `${hola}Sí, lo tengo: *${title}*.\n\nQueda en *S/ ${fmt(price)}* por ${unit}${envio} y en la mayoría de zonas *pagas al recibir* 😊.${ancla}`;
    const regalos = GIFTS[key] || null;
    const l1 = `• 1 ${unit}: *S/ ${fmt(price)}*${regalos ? ` + ${regalos[0]}` : ""}`;
    const l3 = `• 3x2: Lleva 3 ${units} por *S/ ${fmt(price * 2)}* (pagas solo 2)${regalos ? ` + ${regalos[1]}` : ""}`;
    const l5 = `• 5x3: Lleva 5 ${units} por *S/ ${fmt(price * 3)}* (pagas solo 3)${regalos ? ` + ${regalos[2]}` : ""}`;
    promos = `🔥 Promociones disponibles:\n${l1}\n${l3}\n${l5}${opciones}${pregunta}`;
  }
  return { title, shortTitle, precio, promos: promos.slice(0, 1024), options };
}

// Regalos por cantidad (los agrega create-shopify-order; aqui solo se comunican, como pide el prompt).
const GIFTS = {
  eggmixer: ["*Papel para Freidora de Aire* GRATIS 🎁", "*Papel para Freidora* + *Malla Coladora* GRATIS 🎁🎁", "*Papel para Freidora* + *Malla Coladora* + *CrabHolder* GRATIS 🎁🎁🎁"],
  suntent: ["*Kit Playero Infantil* + *Pistola de Agua* GRATIS 🎁🎁", "*2 Pistolas de Agua* + *Kit Playero* GRATIS 🎁🎁🎁", "*2 Kit Playero* + *2 Pistolas de Agua* GRATIS 🎁🎁🎁🎁"],
};

function productKey(title, handle) {
  const t = `${title} ${handle}`.toLowerCase();
  if (/beewax|cera-de-abeja|cera de abeja/.test(t)) return "beewax";
  if (/eggmixer/.test(t)) return "eggmixer";
  if (/suntent/.test(t)) return "suntent";
  return "";
}

function availableValues(product, option) {
  const idx = Number(option.position || 1);
  const vs = (product.variants || []).filter((v) => v.available).map((v) => v[`option${idx}`]).filter(Boolean);
  return option.values.filter((val) => vs.includes(val));
}

// ----- Medios y planes de envio -----

function productMedia(product) {
  const images = (product.images || []).map((s) => (typeof s === "string" ? s : s?.src)).filter((s) => /^https:\/\//i.test(s || ""));
  let video = "";
  for (const m of product.media || []) {
    if (m?.media_type !== "video") continue;
    const srcs = (m.sources || []).filter((s) => s?.url);
    const mp4 = srcs.filter((s) => /mp4/i.test(s.format || s.mime_type || s.url));
    const pick = (mp4.length ? mp4 : srcs).sort((a, b) => (Number(a.height) || 1e9) - (Number(b.height) || 1e9))[0];
    if (pick) { video = pick.url; break; }
  }
  return { images, video };
}

function planAnuncio(copy, media) {
  const plan = [];
  if (media.video) plan.push({ kind: "video", type: "video", link: media.video, caption: "" });
  plan.push({ kind: "precio", type: "text", text: copy.precio });
  for (const img of media.images.slice(0, 2)) plan.push({ kind: "foto", type: "image", link: img, caption: "" });
  plan.push({ kind: "promos", type: "buttons", body: copy.promos, buttons: LIMA_PROVINCIA });
  return plan;
}

function planOrganico(copy, media) {
  const plan = [];
  let headerImage = "";
  if (media.video) {
    plan.push({ kind: "video+precio", type: "video", link: media.video, caption: copy.precio.slice(0, 1024) });
    headerImage = media.images[0] || "";
  } else if (media.images[0]) {
    plan.push({ kind: "foto+precio", type: "image", link: media.images[0], caption: copy.precio.slice(0, 1024) });
    headerImage = media.images[1] || "";
  } else {
    plan.push({ kind: "precio", type: "text", text: copy.precio });
  }
  plan.push({ kind: headerImage ? "promos+foto" : "promos", type: "buttons", body: copy.promos, buttons: LIMA_PROVINCIA, headerImage });
  return plan;
}

// ----- WhatsApp (proxy de Kapso) -----

// WhatsApp baja la foto/video desde el link tal cual: un nombre con "™" sin codificar le da HTTP 400 y el mensaje
// falla (131053), como paso con el video del AirClip el 30-10.
function mediaLink(url) {
  const s = String(url || "");
  try { return encodeURI(decodeURI(s)); } catch { return encodeURI(s); }
}

async function sendMessage(kapso, recipient, step) {
  const msg = { messaging_product: "whatsapp", ...recipient };
  if (step.type === "text") Object.assign(msg, { type: "text", text: { preview_url: false, body: step.text } });
  else if (step.type === "image") Object.assign(msg, { type: "image", image: { link: mediaLink(step.link), ...(step.caption ? { caption: step.caption } : {}) } });
  else if (step.type === "video") Object.assign(msg, { type: "video", video: { link: mediaLink(step.link), ...(step.caption ? { caption: step.caption } : {}) } });
  else if (step.type === "buttons") {
    Object.assign(msg, {
      type: "interactive",
      interactive: {
        type: "button",
        ...(step.headerImage ? { header: { type: "image", image: { link: mediaLink(step.headerImage) } } } : {}),
        body: { text: step.body.slice(0, 1024) },
        action: { buttons: step.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    });
  }
  const url = `${kapso.apiBase}/meta/whatsapp/${API_VERSION}/${encodeURIComponent(kapso.phoneNumberId)}/messages`;
  const r = await fetch(url, { method: "POST", headers: { "X-API-Key": kapso.apiKey, "Content-Type": "application/json" }, body: JSON.stringify(msg) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.messages?.[0]?.id) return { ok: false, error: JSON.stringify(data?.error || data).slice(0, 300) };
  return { ok: true, id: data.messages[0].id };
}

async function conversationMessages(kapso, conversationId) {
  try {
    const url = `${kapso.apiBase}/meta/whatsapp/${API_VERSION}/${encodeURIComponent(kapso.phoneNumberId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=100`;
    const r = await fetch(url, { headers: { "X-API-Key": kapso.apiKey } });
    if (!r.ok) return null;
    const body = await r.json();
    return Array.isArray(body?.data) ? body.data : null;
  } catch {
    return null;
  }
}

function dir(m) {
  return m?.kapso?.direction || m?.direction || "";
}

function recipientFrom(input, c, history) {
  const digits = (v) => String(v || "").replace(/\D/g, "");
  const phone = digits(input.to || input.phone || c.phone_number || c.wa_id || c.contact?.wa_id);
  if (phone.length >= 9) return { to: phone };
  for (const m of [...(history || [])].reverse()) {
    if (dir(m) !== "inbound") continue;
    const p = digits(m?.kapso?.phone_number || m?.from);
    if (p.length >= 9) return { to: p };
  }
  const bsuid = c.whatsapp_business_scoped_user_id || c.contact?.business_scoped_user_id
    || (history || []).map((m) => m?.from_user_id).find(Boolean);
  return bsuid ? { recipient: bsuid } : null;
}

// "anuncio" si algun entrante trae referral de Click-to-WhatsApp. Sin datos, "anuncio" (formato de siempre).
async function conversationOrigin(env, conversationId, history) {
  if (!conversationId) return "anuncio";
  const key = `origen:${conversationId}`;
  try { const cached = env?.KV ? await env.KV.get(key) : null; if (cached === "anuncio" || cached === "organico") return cached; } catch { /* KV opcional */ }
  if (!history) return "anuncio";
  const origin = history.some((m) => dir(m) === "inbound" && (m.referral || m?.kapso?.referral)) ? "anuncio" : "organico";
  try { if (env?.KV) await env.KV.put(key, origin, { expirationTtl: KV_TTL_S }); } catch { /* KV opcional */ }
  return origin;
}

// ----- Utilidades -----

function handleFrom(value) {
  const s = String(value || "").trim();
  const m = s.match(/\/products\/([^/?#\s]+)/i);
  const h = m ? m[1] : s;
  try { return decodeURIComponent(h).replace(/\.js$/i, "").replace(/\/+$/, "").trim(); } catch { return h.trim(); }
}

async function getEnv(env, name) {
  const alt = name.replace(/_/g, "").replace(/^./, (x) => x.toLowerCase());
  const direct = env?.[name] || env?.[alt] || globalThis[name] || globalThis[alt];
  if (direct) return String(direct);
  try { const v = env?.KV ? await env.KV.get(name) : null; if (v) return String(v); } catch { /* KV opcional */ }
  return "";
}

function money(cents) {
  const n = Number(cents || 0);
  return Math.round(n) / 100;
}

function fmt(n) {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.__aurelaPresentarProducto = { handleRequest, buildCopy, productMedia, planAnuncio, planOrganico, handleFrom, recipientFrom };
