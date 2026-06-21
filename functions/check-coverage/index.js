const CASH_ON_DELIVERY = {
  lima: ["lima metropolitana", "lima", "*"],
  callao: ["callao", "*"],
  arequipa: [
    "arequipa",
    "alto selva alegre",
    "cayma",
    "cerro colorado",
    "characato",
    "jacobo hunter",
    "mariano melgar",
    "miraflores",
    "paucarpata",
    "socabaya",
    "yanahuara",
    "jose luis bustamante y rivero",
  ],
  "la libertad": ["trujillo", "el porvenir", "la esperanza", "huanchaco", "moche", "victor larco herrera"],
  lambayeque: ["chiclayo", "jose leonardo ortiz", "la victoria", "lambayeque", "pimentel"],
  piura: ["piura", "castilla", "catacaos", "26 de octubre", "sullana", "talara"],
};

const DISTRICT_LOCATION_HINTS = {
  trujillo: { province: "trujillo", region: "la libertad" },
  "el porvenir": { province: "trujillo", region: "la libertad" },
  "la esperanza": { province: "trujillo", region: "la libertad" },
  huanchaco: { province: "trujillo", region: "la libertad" },
  moche: { province: "trujillo", region: "la libertad" },
  "victor larco herrera": { province: "trujillo", region: "la libertad" },
  arequipa: { province: "arequipa", region: "arequipa" },
  "alto selva alegre": { province: "arequipa", region: "arequipa" },
  cayma: { province: "arequipa", region: "arequipa" },
  "cerro colorado": { province: "arequipa", region: "arequipa" },
  "jacobo hunter": { province: "arequipa", region: "arequipa" },
  miraflores: { province: "lima", region: "lima" },
  "santiago de surco": { province: "lima", region: "lima" },
  "san isidro": { province: "lima", region: "lima" },
  "san borja": { province: "lima", region: "lima" },
  "san miguel": { province: "lima", region: "lima" },
  "los olivos": { province: "lima", region: "lima" },
  callao: { province: "callao", region: "callao" },
  chiclayo: { province: "chiclayo", region: "lambayeque" },
  piura: { province: "piura", region: "piura" },
  castilla: { province: "piura", region: "piura" },
};

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request) {
  const payload = await readJson(request);

  // Follow-up ladder routing: when invoked by a Decide node, the payload carries
  // `available_edges`. Coverage tool calls never include it, so this branch is
  // inert for the normal coverage flow.
  if (Array.isArray(payload.available_edges)) {
    return routeFollowup(payload);
  }

  const input = unwrapInput(payload);
  const region = normalizePlace(input.region || input.departamento || input.department || input.province);
  const province = normalizePlace(input.province || input.provincia || input.city);
  const district = normalizePlace(input.district || input.distrito || input.zone);
  const address = normalizePlace(input.address || input.direccion || "");
  const shalomAgency = String(input.shalomAgency || input.agenciaShalom || input.shalom_agency || "").trim();

  const shippingText = [address, input.shippingMethod, input.metodoEnvio, input.courier, input.agency, shalomAgency].join(" ");
  const selectedCourier = detectCourier(shippingText);
  const agencyRequested = Boolean(selectedCourier) || /(agencia|oficina)/i.test(shippingText);
  const locationIssue = detectLocationInconsistency({ region, province, district });
  if (locationIssue) {
    return json({
      cashOnDelivery: false,
      shippingMode: "needs_location_confirmation",
      locationInconsistent: true,
      shouldAskLocationConfirmation: true,
      normalized: { district, province, region },
      suggested: locationIssue.suggested,
      message: locationIssue.message,
    });
  }

  const cod = hasCashOnDelivery({ region, province, district });

  if (cod && !agencyRequested) {
    return json({
      cashOnDelivery: true,
      shippingMode: "contraentrega",
      requiresDni: false,
      requiresAdvance: false,
      advanceAmount: 0,
      couriers: [],
      normalized: { district, province, region },
      message: "Zona con pago contraentrega. Puede pagar al recibir en efectivo o Yape.",
    });
  }

  if (selectedCourier === "shalom") {
    return json({
      cashOnDelivery: false,
      shippingMode: "agencia",
      courier: "Shalom",
      requiresDni: true,
      requiresAdvance: true,
      advanceAmount: 30,
      paymentRecipient: "Grupo GF SAC",
      yapePhone: "930 555 309",
      requiresFullPrepayment: false,
      balancePayment: "pickup",
      requiresShalomAgency: true,
      shalomAgency: shalomAgency || "",
      requiresVoucherBeforeConfirmation: true,
      shouldCreateOrder: false,
      normalized: { district, province, region },
      message: shalomAgency
        ? `Listo, lo enviamos a la agencia Shalom: ${shalomAgency}.\nPara separarlo, realiza el adelanto de S/30 al Yape:\nGrupo GF SAC\n📱 930 555 309\nEl saldo lo pagas al recoger.\nTambién necesito el DNI del titular que recogerá.\nEnvíame el voucher o captura para pasarlo a validación logística ✅`
        : "Perfecto 🙌\nSí podemos enviarlo por Shalom. Para dejarlo encaminado, dime a qué agencia/oficina de Shalom deseas que llegue.\nLuego te paso el Yape para el adelanto de S/30 y con el voucher lo pasamos a validación ✅",
    });
  }

  if (selectedCourier === "olva") {
    return json({
      cashOnDelivery: false,
      shippingMode: "agencia",
      courier: "Olva Courier",
      requiresDni: false,
      requiresAdvance: false,
      advanceAmount: 0,
      requiresFullPrepayment: true,
      requiresExactAddress: true,
      requiresVoucherBeforeConfirmation: true,
      shouldCreateOrder: false,
      paymentRecipient: "Grupo GF SAC",
      yapePhone: "930 555 309",
      normalized: { district, province, region },
      message: "Perfecto 😊\nPor Olva Courier el pago es anticipado completo.\nPuedes realizarlo al Yape:\nGrupo GF SAC\n📱 930 555 309\nCuando lo realices, envíame el voucher o captura para continuar con la confirmación ✅",
    });
  }

  return json({
    cashOnDelivery: false,
    shippingMode: "agencia",
    requiresDni: true,
    requiresAdvance: true,
    advanceAmount: 30,
    courier: "Shalom",
    couriers: ["Shalom", "Olva"],
    paymentRecipient: "Grupo GF SAC",
    yapePhone: "930 555 309",
    requiresVoucherBeforeConfirmation: true,
    shouldCreateOrder: false,
    requiresShalomAgency: true,
    nextAction: "ask_shalom_agency",
    normalized: { district, province, region },
    message: "Sí, podemos enviarlo por Shalom 🙌\nPara dejarlo encaminado, dime a qué agencia/oficina de Shalom deseas que llegue.\nLuego te paso el Yape para el adelanto de S/30 y con el voucher lo pasamos a validación ✅",
  });
}

// ----- Follow-up ladder decide routing -----
// Serves three decide types, detected by available_edges:
//   resume reason  -> ["respondio", "timeout"]
//   terminal check -> ["seguir", "terminar"]
//   quiet hours    -> ["enviar", "esperar"]  (Peru UTC-5, quiet 00:00-06:59)
const FOLLOWUP_TERMINAL_MARKERS = [
  "orden creada",
  "orden_creada",
  "lead_perdido",
  "lead perdido",
  "handoff",
  "derivad",
  "no_interes",
  "no interes",
  "reclamo",
  "molesto",
  "cancel",
];

function routeFollowup(payload) {
  try {
    const edges = payload.available_edges;
    const ctx = isPlainObject(payload.execution_context) ? payload.execution_context : {};
    const vars = isPlainObject(ctx.vars) ? ctx.vars : {};
    const system = isPlainObject(ctx.system) ? ctx.system : {};
    const messages = (payload.whatsapp_context && Array.isArray(payload.whatsapp_context.messages))
      ? payload.whatsapp_context.messages
      : [];

    if (edges.includes("timeout") && edges.includes("respondio")) {
      return json({ next_edge: resolveResume(system, messages) });
    }

    if (edges.includes("terminar")) {
      const stage = String(vars.stage || "").toLowerCase();
      const isTerminal = FOLLOWUP_TERMINAL_MARKERS.some((marker) => stage.includes(marker));
      return json({ next_edge: isTerminal ? "terminar" : "seguir" });
    }

    if (edges.includes("esperar")) {
      return json({ next_edge: isQuietHourPeru() ? "esperar" : "enviar" });
    }

    return json({ next_edge: edges[0] || "" });
  } catch (error) {
    return json({ next_edge: "respondio", error: error instanceof Error ? error.message : String(error) });
  }
}

function resolveResume(system, messages) {
  const reason = system && system.last_resume && system.last_resume.reason;
  if (typeof reason === "string" && reason.length > 0) {
    return reason === "timeout" ? "timeout" : "respondio";
  }
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  if (last && last.direction === "inbound") return "respondio";
  return "timeout";
}

function isQuietHourPeru() {
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  return limaHour < 7; // 00:00-06:59 -> quiet
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    return { message: text };
  }
}

function hasCashOnDelivery({ region, province, district }) {
  const candidates = [region, province].filter(Boolean);

  if (candidates.some((item) => item === "callao")) return true;
  if (candidates.some((item) => item === "lima")) return true;

  for (const place of candidates) {
    const coveredDistricts = CASH_ON_DELIVERY[place];
    if (!coveredDistricts) continue;
    if (coveredDistricts.includes("*")) return true;
    if (district && coveredDistricts.includes(district)) return true;
  }

  return false;
}

function normalizePlace(value) {
  return stripAccents(String(value || ""))
    .toLowerCase()
    .replace(/\bprovincia constitucional del callao\b/g, "callao")
    .replace(/\blima metropolitana\b/g, "lima")
    .replace(/\blim\b|\blma\b/g, "lima")
    .replace(/\bareq\b/g, "arequipa")
    .replace(/\btruj\b/g, "trujillo")
    .replace(/\bcuz\b/g, "cusco")
    .replace(/\bcuzco\b/g, "cusco")
    .replace(/\s+/g, " ")
    .trim();
}

function detectCourier(value) {
  const text = stripAccents(String(value || "")).toLowerCase();
  if (/\b(shalom|shalon|shaloom)\b/.test(text)) return "shalom";
  if (/\bolva\b/.test(text) || /\bolva\s+curier\b/.test(text) || /\bolva\s+courier\b/.test(text)) return "olva";
  return "";
}

function detectLocationInconsistency({ region, province, district }) {
  if (!district || !province) return null;

  const expected = DISTRICT_LOCATION_HINTS[district];
  if (!expected) return null;

  const provinceMismatch = province !== expected.province && province !== expected.region;
  const regionMismatch = region && region !== expected.region && region !== expected.province;
  if (!provinceMismatch && !regionMismatch) return null;

  const districtLabel = titleCasePlace(district);
  const provinceLabel = titleCasePlace(province);
  const expectedProvinceLabel = titleCasePlace(expected.province);
  const expectedRegionLabel = titleCasePlace(expected.region);

  return {
    suggested: expected,
    message: [
      "Solo para validar 😊",
      `Me indicaste distrito ${districtLabel} y provincia ${provinceLabel}, pero ${districtLabel} corresponde a ${expectedRegionLabel}.`,
      `¿Lo registramos como ${expectedProvinceLabel}, ${expectedRegionLabel}?`,
    ].join("\n"),
  };
}

function titleCasePlace(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (part === "la") return "La";
      if (part === "de") return "de";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function unwrapInput(payload) {
  if (payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input;
  }
  return payload || {};
}

function stripAccents(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

globalThis.__aurelaCheckCoverage = {
  detectCourier,
  detectLocationInconsistency,
  handleRequest,
  handler,
  hasCashOnDelivery,
  normalizePlace,
};
