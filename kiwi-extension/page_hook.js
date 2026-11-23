(function () {
  "use strict";
  if (window.__SHOPVAULT_HOOK_INSTALLED__) return;
  window.__SHOPVAULT_HOOK_INSTALLED__ = true;

  const DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
  const DESKTOP_APP_VERSION =
    "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

  function isShopeeHost(hostname) {
    const h = (hostname || "").toLowerCase();
    return h.includes("shopee.") || h.endsWith("shp.ee") || h.endsWith("shope.ee");
  }

  function installShopeeDesktopCloak() {
    try {
      const navProto = Object.getPrototypeOf(navigator) || Navigator.prototype;

      function defineGetter(target, prop, getterFn) {
        try {
          Object.defineProperty(target, prop, {
            get: getterFn,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      }

      const brands = Object.freeze([
        Object.freeze({ brand: "Not A(Brand", version: "8" }),
        Object.freeze({ brand: "Chromium", version: "132" }),
        Object.freeze({ brand: "Google Chrome", version: "132" }),
      ]);

      const fullVersionList = Object.freeze([
        Object.freeze({ brand: "Not A(Brand", version: "8.0.0.0" }),
        Object.freeze({ brand: "Chromium", version: "132.0.6834.110" }),
        Object.freeze({ brand: "Google Chrome", version: "132.0.6834.110" }),
      ]);

      const highEntropySource = {
        architecture: "x86",
        bitness: "64",
        brands: brands,
        fullVersionList: fullVersionList,
        mobile: false,
        model: "",
        platform: "Windows",
        platformVersion: "15.0.0",
        uaFullVersion: "132.0.6834.110",
        wow64: false,
        formFactors: ["Desktop"],
      };

      const fakeUserAgentData = Object.freeze({
        brands: brands,
        mobile: false,
        platform: "Windows",
        getHighEntropyValues: function (hints) {
          const out = {
            brands: brands,
            mobile: false,
            platform: "Windows",
          };
          if (Array.isArray(hints)) {
            for (const k of hints) {
              if (Object.prototype.hasOwnProperty.call(highEntropySource, k)) {
                out[k] = highEntropySource[k];
              }
            }
          }
          return Promise.resolve(out);
        },
        toJSON: function () {
          return {
            brands: brands,
            mobile: false,
            platform: "Windows",
          };
        },
      });

      defineGetter(navProto, "userAgent", () => DESKTOP_UA);
      defineGetter(navProto, "appVersion", () => DESKTOP_APP_VERSION);
      defineGetter(navProto, "platform", () => "Win32");
      defineGetter(navProto, "vendor", () => "Google Inc.");
      defineGetter(navProto, "maxTouchPoints", () => 0);
      defineGetter(navProto, "userAgentData", () => fakeUserAgentData);
      defineGetter(navProto, "hardwareConcurrency", () => 8);
      defineGetter(navProto, "deviceMemory", () => 8);

      const scrProto = Object.getPrototypeOf(window.screen) || Screen.prototype;
      defineGetter(scrProto, "width", () => 1366);
      defineGetter(scrProto, "height", () => 768);
      defineGetter(scrProto, "availWidth", () => 1366);
      defineGetter(scrProto, "availHeight", () => 728);
      defineGetter(scrProto, "colorDepth", () => 24);
      defineGetter(scrProto, "pixelDepth", () => 24);
      if (window.screen && window.screen.orientation) {
        const oriProto = Object.getPrototypeOf(window.screen.orientation);
        if (oriProto) {
          defineGetter(oriProto, "type", () => "landscape-primary");
          defineGetter(oriProto, "angle", () => 0);
        }
      }

      // Jaga agar tab Login (polling link WhatsApp) & Worker tab di background
      // tetap dianggap aktif/visible oleh SPA Shopee saat pengguna berpindah ke WA/Shopee App!
      const docProto = Object.getPrototypeOf(document) || Document.prototype;
      defineGetter(docProto, "hidden", () => false);
      defineGetter(docProto, "webkitHidden", () => false);
      defineGetter(docProto, "visibilityState", () => "visible");
      document.addEventListener(
        "visibilitychange",
        function (ev) {
          ev.stopImmediatePropagation();
        },
        true
      );

      const origMatchMedia = window.matchMedia;
      if (typeof origMatchMedia === "function") {
        window.matchMedia = function (query) {
          const q = String(query || "").toLowerCase().replace(/\s+/g, "");
          const mql = origMatchMedia.call(window, query);
          let overrideMatches = null;
          if (
            q === "(pointer:coarse)" ||
            q === "(any-pointer:coarse)" ||
            q === "(hover:none)" ||
            q === "(any-hover:none)"
          ) {
            overrideMatches = false;
          } else if (
            q === "(pointer:fine)" ||
            q === "(any-pointer:fine)" ||
            q === "(hover:hover)" ||
            q === "(any-hover:hover)"
          ) {
            overrideMatches = true;
          }
          if (overrideMatches !== null) {
            return new Proxy(mql, {
              get(target, prop) {
                if (prop === "matches") return overrideMatches;
                const val = target[prop];
                return typeof val === "function" ? val.bind(target) : val;
              },
            });
          }
          return mql;
        };
      }
    } catch (_) {}
  }

  if (isShopeeHost(location.hostname)) {
    installShopeeDesktopCloak();
  }

  const TARGET_API_PATTERNS = [
    "/api/v4/pdp/get_pc",
    "/api/v4/pdp/get_rw",
    "/api/v4/item/get",
    "/api/v2/item/get",
    "/api/v4/item/get_ratings",
    "/api/v2/item/get_ratings",
    "/api/v4/pdp/get_shop_info",
  ];

  function shouldCapture(url) {
    if (!url || typeof url !== "string") return false;
    for (const pat of TARGET_API_PATTERNS) {
      if (url.indexOf(pat) !== -1) return true;
    }
    return false;
  }

  function emitCapturedResponse(url, status, bodyText, transport) {
    if (!bodyText || typeof bodyText !== "string") return;
    window.postMessage(
      {
        source: "SHOPVAULT_PAGE_HOOK",
        type: "API_RESPONSE",
        url: String(url),
        status: Number(status || 200),
        transport: transport,
        body: bodyText,
        capturedAt: Date.now(),
      },
      "*"
    );
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      let reqUrl = "";
      try {
        const first = args[0];
        reqUrl = typeof first === "string" ? first : (first && first.url) || "";
      } catch (_) {}

      const p = origFetch.apply(this, args);
      if (shouldCapture(reqUrl)) {
        p.then((res) => {
          try {
            const cloned = res.clone();
            cloned
              .text()
              .then((txt) => {
                emitCapturedResponse(res.url || reqUrl, res.status, txt, "fetch");
              })
              .catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && OrigXHR.prototype) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__sv_url = typeof url === "string" ? url : String(url || "");
      } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.send = function (...args) {
      try {
        if (shouldCapture(this.__sv_url)) {
          this.addEventListener("load", function () {
            try {
              let bodyText = "";
              if (!this.responseType || this.responseType === "text") {
                bodyText = this.responseText;
              } else if (this.responseType === "json" && this.response) {
                bodyText = JSON.stringify(this.response);
              }
              if (bodyText) {
                emitCapturedResponse(
                  this.responseURL || this.__sv_url,
                  this.status,
                  bodyText,
                  "xhr"
                );
              }
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origSend.apply(this, args);
    };
  }

  const origOpenWindow = window.open;
  if (typeof origOpenWindow === "function") {
    window.open = function (url, ...rest) {
      if (
        typeof url === "string" &&
        /^(intent|shopeeid|market|lazada|tokopedia):\/\//i.test(url)
      ) {
        return null;
      }
      return origOpenWindow.call(this, url, ...rest);
    };
  }
})();
