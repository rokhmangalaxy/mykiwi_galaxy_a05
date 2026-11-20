(function () {
  "use strict";

  // 1. Inject page_hook.js into MAIN world at document_start so Desktop Cloak & XHR listener run before Shopee scripts
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page_hook.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.onload = function () {
      script.remove();
    };
  } catch (_) {}

  // 2. Auto-Center & Pas di Layar HP khusus halaman /buyer/login dan /verify/ Shopee PC!
  //    Header & navigator tetap PC Windows 132, tapi tampilan form Login / OTP / QR
  //    diletakkan presisi 1:1 di tengah layar HP tanpa perlu geser ke kanan!
  function applyMobileFriendlyDesktopLoginLayout() {
    try {
      const host = (location.hostname || "").toLowerCase();
      const path = location.pathname || "";
      if (
        !host.includes("shopee.") ||
        (path.indexOf("/buyer/login") !== 0 && path.indexOf("/verify/") !== 0)
      ) {
        return;
      }

      let vp = document.querySelector('meta[name="viewport"]');
      if (!vp) {
        vp = document.createElement("meta");
        vp.name = "viewport";
        (document.head || document.documentElement).appendChild(vp);
      }
      vp.content = "width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes";

      if (!document.getElementById("shopvault-login-center-css")) {
        const style = document.createElement("style");
        style.id = "shopvault-login-center-css";
        style.textContent = `
          html, body, #main {
            min-width: 0 !important;
            width: 100% !important;
            max-width: 100vw !important;
            overflow-x: hidden !important;
          }
          /* Bungkus container 1200px bawaan Shopee PC agar responsif di layar HP */
          header nav,
          div[style*="width: 1040px"],
          div[style*="width:1040px"],
          div[style*="width: 1200px"],
          div[style*="width:1200px"] {
            width: 100% !important;
            min-width: 0 !important;
            max-width: 100vw !important;
            padding-left: 12px !important;
            padding-right: 12px !important;
            box-sizing: border-box !important;
            justify-content: center !important;
          }
          /* Sembunyikan banner ilustrasi kiri pada layout PC agar kotak login langsung di tengah */
          form {
            margin-left: auto !important;
            margin-right: auto !important;
          }
          main > div > div[style*="background-image"] {
            background-image: none !important;
            min-height: auto !important;
            width: 100% !important;
            min-width: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: flex-start !important;
            padding: 12px !important;
            box-sizing: border-box !important;
          }
          main > div > div > div:first-child:not(:only-child):not(:has(form)):not(:has(canvas)) {
            display: none !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyMobileFriendlyDesktopLoginLayout);
  } else {
    applyMobileFriendlyDesktopLoginLayout();
  }
  window.addEventListener("load", function () {
    applyMobileFriendlyDesktopLoginLayout();
    // Scroll halus ke elemen form / canvas QR jika ada
    try {
      const host = (location.hostname || "").toLowerCase();
      if (host.includes("shopee.") && location.pathname.indexOf("/buyer/login") === 0) {
        const targetEl = document.querySelector("form") || document.querySelector("canvas");
        if (targetEl && typeof targetEl.scrollIntoView === "function") {
          targetEl.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        }
      }
    } catch (_) {}
  });

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
