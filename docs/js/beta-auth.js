const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
const CURRENT_VERSION = "1.5.6";
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

// When a trial ends, to the minute and in the reader's own time zone. It
// decides whether they can still download, so it is written out in full
// rather than as "in 3 days".
const momentFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short"
});

function fmtMoment(iso) {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "—" : momentFormat.format(parsed);
}

// Where a Buy link goes: /buy on the site, buy.html on the local preview,
// which serves files rather than clean URLs. The buy page reads no email from
// the address bar, so none is put there.
function buyPath() {
  return LOCAL_HOSTS.has(location.hostname) ? "buy.html" : "/buy";
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
    const response = await fetch("/api/beta-config", { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
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
  form.addEventListener("submit", event => event.preventDefault());
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
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    const emailField = form.querySelector("#email");
    setStatus(status, "Sending a secure sign-in link…", "", emailField);
    const redirectPath = LOCAL_HOSTS.has(location.hostname) ? "dashboard.html" : "/dashboard";
    const redirectTo = new URL(redirectPath, location.origin).href;
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo }
      });
      if (error) {
        setStatus(status, friendlyAuthError(error), "error", emailField);
        return;
      }
      form.reset();
      setStatus(status, "Check your email for a one-time sign-in link. It expires shortly.", "success", emailField);
    } catch {
      setStatus(status, "Could not reach sign-in. Check your connection and try again.", "error", emailField);
    } finally {
      submit.disabled = false;
    }
  });
  submit.disabled = false;
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
    meta.textContent = `${issue.status} · ${issue.affected_versions || "Current build"}`;
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

// What an account's entitlement rows add up to at `now`. Active is the
// database's rule (entitlement_is_active): not revoked, and not past
// expires_at, which only a trial has. Contributor standing, or an unscoped
// purchase or grant, covers every build; otherwise access is build by build. A
// trial counts only while nothing else gives access, and covers every build
// until it ends. This only decides what the page shows — download-build asks
// the database again for every file.
function standingFrom(account, rows, now = Date.now()) {
  const live = (r) => !r.revoked_at && (!r.expires_at || Date.parse(r.expires_at) > now);
  const kept = rows.filter((r) => r.source !== "trial" && live(r));
  const paidEverything = Boolean(account?.free_updates) || kept.some((r) => !r.build_version);
  const owned = new Set(kept.map((r) => r.build_version).filter(Boolean));
  const trialRow = paidEverything || owned.size ? null : rows.find((r) => r.source === "trial");
  // A trial revoked before its end date ended when it was revoked.
  const endsAt = trialRow?.revoked_at && Date.parse(trialRow.revoked_at) < Date.parse(trialRow.expires_at)
    ? trialRow.revoked_at
    : trialRow?.expires_at;
  const trial = trialRow ? { active: live(trialRow), ends_at: endsAt } : null;
  return { owned, everything: paidEverything || Boolean(trial?.active), paidEverything, trial };
}

async function loadOwnership() {
  const title = document.querySelector("#ownership-title");
  const detail = document.querySelector("#ownership-detail");
  const action = document.querySelector("#ownership-action");
  const [account, entitlements, purchases] = await Promise.all([
    supabase.from("accounts").select("free_updates, free_updates_note")
      .eq("auth_user_id", currentUser.id).maybeSingle(),
    // Revoked and expired rows too: an ended trial is still something to say.
    supabase.from("entitlements").select("source, build_version, granted_at, expires_at, revoked_at")
      .eq("entitlement", "early_build"),
    supabase.from("purchases").select("amount_cents, build_version, purchased_at, status")
      .order("purchased_at", { ascending: false })
  ]);
  if (entitlements.error || account.error) {
    title.textContent = "Standing unavailable";
    detail.textContent = "Your purchases could not be read. Refresh this page.";
    return { owned: new Set(), everything: false, trial: null };
  }

  const standing = standingFrom(account.data, entitlements.data || []);
  const { owned, trial } = standing;
  const paid = (purchases.data || []).filter((p) => p.status === "paid");
  const spent = paid.reduce((sum, p) => sum + (p.amount_cents || 0), 0);
  const offerPurchase = () => {
    action.href = buyPath();
    action.textContent = "Buy WavRead — $50 →";
    action.hidden = false;
  };

  if (account.data?.free_updates) {
    title.textContent = "Owned";
    detail.textContent = account.data.free_updates_note
      || "Every build stays yours, for what you already paid.";
    action.hidden = true;
  } else if (standing.paidEverything) {
    title.textContent = "Owned";
    detail.textContent = `Every build is included${spent ? ` · $${(spent / 100).toFixed(2)} paid` : ""}.`;
    action.hidden = true;
  } else if (owned.size) {
    title.textContent = owned.size === 1 ? "1 build owned" : `${owned.size} builds owned`;
    detail.textContent = `${[...owned].join(", ")} · $${(spent / 100).toFixed(2)} paid.`;
    action.hidden = false;
  } else if (trial?.active) {
    title.textContent = "On a free trial";
    detail.textContent = `Your 14-day trial covers Mac and Windows until ${fmtMoment(trial.ends_at)}. Buy WavRead to keep it after that.`;
    offerPurchase();
  } else if (trial) {
    title.textContent = "Trial ended";
    detail.textContent = `Your 14-day trial ended ${fmtMoment(trial.ends_at)}. Downloads are closed until you buy WavRead.`;
    offerPurchase();
  } else {
    title.textContent = "Not owned yet";
    detail.textContent = "One payment covers every build.";
    action.hidden = false;
  }
  return standing;
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

const PLATFORM_NAMES = { macos: "macOS", windows: "Windows" };

// Which desktop this browser runs on: "macos", "windows", or null when it
// cannot tell — a phone, a tablet, Linux, ChromeOS, anything unrecognized.
// It only decides which download button is highlighted. Both are always
// shown, and each one only ever fetches a build of its own platform.
function detectPlatform(nav = globalThis.navigator) {
  if (!nav) return null;
  const hint = nav.userAgentData?.platform;
  if (hint === "macOS") return "macos";
  if (hint === "Windows") return "windows";
  const agent = String(nav.userAgent || "");
  const legacy = String(nav.platform || "");
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(agent)) return null;
  // iPadOS Safari introduces itself as a Mac; only a touch screen gives it away.
  if (/Macintosh|Mac OS X/.test(agent) || /^Mac/.test(legacy)) return nav.maxTouchPoints > 1 ? null : "macos";
  if (/Windows/.test(agent) || /^Win/.test(legacy)) return "windows";
  return null;
}

// The newest build of one platform — never just the newest build. Windows
// 1.5.6 was published after Mac 1.5.6, so the first row of the catalog is a
// Windows installer, and a Mac button that took it would hand a Mac the .exe.
function newestFor(builds, platform) {
  return builds.find((b) => (b.platform || "macos") === platform) || null;
}

// The same button the table row has: Download when this account owns the
// build, otherwise Buy, otherwise nothing to press.
function buildAction(build, has, status, downloadLabel = "Download") {
  const action = document.createElement("button");
  action.type = "button";
  action.className = "btn tiny";
  if (has(build)) {
    action.textContent = downloadLabel;
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
  return action;
}

const PLATFORM_CHOICES = {
  macos: { label: "Download for Mac", needs: "Apple Silicon, macOS 14 or later" },
  windows: { label: "Download for Windows", needs: "Windows 10 or 11, 64-bit" }
};

// One button per platform, the detected one first and highlighted. With no
// confident guess neither is, and the note asks the reader to pick.
function renderPlatformDownloads(builds, has, status) {
  const box = document.querySelector("#platform-downloads");
  const note = document.querySelector("#platform-note");
  if (!box) return;
  const detected = detectPlatform();
  const order = detected === "windows" ? ["windows", "macos"] : ["macos", "windows"];
  box.replaceChildren(...order.map((platform) => {
    const choice = PLATFORM_CHOICES[platform];
    const build = newestFor(builds, platform);
    let action;
    if (build) {
      action = buildAction(build, has, status, choice.label);
    } else {
      action = document.createElement("button");
      action.type = "button";
      action.textContent = choice.label;
      action.disabled = true;
    }
    action.className = platform === detected ? "btn primary" : "btn";
    const detail = document.createElement("p");
    detail.textContent = build
      ? `${PLATFORM_NAMES[platform]} · ${build.version} · ${choice.needs}`
      : `${PLATFORM_NAMES[platform]} · not published yet`;
    const item = document.createElement("div");
    item.className = "platform-download";
    item.dataset.platform = platform;
    if (platform === detected) item.dataset.detected = "true";
    item.append(action, detail);
    return item;
  }));
  box.hidden = false;
  if (note) {
    note.hidden = false;
    note.textContent = detected
      ? `This looks like ${detected === "macos" ? "a Mac" : "a Windows PC"}, so that build is first. The other is beside it.`
      : "Choose the build for the computer you will install WavRead on.";
  }
}

async function loadBuilds(standing) {
  const list = document.querySelector("#builds-list");
  const empty = document.querySelector("#builds-empty");
  const locked = document.querySelector("#builds-locked");
  const status = document.querySelector("#builds-status");
  const { data, error } = await supabase
    .from("builds")
    .select("id, version, platform, kind, channel, file_name, sha256, size_bytes, notes, released_at, price_cents")
    .order("released_at", { ascending: false });
  if (error) {
    setStatus(status, "The build list could not be loaded. Try refreshing this page.", "error");
    return;
  }
  // A running trial downloads the trial build and nothing else; everyone else
  // sees the paid build. download-build enforces the same rule
  // (has_build_access); this only decides what the page lists.
  const onTrial = Boolean(standing.trial?.active) && !standing.paidEverything && !standing.owned.size;
  const builds = (data || []).filter((b) => (b.kind || "full") === (onTrial ? "trial" : "full"));
  // The "Current build" card takes its date from the catalog rather than from
  // a line typed into the page, which went stale once already.
  const dateEl = document.querySelector("#current-build-date");
  const newest = newestFor(builds, "macos");
  if (dateEl && newest) dateEl.textContent = fmtDate(newest.released_at);
  const has = (b) => standing.everything || standing.owned.has(b.version);
  // An ended trial gets its own note in place of "you do not own WavRead yet".
  const trialEnded = Boolean(standing.trial && !standing.trial.active);
  const ended = document.querySelector("#builds-trial-ended");
  locked.hidden = trialEnded || builds.length === 0 || builds.some(has);
  if (ended) ended.hidden = !trialEnded || builds.length === 0;
  const included = standing.trial?.active ? `trial until ${fmtDate(standing.trial.ends_at)}` : "included";
  list.replaceChildren();
  if (!builds.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  renderPlatformDownloads(builds, has, status);
  const rows = builds.map((build) => {
    const sha = document.createElement("code");
    sha.textContent = build.sha256;
    const size = `${(build.size_bytes / (1024 * 1024)).toFixed(0)} MB`;
    const action = buildAction(build, has, status);
    const state = document.createElement("span");
    state.className = "table-status";
    state.textContent = has(build) ? included : "not owned";
    // One version can be published once per platform, so the row says which.
    const platform = PLATFORM_NAMES[build.platform] || "macOS";
    return [build.version, platform, fmtDate(build.released_at), size, sha, state, action];
  });
  list.append(buildTable(["Version", "Platform", "Published", "Size", "SHA-256", "", ""], rows));
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

async function initializeLicenceAdmin() {
  const panel=document.querySelector('#licence-admin');
  const form=document.querySelector('#licence-grant-form');
  if(!panel || !form) return;
  form.addEventListener('submit',event=>event.preventDefault());
  const permission=await supabase.rpc('owner_licence_status');
  if(permission.error || permission.data!==true) return;
  panel.hidden=false;
  const manage = document.querySelector('#licence-manage-form');
  manage?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!manage.reportValidity()) return;
    const submit = manage.querySelector('button');
    if (submit.disabled) return;
    submit.disabled = true;
    const status = document.querySelector('#licence-manage-status');
    const results = document.querySelector('#licence-results');
    results.replaceChildren();
    setStatus(status, 'Checking licence access…');
    try {
      const {data, error} = await supabase.rpc('owner_manage_licence', {
        recipient_email: document.querySelector('#licence-lookup-email').value.trim().toLowerCase(),
        operation: document.querySelector('#licence-operation').value
      });
      if (error || !data) throw new Error('Licence action failed');
      setStatus(status, `${data.email}: ${data.account_status}. Contributor access: ${data.free_updates ? 'yes' : 'no'}.`, 'success');
      for (const licence of data.licences || []) {
        const row = document.createElement('p');
        const ran = licence.expires_at && Date.parse(licence.expires_at) <= Date.now();
        const ends = licence.expires_at ? ` · ends ${fmtDate(licence.expires_at)}` : '';
        row.textContent = `${licence.owner_grant ? 'Complimentary grant' : licence.source} · ${licence.build_version || 'All eligible builds'} · ${licence.revoked_at ? 'Revoked' : ran ? 'Expired' : 'Active'}${ends}`;
        results.append(row);
      }
    } catch { setStatus(status, 'Could not update licence access. Check your sign-in and retry.', 'error'); }
    finally { submit.disabled = false; }
  });
  const button=form.querySelector('button[type=submit]');
  const field=document.querySelector('#licence-recipient');
  const status=document.querySelector('#licence-grant-status');
  button.disabled=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(button.disabled || !form.reportValidity()) return;
    button.disabled=true;
    setStatus(status,'Granting licence…');
    try {
      const email=field.value.trim().toLowerCase();
      const {data,error}=await supabase.functions.invoke('grant-licence',{body:{email}});
      if(error || !data || data.error) throw new Error('Grant failed');
      setStatus(status,`${data.already_owned?'Already owned':'Free licence granted'}: ${data.email}. They can sign in at wavread.com/signin. No email was sent.`,'success');
      form.reset();
    } catch {
      setStatus(status,'Could not grant the licence. Check the address and your sign-in, then retry.','error',field);
    } finally { button.disabled=false; }
  });
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

  initializeLicenceAdmin().catch(()=>{});
  initializeLinkCode();
  const standing = await loadOwnership();
  const devicesTrialNote = document.querySelector("#devices-trial-note");
  if (devicesTrialNote) devicesTrialNote.hidden = !standing.trial;
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


/* Attachments are uploaded after the report row exists, because the row is
   what an attachment belongs to and what the size and count limits are counted
   against. The report is saved either way: a picture that would not upload is
   worth saying out loud, and worth nothing if it takes the words with it. */
async function attachToReport(feedbackId, files, statusEl) {
  const base = betaConfig.url.replace(/\/$/, "");
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "apikey": betaConfig.publishableKey
  };
  const failures = [];
  for (const file of files) {
    try {
      const ask = await fetch(`${base}/functions/v1/report-media`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          feedback_id: feedbackId,
          mime_type: file.type,
          size_bytes: file.size
        })
      });
      const prepared = await ask.json().catch(() => ({}));
      if (!ask.ok || !prepared.token) {
        // The function explains refusals in words — too big, wrong type, too
        // many — so show its sentence rather than inventing one.
        failures.push(prepared.error || `${file.name} could not be attached.`);
        continue;
      }
      const put = await supabase.storage
        .from("report-media")
        .uploadToSignedUrl(prepared.path, prepared.token, file);
      if (put.error) {
        failures.push(`${file.name} did not finish uploading.`);
        continue;
      }
      await fetch(`${base}/functions/v1/report-media`, {
        method: "POST",
        headers,
        body: JSON.stringify({ attachment_id: prepared.attachment_id })
      });
    } catch {
      failures.push(`${file.name} did not finish uploading.`);
    }
  }
  return failures;
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
    const chosen = [...(document.querySelector("#feedback-media")?.files || [])];
    const { data: saved, error } = await supabase
      .from("beta_feedback").insert(payload).select("id").single();
    if (error) {
      submit.disabled = false;
      setStatus(feedbackStatus, "Your feedback could not be sent. Check your connection and try again.", "error");
      return;
    }
    let failures = [];
    if (chosen.length) {
      setStatus(feedbackStatus, chosen.length === 1
        ? "Sent. Uploading your attachment…"
        : `Sent. Uploading ${chosen.length} attachments…`);
      failures = await attachToReport(saved.id, chosen, feedbackStatus);
    }
    submit.disabled = false;
    feedbackForm.reset();
    document.querySelector("#feedback-app-version").value = CURRENT_VERSION;
    document.querySelector("#feedback-os").value = navigator.userAgentData?.platform || navigator.platform || "Not provided";
    if (failures.length) {
      // The report is saved. Say which half worked, so nobody retypes it.
      setStatus(feedbackStatus,
        `Your feedback was received, but ${failures.join(" ")} The report is saved either way.`,
        "error");
    } else {
      setStatus(feedbackStatus, "Feedback received. Thank you for helping improve WavRead.", "success");
    }
    loadReports();
  });

}

initializeSignIn();
initializeDashboard();
