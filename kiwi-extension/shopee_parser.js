(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShopeeParser = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PRICE_DIVISOR = 100000;
  const SHOPEE_IMG_BASE = "https://down-id.img.susercontent.com/file/";

  function extractFirstUrl(rawText) {
    if (!rawText || typeof rawText !== "string") return null;
    const match = rawText.match(/https?:\/\/[^\s<>"')\]}]+/i);
    if (!match) return null;
    return match[0].replace(/[.,;!?]+$/, "");
  }

  /**
   * Ekstrak shop_id dan item_id dari berbagai format URL Shopee:
   * - https://shopee.co.id/product/12345/67890
   * - https://shopee.co.id/universal-link/product/12345/67890
   * - https://shopee.co.id/opaanlp/12345/67890
   * - https://shopee.co.id/Nama-Produk-i.12345.67890
   * - ?shop_id=12345&item_id=67890 / ?shopid=12345&itemid=67890
   * - Nested encoded param ?ulp=https%3A%2F%2Fshopee.co.id%2F...
   */
  function extractShopeeIds(urlStr, depth) {
    const currentDepth = depth || 0;
    if (!urlStr || currentDepth > 3) return null;

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (_) {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "";

    // 1. Nested redirect params (ulp, origin_link, next, redirect, url, target)
    for (const key of [
      "origin_link",
      "ulp",
      "next",
      "url",
      "redirect",
      "target",
      "dl_target_url",
    ]) {
      const nested = parsed.searchParams.get(key);
      if (nested) {
        try {
          const decoded = decodeURIComponent(nested);
          const found = extractShopeeIds(decoded, currentDepth + 1);
          if (found) return found;
        } catch (_) {
          // ignore malformed nested param
        }
      }
    }

    // 2. /product/{shopId}/{itemId} or /universal-link/product/{shopId}/{itemId}
    let m = path.match(/\/product\/(\d+)\/(\d+)/i);
    if (m) {
      return { shopId: m[1], itemId: m[2], domain: normalizeShopeeDomain(host) };
    }

    // 3. /opaanlp/{shopId}/{itemId} (Shopee affiliate redirect landing path)
    m = path.match(/\/opaanlp\/(\d+)\/(\d+)/i);
    if (m) {
      return { shopId: m[1], itemId: m[2], domain: normalizeShopeeDomain(host) };
    }

    // 4. Slug -i.{shopId}.{itemId}
    m = path.match(/-i\.(\d+)\.(\d+)(?:$|[/?#])/i) || path.match(/\/i\.(\d+)\.(\d+)(?:$|[/?#])/i);
    if (m) {
      return { shopId: m[1], itemId: m[2], domain: normalizeShopeeDomain(host) };
    }

    // 5. /{shopUsername}/{itemId} on shopee domain (2 numeric or username + numeric id >= 6 digits)
    if (isShopeeDomain(host)) {
      const itemParam = parsed.searchParams.get("item_id") || parsed.searchParams.get("itemid");
      const shopParam = parsed.searchParams.get("shop_id") || parsed.searchParams.get("shopid");
      if (shopParam && itemParam && /^\d+$/.test(shopParam) && /^\d+$/.test(itemParam)) {
        return { shopId: shopParam, itemId: itemParam, domain: normalizeShopeeDomain(host) };
      }
    }

    return null;
  }

  function isShopeeDomain(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    return (
      h.includes("shopee.") ||
      h.endsWith("shp.ee") ||
      h.endsWith("shope.ee")
    );
  }

  function isShortShopeeUrl(urlStr) {
    try {
      const h = new URL(urlStr).hostname.toLowerCase();
      return (
        h.startsWith("s.shopee.") ||
        h.endsWith("shp.ee") ||
        h.endsWith("shope.ee")
      );
    } catch (_) {
      return false;
    }
  }

  function normalizeShopeeDomain(host) {
    if (!host) return "shopee.co.id";
    const m = host.match(/shopee\.[a-z.]+$/i);
    if (m) return m[0].toLowerCase();
    return "shopee.co.id";
  }

  function buildCleanProductUrl(shopId, itemId, domain) {
    const d = domain || "shopee.co.id";
    return `https://${d}/product/${shopId}/${itemId}`;
  }

  function normalizeShopeePrice(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n === 0) return 0;
    // Shopee API stores prices as integer * 100000
    return Math.round(n / PRICE_DIVISOR);
  }

  function toImageUrl(hashOrUrl) {
    if (!hashOrUrl || typeof hashOrUrl !== "string") return null;
    if (/^https?:\/\//i.test(hashOrUrl)) return hashOrUrl;
    return SHOPEE_IMG_BASE + hashOrUrl.replace(/^\/+/, "");
  }

  function extractVideoInfo(data, item) {
    const candidates = [];
    const pi = (data && data.product_images) || {};

    if (Array.isArray(pi.shopee_video_info_list)) {
      candidates.push(...pi.shopee_video_info_list);
    }
    if (pi.video && typeof pi.video === "object") {
      candidates.push(pi.video);
    }
    if (item && Array.isArray(item.video_info_list)) {
      candidates.push(...item.video_info_list);
    }

    for (const v of candidates) {
      if (!v || typeof v !== "object") continue;
      if (v.default_format && v.default_format.url) {
        return {
          videoUrl: v.default_format.url,
          coverUrl: toImageUrl(v.thumb_url || v.cover),
          durationSec: v.duration || (v.default_format && v.default_format.duration) || null,
        };
      }
      if (Array.isArray(v.formats) && v.formats.length > 0) {
        const best = v.formats.find((f) => f && f.url) || null;
        if (best) {
          return {
            videoUrl: best.url,
            coverUrl: toImageUrl(v.thumb_url || v.cover),
            durationSec: v.duration || best.duration || null,
          };
        }
      }
      if (typeof v.video_url === "string" && v.video_url) {
        return {
          videoUrl: v.video_url,
          coverUrl: toImageUrl(v.thumb_url || v.cover),
          durationSec: v.duration || null,
        };
      }
    }
    return { videoUrl: null, coverUrl: null, durationSec: null };
  }

  function isShopeeProductApiUrl(urlStr) {
    if (!urlStr) return false;
    return (
      urlStr.includes("/api/v4/pdp/get_pc") ||
      urlStr.includes("/api/v4/pdp/get_rw") ||
      urlStr.includes("/api/v4/item/get?") ||
      urlStr.includes("/api/v2/item/get?")
    );
  }

  function isShopeeRatingsApiUrl(urlStr) {
    if (!urlStr) return false;
    return (
      urlStr.includes("/api/v4/item/get_ratings") ||
      urlStr.includes("/api/v2/item/get_ratings")
    );
  }

  function detectBlockedOrLoginState(currentUrl, bodyObj) {
    const u = (currentUrl || "").toLowerCase();
    if (u.includes("/buyer/login") || u.includes("is_logged_in=false")) {
      return { blocked: true, status: "NEED_LOGIN", reason: "Sesi Shopee di Kiwi Dev belum login / habis." };
    }
    if (u.includes("/verify/captcha") || u.includes("/verify/traffic")) {
      return { blocked: true, status: "CAPTCHA", reason: "Shopee meminta verifikasi captcha/traffic di Kiwi Dev." };
    }
    if (bodyObj && typeof bodyObj === "object") {
      const errCode = bodyObj.error;
      if (errCode === 90309999) {
        return {
          blocked: true,
          status: "RATE_LIMITED",
          reason: "Shopee mengembalikan kode anti-bot 90309999 (perlu login di Kiwi Dev atau jeda beberapa menit).",
        };
      }
    }
    return { blocked: false, status: null, reason: null };
  }

  /**
   * Parse response JSON dari /api/v4/pdp/get_pc, /api/v4/pdp/get_rw, atau /api/v4/item/get
   */
  function parseShopeePdpJson(rawBody, meta) {
    const bodyObj = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    if (!bodyObj || typeof bodyObj !== "object") {
      throw new Error("Empty or non-object JSON payload");
    }

    const blockCheck = detectBlockedOrLoginState(meta && meta.pageUrl, bodyObj);
    if (blockCheck.blocked) {
      const err = new Error(blockCheck.reason);
      err.captureStatus = blockCheck.status;
      throw err;
    }

    const data = bodyObj.data || {};
    // Support both pdp/get_pc (data.item) and item/get (data directly has itemid/name)
    const item = data.item || (data.itemid || data.item_id ? data : null);
    if (!item) {
      throw new Error("Field data.item tidak ditemukan pada response Shopee");
    }

    const shop = data.shop_detailed || data.shop_info || {};
    const review = data.product_review || item.item_rating || {};
    const productPrice = data.product_price || {};
    const pi = data.product_images || {};

    const shopId = String(
      item.shop_id || item.shopid || shop.shopid || shop.shop_id || (meta && meta.shopId) || ""
    );
    const itemId = String(
      item.item_id || item.itemid || (meta && meta.itemId) || ""
    );

    const title = item.title || item.name || "";
    const description = item.description || "";
    const brand = item.brand || null;

    const priceMin = normalizeShopeePrice(
      item.price_min !== undefined ? item.price_min : item.price
    );
    const priceMax =
      item.price_max !== undefined ? normalizeShopeePrice(item.price_max) : priceMin;
    const origPriceMin = normalizeShopeePrice(
      item.price_min_before_discount !== undefined
        ? item.price_min_before_discount
        : item.price_before_discount
    );

    let voucherPrice = null;
    if (productPrice && productPrice.has_final_price && productPrice.price) {
      voucherPrice = normalizeShopeePrice(
        productPrice.price.single_value || productPrice.price.range_min
      );
    }

    // Images (preserve all unique HD image URLs)
    const rawImages = []
      .concat(Array.isArray(pi.images) ? pi.images : [])
      .concat(Array.isArray(item.images) ? item.images : [])
      .concat(item.image ? [item.image] : []);
    const imageSet = new Set();
    for (const img of rawImages) {
      const full = toImageUrl(img);
      if (full) imageSet.add(full);
    }

    // Tier variations & variant images
    const tiers = [];
    for (const t of item.tier_variations || []) {
      if (!t) continue;
      const tierImages = Array.isArray(t.images)
        ? t.images.map(toImageUrl).filter(Boolean)
        : [];
      for (const ti of tierImages) imageSet.add(ti);
      tiers.push({
        name: t.name || "",
        options: Array.isArray(t.options) ? t.options : [],
        images: tierImages,
      });
    }

    // Models / SKU variants
    const variants = [];
    let computedTotalStock = 0;
    let hasNumericModelStock = false;
    for (const m of item.models || []) {
      if (!m) continue;
      const mStock = typeof m.stock === "number" ? m.stock : null;
      if (mStock !== null) {
        hasNumericModelStock = true;
        computedTotalStock += mStock;
      }
      const inStock =
        m.has_stock !== undefined
          ? Boolean(m.has_stock) && !m.is_grayout
          : mStock === null || mStock > 0;
      variants.push({
        modelId: m.model_id || m.modelid || null,
        name: m.name || "",
        price: normalizeShopeePrice(m.price),
        originalPrice: normalizeShopeePrice(m.price_before_discount),
        stock: mStock,
        inStock: inStock,
      });
    }

    const stock =
      typeof item.stock === "number"
        ? item.stock
        : hasNumericModelStock
        ? computedTotalStock
        : null;

    const videoInfo = extractVideoInfo(data, item);

    const ratingStar =
      typeof review.rating_star === "number"
        ? Number(review.rating_star.toFixed(2))
        : item.item_rating && typeof item.item_rating.rating_star === "number"
        ? Number(item.item_rating.rating_star.toFixed(2))
        : null;

    const ratingCount =
      review.total_rating_count ??
      (Array.isArray(review.rating_count) ? review.rating_count[0] : null) ??
      null;

    const soldCount =
      review.historical_sold ??
      item.historical_sold ??
      item.sold ??
      data.historical_sold ??
      null;

    const domain =
      (meta && meta.domain) ||
      (meta && meta.pageUrl ? normalizeShopeeDomain(new URL(meta.pageUrl).hostname) : "shopee.co.id");

    const cleanUrl =
      shopId && itemId
        ? buildCleanProductUrl(shopId, itemId, domain)
        : (meta && meta.pageUrl) || "";

    const images = Array.from(imageSet);

    return {
      sourcePlatform: "shopee",
      canonicalKey: shopId && itemId ? `shopee:${shopId}:${itemId}` : `url:${cleanUrl}`,
      shopId: shopId || null,
      itemId: itemId || null,
      affiliateUrl: (meta && meta.affiliateUrl) || null,
      cleanUrl: cleanUrl,
      title: title,
      brand: brand,
      description: description,
      currency: item.currency || "IDR",
      priceMin: priceMin,
      priceMax: priceMax,
      originalPrice: origPriceMin,
      voucherPrice: voucherPrice,
      discountPercent: item.raw_discount ?? item.show_discount ?? null,
      stock: stock,
      soldCount: soldCount,
      ratingStar: ratingStar,
      ratingCount: ratingCount,
      shopName: shop.name || item.shop_name || null,
      shopLocation: item.shop_location || shop.shop_location || null,
      isOfficialShop: Boolean(shop.is_official_shop || item.is_official_shop),
      videoUrl: videoInfo.videoUrl,
      videoCoverUrl: videoInfo.coverUrl,
      videoDurationSec: videoInfo.durationSec,
      coverImageUrl: images[0] || null,
      images: images,
      tiers: tiers,
      variants: variants,
      topReviews: [],
    };
  }

  /**
   * Parse ulasan teratas dari /api/v4/item/get_ratings untuk bahan riset konten Shopee Video
   */
  function parseShopeeRatingsJson(rawBody) {
    try {
      const obj = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      const ratings = (obj && obj.data && obj.data.ratings) || [];
      if (!Array.isArray(ratings)) return [];
      return ratings
        .filter((r) => r && (r.comment || (Array.isArray(r.images) && r.images.length > 0)))
        .slice(0, 10)
        .map((r) => ({
          author: r.author_username || "pembeli",
          rating: r.rating_star || 5,
          comment: (r.comment || "").trim(),
          modelName:
            Array.isArray(r.product_items) && r.product_items[0]
              ? r.product_items[0].model_name || null
              : null,
          images: Array.isArray(r.images) ? r.images.map(toImageUrl).filter(Boolean) : [],
        }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Fallback parser untuk web umum (Tokopedia, Lazada, TikTok Shop, web toko lain)
   * dari ld+json / OpenGraph meta yang dikirim content_bridge.js
   */
  function parseGenericPageMetadata(pageMeta, jobMeta) {
    const cleanUrl = (pageMeta && pageMeta.url) || (jobMeta && jobMeta.cleanUrl) || "";
    let host = "web";
    try {
      host = new URL(cleanUrl).hostname.replace(/^www\./i, "");
    } catch (_) {
      // ignore
    }

    const ld = (pageMeta && pageMeta.ldProduct) || {};
    const offers = Array.isArray(ld.offers) ? ld.offers[0] || {} : ld.offers || {};
    const rawPrice =
      offers.lowPrice ?? offers.price ?? (pageMeta && pageMeta.metaPrice) ?? null;
    const parsedPrice =
      rawPrice !== null && rawPrice !== undefined && rawPrice !== ""
        ? Math.round(Number(String(rawPrice).replace(/[^\d.]/g, "")))
        : null;

    const images = [];
    if (Array.isArray(ld.image)) {
      images.push(...ld.image.filter((x) => typeof x === "string"));
    } else if (typeof ld.image === "string") {
      images.push(ld.image);
    }
    if (pageMeta && pageMeta.ogImage && !images.includes(pageMeta.ogImage)) {
      images.push(pageMeta.ogImage);
    }

    return {
      sourcePlatform: host,
      canonicalKey: `url:${cleanUrl}`,
      shopId: null,
      itemId: null,
      affiliateUrl: (jobMeta && jobMeta.affiliateUrl) || cleanUrl,
      cleanUrl: cleanUrl,
      title: ld.name || (pageMeta && (pageMeta.ogTitle || pageMeta.title)) || cleanUrl,
      brand: (ld.brand && (ld.brand.name || ld.brand)) || null,
      description:
        ld.description || (pageMeta && (pageMeta.ogDescription || pageMeta.description)) || "",
      currency: offers.priceCurrency || (pageMeta && pageMeta.metaCurrency) || "IDR",
      priceMin: Number.isFinite(parsedPrice) ? parsedPrice : null,
      priceMax: Number.isFinite(parsedPrice) ? parsedPrice : null,
      originalPrice: null,
      voucherPrice: null,
      discountPercent: null,
      stock: null,
      soldCount: null,
      ratingStar:
        ld.aggregateRating && ld.aggregateRating.ratingValue
          ? Number(ld.aggregateRating.ratingValue)
          : null,
      ratingCount:
        ld.aggregateRating && ld.aggregateRating.reviewCount
          ? Number(ld.aggregateRating.reviewCount)
          : null,
      shopName: host,
      shopLocation: null,
      isOfficialShop: false,
      videoUrl: (pageMeta && pageMeta.ogVideo) || null,
      videoCoverUrl: images[0] || null,
      videoDurationSec: null,
      coverImageUrl: images[0] || null,
      images: images,
      tiers: [],
      variants: [],
      topReviews: [],
    };
  }

  return {
    PRICE_DIVISOR,
    extractFirstUrl,
    extractShopeeIds,
    isShopeeDomain,
    isShortShopeeUrl,
    normalizeShopeeDomain,
    buildCleanProductUrl,
    normalizeShopeePrice,
    toImageUrl,
    isShopeeProductApiUrl,
    isShopeeRatingsApiUrl,
    detectBlockedOrLoginState,
    parseShopeePdpJson,
    parseShopeeRatingsJson,
    parseGenericPageMetadata,
  };
});
