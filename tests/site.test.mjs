import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve("docs");
const htmlFiles = (await readdir(root)).filter((file) => extname(file) === ".html");
const read = (path) => readFile(resolve(path), "utf8");

test("public homepage tells the real release story", async () => {
  const html = await read("docs/index.html");
  assert.match(html, /Beta 1\.4\.37/);
  assert.match(html, /Your audio stays on your Mac/);
  assert.match(html, /workspace-overview\.png/);
  assert.match(html, /\$5/, "the beta is paid and the page leads with the price");
  assert.match(html, /early-build\.html/);
  // A paid beta must not still advertise a free download of itself.
  assert.doesNotMatch(html, /free beta|download free/i);
  assert.doesNotMatch(html, /releases\/download\/v[\d.]+\/WavRead-[\d.]+\.dmg/, "no ungated DMG link");
  assert.doesNotMatch(html, /customer logos|trusted by|testimonials/i);
});

test("the purchase page sells $5 honestly and takes no card itself", async () => {
  const html = await read("docs/early-build.html");
  assert.match(html, /\$5/);
  assert.match(html, /paid beta/i);
  assert.match(html, /no subscription|never renews/i);
  assert.match(html, /Stripe/);
  assert.match(html, /notarised|notarized/i, "signing status is stated where people decide to buy");
  assert.match(html, /Refunds/);
  assert.match(html, /id="checkout-form"/);
  assert.match(html, /type="email"/);
  assert.doesNotMatch(html, /card.?number|cvc|expiry/i, "payment details belong to Stripe's page, not this one");
  assert.doesNotMatch(html, /licence for the eventual 1\.0 is included|guarantees 1\.0/i);
  const complete = await read("docs/purchase-complete.html");
  assert.match(complete, /noindex/);
  assert.match(complete, /signin\.html/);
});

test("every content page has a main landmark, one h1, and a skip link", async () => {
  for (const file of htmlFiles) {
    const html = await read(join("docs", file));
    assert.match(html, /<main\b/i, `${file} needs a main landmark`);
    assert.match(html, /class="skip-link"/i, `${file} needs a skip link`);
    assert.equal((html.match(/<h1\b/gi) || []).length, 1, `${file} needs exactly one h1`);
  }
});

test("all local links and assets resolve", async () => {
  for (const file of htmlFiles) {
    const html = await read(join("docs", file));
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
    for (const reference of references) {
      if (/^(?:https?:|mailto:|#|data:)/.test(reference)) continue;
      const withoutHash = reference.split("#")[0];
      if (!withoutHash) continue;
      const relative = withoutHash === "/" ? "index.html" : withoutHash.startsWith("/") ? withoutHash.slice(1) : join(dirname(file), withoutHash);
      let target = join(root, relative);
      if (!extname(target)) target += ".html";
      await assert.doesNotReject(access(target), `${file} has a missing reference: ${reference}`);
    }
  }
});

test("public pages share one destination-based primary navigation", async () => {
  const publicPages = ["index.html", "how-it-works.html", "capture.html", "documents.html", "requirements.html", "early-build.html", "privacy.html", "faq.html"];
  const expectedLinks = [
    ["how-it-works.html", "How it works"],
    ["capture.html", "DAW capture"],
    ["documents.html", "Documents"],
    ["requirements.html", "Requirements"],
    ["early-build.html", "Get WavRead"],
    ["privacy.html", "Privacy"],
    ["faq.html", "FAQ"]
  ];
  for (const file of publicPages) {
    const html = await read(join("docs", file));
    const nav = html.match(/<div class="nav-links" id="nav-links">([\s\S]*?)<\/div>/)?.[1] || "";
    const links = [...nav.matchAll(/<a href="([^"]+)"(?: aria-current="page")?>([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(links, expectedLinks, `${file} needs the complete primary navigation`);
    assert.doesNotMatch(nav, /href="#/, `${file} must not mix page sections into the primary navigation`);
  }
});

test("tester routes fail closed and never make users testers in the browser", async () => {
  const auth = await read("docs/js/beta-auth.js");
  const signin = await read("docs/signin.html");
  const dashboard = await read("docs/beta-dashboard.html");
  assert.match(auth, /shouldCreateUser:\s*false/);
  assert.match(auth, /auth\.getUser\(\)/);
  assert.match(auth, /from\("beta_testers"\)/);
  assert.match(auth, /\.eq\("auth_user_id", currentUser\.id\)/);
  assert.match(auth, /tester_id: currentTesterId/);
  assert.match(auth, /status !== "active"/);
  assert.doesNotMatch(auth, /service[_-]?role/i);
  assert.match(signin, /owners and pre-registered beta testers/i);
  assert.match(dashboard, /id="unauthorized-state"/);
  assert.match(dashboard, /autocomplete|noindex/);
});

test("ownership and reports reach the browser read-only", async () => {
  const auth = await read("docs/js/beta-auth.js");
  const dashboard = await read("docs/beta-dashboard.html");
  assert.match(auth, /from\("entitlements"\)/);
  assert.match(auth, /from\("purchases"\)/);
  assert.match(auth, /from\("builds"\)/);
  assert.match(auth, /from\("crash_reports"\)/);
  assert.doesNotMatch(auth, /\.from\("(purchases|entitlements|builds|crash_reports)"\)[\s\S]{0,120}?\.(insert|upsert|delete)\(/, "ownership tables are written only by Edge Functions");
  assert.match(auth, /from\("link_codes"\)[\s\S]{0,80}?\.insert\(\{ tester_id/, "a link code is requested for oneself; the server generates the code");
  assert.match(auth, /functions\/v1\/download-build/);
  assert.match(dashboard, /link-code-button/);
  assert.match(dashboard, /early-build\.html/);
  assert.doesNotMatch(dashboard, /releases\/download\/v[\d.]+\/WavRead-[\d.]+\.dmg/, "the dashboard serves builds through signed URLs, not public links");
});

test("no page still tells buyers to click past a security warning", async () => {
  for (const file of htmlFiles) {
    const html = await read(join("docs", file));
    assert.doesNotMatch(html, /Open Anyway/i, `${file} still describes the pre-1.4.37 unsigned launch`);
  }
});

test("no page offers an ungated build download", async () => {
  for (const file of htmlFiles) {
    const html = await read(join("docs", file));
    assert.doesNotMatch(html, /releases\/download\/v[\d.]+\/WavRead-[\d.]+\.dmg/, `${file} must not link a build directly`);
  }
});

test("browser-facing functions allow this project's previews, not the whole web", async () => {
  const shared = await read("supabase/functions/_shared/mod.ts");
  assert.match(shared, /previewPattern/);
  assert.match(shared, /SITE_URL/, "the allow-list is derived from the configured site, never hardcoded");
  assert.doesNotMatch(shared, /Access-Control-Allow-Origin":\s*"\*"/, "no wildcard origin");
  assert.doesNotMatch(shared, /\^https:\/\/\[a-z0-9-\]\+\\\.vercel\\\.app\$/, "any-project vercel.app must not be allowed");
  assert.match(shared, /"Vary": "Origin"/);
});

test("sign-in explains an unknown account instead of blaming an outage", async () => {
  const auth = await read("docs/js/beta-auth.js");
  assert.match(auth, /otp_disabled/);
  assert.match(auth, /no WavRead account for that email/i);
});

test("edge functions keep the money and token boundaries", async () => {
  const checkout = await read("supabase/functions/create-checkout/index.ts");
  const webhook = await read("supabase/functions/stripe-webhook/index.ts");
  const link = await read("supabase/functions/link-device/index.ts");
  const crash = await read("supabase/functions/crash-report/index.ts");
  const report = await read("supabase/functions/submit-report/index.ts");
  const download = await read("supabase/functions/download-build/index.ts");
  const shared = await read("supabase/functions/_shared/mod.ts");
  assert.match(checkout, /unit_amount\]", String\(AMOUNT_CENTS\)/);
  assert.match(checkout, /AMOUNT_CENTS = 500/);
  assert.match(checkout, /metadata\[product\]/);
  assert.match(webhook, /stripe-signature/);
  assert.match(webhook, /timingSafeEqual/);
  assert.match(webhook, /payment_status.*paid/);
  assert.match(webhook, /ignoreDuplicates/, "fulfillment is idempotent on the checkout session");
  assert.match(link, /token_hash: await sha256Hex\(token\)/, "only the token's hash is stored");
  assert.match(crash, /MAX_PER_INSTALL_PER_HOUR/);
  assert.match(crash, /validateCrash/);
  assert.match(report, /resolveDevice/);
  assert.match(download, /createSignedUrl/);
  assert.match(download, /early_build/);
  assert.match(shared, /token_hash/);
  for (const fn of [checkout, webhook, link, crash, report, download]) {
    assert.doesNotMatch(fn, /console\.log\([^)]*token/i, "tokens never reach function logs");
  }
});

test("shared links carry a canonical URL and a real social card", async () => {
  const publicPages = ["index.html", "how-it-works.html", "capture.html", "documents.html", "requirements.html", "early-build.html", "privacy.html", "faq.html"];
  for (const file of publicPages) {
    const html = await read(join("docs", file));
    const title = html.match(/<title>(.*?)<\/title>/s)[1].trim();
    const description = html.match(/<meta name="description" content="(.*?)">/s)[1];
    // The card repeats the page's own claims rather than inventing new ones.
    assert.match(html, /<link rel="canonical" href="https:\/\/wavread\.vercel\.app\/[^"]*">/, `${file} needs a canonical URL`);
    assert.ok(html.includes(`<meta property="og:title" content="${title}">`), `${file}: og:title must match its own title`);
    assert.ok(html.includes(`<meta property="og:description" content="${description}">`), `${file}: og:description must match its own description`);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, `${file} needs a large-image card`);
    const card = html.match(/<meta property="og:image" content="https:\/\/wavread\.vercel\.app\/([^"]+)">/);
    assert.ok(card, `${file} needs a social card image`);
    await assert.doesNotReject(access(join(root, card[1])), `${file} points at a missing card image: ${card[1]}`);
  }
});

test("an ad campaign label is a label, not a tracker", async () => {
  const shared = await read("supabase/functions/_shared/mod.ts");
  const checkout = await read("supabase/functions/create-checkout/index.ts");
  const page = await read("docs/js/early-build.js");
  const privacy = await read("docs/privacy.html");
  const vercel = await read("vercel.json");

  // The label reaches Stripe with the purchase and stops there.
  assert.match(checkout, /metadata\[source\]/);
  assert.match(checkout, /if \(source\) params\.set/, "an unrecognized label is dropped, never a failed purchase");
  assert.match(page, /campaignLabel/);
  assert.doesNotMatch(page, /document\.cookie|localStorage|sessionStorage/, "the label is read from the URL and sent once, never stored in the browser");

  // The channel comes from a list WavRead knows, and the pattern is anchored:
  // a label that merely contains "reels" is not a label WavRead accepts.
  const channels = JSON.parse(shared.match(/const CAMPAIGN_CHANNELS = (\[[\s\S]*?\]);/)[1]);
  const template = shared.match(/const CAMPAIGN_RE = new RegExp\(\s*`([^`]+)`/)[1];
  assert.ok(template.startsWith("^(") && template.endsWith("$"), "the campaign pattern is anchored at both ends");
  const pattern = new RegExp(template.replace('${CAMPAIGN_CHANNELS.join("|")}', channels.join("|")));
  for (const good of ["reels", "reels-a", "tiktok-hook2"]) {
    assert.ok(pattern.test(good), `${good} is a label WavRead buys`);
  }
  for (const bad of ["not-a-channel", "reels-a plus prose", "xreels", `reels-${"x".repeat(40)}`]) {
    assert.ok(!pattern.test(bad), `${bad} must never reach a payment record`);
  }

  // Disclosure ships in the same release as the behaviour, and the site still
  // loads no third-party script — a pixel cannot be slipped in quietly.
  assert.match(privacy, /campaign label/i);
  assert.match(privacy, /no analytics or advertising trackers/);
  assert.match(vercel, /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/, "no third-party script host");
});

test("database migration enables RLS and ownership checks", async () => {
  const migrations = await readdir("supabase/migrations");
  const sql = await read(join("supabase/migrations", migrations[0]));
  for (const table of ["beta_testers", "beta_known_issues", "beta_feedback"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(sql, /tester_id uuid primary key default gen_random_uuid\(\)/i);
  assert.match(sql, /auth_user_id uuid unique references auth\.users\(id\) on delete set null/i);
  assert.match(sql, /references public\.beta_testers\(tester_id\) on delete restrict/i);
  assert.match(sql, /beta_testers\.tester_id = beta_feedback\.tester_id/i);
  assert.doesNotMatch(sql, /references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /beta_testers\.status = 'active'/i);
  assert.match(sql, /revoke all on table public\.beta_feedback from anon, authenticated/i);
  assert.doesNotMatch(sql, /security definer/i);
});

test("the ownership migration keeps writes server-side and identity durable", async () => {
  const migrations = (await readdir("supabase/migrations")).sort();
  const sql = await read(join("supabase/migrations", migrations[1]));
  for (const table of ["purchases", "entitlements", "builds", "link_codes", "devices", "crash_reports"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`, "i"));
  }
  // The browser reads ownership; it never writes it.
  assert.doesNotMatch(sql, /grant[^;]*insert[^;]*on table public\.(purchases|entitlements|builds|crash_reports)[^;]*to authenticated/i);
  assert.doesNotMatch(sql, /grant[^;]*update[^;]*on table public\.(purchases|entitlements|builds|crash_reports|link_codes)[^;]*to authenticated/i);
  assert.match(sql, /grant update \(revoked_at\) on table public\.devices to authenticated/i, "revoking one's own device is the only browser write to devices");
  assert.match(sql, /with check \(revoked_at is not null\)/i, "a revoked device cannot be re-armed from the browser");
  assert.match(sql, /token_hash text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i, "only hashed tokens are storable");
  assert.match(sql, /stripe_checkout_session_id text not null unique/i, "fulfillment is idempotent at the database too");
  assert.match(sql, /references public\.beta_testers\(tester_id\) on delete restrict/i);
  assert.doesNotMatch(sql, /references auth\.users/i, "ownership hangs off the durable WavRead identity, not the auth binding");
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /insert into storage\.buckets \(id, name, public\)\s*values \('builds', 'builds', false\)/i, "the builds bucket is private");
  assert.match(sql, /expires_at := now\(\) \+ interval '15 minutes'/i);
});

test("release channels and production staging are explicit", async () => {
  const dashboard = await read("docs/beta-dashboard.html");
  const backend = await read("BETA_BACKEND.md");
  const deploy = await read("deploy.sh");
  assert.match(dashboard, /Current build/);
  assert.match(dashboard, /SHA-256/);
  assert.match(dashboard, /updater checks public release listings/);
  assert.match(backend, /must be marked as a \*\*prerelease\*\*/);
  assert.match(backend, /64-character SHA-256/);
  assert.match(deploy, /npm run check/);
  assert.match(deploy, /npm test/);
  assert.match(deploy, /npm run build/);
  assert.match(deploy, /cp -r dist-site\/\*/);
});

test("the privacy page discloses reports and purchases in full", async () => {
  const privacy = await read("docs/privacy.html");
  assert.match(privacy, /off by default/i);
  assert.match(privacy, /scrubbed/i);
  assert.match(privacy, /install ID/);
  assert.match(privacy, /Stripe/);
  assert.match(privacy, /never sees or stores card numbers/i);
  assert.match(privacy, /1\.4\.37/);
  const faq = await read("docs/faq.html");
  assert.match(faq, /crash report/i);
  assert.match(faq, /\$5/);
});

test("runtime configuration exposes only the publishable key", async () => {
  const api = await read("docs/api/beta-config.js");
  assert.match(api, /SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(api, /SERVICE_ROLE|SECRET_KEY/);
  assert.match(api, /no-store/i);
});

test("motion, focus, and content security have explicit safe defaults", async () => {
  const css = await read("docs/site.css");
  const vercel = await read("vercel.json");
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(vercel, /Content-Security-Policy/);
  assert.match(vercel, /frame-ancestors 'none'/);
  assert.doesNotMatch(vercel, /unsafe-inline|unsafe-eval/);
  for (const file of htmlFiles) {
    const html = await read(join("docs", file));
    assert.doesNotMatch(html, /\sstyle="|\sonclick=|\sonsubmit=|\sonload=/i, `${file} must not rely on CSP-blocked inline behavior`);
  }
});

test("A1 Clinical Signal tokens, type, and semantic roles stay canonical", async () => {
  const css = await read("docs/site.css");
  for (const [token, value] of [
    ["--wr-bg", "#0b0d10"],
    ["--wr-surface-1", "#12161b"],
    ["--wr-surface-2", "#1a2027"],
    ["--wr-text", "#f3f6f8"],
    ["--wr-muted", "#929ca7"],
    ["--wr-accent", "#4da8ff"],
    ["--wr-signal", "#53e0d4"],
    ["--wr-warning", "#ffb454"]
  ]) {
    assert.match(css, new RegExp(`${token}:\\s*${value}`, "i"), `${token} must keep its A1 value`);
  }
  assert.match(css, /font-family:\s*"Inter"/);
  assert.match(css, /font-family:\s*"Space Grotesk"/);
  assert.match(css, /\.btn\.primary\s*\{[^}]*background:\s*var\(--wr-accent\)/s);
  assert.doesNotMatch(css, /\.btn\.primary\s*\{[^}]*var\(--wr-warning\)/s);
  assert.doesNotMatch(css, /\.content-page\s+main::before/, "content headings must not have a decorative registration line");
  for (const asset of [
    "docs/fonts/inter-latin.woff2",
    "docs/fonts/space-grotesk-latin.woff2",
    "docs/fonts/INTER-LICENSE.txt",
    "docs/fonts/SPACE-GROTESK-LICENSE.txt"
  ]) {
    await assert.doesNotReject(access(asset), `${asset} must ship with the site`);
  }
});

test("the approved website mark is vector-only and used consistently", async () => {
  const mark = await read("docs/img/wavread-mark.svg");
  assert.match(mark, /<svg\b/);
  assert.doesNotMatch(mark, /<image\b|data:image/i);
  assert.match(mark, /@keyframes wave-acquire/);
  assert.match(mark, /@keyframes trace-acquire/);
  assert.match(mark, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(mark, /infinite/);
  const brandedPages = ["index.html", "how-it-works.html", "capture.html", "documents.html", "requirements.html", "early-build.html", "privacy.html", "faq.html", "signin.html", "beta-dashboard.html", "purchase-complete.html", "EULA.html"];
  for (const file of brandedPages) {
    const html = await read(join("docs", file));
    assert.match(html, /class="brand-mark" src="img\/wavread-mark\.svg"/, `${file} needs the approved vector wordmark`);
  }
});
