const params = new URLSearchParams(location.search);
const imageUrl = params.get("src") ?? "";

const preview     = document.getElementById("preview");
const srcLabel    = document.getElementById("src-label");
const promptEl    = document.getElementById("prompt");
const btn         = document.getElementById("btn");
const statusEl    = document.getElementById("status");
const hintBadge   = document.getElementById("hint-badge");
const cta         = document.getElementById("cta");
const progressTrack = document.getElementById("progress-track");
const progressPulse = document.getElementById("progress-pulse");
const progressFill  = document.getElementById("progress-fill");

preview.src = imageUrl;
try { srcLabel.textContent = new URL(imageUrl).hostname; } catch { srcLabel.textContent = ""; }

const SPINNER_SVG = `<svg class="spinning" width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>`;
const SEND_SVG    = `<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>`;

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

cta.addEventListener("click", () => {
  if (cta.dataset.url) {
    chrome.runtime.sendMessage({ type: "MOCHIFY_OPEN_TAB", url: cta.dataset.url });
  }
  window.close();
});

btn.addEventListener("click", async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  btn.disabled = true;
  btn.innerHTML = SPINNER_SVG;
  promptEl.disabled = true;
  resetCta();
  setProgress("thinking");
  setStatus("Processing…");

  // Route through the background service worker — one shared code path and one
  // error model with the in-page overlay (content.js).
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "MOCHIFY_PROCESS", imageUrl, prompt });
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

  // Download each format result (background returns base64).
  for (const { base64, contentType, downloadName } of result.results) {
    const byteStr = atob(base64);
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(blobUrl);
  }

  const n = result.results.length;
  setProgress("idle");
  setStatus(result.note || (n > 1 ? `Done — ${n} files downloaded.` : "Done — file downloaded."), "success");
  btn.innerHTML = SEND_SVG;
  btn.disabled = false;
  btn.addEventListener("click", () => window.close(), { once: true });
});

promptEl.addEventListener("input", () => {
  btn.disabled = !promptEl.value.trim();
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btn.click();
});
