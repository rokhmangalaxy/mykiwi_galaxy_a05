/* global ShopeeParser */
(function () {
  "use strict";

  const DEFAULT_PORT = 8765;
  const DESKTOP_CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

  // Anti-429 pacing measured on Shopee PDP (9-13s between consecutive Shopee loads)
  const SHOPEE_MIN_JITTER_MS = 9000;
  const SHOPEE_MAX_JITTER_MS = 13000;
  const CAPTURE_TIMEOUT_MS = 22000;
  const RATINGS_GRACE_MS = 1400;

  const state = {
    bridgeHost: "127.0.0.1",
    bridgePort: DEFAULT_PORT,
    useCdpDebugger: true,
    blockHeavyMediaOnWorker: true,
    wsConnected: false,
    paused: false,
    pauseReason: null,
    workerTabId: null,
    processingJob: null,
    lastShopeeCaptureAt: 0,
    capturedCount: 0,
    logs: [],
  };

  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let pollTimer = null;
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
      chrome.runtime.sendMessage({
        type: "WORKER_STATE_UPDATE",
        state: getPublicState(),
      }, function () {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  function getPublicState() {
    return {
      bridgeHost: state.bridgeHost,
      bridgePort: state.bridgePort,
      useCdpDebugger: state.useCdpDebugger,
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
        blockHeavyMediaOnWorker: true,
      },
      function (items) {
        state.bridgePort = Number(items.bridgePort) || DEFAULT_PORT;
        state.useCdpDebugger = items.useCdpDebugger !== false;
        state.blockHeavyMediaOnWorker = items.blockHeavyMediaOnWorker !== false;
        if (cb) cb();
      }
    );
  }

  // =========================================================================
  // 1. Scoped webRequest guards ONLY for workerTabId
  // =========================================================================
  chrome.webRequest.onBeforeRequest.addListener(
    function (details) {
      if (details.tabId === -1 || details.tabId !== state.workerTabId) {
        return {};
      }
      const url = details.url || "";
      // Block deep-link schemes so Android never switches out of Shopee app
      if (/^(intent|shopeeid|market|lazada|tokopedia):\/\//i.test(url)) {
        logEvent("info", `Mencegah redirect eksternal: ${url.slice(0, 60)}`);
        return { cancel: true };
      }
      // Save Galaxy A05 RAM & bandwidth: skip video/font binary downloads on worker tab
      // (Video .mp4 URL is already captured from the JSON API response!)
      if (
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

  chrome.webRequest.onBeforeSendHeaders.addListener(
    function (details) {
      if (details.tabId === -1 || details.tabId !== state.workerTabId) {
        return {};
      }
      if (!ShopeeParser.isShopeeDomain( safeHostname(details.url) )) {
        return {};
      }
      const headers = details.requestHeaders || [];
      let replaced = false;
      for (const h of headers) {
        if (h.name.toLowerCase() === "user-agent") {
          h.value = DESKTOP_CHROME_UA;
          replaced = true;
        }
      }
      if (!replaced) {
        headers.push({ name: "User-Agent", value: DESKTOP_CHROME_UA });
      }
      return { requestHeaders: headers };
    },
    { urls: ["*://*.shopee.co.id/*", "*://*.shopee.tw/*", "*://*.shopee.sg/*", "*://*.shopee.com.my/*", "*://*.shp.ee/*", "*://*.shope.ee/*"] },
    ["blocking", "requestHeaders"]
  );

  function safeHostname(u) {
    try {
      return new URL(u).hostname;
    } catch (_) {
      return "";
    }
  }

  // =========================================================================
  // 2. Worker Anchor Tab Management (prevents kNoCurrentWindowError & saves RAM)
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
  });

  function parkWorkerTab() {
    if (state.workerTabId === null) return;
    chrome.tabs.update(state.workerTabId, { url: idlePageUrl() }, function () {
      void chrome.runtime.lastError;
    });
  }

  // =========================================================================
  // 3. WebSocket + HTTP Bridge Client to ShopVault (com.mykiwi.vault)
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
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      state.wsConnected = true;
      logEvent("info", `Terhubung ke ShopVault (${state.bridgeHost}:${state.bridgePort})`);
      safeWsSend({
        type: "hello",
        client: "kiwi-extension",
        version: "1.0.0",
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
  // 4. Sequential Queue Worker + Anti-429 Jitter + Dual Capture (CDP + Hook)
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

            // Give ratings API a brief window (1.4s) to arrive if not here yet
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

          // Check login / captcha redirect immediately
          const block = ShopeeParser.detectBlockedOrLoginState(currentUrl, null);
          if (block.blocked) {
            const err = new Error(block.reason);
            err.captureStatus = block.status;
            finishError(err);
            return;
          }

          // If short link redirected to universal-link / opaanlp / slug, normalize to clean /product/{shopId}/{itemId}
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

          // Non-Shopee generic web fallback once page finishes loading
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
        // Final attempt via DOM snapshot before declaring timeout
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
                "Timeout menunggu response body produk (cek koneksi atau sesi login Shopee di Kiwi Dev)"
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
                chrome.debugger.sendCommand(
                  { tabId },
                  "Network.setUserAgentOverride",
                  { userAgent: DESKTOP_CHROME_UA },
                  function () {
                    void chrome.runtime.lastError;
                    startNavigation();
                  }
                );
              }
            );
          } else {
            // Fallback seamlessly to page_hook.js XHR/fetch capture
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
  // 5. Runtime Messaging (Content Script + Popup/Idle Dashboard UI)
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

    if (msg.type === "RECONNECT_BRIDGE") {
      if (msg.bridgePort) {
        state.bridgePort = Number(msg.bridgePort) || DEFAULT_PORT;
        chrome.storage.local.set({ bridgePort: state.bridgePort });
      }
      if (typeof msg.useCdpDebugger === "boolean") {
        state.useCdpDebugger = msg.useCdpDebugger;
        chrome.storage.local.set({ useCdpDebugger: state.useCdpDebugger });
      }
      try {
        if (ws) ws.close();
      } catch (_) {}
      connectWebSocket();
      sendResponse(getPublicState());
      return true;
    }

    return false;
  });

  // Boot worker
  loadSettings(function () {
    ensureWorkerTab().catch(() => {});
    connectWebSocket();
    pollTimer = setInterval(function () {
      if (!state.wsConnected) {
        connectWebSocket();
      }
      triggerQueueCheck();
    }, 15000);
    logEvent("info", "ShopVault Kiwi Worker siap di latar belakang.");
  });
})();
