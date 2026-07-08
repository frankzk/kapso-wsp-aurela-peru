async function handler(request, env) {
  const startedAt = new Date().toISOString();
  const input = await readInput(request);
  const maxPages = clampNumber(input.max_pages || input.maxPages || 20, 1, 30);
  const maxFindings = clampNumber(input.max_findings || input.maxFindings || 200, 20, 500);
  const catalog = await loadCatalog(maxPages);
  const findings = [];

  for (const product of catalog) {
    const normalized = productToSearchText(product);
    const tokenSet = new Set(normalized.split(/\s+/).filter(Boolean));
    const url = `https://aurela.pe/products/${product.handle}`;
    const base = {
      title: product.title || product.handle,
      handle: product.handle,
      url,
      product_type: product.product_type || product.type || "",
      price: minPrice(product),
      available: isAvailable(product),
    };

    findings.push(...scanSubstringHazards(base, normalized, tokenSet));
    findings.push(...scanCategoryConflicts(base, normalized, tokenSet));
    findings.push(...scanGenericRuleLeaks(base, normalized, tokenSet));
  }

  const deduped = dedupeFindings(findings)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.category.localeCompare(b.category))
    .slice(0, maxFindings);

  const summary = summarize(deduped, catalog.length, startedAt);
  return json({
    ok: true,
    scanned_at: startedAt,
    catalog_size: catalog.length,
    findings_count: deduped.length,
    summary,
    findings: deduped,
    notes: [
      "scanner read-only sobre https://aurela.pe/products.json",
      "high = puede cambiar categoría o alternativas del lookup",
      "medium = categoría demasiado genérica o subtipo ambiguo",
      "low = revisar copy/tags si aparece mucho en búsquedas",
    ],
  });
}

const CATEGORY_TERMS = {
  carteras: ["cartera", "carteras", "bolso", "bolsos", "bolsa", "bolsas", "morral", "morrales", "bandolera", "bandoleras"],
  cuchillos: ["cuchillo", "cuchillos", "afilador", "afiladores", "cubiertos"],
  organizadores: ["organizador", "organizadores", "ordenador", "ordenadores", "rack", "maleta", "tapa", "tapas", "cubiertos", "estante"],
  sandalias: ["sandalia", "sandalias", "chancla", "chanclas", "pantufla", "pantuflas", "slide", "slides"],
  cocina: ["cocina", "olla", "ollas", "sarten", "sartenes", "pinza", "utensilio", "utensilios", "calor"],
  bano: ["bano", "ducha", "organizador", "estante", "drenaje", "esquinero"],
  auto: ["auto", "carro", "vehiculo", "car"],
  medias: ["media", "medias", "calcetin", "calcetines", "calceta", "calcetas", "soquete", "soquetes"],
};

const CONFLICTS = {
  carteras: ["organizador", "organizadores", "gancho", "ganchos", "armario", "closet", "percha", "perchas", "trapeador", "trapeadores", "escoba", "escobas", "parasol", "auto", "carro", "vehiculo", "soporte", "slimvisor", "handyhold", "strapsafe", "tapa", "tapas", "rack", "estante"],
  cuchillos: ["afilador", "afiladores", "organizador", "organizadores", "cubiertos", "porta", "soporte"],
  cocina: ["cabello", "pelo", "ceja", "cejas", "maquillaje", "auto", "carro", "parasol"],
  sandalias: ["soporte", "organizador", "auto", "parasol", "rack"],
  auto: ["cartera", "carteras", "bolso", "bolsos", "bolsa", "bolsas", "cargador", "carga"],
};

const SHORT_TERMS = [
  { category: "auto", term: "car", dangerousInside: ["cartera", "carteras", "cargador", "cargo", "carbon", "carrito"] },
  { category: "auto", term: "auto", dangerousInside: ["automatico", "automatica", "autoadhesivo", "autoadhesiva"] },
  { category: "medias", term: "media", dangerousInside: ["intermedia", "mediano", "mediana"] },
  { category: "organizadores", term: "tapa", dangerousInside: ["etapa"] },
];

const BATHROOM_CORE = ["bano", "ducha", "drenaje", "esquinero", "shampoo", "jabon", "cepillo", "inodoro"];
const ORGANIZER_CONTEXTS = {
  carteras: ["cartera", "carteras", "bolso", "bolsos", "bolsa", "bolsas"],
  auto: ["auto", "carro", "vehiculo", "parasol"],
  bano: BATHROOM_CORE,
  cocina: ["cocina", "olla", "ollas", "sarten", "sartenes", "cubiertos", "tapa", "tapas"],
  limpieza: ["trapeador", "trapeadores", "escoba", "escobas"],
  ropa: ["armario", "closet", "percha", "perchas"],
};

async function readInput(request) {
  if (request.method === "GET") {
    return Object.fromEntries(new URL(request.url).searchParams.entries());
  }
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function loadCatalog(maxPages) {
  const products = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetch(`https://aurela.pe/products.json?limit=250&page=${page}`, {
      headers: { Accept: "application/json", "User-Agent": "Aurela-FP-Scanner/1.0" },
    });
    if (!response.ok) throw new Error(`catalog_fetch_failed page=${page} status=${response.status}`);
    const payload = await response.json();
    const pageProducts = Array.isArray(payload.products) ? payload.products : [];
    if (pageProducts.length === 0) break;
    for (const product of pageProducts) {
      const key = String(product.id || product.handle || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      products.push(product);
    }
    if (pageProducts.length < 250) break;
  }
  return products;
}

function scanSubstringHazards(base, normalized) {
  const findings = [];
  for (const rule of SHORT_TERMS) {
    if (!normalized.includes(rule.term) || hasWholeWord(normalized, rule.term)) continue;
    const inside = rule.dangerousInside.filter((word) => normalized.includes(word));
    if (inside.length === 0) continue;
    findings.push({
      ...base,
      severity: "high",
      type: "substring_only_match",
      category: rule.category,
      matched_terms: [rule.term],
      conflicting_terms: inside,
      reason: `el término corto '${rule.term}' matchea dentro de otra palabra: ${inside.join(", ")}`,
      recommendation: "usar matching por token/word-boundary para términos cortos, no String.includes",
    });
  }
  return findings;
}

function scanCategoryConflicts(base, normalized) {
  const findings = [];
  for (const [category, terms] of Object.entries(CATEGORY_TERMS)) {
    const matchedTerms = terms.filter((term) => hasWholeWord(normalized, term));
    if (matchedTerms.length === 0) continue;

    const conflicts = (CONFLICTS[category] || []).filter((term) => hasWholeWord(normalized, term));
    if (conflicts.length === 0) continue;

    const severity = category === "carteras" || category === "auto" ? "high" : "medium";
    findings.push({
      ...base,
      severity,
      type: "category_conflict",
      category,
      matched_terms: matchedTerms,
      conflicting_terms: conflicts,
      reason: `parece ${category}, pero contiene términos de otra intención: ${conflicts.join(", ")}`,
      recommendation: category === "carteras"
        ? "excluir organizadores/ganchos/auto/limpieza cuando el cliente pida carteras o bolsos"
        : "agregar filtros negativos o pedir subtipo antes de ofrecer alternativas",
    });
  }
  return findings;
}

function scanGenericRuleLeaks(base, normalized) {
  const findings = [];
  const hasOrganizer = hasWholeWord(normalized, "organizador") || hasWholeWord(normalized, "organizadores") || hasWholeWord(normalized, "estante");
  const hasBathroomCore = BATHROOM_CORE.some((term) => hasWholeWord(normalized, term));
  if (hasOrganizer && !hasBathroomCore) {
    findings.push({
      ...base,
      severity: "medium",
      type: "generic_bathroom_leak",
      category: "bano",
      matched_terms: ["organizador/estante"],
      conflicting_terms: contextMatches(normalized),
      reason: "la regla actual de baño incluye organizador/estante y puede etiquetar productos no-baño como baño",
      recommendation: "para baño, requerir baño/ducha/drenaje/esquinero o contexto explícito; no usar organizador solo",
    });
  }

  if (hasOrganizer) {
    const contexts = contextMatches(normalized);
    if (contexts.length > 0) {
      findings.push({
        ...base,
        severity: "low",
        type: "generic_organizer_subtype",
        category: "organizadores",
        matched_terms: ["organizador"],
        conflicting_terms: contexts,
        reason: `organizador con subtipo específico: ${contexts.join(", ")}`,
        recommendation: "si el cliente solo dice 'organizadores', preguntar subtipo o listar por subcategoría; no mezclar todos como alternativas",
      });
    }
  }
  return findings;
}

function contextMatches(normalized) {
  const contexts = [];
  for (const [context, terms] of Object.entries(ORGANIZER_CONTEXTS)) {
    if (terms.some((term) => hasWholeWord(normalized, term))) contexts.push(context);
  }
  return contexts;
}

function productToSearchText(product) {
  return normalize([
    product.title,
    product.handle ? product.handle.replace(/-/g, " ") : "",
    product.product_type,
    product.type,
    product.vendor,
    Array.isArray(product.tags) ? product.tags.join(" ") : product.tags,
    Array.isArray(product.options) ? product.options.map((option) => option.name || option).join(" ") : "",
    Array.isArray(product.variants) ? product.variants.map((variant) => [variant.title, variant.option1, variant.option2, variant.option3].filter(Boolean).join(" ")).join(" ") : "",
  ].filter(Boolean).join(" "));
}

function hasWholeWord(normalized, term) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  if (normalizedTerm.includes(" ")) return normalized.includes(normalizedTerm);
  return new RegExp(`(^|\\s)${escapeRegExp(normalizedTerm)}($|\\s)`).test(normalized);
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAvailable(product) {
  return (product.variants || []).some((variant) => Boolean(variant.available));
}

function minPrice(product) {
  const prices = (product.variants || [])
    .map((variant) => Number(variant.price))
    .filter((price) => Number.isFinite(price));
  return prices.length ? Math.min(...prices) : null;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const output = [];
  for (const finding of findings) {
    const key = [finding.handle, finding.type, finding.category, finding.matched_terms.join("|"), finding.conflicting_terms.join("|")].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(finding);
  }
  return output;
}

function summarize(findings, catalogSize, scannedAt) {
  const bySeverity = {};
  const byType = {};
  const byCategory = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byType[finding.type] = (byType[finding.type] || 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
  }
  return { catalogSize, scannedAt, bySeverity, byType, byCategory };
}

function severityRank(severity) {
  return { low: 1, medium: 2, high: 3 }[severity] || 0;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return max;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
