/* global ShopeeParser */
(function () {
  "use strict";

  const DEFAULT_PORT = 8765;
  // Selaras 100% dengan engine Chromium 132 asli di dalam Kiwi Browser Next
  const DESKTOP_CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

  const DESKTOP_CH_HEADERS = {
    "user-agent": DESKTOP_CHROME_UA,
    "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"15.0.0"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-model": '""',
    "sec-ch-ua-full-version": '"132.0.6834.110"',
    "sec-ch-ua-full-version-list":
      '"Not A(Brand";v="8.0.0.0", "Chromium";v="132.0.6834.110", "Google Chrome";v="132.0.6834.110"',
    "sec-ch-ua-wow64": "?0",
  };

  const CDP_USER_AGENT_METADATA = {
    brands: [
      { brand: "Not A(Brand", version: "8" },
      { brand: "Chromium", version: "132" },
      { brand: "Google Chrome", version: "132" },
    ],
    fullVersionList: [
      { brand: "Not A(Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: "132.0.6834.110" },
      { brand: "Google Chrome", version: "132.0.6834.110" },
    ],
    fullVersion: "132.0.6834.110",
    platform: "Windows",
    platformVersion: "15.0.0",
    architecture: "x86",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  };

  const EARLY_NEW_DOC_CLOAK_SCRIPT = `
    (function() {
      try {
        var navProto = Object.getPrototypeOf(navigator) || Navigator.prototype;
        Object.defineProperty(navProto, 'platform', { get: function(){ return 'Win32'; }, configurable: true });
        Object.defineProperty(navProto, 'maxTouchPoints', { get: function(){ return 0; }, configurable: true });
      } catch (e) {}
    })();
  `;

  const SHOPEE_MIN_JITTER_MS = 9000;
  const SHOPEE_MAX_JITTER_MS = 13000;
  const CAPTURE_TIMEOUT_MS = 22000;
  const RATINGS_GRACE_MS = 1400;

  const state = {
    bridgeHost: "127.0.0.1",
    bridgePort: DEFAULT_PORT,
    useCdpDebugger: true,
    fullDesktopCloak: true,
    blockHeavyMediaOnWorker: true,
    wsConnected: false,
    paused: false,
    pauseReason: null,
    workerTabId: null,
    qrLoginTabId: null,
    processingJob: null,
    lastShopeeCaptureAt: 0,
    capturedCount: 0,
    logs: [],
  };

  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let activeCaptureSession = null;

  function logEvent(level, message) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
    };
    state.logs.unshift(entry);
    if (state.logs.length > 80) state.logs.length = 80;
    broadcastStateToUi();
  }

  function apiBaseUrl() {
    return `http://${state.bridgeHost}:${state.bridgePort}`;
  }

  function wsUrl() {
    return `ws://${state.bridgeHost}:${state.bridgePort}/ws?client=kiwi-extension`;
  }

  function broadcastStateToUi() {
    try {
      chrome.runtime.sendMessage(
        {
          type: "WORKER_STATE_UPDATE",
          state: getPublicState(),
        },
        function () {
          void chrome.runtime.lastError;
        }
      );
    } catch (_) {}
  }

  function getPublicState() {
    return {
      bridgeHost: state.bridgeHost,
      bridgePort: state.bridgePort,
      useCdpDebugger: state.useCdpDebugger,
      fullDesktopCloak: state.fullDesktopCloak,
      blockHeavyMediaOnWorker: state.blockHeavyMediaOnWorker,
      wsConnected: state.wsConnected,
      paused: state.paused,
      pauseReason: state.pauseReason,
      workerTabId: state.workerTabId,
      processingJob: state.processingJob,
      capturedCount: state.capturedCount,
      logs: state.logs.slice(0, 30),
    };
  }

  function loadSettings(cb) {
    chrome.storage.local.get(
      {
        bridgePort: DEFAULT_PORT,
        useCdpDebugger: true,
        fullDesktopCloak: true,
        blockHeavyMediaOnWorker: true,
      },
      function (items) {
        state.bridgePort = Number(items.bridgePort) || DEFAULT_PORT;
        state.useCdpDebugger = items.useCdpDebugger !== false;
        state.fullDesktopCloak = items.fullDesktopCloak !== false;
        state.blockHeavyMediaOnWorker = items.blockHeavyMediaOnWorker !== false;
        if (cb) cb();
      }
    );
  }

  function safeHostname(u) {
    try {
      return new URL(u).hostname;
    } catch (_) {
      return "";
    }
  }

  function isShopeeRelatedHost(host) {
    const h = (host || "").toLowerCase();
    return (
      ShopeeParser.isShopeeDomain(h) ||
      h.endsWith("susercontent.com") ||
      h.endsWith("shopeemobile.com")
    );
  }

  // =========================================================================
  // 1. WebRequest Guards & Global Shopee Full Desktop Cloak (UA + Client Hints)
  // =========================================================================
  chrome.webRequest.onBeforeRequest.addListener(
    function (details) {
      const url = details.url || "";

      // Cegah skema deep-link intent:// & shopeeid:// agar browser tidak mental ke aplikasi
      if (
        (details.tabId === state.workerTabId || state.fullDesktopCloak) &&
        /^(intent|shopeeid|market):\/\//i.test(url)
      ) {
        logEvent("info", `Mencegah redirect eksternal: ${url.slice(0, 60)}`);
        return { cancel: true };
      }

      // Hemat RAM & kuota Galaxy A05 khusus di workerTabId
      if (
        details.tabId !== -1 &&
        details.tabId === state.workerTabId &&
        state.blockHeavyMediaOnWorker &&
        (details.type === "media" || details.type === "font")
      ) {
        return { cancel: true };
      }
      return {};
    },
    { urls: ["<all_urls>"] },
    ["blocking"]
  );

  function rewriteShopeeRequestHeaders(details) {
    const isWorker = details.tabId !== -1 && details.tabId === state.workerTabId;
    if (!state.fullDesktopCloak && !isWorker) {
      return {};
    }
    if (!isShopeeRelatedHost(safeHostname(details.url))) {
      return {};
    }

    const incoming = details.requestHeaders || [];
    const filtered = [];
    const seen = new Set();

    for (const h of incoming) {
      const lower = h.name.toLowerCase();
      // Buang header pembocor identitas WebView/Android
      if (lower === "x-requested-with") {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(DESKTOP_CH_HEADERS, lower)) {
        filtered.push({ name: h.name, value: DESKTOP_CH_HEADERS[lower] });
        seen.add(lower);
      } else {
        filtered.push(h);
      }
    }

    // Pastikan seluruh header utama Client Hints Windows Desktop selalu terkirim konsisten
    for (const reqKey of [
      "user-agent",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
    ]) {
      if (!seen.has(reqKey)) {
        filtered.push({ name: reqKey, value: DESKTOP_CH_HEADERS[reqKey] });
      }
    }

    return { requestHeaders: filtered };
  }

  const SHOPEE_HEADER_URLS = [
    "*://*.shopee.co.id/*",
    "*://shopee.co.id/*",
    "*://*.shopee.tw/*",
    "*://*.shopee.sg/*",
    "*://*.shopee.com.my/*",
    "*://*.shopee.ph/*",
    "*://*.shopee.vn/*",
    "*://*.shopee.co.th/*",
    "*://*.shp.ee/*",
    "*://*.shope.ee/*",
    "*://*.susercontent.com/*",
    "*://*.shopeemobile.com/*",
  ];

  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      rewriteShopeeRequestHeaders,
      { urls: SHOPEE_HEADER_URLS },
      ["blocking", "requestHeaders", "extraHeaders"]
    );
  } catch (_) {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      rewriteShopeeRequestHeaders,
      { urls: SHOPEE_HEADER_URLS },
      ["blocking", "requestHeaders"]
    );
  }

  // Helper CDP untuk mengaktifkan emulasi PC Windows 1366x768 pada tab tertentu
  function applyCdpDesktopProfile(tabId, done) {
    chrome.debugger.sendCommand({ tabId }, "Page.enable", {}, function () {
      void chrome.runtime.lastError;
      chrome.debugger.sendCommand(
        { tabId },
        "Page.addScriptToEvaluateOnNewDocument",
        { source: EARLY_NEW_DOC_CLOAK_SCRIPT },
        function () {
          void chrome.runtime.lastError;
          chrome.debugger.sendCommand(
            { tabId },
            "Emulation.setDeviceMetricsOverride",
            {
              width: 1366,
              height: 768,
              deviceScaleFactor: 1,
              mobile: false,
              screenWidth: 1366,
              screenHeight: 768,
            },
            function () {
              void chrome.runtime.lastError;
              chrome.debugger.sendCommand(
                { tabId },
                "Emulation.setTouchEmulationEnabled",
                { enabled: false },
                function () {
                  void chrome.runtime.lastError;
                  chrome.debugger.sendCommand(
                    { tabId },
                    "Network.setUserAgentOverride",
                    {
                      userAgent: DESKTOP_CHROME_UA,
                      platform: "Win32",
                      userAgentMetadata: CDP_USER_AGENT_METADATA,
                    },
                    function () {
                      void chrome.runtime.lastError;
                      if (done) done();
                    }
                  );
                }
              );
            }
          );
        }
      );
    });
  }

  // =========================================================================
  // 2. Reset Cookie Shopee & Buka Halaman Login QR Mode PC
  // =========================================================================
  function resetShopeeSessionAndOpenQrLogin() {
    return new Promise((resolve) => {
      logEvent("info", "Membersihkan cookie & sesi lama Shopee yang terdeteksi Android...");

      const origins = [
        "https://shopee.co.id",
        "https://s.shopee.co.id",
        "https://affiliate.shopee.co.id",
      ];

      function clearDomainCookies(cb) {
        chrome.cookies.getAll({ domain: "shopee.co.id" }, function (cookies) {
          const list = cookies || [];
          if (list.length === 0) {
            cb();
            return;
          }
          let pending = list.length;
          for (const ck of list) {
            const cleanDomain = (ck.domain || "shopee.co.id").replace(/^\./, "");
            const scheme = ck.secure ? "https://" : "http://";
            const cookieUrl = scheme + cleanDomain + (ck.path || "/");
            chrome.cookies.remove(
              { url: cookieUrl, name: ck.name, storeId: ck.storeId },
              function () {
                void chrome.runtime.lastError;
                pending -= 1;
                if (pending <= 0) cb();
              }
            );
          }
        });
      }

      clearDomainCookies(function () {
        const removeSiteData = function (afterClear) {
          if (chrome.browsingData && chrome.browsingData.remove) {
            chrome.browsingData.remove(
              { origins },
              {
                cookies: true,
                localStorage: true,
                cacheStorage: true,
                serviceWorkers: true,
              },
              function () {
                void chrome.runtime.lastError;
                afterClear();
              }
            );
          } else {
            afterClear();
          }
        };

        removeSiteData(function () {
          // Jangan paksa Emulation 1366x768 atau CDP attach di halaman /buyer/login:
          // 1) Agar form login pas 1:1 di tengah layar HP (tidak terlempar ke kanan),
          // 2) Agar proses login/OTP tidak dicurigai oleh detektor CDP Shopee,
          // sementara Header HTTP + page_hook.js tetap menyamarkan sesi sebagai Windows 10 Chrome 132!
          chrome.tabs.create(
            { url: "https://shopee.co.id/buyer/login", active: true },
            function (tab) {
              if (chrome.runtime.lastError || !tab || !tab.id) {
                logEvent("error", "Gagal membuka tab Login Shopee");
                resolve({ ok: false });
                return;
              }
              state.qrLoginTabId = tab.id;
              logEvent(
                "info",
                "Form Login Mode PC dibuka tepat di tengah layar! Login pakai No. HP + Password / OTP WhatsApp."
              );
              resolve({ ok: true, tabId: tab.id });
            }
          );
        });
      });
    });
  }

  function importShopeeCookies(rawInput) {
    return new Promise((resolve) => {
      const text = String(rawInput || "").trim();
      if (!text) {
        resolve({ ok: false, error: "Input cookie kosong" });
        return;
      }

      const toSet = [];
      if (text.startsWith("[")) {
        try {
          const arr = JSON.parse(text);
          for (const item of arr) {
            if (item && item.name && item.value !== undefined) {
              toSet.push({
                url: "https://shopee.co.id" + (item.path || "/"),
                name: String(item.name),
                value: String(item.value),
                domain: item.domain || ".shopee.co.id",
                path: item.path || "/",
                secure: item.secure !== false,
                httpOnly: Boolean(item.httpOnly),
                expirationDate:
                  item.expirationDate || Math.floor(Date.now() / 1000) + 86400 * 180,
              });
            }
          }
        } catch (err) {
          resolve({ ok: false, error: "Format JSON cookie tidak valid" });
          return;
        }
      } else {
        // Format header Cookie: key1=val1; key2=val2
        const cleaned = text.replace(/^cookie:\s*/i, "");
        for (const part of cleaned.split(";")) {
          const idx = part.indexOf("=");
          if (idx > 0) {
            const name = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (name) {
              toSet.push({
                url: "https://shopee.co.id/",
                name,
                value,
                domain: ".shopee.co.id",
                path: "/",
                secure: true,
                expirationDate: Math.floor(Date.now() / 1000) + 86400 * 180,
              });
            }
          }
        }
      }

      if (toSet.length === 0) {
        resolve({ ok: false, error: "Tidak ada cookie yang ditemukan dari teks tersebut" });
        return;
      }

      let pending = toSet.length;
      let applied = 0;
      for (const ck of toSet) {
        chrome.cookies.set(ck, function (saved) {
          void chrome.runtime.lastError;
          if (saved) applied += 1;
          pending -= 1;
          if (pending <= 0) {
            state.paused = false;
            state.pauseReason = null;
            logEvent("info", `Berhasil memasang ${applied} cookie sesi Shopee!`);
            triggerQueueCheck();
            resolve({ ok: true, applied });
          }
        });
      }
    });
  }

  function exportShopeeCookies() {
    return new Promise((resolve) => {
      chrome.cookies.getAll({ domain: "shopee.co.id" }, function (cookies) {
        const list = cookies || [];
        resolve({ ok: true, count: list.length, json: JSON.stringify(list, null, 2) });
      });
    });
  }

  // =========================================================================
  // 3. Worker Anchor Tab Management
  // =========================================================================
  function idlePageUrl() {
    return chrome.runtime.getURL("idle.html");
  }

  function ensureWorkerTab() {
    return new Promise((resolve, reject) => {
      if (state.workerTabId !== null) {
        chrome.tabs.get(state.workerTabId, function (tab) {
          if (!chrome.runtime.lastError && tab && tab.id) {
            resolve(tab.id);
          } else {
            state.workerTabId = null;
            createOrAdoptIdleTab(resolve, reject);
          }
        });
      } else {
        createOrAdoptIdleTab(resolve, reject);
      }
    });
  }

  function createOrAdoptIdleTab(resolve, reject) {
    const targetIdle = idlePageUrl();
    chrome.tabs.query({}, function (tabs) {
      const existing = (tabs || []).find((t) => t.url && t.url.indexOf(targetIdle) === 0);
      if (existing && existing.id) {
        state.workerTabId = existing.id;
        broadcastStateToUi();
        resolve(existing.id);
        return;
      }
      chrome.tabs.create({ url: targetIdle, active: false }, function (created) {
        if (chrome.runtime.lastError || !created) {
          reject(
            new Error(
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                "Gagal membuat worker tab di Kiwi Dev"
            )
          );
          return;
        }
        state.workerTabId = created.id;
        broadcastStateToUi();
        resolve(created.id);
      });
    });
  }

  chrome.tabs.onRemoved.addListener(function (tabId) {
    if (tabId === state.workerTabId) {
      state.workerTabId = null;
      broadcastStateToUi();
    }
    if (tabId === state.qrLoginTabId) {
      state.qrLoginTabId = null;
    }
  });

  function parkWorkerTab() {
    if (state.workerTabId === null) return;
    chrome.tabs.update(state.workerTabId, { url: idlePageUrl() }, function () {
      void chrome.runtime.lastError;
    });
  }

  // =========================================================================
  // 4. WebSocket + HTTP Bridge Client to ShopVault (com.mykiwi.vault)
  // =========================================================================
  function connectWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      ws = new WebSocket(wsUrl());
    } catch (_) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      state.wsConnected = true;
      logEvent("info", `Terhubung ke ShopVault (${state.bridgeHost}:${state.bridgePort})`);
      safeWsSend({
        type: "hello",
        client: "kiwi-extension",
        version: "1.1.0",
        paused: state.paused,
      });
      startHeartbeat();
      triggerQueueCheck();
    };

    ws.onmessage = function (ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "wake" || msg.type === "job_queued") {
          if (state.paused && msg.forceResume) {
            state.paused = false;
            state.pauseReason = null;
          }
          triggerQueueCheck();
        } else if (msg.type === "resume") {
          state.paused = false;
          state.pauseReason = null;
          logEvent("info", "Antrean dilanjutkan dari ShopVault.");
          triggerQueueCheck();
        } else if (msg.type === "pause") {
          state.paused = true;
          state.pauseReason = msg.reason || "Dijeda manual";
          broadcastStateToUi();
        }
      } catch (_) {}
    };

    ws.onclose = function () {
      if (state.wsConnected) {
        logEvent("warn", "Koneksi WebSocket ke ShopVault terputus, mencoba sambung ulang...");
      }
      state.wsConnected = false;
      stopHeartbeat();
      broadcastStateToUi();
      scheduleReconnect();
    };

    ws.onerror = function () {
      try {
        ws.close();
      } catch (_) {}
    };
  }

  function safeWsSend(obj) {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    } catch (_) {}
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      safeWsSend({
        type: "ping",
        ts: Date.now(),
        busy: Boolean(state.processingJob),
        paused: state.paused,
      });
    }, 20000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWebSocket();
    }, 3500);
  }

  // =========================================================================
  // 5. Sequential Queue Worker + Anti-429 Jitter + Dual Capture (CDP + Hook)
  // =========================================================================
  async function triggerQueueCheck() {
    if (state.paused || state.processingJob) return;

    let job = null;
    try {
      const resp = await fetch(`${apiBaseUrl()}/api/jobs/next`, {
        method: "GET",
        cache: "no-store",
      });
      if (!resp.ok) return;
      const payload = await resp.json();
      job = payload && payload.job ? payload.job : null;
    } catch (_) {
      return;
    }

    if (!job) return;

    state.processingJob = job;
    broadcastStateToUi();

    try {
      await processJob(job);
    } catch (err) {
      const status = (err && err.captureStatus) || "FAILED";
      const reason = (err && err.message) || "Gagal menangkap data produk";
      logEvent("error", `Job #${job.id} (${status}): ${reason}`);

      if (status === "NEED_LOGIN" || status === "CAPTCHA" || status === "RATE_LIMITED") {
        state.paused = true;
        state.pauseReason = reason;
      }

      await reportJobFailure(job.id, status, reason);
    } finally {
      state.processingJob = null;
      broadcastStateToUi();
      if (!state.paused) {
        setTimeout(triggerQueueCheck, 600);
      }
    }
  }

  async function waitShopeePacingIfNeeded(targetUrl) {
    if (!ShopeeParser.isShopeeDomain(safeHostname(targetUrl))) return;
    const elapsed = Date.now() - state.lastShopeeCaptureAt;
    const targetWait =
      SHOPEE_MIN_JITTER_MS +
      Math.floor(Math.random() * (SHOPEE_MAX_JITTER_MS - SHOPEE_MIN_JITTER_MS));
    if (state.lastShopeeCaptureAt > 0 && elapsed < targetWait) {
      const remain = targetWait - elapsed;
      logEvent("info", `Jeda aman anti-429 Shopee ${(remain / 1000).toFixed(1)} dtk...`);
      await new Promise((r) => setTimeout(r, remain));
    }
  }

  async function processJob(job) {
    const targetUrl = job.targetUrl || job.affiliateUrl;
    if (!targetUrl) {
      throw new Error("URL target kosong");
    }

    await waitShopeePacingIfNeeded(targetUrl);
    const tabId = await ensureWorkerTab();

    logEvent("info", `Memuat produk #${job.id}: ${targetUrl}`);

    const result = await captureTabProduct(tabId, job, targetUrl);
    if (ShopeeParser.isShopeeDomain(safeHostname(targetUrl))) {
      state.lastShopeeCaptureAt = Date.now();
    }

    await submitJobResult(job.id, result);
    state.capturedCount += 1;
    logEvent(
      "info",
      `Tersimpan: "${(result.product.title || "").slice(0, 48)}" (Rp ${(
        result.product.priceMin || 0
      ).toLocaleString("id-ID")})`
    );
    parkWorkerTab();
  }

  function captureTabProduct(tabId, job, initialUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let debuggerAttached = false;
      let mainTimer = null;
      let ratingsTimer = null;
      let capturedPdpRaw = null;
      let capturedPdpUrl = null;
      let capturedRatingsRaw = null;
      let parsedProduct = null;
      const pendingCdpRequests = new Map();

      function cleanup() {
        if (mainTimer) clearTimeout(mainTimer);
        if (ratingsTimer) clearTimeout(ratingsTimer);
        activeCaptureSession = null;
        if (debuggerAttached) {
          debuggerAttached = false;
          chrome.debugger.detach({ tabId }, function () {
            void chrome.runtime.lastError;
          });
        }
      }

      function finishSuccess() {
        if (settled || !parsedProduct) return;
        settled = true;
        if (capturedRatingsRaw) {
          parsedProduct.topReviews = ShopeeParser.parseShopeeRatingsJson(capturedRatingsRaw);
        }
        const rawBundle = {
          capturedAt: new Date().toISOString(),
          jobId: job.id,
          affiliateUrl: job.affiliateUrl,
          resolvedUrl: parsedProduct.cleanUrl || initialUrl,
          pdpEndpoint: capturedPdpUrl,
          pdpResponse: safeJsonParse(capturedPdpRaw),
          ratingsResponse: safeJsonParse(capturedRatingsRaw),
        };
        cleanup();
        resolve({
          product: parsedProduct,
          rawJson: JSON.stringify(rawBundle),
        });
      }

      function finishError(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }

      function handleApiBody(apiUrl, bodyText, pageUrl) {
        if (settled || !bodyText) return;

        if (ShopeeParser.isShopeeProductApiUrl(apiUrl) && !parsedProduct) {
          try {
            const ids =
              ShopeeParser.extractShopeeIds(pageUrl || initialUrl) || {
                shopId: job.shopId,
                itemId: job.itemId,
              };
            parsedProduct = ShopeeParser.parseShopeePdpJson(bodyText, {
              affiliateUrl: job.affiliateUrl,
              pageUrl: pageUrl || initialUrl,
              shopId: ids && ids.shopId,
              itemId: ids && ids.itemId,
              domain: ids && ids.domain,
            });
            capturedPdpRaw = bodyText;
            capturedPdpUrl = apiUrl;

            if (capturedRatingsRaw) {
              finishSuccess();
            } else if (!ratingsTimer) {
              ratingsTimer = setTimeout(finishSuccess, RATINGS_GRACE_MS);
            }
          } catch (err) {
            if (err && err.captureStatus) {
              finishError(err);
            }
          }
        } else if (ShopeeParser.isShopeeRatingsApiUrl(apiUrl) && !capturedRatingsRaw) {
          capturedRatingsRaw = bodyText;
          if (parsedProduct) {
            finishSuccess();
          }
        }
      }

      activeCaptureSession = {
        tabId,
        onPageHookResponse(msg) {
          handleApiBody(msg.url, msg.body, msg.pageUrl);
        },
        onCdpEvent(source, method, params) {
          if (source.tabId !== tabId || settled) return;
          if (method === "Network.responseReceived" && params && params.response) {
            const respUrl = params.response.url || "";
            if (
              ShopeeParser.isShopeeProductApiUrl(respUrl) ||
              ShopeeParser.isShopeeRatingsApiUrl(respUrl)
            ) {
              pendingCdpRequests.set(params.requestId, respUrl);
            }
          } else if (method === "Network.loadingFinished" && params) {
            const respUrl = pendingCdpRequests.get(params.requestId);
            if (respUrl) {
              pendingCdpRequests.delete(params.requestId);
              chrome.debugger.sendCommand(
                { tabId },
                "Network.getResponseBody",
                { requestId: params.requestId },
                function (res) {
                  if (chrome.runtime.lastError || !res || !res.body) return;
                  const text = res.base64Encoded ? atob(res.body) : res.body;
                  handleApiBody(respUrl, text, initialUrl);
                }
              );
            }
          }
        },
        onTabUpdated(updatedTabId, changeInfo, tab) {
          if (updatedTabId !== tabId || settled) return;
          const currentUrl = changeInfo.url || (tab && tab.url) || "";
          if (!currentUrl) return;

          const block = ShopeeParser.detectBlockedOrLoginState(currentUrl, null);
          if (block.blocked) {
            const err = new Error(block.reason);
            err.captureStatus = block.status;
            finishError(err);
            return;
          }

          if (
            (currentUrl.includes("/universal-link/") || currentUrl.includes("/opaanlp/")) &&
            ShopeeParser.isShopeeDomain(safeHostname(currentUrl))
          ) {
            const ids = ShopeeParser.extractShopeeIds(currentUrl);
            if (ids && ids.shopId && ids.itemId) {
              const clean = ShopeeParser.buildCleanProductUrl(
                ids.shopId,
                ids.itemId,
                ids.domain
              );
              if (currentUrl !== clean) {
                chrome.tabs.update(tabId, { url: clean });
                return;
              }
            }
          }

          if (
            changeInfo.status === "complete" &&
            !ShopeeParser.isShopeeDomain(safeHostname(currentUrl)) &&
            !ShopeeParser.isShortShopeeUrl(currentUrl)
          ) {
            setTimeout(function () {
              if (settled || parsedProduct) return;
              chrome.tabs.sendMessage(
                tabId,
                { type: "GET_DOM_SNAPSHOT" },
                function (snapshot) {
                  if (chrome.runtime.lastError || !snapshot) return;
                  parsedProduct = ShopeeParser.parseGenericPageMetadata(snapshot, {
                    affiliateUrl: job.affiliateUrl,
                    cleanUrl: currentUrl,
                  });
                  capturedPdpRaw = JSON.stringify(snapshot);
                  capturedPdpUrl = "dom:ld+json/opengraph";
                  finishSuccess();
                }
              );
            }, 1500);
          }
        },
      };

      mainTimer = setTimeout(function () {
        if (parsedProduct) {
          finishSuccess();
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: "GET_DOM_SNAPSHOT" }, function (snapshot) {
          if (!chrome.runtime.lastError && snapshot && (snapshot.ldProduct || snapshot.ogTitle)) {
            const block = ShopeeParser.detectBlockedOrLoginState(snapshot.url, null);
            if (block.blocked) {
              const bErr = new Error(block.reason);
              bErr.captureStatus = block.status;
              finishError(bErr);
              return;
            }
            parsedProduct = ShopeeParser.parseGenericPageMetadata(snapshot, {
              affiliateUrl: job.affiliateUrl,
              cleanUrl: snapshot.url || initialUrl,
            });
            capturedPdpRaw = JSON.stringify(snapshot);
            capturedPdpUrl = "dom:timeout-fallback";
            finishSuccess();
          } else {
            finishError(
              new Error(
                "Timeout menunggu response body produk (gunakan tombol Reset Cookie & Login QR Mode PC di tab Worker)"
              )
            );
          }
        });
      }, CAPTURE_TIMEOUT_MS);

      function startNavigation() {
        chrome.tabs.update(tabId, { url: initialUrl }, function () {
          if (chrome.runtime.lastError) {
            finishError(new Error(chrome.runtime.lastError.message));
          }
        });
      }

      if (state.useCdpDebugger) {
        chrome.debugger.attach({ tabId }, "1.3", function () {
          if (!chrome.runtime.lastError) {
            debuggerAttached = true;
            chrome.debugger.sendCommand(
              { tabId },
              "Network.enable",
              { maxPostDataSize: 65536 },
              function () {
                void chrome.runtime.lastError;
                applyCdpDesktopProfile(tabId, startNavigation);
              }
            );
          } else {
            startNavigation();
          }
        });
      } else {
        startNavigation();
      }
    });
  }

  function safeJsonParse(str) {
    if (!str) return null;
    try {
      return JSON.parse(str);
    } catch (_) {
      return str;
    }
  }

  chrome.debugger.onEvent.addListener(function (source, method, params) {
    if (activeCaptureSession) {
      activeCaptureSession.onCdpEvent(source, method, params);
    }
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    // Jika tab QR Login sudah berhasil masuk ke beranda Shopee (keluar dari /buyer/login),
    // lepas CDP debugger otomatis dan lanjutkan antrean jika sempat terjeda!
    if (tabId === state.qrLoginTabId && changeInfo.status === "complete") {
      const u = (tab && tab.url) || "";
      if (u.includes("shopee.co.id") && !u.includes("/buyer/login") && !u.includes("/verify/")) {
        state.qrLoginTabId = null;
        if (state.paused) {
          state.paused = false;
          state.pauseReason = null;
        }
        logEvent("info", "Login Shopee Mode PC berhasil! Sesi Desktop aktif.");
        triggerQueueCheck();
      }
    }

    // Jika pengguna membuka manual universal-link/opaanlp di tab biasa saat Full Desktop Cloak aktif,
    // arahkan ke /product/{shopId}/{itemId} agar tidak mental
    if (
      state.fullDesktopCloak &&
      tabId !== state.workerTabId &&
      changeInfo.url &&
      (changeInfo.url.includes("/universal-link/") || changeInfo.url.includes("/opaanlp/")) &&
      ShopeeParser.isShopeeDomain(safeHostname(changeInfo.url))
    ) {
      const ids = ShopeeParser.extractShopeeIds(changeInfo.url);
      if (ids && ids.shopId && ids.itemId) {
        const clean = ShopeeParser.buildCleanProductUrl(ids.shopId, ids.itemId, ids.domain);
        if (changeInfo.url !== clean) {
          chrome.tabs.update(tabId, { url: clean });
          return;
        }
      }
    }

    if (activeCaptureSession) {
      activeCaptureSession.onTabUpdated(tabId, changeInfo, tab);
    }
  });

  async function submitJobResult(jobId, result) {
    const resp = await fetch(`${apiBaseUrl()}/api/jobs/${jobId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    if (!resp.ok) {
      throw new Error(`Gagal menyimpan ke ShopVault (HTTP ${resp.status})`);
    }
  }

  async function reportJobFailure(jobId, status, reason) {
    try {
      await fetch(`${apiBaseUrl()}/api/jobs/${jobId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason }),
      });
    } catch (_) {}
  }

  // =========================================================================
  // 6. Runtime Messaging (Content Script + Popup/Idle Dashboard UI)
  // =========================================================================
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") return false;

    if (msg.type === "PAGE_API_CAPTURED") {
      if (
        activeCaptureSession &&
        sender &&
        sender.tab &&
        sender.tab.id === activeCaptureSession.tabId
      ) {
        activeCaptureSession.onPageHookResponse(msg);
      }
      return false;
    }

    if (msg.type === "GET_WORKER_STATE") {
      sendResponse(getPublicState());
      return true;
    }

    if (msg.type === "RESET_SHOPEE_SESSION_AND_OPEN_QR") {
      resetShopeeSessionAndOpenQrLogin().then((res) => {
        sendResponse(Object.assign({}, getPublicState(), res));
      });
      return true;
    }

    if (msg.type === "IMPORT_SHOPEE_COOKIES") {
      importShopeeCookies(msg.rawCookies).then((res) => {
        sendResponse(Object.assign({}, getPublicState(), res));
      });
      return true;
    }

    if (msg.type === "EXPORT_SHOPEE_COOKIES") {
      exportShopeeCookies().then((res) => {
        sendResponse(res);
      });
      return true;
    }

    if (msg.type === "RESUME_QUEUE") {
      state.paused = false;
      state.pauseReason = null;
      logEvent("info", "Antrean dilanjutkan.");
      triggerQueueCheck();
      sendResponse(getPublicState());
      return true;
    }

    if (msg.type === "PAUSE_QUEUE") {
      state.paused = true;
      state.pauseReason = "Dijeda manual dari Kiwi";
      logEvent("warn", "Antrean dijeda manual.");
      sendResponse(getPublicState());
      return true;
    }

    if (msg.type === "UPDATE_SETTINGS" || msg.type === "RECONNECT_BRIDGE") {
      if (msg.bridgePort) {
        state.bridgePort = Number(msg.bridgePort) || DEFAULT_PORT;
        chrome.storage.local.set({ bridgePort: state.bridgePort });
      }
      if (typeof msg.useCdpDebugger === "boolean") {
        state.useCdpDebugger = msg.useCdpDebugger;
        chrome.storage.local.set({ useCdpDebugger: state.useCdpDebugger });
      }
      if (typeof msg.fullDesktopCloak === "boolean") {
        state.fullDesktopCloak = msg.fullDesktopCloak;
        chrome.storage.local.set({ fullDesktopCloak: state.fullDesktopCloak });
      }
      if (msg.type === "RECONNECT_BRIDGE") {
        try {
          if (ws) ws.close();
        } catch (_) {}
        connectWebSocket();
      }
      sendResponse(getPublicState());
      return true;
    }

    return false;
  });

  // Boot worker
  loadSettings(function () {
    ensureWorkerTab().catch(() => {});
    connectWebSocket();
    setInterval(function () {
      if (!state.wsConnected) {
        connectWebSocket();
      }
      triggerQueueCheck();
    }, 15000);
    logEvent("info", "ShopVault Kiwi Worker v1.1 (Full Desktop Cloak) aktif.");
  });
})();
