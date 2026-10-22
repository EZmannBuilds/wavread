// Checkout: email in, Stripe's hosted payment page out.
//
// The browser talks only to WavRead's own configuration endpoint and the
// create-checkout Edge Function. No Stripe script runs on this page and no
// card field exists here — payment happens entirely on Stripe's checkout.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// If this page was reached from an advertisement, the link carries a short
// campaign label — `?from=reels-a`. It is read from the address bar, sent once
// with the purchase, and kept nowhere else: no cookie, no storage, no script
// from anyone else.
//
// An affiliate's link carries `?from=aff-<code>` instead, and that one label is
// the exception: navigation.js keeps it in localStorage for 30 days, so a
// referral still counts when the buyer comes back later without the link. It
// is read back here only when the address bar carries no label of its own —
// the link someone followed to this page wins over one they followed before.
// The server decides which labels it recognizes; this only keeps something
// obviously wrong from being sent at all.
const AFFILIATE_LABEL = /^aff-[a-z0-9-]{2,32}$/;
const REFERRAL_KEY = "wavread-referral";
const REFERRAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function storedReferral() {
  try {
    const saved = JSON.parse(localStorage.getItem(REFERRAL_KEY));
    const age = Date.now() - saved.savedAt;
    if (AFFILIATE_LABEL.test(saved.label) && age >= 0 && age < REFERRAL_MAX_AGE_MS) return saved.label;
    localStorage.removeItem(REFERRAL_KEY);
  } catch {
    // Nothing stored, storage blocked, or unreadable: there is no referral.
  }
  return null;
}

function campaignLabel() {
  const label = new URLSearchParams(location.search).get("from")?.trim().toLowerCase();
  if (label && (/^[a-z0-9-]{1,24}$/.test(label) || AFFILIATE_LABEL.test(label))) return label;
  return storedReferral();
}

async function loadConfiguration() {
  if (LOCAL_HOSTS.has(location.hostname)) return window.WAVREAD_BETA_CONFIG;
  try {
    const response = await fetch("/api/beta-config", { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const config = await response.json();
    return config.configured ? config : null;
  } catch {
    return null;
  }
}

function setStatus(element, message, state = "", field = null) {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
  // aria-describedby (in the HTML) points the email field at this paragraph;
  // aria-invalid says the value is why. Without both, a screen-reader user
  // tabbing back after a failure hears "Account email, edit text" and the
  // error is gone.
  if (field) {
    field.setAttribute("aria-invalid", state === "error" ? "true" : "false");
  }
}

async function initializeCheckout() {
  const form = document.querySelector("#checkout-form");
  if (!form) return;
  // Block native submission while configuration is still loading.
  form.addEventListener("submit", event => event.preventDefault());
  const status = document.querySelector("#checkout-status");
  const unconfigured = document.querySelector("#checkout-unconfigured");
  const submit = form.querySelector("button[type=submit]");

  // Written here rather than in the page, so the sentence exists only when it
  // is true. Hidden markup is invisible to a person and perfectly visible to
  // everything that reads text without running CSS — a search engine, an
  // assistant answering "can I buy WavRead" — and a buy page that says
  // purchases are not configured reads as a broken shop to all of them.
  const sayUnconfigured = () => {
    unconfigured.textContent = "Payments are temporarily unavailable. "
      + "Nothing has been charged — try again shortly, or email support@wavread.com.";
    unconfigured.hidden = false;
  };

  const config = await loadConfiguration();
  if (!config?.url) {
    sayUnconfigured();
    submit.disabled = true;
    return;
  }
  const endpoint = `${config.url.replace(/\/$/, "")}/functions/v1/create-checkout`;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    const email = new FormData(form).get("email").trim().toLowerCase();
    const source = campaignLabel();
    submit.disabled = true;
    const emailField = form.querySelector("#email");
    setStatus(status, "Preparing the payment page…", "", emailField);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source ? { email, source } : { email }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 503) {
        sayUnconfigured();
        setStatus(status, "", "", emailField);
        return;
      }
      if (!response.ok || !result.url) {
        setStatus(status, result.error || "The payment page could not be started. Try again shortly.", "error", emailField);
        return;
      }
      setStatus(status, "Opening Stripe checkout…", "success", emailField);
      location.assign(result.url);
    } catch {
      // A blocked cross-origin response and a dead network look identical
      // here, so the message names both rather than guessing wrong.
      setStatus(status, `Checkout could not be reached from ${location.host}. If this is a preview or test address, use the main site; otherwise check your connection and try again.`, "error", emailField);
    } finally {
      submit.disabled = false;
    }
  });
  submit.disabled = false;
}

initializeCheckout();
