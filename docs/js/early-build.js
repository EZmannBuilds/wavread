// Early Launch checkout: email in, Stripe's hosted payment page out.
//
// The browser talks only to WavRead's own configuration endpoint and the
// create-checkout Edge Function. No Stripe script runs on this page and no
// card field exists here — payment happens entirely on Stripe's checkout.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// If this page was reached from an advertisement, the link carries a short
// campaign label — `?from=reels-a`. It is read from the address bar, sent once
// with the purchase, and kept nowhere else: no cookie, no storage, no script
// from anyone else. The server decides which labels it recognizes; this only
// keeps something obviously wrong from being sent at all.
function campaignLabel() {
  const raw = new URLSearchParams(location.search).get("from");
  if (!raw) return null;
  const label = raw.trim().toLowerCase();
  return /^[a-z0-9-]{1,24}$/.test(label) ? label : null;
}

async function loadConfiguration() {
  if (LOCAL_HOSTS.has(location.hostname)) return window.WAVREAD_BETA_CONFIG;
  try {
    const response = await fetch("/api/beta-config", { headers: { Accept: "application/json" } });
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
  const status = document.querySelector("#checkout-status");
  const unconfigured = document.querySelector("#checkout-unconfigured");
  const submit = form.querySelector("button[type=submit]");

  const config = await loadConfiguration();
  if (!config?.url) {
    unconfigured.hidden = false;
    submit.disabled = true;
    return;
  }
  const endpoint = `${config.url.replace(/\/$/, "")}/functions/v1/create-checkout`;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const email = new FormData(form).get("email").trim().toLowerCase();
    const source = campaignLabel();
    submit.disabled = true;
    const emailField = form.querySelector("#email");
    setStatus(status, "Preparing the payment page…", "", emailField);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source ? { email, source } : { email }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 503) {
        unconfigured.hidden = false;
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
}

initializeCheckout();
