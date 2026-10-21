// Review copies: a 100% promotion code buys WavRead at $0, the webhook grants
// the licence, and the purchase is recorded as a review — never a sale, never
// commission (REVIEW_CODES.md).
//
// The rules in fulfillment.mjs and attribution.mjs are run directly. Then the
// real stripe-webhook and create-checkout functions are run too: Deno's two
// globals they touch (env and serve) are stubbed, the supabase-js import
// resolves to a stand-in that hands over the in-memory database below, and
// fetch is replaced, so nothing leaves this process — no Supabase, no Stripe.
// tests/affiliates-db.test.mjs checks the migration's side on a real Postgres.
//
// Running a .ts file needs Node's type stripping (22.18 or later); where it is
// missing, the function tests skip and the rest still run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { register } from 'node:module';
import { checkoutPurchase, promotionCode, PROMOTION_CODE_RE } from '../supabase/functions/stripe-webhook/fulfillment.mjs';
import { purchaseAttribution } from '../supabase/functions/stripe-webhook/attribution.mjs';

const PROMO = 'promo_1TestReviewCode';

// A completed Checkout Session as Stripe sends it in checkout.session.completed:
// a $50 sale that arrived by an affiliate's link.
const PAID = {
  id: 'cs_test_paid_sale',
  object: 'checkout.session',
  mode: 'payment',
  status: 'complete',
  payment_status: 'paid',
  amount_subtotal: 5000,
  amount_total: 5000,
  currency: 'usd',
  payment_intent: 'pi_test_paid_sale',
  customer_details: { email: 'buyer@example.net' },
  client_reference_id: 'aff-example',
  metadata: { product: 'early_build', bought_at_version: '1.5.6', source: 'aff-example', affiliate: 'example' },
  discounts: [],
};

// The same checkout with a 100% review code typed on Stripe's page. Nothing is
// charged, so Stripe collects no card, creates no payment intent, and reports
// no_payment_required. The reviewer also followed the affiliate's link.
const REVIEW = {
  ...PAID,
  id: 'cs_test_review_copy',
  payment_status: 'no_payment_required',
  amount_total: 0,
  payment_intent: null,
  customer_details: { email: 'reviewer@example.net' },
  discounts: [{ coupon: 'coupon_test_review', promotion_code: PROMO }],
  total_details: { amount_discount: 5000, amount_shipping: 0, amount_tax: 0 },
};

// === which checkouts grant a licence =======================================

test('a paid checkout above $0 is a sale, at the amount Stripe charged', () => {
  assert.deepEqual(checkoutPurchase(PAID), { kind: 'sale', amount_cents: 5000, stripe_promotion_code: null });
  // A partial discount is still a sale, at what was actually paid.
  assert.deepEqual(checkoutPurchase({ ...PAID, amount_total: 4000, discounts: [{ coupon: 'c', promotion_code: 'promo_1Partial' }] }),
    { kind: 'sale', amount_cents: 4000, stripe_promotion_code: 'promo_1Partial' });
});

test('a checkout a promotion code brought to $0 is a review, at $0', () => {
  assert.deepEqual(checkoutPurchase(REVIEW), { kind: 'review', amount_cents: 0, stripe_promotion_code: PROMO });
  // Paid with nothing charged reads the same way: no money, no sale.
  assert.equal(checkoutPurchase({ ...PAID, amount_total: 0 })?.kind, 'review');
});

test('an unpaid or pending checkout grants nothing', () => {
  for (const session of [
    { ...PAID, payment_status: 'unpaid' },
    { ...REVIEW, payment_status: 'unpaid' },
    // Stripe says nothing was collected, yet the total is above $0: nothing
    // arrived, so nothing was bought.
    { ...REVIEW, amount_total: 5000 },
    { ...PAID, payment_status: undefined },
    { ...PAID, amount_total: '5000' },
    {},
    null,
  ]) {
    assert.equal(checkoutPurchase(session), null, JSON.stringify(session?.payment_status));
  }
});

test('the promotion code is read from the session, however Stripe shaped it', () => {
  assert.equal(promotionCode(REVIEW), PROMO, 'the id, unexpanded, as the webhook carries it');
  assert.equal(promotionCode({ discounts: [{ promotion_code: { id: PROMO, code: 'REVIEW-7Q4M2K' } }] }), PROMO, 'expanded');
  assert.equal(promotionCode({ total_details: { breakdown: { discounts: [{ amount: 5000, discount: { promotion_code: PROMO } }] } } }), PROMO,
    'from the breakdown, when the session was retrieved with it');
  assert.equal(promotionCode({ discounts: [{ coupon: 'coupon_test_review', promotion_code: null }, { promotion_code: PROMO }] }), PROMO);
  for (const session of [PAID, {}, null, { discounts: 'promo_1X' }, { discounts: [{ promotion_code: 'REVIEW-7Q4M2K' }] },
    { discounts: [{ promotion_code: 'promo_has space' }] }, { discounts: [{ promotion_code: `promo_${'a'.repeat(101)}` }] }]) {
    assert.equal(promotionCode(session), null, JSON.stringify(session));
  }
  assert.ok(PROMOTION_CODE_RE.test(`promo_${'a'.repeat(100)}`), 'the longest id accepted here fits the column (^promo_[A-Za-z0-9]{1,250}$)');
});

// === a review credits no affiliate =========================================

function affiliates() {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: args.target_code === 'example' && args.buyer_email !== 'affiliate@example.net' ? 'example' : null, error: null };
    },
  };
}

test('a sale through an affiliate link still credits the affiliate', async () => {
  const db = affiliates();
  assert.deepEqual(await purchaseAttribution(db, PAID, 'buyer@example.net'), { source: 'aff-example', affiliate_code: 'example' });
  assert.equal(db.calls.length, 1);
});

test('a review through an affiliate link credits nobody, and keeps the label', async () => {
  for (const session of [REVIEW, { ...REVIEW, metadata: { product: 'early_build' } }, { ...PAID, amount_total: 0 }]) {
    const db = affiliates();
    assert.deepEqual(await purchaseAttribution(db, session, 'reviewer@example.net'), { source: 'aff-example', affiliate_code: null });
    assert.deepEqual(db.calls, [], 'the affiliates table is not even asked');
  }
});

// The same promises read from the source, so they still hold on a machine that
// skips the function tests below.
test('the functions use these rules: checkout offers codes, the webhook tags what it records', async () => {
  const { readFile } = await import('node:fs/promises');
  const checkoutSource = await readFile(new URL('../supabase/functions/create-checkout/index.ts', import.meta.url), 'utf8');
  assert.match(checkoutSource, /params\.set\("allow_promotion_codes", "true"\);/);
  assert.doesNotMatch(checkoutSource, /params\.set\("payment_method_collection"/, 'Stripe accepts it in subscription mode only');
  assert.doesNotMatch(checkoutSource, /discounts\[/, 'no discount is applied by WavRead');
  const webhookSource = await readFile(new URL('../supabase/functions/stripe-webhook/index.ts', import.meta.url), 'utf8');
  const fulfill = webhookSource.slice(webhookSource.indexOf('async function fulfill'), webhookSource.indexOf('async function refund'));
  assert.match(fulfill, /const purchase = checkoutPurchase\(session\);\s*if \(!purchase\) return "ignored: not paid";/);
  assert.match(fulfill, /amount_cents: purchase\.amount_cents,/);
  assert.match(fulfill, /kind: purchase\.kind,\s*stripe_promotion_code: purchase\.stripe_promotion_code,/);
  assert.doesNotMatch(fulfill, /payment_status !== "paid"/, 'a $0 review is no longer turned away');
});

// === the real functions =====================================================

const typescript = Boolean(process.features?.typescript);
const skip = typescript ? false : 'this Node cannot run TypeScript (type stripping needs Node 22.18 or later)';

const SECRET = 'whsec_test_review_codes';
const env = {
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
  SITE_URL: 'https://wavread.example',
};

// Every request the checkout function makes. Only Stripe's session endpoint is
// answered, and only with a stand-in; anything else fails the test.
const sentToStripe = [];
async function fakeFetch(url, init) {
  if (String(url) !== 'https://api.stripe.com/v1/checkout/sessions') throw new Error(`unexpected request to ${url}`);
  sentToStripe.push(new URLSearchParams(init.body));
  return new Response(JSON.stringify({ id: 'cs_test_created', url: 'https://checkout.stripe.example/c/pay/cs_test_created' }), { status: 200 });
}

let webhook;
let checkout;
if (typescript) {
  const supabase = 'data:text/javascript,' + encodeURIComponent('export function createClient() { return globalThis.__reviewCodesDb; }');
  register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'jsr:@supabase/supabase-js@2') return { url: ${JSON.stringify(supabase)}, shortCircuit: true };
      return next(specifier, context);
    }`));
  const handlers = [];
  globalThis.Deno = { env: { get: (name) => env[name] }, serve: (handler) => { handlers.push(handler); } };
  globalThis.fetch = fakeFetch;
  await import('../supabase/functions/stripe-webhook/index.ts');
  await import('../supabase/functions/create-checkout/index.ts');
  [webhook, checkout] = handlers;
}

// The tables the two functions read and write, in memory, behind the slice of
// the supabase-js query builder they use. Filters apply for real, so a row the
// function asks for is the row it gets.
function memoryDb({ builds = [] } = {}) {
  const tables = { accounts: [], purchases: [], entitlements: [], builds: [...builds] };
  const rpcCalls = [];
  let nextId = 1;
  const defaults = {
    accounts: () => ({ tester_id: `tester-${nextId}`, auth_user_id: null, status: 'active' }),
    purchases: () => ({ kind: 'sale', stripe_promotion_code: null, purchased_at: new Date().toISOString(), refunded_at: null }),
    entitlements: () => ({ granted_at: new Date().toISOString(), revoked_at: null }),
  };
  function from(name) {
    const rows = tables[name];
    assert.ok(rows, `no table ${name}`);
    let op = 'select';
    let payload;
    let options = {};
    const filters = [];
    let order;
    let limit = Infinity;
    const run = () => {
      if (op === 'insert' || op === 'upsert') {
        const key = options.onConflict;
        if (op === 'upsert' && options.ignoreDuplicates && rows.some((row) => row[key] === payload[key])) return { data: [], error: null };
        const row = { id: nextId++, ...defaults[name](), ...payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      let found = rows.filter((row) => filters.every(([column, value]) => (row[column] ?? null) === value));
      if (op === 'update') {
        for (const row of found) Object.assign(row, payload);
        return { data: found, error: null };
      }
      if (order) found = [...found].sort((a, b) => (order.ascending ? 1 : -1) * String(a[order.column]).localeCompare(String(b[order.column])));
      return { data: found.slice(0, limit), error: null };
    };
    const query = {
      select: () => query,
      insert(row) { op = 'insert'; payload = row; return query; },
      upsert(row, opts) { op = 'upsert'; payload = row; options = opts; return query; },
      update(patch) { op = 'update'; payload = patch; return query; },
      eq(column, value) { filters.push([column, value]); return query; },
      is(column, value) { filters.push([column, value]); return query; },
      order(column, { ascending }) { order = { column, ascending }; return query; },
      limit(count) { limit = count; return query; },
      async maybeSingle() {
        const { data } = run();
        return data.length > 1 ? { data: null, error: { message: 'more than one row' } } : { data: data[0] ?? null, error: null };
      },
      async single() {
        const { data } = run();
        return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `${data.length} rows` } };
      },
      then(resolve, reject) {
        try { resolve(run()); } catch (error) { reject(error); }
      },
    };
    return query;
  }
  const user = (email) => ({ data: { user: { id: `auth-${email}` } }, error: null });
  return {
    tables,
    rpcCalls,
    from,
    async rpc(name, args) {
      rpcCalls.push([name, args]);
      // attributable_affiliate's rule (tests/affiliates-db.test.mjs runs the
      // real one): 'example' is active and belongs to affiliate@example.net.
      return { data: args.target_code === 'example' && args.buyer_email !== 'affiliate@example.net' ? 'example' : null, error: null };
    },
    auth: { admin: { createUser: async ({ email }) => user(email), generateLink: async ({ email }) => user(email) } },
  };
}

// Delivers one event, signed as Stripe signs it, and answers the HTTP status
// and the outcome the function logged.
async function deliver(db, type, object) {
  const body = JSON.stringify({ id: `evt_test_${type}`, object: 'event', type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  globalThis.__reviewCodesDb = db;
  const logged = [];
  const log = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const response = await webhook(new Request('https://project.supabase.example/functions/v1/stripe-webhook', {
      method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}` }, body,
    }));
    return { status: response.status, outcome: logged.at(-1) };
  } finally {
    console.log = log;
  }
}

test('a paid session is fulfilled exactly as before: a sale, its amount, its affiliate', { skip }, async () => {
  const db = memoryDb();
  const { status, outcome } = await deliver(db, 'checkout.session.completed', PAID);
  assert.equal(status, 200);
  assert.match(outcome, /^fulfilled cs_test_paid_sale/);
  assert.equal(db.tables.purchases.length, 1);
  const [purchase] = db.tables.purchases;
  assert.equal(purchase.kind, 'sale');
  assert.equal(purchase.amount_cents, 5000);
  assert.equal(purchase.status, 'paid');
  assert.equal(purchase.stripe_payment_intent, 'pi_test_paid_sale');
  assert.equal(purchase.source, 'aff-example');
  assert.equal(purchase.affiliate_code, 'example', 'the affiliate is credited');
  assert.equal(purchase.stripe_promotion_code, null);
  assert.equal(db.rpcCalls.length, 1);
  assert.deepEqual(db.tables.entitlements.map((e) => [e.entitlement, e.source, e.build_version, e.purchase_id]),
    [['early_build', 'purchase', null, purchase.id]]);
});

test('a $0 review checkout grants the licence, tagged review, with no commission even from ?from=aff-example', { skip }, async () => {
  const db = memoryDb();
  const { status, outcome } = await deliver(db, 'checkout.session.completed', REVIEW);
  assert.equal(status, 200);
  assert.match(outcome, /^fulfilled cs_test_review_copy/);

  const [purchase] = db.tables.purchases;
  assert.equal(purchase.kind, 'review');
  assert.equal(purchase.amount_cents, 0, 'nothing was charged, and nothing is recorded as charged');
  assert.equal(purchase.affiliate_code, null, 'no affiliate is credited');
  assert.equal(purchase.source, 'aff-example', 'the label it arrived by is still kept');
  assert.equal(purchase.stripe_promotion_code, PROMO, 'the code it was redeemed with');
  assert.equal(purchase.stripe_payment_intent, null, 'a $0 checkout has no payment to refund');
  assert.deepEqual(db.rpcCalls, [], 'the affiliates table is not asked');

  // The licence is the same one a sale grants: every build, signed in by email.
  assert.deepEqual(db.tables.entitlements.map((e) => [e.entitlement, e.source, e.build_version, e.purchase_id, e.revoked_at]),
    [['early_build', 'purchase', null, purchase.id, null]]);
  assert.deepEqual(db.tables.accounts.map((a) => [a.email, a.auth_user_id]), [['reviewer@example.net', 'auth-reviewer@example.net']]);

  // Stripe retries; the review is recorded and granted once.
  await deliver(db, 'checkout.session.completed', REVIEW);
  assert.equal(db.tables.purchases.length, 1);
  assert.equal(db.tables.entitlements.length, 1);
});

test('an unpaid session is still ignored', { skip }, async () => {
  for (const session of [
    { ...PAID, payment_status: 'unpaid' },
    { ...REVIEW, payment_status: 'unpaid' },
    { ...REVIEW, amount_total: 5000 },
  ]) {
    const db = memoryDb();
    const { status, outcome } = await deliver(db, 'checkout.session.completed', session);
    assert.equal(status, 200);
    assert.equal(outcome, 'ignored: not paid');
    assert.deepEqual([db.tables.accounts, db.tables.purchases, db.tables.entitlements], [[], [], []]);
    assert.deepEqual(db.rpcCalls, []);
  }
  // A review code on some other product still sells nothing.
  const db = memoryDb();
  assert.equal((await deliver(db, 'checkout.session.completed', { ...REVIEW, metadata: { product: 'something_else' } })).outcome,
    'ignored: unknown product');
  assert.deepEqual(db.tables.purchases, []);
});

test('refunds are unaffected, and a review has no payment for one to match', { skip }, async () => {
  const db = memoryDb();
  await deliver(db, 'checkout.session.completed', PAID);
  await deliver(db, 'checkout.session.completed', REVIEW);
  const [sale, review] = db.tables.purchases;
  const entitlementOf = (purchase) => db.tables.entitlements.find((e) => e.purchase_id === purchase.id);

  const refunded = await deliver(db, 'charge.refunded', { id: 'ch_test_paid_sale', object: 'charge', payment_intent: 'pi_test_paid_sale', refunded: true });
  assert.equal(refunded.outcome, `refunded purchase ${sale.id}`);
  assert.equal(sale.status, 'refunded');
  assert.ok(sale.refunded_at);
  assert.ok(entitlementOf(sale).revoked_at, 'the refunded sale loses its licence');

  for (const charge of [{ id: 'ch_test_none', payment_intent: null }, { id: 'ch_test_other', payment_intent: 'pi_test_someone_else' }]) {
    const { outcome } = await deliver(db, 'charge.refunded', charge);
    assert.match(outcome, /^ignored: refund/);
  }
  assert.equal(review.status, 'paid');
  assert.equal(entitlementOf(review).revoked_at, null, 'the review keeps its licence');
});

async function startCheckout(db, body) {
  globalThis.__reviewCodesDb = db;
  sentToStripe.length = 0;
  const response = await checkout(new Request('https://project.supabase.example/functions/v1/create-checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.SITE_URL }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json(), params: sentToStripe[0] };
}

const MAC = { id: 15, version: '1.5.6', platform: 'macos', price_cents: 5000, published: true, released_at: '2026-10-01T12:00:00Z' };
const WINDOWS = { id: 16, version: '1.5.6-win', platform: 'windows', price_cents: 5000, published: true, released_at: '2026-10-12T12:00:00Z' };

test('the checkout lets a promotion code be typed, and sends nothing payment mode refuses', { skip }, async () => {
  const { status, body, params } = await startCheckout(memoryDb({ builds: [MAC, WINDOWS] }), { email: 'buyer@example.net', source: 'aff-example' });
  assert.equal(status, 200);
  assert.equal(body.url, 'https://checkout.stripe.example/c/pay/cs_test_created');
  assert.equal(sentToStripe.length, 1);
  assert.equal(params.get('allow_promotion_codes'), 'true');
  // A $0 total finishes without a card on its own in payment mode;
  // payment_method_collection is subscription-only and would fail every
  // checkout.
  assert.equal(params.get('payment_method_collection'), null);
  // Stripe refuses discounts beside allow_promotion_codes, and nothing here
  // applies one: the buyer types the code, or pays the price.
  assert.ok(![...params.keys()].some((key) => key.startsWith('discounts')), 'no discount is applied by WavRead');

  // The price, the build and the affiliate metadata are what they were.
  assert.equal(params.get('mode'), 'payment');
  assert.equal(params.get('customer_email'), 'buyer@example.net');
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '5000');
  assert.equal(params.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(params.get('metadata[product]'), 'early_build');
  assert.equal(params.get('metadata[bought_at_version]'), MAC.version, 'no build named buys the newest Mac build');
  assert.equal(params.get('metadata[source]'), 'aff-example');
  assert.equal(params.get('client_reference_id'), 'aff-example');
  assert.equal(params.get('metadata[affiliate]'), 'example');
});

test('a checkout naming a build still buys that build at its price, with the code field', { skip }, async () => {
  const { status, params } = await startCheckout(memoryDb({ builds: [MAC, { ...WINDOWS, price_cents: 4500 }] }), { email: 'buyer@example.net', build_id: 16 });
  assert.equal(status, 200);
  assert.equal(params.get('metadata[bought_at_version]'), WINDOWS.version);
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '4500');
  assert.equal(params.get('allow_promotion_codes'), 'true');
  assert.equal(params.get('payment_method_collection'), null);
  assert.equal(params.get('metadata[source]'), null, 'no label, no attribution');
});

test('with nothing on sale, no checkout is started, code or no code', { skip }, async () => {
  const { status } = await startCheckout(memoryDb({ builds: [{ ...MAC, published: false }] }), { email: 'buyer@example.net' });
  assert.equal(status, 409);
  assert.equal(sentToStripe.length, 0);
});
