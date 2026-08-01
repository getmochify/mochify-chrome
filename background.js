importScripts("lib/fflate.js"); // exposes self.fflate (zipSync) for batch downloads

const API        = "https://api.mochify.app";
const WORKER_URL = "https://tokens.mochify.app";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-to-mochify",
    title: "Send to Mochify...",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "send-to-mochify" || !info.srcUrl) return;

  const imageUrl = info.srcUrl;

  if (!tab?.id) {
    fallbackWindow(imageUrl);
    return;
  }

  try {
    // Always re-inject so a stale context (after extension reload) gets replaced.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, { type: "MOCHIFY_OPEN", imageUrl });
  } catch {
    fallbackWindow(imageUrl);
  }
});

// ── Message router — all Mochify fetch calls run here to bypass page CSP/CORS ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MOCHIFY_PROCESS") {
    const tabId = sender.tab?.id ?? null;
    processImage(msg.imageUrl, msg.prompt, tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.detail ?? genericError(err) }));
    return true; // Keep channel open for async sendResponse
  }
  if (msg.type === "MOCHIFY_OPEN_TAB" && msg.url) {
    // CTA buttons in the overlay/window route here so we can open a real tab.
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
    return; // sync
  }
});

// ── Auth + error helpers ────────────────────────────────────────────────────
function authUrl() {
  return `https://mochify.app/auth/extension?ext=${chrome.runtime.id}`;
}

async function clearAuth() {
  await chrome.storage.sync.remove(["apiKey", "userEmail"]);
}

// Structured, user-facing errors. `action` (if present) drives the CTA button.
function errorDetail(code) {
  switch (code) {
    case "auth_expired":
      return {
        code,
        message: "Your Mochify session has expired. Sign in again to keep going.",
        action: { label: "Sign in", url: authUrl() },
      };
    case "limit_anon":
      return {
        code,
        message: "You've hit the free limit. Sign in for 25 images a month, free.",
        action: { label: "Sign in — it's free", url: authUrl() },
      };
    case "limit_authed":
      return {
        code,
        message: "You've used all your images this month. Upgrade for more.",
        action: { label: "Upgrade plan", url: "https://mochify.app/pricing" },
      };
    default:
      return { code: "generic", message: "Something went wrong. Please try again.", action: null };
  }
}

function genericError(err) {
  return {
    code: "generic",
    message: err?.message || "Something went wrong. Please try again.",
    action: null,
  };
}

// Wrap a structured error code in an Error so it can flow through throw/catch.
function fail(code) {
  const detail = errorDetail(code);
  const e = new Error(detail.message);
  e.detail = detail;
  return e;
}

// Map an HTTP failure to a structured error, clearing dead auth as a side effect.
async function classifyHttp(status, authed) {
  if (status === 401 || status === 403) {
    await clearAuth();
    return fail("auth_expired");
  }
  if (status === 429) {
    return fail(authed ? "limit_authed" : "limit_anon");
  }
  return fail("generic");
}

// GET /v1/checkTokens → { available, plan, quota, remaining } or null on failure.
async function fetchTokens(authHeader) {
  try {
    const res = await fetch(`${API}/v1/checkTokens`, { headers: authHeader });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function processImage(imageUrl, prompt, tabId) {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  const authHeader = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const filename = imageUrl.split("?")[0].split("/").pop() || "image.jpg";

  function progress(status, phase, pct) {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "MOCHIFY_PROGRESS", status, phase, pct })
        .catch(() => {});
    }
  }

  // ── Pre-flight: one call validates auth AND quota, so we fail fast with the
  // right CTA instead of a dead-end 429 mid-process. A stored key the API
  // reports as plan "ip" has been silently downgraded to anonymous (revoked /
  // expired) — clear it and prompt re-sign-in rather than looping on 429s.
  let authed = !!apiKey;
  const tokens = await fetchTokens(authHeader);
  if (tokens) {
    authed = !!apiKey && !!tokens.plan && tokens.plan !== "ip";
    if (apiKey && !authed) {
      await clearAuth();
      throw fail("auth_expired");
    }
    if (tokens.remaining <= 0 || tokens.available === false) {
      throw fail(authed ? "limit_authed" : "limit_anon");
    }
  }

  // 1. Fetch original image first so we can pass real dimensions to NLP.
  progress("Fetching image…", "thinking");
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    const e = new Error("Couldn't fetch that image.");
    e.detail = {
      code: "generic",
      message: "Couldn't fetch that image — try saving it, then use mochify.app.",
      action: null,
    };
    throw e;
  }
  const imgBlob = await imgRes.blob();

  // Decode dimensions so the NLP can compute square crops correctly.
  let imgWidth = 0, imgHeight = 0;
  try {
    const bitmap = await createImageBitmap(imgBlob);
    imgWidth = bitmap.width;
    imgHeight = bitmap.height;
    bitmap.close();
  } catch { /* fall through with 0×0 — NLP degrades gracefully */ }

  // 2. Parse prompt via worker NLP.
  progress("Parsing prompt…", "thinking");
  const parseRes = await fetch(`${WORKER_URL}/v1/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ prompt, fileData: [{ name: filename, width: imgWidth, height: imgHeight }] }),
  });
  if (!parseRes.ok) throw await classifyHttp(parseRes.status, authed);
  const parsed = await parseRes.json();
  const baseParams = Array.isArray(parsed.files)
    ? parsed.files[0]
    : (parsed.files ?? parsed);

  // Fan out into one request per (size × format), driven by the NLP's arrays —
  // same as the web app, so multi-size works, not just multi-format.
  const formats = Array.isArray(baseParams.types) && baseParams.types.length > 1
    ? baseParams.types
    : [baseParams.type || filename.split(".").pop() || "jpg"];
  const sizes = Array.isArray(baseParams.sizes) && baseParams.sizes.length > 1
    ? baseParams.sizes
    : [{ width: baseParams.width, height: baseParams.height }];
  const multiFormat = formats.length > 1;
  const multiSize = sizes.length > 1;

  // Build the squish query exactly as the web app does, so the extension and
  // frontend send byte-identical params for the same NLP output: booleans → "1"
  // (omitted when false), strip_exif defaults on, brightness only when set.
  // Background removal needs auth — strip it for signed-out users (the backend
  // 403s otherwise) and note it, mirroring the frontend's upsell.
  const bgRemovalBlocked = !!baseParams.removeBackground && !authed;
  const sharedParams = new URLSearchParams();
  if (baseParams.smartCompress) sharedParams.append("smartCompress", "1");
  if (baseParams.smartCrop) sharedParams.append("smartCrop", "1");
  if (baseParams.removeBackground && authed) sharedParams.append("removeBackground", "1");
  if (baseParams.background) sharedParams.append("background", String(baseParams.background));
  const stripExif = baseParams.stripExif !== undefined ? baseParams.stripExif : 1;
  sharedParams.append("strip_exif", stripExif ? "1" : "0");
  if (baseParams.rotate) sharedParams.append("rotate", String(baseParams.rotate));
  if (baseParams.brightness != null && baseParams.brightness !== 0)
    sharedParams.append("brightness", String(baseParams.brightness));
  if (baseParams.clarity) sharedParams.append("clarity", "1");
  if (baseParams.optimizeForWeb) sharedParams.append("optimizeForWeb", "1");
  if (baseParams.hdr) sharedParams.append("hdr", "1");
  if (baseParams.quality != null) sharedParams.append("quality", String(baseParams.quality));

  const variants = [];
  for (const size of sizes) {
    for (const fmt of formats) {
      const query = new URLSearchParams(sharedParams.toString());
      query.append("type", fmt);
      if (size?.width) query.append("width", String(size.width));
      if (size?.height) query.append("height", String(size.height));
      const sizeSuffix = multiSize
        ? (size?.width && size?.height
            ? `_${size.width}x${size.height}`
            : size?.width || size?.height
              ? `_${size.width || size.height}w`
              : "")
        : "";
      const fmtSuffix = multiFormat ? `_${fmt}` : "";
      variants.push({ query, suffix: `${sizeSuffix}${fmtSuffix}` });
    }
  }

  // 3. Squish each variant in parallel.
  const label = variants.length > 1 ? `Processing ${variants.length} variants…` : "Processing…";
  progress(label, "uploading", 30);

  const baseName = filename.replace(/\.[^.]+$/, "");

  const outputs = await Promise.all(variants.map(async ({ query, suffix }) => {
    const squishRes = await fetch(`${API}/v1/squish?${query}`, {
      method: "POST",
      headers: { "Content-Type": imgBlob.type || "image/jpeg", ...authHeader },
      body: imgBlob,
    });
    if (!squishRes.ok) throw await classifyHttp(squishRes.status, authed);
    const buf = await squishRes.arrayBuffer();
    const ct  = squishRes.headers.get("Content-Type") ?? "image/webp";
    const ext = ct.split("/")[1]?.split(";")[0] ?? "webp";
    return { bytes: new Uint8Array(buf), contentType: ct, downloadName: `${baseName}_mochified${suffix}.${ext}` };
  }));

  progress(null, "uploading", 90);

  const note = bgRemovalBlocked ? "Saved — sign in to also remove the background." : null;

  // More than one output → zip it, so the user gets a single download instead of
  // Chrome's "download multiple files" permission prompt.
  if (outputs.length > 1) {
    progress("Packing zip…", "uploading", 95);
    const files = {};
    for (const o of outputs) files[o.downloadName] = o.bytes;
    const zipped = fflate.zipSync(files, { level: 0 });
    return {
      ok: true,
      note,
      results: [{ base64: toBase64(zipped), contentType: "application/zip", downloadName: `${baseName}_mochified.zip` }],
    };
  }

  const only = outputs[0];
  return {
    ok: true,
    note,
    results: [{ base64: toBase64(only.bytes), contentType: only.contentType, downloadName: only.downloadName }],
  };
}

// Base64-encode bytes in chunks (avoids call-stack limits on large buffers).
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

// Receive auth token pushed from mochify.app/auth/extension after sign-in.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "MOCHIFY_AUTH") return;
  if (!sender.url?.startsWith("https://mochify.app/")) return;
  chrome.storage.sync.set({ apiKey: msg.apiKey, userEmail: msg.email }, () => {
    sendResponse({ ok: true });
  });
  return true;
});

function fallbackWindow(imageUrl) {
  chrome.windows.create({
    url: `${chrome.runtime.getURL("prompt/prompt.html")}?src=${encodeURIComponent(imageUrl)}`,
    type: "popup",
    width: 420,
    height: 240,
    focused: true,
  });
}
