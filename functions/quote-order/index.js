const FREE_SHIPPING_THRESHOLD = 40;
const SHIPPING_FEE_UNDER_THRESHOLD = 10;
const MAX_QUANTITY = 50; // tope de seguridad: evita ordenes accidentales de miles de unidades

function clampQuantity(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_QUANTITY, n);
}

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request) {
  try {
    const payload = await readJson(request);
    const input = unwrapInput(payload);
    const lineItems = normalizeLineItems(input.lineItems || input.items || []);

    if (!lineItems.length) {
      return json({ ok: false, reason: "missing_items", message: "Faltan productos para calcular la cotizacion." });
    }

    const grouped = groupByProduct(lineItems);
    const quotedGroups = grouped.map(quoteGroup);
    const subtotalBeforeDiscount = money(quotedGroups.reduce((sum, group) => sum + group.subtotalBeforeDiscount, 0));
    const discountTotal = money(quotedGroups.reduce((sum, group) => sum + group.discountAmount, 0));
    const subtotalAfterDiscount = money(subtotalBeforeDiscount - discountTotal);
    const shippingFee = subtotalAfterDiscount > FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE_UNDER_THRESHOLD;
    const total = money(subtotalAfterDiscount + shippingFee);

    return json({
      ok: true,
      currencyCode: "PEN",
      subtotalBeforeDiscount,
      discountTotal,
      subtotalAfterDiscount,
      shippingFee,
      freeShipping: shippingFee === 0,
      total,
      promoApplied: quotedGroups.some((group) => group.freeUnits > 0),
      groups: quotedGroups,
      customerMessage: buildCustomerMessage({ quotedGroups, subtotalAfterDiscount, shippingFee, total }),
    });
  } catch (error) {
    return json({ ok: false, reason: "quote_error", error: safeError(error) });
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

function normalizeLineItems(items) {
  return items
    .map((item) => ({
      productId: String(item.productId || item.product_id || item.product?.id || item.handle || item.title || "").trim(),
      productTitle: String(item.productTitle || item.product_title || item.product?.title || item.title || "").trim(),
      variantId: String(item.variantId || item.variant_id || item.variant?.id || "").trim(),
      variantTitle: String(item.variantTitle || item.variant_title || item.variant?.title || "").trim(),
      quantity: clampQuantity(item.quantity ?? item.qty ?? 1),
      unitPrice: Number(item.unitPrice ?? item.unit_price ?? item.price ?? item.variant?.price),
    }))
    .filter((item) => item.productId && item.quantity > 0 && Number.isFinite(item.unitPrice));
}

function unwrapInput(payload) {
  if (payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input;
  }
  return payload || {};
}

function groupByProduct(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.productId;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

function quoteGroup(items) {
  const expandedUnits = [];
  for (const item of items) {
    for (let index = 0; index < item.quantity; index += 1) {
      expandedUnits.push({
        productId: item.productId,
        productTitle: item.productTitle,
        variantId: item.variantId,
        variantTitle: item.variantTitle,
        unitPrice: item.unitPrice,
      });
    }
  }

  const quantity = expandedUnits.length;
  const freeUnits = countFreeUnits(quantity);
  const sortedForFree = [...expandedUnits].sort((a, b) => a.unitPrice - b.unitPrice);
  const freeUnitKeys = new Map();

  for (const unit of sortedForFree.slice(0, freeUnits)) {
    const key = `${unit.variantId || unit.variantTitle || unit.productId}|${unit.unitPrice}`;
    freeUnitKeys.set(key, (freeUnitKeys.get(key) || 0) + 1);
  }

  const lines = items.map((item) => {
    const key = `${item.variantId || item.variantTitle || item.productId}|${item.unitPrice}`;
    const freeForLine = Math.min(item.quantity, freeUnitKeys.get(key) || 0);
    return {
      productId: item.productId,
      productTitle: item.productTitle,
      variantId: item.variantId,
      variantTitle: item.variantTitle,
      quantity: item.quantity,
      unitPrice: money(item.unitPrice),
      subtotalBeforeDiscount: money(item.unitPrice * item.quantity),
      freeUnits: freeForLine,
      paidUnits: item.quantity - freeForLine,
    };
  });

  const subtotalBeforeDiscount = money(expandedUnits.reduce((sum, unit) => sum + unit.unitPrice, 0));
  const discountAmount = money(sortedForFree.slice(0, freeUnits).reduce((sum, unit) => sum + unit.unitPrice, 0));

  return {
    productId: items[0].productId,
    productTitle: items[0].productTitle,
    quantity,
    paidUnits: quantity - freeUnits,
    freeUnits,
    promo: promoLabel(quantity),
    subtotalBeforeDiscount,
    discountAmount,
    subtotalAfterDiscount: money(subtotalBeforeDiscount - discountAmount),
    lines,
  };
}

function countFreeUnits(quantity) {
  const fivePacks = Math.floor(quantity / 5);
  const remainder = quantity % 5;
  const threePackFreeUnits = remainder >= 3 ? 1 : 0;
  return fivePacks * 2 + threePackFreeUnits;
}

function promoLabel(quantity) {
  if (quantity >= 5) return "5x3";
  if (quantity >= 3) return "3x2";
  return "sin promo";
}

function buildCustomerMessage({ quotedGroups, subtotalAfterDiscount, shippingFee, total }) {
  const lines = quotedGroups.map((group) => {
    const promo = group.freeUnits > 0 ? ` (${group.promo}: pagas ${group.paidUnits} y llevas ${group.quantity})` : "";
    return `- ${group.quantity} x ${group.productTitle}${promo}: S/ ${formatMoney(group.subtotalAfterDiscount)}`;
  });

  const shipping = shippingFee === 0 ? "Envio: gratis" : `Envio: S/ ${formatMoney(shippingFee)}`;

  return [
    "Tu pedido va asi:",
    ...lines,
    shipping,
    `Total a pagar: S/ ${formatMoney(total)}`,
  ].join("\n");
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

globalThis.__aurelaQuoteOrder = { countFreeUnits, handleRequest, handler, quoteGroup };
