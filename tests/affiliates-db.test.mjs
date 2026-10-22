// The affiliate migration, run for real. Every migration in supabase/migrations
// is applied in order to a throwaway local Postgres, with the few Supabase
// pieces they rely on stubbed below, and the owner-only functions, the
// webhook's lookup and the earnings rules are exercised as the roles that will
// call them: anon, a signed-in stranger, the owner, and the service role.
//
// Nothing here touches a hosted database. The cluster lives in a temporary
// directory, listens on a Unix socket only, and is deleted afterwards.
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
// The owner's id with a session that is not live: a stolen or expired token.
const OWNER_WITHOUT_SESSION = { role: 'authenticated', claims: { sub: OWNER_ID, session_id: '00000000-0000-4000-8000-0000000000ff' } };
const ANON = { role: 'anon', claims: {} };
const SERVICE = { role: 'service_role', claims: {} };

let dir;
let connection;
// Why the cluster could not start, if it could not. A machine whose Postgres
// will not start is not a failing test, so it skips like a machine with none.
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

// One statement, as one caller, in its own transaction. Answers the parsed
// JSON of a single-value result, or { error: { code } }.
function as(who, statement) {
  const prefix = who
    ? `set local role ${who.role};\nset local request.jwt.claims = '${JSON.stringify(who.claims)}';\n`
    : '';
  const result = psql(`begin;\n${prefix}${statement};\ncommit;\n`);
  if (result.error) return result;
  return result.out === '' ? null : JSON.parse(result.out);
}

const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
const save = (operation, code, name, email, pct, active = true) =>
  `select public.owner_save_affiliate(${quote(operation)}, ${quote(code)}, ${quote(name)}, ${quote(email)}, ${pct}, ${active})`;
const overview = (code) => {
  const all = as(OWNER, 'select public.owner_affiliates()');
  return code ? all.find((row) => row.code === code) : all;
};

// A purchase as the webhook writes one, made `daysAgo` days ago.
function purchase({ session, code, cents = 5000, daysAgo, refunded = false, source = code ? `aff-${code}` : null, at }) {
  const when = at ?? `now() - interval '${daysAgo} days'`;
  return as(SERVICE, `insert into public.purchases
      (tester_id, product, amount_cents, stripe_checkout_session_id, email, status, purchased_at, refunded_at, source, affiliate_code)
    select tester_id, 'early_build', ${cents}, ${quote(session)}, 'buyer@example.net',
      ${refunded ? "'refunded'" : "'paid'"}, ${when}, ${refunded ? 'now()' : 'null'},
      ${source ? quote(source) : 'null'}, ${code ? quote(code) : 'null'}
    from public.accounts where email = 'buyer@example.net'`);
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

  assert.ok(OWNER_ID && OWNER_EMAIL, 'the owner identity is read from the licence-grant migration');
  const people = psql(`
    insert into auth.users values (${quote(OWNER_ID)}, ${quote(OWNER_EMAIL)}, now()),
                                  (${quote(STRANGER_ID)}, 'stranger@example.net', now());
    insert into auth.sessions values (${quote(OWNER_SESSION)}, ${quote(OWNER_ID)}),
                                     (${quote(STRANGER_SESSION)}, ${quote(STRANGER_ID)});
    insert into public.accounts (email, status, auth_user_id)
    values (${quote(OWNER_EMAIL)}, 'active', ${quote(OWNER_ID)}),
           ('stranger@example.net', 'active', ${quote(STRANGER_ID)}),
           ('buyer@example.net', 'active', null);`);
  assert.ok(!people.error, people.error?.message);
});

// A test that needs the database: skipped, with the reason, when there is none.
function dbTest(name, body) {
  test(name, { skip }, (t) => (unavailable ? t.skip(unavailable) : body()));
}

after(() => {
  if (!dir) return;
  spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(dir, { recursive: true, force: true });
});

dbTest('only the owner can read or change affiliates', () => {
  assert.equal(as(OWNER, save('create', 'gate-check', 'Example Affiliate', 'gate@example.net', 30))?.code, 'gate-check');

  for (const [who, name] of [[ANON, 'anon'], [STRANGER, 'a signed-in stranger'], [OWNER_WITHOUT_SESSION, 'the owner id without a live session']]) {
    assert.equal(as(who, 'select public.owner_affiliates()').error?.code, '42501', `${name} cannot list affiliates`);
    assert.equal(as(who, save('update', 'gate-check', 'Changed', 'changed@example.net', 99)).error?.code, '42501', `${name} cannot edit one`);
    assert.equal(as(who, save('create', 'intruder', 'Intruder', 'intruder@example.net', 99)).error?.code, '42501', `${name} cannot add one`);
  }
  const row = overview('gate-check');
  assert.equal(row.name, 'Example Affiliate', 'the refused edit changed nothing');
  assert.equal(row.commission_pct, 30);
  assert.equal(overview('intruder'), undefined, 'the refused add created nothing');

  // No client role reaches the table itself — not even the owner's session.
  for (const who of [ANON, STRANGER, OWNER]) {
    assert.equal(as(who, 'select count(*) from wavread_private.affiliates').error?.code, '42501');
    assert.equal(as(who, "update wavread_private.affiliates set commission_pct = 99").error?.code, '42501');
  }
  for (const who of [ANON, STRANGER, OWNER]) {
    assert.equal(as(who, 'select count(*) from wavread_private.affiliate_earnings').error?.code, '42501');
  }
});

dbTest('the owner adds, edits and deactivates affiliates; the code never changes', () => {
  const created = as(OWNER, save('create', ' Studio-A ', ' Example Studio ', ' Studio@Example.NET ', 30));
  assert.deepEqual([created.code, created.name, created.email, created.commission_pct, created.active],
    ['studio-a', 'Example Studio', 'studio@example.net', 30, true], 'code, name and email are normalized');

  assert.equal(as(OWNER, save('create', 'studio-a', 'Someone Else', 'else@example.net', 30)).error?.code, '23505', 'a taken code is refused, not overwritten');
  assert.equal(overview('studio-a').name, 'Example Studio');

  for (const [code, email, pct] of [['x', 'ok@example.net', 30], ['has space', 'ok@example.net', 30], ['a'.repeat(33), 'ok@example.net', 30],
                                    ['fine-code', 'not-an-email', 30], ['fine-code', 'ok@example.net', 101], ['fine-code', 'ok@example.net', -1]]) {
    assert.equal(as(OWNER, save('create', code, 'Name', email, pct)).error?.code, '22023', `${code} / ${email} / ${pct} is refused`);
  }
  assert.equal(as(OWNER, save('update', 'no-such-code', 'Name', 'ok@example.net', 30)).error?.code, 'P0002');
  assert.equal(as(OWNER, save('delete', 'studio-a', 'Name', 'ok@example.net', 30)).error?.code, '22023', 'there is no delete');

  const edited = as(OWNER, save('update', 'studio-a', 'Example Studio Two', 'two@example.net', 25));
  assert.deepEqual([edited.name, edited.email, edited.commission_pct, edited.active], ['Example Studio Two', 'two@example.net', 25, true]);
  assert.equal(as(OWNER, save('update', 'studio-a', 'Example Studio Two', 'two@example.net', 25, false)).active, false, 'deactivated');
  assert.equal(as(OWNER, save('update', 'studio-a', 'Example Studio Two', 'two@example.net', 25, true)).active, true, 'and reactivated');
});

dbTest('the webhook credits only an active affiliate who is not the buyer', () => {
  as(OWNER, save('create', 'credited', 'Example Credited', 'credited@example.net', 30));
  as(OWNER, save('create', 'paused', 'Example Paused', 'paused@example.net', 30, false));
  const lookup = (code, buyer) => as(SERVICE, `select to_jsonb(public.attributable_affiliate(${quote(code)}, ${quote(buyer)}))`);

  assert.equal(lookup('credited', 'buyer@example.net'), 'credited');
  assert.equal(lookup('credited', 'credited@example.net'), null, 'self-referral credits nobody');
  assert.equal(lookup('credited', ' Credited@Example.NET '), null, 'however the buyer typed their own email');
  assert.equal(lookup('paused', 'buyer@example.net'), null, 'an inactive affiliate is not credited');
  assert.equal(lookup('never-added', 'buyer@example.net'), null, 'an unknown code is not credited');

  for (const who of [ANON, STRANGER, OWNER]) {
    assert.equal(as(who, "select public.attributable_affiliate('credited', 'buyer@example.net')").error?.code, '42501',
      'only the service role may ask, so nobody can probe which codes or emails exist');
  }
});

dbTest('a purchase records its label and can only credit an affiliate that exists', () => {
  as(OWNER, save('create', 'a'.repeat(32), 'Example Long Code', 'long@example.net', 30));
  assert.equal(purchase({ session: 'cs_test_longest_label', code: 'a'.repeat(32), daysAgo: 1 }), null,
    'the longest label labels.mjs accepts fits the source column');
  assert.equal(purchase({ session: 'cs_test_ad_label_only', code: null, source: 'reels-a', daysAgo: 1 }), null,
    'an advertisement label is recorded with no affiliate');
  assert.equal(purchase({ session: 'cs_test_unknown_code_', code: 'never-added', daysAgo: 1 }).error?.code, '23503',
    'a code with no affiliate row cannot be written');
  assert.equal(purchase({ session: 'cs_test_prose_source_', code: null, source: 'Reels A, from the newsletter', daysAgo: 1 }).error?.code, '23514');
});

dbTest('earnings are 30% of gross, payable by month once 30 days old; refunds and $0 sales drop out', () => {
  as(OWNER, save('create', 'earner', 'Example Earner', 'earner@example.net', 30));
  // Two payable sales in different months, comfortably past the window.
  purchase({ session: 'cs_test_earner_month1', code: 'earner', at: "date_trunc('month', now()) - interval '3 months' + interval '5 days'" });
  purchase({ session: 'cs_test_earner_month2', code: 'earner', at: "date_trunc('month', now()) - interval '2 months' + interval '3 days'" });
  purchase({ session: 'cs_test_earner_day_31', code: 'earner', daysAgo: 31 });
  purchase({ session: 'cs_test_earner_day_29', code: 'earner', daysAgo: 29 });
  purchase({ session: 'cs_test_earner_pending', code: 'earner', daysAgo: 2 });
  purchase({ session: 'cs_test_earner_refunded', code: 'earner', daysAgo: 60, refunded: true });
  purchase({ session: 'cs_test_earner_free', code: 'earner', cents: 0, daysAgo: 50 });
  purchase({ session: 'cs_test_not_credited__', code: null, source: 'aff-earner', daysAgo: 50 });

  let row = overview('earner');
  assert.equal(row.sales, 5, 'paid, more than $0, not refunded — pending or payable');
  assert.equal(row.gross_cents, 25000);
  assert.equal(row.pending_sales, 2, 'the 29-day and 2-day sales are still inside the refund window');
  assert.equal(row.pending_commission_cents, 3000);
  assert.equal(row.payable_commission_cents, 4500, '30% of $50 is $15, three times');
  assert.equal(row.refunds, 1);
  assert.equal(row.refunded_cents, 5000);
  assert.equal(row.months.reduce((sum, month) => sum + month.commission_cents, 0), 4500);
  assert.ok(row.months.every((month) => month.commission_cents === 1500 * month.sales && month.gross_cents === 5000 * month.sales));
  assert.deepEqual(row.months.map((m) => m.month), [...row.months.map((m) => m.month)].sort().reverse(), 'newest month first');
  assert.ok(row.months.length >= 2, 'payable earnings are split by month');

  // A refund, as stripe-webhook's refund() records one, takes a payable sale
  // out of earnings and into refunds.
  assert.equal(as(SERVICE, `update public.purchases set status = 'refunded', refunded_at = now()
    where stripe_checkout_session_id = 'cs_test_earner_day_31'`), null);
  row = overview('earner');
  assert.equal(row.payable_commission_cents, 3000);
  assert.equal(row.refunds, 2);
  assert.equal(row.sales, 4);

  // The view the SQL editor reads agrees with the page.
  const view = JSON.parse(psql(`select coalesce(jsonb_agg(e), '[]') from wavread_private.affiliate_earnings e where affiliate_code = 'earner'`).out);
  assert.equal(view.reduce((sum, month) => sum + Number(month.commission_cents), 0), 3000);
  assert.ok(view.every((month) => Number(month.commission_cents) * 100 === Number(month.gross_cents) * 30));

  // Changing the rate re-prices what has not been paid out (OPEN in the
  // migration header): the report is a calculation, not a ledger.
  as(OWNER, save('update', 'earner', 'Example Earner', 'earner@example.net', 20));
  assert.equal(overview('earner').payable_commission_cents, 2000);
});

// === review copies (20261021190000_review_promotion_codes.sql) ==============

// A purchase as the webhook writes a review: a 100% promotion code brought the
// checkout to $0, so the row is kind 'review', amount 0 and credits no one.
function review({ session, cents = 0, code = null, source = 'aff-reviewed', promo = 'promo_1TestReviewCode', kind = 'review' }) {
  return as(SERVICE, `insert into public.purchases
      (tester_id, product, amount_cents, stripe_checkout_session_id, email, status, source, affiliate_code, kind, stripe_promotion_code)
    select tester_id, 'early_build', ${cents}, ${quote(session)}, 'buyer@example.net', 'paid',
      ${source ? quote(source) : 'null'}, ${code ? quote(code) : 'null'}, ${quote(kind)}, ${promo ? quote(promo) : 'null'}
    from public.accounts where email = 'buyer@example.net'`);
}

dbTest('a review is $0, credits no one, and the database refuses one that does not', () => {
  as(OWNER, save('create', 'reviewed', 'Example Reviewed', 'reviewed@example.net', 30));
  assert.equal(review({ session: 'cs_test_review_ok_____' }), null, 'a review as the webhook writes it');
  assert.equal(review({ session: 'cs_test_review_no_code', promo: null, source: null }), null, 'with no code or label recorded');
  assert.equal(review({ session: 'cs_test_review_longest', promo: `promo_${'a'.repeat(100)}` }), null,
    'the longest promotion code id fulfillment.mjs accepts fits the column');

  assert.equal(review({ session: 'cs_test_review_affil__', code: 'reviewed' }).error?.code, '23514', 'a review cannot credit an affiliate');
  assert.equal(review({ session: 'cs_test_review_charged', cents: 5000 }).error?.code, '23514', 'a review cannot carry an amount');
  assert.equal(review({ session: 'cs_test_review_kind___', kind: 'gift' }).error?.code, '23514', 'sale and review are the only kinds');
  assert.equal(review({ session: 'cs_test_review_promo__', promo: 'REVIEW-7Q4M2K' }).error?.code, '23514', 'the id is stored, never the code');

  // Every purchase written before this migration, and every one the webhook
  // writes without saying, is a sale.
  assert.equal(purchase({ session: 'cs_test_plain_sale_____', code: 'reviewed', daysAgo: 1 }), null);
  const kinds = JSON.parse(psql(`select jsonb_object_agg(stripe_checkout_session_id, kind) from public.purchases
    where stripe_checkout_session_id in ('cs_test_plain_sale_____', 'cs_test_review_ok_____')`).out);
  assert.deepEqual(kinds, { cs_test_plain_sale_____: 'sale', cs_test_review_ok_____: 'review' });
});

dbTest('a review through an affiliate link adds nothing to their sales, pending, payable or refunds', () => {
  as(OWNER, save('create', 'counted', 'Example Counted', 'counted@example.net', 30));
  purchase({ session: 'cs_test_counted_payable', code: 'counted', daysAgo: 40 });
  purchase({ session: 'cs_test_counted_pending', code: 'counted', daysAgo: 3 });
  const before = overview('counted');
  const earningsBefore = psql(`select coalesce(sum(commission_cents), 0) from wavread_private.affiliate_earnings where affiliate_code = 'counted'`).out;

  // What the webhook records for a reviewer who followed ?from=aff-counted.
  assert.equal(review({ session: 'cs_test_counted_review_', source: 'aff-counted' }), null);
  assert.deepEqual(overview('counted'), before, 'the admin page reads exactly what it did');
  assert.equal(psql(`select coalesce(sum(commission_cents), 0) from wavread_private.affiliate_earnings where affiliate_code = 'counted'`).out,
    earningsBefore);
  assert.deepEqual([before.sales, before.pending_sales, before.payable_commission_cents], [2, 1, 1500]);

  // The constraint above keeps a review's affiliate null. Were it ever lifted,
  // affiliate_sales still excludes a review by its kind — even one that, by
  // some mistake, carried a full amount — so it is never a sale or a payout.
  const lifted = psql(`begin;
    alter table public.purchases drop constraint purchases_review_is_free;
    insert into public.purchases (tester_id, product, amount_cents, stripe_checkout_session_id, email, status, purchased_at, affiliate_code, kind)
    select tester_id, 'early_build', 5000, 'cs_test_counted_mistake', 'buyer@example.net', 'paid', now() - interval '40 days', 'counted', 'review'
      from public.accounts where email = 'buyer@example.net';
    select jsonb_build_object(
      'state', (select state from wavread_private.affiliate_sales s join public.purchases p on p.id = s.purchase_id
                 where p.stripe_checkout_session_id = 'cs_test_counted_mistake'),
      'payable', (select coalesce(sum(commission_cents), 0) from wavread_private.affiliate_earnings where affiliate_code = 'counted'));
    rollback;`);
  assert.ok(!lifted.error, lifted.error?.message);
  assert.deepEqual(JSON.parse(lifted.out), { state: 'excluded', payable: Number(earningsBefore) });
  assert.equal(psql(`select count(*) from pg_constraint where conname = 'purchases_review_is_free'`).out, '1', 'and the constraint is back');
});

dbTest('affiliate_sales is still invoker-rights and closed to client roles after the replace', () => {
  const options = psql(`select array_to_string(reloptions, ',') from pg_class where oid = 'wavread_private.affiliate_sales'::regclass`).out;
  assert.match(options, /security_invoker=true/);
  for (const who of [ANON, STRANGER, OWNER]) {
    assert.equal(as(who, 'select count(*) from wavread_private.affiliate_sales').error?.code, '42501');
  }
});
