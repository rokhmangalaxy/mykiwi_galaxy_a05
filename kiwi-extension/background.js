/* global ShopeeParser */
(function () {
  "use strict";

  const DEFAULT_PORT = 8765;
  const EXTENSION_VERSION = "1.2.1";
  // Selaras 100% dengan engine Chromium 132 asli di dalam Kiwi Browser Dev
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
  const CAPTURE_TIMEOUT_MS = 24000;
  const RATINGS_GRACE_MS = 1400;
  const LOGIN_BOUNCE_GRACE_MS = 3500;

  const state = {
    bridgeHost: "127.0.0.1",
    bridgePort: DEFAULT_PORT,
    // Matikan CDP debugger secara default agar fingerprint tab Worker 100% identik dengan tab Login!
    useCdpDebugger: false,
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
        blockHeavyMediaOnWorker: true,
      },
      function (items) {
        state.bridgePort = Number(items.bridgePort) || DEFAULT_PORT;
        state.useCdpDebugger = items.useCdpDebuggerV2 === true;
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

      if (
        (details.tabId === state.workerTabId || state.fullDesktopCloak) &&
        /^(intent|shopeeid|market):\/\//i.test(url)
      ) {
        logEvent("info", `Mencegah redirect eksternal: ${url.slice(0, 60)}`);
        return { cancel: true };
      }

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
                "Form Login dibuka! Jika pakai Link WhatsApp: setelah klik Setujui di WA/Shopee, wajib kembali ke tab Kiwi ini sampai masuk Beranda Shopee."
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
    }, 3500);
  }

  // =========================================================================
  // 5. Sequential Queue Worker + Session Check + Capture Engine
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

  async function waitForPendingWhatsAppLoginIfOpen() {
    let auth = await checkShopeeAuthSession();
    if (auth.loggedIn || state.qrLoginTabId === null) {
      return auth;
    }

    // Jika pengguna baru saja klik "Setujui" pada Link WhatsApp di aplikasi WA/Shopee
    // lalu langsung Share produk tanpa sempat kembali ke tab Kiwi, bangunkan poller tab Login!
    logEvent("info", "Membangunkan tab Login Shopee untuk mengambil cookie verifikasi WhatsApp...");
    for (let i = 0; i < 7; i++) {
      if (state.qrLoginTabId !== null) {
        chrome.tabs.sendMessage(state.qrLoginTabId, { type: "WAKE_LOGIN_POLLER" }, function () {
          void chrome.runtime.lastError;
        });
      }
      await new Promise((r) => setTimeout(r, 1000));
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
      logEvent("info", `Jeda aman anti-429 Shopee ${(remain / 1000).toFixed(1)} dtk...`);
      await new Promise((r) => setTimeout(r, remain));
    }
  }

  async function processJob(job) {
    const rawTargetUrl = job.targetUrl || job.affiliateUrl;
    if (!rawTargetUrl) {
      throw new Error("URL target kosong");
    }

    const targetUrl = ShopeeParser.cleanShopeeTargetUrl(rawTargetUrl);
    const isShopeeJob =
      ShopeeParser.isShopeeDomain(safeHostname(targetUrl)) ||
      ShopeeParser.isShortShopeeUrl(targetUrl);

    let auth = state.shopeeAuth;
    if (isShopeeJob) {
      auth = await waitForPendingWhatsAppLoginIfOpen();
    }

    await waitShopeePacingIfNeeded(targetUrl);
    const tabId = await ensureWorkerTab();

    const authTag = isShopeeJob
      ? auth.loggedIn
        ? `[Sesi Shopee: AKTIF${auth.userId ? " UID " + auth.userId : ""}]`
        : "[Sesi Shopee: BELUM ADA COOKIE SPC_EC]"
      : "";
    logEvent("info", `Memuat produk #${job.id}: ${targetUrl} ${authTag}`);

    const result = await captureTabProduct(tabId, job, targetUrl);
    if (isShopeeJob) {
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
      let loginBounceTimer = null;
      let retriedDirectAfterBounce = false;
      let capturedPdpRaw = null;
      let capturedPdpUrl = null;
      let capturedRatingsRaw = null;
      let parsedProduct = null;
      const pendingCdpRequests = new Map();

      function clearLoginBounceTimer() {
        if (loginBounceTimer) {
          clearTimeout(loginBounceTimer);
          loginBounceTimer = null;
        }
      }

      function cleanup() {
        if (mainTimer) clearTimeout(mainTimer);
        if (ratingsTimer) clearTimeout(ratingsTimer);
        clearLoginBounceTimer();
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
        parkWorkerTab();
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
          if (!currentUrl || currentUrl.indexOf("chrome-extension://") === 0) return;

          const block = ShopeeParser.detectBlockedOrLoginState(currentUrl, null);
          if (block.blocked) {
            if (block.status === "CAPTCHA" || block.status === "RATE_LIMITED") {
              const cErr = new Error(block.reason);
              cErr.captureStatus = block.status;
              finishError(cErr);
              return;
            }

            // Status NEED_LOGIN (/buyer/login):
            // 1. Jika cookie SPC_EC di Kiwi sebenarnya AKTIF dan ada parameter ?next=...,
            //    buka ulang URL produk bersih secara langsung (menghindari jebakan redirect lintas-domain shp.ee / universal-link).
            checkShopeeAuthSession().then((auth) => {
              if (settled) return;
              const nextClean = ShopeeParser.extractLoginNextUrl(currentUrl);
              if (auth.loggedIn && !retriedDirectAfterBounce && nextClean) {
                retriedDirectAfterBounce = true;
                clearLoginBounceTimer();
                logEvent(
                  "info",
                  `Cookie Shopee aktif, melewati redirect login menuju: ${nextClean}`
                );
                chrome.tabs.update(tabId, { url: nextClean });
                return;
              }

              // 2. Beri waktu 3.5 detik bagi SPA Shopee untuk auto-redirect jika sesi valid,
              //    sebelum benar-benar memvonis NEED_LOGIN.
              if (!loginBounceTimer) {
                loginBounceTimer = setTimeout(async function () {
                  loginBounceTimer = null;
                  if (settled || parsedProduct) return;
                  const finalAuth = await checkShopeeAuthSession();
                  chrome.tabs.get(tabId, function (latestTab) {
                    void chrome.runtime.lastError;
                    const latestUrl = (latestTab && latestTab.url) || currentUrl;
                    const stillBlocked = ShopeeParser.detectBlockedOrLoginState(latestUrl, null);
                    if (!stillBlocked.blocked) return;

                    const msgText = !finalAuth.loggedIn
                      ? "Cookie login Shopee (SPC_EC) belum tersimpan di Kiwi Dev! Jika pakai Link WhatsApp: setelah klik Setujui di WA/Shopee, buka kembali Kiwi Dev 3 detik sampai masuk Beranda Shopee (indikator Sesi Aktif HIJAU), lalu klik Lanjutkan Antrean."
                      : "Sesi Shopee di Kiwi Dev diminta verifikasi/login ulang oleh Shopee. Klik 'Buka Beranda Shopee' di tab Worker untuk mengecek akun.";
                    const lErr = new Error(msgText);
                    lErr.captureStatus = "NEED_LOGIN";
                    finishError(lErr);
                  });
                }, LOGIN_BOUNCE_GRACE_MS);
              }
            });
            return;
          }

          // Jika tab sudah keluar dari /buyer/login, batalkan timer NEED_LOGIN
          clearLoginBounceTimer();

          // Bersihkan wrapper /universal-link/ atau /opaanlp/ baik format /product/id/id maupun /username/id
          if (
            (currentUrl.includes("/universal-link/") || currentUrl.includes("/opaanlp/")) &&
            ShopeeParser.isShopeeDomain(safeHostname(currentUrl))
          ) {
            const cleaned = ShopeeParser.cleanShopeeTargetUrl(currentUrl);
            if (cleaned && cleaned !== currentUrl) {
              chrome.tabs.update(tabId, { url: cleaned });
              return;
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
                "Timeout menunggu response body produk Shopee (pastikan indikator Sesi Shopee di tab Worker berwarna HIJAU Aktif)"
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
    if (tabId === state.qrLoginTabId && changeInfo.status === "complete") {
      const u = (tab && tab.url) || "";
      if (u.includes("shopee.co.id") && !u.includes("/buyer/login") && !u.includes("/verify/")) {
        state.qrLoginTabId = null;
        checkShopeeAuthSession().then((auth) => {
          if (state.paused) {
            state.paused = false;
            state.pauseReason = null;
          }
          logEvent(
            "info",
            `Login Shopee berhasil! Sesi ${
              auth.loggedIn ? "AKTIF" + (auth.userId ? " (UID: " + auth.userId + ")" : "") : "terdeteksi"
            }.`
          );
          retryBridgeQueueAfterLogin();
        });
      }
    }

    if (
      state.fullDesktopCloak &&
      tabId !== state.workerTabId &&
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
    }, 15000);
    logEvent("info", `ShopVault Kiwi Worker v${EXTENSION_VERSION} aktif.`);
  });
})();
