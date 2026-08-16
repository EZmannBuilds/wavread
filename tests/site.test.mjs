import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve("docs");
const htmlFiles = (await readdir(root)).filter((file) => extname(file) === ".html");
const read = (path) => readFile(resolve(path), "utf8");

test("public homepage tells the real beta story", async () => {
  const html = await read("docs/index.html");
  assert.match(html, /WavRead Beta/);
  assert.match(html, /Beta 1\.4\.4/);
  assert.match(html, /Your audio stays on your Mac/);
  assert.match(html, /workspace-overview\.png/);
  assert.match(html, /Free beta/);
  assert.doesNotMatch(html, /customer logos|trusted by|testimonials/i);
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
  const publicPages = ["index.html", "how-it-works.html", "capture.html", "documents.html", "requirements.html", "privacy.html", "faq.html"];
  const expectedLinks = [
    ["how-it-works.html", "How it works"],
    ["capture.html", "DAW capture"],
    ["documents.html", "Documents"],
    ["requirements.html", "Requirements"],
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
  assert.match(signin, /Only pre-registered beta testers/);
  assert.match(dashboard, /id="unauthorized-state"/);
  assert.match(dashboard, /autocomplete|noindex/);
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

test("release channels and production staging are explicit", async () => {
  const dashboard = await read("docs/beta-dashboard.html");
  const backend = await read("BETA_BACKEND.md");
  const deploy = await read("deploy.sh");
  assert.match(dashboard, /Public stable build/);
  assert.match(dashboard, /No private 1\.4\.7 app build is published/);
  assert.match(dashboard, /in-app updater checks public GitHub releases/);
  assert.match(backend, /must be marked as a \*\*prerelease\*\*/);
  assert.match(backend, /64-character SHA-256/);
  assert.match(deploy, /npm run check/);
  assert.match(deploy, /npm test/);
  assert.match(deploy, /npm run build/);
  assert.match(deploy, /cp -r dist-site\/\*/);
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
  const brandedPages = ["index.html", "how-it-works.html", "capture.html", "documents.html", "requirements.html", "privacy.html", "faq.html", "signin.html", "beta-dashboard.html", "EULA.html"];
  for (const file of brandedPages) {
    const html = await read(join("docs", file));
    assert.match(html, /class="brand-mark" src="img\/wavread-mark\.svg"/, `${file} needs the approved vector wordmark`);
  }
});
