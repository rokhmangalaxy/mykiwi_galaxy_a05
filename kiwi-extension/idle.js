(function () {
  "use strict";

  const connBadge = document.getElementById("connBadge");
  const openDashboardBtn = document.getElementById("openDashboardBtn");
  const shopeeSessionBox = document.getElementById("shopeeSessionBox");
  const shopeeSessionTitle = document.getElementById("shopeeSessionTitle");
  const shopeeSessionDesc = document.getElementById("shopeeSessionDesc");
  const openShopeeBtn = document.getElementById("openShopeeBtn");
  const checkAuthBtn = document.getElementById("checkAuthBtn");
  const waLinkInput = document.getElementById("waLinkInput");
  const openWaLinkBtn = document.getElementById("openWaLinkBtn");
  const capturedCount = document.getElementById("capturedCount");
  const workerState = document.getElementById("workerState");
  const pauseAlert = document.getElementById("pauseAlert");
  const logBox = document.getElementById("logBox");
  const qrLoginBtn = document.getElementById("qrLoginBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  const reconnectBtn = document.getElementById("reconnectBtn");
  const cdpToggle = document.getElementById("cdpToggle");
  const cloakToggle = document.getElementById("cloakToggle");
  const autoCloseToggle = document.getElementById("autoCloseToggle");
  const cookieInput = document.getElementById("cookieInput");
  const importCookieBtn = document.getElementById("importCookieBtn");
  const exportCookieBtn = document.getElementById("exportCookieBtn");
  const cookieFeedback = document.getElementById("cookieFeedback");

  function render(st) {
    if (!st) return;
    const dashUrl = `http://${st.bridgeHost || "127.0.0.1"}:${st.bridgePort || 8765}/`;
    connBadge.href = dashUrl;
    if (openDashboardBtn) openDashboardBtn.href = dashUrl;

    if (st.wsConnected) {
      connBadge.textContent = `Terhubung :${st.bridgePort} ↗`;
      connBadge.className = "badge ok";
    } else {
      connBadge.textContent = "Menunggu ShopVault ↗";
      connBadge.className = "badge";
    }

    const auth = st.shopeeAuth || {};
    if (auth.loggedIn) {
      shopeeSessionBox.className = "session-banner ok";
      shopeeSessionTitle.textContent = `✅ Sesi Shopee di Kiwi: AKTIF${
        auth.userId ? " (UID: " + auth.userId + ")" : ""
      }`;
      shopeeSessionDesc.textContent =
        "Cookie sesi SPC_EC aktif di Kiwi Dev. Silakan langsung Share produk dari aplikasi Shopee!";
    } else {
      shopeeSessionBox.className = "session-banner";
      shopeeSessionTitle.textContent = "⚠️ Sesi Shopee di Kiwi: BELUM AKTIF";
      shopeeSessionDesc.textContent =
        "Cookie SPC_EC belum masuk ke Kiwi Dev. Jika baru klik Setujui lewat Link WhatsApp, ketuk 'Buka / Cek Tab Shopee' di bawah agar tab Login selesai masuk ke Beranda.";
    }

    capturedCount.textContent = String(st.capturedCount || 0);
    cdpToggle.checked = st.useCdpDebugger === true;
    cloakToggle.checked = st.fullDesktopCloak !== false;
    if (autoCloseToggle) autoCloseToggle.checked = st.autoCloseShopeeTab !== false;

    if (st.paused) {
      workerState.textContent = "Dijeda";
      pauseAlert.style.display = "block";
      pauseAlert.textContent = `⚠️ Antrean dijeda: ${
        st.pauseReason || "Pastikan Sesi Shopee AKTIF (Hijau) lalu klik Lanjutkan Antrean."
      }`;
    } else if (st.processingJob) {
      workerState.textContent = `Memproses #${st.processingJob.id}`;
      pauseAlert.style.display = "none";
    } else {
      workerState.textContent = "Siaga";
      pauseAlert.style.display = "none";
    }

    const logs = st.logs || [];
    if (logs.length === 0) {
      logBox.textContent = "Belum ada aktivitas.";
    } else {
      logBox.innerHTML = "";
      for (const item of logs) {
        const div = document.createElement("div");
        div.className = `log-item ${item.level || "info"}`;
        const timeStr = (item.ts || "").slice(11, 19);
        div.textContent = `[${timeStr}] ${item.message}`;
        logBox.appendChild(div);
      }
    }
  }

  function refresh() {
    chrome.runtime.sendMessage({ type: "GET_WORKER_STATE" }, function (res) {
      if (!chrome.runtime.lastError && res) {
        render(res);
      }
    });
  }

  openShopeeBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "OPEN_SHOPEE_HOME" }, function (res) {
      if (!chrome.runtime.lastError && res) render(res);
    });
  });

  checkAuthBtn.addEventListener("click", function () {
    checkAuthBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "CHECK_SHOPEE_AUTH" }, function (res) {
      checkAuthBtn.disabled = false;
      if (!chrome.runtime.lastError && res) render(res);
    });
  });

  openWaLinkBtn.addEventListener("click", function () {
    const raw = (waLinkInput.value || "").trim();
    const match = raw.match(/https?:\/\/[^\s<>"')\]}]+/i);
    if (!match) {
      alert("Tempel teks atau link http/https dari pesan WhatsApp Shopee terlebih dahulu.");
      return;
    }
    const url = match[0].replace(/[.,;!?]+$/, "");
    waLinkInput.value = "";
    chrome.tabs.create({ url, active: true });
  });

  qrLoginBtn.addEventListener("click", function () {
    qrLoginBtn.disabled = true;
    qrLoginBtn.textContent = "⏳ Menyiapkan form login baru...";
    chrome.runtime.sendMessage({ type: "RESET_SHOPEE_SESSION_AND_OPEN_QR" }, function (res) {
      qrLoginBtn.disabled = false;
      qrLoginBtn.textContent = "🧹 Reset Cookie & Buka Form Login Baru";
      if (!chrome.runtime.lastError && res) {
        render(res);
      }
    });
  });

  importCookieBtn.addEventListener("click", function () {
    const raw = (cookieInput.value || "").trim();
    if (!raw) {
      cookieFeedback.textContent = "⚠️ Tempel teks JSON / header Cookie terlebih dahulu.";
      return;
    }
    importCookieBtn.disabled = true;
    chrome.runtime.sendMessage(
      { type: "IMPORT_SHOPEE_COOKIES", rawCookies: raw },
      function (res) {
        importCookieBtn.disabled = false;
        if (res && res.ok) {
          cookieFeedback.textContent = `✅ Berhasil memasang ${res.applied} cookie sesi Shopee!`;
          cookieInput.value = "";
          render(res);
        } else {
          cookieFeedback.textContent = `❌ ${(res && res.error) || "Gagal mengimpor cookie"}`;
        }
      }
    );
  });

  exportCookieBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "EXPORT_SHOPEE_COOKIES" }, function (res) {
      if (res && res.ok) {
        cookieInput.value = res.json || "[]";
        cookieInput.select();
        document.execCommand("copy");
        cookieFeedback.textContent = `✅ ${res.count} cookie Shopee disalin ke clipboard!`;
      }
    });
  });

  resumeBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "RESUME_QUEUE" }, render);
  });

  reconnectBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage(
      {
        type: "RECONNECT_BRIDGE",
        useCdpDebugger: cdpToggle.checked,
        fullDesktopCloak: cloakToggle.checked,
        autoCloseShopeeTab: autoCloseToggle ? autoCloseToggle.checked : true,
      },
      render
    );
  });

  function saveSettings() {
    chrome.runtime.sendMessage(
      {
        type: "UPDATE_SETTINGS",
        useCdpDebugger: cdpToggle.checked,
        fullDesktopCloak: cloakToggle.checked,
        autoCloseShopeeTab: autoCloseToggle ? autoCloseToggle.checked : true,
      },
      render
    );
  }

  cdpToggle.addEventListener("change", saveSettings);
  cloakToggle.addEventListener("change", saveSettings);
  if (autoCloseToggle) autoCloseToggle.addEventListener("change", saveSettings);

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "WORKER_STATE_UPDATE") {
      render(msg.state);
    }
  });

  function notifyForegrounded() {
    chrome.runtime.sendMessage({ type: "APP_FOREGROUNDED" }, function (res) {
      if (!chrome.runtime.lastError && res) {
        render(res);
      }
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) notifyForegrounded();
  });
  window.addEventListener("focus", notifyForegrounded);

  notifyForegrounded();
})();
