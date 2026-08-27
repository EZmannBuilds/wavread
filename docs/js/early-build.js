// Early Build checkout: email in, Stripe's hosted payment page out.
//
// The browser talks only to WavRead's own configuration endpoint and the
// create-checkout Edge Function. No Stripe script runs on this page and no
// card field exists here — payment happens entirely on Stripe's checkout.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

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

function setStatus(element, message, state = "") {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
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
    submit.disabled = true;
    setStatus(status, "Preparing the payment page…");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 503) {
        unconfigured.hidden = false;
        setStatus(status, "");
        return;
      }
      if (!response.ok || !result.url) {
        setStatus(status, result.error || "The payment page could not be started. Try again shortly.", "error");
        return;
      }
      setStatus(status, "Opening Stripe checkout…", "success");
      location.assign(result.url);
    } catch {
      setStatus(status, "The payment page could not be reached. Check your connection and try again.", "error");
    } finally {
      submit.disabled = false;
    }
  });
}

initializeCheckout();
