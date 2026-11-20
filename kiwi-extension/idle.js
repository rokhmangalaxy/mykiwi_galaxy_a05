(function () {
  "use strict";

  const connBadge = document.getElementById("connBadge");
  const capturedCount = document.getElementById("capturedCount");
  const workerState = document.getElementById("workerState");
  const pauseAlert = document.getElementById("pauseAlert");
  const logBox = document.getElementById("logBox");
  const resumeBtn = document.getElementById("resumeBtn");
  const reconnectBtn = document.getElementById("reconnectBtn");
  const cdpToggle = document.getElementById("cdpToggle");

  function render(st) {
    if (!st) return;
    if (st.wsConnected) {
      connBadge.textContent = `Terhubung :${st.bridgePort}`;
      connBadge.className = "badge ok";
    } else {
      connBadge.textContent = "Menunggu ShopVault";
      connBadge.className = "badge";
    }

    capturedCount.textContent = String(st.capturedCount || 0);
    cdpToggle.checked = st.useCdpDebugger !== false;

    if (st.paused) {
      workerState.textContent = "Dijeda";
      pauseAlert.style.display = "block";
      pauseAlert.textContent = `⚠️ Antrean dijeda: ${st.pauseReason || "Periksa login Shopee lalu klik Lanjutkan Antrean."}`;
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

  resumeBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "RESUME_QUEUE" }, render);
  });

  reconnectBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage(
      { type: "RECONNECT_BRIDGE", useCdpDebugger: cdpToggle.checked },
      render
    );
  });

  cdpToggle.addEventListener("change", function () {
    chrome.runtime.sendMessage(
      { type: "RECONNECT_BRIDGE", useCdpDebugger: cdpToggle.checked },
      render
    );
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "WORKER_STATE_UPDATE") {
      render(msg.state);
    }
  });

  refresh();
})();
