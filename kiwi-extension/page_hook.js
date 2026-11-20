(function () {
  "use strict";
  if (window.__SHOPVAULT_HOOK_INSTALLED__) return;
  window.__SHOPVAULT_HOOK_INSTALLED__ = true;

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

  // 1. Passive Fetch response clone listener (does NOT alter headers or request behavior)
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
            cloned.text().then((txt) => {
              emitCapturedResponse(res.url || reqUrl, res.status, txt, "fetch");
            }).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // 2. Passive XMLHttpRequest listener (Shopee anti-fraud SDK uses XHR for PDP APIs)
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

  // 3. Block JS-initiated deep-link schemes (shopeeid://, intent://) from stealing focus
  const origOpenWindow = window.open;
  if (typeof origOpenWindow === "function") {
    window.open = function (url, ...rest) {
      if (typeof url === "string" && /^(intent|shopeeid|market|lazada|tokopedia):\/\//i.test(url)) {
        return null;
      }
      return origOpenWindow.call(this, url, ...rest);
    };
  }
})();
