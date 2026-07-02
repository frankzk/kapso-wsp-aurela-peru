const DEFAULT_SHOP_DOMAIN = "aurela-peru.myshopify.com";
const DEFAULT_API_VERSION = "2026-04";
const DEFAULT_PHONE_NUMBER_ID = "1241790819006805"; // numero de WhatsApp de Aurela (fallback para atribucion CTWA)
const MAX_QUANTITY = 50; // tope de seguridad: evita ordenes accidentales de miles de unidades
// Reglas de promo/envio (espejo de quote-order): el descuento 3x2/5x3 se calcula
// aqui en el servidor desde los precios reales, sin depender de que el agente lo pase.
const FREE_SHIPPING_THRESHOLD = 40;
const SHIPPING_FEE_UNDER_THRESHOLD = 10;

function clampQuantity(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_QUANTITY, n);
}

// Limpia texto libre del cliente antes de meterlo en la nota de Shopify:
// colapsa saltos de linea y espacios, recorta y limita largo.
function sanitizeNoteText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
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
    const input = unwrapInput(payload);
    enrichConversationContext(input, payload);

    if (input.coverage?.shippingMode === "agencia" || input.coverage?.shipping_mode === "agencia" || input.requiresLogisticsValidation || input.requires_logistics_validation) {
      return json({
        ok: false,
        reason: "logistics_validation_required",
        message: "Este pedido requiere validacion logistica antes de crear la orden.",
      });
    }

    const config = await getConfig(env);
    // Atribucion CTWA (Click-to-WhatsApp): lee el referral del anuncio desde el
    // primer mensaje de la conversacion via API de Kapso, de forma determinista
    // (sin depender de que el agente lo pase). Fail-soft: null si no hay key,
    // no hay referral (trafico organico) o la consulta falla.
    input.ctwaReferral = await fetchCtwaReferral(env, input);
    const orderInput = await buildOrderInput(config, input);

    // Check final de stock por variante (cubre el caso en que el agente pasa variantId
    // directo). Criterio: availableForSale. La orden se crea igual, pero se marca para
    // validacion logistica si alguna variante esta agotada.
    const outOfStockVariants = await checkVariantsStock(config, orderInput.lineItems.map((li) => li.variantId));
    const stockToValidate = outOfStockVariants.length > 0;
    if (stockToValidate) {
      if (!orderInput.tags.includes("stock-por-validar")) orderInput.tags.push("stock-por-validar");
      const detail = outOfStockVariants.map((v) => v.title || v.id).join("; ");
      orderInput.note = `${orderInput.note}\nSTOCK POR VALIDAR (sin stock al crear): ${detail}`;
    }

    if (input.dryRun || input.dry_run) {
      return json({
        ok: true,
        dryRun: true,
        stockToValidate,
        outOfStockVariants,
        orderPreview: {
          lineItems: orderInput.lineItems,
          phone: orderInput.phone,
          shippingAddress: orderInput.shippingAddress,
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
      return json({ ok: false, reason: "shopify_user_errors", errors: result.userErrors });
    }

    return json({
      ok: true,
      stage: "orden creada",
      conversionStatus: "confirmed",
      conversionType: "contraentrega",
      conversionTotal: Number(input.quote?.total ?? input.quote?.totalAmount ?? 0),
      stockToValidate,
      outOfStockVariants,
      order: {
        id: result.order.id,
        name: result.order.name,
        legacyResourceId: result.order.legacyResourceId,
        statusUrl: result.order.statusPageUrl,
      },
      customerMessage: stockToValidate
        ? "Listo, registre tu pedido. Queda sujeto a confirmacion de stock; nuestro equipo lo valida y te confirma por aqui."
        : "Listo, tu pedido quedo registrado. Nuestro equipo coordinara el despacho por aqui.",
    });
  } catch (error) {
    return json({ ok: false, reason: "order_create_error", error: safeError(error) });
  }
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
      }
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

  if (!token) {
    throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

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

// Config para llamar a la API de Kapso (atribucion CTWA). La API key del proyecto
// va en runtime_config (gitignored), igual que el token de Shopify.
function getKapsoConfig(env = globalThis) {
  const apiKey = env.KAPSO_API_KEY || env.kAPSOAPIKEY || globalThis.KAPSO_API_KEY || globalThis.kAPSOAPIKEY;
  const apiBase = env.KAPSO_API_BASE || env.kAPSOAPIBASE || globalThis.KAPSO_API_BASE || "https://api.kapso.ai";
  return { apiKey, apiBase };
}

const CTWA_MAX_PAGES = 5; // tope de paginas (100 msgs c/u) al buscar el referral

// Busca el objeto referral del anuncio (Click-to-WhatsApp) en los mensajes
// entrantes de la conversacion. El referral solo viene en el PRIMER mensaje, que
// es el mas antiguo; los mensajes llegan del mas nuevo al mas viejo, asi que
// paginamos con el cursor `next` hasta encontrarlo. Devuelve null si no hay key,
// no hay conversationId, no aparece referral, o algo falla (nunca lanza).
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

// El referral puede venir en distintos lugares segun el shape del payload.
function extractReferral(message) {
  const referral = message?.referral || message?.message?.referral || message?.kapso?.referral;
  if (referral && (referral.source_id || referral.source_type || referral.ctwa_clid)) return referral;
  return null;
}

async function buildOrderInput(config, input) {
  const customer = input.customer || {};
  const quote = input.quote || {};
  const lineItems = await resolveLineItems(config, normalizeLineItems(input.lineItems || input.items || []));

  if (!lineItems.length) {
    throw new Error("Missing line items with valid Shopify variant IDs");
  }

  // Descuento de promo (3x2/5x3) y envio se calculan en el servidor desde los
  // precios reales de las variantes, para que la orden SIEMPRE respete la promo
  // aunque el agente olvide pasar quote.discountTotal. Si la consulta de precios
  // falla, se cae al quote que envio el agente (comportamiento previo).
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

  const order = {
    lineItems: lineItems.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    phone: normalizePhone(customer.phone || input.phone),
    shippingAddress: buildAddress(customer),
    billingAddress: buildAddress(customer),
    tags: buildTags(input),
    note: buildNote(input),
    financialStatus: "PENDING",
    presentmentCurrency: "PEN",
  };

  const customAttributes = buildCustomAttributes(input);
  if (customAttributes.length) {
    order.customAttributes = customAttributes;
  }

  if (customer.email) {
    order.email = customer.email;
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

  return order;
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
    if (variant?.id) {
      resolved.push({ ...item, variantId: normalizeVariantId(variant.id) });
    }
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
  if (!item.variantTitle) {
    return variants.find((variant) => variant.availableForSale) || variants[0];
  }

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
        ...ProductFields
      }
    }

    fragment ProductFields on Product {
      id
      handle
      title
      variants(first: 100) {
        nodes {
          id
          title
          availableForSale
          selectedOptions { name value }
        }
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
        ... on ProductVariant {
          id
          title
          availableForSale
          product { title }
        }
      }
    }`;

  try {
    const data = await shopifyGraphql(config, query, { ids });
    const nodes = (data.nodes || []).filter(Boolean);
    return nodes
      .filter((variant) => variant.availableForSale === false)
      .map((variant) => ({
        id: variant.id,
        title: [variant.product?.title, variant.title].filter(Boolean).join(" - "),
      }));
  } catch {
    // Fail-open: si el check falla, no bloqueamos la creacion de la orden.
    return [];
  }
}

// Calcula descuento de promo (3x2/5x3) y envio desde los precios reales de las
// variantes. Devuelve null si no se pudo obtener el precio de todas (fallback al
// quote del agente). La promo aplica por producto: variantes del mismo producto
// cuentan juntas (mismas reglas que quote-order).
async function computePricing(config, lineItems) {
  const variantIds = lineItems.map((li) => normalizeVariantId(li.variantId)).filter(Boolean);
  const pricing = await fetchVariantPricing(config, variantIds);
  if (!pricing.size) return null;

  const unitsByProduct = new Map();
  for (const item of lineItems) {
    const info = pricing.get(normalizeVariantId(item.variantId));
    if (!info || !Number.isFinite(info.price)) return null; // sin precio confiable -> fallback
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

// Unidades gratis por promo: 5x3 (2 gratis por cada 5) + 3x2 (1 gratis si el resto >=3).
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
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          product { id }
        }
      }
    }`;

  try {
    const data = await shopifyGraphql(config, query, { ids });
    const map = new Map();
    for (const node of (data.nodes || []).filter(Boolean)) {
      map.set(node.id, { price: Number(node.price), productId: node.product?.id || node.id });
    }
    return map;
  } catch {
    // Fail-soft: si falla la consulta de precios, devolvemos vacio y se usa el quote del agente.
    return new Map();
  }
}

async function searchProducts(config, text) {
  const searchQueries = buildProductSearchQueries(text);
  if (searchQueries.length === 0) return [];

  const query = `#graphql
    query SearchProducts($query: String!) {
      products(first: 5, query: $query) {
        nodes {
          id
          handle
          title
          variants(first: 100) {
            nodes {
              id
              title
              availableForSale
              selectedOptions { name value }
            }
          }
        }
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
  const words = unique(
    normalized
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .slice(0, 8),
  );

  const queries = [];
  if (words.length > 0) {
    queries.push(words.map((word) => `title:*${escapeSearch(word)}*`).join(" AND "));
    queries.push(words.slice(0, 5).join(" "));
  }
  if (normalized) queries.push(escapeSearch(normalized));
  return unique(queries);
}

function buildAddress(customer) {
  const [firstName, ...lastNameParts] = String(customer.name || customer.fullName || "").trim().split(/\s+/);
  return {
    firstName: firstName || "Cliente",
    lastName: lastNameParts.join(" ") || "Aurela",
    phone: normalizePhone(customer.phone),
    address1: customer.address || customer.direccion || "Por coordinar",
    address2: customer.reference || customer.referencia || "",
    city: customer.district || customer.distrito || "",
    province: customer.province || customer.provincia || "",
    country: "PE",
    zip: "",
  };
}

// Atributos estructurados (note_attributes) para enlazar la orden con la
// conversacion de Kapso de forma confiable (sin parsear la nota de texto).
// Los consume el panel de analitica multi-tienda.
function buildCustomAttributes(input) {
  const attrs = [];
  const conversationId = input.conversationId || input.conversation_id;
  const phoneNumberId =
    input.phoneNumberId || input.phone_number_id || input.whatsappPhoneNumberId || input.whatsapp_phone_number_id;

  if (conversationId) attrs.push({ key: "kapso_conversation_id", value: String(conversationId) });
  if (phoneNumberId) attrs.push({ key: "kapso_phone_number_id", value: String(phoneNumberId) });
  attrs.push({ key: "source", value: "whatsapp-bot" });

  // Atribucion de campana Click-to-WhatsApp: enlaza la orden con el anuncio de
  // origen para medir ventas por campana/anuncio en el panel.
  const ref = input.ctwaReferral;
  if (ref) {
    const add = (key, value) => {
      const v = String(value ?? "").trim();
      if (v) attrs.push({ key, value: v.slice(0, 250) });
    };
    add("ctwa_source_type", ref.source_type); // ad | post | organic
    add("ctwa_ad_id", ref.source_id);          // ID del anuncio (clave de atribucion)
    add("ctwa_clid", ref.ctwa_clid);           // click id (atribucion fina)
    add("ctwa_headline", ref.headline);        // titulo legible del anuncio
    add("ctwa_source_url", ref.source_url);
  }
  return attrs;
}

function buildTags(input) {
  const tags = new Set(["kapso", "whatsapp", "aurela"]);
  if (
    input.coverage?.shippingMode === "contraentrega"
    || input.coverage?.shipping_mode === "contraentrega"
    || input.coverage?.cashOnDelivery === true
    || input.coverage?.cash_on_delivery === true
  ) {
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

function buildNote(input) {
  const customer = input.customer || {};
  const quote = input.quote || {};
  const lines = [
    "Pedido creado desde WhatsApp/Kapso.",
    `Producto(s): ${summaryLine(input.lineItems || input.items || [])}`,
    `Total cotizado: S/ ${formatMoney(quote.total || 0)}`,
    `Metodo: Contraentrega - efectivo o Yape`,
    `Cliente: ${customer.name || customer.fullName || ""}`,
    `Telefono: ${customer.phone || input.phone || ""}`,
    `Distrito: ${customer.district || customer.distrito || ""}`,
    `Provincia: ${customer.province || customer.provincia || ""}`,
    `Region: ${customer.region || customer.departamento || ""}`,
    `Direccion: ${customer.address || customer.direccion || ""}`,
    `Referencia: ${customer.reference || customer.referencia || ""}`,
  ];

  const specialNote = sanitizeNoteText(input.specialDeliveryNote || input.special_delivery_note);
  if (specialNote) {
    lines.push(`Fecha/hora solicitada: ${specialNote}`);
  }

  if (input.conversationId) {
    lines.push(`Kapso conversation: ${input.conversationId}`);
  }

  return lines.filter(Boolean).join("\n");
}

function summaryLine(items) {
  return items
    .map((item) => `${item.quantity || 1} x ${item.productTitle || item.title || item.variantTitle || item.variantId}`)
    .join("; ");
}

function moneySet(amount) {
  return {
    shopMoney: {
      amount: Number(amount),
      currencyCode: "PEN",
    },
    presentmentMoney: {
      amount: Number(amount),
      currencyCode: "PEN",
    },
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

// Captura el contexto de conversacion de Kapso desde la raiz del payload (varias
// formas posibles) y lo fusiona en `input` si el agente no lo paso. Habilita el
// enlace orden <-> conversacion para el panel de analitica sin depender del prompt.
function enrichConversationContext(input, payload) {
  if (!input || typeof input !== "object") return;
  const p = payload || {};

  if (!input.conversationId && !input.conversation_id) {
    const conversationId =
      p.conversationId || p.conversation_id || p.conversation?.id || p.metadata?.conversation_id || p.metadata?.conversationId;
    if (conversationId) input.conversationId = conversationId;
  }

  if (!input.phoneNumberId && !input.phone_number_id) {
    const phoneNumberId =
      p.phoneNumberId || p.phone_number_id || p.whatsapp?.phone_number_id || p.metadata?.phone_number_id;
    if (phoneNumberId) input.phoneNumberId = phoneNumberId;
  }
}

function unwrapInput(payload) {
  if (payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input;
  }
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
      if (productIndex !== -1 && parts[productIndex + 1]) {
        candidates.push(parts[productIndex + 1].replace(/\.js$/i, ""));
      }
    } catch {
      // Ignore malformed URLs.
    }
  }

  return unique(candidates.flatMap((handle) => {
    const decoded = safeDecode(handle);
    return [handle, decoded, slugifyHandle(decoded)];
  }));
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

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("51") && digits.length === 11) return `+${digits}`;
  if (digits.length === 9) return `+51${digits}`;
  return `+${digits}`;
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

globalThis.__aurelaCreateShopifyOrder = { buildOrderInput, computePricing, countFreeUnits, fetchCtwaReferral, handleRequest, handler };
