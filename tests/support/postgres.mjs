// A throwaway local Postgres with every migration in supabase/migrations
// applied, for tests that run the SQL for real. The same approach as
// tests/affiliates-db.test.mjs: the few Supabase pieces the migrations rely on
// are stubbed, the cluster lives in a temporary directory, listens on a Unix
// socket only, and is deleted afterwards. Nothing here touches a hosted
// database.
//
// Unavailable (and the tests using it skip, with the reason) where there are no
// Postgres server binaries (set PG_BIN to their directory if they are somewhere
// unusual), when running as root, which initdb refuses, or when the cluster
// will not start.

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

export const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

export function migratedDatabase() {
  const bin = postgresBin();
  const db = {
    unavailable: !bin ? 'no Postgres server binaries found (set PG_BIN)'
      : process.getuid?.() === 0 ? 'initdb refuses to run as root'
      : false,
  };
  let dir;
  let connection;

  db.psql = (script) => {
    const result = spawnSync(join(bin, 'psql'),
      [...connection, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '-'],
      { input: script, encoding: 'utf8' });
    if (result.status !== 0) {
      return { error: { code: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1], message: result.stderr } };
    }
    return { out: result.stdout.trim() };
  };

  // One statement, as one caller ({ role, claims }, or null for the
  // superuser), in its own transaction. Answers the parsed JSON of a
  // single-value result, null for no output, or { error: { code } }.
  db.as = (who, statement) => {
    const prefix = who
      ? `set local role ${who.role};\nset local request.jwt.claims = '${JSON.stringify(who.claims ?? {})}';\n`
      : '';
    const result = db.psql(`begin;\n${prefix}${statement};\ncommit;\n`);
    if (result.error) return result;
    return result.out === '' ? null : JSON.parse(result.out);
  };

  db.start = () => {
    if (db.unavailable) return;
    dir = mkdtempSync(join(tmpdir(), 'wavread-pg-'));
    const init = spawnSync(join(bin, 'initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8' });
    const start = init.status === 0 && spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'log'), '-w', 'start',
      '-o', `-k ${dir} -c listen_addresses= -p 5432 -c fsync=off`], { encoding: 'utf8' });
    if (start?.status !== 0) {
      db.unavailable = `local Postgres did not start: ${(init.stderr || start?.stderr || '').trim().split('\n')[0]}`;
      return;
    }
    connection = ['-h', dir, '-p', '5432', '-U', 'postgres', '-d', 'postgres'];
    assert.ok(!db.psql(SUPABASE_STUBS).error, 'the Supabase stubs load');
    for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
      const applied = db.psql(readFileSync(join('supabase/migrations', file), 'utf8'));
      assert.ok(!applied.error, `${file} applies: ${applied.error?.message}`);
      if (file.startsWith('20260827150000')) assert.ok(!db.psql(PUBLISHED_BUILD).error);
    }
  };

  db.stop = () => {
    if (!dir) return;
    spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  };

  return db;
}
