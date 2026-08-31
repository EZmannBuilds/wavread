const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
const CURRENT_VERSION = "1.4.46";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

let supabase = null;
let betaConfig = null;
let currentUser = null;
let currentTesterId = null;

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function fmtDate(iso) {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
}

function setStatus(element, message, state = "", field = null) {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
  // The status paragraph is a sibling of the form, so on its own it tells a
  // screen-reader user nothing once they tab back to the field: they hear
  // "Account email, edit text" and the error is gone. aria-describedby (in the
  // HTML) points the field at this text; aria-invalid says the value is why.
  if (field) {
    field.setAttribute("aria-invalid", state === "error" ? "true" : "false");
  }
}

function friendlyAuthError(error) {
  const code = String(error?.code || error?.error_code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  // Supabase answers an unknown address with "signups not allowed for otp",
  // because the client asks it never to create users. That is not an outage
  // and saying so sends people to wait instead of to checkout.
  if (code.includes("otp_disabled") || message.includes("signups not allowed")) {
    return "There is no WavRead account for that email. Buy WavRead to create one, or check the address you used.";
  }
  if (message.includes("rate") || message.includes("email rate")) return "Too many sign-in attempts. Wait a few minutes and try again.";
  if (message.includes("invalid") || message.includes("expired")) return "That sign-in link is invalid or has expired. Request a new one.";
  return "Sign-in is unavailable right now. Please try again shortly.";
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

async function createBetaClient() {
  const config = await loadConfiguration();
  if (!config?.url || !config?.publishableKey) return null;
  betaConfig = config;
  const { createClient } = await import(SUPABASE_MODULE);
  return createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "wavread-beta-session"
    }
  });
}

async function initializeSignIn() {
  const form = document.querySelector("#signin-form");
  if (!form) return;
  const setupNotice = document.querySelector("#setup-notice");
  const status = document.querySelector("#signin-status");
  const submit = form.querySelector("button[type=submit]");

  try {
    supabase = await createBetaClient();
  } catch {
    supabase = null;
  }
  if (!supabase) {
    setupNotice.hidden = false;
    submit.disabled = true;
    return;
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    location.replace("dashboard.html");
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = new FormData(form).get("email").trim();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const emailField = form.querySelector("#email");
    setStatus(status, "Sending a secure sign-in link…", "", emailField);
    const redirectPath = LOCAL_HOSTS.has(location.hostname) ? "dashboard.html" : "/dashboard";
    const redirectTo = new URL(redirectPath, location.origin).href;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo }
    });
    submit.disabled = false;
    if (error) {
      setStatus(status, friendlyAuthError(error), "error", emailField);
      return;
    }
    form.reset();
    setStatus(status, "Check your email for a one-time sign-in link. It expires shortly.", "success", emailField);
  });
}

function showDashboardState(id) {
  ["loading-state", "setup-state", "signed-out-state", "unauthorized-state", "dashboard-content"].forEach((stateId) => {
    const element = document.getElementById(stateId);
    if (element) element.hidden = stateId !== id;
  });
}

// A small table built entirely from text nodes — nothing user-written is ever
// parsed as markup.
function buildTable(headers, rows) {
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  headers.forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.append(th);
  });
  const body = table.createTBody();
  rows.forEach((cells) => {
    const row = body.insertRow();
    cells.forEach((cell) => {
      const td = row.insertCell();
      if (cell instanceof Node) td.append(cell);
      else td.textContent = String(cell);
    });
  });
  return table;
}

function renderKnownIssues(issues) {
  const list = document.querySelector("#issue-list");
  const empty = document.querySelector("#issues-empty");
  list.replaceChildren();
  if (!issues.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  issues.forEach((issue) => {
    const article = document.createElement("article");
    article.className = "issue";
    const meta = document.createElement("p");
    meta.className = "issue-meta";
    meta.textContent = `${issue.status} · ${issue.affected_versions || "Current beta"}`;
    const title = document.createElement("h3");
    title.textContent = issue.title;
    const summary = document.createElement("p");
    summary.textContent = issue.summary;
    article.append(meta, title, summary);
    if (issue.workaround) {
      const workaround = document.createElement("p");
      const label = document.createElement("strong");
      label.textContent = "Workaround: ";
      workaround.append(label, document.createTextNode(issue.workaround));
      article.append(workaround);
    }
    list.append(article);
  });
}

async function loadOwnership() {
  const title = document.querySelector("#ownership-title");
  const detail = document.querySelector("#ownership-detail");
  const action = document.querySelector("#ownership-action");
  const [account, entitlements, purchases] = await Promise.all([
    supabase.from("accounts").select("free_updates, free_updates_note")
      .eq("auth_user_id", currentUser.id).maybeSingle(),
    supabase.from("entitlements").select("build_version, granted_at")
      .eq("entitlement", "early_build").is("revoked_at", null),
    supabase.from("purchases").select("amount_cents, build_version, purchased_at, status")
      .order("purchased_at", { ascending: false })
  ]);
  if (entitlements.error || account.error) {
    title.textContent = "Standing unavailable";
    detail.textContent = "Your purchases could not be read. Refresh this page.";
    return { owned: new Set(), everything: false };
  }

  // Contributor standing, or a legacy all-access entitlement from the original
  // programme, covers every build. Otherwise access is build by build.
  const rows = entitlements.data || [];
  const everything = Boolean(account.data?.free_updates) || rows.some((r) => !r.build_version);
  const owned = new Set(rows.map((r) => r.build_version).filter(Boolean));
  const paid = (purchases.data || []).filter((p) => p.status === "paid");
  const spent = paid.reduce((sum, p) => sum + (p.amount_cents || 0), 0);

  if (account.data?.free_updates) {
    title.textContent = "Owned";
    detail.textContent = account.data.free_updates_note
      || "Every build stays yours, for what you already paid.";
    action.hidden = true;
  } else if (everything) {
    title.textContent = "Owned";
    detail.textContent = `Every build is included${spent ? ` · $${(spent / 100).toFixed(2)} paid` : ""}.`;
    action.hidden = true;
  } else if (owned.size) {
    title.textContent = owned.size === 1 ? "1 build owned" : `${owned.size} builds owned`;
    detail.textContent = `${[...owned].join(", ")} · $${(spent / 100).toFixed(2)} paid.`;
    action.hidden = false;
  } else {
    title.textContent = "Not owned yet";
    detail.textContent = "One payment covers every build.";
    action.hidden = false;
  }
  return { owned, everything };
}

// Buying one specific build, rather than a blanket purchase.
async function buyBuild(build, statusEl) {
  setStatus(statusEl, `Opening checkout for ${build.version}…`);
  try {
    const response = await fetch(`${betaConfig.url.replace(/\/$/, "")}/functions/v1/create-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: currentUser.email, build_id: build.id })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) {
      setStatus(statusEl, result.error || "Checkout could not be started. Try again shortly.", "error");
      return;
    }
    location.assign(result.url);
  } catch {
    setStatus(statusEl, "Checkout could not be reached. Check your connection.", "error");
  }
}

async function downloadBuild(build, statusEl) {
  setStatus(statusEl, `Preparing ${build.file_name}…`);
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    const response = await fetch(`${betaConfig.url.replace(/\/$/, "")}/functions/v1/download-build`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "apikey": betaConfig.publishableKey
      },
      body: JSON.stringify({ build_id: build.id })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) {
      setStatus(statusEl, result.error || "The download could not be prepared. Try again.", "error");
      return;
    }
    setStatus(statusEl, `Downloading ${result.file_name}. Verify the SHA-256 shown before installing.`, "success");
    location.assign(result.url);
  } catch {
    setStatus(statusEl, "The download could not be reached. Check your connection.", "error");
  }
}

async function loadBuilds(standing) {
  const list = document.querySelector("#builds-list");
  const empty = document.querySelector("#builds-empty");
  const locked = document.querySelector("#builds-locked");
  const status = document.querySelector("#builds-status");
  const { data, error } = await supabase
    .from("builds")
    .select("id, version, channel, file_name, sha256, size_bytes, notes, released_at, price_cents")
    .order("released_at", { ascending: false });
  if (error) {
    setStatus(status, "The build list could not be loaded. Try refreshing this page.", "error");
    return;
  }
  const builds = data || [];
  const has = (b) => standing.everything || standing.owned.has(b.version);
  locked.hidden = builds.length === 0 || builds.some(has);
  list.replaceChildren();
  if (!builds.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const rows = builds.map((build) => {
    const sha = document.createElement("code");
    sha.textContent = build.sha256;
    const size = `${(build.size_bytes / (1024 * 1024)).toFixed(0)} MB`;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn tiny";
    if (has(build)) {
      action.textContent = "Download";
      action.addEventListener("click", () => downloadBuild(build, status));
    } else {
      // No fallback price. A hardcoded default outlived the price it was
      // copied from once already; if the catalog did not give us a number,
      // the button says nothing rather than a stale one.
      if (build.price_cents > 0) {
        action.textContent = `Buy — $${(build.price_cents / 100).toFixed(2)}`;
        action.addEventListener("click", () => buyBuild(build, status));
      } else {
        action.textContent = "Not for sale";
        action.disabled = true;
      }
    }
    const state = document.createElement("span");
    state.className = "table-status";
    state.textContent = standing.everything || standing.owned.has(build.version) ? "included" : "not owned";
    return [build.version, fmtDate(build.released_at), size, sha, state, action];
  });
  list.append(buildTable(["Version", "Published", "Size", "SHA-256", "", ""], rows));
}

async function loadDevices() {
  const list = document.querySelector("#devices-list");
  const empty = document.querySelector("#devices-empty");
  const status = document.querySelector("#link-code-status");
  const { data, error } = await supabase
    .from("devices")
    .select("id, label, linked_at, last_seen_at, revoked_at")
    .order("linked_at", { ascending: false });
  if (error) {
    setStatus(status, "Linked devices could not be loaded.", "error");
    return;
  }
  list.replaceChildren();
  if (!data || !data.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const rows = data.map((device) => {
    const state = document.createElement("span");
    state.className = "table-status";
    state.textContent = device.revoked_at ? `revoked ${fmtDate(device.revoked_at)}` : "linked";
    if (device.revoked_at) {
      return [device.label || "WavRead install", fmtDate(device.linked_at), fmtDate(device.last_seen_at), state, "—"];
    }
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "btn tiny";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      const { error: revokeError } = await supabase
        .from("devices")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", device.id);
      if (revokeError) {
        setStatus(status, "The device could not be revoked. Try again.", "error");
        revoke.disabled = false;
        return;
      }
      setStatus(status, "Device revoked. Its report token no longer works.", "success");
      loadDevices();
    });
    return [device.label || "WavRead install", fmtDate(device.linked_at), fmtDate(device.last_seen_at), state, revoke];
  });
  list.append(buildTable(["Device", "Linked", "Last report", "State", ""], rows));
}

function initializeLinkCode() {
  const button = document.querySelector("#link-code-button");
  const panel = document.querySelector("#link-code-panel");
  const value = document.querySelector("#link-code-value");
  const status = document.querySelector("#link-code-status");
  button.addEventListener("click", async () => {
    button.disabled = true;
    setStatus(status, "Generating a code…");
    const { data, error } = await supabase
      .from("link_codes")
      .insert({ tester_id: currentTesterId })
      .select("code, expires_at")
      .single();
    button.disabled = false;
    if (error || !data?.code) {
      const tooMany = String(error?.message || "").includes("Too many");
      setStatus(status, tooMany
        ? "Too many codes in the last hour. Wait a while and try again."
        : "A code could not be generated. Try again.", "error");
      return;
    }
    setStatus(status, "");
    value.textContent = `${data.code.slice(0, 4)}-${data.code.slice(4)}`;
    panel.hidden = false;
  });
}

async function loadReports() {
  const status = document.querySelector("#reports-status");
  const feedbackList = document.querySelector("#feedback-list");
  const feedbackEmpty = document.querySelector("#feedback-empty");
  const crashesList = document.querySelector("#crashes-list");
  const crashesEmpty = document.querySelector("#crashes-empty");

  const [feedback, crashes] = await Promise.all([
    supabase.from("beta_feedback")
      .select("feedback_type, title, status, source, created_at")
      .order("created_at", { ascending: false }).limit(25),
    supabase.from("crash_reports")
      .select("kind, app_version, summary, status, created_at")
      .order("created_at", { ascending: false }).limit(25)
  ]);

  if (feedback.error || crashes.error) {
    setStatus(status, "Your reports could not be loaded. Try refreshing this page.", "error");
  }

  feedbackList.replaceChildren();
  const feedbackRows = (feedback.data || []).map((item) => {
    const state = document.createElement("span");
    state.className = "table-status";
    state.textContent = item.status;
    return [fmtDate(item.created_at), item.feedback_type, item.source === "app" ? "app" : "web", item.title, state];
  });
  if (feedbackRows.length) {
    feedbackEmpty.hidden = true;
    feedbackList.append(buildTable(["Sent", "Type", "From", "Title", "Status"], feedbackRows));
  } else {
    feedbackEmpty.hidden = false;
  }

  crashesList.replaceChildren();
  const crashRows = (crashes.data || []).map((item) => {
    const state = document.createElement("span");
    state.className = "table-status";
    state.textContent = item.status;
    return [fmtDate(item.created_at), item.kind, item.app_version, item.summary, state];
  });
  if (crashRows.length) {
    crashesEmpty.hidden = true;
    crashesList.append(buildTable(["Received", "Kind", "Version", "Summary", "Status"], crashRows));
  } else {
    crashesEmpty.hidden = false;
  }
}

async function initializeDashboard() {
  if (!document.querySelector("#dashboard-content")) return;
  const sessionMessage = document.querySelector("#session-message");
  try {
    supabase = await createBetaClient();
  } catch {
    supabase = null;
  }
  if (!supabase) {
    showDashboardState("setup-state");
    return;
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    setStatus(sessionMessage, location.hash ? "Your sign-in link is invalid or expired. Request a new link." : "Sign in to open your dashboard.", "error");
    showDashboardState("signed-out-state");
    return;
  }
  currentUser = userData.user;
  const signoutButton = document.querySelector("#signout-button");
  signoutButton.hidden = false;
  const signOut = async () => {
    await supabase.auth.signOut();
    location.replace("signin.html");
  };
  signoutButton.addEventListener("click", signOut);
  document.querySelector("#unauthorized-signout").addEventListener("click", signOut);

  const { data: tester, error: testerError } = await supabase
    .from("accounts")
    .select("tester_id, status, joined_at, complimentary_release_eligible")
    .eq("auth_user_id", currentUser.id)
    .maybeSingle();
  if (testerError || !tester || tester.status !== "active") {
    showDashboardState("unauthorized-state");
    return;
  }
  currentTesterId = tester.tester_id;

  document.querySelector("#tester-email").textContent = currentUser.email || "WavRead account";
  document.querySelector("#feedback-app-version").value = CURRENT_VERSION;
  document.querySelector("#feedback-os").value = navigator.userAgentData?.platform || navigator.platform || "Not provided";
  showDashboardState("dashboard-content");

  initializeLinkCode();
  const standing = await loadOwnership();
  loadBuilds(standing);
  loadDevices();
  loadReports();

  const { data: issues, error: issueError } = await supabase
    .from("beta_known_issues")
    .select("title, summary, affected_versions, status, workaround")
    .eq("published", true)
    .order("sort_order", { ascending: true });
  if (issueError) {
    setStatus(document.querySelector("#issues-status"), "Known issues could not be loaded. Try refreshing this page.", "error");
  } else {
    renderKnownIssues(issues || []);
  }

  const feedbackForm = document.querySelector("#feedback-form");
  const feedbackStatus = document.querySelector("#feedback-status");
  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!feedbackForm.reportValidity()) return;
    const fields = new FormData(feedbackForm);
    const submit = feedbackForm.querySelector("button[type=submit]");
    submit.disabled = true;
    setStatus(feedbackStatus, "Sending feedback…");
    const payload = {
      tester_id: currentTesterId,
      feedback_type: fields.get("feedback_type"),
      title: fields.get("title").trim(),
      description: fields.get("description").trim(),
      reproduction_steps: fields.get("reproduction_steps").trim() || null,
      app_version: CURRENT_VERSION,
      operating_system: fields.get("operating_system").trim() || null,
      follow_up_allowed: fields.get("follow_up_allowed") === "on"
    };
    const { error } = await supabase.from("beta_feedback").insert(payload);
    submit.disabled = false;
    if (error) {
      setStatus(feedbackStatus, "Your feedback could not be sent. Check your connection and try again.", "error");
      return;
    }
    feedbackForm.reset();
    document.querySelector("#feedback-app-version").value = CURRENT_VERSION;
    document.querySelector("#feedback-os").value = navigator.userAgentData?.platform || navigator.platform || "Not provided";
    setStatus(feedbackStatus, "Feedback received. Thank you for helping improve WavRead.", "success");
    loadReports();
  });

}

initializeSignIn();
initializeDashboard();
