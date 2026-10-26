async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

const DEFAULT_SHOP_DOMAIN = "aurela-peru.myshopify.com";
const DEFAULT_API_VERSION = "2026-04";
const DEFAULT_PHONE_NUMBER_ID = "1241790819006805";
const MAX_QUANTITY = 50;
const FREE_SHIPPING_THRESHOLD = 40;
const SHIPPING_FEE_UNDER_THRESHOLD = 10;

function clampQuantity(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_QUANTITY, n);
}

function sanitizeNoteText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  try {
    const payload = await readJson(request);
    const input = unwrapInput(payload);
    enrichConversationContext(input, payload);
    enrichCustomerFromContext(input, payload);

    if (input.coverage?.shippingMode === "agencia" || input.coverage?.shipping_mode === "agencia" || input.requiresLogisticsValidation || input.requires_logistics_validation) {
      return json({
        ok: false,
        reason: "logistics_validation_required",
        message: "Este pedido requiere validacion logistica antes de crear la orden.",
      });
    }

    if ((await getStoreBackend(env, input)) === "woocommerce") {
      return await handleWooOrder(input, env);
    }

    const config = await getConfig(env);
    const dryRun = Boolean(input.dryRun || input.dry_run);
    input.ctwaReferral = await fetchCtwaReferral(env, input);

    const build = await buildOrderInput(config, input, { createMissingCustomer: !dryRun });
    const orderInput = build.orderInput;
    const customerLookup = build.customerLookup;

    const outOfStockVariants = await checkVariantsStock(config, orderInput.lineItems.map((li) => li.variantId));
    const stockToValidate = outOfStockVariants.length > 0;
    if (stockToValidate) {
      if (!orderInput.tags.includes("stock-por-validar")) orderInput.tags.push("stock-por-validar");
      const detail = outOfStockVariants.map((v) => v.title || v.id).join("; ");
      orderInput.note = `${orderInput.note}\nSTOCK POR VALIDAR (sin stock al crear): ${detail}`;
    }

    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        stockToValidate,
        outOfStockVariants,
        customerLookup,
        orderPreview: {
          customerId: orderInput.customerId || null,
          lineItems: orderInput.lineItems,
          phone: orderInput.phone,
          email: orderInput.email || null,
          shippingAddress: orderInput.shippingAddress,
          billingAddress: orderInput.billingAddress,
          tags: orderInput.tags,
          customAttributes: orderInput.customAttributes || [],
          hasDiscount: Boolean(orderInput.discountCode),
          shippingLines: orderInput.shippingLines || [],
        },
      });
    }

    const data = await shopifyGraphql(config, ORDER_CREATE_MUTATION, {
      order: orderInput,
      options: {
        sendReceipt: false,
        sendFulfillmentReceipt: false,
      },
    });

    const result = data.orderCreate;
    if (result.userErrors?.length) {
      return json({ ok: false, reason: "shopify_user_errors", errors: result.userErrors, customerLookup });
    }

    return json({
      ok: true,
      stage: "orden creada",
      conversionStatus: "confirmed",
      conversionType: "contraentrega",
      conversionTotal: Number(input.quote?.total ?? input.quote?.totalAmount ?? 0),
      stockToValidate,
      outOfStockVariants,
      customerLookup,
      order: {
        id: result.order.id,
        name: result.order.name,
        legacyResourceId: result.order.legacyResourceId,
        statusUrl: result.order.statusPageUrl,
        customer: result.order.customer ? {
          id: result.order.customer.id,
          displayName: result.order.customer.displayName,
          email: result.order.customer.email,
          phone: result.order.customer.phone,
        } : null,
      },
      customerMessage: stockToValidate
        ? "Listo, registre tu pedido. Queda sujeto a confirmacion de stock; nuestro equipo lo valida y te confirma por aqui."
        : "Listo, tu pedido quedo registrado. Nuestro equipo coordinara el despacho por aqui.",
    });
  } catch (error) {
    return json({ ok: false, reason: "order_create_error", error: safeError(error) });
  }
}

// ---------------------------------------------------------------------------
// WooCommerce (tienda nueva de aurela.pe, desde el 27-10-2026)
//
// Con STORE_BACKEND=woocommerce (variable de la funcion o KV) el pedido se crea en WooCommerce por su API REST en
// vez de Shopify. Los productos se resuelven con el catalogo publico de la tienda (/products.json, mismo formato
// y mismos IDs de Shopify, lo sirve el plugin cod-core) y el pedido sigue las reglas de Kapta: metodo "cod", estado
// "Por confirmar" (cod-pending), departamento con el codigo de WooCommerce, distrito en city, envio como linea de
// envio, descuento como cupon (cod-core lo arma con el metadato cod_core_cupon) y kapta_channel.
// Configuracion (variables de la funcion o KV): WOO_STORE_URL (https://aurela.pe), WOO_CONSUMER_KEY,
// WOO_CONSUMER_SECRET, KAPTA_CHANNEL (por defecto "whatsapp_bot") y WOO_COUPON_CODE (por defecto
// "aurela-whatsapp-promo"). Para probar sin cambiar el bot real: input.storeBackend = "woocommerce".
// ---------------------------------------------------------------------------

const WOO_DEFAULT_CHANNEL = "whatsapp_bot";
const WOO_DEFAULT_COUPON = "aurela-whatsapp-promo";
const WOO_CATALOG_TTL_MS = 5 * 60 * 1000;
const WOO_MAX_CATALOG_PAGES = 20;

// Departamento (normalizado, sin tildes) -> codigo de WooCommerce. Lima: LMA (provincia de Lima) o LIM (resto).
const WOO_STATE_CODES = {
  amazonas: "AMA", ancash: "ANC", apurimac: "APU", arequipa: "ARE", ayacucho: "AYA", cajamarca: "CAJ",
  callao: "CAL", "el callao": "CAL", "prov const del callao": "CAL", cusco: "CUS", cuzco: "CUS", huancavelica: "HUV",
  huanuco: "HUC", ica: "ICA", junin: "JUN", "la libertad": "LAL", lambayeque: "LAM", loreto: "LOR",
  "madre de dios": "MDD", moquegua: "MOQ", pasco: "PAS", piura: "PIU", puno: "PUN", "san martin": "SAM",
  tacna: "TAC", tumbes: "TUM", ucayali: "UCA",
};

function wooEnvKey(name) {
  return name.replace(/_/g, "").replace(/^./, (c) => c.toLowerCase());
}

async function getEnvValue(env, name) {
  const direct = env?.[name] || env?.[wooEnvKey(name)] || globalThis[name] || globalThis[wooEnvKey(name)];
  if (direct) return String(direct);
  if (env?.KV?.get) {
    try {
      const value = await env.KV.get(name);
      if (value) return String(value);
    } catch {
      // Sin KV: queda el valor por defecto.
    }
  }
  return "";
}

async function getStoreBackend(env, input) {
  const override = String(input?.storeBackend || input?.store_backend || "").toLowerCase();
  if (override === "woocommerce" || override === "shopify") return override;
  return (await getEnvValue(env, "STORE_BACKEND")).toLowerCase() === "woocommerce" ? "woocommerce" : "shopify";
}

async function getWooConfig(env) {
  const storeUrl = (await getEnvValue(env, "WOO_STORE_URL")).replace(/\/+$/, "");
  const key = await getEnvValue(env, "WOO_CONSUMER_KEY");
  const secret = await getEnvValue(env, "WOO_CONSUMER_SECRET");
  if (!storeUrl || !key || !secret) throw new Error("Missing WOO_STORE_URL, WOO_CONSUMER_KEY or WOO_CONSUMER_SECRET");
  return {
    storeUrl,
    key,
    secret,
    kaptaChannel: (await getEnvValue(env, "KAPTA_CHANNEL")) || WOO_DEFAULT_CHANNEL,
    couponCode: (await getEnvValue(env, "WOO_COUPON_CODE")) || WOO_DEFAULT_COUPON,
  };
}

async function wooApi(woo, path, options = {}) {
  const auth = btoa(`${woo.key}:${woo.secret}`);
  const response = await fetch(`${woo.storeUrl}/wp-json/wc/v3${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Aurela-Kapso-Order/1.0",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 300) };
  }
  if (!response.ok) {
    const error = new Error(`WooCommerce ${response.status}: ${body?.message || body?.code || "error"}`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}

async function loadWooCatalog(woo) {
  const cached = globalThis.__AURELA_WOO_CATALOG_CACHE;
  if (cached?.storeUrl === woo.storeUrl && cached.expiresAt > Date.now()) return cached.products;

  const products = [];
  for (let page = 1; page <= WOO_MAX_CATALOG_PAGES; page += 1) {
    const response = await fetch(`${woo.storeUrl}/products.json?limit=250&page=${page}`, {
      headers: { Accept: "application/json", "User-Agent": "Aurela-Kapso-Order/1.0" },
    });
    if (!response.ok) {
      if (page === 1) throw new Error(`Catalogo de la tienda no disponible (${response.status})`);
      break;
    }
    const payload = await response.json();
    const pageProducts = Array.isArray(payload?.products) ? payload.products : [];
    products.push(...pageProducts);
    if (pageProducts.length < 250) break;
  }
  globalThis.__AURELA_WOO_CATALOG_CACHE = { storeUrl: woo.storeUrl, expiresAt: Date.now() + WOO_CATALOG_TTL_MS, products };
  return products;
}

function numericId(value) {
  return String(value || "").match(/\d+/g)?.pop() || "";
}

function wooVariantText(variant) {
  return normalizeSearchText([variant.title, variant.option1, variant.option2, variant.option3].filter(Boolean).join(" "));
}

function chooseWooVariant(product, item) {
  const variants = product?.variants || [];
  if (!variants.length) return null;
  if (!item.variantTitle) return variants.find((v) => v.available) || variants[0];
  const wanted = normalizeSearchText(item.variantTitle);
  return variants.find((v) => normalizeSearchText(v.title) === wanted)
    || variants.find((v) => wooVariantText(v).includes(wanted))
    || variants.find((v) => wanted.split(" ").every((token) => wooVariantText(v).includes(token)))
    || null;
}

function findWooProduct(catalog, item) {
  const handles = extractHandleCandidates([item.productUrl, item.handle].filter(Boolean).join(" "));
  for (const handle of handles) {
    const key = slugifyHandle(safeDecode(handle));
    const product = catalog.find((p) => slugifyHandle(p.handle) === key);
    if (product) return product;
  }
  if (item.productTitle) {
    const wanted = normalizeSearchText(item.productTitle);
    const exact = catalog.find((p) => normalizeSearchText(p.title) === wanted);
    if (exact) return exact;
    const tokens = wanted.split(" ").filter((t) => t.length >= 3);
    if (tokens.length) {
      const scored = catalog
        .map((p) => ({ p, score: tokens.filter((t) => normalizeSearchText(p.title).includes(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length && scored[0].score >= Math.min(2, tokens.length)) return scored[0].p;
    }
  }
  return null;
}

/** Lineas del pedido contra el catalogo: por ID de variante (de Shopify o de WooCommerce), handle o titulo. */
function resolveWooLineItems(catalog, items) {
  const lines = [];
  const unresolved = [];
  for (const item of items) {
    let product = null;
    let variant = null;
    const wantedId = numericId(item.variantId);
    if (wantedId) {
      for (const p of catalog) {
        const v = (p.variants || []).find((x) => String(x.id) === wantedId || String(x.woo_id) === wantedId);
        if (v) {
          product = p;
          variant = v;
          break;
        }
      }
    }
    if (!variant) {
      product = findWooProduct(catalog, item);
      variant = product ? chooseWooVariant(product, item) : null;
    }
    if (product && variant && variant.woo_id) {
      lines.push({ item, product, variant, quantity: item.quantity, price: Number(variant.price) });
    } else {
      unresolved.push(item.productTitle || item.handle || item.variantTitle || item.variantId || "producto");
    }
  }
  return { lines, unresolved };
}

/** Promos del bot (3x2 y 5x3 por producto) y envio, igual que computePricing de Shopify. */
function computeWooPricing(lines) {
  const unitsByProduct = new Map();
  for (const line of lines) {
    if (!Number.isFinite(line.price)) return null;
    const list = unitsByProduct.get(line.product.id) || [];
    for (let i = 0; i < line.quantity; i += 1) list.push(line.price);
    unitsByProduct.set(line.product.id, list);
  }
  let subtotalBeforeDiscount = 0;
  let discountTotal = 0;
  for (const prices of unitsByProduct.values()) {
    subtotalBeforeDiscount += prices.reduce((sum, price) => sum + price, 0);
    const freeUnits = countFreeUnits(prices.length);
    if (freeUnits > 0) {
      discountTotal += [...prices].sort((a, b) => a - b).slice(0, freeUnits).reduce((sum, price) => sum + price, 0);
    }
  }
  discountTotal = money(discountTotal);
  const subtotalAfterDiscount = money(money(subtotalBeforeDiscount) - discountTotal);
  const shippingFee = subtotalAfterDiscount > FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE_UNDER_THRESHOLD;
  return { discountTotal, shippingFee, subtotalAfterDiscount, subtotalBeforeDiscount: money(subtotalBeforeDiscount) };
}

/** Reparte el descuento entre lineas en proporcion a su subtotal, en centimos (suman exacto). */
function spreadWooDiscount(lines, discount) {
  const cents = lines.map((line) => Math.round(line.price * line.quantity * 100));
  const base = cents.reduce((a, b) => a + b, 0);
  let left = Math.min(Math.round(discount * 100), base);
  const shares = cents.map((c) => (base > 0 ? Math.floor((left * c) / base) : 0));
  left -= shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0 && shares.length; i = (i + 1) % shares.length) {
    if (shares[i] < cents[i]) {
      shares[i] += 1;
      left -= 1;
    }
  }
  return lines.map((line, i) => ({ subtotal: cents[i] / 100, total: (cents[i] - shares[i]) / 100 }));
}

function titleCasePlace(value) {
  const small = new Set(["de", "del", "la", "las", "los", "y", "el"]);
  return String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

/** Departamento, provincia y distrito: de check-coverage (normalized) o de lo que dio el cliente. */
// Distritos de Lima Metropolitana (los de check-coverage): con ellos se sabe el departamento LMA aunque el bot mande
// solo el distrito, que pasa seguido ("La Molina", "Cercado de Lima", sin region ni provincia).
const WOO_LIMA_METRO_DISTRITOS = new Set([
  "barranco", "brena", "cercado de lima", "centro de lima", "jesus maria", "la victoria", "lima", "lince",
  "magdalena del mar", "magdalena", "miraflores", "pueblo libre", "rimac", "san borja", "san isidro", "san luis",
  "san miguel", "santiago de surco", "surco", "surquillo", "ancon", "carabayllo", "comas", "independencia",
  "los olivos", "puente piedra", "san martin de porres", "smp", "santa rosa", "ate", "ate vitarte", "vitarte",
  "chaclacayo", "cieneguilla", "el agustino", "lurigancho chosica", "lurigancho", "chosica", "san juan de lurigancho",
  "sjl", "santa anita", "la molina", "chorrillos", "lurin", "pachacamac", "pucusana", "punta hermosa", "punta negra",
  "san bartolo", "san juan de miraflores", "sjm", "santa maria del mar", "villa el salvador", "ves",
  "villa maria del triunfo", "vmt",
]);

function wooLocation(input) {
  const customer = input.customer || {};
  const coverage = input.coverage || {};
  const normalized = coverage.normalized || {};
  // El bot manda la ubicacion en sitios distintos segun el caso: coverage.normalized (respuesta de check_coverage),
  // los datos del cliente o coverage a secas. Se toma el primero que tenga valor.
  const regionRaw = normalized.region || customer.region || customer.departamento || coverage.region || "";
  const provinceRaw = normalized.province || customer.province || customer.provincia || coverage.province || "";
  const districtRaw = String(customer.district || customer.distrito || normalized.district || coverage.district || "").trim();
  const region = normalizeSearchText(regionRaw);
  const province = normalizeSearchText(provinceRaw);
  // Mismas reglas que la provincia de Shopify (peruZoneCode: Callao por distrito, resto de Lima, ciudades); los
  // codigos de WooCommerce son los mismos sin el "PE-".
  let state = (peruZoneCode({ region: regionRaw, province: provinceRaw, city: districtRaw }) || "").replace(/^PE-/, "");
  if (!state && WOO_LIMA_METRO_DISTRITOS.has(normZona(districtRaw))) state = "LMA";
  if (!state) state = WOO_STATE_CODES[region] || "";
  const district = /[A-ZÁÉÍÓÚÑ]/.test(districtRaw) ? districtRaw : titleCasePlace(districtRaw);
  return { state, district, province, region };
}

function wooMeta(input, woo, discountTotal, extraTags = []) {
  const meta = [];
  const add = (key, value) => {
    const v = String(value ?? "").trim();
    if (v) meta.push({ key, value: v.slice(0, 250) });
  };
  add("kapta_channel", woo.kaptaChannel);
  for (const attr of buildCustomAttributes(input, null)) add(attr.key, attr.value);
  // Etiquetas en kapta_tags: es el metadato que lee Kapta (WOO_META.tags, MOM §38.5: promo-whatsapp, contraentrega,
  // stock-por-validar, regalos...). Antes iba en kapso_tags, que nadie leia, y Kapta solo veia el canal.
  add("kapta_tags", [...buildTags(input), ...extraTags].join(","));
  const ref = input.ctwaReferral;
  if (ref?.source_id) {
    // Atribucion para Kapta (pedido sin checkout): los utm visibles, con el anuncio de origen.
    add("utm_id", ref.source_id);
    add("utm_source", "facebook");
    add("utm_medium", "ctwa");
  }
  if (discountTotal > 0) add("cod_core_cupon", woo.couponCode);
  return meta;
}

// Celular peruano real para el pedido de WooCommerce (Kapta llama y escribe a ese numero). Un contacto que escribe con
// usuario de WhatsApp no trae numero, y su ID ("PE.2139...") no es un telefono: sin un 9XXXXXXXX no se crea el pedido.
function wooCustomerPhone(input, address) {
  const customer = input.customer || {};
  for (const raw of [customer.phone, input.phone, address.phone, input.customerPhone]) {
    const text = String(raw || "").trim();
    if (!text || /[a-z]/i.test(text)) continue;
    const digits = phoneDigits(text);
    if (/^9\d{8}$/.test(digits)) return `+51${digits}`;
    if (/^519\d{8}$/.test(digits)) return `+${digits}`;
  }
  return "";
}

// Respaldo: el numero de WhatsApp de la conversacion (el agente a veces no manda customer.phone). Un contacto que
// escribe con usuario de WhatsApp no tiene numero y aqui no aparece.
async function wooConversationPhone(env, input) {
  try {
    const { apiKey, apiBase } = getKapsoConfig(env);
    const conversationId = input.conversationId || input.conversation_id;
    const phoneNumberId =
      input.phoneNumberId || input.phone_number_id || input.whatsappPhoneNumberId || input.whatsapp_phone_number_id || DEFAULT_PHONE_NUMBER_ID;
    if (!apiKey || !conversationId) return "";
    const url = `${apiBase}/meta/whatsapp/v24.0/${encodeURIComponent(phoneNumberId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&direction=inbound&limit=5`;
    const response = await fetch(url, { headers: { "X-API-Key": apiKey, "Content-Type": "application/json" } });
    if (!response.ok) return "";
    const payload = await response.json();
    for (const message of payload?.data || []) {
      const value = message?.kapso?.phone_number || message?.from || "";
      if (value && !/[a-z]/i.test(String(value))) return String(value);
    }
  } catch {
    // Sin respaldo: se pide el celular al cliente.
  }
  return "";
}

// El pedido de WooCommerce se cobra con los precios de la tienda (y las promos 3x2/5x3). Si el bot le prometio al
// cliente otro total (p. ej. el precio de un anuncio), la nota lo dice para que el equipo lo confirme antes de cobrar:
// en Shopify se veia en "Total cotizado", que la nota corta de WooCommerce ya no trae.
function wooQuoteMismatchNote(quote, orderTotal) {
  const quoted = Number(quote?.total);
  if (!Number.isFinite(quoted) || quoted <= 0 || Math.abs(quoted - orderTotal) < 0.5) return "";
  return `\nOJO PRECIO: el bot le cotizo S/ ${money(quoted).toFixed(2)} y el pedido suma S/ ${money(orderTotal).toFixed(2)}. Confirmar con el cliente antes de cobrar.`;
}

async function handleWooOrder(input, env) {
  const woo = await getWooConfig(env);
  const dryRun = Boolean(input.dryRun || input.dry_run);
  input.ctwaReferral = await fetchCtwaReferral(env, input);

  const catalog = await loadWooCatalog(woo);
  const { lines, unresolved } = resolveWooLineItems(catalog, normalizeLineItems(input.lineItems || input.items || []));
  if (!lines.length || unresolved.length) {
    return json({ ok: false, reason: "products_not_found", unresolved, message: "No pude ubicar todos los productos en la tienda." });
  }

  const quote = input.quote || {};
  const computed = computeWooPricing(lines);
  let discountTotal = computed ? computed.discountTotal : Number(quote.discountTotal ?? quote.discount_total ?? 0);
  let shippingFee = computed ? computed.shippingFee : Number(quote.shippingFee ?? quote.shipping_fee ?? 0);
  const extraDiscount = Number(quote.extraDiscountTotal ?? quote.extra_discount_total ?? 0);
  if (Number.isFinite(extraDiscount) && extraDiscount > 0 && computed) {
    discountTotal = money(discountTotal + Math.min(extraDiscount, money(computed.subtotalBeforeDiscount * 0.15)));
    shippingFee = money(computed.subtotalBeforeDiscount - discountTotal) > FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE_UNDER_THRESHOLD;
  }

  const outOfStockVariants = lines
    .filter((line) => line.variant.available === false)
    .map((line) => ({ id: String(line.variant.id), title: [line.product.title, line.variant.title].filter((t) => t && t !== "Default Title").join(" - ") }));
  const stockToValidate = outOfStockVariants.length > 0
    || Boolean(input.stockPorValidar || input.stock_por_validar || input.stockValidationRequired || input.stock_validation_required);

  const customer = input.customer || {};
  const address = buildAddress(customer, input);
  const phone = wooCustomerPhone(input, address)
    || wooCustomerPhone({ customer: { phone: await wooConversationPhone(env, input) } }, {});
  if (!phone) {
    return json({
      ok: false,
      reason: "missing_phone",
      message: "Falta el celular del cliente (9 digitos, empieza con 9). Pideselo y vuelve a llamar con customer.phone.",
    });
  }
  const location = wooLocation(input);
  const email = normalizeEmail(customer.email || input.email);
  const totals = spreadWooDiscount(lines, discountTotal);
  const gifts = wooGiftLines(catalog, lines);
  const specialNote = sanitizeNoteText(input.specialDeliveryNote || input.special_delivery_note);

  const order = {
    status: "cod-pending",
    payment_method: "cod",
    payment_method_title: "Pago contra entrega",
    set_paid: false,
    billing: {
      first_name: address.firstName,
      last_name: address.lastName,
      phone,
      country: "PE",
      state: location.state,
      city: location.district,
      address_1: address.address1,
      address_2: address.address2,
      ...(email ? { email } : {}),
    },
    line_items: lines.map((line, i) => ({
      product_id: line.product.woo_id,
      ...(line.variant.woo_id !== line.product.woo_id ? { variation_id: line.variant.woo_id } : {}),
      quantity: line.quantity,
      subtotal: totals[i].subtotal.toFixed(2),
      total: totals[i].total.toFixed(2),
    })).concat(gifts.found.map((gift) => ({
      product_id: gift.product.woo_id,
      ...(gift.variant.woo_id !== gift.product.woo_id ? { variation_id: gift.variant.woo_id } : {}),
      quantity: gift.quantity,
      subtotal: "0.00",
      total: "0.00",
    }))),
    shipping_lines: [shippingFee > 0
      ? { method_id: "flat_rate", method_title: "Envio", total: money(shippingFee).toFixed(2) }
      : { method_id: "free_shipping", method_title: "Envío gratis", total: "0.00" }],
    customer_note: specialNote ? `Fecha/hora solicitada: ${specialNote}` : "",
    meta_data: wooMeta(input, woo, discountTotal, gifts.tags),
  };
  // La nota con los productos ya resueltos (nombre y talla) y el total calculado, aunque el agente solo haya mandado
  // el handle o el ID de la variante.
  const orderTotal = money((computed ? computed.subtotalBeforeDiscount : lines.reduce((s, l) => s + l.price * l.quantity, 0)) - discountTotal + shippingFee);
  const noteInput = {
    ...input,
    items: lines.map((line) => ({
      quantity: line.quantity,
      productTitle: [line.product.title, line.variant.title !== "Default Title" ? line.variant.title : ""].filter(Boolean).join(" - "),
    })),
    quote: { ...quote, total: quote.total || orderTotal },
  };
  const note = buildNote(noteInput, null)
    + (gifts.found.length ? `\nRegalo(s): ${summaryLine(gifts.found.map((gift) => ({ quantity: gift.quantity, productTitle: wooLineTitle(gift) })))}` : "")
    + (gifts.missing.length ? `\nREGALO POR AGREGAR A MANO (no esta en la tienda): ${gifts.missing.join("; ")}` : "")
    + (stockToValidate
      ? `\nSTOCK POR VALIDAR: ${outOfStockVariants.map((v) => v.title || v.id).join("; ") || "lo pidio el agente"}`
      : "")
    + wooQuoteMismatchNote(quote, orderTotal);

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      backend: "woocommerce",
      stockToValidate,
      outOfStockVariants,
      location,
      pricing: { discountTotal, shippingFee, subtotal: computed?.subtotalBeforeDiscount ?? null },
      orderPreview: order,
      internalNote: note,
    });
  }

  let created;
  try {
    created = await wooApi(woo, "/orders", { method: "POST", body: order });
  } catch (error) {
    return json({ ok: false, reason: "woocommerce_error", status: error.status || null, error: safeError(error) });
  }
  try {
    await wooApi(woo, `/orders/${created.id}/notes`, { method: "POST", body: { note, customer_note: false } });
  } catch {
    // La nota interna es un extra: el pedido ya quedo creado.
  }

  return json({
    ok: true,
    backend: "woocommerce",
    stage: "orden creada",
    conversionStatus: "confirmed",
    conversionType: "contraentrega",
    conversionTotal: Number(created.total ?? quote.total ?? 0),
    stockToValidate,
    outOfStockVariants,
    customerLookup: { searched: false, status: "skipped", reason: "woocommerce_guest" },
    order: {
      id: created.id,
      name: `#${created.number}`,
      number: created.number,
      legacyResourceId: String(created.id),
      total: created.total,
      statusUrl: null,
      customer: null,
    },
    customerMessage: stockToValidate
      ? "Listo, registre tu pedido. Queda sujeto a confirmacion de stock; nuestro equipo lo valida y te confirma por aqui."
      : "Listo, tu pedido quedo registrado. Nuestro equipo coordinara el despacho por aqui.",
  });
}

const ORDER_CREATE_MUTATION = `#graphql
  mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors { field message }
      order {
        id
        name
        legacyResourceId
        statusPageUrl
        customer { id displayName email phone }
      }
    }
  }`;

const CUSTOMER_SEARCH_QUERY = `#graphql
  query CustomersByQuery($query: String!) {
    customers(first: 10, query: $query) {
      nodes {
        id
        displayName
        firstName
        lastName
        email
        phone
        defaultAddress { phone address1 address2 city province country zip }
      }
    }
  }`;

const CUSTOMER_CREATE_MUTATION = `#graphql
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id displayName firstName lastName email phone defaultAddress { phone address1 city province country zip } }
      userErrors { field message }
    }
  }`;

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function getConfig(env = globalThis) {
  const kvConfig = await getKvConfig(env);
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN || env.sHOPIFYSHOPDOMAIN || kvConfig.SHOPIFY_SHOP_DOMAIN || globalThis.SHOPIFY_SHOP_DOMAIN || globalThis.sHOPIFYSHOPDOMAIN || DEFAULT_SHOP_DOMAIN;
  const apiVersion = env.SHOPIFY_API_VERSION || env.sHOPIFYAPIVERSION || kvConfig.SHOPIFY_API_VERSION || globalThis.SHOPIFY_API_VERSION || globalThis.sHOPIFYAPIVERSION || DEFAULT_API_VERSION;
  const token = env.SHOPIFY_ADMIN_ACCESS_TOKEN || env.sHOPIFYADMINACCESSTOKEN || kvConfig.SHOPIFY_ADMIN_ACCESS_TOKEN || globalThis.SHOPIFY_ADMIN_ACCESS_TOKEN || globalThis.sHOPIFYADMINACCESSTOKEN;

  if (!token) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");
  return { apiVersion, shopDomain, token };
}

async function getKvConfig(env) {
  if (!env?.KV?.get) return {};
  const [token, apiVersion, shopDomain] = await Promise.all([
    env.KV.get("SHOPIFY_ADMIN_ACCESS_TOKEN"),
    env.KV.get("SHOPIFY_API_VERSION"),
    env.KV.get("SHOPIFY_SHOP_DOMAIN"),
  ]);
  return {
    SHOPIFY_ADMIN_ACCESS_TOKEN: token,
    SHOPIFY_API_VERSION: apiVersion,
    SHOPIFY_SHOP_DOMAIN: shopDomain,
  };
}

function getKapsoConfig(env = globalThis) {
  const apiKey = env.KAPSO_API_KEY || env.kAPSOAPIKEY || globalThis.KAPSO_API_KEY || globalThis.kAPSOAPIKEY;
  const apiBase = env.KAPSO_API_BASE || env.kAPSOAPIBASE || globalThis.KAPSO_API_BASE || "https://api.kapso.ai";
  return { apiKey, apiBase };
}

const CTWA_MAX_PAGES = 5;

async function fetchCtwaReferral(env, input) {
  try {
    const { apiKey, apiBase } = getKapsoConfig(env);
    const conversationId = input.conversationId || input.conversation_id;
    const phoneNumberId =
      input.phoneNumberId || input.phone_number_id || input.whatsappPhoneNumberId || input.whatsapp_phone_number_id || DEFAULT_PHONE_NUMBER_ID;
    if (!apiKey || !conversationId || !phoneNumberId) return null;

    let url = `${apiBase}/meta/whatsapp/${encodeURIComponent(phoneNumberId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&direction=inbound&limit=100`;
    for (let page = 0; page < CTWA_MAX_PAGES && url; page += 1) {
      const response = await fetch(url, { headers: { "X-API-Key": apiKey, "Content-Type": "application/json" } });
      if (!response.ok) return null;
      const payload = await response.json();
      const messages = payload?.data || [];
      for (const message of messages) {
        const referral = extractReferral(message);
        if (referral) return referral;
      }
      const nextCursor = payload?.paging?.cursors?.after || payload?.paging?.next;
      if (!nextCursor || payload?.paging?.next === null) break;
      url = `${apiBase}/meta/whatsapp/${encodeURIComponent(phoneNumberId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&direction=inbound&limit=100&after=${encodeURIComponent(nextCursor)}`;
    }
    return null;
  } catch {
    return null;
  }
}

function extractReferral(message) {
  const referral = message?.referral || message?.message?.referral || message?.kapso?.referral;
  if (referral && (referral.source_id || referral.source_type || referral.ctwa_clid)) return referral;
  return null;
}

async function buildOrderInput(config, input, options = {}) {
  const customer = input.customer || {};
  const quote = input.quote || {};
  const lineItems = await resolveLineItems(config, normalizeLineItems(input.lineItems || input.items || []));

  if (!lineItems.length) {
    throw new Error("Missing line items with valid Shopify variant IDs");
  }

  let discountTotal = Number(quote.discountTotal ?? quote.discount_total ?? 0);
  let shippingFee = Number(quote.shippingFee ?? quote.shipping_fee ?? 0);
  const computed = await computePricing(config, lineItems);
  if (computed) {
    discountTotal = computed.discountTotal;
    shippingFee = computed.shippingFee;
  }

  // Descuento extra autorizado (ej. el 10% del follow-up de recuperacion en 1
  // unidad). Se SUMA al descuento de promos, con tope de seguridad del 15% del
  // subtotal para que un error del agente no regale la orden.
  const extraDiscount = Number(quote.extraDiscountTotal ?? quote.extra_discount_total ?? 0);
  if (Number.isFinite(extraDiscount) && extraDiscount > 0) {
    const cap = computed ? money(computed.subtotalBeforeDiscount * 0.15) : money(extraDiscount);
    const applied = money(Math.min(extraDiscount, cap));
    discountTotal = money(discountTotal + applied);
    if (computed) {
      const paidAfter = money(computed.subtotalBeforeDiscount - discountTotal);
      shippingFee = paidAfter > FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE_UNDER_THRESHOLD;
    }
  }

  const shippingAddress = buildAddress(customer, input);
  const billingAddress = buildAddress(customer, input);
  const customerLookup = await resolveOrderCustomer(config, input, customer, shippingAddress, {
    createMissingCustomer: options.createMissingCustomer === true,
  });

  const giftResult = giftLineItems(lineItems);
  const order = {
    lineItems: [
      ...lineItems.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
      })),
      ...giftResult.items,
    ],
    phone: normalizePhone(customer.phone || input.phone || shippingAddress.phone),
    shippingAddress,
    billingAddress,
    tags: [...buildTags(input), ...giftResult.tags],
    note: buildNote(input),
    financialStatus: "PENDING",
    presentmentCurrency: "PEN",
  };

  if (customerLookup?.customerId) {
    order.customerId = customerLookup.customerId;
  }

  const email = normalizeEmail(customer.email || input.email || customerLookup?.email);
  if (email) {
    order.email = email;
  }

  const customAttributes = buildCustomAttributes(input, customerLookup);
  if (customAttributes.length) {
    order.customAttributes = customAttributes;
  }

  if (discountTotal > 0) {
    order.discountCode = {
      itemFixedDiscountCode: {
        code: "AURELA-WHATSAPP-PROMO",
        amountSet: moneySet(discountTotal),
      },
    };
    if (!order.tags.includes("promo-whatsapp")) order.tags.push("promo-whatsapp");
  }

  if (shippingFee > 0) {
    order.shippingLines = [
      {
        title: "Envio Aurela",
        priceSet: moneySet(shippingFee),
      },
    ];
  }

  return { orderInput: order, customerLookup };
}

async function resolveOrderCustomer(config, input, customer, shippingAddress, options = {}) {
  const phone = normalizePhone(customer.phone || input.phone || shippingAddress.phone || "");
  const email = normalizeEmail(customer.email || input.email || "");
  const fullName = String(customer.name || customer.fullName || customer.full_name || "").trim();
  const nameParts = splitCustomerName(fullName || [shippingAddress.firstName, shippingAddress.lastName].filter(Boolean).join(" "));

  const base = {
    searched: false,
    status: "skipped",
    customerId: null,
    phone: phone || null,
    email: email || null,
    displayName: fullName || null,
  };

  if (!phone && !email) {
    return { ...base, reason: "missing_phone_email" };
  }

  try {
    const existing = await findShopifyCustomer(config, { phone, email, fullName });
    if (existing) {
      return {
        ...base,
        searched: true,
        status: "found",
        customerId: existing.id,
        displayName: existing.displayName,
        email: existing.email || email || null,
        phone: existing.phone || phone || null,
      };
    }
  } catch (error) {
    return { ...base, searched: true, status: "lookup_failed", error: safeError(error) };
  }

  if (!options.createMissingCustomer) {
    return { ...base, searched: true, status: "not_found", createSkipped: true };
  }

  try {
    const created = await createShopifyCustomer(config, {
      phone,
      email,
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      address: {
        ...shippingAddress,
        zoneCode: peruZoneCode({
          region: customer.region || customer.departamento || input.coverage?.region || input.region || "",
          province: customer.province || customer.provincia || input.coverage?.province || shippingAddress.province || "",
          city: shippingAddress.city || "",
        }),
      },
      note: buildCustomerNote(input),
    });

    if (created.customer) {
      return {
        ...base,
        searched: true,
        status: "created",
        customerId: created.customer.id,
        displayName: created.customer.displayName,
        email: created.customer.email || email || null,
        phone: created.customer.phone || phone || null,
      };
    }

    const retryExisting = await findShopifyCustomer(config, { phone, email, fullName });
    if (retryExisting) {
      return {
        ...base,
        searched: true,
        status: "found_after_create_error",
        customerId: retryExisting.id,
        displayName: retryExisting.displayName,
        email: retryExisting.email || email || null,
        phone: retryExisting.phone || phone || null,
        createErrors: created.userErrors || [],
      };
    }

    return {
      ...base,
      searched: true,
      status: "create_failed",
      createErrors: created.userErrors || [],
    };
  } catch (error) {
    try {
      const retryExisting = await findShopifyCustomer(config, { phone, email, fullName });
      if (retryExisting) {
        return {
          ...base,
          searched: true,
          status: "found_after_create_exception",
          customerId: retryExisting.id,
          displayName: retryExisting.displayName,
          email: retryExisting.email || email || null,
          phone: retryExisting.phone || phone || null,
          createError: safeError(error),
        };
      }
    } catch {
      // Ignore retry errors; return original create error below.
    }
    return { ...base, searched: true, status: "create_failed", error: safeError(error) };
  }
}

async function findShopifyCustomer(config, { phone, email, fullName }) {
  const queries = buildCustomerSearchQueries({ phone, email });
  const candidates = [];
  const seen = new Set();

  for (const query of queries) {
    const data = await shopifyGraphql(config, CUSTOMER_SEARCH_QUERY, { query });
    for (const node of data.customers?.nodes || []) {
      if (!node?.id || seen.has(node.id)) continue;
      seen.add(node.id);
      candidates.push(node);
    }
  }

  if (candidates.length === 0) return null;
  const scored = candidates
    .map((customer) => ({ customer, score: scoreCustomerCandidate(customer, { phone, email, fullName }) }))
    .filter((item) => item.score >= 60)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.customer || null;
}

function buildCustomerSearchQueries({ phone, email }) {
  const queries = [];
  const cleanEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const digits = phoneDigits(normalizedPhone || phone);
  const local = digits.startsWith("51") && digits.length === 11 ? digits.slice(2) : digits;

  if (cleanEmail) {
    queries.push(`email:${escapeCustomerSearch(cleanEmail)}`);
    queries.push(cleanEmail);
  }
  if (normalizedPhone) {
    queries.push(`phone:${escapeCustomerSearch(normalizedPhone)}`);
  }
  if (digits) {
    queries.push(`phone:${digits}`);
    queries.push(digits);
  }
  if (local && local !== digits) {
    queries.push(`phone:${local}`);
    queries.push(local);
  }
  return unique(queries);
}

function scoreCustomerCandidate(customer, { phone, email, fullName }) {
  let score = 0;
  const cleanEmail = normalizeEmail(email);
  const candidateEmail = normalizeEmail(customer.email);
  if (cleanEmail && candidateEmail && cleanEmail === candidateEmail) score += 120;

  const wantedDigits = phoneDigits(phone);
  const phones = [customer.phone, customer.defaultAddress?.phone].map(phoneDigits).filter(Boolean);
  if (wantedDigits && phones.some((candidate) => samePhoneDigits(candidate, wantedDigits))) score += 100;
  else if (wantedDigits && phones.some((candidate) => candidate.endsWith(wantedDigits.slice(-9)) || wantedDigits.endsWith(candidate.slice(-9)))) score += 80;

  const wantedName = normalizeSearchText(fullName || "");
  const candidateName = normalizeSearchText(customer.displayName || [customer.firstName, customer.lastName].filter(Boolean).join(" "));
  if (wantedName && candidateName) {
    const wantedTokens = wantedName.split(/\s+/).filter((token) => token.length >= 3);
    const matched = wantedTokens.filter((token) => candidateName.includes(token)).length;
    score += Math.min(30, matched * 10);
  }

  return score;
}

async function createShopifyCustomer(config, { phone, email, firstName, lastName, address, note }) {
  const input = {
    firstName: firstName || "Cliente",
    lastName: lastName || "Aurela",
    tags: ["kapso", "whatsapp", "aurela"],
  };

  const cleanPhone = normalizePhone(phone);
  const cleanEmail = normalizeEmail(email);
  if (cleanPhone) input.phone = cleanPhone;
  if (cleanEmail) input.email = cleanEmail;
  if (note) input.note = note;

  const mailingAddress = mailingAddressFromOrderAddress(address);
  if (mailingAddress) {
    input.addresses = [mailingAddress];
  }

  const data = await shopifyGraphql(config, CUSTOMER_CREATE_MUTATION, { input });
  return data.customerCreate || { customer: null, userErrors: [{ message: "empty customerCreate response" }] };
}

// Direccion de la ficha de cliente. customerCreate valida la provincia contra
// las zonas de Shopify y rechazaba TODAS las del bot ("Province is invalid"):
// el bot manda "Lima" y Shopify solo conoce "Lima (provincia)" / "Lima
// (departamento)". El pedido igual se creaba, pero sin cliente vinculado. Se
// manda el codigo de zona (provinceCode) y, si no se puede resolver, ninguna
// provincia: Shopify lo acepta. La direccion del PEDIDO (buildAddress) no cambia.
function mailingAddressFromOrderAddress(address) {
  if (!address) return null;
  const out = {
    firstName: address.firstName || "Cliente",
    lastName: address.lastName || "Aurela",
    phone: normalizePhone(address.phone),
    address1: address.address1 || "Por coordinar",
    address2: address.address2 || "",
    city: address.city || "",
    countryCode: "PE",
    provinceCode: address.zoneCode || "",
    zip: address.zip || "",
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

// Zonas de Peru en Shopify (GET /admin/api/2026-04/countries.json, 12-oct-2026).
// "Lima" a secas NO existe: Lima (provincia) = PE-LMA es Lima Metropolitana y
// Lima (departamento) = PE-LIM es el resto de la region (Huaral, Cañete, Huacho).
const PE_ZONAS = {
  amazonas: "PE-AMA", ancash: "PE-ANC", apurimac: "PE-APU", arequipa: "PE-ARE", ayacucho: "PE-AYA",
  cajamarca: "PE-CAJ", callao: "PE-CAL", cusco: "PE-CUS", cuzco: "PE-CUS", huancavelica: "PE-HUV",
  huanuco: "PE-HUC", ica: "PE-ICA", junin: "PE-JUN", "la libertad": "PE-LAL", lambayeque: "PE-LAM",
  loreto: "PE-LOR", "madre de dios": "PE-MDD", moquegua: "PE-MOQ", pasco: "PE-PAS", piura: "PE-PIU",
  puno: "PE-PUN", "san martin": "PE-SAM", tacna: "PE-TAC", tumbes: "PE-TUM", ucayali: "PE-UCA",
};
// Provincias y ciudades de la region Lima que NO son Lima Metropolitana.
const PE_LIMA_REGION = new Set([
  "barranca", "cajatambo", "canete", "san vicente de canete", "canta", "huaral", "chancay", "huarochiri",
  "huaura", "huacho", "oyon", "yauyos", "mala", "chilca", "asia", "lunahuana", "imperial",
]);
const PE_CALLAO_DISTRITOS = new Set(["callao", "bellavista", "la perla", "la punta", "carmen de la legua", "carmen de la legua reynoso", "ventanilla", "mi peru"]);
// Ciudades/provincias frecuentes -> departamento, para cuando el bot manda la
// ciudad como "provincia" (en los pedidos web aparecen "Chiclayo", "Abancay").
const PE_CIUDADES = {
  chiclayo: "PE-LAM", ferrenafe: "PE-LAM", trujillo: "PE-LAL", chepen: "PE-LAL", pacasmayo: "PE-LAL",
  huancayo: "PE-JUN", tarma: "PE-JUN", jauja: "PE-JUN", satipo: "PE-JUN", "la merced": "PE-JUN",
  chimbote: "PE-ANC", "nuevo chimbote": "PE-ANC", huaraz: "PE-ANC", casma: "PE-ANC",
  jaen: "PE-CAJ", chota: "PE-CAJ", iquitos: "PE-LOR", maynas: "PE-LOR", yurimaguas: "PE-LOR",
  pucallpa: "PE-UCA", "coronel portillo": "PE-UCA", tarapoto: "PE-SAM", moyobamba: "PE-SAM", juanjui: "PE-SAM",
  juliaca: "PE-PUN", "san roman": "PE-PUN", abancay: "PE-APU", andahuaylas: "PE-APU",
  huamanga: "PE-AYA", huanta: "PE-AYA", chincha: "PE-ICA", "chincha alta": "PE-ICA", pisco: "PE-ICA",
  nazca: "PE-ICA", nasca: "PE-ICA", sullana: "PE-PIU", paita: "PE-PIU", talara: "PE-PIU",
  "tingo maria": "PE-HUC", "leoncio prado": "PE-HUC", ilo: "PE-MOQ", "mariscal nieto": "PE-MOQ",
  "puerto maldonado": "PE-MDD", tambopata: "PE-MDD", "cerro de pasco": "PE-PAS", oxapampa: "PE-PAS",
  chachapoyas: "PE-AMA", bagua: "PE-AMA", "bagua grande": "PE-AMA", utcubamba: "PE-AMA",
  sicuani: "PE-CUS", quillabamba: "PE-CUS", "la convencion": "PE-CUS", camana: "PE-ARE",
  mollendo: "PE-ARE", islay: "PE-ARE", zarumilla: "PE-TUM",
};

function normZona(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(departamento|region|provincia|prov|dpto)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Codigo de zona de Shopify para una direccion peruana, o null si no se puede
// resolver con seguridad (entonces el cliente se crea sin provincia).
function peruZoneCode({ region, province, city }) {
  const r = normZona(region);
  const p = normZona(province);
  const c = normZona(city);
  const enLimaOCallao = [r, p].some((v) => v === "lima" || v === "lima metropolitana" || v === "callao");
  if (r === "callao" || p === "callao" || (enLimaOCallao && PE_CALLAO_DISTRITOS.has(c))) return "PE-CAL";
  if ([r, p].some((v) => v === "lima" || v === "lima metropolitana")) {
    return PE_LIMA_REGION.has(p) || PE_LIMA_REGION.has(c) ? "PE-LIM" : "PE-LMA";
  }
  if (PE_LIMA_REGION.has(p)) return "PE-LIM";
  for (const v of [r, p]) if (PE_ZONAS[v]) return PE_ZONAS[v];
  for (const v of [p, c, r]) if (PE_CIUDADES[v]) return PE_CIUDADES[v];
  return null;
}

function buildCustomerNote(input) {
  const conversationId = input.conversationId || input.conversation_id;
  return [
    "Cliente creado desde WhatsApp/Kapso.",
    conversationId ? `Kapso conversation: ${conversationId}` : "",
  ].filter(Boolean).join("\n");
}

function normalizeLineItems(items) {
  return items
    .map((item) => ({
      handle: String(item.handle || item.productHandle || item.product_handle || item.product?.handle || "").trim(),
      productTitle: String(item.productTitle || item.product_title || item.product?.title || item.title || item.name || "").trim(),
      productUrl: String(item.productUrl || item.product_url || item.url || item.link || "").trim(),
      variantId: normalizeVariantId(item.variantId || item.variant_id || item.variant?.id),
      variantTitle: String(item.variantTitle || item.variant_title || item.variant?.title || item.color || item.modelo || item.model || "").trim(),
      quantity: clampQuantity(item.quantity ?? item.qty ?? 1),
    }))
    .filter((item) => item.quantity > 0 && (item.variantId || item.handle || item.productTitle || item.productUrl));
}

async function resolveLineItems(config, items) {
  const resolved = [];
  for (const item of items) {
    if (item.variantId) {
      resolved.push({ ...item, variantId: normalizeVariantId(item.variantId) });
      continue;
    }
    const product = await findProductForItem(config, item);
    const variant = chooseVariant(product, item);
    if (variant?.id) resolved.push({ ...item, variantId: normalizeVariantId(variant.id) });
  }
  return resolved.filter((item) => item.variantId);
}

async function findProductForItem(config, item) {
  const handles = extractHandleCandidates([item.productUrl, item.handle].filter(Boolean).join(" "));
  for (const handle of handles) {
    const product = await getProductByHandle(config, handle);
    if (product) return product;
  }
  if (item.productTitle) {
    const products = await searchProducts(config, item.productTitle);
    return products[0] || null;
  }
  return null;
}

function chooseVariant(product, item) {
  const variants = product?.variants?.nodes || [];
  if (variants.length === 0) return null;
  if (!item.variantTitle) return variants.find((variant) => variant.availableForSale) || variants[0];

  const wanted = normalizeSearchText(item.variantTitle);
  const exact = variants.find((variant) => {
    const title = normalizeSearchText(variant.title);
    const options = normalizeSearchText((variant.selectedOptions || []).map((option) => option.value).join(" "));
    return title === wanted || options === wanted;
  });
  if (exact) return exact;

  return variants.find((variant) => {
    const haystack = normalizeSearchText([
      variant.title,
      ...(variant.selectedOptions || []).map((option) => option.value),
    ].join(" "));
    return haystack.includes(wanted);
  }) || variants.find((variant) => variant.availableForSale) || variants[0];
}

async function getProductByHandle(config, handle) {
  const query = `#graphql
    query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        handle
        title
        variants(first: 100) { nodes { id title availableForSale selectedOptions { name value } } }
      }
    }`;
  try {
    const data = await shopifyGraphql(config, query, { handle });
    return data.productByHandle;
  } catch {
    return null;
  }
}

async function checkVariantsStock(config, variantIds) {
  const ids = [...new Set((variantIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const query = `#graphql
    query VariantsStock($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant { id title availableForSale product { title } }
      }
    }`;

  try {
    const data = await shopifyGraphql(config, query, { ids });
    const nodes = (data.nodes || []).filter(Boolean);
    return nodes
      .filter((variant) => variant.availableForSale === false)
      .map((variant) => ({ id: variant.id, title: [variant.product?.title, variant.title].filter(Boolean).join(" - ") }));
  } catch {
    return [];
  }
}

async function computePricing(config, lineItems) {
  const variantIds = lineItems.map((li) => normalizeVariantId(li.variantId)).filter(Boolean);
  const pricing = await fetchVariantPricing(config, variantIds);
  if (!pricing.size) return null;

  const unitsByProduct = new Map();
  for (const item of lineItems) {
    const info = pricing.get(normalizeVariantId(item.variantId));
    if (!info || !Number.isFinite(info.price)) return null;
    const list = unitsByProduct.get(info.productId) || [];
    for (let i = 0; i < item.quantity; i += 1) list.push(info.price);
    unitsByProduct.set(info.productId, list);
  }

  let subtotalBeforeDiscount = 0;
  let discountTotal = 0;
  for (const prices of unitsByProduct.values()) {
    subtotalBeforeDiscount += prices.reduce((sum, price) => sum + price, 0);
    const freeUnits = countFreeUnits(prices.length);
    if (freeUnits > 0) {
      const cheapestFirst = [...prices].sort((a, b) => a - b);
      discountTotal += cheapestFirst.slice(0, freeUnits).reduce((sum, price) => sum + price, 0);
    }
  }

  discountTotal = money(discountTotal);
  const subtotalAfterDiscount = money(money(subtotalBeforeDiscount) - discountTotal);
  const shippingFee = subtotalAfterDiscount > FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE_UNDER_THRESHOLD;
  return { discountTotal, shippingFee, subtotalAfterDiscount, subtotalBeforeDiscount: money(subtotalBeforeDiscount) };
}

function countFreeUnits(quantity) {
  const fivePacks = Math.floor(quantity / 5);
  const remainder = quantity % 5;
  const threePackFreeUnits = remainder >= 3 ? 1 : 0;
  return fivePacks * 2 + threePackFreeUnits;
}

async function fetchVariantPricing(config, variantIds) {
  const ids = [...new Set((variantIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const query = `#graphql
    query VariantPricing($ids: [ID!]!) {
      nodes(ids: $ids) { ... on ProductVariant { id price product { id } } }
    }`;

  try {
    const data = await shopifyGraphql(config, query, { ids });
    const map = new Map();
    for (const node of (data.nodes || []).filter(Boolean)) {
      map.set(node.id, { price: Number(node.price), productId: node.product?.id || node.id });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function searchProducts(config, text) {
  const searchQueries = buildProductSearchQueries(text);
  if (searchQueries.length === 0) return [];

  const query = `#graphql
    query SearchProducts($query: String!) {
      products(first: 5, query: $query) {
        nodes { id handle title variants(first: 100) { nodes { id title availableForSale selectedOptions { name value } } } }
      }
    }`;

  for (const searchQuery of searchQueries) {
    try {
      const data = await shopifyGraphql(config, query, { query: searchQuery });
      const products = data.products?.nodes || [];
      if (products.length > 0) return products;
    } catch {
      // Try the next query shape.
    }
  }
  return [];
}

function buildProductSearchQueries(text) {
  const normalized = normalizeSearchText(text);
  const words = unique(normalized.split(/\s+/).filter((word) => word.length >= 3).slice(0, 8));
  const queries = [];
  if (words.length > 0) {
    queries.push(words.map((word) => `title:*${escapeSearch(word)}*`).join(" AND "));
    queries.push(words.slice(0, 5).join(" "));
  }
  if (normalized) queries.push(escapeSearch(normalized));
  return unique(queries);
}

function buildAddress(customer, input = {}) {
  const nameParts = splitCustomerName(customer.name || customer.fullName || customer.full_name || "");
  const firstName = nameParts.firstName || "Cliente";
  const lastName = nameParts.lastName || "Aurela";

  const coverage = input.coverage || {};
  const address1 = String(customer.address || customer.direccion || "").trim();

  // 1) Campos estructurados (customer, coverage, input) — la fuente confiable.
  let city = String(customer.district || customer.distrito || coverage.district || coverage.distrito || input.district || input.distrito || "").trim();
  let province = String(customer.province || customer.provincia || coverage.province || coverage.provincia || input.province || input.provincia || "").trim();

  // 2) Respaldo: si faltan y hay texto de direccion, extraer de los ultimos
  // segmentos separados por coma. 3+ segmentos: penultimo=distrito, ultimo=provincia.
  // 2 segmentos: ultimo=distrito. Limpia parentesis del tipo "(provincia)".
  if ((!city || !province) && address1) {
    const segs = address1
      .split(",")
      .map((s) => s.replace(/[()]/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (segs.length >= 3) {
      if (!city) city = segs[segs.length - 2];
      if (!province) province = segs[segs.length - 1];
    } else if (segs.length === 2) {
      if (!city) city = segs[segs.length - 1];
    }
  }

  // 3) Nunca dejar city vacio: Shopify no puebla la direccion sin city.
  if (!city) city = province || "Por coordinar";

  return {
    firstName,
    lastName,
    phone: normalizePhone(customer.phone || input.phone),
    address1: address1 || "Por coordinar",
    address2: customer.reference || customer.referencia || "",
    city,
    province,
    country: "PE",
    zip: "",
  };
}

function buildCustomAttributes(input, customerLookup) {
  const attrs = [];
  const conversationId = input.conversationId || input.conversation_id;
  const phoneNumberId = input.phoneNumberId || input.phone_number_id || input.whatsappPhoneNumberId || input.whatsapp_phone_number_id;

  if (conversationId) attrs.push({ key: "kapso_conversation_id", value: String(conversationId) });
  if (phoneNumberId) attrs.push({ key: "kapso_phone_number_id", value: String(phoneNumberId) });
  attrs.push({ key: "source", value: "whatsapp-bot" });

  if (customerLookup?.customerId) {
    attrs.push({ key: "kapso_shopify_customer_match", value: customerLookup.status });
    attrs.push({ key: "kapso_shopify_customer_id", value: customerLookup.customerId });
  } else if (customerLookup?.status) {
    attrs.push({ key: "kapso_shopify_customer_match", value: customerLookup.status });
  }

  const ref = input.ctwaReferral;
  if (ref) {
    const add = (key, value) => {
      const v = String(value ?? "").trim();
      if (v) attrs.push({ key, value: v.slice(0, 250) });
    };
    add("ctwa_source_type", ref.source_type);
    add("ctwa_ad_id", ref.source_id);
    add("ctwa_clid", ref.ctwa_clid);
    add("ctwa_headline", ref.headline);
    add("ctwa_source_url", ref.source_url);
  }
  return attrs;
}

function buildTags(input) {
  const tags = new Set(["kapso", "whatsapp", "aurela"]);
  if (input.coverage?.shippingMode === "contraentrega" || input.coverage?.shipping_mode === "contraentrega" || input.coverage?.cashOnDelivery === true || input.coverage?.cash_on_delivery === true) {
    tags.add("contraentrega");
    tags.add("conversion-confirmada");
    tags.add("pedido-confirmado");
  }
  if (input.quote?.promoApplied || input.quote?.promo_applied) tags.add("promo-whatsapp");
  if (input.ctwaReferral?.source_type === "ad") tags.add("ctwa-ad");
  if (input.stockPorValidar || input.stock_por_validar || input.stockValidationRequired || input.stock_validation_required) tags.add("stock-por-validar");
  if (input.specialDeliveryNote || input.special_delivery_note) tags.add("fecha-hora-especial");
  return [...tags];
}

// Nota corta para logistica: solo lo que se necesita de un vistazo. Se omiten
// datos que Shopify ya muestra en otros bloques (total, ids, customer id) y las
// lineas vacias. La direccion SI se conserva aqui porque el campo estructurado
// a veces queda incompleto.
function buildNote(input) {
  const customer = input.customer || {};
  const coverage = input.coverage || {};
  const mode = String(coverage.shippingMode || coverage.shipping_mode || "").toLowerCase();
  const pago = /agenc|shalom|olva/.test(mode)
    ? "Envio por agencia (adelanto + saldo)"
    : "Contraentrega (efectivo o Yape)";

  const nombre = String(customer.name || customer.fullName || customer.full_name || "").trim();
  const tel = String(customer.phone || input.phone || "").trim();
  const dir = String(customer.address || customer.direccion || "").trim();
  const ref = String(customer.reference || customer.referencia || "").trim();
  const distrito = String(customer.district || customer.distrito || "").trim();
  const provincia = String(customer.province || customer.provincia || "").trim();

  const lines = [
    `Pedido WhatsApp/Kapso · ${pago}`,
    `Producto(s): ${summaryLine(input.lineItems || input.items || [])}`,
  ];

  const contacto = [nombre, tel].filter(Boolean).join(" · ");
  if (contacto) lines.push(`Contacto: ${contacto}`);

  const zona = [distrito, provincia].filter(Boolean).join(", ");
  const entrega = [dir, ref ? `Ref: ${ref}` : "", zona].filter(Boolean).join(" · ");
  if (entrega) lines.push(`Entrega: ${entrega}`);

  const specialNote = sanitizeNoteText(input.specialDeliveryNote || input.special_delivery_note);
  if (specialNote) lines.push(`Fecha/hora solicitada: ${specialNote}`);
  return lines.filter(Boolean).join("\n");
}

function summaryLine(items) {
  return items.map((item) => `${item.quantity || 1} x ${item.productTitle || item.title || item.variantTitle || item.variantId}`).join("; ");
}

// --- Escaleras de regalos por cantidad --- deterministas, no dependen del LLM.
// Por producto: segun cuantas unidades/sets haya en el pedido se agregan regalos
// GRATIS (S/0) con su cantidad. triggers lista TODAS las variantes del producto
// (colores), asi aplica sin importar el color elegido.
const GIFT_LADDERS = [
  {
    tag: "regalo-eggmixer",
    triggers: ["gid://shopify/ProductVariant/44255967740124"],
    tiers: [
      { min: 5, gifts: [{ v: "gid://shopify/ProductVariant/43391484657884", q: 1 }, { v: "gid://shopify/ProductVariant/40428462604476", q: 1 }, { v: "gid://shopify/ProductVariant/44288695337180", q: 1 }] },
      { min: 3, gifts: [{ v: "gid://shopify/ProductVariant/43391484657884", q: 1 }, { v: "gid://shopify/ProductVariant/40428462604476", q: 1 }] },
      { min: 1, gifts: [{ v: "gid://shopify/ProductVariant/43391484657884", q: 1 }] },
    ],
  },
  {
    tag: "regalo-suntent",
    triggers: ["gid://shopify/ProductVariant/44036950622428","gid://shopify/ProductVariant/45049209258204","gid://shopify/ProductVariant/45049209290972","gid://shopify/ProductVariant/44036950589660"],
    tiers: [
      { min: 5, gifts: [{ v: "gid://shopify/ProductVariant/52424310489308", q: 2 }, { v: "gid://shopify/ProductVariant/52424314912988", q: 2 }] },
      { min: 3, gifts: [{ v: "gid://shopify/ProductVariant/52424314912988", q: 2 }, { v: "gid://shopify/ProductVariant/52424310489308", q: 1 }] },
      { min: 1, gifts: [{ v: "gid://shopify/ProductVariant/52424310489308", q: 1 }, { v: "gid://shopify/ProductVariant/52424314912988", q: 1 }] },
    ],
  },
];
// Pedido en WooCommerce: las mismas escaleras, con los regalos a S/ 0. El catalogo publico de la tienda trae los IDs
// de variante de Shopify (cod-core), asi que los triggers y los regalos sirven igual. Un regalo que no esta en el
// catalogo (borrador u oculto) no frena el pedido: va en la nota para que el equipo lo agregue a mano.
function wooGiftLines(catalog, lines) {
  const gifts = giftLineItems(lines.map((line) => ({ variantId: `gid://shopify/ProductVariant/${line.variant.id}`, quantity: line.quantity })));
  const found = [];
  const missing = [];
  for (const gift of gifts.items) {
    const wanted = numericId(gift.variantId);
    let match = null;
    for (const product of catalog) {
      const variant = (product.variants || []).find((v) => String(v.id) === wanted);
      if (variant && variant.woo_id) {
        match = { product, variant, quantity: gift.quantity };
        break;
      }
    }
    if (match) found.push(match);
    else missing.push(`${gift.quantity} x variante ${wanted}`);
  }
  return { found, missing, tags: gifts.tags };
}

function wooLineTitle(line) {
  return [line.product.title, line.variant.title !== "Default Title" ? line.variant.title : ""].filter(Boolean).join(" - ");
}

function giftLineItems(lineItems) {
  const items = [];
  const tags = [];
  for (const ladder of GIFT_LADDERS) {
    const qty = (lineItems || [])
      .filter((it) => ladder.triggers.includes(String(it.variantId)))
      .reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    if (qty < 1) continue;
    const tier = ladder.tiers.find((t) => qty >= t.min);
    if (!tier) continue;
    for (const g of tier.gifts) items.push({ variantId: g.v, quantity: g.q, priceSet: moneySet(0) });
    tags.push(ladder.tag);
  }
  return { items, tags };
}

function moneySet(amount) {
  return {
    shopMoney: { amount: Number(amount), currencyCode: "PEN" },
    presentmentMoney: { amount: Number(amount), currencyCode: "PEN" },
  };
}

async function shopifyGraphql(config, query, variables) {
  const response = await fetch(`https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(JSON.stringify(payload.errors || payload));
  }
  return payload.data;
}

function enrichConversationContext(input, payload) {
  if (!input || typeof input !== "object") return;
  const p = payload || {};

  if (!input.conversationId && !input.conversation_id) {
    const conversationId = p.conversationId || p.conversation_id || p.conversation?.id || p.metadata?.conversation_id || p.metadata?.conversationId || p.execution_context?.context?.conversation_id;
    if (conversationId) input.conversationId = conversationId;
  }

  if (!input.phoneNumberId && !input.phone_number_id) {
    const phoneNumberId = p.phoneNumberId || p.phone_number_id || p.whatsapp?.phone_number_id || p.metadata?.phone_number_id || p.execution_context?.system?.whatsapp_config?.phone_number_id;
    if (phoneNumberId) input.phoneNumberId = phoneNumberId;
  }
}

function enrichCustomerFromContext(input, payload) {
  if (!input || typeof input !== "object") return;
  if (!input.customer || typeof input.customer !== "object") input.customer = {};
  const customer = input.customer;
  const context = payload?.execution_context?.context || {};
  const contact = context.contact || {};
  const wa = payload?.whatsapp_context || {};

  if (!customer.phone && !input.phone) {
    const phone = context.phone_number || wa.conversation?.phone_number;
    if (phone) input.phone = phone;
  }
  if (!customer.name && !customer.fullName) {
    const name = contact.name || contact.profile_name || contact.display_name || wa.conversation?.contact_name;
    if (name) customer.name = name;
  }
}

function unwrapInput(payload) {
  if (payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input)) return payload.input;
  return payload || {};
}

function normalizeVariantId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("gid://shopify/ProductVariant/")) return text;
  const numeric = text.match(/\d+/)?.[0];
  return numeric ? `gid://shopify/ProductVariant/${numeric}` : "";
}

function extractHandleCandidates(value) {
  const text = String(value || "").trim();
  const candidates = [];
  if (/^[^\s/]{3,}$/.test(text)) candidates.push(text);

  const urls = text.match(/https?:\/\/[^\s]+/gi) || [];
  for (const rawUrl of urls) {
    try {
      const cleanedUrl = rawUrl.replace(/[)\].,!?]+$/g, "");
      const url = new URL(cleanedUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      const productIndex = parts.indexOf("products");
      if (productIndex !== -1 && parts[productIndex + 1]) candidates.push(parts[productIndex + 1].replace(/\.js$/i, ""));
    } catch {
      // Ignore malformed URLs.
    }
  }

  return unique(candidates.flatMap((handle) => {
    const decoded = safeDecode(handle);
    return [handle, decoded, slugifyHandle(decoded)];
  }));
}

function splitCustomerName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Cliente", lastName: "Aurela" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "Aurela" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function slugifyHandle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  return /.+@.+\..+/.test(text) ? text : "";
}

function normalizePhone(value) {
  const digits = phoneDigits(value);
  if (!digits) return "";
  if (digits.startsWith("51") && digits.length === 11) return `+${digits}`;
  if (digits.length === 9) return `+51${digits}`;
  return `+${digits}`;
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function samePhoneDigits(a, b) {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-9) === db.slice(-9);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeSearch(value) {
  return String(value || "").replace(/["'\\:]/g, " ").trim();
}

function escapeCustomerSearch(value) {
  return String(value || "").replace(/["'\\]/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return money(value).toFixed(2);
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

globalThis.__aurelaCreateShopifyOrder = {
  buildAddress,
  buildNote,
  buildOrderInput,
  computeWooPricing,
  getStoreBackend,
  handleWooOrder,
  resolveWooLineItems,
  spreadWooDiscount,
  wooLocation,
  wooQuoteMismatchNote,
  wooCustomerPhone,
  computePricing,
  countFreeUnits,
  fetchCtwaReferral,
  findShopifyCustomer,
  handleRequest,
  handler,
  resolveOrderCustomer,
};
