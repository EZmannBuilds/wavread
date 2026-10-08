import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  allowOriginFor, allowedOrigins, clientAddressFrom, keyedDigest, previewPatterns,
} from '../supabase/functions/_shared/callers.mjs';

// The production settings as they are deployed: the apex is canonical, and
// ALLOWED_ORIGINS names the www host and the vercel.app hostname.
const PRODUCTION = {
  siteUrl: 'https://wavread.com',
  allowedOrigins: 'https://www.wavread.com, https://wavread.vercel.app',
};
const WITH_PREVIEWS = { ...PRODUCTION, vercelTeam: 'lorehouse-team' };
const headers = (values) => new Headers(values);

test('the site and its configured names are allowed, nothing else', () => {
  for (const origin of ['https://wavread.com', 'https://www.wavread.com', 'https://wavread.vercel.app']) {
    assert.equal(allowOriginFor(origin, PRODUCTION), origin);
  }
  // A refusal answers with the site's own name, which a browser will not match.
  for (const origin of ['https://evil.example', 'https://wavread.com.evil.example', 'null', '']) {
    assert.equal(allowOriginFor(origin, PRODUCTION), 'https://wavread.com');
  }
});

test("a stranger's vercel.app project is not the site", () => {
  // The old rule accepted wavread-<anything>.vercel.app, a name anyone can register.
  for (const origin of ['https://wavread-attacker.vercel.app', 'https://wavread-x1y2z3-someoneelse.vercel.app']) {
    assert.equal(allowOriginFor(origin, PRODUCTION), 'https://wavread.com');
    assert.equal(allowOriginFor(origin, WITH_PREVIEWS), 'https://wavread.com');
  }
});

test('previews are off by default and team-scoped when turned on', () => {
  const hashed = 'https://wavread-a1b2c3d4e-lorehouse-team.vercel.app';
  const branch = 'https://wavread-git-codex-web-update-lorehouse-team.vercel.app';
  assert.deepEqual(previewPatterns(PRODUCTION), [], 'no VERCEL_TEAM, no previews');
  assert.equal(allowOriginFor(hashed, PRODUCTION), 'https://wavread.com');
  assert.equal(allowOriginFor(hashed, WITH_PREVIEWS), hashed);
  assert.equal(allowOriginFor(branch, WITH_PREVIEWS), branch);
  for (const origin of [
    'https://wavread-a1b2c3d4-lorehouse-team.vercel.app',             // eight characters is not Vercel's hash
    'https://wavread-a1b2c3d4e-otherteam.vercel.app',                 // someone else's team
    'https://wavread-a1b2c3d4e-lorehouse-team.vercel.app.evil.example',
    'http://wavread-a1b2c3d4e-lorehouse-team.vercel.app',
  ]) {
    assert.equal(allowOriginFor(origin, WITH_PREVIEWS), 'https://wavread.com', origin);
  }
  assert.deepEqual(previewPatterns({ ...PRODUCTION, vercelTeam: 'lorehouse.team|x' }), [], 'a malformed team is ignored');
});

test('the local preview counts only where ALLOW_LOCAL_ORIGINS says so', () => {
  for (const origin of ['http://127.0.0.1:4173', 'http://localhost:4173']) {
    assert.equal(allowOriginFor(origin, PRODUCTION), 'https://wavread.com');
    assert.equal(allowOriginFor(origin, { ...PRODUCTION, allowLocal: 'true' }), origin);
  }
  assert.ok(!allowedOrigins({ ...PRODUCTION, allowLocal: '1' }).includes('http://localhost:4173'), 'only the word true turns it on');
});

test('the address for a rate limit is the one the sender cannot write', () => {
  assert.equal(clientAddressFrom(headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })), '203.0.113.7');
  // Supabase appends what it saw after whatever the request carried.
  assert.equal(clientAddressFrom(headers({ 'x-forwarded-for': 'spoofed-by-sender, 203.0.113.9' })), '203.0.113.9');
  assert.equal(clientAddressFrom(headers({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientAddressFrom(headers({})), 'unknown');
  assert.equal(clientAddressFrom(headers({ 'cf-connecting-ip': 'x'.repeat(500) })).length, 64);
});

test('counters key on a keyed digest, never the address', async () => {
  const digest = await keyedDigest('server-only-test-key', 'crash-report:203.0.113.7');
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, await keyedDigest('server-only-test-key', 'crash-report:203.0.113.7'));
  assert.notEqual(digest, await keyedDigest('another-key', 'crash-report:203.0.113.7'));
  assert.notEqual(digest, await keyedDigest('server-only-test-key', 'crash-report:203.0.113.8'));
});

test('crash reports spend an address-limited slot before anything is stored', async () => {
  const crash = await readFile('supabase/functions/crash-report/index.ts', 'utf8');
  const shared = await readFile('supabase/functions/_shared/mod.ts', 'utf8');
  const slot = crash.indexOf('take_crash_report_slot');
  assert.ok(slot > 0, 'the slot is taken');
  assert.ok(slot < crash.indexOf('.from("crash_reports")\n    .insert('), 'before the insert');
  assert.match(crash, /keyedDigest\(`crash-report:\$\{clientAddress\(req\)\}`\)/, 'keyed on the address the platform saw');
  assert.match(crash, /slot\.data !== true\)[\s\S]{0,80}429/, 'a refused slot is a 429 the app already understands');
  assert.doesNotMatch(shared, /"http:\/\/(127\.0\.0\.1|localhost):4173"/, 'no local origin is hardcoded into production');
  assert.match(shared, /ALLOW_LOCAL_ORIGINS/);
  assert.match(shared, /VERCEL_TEAM/);
});

test('the crash counters hold digests only, server-side only', async () => {
  const sql = await readFile('supabase/migrations/20261007210000_crash_reports_are_limited_by_address.sql', 'utf8');
  assert.match(sql, /alter table public\.wavread_report_rate_limits enable row level security/i);
  assert.match(sql, /revoke all on table public\.wavread_report_rate_limits from public, anon, authenticated/i);
  assert.match(sql, /security invoker set search_path = ''/i);
  assert.match(sql, /revoke all on function public\.take_crash_report_slot\(text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.take_crash_report_slot\(text\) to service_role/i);
  assert.match(sql, /'\^\[a-f0-9\]\{64\}\$'/, 'only a 64-character digest is accepted as a key');
  assert.match(sql, /from_address > 30 then return false/, 'one address cannot fill the hour');
  assert.match(sql, /from_everyone <= 200/, 'and neither can many');
  assert.doesNotMatch(sql, /security definer/i);
});
