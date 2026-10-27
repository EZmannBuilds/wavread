// The agent licence-grant migration, run for real. Every migration in
// supabase/migrations is applied in order to a throwaway local Postgres, with
// the few Supabase pieces they rely on stubbed below, and agent_grant_licence
// is exercised as the roles that could try to call it: anon, a signed-in
// stranger, the owner's own session, and the service role.
//
// The same approach as tests/affiliates-db.test.mjs, and nothing here touches
// a hosted database: the cluster lives in a temporary directory, listens on a
// Unix socket only, and is deleted afterwards.
//
// Skipped where it cannot run: no Postgres server binaries on this machine
// (set PG_BIN to their directory if they are somewhere unusual), or running as
// root, which initdb refuses.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function postgresBin() {
  const dirs = [process.env.PG_BIN, ...(process.env.PATH ?? '').split(':')];
  for (const root of ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt']) {
    try {
      for (const name of readdirSync(root).sort().reverse()) {
        if (/^(\d+|postgresql(@\d+)?)$/.test(name)) dirs.push(join(root, name, 'bin'));
      }
    } catch { /* not there */ }
  }
  return dirs.find((dir) => dir && ['initdb', 'pg_ctl', 'psql'].every((tool) => existsSync(join(dir, tool))));
}

const bin = postgresBin();
const skip = !bin ? 'no Postgres server binaries found (set PG_BIN)'
  : process.getuid?.() === 0 ? 'initdb refuses to run as root'
  : false;

// What the migrations expect Supabase to provide. auth.uid() and auth.jwt()
// read the same request.jwt.claims setting Supabase's own do.
const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create schema extensions;
grant usage on schema auth, public to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users (id));
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id), name text, owner uuid);
alter table storage.objects enable row level security;
`;

// Two early migrations check that exactly one build is published and that its
// file exists, so the history needs one before they run.
const PUBLISHED_BUILD = `
insert into public.builds (version, channel, file_name, storage_path, sha256, size_bytes, published)
values ('1.4.49', 'early', 'WavRead-1.4.49.dmg', '1.4.49/WavRead-1.4.49.dmg', repeat('a', 64), 1, true);
insert into storage.objects (bucket_id, name) values ('builds', '1.4.49/WavRead-1.4.49.dmg');
`;

// The owner is whoever owner_can_grant() pins. Read from that migration rather
// than repeated here, so this file names nobody.
const grants = readFileSync('supabase/migrations/20260911002958_owner_licence_grants.sql', 'utf8');
const OWNER_ID = grants.match(/auth\.uid\(\) = '([0-9a-f-]{36})'::uuid/)?.[1];
const OWNER_EMAIL = grants.match(/lower\(u\.email\)='([^']+)'/)?.[1];
const OWNER_SESSION = '00000000-0000-4000-8000-0000000000a1';
const STRANGER_ID = '00000000-0000-4000-8000-000000000002';
const STRANGER_SESSION = '00000000-0000-4000-8000-0000000000a2';

const OWNER = { role: 'authenticated', claims: { sub: OWNER_ID, session_id: OWNER_SESSION } };
const STRANGER = { role: 'authenticated', claims: { sub: STRANGER_ID, session_id: STRANGER_SESSION } };
const OWNER_WITHOUT_SESSION = { role: 'authenticated', claims: { sub: OWNER_ID, session_id: '00000000-0000-4000-8000-0000000000ff' } };
const ANON = { role: 'anon', claims: {} };
const SERVICE = { role: 'service_role', claims: {} };

let dir;
let connection;
let unavailable = skip;

function psql(script) {
  const result = spawnSync(join(bin, 'psql'),
    [...connection, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '-'],
    { input: script, encoding: 'utf8' });
  if (result.status !== 0) {
    return { error: { code: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1], message: result.stderr } };
  }
  return { out: result.stdout.trim() };
}

// One statement, as one caller (or as the database owner when `who` is null),
// in its own transaction. Answers the parsed JSON of a single-value result, or
// { error: { code } }.
function as(who, statement) {
  const prefix = who
    ? `set local role ${who.role};\nset local request.jwt.claims = '${JSON.stringify(who.claims)}';\n`
    : '';
  const result = psql(`begin;\n${prefix}${statement};\ncommit;\n`);
  if (result.error) return result;
  return result.out === '' ? null : JSON.parse(result.out);
}

const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
const grant = (who, email, requester = 'sales', reason = 'Said yes on the call') =>
  as(who, `select public.agent_grant_licence_service(${quote(email)}, ${quote(requester)}, ${quote(reason)})`);
// A sign-in identity, as agent-grant-licence's createUser makes one.
let users = 0;
const identity = (email) => {
  const id = `00000000-0000-4000-9000-${String(++users).padStart(12, '0')}`;
  assert.ok(!psql(`insert into auth.users values (${quote(id)}, ${quote(email)}, null)`).error);
  return id;
};
// Everything the database holds about an address, read as its owner.
const state = (email) => as(null, `select jsonb_build_object(
    'account', (select to_jsonb(a) from public.accounts a where a.email = ${quote(email)}),
    'entitlements', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]') from public.entitlements e
      join public.accounts a using (tester_id) where a.email = ${quote(email)}),
    'grants', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]') from wavread_private.licence_grants g
      where g.recipient_email = ${quote(email)}),
    'log', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]') from wavread_private.agent_licence_grant_log l
      where l.recipient_email = ${quote(email)}))`);

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'wavread-pg-'));
  const init = spawnSync(join(bin, 'initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8' });
  const start = init.status === 0 && spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'log'), '-w', 'start',
    '-o', `-k ${dir} -c listen_addresses= -p 5432 -c fsync=off`], { encoding: 'utf8' });
  if (start?.status !== 0) {
    unavailable = `local Postgres did not start: ${(init.stderr || start?.stderr || '').trim().split('\n')[0]}`;
    return;
  }
  unavailable = false;
  connection = ['-h', dir, '-p', '5432', '-U', 'postgres', '-d', 'postgres'];

  assert.ok(!psql(SUPABASE_STUBS).error, 'the Supabase stubs load');
  for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const applied = psql(readFileSync(join('supabase/migrations', file), 'utf8'));
    assert.ok(!applied.error, `${file} applies: ${applied.error?.message}`);
    if (file.startsWith('20260827150000')) assert.ok(!psql(PUBLISHED_BUILD).error);
  }

  assert.ok(OWNER_ID && OWNER_EMAIL, 'the owner identity is read from the licence-grant migration');
  const people = psql(`
    insert into auth.users values (${quote(OWNER_ID)}, ${quote(OWNER_EMAIL)}, now()),
                                  (${quote(STRANGER_ID)}, 'stranger@example.net', now());
    insert into auth.sessions values (${quote(OWNER_SESSION)}, ${quote(OWNER_ID)}),
                                     (${quote(STRANGER_SESSION)}, ${quote(STRANGER_ID)});
    insert into public.accounts (email, status, auth_user_id)
    values (${quote(OWNER_EMAIL)}, 'active', ${quote(OWNER_ID)}),
           ('stranger@example.net', 'active', ${quote(STRANGER_ID)});`);
  assert.ok(!people.error, people.error?.message);
});

function dbTest(name, body) {
  test(name, { skip }, (t) => (unavailable ? t.skip(unavailable) : body()));
}

after(() => {
  if (!dir) return;
  spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(dir, { recursive: true, force: true });
});

dbTest('no client role can grant through the agent path or read its log — not even the owner', () => {
  identity('blocked@example.net');
  for (const [who, name] of [[ANON, 'anon'], [STRANGER, 'a signed-in stranger'], [OWNER, "the owner's live session"], [OWNER_WITHOUT_SESSION, 'the owner id without a session']]) {
    assert.equal(grant(who, 'blocked@example.net').error?.code, '42501', `${name} cannot call the service entrypoint`);
    assert.equal(as(who, "select wavread_private.agent_grant_licence('blocked@example.net', 'sales', 'yes')").error?.code, '42501',
      `${name} cannot call the private function`);
    assert.equal(as(who, 'select count(*) from wavread_private.agent_licence_grant_log').error?.code, '42501', `${name} cannot read the log`);
    assert.equal(as(who, "insert into wavread_private.agent_licence_grant_log (recipient_email, requester, reason) values ('x@example.net', 'sales', 'yes')").error?.code,
      '42501', `${name} cannot write the log`);
  }
  const left = state('blocked@example.net');
  assert.equal(left.account, null, 'the refused calls created no account');
  assert.deepEqual(left.log, []);
});

dbTest('the service role grants once; asking again finds it owned and grants nothing more', () => {
  const user = identity('contact@example.net');
  assert.deepEqual(grant(SERVICE, ' Contact@Example.NET ', ' product-manager ', ' Said yes on the evidence-sprint call '),
    { email: 'contact@example.net', already_owned: false, granted: true, requester: 'product-manager' });

  let held = state('contact@example.net');
  assert.equal(held.account.status, 'active');
  assert.equal(held.account.auth_user_id, user, 'the account is bound to the sign-in identity');
  assert.equal(held.entitlements.length, 1);
  const [licence] = held.entitlements;
  assert.deepEqual([licence.entitlement, licence.source, licence.build_version, licence.revoked_at], ['early_build', 'grant', null, null],
    'a full, unscoped licence, the same an owner grant gives');
  assert.equal(held.grants.length, 1);
  assert.equal(held.grants[0].actor_id, OWNER_ID, "recorded under the owner owner_can_grant pins");
  assert.equal(held.grants[0].entitlement_id, licence.id);
  assert.equal(held.log.length, 1);
  assert.deepEqual([held.log[0].requester, held.log[0].reason, held.log[0].entitlement_id, held.log[0].already_owned],
    ['product-manager', 'Said yes on the evidence-sprint call', licence.id, false]);

  assert.deepEqual(grant(SERVICE, 'contact@example.net', 'support', 'Asked again by mistake'),
    { email: 'contact@example.net', already_owned: true, granted: false, requester: 'support' });
  held = state('contact@example.net');
  assert.equal(held.entitlements.length, 1, 'no second licence');
  assert.equal(held.grants.length, 1, 'no second grant record');
  assert.equal(held.log.length, 2, 'but the request is logged');
  assert.deepEqual([held.log[1].requester, held.log[1].entitlement_id, held.log[1].already_owned], ['support', licence.id, true]);

  assert.equal(as(null, `select to_jsonb(public.has_build_access(${quote(held.account.tester_id)}, (select id from public.builds order by id limit 1)))`), true,
    'the grant opens the download, by the one access rule');
});

dbTest("the owner's controls treat an agent's grant as their own", () => {
  identity('revocable@example.net');
  assert.equal(grant(SERVICE, 'revocable@example.net').granted, true);
  const looked = as(OWNER, "select public.owner_manage_licence('revocable@example.net', 'lookup')");
  assert.equal(looked.licences.length, 1);
  assert.equal(looked.licences[0].owner_grant, true);

  const revoked = as(OWNER, "select public.owner_manage_licence('revocable@example.net', 'revoke')");
  assert.notEqual(revoked.licences[0].revoked_at, null, 'the owner can revoke it');
  assert.equal(grant(SERVICE, 'revocable@example.net').granted, true, 'a revoked licence is not owned, so an agent can grant again');
  assert.equal(state('revocable@example.net').grants.length, 2);
});

dbTest('contributor standing and a purchase both count as owned', () => {
  identity('standing@example.net');
  assert.ok(!psql("insert into public.accounts (email, status, free_updates, free_updates_note) values ('standing@example.net', 'active', true, 'test')").error);
  assert.equal(grant(SERVICE, 'standing@example.net').already_owned, true);
  let held = state('standing@example.net');
  assert.deepEqual(held.entitlements, []);
  assert.equal(held.log[0].entitlement_id, null);

  identity('buyer@example.net');
  assert.ok(!psql(`insert into public.accounts (email, status) values ('buyer@example.net', 'active');
    insert into public.entitlements (tester_id, entitlement, source)
    select tester_id, 'early_build', 'purchase' from public.accounts where email = 'buyer@example.net'`).error);
  assert.equal(grant(SERVICE, 'buyer@example.net').already_owned, true);
  held = state('buyer@example.net');
  assert.equal(held.entitlements.length, 1, 'the purchase is left as it was');
  assert.equal(held.entitlements[0].source, 'purchase');
  assert.deepEqual(held.grants, []);
  assert.equal(held.log[0].entitlement_id, held.entitlements[0].id);
});

dbTest('refuses what grant_licence refuses, and a bad request writes nothing', () => {
  assert.equal(grant(SERVICE, 'nobody@example.net').error?.code, '22023', 'no sign-in identity yet');
  assert.equal(state('nobody@example.net').account, null);

  identity('paused@example.net');
  assert.ok(!psql("insert into public.accounts (email, status) values ('paused@example.net', 'paused')").error);
  assert.equal(grant(SERVICE, 'paused@example.net').error?.code, '22023', 'an inactive account');

  identity('fields@example.net');
  for (const [email, requester, reason] of [
    ['not-an-email', 'sales', 'yes'],
    ['fields@example.net', '', 'yes'],
    ['fields@example.net', '   ', 'yes'],
    ['fields@example.net', 'x'.repeat(65), 'yes'],
    ['fields@example.net', 'sales', ''],
    ['fields@example.net', 'sales', 'x'.repeat(501)],
  ]) {
    assert.equal(grant(SERVICE, email, requester, reason).error?.code, '22023', JSON.stringify([email, requester, reason.length]));
  }
  assert.equal(as(SERVICE, 'select public.agent_grant_licence_service(null, null, null)').error?.code, '22023');

  for (const email of ['paused@example.net', 'fields@example.net']) {
    const held = state(email);
    assert.deepEqual([held.entitlements, held.grants, held.log], [[], [], []], `${email}: nothing written`);
  }
});

dbTest('an account bound to another sign-in is refused', () => {
  identity('rebound@example.net');
  assert.ok(!psql(`insert into auth.users values ('00000000-0000-4000-9000-ffffffffffff', 'elsewhere@example.net', null);
    insert into public.accounts (email, status, auth_user_id) values ('rebound@example.net', 'active', '00000000-0000-4000-9000-ffffffffffff')`).error);
  assert.equal(grant(SERVICE, 'rebound@example.net').error?.code, '22023');
  assert.deepEqual(state('rebound@example.net').entitlements, []);
});

dbTest('at most twenty requests an hour, across every agent', () => {
  const recent = as(null, "select count(*) from wavread_private.agent_licence_grant_log where created_at > now() - interval '1 hour'");
  assert.ok(!psql(`insert into wavread_private.agent_licence_grant_log (recipient_email, requester, reason)
    select 'filler@example.net', 'filler', 'filler' from generate_series(1, ${20 - recent})`).error);
  identity('burst@example.net');
  assert.equal(grant(SERVICE, 'burst@example.net').error?.code, '53400', 'the twenty-first is refused');
  assert.equal(state('burst@example.net').account, null, 'and wrote nothing');

  assert.ok(!psql("update wavread_private.agent_licence_grant_log set created_at = now() - interval '61 minutes'").error);
  assert.equal(grant(SERVICE, 'burst@example.net').granted, true, 'an hour later there is room again');
  assert.ok(!psql("delete from wavread_private.agent_licence_grant_log where requester = 'filler'").error);
});

dbTest("the owner's own grant is unchanged: owner_can_grant still decides it", () => {
  identity('owner-grant@example.net');
  for (const who of [STRANGER, OWNER_WITHOUT_SESSION, SERVICE, ANON]) {
    assert.equal(as(who, "select public.owner_grant_licence('owner-grant@example.net')").error?.code, '42501');
  }
  assert.equal(as(OWNER, "select public.owner_grant_licence('owner-grant@example.net')").granted, true);
  assert.equal(as(null, 'select to_jsonb(wavread_private.owner_can_grant())'), false, 'nobody signed in is not the owner');
});
