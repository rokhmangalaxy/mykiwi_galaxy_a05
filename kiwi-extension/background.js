/* global ShopeeParser */
(function () {
  "use strict";

  const DEFAULT_PORT = 8765;
  const EXTENSION_VERSION = "1.3.0";
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

  const SHOPEE_MIN_JITTER_MS = 2500;
  const SHOPEE_MAX_JITTER_MS = 4200;
  const CAPTURE_TIMEOUT_MS = 22000;
  const LOGIN_BOUNCE_GRACE_MS = 3500;

  const state = {
    bridgeHost: "127.0.0.1",
    bridgePort: DEFAULT_PORT,
    useCdpDebugger: false,
    fullDesktopCloak: true,
    autoCloseShopeeTab: true,
    blockHeavyMediaOnWorker: true,
    wsConnected: false,
    paused: false,
    pauseReason: null,
    workerTabId: null,
    qrLoginTabId: null,
    activeCaptureTabId: null,
    processingJob: null,
    lastShopeeCaptureAt: 0,
    capturedCount: 0,
    shopeeAuth: {
      loggedIn: false,
      userId: null,
      cookieCount: 0,
      hasSpcEc: false,
      hasSpcSt: false,
      checkedAt: 0,
    },
    logs: [],
  };

  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let activeCaptureSession = null;
  let cookieDebounceTimer = null;
  let burstTimers = [];

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
      autoCloseShopeeTab: state.autoCloseShopeeTab,
      blockHeavyMediaOnWorker: state.blockHeavyMediaOnWorker,
      wsConnected: state.wsConnected,
      paused: state.paused,
      pauseReason: state.pauseReason,
      workerTabId: state.workerTabId,
      processingJob: state.processingJob,
      capturedCount: state.capturedCount,
      shopeeAuth: state.shopeeAuth,
      logs: state.logs.slice(0, 35),
    };
  }

  function loadSettings(cb) {
    chrome.storage.local.get(
      {
        bridgePort: DEFAULT_PORT,
        useCdpDebuggerV2: false,
        fullDesktopCloak: true,
        autoCloseShopeeTab: true,
        blockHeavyMediaOnWorker: true,
      },
      function (items) {
        state.bridgePort = Number(items.bridgePort) || DEFAULT_PORT;
        state.useCdpDebugger = items.useCdpDebuggerV2 === true;
        state.fullDesktopCloak = items.fullDesktopCloak !== false;
        state.autoCloseShopeeTab = items.autoCloseShopeeTab !== false;
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

  // Saat Kiwi dibangunkan oleh ShareReceiverActivity dari aplikasi Shopee,
  // langsung cek antrean secara agresif (0ms, 450ms, 1100ms, 2300ms) agar tidak menunggu interval 15 detik!
  function triggerForegroundBurst() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    for (const t of burstTimers) clearTimeout(t);
    burstTimers = [];

    triggerQueueCheck();
    for (const delay of [450, 1100, 2300]) {
      burstTimers.push(
        setTimeout(function () {
          triggerQueueCheck();
        }, delay)
      );
    }
  }

  // =========================================================================
  // 0. Detektor Real-Time Cookie Sesi Login Shopee (SPC_EC / SPC_ST / SPC_U)
  // =========================================================================
  function checkShopeeAuthSession() {
    return new Promise((resolve) => {
      chrome.cookies.getAll({ domain: "shopee.co.id" }, function (cookies) {
        void chrome.runtime.lastError;
        const list = cookies || [];
        let spcEc = "";
        let spcSt = "";
        let spcU = "";

        for (const ck of list) {
          if (!ck || !ck.name) continue;
          if (ck.name === "SPC_EC" && ck.value) spcEc = String(ck.value);
          else if (ck.name === "SPC_ST" && ck.value) spcSt = String(ck.value);
          else if (ck.name === "SPC_U" && ck.value) spcU = String(ck.value);
        }

        const hasSpcEc = spcEc.length > 4;
        const hasSpcSt = spcSt.length > 4;
        const validUserId =
          spcU && spcU !== "-" && spcU !== "0" && spcU !== '""' ? spcU : null;
        const loggedIn = Boolean((hasSpcEc || hasSpcSt) && (validUserId || hasSpcEc));

        const info = {
          loggedIn,
          userId: validUserId,
          cookieCount: list.length,
          hasSpcEc,
          hasSpcSt,
          checkedAt: Date.now(),
        };
        state.shopeeAuth = info;
        broadcastStateToUi();
        resolve(info);
      });
    });
  }

  async function retryBridgeQueueAfterLogin() {
    try {
      await fetch(`${apiBaseUrl()}/api/queue/retry`, { method: "POST" });
    } catch (_) {}
    triggerQueueCheck();
  }

  if (chrome.cookies && chrome.cookies.onChanged) {
    chrome.cookies.onChanged.addListener(function (changeInfo) {
      const ck = changeInfo && changeInfo.cookie;
      if (!ck || !ck.domain || ck.domain.indexOf("shopee.co.id") === -1) return;
      if (ck.name !== "SPC_EC" && ck.name !== "SPC_ST" && ck.name !== "SPC_U") return;

      if (cookieDebounceTimer) clearTimeout(cookieDebounceTimer);
      cookieDebounceTimer = setTimeout(async function () {
        const wasLoggedIn = state.shopeeAuth.loggedIn;
        const nowAuth = await checkShopeeAuthSession();
        safeWsSend({
          type: "ping",
          ts: Date.now(),
          busy: Boolean(state.processingJob),
          paused: state.paused,
          shopeeLoggedIn: nowAuth.loggedIn,
          shopeeUserId: nowAuth.userId,
        });

        if (!wasLoggedIn && nowAuth.loggedIn) {
          logEvent(
            "info",
            `✅ Cookie login Shopee masuk di Kiwi Dev${
              nowAuth.userId ? " (UID: " + nowAuth.userId + ")" : ""
            }! Melanjutkan antrean otomatis...`
          );
          state.paused = false;
          state.pauseReason = null;
          broadcastStateToUi();
          retryBridgeQueueAfterLogin();
        }
      }, 450);
    });
  }

  // =========================================================================
  // 1. WebRequest Guards & Global Shopee Full Desktop Cloak (UA + Client Hints)
  // =========================================================================
  chrome.webRequest.onBeforeRequest.addListener(
    function (details) {
      const url = details.url || "";
      const isCaptureTab =
        details.tabId !== -1 && details.tabId === state.activeCaptureTabId;

      if (
        (isCaptureTab || state.fullDesktopCloak) &&
        /^(intent|shopeeid|market):\/\//i.test(url)
      ) {
        logEvent("info", `Mencegah redirect eksternal: ${url.slice(0, 60)}`);
        return { cancel: true };
      }

      if (
        isCaptureTab &&
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
    const isCaptureTab =
      details.tabId !== -1 && details.tabId === state.activeCaptureTabId;
    if (!state.fullDesktopCloak && !isCaptureTab) {
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

    for (const reqKey of [
      "user-agent",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-ch-ua-platform-version",
      "sec-ch-ua-model",
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
    "*://*.shopee.com/*",
    "*://*.shopee.tw/*",
    "*://*.shopee.sg/*",
    "*://*.shopee.com.my/*",
    "*://*.shopee.ph/*",
    "*://*.shopee.vn/*",
    "*://*.shopee.co.th/*",
    "*://*.shp.ee/*",
    "*://shp.ee/*",
    "*://*.shope.ee/*",
    "*://shope.ee/*",
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
    });
  }

  // =========================================================================
  // 2. Reset Cookie Shopee & Buka Halaman Login Mode PC (Tengah Layar)
  // =========================================================================
  function resetShopeeSessionAndOpenQrLogin() {
    return new Promise((resolve) => {
      logEvent("info", "Membersihkan cookie lama Shopee & menyiapkan form login baru...");

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

        removeSiteData(async function () {
          await checkShopeeAuthSession();
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
                "Form Login dibuka! Begitu berhasil login, tab Shopee akan otomatis ditutup agar sesi tidak kena verifikasi ulang."
              );
              resolve({ ok: true, tabId: tab.id });
            }
          );
        });
      });
    });
  }

  function openOrFocusShopeeHome() {
    return new Promise((resolve) => {
      if (state.qrLoginTabId !== null) {
        chrome.tabs.update(state.qrLoginTabId, { active: true }, function (tab) {
          if (!chrome.runtime.lastError && tab && tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: "WAKE_LOGIN_POLLER" }, function () {
              void chrome.runtime.lastError;
            });
            resolve({ ok: true, tabId: tab.id });
            return;
          }
          state.qrLoginTabId = null;
          chrome.tabs.create({ url: "https://shopee.co.id/", active: true }, function (t2) {
            void chrome.runtime.lastError;
            resolve({ ok: Boolean(t2), tabId: t2 && t2.id });
          });
        });
      } else {
        chrome.tabs.create({ url: "https://shopee.co.id/", active: true }, function (tab) {
          void chrome.runtime.lastError;
          resolve({ ok: Boolean(tab), tabId: tab && tab.id });
        });
      }
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
        } catch (_) {
          resolve({ ok: false, error: "Format JSON cookie tidak valid" });
          return;
        }
      } else {
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
            checkShopeeAuthSession().then((auth) => {
              state.paused = false;
              state.pauseReason = null;
              logEvent(
                "info",
                `Berhasil memasang ${applied} cookie Shopee (${
                  auth.loggedIn ? "Sesi AKTIF" : "periksa SPC_EC/SPC_ST"
                }).`
              );
              retryBridgeQueueAfterLogin();
              resolve({ ok: true, applied });
            });
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
  // 3. Worker Anchor Tab Management + Auto-Close Tab Produk Sementara
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

  function focusWorkerIdleTab() {
    if (state.workerTabId === null) return;
    chrome.tabs.update(state.workerTabId, { active: true }, function () {
      void chrome.runtime.lastError;
    });
  }

  function closeTabSafely(tabId) {
    if (!tabId) return;
    chrome.tabs.remove(tabId, function () {
      void chrome.runtime.lastError;
      focusWorkerIdleTab();
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
    if (activeCaptureSession && tabId === activeCaptureSession.tabId) {
      activeCaptureSession.onTabClosedExternally();
    }
  });

  chrome.tabs.onActivated.addListener(function () {
    if (!state.processingJob && !state.paused) {
      triggerQueueCheck();
    }
  });

  try {
    if (chrome.windows && chrome.windows.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener(function (winId) {
        if (winId !== chrome.windows.WINDOW_ID_NONE) {
          triggerForegroundBurst();
        }
      });
    }
  } catch (_) {}

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

    ws.onopen = async function () {
      state.wsConnected = true;
      const auth = await checkShopeeAuthSession();
      logEvent("info", `Terhubung ke ShopVault (${state.bridgeHost}:${state.bridgePort})`);
      safeWsSend({
        type: "hello",
        client: "kiwi-extension",
        version: EXTENSION_VERSION,
        paused: state.paused,
        shopeeLoggedIn: auth.loggedIn,
        shopeeUserId: auth.userId,
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
          triggerForegroundBurst();
        } else if (msg.type === "resume") {
          state.paused = false;
          state.pauseReason = null;
          logEvent("info", "Antrean dilanjutkan dari ShopVault.");
          triggerForegroundBurst();
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
    heartbeatTimer = setInterval(async function () {
      const auth = await checkShopeeAuthSession();
      safeWsSend({
        type: "ping",
        ts: Date.now(),
        busy: Boolean(state.processingJob),
        paused: state.paused,
        shopeeLoggedIn: auth.loggedIn,
        shopeeUserId: auth.userId,
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
    }, 3000);
  }

  // =========================================================================
  // 5. Sequential Queue Worker + Instant Auto-Close + Pure Verbatim Raw JSON
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
        setTimeout(triggerQueueCheck, 500);
      }
    }
  }

  async function waitForPendingWhatsAppLoginIfOpen() {
    let auth = await checkShopeeAuthSession();
    if (auth.loggedIn || state.qrLoginTabId === null) {
      return auth;
    }

    logEvent("info", "Membangunkan tab Login Shopee untuk mengambil cookie verifikasi WhatsApp...");
    for (let i = 0; i < 6; i++) {
      if (state.qrLoginTabId !== null) {
        chrome.tabs.sendMessage(state.qrLoginTabId, { type: "WAKE_LOGIN_POLLER" }, function () {
          void chrome.runtime.lastError;
        });
      }
      await new Promise((r) => setTimeout(r, 900));
      auth = await checkShopeeAuthSession();
      if (auth.loggedIn) {
        logEvent("info", "✅ Cookie verifikasi WhatsApp berhasil diterima Kiwi Dev!");
        return auth;
      }
    }
    return auth;
  }

  async function waitShopeePacingIfNeeded(targetUrl) {
    if (!ShopeeParser.isShopeeDomain(safeHostname(targetUrl))) return;
    const elapsed = Date.now() - state.lastShopeeCaptureAt;
    const targetWait =
      SHOPEE_MIN_JITTER_MS +
      Math.floor(Math.random() * (SHOPEE_MAX_JITTER_MS - SHOPEE_MIN_JITTER_MS));
    if (state.lastShopeeCaptureAt > 0 && elapsed < targetWait) {
      const remain = targetWait - elapsed;
      logEvent("info", `Jeda antrean ${(remain / 1000).toFixed(1)} dtk...`);
      await new Promise((r) => setTimeout(r, remain));
    }
  }

  async function processJob(job) {
    const rawTargetUrl = job.targetUrl || job.affiliateUrl;
    if (!rawTargetUrl) {
      throw new Error("URL target kosong");
    }

    // Pastikan tab anchor idle.html ada agar saat tab produk auto-close, Kiwi kembali ke halaman aman
    await ensureWorkerTab().catch(() => {});

    const targetUrl = ShopeeParser.cleanShopeeTargetUrl(rawTargetUrl);
    const isShopeeJob =
      ShopeeParser.isShopeeDomain(safeHostname(targetUrl)) ||
      ShopeeParser.isShortShopeeUrl(targetUrl);

    let auth = state.shopeeAuth;
    if (isShopeeJob) {
      auth = await waitForPendingWhatsAppLoginIfOpen();
    }

    await waitShopeePacingIfNeeded(targetUrl);

    const authTag = isShopeeJob
      ? auth.loggedIn
        ? `[Sesi: AKTIF${auth.userId ? " UID " + auth.userId : ""}]`
        : "[Sesi: BELUM ADA COOKIE SPC_EC]"
      : "";
    logEvent("info", `Membuka tab sementara #${job.id}: ${targetUrl} ${authTag}`);

    const result = await captureInEphemeralTab(job, targetUrl);
    if (isShopeeJob) {
      state.lastShopeeCaptureAt = Date.now();
    }

    await submitJobResult(job.id, result);
    state.capturedCount += 1;
    const rawKb = result.rawJson ? (result.rawJson.length / 1024).toFixed(1) : "0";
    logEvent(
      "info",
      `✅ Raw JSON Murni tersimpan (${rawKb} KB) & tab ditutup: "${(
        result.product.title || ""
      ).slice(0, 44)}"`
    );
  }

  function captureInEphemeralTab(job, initialUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let captureTabId = null;
      let debuggerAttached = false;
      let mainTimer = null;
      let loginBounceTimer = null;
      let retriedDirectAfterBounce = false;
      let capturedPdpRaw = null;
      let parsedProduct = null;
      const pendingCdpRequests = new Map();

      function clearLoginBounceTimer() {
        if (loginBounceTimer) {
          clearTimeout(loginBounceTimer);
          loginBounceTimer = null;
        }
      }

      function cleanupAndAutoClose() {
        if (mainTimer) clearTimeout(mainTimer);
        clearLoginBounceTimer();
        activeCaptureSession = null;
        const tabToClose = captureTabId;
        state.activeCaptureTabId = null;
        captureTabId = null;

        if (debuggerAttached && tabToClose) {
          debuggerAttached = false;
          chrome.debugger.detach({ tabId: tabToClose }, function () {
            void chrome.runtime.lastError;
            if (state.autoCloseShopeeTab && tabToClose) {
              closeTabSafely(tabToClose);
            }
          });
        } else if (state.autoCloseShopeeTab && tabToClose) {
          closeTabSafely(tabToClose);
        }
      }

      function finishSuccess() {
        if (settled || !parsedProduct) return;
        settled = true;
        // PENTING: Tutup tab Shopee DETIK ITU JUGA (0ms) agar tidak sempat memicu verifikasi ulang!
        cleanupAndAutoClose();
        // PENTING: Kirim capturedPdpRaw 100% APA ADANYA (murni response body Shopee tanpa edit/bungkus)!
        resolve({
          product: parsedProduct,
          rawJson: capturedPdpRaw,
        });
      }

      function finishError(err) {
        if (settled) return;
        settled = true;
        cleanupAndAutoClose();
        reject(err);
      }

      function handleApiBody(apiUrl, bodyText, pageUrl) {
        if (settled || !bodyText) return;

        if (ShopeeParser.isShopeeProductApiUrl(apiUrl) && !parsedProduct) {
          try {
            clearLoginBounceTimer();
            const ids =
              ShopeeParser.extractShopeeIds(pageUrl || initialUrl) || {
                shopId: job.shopId,
                itemId: job.itemId,
              };
            // parseShopeePdpJson HANYA membaca ringkasan untuk indeks pencarian ShopVault;
            // string asli bodyText sama sekali TIDAK diubah!
            parsedProduct = ShopeeParser.parseShopeePdpJson(bodyText, {
              affiliateUrl: job.affiliateUrl,
              pageUrl: pageUrl || initialUrl,
              shopId: ids && ids.shopId,
              itemId: ids && ids.itemId,
              domain: ids && ids.domain,
            });
            capturedPdpRaw = bodyText;

            // Langsung selesaikan & auto-close tab saat itu juga tanpa menunggu apa pun lagi!
            finishSuccess();
          } catch (err) {
            if (err && err.captureStatus) {
              finishError(err);
            }
          }
        }
      }

      chrome.tabs.create({ url: "about:blank", active: true }, function (createdTab) {
        if (chrome.runtime.lastError || !createdTab || !createdTab.id) {
          reject(
            new Error(
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                "Gagal membuka tab pengambilan JSON"
            )
          );
          return;
        }

        captureTabId = createdTab.id;
        state.activeCaptureTabId = captureTabId;

        activeCaptureSession = {
          tabId: captureTabId,
          onTabClosedExternally() {
            if (settled) return;
            captureTabId = null;
            finishError(new Error("Tab produk ditutup sebelum Raw JSON selesai diterima."));
          },
          onPageHookResponse(msg) {
            handleApiBody(msg.url, msg.body, msg.pageUrl);
          },
          onCdpEvent(source, method, params) {
            if (source.tabId !== captureTabId || settled) return;
            if (method === "Network.responseReceived" && params && params.response) {
              const respUrl = params.response.url || "";
              if (ShopeeParser.isShopeeProductApiUrl(respUrl)) {
                pendingCdpRequests.set(params.requestId, respUrl);
              }
            } else if (method === "Network.loadingFinished" && params) {
              const respUrl = pendingCdpRequests.get(params.requestId);
              if (respUrl) {
                pendingCdpRequests.delete(params.requestId);
                chrome.debugger.sendCommand(
                  { tabId: captureTabId },
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
            if (updatedTabId !== captureTabId || settled) return;
            const currentUrl = changeInfo.url || (tab && tab.url) || "";
            if (
              !currentUrl ||
              currentUrl === "about:blank" ||
              currentUrl.indexOf("chrome-extension://") === 0
            ) {
              return;
            }

            const block = ShopeeParser.detectBlockedOrLoginState(currentUrl, null);
            if (block.blocked) {
              if (block.status === "CAPTCHA" || block.status === "RATE_LIMITED") {
                const cErr = new Error(block.reason);
                cErr.captureStatus = block.status;
                finishError(cErr);
                return;
              }

              checkShopeeAuthSession().then((auth) => {
                if (settled) return;
                const nextClean = ShopeeParser.extractLoginNextUrl(currentUrl);
                if (auth.loggedIn && !retriedDirectAfterBounce && nextClean && captureTabId) {
                  retriedDirectAfterBounce = true;
                  clearLoginBounceTimer();
                  logEvent(
                    "info",
                    `Cookie Shopee aktif, melewati redirect login menuju: ${nextClean}`
                  );
                  chrome.tabs.update(captureTabId, { url: nextClean });
                  return;
                }

                if (!loginBounceTimer) {
                  loginBounceTimer = setTimeout(async function () {
                    loginBounceTimer = null;
                    if (settled || parsedProduct || !captureTabId) return;
                    const finalAuth = await checkShopeeAuthSession();
                    chrome.tabs.get(captureTabId, function (latestTab) {
                      void chrome.runtime.lastError;
                      const latestUrl = (latestTab && latestTab.url) || currentUrl;
                      const stillBlocked = ShopeeParser.detectBlockedOrLoginState(latestUrl, null);
                      if (!stillBlocked.blocked) return;

                      const msgText = !finalAuth.loggedIn
                        ? "Cookie login Shopee (SPC_EC) belum tersimpan di Kiwi Dev! Buka tab Worker lalu pastikan indikator Sesi Shopee berwarna HIJAU (AKTIF)."
                        : "Sesi Shopee diminta verifikasi ulang oleh Shopee. Gunakan tombol Reset & Login ulang di tab Worker.";
                      const lErr = new Error(msgText);
                      lErr.captureStatus = "NEED_LOGIN";
                      finishError(lErr);
                    });
                  }, LOGIN_BOUNCE_GRACE_MS);
                }
              });
              return;
            }

            clearLoginBounceTimer();

            if (
              (currentUrl.includes("/universal-link/") || currentUrl.includes("/opaanlp/")) &&
              ShopeeParser.isShopeeDomain(safeHostname(currentUrl))
            ) {
              const cleaned = ShopeeParser.cleanShopeeTargetUrl(currentUrl);
              if (cleaned && cleaned !== currentUrl && captureTabId) {
                chrome.tabs.update(captureTabId, { url: cleaned });
                return;
              }
            }

            if (
              changeInfo.status === "complete" &&
              !ShopeeParser.isShopeeDomain(safeHostname(currentUrl)) &&
              !ShopeeParser.isShortShopeeUrl(currentUrl)
            ) {
              setTimeout(function () {
                if (settled || parsedProduct || !captureTabId) return;
                chrome.tabs.sendMessage(
                  captureTabId,
                  { type: "GET_DOM_SNAPSHOT" },
                  function (snapshot) {
                    if (chrome.runtime.lastError || !snapshot) return;
                    parsedProduct = ShopeeParser.parseGenericPageMetadata(snapshot, {
                      affiliateUrl: job.affiliateUrl,
                      cleanUrl: currentUrl,
                    });
                    capturedPdpRaw = JSON.stringify(snapshot);
                    finishSuccess();
                  }
                );
              }, 1200);
            }
          },
        };

        mainTimer = setTimeout(function () {
          if (parsedProduct) {
            finishSuccess();
            return;
          }
          if (!captureTabId) {
            finishError(new Error("Timeout menunggu Raw JSON produk."));
            return;
          }
          chrome.tabs.sendMessage(captureTabId, { type: "GET_DOM_SNAPSHOT" }, function (snapshot) {
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
              finishSuccess();
            } else {
              finishError(
                new Error(
                  "Timeout menunggu response Raw JSON produk Shopee (tab otomatis ditutup agar aman)."
                )
              );
            }
          });
        }, CAPTURE_TIMEOUT_MS);

        function startNavigation() {
          if (!captureTabId) return;
          chrome.tabs.update(captureTabId, { url: initialUrl }, function () {
            if (chrome.runtime.lastError) {
              finishError(new Error(chrome.runtime.lastError.message));
            }
          });
        }

        if (state.useCdpDebugger) {
          chrome.debugger.attach({ tabId: captureTabId }, "1.3", function () {
            if (!chrome.runtime.lastError) {
              debuggerAttached = true;
              chrome.debugger.sendCommand(
                { tabId: captureTabId },
                "Network.enable",
                { maxPostDataSize: 65536 },
                function () {
                  void chrome.runtime.lastError;
                  applyCdpDesktopProfile(captureTabId, startNavigation);
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
    });
  }

  chrome.debugger.onEvent.addListener(function (source, method, params) {
    if (activeCaptureSession) {
      activeCaptureSession.onCdpEvent(source, method, params);
    }
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    // Begitu login di tab Login berhasil masuk ke beranda Shopee & cookie SPC_EC tersimpan,
    // otomatis tutup tab Shopee juga agar tidak didiamkan (mencegah verifikasi ulang)!
    if (tabId === state.qrLoginTabId && changeInfo.status === "complete") {
      const u = (tab && tab.url) || "";
      if (u.includes("shopee.co.id") && !u.includes("/buyer/login") && !u.includes("/verify/")) {
        const finishedLoginTabId = state.qrLoginTabId;
        state.qrLoginTabId = null;
        setTimeout(function () {
          checkShopeeAuthSession().then((auth) => {
            if (state.paused) {
              state.paused = false;
              state.pauseReason = null;
            }
            if (state.autoCloseShopeeTab && auth.loggedIn) {
              closeTabSafely(finishedLoginTabId);
              logEvent(
                "info",
                `✅ Login Shopee berhasil${
                  auth.userId ? " (UID: " + auth.userId + ")" : ""
                }! Tab Shopee ditutup otomatis agar sesi aman dari verifikasi ulang.`
              );
            } else {
              logEvent(
                "info",
                `Login Shopee selesai (${auth.loggedIn ? "Sesi AKTIF" : "cek cookie"}).`
              );
            }
            retryBridgeQueueAfterLogin();
          });
        }, 1200);
      }
    }

    if (
      state.fullDesktopCloak &&
      tabId !== state.activeCaptureTabId &&
      changeInfo.url &&
      (changeInfo.url.includes("/universal-link/") || changeInfo.url.includes("/opaanlp/")) &&
      ShopeeParser.isShopeeDomain(safeHostname(changeInfo.url))
    ) {
      const cleaned = ShopeeParser.cleanShopeeTargetUrl(changeInfo.url);
      if (cleaned && cleaned !== changeInfo.url) {
        chrome.tabs.update(tabId, { url: cleaned });
        return;
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

    if (msg.type === "APP_FOREGROUNDED") {
      triggerForegroundBurst();
      checkShopeeAuthSession().then(() => {
        sendResponse(getPublicState());
      });
      return true;
    }

    if (msg.type === "GET_WORKER_STATE") {
      checkShopeeAuthSession().then(() => {
        sendResponse(getPublicState());
      });
      return true;
    }

    if (msg.type === "CHECK_SHOPEE_AUTH") {
      checkShopeeAuthSession().then((auth) => {
        if (auth.loggedIn && state.paused) {
          state.paused = false;
          state.pauseReason = null;
          retryBridgeQueueAfterLogin();
        }
        sendResponse(getPublicState());
      });
      return true;
    }

    if (msg.type === "OPEN_SHOPEE_HOME") {
      openOrFocusShopeeHome().then((res) => {
        sendResponse(Object.assign({}, getPublicState(), res));
      });
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
      logEvent("info", "Antrean dilanjutkan & mencoba ulang job tertunda...");
      retryBridgeQueueAfterLogin();
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
        chrome.storage.local.set({ useCdpDebuggerV2: state.useCdpDebugger });
      }
      if (typeof msg.fullDesktopCloak === "boolean") {
        state.fullDesktopCloak = msg.fullDesktopCloak;
        chrome.storage.local.set({ fullDesktopCloak: state.fullDesktopCloak });
      }
      if (typeof msg.autoCloseShopeeTab === "boolean") {
        state.autoCloseShopeeTab = msg.autoCloseShopeeTab;
        chrome.storage.local.set({ autoCloseShopeeTab: state.autoCloseShopeeTab });
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
  loadSettings(async function () {
    await checkShopeeAuthSession();
    ensureWorkerTab().catch(() => {});
    connectWebSocket();
    setInterval(function () {
      if (!state.wsConnected) {
        connectWebSocket();
      }
      triggerQueueCheck();
    }, 10000);
    logEvent(
      "info",
      `ShopVault Kiwi Worker v${EXTENSION_VERSION} aktif (Auto-Close & Raw JSON Murni).`
    );
  });
})();
