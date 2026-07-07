const DEFAULT_SHOP_DOMAIN = "aurela-peru.myshopify.com";
const DEFAULT_PUBLIC_SHOP_DOMAIN = "aurela.pe";
const DEFAULT_API_VERSION = "2026-04";
const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CATALOG_PAGES = 20;
const DEFAULT_PHONE_NUMBER_ID = "1241790819006805";
const CTWA_MAX_PAGES = 3;

const PRODUCT_STOPWORDS = new Set([
  "aurela",
  "alguna",
  "algunas",
  "alguno",
  "algunos",
  "consulta",
  "consultar",
  "color",
  "colores",
  "cuanto",
  "cuesta",
  "deseo",
  "disponible",
  "disponibles",
  "este",
  "hay",
  "hola",
  "info",
  "informacion",
  "las",
  "link",
  "los",
  "modelo",
  "modelos",
  "opcion",
  "opciones",
  "queda",
  "quedan",
  "que",
  "precio",
  "producto",
  "products",
  "quiero",
  "sale",
  "saber",
  "stock",
  "talla",
  "tallas",
  "tengo",
  "tienes",
  "una",
  "unas",
  "unos",
  "vende",
  "venden",
  "vendes",
  "ver",
  "azul",
  "beige",
  "blanca",
  "blanco",
  "celeste",
  "gris",
  "morada",
  "morado",
  "naranja",
  "negra",
  "negro",
  "rosada",
  "rosado",
  "verde",
]);

const CATEGORY_RULES = [
  {
    key: "cuchillos",
    label: "cuchillos",
    triggers: [
      "cuchillo",
      "cuchillos",
      "afilador",
      "afiladores",
    ],
    terms: [
      "cuchillo",
      "cuchillos",
      "afilador",
      "afiladores",
      "cubiertos",
    ],
  },
  {
    key: "organizadores",
    label: "organizadores",
    triggers: [
      "organizador",
      "organizadores",
      "ordenador",
      "ordenadores",
    ],
    terms: [
      "organizador",
      "organizadores",
      "ordenador",
      "ordenadores",
      "rack",
      "maleta",
      "tapa",
      "tapas",
      "cubiertos",
      "estante",
    ],
  },
  {
    key: "sandalias",
    label: "sandalias",
    triggers: [
      "sandalia",
      "sandalias",
      "chancla",
      "chanclas",
      "pantufla",
      "pantuflas",
      "slide",
      "slides",
      "zapatilla casa",
      "zapatillas casa",
    ],
    terms: [
      "sandalia",
      "sandalias",
      "chancla",
      "chanclas",
      "pantufla",
      "pantuflas",
      "zapatilla casa",
      "zapatillas casa",
    ],
  },
  {
    key: "cocina",
    label: "cocina",
    triggers: ["cocina", "olla", "ollas", "sarten", "sartenes", "pinza", "utensilio", "utensilios"],
    terms: ["cocina", "olla", "ollas", "sarten", "sartenes", "pinza", "utensilio", "utensilios", "calor"],
  },
  {
    key: "bano",
    label: "bano",
    triggers: ["bano", "baño", "ducha", "organizador", "estante", "drenaje"],
    terms: ["bano", "baño", "ducha", "organizador", "estante", "drenaje", "esquinero"],
  },
  {
    key: "camping",
    label: "camping",
    triggers: ["camping", "campamento", "portatil", "plegable"],
    terms: ["camping", "campamento", "portatil", "plegable", "kamisori"],
  },
  {
    key: "auto",
    label: "auto",
    triggers: ["auto", "carro", "vehiculo", "vehiculo", "car"],
    terms: ["auto", "carro", "vehiculo", "vehiculo", "car"],
  },
  {
    key: "medias",
    label: "medias",
    triggers: ["media", "medias", "calcetin", "calcetines", "calceta", "calcetas", "soquete", "soquetes"],
    terms: ["media", "medias", "calcetin", "calcetines", "calceta", "soquete"],
  },
];

// Synonyms so customer terms match catalog wording (e.g. "medias" == "calcetines" in Peru).
const SYNONYM_GROUPS = [
  ["medias", "media", "calcetines", "calcetin", "calceta", "calcetas", "soquetes", "soquete"],
];

const SYNONYM_MAP = buildSynonymMap(SYNONYM_GROUPS);

function buildSynonymMap(groups) {
  const map = new Map();
  for (const group of groups) {
    const normalized = [...new Set(group.map((word) => normalizeSearchText(word)).filter(Boolean))];
    for (const word of normalized) {
      const set = map.get(word) || new Set();
      normalized.forEach((other) => set.add(other));
      map.set(word, set);
    }
  }
  return map;
}

function tokenVariants(token) {
  const set = SYNONYM_MAP.get(token);
  return set ? [...set] : [token];
}

function searchableHasToken(searchable, token) {
  return tokenVariants(token).some((variant) => variant && searchable.includes(variant));
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
    const input = await readJson(request);
    if (input.adSeed || input.adDebug) return adAdmin(input, env);
    const config = getConfig(env);
    const queryText = collectInputText(input);
    const handles = extractHandleCandidates(queryText);

    if (handles.length === 0 && !queryText) {
      return json({
        found: false,
        reason: "missing_product",
        message: "Sobre que producto deseas informacion? Pasame el link o una captura y lo reviso al toque.",
      });
    }

    let product = null;
    let catalogSearch = null;

    for (const handle of handles) {
      product = await getPublicProductByHandle(config, handle);
      if (product) break;
    }

    if (!product) {
      const catalog = await loadPublicCatalog(config);

      for (const handle of handles) {
        product = getCatalogProductByHandle(catalog, handle);
        if (product) break;
      }

      if (!product && queryText) {
        catalogSearch = searchCatalogProducts(catalog, queryText, handles);
        product = catalogSearch.product;
      }
    }

    if (!product && config.token) {
      for (const handle of handles) {
        product = await getProductByHandle(config, handle);
        if (product) break;
      }
    }

    if (!product && queryText && config.token) {
      const products = await searchProducts(config, queryText, handles);
      product = products[0] || null;
    }

    // Rescate por anuncio (Click-to-WhatsApp): si no se identifico producto y el
    // cliente llego de un anuncio (ej. escribio solo "Precio"), usar el titular +
    // cuerpo del anuncio para identificar el producto en vez de pedir link/captura.
    let adRescued = false;
    if (!product) {
      const adText = await resolveAdText(env, input);
      if (adText) {
        const catalog = await loadPublicCatalog(config);
        const adSearch = searchCatalogProducts(catalog, adText, []);
        product = adSearch.product || null;
        if (!product && config.token) {
          const adProducts = await searchProducts(config, adText, []);
          product = adProducts[0] || null;
        }
        if (product) adRescued = true;
      }
    }

    if (!product) {
      if (catalogSearch?.ambiguous) {
        return json({
          found: false,
          reason: "ambiguous",
          input: queryText,
          handlesTried: handles,
          matches: catalogSearch.matches,
          message: buildAmbiguousMessage(catalogSearch.matches),
        });
      }

      if (catalogSearch?.categoryMatches?.length) {
        // Solo listar productos de la categoria que SI tienen stock. Si toda la categoria
        // esta agotada, avisar + ofrecer asesora (no listar agotados).
        const availableMatches = catalogSearch.categoryMatches.filter((match) => match.available);
        if (availableMatches.length === 0) {
          return json({
            found: false,
            reason: "category_out_of_stock",
            category: catalogSearch.category,
            input: queryText,
            matches: [],
            message: buildCategoryOutOfStockMessage(catalogSearch.category),
            customerMessage: buildCategoryOutOfStockMessage(catalogSearch.category),
            nextAction: "offer_advisor",
          });
        }
        return json({
          found: false,
          reason: "category_matches",
          category: catalogSearch.category,
          input: queryText,
          matches: availableMatches,
          message: buildCategoryMatchesMessage(catalogSearch.category, availableMatches),
          customerMessage: buildCategoryMatchesMessage(catalogSearch.category, availableMatches),
          nextAction: "ask_product_choice",
        });
      }

      return json({
        found: false,
        reason: "not_found",
        input: queryText,
        handlesTried: handles,
        message: "Para no darte un dato incorrecto, pasame el link o una captura del producto y lo reviso al toque.",
      });
    }

    const normalizedProduct = normalizeAnyProduct(product, config.publicShopDomain);
    const outOfStock = isProductOutOfStock(normalizedProduct);

    if (outOfStock) {
      // Nunca ofrecer un producto agotado como alternativa: buscar solo alternativas EN STOCK
      // de la misma categoria. Si no hay ninguna, avisar + ofrecer asesora (sin empujar otra categoria).
      const catalog = await loadPublicCatalog(config);
      const alternatives = findInStockAlternatives(catalog, normalizedProduct);
      return json({
        found: true,
        source: normalizedProduct.__source || "shopify",
        product: normalizedProduct,
        outOfStock: true,
        alternatives,
        customerMessage: buildOutOfStockMessage(normalizedProduct, alternatives),
        nextAction: alternatives.length > 0 ? "offer_alternative" : "offer_advisor",
      });
    }

    return json({
      found: true,
      source: normalizedProduct.__source || "shopify",
      adRescued,
      product: normalizedProduct,
      outOfStock: false,
      customerMessage: buildProductFoundMessage(normalizedProduct),
      nextAction: "ask_quantity",
    });
  } catch (error) {
    return json({
      found: false,
      reason: "lookup_error",
      message: "No pude validar el producto en Shopify en este momento. Un asesor puede revisarlo.",
      error: safeError(error),
    }, 500);
  }
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

function getConfig(env = globalThis) {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN || env.sHOPIFYSHOPDOMAIN || globalThis.SHOPIFY_SHOP_DOMAIN || globalThis.sHOPIFYSHOPDOMAIN || DEFAULT_SHOP_DOMAIN;
  const publicShopDomain = env.SHOPIFY_PUBLIC_SHOP_DOMAIN || env.sHOPIFYPUBLICSHOPDOMAIN || globalThis.SHOPIFY_PUBLIC_SHOP_DOMAIN || globalThis.sHOPIFYPUBLICSHOPDOMAIN || DEFAULT_PUBLIC_SHOP_DOMAIN;
  const apiVersion = env.SHOPIFY_API_VERSION || env.sHOPIFYAPIVERSION || globalThis.SHOPIFY_API_VERSION || globalThis.sHOPIFYAPIVERSION || DEFAULT_API_VERSION;
  const token = env.SHOPIFY_ADMIN_ACCESS_TOKEN || env.sHOPIFYADMINACCESSTOKEN || globalThis.SHOPIFY_ADMIN_ACCESS_TOKEN || globalThis.sHOPIFYADMINACCESSTOKEN;

  return { apiVersion, publicShopDomain, shopDomain, token };
}

// --- Rescate por anuncio Click-to-WhatsApp ---------------------------------
// Cuando el cliente llega de un anuncio y escribe solo "precio"/"hola", el
// referral del anuncio (titular + cuerpo) identifica el producto. Se busca
// primero inline en el payload y, si no, se trae por la API de Kapso.

async function resolveAdText(env, input) {
  let referral = extractInlineReferral(input);
  if (!referral) referral = await fetchCtwaReferral(env, input);
  return adReferralText(referral);
}

function extractInlineReferral(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = extractInlineReferral(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    const st = String(node.source_type || node.sourceType || "").toLowerCase();
    const hasCopy = node.headline || node.body;
    const isAd = st === "ad" || st === "post";
    if ((isAd && (hasCopy || node.source_id)) || (hasCopy && (node.ctwa_clid || node.source_id || node.source_url))) {
      return { source_type: st || "ad", headline: node.headline || node.title || "", body: node.body || node.description || "" };
    }
    for (const value of Object.values(node)) {
      const r = extractInlineReferral(value, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function extractReferral(message) {
  const referral = message?.referral || message?.message?.referral || message?.kapso?.referral;
  if (referral && (referral.source_id || referral.source_type || referral.ctwa_clid)) return referral;
  return null;
}

function adReferralText(referral) {
  if (!referral) return "";
  const parts = [referral.headline, referral.body].filter((s) => typeof s === "string" && s.trim());
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
}

async function getKapsoConfig(env = globalThis) {
  let apiKey = env.KAPSO_API_KEY || env.kAPSOAPIKEY || globalThis.KAPSO_API_KEY || globalThis.kAPSOAPIKEY;
  if (!apiKey && env?.KV?.get) {
    try { apiKey = await env.KV.get("KAPSO_API_KEY"); } catch { /* sin KV */ }
  }
  const apiBase = env.KAPSO_API_BASE || env.kAPSOAPIBASE || globalThis.KAPSO_API_BASE || "https://api.kapso.ai";
  return { apiKey, apiBase };
}

async function fetchCtwaReferral(env, input) {
  try {
    const { apiKey, apiBase } = await getKapsoConfig(env);
    const root = isPlainObject(input.input) ? { ...input, ...input.input } : input;
    const conversationId = root.conversationId || root.conversation_id;
    const phoneNumberId = root.phoneNumberId || root.phone_number_id || root.whatsappPhoneNumberId || root.whatsapp_phone_number_id || DEFAULT_PHONE_NUMBER_ID;
    if (!apiKey || !conversationId) return null;

    const base = (cursor) => `${apiBase}/meta/whatsapp/${encodeURIComponent(phoneNumberId)}/messages`
      + `?conversation_id=${encodeURIComponent(conversationId)}&direction=inbound&limit=100`
      + (cursor ? `&after=${encodeURIComponent(cursor)}` : "");
    let url = base(null);
    for (let page = 0; page < CTWA_MAX_PAGES && url; page += 1) {
      const response = await fetch(url, { headers: { "X-API-Key": apiKey, "Content-Type": "application/json" } });
      if (!response.ok) return null;
      const payload = await response.json();
      for (const message of payload?.data || []) {
        const referral = extractReferral(message);
        if (referral) return referral;
      }
      const nextCursor = payload?.paging?.cursors?.after || payload?.paging?.next;
      if (!nextCursor) break;
      url = base(nextCursor);
    }
    return null;
  } catch {
    return null;
  }
}

// Admin privado (invoke con X-API-Key): adSeed guarda la KAPSO_API_KEY en KV;
// adDebug resuelve el texto del anuncio de una conversacion para pruebas.
async function adAdmin(input, env) {
  if (input.adSeed && typeof input.adSeed === "object") {
    if (!env?.KV) return json({ ok: false, reason: "no_kv" });
    const saved = [];
    const key = input.adSeed.KAPSO_API_KEY;
    if (typeof key === "string" && key.trim()) {
      await env.KV.put("KAPSO_API_KEY", key.trim());
      saved.push("KAPSO_API_KEY");
    }
    return json({ ok: true, seeded: saved });
  }
  const cfg = await getKapsoConfig(env);
  const adText = await resolveAdText(env, input);
  return json({ ok: true, kapsoApiKey: Boolean(cfg.apiKey), kv: Boolean(env?.KV), adText: adText || null });
}

function collectInputText(input) {
  const root = isPlainObject(input.input) ? input.input : input;
  const preferredSources = [root, input].filter(Boolean);
  const preferredKeys = [
    "url",
    "link",
    "productUrl",
    "product_url",
    "handle",
    "productHandle",
    "product_handle",
    "product",
    "productName",
    "product_name",
    "title",
    "message",
    "customerMessage",
    "customer_message",
    "text",
    "body",
    "content",
  ];

  const direct = [];
  for (const source of preferredSources) {
    for (const key of preferredKeys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) direct.push(value.trim());
    }
  }

  if (direct.length > 0) return uniquePreserveCase(direct).join(" ");
  return collectStrings(input).join(" ").trim();
}

function collectStrings(value, output = []) {
  if (typeof value === "string" && value.trim()) {
    output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
  return output;
}

function extractHandleCandidates(value) {
  if (!value) return [];

  const text = String(value).trim();
  const directHandle = text.match(/^[^\s/]{3,}$/);
  if (directHandle) {
    const decoded = safeDecode(directHandle[0]);
    return uniqueCandidates([directHandle[0], decoded, encodeURIComponent(decoded), slugifyHandle(decoded)]);
  }

  const urls = text.match(/https?:\/\/[^\s]+/gi) || [];
  const candidates = [];

  for (const rawUrl of urls) {
    try {
      const cleanedUrl = rawUrl.replace(/[)\].,!?]+$/g, "");
      const url = new URL(cleanedUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      const productIndex = parts.indexOf("products");
      if (productIndex === -1 || !parts[productIndex + 1]) continue;

      const rawHandle = parts[productIndex + 1].replace(/\.js$/i, "");
      const decodedHandle = safeDecode(rawHandle);
      candidates.push(rawHandle, decodedHandle, encodeURIComponent(decodedHandle), slugifyHandle(decodedHandle));
    } catch {
      // Ignore malformed URLs and let catalog/name search handle the original text.
    }
  }

  return uniqueCandidates(candidates);
}

async function getPublicProductByHandle(config, handle) {
  const keys = handleKeys(handle);

  for (const key of keys) {
    try {
      const response = await fetch(`https://${config.publicShopDomain}/products/${key}.js`, {
        headers: publicHeaders(),
      });
      if (!response.ok) continue;

      const product = await response.json();
      if (!product?.id || !product?.handle || !Array.isArray(product.variants)) continue;
      return publicProductToNormalized(product, config.publicShopDomain, { priceInCents: true, source: "public_product" });
    } catch {
      // Try the next handle candidate, then catalog lookup.
    }
  }

  return null;
}

async function loadPublicCatalog(config) {
  const now = Date.now();
  const cached = globalThis.__AURELA_PUBLIC_CATALOG_CACHE;

  if (cached?.expiresAt > now && Array.isArray(cached.products)) {
    return cached.products;
  }

  const products = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
    try {
      const response = await fetch(`https://${config.publicShopDomain}/products.json?limit=250&page=${page}`, {
        headers: publicHeaders(),
      });
      if (!response.ok) break;

      const payload = await response.json();
      const pageProducts = Array.isArray(payload.products) ? payload.products : [];
      if (pageProducts.length === 0) break;

      for (const product of pageProducts) {
        const key = String(product.id || product.handle || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        products.push(publicProductToNormalized(product, config.publicShopDomain, { priceInCents: false, source: "catalog" }));
      }

      if (pageProducts.length < 250) break;
    } catch {
      break;
    }
  }

  globalThis.__AURELA_PUBLIC_CATALOG_CACHE = {
    expiresAt: now + CATALOG_CACHE_TTL_MS,
    products,
  };

  return products;
}

function publicHeaders() {
  return {
    "Accept": "application/json",
    "User-Agent": "Aurela-Kapso-Lookup/1.0",
  };
}

function getCatalogProductByHandle(catalog, handle) {
  if (!handle || !Array.isArray(catalog) || catalog.length === 0) return null;
  const keys = handleKeys(handle);
  return catalog.find((product) => handleKeys(product.handle).some((key) => keys.includes(key))) || null;
}

function searchCatalogProducts(catalog, text, handles = []) {
  if (!text || !Array.isArray(catalog) || catalog.length === 0) {
    return { product: null, ambiguous: false, matches: [] };
  }

  for (const handle of handles) {
    const product = getCatalogProductByHandle(catalog, handle);
    if (product) return { product, ambiguous: false, matches: [] };
  }

  const query = cleanProductQuery(text, handles);
  if (!query.normalized || query.tokens.length === 0) {
    return { product: null, ambiguous: false, matches: [] };
  }
  const category = detectCategoryQuery(text, query);

  const scored = catalog
    .map((product) => ({ product, score: scoreCatalogProduct(product, query) }))
    .filter((item) => item.score >= 12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    if (category) {
      const categoryMatches = searchCategoryProducts(catalog, category);
      if (categoryMatches.length > 0) {
        return { product: null, ambiguous: false, matches: [], category, categoryMatches };
      }
    }

    return { product: null, ambiguous: false, matches: [] };
  }

  const best = scored[0];
  const second = scored[1];
  if (category && isPureCategoryQuery(query, category)) {
    const categoryMatches = searchCategoryProducts(catalog, category);
    if (categoryMatches.length > 0) {
      return { product: null, ambiguous: false, matches: [], category, categoryMatches };
    }
  }

  const singleStrongMatch = query.tokens.length === 1 && best.score >= 12 && (!second || best.score >= second.score + 5);
  const distinctiveMatch = hasDistinctiveProductToken(best.product, query)
    && best.score >= 20
    && (!second || best.score >= second.score + 5);
  const highConfidence = (best.score >= 30 && (!second || best.score >= second.score + 8)) || singleStrongMatch || distinctiveMatch;
  if (highConfidence) return { product: best.product, ambiguous: false, matches: scored.map(catalogMatchSummary) };

  if (category) {
    const categoryMatches = searchCategoryProducts(catalog, category);
    if (categoryMatches.length > 0) {
      return { product: null, ambiguous: false, matches: [], category, categoryMatches };
    }
  }

  return { product: null, ambiguous: true, matches: scored.map(catalogMatchSummary) };
}

function cleanProductQuery(text, handles) {
  const handleText = handles.map((handle) => handle.replace(/-/g, " ")).join(" ");
  const cleaned = [handleText, text]
    .filter(Boolean)
    .join(" ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[|]/g, " ");
  const normalized = normalizeSearchText(cleaned);
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !PRODUCT_STOPWORDS.has(token))
    .slice(0, 12);

  return { normalized: tokens.join(" "), tokens };
}

function scoreCatalogProduct(product, query) {
  const searchable = product.searchText || normalizeSearchText([
    product.title,
    product.handle?.replace(/-/g, " "),
    product.productType,
    product.vendor,
  ].filter(Boolean).join(" "));

  const handle = normalizeSearchText(product.handle || "");
  const title = normalizeSearchText(product.title || "");

  let score = 0;
  if (query.normalized && searchable.includes(query.normalized)) score += 40;
  if (query.normalized && title.includes(query.normalized)) score += 20;

  for (const token of query.tokens) {
    const variants = tokenVariants(token);
    if (variants.some((variant) => handle === variant)) score += 28;
    else if (variants.some((variant) => handle.includes(variant))) score += 12;
    if (variants.some((variant) => title === variant || title.startsWith(`${variant} `))) score += 24;
    else if (variants.some((variant) => title.includes(variant))) score += 14;
    else if (variants.some((variant) => searchable.includes(variant))) score += 3;
  }

  const matchedTokens = query.tokens.filter((token) => searchableHasToken(searchable, token)).length;
  if (matchedTokens === query.tokens.length && query.tokens.length >= 2) score += 12;
  if (matchedTokens < Math.min(2, query.tokens.length)) score = 0;

  return score;
}

function hasDistinctiveProductToken(product, query) {
  if (!product || !query?.tokens?.length) return false;

  const titleTokens = normalizeSearchText(product.title || "")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !PRODUCT_STOPWORDS.has(token));
  const handleTokens = normalizeSearchText((product.handle || "").replace(/-/g, " "))
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !PRODUCT_STOPWORDS.has(token));
  const identityTokens = new Set([...titleTokens, ...handleTokens]);

  return query.tokens.some((token) => identityTokens.has(token));
}

function detectCategoryQuery(text, query) {
  const normalized = normalizeSearchText(text);
  const tokenSet = new Set(query.tokens);

  return CATEGORY_RULES.find((rule) => (
    rule.triggers.some((trigger) => triggerMatchesText(normalized, tokenSet, trigger))
  )) || null;
}

function triggerMatchesText(normalizedText, tokenSet, trigger) {
  const normalizedTrigger = normalizeSearchText(trigger);
  if (!normalizedTrigger) return false;
  if (normalizedTrigger.includes(" ")) return normalizedText.includes(normalizedTrigger);
  return tokenSet.has(normalizedTrigger);
}

function isPureCategoryQuery(query, category) {
  if (!query.tokens.length || query.tokens.length > 2) return false;
  const triggerSet = new Set(category.triggers.map((trigger) => normalizeSearchText(trigger)));
  return query.tokens.every((token) => triggerSet.has(token));
}

function searchCategoryProducts(catalog, category) {
  return catalog
    .map((product) => ({ product, score: scoreCategoryProduct(product, category) }))
    .filter((item) => item.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(catalogMatchSummary);
}

function scoreCategoryProduct(product, category) {
  const title = normalizeSearchText(product.title || "");
  const handle = normalizeSearchText((product.handle || "").replace(/-/g, " "));
  const searchable = product.searchText || normalizeSearchText([
    product.title,
    product.handle?.replace(/-/g, " "),
    product.productType,
    product.vendor,
    (product.tags || []).join(" "),
    (product.categories || []).join(" "),
  ].filter(Boolean).join(" "));

  let score = 0;
  for (const rawTerm of category.terms) {
    const term = normalizeSearchText(rawTerm);
    if (!term) continue;
    if (title.includes(term)) score += 16;
    else if (handle.includes(term)) score += 12;
    else if (searchable.includes(term)) score += 8;
  }

  if ((product.categories || []).includes(category.key)) score += 20;
  if (category.key === "cuchillos") {
    const isAccessory = /\b(afilador|organizador|cubiertos)\b/.test(title);
    if (/\bcuchillo(s)?\b/.test(title) && !isAccessory) score += 35;
    if (/\bcuchillo(s)?\b/.test(title)) score += 12;
    if (/\b(plegable|chef|forjado|kamisori|hokkaido)\b/.test(title)) score += 12;
    if (isAccessory) score -= 28;
  }
  if (category.key === "organizadores") {
    if (/\borganizador(es)?\b/.test(title)) score += 10;
    if (/\bmaleta|tapa|rack|estante|cubiertos\b/.test(title)) score += 4;
  }
  return score;
}

function catalogMatchSummary(item) {
  const product = item.product;
  return {
    handle: product.handle,
    score: item.score,
    title: product.title,
    url: product.url,
    price: product.priceRange?.min ?? null,
    available: !isProductOutOfStock(product),
  };
}

function findInStockAlternatives(catalog, product, limit = 2) {
  const targetCategories = new Set(product.categories || []);
  if (targetCategories.size === 0 || !Array.isArray(catalog)) return [];

  const currentKeys = new Set(handleKeys(product.handle || ""));

  return catalog
    .filter((candidate) => !isProductOutOfStock(candidate))
    .filter((candidate) => !handleKeys(candidate.handle || "").some((key) => currentKeys.has(key)))
    .map((candidate) => ({
      product: candidate,
      score: (candidate.categories || []).filter((category) => targetCategories.has(category)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(catalogMatchSummary);
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
      description
      productType
      vendor
      tags
      onlineStoreUrl
      featuredImage { url altText }
      collections(first: 5) { nodes { id handle title } }
      options { id name values }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          availableForSale
          inventoryQuantity
          price
          compareAtPrice
          selectedOptions { name value }
          image { url altText }
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

async function searchProducts(config, text, handles = []) {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const handleText = handles.map((handle) => handle.replace(/-/g, " ")).join(" ").trim();
  const searchText = [handleText, cleaned]
    .filter(Boolean)
    .join(" ")
    .replace(/\b(tengo|una|consulta|aurela|producto|products|pe|https?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const searchQueries = buildProductSearchQueries(searchText, handles);
  if (searchQueries.length === 0) return [];

  const query = `#graphql
    query SearchProducts($query: String!) {
      products(first: 5, query: $query) {
        nodes {
          id
          handle
          title
          description
          productType
          vendor
          tags
          onlineStoreUrl
          featuredImage { url altText }
          collections(first: 5) { nodes { id handle title } }
          options { id name values }
          variants(first: 100) {
            nodes {
              id
              title
              sku
              availableForSale
              inventoryQuantity
              price
              compareAtPrice
              selectedOptions { name value }
              image { url altText }
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
      // Try the next, simpler query if Shopify rejects one search syntax.
    }
  }

  return [];
}

function buildProductSearchQueries(text, handles) {
  const queries = handles.map((handle) => `handle:${escapeSearch(handle)}`);
  const words = uniqueCandidates(
    text
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9-]/gi, ""))
      .filter((word) => word.length >= 3)
      .slice(0, 8),
  );

  if (words.length > 0) {
    queries.push(words.map((word) => `title:*${escapeSearch(word)}*`).join(" AND "));
    queries.push(words.slice(0, 4).join(" "));
  }
  if (text) queries.push(escapeSearch(text));
  return uniqueCandidates(queries);
}

async function shopifyGraphql(config, query, variables) {
  if (!config.token) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");

  const response = await fetch(`https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(JSON.stringify(payload.errors || payload));
  return payload.data;
}

function publicProductToNormalized(product, publicShopDomain, options = {}) {
  const priceInCents = Boolean(options.priceInCents);
  const optionDefinitions = normalizePublicOptions(product);
  const featuredImageUrl = normalizeImageUrl(product.featured_image || product.images?.[0]?.src || product.images?.[0] || product.image?.src);
  const variants = (product.variants || []).map((variant) => publicVariantToNormalized(variant, optionDefinitions, featuredImageUrl, priceInCents));
  const prices = variants.map((variant) => variant.price).filter((price) => Number.isFinite(price));

  const searchText = normalizeSearchText([
    product.title,
    product.handle?.replace(/-/g, " "),
    product.type,
    product.product_type,
    product.vendor,
    normalizePublicTags(product.tags).join(" "),
    optionDefinitions.flatMap((option) => option.values).join(" "),
    variants.map((variant) => variant.title).join(" "),
  ].filter(Boolean).join(" "));
  const categories = categorizeSearchText(searchText);

  return {
    __source: options.source || "public",
    id: toShopifyGid("Product", product.id),
    handle: product.handle,
    title: product.title || product.handle,
    description: product.description || "",
    productType: product.type || product.product_type || "",
    vendor: product.vendor || "",
    tags: normalizePublicTags(product.tags),
    url: `https://${publicShopDomain}${product.url || `/products/${product.handle}`}`,
    image: "",
    categories,
    collections: [],
    options: optionDefinitions.map((option) => ({ name: option.name, values: option.values })),
    priceRange: {
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      currencyCode: "PEN",
    },
    variants,
    searchText,
  };
}

function normalizePublicOptions(product) {
  const variants = product.variants || [];
  const rawOptions = Array.isArray(product.options) ? product.options : [];
  return rawOptions.map((option, index) => {
    const optionObject = typeof option === "string" ? { name: option, position: index + 1 } : option || {};
    const position = Number(optionObject.position || index + 1);
    const values = Array.isArray(optionObject.values)
      ? optionObject.values
      : variants.map((variant) => variant[`option${position}`]).filter(Boolean);

    return { name: optionObject.name || `Option ${position}`, position, values: uniquePreserveCase(values) };
  });
}

function publicVariantToNormalized(variant, optionDefinitions, fallbackImageUrl, priceInCents) {
  const selectedOptions = {};
  for (const option of optionDefinitions) {
    const value = variant[`option${option.position}`];
    if (value) selectedOptions[option.name] = value;
  }

  return {
    id: toShopifyGid("ProductVariant", variant.id),
    title: variant.title || "Default Title",
    sku: variant.sku || variant.barcode || "",
    availableForSale: Boolean(variant.available),
    inventoryQuantity: null,
    price: publicMoney(variant.price, priceInCents),
    compareAtPrice: variant.compare_at_price ? publicMoney(variant.compare_at_price, priceInCents) : null,
    selectedOptions,
    image: "",
  };
}

function normalizeProduct(product) {
  const variants = product.variants?.nodes || [];
  const normalizedVariants = variants.map((variant) => ({
    id: variant.id,
    title: variant.title,
    sku: variant.sku || "",
    availableForSale: Boolean(variant.availableForSale),
    inventoryQuantity: typeof variant.inventoryQuantity === "number" ? variant.inventoryQuantity : null,
    price: Number(variant.price),
    compareAtPrice: variant.compareAtPrice ? Number(variant.compareAtPrice) : null,
    selectedOptions: Object.fromEntries((variant.selectedOptions || []).map((option) => [option.name, option.value])),
    image: "",
  }));
  const prices = normalizedVariants.map((variant) => Number(variant.price)).filter((price) => Number.isFinite(price));

  const searchText = normalizeSearchText([
    product.title,
    product.handle?.replace(/-/g, " "),
    product.productType,
    product.vendor,
    (product.tags || []).join(" "),
    (product.collections?.nodes || []).map((collection) => collection.title).join(" "),
    normalizedVariants.map((variant) => variant.title).join(" "),
  ].filter(Boolean).join(" "));

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: product.description || "",
    productType: product.productType || "",
    vendor: product.vendor || "",
    tags: product.tags || [],
    url: product.onlineStoreUrl || `https://aurela.pe/products/${product.handle}`,
    image: "",
    categories: categorizeSearchText(searchText),
    collections: (product.collections?.nodes || []).map((collection) => ({
      id: collection.id,
      handle: collection.handle,
      title: collection.title,
    })),
    options: (product.options || []).map((option) => ({ name: option.name, values: option.values || [] })),
    priceRange: { min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, currencyCode: "PEN" },
    variants: normalizedVariants,
    searchText,
  };
}

function normalizeAnyProduct(product) {
  if (product?.priceRange && Array.isArray(product.variants)) return product;
  return normalizeProduct(product);
}

function isProductOutOfStock(product) {
  return (product.variants || []).filter((variant) => variant.availableForSale).length === 0;
}

function buildOutOfStockMessage(product, alternatives = []) {
  // Producto agotado: nunca ofrecer otro agotado. Solo ofrecer alternativas EN STOCK;
  // si no hay, ofrecer pasar con asesora (NO prometer aviso de restock: no existe).
  if (alternatives.length === 0) {
    return [
      `Uy, *${product.title}* esta agotado por ahora 😔`,
      "",
      "¿Quieres que te pase con una asesora para ver otras opciones?",
    ].join("\n");
  }

  if (alternatives.length === 1) {
    return [
      `Uy, *${product.title}* esta agotado por ahora 😔`,
      "",
      `Lo que si tengo disponible y es parecido: *${alternatives[0].title}*${formatAlternativePrice(alternatives[0])}.`,
      "¿Te muestro ese?",
    ].join("\n");
  }

  const options = alternatives
    .map((alternative) => `• *${alternative.title}*${formatAlternativePrice(alternative)}`)
    .join("\n");
  return [
    `Uy, *${product.title}* esta agotado por ahora 😔`,
    "",
    "Estas opciones parecidas si las tengo disponibles:",
    options,
    "¿Cual te muestro?",
  ].join("\n");
}

function formatAlternativePrice(alternative) {
  return Number.isFinite(Number(alternative?.price)) ? ` (S/ ${formatMoney(alternative.price)})` : "";
}

function buildCategoryOutOfStockMessage(category) {
  const title = category?.label || "esos productos";
  return [
    `Uy, por ahora no tengo stock de ${title} 😔`,
    "",
    "¿Quieres que te pase con una asesora para ver otras opciones?",
  ].join("\n");
}

function buildProductFoundMessage(product) {
  const price = product.priceRange?.min;
  const maxPrice = product.priceRange?.max;
  const priceText = Number.isFinite(price) && Number.isFinite(maxPrice) && price !== maxPrice
    ? `desde S/ ${formatMoney(price)}`
    : Number.isFinite(price)
      ? `S/ ${formatMoney(price)}`
      : "precio por confirmar";
  const stockLine = "";
  const options = visibleOptions(product);
  const optionsLine = options.length ? `\nOpciones disponibles: ${options.join("; ")}` : "";
  const labels = productUnitLabels(product);
  const hasSize = hasOption(product, ["talla", "tallas", "size", "tamano", "tamaño"]);

  if (Number.isFinite(price) && Number.isFinite(maxPrice) && price === maxPrice) {
    // Closed two-option close: 1 unit vs the entry promo (3x2). Never ask if they want the price.
    const closing = hasSize
      ? `Que talla quieres? Y te llevas 1 ${labels.singular} por *S/ ${formatMoney(price)}* o aprovechas el 3x2 (3 ${labels.plural} por *S/ ${formatMoney(price * 2)}*)?`
      : `Te llevas 1 ${labels.singular} por *S/ ${formatMoney(price)}* o aprovechas el 3x2 (3 ${labels.plural} por *S/ ${formatMoney(price * 2)}*)?`;
    return [
      `Si, lo tengo: *${product.title}*.`,
      `El precio es de *S/ ${formatMoney(price)}* por ${labels.singular}.${optionsLine}${stockLine}`,
      "",
      "🔥 Promociones disponibles:",
      `• 1 ${labels.singular}: *S/ ${formatMoney(price)}*`,
      `• 3x2: Lleva 3 ${labels.plural} por *S/ ${formatMoney(price * 2)}* (pagas solo 2)`,
      `• 5x3: Lleva 5 ${labels.plural} por *S/ ${formatMoney(price * 3)}* (pagas solo 3)`,
      "",
      closing,
    ].join("\n");
  }

  return [
    `Si, lo tengo: *${product.title}*.`,
    `Precio: *${priceText}*.${optionsLine}${stockLine}`,
    `Te llevas 1 ${labels.singular} o aprovechas el 3x2 (pagas 2 y llevas 3)? Te paso el total exacto al toque.`,
  ].join("\n");
}

function productUnitLabels(product) {
  const searchText = product.searchText || normalizeSearchText([
    product.title,
    product.handle?.replace(/-/g, " "),
    product.productType,
    (product.tags || []).join(" "),
    (product.categories || []).join(" "),
  ].filter(Boolean).join(" "));

  if ((product.categories || []).includes("sandalias") || /\b(sandalia|sandalias|pantufla|pantuflas|slide|slides|chancla|chanclas)\b/.test(searchText)) {
    return { singular: "par", plural: "pares", quantityQuestion: "Cuantos pares" };
  }

  return { singular: "unidad", plural: "unidades", quantityQuestion: "Cuantas unidades" };
}

function hasOption(product, names) {
  const normalizedNames = new Set(names.map((name) => normalizeSearchText(name)));
  return (product.options || []).some((option) => normalizedNames.has(normalizeSearchText(option.name)));
}

function visibleOptions(product) {
  // Solo valores de opciones (talla/color/...) que existen en al menos una variante
  // con stock (availableForSale). Si una opcion no tiene valores en stock, se omite.
  const inStockVariants = (product.variants || []).filter((variant) => variant.availableForSale);
  return (product.options || [])
    .filter((option) => {
      const name = normalizeSearchText(option.name);
      const values = option.values || [];
      return name !== "title" && !(values.length === 1 && normalizeSearchText(values[0]) === "default title");
    })
    .map((option) => {
      const definedValues = option.values || [];
      const availableSet = new Set(
        inStockVariants
          .map((variant) => (variant.selectedOptions || {})[option.name])
          .filter(Boolean)
          .map((value) => normalizeSearchText(value)),
      );
      const availableValues = definedValues.filter((value) => availableSet.has(normalizeSearchText(value)));
      return { name: option.name, values: availableValues };
    })
    .filter((option) => option.values.length > 0)
    .map((option) => `${option.name}: ${option.values.join(", ")}`);
}

function buildAmbiguousMessage(matches) {
  const options = (matches || []).slice(0, 3).map((match, index) => `${index + 1}. ${match.title}`).join("\n");
  return ["Encontre varios productos parecidos y no quiero darte un dato incorrecto.", options, "Cual de estos deseas revisar?"].filter(Boolean).join("\n");
}

function buildCategoryMatchesMessage(category, matches) {
  const title = category?.label || "productos";
  const options = (matches || [])
    .slice(0, 5)
    .map((match, index) => {
      const price = Number.isFinite(Number(match.price)) ? ` - S/ ${formatMoney(match.price)}` : "";
      return `${index + 1}. *${match.title}*${price}`;
    })
    .join("\n");

  return [
    `Si, tenemos ${title}. Estas opciones encontre en catalogo:`,
    options,
    "Cuando elijas uno, te paso 1 unidad, 3x2 y 5x3 con total exacto.",
    "Cual te gustaria revisar?",
  ].filter(Boolean).join("\n");
}

function categorizeSearchText(searchText) {
  return CATEGORY_RULES
    .filter((rule) => rule.terms.some((term) => searchText.includes(normalizeSearchText(term))))
    .map((rule) => rule.key);
}

function handleKeys(handle) {
  const decoded = safeDecode(handle);
  return uniqueCandidates([handle, decoded, encodeURIComponent(decoded), slugifyHandle(decoded)]);
}

function slugifyHandle(value) {
  return String(value)
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

function normalizePublicTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).map((tag) => tag.trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

function normalizeImageUrl(value) {
  if (!value) return "";
  const text = String(value);
  if (text.startsWith("//")) return `https:${text}`;
  return text;
}

function publicMoney(value, priceInCents) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const normalized = priceInCents ? amount / 100 : amount;
  return Math.round((normalized + Number.EPSILON) * 100) / 100;
}

function toShopifyGid(type, id) {
  const value = String(id || "");
  return value.startsWith("gid://shopify/") ? value : `gid://shopify/${type}/${value}`;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeSearch(value) {
  return value.replace(/["'\\:]/g, " ").trim();
}

function uniqueCandidates(values) {
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

function uniquePreserveCase(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatMoney(value) {
  return (Math.round((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2);
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

globalThis.__aurelaProductLookup = { adReferralText, extractHandleCandidates, extractInlineReferral, handleRequest, handler, loadPublicCatalog, resolveAdText };
