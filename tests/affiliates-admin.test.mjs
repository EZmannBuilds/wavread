import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

const PAGE = 'docs/admin/affiliates.html';
const read = (path) => readFile(path, 'utf8');

// A small stand-in for the DOM: enough nodes, events and tables for the page
// script to run, and a way to read back what it drew.
class FakeNode {
  constructor(tag = 'div', id = '') {
    Object.assign(this, { tag, id, children: [], listeners: {}, dataset: {}, hidden: id === 'admin-content', textContent: '',
      value: '', checked: false, readOnly: false, disabled: id === 'submit', className: '', type: '' });
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  async fire(type) { for (const listener of this.listeners[type] ?? []) await listener({ preventDefault() {} }); }
  createTHead() { const node = new FakeNode('thead'); this.append(node); return node; }
  createTBody() { const node = new FakeNode('tbody'); this.append(node); return node; }
  insertRow() { const node = new FakeNode('tr'); this.append(node); return node; }
  insertCell() { const node = new FakeNode('td'); this.append(node); return node; }
  get text() { return [this.textContent, ...this.children.map((child) => child.text)].filter(Boolean).join(' '); }
  click() { this.clicked = (this.clicked ?? 0) + 1; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  find(test) { return test(this) ? this : this.children.map((child) => child.find(test)).find(Boolean); }
  findAll(test) { return [...(test(this) ? [this] : []), ...this.children.flatMap((child) => child.findAll(test))]; }
}

function page() {
  const nodes = new Map();
  const byId = (id) => nodes.get(id) ?? nodes.set(id, new FakeNode('div', id)).get(id);
  const form = byId('affiliate-form');
  const submit = new FakeNode('button', 'submit');
  form.querySelector = () => submit;
  form.reportValidity = () => true;
  form.reset = () => {
    byId('affiliate-code').value = ''; byId('affiliate-name').value = ''; byId('affiliate-email').value = '';
    byId('affiliate-pct').value = '30'; byId('affiliate-active').checked = true;
  };
  const body = new FakeNode('body');
  return { byId, submit, body, document: { body, querySelector: (selector) => byId(selector.replace(/^#/, '')), createElement: (tag) => new FakeNode(tag) } };
}

const AFFILIATES = [
  { code: 'example', name: 'Example Affiliate', email: 'affiliate@example.net', commission_pct: 30, active: true, created_at: '2026-10-01T00:00:00Z',
    sales: 3, gross_cents: 15000, pending_sales: 1, pending_commission_cents: 1500, payable_commission_cents: 3000, refunds: 1, refunded_cents: 5000,
    months: [{ month: '2026-09', sales: 1, gross_cents: 5000, commission_cents: 1500 }, { month: '2026-08', sales: 1, gross_cents: 5000, commission_cents: 1500 }] },
  { code: 'paused', name: 'Paused Affiliate', email: 'paused@example.net', commission_pct: 25, active: false, created_at: '2026-10-02T00:00:00Z',
    sales: 0, gross_cents: 0, pending_sales: 0, pending_commission_cents: 0, payable_commission_cents: 0, refunds: 0, refunded_cents: 0, months: [] },
];

// What owner_affiliate_payable_by_month answers: one row per affiliate per
// month, newest first, with the sales behind it.
const sale = (purchased_on, session_suffix, state, commission_cents = 0, extra = {}) =>
  ({ purchased_on, session_suffix, gross_cents: 5000, commission_cents, state, has_refund: false, amount_refunded_cents: null, ...extra });
const PAYOUTS = [
  { affiliate_code: 'example', affiliate_name: 'Example Affiliate', period_month: '2026-10-01', hold_ends_at: '2026-12-01T00:00:00+00:00',
    status: 'on_hold', sales_count: 1, amount_cents: 1500, commission_pct: 30, payout_id: null, paid_at: null, method_note: null,
    needs_review_sales: 0, clawback_sales: 0, clawback_cents: 0, sales: [sale('2026-10-20', 'Oct20aaa', 'pending', 1500)] },
  { affiliate_code: 'example', affiliate_name: 'Example Affiliate', period_month: '2026-08-01', hold_ends_at: '2026-10-01T00:00:00+00:00',
    status: 'payable', sales_count: 3, amount_cents: 4500, commission_pct: 30, payout_id: null, paid_at: null, method_note: null,
    needs_review_sales: 1, clawback_sales: 0, clawback_cents: 0,
    sales: [sale('2026-08-02', 'Aug02aaa', 'payable', 1500), sale('2026-08-09', 'Aug09bbb', 'payable', 1500),
            sale('2026-08-11', 'Aug11ccc', 'needs_review', 0, { has_refund: true, amount_refunded_cents: 2000 }),
            sale('2026-08-30', 'Aug30ddd', 'payable', 1500)] },
  { affiliate_code: 'example', affiliate_name: 'Example Affiliate', period_month: '2026-07-01', hold_ends_at: '2026-08-31T00:00:00+00:00',
    status: 'paid', sales_count: 2, amount_cents: 3000, commission_pct: 30, payout_id: 7, paid_at: '2026-09-05T14:00:00+00:00', method_note: 'PayPal',
    needs_review_sales: 0, clawback_sales: 1, clawback_cents: 1500,
    sales: [sale('2026-07-03', 'Jul03aaa', 'paid', 1500), sale('2026-07-19', 'Jul19bbb', 'clawback', 1500, { has_refund: true })] },
  // An affiliate code may start with a hyphen, and a method note is free text:
  // both reach the CSV, so both must arrive there as text, not as formulas.
  { affiliate_code: '-cmd', affiliate_name: 'Formula Test', period_month: '2026-06-01', hold_ends_at: '2026-07-31T00:00:00+00:00',
    status: 'paid', sales_count: 1, amount_cents: 1500, commission_pct: 30, payout_id: 8, paid_at: '2026-08-02T09:30:00+00:00',
    method_note: '=HYPERLINK("http://example.net","pay, now")', needs_review_sales: 0, clawback_sales: 0, clawback_cents: 0,
    sales: [sale('2026-06-14', '@SUM(A1)', 'paid', 1500)] },
];

function client({ user = true, owner = true, permissionError = null, saveError = null, markError = null } = {}) {
  const calls = [];
  return {
    calls,
    auth: { getUser: async () => ({ data: { user: user ? { id: 'session-user' } : null }, error: null }) },
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'owner_licence_status') return { data: owner, error: permissionError };
      if (name === 'owner_affiliates') return owner ? { data: AFFILIATES, error: null } : { data: null, error: { code: '42501' } };
      if (name === 'owner_save_affiliate') return saveError ? { data: null, error: saveError } : { data: { code: args.target_code }, error: null };
      if (name === 'owner_affiliate_payable_by_month') return owner ? { data: PAYOUTS, error: null } : { data: null, error: { code: '42501' } };
      if (name === 'owner_mark_month_paid') return markError ? { data: null, error: markError } : { data: { id: 9, amount_cents: args.expected_cents }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

async function run(supabase) {
  const view = page();
  const source = (await read('docs/js/affiliates-admin.js')).replace(/\ncreateAdminClient\(\)[\s\S]*$/, '\n');
  view.downloads = [];
  const context = vm.createContext({ document: view.document, location: { hostname: 'localhost' }, window: {},
    navigator: { clipboard: { writeText: async (text) => { view.copied = text; } } },
    Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = options?.type; } },
    URL: { createObjectURL: (blob) => { view.downloads.push({ blob }); return `blob:${view.downloads.length}`; }, revokeObjectURL: () => {} },
    setTimeout: () => {} });
  vm.runInContext(`${source}\nglobalThis.start = initializeAffiliateAdmin;\nglobalThis.helpers = { csvCell, payoutCsv, payoutSalesCsv };`, context);
  view.helpers = context.helpers;
  await context.start(supabase);
  return view;
}

// Objects made inside the vm context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const visible = (view) => ['loading-state', 'unavailable-state', 'admin-content'].filter((id) => !view.byId(id).hidden);

test('signed-out visitors and non-owners see nothing, and no affiliate data is requested', async () => {
  for (const [name, supabase] of [
    ['not configured', null],
    ['signed out', client({ user: false })],
    ['signed in, not the owner', client({ owner: false })],
    ['permission check failed', client({ permissionError: { code: '42501' } })],
  ]) {
    const view = await run(supabase);
    assert.deepEqual(visible(view), ['unavailable-state'], name);
    assert.deepEqual((supabase?.calls ?? []).map(([rpc]) => rpc).filter((rpc) => rpc !== 'owner_licence_status'), [], `${name}: nothing else is asked`);
    assert.equal(view.byId('affiliate-list').children.length, 0);
  }
});

test('the owner sees each affiliate, their link, sales, pending, payable and refunds', async () => {
  const supabase = client();
  const view = await run(supabase);
  assert.deepEqual(visible(view), ['admin-content']);
  assert.deepEqual(supabase.calls.map(([rpc]) => rpc), ['owner_licence_status', 'owner_affiliates', 'owner_affiliate_payable_by_month']);
  assert.equal(view.submit.disabled, false);

  const rows = view.byId('affiliate-list').findAll((node) => node.tag === 'tr').slice(1).map((row) => row.text);
  assert.equal(rows.length, 2);
  for (const expected of ['Example Affiliate', 'example · affiliate@example.net', 'https://wavread.com/?from=aff-example', '30%', 'Active',
                          '3 · $150.00', '1 · $15.00', '$30.00', '1 · $50.00', 'Deactivate']) {
    assert.ok(rows[0].includes(expected), `the row shows ${expected}: ${rows[0]}`);
  }
  assert.ok(rows[1].includes('Inactive') && rows[1].includes('Reactivate') && rows[1].includes('https://wavread.com/?from=aff-paused'));

  await view.byId('affiliate-list').find((node) => node.tag === 'button' && node.textContent === 'Copy link').fire('click');
  assert.equal(view.copied, 'https://wavread.com/?from=aff-example');
});

test('adding an affiliate goes through owner_save_affiliate, normalized', async () => {
  const supabase = client();
  const view = await run(supabase);
  view.byId('affiliate-code').value = ' Studio-A ';
  view.byId('affiliate-name').value = ' Example Studio ';
  view.byId('affiliate-email').value = ' Studio@Example.NET ';
  view.byId('affiliate-pct').value = '30';
  await view.byId('affiliate-form').fire('submit');
  assert.deepEqual(plain(supabase.calls.find(([rpc]) => rpc === 'owner_save_affiliate')[1]), {
    operation: 'create', target_code: 'studio-a', target_name: 'Example Studio', target_email: 'studio@example.net', target_pct: 30, target_active: true,
  });
  assert.equal(view.byId('affiliate-form-status').dataset.state, 'success');
  assert.match(view.byId('affiliate-form-status').textContent, /https:\/\/wavread\.com\/\?from=aff-studio-a/);
  assert.equal(supabase.calls.filter(([rpc]) => rpc === 'owner_affiliates').length, 2, 'the list is reloaded');
});

test('editing keeps the code, and deactivating sends the row back unchanged but inactive', async () => {
  const supabase = client();
  const view = await run(supabase);
  await view.byId('affiliate-list').find((node) => node.tag === 'button' && node.textContent === 'Edit').fire('click');
  assert.equal(view.byId('affiliate-code').readOnly, true, 'the code cannot be edited');
  assert.equal(view.byId('affiliate-active-field').hidden, false);
  view.byId('affiliate-code').value = 'tampered';
  view.byId('affiliate-pct').value = '20';
  await view.byId('affiliate-form').fire('submit');
  assert.deepEqual(plain(supabase.calls.filter(([rpc]) => rpc === 'owner_save_affiliate').at(-1)[1]), {
    operation: 'update', target_code: 'example', target_name: 'Example Affiliate', target_email: 'affiliate@example.net', target_pct: 20, target_active: true,
  });

  await view.byId('affiliate-list').find((node) => node.tag === 'button' && node.textContent === 'Deactivate').fire('click');
  assert.deepEqual(plain(supabase.calls.filter(([rpc]) => rpc === 'owner_save_affiliate').at(-1)[1]), {
    operation: 'update', target_code: 'example', target_name: 'Example Affiliate', target_email: 'affiliate@example.net', target_pct: 30, target_active: false,
  });
});

test('a refused save says why, in words', async () => {
  const view = await run(client({ saveError: { code: '23505', message: 'That code is already taken' } }));
  view.byId('affiliate-code').value = 'example';
  view.byId('affiliate-name').value = 'Someone';
  view.byId('affiliate-email').value = 'someone@example.net';
  await view.byId('affiliate-form').fire('submit');
  assert.equal(view.byId('affiliate-form-status').dataset.state, 'error');
  assert.match(view.byId('affiliate-form-status').textContent, /already taken/);
  assert.equal(view.submit.disabled, false);
});

test('the admin page is noindex, unlisted, and empty until the script says otherwise', async () => {
  const html = await read(PAGE);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(await read('docs/robots.txt'), /Disallow: \/admin\//);
  assert.doesNotMatch(await read('docs/sitemap.xml'), /admin/);
  assert.match(html, /<div id="admin-content" hidden>/);
  assert.match(html, /id="unavailable-state" hidden/);
  assert.match(html, /<button class="btn primary" type="submit" disabled>/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<main\b/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /mailto:support@wavread\.com/);
  assert.match(html, /src="\/js\/affiliates-admin\.js" type="module"/);
  assert.match(html, /href="\/product\.css"/);
  assert.match(html, /href="\/pages\.css"/);
  assert.match(html, /src="\/js\/navigation\.js"/);
  assert.doesNotMatch(html, /\sstyle="|\sonclick=|\sonsubmit=|\sonload=/i, 'nothing the CSP would block');
  assert.deepEqual([...new Set(html.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g))], ['support@wavread.com'], 'no address but support');
  for (const reference of [...html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)].map((m) => m[1])) {
    if (reference === '/') continue;
    const target = join('docs', reference.endsWith('.html') || /\.\w+$/.test(reference) ? reference : `${reference}.html`);
    await assert.doesNotReject(access(target), `missing ${reference}`);
  }
});

test('the admin script reads and writes only through owner-checked functions', async () => {
  const js = await read('docs/js/affiliates-admin.js');
  assert.deepEqual([...new Set([...js.matchAll(/\.rpc\("([^"]+)"/g)].map((m) => m[1]))].sort(),
    ['owner_affiliate_payable_by_month', 'owner_affiliates', 'owner_licence_status', 'owner_mark_month_paid', 'owner_save_affiliate']);
  assert.doesNotMatch(js, /\.from\(|service[_-]?role|attributable_affiliate/i, 'no table access, no service key, no webhook lookup');
  const migration = await read('supabase/migrations/20261021120000_affiliate_tracking.sql');
  for (const fn of ['affiliate_overview', 'save_affiliate']) {
    const body = migration.slice(migration.indexOf(`create function wavread_private.${fn}(`));
    assert.match(body.slice(0, 1200), /if not coalesce\(wavread_private\.owner_can_grant\(\), false\) then\s+raise exception '[^']+' using errcode = '42501';/,
      `${fn} checks the owner before anything else`);
  }
  for (const fn of ['owner_affiliates()', 'owner_save_affiliate(text, text, text, text, numeric, boolean)',
                    'wavread_private.affiliate_overview()', 'wavread_private.save_affiliate(text, text, text, text, numeric, boolean)']) {
    const name = fn.includes('.') ? fn : `public.${fn}`;
    assert.ok(migration.includes(`revoke all on function ${name} from public, anon;`), `${name} is not callable by anon`);
  }
  const ledger = await read('supabase/migrations/20261023120000_affiliate_payout_ledger.sql');
  for (const fn of ['affiliate_overview', 'affiliate_payable_by_month', 'mark_month_paid']) {
    const body = ledger.slice(ledger.search(new RegExp(`create (or replace )?function wavread_private\\.${fn}\\(`)));
    assert.match(body.slice(0, 1200), /if not coalesce\(wavread_private\.owner_can_grant\(\), false\) then\s+raise exception '[^']+' using errcode = '42501';/,
      `${fn} checks the owner before anything else`);
  }
  for (const fn of ['public.owner_affiliate_payable_by_month()', 'public.owner_mark_month_paid(text, date, text, integer)',
                    'wavread_private.affiliate_payable_by_month()', 'wavread_private.mark_month_paid(text, date, text, integer)']) {
    assert.ok(ledger.includes(`revoke all on function ${fn} from public, anon;`), `${fn} is not callable by anon`);
  }
  assert.doesNotMatch(ledger, /grant [^;]* on (table )?wavread_private\.affiliate_payout/i, 'no role is granted the ledger tables');
  assert.doesNotMatch(ledger, /for (update|delete) to/i, 'no policy lets anyone change or remove a ledger row');
  const dashboard = await read('docs/dashboard.html');
  const ownerSection = dashboard.slice(dashboard.indexOf('id="licence-admin"'), dashboard.indexOf('</section>', dashboard.indexOf('id="licence-admin"')));
  assert.match(ownerSection, /href="\/admin\/affiliates"/, 'reached from the owner-only dashboard section');
  assert.equal(dashboard.indexOf('/admin/affiliates'), dashboard.lastIndexOf('/admin/affiliates'), 'and nowhere else');
});

// === payouts ================================================================

const rowsOf = (node) => node.findAll((child) => child.tag === 'tbody').flatMap((body) => body.children.map((row) => row.text));
const buttonIn = (node, label) => node.find((child) => child.tag === 'button' && child.textContent === label);

test("the owner sees each affiliate's months: on hold, payable with needs review, paid with a clawback", async () => {
  const view = await run(client());
  const payouts = view.byId('payouts');
  assert.deepEqual(payouts.findAll((node) => node.tag === 'h3').map((node) => node.textContent), ['Example Affiliate (example)', 'Formula Test (-cmd)']);
  assert.deepEqual(rowsOf(payouts), [
    '2026-10 1 $15.00 On hold until 2026-12-01',
    '2026-08 3 $45.00 Payable · Needs review: 1 sale Mark paid',
    '2026-07 2 $30.00 Paid 2026-09-05 via PayPal · Clawback needed: $15.00 on 1 refunded sale',
    '2026-06 1 $15.00 Paid 2026-08-02 via =HYPERLINK("http://example.net","pay, now")',
  ]);
  assert.equal(payouts.findAll((node) => node.tag === 'button').length, 1, 'only a payable month can be marked paid');
  assert.equal(view.byId('payouts-empty').hidden, true);
  assert.equal(view.byId('payouts-csv').disabled, false);
  assert.equal(view.byId('payout-sales-csv').disabled, false);
  assert.equal(view.byId('payout-form').hidden, true, 'the confirm form stays closed until Mark paid is clicked');

  const affiliates = rowsOf(view.byId('affiliate-list'));
  assert.ok(affiliates[0].includes('$30.00 $0.00 1 · $50.00'), `payable, then paid out, then refunds: ${affiliates[0]}`);
});

test('Mark paid opens a confirm step; only Confirm with a note records the month, at the amount shown', async () => {
  const supabase = client();
  const view = await run(supabase);
  const marks = () => supabase.calls.filter(([rpc]) => rpc === 'owner_mark_month_paid');
  await buttonIn(view.byId('payouts'), 'Mark paid').fire('click');

  assert.equal(view.byId('payout-form').hidden, false);
  assert.equal(view.byId('payout-form-title').textContent, 'Mark August 2026 paid for example');
  for (const expected of ['Example Affiliate (example) is owed $45.00', '3 sales made in August 2026', 'at 30%', 'Pay them by hand first']) {
    assert.ok(view.byId('payout-summary').textContent.includes(expected), `the summary says ${expected}`);
  }
  assert.equal(view.byId('payout-confirm').textContent, 'Confirm: I have paid $45.00');
  assert.equal(view.byId('payout-note').focused, true);
  assert.deepEqual(marks(), [], 'opening the confirm step records nothing');

  view.byId('payout-note').value = '   ';
  await view.byId('payout-form').fire('submit');
  assert.equal(view.byId('payout-form-status').dataset.state, 'error');
  assert.deepEqual(marks(), [], 'no note, no record');

  view.byId('payout-note').value = ' PayPal ';
  await view.byId('payout-form').fire('submit');
  assert.deepEqual(marks().map(([, args]) => plain(args)), [{ target_code: 'example', target_month: '2026-08-01', target_note: 'PayPal', expected_cents: 4500 }]);
  assert.equal(view.byId('payout-form').hidden, true);
  assert.equal(view.byId('payouts-status').dataset.state, 'success');
  assert.equal(view.byId('payouts-status').textContent, 'Recorded: August 2026 paid to example, $45.00 via PayPal.');
  assert.equal(supabase.calls.filter(([rpc]) => rpc === 'owner_affiliate_payable_by_month').length, 2, 'the months are reloaded');
  assert.equal(supabase.calls.filter(([rpc]) => rpc === 'owner_affiliates').length, 2, 'and so is the list');
});

test('Cancel closes the confirm step without recording anything', async () => {
  const supabase = client();
  const view = await run(supabase);
  await buttonIn(view.byId('payouts'), 'Mark paid').fire('click');
  view.byId('payout-note').value = 'PayPal';
  await view.byId('payout-cancel').fire('click');
  assert.equal(view.byId('payout-form').hidden, true);
  assert.equal(view.byId('payout-note').value, '');
  await view.byId('payout-form').fire('submit');
  assert.deepEqual(supabase.calls.filter(([rpc]) => rpc === 'owner_mark_month_paid'), [], 'a stray submit after cancel does nothing');
});

test('a refused Mark paid says why and leaves the confirm step open', async () => {
  for (const [error, expected] of [
    [{ code: '55000', message: 'August 2026 is inside the 30-day refund hold until 2026-10-01 (UTC)' }, /inside the 30-day refund hold/],
    [{ code: '23505', message: 'August 2026 is already marked paid for example' }, /already marked paid/],
    [{ code: '55000', message: 'The payable amount is now $30.00, not $45.00. Reload the page and check the month before marking it paid.' }, /now \$30\.00/],
    [{ code: '42501', message: 'Owner access required' }, /no longer has owner access/],
    [{ code: 'PGRST000', message: 'connection reset' }, /could not be recorded/],
  ]) {
    const view = await run(client({ markError: error }));
    await buttonIn(view.byId('payouts'), 'Mark paid').fire('click');
    view.byId('payout-note').value = 'PayPal';
    await view.byId('payout-form').fire('submit');
    assert.equal(view.byId('payout-form-status').dataset.state, 'error');
    assert.match(view.byId('payout-form-status').textContent, expected);
    assert.equal(view.byId('payout-form').hidden, false);
    assert.equal(view.byId('payout-confirm').disabled, false);
  }
});

test('CSV cells are escaped, and a cell a spreadsheet would run as a formula is made text', async () => {
  const { csvCell } = (await run(client())).helpers;
  for (const [value, expected] of [
    ['plain', 'plain'], ['', ''], [null, ''], [undefined, ''], [0, '0'], ['45.00', '45.00'], ['a=b', 'a=b'],
    ['a,b', '"a,b"'], ['say "hi"', '"say ""hi"""'], ['line\nbreak', '"line\nbreak"'], ['carriage\rreturn', '"carriage\rreturn"'],
    ['=1+1', "'=1+1"], ['+1', "'+1"], ['-cmd', "'-cmd"], ['@SUM(A1)', "'@SUM(A1)"], ['\t=1', "'\t=1"], ['\r=1', `"'\r=1"`],
    ['=HYPERLINK("http://example.net","pay, now")', `"'=HYPERLINK(""http://example.net"",""pay, now"")"`],
    ['PayPal, less 15.00 clawback', '"PayPal, less 15.00 clawback"'],
  ]) {
    assert.equal(csvCell(value), expected, JSON.stringify(value));
  }
});

test('Download CSV exports every month; the per-sale export lists each sale behind them', async () => {
  const supabase = client();
  const view = await run(supabase);
  const asked = supabase.calls.length;
  await view.byId('payouts-csv').fire('click');
  await view.byId('payout-sales-csv').fire('click');
  assert.equal(supabase.calls.length, asked, 'a download asks the database for nothing');
  assert.equal(view.downloads.length, 2);
  const links = view.body.findAll((node) => node.tag === 'a');
  assert.match(links[0].download, /^wavread-affiliate-payouts-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(links[1].download, /^wavread-affiliate-payout-sales-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(links.every((link) => link.clicked === 1 && link.removed), 'each link is clicked once and removed');
  assert.equal(view.downloads[0].blob.type, 'text/csv;charset=utf-8');

  assert.equal(view.downloads[0].blob.text, [
    '\uFEFFaffiliate code,period month,sales count,amount (dollars),status,paid date,method note,needs review sales,clawback (dollars)',
    'example,2026-10,1,15.00,on hold,,,0,0.00',
    'example,2026-08,3,45.00,payable; needs review,,,1,0.00',
    'example,2026-07,2,30.00,paid; clawback needed,2026-09-05,PayPal,0,15.00',
    `'-cmd,2026-06,1,15.00,paid,2026-08-02,"'=HYPERLINK(""http://example.net"",""pay, now"")",0,0.00`,
    '',
  ].join('\r\n'));

  assert.equal(view.downloads[1].blob.text, [
    '\uFEFFaffiliate code,period month,purchase date,session id suffix,gross (dollars),commission (dollars),status,refunded (dollars)',
    'example,2026-10,2026-10-20,Oct20aaa,50.00,15.00,on hold,',
    'example,2026-08,2026-08-02,Aug02aaa,50.00,15.00,payable,',
    'example,2026-08,2026-08-09,Aug09bbb,50.00,15.00,payable,',
    'example,2026-08,2026-08-11,Aug11ccc,50.00,0.00,needs review,20.00',
    'example,2026-08,2026-08-30,Aug30ddd,50.00,15.00,payable,',
    'example,2026-07,2026-07-03,Jul03aaa,50.00,15.00,paid,',
    'example,2026-07,2026-07-19,Jul19bbb,50.00,15.00,clawback needed,unknown',
    "'-cmd,2026-06,2026-06-14,'@SUM(A1),50.00,15.00,paid,",
    '',
  ].join('\r\n'));
});

test('the payouts copy states the rules', async () => {
  const html = await read(PAGE);
  const start = html.indexOf('aria-labelledby="payouts-title"');
  const section = html.slice(start, html.indexOf('</section>', start));
  for (const rule of [/\$15 on a \$50 sale at 30%/, /30-day refund window/, /once a month/, /Pay the affiliate first, then mark the month paid/,
                      /later rate change only affects sales not yet paid/, /needs review/, /clawback needed/, /Nothing here is adjusted automatically/]) {
    assert.match(section, rule);
  }
  assert.match(section, /<form id="payout-form" hidden novalidate>/);
  assert.match(section, /<button class="btn" id="payouts-csv" type="button" disabled>Download CSV<\/button>/);
  assert.match(section, /<button class="btn" id="payout-sales-csv" type="button" disabled>Download per-sale CSV<\/button>/);
  assert.doesNotMatch(html, /Still to confirm|Payouts are not recorded here/, 'the open questions this settles are gone');
});
