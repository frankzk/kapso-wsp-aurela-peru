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

// Los 43 distritos de Lima Metropolitana tienen contraentrega. El cliente
// suele dar solo el distrito (ej. "San Juan de Lurigancho", "Breña") sin la
// provincia/region, asi que reconocemos el distrito por nombre para no caer al
// fallback de agencia. Nombres normalizados (sin acentos, minusculas).
const LIMA_METRO_DISTRICTS = new Set([
  // Lima Centro
  "barranco", "brena", "cercado de lima", "jesus maria", "la victoria", "lima",
  "lince", "magdalena del mar", "miraflores", "pueblo libre", "rimac",
  "san borja", "san isidro", "san luis", "san miguel", "santiago de surco", "surco", "surquillo",
  // Lima Norte
  "ancon", "carabayllo", "comas", "independencia", "los olivos", "puente piedra",
  "san martin de porres", "smp", "santa rosa",
  // Lima Este
  "ate", "ate vitarte", "vitarte", "chaclacayo", "cieneguilla", "el agustino",
  "lurigancho-chosica", "lurigancho", "chosica", "san juan de lurigancho", "sjl", "santa anita",
  // Lima Sur
  "chorrillos", "lurin", "pachacamac", "pucusana", "punta hermosa", "punta negra",
  "san bartolo", "san juan de miraflores", "sjm", "santa maria del mar",
  "villa el salvador", "ves", "villa maria del triunfo", "vmt",
]);

// Nombres de distrito de >=2 palabras (y referencias frecuentes) que el cliente
// suele escribir DENTRO de una frase mas larga, p.ej. "av pezet 131 san isidro"
// o "lima/lima/santiago de surco". Se buscan por contencion de substring; todos
// son lo bastante especificos como para no producir falsos positivos.
const LIMA_METRO_PHRASES = [
  "san juan de lurigancho", "san juan de miraflores", "san martin de porres",
  "villa maria del triunfo", "villa el salvador", "santiago de surco",
  "lurigancho chosica", "magdalena del mar", "santa maria del mar",
  "pueblo libre", "cercado de lima", "centro de lima", "san isidro", "san borja",
  "san luis", "san miguel", "la molina", "la victoria", "los olivos",
  "el agustino", "jesus maria", "santa anita", "santa rosa", "puente piedra",
  "punta hermosa", "punta negra", "san bartolo", "canto grande", "pte piedra",
  "villa maria",
];

// Tokens de una sola palabra que identifican un distrito de Lima Metropolitana,
// incluyendo abreviaturas y anexos/urbanizaciones conocidas (campoy/zarate=SJL,
// huaycan/salamanca/ceres/santa clara/vitarte/huachipa=Ate, collique=Comas,
// chacarilla/higuereta/monterrico=Surco, maranga=San Miguel). Se evaluan como
// palabra completa, nunca como substring, para no matchear dentro de otra palabra.
const LIMA_METRO_TOKENS = new Set([
  "barranco", "brena", "chorrillos", "surquillo", "lince", "miraflores", "surco",
  "rimac", "ancon", "carabayllo", "comas", "independencia", "ate", "chaclacayo",
  "cieneguilla", "lurin", "pachacamac", "pucusana", "chosica", "lurigancho",
  "vitarte", "huaycan", "campoy", "zarate", "huascar", "bayovar", "chacarilla",
  "higuereta", "monterrico", "collique", "salamanca", "ceres", "huachipa",
  "manchay", "maranga", "magdalena", "molina", "olivos", "agustino", "cercado",
  "victoria", "porres", "porras",
  "sjl", "smp", "vmt", "ves", "sjm",
]);

// Nombres largos de una palabra usados solo para tolerancia a typos (Levenshtein
// por token). No incluye palabras cortas (<5) para evitar falsos positivos.
// "barranco" se omite a proposito: su unico typo plausible ("barranca") es una
// provincia distinta al norte de Lima, asi que solo se acepta exacto (via tokens).
const LIMA_FUZZY_WORDS = [
  "chorrillos", "surquillo", "miraflores", "carabayllo",
  "independencia", "chaclacayo", "cieneguilla", "pachacamac", "pucusana",
  "lurigancho", "chosica", "vitarte", "magdalena", "molina", "olivos",
  "agustino", "cercado", "santiago", "comas", "rimac", "ancon", "brena",
];

// Callao es provincia aparte de Lima, pero tiene contraentrega a todo el Callao.
// Si el cliente da solo el distrito del Callao (sin provincia) lo reconocemos aca.
const CALLAO_TOKENS = new Set(["callao", "ventanilla", "bellavista", "pachacutec", "oquendo"]);
const CALLAO_PHRASES = ["la perla", "la punta", "carmen de la legua", "carmen de la lengua", "mi peru"];
const CALLAO_FUZZY_WORDS = ["callao", "ventanilla", "bellavista"];

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
    const isLimaMetro = region === "lima" || province === "lima" || region === "callao"
      || province === "callao" || isLimaMetroDistrict(district) || isCallaoDistrict(district);
    return json({
      cashOnDelivery: true,
      shippingMode: "contraentrega",
      requiresDni: false,
      requiresAdvance: false,
      advanceAmount: 0,
      couriers: [],
      normalized: { district, province, region },
      sameDayUrgent: isLimaMetro ? sameDayUrgentInfo() : null,
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

// Ventana de entrega urgente HOY (solo Lima Metropolitana, contraentrega).
// Peru = UTC-5. Corte exacto en horas enteras: 10:00 y 12:00.
function sameDayUrgentInfo() {
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  if (limaHour < 10) {
    return { limaHour, window: "antes_10", canDeliverToday: true, deliveryWindowText: "hoy", alertTeam: false };
  }
  if (limaHour < 12) {
    return { limaHour, window: "ventana_10_12", canDeliverToday: true, deliveryWindowText: "hoy entre las 3pm y 8pm", alertTeam: true };
  }
  return { limaHour, window: "cerrado", canDeliverToday: false, deliveryWindowText: null, alertTeam: false };
}

function hasCashOnDelivery({ region, province, district }) {
  const candidates = [region, province].filter(Boolean);

  if (candidates.some((item) => item === "callao")) return true;
  if (candidates.some((item) => item === "lima")) return true;

  // El cliente dio solo el distrito (sin provincia/region): si es un distrito de
  // Lima Metropolitana o del Callao, igual tiene contraentrega.
  if (district && isLimaMetroDistrict(district)) return true;
  if (district && isCallaoDistrict(district)) return true;

  for (const place of candidates) {
    const coveredDistricts = CASH_ON_DELIVERY[place];
    if (!coveredDistricts) continue;
    if (coveredDistricts.includes("*")) return true;
    if (district && coveredDistricts.includes(district)) return true;
  }

  return false;
}

// Reconoce un distrito de Lima Metropolitana tolerando errores de tipeo del
// cliente (ej. "San juam de lurigancho" -> "san juan de lurigancho"). Usa
// distancia de edicion solo en nombres largos para evitar falsos positivos en
// abreviaturas cortas ("sjl", "ate", "ves", "vmt", "sjm").
function isLimaMetroDistrict(district) {
  if (!district) return false;
  const text = cleanDistrictText(district);
  if (!text) return false;

  // 1) match exacto del string completo o de una abreviatura conocida.
  if (LIMA_METRO_DISTRICTS.has(text) || LIMA_METRO_TOKENS.has(text)) return true;

  // 2) frase multi-palabra contenida en el texto (cliente pega direccion +
  //    distrito, "lima/lima/X", referencias, etc.).
  for (const phrase of LIMA_METRO_PHRASES) {
    if (text.includes(phrase)) return true;
  }

  // 3) por token: palabra completa exacta, alias/anexo, o typo (Levenshtein).
  const tokens = text.split(" ").filter(Boolean);
  for (const tok of tokens) {
    if (LIMA_METRO_TOKENS.has(tok) || LIMA_METRO_DISTRICTS.has(tok)) return true;
    if (tok.length >= 5) {
      for (const word of LIMA_FUZZY_WORDS) {
        const maxDist = word.length >= 10 ? 2 : 1;
        if (Math.abs(word.length - tok.length) > maxDist) continue;
        if (levenshtein(tok, word) <= maxDist) return true;
      }
    }
  }

  // 4) fuzzy del string completo contra nombres largos de >=2 palabras (typos en
  //    "santiago de surc", "villa maria del trinfo"). Se limita a nombres de >=10
  //    letras: los cortos ya los cubre el match por token y abrirlos a fuzzy
  //    genera falsos positivos (p.ej. "barranca", provincia distinta, vs barranco).
  for (const known of LIMA_METRO_DISTRICTS) {
    if (known.length < 10) continue;
    const maxDist = known.length >= 12 ? 3 : 2;
    if (Math.abs(known.length - text.length) > maxDist) continue;
    if (levenshtein(text, known) <= maxDist) return true;
  }

  return false;
}

// Reconoce un distrito del Callao (provincia aparte de Lima) cuando el cliente
// da solo el distrito sin la provincia. Todo el Callao tiene contraentrega.
function isCallaoDistrict(district) {
  if (!district) return false;
  const text = cleanDistrictText(district);
  if (!text) return false;
  if (CALLAO_TOKENS.has(text)) return true;
  for (const phrase of CALLAO_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  for (const tok of text.split(" ").filter(Boolean)) {
    if (CALLAO_TOKENS.has(tok)) return true;
    if (tok.length >= 5) {
      for (const word of CALLAO_FUZZY_WORDS) {
        const maxDist = word.length >= 10 ? 2 : 1;
        if (Math.abs(word.length - tok.length) > maxDist) continue;
        if (levenshtein(tok, word) <= maxDist) return true;
      }
    }
  }
  return false;
}

// Limpia el texto del distrito que escribe el cliente antes de compararlo:
// elimina separadores tipo "Lima/Lima/X", viñetas y prefijos basura, numeros
// sueltos, y colapsa abreviaturas deletreadas ("s j l" / "s.j.l" -> "sjl").
// Asume entrada ya normalizada (minusculas, sin acentos) por normalizePlace.
function cleanDistrictText(value) {
  let text = stripAccents(String(value || "").toLowerCase());
  text = text.replace(/[^a-z0-9 ]+/g, " ");
  text = text.replace(/\b\d+\b/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  // Colapsar abreviaturas deletreadas DESPUES de unificar espacios, para que
  // "s. j. l." (que deja doble espacio al quitar los puntos) tambien funcione.
  text = text.replace(/\b([a-z]) ([a-z]) ([a-z])\b/g, "$1$2$3");
  text = text.replace(/\b([a-z]) ([a-z])\b/g, "$1$2");
  return text.replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
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
  cleanDistrictText,
  detectCourier,
  detectLocationInconsistency,
  handleRequest,
  handler,
  hasCashOnDelivery,
  isCallaoDistrict,
  isLimaMetroDistrict,
  levenshtein,
  normalizePlace,
};
