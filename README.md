# Mochify – Chrome Extension

Right-click any image on the web to resize, convert, and optimize it instantly with [Mochify](https://mochify.app) — driven by a plain-English prompt.

> **[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/mochify-%E2%80%93-ai-image-compre/pgegchhkcjdcnnppeahkdcalclpaamcj)**

## Features

- **Right-click any image** → *Send to Mochify…* to open an in-page prompt overlay.
- **Plain-English prompts** — e.g. "convert to webp at 800px wide", "make it a square avatar", "compress for web". The prompt is parsed by Mochify's NLP worker into concrete compression parameters.
- **Multi-size / multi-format fan-out** — ask for several sizes or formats in one prompt and they're processed in parallel, then bundled into a single `.zip` download.
- **Smart compression, smart crop, EXIF stripping, background removal, HDR, brightness/rotation**, and more — the same processing options as the web app.
- **Optional sign-in** for higher monthly limits and features like background removal. Signed-out use works against the free anonymous tier.

## How it works

The extension is a standard Manifest V3 Chrome extension with no build step:

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (permissions, background worker, popup). |
| `background.js` | Service worker. Routes all API calls (to bypass page CSP/CORS), handles the context-menu action, parses prompts, and fans out compression requests. |
| `content.js` | Injects the in-page prompt overlay (shadow DOM) on the current tab. |
| `prompt/` | Fallback popup window used when a content script can't be injected. |
| `popup/` | The toolbar popup — sign-in state and account info. |
| `lib/fflate.js` | Zip library used to bundle multi-variant downloads. |

### Endpoints

- `api.mochify.app` — image processing (`POST /v1/squish`).
- `id.mochify.app` — prompt parsing (`POST /v1/prompt`) and usage/quota checks (`GET /v1/usage`).

Auth is a per-user bearer token, obtained by signing in at `mochify.app/auth/extension` and stored in `chrome.storage.sync`. No secrets are embedded in the source.

## Development

There's no build or bundling step — load the folder directly:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository's root folder.
4. After editing files, click the **reload** icon on the extension card. If you change `host_permissions` in `manifest.json`, remove and re-add the extension so Chrome re-prompts for the new permissions.

## License

[MIT](./LICENSE)
