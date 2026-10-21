import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { purchaseAttribution } from '../supabase/functions/stripe-webhook/attribution.mjs';

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
  // refund() is unchanged: marking the purchase refunded is what takes it out
  // of the earnings (affiliate_sales reads status).
  assert.match(webhook, /update\(\{ status: "refunded", refunded_at:/);
});

test('the RPC the webhook calls is the one the migration defines, for the service role only', () => {
  const migration = readFileSync('supabase/migrations/20261021120000_affiliate_tracking.sql', 'utf8');
  assert.match(migration, /create function public\.attributable_affiliate\(target_code text, buyer_email text\)/);
  assert.match(migration, /revoke all on function public\.attributable_affiliate\(text, text\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.attributable_affiliate\(text, text\) to service_role;/);
});
