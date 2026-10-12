import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Vercel runs this file as CommonJS while the package is ESM, so it is loaded
// the way Vercel loads it rather than imported.
const source = await readFile(new URL("../docs/api/latest-build.js", import.meta.url), "utf8");
const module = { exports: {} };
new Function("module", "exports", source)(module, module.exports);
const handler = module.exports;

// Mac and Windows share one catalog: only a Windows question is passed on as
// one, and every other request asks plainly, which the catalog answers for Mac.
async function forwarded(path) {
  const seen = [];
  const realFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  globalThis.fetch = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => "{}" }; };
  const response = { setHeader() {}, status() { return this; }, send() { return this; }, json() { return this; } };
  try {
    await handler({ method: "GET", url: path }, response);
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen[0];
}

test("the update proxy passes only a Windows platform question on", async () => {
  const base = "https://example.supabase.co/functions/v1/latest-build";
  assert.equal(await forwarded("/api/latest-build"), base);
  assert.equal(await forwarded("/api/latest-build?platform=windows"), `${base}?platform=windows`);
  assert.equal(await forwarded("/api/latest-build?platform=macos"), base);
  assert.equal(await forwarded("/api/latest-build?platform=evil%26x%3D1"), base);
});

test("the catalog answers each platform with its own builds, the Mac by default", async () => {
  const fn = await readFile(new URL("../supabase/functions/latest-build/index.ts", import.meta.url), "utf8");
  // Every Mac build ever shipped asks with no platform, so anything but an
  // explicit Windows question must be answered for the Mac.
  assert.match(fn, /searchParams\.get\("platform"\) === "windows"\s*\?\s*"windows"\s*:\s*"macos"/);
  assert.match(fn, /\.eq\("published", true\)\s*\.eq\("platform", platform\)/);
  const migration = await readFile(new URL("../supabase/migrations/20261012190000_builds_have_a_platform.sql", import.meta.url), "utf8");
  assert.match(migration, /platform text not null default 'macos'/);
  assert.match(migration, /unique \(version, channel, platform\)/);
});
