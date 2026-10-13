import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

function fixture(id) {
  const listeners = [];
  const button = {disabled: true};
  const field = {value: 'audit@example.com', setAttribute() {}};
  const status = {textContent: '', dataset: {}};
  const notice = {hidden: true, textContent: ''};
  const form = {reportValidity: () => true, reset() {}, addEventListener: (_, cb) => listeners.push(cb),
    querySelector: selector => selector === 'button[type=submit]' ? button : field};
  return {listeners, button, field, status, notice, form,
    document: {querySelector: selector => selector === `#${id}` ? form : selector.endsWith('-status') ? status : notice},
    async submit() {
      const event = {prevented: false, preventDefault() {this.prevented = true;}};
      for (const listener of listeners) await listener(event);
      return event;
    }};
}
test('checkout blocks native submission until configuration and recovers after a network error', async () => {
  const f = fixture('checkout-form');
  let resolveConfig, calls = 0;
  const context = vm.createContext({document: f.document, AbortSignal, URLSearchParams,
    location: {hostname: 'wavread.com', host: 'wavread.com', search: '', assign: () => assert.fail('unexpected checkout navigation')},
    FormData: class {get() {return f.field.value;}},
    fetch: () => {calls++; return calls === 1 ? new Promise(resolve => {resolveConfig = resolve;}) : Promise.reject(new Error('offline'));}});
  vm.runInContext(await readFile('docs/js/buy.js','utf8'), context);
  assert.equal((await f.submit()).prevented, true);
  assert.equal(f.button.disabled, true);
  assert.equal(calls, 1, 'no checkout request before configuration');
  resolveConfig({ok: true, json: async () => ({configured: true, url: 'https://example.supabase.co'})});
  await new Promise(setImmediate);
  assert.equal(f.button.disabled, false);
  await f.submit();
  assert.equal(f.button.disabled, false);
  assert.equal(f.status.dataset.state, 'error');
  assert.match(f.status.textContent, /Checkout could not be reached/);
});
test('sign-in handles a rejected request and re-enables the form without claiming delivery', async () => {
  const f = fixture('signin-form');
  let resolveClient;
  const context = vm.createContext({document: f.document, Intl, URL, URLSearchParams, AbortSignal,
    location: {hostname: 'wavread.com', origin: 'https://wavread.com'},
    FormData: class {get() {return f.field.value;}},
    client: new Promise(resolve => {resolveClient = resolve;})});
  const source = (await readFile('docs/js/beta-auth.js','utf8')).replace('initializeSignIn();\ninitializeDashboard();','');
  vm.runInContext(source+'\ncreateBetaClient = () => client; initializeSignIn();',context);
  assert.equal((await f.submit()).prevented, true);
  assert.equal(f.button.disabled, true);
  resolveClient({auth: {getSession: async () => ({data: {session: null}}), signInWithOtp: async () => {throw new Error('offline');}}});
  await new Promise(setImmediate);
  assert.equal(f.button.disabled, false);
  await f.submit();
  assert.equal(f.button.disabled, false);
  assert.equal(f.status.dataset.state, 'error');
  assert.match(f.status.textContent, /Could not reach sign-in/);
});
test('public email forms are disabled before scripts initialize and never default to GET', async () => {
  for (const [file,id] of [['buy','checkout-form'],['signin','signin-form']]) {
    const html = await readFile(`docs/${file}.html`, 'utf8');
    const form = html.match(new RegExp(`<form[^>]+id="${id}"[\\s\\S]*?</form>`))?.[0];
    assert.ok(form); assert.match(form, /method="post"/); assert.match(form, /type="submit" disabled/);
    assert.match(html, /<noscript>/);
  }
});
