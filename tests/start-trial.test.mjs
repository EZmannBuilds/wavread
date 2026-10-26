// start-trial, run as deployed: index.ts and _shared/mod.ts under the edge
// runtime stand-in (tests/support/edge-runtime.mjs), the real handler.mjs, and
// an in-memory service client. start_trial and take_trial_slot are mirrors of
// their SQL here; tests/trial-db.test.mjs runs the SQL itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleStartTrial } from '../supabase/functions/start-trial/handler.mjs';
import { loadEdgeFunction, supported } from './support/edge-runtime.mjs';
import { DAY_MS, daysFromNow, fakeDatabase } from './support/fake-db.mjs';

const ENV = { SITE_URL: 'https://wavread.com', SUPABASE_SERVICE_ROLE_KEY: 'test-only-secret' };
const edge = (name, body) => test(name, { skip: supported ? false : 'this node cannot strip TypeScript (needs 22.13+)' }, body);

// The SQL's rules, in miniature: one trial per account ever, never for an
// account that owns WavRead, and only once a sign-in identity exists.
function startTrialMirror(db) {
  return ({ trial_email: email }, tables) => {
    if (!db.authUsers.some((u) => u.email === email)) return { error: { code: '22023' } };
    let account = tables.accounts.find((a) => a.email === email);
    if (account) {
      if (account.status !== 'active') return { status: 'account_inactive', email };
      const live = (e) => !e.revoked_at && (!e.expires_at || Date.parse(e.expires_at) > Date.now());
      const mine = tables.entitlements.filter((e) => e.tester_id === account.tester_id);
      if (account.free_updates || mine.some((e) => e.source !== 'trial' && live(e))) return { status: 'already_owned', email };
      const previous = mine.find((e) => e.source === 'trial');
      if (previous) return { status: 'trial_used', email, trial_active: live(previous), expires_at: previous.expires_at };
    } else {
      account = { tester_id: `tester-${tables.accounts.length + 1}`, email, status: 'active', free_updates: false };
      tables.accounts.push(account);
    }
    const granted = new Date();
    const row = { id: tables.entitlements.length + 1, tester_id: account.tester_id, entitlement: 'early_build', source: 'trial',
      build_version: null, purchase_id: null, revoked_at: null,
      granted_at: granted.toISOString(), expires_at: new Date(granted.getTime() + 14 * DAY_MS).toISOString() };
    tables.entitlements.push(row);
    return { status: 'started', email, granted_at: row.granted_at, expires_at: row.expires_at };
  };
}

function harness({ seed = {}, slot = () => true } = {}) {
  let db;
  const rpcs = { take_trial_slot: (args) => slot(args), start_trial: (args, tables) => startTrialMirror(db)(args, tables) };
  db = fakeDatabase(seed, { rpcs });
  const { handler } = loadEdgeFunction('supabase/functions/start-trial/index.ts', { db, env: ENV, imports: { handleStartTrial } });
  const send = async (body, { method = 'POST', address = '203.0.113.7' } = {}) => {
    const response = await handler(new Request('https://project.supabase.co/functions/v1/start-trial', {
      method,
      headers: { 'Content-Type': 'application/json', Origin: 'https://wavread.com', 'cf-connecting-ip': address },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }));
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  return { db, send, rpcCalls: () => db.calls.filter((c) => c.rpc).map((c) => c.rpc) };
}

edge('a new email gets a 14-day trial, a sign-in identity, and nothing that looks like a sale', async () => {
  const { db, send, rpcCalls } = harness();
  const before = Date.now();
  const { status, body, headers } = await send({ email: '  New.Person@Example.COM ' });
  assert.equal(status, 200);
  assert.equal(body.trial, true);
  assert.equal(body.email, 'new.person@example.com', 'the email is normalized before anything is created');
  assert.equal(body.signin_url, 'https://wavread.com/signin');
  assert.equal(body.email_sent, false);
  const expires = Date.parse(body.expires_at);
  assert.ok(Math.abs(expires - (before + 14 * DAY_MS)) < 60_000, 'expires_at is 14 days out');
  assert.equal(headers.get('Access-Control-Allow-Origin'), 'https://wavread.com');

  assert.deepEqual(rpcCalls(), ['take_trial_slot', 'start_trial'], 'rate-limited first, then the trial — and no affiliate lookup');
  assert.deepEqual(db.authUsers.map((u) => u.email), ['new.person@example.com'], 'a sign-in identity exists for the address');
  assert.equal(db.tables.purchases.length, 0, 'no purchases row');
  const [row] = db.tables.entitlements;
  assert.deepEqual([row.source, row.entitlement, row.build_version, row.purchase_id], ['trial', 'early_build', null, null],
    'the entitlement download-build already honours, unscoped, marked as a trial');

  const slot = db.calls.find((c) => c.rpc === 'take_trial_slot').args;
  for (const digest of Object.values(slot)) {
    assert.match(digest, /^[0-9a-f]{64}$/, 'the limit is keyed by digests');
  }
  assert.doesNotMatch(JSON.stringify(slot), /example|203\.0\.113/, 'neither the email nor the address is sent to the database');
});

edge('a second trial is refused, while the first runs and after it has expired', async () => {
  const { db, send } = harness();
  assert.equal((await send({ email: 'twice@example.net' })).status, 200);

  let again = await send({ email: 'twice@example.net' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'trial_used');
  assert.equal(again.body.trial_active, true);
  assert.match(again.body.error, /already running\. Sign in/);
  assert.equal(again.body.signin_url, 'https://wavread.com/signin');

  const [row] = db.tables.entitlements;
  row.granted_at = daysFromNow(-15);
  row.expires_at = daysFromNow(-1);
  again = await send({ email: 'twice@example.net' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'trial_used');
  assert.equal(again.body.trial_active, false);
  assert.match(again.body.error, /already used its free trial\. Buy WavRead/);
  assert.equal(again.body.buy_url, 'https://wavread.com/buy');
  assert.equal(db.tables.entitlements.length, 1, 'no second trial row');
});

edge('someone who already owns WavRead is told to sign in, not given a trial', async () => {
  const seed = {
    accounts: [{ tester_id: 'paid', email: 'paid@example.net' }, { tester_id: 'granted', email: 'granted@example.net' },
      { tester_id: 'contributor', email: 'contributor@example.net', free_updates: true }],
    entitlements: [{ tester_id: 'paid', entitlement: 'early_build', source: 'purchase', purchase_id: 1 },
      { tester_id: 'granted', entitlement: 'early_build', source: 'grant' }],
  };
  const { db, send } = harness({ seed });
  db.authUsers.push({ id: 'u-paid', email: 'paid@example.net' });
  for (const email of ['paid@example.net', 'granted@example.net', 'contributor@example.net']) {
    const { status, body } = await send({ email });
    assert.equal(status, 409, email);
    assert.equal(body.code, 'already_owned');
    assert.match(body.error, /already owns WavRead\. Sign in/);
  }
  assert.equal(db.tables.entitlements.filter((e) => e.source === 'trial').length, 0);
});

edge('a paused account is refused in plain words', async () => {
  const { send } = harness({ seed: { accounts: [{ tester_id: 'p', email: 'paused@example.net', status: 'paused' }] } });
  const { status, body } = await send({ email: 'paused@example.net' });
  assert.equal(status, 409);
  assert.equal(body.code, 'account_unavailable');
  assert.match(body.error, /support@wavread\.com/);
});

edge('a bad email is refused before anything is counted or created', async () => {
  const { db, send, rpcCalls } = harness();
  for (const email of ['not-an-email', '', 'a@b', `${'x'.repeat(250)}@example.net`, 42, null]) {
    const { status, body } = await send({ email });
    assert.equal(status, 400, String(email));
    assert.equal(body.code, 'invalid_email');
    assert.equal(body.error, 'Enter a valid email address.');
  }
  assert.equal((await send(null)).status, 400, 'no body at all');
  assert.deepEqual(rpcCalls(), []);
  assert.equal(db.authUsers.length, 0);
});

edge('over the rate limit, nothing is created', async () => {
  const { db, send, rpcCalls } = harness({ slot: () => false });
  const { status, body } = await send({ email: 'flood@example.net' });
  assert.equal(status, 429);
  assert.equal(body.code, 'rate_limited');
  assert.deepEqual(rpcCalls(), ['take_trial_slot']);
  assert.equal(db.authUsers.length, 0);
});

edge('failures say nothing was created and leak nothing', async () => {
  const cases = [
    ['the rate limit is down', (h) => { h.db.rpc = async () => ({ data: null, error: { code: 'PGRST301', message: 'internal detail' } }); }],
    ['Auth refuses the identity', (h) => { h.db.auth.admin.createUser = async () => ({ error: { code: 'unexpected_failure', message: 'internal detail' } }); }],
    ['start_trial fails', (h) => { const rpc = h.db.rpc; h.db.rpc = async (name, args) => (name === 'start_trial' ? { data: null, error: { code: 'XX000', message: 'internal detail' } } : rpc(name, args)); }],
    ['start_trial answers something unknown', (h) => { const rpc = h.db.rpc; h.db.rpc = async (name, args) => (name === 'start_trial' ? { data: { status: 'surprise' }, error: null } : rpc(name, args)); }],
    ['the client throws', (h) => { h.db.rpc = async () => { throw new Error('connection reset'); }; }],
  ];
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const [name, breakIt] of cases) {
      const h = harness();
      breakIt(h);
      const { status, body } = await h.send({ email: 'unlucky@example.net' });
      assert.equal(status, 503, name);
      assert.match(body.error, /Nothing was created/, name);
      assert.doesNotMatch(JSON.stringify(body), /internal detail|PGRST|XX000/, `${name}: no internals reach the buyer`);
      assert.equal(h.db.tables.entitlements.length, 0, name);
    }
  } finally {
    console.error = quiet;
  }
});

edge('an address that already has a sign-in identity still starts its trial', async () => {
  const { db, send } = harness();
  db.authUsers.push({ id: 'u-existing', email: 'returning@example.net' });
  const { status } = await send({ email: 'returning@example.net' });
  assert.equal(status, 200);
  assert.equal(db.authUsers.length, 1, 'the existing identity is the one used');
});

edge('POST only, and the browser preflight is answered', async () => {
  const { send } = harness();
  assert.equal((await send(null, { method: 'GET' })).status, 405);
  const preflight = await send(null, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://wavread.com');
});

test('the handler creates the identity without a confirmation, after the limit and before the trial', async () => {
  const calls = [];
  const deps = {
    json: (_, status, body) => ({ status, body }),
    readJson: async (r) => r.json(),
    normalizeEmail: (e) => (typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? e.trim().toLowerCase() : null),
    clientAddress: () => '198.51.100.4',
    keyedDigest: async (text) => `${'0'.repeat(63)}${text.length % 10}`,
    admin: {
      rpc: async (name, args) => {
        calls.push([name, args]);
        return name === 'take_trial_slot' ? { data: true } : { data: { status: 'started', email: args.trial_email, expires_at: daysFromNow(14) } };
      },
      auth: { admin: { createUser: async (args) => { calls.push(['createUser', args]); return { data: { user: { id: 'u' } }, error: null }; } } },
    },
  };
  const result = await handleStartTrial(new Request('https://example.test', { method: 'POST', body: JSON.stringify({ email: 'Order@Example.net' }) }), deps);
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map((c) => c[0]), ['take_trial_slot', 'createUser', 'start_trial']);
  assert.deepEqual(calls[1][1], { email: 'order@example.net', email_confirm: false }, 'the address is proven by signing in, as for an owner grant');
  assert.deepEqual(calls[2][1], { trial_email: 'order@example.net' });
});

test('start-trial is public like checkout, and never touches money', () => {
  const config = readFileSync('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.start-trial\]\nverify_jwt = false/);
  for (const file of ['supabase/functions/start-trial/handler.mjs', 'supabase/functions/start-trial/index.ts']) {
    const source = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /stripe|purchases|affiliate|commission/i, `${file} has no sale in it`);
  }
});
