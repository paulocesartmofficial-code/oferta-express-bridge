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
  const header = String(req.headers.authorization || "");
  return header === `Bearer ${BRIDGE_TOKEN}`;
}

function toNumber(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;

  const s = String(v).trim();
  if (!s) return undefined;

  // Formatos BR: 1.299,90 / R$ 89,90
  if (/[,.]/.test(s)) {
    const cleaned = s.replace(/[^\d,.-]/g, "");
    if (cleaned.includes(",")) {
      const n = Number(cleaned.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    }
  }

  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function normalizeShopeePrice(v) {
  const n = toNumber(v);
  if (n === undefined) return undefined;

  // A API da Shopee frequentemente usa preço x100000.
  if (n >= 100000) return Math.round((n / 100000) * 100) / 100;
  return Math.round(n * 100) / 100;
}

function uniqueStrings(values) {
  return [...new Set(
    values
      .flat()
      .filter(Boolean)
      .map(v => String(v).trim())
      .filter(Boolean)
  )];
}

function walk(obj, visit, depth = 0) {
  if (!obj || depth > 10) return;
  if (Array.isArray(obj)) {
    for (const v of obj.slice(0, 300)) walk(v, visit, depth + 1);
    return;
  }
  if (typeof obj !== "object") return;
  visit(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") walk(v, visit, depth + 1);
  }
}

function productFromApiJson(data, canonicalUrl) {
  let best = null;

  walk(data, (o) => {
    const title = o.name || o.title || o.item_name;
    const rawPrice =
      o.price ?? o.price_min ?? o.priceMin ?? o.current_price ??
      o.sale_price ?? o.final_price;
    const price = normalizeShopeePrice(rawPrice);

    const hasProductSignals =
      title ||
      o.itemid || o.item_id ||
      o.shopid || o.shop_id ||
      o.images || o.image;

    if (!hasProductSignals || !(price > 0)) return;

    const imgs = [];
    if (Array.isArray(o.images)) imgs.push(...o.images);
    if (o.image) imgs.push(o.image);
    if (Array.isArray(o.image_list)) imgs.push(...o.image_list);

    const imageUrls = uniqueStrings(imgs).map(img => {
      if (/^https?:\/\//i.test(img)) return img;
      return `https://down-br.img.susercontent.com/file/${img}`;
    });

    const candidate = {
      title: title ? String(title).trim() : undefined,
      currentPrice: price,
      originalPrice: normalizeShopeePrice(
        o.price_before_discount ??
        o.original_price ??
        o.price_original ??
        o.price_before
      ),
      images: imageUrls,
      rating: toNumber(
        o.item_rating?.rating_star ??
        o.rating_star ??
        o.rating
      ),
      soldCount: toNumber(
        o.historical_sold ??
        o.sold ??
        o.sold_count
      ),
      sellerName:
        o.shop_name ??
        o.shop?.name ??
        o.seller_name ??
        undefined,
      canonicalUrl,
      source: "online_playwright_api"
    };

    const score =
      (candidate.title ? 3 : 0) +
      (candidate.images.length ? 2 : 0) +
      (candidate.currentPrice ? 4 : 0) +
      (candidate.sellerName ? 1 : 0);

    if (!best || score > best.score) best = { score, product: candidate };
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
  page.setDefaultTimeout(8000);

  let apiProduct = null;

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!/shopee\.com\.br/i.test(url)) return;
      if (!/api|pdp|item|get_pc|detail/i.test(url)) return;

      const ct = String(response.headers()["content-type"] || "");
      if (!ct.includes("json")) return;

      const data = await response.json().catch(() => null);
      if (!data) return;

      const p = productFromApiJson(data, page.url() || safeUrl);
      if (p?.currentPrice && !apiProduct) {
        apiProduct = p;
      }
    } catch {}
  });

  try {
  await page.goto(safeUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT
  });
} catch (err) {
  log("NAVIGATION NOTICE", err?.message || String(err));
}

// Links curtos da Shopee fazem vários redirecionamentos.
// Esperamos a URL parar de mudar antes de tentar ler o produto.
let ultimaUrl = page.url();
let urlEstavel = 0;

for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);

  const urlAtual = page.url();

  if (urlAtual === ultimaUrl) {
    urlEstavel++;

    if (urlEstavel >= 3) {
      break;
    }
  } else {
    ultimaUrl = urlAtual;
    urlEstavel = 0;
  }
}

log("FINAL URL", page.url());

// Espera a aplicação da Shopee carregar os dados dinâmicos.
await page.waitForTimeout(5000);

    // O link curto pode ter redirecionado para um host final da Shopee.
    const canonicalUrl = page.url();
    const final = new URL(canonicalUrl);
    if (!isShopeeHost(final.hostname)) {
      throw new Error("O link redirecionou para um domínio não autorizado.");
    }

    // Dá um pouco mais de tempo caso a API de produto esteja chegando após o DOM.
    if (!apiProduct) {
      await page.waitForTimeout(1800);
    }

    if (apiProduct?.currentPrice > 0) {
      apiProduct.canonicalUrl = canonicalUrl;
      return apiProduct;
    }

    const dom = await page.evaluate(() => {
      const text = (sel) => {
        const el = document.querySelector(sel);
        return el?.textContent?.trim() || undefined;
      };

      const attr = (sel, name) =>
        document.querySelector(sel)?.getAttribute(name) || undefined;

      const metas = {};
      for (const m of document.querySelectorAll("meta")) {
        const key = m.getAttribute("property") || m.getAttribute("name");
        const val = m.getAttribute("content");
        if (key && val) metas[key] = val;
      }

      const jsonLd = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(s.textContent || "");
          if (Array.isArray(parsed)) jsonLd.push(...parsed);
          else jsonLd.push(parsed);
        } catch {}
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
          attr('link[rel="image_src"]', "href"),
        metaPrice:
          metas["product:price:amount"] ||
          metas["og:price:amount"] ||
          metas["product:price"],
        jsonLd,
        bodyText: bodyText.slice(0, 60000)
      };
    });

    // JSON-LD
    for (const block of dom.jsonLd || []) {
      const candidates = block?.["@graph"] || [block];
      for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        const type = String(item["@type"] || "").toLowerCase();
        if (type && !type.includes("product")) continue;

        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        const price = normalizeShopeePrice(
          offers?.price ?? offers?.lowPrice ?? dom.metaPrice
        );

        if (price > 0) {
          const imgs = Array.isArray(item.image) ? item.image : [item.image, dom.image];
          return {
            title: item.name || dom.title || "Produto Shopee",
            currentPrice: price,
            originalPrice: undefined,
            images: uniqueStrings(imgs),
            rating: toNumber(item.aggregateRating?.ratingValue),
            soldCount: undefined,
            sellerName:
              offers?.seller?.name ||
              item.brand?.name ||
              undefined,
            canonicalUrl,
            source: "online_playwright_jsonld"
          };
        }
      }
    }

    // Último fallback: texto visível + metadados.
    const priceMatches = [...String(dom.bodyText || "").matchAll(/R\$\s*([\d.]+,\d{2})/g)]
      .map(m => toNumber(m[1]))
      .filter(n => n && n > 0 && n < 1000000);

    const currentPrice =
      normalizeShopeePrice(dom.metaPrice) ||
      priceMatches[0];

    const originalPrice =
      priceMatches.length > 1 && priceMatches[1] > currentPrice
        ? priceMatches[1]
        : undefined;

    if (!(currentPrice > 0)) {
      const challenge =
        /captcha|verifique|verification|unusual|robô|robot/i.test(dom.bodyText || "");
      throw new Error(
        challenge
          ? "Shopee apresentou verificação/bloqueio ao navegador online."
          : "Preço não encontrado na página renderizada."
      );
    }

    return {
      title: dom.title || "Produto Shopee",
      currentPrice,
      originalPrice,
      images: uniqueStrings([dom.image]),
      rating: undefined,
      soldCount: undefined,
      sellerName: undefined,
      canonicalUrl,
      source: "online_playwright_dom"
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
    mode: "Playwright/Chromium"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Oferta Express Bridge",
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
    log("ERROR", message);

    return res.status(502).json({
      ok: false,
      error: message
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Rota não encontrada." });
});

app.listen(PORT, "0.0.0.0", () => {
  log(`Oferta Express Bridge online na porta ${PORT}`);
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
