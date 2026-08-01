const WORKER_URL = "https://id.mochify.app";

const signedOut = document.getElementById("signed-out");
const signedIn  = document.getElementById("signed-in");
const userEmail = document.getElementById("user-email");
const signInBtn = document.getElementById("sign-in");
const signOutBtn = document.getElementById("sign-out");

function showSignedIn(email) {
  userEmail.textContent = email || "Signed in";
  signedOut.style.display = "none";
  signedIn.style.display  = "block";
}

function showSignedOut() {
  signedOut.style.display = "block";
  signedIn.style.display  = "none";
}

// A revoked/expired key is silently downgraded to the anonymous tier (plan
// "ip") rather than 401'd, so presence of a stored key doesn't mean it's valid.
// Validate against the usage endpoint and clear a dead key, otherwise the popup
// keeps showing "signed in" while every request quietly drops to the free limit.
async function validateAndRender() {
  const { apiKey, userEmail: email } = await chrome.storage.sync.get(["apiKey", "userEmail"]);
  if (!apiKey) {
    showSignedOut();
    return;
  }
  showSignedIn(email); // optimistic — confirm in the background
  try {
    const res = await fetch(`${WORKER_URL}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const info = await res.json();
      if (!info.plan || info.plan === "ip") {
        await chrome.storage.sync.remove(["apiKey", "userEmail"]);
        showSignedOut();
      }
    }
  } catch {
    // Offline — keep the optimistic signed-in state.
  }
}

validateAndRender();

// Reflect auth changes made elsewhere (e.g. background clearing a dead key after
// a failed request) so the popup never lags behind the real auth state.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !("apiKey" in changes)) return;
  if (changes.apiKey.newValue) showSignedIn(changes.userEmail?.newValue);
  else showSignedOut();
});

signInBtn.addEventListener("click", () => {
  const extId = chrome.runtime.id;
  chrome.tabs.create({ url: `https://mochify.app/auth/extension?ext=${extId}` });
  window.close();
});

signOutBtn.addEventListener("click", () => {
  chrome.storage.sync.remove(["apiKey", "userEmail"], showSignedOut);
});
