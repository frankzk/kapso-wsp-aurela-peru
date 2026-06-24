// Dashboard de ventas por campana de WhatsApp (Click-to-WhatsApp).
//
// Cruza las ordenes de Shopify (atribuidas con ctwa_ad_id en los note_attributes
// por la funcion create-shopify-order) con el gasto publicitario de Meta Marketing
// API para reportar, por anuncio y por campana: pedidos, ingresos, gasto, CPA y ROAS.
//
// Endpoint PUBLICO protegido por access key (expone datos de ventas):
//   GET /?key=<DASHBOARD_ACCESS_KEY>            -> dashboard HTML
//   GET /?key=<...>&format=json                 -> mismos datos en JSON
//   Parametros de rango: ?days=30  o  ?since=YYYY-MM-DD&until=YYYY-MM-DD
//
// Meta es opcional: si no hay token configurado, el reporte muestra las ventas
// igual (sin gasto/CPA/ROAS) con un aviso para conectar la cuenta.

const DEFAULT_SHOP_DOMAIN = "aurela-peru.myshopify.com";
const DEFAULT_API_VERSION = "2026-04";
const DEFAULT_META_API_VERSION = "v21.0";
const MAX_ORDER_PAGES = 12; // 12 x 250 = 3000 ordenes por rango
const MAX_META_PAGES = 20;
const DEFAULT_DAYS = 30;
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000; // America/Lima = UTC-5 (sin DST)

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const wantsJson = params.format === "json" || /application\/json/i.test(request.headers.get("accept") || "");
  const config = getConfig(env);

  // Guarda de acceso: si hay key configurada, exigirla. Si no hay key configurada,
  // bloquear por defecto (no exponer ventas por accidente).
  const provided = params.key || request.headers.get("x-dashboard-key") || "";
  if (!config.dashboardKey || provided !== config.dashboardKey) {
    const body = wantsJson
      ? json({ error: "unauthorized" }, 401)
      : html(renderUnauthorized(), 401);
    return body;
  }

  try {
    const range = resolveRange(params);
    const sales = await fetchOrderAggregates(config, range);
    const meta = await fetchMetaInsights(config, range);
    const report = buildReport({ sales, meta, range, config });

    if (wantsJson) return json(report);
    return html(renderDashboard(report).replace(/__KEY__/g, encodeURIComponent(provided)));
  } catch (error) {
    const payload = { error: "report_error", message: safeError(error) };
    return wantsJson ? json(payload, 500) : html(renderError(payload), 500);
  }
}

function getConfig(env = globalThis) {
  const g = (a, b) => env[a] || env[b] || globalThis[a] || globalThis[b];
  return {
    shopDomain: g("SHOPIFY_SHOP_DOMAIN", "sHOPIFYSHOPDOMAIN") || DEFAULT_SHOP_DOMAIN,
    apiVersion: g("SHOPIFY_API_VERSION", "sHOPIFYAPIVERSION") || DEFAULT_API_VERSION,
    token: g("SHOPIFY_ADMIN_ACCESS_TOKEN", "sHOPIFYADMINACCESSTOKEN"),
    metaToken: g("META_ACCESS_TOKEN", "mETAACCESSTOKEN"),
    metaAdAccountId: normalizeAdAccountId(g("META_AD_ACCOUNT_ID", "mETAADACCOUNTID")),
    metaApiVersion: g("META_API_VERSION", "mETAAPIVERSION") || DEFAULT_META_API_VERSION,
    dashboardKey: g("DASHBOARD_ACCESS_KEY", "dASHBOARDACCESSKEY"),
  };
}

function normalizeAdAccountId(value) {
  if (!value) return null;
  const v = String(value).trim();
  return v.startsWith("act_") ? v.slice(4) : v;
}

// ---------------------------------------------------------------------------
// Rango de fechas (en hora Lima)
// ---------------------------------------------------------------------------

function resolveRange(params) {
  const nowLima = new Date(Date.now() - LIMA_OFFSET_MS);
  const until = isValidDate(params.until) ? params.until : toDateStr(nowLima);
  let since;
  let days = clampInt(params.days, 1, 365, DEFAULT_DAYS);

  if (isValidDate(params.since)) {
    since = params.since;
    days = null;
  } else {
    const start = new Date(`${until}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    since = toDateStr(start);
  }

  return {
    since,
    until,
    days,
    sinceIso: `${since}T00:00:00Z`,
    untilIso: `${until}T23:59:59Z`,
  };
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Shopify: agregacion de ventas por anuncio (ctwa_ad_id)
// ---------------------------------------------------------------------------

async function fetchOrderAggregates(config, range) {
  const byAd = new Map();
  let cursor = null;
  let currency = "PEN";
  let ordersScanned = 0;
  let attributedOrders = 0;
  let totalRevenue = 0;
  let attributedRevenue = 0;
  let truncated = false;

  const queryString = `created_at:>='${range.sinceIso}' created_at:<='${range.untilIso}'`;

  const gql = `#graphql
    query CampaignOrders($q: String!, $cursor: String) {
      orders(first: 250, query: $q, after: $cursor, sortKey: CREATED_AT) {
        nodes {
          id
          name
          createdAt
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          customAttributes { key value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const data = await shopifyGraphql(config, gql, { q: queryString, cursor });
    const orders = data.orders?.nodes || [];

    for (const order of orders) {
      ordersScanned += 1;
      const money = order.currentTotalPriceSet?.shopMoney;
      const amount = Number(money?.amount || 0);
      if (money?.currencyCode) currency = money.currencyCode;
      if (Number.isFinite(amount)) totalRevenue += amount;

      const attrs = attributesToMap(order.customAttributes);
      const adId = attrs.ctwa_ad_id;
      if (!adId) continue;

      attributedOrders += 1;
      if (Number.isFinite(amount)) attributedRevenue += amount;

      const entry = byAd.get(adId) || {
        adId,
        orders: 0,
        revenue: 0,
        headline: attrs.ctwa_headline || null,
        sourceType: attrs.ctwa_source_type || null,
        sourceUrl: attrs.ctwa_source_url || null,
      };
      entry.orders += 1;
      if (Number.isFinite(amount)) entry.revenue += amount;
      if (!entry.headline && attrs.ctwa_headline) entry.headline = attrs.ctwa_headline;
      byAd.set(adId, entry);
    }

    const pageInfo = data.orders?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    if (page === MAX_ORDER_PAGES - 1) truncated = true;
  }

  return {
    byAd,
    currency,
    ordersScanned,
    attributedOrders,
    totalRevenue,
    attributedRevenue,
    truncated,
  };
}

function attributesToMap(customAttributes) {
  const map = {};
  for (const attr of customAttributes || []) {
    if (attr?.key) map[attr.key] = attr.value;
  }
  return map;
}

async function shopifyGraphql(config, query, variables) {
  if (!config.token) throw new Error("Falta SHOPIFY_ADMIN_ACCESS_TOKEN");

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
    throw new Error(`Shopify: ${JSON.stringify(payload.errors || payload).slice(0, 500)}`);
  }
  return payload.data;
}

// ---------------------------------------------------------------------------
// Meta Marketing API: gasto por anuncio (opcional)
// ---------------------------------------------------------------------------

async function fetchMetaInsights(config, range) {
  if (!config.metaToken || !config.metaAdAccountId) {
    return { configured: false, byAd: new Map(), accountCurrency: null };
  }

  const byAd = new Map();
  let accountCurrency = null;
  const fields = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks,account_currency";
  const timeRange = encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }));
  let nextUrl = `https://graph.facebook.com/${config.metaApiVersion}/act_${config.metaAdAccountId}/insights`
    + `?level=ad&fields=${fields}&time_range=${timeRange}&limit=500&access_token=${encodeURIComponent(config.metaToken)}`;

  try {
    for (let page = 0; page < MAX_META_PAGES && nextUrl; page += 1) {
      const response = await fetch(nextUrl, { headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok || payload.error) {
        const msg = payload?.error?.message || `HTTP ${response.status}`;
        return { configured: true, error: msg, byAd, accountCurrency };
      }
      for (const row of payload.data || []) {
        if (!row.ad_id) continue;
        if (!accountCurrency && row.account_currency) accountCurrency = row.account_currency;
        const existing = byAd.get(row.ad_id);
        const spend = Number(row.spend || 0);
        if (existing) {
          existing.spend += Number.isFinite(spend) ? spend : 0;
          existing.impressions += Number(row.impressions || 0);
          existing.linkClicks += Number(row.inline_link_clicks || 0);
        } else {
          byAd.set(row.ad_id, {
            adId: row.ad_id,
            adName: row.ad_name || null,
            adsetName: row.adset_name || null,
            campaignId: row.campaign_id || null,
            campaignName: row.campaign_name || null,
            spend: Number.isFinite(spend) ? spend : 0,
            impressions: Number(row.impressions || 0),
            linkClicks: Number(row.inline_link_clicks || 0),
          });
        }
      }
      nextUrl = payload.paging?.next || null;
    }
    return { configured: true, byAd, accountCurrency };
  } catch (error) {
    return { configured: true, error: safeError(error), byAd, accountCurrency };
  }
}

// ---------------------------------------------------------------------------
// Construccion del reporte (puro, testeable)
// ---------------------------------------------------------------------------

function buildReport({ sales, meta, range, config }) {
  const adIds = new Set([...sales.byAd.keys(), ...meta.byAd.keys()]);
  const sameCurrency = !meta.accountCurrency || meta.accountCurrency === sales.currency;

  const ads = [];
  for (const adId of adIds) {
    const s = sales.byAd.get(adId);
    const m = meta.byAd.get(adId);
    const orders = s?.orders || 0;
    const revenue = s?.revenue || 0;
    const spend = m?.spend || 0;
    ads.push({
      adId,
      adName: m?.adName || null,
      adsetName: m?.adsetName || null,
      campaignId: m?.campaignId || null,
      campaignName: m?.campaignName || null,
      headline: s?.headline || null,
      sourceUrl: s?.sourceUrl || null,
      orders,
      revenue: round2(revenue),
      spend: round2(spend),
      impressions: m?.impressions || 0,
      linkClicks: m?.linkClicks || 0,
      cpa: orders > 0 && spend > 0 ? round2(spend / orders) : null,
      roas: spend > 0 ? round2(revenue / spend) : null,
      aov: orders > 0 ? round2(revenue / orders) : null,
    });
  }
  ads.sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);

  // Agrupar por campana (cae a "(sin campana / Meta no conectado)" cuando no hay match)
  const campaignMap = new Map();
  for (const ad of ads) {
    const key = ad.campaignId || ad.campaignName || "__none__";
    const label = ad.campaignName || (meta.configured ? "(anuncio sin campana)" : "(conecta Meta para ver campana)");
    const c = campaignMap.get(key) || { campaignId: ad.campaignId, campaignName: label, orders: 0, revenue: 0, spend: 0, ads: 0 };
    c.orders += ad.orders;
    c.revenue += ad.revenue;
    c.spend += ad.spend;
    c.ads += 1;
    campaignMap.set(key, c);
  }
  const campaigns = [...campaignMap.values()].map((c) => ({
    ...c,
    revenue: round2(c.revenue),
    spend: round2(c.spend),
    cpa: c.orders > 0 && c.spend > 0 ? round2(c.spend / c.orders) : null,
    roas: c.spend > 0 ? round2(c.revenue / c.spend) : null,
    aov: c.orders > 0 ? round2(c.revenue / c.orders) : null,
  })).sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);

  const totalSpend = round2(ads.reduce((sum, a) => sum + a.spend, 0));
  const totals = {
    ordersScanned: sales.ordersScanned,
    attributedOrders: sales.attributedOrders,
    attributionRate: sales.ordersScanned > 0 ? round2(sales.attributedOrders / sales.ordersScanned) : 0,
    totalRevenue: round2(sales.totalRevenue),
    attributedRevenue: round2(sales.attributedRevenue),
    organicRevenue: round2(sales.totalRevenue - sales.attributedRevenue),
    organicOrders: sales.ordersScanned - sales.attributedOrders,
    totalSpend,
    overallCpa: sales.attributedOrders > 0 && totalSpend > 0 ? round2(totalSpend / sales.attributedOrders) : null,
    overallRoas: totalSpend > 0 ? round2(sales.attributedRevenue / totalSpend) : null,
  };

  const warnings = [];
  if (!meta.configured) warnings.push("Meta Marketing API no esta conectada: se muestran ventas atribuidas, pero sin gasto, CPA ni ROAS. Configura META_ACCESS_TOKEN y META_AD_ACCOUNT_ID para activarlo.");
  if (meta.configured && meta.error) warnings.push(`No se pudo leer Meta Ads: ${meta.error}`);
  if (!sameCurrency) warnings.push(`La moneda de Shopify (${sales.currency}) difiere de la de Meta (${meta.accountCurrency}); CPA y ROAS pueden no ser comparables.`);
  if (sales.truncated) warnings.push(`Se alcanzo el limite de ${MAX_ORDER_PAGES * 250} ordenes; acota el rango de fechas para ver todo.`);

  return {
    range: { since: range.since, until: range.until, days: range.days },
    currency: sales.currency,
    metaConfigured: meta.configured,
    metaCurrency: meta.accountCurrency,
    sameCurrency,
    totals,
    campaigns,
    ads,
    warnings,
    generatedAt: new Date(Date.now() - LIMA_OFFSET_MS).toISOString().replace("T", " ").slice(0, 16) + " (Lima)",
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Render HTML
// ---------------------------------------------------------------------------

function renderDashboard(report) {
  const cur = report.currency;
  const t = report.totals;
  const rangeLinks = [7, 14, 30, 90].map((d) => {
    const active = report.range.days === d ? " active" : "";
    return `<a class="chip${active}" href="?key=__KEY__&days=${d}">${d}d</a>`;
  }).join("");

  const warningsHtml = report.warnings.length
    ? `<div class="warnings">${report.warnings.map((w) => `<div class="warn">⚠️ ${escapeHtml(w)}</div>`).join("")}</div>`
    : "";

  const cards = [
    card("Ingresos atribuidos", money(t.attributedRevenue, cur), `${t.attributedOrders} pedidos por anuncio`),
    report.metaConfigured ? card("Gasto publicitario", money(t.totalSpend, cur), "Meta Ads") : card("Gasto publicitario", "—", "Conecta Meta"),
    report.metaConfigured ? card("ROAS global", t.overallRoas != null ? `${t.overallRoas}x` : "—", "ingreso / gasto") : card("ROAS global", "—", "Conecta Meta"),
    report.metaConfigured ? card("CPA global", t.overallCpa != null ? money(t.overallCpa, cur) : "—", "gasto / pedido") : card("CPA global", "—", "Conecta Meta"),
    card("Ingresos totales", money(t.totalRevenue, cur), `${t.ordersScanned} pedidos en total`),
    card("% atribuido", `${Math.round(t.attributionRate * 100)}%`, `${t.organicOrders} pedidos organicos`),
  ].join("");

  const campaignRows = report.campaigns.length
    ? report.campaigns.map((c) => `
      <tr>
        <td>${escapeHtml(c.campaignName)}</td>
        <td class="num">${c.orders}</td>
        <td class="num">${money(c.revenue, cur)}</td>
        <td class="num">${report.metaConfigured ? money(c.spend, cur) : "—"}</td>
        <td class="num">${c.cpa != null ? money(c.cpa, cur) : "—"}</td>
        <td class="num">${roasCell(c.roas)}</td>
        <td class="num">${c.aov != null ? money(c.aov, cur) : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="empty">Sin ventas atribuidas en este rango.</td></tr>`;

  const adRows = report.ads.length
    ? report.ads.map((a) => `
      <tr>
        <td>
          <div class="adname">${escapeHtml(a.adName || a.headline || "(anuncio sin nombre)")}</div>
          <div class="admeta">${escapeHtml(a.campaignName || "")} ${a.campaignName ? "·" : ""} <span class="mono">${escapeHtml(a.adId)}</span></div>
        </td>
        <td class="num">${a.orders}</td>
        <td class="num">${money(a.revenue, cur)}</td>
        <td class="num">${report.metaConfigured ? money(a.spend, cur) : "—"}</td>
        <td class="num">${a.cpa != null ? money(a.cpa, cur) : "—"}</td>
        <td class="num">${roasCell(a.roas)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">Sin datos en este rango.</td></tr>`;

  const body = `
    <header>
      <h1>📊 Ventas por campaña · WhatsApp</h1>
      <div class="sub">Aurela Perú · ${escapeHtml(report.range.since)} → ${escapeHtml(report.range.until)} · generado ${escapeHtml(report.generatedAt)}</div>
      <div class="chips">${rangeLinks}</div>
    </header>
    ${warningsHtml}
    <section class="cards">${cards}</section>
    <section>
      <h2>Por campaña</h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Campaña</th><th class="num">Pedidos</th><th class="num">Ingresos</th><th class="num">Gasto</th><th class="num">CPA</th><th class="num">ROAS</th><th class="num">Ticket prom.</th></tr></thead>
        <tbody>${campaignRows}</tbody>
      </table></div>
    </section>
    <section>
      <h2>Por anuncio</h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Anuncio</th><th class="num">Pedidos</th><th class="num">Ingresos</th><th class="num">Gasto</th><th class="num">CPA</th><th class="num">ROAS</th></tr></thead>
        <tbody>${adRows}</tbody>
      </table></div>
    </section>
    <footer>Datos: Shopify (ventas atribuidas vía ctwa_ad_id) + Meta Marketing API (gasto). <a href="?key=__KEY__&days=${report.range.days || 30}&format=json">Ver JSON</a></footer>`;

  return pageShell(body);
}

function card(label, value, hint) {
  return `<div class="cardbox"><div class="cardlabel">${escapeHtml(label)}</div><div class="cardvalue">${escapeHtml(String(value))}</div><div class="cardhint">${escapeHtml(hint)}</div></div>`;
}

function roasCell(roas) {
  if (roas == null) return "—";
  const cls = roas >= 2 ? "good" : roas >= 1 ? "ok" : "bad";
  return `<span class="roas ${cls}">${roas}x</span>`;
}

function pageShell(body) {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ventas por campaña · Aurela</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262a33;--txt:#e7e9ee;--mut:#9aa3b2;--accent:#6ea8fe;--good:#3ddc97;--bad:#ff6b6b;--ok:#ffd166}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
header h1{margin:0 0 4px;font-size:22px}.sub{color:var(--mut);font-size:13px}
.chips{margin-top:12px;display:flex;gap:8px}.chip{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--mut);text-decoration:none;font-size:13px}
.chip.active{background:var(--accent);color:#0b0d10;border-color:var(--accent);font-weight:600}
.warnings{margin:16px 0}.warn{background:#2a230f;border:1px solid #5a4a1a;color:#ffd98a;padding:8px 12px;border-radius:8px;margin-bottom:6px;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.cardbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.cardlabel{color:var(--mut);font-size:12px}.cardvalue{font-size:24px;font-weight:700;margin:4px 0}.cardhint{color:var(--mut);font-size:12px}
h2{font-size:16px;margin:24px 0 8px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th.num,td.num{text-align:right}th{color:var(--mut);font-weight:600;font-size:12px}
tr:last-child td{border-bottom:none}.empty{color:var(--mut);text-align:center}
.adname{font-weight:600}.admeta{color:var(--mut);font-size:12px}.mono{font-family:ui-monospace,monospace}
.roas{font-weight:700}.roas.good{color:var(--good)}.roas.ok{color:var(--ok)}.roas.bad{color:var(--bad)}
footer{margin-top:24px;color:var(--mut);font-size:12px}footer a,.cardhint a{color:var(--accent)}
</style></head><body>${body}</body></html>`;
}

function renderUnauthorized() {
  return pageShell(`<header><h1>🔒 Acceso restringido</h1><div class="sub">Falta o es incorrecta la clave de acceso (?key=...).</div></header>`);
}

function renderError(payload) {
  return pageShell(`<header><h1>⚠️ Error</h1><div class="sub">${escapeHtml(payload.message || "Error")}</div></header>`);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(amount, currency) {
  const symbol = currency === "PEN" ? "S/ " : currency === "USD" ? "$ " : `${currency} `;
  const n = Number(amount || 0);
  return symbol + n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

globalThis.__aurelaCampaignReport = { buildReport, fetchOrderAggregates, fetchMetaInsights, handleRequest, handler, resolveRange };
