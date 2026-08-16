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
  assert.match(html, /Version 1\.4\.4/);
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

test("tester routes fail closed and never make users testers in the browser", async () => {
  const auth = await read("docs/js/beta-auth.js");
  const signin = await read("docs/signin.html");
  const dashboard = await read("docs/beta-dashboard.html");
  assert.match(auth, /shouldCreateUser:\s*false/);
  assert.match(auth, /auth\.getUser\(\)/);
  assert.match(auth, /from\("beta_testers"\)/);
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
  assert.match(sql, /tester_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /beta_testers\.status = 'active'/i);
  assert.match(sql, /revoke all on table public\.beta_feedback from anon, authenticated/i);
  assert.doesNotMatch(sql, /security definer/i);
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
