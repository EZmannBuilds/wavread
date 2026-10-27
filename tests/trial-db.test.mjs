// The 14-day trial migration, run for real: every migration in
// supabase/migrations applied to a throwaway local Postgres
// (tests/support/postgres.mjs), and start_trial, the active rule, the trial
// device standing, the rate limit and the owner-grant changes exercised as the
// roles that will call them. Nothing here touches a hosted database.
//
// Expiring a trial here is the same statement the PR's test plan gives for a
// throwaway account on the hosted project: shift the trial's window back by
// 15 days, which keeps expires_at after granted_at as the table requires.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDatabase, quote } from './support/postgres.mjs';

const pg = migratedDatabase();
const { as, psql } = pg;

const grants = readFileSync('supabase/migrations/20260911002958_owner_licence_grants.sql', 'utf8');
const OWNER_ID = grants.match(/auth\.uid\(\) = '([0-9a-f-]{36})'::uuid/)?.[1];
const OWNER_EMAIL = grants.match(/lower\(u\.email\)='([^']+)'/)?.[1];
const OWNER_SESSION = '00000000-0000-4000-8000-0000000000b1';
const OWNER = { role: 'authenticated', claims: { sub: OWNER_ID, session_id: OWNER_SESSION } };
const STRANGER = { role: 'authenticated', claims: { sub: '00000000-0000-4000-8000-0000000000c2' } };
const ANON = { role: 'anon', claims: {} };
const SERVICE = { role: 'service_role', claims: {} };
const DAY_MS = 24 * 3600 * 1000;

let MAC;
let WINDOWS;
let MAC_TRIAL;
let WINDOWS_TRIAL;

before(() => {
  pg.start();
  if (pg.unavailable) return;
  assert.ok(OWNER_ID && OWNER_EMAIL, 'the owner identity is read from the licence-grant migration');
  const setup = psql(`
    insert into auth.users values (${quote(OWNER_ID)}, ${quote(OWNER_EMAIL)}, now());
    insert into auth.sessions values (${quote(OWNER_SESSION)}, ${quote(OWNER_ID)});
    insert into public.accounts (email, status, auth_user_id) values (${quote(OWNER_EMAIL)}, 'active', ${quote(OWNER_ID)});
    update public.builds set published = false;
    insert into public.builds (version, channel, platform, file_name, storage_path, sha256, size_bytes, published, price_cents)
    values ('1.5.6', 'early', 'macos', 'WavRead-1.5.6.dmg', '1.5.6/WavRead-1.5.6.dmg', repeat('b', 64), 1, true, 5000),
           ('1.5.6', 'early', 'windows', 'WavRead-1.5.6-Setup.exe', '1.5.6/WavRead-1.5.6-Setup.exe', repeat('c', 64), 1, true, 5000);
    insert into public.builds (version, channel, platform, kind, file_name, storage_path, sha256, size_bytes, published, price_cents)
    values ('1.5.6', 'early', 'macos', 'trial', 'WavRead-1.5.6-Trial.dmg', '1.5.6/WavRead-1.5.6-Trial.dmg', repeat('d', 64), 1, true, 5000),
           ('1.5.6', 'early', 'windows', 'trial', 'WavRead-1.5.6-Trial-Setup.exe', '1.5.6/WavRead-1.5.6-Trial-Setup.exe', repeat('e', 64), 1, true, 5000);`);
  assert.ok(!setup.error, setup.error?.message);
  MAC = as(null, "select id from public.builds where version = '1.5.6' and platform = 'macos' and kind = 'full'");
  WINDOWS = as(null, "select id from public.builds where version = '1.5.6' and platform = 'windows' and kind = 'full'");
  MAC_TRIAL = as(null, "select id from public.builds where version = '1.5.6' and platform = 'macos' and kind = 'trial'");
  WINDOWS_TRIAL = as(null, "select id from public.builds where version = '1.5.6' and platform = 'windows' and kind = 'trial'");
});

after(() => pg.stop());

function dbTest(name, body) {
  test(name, (t) => (pg.unavailable ? t.skip(pg.unavailable) : body()));
}

// start-trial makes the Supabase Auth user before it calls start_trial; this
// is that step.
const signIn = (email) => as(null, `insert into auth.users (id, email) values (gen_random_uuid(), ${quote(email)})`);
const startTrial = (email) => as(SERVICE, `select public.start_trial(${quote(email)})`);
const tester = (email) => `(select tester_id from public.accounts where email = ${quote(email)})`;
const access = (email, build) => as(SERVICE, `select to_jsonb(public.has_build_access(${tester(email)}, ${build}))`);
const standing = (email, install = null) =>
  as(SERVICE, `select public.account_standing(${tester(email)}${install ? `, ${quote(install)}::uuid` : ''})`);
const trialRow = (email) => as(null, `select to_jsonb(e) from public.entitlements e where source = 'trial' and tester_id = ${tester(email)}`);
const forceExpire = (email) => as(null, `update public.entitlements
  set granted_at = granted_at - interval '15 days', expires_at = expires_at - interval '15 days'
  where source = 'trial' and tester_id = ${tester(email)}`);
// A purchase as stripe-webhook's fulfill() records one, and the entitlement it
// grants. Answers the entitlement insert's outcome.
function buy(email, session) {
  const paid = as(SERVICE, `insert into public.purchases (tester_id, product, amount_cents, stripe_checkout_session_id, email, status)
    values (${tester(email)}, 'early_build', 5000, ${quote(session)}, ${quote(email)}, 'paid')`);
  assert.equal(paid, null, paid?.error?.message);
  return as(SERVICE, `insert into public.entitlements (tester_id, entitlement, source, build_version, purchase_id)
    select ${tester(email)}, 'early_build', 'purchase', null, id from public.purchases where stripe_checkout_session_id = ${quote(session)}`);
}
// fulfill()'s "paid wins" step.
const endTrials = (email) => as(SERVICE, `update public.entitlements set revoked_at = now()
  where tester_id = ${tester(email)} and entitlement = 'early_build' and source = 'trial' and revoked_at is null`);

dbTest('a trial starts once per email, for exactly 14 days, and buys nothing', () => {
  signIn('first@example.net');
  const before = Date.now();
  const started = startTrial(' First@Example.NET ');
  assert.equal(started.status, 'started');
  assert.equal(started.email, 'first@example.net', 'the email is normalized');
  const granted = Date.parse(started.granted_at);
  const expires = Date.parse(started.expires_at);
  assert.equal(expires - granted, 14 * DAY_MS, 'expires_at is granted_at + 14 days, to the microsecond');
  assert.ok(Math.abs(expires - (before + 14 * DAY_MS)) < 60_000, 'and that is 14 days from now');

  const row = trialRow('first@example.net');
  assert.deepEqual([row.entitlement, row.source, row.build_version, row.purchase_id, row.revoked_at],
    ['early_build', 'trial', null, null, null], 'an unscoped trial entitlement with no purchase behind it');
  assert.equal(as(null, `select count(*) from public.purchases where tester_id = ${tester('first@example.net')}`), 0, 'no purchases row');
  assert.equal(as(null, `select to_jsonb(a.auth_user_id = u.id) from public.accounts a join auth.users u on u.email = a.email
    where a.email = 'first@example.net'`), true, 'the account is created and bound to its sign-in identity');
  assert.deepEqual(standing('first@example.net'),
    { owned: false, trial: 'active', trial_expires_at: row.expires_at, linked_devices: 0, install_linked: false });
});

dbTest('a second trial is refused while the first runs, after it expires, and after it is revoked', () => {
  signIn('again@example.net');
  assert.equal(startTrial('again@example.net').status, 'started');

  let second = startTrial('again@example.net');
  assert.equal(second.status, 'trial_used');
  assert.equal(second.trial_active, true, 'still running — the caller can say so');

  forceExpire('again@example.net');
  second = startTrial('again@example.net');
  assert.equal(second.status, 'trial_used', 'expiry does not free the slot');
  assert.equal(second.trial_active, false);

  endTrials('again@example.net');
  assert.equal(startTrial('again@example.net').status, 'trial_used', 'neither does revocation');

  // The index holds even for a writer that skips start_trial.
  assert.equal(as(SERVICE, `insert into public.entitlements (tester_id, entitlement, source, granted_at, expires_at)
    values (${tester('again@example.net')}, 'early_build', 'trial', now(), now() + interval '14 days')`).error?.code, '23505');
});

dbTest('a buyer, a grantee or a contributor cannot start a trial; a refunded buyer can', () => {
  for (const email of ['buyer@example.net', 'contributor@example.net', 'refunded@example.net']) {
    signIn(email);
    as(null, `insert into public.accounts (email, status) values (${quote(email)}, 'active')`);
  }
  assert.equal(buy('buyer@example.net', 'cs_test_trial_buyer_01'), null);
  assert.equal(startTrial('buyer@example.net').status, 'already_owned');

  as(null, "update public.accounts set free_updates = true where email = 'contributor@example.net'");
  assert.equal(startTrial('contributor@example.net').status, 'already_owned');

  signIn('grantee@example.net');
  assert.equal(as(OWNER, "select public.owner_grant_licence('grantee@example.net')").granted, true);
  assert.equal(startTrial('grantee@example.net').status, 'already_owned');

  assert.equal(buy('refunded@example.net', 'cs_test_trial_refund_1'), null);
  as(SERVICE, `update public.entitlements set revoked_at = now() where source = 'purchase' and tester_id = ${tester('refunded@example.net')}`);
  assert.equal(startTrial('refunded@example.net').status, 'started', 'a revoked purchase is not an active one');

  for (const email of ['buyer@example.net', 'contributor@example.net', 'grantee@example.net']) {
    assert.equal(trialRow(email), null, `${email} was given no trial row`);
  }
});

dbTest('paused accounts, bad addresses and missing sign-ins are refused', () => {
  signIn('paused@example.net');
  as(null, "insert into public.accounts (email, status) values ('paused@example.net', 'paused')");
  assert.equal(startTrial('paused@example.net').status, 'account_inactive');

  signIn('bound@example.net');
  as(null, "insert into public.accounts (email, status, auth_user_id) values ('bound@example.net', 'active', null)");
  as(null, "update public.accounts set auth_user_id = (select id from auth.users where email = 'paused@example.net') where email = 'bound@example.net'");
  assert.equal(startTrial('bound@example.net').status, 'account_mismatch', 'an account bound to another identity is not rebound');

  assert.equal(startTrial('not-an-email').error?.code, '22023');
  assert.equal(startTrial('nobody@example.net').error?.code, '22023', 'start-trial creates the sign-in first; without it nothing is written');
  assert.equal(as(null, "select count(*) from public.accounts where email = 'nobody@example.net'"), 0);
});

dbTest('only the service role can start a trial, take a slot or read an account standing', () => {
  signIn('direct@example.net');
  const digest = 'a'.repeat(64);
  for (const who of [ANON, STRANGER, OWNER]) {
    assert.equal(as(who, "select public.start_trial('direct@example.net')").error?.code, '42501');
    assert.equal(as(who, `select public.take_trial_slot('${digest}', '${digest}')`).error?.code, '42501');
    assert.equal(as(who, `select public.account_standing(${tester(OWNER_EMAIL)})`).error?.code, '42501');
    assert.equal(as(who, 'select count(*) from public.wavread_trial_rate_limits').error?.code, '42501');
  }
  assert.equal(trialRow('direct@example.net'), null);
});

dbTest('a trial downloads the Mac and Windows trial builds until it expires, and nothing after', () => {
  signIn('both@example.net');
  startTrial('both@example.net');
  assert.equal(access('both@example.net', MAC_TRIAL), true);
  assert.equal(access('both@example.net', WINDOWS_TRIAL), true, 'one trial covers both platforms');
  assert.equal(access('both@example.net', MAC), false, 'never the paid build, which has no end');
  assert.equal(access('both@example.net', WINDOWS), false);

  forceExpire('both@example.net');
  assert.equal(access('both@example.net', MAC_TRIAL), false, 'an expired trial is inactive');
  assert.equal(access('both@example.net', WINDOWS_TRIAL), false);
  const after = standing('both@example.net');
  assert.equal(after.trial, 'ended');
  assert.equal(after.owned, false);
  assert.ok(Date.parse(after.trial_expires_at) < Date.now());
  assert.equal(as(SERVICE, "select to_jsonb(public.entitlement_is_active(null, now() - interval '1 second'))"), false);
  assert.equal(as(SERVICE, "select to_jsonb(public.entitlement_is_active(null, now() + interval '1 day'))"), true);
  assert.equal(as(SERVICE, 'select to_jsonb(public.entitlement_is_active(null, null))'), true, 'purchases and grants never expire');
  assert.equal(as(SERVICE, 'select to_jsonb(public.entitlement_is_active(now(), null))'), false);
});

dbTest('a build is the paid build unless it says it is the trial, and each exists once per platform', () => {
  assert.equal(as(null, "select to_jsonb(kind) from public.builds where file_name = 'WavRead-1.5.6.dmg'"), 'full', 'the default');
  const again = as(null, `insert into public.builds (version, channel, platform, kind, file_name, storage_path, sha256, size_bytes, published, price_cents)
    values ('1.5.6', 'early', 'macos', 'trial', 'WavRead-1.5.6-Trial-2.dmg', '1.5.6/x.dmg', repeat('f', 64), 1, false, 5000)`);
  assert.equal(again?.error?.code, '23505', 'one trial build per version, channel and platform');
  const odd = as(null, `insert into public.builds (version, channel, platform, kind, file_name, storage_path, sha256, size_bytes, published, price_cents)
    values ('1.5.7', 'early', 'macos', 'demo', 'WavRead-1.5.7.dmg', '1.5.7/x.dmg', repeat('f', 64), 1, false, 5000)`);
  assert.equal(odd?.error?.code, '23514', 'no third kind');
});

dbTest('only trials expire, a trial is never scoped or paid for, and nothing expires before it starts', () => {
  signIn('shape@example.net');
  as(null, "insert into public.accounts (email, status) values ('shape@example.net', 'active')");
  const insert = (fields, values) => as(SERVICE, `insert into public.entitlements (tester_id, entitlement, ${fields})
    values (${tester('shape@example.net')}, 'early_build', ${values})`);
  assert.equal(insert('source, expires_at', "'purchase', now() + interval '1 year'").error?.code, '23514', 'a purchase cannot be a rental');
  assert.equal(insert('source, expires_at', "'grant', now() + interval '1 year'").error?.code, '23514', 'nor a grant');
  assert.equal(insert('source', "'trial'").error?.code, '23514', 'a trial must end');
  assert.equal(insert('source, expires_at, build_version', "'trial', now() + interval '14 days', '1.5.6'").error?.code, '23514');
  assert.equal(insert('source, granted_at, expires_at', "'trial', now(), now() - interval '1 day'").error?.code, '23514');
  assert.equal(insert('source, expires_at', "'rental', now() + interval '14 days'").error?.code, '23514', 'no fourth source');
});

dbTest('a purchase lands beside a running or an expired trial and ends it; a refund does not bring it back', () => {
  for (const [email, expired] of [['converts@example.net', false], ['late@example.net', true]]) {
    signIn(email);
    startTrial(email);
    if (expired) forceExpire(email);
    assert.equal(buy(email, `cs_test_convert_${expired ? 'late' : 'now_'}`), null,
      `the purchase entitlement is not refused by ${expired ? 'an expired' : 'a running'} trial`);
    endTrials(email);
    assert.equal(access(email, MAC), true);
    assert.equal(access(email, MAC_TRIAL), false, 'a buyer is never handed the build that asks for an account');
    const now = standing(email);
    assert.equal(now.owned, true);
    assert.equal(now.trial, 'ended', 'paid wins');
    assert.equal(startTrial(email).status, 'already_owned');
    const purchase = as(null, `select to_jsonb(e) from public.entitlements e where source = 'purchase' and tester_id = ${tester(email)}`);
    assert.equal(purchase.expires_at, null, 'a purchase never expires');
  }

  // The rule the trial must not weaken: still one unrevoked purchase per build.
  assert.equal(buy('converts@example.net', 'cs_test_convert_dupe').error?.code, '23505');

  // refund() revokes the purchase entitlement only.
  as(SERVICE, `update public.entitlements set revoked_at = now() where source = 'purchase' and tester_id = ${tester('converts@example.net')}`);
  assert.equal(access('converts@example.net', MAC), false);
  assert.equal(standing('converts@example.net').trial, 'ended', 'the trial it ended stays ended');
  assert.equal(startTrial('converts@example.net').status, 'trial_used');
});

dbTest('an owner grant is never blocked by a trial, ends it, and can be revoked and restored around it', () => {
  signIn('creator@example.net');
  startTrial('creator@example.net');
  const granted = as(OWNER, "select public.owner_grant_licence('creator@example.net')");
  assert.deepEqual([granted.granted, granted.already_owned], [true, false], 'a running trial is not ownership');
  assert.equal(standing('creator@example.net').trial, 'ended', 'the grant ends the trial');
  assert.equal(standing('creator@example.net').owned, true);

  const looked = as(OWNER, "select public.owner_manage_licence('creator@example.net', 'lookup')");
  const trial = looked.licences.find((l) => l.source === 'trial');
  const grant = looked.licences.find((l) => l.source === 'grant');
  assert.ok(trial.expires_at && trial.revoked_at, 'the owner sees the trial, when it would have ended, and that it was ended');
  assert.equal(grant.expires_at, null, 'a grant never expires');

  as(OWNER, "select public.owner_manage_licence('creator@example.net', 'revoke')");
  assert.equal(access('creator@example.net', MAC), false);
  const restored = as(OWNER, "select public.owner_manage_licence('creator@example.net', 'restore')");
  assert.equal(restored.licences.find((l) => l.source === 'grant').revoked_at, null, 'restore is not blocked by the trial row');
  assert.equal(access('creator@example.net', MAC), true);

  // A grant to someone still mid-trial when restore runs ends that trial too.
  signIn('second-creator@example.net');
  as(OWNER, "select public.owner_grant_licence('second-creator@example.net')");
  as(OWNER, "select public.owner_manage_licence('second-creator@example.net', 'revoke')");
  assert.equal(startTrial('second-creator@example.net').status, 'started', 'with the grant revoked, the account may trial');
  as(OWNER, "select public.owner_manage_licence('second-creator@example.net', 'restore')");
  assert.deepEqual([standing('second-creator@example.net').owned, standing('second-creator@example.net').trial], [true, 'ended']);
});

dbTest('linked installs are counted once each, revoked ones not at all', () => {
  signIn('devices@example.net');
  startTrial('devices@example.net');
  const link = (install, hash, revoked = false) => as(SERVICE, `insert into public.devices (tester_id, install_id, token_hash, revoked_at)
    values (${tester('devices@example.net')}, ${quote(install)}, ${quote(hash.repeat(64))}, ${revoked ? 'now()' : 'null'})`);
  const one = '11111111-1111-4111-8111-111111111111';
  const two = '22222222-2222-4222-8222-222222222222';
  link(one, 'a');
  link(one, 'b');
  link(two, 'c', true);
  let now = standing('devices@example.net', one);
  assert.equal(now.linked_devices, 1, 'one install linked twice is one device');
  assert.equal(now.install_linked, true);
  assert.equal(standing('devices@example.net', two).install_linked, false, 'a revoked link is not a link');
  link(two, 'd');
  now = standing('devices@example.net');
  assert.equal(now.linked_devices, 2);
  assert.equal(now.install_linked, false, 'no install given, none is linked');
});

dbTest('start-trial is limited per address, per email and across everyone', () => {
  // One transaction, so every call lands in the same hour and day buckets.
  const hex = (seed) => `md5(${seed}) || md5(${seed})`;
  const result = psql(`begin;
    set local role service_role;
    select jsonb_agg(public.take_trial_slot(${hex("'one address'")}, ${hex("'email ' || i")}) order by i) from generate_series(1, 7) i;
    select jsonb_agg(public.take_trial_slot(${hex("'address ' || i")}, ${hex("'one email'")}) order by i) from generate_series(1, 7) i;
    select jsonb_agg(public.take_trial_slot(${hex("'flood address ' || i")}, ${hex("'flood email ' || i")}) order by i) from generate_series(1, 100) i;
    commit;`);
  assert.ok(!result.error, result.error?.message);
  const [address, email, everyone] = result.out.split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(address, [true, true, true, true, true, false, false], '5 an hour from one address');
  assert.deepEqual(email, [true, true, true, true, true, false, false], '5 a day for one email, from any address');
  assert.equal(everyone.filter(Boolean).length, 90, '100 an hour across everyone, 10 of them used above');
  assert.deepEqual(everyone.slice(90), Array(10).fill(false));
  assert.equal(as(SERVICE, "select public.take_trial_slot('not-a-digest', 'not-a-digest')").error?.code, 'P0001');
  assert.equal(as(null, "select count(*) from public.wavread_trial_rate_limits where scope !~ '^trial:(address|email):[a-f0-9]{64}$' and scope <> 'trial:everyone'"), 0,
    'only digests are stored');
});
