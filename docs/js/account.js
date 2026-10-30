// /account: profile, password, standing, and the articles you have written.
//
// What this page may change is limited by the database, not by this script:
// three profile columns of the holder's own account row (a column grant and
// an RLS policy), the holder's own password through Supabase Auth, and the
// holder's own drafts through the article functions. Setting a password calls
// updateUser with a password and nothing else, so the sign-in keeps its email
// and its id, and with them the account row and every purchase and entitlement
// hanging off it.

import {
  STATUS_LABELS,
  authErrorMessage,
  createAccountClient,
  fmtDate,
  passwordProblem,
  profileFromForm,
  profilePath,
  profileProblems,
  setStatus,
  showState,
  signedInAccount,
  sitePath,
  standingSummary,
} from "./account-client.js";

const STATES = ["loading-state", "setup-state", "signed-out-state", "unauthorized-state", "account-content"];
const ACCOUNT_COLUMNS = "tester_id, status, email, display_name, bio, public_slug, profile_updated_at, free_updates, free_updates_note";

let supabase = null;

function table(headers, rows) {
  const element = document.createElement("table");
  const head = element.createTHead().insertRow();
  for (const label of headers) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.append(th);
  }
  const body = element.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const cell of cells) {
      const td = row.insertCell();
      if (cell instanceof Node) td.append(cell);
      else td.textContent = String(cell);
    }
  }
  return element;
}

async function loadStanding(account) {
  const title = document.querySelector("#standing-title");
  const detail = document.querySelector("#standing-detail");
  const buy = document.querySelector("#standing-buy");
  // Every column, so expires_at is read once the trial migration adds it.
  const { data, error } = await supabase.from("entitlements").select("*").eq("entitlement", "early_build");
  if (error) {
    title.textContent = "Standing unavailable";
    detail.textContent = "Your licence could not be read. Refresh this page.";
    return;
  }
  const summary = standingSummary(account, data || []);
  title.textContent = summary.title;
  detail.textContent = summary.detail;
  buy.hidden = !summary.buy;
  buy.href = sitePath("/buy");
}

// "Set a password" for accounts that have only ever used email links, which is
// every buyer and trialist until they add one; "Change password" otherwise.
async function loadPassword(user) {
  const detail = document.querySelector("#password-detail");
  const title = document.querySelector("#password-title");
  const form = document.querySelector("#password-set-form");
  const button = document.querySelector("#password-set-button");
  const status = document.querySelector("#password-set-status");
  const password = document.querySelector("#new-password");
  const confirm = document.querySelector("#confirm-password");
  const username = document.querySelector("#password-username");
  if (username) username.value = user.email || "";

  const render = (hasPassword) => {
    title.textContent = hasPassword ? "Password" : "Set a password";
    detail.textContent = hasPassword
      ? "This account has a password. You can still sign in with an email link whenever you like."
      : "You have been signing in with email links. Add a password to sign in without waiting for an email. Your purchases and downloads stay exactly where they are.";
    button.textContent = hasPassword ? "Change password" : "Set a password";
    form.hidden = false;
  };
  const known = await supabase.rpc("account_password_status");
  render(known.error ? true : known.data === true);
  if (known.error) detail.textContent = "Set or change the password you sign in with.";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    const problem = passwordProblem(password.value, confirm.value);
    if (problem) {
      setStatus(status, problem, "error", password);
      return;
    }
    button.disabled = true;
    setStatus(status, "Saving your password…", "", password);
    try {
      // The password only. Passing an email here would start an email change.
      const { error } = await supabase.auth.updateUser({ password: password.value });
      password.value = "";
      confirm.value = "";
      if (error) {
        setStatus(status, authErrorMessage(error, "Your password could not be saved. Try again shortly."), "error", password);
        return;
      }
      render(true);
      setStatus(status, "Password saved. Next time, sign in with your email and this password.", "success", password);
    } catch {
      password.value = "";
      confirm.value = "";
      setStatus(status, "Could not reach sign-in. Check your connection and try again.", "error", password);
    } finally {
      button.disabled = false;
    }
  });
}

function showProfile(profile) {
  document.querySelector("#display-name").value = profile.display_name || "";
  document.querySelector("#bio").value = profile.bio || "";
  document.querySelector("#public-slug").value = profile.public_slug || "";
  document.querySelector("#slug-preview").textContent = profile.public_slug || "your-name";
  const link = document.querySelector("#profile-public-link");
  link.hidden = !profile.public_slug;
  if (profile.public_slug) link.href = profilePath(profile.public_slug);
}

function initializeProfile(account) {
  const form = document.querySelector("#profile-form");
  const status = document.querySelector("#profile-status");
  const slugField = document.querySelector("#public-slug");
  showProfile(account);
  slugField.addEventListener("input", () => {
    document.querySelector("#slug-preview").textContent = slugField.value.trim().toLowerCase() || "your-name";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    if (submit.disabled) return;
    const profile = profileFromForm(Object.fromEntries(new FormData(form)));
    const problems = profileProblems(profile);
    if (problems.length) {
      setStatus(status, problems.join(" "), "error", slugField);
      return;
    }
    submit.disabled = true;
    setStatus(status, "Saving your profile…");
    const { data, error } = await supabase
      .from("accounts")
      .update(profile)
      .eq("tester_id", account.tester_id)
      .select("display_name, bio, public_slug, profile_updated_at")
      .single();
    submit.disabled = false;
    if (error) {
      const taken = error.code === "23505";
      setStatus(status, taken
        ? "That profile address is taken. Choose another."
        : error.code === "23514"
          ? "Check the profile fields: the address takes 3 to 40 lowercase letters, digits and hyphens, and some words are reserved."
          : "Your profile could not be saved. Try again shortly.", "error", slugField);
      return;
    }
    showProfile(data);
    setStatus(status, data.public_slug ? "Profile saved. It is public at your profile address." : "Profile saved. It is not public until you choose a profile address.", "success", slugField);
  });
}

async function loadArticles() {
  const list = document.querySelector("#articles-list");
  const empty = document.querySelector("#articles-empty");
  const status = document.querySelector("#articles-status");
  const { data, error } = await supabase
    .from("article_submissions")
    .select("id, title, status, updated_at, submitted_at, reviewed_at, published_slug")
    .order("updated_at", { ascending: false });
  if (error) {
    setStatus(status, "Your articles could not be loaded. Refresh this page.", "error");
    return;
  }
  list.replaceChildren();
  empty.hidden = Boolean(data?.length);
  if (!data?.length) return;
  const rows = data.map((item) => {
    const state = document.createElement("span");
    state.className = "table-status";
    state.textContent = STATUS_LABELS[item.status] || item.status;
    const open = document.createElement("a");
    open.href = sitePath(`/account/articles/edit?id=${encodeURIComponent(item.id)}`);
    open.textContent = item.status === "draft" || item.status === "needs_changes" ? "Edit" : "View";
    return [item.title || "Untitled draft", state, fmtDate(item.updated_at), open];
  });
  list.append(table(["Title", "Status", "Updated", ""], rows));
}

async function initialize() {
  try {
    const ctx = await createAccountClient();
    supabase = ctx?.supabase ?? null;
  } catch {
    supabase = null;
  }
  if (!supabase) return showState(STATES, "setup-state");

  const signOut = async () => {
    await supabase.auth.signOut();
    location.replace(sitePath("/signin"));
  };
  document.querySelector("#unauthorized-signout")?.addEventListener("click", signOut);

  const result = await signedInAccount(supabase, ACCOUNT_COLUMNS);
  if (result.signedOut) {
    document.querySelector("#signin-link").href = `${sitePath("/signin")}?next=/account`;
    return showState(STATES, "signed-out-state");
  }
  const signoutButton = document.querySelector("#signout-button");
  signoutButton.hidden = false;
  signoutButton.addEventListener("click", signOut);
  if (result.problem) {
    document.querySelector("#unauthorized-message").textContent = result.problem;
    return showState(STATES, "unauthorized-state");
  }

  const { user, account } = result;
  document.querySelector("#account-email").textContent = user.email || account.email || "";
  showState(STATES, "account-content");
  initializeProfile(account);
  loadStanding(account);
  loadPassword(user);
  loadArticles();
}

if (document.querySelector("#account-content")) initialize();
