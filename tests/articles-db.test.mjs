// The profiles and article submissions migration, run for real. Every
// migration in supabase/migrations is applied in order to a throwaway local
// Postgres, with the Supabase pieces they rely on stubbed, and the new tables
// and functions are exercised as the roles that will use them: anon, a writer,
// another writer, and the service role.
//
// The harness is the one tests/affiliates-db.test.mjs uses. Nothing here
// touches a hosted database: the cluster lives in a temporary directory,
// listens on a Unix socket only, and is deleted afterwards. Skipped where it
// cannot run: no Postgres server binaries (set PG_BIN), or running as root,
// which initdb refuses.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATUSES, canTransition } from '../supabase/functions/_shared/submissions.mjs';
import { RESERVED_SLUGS } from '../docs/js/account-client.js';
import { COMPLETE } from './fixtures/article.mjs';

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

// What the migrations expect Supabase to provide, as in affiliates-db, plus the
// password column the password-status function reads.
const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create schema extensions;
grant usage on schema auth, public to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, encrypted_password text default '');
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

const PUBLISHED_BUILD = `
insert into public.builds (version, channel, file_name, storage_path, sha256, size_bytes, published)
values ('1.4.49', 'early', 'WavRead-1.4.49.dmg', '1.4.49/WavRead-1.4.49.dmg', repeat('a', 64), 1, true);
insert into storage.objects (bucket_id, name) values ('builds', '1.4.49/WavRead-1.4.49.dmg');
`;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WRITER = { role: 'authenticated', claims: { sub: id(1) } };
const OTHER = { role: 'authenticated', claims: { sub: id(2) } };
const NEWCOMER = { role: 'authenticated', claims: { sub: id(3) } };
const UNCONFIRMED = { role: 'authenticated', claims: { sub: id(4) } };
const BUYER = { role: 'authenticated', claims: { sub: id(5) } };
const CLASHING = { role: 'authenticated', claims: { sub: id(6) } };
const CAPPED = { role: 'authenticated', claims: { sub: id(7) } };
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

// One statement, as one caller, in its own transaction. Answers the parsed JSON
// of a single-value result, null for no output, or { error: { code } }.
function as(who, statement) {
  const prefix = who
    ? `set local role ${who.role};\nset local request.jwt.claims = '${JSON.stringify(who.claims)}';\n`
    : '';
  const result = psql(`begin;\n${prefix}${statement};\ncommit;\n`);
  if (result.error) return result;
  return result.out === '' ? null : JSON.parse(result.out);
}

const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
const lanes = (list) => `array[${list.map(quote).join(',')}]::text[]`;
const testerOf = (email) => `(select tester_id from public.accounts where email = ${quote(email)})`;

// A complete draft by `who`, as the editor's save writes one. Answers its id.
function draft(who, email, fields = COMPLETE) {
  const row = as(who, `insert into public.article_submissions (author_tester_id, title, summary, lanes, body_markdown)
    values (${testerOf(email)}, ${quote(fields.title)}, ${quote(fields.summary)}, ${lanes(fields.lanes)}, ${quote(fields.body_markdown)})
    returning to_jsonb(id)`);
  assert.ok(typeof row === 'string', `draft inserted: ${row?.error?.message}`);
  return row;
}
const statusOf = (submission) => as(SERVICE, `select to_jsonb(status) from public.article_submissions where id = ${quote(submission)}`);
const setStatus = (who, submission, status) =>
  as(who, `with changed as (update public.article_submissions set status = ${quote(status)} where id = ${quote(submission)} returning 1)
    select to_jsonb(count(*)) from changed`);
const publish = (who, submission, slug, markdown = '---\ntitle: "x"\n---\n\nbody\n') =>
  as(who, `select public.publish_approved_submission(${quote(submission)}, ${quote(slug)}, ${quote(markdown)})`);

// The way to each status, as the service role takes it (publishing through the
// one function that may).
const PATHS = {
  draft: [], pending: ['pending'], needs_changes: ['pending', 'needs_changes'], approved: ['pending', 'approved'],
  rejected: ['pending', 'rejected'], published: ['pending', 'approved', 'published'],
};
let slugs = 0;
// Removes a row the matrix made, as the database owner, so the rows it walks
// through never count against the writer's caps.
const discard = (submission) => psql(`delete from public.article_publish_queue where submission_id = ${quote(submission)};
  delete from public.article_submissions where id = ${quote(submission)};`);
function inStatus(status) {
  const submission = draft(WRITER, 'writer@example.net');
  for (const step of PATHS[status]) {
    const moved = step === 'published' ? publish(SERVICE, submission, `matrix-post-${++slugs}`) : setStatus(SERVICE, submission, step);
    assert.ok(!moved?.error, `reaching ${status}: ${moved?.error?.message}`);
  }
  assert.equal(statusOf(submission), status);
  return submission;
}

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
  // bound@ has an account already bound to a different sign-in (id 8), which
  // is the case ensure_my_account must refuse rather than rebind.
  const people = psql(`
    insert into auth.users (id, email, email_confirmed_at, encrypted_password) values
      (${quote(id(1))}, 'writer@example.net', now(), '$2a$10$hash'),
      (${quote(id(2))}, 'other@example.net', now(), ''),
      (${quote(id(3))}, 'newcomer@example.net', now(), null),
      (${quote(id(4))}, 'unconfirmed@example.net', null, '$2a$10$hash'),
      (${quote(id(5))}, 'Buyer@Example.net', now(), ''),
      (${quote(id(6))}, 'bound@example.net', now(), ''),
      (${quote(id(7))}, 'capped@example.net', now(), ''),
      (${quote(id(8))}, 'someone-else@example.net', now(), '');
    insert into public.accounts (email, status, auth_user_id) values
      ('writer@example.net', 'active', ${quote(id(1))}),
      ('other@example.net', 'active', ${quote(id(2))}),
      ('capped@example.net', 'active', ${quote(id(7))}),
      ('buyer@example.net', 'active', null),
      ('bound@example.net', 'active', ${quote(id(8))});`);
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

dbTest('a writer starts drafts for themself only, and a draft starts as a draft', () => {
  const mine = draft(WRITER, 'writer@example.net', { title: '', summary: '', lanes: [], body_markdown: '' });
  assert.equal(statusOf(mine), 'draft', 'an empty draft is allowed');
  const forOther = as(WRITER, `insert into public.article_submissions (author_tester_id, title) values (${testerOf('other@example.net')}, 'Mine now')`);
  assert.equal(forOther.error?.code, '42501', 'not in someone else\'s name');
  const asPending = as(WRITER, `insert into public.article_submissions (author_tester_id, status) values (${testerOf('writer@example.net')}, 'pending')`);
  assert.equal(asPending.error?.code, '42501', 'status is not a column a writer inserts');
  const withNotes = as(WRITER, `insert into public.article_submissions (author_tester_id, reviewer_notes) values (${testerOf('writer@example.net')}, 'Approved by me')`);
  assert.equal(withNotes.error?.code, '42501');
  assert.equal(as(ANON, `insert into public.article_submissions (author_tester_id) values (${testerOf('writer@example.net')})`).error?.code, '42501');
  assert.equal(as(SERVICE, `insert into public.article_submissions (author_tester_id, status) values (${testerOf('writer@example.net')}, 'approved')`).error?.code, '55000',
    'not even the service role creates an article past draft');
});

dbTest('writers see only their own articles, and nobody else sees drafts', () => {
  const mine = draft(WRITER, 'writer@example.net');
  assert.equal(as(OTHER, `select to_jsonb(count(*)) from public.article_submissions where id = ${quote(mine)}`), 0);
  assert.equal(as(ANON, 'select to_jsonb(count(*)) from public.article_submissions').error?.code, '42501');
  assert.equal(as(OTHER, `with changed as (update public.article_submissions set title = 'Mine now' where id = ${quote(mine)} returning 1) select to_jsonb(count(*)) from changed`), 0);
  assert.equal(as(OTHER, `with gone as (delete from public.article_submissions where id = ${quote(mine)} returning 1) select to_jsonb(count(*)) from gone`), 0);
  assert.equal(statusOf(mine), 'draft');
});

dbTest('a writer submits a complete draft, and cannot decide anything about it', () => {
  const unfinished = draft(WRITER, 'writer@example.net', { title: 'Short', summary: 'Too short.', lanes: [], body_markdown: 'Short.' });
  assert.equal(setStatus(WRITER, unfinished, 'pending').error?.code, '23514', 'the database refuses an incomplete submission too');

  const mine = draft(WRITER, 'writer@example.net');
  // The trigger refuses the move (55000) before RLS's check would (42501);
  // either way it does not happen.
  for (const decision of ['approved', 'needs_changes', 'rejected', 'published']) {
    assert.ok(['42501', '55000'].includes(setStatus(WRITER, mine, decision).error?.code), `a writer cannot mark their own article ${decision}`);
  }
  assert.equal(statusOf(mine), 'draft');
  assert.equal(as(WRITER, `update public.article_submissions set reviewer_notes = 'Looks great' where id = ${quote(mine)}`).error?.code, '42501');
  assert.equal(as(WRITER, `update public.article_submissions set published_slug = 'mine' where id = ${quote(mine)}`).error?.code, '42501');

  assert.equal(setStatus(WRITER, mine, 'pending'), 1);
  const row = as(SERVICE, `select jsonb_build_object('status', status, 'submitted', submitted_at is not null) from public.article_submissions where id = ${quote(mine)}`);
  assert.deepEqual(row, { status: 'pending', submitted: true }, 'submitted_at is stamped by the database');
  assert.equal(as(WRITER, `with changed as (update public.article_submissions set title = 'Edited while pending' where id = ${quote(mine)} returning 1) select to_jsonb(count(*)) from changed`), 0,
    'a pending article is out of the writer\'s reach');
  assert.equal(as(WRITER, `with gone as (delete from public.article_submissions where id = ${quote(mine)} returning 1) select to_jsonb(count(*)) from gone`), 0,
    'and cannot be deleted from under the reviewer');
});

dbTest('approving does not publish; only publish_approved_submission does, and only from approved', () => {
  const mine = draft(WRITER, 'writer@example.net');
  setStatus(WRITER, mine, 'pending');
  assert.equal(setStatus(SERVICE, mine, 'published').error?.code, '55000', 'pending cannot jump to published');
  assert.equal(publish(SERVICE, mine, 'too-early').error?.code, '55000', 'the publish function refuses a pending article');
  assert.equal(setStatus(SERVICE, mine, 'approved'), 1);
  const approved = as(SERVICE, `select jsonb_build_object('status', status, 'path', published_path, 'reviewed', reviewed_at is not null,
      'queued', (select count(*) from public.article_publish_queue q where q.submission_id = s.id))
    from public.article_submissions s where id = ${quote(mine)}`);
  assert.deepEqual(approved, { status: 'approved', path: null, reviewed: true, queued: 0 }, 'approved, and nothing written');

  assert.equal(setStatus(SERVICE, mine, 'published').error?.code, '23514', 'a bare status change cannot fake a publish: it has no path');
  for (const who of [WRITER, ANON]) {
    assert.equal(publish(who, mine, 'by-the-writer').error?.code, '42501', 'only the service role may call the publish function');
  }
  assert.deepEqual(publish(SERVICE, mine, 'a-published-post'),
    { id: mine, slug: 'a-published-post', path: 'content/articles/community/a-published-post.md' });
  const published = as(SERVICE, `select jsonb_build_object('status', status, 'path', published_path, 'at', published_at is not null,
      'markdown', (select markdown from public.article_publish_queue q where q.submission_id = s.id))
    from public.article_submissions s where id = ${quote(mine)}`);
  assert.equal(published.status, 'published');
  assert.equal(published.path, 'content/articles/community/a-published-post.md');
  assert.equal(published.at, true);
  assert.match(published.markdown, /^---/);
  assert.equal(publish(SERVICE, mine, 'a-published-post-again').error?.code, '55000', 'published once');

  const second = draft(WRITER, 'writer@example.net', { ...COMPLETE, title: 'Another one entirely' });
  setStatus(WRITER, second, 'pending');
  setStatus(SERVICE, second, 'approved');
  assert.equal(publish(SERVICE, second, 'a-published-post').error?.code, '23505', 'a slug is used once');
  assert.equal(publish(SERVICE, second, 'Not A Slug').error?.code, '23514', 'and must be a slug');
  assert.equal(statusOf(second), 'approved', 'a refused publish changes nothing');
});

dbTest('the trigger allows exactly the moves submissions.mjs lists, for writers and the service role', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (to === 'published') continue; // reached only through the publish function, checked above
      const submission = inStatus(from);
      const service = setStatus(SERVICE, submission, to);
      const serviceAllowed = !service?.error && service === 1;
      discard(submission);
      assert.equal(serviceAllowed, canTransition(from, to, 'reviewer'), `service role: ${from} -> ${to} (${service?.error?.code ?? service})`);

      const fresh = inStatus(from);
      const writer = setStatus(WRITER, fresh, to);
      const writerAllowed = !writer?.error && writer === 1;
      discard(fresh);
      assert.equal(writerAllowed, canTransition(from, to, 'author'), `writer: ${from} -> ${to} (${writer?.error?.code ?? writer})`);
    }
  }
});

dbTest('once out of the writer\'s hands, the words are fixed', () => {
  const submission = inStatus('pending');
  assert.equal(as(SERVICE, `update public.article_submissions set body_markdown = body_markdown || ' edited' where id = ${quote(submission)}`).error?.code, '55000');
  setStatus(SERVICE, submission, 'approved');
  assert.equal(as(SERVICE, `update public.article_submissions set title = 'Retitled', status = 'approved' where id = ${quote(submission)}`).error?.code, '55000');
  const back = inStatus('needs_changes');
  assert.equal(as(WRITER, `with changed as (update public.article_submissions set title = 'Fixed', status = 'draft' where id = ${quote(back)} returning 1) select to_jsonb(count(*)) from changed`), 1,
    'sent back with changes requested, it is the writer\'s to edit again');
});

dbTest('a writer can have 5 articles waiting and 25 unfinished, no more', () => {
  const waiting = [];
  for (let n = 0; n < 6; n++) waiting.push(draft(CAPPED, 'capped@example.net'));
  for (const submission of waiting.slice(0, 5)) assert.equal(setStatus(CAPPED, submission, 'pending'), 1);
  assert.equal(setStatus(CAPPED, waiting[5], 'pending').error?.code, '54000');
  for (let n = 6; n < 25; n++) draft(CAPPED, 'capped@example.net', { title: '', summary: '', lanes: [], body_markdown: '' });
  const overflow = as(CAPPED, `insert into public.article_submissions (author_tester_id) values (${testerOf('capped@example.net')})`);
  assert.equal(overflow.error?.code, '54000');
  assert.match(overflow.error.message, /25 unfinished articles/);
  assert.equal(as(CAPPED, `with gone as (delete from public.article_submissions where id = ${quote(waiting[5])} returning 1) select to_jsonb(count(*)) from gone`), 1,
    'a draft can be deleted to make room');
});

dbTest('a holder edits their own profile columns, and nothing else on the account', () => {
  const saved = as(WRITER, `update public.accounts set display_name = 'Jane Doe', bio = 'Mixes in Ableton Live.', public_slug = 'jane-doe'
    where auth_user_id = ${quote(id(1))} returning jsonb_build_object('slug', public_slug, 'stamped', profile_updated_at is not null)`);
  assert.deepEqual(saved, { slug: 'jane-doe', stamped: true }, 'profile_updated_at is stamped by the database');
  for (const column of ["email = 'stolen@example.net'", "status = 'ended'", 'free_updates = true', `auth_user_id = ${quote(id(2))}`, 'profile_updated_at = now()']) {
    assert.equal(as(WRITER, `update public.accounts set ${column} where auth_user_id = ${quote(id(1))}`).error?.code, '42501', column);
  }
  assert.equal(as(OTHER, `with changed as (update public.accounts set display_name = 'Hijacked' where auth_user_id = ${quote(id(1))} returning 1) select to_jsonb(count(*)) from changed`), 0);
  assert.equal(as(OTHER, `update public.accounts set public_slug = 'jane-doe' where auth_user_id = ${quote(id(2))}`).error?.code, '23505', 'a profile address is taken once');
  assert.equal(as(OTHER, `update public.accounts set public_slug = 'Jane Doe' where auth_user_id = ${quote(id(2))}`).error?.code, '23514');
  assert.equal(as(OTHER, `update public.accounts set display_name = '' where auth_user_id = ${quote(id(2))}`).error?.code, '23514', 'no name is null, not empty');
  assert.equal(as(OTHER, `update public.accounts set bio = repeat('x', 1001) where auth_user_id = ${quote(id(2))}`).error?.code, '23514');
  assert.equal(as(ANON, "update public.accounts set display_name = 'Anon'").error?.code, '42501');
});

dbTest('the reserved profile addresses are the ones the account page refuses', () => {
  const migration = readFileSync('supabase/migrations/20261027090000_profiles_and_article_submissions.sql', 'utf8');
  const listed = migration.match(/public_slug <> all \(array\[([\s\S]*?)\]\)/)[1].match(/'([a-z0-9-]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...listed].sort(), [...RESERVED_SLUGS].sort());
  for (const slug of listed) {
    assert.equal(as(OTHER, `update public.accounts set public_slug = ${quote(slug)} where auth_user_id = ${quote(id(2))}`).error?.code, '23514', slug);
  }
});

dbTest('a confirmed sign-in without an account gets a plain one; nothing is ever rebound', () => {
  const created = as(NEWCOMER, 'select public.ensure_my_account()');
  assert.equal(created.created, true);
  const account = as(SERVICE, `select jsonb_build_object('email', email, 'bound', auth_user_id = ${quote(id(3))}, 'status', status,
      'entitlements', (select count(*) from public.entitlements e where e.tester_id = a.tester_id))
    from public.accounts a where email = 'newcomer@example.net'`);
  assert.deepEqual(account, { email: 'newcomer@example.net', bound: true, status: 'active', entitlements: 0 }, 'a writer\'s account owns nothing');
  assert.equal(as(NEWCOMER, 'select public.ensure_my_account()').created, false, 'calling again is harmless');

  const bound = as(BUYER, 'select public.ensure_my_account()');
  assert.deepEqual([bound.created, bound.bound], [false, true], 'an unbound account for the same email is bound, not duplicated');
  assert.equal(as(SERVICE, "select to_jsonb(count(*)) from public.accounts where email = 'buyer@example.net'"), 1);

  assert.equal(as(CLASHING, 'select public.ensure_my_account()').error?.code, '22023', 'an account bound to another sign-in is refused');
  assert.equal(as(UNCONFIRMED, 'select public.ensure_my_account()').error?.code, '55000', 'an unconfirmed email gets nothing');
  assert.equal(as(SERVICE, "select to_jsonb(count(*)) from public.accounts where email = 'unconfirmed@example.net'"), 0);
  assert.equal(as(ANON, 'select public.ensure_my_account()').error?.code, '42501');
});

dbTest('the password question answers only about the caller', () => {
  assert.equal(as(WRITER, 'select to_jsonb(public.account_password_status())'), true);
  assert.equal(as(OTHER, 'select to_jsonb(public.account_password_status())'), false, 'an email-link account has no password');
  assert.equal(as(NEWCOMER, 'select to_jsonb(public.account_password_status())'), false, 'null is no password');
  assert.equal(as(ANON, 'select to_jsonb(public.account_password_status())').error?.code, '42501');
  assert.equal(as(WRITER, 'select count(*) from auth.users').error?.code, '42501', 'the answer is a boolean, not a window onto auth.users');
});

dbTest('a public profile shows a name, a bio and published titles, and never an email', () => {
  as(WRITER, `update public.accounts set display_name = 'Jane Doe', public_slug = 'jane-doe' where auth_user_id = ${quote(id(1))}`);
  const unpublished = draft(WRITER, 'writer@example.net', { ...COMPLETE, title: 'Still a draft, never shown' });
  const profile = as(ANON, "select public.public_profile(' Jane-Doe ')");
  assert.equal(profile.display_name, 'Jane Doe');
  assert.equal(profile.public_slug, 'jane-doe');
  assert.deepEqual(Object.keys(profile).sort(), ['articles', 'bio', 'display_name', 'public_slug']);
  assert.ok(profile.articles.length >= 1, 'the published post from the earlier test is listed');
  assert.ok(profile.articles.every((a) => a.slug && a.published_at), 'only published articles');
  assert.ok(!profile.articles.some((a) => a.title === 'Still a draft, never shown'));
  assert.deepEqual(Object.keys(profile.articles[0]).sort(), ['lanes', 'published_at', 'slug', 'summary', 'title']);
  assert.doesNotMatch(JSON.stringify(profile), /@example\.net|tester_id|auth_user_id/);
  assert.equal(as(ANON, "select public.public_profile('nobody-here')"), null);
  assert.equal(as(ANON, "select public.public_profile('')"), null, 'an account without an address has no profile');
  assert.ok(unpublished);
});

dbTest('the publish queue is the service role\'s alone', () => {
  for (const who of [ANON, WRITER]) {
    assert.equal(as(who, 'select count(*) from public.article_publish_queue').error?.code, '42501');
  }
  assert.ok(as(SERVICE, 'select to_jsonb(count(*)) from public.article_publish_queue') >= 1);
  assert.equal(as(SERVICE, "update public.article_publish_queue set markdown = 'tampered'").error?.code, '42501', 'the service role marks exports, it does not rewrite files');
  assert.ok(!as(SERVICE, 'update public.article_publish_queue set exported_at = now()')?.error);
});
