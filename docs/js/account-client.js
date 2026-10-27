// Shared pieces for the account pages: /account, the article editor, sign-up,
// password reset, and public profiles.
//
// These pages use the dashboard's session, under the dashboard's storage key,
// so someone signed in there is signed in here. Nothing in this file is an
// authorization boundary: RLS and the Edge Functions decide what an account
// may read or change, and these helpers only decide what to draw. No password
// is ever logged, stored, or sent anywhere but Supabase Auth.
//
// The pure helpers below touch no page state, so tests/account-pages.test.mjs
// imports this module directly.

export const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
export const SESSION_KEY = "wavread-beta-session";
export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Passwords: long enough to resist guessing, short enough for bcrypt, which
// ignores anything past 72 bytes. Supabase Auth applies its own minimum too;
// this one is the message a person reads first.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 72;

export const PROFILE_LIMITS = { name: 80, bio: 1000, slugMin: 3, slugMax: 40 };
export const RESERVED_SLUGS = new Set([
  "admin", "account", "accounts", "articles", "community", "staff",
  "support", "team", "help", "owner", "index", "wavread", "ezmannbuilds",
]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isLocal = () => LOCAL_HOSTS.has(globalThis.location?.hostname);

// A site path as this host serves it: clean URLs on wavread.com, files on the
// local preview (python -m http.server serves account.html, not /account).
export function sitePath(path, local = isLocal()) {
  if (!local) return path;
  const [route, query] = path.split("?");
  if (route === "/") return query ? `/index.html?${query}` : "/";
  return `${route}.html${query ? `?${query}` : ""}`;
}

// A public profile's address: /u/<slug> on the site (vercel.json rewrites it
// to u.html), and u.html?slug= on the local preview, which has no rewrites.
export function profilePath(slug, local = isLocal()) {
  const encoded = encodeURIComponent(slug);
  return local ? `/u.html?slug=${encoded}` : `/u/${encoded}`;
}

// The slug a profile page was opened for, from either form of its address.
export function slugFromLocation(loc = globalThis.location) {
  const fromPath = String(loc?.pathname ?? "").match(/^\/u\/([^/]+)\/?$/)?.[1];
  const raw = fromPath ? decodeURIComponent(fromPath) : new URLSearchParams(loc?.search ?? "").get("slug");
  const slug = String(raw ?? "").trim().toLowerCase();
  return SLUG.test(slug) && slug.length <= PROFILE_LIMITS.slugMax ? slug : null;
}

// Where a sign-in may send someone afterwards. Anything else in ?next= is
// ignored, so a crafted link cannot send a signed-in person off the site.
export const NEXT_PATHS = new Set(["/dashboard", "/account", "/account/articles/new"]);
export const nextPath = (asked, fallback = "/dashboard") => (NEXT_PATHS.has(asked) ? asked : fallback);

export async function loadConfiguration() {
  if (isLocal()) return globalThis.WAVREAD_BETA_CONFIG ?? null;
  try {
    const response = await fetch("/api/beta-config", { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const config = await response.json();
    return config.configured ? config : null;
  } catch {
    return null;
  }
}

// The Supabase client, or null when this deployment has no configuration.
// detectSessionInUrl reads the tokens a confirmation or reset link carries.
export async function createAccountClient({ detectSessionInUrl = true } = {}) {
  const config = await loadConfiguration();
  if (!config?.url || !config?.publishableKey) return null;
  const { createClient } = await import(SUPABASE_MODULE);
  const supabase = createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl, storageKey: SESSION_KEY },
  });
  return { supabase, config };
}

export function setStatus(element, message, state = "", field = null) {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
  if (field) field.setAttribute("aria-invalid", state === "error" ? "true" : "false");
}

export function showState(ids, visible) {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) element.hidden = id !== visible;
  }
}

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const longFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" });

export function fmtDate(iso, long = false) {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return (long ? longFormat : dateFormat).format(parsed);
}

// Why a new password will not do, or null. The confirmation must match, so a
// typo cannot lock someone out of the password they meant.
export function passwordProblem(password, confirm) {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (new TextEncoder().encode(value).length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (value.trim() !== value) return "Leave out spaces at the start and end.";
  if (confirm !== undefined && value !== String(confirm ?? "")) return "The two passwords do not match.";
  return null;
}

// Supabase Auth's refusals, in sentences. Rate limits get their own because
// waiting is the fix; nothing here says whether an email has an account.
export function authErrorMessage(error, fallback = "Something went wrong. Try again shortly.") {
  const code = String(error?.code || error?.error_code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if (error?.status === 429 || code.startsWith("over_") || message.includes("rate limit")) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (code === "weak_password" || message.includes("weak") || message.includes("at least")) {
    return `Choose a longer password: at least ${PASSWORD_MIN} characters, and not one you use on other sites.`;
  }
  if (code === "same_password" || message.includes("different from the old")) return "That is already your password. Choose a new one.";
  if (code === "signup_disabled" || message.includes("signups not allowed")) {
    return "Writer sign-up is not open yet. You do not need an account to buy WavRead: checkout takes your email.";
  }
  if (code === "reauthentication_needed") return "For security, sign in again with an email link, then set your password.";
  if (code === "email_not_confirmed" || message.includes("not confirmed")) return "Confirm your email first: open the link we sent when you created the account.";
  if (code === "invalid_credentials" || message.includes("invalid login")) {
    return "That email and password do not match. Try again, reset your password, or email yourself a sign-in link.";
  }
  if (code === "session_not_found" || message.includes("session missing") || message.includes("jwt")) {
    return "Your sign-in has ended. Sign in again, then try once more.";
  }
  if (code === "otp_expired" || message.includes("expired")) return "That link is invalid or has expired. Request a new one.";
  return fallback;
}

// A profile as the form holds it, cleaned for the database: empty fields are
// null, which is what "no profile" is stored as.
export function profileFromForm({ display_name, bio, public_slug }) {
  const clean = (value) => {
    const text = String(value ?? "").trim();
    return text ? text : null;
  };
  return {
    display_name: clean(String(display_name ?? "").replace(/\s+/g, " ")),
    bio: clean(String(bio ?? "").replace(/\r\n?/g, "\n")),
    public_slug: clean(String(public_slug ?? "").toLowerCase()),
  };
}

export function profileProblems(profile) {
  const problems = [];
  if (profile.display_name && [...profile.display_name].length > PROFILE_LIMITS.name) {
    problems.push(`Keep the name under ${PROFILE_LIMITS.name} characters.`);
  }
  if (profile.bio && [...profile.bio].length > PROFILE_LIMITS.bio) problems.push(`Keep the bio under ${PROFILE_LIMITS.bio} characters.`);
  const slug = profile.public_slug;
  if (slug) {
    if (!SLUG.test(slug) || slug.length < PROFILE_LIMITS.slugMin || slug.length > PROFILE_LIMITS.slugMax) {
      problems.push(`The profile address takes ${PROFILE_LIMITS.slugMin} to ${PROFILE_LIMITS.slugMax} lowercase letters, digits and single hyphens.`);
    } else if (RESERVED_SLUGS.has(slug)) {
      problems.push("That profile address is reserved. Choose another.");
    }
  }
  return problems;
}

// One sentence and a heading for the account's standing, from its account row
// and entitlement rows. Reads expires_at when the trial migration has added it
// and treats it as absent otherwise, so it is right before and after that
// lands. It only decides what the page says; download-build asks the database.
export function standingSummary(account, rows = [], now = Date.now()) {
  const live = (row) => !row.revoked_at && (!row.expires_at || Date.parse(row.expires_at) > now);
  if (account?.free_updates) {
    return { title: "Owned", detail: account.free_updates_note || "Every build stays yours.", buy: false };
  }
  const kept = rows.filter((row) => row.source !== "trial" && live(row));
  if (kept.some((row) => !row.build_version)) {
    return { title: "Owned", detail: "Every 1.x build is included. Download yours from the dashboard.", buy: false };
  }
  if (kept.length) {
    const versions = [...new Set(kept.map((row) => row.build_version))];
    return { title: versions.length === 1 ? "1 build owned" : `${versions.length} builds owned`, detail: `${versions.join(", ")}. One payment covers every 1.x build.`, buy: true };
  }
  const trial = rows.find((row) => row.source === "trial");
  if (trial && live(trial)) {
    return { title: "Trial", detail: `Your trial runs until ${fmtDate(trial.expires_at, true)}. Buy WavRead to keep it after that.`, buy: true };
  }
  if (trial) return { title: "Trial ended", detail: "Downloads are closed until you buy WavRead.", buy: true };
  return { title: "Not owned yet", detail: "You can write for WavRead without owning it. One payment of $50 covers every 1.x build.", buy: true };
}

export const STATUS_LABELS = {
  draft: "Draft",
  pending: "Waiting for review",
  needs_changes: "Changes requested",
  approved: "Approved",
  rejected: "Not accepted",
  published: "Published",
};

// Calls one of the account Edge Functions as the signed-in caller. Answers
// { ok, status, data }; a network failure is status 0 with no data.
export async function callFunction(supabase, config, name, body) {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    const response = await fetch(`${config.url.replace(/\/$/, "")}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "apikey": config.publishableKey,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

// The signed-in caller's account row, creating the plain account a confirmed
// writer is owed if there is none yet (ensure_my_account). Answers
// { account } or { problem } with a sentence.
export async function signedInAccount(supabase, columns) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { signedOut: true };
  const user = userData.user;
  const read = () => supabase.from("accounts").select(columns).eq("auth_user_id", user.id).maybeSingle();
  let account = await read();
  if (account.error) return { user, problem: "Your account could not be read. Refresh this page." };
  if (!account.data) {
    const ensured = await supabase.rpc("ensure_my_account");
    if (ensured.error) {
      const code = String(ensured.error.code || "");
      return {
        user,
        problem: code === "55000"
          ? "Confirm your email first: open the link we sent when you created the account."
          : code === "22023"
            ? "This email's account is linked to a different sign-in. Email support@wavread.com and we will sort it out."
            : "Your account could not be set up. Refresh this page, or email support@wavread.com.",
      };
    }
    account = await read();
    if (account.error || !account.data) return { user, problem: "Your account could not be read. Refresh this page." };
  }
  if (account.data.status !== "active") {
    return { user, problem: "This account is not active. Email support@wavread.com if that is unexpected." };
  }
  return { user, account: account.data };
}
