// The last few prompts, for ↑/↓ recall and the chip row under the input.
// Ported from mochify-frontend's promptHistory.ts so both surfaces behave the
// same: 10 kept, 3 shown, recorded on submit, "same again" resolved locally.
//
// chrome.storage.local rather than localStorage: the overlay runs on the host
// page's origin, where localStorage would scatter the user's prompts across
// every site they right-clicked on — and hand them to that site's scripts.
// Nothing here leaves the device, and the ✕ on the chip row clears it.
//
// Loaded three ways: importScripts() in the service worker, a <script> tag in
// the prompt window, and executeScript() ahead of content.js. The last runs on
// every right-click, so this must be safe to evaluate more than once.
(() => {
  const KEY = "promptHistory";

  // Enough to cover "what did I do last time" without becoming a log.
  const LIMIT = 10;

  // How many are surfaced as chips; the card is narrow.
  const VISIBLE = 3;

  // "webp" is a prompt. "w" is a slip of the keyboard on the way to submitting.
  const MIN_LENGTH = 3;

  const REPEAT_PHRASES = new Set([
    "same", "same again", "same as before", "same as last time", "same thing",
    "same thing again", "same settings", "do the same", "do the same again",
    "do it again", "do that again", "again", "repeat", "repeat that", "redo",
    "redo that", "one more time",
  ]);

  const CLOCK_SVG = `<svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
  const CLEAR_SVG = `<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`;

  // Every failure reads as "no history": a value from some other version of
  // this shape is not worth an error.
  async function load() {
    try {
      const { [KEY]: list } = await chrome.storage.local.get(KEY);
      if (!Array.isArray(list)) return [];
      return list.filter((t) => typeof t === "string" && t.length > 0).slice(0, LIMIT);
    } catch {
      return [];
    }
  }

  // Newest first. Called when a prompt is SUBMITTED, not when it succeeds: the
  // one that failed or hit a quota is the one the user is about to retry.
  async function remember(text) {
    const trimmed = String(text ?? "").trim();
    if (trimmed.length < MIN_LENGTH) return;
    // Case-insensitive: "Convert to WebP" and "convert to webp" are one instruction.
    const lower = trimmed.toLowerCase();
    const next = [trimmed, ...(await load()).filter((t) => t.toLowerCase() !== lower)].slice(0, LIMIT);
    try {
      await chrome.storage.local.set({ [KEY]: next });
    } catch { /* storage full or unavailable: recall just won't have it */ }
  }

  async function clear() {
    try { await chrome.storage.local.remove(KEY); } catch { /* nothing to remove */ }
  }

  // Only a prompt that is *nothing but* a repeat phrase counts. "same again but
  // as PNG" carries a modifier the model understands perfectly well.
  function isRepeatPhrase(text) {
    const normalized = String(text ?? "")
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/, "")
      .replace(/^please\s+/, "")
      .replace(/\s+please$/, "")
      .replace(/\s+/g, " ");
    return REPEAT_PHRASES.has(normalized);
  }

  // Wire recall into a prompt surface: ↑/↓ cycling on `input`, chips in `row`.
  // `onFill` runs after any programmatic change to the input, so the surface
  // can re-derive its send button without the input event (which would end
  // the cycle). Styling is the surface's: .recent-row, .recent-chip, .recent-clear.
  function attach({ input, row, onFill }) {
    let history = [];
    // -1 when not cycling. `draft` holds what was being typed when cycling
    // started, so arrowing back past the newest entry (or Escape) restores it.
    let index = -1;
    let draft = "";

    function fill(text, { focus = false } = {}) {
      input.value = text;
      const end = text.length;
      input.setSelectionRange(end, end);
      if (focus) input.focus();
      onFill?.();
    }

    function render() {
      row.replaceChildren();
      const recent = history.slice(0, VISIBLE);
      row.classList.toggle("on", recent.length > 0);
      for (const text of recent) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "recent-chip";
        chip.title = text;
        chip.innerHTML = CLOCK_SVG;
        const label = document.createElement("span");
        label.textContent = text;
        chip.appendChild(label);
        chip.addEventListener("click", () => {
          if (input.disabled) return;
          index = -1;
          fill(text, { focus: true });
        });
        row.appendChild(chip);
      }
      if (recent.length > 0) {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "recent-clear";
        x.title = x.ariaLabel = "Clear recent prompts";
        x.innerHTML = CLEAR_SVG;
        x.addEventListener("click", () => {
          index = -1;
          clear();
          input.focus();
        });
        row.appendChild(x);
      }
    }

    function refresh() {
      return load().then((list) => { history = list; render(); });
    }

    function cycle(delta) {
      if (index === -1) draft = input.value;
      const next = Math.min(Math.max(index + delta, -1), history.length - 1);
      if (next === index) return;
      index = next;
      fill(next === -1 ? draft : history[next]);
    }

    // Typing makes this a draft again, so the next ↑ starts from the top
    // rather than continuing a stale cycle.
    input.addEventListener("input", () => { index = -1; });

    // Single-line input, so ↑/↓ have no caret job of their own to steal.
    input.addEventListener("keydown", (e) => {
      if (history.length === 0) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        cycle(1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        cycle(-1);
      } else if (e.key === "Escape" && index !== -1) {
        // Handled here so the overlay's own Escape-to-close doesn't also fire.
        e.preventDefault();
        e.stopPropagation();
        index = -1;
        fill(draft);
      }
    });

    // The background records each submit, and another tab may clear the list,
    // so storage is the source of truth. The overlay is re-injected on every
    // right-click; a listener whose row has been torn down retires itself.
    const onChanged = (changes, area) => {
      if (!row.isConnected) {
        chrome.storage.onChanged.removeListener(onChanged);
        return;
      }
      if (area === "local" && KEY in changes) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);

    refresh();

    return {
      refresh,
      // Leave cycling mode, e.g. when the surface resets for a new image.
      reset() { index = -1; draft = ""; },
      // The prompt to actually send for `text`: itself, or — for "same again"
      // and friends — the last one recorded. null when there is nothing to
      // repeat. The caller writes it back into the box so the user sees which
      // instruction is being carried out.
      resolve(text) {
        if (!isRepeatPhrase(text)) return text;
        return history[0] ?? null;
      },
    };
  }

  // Example prompts for the placeholder, as on mochify.app/flow. They live here
  // because this is the one file both prompt surfaces already load.
  const EXAMPLES = [
    "Make 1:1 square, remove bg, convert to AVIF…",
    "remove bg, avif and webp, 1200px, 800px…",
    "Remove background, square crop, shopify…",
    "Convert to webp, resize width 800px and 600px…",
    "vinted, compress, 1080x1080 and 500px…",
  ];

  // Unlike the web, this keeps going while the input is focused: both surfaces
  // focus it on open, so pausing on focus would mean never rotating at all.
  // The placeholder only shows on an empty input, so that is the only time a
  // swap is worth doing. The fade is the surface's `.ph-out::placeholder`.
  function cyclePlaceholder(input) {
    let i = 0;
    input.placeholder = EXAMPLES[0];
    const id = setInterval(() => {
      if (!input.isConnected) return clearInterval(id);
      // Hidden overlay, typed text, or a job running: nobody can see it.
      if (!input.offsetParent || input.value || input.disabled) return;
      input.classList.add("ph-out");
      setTimeout(() => {
        i = (i + 1) % EXAMPLES.length;
        input.placeholder = EXAMPLES[i];
        input.classList.remove("ph-out");
      }, 400);
    }, 3200);
  }

  globalThis.MochifyPromptHistory = { remember, clear, load, isRepeatPhrase, attach, cyclePlaceholder };
})();
