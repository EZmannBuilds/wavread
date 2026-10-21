import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('docs/js/buy.js', 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 21);

function storage(initial = {}) {
  const entries = { ...initial };
  return { entries, getItem: (k) => (k in entries ? entries[k] : null), setItem: (k, v) => { entries[k] = String(v); }, removeItem: (k) => { delete entries[k]; } };
}
const referral = (label, age) => JSON.stringify({ label, savedAt: NOW - age });

// Runs buy.js against a stand-in checkout form, submits it once, and answers
// the JSON body create-checkout received.
async function checkoutBody({ search = '', localStorage } = {}) {
  const listeners = [];
  const button = { disabled: true };
  const field = { value: 'buyer@example.net', setAttribute() {} };
  const status = { textContent: '', dataset: {} };
  const form = { reportValidity: () => true, addEventListener: (_, cb) => listeners.push(cb),
    querySelector: (selector) => (selector === 'button[type=submit]' ? button : field) };
  const sent = [];
  const context = vm.createContext({
    document: { querySelector: (s) => (s === '#checkout-form' ? form : s === '#checkout-status' ? status : { hidden: true }) },
    window: { WAVREAD_BETA_CONFIG: { url: 'https://example.supabase.co' } },
    location: { hostname: 'localhost', host: 'localhost', search, assign: () => {} },
    AbortSignal, URLSearchParams, JSON, Date: { now: () => NOW }, localStorage,
    FormData: class { get() { return field.value; } },
    fetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.test/session' }) };
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  assert.equal(button.disabled, false, 'checkout is ready');
  for (const listener of listeners) await listener({ preventDefault() {} });
  assert.equal(sent.length, 1);
  return sent[0];
}

test('an affiliate link on the buy page itself is sent with the purchase', async () => {
  assert.deepEqual(await checkoutBody({ search: '?from=aff-example', localStorage: storage() }),
    { email: 'buyer@example.net', source: 'aff-example' });
});

test('a referral stored in the last 30 days is sent when the page carries no label', async () => {
  const local = storage({ 'wavread-referral': referral('aff-example', 29 * DAY) });
  assert.equal((await checkoutBody({ localStorage: local })).source, 'aff-example');
  assert.ok(local.entries['wavread-referral'], 'and stays until it expires');
});

test('an expired referral is ignored and removed', async () => {
  for (const age of [30 * DAY, 90 * DAY]) {
    const local = storage({ 'wavread-referral': referral('aff-example', age) });
    assert.deepEqual(await checkoutBody({ localStorage: local }), { email: 'buyer@example.net' });
    assert.equal(local.entries['wavread-referral'], undefined);
  }
});

test('the link followed to this page wins over a stored referral', async () => {
  const local = storage({ 'wavread-referral': referral('aff-example', DAY) });
  assert.equal((await checkoutBody({ search: '?from=reels-a', localStorage: local })).source, 'reels-a');
  assert.equal((await checkoutBody({ search: '?from=aff-newer', localStorage: local })).source, 'aff-newer');
});

test('stored values that are not a referral are never sent', async () => {
  for (const raw of ['{not json', '"aff-example"', JSON.stringify({ label: 'reels-a', savedAt: NOW }),
                     JSON.stringify({ label: 'aff-example', savedAt: NOW + DAY }), JSON.stringify({ label: 'aff-example' })]) {
    const local = storage({ 'wavread-referral': raw });
    assert.deepEqual(await checkoutBody({ localStorage: local }), { email: 'buyer@example.net' }, raw);
  }
});

test('no label and no storage, or blocked storage, still sells', async () => {
  assert.deepEqual(await checkoutBody({ localStorage: storage() }), { email: 'buyer@example.net' });
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
  assert.deepEqual(await checkoutBody({ localStorage: blocked }), { email: 'buyer@example.net' });
  assert.deepEqual(await checkoutBody({ localStorage: undefined }), { email: 'buyer@example.net' });
});

test('buy.js stores nothing itself and touches no other storage', () => {
  assert.doesNotMatch(source, /localStorage\.setItem|document\.cookie|sessionStorage/);
  assert.deepEqual([...source.matchAll(/localStorage\.(\w+)\(/g)].map((m) => m[1]).sort(), ['getItem', 'removeItem']);
});
