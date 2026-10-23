import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { purchaseAttribution } from '../supabase/functions/stripe-webhook/attribution.mjs';
import { refundedCents, refundUpdate } from '../supabase/functions/stripe-webhook/refund.mjs';

// The affiliates table as attributable_affiliate sees it, and the rule it
// applies (tests/affiliates-db.test.mjs runs the real function): the code must
// exist and be active, and the buyer must not be the affiliate.
const AFFILIATES = [
  { code: 'example', email: 'affiliate@example.net', active: true },
  { code: 'paused', email: 'paused@example.net', active: false },
];

function database({ error = null, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      if (throws) throw new Error('connection reset');
      if (error) return { data: null, error };
      const row = AFFILIATES.find((a) => a.code === args.target_code && a.active
        && a.email !== String(args.buyer_email ?? '').trim().toLowerCase());
      return { data: row?.code ?? null, error: null };
    },
  };
}

const session = (source, extra = {}) => ({ id: 'cs_test_1', metadata: { product: 'early_build', source }, ...extra });

test('an affiliate sale is credited and keeps its label', async () => {
  const db = database();
  assert.deepEqual(await purchaseAttribution(db, session('aff-example', { client_reference_id: 'aff-example' }), 'buyer@example.net'),
    { source: 'aff-example', affiliate_code: 'example' });
  assert.deepEqual(db.calls, [['attributable_affiliate', { target_code: 'example', buyer_email: 'buyer@example.net' }]]);
});

test('self-referral is recorded with no affiliate', async () => {
  assert.deepEqual(await purchaseAttribution(database(), session('aff-example'), 'affiliate@example.net'),
    { source: 'aff-example', affiliate_code: null });
});

test('an unknown or inactive code is recorded with no affiliate', async () => {
  for (const label of ['aff-never-added', 'aff-paused']) {
    assert.deepEqual(await purchaseAttribution(database(), session(label), 'buyer@example.net'),
      { source: label, affiliate_code: null }, label);
  }
});

test('an advertisement label is recorded without asking about affiliates', async () => {
  const db = database();
  assert.deepEqual(await purchaseAttribution(db, session('reels-a'), 'buyer@example.net'), { source: 'reels-a', affiliate_code: null });
  assert.deepEqual(db.calls, []);
});

test('no label, or one that is not a label, records nothing', async () => {
  for (const s of [session(undefined), session('Reels A from the newsletter'), session('aff-a'), {}, null]) {
    const db = database();
    assert.deepEqual(await purchaseAttribution(db, s, 'buyer@example.net'), { source: null, affiliate_code: null });
    assert.deepEqual(db.calls, []);
  }
});

test('client_reference_id stands in when metadata carries no usable label', async () => {
  assert.deepEqual(await purchaseAttribution(database(), { metadata: {}, client_reference_id: 'aff-example' }, 'buyer@example.net'),
    { source: 'aff-example', affiliate_code: 'example' });
});

test('a failed lookup never blocks the sale', async () => {
  for (const db of [database({ error: { code: 'PGRST202', message: 'function not found' } }), database({ throws: true })]) {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      assert.deepEqual(await purchaseAttribution(db, session('aff-example'), 'buyer@example.net'),
        { source: 'aff-example', affiliate_code: null }, 'the label is kept so the sale can be credited by hand');
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], /buyer@example\.net|affiliate@/, 'no email reaches the function log');
  }
});

test('an answer naming a different code credits nobody', async () => {
  const db = { rpc: async () => ({ data: 'someone-else', error: null }) };
  assert.deepEqual(await purchaseAttribution(db, session('aff-example'), 'buyer@example.net'), { source: 'aff-example', affiliate_code: null });
});

test('fulfill() records the attribution on the purchase, once', () => {
  const webhook = readFileSync('supabase/functions/stripe-webhook/index.ts', 'utf8');
  assert.match(webhook, /import \{ purchaseAttribution \} from "\.\/attribution\.mjs";/);
  const fulfill = webhook.slice(webhook.indexOf('async function fulfill'), webhook.indexOf('async function refund'));
  assert.match(fulfill, /const attribution = await purchaseAttribution\(db, session, email\);/, 'asked with the checkout email');
  assert.ok(fulfill.indexOf('purchaseAttribution(') < fulfill.indexOf('.upsert('), 'decided before the purchase is written');
  assert.match(fulfill, /\.upsert\(\{[\s\S]*source: attribution\.source,\s*affiliate_code: attribution\.affiliate_code,[\s\S]*ignoreDuplicates: true/,
    'written with the purchase, and never rewritten by a retry');
  // refund() still marks the purchase refunded — what takes it out of the
  // earnings (affiliate_sales reads status) — through refund.mjs, tested below.
  assert.match(webhook, /import \{ refundUpdate \} from "\.\/refund\.mjs";/);
});

test('refund() records the refunded amount and otherwise works as before', () => {
  const webhook = readFileSync('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const refund = webhook.slice(webhook.indexOf('async function refund'), webhook.indexOf('Deno.serve'));
  assert.match(refund, /\.select\("id, tester_id, status, amount_refunded_cents"\)/);
  assert.match(refund, /const changes = refundUpdate\(found\.data, charge, new Date\(\)\.toISOString\(\)\);\s+if \(changes\) \{[\s\S]*\.update\(changes\)\s+\.eq\("id", found\.data\.id\);/);
  assert.match(refund, /\.update\(\{ revoked_at: new Date\(\)\.toISOString\(\) \}\)[\s\S]*\.eq\("purchase_id", found\.data\.id\)/,
    'the licence the purchase granted is still revoked, partial refund or full');
});

const NOW = '2026-10-23T12:00:00.000Z';

test('the first refund event marks the purchase refunded, with the amount Stripe reports', () => {
  const paid = { status: 'paid', amount_refunded_cents: null };
  assert.deepEqual(refundUpdate(paid, { amount: 5000, amount_refunded: 5000, refunded: true }, NOW),
    { status: 'refunded', refunded_at: NOW, amount_refunded_cents: 5000 }, 'a full refund');
  assert.deepEqual(refundUpdate(paid, { amount: 5000, amount_refunded: 2000, refunded: false }, NOW),
    { status: 'refunded', refunded_at: NOW, amount_refunded_cents: 2000 }, 'a partial refund is marked the same way, and its amount says so');
});

test('a charge without a usable amount is still marked refunded, with the amount unknown', () => {
  for (const charge of [{}, { amount_refunded: '5000' }, { amount_refunded: -1 }, { amount_refunded: 12.5 }, { amount_refunded: null }, null]) {
    assert.deepEqual(refundUpdate({ status: 'paid', amount_refunded_cents: null }, charge, NOW),
      { status: 'refunded', refunded_at: NOW, amount_refunded_cents: null }, JSON.stringify(charge));
    assert.equal(refundedCents(charge), null);
  }
});

test('a later refund event only raises the recorded amount; a repeat or late one changes nothing', () => {
  const partly = { status: 'refunded', amount_refunded_cents: 2000 };
  assert.deepEqual(refundUpdate(partly, { amount_refunded: 5000 }, NOW), { amount_refunded_cents: 5000 }, 'a second refund completes it');
  assert.equal(refundUpdate(partly, { amount_refunded: 2000 }, NOW), null, 'a retried event');
  assert.equal(refundUpdate(partly, { amount_refunded: 1000 }, NOW), null, 'an event that arrives out of order never lowers it');
  assert.equal(refundUpdate(partly, {}, NOW), null);
  assert.deepEqual(refundUpdate({ status: 'refunded', amount_refunded_cents: null }, { amount_refunded: 5000 }, NOW),
    { amount_refunded_cents: 5000 }, 'a refund recorded before the amount was kept gets it from the next event');
  assert.deepEqual(refundUpdate({ status: 'refunded', amount_refunded_cents: null }, { amount_refunded: 0 }, NOW),
    { amount_refunded_cents: 0 });
});

test('the column refund() writes is the one the payout migration adds', () => {
  const migration = readFileSync('supabase/migrations/20261023120000_affiliate_payout_ledger.sql', 'utf8');
  assert.match(migration, /add column amount_refunded_cents integer\s+constraint purchases_amount_refunded_cents_check\s+check \(amount_refunded_cents is null or amount_refunded_cents >= 0\);/,
    'nullable and bounded below only, so no figure Stripe sends can make the update fail');
});

test('the RPC the webhook calls is the one the migration defines, for the service role only', () => {
  const migration = readFileSync('supabase/migrations/20261021120000_affiliate_tracking.sql', 'utf8');
  assert.match(migration, /create function public\.attributable_affiliate\(target_code text, buyer_email text\)/);
  assert.match(migration, /revoke all on function public\.attributable_affiliate\(text, text\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.attributable_affiliate\(text, text\) to service_role;/);
});
