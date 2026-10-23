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

// === payout ledger (20261023120000_affiliate_payout_ledger.sql) =============

// The first of the UTC month `monthsAgo` months back, as the RPCs name a month.
function monthStart(monthsAgo) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1)).toISOString().slice(0, 10);
}
// A moment on the given day of that month, for purchase({ at }).
const inMonth = (monthsAgo, day = 10) => `'${monthStart(monthsAgo)}T12:00:00Z'::timestamptz + interval '${day - 1} days'`;

const payoutMonths = (who = OWNER) => as(who, 'select public.owner_affiliate_payable_by_month()');
const payoutMonth = (code, month) => payoutMonths().find((row) => row.affiliate_code === code && row.period_month === month);
const markPaid = (who, code, month, note, expected = null) =>
  as(who, `select public.owner_mark_month_paid(${quote(code)}, ${month === null ? 'null' : `${quote(month)}::date`}, ${quote(note)}, ${expected ?? 'null'})`);
// A refund as stripe-webhook's refund() records one: marked refunded, with the
// amount Stripe reported (null when the webhook did not record it).
const refund = (session, cents) => as(SERVICE, `update public.purchases
  set status = 'refunded', refunded_at = coalesce(refunded_at, now()), amount_refunded_cents = ${cents ?? 'null'}
  where stripe_checkout_session_id = ${quote(session)}`);
const ledger = (code) => JSON.parse(psql(`select coalesce(jsonb_agg(to_jsonb(po) order by po.period_month), '[]')
  from wavread_private.affiliate_payouts po where affiliate_code = ${quote(code)}`).out);
const statesOf = (row) => row.sales.map((sale) => [sale.session_suffix, sale.state, sale.commission_cents]);

dbTest('only paid, charged, never-refunded sales are payable; any refund short of a recorded full one needs review', () => {
  as(OWNER, save('create', 'ledger-a', 'Example Ledger A', 'ledger-a@example.net', 30));
  const m3 = monthStart(3);
  purchase({ session: 'cs_test_la_paid_one', code: 'ledger-a', at: inMonth(3, 2) });
  purchase({ session: 'cs_test_la_paid_two', code: 'ledger-a', at: inMonth(3, 3) });
  purchase({ session: 'cs_test_la_free_one', code: 'ledger-a', cents: 0, at: inMonth(3, 4) });
  purchase({ session: 'cs_test_la_full_rfd', code: 'ledger-a', at: inMonth(3, 5) });
  purchase({ session: 'cs_test_la_part_rfd', code: 'ledger-a', at: inMonth(3, 6) });
  purchase({ session: 'cs_test_la_unkn_rfd', code: 'ledger-a', at: inMonth(3, 7) });
  purchase({ session: 'cs_test_la_paid_part', code: 'ledger-a', at: inMonth(3, 8) });
  refund('cs_test_la_full_rfd', 5000);
  refund('cs_test_la_part_rfd', 2000);
  refund('cs_test_la_unkn_rfd', null);
  // A partial refund recorded on a purchase still marked paid counts as one too.
  assert.equal(as(SERVICE, `update public.purchases set amount_refunded_cents = 1000
    where stripe_checkout_session_id = 'cs_test_la_paid_part'`), null);

  const row = payoutMonth('ledger-a', m3);
  assert.equal(row.status, 'payable');
  assert.deepEqual([row.sales_count, row.amount_cents, row.commission_pct], [2, 3000, 30], 'two clean $50 sales at 30%');
  assert.equal(row.needs_review_sales, 3, 'the partial, the unknown-amount and the paid-but-part-refunded sale');
  assert.deepEqual(statesOf(row), [
    ['paid_one', 'payable', 1500], ['paid_two', 'payable', 1500], ['free_one', 'excluded', 0], ['full_rfd', 'refunded', 0],
    ['part_rfd', 'needs_review', 0], ['unkn_rfd', 'needs_review', 0], ['aid_part', 'needs_review', 0],
  ]);
  assert.deepEqual(row.sales.map((sale) => sale.amount_refunded_cents), [null, null, null, 5000, 2000, null, 1000]);

  const affiliate = overview('ledger-a');
  assert.deepEqual([affiliate.sales, affiliate.payable_commission_cents, affiliate.refunds, affiliate.needs_review],
    [2, 3000, 4, 3], 'every refund, partial or full, is counted as one and none is payable');

  // Only the two clean sales are frozen when the month is paid.
  assert.equal(markPaid(OWNER, 'ledger-a', m3, 'PayPal', 3000).amount_cents, 3000);
  assert.deepEqual(statesOf(payoutMonth('ledger-a', m3)).map(([, state]) => state),
    ['paid', 'paid', 'excluded', 'refunded', 'needs_review', 'needs_review', 'needs_review']);
});

dbTest('a $0 sale never earns commission, whatever the rate', () => {
  as(OWNER, save('create', 'ledger-zero', 'Example Ledger Zero', 'ledger-zero@example.net', 100));
  const m3 = monthStart(3);
  purchase({ session: 'cs_test_lz_free_one', code: 'ledger-zero', cents: 0, at: inMonth(3) });
  purchase({ session: 'cs_test_lz_free_two', code: 'ledger-zero', cents: 0, at: inMonth(3, 12) });
  const row = payoutMonth('ledger-zero', m3);
  assert.deepEqual([row.status, row.sales_count, row.amount_cents], ['nothing_payable', 0, 0]);
  assert.ok(row.sales.every((sale) => sale.state === 'excluded' && sale.commission_cents === 0));
  assert.equal(markPaid(OWNER, 'ledger-zero', m3, 'PayPal').error?.code, 'P0002', 'there is nothing to pay');
  assert.deepEqual(ledger('ledger-zero'), []);
  assert.equal(overview('ledger-zero').sales, 0);
});

dbTest('marking a month paid freezes it: a later rate change re-prices only unpaid sales', () => {
  as(OWNER, save('create', 'ledger-b', 'Example Ledger B', 'ledger-b@example.net', 30));
  const [m4, m3] = [monthStart(4), monthStart(3)];
  purchase({ session: 'cs_test_lb_m4_first', code: 'ledger-b', at: inMonth(4, 3) });
  purchase({ session: 'cs_test_lb_m4_second', code: 'ledger-b', at: inMonth(4, 20) });
  purchase({ session: 'cs_test_lb_m3_only', code: 'ledger-b', at: inMonth(3) });

  const paid = markPaid(OWNER, 'ledger-b', m4, '  PayPal  ', 3000);
  assert.deepEqual(
    [paid.affiliate_code, paid.period_month, paid.amount_cents, paid.sales_count, paid.commission_pct_at_payout, paid.method_note, paid.paid_by],
    ['ledger-b', m4, 3000, 2, 30, 'PayPal', OWNER_ID], 'the owner is recorded by auth user id; the note is trimmed');
  assert.ok(Date.now() - Date.parse(paid.paid_at) < 60_000, 'paid_at is now');
  const items = JSON.parse(psql(`select jsonb_agg(amount_cents_paid order by purchase_id) from wavread_private.affiliate_payout_items
    where payout_id = ${paid.id}`).out);
  assert.deepEqual(items, [1500, 1500], 'each sale is frozen at 30% of $50');

  as(OWNER, save('update', 'ledger-b', 'Example Ledger B', 'ledger-b@example.net', 20));

  const paidMonth = payoutMonth('ledger-b', m4);
  assert.deepEqual([paidMonth.status, paidMonth.amount_cents, paidMonth.commission_pct, paidMonth.method_note],
    ['paid', 3000, 30, 'PayPal'], 'the paid month keeps its frozen amount and rate');
  assert.deepEqual(statesOf(paidMonth).map(([, state, cents]) => [state, cents]), [['paid', 1500], ['paid', 1500]]);
  const unpaid = payoutMonth('ledger-b', m3);
  assert.deepEqual([unpaid.status, unpaid.amount_cents, unpaid.commission_pct], ['payable', 1000, 20], 'the unpaid month moves to 20%');

  const earnings = JSON.parse(psql(`select jsonb_object_agg(month, jsonb_build_array(commission_cents, paid_commission_cents))
    from wavread_private.affiliate_earnings where affiliate_code = 'ledger-b'`).out);
  assert.deepEqual(earnings, { [m4]: [3000, 3000], [m3]: [1000, 0] }, 'the earnings view reads the frozen figures for a paid month');
  const affiliate = overview('ledger-b');
  assert.deepEqual([affiliate.sales, affiliate.paid_commission_cents, affiliate.payable_commission_cents], [3, 3000, 1000]);
  assert.deepEqual(affiliate.months.map((m) => [m.month, m.commission_cents]), [[m3.slice(0, 7), 1000], [m4.slice(0, 7), 3000]]);
});

dbTest('mark_month_paid refuses before the 30-day hold, twice, without a usable note, or when the amount moved', () => {
  as(OWNER, save('create', 'ledger-c', 'Example Ledger C', 'ledger-c@example.net', 30));
  const [m0, m3] = [monthStart(0), monthStart(3)];
  purchase({ session: 'cs_test_lc_this_month', code: 'ledger-c', at: 'now()' });
  purchase({ session: 'cs_test_lc_m3_sale__', code: 'ledger-c', at: inMonth(3) });

  const early = markPaid(OWNER, 'ledger-c', m0, 'PayPal');
  assert.equal(early.error?.code, '55000', 'this month is still inside the hold');
  assert.match(early.error.message, /30-day refund hold until \d{4}-\d{2}-\d{2}/);
  assert.equal(payoutMonth('ledger-c', m0).status, 'on_hold');

  assert.equal(markPaid(OWNER, 'ledger-c', m3, 'PayPal', 1499).error?.code, '55000', 'the page saw a different amount');
  for (const [month, note, why] of [[m3.replace(/01$/, '15'), 'PayPal', 'not the first of a month'], [null, 'PayPal', 'no month'],
                                    [m3, '   ', 'an empty note'], [m3, 'x'.repeat(81), 'a note over 80 characters'],
                                    [m3, 'Zelle 555-123-4567', 'a phone number'], [m3, 'Acct 1234 5678 90', 'an account number']]) {
    assert.equal(markPaid(OWNER, 'ledger-c', month, note).error?.code, '22023', `refused: ${why}`);
  }
  assert.equal(markPaid(OWNER, 'no-such-code', m3, 'PayPal').error?.code, 'P0002');
  assert.deepEqual(ledger('ledger-c'), [], 'nothing was recorded by any refusal');

  assert.equal(markPaid(OWNER, 'ledger-c', m3, 'Zelle', 1500).amount_cents, 1500);
  const twice = markPaid(OWNER, 'ledger-c', m3, 'Zelle', 1500);
  assert.equal(twice.error?.code, '23505', 'a month is paid once');
  assert.match(twice.error.message, /already marked paid/);
  assert.equal(ledger('ledger-c').length, 1);
});

dbTest('a refund after payout is flagged as a clawback with the commission paid, and nothing is adjusted', () => {
  as(OWNER, save('create', 'ledger-d', 'Example Ledger D', 'ledger-d@example.net', 30));
  const m3 = monthStart(3);
  purchase({ session: 'cs_test_ld_kept_sale', code: 'ledger-d', at: inMonth(3, 2) });
  purchase({ session: 'cs_test_ld_full_late', code: 'ledger-d', at: inMonth(3, 3) });
  purchase({ session: 'cs_test_ld_part_late', code: 'ledger-d', at: inMonth(3, 4) });
  const paid = markPaid(OWNER, 'ledger-d', m3, 'PayPal', 4500);
  assert.equal(paid.amount_cents, 4500);

  refund('cs_test_ld_full_late', 5000);
  refund('cs_test_ld_part_late', 1000);
  const row = payoutMonth('ledger-d', m3);
  assert.deepEqual([row.status, row.amount_cents, row.sales_count, row.clawback_sales, row.clawback_cents],
    ['paid', 4500, 3, 2, 3000], 'the payout still reads what was paid; the refunded sales are flagged with the $15 paid on each');
  assert.deepEqual(statesOf(row), [['ept_sale', 'paid', 1500], ['ull_late', 'clawback', 1500], ['art_late', 'clawback', 1500]]);
  assert.deepEqual(ledger('ledger-d').map((p) => [p.amount_cents, p.sales_count]), [[4500, 3]], 'the ledger row is untouched');
  const affiliate = overview('ledger-d');
  assert.deepEqual([affiliate.paid_commission_cents, affiliate.clawbacks, affiliate.clawback_cents, affiliate.sales], [4500, 2, 3000, 1]);

  // A sale credited by hand to a month already paid is not slipped into a
  // second payout: it waits for review.
  purchase({ session: 'cs_test_ld_late_credit', code: 'ledger-d', at: inMonth(3, 20) });
  const after = payoutMonth('ledger-d', m3);
  assert.deepEqual([after.status, after.amount_cents, after.needs_review_sales], ['paid', 4500, 1]);
  assert.equal(markPaid(OWNER, 'ledger-d', m3, 'PayPal').error?.code, '23505');
});

dbTest('only the owner can read payouts or mark a month paid', () => {
  as(OWNER, save('create', 'ledger-e', 'Example Ledger E', 'ledger-e@example.net', 30));
  const m3 = monthStart(3);
  purchase({ session: 'cs_test_le_sale_one', code: 'ledger-e', at: inMonth(3) });

  for (const [who, name] of [[ANON, 'anon'], [STRANGER, 'a signed-in stranger'],
                             [OWNER_WITHOUT_SESSION, 'the owner id without a live session'], [SERVICE, 'the service role']]) {
    assert.equal(as(who, 'select public.owner_affiliate_payable_by_month()').error?.code, '42501', `${name} cannot read payouts`);
    assert.equal(markPaid(who, 'ledger-e', m3, 'PayPal').error?.code, '42501', `${name} cannot mark a month paid`);
    assert.equal(as(who, `select wavread_private.mark_month_paid('ledger-e', ${quote(m3)}::date, 'PayPal')`).error?.code, '42501',
      `${name} cannot reach the private function either`);
  }
  assert.deepEqual(ledger('ledger-e'), [], 'no refused call recorded anything');

  // No client role reaches the ledger tables — not even the owner's session.
  for (const who of [ANON, STRANGER, OWNER]) {
    for (const table of ['affiliate_payouts', 'affiliate_payout_items']) {
      assert.equal(as(who, `select count(*) from wavread_private.${table}`).error?.code, '42501');
      assert.equal(as(who, `delete from wavread_private.${table}`).error?.code, '42501');
    }
    assert.equal(as(who, `insert into wavread_private.affiliate_payouts (affiliate_code, period_month, amount_cents, sales_count,
      commission_pct_at_payout, paid_by, method_note) values ('ledger-e', ${quote(m3)}, 1500, 1, 30, ${quote(OWNER_ID)}, 'PayPal')`).error?.code, '42501');
  }
  assert.equal(payoutMonth('ledger-e', m3).status, 'payable');
});

dbTest('the ledger is append-only; the correction in AFFILIATE_PAYOUTS.md is the only way to change it', () => {
  as(OWNER, save('create', 'ledger-f', 'Example Ledger F', 'ledger-f@example.net', 30));
  const m3 = monthStart(3);
  purchase({ session: 'cs_test_lf_sale_one', code: 'ledger-f', at: inMonth(3) });
  const paid = markPaid(OWNER, 'ledger-f', m3, 'PayPal', 1500);

  // Even the database owner, in the SQL editor, is refused without the setting.
  for (const statement of [`update wavread_private.affiliate_payouts set method_note = 'Zelle' where id = ${paid.id}`,
                           `delete from wavread_private.affiliate_payout_items where payout_id = ${paid.id}`,
                           `delete from wavread_private.affiliate_payouts where id = ${paid.id}`,
                           'truncate wavread_private.affiliate_payout_items, wavread_private.affiliate_payouts']) {
    assert.equal(psql(statement).error?.code, '23001', statement);
  }
  assert.equal(ledger('ledger-f').length, 1);

  // The two corrections the ops note documents, run exactly as written there.
  const docs = readFileSync('AFFILIATE_PAYOUTS.md', 'utf8');
  const block = (title) => docs.match(new RegExp(`\`\`\`sql\\n(-- ${title}\\n[\\s\\S]*?)\`\`\``))?.[1];
  const fixNote = block('Correct the method note of one payout');
  const remove = block('Remove one mistaken payout');
  assert.ok(fixNote && remove, 'the ops note carries both corrections');
  assert.ok(!psql(fixNote.replaceAll('<payout id>', String(paid.id)).replaceAll('<new note>', 'Zelle')).error);
  assert.equal(ledger('ledger-f')[0].method_note, 'Zelle');
  const removed = psql(`${remove.replaceAll('<payout id>', String(paid.id))}
    select '[' || coalesce(current_setting('wavread.payout_correction', true), '') || ']';`);
  assert.ok(!removed.error, removed.error?.message);
  assert.equal(removed.out, '[]', 'the setting does not outlive the correction\'s transaction');
  assert.deepEqual(ledger('ledger-f'), []);
  assert.equal(payoutMonth('ledger-f', m3).status, 'payable', 'the month is payable again, and can be marked paid afresh');
  assert.equal(markPaid(OWNER, 'ledger-f', m3, 'Zelle', 1500).amount_cents, 1500);
});

dbTest('the replaced views are still invoker-rights and closed to client roles', () => {
  for (const view of ['affiliate_sales', 'affiliate_earnings']) {
    const options = psql(`select array_to_string(reloptions, ',') from pg_class where oid = 'wavread_private.${view}'::regclass`).out;
    assert.match(options, /security_invoker=true/, view);
    for (const who of [ANON, STRANGER, OWNER]) {
      assert.equal(as(who, `select count(*) from wavread_private.${view}`).error?.code, '42501');
    }
  }
});
