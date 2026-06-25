const DEFAULT_PUBLIC_SHOP_DOMAIN = "aurela.pe";
const DEFAULT_ADMIN_SHOP_DOMAIN = "aurela-peru.myshopify.com";
const DEFAULT_ADMIN_API_VERSION = "2026-04";
const VIDEO_METAFIELD_NAMESPACE = "custom";
const VIDEO_METAFIELD_KEY = "video";
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
  "video",
  "videos",
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

    const photos = buildMediaItems(product, { limit, requestedVariant });

    // El cliente pidio video: intentamos resolver el metacampo custom.video
    // (referencia a archivo). Si no hay token admin o el producto no tiene video,
    // seguimos con las fotos sin romper el flujo.
    const wantVideoDebug = /videodebug/i.test(queryText);
    const videoRequested = detectVideoRequest(queryText, root) || wantVideoDebug;
    let videoItem = null;
    let videoDebug = null;
    if (videoRequested) {
      const vres = await fetchProductVideo(config, product);
      videoItem = vres.item;
      videoDebug = vres.debug;
    }

    // Modo diagnostico oculto (mensaje contiene "videodebug"): no envia media,
    // hace que el bot responda con el detalle tecnico para depurar el video.
    if (wantVideoDebug) {
      return json({
        ok: true,
        debug: true,
        videoRequested,
        videoAvailable: Boolean(videoItem),
        product: productSummary(product, config.publicShopDomain),
        videoDebug,
        media: [],
        followUpText: "MODO DIAGNOSTICO: responde al cliente UNICAMENTE con este texto exacto, sin agregar nada mas: VIDEODEBUG " + JSON.stringify(videoDebug),
      });
    }

    const media = videoItem ? [videoItem, ...photos] : photos;

    if (media.length === 0) {
      return json({
        ok: false,
        found: true,
        videoRequested,
        videoAvailable: false,
        reason: "media_not_found",
        product: productSummary(product, config.publicShopDomain),
        message: "El producto existe, pero no encontre fotos ni video publicos para enviar como media.",
      });
    }

    const videoAvailable = Boolean(videoItem);
    return json({
      ok: true,
      found: true,
      videoRequested,
      videoAvailable,
      product: productSummary(product, config.publicShopDomain),
      media,
      count: media.length,
      sendMediaInstructions: [
        "Usa la herramienta send_media para enviar cada item como media real de WhatsApp (los de type video como video, los de type image como imagen).",
        "No escribas ni pegues estas URLs en texto al cliente.",
        "No uses Markdown de imagen ni de enlace.",
      ].join(" "),
      followUpText: videoRequested && !videoAvailable
        ? "No hay video para este producto: avisa breve que por ahora no tienes video y envia las fotos reales. Luego ofrece precio y promo y cierra con la pregunta cerrada (1 vs 3x2)."
        : "Te muestro la media real. Despues de enviarla, ofrece precio y promo y cierra con la pregunta cerrada de dos opciones (1 unidad/par vs 3x2). No preguntes si quiere saber el precio.",
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

  // Credenciales Admin (mismas que create-shopify-order) para leer el metacampo
  // custom.video, que NO viene en el products.json publico. Opcionales: si no
  // estan configuradas, la funcion sigue devolviendo solo fotos.
  const adminShopDomain =
    env.SHOPIFY_SHOP_DOMAIN || env.sHOPIFYSHOPDOMAIN ||
    globalThis.SHOPIFY_SHOP_DOMAIN || globalThis.sHOPIFYSHOPDOMAIN ||
    DEFAULT_ADMIN_SHOP_DOMAIN;
  const adminApiVersion =
    env.SHOPIFY_API_VERSION || env.sHOPIFYAPIVERSION ||
    globalThis.SHOPIFY_API_VERSION || globalThis.sHOPIFYAPIVERSION ||
    DEFAULT_ADMIN_API_VERSION;
  const adminToken =
    env.SHOPIFY_ADMIN_ACCESS_TOKEN || env.sHOPIFYADMINACCESSTOKEN ||
    globalThis.SHOPIFY_ADMIN_ACCESS_TOKEN || globalThis.sHOPIFYADMINACCESSTOKEN || "";

  return { publicShopDomain, adminShopDomain, adminApiVersion, adminToken };
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

function detectVideoRequest(queryText, root) {
  if (root && (root.includeVideo === true || root.wantsVideo === true || root.video === true)) return true;
  const flag = String((root && (root.mediaType || root.media_type)) || "").toLowerCase();
  if (flag === "video") return true;
  return /\bvideos?\b/i.test(String(queryText || ""));
}

// Lee el metacampo custom.video (referencia a archivo Video) del producto via
// Admin API. Devuelve { item, debug }: item es el media listo para send_media (o
// null), y debug explica por que no se resolvio (para el modo diagnostico).
async function fetchProductVideo(config, product) {
  const debug = {
    tokenPresent: Boolean(config.adminToken),
    productId: product?.id || null,
    metafieldPresent: false,
    metafieldType: null,
    referenceType: null,
    fileStatus: null,
    sourcesCount: 0,
    urlPicked: false,
    error: null,
  };
  if (!config.adminToken || !product?.id) return { item: null, debug };

  try {
    const query = `#graphql
      query ProductVideo($id: ID!, $ns: String!, $key: String!) {
        product(id: $id) {
          metafield(namespace: $ns, key: $key) {
            type
            reference {
              __typename
              ... on Video { fileStatus sources { url mimeType format height width } }
              ... on GenericFile { url mimeType }
              ... on MediaImage { image { url } }
            }
          }
        }
      }`;
    const data = await shopifyAdminGraphql(config, query, {
      id: `gid://shopify/Product/${product.id}`,
      ns: VIDEO_METAFIELD_NAMESPACE,
      key: VIDEO_METAFIELD_KEY,
    });
    const mf = data?.product?.metafield;
    debug.metafieldPresent = Boolean(mf);
    debug.metafieldType = mf?.type || null;
    const ref = mf?.reference;
    if (!ref) return { item: null, debug };
    debug.referenceType = ref.__typename || null;

    let url = "";
    let mimeType = "video/mp4";
    if (ref.__typename === "Video") {
      debug.fileStatus = ref.fileStatus || null;
      const sources = Array.isArray(ref.sources) ? ref.sources : [];
      debug.sourcesCount = sources.length;
      const src = pickVideoSource(sources);
      if (src) { url = src.url; mimeType = src.mimeType || mimeType; }
    } else if (ref.__typename === "GenericFile" && ref.url) {
      url = ref.url;
      mimeType = ref.mimeType || mimeType;
    }

    url = normalizeImageUrl(url);
    debug.urlPicked = Boolean(url);
    if (!url) return { item: null, debug };
    return { item: videoItem(product, url, mimeType), debug };
  } catch (error) {
    debug.error = error instanceof Error ? error.message : String(error);
    return { item: null, debug };
  }
}

// Elige la fuente mp4 mas liviana (menor altura) para no pasar el limite de
// 16MB de WhatsApp; cae a la primera fuente con url si faltan metadatos.
function pickVideoSource(sources) {
  const mp4 = sources.filter((s) => s && s.url && (/mp4/i.test(s.mimeType || "") || /mp4/i.test(s.format || "")));
  const pool = mp4.length ? mp4 : sources.filter((s) => s && s.url);
  if (pool.length === 0) return null;
  return pool.slice().sort((a, b) => (Number(a.height) || 1e9) - (Number(b.height) || 1e9))[0];
}

function videoItem(product, url, mimeType) {
  return {
    mediaType: "video",
    type: "video",
    label: "Video",
    caption: product.title || "Video",
    url,
    mediaUrl: url,
    mimeType: mimeType || "video/mp4",
  };
}

async function shopifyAdminGraphql(config, query, variables) {
  const response = await fetch(
    `https://${config.adminShopDomain}/admin/api/${config.adminApiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": config.adminToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!response.ok) throw new Error(`Admin GraphQL HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors) throw new Error(`Admin GraphQL: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

globalThis.__aurelaProductMediaLookup = {
  buildMediaItems,
  detectVideoRequest,
  fetchProductVideo,
  handleRequest,
  handler,
  pickVideoSource,
  videoItem,
};
