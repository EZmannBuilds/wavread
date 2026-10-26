// What a trial changes in the functions that already existed — download-build,
// stripe-webhook's fulfill() and refund(), and link-device — run as deployed:
// each index.ts under the edge runtime stand-in (tests/support/edge-runtime.mjs)
// against an in-memory service client holding the migrations' unique indexes
// and checks (tests/support/fake-db.mjs). The SQL those RPCs mirror is run for
// real in tests/trial-db.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessRefusal } from '../supabase/functions/download-build/refusal.mjs';
import { TRIAL_DEVICE_LIMIT, trialDeviceRefusal } from '../supabase/functions/link-device/trial-cap.mjs';
import { purchaseAttribution } from '../supabase/functions/stripe-webhook/attribution.mjs';
import { loadEdgeFunction, supported } from './support/edge-runtime.mjs';
import { daysFromNow, fakeDatabase } from './support/fake-db.mjs';

const ENV = { SITE_URL: 'https://wavread.com', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' };
const edge = (name, body) => test(name, { skip: supported ? false : 'this node cannot strip TypeScript (needs 22.13+)' }, body);

const MAC = { id: 15, version: '1.5.6', platform: 'macos', channel: 'early', published: true, file_name: 'WavRead-1.5.6.dmg',
  storage_path: '1.5.6/WavRead-1.5.6.dmg', sha256: 'b'.repeat(64), size_bytes: 1 };
const WINDOWS = { ...MAC, id: 16, platform: 'windows', file_name: 'WavRead-1.5.6-Setup.exe', storage_path: '1.5.6/WavRead-1.5.6-Setup.exe' };
const EMAIL = 'trial@example.net';
const TESTER = '7e57e700-0000-4000-8000-000000000001';

const runningTrial = (extra = {}) => ({ tester_id: TESTER, entitlement: 'early_build', source: 'trial',
  granted_at: daysFromNow(-3), expires_at: daysFromNow(11), ...extra });
const expiredTrial = () => runningTrial({ granted_at: daysFromNow(-15), expires_at: daysFromNow(-1) });

function world({ entitlements = [], devices = [], account = {} } = {}) {
  return fakeDatabase({
    accounts: [{ tester_id: TESTER, email: EMAIL, auth_user_id: 'user-1', ...account }],
    builds: [MAC, WINDOWS],
    entitlements,
    devices,
    link_codes: [{ code: 'ABCD2345', tester_id: TESTER, expires_at: daysFromNow(0.01), claimed_at: null }],
  });
}

// --- download-build ---------------------------------------------------------

function downloads(db) {
  const createClient = (_url, _key, options) => ({
    auth: {
      getUser: async () => (options.global.headers.Authorization === 'Bearer user-1'
        ? { data: { user: { id: 'user-1' } }, error: null }
        : { data: { user: null }, error: { message: 'bad jwt' } }),
    },
  });
  const { handler } = loadEdgeFunction('supabase/functions/download-build/index.ts', {
    db, env: ENV, createClient, imports: { accessRefusal },
  });
  return async (buildId) => {
    const response = await handler(new Request('https://project.supabase.co/functions/v1/download-build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-1', Origin: 'https://wavread.com' },
      body: JSON.stringify({ build_id: buildId }),
    }));
    return { status: response.status, body: await response.json() };
  };
}

edge('a running trial downloads the Mac and the Windows build', async () => {
  const download = downloads(world({ entitlements: [runningTrial()] }));
  for (const build of [MAC, WINDOWS]) {
    const { status, body } = await download(build.id);
    assert.equal(status, 200, build.platform);
    assert.equal(body.file_name, build.file_name);
    assert.match(body.url, new RegExp(build.storage_path.replace(/\./g, '\\.')));
  }
});

edge('an expired trial downloads nothing, and says the trial ended and where to buy', async () => {
  const download = downloads(world({ entitlements: [expiredTrial()] }));
  for (const build of [MAC, WINDOWS]) {
    const { status, body } = await download(build.id);
    assert.equal(status, 403, build.platform);
    assert.equal(body.trial_expired, true);
    assert.equal(body.code, 'trial_expired');
    assert.equal(body.error, 'Your 14-day trial has ended. Buy WavRead to keep downloading it.');
    assert.equal(body.buy_url, 'https://wavread.com/buy');
    assert.equal(body.purchasable, true);
    assert.equal(body.build_id, build.id);
    assert.equal(body.url, undefined, 'no signed URL');
  }
});

edge('a revoked trial is refused the same way as an expired one', async () => {
  const download = downloads(world({ entitlements: [runningTrial({ revoked_at: daysFromNow(-1) })] }));
  const { status, body } = await download(MAC.id);
  assert.equal(status, 403);
  assert.equal(body.trial_expired, true);
});

edge('an account that never had a trial keeps the refusal it always got', async () => {
  const download = downloads(world());
  const { status, body } = await download(MAC.id);
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'This build has not been purchased on this account.', purchasable: true, build_id: MAC.id });
});

edge('when the standing cannot be read, the refusal is the plain one and the decision is unchanged', async () => {
  const db = world({ entitlements: [expiredTrial()] });
  const rpc = db.rpc;
  db.rpc = (name, args) => (name === 'account_standing' ? { data: null, error: { code: 'XX000' } } : rpc(name, args));
  const quiet = console.error;
  console.error = () => {};
  try {
    const { status, body } = await downloads(db)(MAC.id);
    assert.equal(status, 403);
    assert.equal(body.trial_expired, undefined);
  } finally {
    console.error = quiet;
  }
});

test('accessRefusal flags an ended trial only for an account that owns nothing', () => {
  assert.equal(accessRefusal({ trial: 'ended', owned: false }, 15).trial_expired, true);
  for (const standing of [null, undefined, { trial: null, owned: false }, { trial: 'active', owned: false }, { trial: 'ended', owned: true }]) {
    assert.equal(accessRefusal(standing, 15).trial_expired, undefined, JSON.stringify(standing));
  }
});

// --- stripe-webhook ---------------------------------------------------------

function webhook(db) {
  const { context } = loadEdgeFunction('supabase/functions/stripe-webhook/index.ts', {
    db, env: { ...ENV, STRIPE_WEBHOOK_SECRET: 'whsec_test' }, imports: { purchaseAttribution },
  });
  return { fulfill: (session) => context.fulfill(db, session), refund: (charge) => context.refund(db, charge) };
}

const paidSession = (extra = {}) => ({
  id: 'cs_test_trial_converts', mode: 'payment', payment_status: 'paid', amount_total: 5000, currency: 'usd',
  payment_intent: 'pi_test_trial_converts', customer_details: { email: EMAIL },
  metadata: { product: 'early_build', bought_at_version: '1.5.6' }, ...extra,
});

const rows = (db, source) => db.tables.entitlements.filter((e) => e.source === source);

edge('fulfill() grants the purchase and ends the trial — paid wins', async () => {
  const db = world({ entitlements: [runningTrial()] });
  const { fulfill } = webhook(db);
  assert.match(await fulfill(paidSession()), /^fulfilled cs_test_trial_converts/);

  const [purchase] = db.tables.purchases;
  assert.equal(purchase.status, 'paid');
  assert.equal(purchase.amount_cents, 5000);
  const [granted] = rows(db, 'purchase');
  assert.deepEqual([granted.revoked_at, granted.expires_at, granted.build_version, granted.purchase_id],
    [null, null, null, purchase.id], 'a permanent, unscoped purchase entitlement');
  const [trial] = rows(db, 'trial');
  assert.ok(trial.revoked_at, 'the trial is revoked');
  assert.equal(db.tables.entitlements.length, 2, 'revoked, not deleted');

  const download = downloads(db);
  assert.equal((await download(MAC.id)).status, 200, 'and the buyer downloads');
  assert.equal((await download(WINDOWS.id)).status, 200);
});

edge('a retried delivery changes nothing', async () => {
  const db = world({ entitlements: [runningTrial()] });
  const { fulfill } = webhook(db);
  await fulfill(paidSession());
  const endedAt = rows(db, 'trial')[0].revoked_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fulfill(paidSession());
  assert.equal(db.tables.purchases.length, 1);
  assert.equal(rows(db, 'purchase').length, 1);
  assert.equal(rows(db, 'trial')[0].revoked_at, endedAt, 'the trial ended once');
});

edge('a trial that ran out without being revoked does not block the purchase', async () => {
  const db = world({ entitlements: [expiredTrial()] });
  await webhook(db).fulfill(paidSession());
  assert.equal(rows(db, 'purchase').length, 1);
  assert.ok(rows(db, 'trial')[0].revoked_at);
  assert.equal((await downloads(db)(MAC.id)).status, 200);
});

edge('a buyer with no trial is fulfilled exactly as before', async () => {
  const db = world();
  await webhook(db).fulfill(paidSession());
  assert.equal(db.tables.entitlements.length, 1);
  assert.deepEqual(rows(db, 'purchase').map((e) => [e.revoked_at, e.expires_at]), [[null, null]]);
});

edge('a new buyer gets an account, a sign-in identity and the entitlement', async () => {
  const db = fakeDatabase({ builds: [MAC] });
  await webhook(db).fulfill(paidSession({ customer_details: { email: 'Fresh@Example.net' } }));
  const [account] = db.tables.accounts;
  assert.equal(account.email, 'fresh@example.net');
  assert.equal(account.auth_user_id, db.authUsers[0].id);
  assert.equal(rows(db, 'purchase')[0].tester_id, account.tester_id);
});

edge('an unpaid or no-payment-required session grants nothing and leaves the trial alone', async () => {
  for (const payment_status of ['unpaid', 'no_payment_required']) {
    const db = world({ entitlements: [runningTrial()] });
    assert.equal(await webhook(db).fulfill(paidSession({ payment_status })), 'ignored: not paid');
    assert.equal(db.tables.purchases.length, 0, payment_status);
    assert.equal(rows(db, 'purchase').length, 0);
    assert.equal(rows(db, 'trial')[0].revoked_at, null, 'the trial keeps running');
  }
});

edge('a refund revokes the purchase and does not bring the trial back', async () => {
  const db = world({ entitlements: [runningTrial()] });
  const { fulfill, refund } = webhook(db);
  await fulfill(paidSession());
  assert.match(await refund({ payment_intent: 'pi_test_trial_converts' }), /^refunded purchase/);
  assert.equal(db.tables.purchases[0].status, 'refunded');
  assert.ok(db.tables.purchases[0].refunded_at);
  assert.ok(rows(db, 'purchase')[0].revoked_at, 'the paid entitlement is revoked');
  assert.ok(rows(db, 'trial')[0].revoked_at, 'the trial stays ended');
  const { status, body } = await downloads(db)(MAC.id);
  assert.equal(status, 403);
  assert.equal(body.trial_expired, true, 'and the refusal says the trial is over');
});

test('fulfill() ends trials only after the purchase entitlement exists, and refund() only touches purchases', () => {
  const source = readFileSync('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const fulfill = source.slice(source.indexOf('async function fulfill'), source.indexOf('async function refund'));
  const refund = source.slice(source.indexOf('async function refund'), source.indexOf('Deno.serve'));
  assert.ok(fulfill.indexOf('.eq("source", "trial")') > fulfill.indexOf('.from("entitlements").insert('),
    'the trial ends after the purchase entitlement is written, so access never lapses');
  assert.match(fulfill, /\.neq\("source", "trial"\)/, 'a trial is not mistaken for an existing purchase');
  assert.doesNotMatch(fulfill, /expires_at/, 'a purchase entitlement is never given an end date');
  assert.match(refund, /\.eq\("source", "purchase"\)/);
  assert.doesNotMatch(refund, /trial/);
});

// --- link-device ------------------------------------------------------------

const INSTALLS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const linkedDevice = (install, n) => ({ tester_id: TESTER, install_id: install, token_hash: String(n).repeat(64) });

function linker(db) {
  const { handler } = loadEdgeFunction('supabase/functions/link-device/index.ts', { db, env: ENV, imports: { trialDeviceRefusal } });
  return async (install) => {
    const response = await handler(new Request('https://project.supabase.co/functions/v1/link-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim', code: 'abcd-2345', install_id: install, label: 'Studio Mac' }),
    }));
    return { status: response.status, body: await response.json() };
  };
}

edge('a trial links a second device, and is refused a third', async () => {
  const db = world({ entitlements: [runningTrial()], devices: [linkedDevice(INSTALLS[0], 1)] });
  const second = await linker(db)(INSTALLS[1]);
  assert.equal(second.status, 200);
  assert.ok(second.body.token);
  assert.equal(db.tables.devices.length, 2);

  db.tables.link_codes.push({ code: 'ABCD2345', tester_id: TESTER, expires_at: daysFromNow(0.01), claimed_at: null });
  db.tables.link_codes.shift();
  const third = await linker(db)(INSTALLS[2]);
  assert.equal(third.status, 409);
  assert.equal(third.body.code, 'trial_device_limit');
  assert.equal(third.body.device_limit, 2);
  assert.match(third.body.error, /A trial can link 2 devices.*Revoke one on your dashboard.*buy WavRead/);
  assert.equal(db.tables.devices.length, 2, 'no device was added');
  assert.equal(db.tables.link_codes[0].claimed_at, null, 'and the code is not used up');
});

edge('at the cap, revoking a device makes room again', async () => {
  const db = world({ entitlements: [runningTrial()], devices: [linkedDevice(INSTALLS[0], 1), linkedDevice(INSTALLS[1], 2)] });
  assert.equal((await linker(db)(INSTALLS[2])).status, 409);
  db.tables.devices[0].revoked_at = new Date().toISOString();
  assert.equal((await linker(db)(INSTALLS[2])).status, 200, 'the same code works once there is room');
});

edge('relinking an install that is already linked is not a third device', async () => {
  const db = world({ entitlements: [runningTrial()], devices: [linkedDevice(INSTALLS[0], 1), linkedDevice(INSTALLS[1], 2)] });
  assert.equal((await linker(db)(INSTALLS[0])).status, 200);
});

edge('an ended trial keeps the cap', async () => {
  const db = world({ entitlements: [expiredTrial()], devices: [linkedDevice(INSTALLS[0], 1), linkedDevice(INSTALLS[1], 2)] });
  assert.equal((await linker(db)(INSTALLS[2])).status, 409);
});

edge('paid and granted accounts, and accounts that never had a trial, keep the existing policy', async () => {
  const three = [linkedDevice(INSTALLS[0], 1), linkedDevice(INSTALLS[1], 2), linkedDevice(INSTALLS[2], 3)];
  const fourth = '44444444-4444-4444-8444-444444444444';
  for (const [name, entitlements, account] of [
    ['a buyer after a trial', [runningTrial({ revoked_at: daysFromNow(-1) }), { tester_id: TESTER, entitlement: 'early_build', source: 'purchase', purchase_id: 1 }], {}],
    ['a grantee', [{ tester_id: TESTER, entitlement: 'early_build', source: 'grant' }], {}],
    ['a contributor with an ended trial', [expiredTrial()], { free_updates: true }],
    ['an account with no trial', [], {}],
  ]) {
    const db = world({ entitlements, devices: three, account });
    assert.equal((await linker(db)(fourth)).status, 200, name);
  }
});

edge('when the standing cannot be read, nothing is linked', async () => {
  const db = world({ entitlements: [runningTrial()] });
  const rpc = db.rpc;
  db.rpc = (name, args) => (name === 'account_standing' ? { data: null, error: { code: 'XX000' } } : rpc(name, args));
  const quiet = console.error;
  console.error = () => {};
  try {
    const { status } = await linker(db)(INSTALLS[0]);
    assert.equal(status, 500);
    assert.equal(db.tables.devices.length, 0);
  } finally {
    console.error = quiet;
  }
});

test('the trial cap is two, and applies only where a trial is the whole claim', () => {
  assert.equal(TRIAL_DEVICE_LIMIT, 2);
  const at = (linked, extra = {}) => trialDeviceRefusal({ owned: false, trial: 'active', linked_devices: linked, install_linked: false, ...extra });
  assert.equal(at(0), null);
  assert.equal(at(1), null);
  assert.equal(at(2)?.code, 'trial_device_limit');
  assert.equal(at(5)?.code, 'trial_device_limit');
  assert.equal(at(2, { trial: 'ended' })?.code, 'trial_device_limit');
  assert.equal(at(2, { owned: true }), null);
  assert.equal(at(2, { trial: null }), null);
  assert.equal(at(2, { install_linked: true }), null);
  assert.equal(trialDeviceRefusal(null), null);
});
