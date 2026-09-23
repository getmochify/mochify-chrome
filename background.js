importScripts("lib/fflate.js"); // exposes self.fflate (zipSync/unzipSync) for multi-variant jobs

const API        = "https://api.mochify.app";
const WORKER_URL = "https://id.mochify.app";

// Plans core lets through its generative (shadow / background) gate. Deliberately
// NOT the same as "paid": "lite" pays for quota but not for generative features,
// so it sits outside this set — mirrors core's gate in SquishPipeline.
const GENERATIVE_PLANS = new Set(["seller", "pro", "growth", "day"]);

// Canonical format → MIME. Used to type variants pulled out of a multi-variant
// ZIP, whose entries carry no content type of their own.
const MIME_BY_FMT = {
  jpg:  "image/jpeg",
  png:  "image/png",
  webp: "image/webp",
  avif: "image/avif",
  jxl:  "image/jxl",
};

// Quick-convert targets, in menu order. `id` is what core is asked for (a
// `type` for squish; "pdf" routes to op=create instead), `label` is the menu row.
//
// Chrome builds this menu from items registered here, at install time — there is
// no onShown hook (that's Firefox), and the image URL isn't known until the
// click — so a row can't name the source format. The overlay does that once it
// has the bytes, where it's a fact rather than a guess from the URL.
const QUICK_FORMATS = [
  { id: "jpg",  label: "JPG" },
  { id: "webp", label: "WebP" },
  { id: "avif", label: "AVIF" },
  { id: "jxl",  label: "JPEG XL" },
  { id: "png",  label: "PNG" },
  { id: "pdf",  label: "PDF" },
];

const CONVERT_PREFIX = "convert:";

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: create() on an id that already exists throws, and an
  // upgrade re-runs this over the previous install's menu.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "send-to-mochify",
      title: "Send to Mochify...",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "quick-convert",
      title: "Convert to",
      contexts: ["image"],
    });
    for (const fmt of QUICK_FORMATS) {
      // PDF is a different endpoint and a different kind of output; the rule
      // says so without a word of explanation.
      if (fmt.id === "pdf") {
        chrome.contextMenus.create({
          id: "quick-convert-sep",
          type: "separator",
          parentId: "quick-convert",
          contexts: ["image"],
        });
      }
      chrome.contextMenus.create({
        id: CONVERT_PREFIX + fmt.id,
        parentId: "quick-convert",
        title: fmt.label,
        contexts: ["image"],
      });
    }
    // The menu is recreated with default titles on every install/update, so the
    // stored preference has to be re-applied over it.
    refreshQuickMenuLabel();
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.srcUrl) return;
  const id = String(info.menuItemId);
  // A Convert to ▸ row skips the prompt entirely: the format IS the instruction,
  // so there is nothing to type and nothing to parse.
  const convertTo = id.startsWith(CONVERT_PREFIX) ? id.slice(CONVERT_PREFIX.length) : null;
  if (id !== "send-to-mochify" && !convertTo) return;

  const imageUrl = info.srcUrl;

  // Before anything else, including the content-script injection: this is the
  // earliest the URL is known, and the user is about to spend several seconds
  // typing a prompt that none of the prefetched work depends on.
  startPrefetch(imageUrl);

  if (!tab?.id) {
    fallbackWindow(imageUrl, convertTo);
    return;
  }

  try {
    // Always re-inject so a stale context (after extension reload) gets replaced.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, {
      type: "MOCHIFY_OPEN",
      imageUrl,
      // The overlay opens straight into its working state when this is set.
      convertTo,
    });
  } catch {
    fallbackWindow(imageUrl, convertTo);
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
  if (msg.type === "MOCHIFY_CONVERT") {
    const tabId = sender.tab?.id ?? null;
    convertImage(msg.imageUrl, msg.format, tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.detail ?? genericError(err) }));
    return true; // Keep channel open for async sendResponse
  }
  if (msg.type === "MOCHIFY_DEST_STATE") {
    destinationState(msg.imageUrl)
      .then(sendResponse)
      .catch(() => sendResponse({ driveConnected: false, folderName: null, saveToDrive: false }));
    return true;
  }
  if (msg.type === "MOCHIFY_SET_DEST") {
    chrome.storage.sync.set({ saveToDrive: !!msg.saveToDrive }, () => {
      refreshQuickMenuLabel();
      sendResponse({ ok: true });
    });
    return true;
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
    // The button already names the action, so the message doesn't repeat it —
    // it says what happened and what the account would get.
    case "auth_expired":
      return {
        code,
        message: "Your Mochify session has expired.",
        action: { label: "Sign in again", url: authUrl() },
      };
    case "limit_anon":
      return {
        code,
        message: "Monthly limit reached — accounts get 25 images a month.",
        action: { label: "Sign in — it's free", url: authUrl() },
      };
    case "limit_authed":
      return {
        code,
        message: "You've used all your images this month.",
        action: { label: "Upgrade plan", url: "https://mochify.app/pricing" },
      };
    case "limit_generate":
      return {
        code,
        message: "Drop shadows and generated backgrounds need a paid plan.",
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
// `overrides` lets a caller keep the code and CTA but say something more exact
// (e.g. how many images short of the job the account actually is).
function fail(code, overrides) {
  const detail = { ...errorDetail(code), ...overrides };
  const e = new Error(detail.message);
  e.detail = detail;
  return e;
}

// Map an HTTP failure to a structured error, clearing dead auth as a side effect.
// Core answers in text/plain, and its 403 is overloaded: a bad key AND a
// generative request from a plan that isn't entitled to one both land here. Only
// the first is a dead key — clearing auth on the second would sign the user out
// for asking for a drop shadow, so the body is what separates them.
async function classifyHttp(res, authed) {
  let body = "";
  try { body = (await res.clone().text()).slice(0, 300).trim(); } catch { /* empty body */ }

  if (res.status === 403 && /paid plan/i.test(body)) return fail("limit_generate");
  if (res.status === 401 || res.status === 403) {
    await clearAuth();
    return fail("auth_expired");
  }
  if (res.status === 429) {
    return fail(authed ? "limit_authed" : "limit_anon");
  }
  // 4xx here is core rejecting the request itself (an unsupported format, a
  // decompression bomb, a size over the plan ceiling). Its own wording is far
  // more useful than "something went wrong", so pass it through.
  if (res.status >= 400 && res.status < 500 && body) {
    return fail("generic", { message: body });
  }
  return fail("generic");
}

// mochify-core seeds an anonymous (IP-metered) bucket with 3 ops, and the worker
// reports that same number as the quota for any caller it could not resolve to a
// user. Keep in step with ANON_QUOTA in mochify-worker / TokenLimiter.cc.
const ANON_QUOTA = 3;

// Whether /v1/usage answered as an anonymous caller. The worker carries no
// explicit "this key didn't resolve" flag: an unknown or expired key simply
// falls through to the anonymous branch, which reports plan "free" with the
// 3-op anonymous allowance instead of the free plan's 25. That pairing is the
// only signal available that a stored key is dead — plan alone never says so,
// because /v1/usage computes its own plan and never returns the bucket's "ip".
// Replace this with an explicit flag if /v1/usage ever grows one.
function resolvedAsAnonymous(tokens) {
  return tokens.plan === "free" && tokens.quota === ANON_QUOTA;
}

// GET /v1/usage → { available, plan, quota, remaining, drive? } or null on
// failure. `integrations` opts into the Drive lookup: the worker only pays for
// the D1 read when asked, and the answer is the only way the extension can know
// whether this account connected a Drive (that route is internal-token only).
async function fetchTokens(authHeader, { integrations = false } = {}) {
  try {
    const url = `${WORKER_URL}/v1/usage${integrations ? "?integrations=1" : ""}`;
    const res = await fetch(url, { headers: authHeader });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Destination ─────────────────────────────────────────────────────────────
// The extension never talks to Google. Drive is a per-account connection made
// on mochify.app, and core uploads with the refresh token it already holds —
// `dest=drive&name=…` on the request it was going to make anyway. So there is
// no OAuth here, no Google scope in the manifest, and nothing new to review.

// A Drive whose last check failed (revoked grant, full account) can't take an
// upload: the worker refuses to mint a session for it (handleSessionUserDrive
// gates on status === 'ok'), so nothing is offered against it.
function driveOffered(tokens) {
  return !!tokens?.drive?.connected && (tokens.drive.status ?? "ok") === "ok";
}

async function saveToDrivePref() {
  const { saveToDrive } = await chrome.storage.sync.get("saveToDrive");
  return !!saveToDrive;
}

// What the overlay needs to decide whether to show the toggle, and where it
// points. Peeks the in-flight prefetch rather than consuming it — the overlay
// asks for this in the same tick the prefetch starts.
async function destinationState(imageUrl) {
  let tokens = prefetched && prefetched.imageUrl === imageUrl ? await prefetched.tokens : null;
  if (!tokens) {
    const { apiKey } = await chrome.storage.sync.get("apiKey");
    tokens = await fetchTokens(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, {
      integrations: true,
    });
  }
  // A connection that exists but is broken is reported as such rather than
  // hidden: a toggle that silently vanishes tells the user nothing, and this is
  // the one state they can actually fix.
  const connected = !!tokens?.drive?.connected;
  const state = {
    driveConnected: connected,
    driveBroken: connected && !driveOffered(tokens),
    folderName: tokens?.drive?.folderName ?? null,
    // The worker's own words for why a connection isn't usable ("the grant was
    // revoked", "the folder is gone"), so the row can say more than "broken".
    driveDetail: tokens?.drive?.statusDetail ?? null,
    saveToDrive: await saveToDrivePref(),
  };
  if (!connected) {
    // Why the row isn't there at all: no account, no Drive, or a usage call
    // that didn't come back. Visible in the service worker console.
    console.log("[mochify] no Drive to offer —", tokens?.drive ?? (tokens ? "no drive field" : "no usage response"));
  }
  return state;
}

// The quick-convert rows obey the same preference, and a menu that fires
// without opening anything first has to say where the file will land BEFORE the
// click. This title is per-preference, not per-image, so unlike naming the
// source format there is no race to lose: it's rewritten when the toggle moves.
async function refreshQuickMenuLabel() {
  const on = await saveToDrivePref();
  chrome.contextMenus.update("quick-convert", {
    title: on ? "Convert to (→ Drive)" : "Convert to",
  }, () => void chrome.runtime.lastError);
}

// ── Prefetch ────────────────────────────────────────────────────────────────
// Everything processImage() needs that does NOT depend on the prompt text: the
// quota check, the image bytes, and the decoded dimensions. All three used to
// run on submit, ahead of the NLP parse — so the user waited through them after
// committing, even though the image URL has been known since the right-click and
// they were about to spend several seconds typing.
//
// The image is the valuable one. The parse can't start without its dimensions,
// so it isn't merely parallel work: it's a blocker sitting on the critical path
// in front of the slowest call in the chain.
//
// One slot, because there is one overlay at a time, and it holds promises rather
// than values — the overlay opens and the prefetch starts in the same tick, so a
// fast submit has to await the in-flight work rather than start a second copy.
//
// Best-effort by construction: MV3 can terminate this worker while the user
// types, taking the slot with it, and a page's image may simply not be fetchable
// from here. So nothing below ever throws, and processImage() stays able to do
// the whole job itself.
let prefetched = null;

function startPrefetch(imageUrl) {
  prefetched = {
    imageUrl,
    tokens: (async () => {
      const { apiKey } = await chrome.storage.sync.get("apiKey");
      return fetchTokens(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, {
        integrations: true,
      });
    })().catch(() => null),
    // A failed load resolves to null rather than rejecting, so the real attempt
    // re-runs it and the user gets the error from the path that owns it.
    image: loadImage(imageUrl).catch(() => null),
  };
}

// Consume the slot: a second attempt on the same image (a retry after a 429, say)
// should fetch fresh rather than reuse this, and dropping the reference releases
// what may be a several-MB blob held in the worker.
function takePrefetch(imageUrl) {
  if (!prefetched || prefetched.imageUrl !== imageUrl) return null;
  const hit = prefetched;
  prefetched = null;
  return hit;
}

// Fetch the original and decode its dimensions. The decode is part of loading
// rather than an extra: the worker needs real pixels to resolve relative intent
// ("50%", "9:16") server-side, and without them those prompts come back a no-op.
async function loadImage(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    const e = new Error("Couldn't fetch that image.");
    e.detail = {
      code: "generic",
      message: "Couldn't fetch that image — try saving it, then use mochify.app.",
      action: null,
    };
    throw e;
  }
  const blob = await res.blob();

  let width = 0, height = 0;
  try {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch { /* fall through with 0×0 — NLP degrades gracefully */ }

  return { blob, width, height };
}

// Status line back to whichever UI is open (overlay or fallback window). Both
// jobs report through the same channel, so the UI needs no idea which ran.
function progressReporter(tabId) {
  return function progress(status, phase, pct) {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "MOCHIFY_PROGRESS", status, phase, pct })
        .catch(() => {});
    }
  };
}

// Everything both jobs must do before they can spend a token: resolve auth,
// check quota, and get the bytes. One call validates auth AND quota, so we fail
// fast with the right CTA instead of a dead-end 429 mid-process. A stored key
// the API reports as anonymous has been silently downgraded (revoked / expired)
// — clear it and prompt re-sign-in rather than looping on 429s.
async function preflight(imageUrl, progress) {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  const authHeader = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const cached = takePrefetch(imageUrl);

  let authed = !!apiKey;
  let plan = null;
  const tokens = await (cached ? cached.tokens : fetchTokens(authHeader));
  if (tokens) {
    plan = typeof tokens.plan === "string" ? tokens.plan : null;
    authed = !!apiKey && !!plan && !resolvedAsAnonymous(tokens);
    if (apiKey && !authed) {
      await clearAuth();
      throw fail("auth_expired");
    }
    if (tokens.remaining <= 0 || tokens.available === false) {
      throw fail(authed ? "limit_authed" : "limit_anon");
    }
  }

  // The original, with real dimensions for the NLP. Usually already in hand —
  // the prefetch has been running since the overlay opened. Only announce the
  // fetch when there is actually one to wait for.
  let image = cached ? await cached.image : null;
  if (!image) {
    progress("Fetching image…", "thinking");
    image = await loadImage(imageUrl);
  }

  return { authHeader, authed, plan, tokens, image };
}

// Image → PDF. Core's op=create takes a single raw image body as readily as a
// multipart batch, and one image is all the extension ever has — so no form
// data, and combine has nothing to combine (combine=0 would answer with a ZIP
// holding one PDF). Shared by the prompt path and the Convert to ▸ PDF item.
async function createPdf(imgBlob, { page = "fit", quality, dest, name } = {}, authHeader, authed) {
  const query = new URLSearchParams({ op: "create", page, combine: "1" });
  if (quality != null) query.append("quality", String(quality));
  // dest sends the result to the account's own storage instead of back to us;
  // core demands a name to file it under.
  if (dest) {
    query.append("dest", dest);
    query.append("name", name);
  }

  const res = await fetch(`${API}/v1/pdf?${query}`, {
    method: "POST",
    headers: { "Content-Type": imgBlob.type || "image/jpeg", ...authHeader },
    body: imgBlob,
  });
  if (!res.ok) throw await classifyHttp(res, authed);
  return res;
}

// Where this job's output should land. Only a job with ONE output can go to
// Drive — core refuses a multi-variant request a destination, since there is no
// honest single name for an archive.
async function driveTarget(tokens, singleOutput) {
  if (!singleOutput || !driveOffered(tokens)) return null;
  if (!(await saveToDrivePref())) return null;
  return tokens.drive.folderName || "Google Drive";
}

// A delivered job answers with a JSON receipt instead of the file. Success is a
// receipt, not a document, so the shape is verified rather than assumed.
//
// A FAILED delivery is not an error: core hands back the bytes with
// X-Mochify-Bucket-Error attached (helpers/BucketDelivery.h), on the principle
// that a storage problem must never cost the user the work they paid a token
// for. So the body decides — a receipt means it was filed, anything else is the
// image, and the image gets downloaded with the reason attached. The header is
// only there to explain why; the extension can read it because a service-worker
// fetch under host permissions isn't subject to the CORS expose list.
async function driveResult(res, folder, name, fallbackType) {
  const body = new Uint8Array(await res.arrayBuffer());
  const reason = res.headers.get("X-Mochify-Bucket-Error");

  let receipt = null;
  if (!reason) {
    try { receipt = JSON.parse(new TextDecoder().decode(body)); } catch { /* it's the file */ }
  }
  if (receipt?.stored) {
    return { ok: true, note: null, results: [], saved: { name, where: folder } };
  }

  // Core's wording says "bucket" for both destinations. Name the destination,
  // not the folder — "Mochify rejected the upload" reads like the app did it.
  const why = reason
    ? reason.replace(/your bucket/gi, "Google Drive").replace(/\.$/, "")
    : "the write couldn't be confirmed";
  return {
    ok: true,
    note: `Downloaded instead — ${why}.`,
    results: [{
      base64: toBase64(body),
      contentType: res.headers.get("Content-Type") || fallbackType,
      downloadName: name,
    }],
  };
}

async function processImage(imageUrl, prompt, tabId) {
  const filename = imageUrl.split("?")[0].split("/").pop() || "image.jpg";
  const progress = progressReporter(tabId);

  const { authHeader, authed, plan, tokens, image } = await preflight(imageUrl, progress);
  const { blob: imgBlob, width: imgWidth, height: imgHeight } = image;

  // 2. Parse prompt via worker NLP. A prompt that says "pdf" is asking for the
  // image BACK as a PDF, which is a different NLP schema (`imgpdf`) and a
  // different endpoint — without this branch "convert to pdf" parses as an
  // ordinary image request and downloads a JPEG. Same test as the web app's
  // upload form and the CLI, so all three route the sentence the same way.
  const wantsPdf = /\bpdfs?\b/i.test(prompt);

  progress("Parsing prompt…", "thinking");
  const parseRes = await fetch(`${WORKER_URL}/v1/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({
      prompt,
      fileData: [{ name: filename, width: imgWidth, height: imgHeight }],
      ...(wantsPdf ? { mode: "imgpdf" } : {}),
    }),
  });
  if (!parseRes.ok) throw await classifyHttp(parseRes, authed);
  const parsed = await parseRes.json();

  // ── Image → PDF (op=create) ───────────────────────────────────────────────
  // One image, so one page: core takes the raw body here, no multipart needed,
  // and `combine` has nothing to combine — send combine=1 whatever the NLP said,
  // since combine=0 answers with a ZIP holding a single PDF.
  if (wantsPdf && parsed.pdf) {
    const name = pdfName(filename);
    const folder = await driveTarget(tokens, true);
    progress(folder ? `Building PDF → ${folder}…` : "Building PDF…", "uploading", 30);
    const res = await createPdf(
      imgBlob,
      {
        page: parsed.pdf.page ?? "fit",
        quality: parsed.pdf.quality,
        ...(folder ? { dest: "drive", name } : {}),
      },
      authHeader,
      authed,
    );
    if (folder) return driveResult(res, folder, name, "application/pdf");
    const pdfBytes = new Uint8Array(await res.arrayBuffer());
    progress(null, "uploading", 90);

    return {
      ok: true,
      note: null,
      results: [{
        base64: toBase64(pdfBytes),
        contentType: res.headers.get("Content-Type") ?? "application/pdf",
        downloadName: name,
      }],
    };
  }

  const p = Array.isArray(parsed.files)
    ? parsed.files[0]
    : (parsed.files ?? parsed);

  // The generative step is paid-plan only and core answers a non-entitled
  // request with a 403 — after the upload. Check the plan we already fetched so
  // the user gets the upgrade CTA immediately. Silently dropping the step is the
  // wrong call here: someone who asked for a shadow does not want a plain resize
  // handed back as if it succeeded.
  // Only pre-check when the usage call actually told us the plan — a transient
  // failure there must not block a paid user, and classifyHttp reads core's own
  // 403 correctly either way.
  const generateKind = typeof p.generate?.kind === "string" ? p.generate.kind : "";
  if (generateKind && plan && !GENERATIVE_PLANS.has(plan)) throw fail("limit_generate");

  // Fan out over (size × format), driven by the NLP's arrays — same as the web
  // app, so multi-size works, not just multi-format.
  const formats = Array.isArray(p.types) && p.types.length > 1
    ? p.types
    : [p.type || filename.split(".").pop() || "jpg"];
  const sizes = Array.isArray(p.sizes) && p.sizes.length > 1
    ? p.sizes
    : [{ width: p.width, height: p.height }];
  const multiFormat = formats.length > 1;
  const multiSize = sizes.length > 1;
  const variantCount = formats.length * sizes.length;

  // Every variant costs a token and core charges the whole set atomically, so a
  // job that can't be paid for is refused outright. Say so before the upload
  // rather than letting it come back as a bare 429.
  if (tokens && typeof tokens.remaining === "number" && tokens.remaining < variantCount) {
    throw fail(authed ? "limit_authed" : "limit_anon", {
      message: `That needs ${variantCount} images and you have ${tokens.remaining} left.`,
    });
  }

  // Build the squish query exactly as the web app does, so the extension and
  // frontend send byte-identical params for the same NLP output: booleans → "1"
  // (omitted when false), stripExif defaults on, brightness only when set.
  const shared = new URLSearchParams();
  if (p.smartCompress) shared.append("smartCompress", "1");
  if (p.smartCrop) shared.append("smartCrop", "1");
  if (p.removeBackground) shared.append("removeBackground", "1");
  if (p.background) shared.append("background", String(p.background));
  // Generative Magic Flow: forward the AI step (shadow now; background later).
  if (generateKind) {
    shared.append("generate", generateKind);
    if (p.generate.prompt) shared.append("genPrompt", String(p.generate.prompt));
  }
  const stripExif = p.stripExif !== undefined ? p.stripExif : 1;
  shared.append("stripExif", stripExif ? "1" : "0");
  if (p.rotate) shared.append("rotate", String(p.rotate));
  if (p.brightness != null && p.brightness !== 0)
    shared.append("brightness", String(p.brightness));
  if (p.clarity) shared.append("clarity", "1");
  if (p.optimizeForWeb) shared.append("optimizeForWeb", "1");
  // 'generate' rather than '1': the server preserves an existing gain map either
  // way, and additionally synthesises one when the source has none. '1' is
  // preserve-only, which for someone who typed "make it HDR" would silently do
  // nothing on the SDR photos that are most of the inputs.
  if (p.hdr) shared.append("hdr", "generate");
  if (p.quality != null) shared.append("quality", String(p.quality));
  // Pixel-exact encode. The worker has already cleared this for any format that
  // cannot comply (core 400s lossless + jpg/avif), so no format check is needed
  // here. On an already-lossy source the backend downgrades to its best lossy
  // encode and reports that in X-Mochify-Lossless.
  if (p.lossless === true) shared.append("lossless", "1");

  // ── Output naming — mirrors the web app's variantFinalName ────────────────
  const rawOutputName = typeof p.outputName === "string"
    ? p.outputName.replace(/[/\\:*?"<>|\r\n\t]/g, "").trim().slice(0, 100)
    : "";
  const baseName = rawOutputName || filename.replace(/\.[^.]+$/, "") || filename;
  const mochified = rawOutputName ? "" : "_mochified";

  function variantName(fmt, size) {
    const sizeSuffix = multiSize
      ? (size?.width && size?.height
          ? `_${size.width}x${size.height}`
          : size?.width || size?.height
            ? `_${size.width || size.height}w`
            : "")
      : "";
    const fmtSuffix = multiFormat ? `_${fmt}` : "";
    return `${baseName}${mochified}${sizeSuffix}${fmtSuffix}.${fmt}`;
  }

  // ── Caveats core reports in headers ───────────────────────────────────────
  // Both describe the bytes that came back, not the request, so they are the
  // only way to know a requested effect didn't survive. Silence here would let
  // "make it HDR" hand back an ordinary JPEG looking like a success.
  const notes = new Set();
  function collectNotes(headers) {
    if (p.hdr && headers.get("X-Mochify-HDR") === "false") {
      notes.add(formats.includes("jpg")
        ? "Saved, but an HDR gain map couldn't be added to this image."
        : "Saved, but only JPEG can carry HDR — the gain map was dropped.");
    }
    if (p.lossless === true && headers.get("X-Mochify-Lossless") === "downgraded") {
      notes.add("Saved at the best lossy quality — the source was already lossy, so a pixel-exact copy isn't possible.");
    }
  }
  const noteText = () => (notes.size ? [...notes].join(" ") : null);

  async function squish(query) {
    const res = await fetch(`${API}/v1/squish?${query}`, {
      method: "POST",
      headers: { "Content-Type": imgBlob.type || "image/jpeg", ...authHeader },
      body: imgBlob,
    });
    if (!res.ok) throw await classifyHttp(res, authed);
    return res;
  }

  // 3. Squish.
  progress(variantCount > 1 ? `Processing ${variantCount} variants…` : "Processing…", "uploading", 30);

  if (variantCount === 1) {
    const fmt = formats[0];
    const size = sizes[0];
    const query = new URLSearchParams(shared.toString());
    query.append("type", fmt);
    if (size?.width) query.append("width", String(size.width));
    if (size?.height) query.append("height", String(size.height));

    const name = variantName(fmt, size);
    const folder = await driveTarget(tokens, true);
    if (folder) {
      query.append("dest", "drive");
      query.append("name", name);
      progress(`Processing → ${folder}…`, "uploading", 30);
    }

    const res = await squish(query);
    if (folder) return driveResult(res, folder, name, MIME_BY_FMT[fmt] ?? "application/octet-stream");
    collectNotes(res.headers);
    const bytes = new Uint8Array(await res.arrayBuffer());
    progress(null, "uploading", 90);

    return {
      ok: true,
      note: noteText(),
      results: [{
        base64: toBase64(bytes),
        contentType: res.headers.get("Content-Type") ?? MIME_BY_FMT[fmt] ?? "application/octet-stream",
        downloadName: name,
      }],
    };
  }

  // A fan-out has no single file to file, and core refuses a destination on
  // one. Downloading is the honest fallback — but silence would look like the
  // toggle was ignored, so it goes in the note.
  if (driveOffered(tokens) && (await saveToDrivePref())) {
    notes.add(`Downloaded instead of saved to Drive — Drive takes one file at a time, and this is ${variantCount}.`);
  }

  // ── Multi-variant: ONE upload, not one per variant. Core fans out
  // server-side and answers with a ZIP keyed "{w}x{h}.{fmt}". Beyond the saved
  // bandwidth this makes the job atomic — the old per-variant loop could spend
  // three tokens and then 429 on the fourth, leaving a half-finished run.
  const query = new URLSearchParams(shared.toString());
  query.append("types", formats.join(","));
  query.append("sizes", sizes.map((s) => `${s?.width ?? 0}x${s?.height ?? 0}`).join(","));

  const res = await squish(query);
  collectNotes(res.headers);
  const body = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("Content-Type") ?? "";
  progress(null, "uploading", 90);

  if (!contentType.includes("zip")) {
    // Deploy skew: an older core ignores types/sizes and returns a single raw
    // image. Deliver it as the first variant rather than dropping the result.
    console.warn(`Expected application/zip for a ${variantCount}-variant request, got "${contentType}" — old core?`);
    return {
      ok: true,
      note: noteText(),
      results: [{
        base64: toBase64(body),
        contentType: contentType || MIME_BY_FMT[formats[0]] || "application/octet-stream",
        downloadName: variantName(formats[0], sizes[0]),
      }],
    };
  }

  // Repack under readable names — core's entries are keyed by dimensions, and a
  // single archive also avoids Chrome's "download multiple files" prompt.
  progress("Packing zip…", "uploading", 95);
  const files = {};
  for (const [entryName, bytes] of Object.entries(fflate.unzipSync(body))) {
    const m = entryName.match(/^(\d+)x(\d+)\.(\w+)$/);
    const fmt = m ? m[3] : entryName.split(".").pop() || formats[0];
    const size = m
      ? (sizes.find((s) => (s?.width ?? 0) === Number(m[1]) && (s?.height ?? 0) === Number(m[2]))
         ?? { width: Number(m[1]), height: Number(m[2]) })
      : sizes[0];
    files[variantName(fmt, size)] = bytes;
  }
  const zipped = fflate.zipSync(files, { level: 0 });

  return {
    ok: true,
    note: noteText(),
    results: [{
      base64: toBase64(zipped),
      contentType: "application/zip",
      downloadName: `${baseName}${mochified}.zip`,
    }],
  };
}

// ── Quick convert (Convert to ▸ …) ──────────────────────────────────────────
// The format is the whole instruction, so this path never calls the NLP: one
// request instead of two, which is the point of having it next to the prompt.

// What to call the source format in the status line. The blob's own type is the
// truth — a URL extension lies routinely (CDN paths, query-string resizers,
// extensionless URLs), and by here the bytes are already in hand.
function sourceFormatLabel(imgBlob, filename) {
  const fromType = (imgBlob.type || "").split("/")[1]?.split("+")[0]?.toLowerCase();
  const fromName = filename.split(".").pop()?.toLowerCase();
  const raw = fromType || (fromName && fromName !== filename.toLowerCase() ? fromName : "");
  if (!raw) return "This image";
  const canonical = raw === "jpeg" ? "jpg" : raw;
  return QUICK_FORMATS.find((f) => f.id === canonical)?.label ?? canonical.toUpperCase();
}

function baseName(filename) {
  return filename.replace(/\.[^.]+$/, "") || filename;
}

// The PDF is a different kind of file, so it can't collide with the source the
// way a re-encode can — no _mochified needed, and it matches what the CLI names
// an op=create result.
function pdfName(filename) {
  return `${baseName(filename)}.pdf`;
}

async function convertImage(imageUrl, format, tabId) {
  const filename = imageUrl.split("?")[0].split("/").pop() || "image.jpg";
  const progress = progressReporter(tabId);

  const target = QUICK_FORMATS.find((f) => f.id === format);
  if (!target) throw fail("generic", { message: `Unsupported format: ${format}` });

  const { authHeader, authed, tokens, image } = await preflight(imageUrl, progress);
  const { blob: imgBlob } = image;

  // One output, always — so the Drive toggle applies here exactly as it does to
  // a typed prompt. The menu row says where it lands before the click.
  const folder = await driveTarget(tokens, true);
  const outName = format === "pdf"
    ? pdfName(filename)
    : `${baseName(filename)}_mochified.${format}`;

  // Now that the bytes are here, say what this actually is — the menu row could
  // only name the target.
  const from = sourceFormatLabel(imgBlob, filename);
  progress(`${from} → ${target.label}${folder ? ` → ${folder}` : ""}…`, "uploading", 30);

  if (format === "pdf") {
    const res = await createPdf(
      imgBlob,
      { page: "fit", ...(folder ? { dest: "drive", name: outName } : {}) },
      authHeader,
      authed,
    );
    if (folder) return driveResult(res, folder, outName, "application/pdf");
    const pdfBytes = new Uint8Array(await res.arrayBuffer());
    progress(null, "uploading", 90);
    return {
      ok: true,
      note: null,
      results: [{
        base64: toBase64(pdfBytes),
        contentType: res.headers.get("Content-Type") ?? "application/pdf",
        downloadName: outName,
      }],
    };
  }

  // Format only: no resize, no quality, no smart compression — quality stays on
  // core's auto setting, which is what "just convert this" means. stripExif=1 is
  // the same default the web app and the prompt path send.
  const query = new URLSearchParams({ type: format, stripExif: "1" });
  if (folder) {
    query.append("dest", "drive");
    query.append("name", outName);
  }
  const res = await fetch(`${API}/v1/squish?${query}`, {
    method: "POST",
    headers: { "Content-Type": imgBlob.type || "image/jpeg", ...authHeader },
    body: imgBlob,
  });
  if (!res.ok) throw await classifyHttp(res, authed);
  if (folder) return driveResult(res, folder, outName, MIME_BY_FMT[format] ?? "application/octet-stream");
  const bytes = new Uint8Array(await res.arrayBuffer());
  progress(null, "uploading", 90);

  return {
    ok: true,
    note: null,
    results: [{
      base64: toBase64(bytes),
      contentType: res.headers.get("Content-Type") ?? MIME_BY_FMT[format] ?? "application/octet-stream",
      // _mochified whatever the format: converting a JPG to JPG re-encodes it,
      // and that result must not land under the original's name.
      downloadName: outName,
    }],
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

function fallbackWindow(imageUrl, convertTo = null) {
  const convertParam = convertTo ? `&convert=${encodeURIComponent(convertTo)}` : "";
  chrome.windows.create({
    url: `${chrome.runtime.getURL("prompt/prompt.html")}?src=${encodeURIComponent(imageUrl)}${convertParam}`,
    type: "popup",
    width: 420,
    height: 240,
    focused: true,
  });
}
