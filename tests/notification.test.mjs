import assert from 'node:assert/strict';
import test from 'node:test';
import {createHandler} from '../supabase/functions/notification-signup/handler.mjs';

const req = (body, options = {}) => new Request('https://signup.invalid', {
  method: 'POST', headers: {'origin': 'https://wavread.com', 'content-type': 'application/json'},
  body: JSON.stringify(body), ...options});
const valid = {email: '  Release.Test@EXAMPLE.COM  '};
test('normalizes email, records explicit consent only, and sends keyed rate digests', async () => {
  const calls = [];
  const handler = createHandler({url: 'https://database.invalid', key: 'server-only-test-key',
    fetcher: async (url, options) => {calls.push(JSON.parse(options.body)); return Response.json(true);}});
  assert.equal((await handler(req(valid))).status, 200);
  assert.equal(calls[0].signup_email, 'release.test@example.com');
  assert.equal(calls[0].marketing, false);
  assert.match(calls[0].ip_digest, /^[a-f0-9]{64}$/);
  assert.match(calls[0].email_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(calls[0].ip_digest, calls[0].email_digest);
  assert.equal((await handler(req({...valid, marketing_opt_in: true}))).status, 200);
  assert.equal(calls[1].marketing, true);
});
test('rejects invalid inputs and foreign origins before storage', async () => {
  let called = 0;
  const handler = createHandler({url: 'x', key: 'y', fetcher: () => {called++; throw Error();}});
  for (const body of [{email: ''}, {email: ['a@b.com']}, {email: 'a@b.com', marketing_opt_in: 'true'}, {email: 'a'.repeat(250)+'@b.com'}]) {
    assert.equal((await handler(req(body))).status, 400);
  }
  assert.equal((await handler(req(valid, {headers: {origin: 'https://evil.example', 'content-type': 'application/json'}}))).status, 403);
  assert.equal((await handler(req(valid, {headers: {origin: 'https://wavread.com'}}))).status, 415);
  assert.equal((await handler(req({email: 'x'.repeat(5000)}))).status, 413);
  assert.equal(called, 0);
});
test('preflight only admits WavRead and its precise preview hostnames', async () => {
  const handler = createHandler({});
  for (const origin of ['https://wavread.com', 'https://www.wavread.com', 'https://wavread-abc123-lorehouse-team.vercel.app']) {
    const result = await handler(req(null, {method: 'OPTIONS', body: undefined, headers: {origin}}));
    assert.equal(result.status, 204); assert.equal(result.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal((await handler(req(valid, {headers: {origin: 'https://wavread-evil.vercel.app'}}))).status, 403);
});
test('rate limits and storage failures never produce false success', async () => {
  const make = fetcher => createHandler({url: 'https://database.invalid', key: 'test-key', fetcher});
  assert.equal((await make(async () => Response.json(false))(req(valid))).status, 429);
  assert.equal((await make(async () => Response.json({secret: 'must not leak'}, {status: 500}))(req(valid))).status, 503);
  assert.equal((await make(async () => Response.json({}))(req(valid))).status, 503);
  assert.equal((await createHandler({})(req(valid))).status, 503);
});
