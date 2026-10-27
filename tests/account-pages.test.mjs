// Password sign-in, sign-up, reset, /account, the article editor and public
// profiles: what the pages offer, how the sign-in script handles a password,
// and the helpers the account pages share.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { access, readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  NEXT_PATHS,
  PASSWORD_MIN,
  authErrorMessage,
  nextPath,
  passwordProblem,
  profileFromForm,
  profilePath,
  profileProblems,
  sitePath,
  slugFromLocation,
  standingSummary,
} from "../docs/js/account-client.js";
import { PREVIEW_DELAY_MS, applyFormat } from "../docs/js/article-editor.js";

const read = (path) => readFile(path, "utf8");
const tick = () => new Promise(setImmediate);

// ------------------------------------------------------------- sign-in page

function signinPage({ search = "", session = null, signIn = async () => ({ error: null }) } = {}) {
  const replaced = [];
  const calls = [];
  const listeners = { password: [], link: [] };
  const field = (value = "") => ({ value, setAttribute() {} });
  const button = () => ({ disabled: true });
  const passwordEmail = field("  Writer@Example.NET ");
  const password = field("correct horse battery");
  const passwordButton = button();
  const linkEmail = field("writer@example.net");
  const linkButton = button();
  const status = { password: { textContent: "", dataset: {} }, link: { textContent: "", dataset: {} } };
  const passwordForm = {
    reportValidity: () => true,
    addEventListener: (_, cb) => listeners.password.push(cb),
    querySelector: (selector) => ({ "button[type=submit]": passwordButton, "#password-email": passwordEmail, "#password": password })[selector] ?? null,
  };
  const linkForm = {
    reportValidity: () => true, reset() {},
    addEventListener: (_, cb) => listeners.link.push(cb),
    querySelector: (selector) => (selector === "button[type=submit]" ? linkButton : linkEmail),
  };
  const document = {
    querySelector: (selector) => ({
      "#signin-form": linkForm, "#password-form": passwordForm, "#setup-notice": { hidden: true },
      "#signin-status": status.link, "#password-status": status.password,
    })[selector] ?? null,
  };
  class FormData {
    constructor(form) { this.form = form; }
    get(name) {
      if (this.form === passwordForm) return name === "email" ? passwordEmail.value : password.value;
      return linkEmail.value;
    }
  }
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      signInWithPassword: async (args) => { calls.push(args); return signIn(args); },
      signInWithOtp: async (args) => { calls.push(args); return { error: null }; },
    },
  };
  const context = vm.createContext({
    document, FormData, client, Intl, URL, URLSearchParams, AbortSignal,
    location: { hostname: "wavread.com", origin: "https://wavread.com", search, replace: (path) => replaced.push(path) },
  });
  return {
    context, calls, replaced, password, passwordButton, status,
    async start() {
      const source = (await read("docs/js/beta-auth.js")).replace("initializeSignIn();\ninitializeDashboard();", "");
      vm.runInContext(`${source}\ncreateBetaClient = () => client; initializeSignIn();`, context);
      for (let i = 0; i < 4; i++) await tick();
    },
    async submitPassword() {
      for (const listener of listeners.password) await listener({ preventDefault() {} });
    },
    async submitLink() {
      for (const listener of listeners.link) await listener({ preventDefault() {} });
    },
  };
}

test("sign-in offers a password first and keeps the one-time link as the fallback", async () => {
  const html = await read("docs/signin.html");
  const passwordForm = html.match(/<form[^>]+id="password-form"[\s\S]*?<\/form>/)?.[0];
  const linkForm = html.match(/<form[^>]+id="signin-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(passwordForm && linkForm, "both forms are on the page");
  assert.ok(html.indexOf('id="password-form"') < html.indexOf('id="signin-form"'), "password first");
  assert.match(passwordForm, /method="post"/);
  assert.match(passwordForm, /type="password"[^>]*autocomplete="current-password"/);
  assert.match(passwordForm, /type="email"[^>]*autocomplete="username"/);
  assert.match(passwordForm, /type="submit" disabled/, "disabled until the script is ready");
  assert.match(passwordForm, /href="\/forgot-password\.html"/);
  assert.match(html, /Email me a sign-in link/);
  assert.match(html, /href="\/signup\.html"/);
  const auth = await read("docs/js/beta-auth.js");
  assert.match(auth, /signInWithOtp\(\{\s*email,\s*options: \{ shouldCreateUser: false/, "the link still never creates an account");
  assert.match(auth, /signInWithPassword\(\{ email, password \}\)/);
});

test("a password sign-in sends the normalized email, clears the field, and opens the dashboard", async () => {
  const page = signinPage();
  await page.start();
  assert.equal(page.passwordButton.disabled, false, "enabled once the client is ready");
  await page.submitPassword();
  // Made inside the vm, so compared as plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(page.calls)), [{ email: "writer@example.net", password: "correct horse battery" }]);
  assert.equal(page.password.value, "", "the password does not stay in the field");
  assert.deepEqual([...page.replaced], ["/dashboard"]);
  assert.equal(page.status.password.dataset.state, "success");
});

test("after sign-in, only the site's own account pages are honoured from ?next=", async () => {
  for (const [search, expected] of [
    ["?next=/account", "/account"],
    ["?next=/account/articles/new", "/account/articles/new"],
    ["?next=https://evil.example/", "/dashboard"],
    ["?next=//evil.example", "/dashboard"],
    ["?next=/dashboard%0d%0a", "/dashboard"],
    ["", "/dashboard"],
  ]) {
    const page = signinPage({ search });
    await page.start();
    await page.submitPassword();
    assert.deepEqual(page.replaced, [expected], search);
  }
  const signedIn = signinPage({ search: "?next=/account", session: { user: {} } });
  await signedIn.start();
  assert.deepEqual(signedIn.replaced, ["/account"], "already signed in goes straight there");
  assert.deepEqual([...NEXT_PATHS].sort(), ["/account", "/account/articles/new", "/dashboard"]);
});

test("a refused password says why without saying whether the email has an account", async () => {
  const cases = [
    [{ code: "invalid_credentials", message: "Invalid login credentials" }, /do not match.*email yourself a sign-in link/],
    [{ status: 429, code: "over_request_rate_limit" }, /Too many sign-in attempts/],
    [{ code: "email_not_confirmed" }, /Confirm your email first/],
    [{ message: "something else" }, /unavailable right now/],
  ];
  for (const [error, pattern] of cases) {
    const page = signinPage({ signIn: async () => ({ error }) });
    await page.start();
    await page.submitPassword();
    assert.match(page.status.password.textContent, pattern);
    assert.equal(page.status.password.dataset.state, "error");
    assert.equal(page.password.value, "");
    assert.deepEqual(page.replaced, []);
    assert.equal(page.passwordButton.disabled, false, "the form recovers");
  }
  const offline = signinPage({ signIn: async () => { throw new Error("offline"); } });
  await offline.start();
  await offline.submitPassword();
  assert.match(offline.status.password.textContent, /Could not reach sign-in/);
  assert.equal(offline.password.value, "");
});

test("the one-time link still works beside the password form", async () => {
  const page = signinPage({ search: "?next=/account" });
  await page.start();
  await page.submitLink();
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].options.shouldCreateUser, false);
  assert.equal(page.calls[0].options.emailRedirectTo, "https://wavread.com/account");
});

// ------------------------------------------------------------ other pages

test("buying never asks for a password; sign-up says so and is optional", async () => {
  const buy = await read("docs/buy.html");
  assert.doesNotMatch(buy, /type="password"/, "checkout takes an email only");
  const signup = await read("docs/signup.html");
  assert.match(signup, /You do not need an account or a password to buy WavRead/);
  const form = signup.match(/<form[^>]+id="signup-form"[\s\S]*?<\/form>/)[0];
  assert.match(form, /method="post"/);
  assert.match(form, /type="submit" disabled/);
  assert.equal((form.match(/autocomplete="new-password"/g) || []).length, 2, "password and confirmation");
  const pages = await read("docs/js/auth-pages.js");
  assert.match(pages, /signUp\(\{[\s\S]{0,200}emailRedirectTo: absolute\("\/account"\)/);
  assert.match(pages, /resetPasswordForEmail\([\s\S]{0,120}redirectTo: absolute\("\/reset-password"\)/);
  assert.match(pages, /updateUser\(\{ password: password\.value \}\)/);
  assert.match(pages, /signOut\(\{ scope: "others" \}\)/, "a reset signs out the other devices");
  for (const file of ["forgot-password", "reset-password"]) {
    const html = await read(`docs/${file}.html`);
    assert.match(html, /method="post"/);
    assert.match(html, /type="submit" disabled/);
  }
});

test("/account offers Set a password, and setting one changes nothing but the password", async () => {
  const html = await read("docs/account.html");
  const form = html.match(/<form[^>]+id="password-set-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.match(form, /Set a password/);
  assert.equal((form.match(/autocomplete="new-password"/g) || []).length, 2);
  assert.match(html, /href="\/account\/articles\/new\.html"[^>]*>Write an article/);
  assert.match(html, /id="standing-title"/);
  assert.match(html, /id="profile-form"/);
  const account = await read("docs/js/account.js");
  assert.match(account, /rpc\("account_password_status"\)/);
  for (const file of await readdir("docs/js")) {
    const source = await read(`docs/js/${file}`);
    for (const [call] of source.matchAll(/updateUser\([^)]*\)/g)) {
      assert.equal(call, "updateUser({ password: password.value })", `${file}: a password change passes the password and nothing else`);
    }
  }
  assert.match(account, /\.update\(profile\)\s*\.eq\("tester_id", account\.tester_id\)/, "a profile save names the holder's own row");
});

test("no account script logs anything, least of all a password", async () => {
  for (const file of ["beta-auth.js", "account-client.js", "auth-pages.js", "account.js", "article-editor.js", "public-profile.js"]) {
    const source = await read(`docs/js/${file}`);
    assert.doesNotMatch(source, /console\.[a-z]+\([^)]*password/i, `${file} logs a password`);
    if (file !== "beta-auth.js") assert.doesNotMatch(source, /console\./, `${file} logs nothing`);
    assert.doesNotMatch(source, /(localStorage|sessionStorage)\.setItem/, `${file} stores nothing itself`);
  }
  const navigation = await read("docs/js/navigation.js");
  assert.match(navigation, /localStorage\.getItem\('wavread-beta-session'\)/, "the header only looks for a session");
  assert.match(navigation, /link\.setAttribute\('href', '\/account\.html'\)/);
});

test("no test or sample credential is committed", async () => {
  const files = ["docs/signin.html", "docs/signup.html", "docs/account.html", "docs/reset-password.html",
    "docs/js/account-client.js", "docs/js/auth-pages.js", "docs/js/account.js", "docs/js/beta-auth.js"];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /value="[^"]{4,}"[^>]*type="password"|type="password"[^>]*value="[^"]+"/, `${file} prefills a password`);
    assert.doesNotMatch(source, /password\s*[:=]\s*["'][^"']{6,}["']/i, `${file} contains a password literal`);
  }
});

// ------------------------------------------------------------ the editor

test("the editor is a split Markdown view with a toolbar, checks, and no publish button", async () => {
  for (const file of ["docs/account/articles/new.html", "docs/account/articles/edit.html"]) {
    const html = await read(file);
    const inserts = [...html.matchAll(/data-insert="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(inserts, ["bold", "italic", "heading", "link", "list", "code"], `${file} toolbar`);
    assert.match(html, /<textarea id="article-body"/);
    assert.match(html, /id="article-preview"[^>]*aria-live="polite"/);
    for (const lane of ["developer", "ai", "musician"]) assert.match(html, new RegExp(`name="lanes" value="${lane}"`));
    assert.match(html, /id="article-title"/);
    assert.match(html, /id="article-summary"/);
    assert.match(html, />Save draft</);
    assert.match(html, />Submit for review</);
    assert.doesNotMatch(html, /<button[^>]*>[^<]*Publish/i, "a writer cannot publish");
    assert.match(html, /id="status-panel"/);
    assert.match(html, /id="reviewer-notes"/);
    assert.match(html, /src="\/js\/article-editor\.js" type="module"/);
  }
  const editor = await read("docs/js/article-editor.js");
  assert.equal(PREVIEW_DELAY_MS, 300);
  assert.match(editor, /setTimeout\(check, PREVIEW_DELAY_MS\)/, "the preview waits for a pause in typing");
  assert.match(editor, /"article-submission-save"/);
  assert.match(editor, /"article-submission-submit"/);
  assert.doesNotMatch(editor, /article-publish-approved|article-review|publish_approved_submission/, "nothing in the editor reaches review or publishing");
  for (const status of ["pending", "needs_changes", "approved", "rejected", "published"]) {
    assert.match(editor, new RegExp(`${status}: \\(`), `the status panel explains ${status}`);
  }
});

test("toolbar buttons insert the build's Markdown around the selection", () => {
  const at = (text, start, end, kind) => applyFormat(text, start, end, kind);
  assert.deepEqual(at("make this loud", 5, 9, "bold"), { value: "make **this** loud", start: 7, end: 11 });
  assert.deepEqual(at("make this loud", 5, 9, "italic"), { value: "make *this* loud", start: 6, end: 10 });
  assert.equal(at("", 0, 0, "bold").value, "**bold text**");
  assert.equal(at("First\nSecond line", 8, 8, "heading").value, "First\n## Second line");
  assert.equal(at("## Already", 3, 3, "heading").value, "## Already", "a heading is not doubled");
  const link = at("see the faq here", 8, 11, "link");
  assert.equal(link.value, "see the [faq](https://) here");
  assert.equal(link.value.slice(link.start, link.end), "https://", "the address is selected, ready to type over");
  assert.equal(at("one\ntwo", 0, 7, "list").value, "- one\n- two");
  assert.equal(at("- one\ntwo", 0, 9, "list").value, "- one\n- two", "a list item is not doubled");
  const code = at("Intro\nlet x = 1", 6, 15, "code");
  assert.equal(code.value, "Intro\n\n```\nlet x = 1\n```\n");
  assert.equal(code.value.slice(code.start, code.end), "let x = 1");
  assert.deepEqual(at("abc", 1, 2, "unknown"), { value: "abc", start: 1, end: 2 });
});

// ------------------------------------------------------------- helpers

test("passwords: long enough, confirmed, and kept under bcrypt's limit", () => {
  assert.equal(PASSWORD_MIN, 10);
  assert.match(passwordProblem("short", "short"), /at least 10/);
  assert.match(passwordProblem("x".repeat(73), "x".repeat(73)), /at most 72/);
  assert.match(passwordProblem("é".repeat(40), "é".repeat(40)), /at most 72/, "72 bytes, not 72 characters");
  assert.match(passwordProblem(" padded password ", " padded password "), /spaces/);
  assert.match(passwordProblem("long enough password", "long enough passwrod"), /do not match/);
  assert.equal(passwordProblem("long enough password", "long enough password"), null);
});

test("Auth errors read as sentences, with rate limits named", () => {
  assert.match(authErrorMessage({ status: 429 }), /Too many attempts/);
  assert.match(authErrorMessage({ code: "over_email_send_rate_limit" }), /Too many attempts/);
  assert.match(authErrorMessage({ code: "weak_password" }), /at least 10/);
  assert.match(authErrorMessage({ code: "signup_disabled" }), /not open yet.*checkout takes your email/);
  assert.match(authErrorMessage({ code: "same_password" }), /already your password/);
  assert.match(authErrorMessage({ code: "reauthentication_needed" }), /sign in again/);
  assert.match(authErrorMessage({ code: "otp_expired" }), /expired/);
  assert.equal(authErrorMessage({ code: "mystery" }, "fallback"), "fallback");
});

test("paths, next targets and profile addresses", () => {
  assert.equal(sitePath("/account", false), "/account");
  assert.equal(sitePath("/account", true), "/account.html");
  assert.equal(sitePath("/account/articles/edit?id=abc", true), "/account/articles/edit.html?id=abc");
  assert.equal(nextPath("/account"), "/account");
  assert.equal(nextPath("https://evil.example"), "/dashboard");
  assert.equal(profilePath("jane-doe", false), "/u/jane-doe");
  assert.equal(profilePath("jane-doe", true), "/u.html?slug=jane-doe");
  assert.equal(slugFromLocation({ pathname: "/u/Jane-Doe", search: "" }), "jane-doe");
  assert.equal(slugFromLocation({ pathname: "/u.html", search: "?slug=jane-doe" }), "jane-doe");
  assert.equal(slugFromLocation({ pathname: "/u", search: "?slug=<script>" }), null);
  assert.equal(slugFromLocation({ pathname: "/u", search: "" }), null);
});

test("profiles: empty means none, and the address follows the database's rules", () => {
  assert.deepEqual(profileFromForm({ display_name: "  Jane   Doe ", bio: "  ", public_slug: " Jane-Doe " }),
    { display_name: "Jane Doe", bio: null, public_slug: "jane-doe" });
  assert.deepEqual(profileProblems({ display_name: "Jane", bio: null, public_slug: "jane-doe" }), []);
  assert.match(profileProblems({ public_slug: "admin" }).join(), /reserved/);
  assert.match(profileProblems({ public_slug: "a" }).join(), /3 to 40/);
  assert.match(profileProblems({ public_slug: "no--double" }).join(), /3 to 40/);
  assert.match(profileProblems({ bio: "x".repeat(1001) }).join(), /1000/);
});

test("standing reads the same before and after the trial migration", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  assert.equal(standingSummary({ free_updates: true }, [], now).title, "Owned");
  assert.equal(standingSummary({}, [{ source: "purchase", build_version: null, revoked_at: null }], now).title, "Owned",
    "a row with no expires_at column at all");
  assert.equal(standingSummary({}, [{ source: "purchase", build_version: null, revoked_at: "2026-10-01T00:00:00Z" }], now).title, "Not owned yet",
    "a refunded purchase owns nothing");
  assert.equal(standingSummary({}, [{ source: "purchase", build_version: "1.5.4", revoked_at: null }], now).title, "1 build owned");
  const trial = { source: "trial", build_version: null, revoked_at: null, expires_at: "2026-11-05T12:00:00Z" };
  assert.equal(standingSummary({}, [trial], now).title, "Trial");
  assert.equal(standingSummary({}, [{ ...trial, expires_at: "2026-10-20T00:00:00Z" }], now).title, "Trial ended");
  assert.equal(standingSummary({}, [trial, { source: "purchase", build_version: null, revoked_at: null }], now).title, "Owned", "paid wins");
  const nothing = standingSummary(null, [], now);
  assert.equal(nothing.title, "Not owned yet");
  assert.equal(nothing.buy, true);
  assert.match(nothing.detail, /write for WavRead without owning it/);
});

// ------------------------------------------------- site rules, new pages

const NEW_PAGES = ["signup.html", "forgot-password.html", "reset-password.html", "account.html", "u.html",
  "account/articles/new.html", "account/articles/edit.html"];

test("the new pages follow the site's page rules, nested ones included", async () => {
  for (const file of NEW_PAGES) {
    const html = await read(join("docs", file));
    assert.match(html, /<main\b/, `${file}: main`);
    assert.match(html, /class="skip-link"/, `${file}: skip link`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${file}: one h1`);
    assert.match(html, /mailto:support@wavread\.com/, `${file}: support`);
    assert.match(html, /<meta name="robots" content="noindex">/, `${file}: noindex`);
    assert.match(html, /href="\/product\.css"/);
    assert.match(html, /href="\/pages\.css"/);
    assert.match(html, /href="\/account\.css"/);
    assert.match(html, /src="\/js\/navigation\.js"/);
    assert.match(html, /class="brand"[\s\S]{0,100}assets\/favicon\.png/);
    assert.match(html, /aria-label="Footer"/);
    assert.doesNotMatch(html, /\sstyle="|\sonclick=|\sonsubmit=|\sonload=|<script>(?!<\/script>)|<style/i, `${file}: nothing the CSP blocks`);
    for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
      assert.match(src, /^\/js\/[a-z-]+\.js$/, `${file}: scripts come from this origin: ${src}`);
    }
    for (const [, reference] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:|#|data:)/.test(reference)) continue;
      const path = reference.split(/[?#]/)[0];
      assert.ok(path.startsWith("/"), `${file}: root-relative, so it works from nested pages: ${reference}`);
      let target = resolve("docs", path === "/" ? "index.html" : path.slice(1));
      if (!extname(target)) target += ".html";
      await assert.doesNotReject(access(target), `${file}: missing ${reference}`);
    }
    assert.doesNotMatch(html, /(?<!no )(?<!nothing )free (?:beta|trial|download)\b/i);
  }
});

test("account pages stay out of search indexes, and profiles have an address", async () => {
  const robots = await read("docs/robots.txt");
  for (const path of ["/account", "/signup", "/forgot-password", "/reset-password", "/u/"]) {
    assert.ok(robots.includes(`Disallow: ${path}\n`), path);
  }
  const vercel = JSON.parse(await read("vercel.json"));
  assert.deepEqual(vercel.rewrites, [{ source: "/u/:slug", destination: "/u" }]);
  const profile = await read("docs/js/public-profile.js");
  assert.match(profile, /rpc\("public_profile", \{ profile_slug: slug \}\)/);
  assert.match(profile, /bio\.textContent = /, "a bio is text");
});

// ------------------------------------------------------- email templates

test("the auth emails are branded files with one button and a plain link", async () => {
  const dir = "email-templates";
  const linked = ["confirm-signup", "magic-link", "reset-password", "change-email"];
  for (const name of [...linked, "password-changed"]) {
    const html = await read(`${dir}/${name}.html`);
    assert.match(html, /<img src="https:\/\/wavread\.com\/apple-touch-icon\.png"/, `${name}: the published logo`);
    await assert.doesNotReject(access("docs/apple-touch-icon.png"), "the logo is a file the site serves");
    assert.equal((html.match(/class="wr-button"/g) || []).length, 1, `${name}: one primary button`);
    assert.match(html, /background:#142039/, `${name}: the site's ink for the button`);
    assert.match(html, /mailto:support@wavread\.com/);
    const variables = [...html.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(variables.every((v) => [".ConfirmationURL", ".Email", ".NewEmail"].includes(v)), `${name}: Supabase variables only (${variables})`);
    assert.doesNotMatch(html, /\{\{ \.Token/, "no one-time code the site has no field for");
    if (linked.includes(name)) {
      assert.equal((html.match(/\{\{ \.ConfirmationURL \}\}/g) || []).length, 2, `${name}: the button and the plain-text link`);
    }
  }
  const readme = await read(`${dir}/README.md`);
  assert.match(readme, /\*\*These\s+are files only\.\*\*/);
  assert.match(readme, /Custom SMTP comes first/);
  assert.match(readme, /Do not apply these with the Management API/);
  assert.match(readme, /change-email is a stub/);
});

test("community articles have a home, and it waits on PR #8", async () => {
  const readme = await read("content/articles/community/README.md");
  assert.match(readme, /PR #8/);
  assert.match(readme, /feat\/articles-cms-lite/);
  assert.match(readme, /author_slug/);
  assert.match(readme, /source: user/);
  assert.match(readme, /Approving does not publish/);
  const files = await readdir("content/articles/community");
  assert.deepEqual(files, ["README.md"], "no user content is committed");
});

// npm run check names its files one by one on one line, which PR #7 and PR #8
// both edit; checking the new files here keeps that line out of this branch.
test("every new script parses", async () => {
  const { spawnSync } = await import("node:child_process");
  const files = [
    ...["account-client", "auth-pages", "account", "article-editor", "markdown-preview", "public-profile", "article-rules"].map((f) => `docs/js/${f}.js`),
    "supabase/functions/_shared/submissions.mjs", "supabase/functions/_shared/reviewers.mjs",
    ...["article-submission-save", "article-submission-submit", "article-review", "article-publish-approved"].map((f) => `supabase/functions/${f}/handler.mjs`),
    "tools/review-submissions.mjs", "tools/export-publish-queue.mjs",
  ];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
