const DEFAULT_PUBLIC_SHOP_DOMAIN = "aurela.pe";
const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CATALOG_PAGES = 20;

const STOPWORDS = new Set([
  "aurela",
  "color",
  "colores",
  "consulta",
  "foto",
  "fotos",
  "imagen",
  "imagenes",
  "modelo",
  "modelos",
  "opcion",
  "opciones",
  "pasame",
  "producto",
  "quiero",
  "tienes",
  "ver",
]);

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
    const config = getConfig(env);
    const root = isPlainObject(input.input) ? input.input : input;
    const queryText = collectInputText(input);
    const handles = extractHandleCandidates(queryText);
    const requestedVariant = collectVariantText(root);
    const limit = clamp(Number(root.limit || input.limit || 6) || 6, 1, 10);

    let product = null;

    for (const handle of handles) {
      product = await getPublicProductByHandle(config, handle);
      if (product) break;
    }

    if (!product && queryText) {
      const catalog = await loadPublicCatalog(config);
      const catalogMatch = searchCatalogProducts(catalog, queryText, handles);
      if (catalogMatch?.handle) product = await getPublicProductByHandle(config, catalogMatch.handle);
    }

    if (!product) {
      return json({
        ok: false,
        found: false,
        reason: "product_not_found",
        message: "No encontre fotos reales para ese producto. Pide link, nombre exacto o captura antes de responder.",
      });
    }

    const media = buildMediaItems(product, { limit, requestedVariant });
    if (media.length === 0) {
      return json({
        ok: false,
        found: true,
        reason: "media_not_found",
        product: productSummary(product, config.publicShopDomain),
        message: "El producto existe, pero no encontre fotos publicas disponibles para enviar como media.",
      });
    }

    return json({
      ok: true,
      found: true,
      product: productSummary(product, config.publicShopDomain),
      media,
      count: media.length,
      sendMediaInstructions: [
        "Usa la herramienta send_media para enviar cada item como imagen de WhatsApp.",
        "No escribas ni pegues estas URLs en texto al cliente.",
        "No uses Markdown de imagen.",
      ].join(" "),
      followUpText: "Te muestro esas opciones. Cual color te gusta mas?",
    });
  } catch (error) {
    return json({
      ok: false,
      found: false,
      reason: "media_lookup_error",
      message: "No pude obtener fotos reales ahora. Deriva a humano sin pegar links.",
      error: safeError(error),
    }, 200);
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
  const publicShopDomain =
    env.SHOPIFY_PUBLIC_SHOP_DOMAIN ||
    env.sHOPIFYPUBLICSHOPDOMAIN ||
    globalThis.SHOPIFY_PUBLIC_SHOP_DOMAIN ||
    globalThis.sHOPIFYPUBLICSHOPDOMAIN ||
    DEFAULT_PUBLIC_SHOP_DOMAIN;

  return { publicShopDomain };
}

function collectInputText(input) {
  const root = isPlainObject(input.input) ? input.input : input;
  const sources = [root, input].filter(Boolean);
  const keys = [
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
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) direct.push(value.trim());
    }
  }

  if (direct.length > 0) return uniquePreserveCase(direct).join(" ");
  return collectStrings(input).join(" ").trim();
}

function collectVariantText(root) {
  return [
    root.variant,
    root.variantTitle,
    root.variant_title,
    root.color,
    root.colour,
    root.modelo,
    root.option,
  ].filter((value) => typeof value === "string" && value.trim()).join(" ");
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
      // Malformed URLs are ignored; name search can still resolve the product.
    }
  }

  return uniqueCandidates(candidates);
}

async function getPublicProductByHandle(config, handle) {
  for (const key of handleKeys(handle)) {
    try {
      const response = await fetch(`https://${config.publicShopDomain}/products/${key}.js`, {
        headers: publicHeaders(),
      });
      if (!response.ok) continue;

      const product = await response.json();
      if (!product?.id || !product?.handle) continue;
      return product;
    } catch {
      // Try the next handle.
    }
  }

  return null;
}

async function loadPublicCatalog(config) {
  const now = Date.now();
  const cached = globalThis.__AURELA_MEDIA_CATALOG_CACHE;

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
        products.push(product);
      }

      if (pageProducts.length < 250) break;
    } catch {
      break;
    }
  }

  globalThis.__AURELA_MEDIA_CATALOG_CACHE = {
    expiresAt: now + CATALOG_CACHE_TTL_MS,
    products,
  };

  return products;
}

function publicHeaders() {
  return {
    "Accept": "application/json",
    "User-Agent": "Aurela-Kapso-Media-Lookup/1.0",
  };
}

function searchCatalogProducts(catalog, text, handles = []) {
  if (!text || !Array.isArray(catalog) || catalog.length === 0) return null;

  for (const handle of handles) {
    const keys = handleKeys(handle);
    const exact = catalog.find((product) => handleKeys(product.handle).some((key) => keys.includes(key)));
    if (exact) return exact;
  }

  const query = cleanProductQuery(text, handles);
  if (!query.normalized || query.tokens.length === 0) return null;

  return catalog
    .map((product) => ({ ...product, __score: scoreProduct(product, query) }))
    .filter((product) => product.__score >= 12)
    .sort((a, b) => b.__score - a.__score)[0] || null;
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
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .slice(0, 12);

  return { normalized: tokens.join(" "), tokens };
}

function scoreProduct(product, query) {
  const title = normalizeSearchText(product.title || "");
  const handle = normalizeSearchText((product.handle || "").replace(/-/g, " "));
  const searchable = normalizeSearchText([
    product.title,
    (product.handle || "").replace(/-/g, " "),
    product.product_type,
    product.type,
    product.vendor,
    normalizeTags(product.tags).join(" "),
    (product.variants || []).map((variant) => variant.title).join(" "),
  ].filter(Boolean).join(" "));

  let score = 0;
  if (query.normalized && title.includes(query.normalized)) score += 35;
  if (query.normalized && handle.includes(query.normalized)) score += 30;
  if (query.normalized && searchable.includes(query.normalized)) score += 20;

  for (const token of query.tokens) {
    const variants = tokenVariants(token);
    if (variants.some((variant) => handle === variant)) score += 25;
    else if (variants.some((variant) => handle.includes(variant))) score += 12;
    if (variants.some((variant) => title === variant || title.startsWith(`${variant} `))) score += 22;
    else if (variants.some((variant) => title.includes(variant))) score += 14;
    else if (variants.some((variant) => searchable.includes(variant))) score += 3;
  }

  const matchedTokens = query.tokens.filter((token) => searchableHasToken(searchable, token)).length;
  if (matchedTokens === query.tokens.length && query.tokens.length >= 2) score += 10;
  if (matchedTokens < Math.min(2, query.tokens.length)) score = 0;
  return score;
}

function buildMediaItems(product, options) {
  const limit = options.limit || 6;
  const requestedTokens = normalizeSearchText(options.requestedVariant || "")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  const optionDefinitions = normalizePublicOptions(product);
  const visualPositions = findVisualOptionPositions(optionDefinitions);
  const items = [];
  const seenUrls = new Set();

  for (const variant of product.variants || []) {
    const url = normalizeImageUrl(
      variant.featured_image?.src ||
      variant.featured_image ||
      variant.image ||
      variant.image?.src,
    );
    if (!url || seenUrls.has(url)) continue;

    const label = labelFromVariant(variant, optionDefinitions, visualPositions);
    const searchable = normalizeSearchText([label, variant.title, product.title].filter(Boolean).join(" "));
    if (requestedTokens.length > 0 && !requestedTokens.every((token) => searchable.includes(token))) continue;

    seenUrls.add(url);
    items.push(mediaItem(product, label, url));
    if (items.length >= limit) return items;
  }

  if (items.length === 0 && requestedTokens.length > 0) {
    return buildMediaItems(product, { ...options, requestedVariant: "" });
  }

  for (const image of product.images || []) {
    const url = normalizeImageUrl(image?.src || image);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    items.push(mediaItem(product, `Foto ${items.length + 1}`, url));
    if (items.length >= limit) return items;
  }

  const featured = normalizeImageUrl(product.featured_image || product.image?.src);
  if (featured && !seenUrls.has(featured) && items.length < limit) {
    items.push(mediaItem(product, "Principal", featured));
  }

  return items.slice(0, limit);
}

function mediaItem(product, label, url) {
  const safeLabel = label && normalizeSearchText(label) !== "default title" ? label : "Foto";
  return {
    mediaType: "image",
    type: "image",
    label: safeLabel,
    caption: `${safeLabel} - ${product.title}`,
    url,
    mediaUrl: url,
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

function findVisualOptionPositions(optionDefinitions) {
  const positions = optionDefinitions
    .filter((option) => /color|colour|tono|modelo|estilo|diseno|diseño/i.test(option.name || ""))
    .map((option) => option.position);

  if (positions.length > 0) return positions;
  return optionDefinitions.length ? [optionDefinitions[0].position] : [];
}

function labelFromVariant(variant, optionDefinitions, visualPositions) {
  const values = [];
  for (const option of optionDefinitions) {
    if (!visualPositions.includes(option.position)) continue;
    const value = variant[`option${option.position}`];
    if (value) values.push(value);
  }

  if (values.length > 0) return values.join(" / ");
  return variant.title || "Foto";
}

function productSummary(product, publicShopDomain) {
  return {
    handle: product.handle,
    title: product.title || product.handle,
    url: `https://${publicShopDomain}${product.url || `/products/${product.handle}`}`,
  };
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

function normalizeTags(tags) {
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

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

globalThis.__aurelaProductMediaLookup = { buildMediaItems, handleRequest, handler };
