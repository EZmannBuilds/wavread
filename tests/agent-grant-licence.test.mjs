import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAgentGrant } from '../supabase/functions/agent-grant-licence/handler.mjs';

const SECRET = 'a'.repeat(24) + '0123456789abcdef0123456789abcdef';
const normalizeEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? e.trim().toLowerCase() : null;

// A service client that remembers what it was asked, and grants the way
// agent_grant_licence does: once per address, then "already owned".
function harness({ secret = SECRET, createError = null, grantError = null, grantThrows = false } = {}) {
  const calls = [];
  const logs = [];
  const users = new Set();
  const owned = new Set();
  const admin = {
    auth: { admin: { createUser: async (args) => {
      calls.push(['createUser', args]);
      if (createError) return { error: createError };
      if (users.has(args.email)) return { error: { code: 'email_exists' } };
      users.add(args.email);
      return { data: { user: { id: 'new-user' } }, error: null };
    } } },
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (grantThrows) throw new Error('network down');
      if (grantError) return { data: null, error: grantError };
      const already = owned.has(args.recipient_email);
      owned.add(args.recipient_email);
      return { data: { email: args.recipient_email, already_owned: already, granted: !already, requester: args.requester }, error: null };
    },
  };
  const deps = { secret, admin, json: (_, status, body) => ({ status, body }), readJson: async (r) => { try { return await r.json(); } catch { return null; } },
    normalizeEmail, log: (...line) => logs.push(line.join(' ')) };
  const run = (body, { auth = `Bearer ${SECRET}`, method = 'POST' } = {}) => handleAgentGrant(new Request('https://example.test/agent-grant-licence', {
    method, headers: auth === null ? {} : { Authorization: auth }, body: method === 'POST' ? JSON.stringify(body) : undefined,
  }), deps);
  return { calls, logs, run };
}

const contact = { email: ' Contact@Example.com ', requester: ' product-manager ', reason: ' Said yes on the evidence-sprint call ' };

test('a missing or wrong secret is refused before anything is created', async () => {
  for (const auth of [null, '', 'Bearer', `Bearer ${SECRET.slice(0, -1)}`, `Bearer ${SECRET}x`, `Basic ${SECRET}`, SECRET, `Bearer ${SECRET} extra`]) {
    const h = harness();
    const r = await h.run(contact, { auth });
    assert.equal(r.status, 401, `refused: ${JSON.stringify(auth)}`);
    assert.deepEqual(h.calls, [], 'no identity and no grant');
  }
});

test('with no secret configured, nobody gets in — not even with an empty bearer', async () => {
  for (const secret of ['', null, 'short-secret']) {
    const h = harness({ secret });
    for (const auth of [null, 'Bearer ', `Bearer ${secret ?? ''}`]) {
      const r = await h.run(contact, { auth });
      assert.equal(r.status, 503);
      assert.deepEqual(h.calls, []);
    }
  }
});

test('POST only', async () => {
  const h = harness();
  assert.equal((await h.run(null, { method: 'GET' })).status, 405);
  assert.equal((await h.run(null, { method: 'OPTIONS' })).status, 405);
  assert.deepEqual(h.calls, []);
});

test('an email, a requester and a reason are all required', async () => {
  for (const body of [
    { requester: 'sales', reason: 'yes' },
    { email: 'not-an-email', requester: 'sales', reason: 'yes' },
    { email: 'contact@example.com', requester: 'sales' },
    { email: 'contact@example.com', requester: 'sales', reason: '   ' },
    { email: 'contact@example.com', requester: 'sales', reason: 7 },
    { email: 'contact@example.com', requester: 'sales', reason: 'x'.repeat(501) },
    { email: 'contact@example.com', reason: 'yes' },
    { email: 'contact@example.com', requester: '', reason: 'yes' },
    { email: 'contact@example.com', requester: 'x'.repeat(65), reason: 'yes' },
    null,
  ]) {
    const h = harness();
    const r = await h.run(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(h.calls, [], 'a bad request creates nothing');
  }
});

test('grants: one identity, one service-role grant, no email; the second time it is already owned', async () => {
  const h = harness();
  const first = await h.run(contact);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { email: 'contact@example.com', already_owned: false, granted: true, signin_url: 'https://wavread.com/signin', email_sent: false });
  assert.deepEqual(h.calls, [
    ['createUser', { email: 'contact@example.com', email_confirm: false }],
    ['agent_grant_licence_service', { recipient_email: 'contact@example.com', requester: 'product-manager', reason: 'Said yes on the evidence-sprint call' }],
  ]);

  const second = await h.run({ ...contact, requester: 'support' });
  assert.equal(second.status, 200, 'an existing sign-in identity is not an error');
  assert.equal(second.body.already_owned, true);
  assert.equal(second.body.granted, false);
  assert.equal(second.body.email_sent, false);
  assert.equal(h.calls.length, 4);
});

test('failures never claim a licence, and map to what the caller should do', async () => {
  let h = harness({ createError: { code: 'unexpected_failure', status: 500 } });
  let r = await h.run(contact);
  assert.equal(r.status, 503);
  assert.deepEqual(h.calls.map((c) => c[0]), ['createUser'], 'no grant without an identity');

  for (const [code, status] of [['22023', 409], ['23505', 409], ['53400', 429], ['42501', 503], ['PGRST202', 503], [undefined, 503]]) {
    h = harness({ grantError: { code, message: 'from the database' } });
    r = await h.run(contact);
    assert.equal(r.status, status, `rpc error ${code}`);
    assert.equal(r.body.granted, undefined);
    assert.ok(!JSON.stringify(r.body).includes('from the database'), 'database text stays in the function');
  }

  h = harness({ grantThrows: true });
  r = await h.run(contact);
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes('network down'));
});

test('the secret appears in no response and no log line', async () => {
  const h = harness({ grantError: { code: '42501' } });
  const responses = [await h.run(contact), await h.run(contact, { auth: 'Bearer wrong' }), await h.run({})];
  const bad = harness({ createError: { code: 'unexpected_failure' } });
  responses.push(await bad.run(contact));
  for (const text of [...responses.map((r) => JSON.stringify(r.body)), ...h.logs, ...bad.logs]) {
    assert.ok(!text.includes(SECRET), text);
  }
  assert.ok(h.logs.length > 0 && bad.logs.length > 0, 'failures are logged, by code');
});

test('the function sends no mail, touches no payment and reads its secret from the environment', () => {
  const handler = readFileSync('supabase/functions/agent-grant-licence/handler.mjs', 'utf8');
  const index = readFileSync('supabase/functions/agent-grant-licence/index.ts', 'utf8');
  const code = (source) => source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  for (const source of [handler, index]) {
    assert.doesNotMatch(code(source), /stripe|purchases|inviteUserByEmail|signInWithOtp|generateLink|resend|affiliate/i);
  }
  assert.match(index, /Deno\.env\.get\('OWNER_GRANT_SECRET'\)/);
  assert.match(index, /serviceClient\(\)/);
  assert.doesNotMatch(index, /SUPABASE_ANON_KEY/, 'no client-JWT path into the grant');
});

test('the gateway leaves authentication to the function', () => {
  const config = readFileSync('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.agent-grant-licence\]\nverify_jwt = false\n/);
  assert.doesNotMatch(config, /\[functions\.grant-licence\]\nverify_jwt = false/, "the owner's grant-licence keeps its JWT check");
});

test('agent grants are recorded under the owner id owner_can_grant pins, and owner_can_grant is untouched', () => {
  const owner = readFileSync('supabase/migrations/20260911002958_owner_licence_grants.sql', 'utf8')
    .match(/auth\.uid\(\) = '([0-9a-f-]{36})'::uuid/)?.[1];
  const agent = readFileSync('supabase/migrations/20261027150000_agent_licence_grants.sql', 'utf8');
  assert.ok(owner);
  assert.equal(agent.match(/owner_id constant uuid := '([0-9a-f-]{36})'/)?.[1], owner);
  const code = agent.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /owner_can_grant/, 'the agent path neither calls nor redefines it');
  const grantees = [...code.matchAll(/grant execute on function ([\w.]+)\([^)]*\) to ([^;]+);/gi)].map((m) => [m[1], m[2].trim()]);
  assert.deepEqual(grantees, [['wavread_private.agent_grant_licence', 'service_role'], ['public.agent_grant_licence_service', 'service_role']],
    'the service role, and no client role, may execute either function');
  assert.equal([...code.matchAll(/^\s*grant /gim)].length, 2, 'and nothing else here is granted to anyone');
});
