import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);
const BRIDGE_TOKEN = String(process.env.BRIDGE_TOKEN || "").trim();
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS || 300000);

let browserPromise = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isShopeeHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return (
    h === "shopee.com.br" ||
    h.endsWith(".shopee.com.br") ||
    h === "shope.ee" ||
    h.endsWith(".shope.ee")
  );
}

function assertShopeeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw new Error("URL inválida.");
  }

  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Protocolo não permitido.");
  }

  if (!isShopeeHost(u.hostname)) {
    throw new Error("Somente links da Shopee são permitidos.");
  }

  return u.toString();
}

function authOk(req) {
  if (!BRIDGE_TOKEN) return false;
  return String(req.headers.authorization || "") === `Bearer ${BRIDGE_TOKEN}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;

  const s = String(v).trim();
  if (!s) return undefined;

  const cleaned = s.replace(/[^\d,.-]/g, "");
  if (!cleaned) return undefined;

  if (cleaned.includes(",")) {
    const n = Number(cleaned.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeShopeePrice(v) {
  const n = toNumber(v);
  if (n === undefined) return undefined;

  // A Shopee costuma usar inteiros multiplicados por 100000.
  if (n >= 100000) {
    return Math.round((n / 100000) * 100) / 100;
  }

  return Math.round(n * 100) / 100;
}

function uniqueStrings(values) {
  return [...new Set(
    values
      .flat(Infinity)
      .filter(Boolean)
      .map(v => String(v).trim())
      .filter(Boolean)
  )];
}

function walk(obj, visit, depth = 0) {
  if (!obj || depth > 12) return;

  if (Array.isArray(obj)) {
    for (const v of obj.slice(0, 500)) {
      walk(v, visit, depth + 1);
    }
    return;
  }

  if (typeof obj !== "object") return;

  visit(obj);

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      walk(v, visit, depth + 1);
    }
  }
}

function imageUrlFromShopee(value) {
  if (!value) return undefined;

  const s = String(value).trim();
  if (!s) return undefined;

  if (/^https?:\/\//i.test(s)) return s;

  // IDs de imagem da Shopee.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) {
    return `https://down-br.img.susercontent.com/file/${s}`;
  }

  return undefined;
}

function productFromJson(data, canonicalUrl, source = "json") {
  let best = null;

  walk(data, (o) => {
    const title =
      o.name ??
      o.title ??
      o.item_name ??
      o.product_name ??
      o.display_name;

    const currentPrice = normalizeShopeePrice(
      o.price ??
      o.price_min ??
      o.priceMin ??
      o.current_price ??
      o.sale_price ??
      o.final_price ??
      o.price_min_before_discount
    );

    const originalPrice = normalizeShopeePrice(
      o.price_before_discount ??
      o.original_price ??
      o.price_original ??
      o.price_before ??
      o.price_max_before_discount
    );

    const hasSignals =
      title ||
      o.itemid ||
      o.item_id ||
      o.shopid ||
      o.shop_id ||
      o.images ||
      o.image ||
      o.image_list;

    if (!hasSignals || !(currentPrice > 0)) return;

    const imageCandidates = [];

    if (Array.isArray(o.images)) imageCandidates.push(...o.images);
    if (Array.isArray(o.image_list)) imageCandidates.push(...o.image_list);
    if (Array.isArray(o.image_urls)) imageCandidates.push(...o.image_urls);

    imageCandidates.push(
      o.image,
      o.image_url,
      o.cover,
      o.cover_image
    );

    const images = uniqueStrings(
      imageCandidates.map(imageUrlFromShopee)
    );

    const product = {
      title: title ? String(title).trim() : undefined,
      currentPrice,
      originalPrice:
        originalPrice && originalPrice > currentPrice
          ? originalPrice
          : undefined,
      images,
      rating: toNumber(
        o.item_rating?.rating_star ??
        o.rating_star ??
        o.rating ??
        o.rating_avg
      ),
      soldCount: toNumber(
        o.historical_sold ??
        o.sold ??
        o.sold_count ??
        o.global_sold
      ),
      sellerName:
        o.shop_name ??
        o.shop?.name ??
        o.seller_name ??
        o.shop_info?.name ??
        undefined,
      canonicalUrl,
      source
    };

    const score =
      (product.title ? 5 : 0) +
      (product.currentPrice ? 6 : 0) +
      (product.images.length ? 3 : 0) +
      (product.originalPrice ? 1 : 0) +
      (product.sellerName ? 1 : 0) +
      (product.rating ? 1 : 0);

    if (!best || score > best.score) {
      best = { score, product };
    }
  });

  return best?.product || null;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio"
      ]
    }).catch(err => {
      browserPromise = null;
      throw err;
    });
  }

  return browserPromise;
}

async function waitForStableUrl(page, maxMs = 8000) {
  let last = page.url();
  let stableFor = 0;
  const step = 500;

  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    await sleep(step);

    const now = page.url();

    if (now === last) {
      stableFor += step;
      if (stableFor >= 1500) return now;
    } else {
      last = now;
      stableFor = 0;
    }
  }

  return page.url();
}

function parseJsonLoose(text) {
  if (!text) return null;

  const trimmed = String(text).trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  return null;
}

async function extractFromScripts(page, canonicalUrl) {
  const scriptPayloads = await page.evaluate(() => {
    const out = [];

    for (const s of document.querySelectorAll("script")) {
      const txt = s.textContent || "";

      if (
        txt.length > 20 &&
        txt.length < 2_500_000 &&
        (
          txt.includes('"price"') ||
          txt.includes('"price_min"') ||
          txt.includes('"itemid"') ||
          txt.includes('"item_id"') ||
          txt.includes('"product"')
        )
      ) {
        out.push(txt);
      }
    }

    return out.slice(0, 60);
  }).catch(() => []);

  let best = null;

  for (const raw of scriptPayloads) {
    // JSON puro.
    const direct = parseJsonLoose(raw);
    if (direct) {
      const p = productFromJson(direct, canonicalUrl, "script_json");
      if (p?.currentPrice && (!best || (p.images?.length || 0) > (best.images?.length || 0))) {
        best = p;
      }
    }

    // Alguns scripts guardam JSON dentro de uma atribuição JS.
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const maybe = raw.slice(firstBrace, lastBrace + 1);
      const parsed = parseJsonLoose(maybe);

      if (parsed) {
        const p = productFromJson(parsed, canonicalUrl, "script_embedded_json");
        if (p?.currentPrice && (!best || (p.images?.length || 0) > (best.images?.length || 0))) {
          best = p;
        }
      }
    }
  }

  return best;
}


function extractIdsFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:[^/]+\/)?(\d+)\/(\d+)(?:\/|$)/);
    if (m) return { shopId: m[1], itemId: m[2] };

    const itemId = u.searchParams.get("itemid") || u.searchParams.get("item_id");
    const shopId = u.searchParams.get("shopid") || u.searchParams.get("shop_id");
    if (itemId && shopId) return { shopId, itemId };
  } catch {}
  return { shopId: undefined, itemId: undefined };
}

async function fetchProductInsideBrowser(page, canonicalUrl) {
  const { shopId, itemId } = extractIdsFromUrl(canonicalUrl);
  if (!shopId || !itemId) {
    log("BROWSER API SKIP", "shopId/itemId não encontrados");
    return null;
  }

  const result = await page.evaluate(async ({ shopId, itemId }) => {
    const csrfMatch = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : "";

    const endpoints = [
      `/api/v4/item/get?itemid=${encodeURIComponent(itemId)}&shopid=${encodeURIComponent(shopId)}`,
      `/api/v4/pdp/get_pc?item_id=${encodeURIComponent(itemId)}&shop_id=${encodeURIComponent(shopId)}`
    ];

    const attempts = [];

    for (const endpoint of endpoints) {
      try {
        const headers = {
          "accept": "application/json, text/plain, */*",
          "x-api-source": "pc"
        };
        if (csrf) headers["x-csrftoken"] = csrf;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        let response;
        try {
          response = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
            headers,
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }

        const txt = await response.text();
        let data = null;
        try { data = JSON.parse(txt); } catch {}

        attempts.push({
          endpoint,
          status: response.status,
          ok: response.ok,
          data,
          text: data ? undefined : txt.slice(0, 5000)
        });

        if (response.ok && data) {
          return {
            success: true,
            endpoint,
            status: response.status,
            data,
            attempts
          };
        }
      } catch (err) {
        attempts.push({
          endpoint,
          error: err?.message || String(err)
        });
      }
    }

    return { success: false, attempts };
  }, { shopId, itemId }).catch(err => ({
    success: false,
    evaluateError: err?.message || String(err),
    attempts: []
  }));

  for (const attempt of result.attempts || []) {
    log("BROWSER API", {
      endpoint: attempt.endpoint,
      status: attempt.status,
      ok: attempt.ok,
      error: attempt.error
    });
  }

  if (result.success && result.data) {
    const p = productFromJson(result.data, canonicalUrl, "browser_same_origin_api");
    if (p?.currentPrice) return p;
  }

  return null;
}

function productFromRawText(raw, canonicalUrl) {
  if (!raw) return null;
  const txt = String(raw);

  const pricePatterns = [
    /["']price["']\s*:\s*(\d{3,})/gi,
    /["']price_min["']\s*:\s*(\d{3,})/gi,
    /["']current_price["']\s*:\s*(\d{3,})/gi,
    /\\"price\\"\s*:\s*(\d{3,})/gi,
    /\\"price_min\\"\s*:\s*(\d{3,})/gi
  ];

  const prices = [];
  for (const rx of pricePatterns) {
    let m;
    while ((m = rx.exec(txt)) && prices.length < 100) {
      const n = normalizeShopeePrice(m[1]);
      if (n && n > 0 && n < 1000000) prices.push(n);
    }
  }

  if (!prices.length) return null;

  const uniquePrices = [...new Set(prices)];
  const currentPrice = uniquePrices[0];

  const titlePatterns = [
    /["']name["']\s*:\s*"([^"]{4,300})"/i,
    /["']item_name["']\s*:\s*"([^"]{4,300})"/i,
    /\\"name\\"\s*:\s*\\"([^"]{4,300})\\"/i
  ];

  let title;
  for (const rx of titlePatterns) {
    const m = txt.match(rx);
    if (m?.[1]) {
      title = m[1]
        .replace(/\\u([\da-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .trim();
      if (title) break;
    }
  }

  const imageMatches = [];
  const imagePatterns = [
    /["']image["']\s*:\s*"([^"]{10,500})"/gi,
    /["']image_url["']\s*:\s*"([^"]{10,500})"/gi,
    /\\"image\\"\s*:\s*\\"([^"]{10,500})\\"/gi
  ];

  for (const rx of imagePatterns) {
    let m;
    while ((m = rx.exec(txt)) && imageMatches.length < 20) {
      imageMatches.push(m[1].replace(/\\\//g, "/"));
    }
  }

  const images = uniqueStrings(imageMatches.map(imageUrlFromShopee));

  const larger = uniquePrices.find(p => p > currentPrice);

  return {
    title: title || undefined,
    currentPrice,
    originalPrice: larger,
    images,
    rating: undefined,
    soldCount: undefined,
    sellerName: undefined,
    canonicalUrl,
    source: "raw_text_fallback"
  };
}

async function extractFromPageSource(page, canonicalUrl) {
  const html = await page.content().catch(() => "");
  const fromHtml = productFromRawText(html, canonicalUrl);
  if (fromHtml?.currentPrice) return fromHtml;

  const scripts = await page.evaluate(() =>
    [...document.scripts]
      .map(s => s.textContent || "")
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .slice(0, 80)
  ).catch(() => []);

  for (const raw of scripts) {
    const p = productFromRawText(raw, canonicalUrl);
    if (p?.currentPrice) return p;
  }

  return null;
}

async function scrapeShopee(rawUrl) {
  const safeUrl = assertShopeeUrl(rawUrl);
  const browser = await getBrowser();

  const context = await browser.newContext({
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(5000);

  // Economia de RAM/tempo sem bloquear scripts/XHR.
  await page.route("**/*", async route => {
    const type = route.request().resourceType();

    if (["font", "media"].includes(type)) {
      return route.abort();
    }

    return route.continue();
  });

  let networkProduct = null;
  const networkDiagnostics = [];
  const seenDiagnosticPaths = new Set();

  page.on("response", async response => {
    try {
      const url = response.url();

      if (!/shopee\.com\.br|shopeeusercontent\.com|susercontent\.com/i.test(url)) {
        return;
      }

      const contentType = String(response.headers()["content-type"] || "");
      const resourceType = response.request().resourceType();

      let safeEndpoint = url;
      try {
        const u = new URL(url);
        safeEndpoint = `${u.origin}${u.pathname}`;
      } catch {}

      if (
        ["xhr", "fetch"].includes(resourceType) &&
        !seenDiagnosticPaths.has(safeEndpoint) &&
        networkDiagnostics.length < 50
      ) {
        seenDiagnosticPaths.add(safeEndpoint);

        const info = {
          status: response.status(),
          type: resourceType,
          contentType,
          url: safeEndpoint
        };

        networkDiagnostics.push(info);
        log("NETWORK ENDPOINT", info);
      }

      if (!contentType.includes("json")) return;

      const data = await response.json().catch(() => null);
      if (!data) return;

      const p = productFromJson(data, page.url() || safeUrl, "network_json");

      if (
        p?.currentPrice &&
        (
          !networkProduct ||
          (p.images?.length || 0) > (networkProduct.images?.length || 0)
        )
      ) {
        log("NETWORK PRODUCT CANDIDATE", {
          currentPrice: p.currentPrice,
          title: p.title?.slice(0, 120),
          endpoint: safeEndpoint
        });

        networkProduct = p;
      }
    } catch {}
  });

  try {
    log("OPEN", safeUrl);

    try {
      await page.goto(safeUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT
      });
    } catch (err) {
      // Links curtos da Shopee podem destruir o contexto durante o redirecionamento.
      log("NAVIGATION NOTICE", err?.message || String(err));
    }

    const canonicalUrl = await waitForStableUrl(page, 12000);

    const final = new URL(canonicalUrl);

    if (!isShopeeHost(final.hostname)) {
      throw new Error("O link redirecionou para um domínio não autorizado.");
    }

    log("FINAL URL", canonicalUrl);

    // Se a rede já entregou o produto, não esperamos mais.
    if (networkProduct?.currentPrice) {
      networkProduct.canonicalUrl = canonicalUrl;
      log("FOUND VIA NETWORK");
      return networkProduct;
    }

    // Dá uma chance curta para chamadas XHR que chegam logo depois do redirecionamento.
    await sleep(1800);

    if (networkProduct?.currentPrice) {
      networkProduct.canonicalUrl = canonicalUrl;
      log("FOUND VIA NETWORK AFTER WAIT");
      return networkProduct;
    }

    // Tenta a API da Shopee a partir do próprio navegador, com cookies/sessão.
    let browserApiProduct = null;
    try {
      browserApiProduct = await Promise.race([
        fetchProductInsideBrowser(page, canonicalUrl),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Browser API timeout interno")), 20000)
        )
      ]);
    } catch (err) {
      log("BROWSER API FALLBACK", err?.message || String(err));
    }

    if (browserApiProduct?.currentPrice) {
      log("FOUND VIA BROWSER API");
      return browserApiProduct;
    }

    // Procura JSON embutido na página.
    const scriptProduct = await extractFromScripts(page, canonicalUrl);

    if (scriptProduct?.currentPrice) {
      log("FOUND VIA SCRIPT");
      return scriptProduct;
    }

    // Procura campos de preço/nome/imagem no HTML e scripts mesmo quando
    // eles não formam JSON puro.
    const sourceProduct = await extractFromPageSource(page, canonicalUrl);
    if (sourceProduct?.currentPrice) {
      log("FOUND VIA PAGE SOURCE");
      return sourceProduct;
    }

    let dom = null;
    let lastEvaluateError = null;

    // A Shopee pode fazer mais uma navegação client-side mesmo depois
    // de a URL já parecer estável. Em vez de falhar, tentamos novamente.
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await sleep(1500);

        dom = await page.evaluate(() => {
          const text = sel =>
            document.querySelector(sel)?.textContent?.trim() || undefined;

          const attr = (sel, name) =>
            document.querySelector(sel)?.getAttribute(name) || undefined;

          const metas = {};

          for (const m of document.querySelectorAll("meta")) {
            const key = m.getAttribute("property") || m.getAttribute("name");
            const val = m.getAttribute("content");
            if (key && val) metas[key] = val;
          }

          const bodyText = document.body?.innerText || "";

          return {
            title:
              text("h1") ||
              metas["og:title"] ||
              document.title ||
              undefined,

            image:
              metas["og:image"] ||
              metas["twitter:image"] ||
              attr('link[rel="image_src"]', "href"),

            metaPrice:
              metas["product:price:amount"] ||
              metas["og:price:amount"] ||
              metas["product:price"] ||
              metas["twitter:data1"],

            bodyText: bodyText.slice(0, 100000)
          };
        });

        log("DOM READ SUCCESS", { attempt, url: page.url() });
        break;
      } catch (err) {
        lastEvaluateError = err;
        const msg = err?.message || String(err);

        log("DOM READ RETRY", { attempt, message: msg, url: page.url() });

        if (
          /Execution context was destroyed|navigation|Target page, context or browser has been closed/i.test(msg)
        ) {
          await sleep(2000);
          continue;
        }

        throw err;
      }
    }

    if (!dom) {
      throw new Error(
        `Falha ao ler a página após várias tentativas: ${
          lastEvaluateError?.message || "erro desconhecido"
        }`
      );
    }

    const challenge =
      /captcha|verifique|verification|unusual|robô|robot|access denied|bloquead/i
        .test(dom.bodyText || "");

    if (challenge) {
      throw new Error("Shopee apresentou verificação/bloqueio ao navegador online.");
    }

    const priceMatches = [
      ...String(dom.bodyText || "").matchAll(/R\$\s*([\d.]+,\d{2})/g)
    ]
      .map(m => toNumber(m[1]))
      .filter(n => n && n > 0 && n < 1000000);

    const currentPrice =
      normalizeShopeePrice(dom.metaPrice) ||
      priceMatches[0];

    const originalPrice =
      priceMatches.find(p => p > currentPrice) || undefined;

    if (!(currentPrice > 0)) {
      log("NETWORK DIAGNOSTIC SUMMARY", {
        endpointsSeen: networkDiagnostics.length,
        productCandidateFound: Boolean(networkProduct?.currentPrice),
        endpoints: networkDiagnostics.slice(-25)
      });

      throw new Error("Preço não encontrado na página renderizada.");
    }

    log("FOUND VIA DOM");

    return {
      title: dom.title || "Produto Shopee",
      currentPrice,
      originalPrice,
      images: uniqueStrings([dom.image]),
      rating: undefined,
      soldCount: undefined,
      sellerName: undefined,
      canonicalUrl,
      source: "dom"
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Oferta Express Bridge",
    version: "6.0",
    mode: "Playwright/Chromium"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Oferta Express Bridge",
    version: "6.0",
    tokenConfigured: Boolean(BRIDGE_TOKEN)
  });
});

app.post("/resolve", async (req, res) => {
  if (!authOk(req)) {
    return res.status(401).json({
      ok: false,
      error: "Não autorizado."
    });
  }

  const url = req.body?.url;

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: "Campo url é obrigatório."
    });
  }

  const started = Date.now();

  try {
    const product = await scrapeShopee(url);

    log("SUCCESS", {
      ms: Date.now() - started,
      source: product.source,
      title: product.title,
      currentPrice: product.currentPrice,
      images: product.images?.length || 0
    });

    return res.json({
      ok: true,
      product
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log("ERROR", {
      ms: Date.now() - started,
      message
    });

    return res.status(502).json({
      ok: false,
      error: message
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Rota não encontrada."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  log(`Oferta Express Bridge v6 online na porta ${PORT}`);

  if (!BRIDGE_TOKEN) {
    log("ATENÇÃO: configure BRIDGE_TOKEN antes de usar /resolve.");
  }
});

async function shutdown() {
  try {
    const browser = await browserPromise;
    if (browser) await browser.close();
  } catch {}

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
