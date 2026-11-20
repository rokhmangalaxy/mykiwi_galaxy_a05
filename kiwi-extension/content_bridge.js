(function () {
  "use strict";

  // Inject page_hook.js into MAIN world at document_start so Desktop Cloak & XHR listener run before Shopee scripts
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page_hook.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.onload = function () {
      script.remove();
    };
  } catch (_) {}

  // Bantu tampilan halaman Login PC Shopee di layar HP agar kode QR langsung muat & mudah di-screenshot
  try {
    const host = (location.hostname || "").toLowerCase();
    if (host.includes("shopee.") && location.pathname.indexOf("/buyer/login") === 0) {
      document.addEventListener("DOMContentLoaded", function () {
        let vp = document.querySelector('meta[name="viewport"]');
        if (!vp) {
          vp = document.createElement("meta");
          vp.name = "viewport";
          if (document.head) document.head.appendChild(vp);
        }
        vp.content = "width=1200, initial-scale=0.32, user-scalable=yes";
      });
    }
  } catch (_) {}

  // Forward captured API responses from MAIN world to Extension Background
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "SHOPVAULT_PAGE_HOOK" || msg.type !== "API_RESPONSE") {
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: "PAGE_API_CAPTURED",
        url: msg.url,
        status: msg.status,
        transport: msg.transport,
        body: msg.body,
        pageUrl: location.href,
        capturedAt: msg.capturedAt,
      });
    } catch (_) {}
  });

  function extractDomSnapshot() {
    let ldProduct = null;
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const el of scripts) {
        try {
          const parsed = JSON.parse(el.textContent || "");
          const items = Array.isArray(parsed)
            ? parsed
            : parsed && Array.isArray(parsed["@graph"])
            ? parsed["@graph"]
            : [parsed];
          for (const item of items) {
            if (item && (item["@type"] === "Product" || item["@type"] === "IndividualProduct")) {
              ldProduct = item;
              break;
            }
          }
          if (ldProduct) break;
        } catch (_) {}
      }
    } catch (_) {}

    function metaContent(selector) {
      const el = document.querySelector(selector);
      return el ? el.getAttribute("content") : null;
    }

    return {
      url: location.href,
      title: document.title || "",
      ogTitle: metaContent('meta[property="og:title"]'),
      ogDescription: metaContent('meta[property="og:description"]'),
      description: metaContent('meta[name="description"]'),
      ogImage: metaContent('meta[property="og:image"]'),
      ogVideo: metaContent('meta[property="og:video"]') || metaContent('meta[property="og:video:url"]'),
      metaPrice:
        metaContent('meta[property="product:price:amount"]') ||
        metaContent('meta[property="og:price:amount"]'),
      metaCurrency:
        metaContent('meta[property="product:price:currency"]') ||
        metaContent('meta[property="og:price:currency"]'),
      ldProduct: ldProduct,
    };
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === "GET_DOM_SNAPSHOT") {
      sendResponse(extractDomSnapshot());
      return true;
    }
    return false;
  });
})();
