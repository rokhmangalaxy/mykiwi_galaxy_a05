(function () {
  "use strict";

  // 1. Suntikkan Cloak Desktop + Hook Fetch/XHR secara SINKRON (inline) tepat di document_start
  //    sebelum script inline <head> Shopee sempat membaca navigator/screen asli Android!
  //    Lalu tetap muat page_hook.js eksternal sebagai cadangan bila halaman memiliki CSP ketat.
  const SYNC_MAIN_WORLD_SCRIPT = `
    (function () {
      if (window.__SHOPVAULT_HOOK_INSTALLED__) return;
      window.__SHOPVAULT_HOOK_INSTALLED__ = true;

      var DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
      var DESKTOP_APP_VERSION = "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
      var h = (location.hostname || "").toLowerCase();
      var isShopee = h.indexOf("shopee.") !== -1 || h.slice(-6) === "shp.ee" || h.slice(-8) === "shope.ee";

      if (isShopee) {
        try {
          var navProto = Object.getPrototypeOf(navigator) || Navigator.prototype;
          var def = function (target, prop, fn) {
            try { Object.defineProperty(target, prop, { get: fn, configurable: true, enumerable: true }); } catch (_) {}
          };
          var brands = Object.freeze([
            Object.freeze({ brand: "Not A(Brand", version: "8" }),
            Object.freeze({ brand: "Chromium", version: "132" }),
            Object.freeze({ brand: "Google Chrome", version: "132" })
          ]);
          var fullVersionList = Object.freeze([
            Object.freeze({ brand: "Not A(Brand", version: "8.0.0.0" }),
            Object.freeze({ brand: "Chromium", version: "132.0.6834.110" }),
            Object.freeze({ brand: "Google Chrome", version: "132.0.6834.110" })
          ]);
          var hi = {
            architecture: "x86", bitness: "64", brands: brands, fullVersionList: fullVersionList,
            mobile: false, model: "", platform: "Windows", platformVersion: "15.0.0",
            uaFullVersion: "132.0.6834.110", wow64: false, formFactors: ["Desktop"]
          };
          var fakeUad = Object.freeze({
            brands: brands, mobile: false, platform: "Windows",
            getHighEntropyValues: function (hints) {
              var out = { brands: brands, mobile: false, platform: "Windows" };
              if (Array.isArray(hints)) {
                for (var i = 0; i < hints.length; i++) {
                  var k = hints[i];
                  if (Object.prototype.hasOwnProperty.call(hi, k)) out[k] = hi[k];
                }
              }
              return Promise.resolve(out);
            },
            toJSON: function () { return { brands: brands, mobile: false, platform: "Windows" }; }
          });

          def(navProto, "userAgent", function () { return DESKTOP_UA; });
          def(navProto, "appVersion", function () { return DESKTOP_APP_VERSION; });
          def(navProto, "platform", function () { return "Win32"; });
          def(navProto, "vendor", function () { return "Google Inc."; });
          def(navProto, "maxTouchPoints", function () { return 0; });
          def(navProto, "userAgentData", function () { return fakeUad; });
          def(navProto, "hardwareConcurrency", function () { return 8; });
          def(navProto, "deviceMemory", function () { return 8; });

          var scrProto = Object.getPrototypeOf(window.screen) || Screen.prototype;
          def(scrProto, "width", function () { return 1366; });
          def(scrProto, "height", function () { return 768; });
          def(scrProto, "availWidth", function () { return 1366; });
          def(scrProto, "availHeight", function () { return 728; });
          def(scrProto, "colorDepth", function () { return 24; });
          def(scrProto, "pixelDepth", function () { return 24; });

          var docProto = Object.getPrototypeOf(document) || Document.prototype;
          def(docProto, "hidden", function () { return false; });
          def(docProto, "webkitHidden", function () { return false; });
          def(docProto, "visibilityState", function () { return "visible"; });
          document.addEventListener("visibilitychange", function (ev) { ev.stopImmediatePropagation(); }, true);

          var origMM = window.matchMedia;
          if (typeof origMM === "function") {
            window.matchMedia = function (query) {
              var q = String(query || "").toLowerCase().replace(/\\s+/g, "");
              var mql = origMM.call(window, query);
              var ov = null;
              if (q === "(pointer:coarse)" || q === "(any-pointer:coarse)" || q === "(hover:none)" || q === "(any-hover:none)") ov = false;
              else if (q === "(pointer:fine)" || q === "(any-pointer:fine)" || q === "(hover:hover)" || q === "(any-hover:hover)") ov = true;
              if (ov !== null) {
                return new Proxy(mql, {
                  get: function (t, p) {
                    if (p === "matches") return ov;
                    var v = t[p];
                    return typeof v === "function" ? v.bind(t) : v;
                  }
                });
              }
              return mql;
            };
          }
        } catch (_) {}
      }

      var PATS = ["/api/v4/pdp/get_pc", "/api/v4/pdp/get_rw", "/api/v4/item/get", "/api/v2/item/get", "/api/v4/item/get_ratings", "/api/v2/item/get_ratings", "/api/v4/pdp/get_shop_info"];
      function want(u) {
        if (!u || typeof u !== "string") return false;
        for (var i = 0; i < PATS.length; i++) if (u.indexOf(PATS[i]) !== -1) return true;
        return false;
      }
      function emit(u, st, body, tr) {
        if (!body || typeof body !== "string") return;
        window.postMessage({ source: "SHOPVAULT_PAGE_HOOK", type: "API_RESPONSE", url: String(u), status: Number(st || 200), transport: tr, body: body, capturedAt: Date.now() }, "*");
      }

      var origFetch = window.fetch;
      if (typeof origFetch === "function") {
        window.fetch = function () {
          var args = arguments;
          var reqUrl = "";
          try { reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || ""; } catch (_) {}
          var p = origFetch.apply(this, args);
          if (want(reqUrl)) {
            p.then(function (res) {
              try {
                res.clone().text().then(function (txt) { emit(res.url || reqUrl, res.status, txt, "fetch"); }).catch(function () {});
              } catch (_) {}
            }).catch(function () {});
          }
          return p;
        };
      }

      var OrigXHR = window.XMLHttpRequest;
      if (OrigXHR && OrigXHR.prototype) {
        var oOpen = OrigXHR.prototype.open;
        var oSend = OrigXHR.prototype.send;
        OrigXHR.prototype.open = function (m, u) {
          try { this.__sv_url = typeof u === "string" ? u : String(u || ""); } catch (_) {}
          return oOpen.apply(this, arguments);
        };
        OrigXHR.prototype.send = function () {
          try {
            if (want(this.__sv_url)) {
              this.addEventListener("load", function () {
                try {
                  var bt = (!this.responseType || this.responseType === "text") ? this.responseText : (this.responseType === "json" && this.response ? JSON.stringify(this.response) : "");
                  if (bt) emit(this.responseURL || this.__sv_url, this.status, bt, "xhr");
                } catch (_) {}
              });
            }
          } catch (_) {}
          return oSend.apply(this, arguments);
        };
      }

      var origOpenWin = window.open;
      if (typeof origOpenWin === "function") {
        window.open = function (u) {
          if (typeof u === "string" && /^(intent|shopeeid|market|lazada|tokopedia):\\/\\//i.test(u)) return null;
          return origOpenWin.apply(this, arguments);
        };
      }
    })();
  `;

  try {
    const inlineEl = document.createElement("script");
    inlineEl.textContent = SYNC_MAIN_WORLD_SCRIPT;
    (document.head || document.documentElement).appendChild(inlineEl);
    inlineEl.remove();
  } catch (_) {}

  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page_hook.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.onload = function () {
      script.remove();
    };
  } catch (_) {}

  // 2. Auto-Center & Pas di Layar HP khusus halaman /buyer/login dan /verify/ Shopee PC
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
      ogVideo:
        metaContent('meta[property="og:video"]') || metaContent('meta[property="og:video:url"]'),
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
    if (!message || typeof message !== "object") return false;
    if (message.type === "GET_DOM_SNAPSHOT") {
      sendResponse(extractDomSnapshot());
      return true;
    }
    if (message.type === "WAKE_LOGIN_POLLER") {
      try {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
      } catch (_) {}
      sendResponse({ ok: true, url: location.href });
      return true;
    }
    return false;
  });
})();
