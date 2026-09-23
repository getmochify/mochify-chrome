const params = new URLSearchParams(location.search);
const imageUrl = params.get("src") ?? "";
// Set by a Convert to ▸ pick: the format is the instruction, so this window has
// nothing to ask and runs the job as soon as it opens.
const convertTo = params.get("convert");

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
const destRow       = document.getElementById("dest-row");
const destSwitch    = document.getElementById("dest-switch");
const destLabel     = document.getElementById("dest-label");
const footerInner   = document.querySelector(".footer-inner");

preview.src = imageUrl;
try { srcLabel.textContent = new URL(imageUrl).hostname; } catch { srcLabel.textContent = ""; }

const SPINNER_SVG = `<svg class="spinning" width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>`;
const SEND_SVG    = `<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>`;

// ── Destination toggle ──────────────────────────────────────────────────────
// Same contract as the in-page overlay: hidden unless the account connected a
// Drive on mochify.app, sticky, and shared with the Convert to ▸ rows.
let saveToDrive = false;

let destBroken = false;

function renderDest(state) {
  if (!state?.driveConnected) {
    destRow.classList.remove("on");
    saveToDrive = false;
    destBroken = false;
    return;
  }
  // Connected but failing its checks: the worker won't mint an upload session
  // for it, so the switch is inert and the row says what to do about it.
  destBroken = !!state.driveBroken;
  saveToDrive = !destBroken && !!state.saveToDrive;
  destLabel.textContent = destBroken
    ? "Drive needs reconnecting"
    : state.folderName
      ? `Save to Drive · ${state.folderName}`
      : "Save to Google Drive";
  destSwitch.setAttribute("aria-checked", saveToDrive ? "true" : "false");
  destSwitch.setAttribute("aria-disabled", destBroken ? "true" : "false");
  // Hover gives the reason; the click gives the fix.
  destLabel.title = destBroken && state.driveDetail ? state.driveDetail : "";
  destRow.classList.toggle("broken", destBroken);
  destRow.classList.add("on");
}

function toggleDest() {
  if (destBroken) {
    chrome.runtime.sendMessage({ type: "MOCHIFY_OPEN_TAB", url: "https://mochify.app/dashboard" });
    return;
  }
  saveToDrive = !saveToDrive;
  destSwitch.setAttribute("aria-checked", saveToDrive ? "true" : "false");
  chrome.runtime.sendMessage({ type: "MOCHIFY_SET_DEST", saveToDrive }).catch(() => {});
}

destSwitch.addEventListener("click", toggleDest);
destLabel.addEventListener("click", toggleDest);

chrome.runtime
  .sendMessage({ type: "MOCHIFY_DEST_STATE", imageUrl })
  .then(renderDest)
  .catch(() => {});

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
  footerInner.classList.remove("has-cta");
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
    // The message needs the full width once it shares the row with a button.
    footerInner.classList.add("has-cta");
  }
}

cta.addEventListener("click", () => {
  if (cta.dataset.url) {
    chrome.runtime.sendMessage({ type: "MOCHIFY_OPEN_TAB", url: cta.dataset.url });
  }
  window.close();
});

// Route through the background service worker — one shared code path and one
// error model with the in-page overlay (content.js).
async function runJob(message) {
  let result;
  try {
    result = await chrome.runtime.sendMessage(message);
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

  // A job sent to Drive answers with a receipt, not a file.
  if (result.saved) {
    setProgress("idle");
    setStatus(`Saved ${result.saved.name} to ${result.saved.where} ✓`, "success");
    btn.innerHTML = SEND_SVG;
    btn.disabled = false;
    promptEl.disabled = false;
    btn.addEventListener("click", () => window.close(), { once: true });
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
  promptEl.disabled = false;
  btn.addEventListener("click", () => window.close(), { once: true });
}

btn.addEventListener("click", () => {
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  btn.disabled = true;
  btn.innerHTML = SPINNER_SVG;
  promptEl.disabled = true;
  resetCta();
  setProgress("thinking");
  setStatus("Processing…");

  runJob({ type: "MOCHIFY_PROCESS", imageUrl, prompt });
});

if (convertTo) {
  promptEl.disabled = true;
  btn.disabled = true;
  btn.innerHTML = SPINNER_SVG;
  setProgress("thinking");
  // Replaced by the background's own status once it knows the source format —
  // except here there is no tab to message, so this line is what stays.
  setStatus("Converting…");
  runJob({ type: "MOCHIFY_CONVERT", imageUrl, format: convertTo });
}

promptEl.addEventListener("input", () => {
  btn.disabled = !promptEl.value.trim();
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btn.click();
});
