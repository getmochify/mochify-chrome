(() => {
  // Replace any stale host from a previous extension context (e.g. after reload).
  const stale = document.getElementById("__mochify_host__");
  if (stale) stale.remove();

  // ── Shadow host ──────────────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "__mochify_host__";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "none",
  });
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });

  // ── Styles ───────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700;800&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    .backdrop {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, rgba(255,230,240,0.18) 0%, rgba(255,245,235,0.14) 50%, rgba(255,225,238,0.18) 100%);
      backdrop-filter: blur(10px) saturate(1.5) brightness(0.92);
      -webkit-backdrop-filter: blur(10px) saturate(1.5) brightness(0.92);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      animation: fade-in 0.18s ease;
    }

    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .card {
      width: 100%;
      max-width: 400px;
      border-radius: 24px;
      background: linear-gradient(135deg, rgba(255,255,255,0.52) 0%, rgba(255,255,255,0.20) 100%);
      backdrop-filter: blur(28px) saturate(1.6);
      -webkit-backdrop-filter: blur(28px) saturate(1.6);
      border: 1px solid rgba(255,255,255,0.52);
      box-shadow:
        0 8px 40px rgba(240,98,146,0.20),
        0 2px 8px rgba(0,0,0,0.08),
        inset 0 1px 0 rgba(255,255,255,0.72),
        inset 0 -1px 0 rgba(255,255,255,0.12);
      overflow: hidden;
      position: relative;
      animation: scale-in 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes scale-in {
      from { opacity: 0; transform: scale(0.92) translateY(8px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    .shine {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      height: 2px;
      background: linear-gradient(to right, transparent, rgba(255,255,255,0.88), transparent);
      z-index: 1;
      pointer-events: none;
    }

    .close-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: none;
      background: rgba(255,255,255,0.36);
      color: rgba(135,95,66,0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2;
      transition: background 0.15s, color 0.15s;
      font-size: 16px;
      line-height: 1;
    }
    .close-btn:hover {
      background: rgba(255,255,255,0.62);
      color: rgba(135,95,66,0.9);
    }

    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 44px 10px 16px;
    }

    .preview-bubble {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      overflow: hidden;
      flex-shrink: 0;
      padding: 3px;
      background: rgba(255,255,255,0.28);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.55);
      box-shadow:
        inset 0 2px 4px rgba(255,255,255,0.65),
        inset 0 -2px 4px rgba(0,0,0,0.04),
        0 4px 12px rgba(240,98,146,0.10);
    }

    .preview-bubble img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 9px;
      display: block;
    }

    .header-meta { flex: 1; min-width: 0; }

    .brand {
      font-family: 'Quicksand', system-ui, sans-serif;
      font-size: 11px;
      font-weight: 800;
      color: #F06292;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      line-height: 1;
      margin-bottom: 3px;
    }

    .src-host {
      font-family: 'Quicksand', system-ui, sans-serif;
      font-size: 10px;
      font-weight: 600;
      color: #875F42;
      opacity: 0.5;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .input-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 2px 16px 14px;
    }

    input[type="text"] {
      flex: 1;
      border: none;
      background: transparent;
      font-family: 'Quicksand', system-ui, sans-serif;
      font-size: 13.5px;
      font-weight: 600;
      color: #4A2C2C;
      line-height: 1.55;
      outline: none;
      padding: 6px 0;
      min-width: 0;
    }

    input[type="text"]::placeholder {
      color: #875F42;
      opacity: 0.38;
      font-weight: 500;
    }

    .send-btn {
      flex-shrink: 0;
      width: 44px;
      height: 44px;
      border-radius: 14px;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      cursor: pointer;
    }

    .send-btn:not(:disabled) {
      background: linear-gradient(135deg, #FF9EBB, #F06292);
      color: #fff;
      box-shadow:
        inset 0 2px 4px rgba(255,255,255,0.8),
        0 4px 16px rgba(240,98,146,0.4);
    }

    .send-btn:not(:disabled):hover {
      box-shadow:
        inset 0 2px 4px rgba(255,255,255,0.9),
        0 8px 24px rgba(240,98,146,0.6);
      transform: translateY(-1px);
    }

    .send-btn:disabled {
      background: rgba(255,255,255,0.5);
      color: rgba(240,98,146,0.28);
      border: 1px solid rgba(255,255,255,0.6);
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);
      cursor: not-allowed;
    }

    .footer {
      border-top: 1px solid rgba(255,255,255,0.32);
      background: rgba(255,249,244,0.82);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .progress-track {
      height: 3px;
      background: rgba(255,255,255,0.22);
      overflow: hidden;
      display: none;
    }

    .progress-pulse {
      height: 100%;
      background: linear-gradient(to right, #F06292, #e040a0);
      opacity: 0.65;
      animation: pulse-bar 1.4s ease-in-out infinite;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(to right, #F06292, #e040a0);
      box-shadow: 0 0 10px rgba(240,98,146,0.5);
      transition: width 0.3s ease-out;
      display: none;
    }

    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
    }

    .status-text {
      font-family: 'Quicksand', system-ui, sans-serif;
      font-size: 11px;
      font-weight: 600;
      color: #875F42;
      opacity: 0.7;
      transition: color 0.2s;
    }

    .status-text.error   { color: #e53935; opacity: 1; }
    .status-text.success { color: #388e3c; opacity: 1; }

    .hint-badge {
      font-family: 'Quicksand', system-ui, sans-serif;
      font-size: 10px;
      font-weight: 700;
      color: rgba(46,92,49,0.7);
      background: #e8f5e9;
      padding: 3px 7px;
      border-radius: 6px;
      border: 1px solid rgba(200,230,201,0.55);
      letter-spacing: 0.02em;
    }

    .cta-btn {
      font-family: 'Quicksand', system-ui, sans-serif;
      font-size: 10px;
      font-weight: 800;
      color: #fff;
      background: linear-gradient(135deg, #FF9EBB, #F06292);
      padding: 4px 10px;
      border: none;
      border-radius: 7px;
      cursor: pointer;
      letter-spacing: 0.02em;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(240,98,146,0.35);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .cta-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(240,98,146,0.5); }

    @keyframes spin      { to { transform: rotate(360deg); } }
    @keyframes pulse-bar { 0%, 100% { opacity: 0.65; } 50% { opacity: 0.28; } }

    .spinning { animation: spin 0.9s linear infinite; }
  `;
  shadow.appendChild(style);

  // ── HTML ─────────────────────────────────────────────────────────────────
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.innerHTML = `
    <div class="card">
      <div class="shine"></div>
      <button class="close-btn" aria-label="Close">✕</button>

      <div class="header">
        <div class="preview-bubble">
          <img id="preview" alt="" />
        </div>
        <div class="header-meta">
          <div class="brand">Mochify</div>
          <div class="src-host" id="src-label"></div>
        </div>
      </div>

      <div class="input-row">
        <input type="text" id="prompt"
          placeholder="Make 1:1 square, remove bg, convert to AVIF…" />
        <button class="send-btn" id="btn" disabled>
          <svg id="btn-icon" width="18" height="18" fill="none" stroke="currentColor"
            viewBox="0 0 24 24" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/>
          </svg>
        </button>
      </div>

      <div class="footer">
        <div class="progress-track" id="progress-track">
          <div class="progress-pulse" id="progress-pulse"></div>
          <div class="progress-fill"  id="progress-fill"></div>
        </div>
        <div class="footer-inner">
          <span class="status-text" id="status">Describe what you want…</span>
          <span class="hint-badge" id="hint-badge">↵</span>
          <button class="cta-btn" id="cta" style="display:none"></button>
        </div>
      </div>
    </div>
  `;
  shadow.appendChild(backdrop);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const preview       = shadow.getElementById("preview");
  const srcLabel      = shadow.getElementById("src-label");
  const promptEl      = shadow.getElementById("prompt");
  const btn           = shadow.getElementById("btn");
  const statusEl      = shadow.getElementById("status");
  const progressTrack = shadow.getElementById("progress-track");
  const progressPulse = shadow.getElementById("progress-pulse");
  const progressFill  = shadow.getElementById("progress-fill");
  const closeBtn      = shadow.querySelector(".close-btn");
  const cta           = shadow.getElementById("cta");
  const hintBadge     = shadow.getElementById("hint-badge");

  const SPINNER_SVG = `<svg class="spinning" width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>`;
  const SEND_SVG    = `<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>`;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(msg, type = "") {
    statusEl.textContent = msg;
    statusEl.className = `status-text ${type}`;
  }

  function setProgress(phase, pct = 0) {
    progressTrack.style.display = phase === "idle" ? "none" : "block";
    progressPulse.style.display = phase === "thinking" ? "block" : "none";
    progressFill.style.display  = phase === "uploading" ? "block" : "none";
    if (phase === "uploading") progressFill.style.width = pct + "%";
  }

  function resetCta() {
    cta.style.display = "none";
    hintBadge.style.display = "";
  }

  // Render a structured error from the background, with an optional CTA button.
  function showError(detail) {
    setProgress("idle");
    setStatus(detail?.message || "Something went wrong.", "error");
    if (detail?.action?.url) {
      cta.textContent = detail.action.label;
      cta.dataset.url = detail.action.url;
      cta.style.display = "";
      hintBadge.style.display = "none";
    }
  }

  function openOverlay(imageUrl) {
    try {
      preview.src = imageUrl;
      srcLabel.textContent = new URL(imageUrl).hostname;
    } catch {
      srcLabel.textContent = "";
    }
    promptEl.value = "";
    promptEl.disabled = false;
    btn.disabled = true;
    btn.innerHTML = SEND_SVG;
    resetCta();
    setStatus("Describe what you want…");
    setProgress("idle");

    host.style.display = "block";
    setTimeout(() => promptEl.focus(), 50);
  }

  function closeOverlay() {
    host.style.display = "none";
  }

  // ── Events ────────────────────────────────────────────────────────────────
  closeBtn.addEventListener("click", closeOverlay);

  cta.addEventListener("click", () => {
    if (cta.dataset.url) {
      chrome.runtime.sendMessage({ type: "MOCHIFY_OPEN_TAB", url: cta.dataset.url });
    }
    closeOverlay();
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeOverlay();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && host.style.display !== "none") closeOverlay();
  });

  promptEl.addEventListener("input", () => {
    btn.disabled = !promptEl.value.trim();
  });

  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btn.click();
  });

  btn.addEventListener("click", async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) return;

    btn.disabled = true;
    btn.innerHTML = SPINNER_SVG;
    promptEl.disabled = true;
    resetCta();
    setProgress("thinking");
    setStatus("Parsing prompt…");

    // All API calls go through the background service worker to bypass page CSP/CORS.
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "MOCHIFY_PROCESS",
        imageUrl: preview.src,
        prompt,
      });
    } catch {
      result = { error: { message: "Something went wrong. Please try again.", action: null } };
    }

    if (!result || result.error) {
      const detail = result?.error && typeof result.error === "object"
        ? result.error
        : { message: result?.error || "Something went wrong.", action: null };
      showError(detail);
      btn.innerHTML = SEND_SVG;
      btn.disabled = false;
      promptEl.disabled = false;
      return;
    }

    // Download each format result.
    for (const { base64, contentType, downloadName } of result.results) {
      const byteStr = atob(base64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: contentType });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    }

    const n = result.results.length;
    const doneMsg = n > 1 ? `Done — ${n} files downloaded.` : "Done — file downloaded.";
    setProgress("idle");
    setStatus(result.note || doneMsg, "success");
    btn.innerHTML = SEND_SVG;
    btn.disabled = false;
    btn.addEventListener("click", closeOverlay, { once: true });
  });

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "MOCHIFY_OPEN") {
      openOverlay(msg.imageUrl);
      sendResponse({ ok: true });
    } else if (msg.type === "MOCHIFY_PROGRESS") {
      if (msg.status) setStatus(msg.status);
      if (msg.phase)  setProgress(msg.phase, msg.pct ?? 0);
      sendResponse({ ok: true });
    }
  });
})();
