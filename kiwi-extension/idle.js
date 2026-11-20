(function () {
  "use strict";

  const connBadge = document.getElementById("connBadge");
  const openDashboardBtn = document.getElementById("openDashboardBtn");
  const capturedCount = document.getElementById("capturedCount");
  const workerState = document.getElementById("workerState");
  const pauseAlert = document.getElementById("pauseAlert");
  const logBox = document.getElementById("logBox");
  const qrLoginBtn = document.getElementById("qrLoginBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  const reconnectBtn = document.getElementById("reconnectBtn");
  const cdpToggle = document.getElementById("cdpToggle");
  const cloakToggle = document.getElementById("cloakToggle");
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

    capturedCount.textContent = String(st.capturedCount || 0);
    cdpToggle.checked = st.useCdpDebugger !== false;
    cloakToggle.checked = st.fullDesktopCloak !== false;

    if (st.paused) {
      workerState.textContent = "Dijeda";
      pauseAlert.style.display = "block";
      pauseAlert.textContent = `⚠️ Antrean dijeda: ${st.pauseReason || "Silakan login Shopee di Kiwi Dev lalu klik Lanjutkan Antrean."}`;
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

  qrLoginBtn.addEventListener("click", function () {
    qrLoginBtn.disabled = true;
    qrLoginBtn.textContent = "⏳ Menyiapkan form login tengah layar...";
    chrome.runtime.sendMessage({ type: "RESET_SHOPEE_SESSION_AND_OPEN_QR" }, function (res) {
      qrLoginBtn.disabled = false;
      qrLoginBtn.textContent = "🧹 Reset Cookie & Buka Form Login (Tengah Layar)";
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
      },
      render
    );
  }

  cdpToggle.addEventListener("change", saveSettings);
  cloakToggle.addEventListener("change", saveSettings);

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "WORKER_STATE_UPDATE") {
      render(msg.state);
    }
  });

  refresh();
})();
