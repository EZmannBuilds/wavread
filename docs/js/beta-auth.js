const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
const CURRENT_VERSION = "1.4.4";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

let supabase = null;
let currentUser = null;
let currentTesterId = null;

function setStatus(element, message, state = "") {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
}

function friendlyAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
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
    location.replace("beta-dashboard.html");
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = new FormData(form).get("email").trim();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    setStatus(status, "Sending a secure sign-in link…");
    const redirectPath = LOCAL_HOSTS.has(location.hostname) ? "beta-dashboard.html" : "/beta-dashboard";
    const redirectTo = new URL(redirectPath, location.origin).href;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo }
    });
    submit.disabled = false;
    if (error) {
      setStatus(status, friendlyAuthError(error), "error");
      return;
    }
    form.reset();
    setStatus(status, "Check your email for a one-time sign-in link. It expires shortly.", "success");
  });
}

function showDashboardState(id) {
  ["loading-state", "setup-state", "signed-out-state", "unauthorized-state", "dashboard-content"].forEach((stateId) => {
    const element = document.getElementById(stateId);
    if (element) element.hidden = stateId !== id;
  });
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
    setStatus(sessionMessage, location.hash ? "Your sign-in link is invalid or expired. Request a new link." : "Sign in to open the tester dashboard.", "error");
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
    .from("beta_testers")
    .select("tester_id, status, joined_at, complimentary_release_eligible")
    .eq("auth_user_id", currentUser.id)
    .maybeSingle();
  if (testerError || !tester || tester.status !== "active") {
    showDashboardState("unauthorized-state");
    return;
  }
  currentTesterId = tester.tester_id;

  document.querySelector("#tester-email").textContent = currentUser.email || "Registered tester";
  document.querySelector("#feedback-app-version").value = CURRENT_VERSION;
  document.querySelector("#feedback-os").value = navigator.userAgentData?.platform || navigator.platform || "Not provided";
  showDashboardState("dashboard-content");

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
  });

}

initializeSignIn();
initializeDashboard();
