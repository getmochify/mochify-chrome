# Mochify – Chrome Extension

Right-click any image on the web to resize, convert, and optimize it instantly with [Mochify](https://mochify.app) — driven by a plain-English prompt.

> **[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/mochify-%E2%80%93-ai-image-compre/pgegchhkcjdcnnppeahkdcalclpaamcj)**

## Features

- **Right-click any image** → *Send to Mochify…* to open an in-page prompt overlay.
- **Quick convert** — *Convert to ▸ JPG / WebP / AVIF / JPEG XL / PNG / PDF* skips the prompt entirely. The format is the whole instruction, so there's no NLP call: one request, no typing. Quality stays on core's auto setting and nothing is resized. Chrome builds a context menu from items registered at install time and gives no `onShown` hook, so a row can't name the source format — the overlay does it once it has the bytes ("WebP → AVIF…").
- **Plain-English prompts** — e.g. "convert to webp at 800px wide", "make it a square avatar", "compress for web". The prompt is parsed by Mochify's NLP worker into concrete compression parameters.
- **Multi-size / multi-format fan-out** — ask for several sizes or formats in one prompt. They go up as a single request, are expanded server-side, and come back bundled into one `.zip` download.
- **Image → PDF** — say "pdf" ("convert to pdf", "save as an a4 pdf") and the image comes back as a one-page PDF instead, via `POST /v1/pdf?op=create`. Works on every plan, including Free.
- **Smart compression, smart crop, EXIF stripping, background removal, HDR gain maps, lossless encoding, drop shadows, brightness/rotation/clarity**, and more — the same processing options, sent with the same parameters, as the web app.
- **Save to Google Drive** — if the account connected a Drive on mochify.app, the overlay grows a toggle and results go straight there instead of the downloads folder (the `Convert to ▸` rows obey it too, and say `Convert to (→ Drive)` while it's on). The extension never talks to Google: core uploads with the connection the account already holds, so there's no OAuth here, no Google scope in the manifest, and no extra permission — just `dest=drive&name=…` on the request it was making anyway. Requires the worker's `GET /v1/usage?integrations=1`, which is the only way the extension can learn a Drive exists (`/user/:id/drive` is behind the internal token).
- **Optional sign-in** for higher monthly limits. Background removal works signed-out too; drop shadows and generated backgrounds need a paid plan. Signed-out use works against the anonymous tier.

## How it works

The extension is a standard Manifest V3 Chrome extension with no build step:

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (permissions, background worker, popup). |
| `background.js` | Service worker. Routes all API calls (to bypass page CSP/CORS), handles the context-menu action, parses prompts, and fans out compression requests. |
| `content.js` | Injects the in-page prompt overlay (shadow DOM) on the current tab. Opens straight into its working state for a quick convert. |
| `prompt/` | Fallback popup window used when a content script can't be injected. |
| `popup/` | The toolbar popup — sign-in state and account info. |
| `lib/fflate.js` | Zip library used to unpack the server's multi-variant response and repack it under readable filenames. |

### Prefetching

The quota check, the image download and its dimension decode don't depend on what the user types, so they start when the overlay opens rather than when the prompt is submitted. The image matters most: the NLP parse needs real pixel dimensions to resolve relative intent ("50%", "9:16"), so the download sits on the critical path *in front of* the slowest call in the chain. Moving it into the typing window takes it off that path entirely.

It's best-effort — MV3 can terminate the service worker mid-typing, and some images aren't fetchable from the worker at all — so `processImage()` always stays able to do the whole job itself, and a failed prefetch simply falls through to the normal path.

### Endpoints

- `api.mochify.app` — image processing (`POST /v1/squish`) and image → PDF (`POST /v1/pdf?op=create`).
- `id.mochify.app` — prompt parsing (`POST /v1/prompt`) and usage/quota checks (`GET /v1/usage`, plus `?integrations=1` for the Drive toggle).

Auth is a per-user bearer token, obtained by signing in at `mochify.app/auth/extension` and stored in `chrome.storage.sync`. No secrets are embedded in the source.

## Development

There's no build or bundling step — load the folder directly:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository's root folder.
4. After editing files, click the **reload** icon on the extension card. If you change `host_permissions` in `manifest.json`, remove and re-add the extension so Chrome re-prompts for the new permissions.

## License

[MIT](./LICENSE)
