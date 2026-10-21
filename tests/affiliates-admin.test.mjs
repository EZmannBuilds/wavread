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
  return { byId, submit, document: { querySelector: (selector) => byId(selector.replace(/^#/, '')), createElement: (tag) => new FakeNode(tag) } };
}

const AFFILIATES = [
  { code: 'example', name: 'Example Affiliate', email: 'affiliate@example.net', commission_pct: 30, active: true, created_at: '2026-10-01T00:00:00Z',
    sales: 3, gross_cents: 15000, pending_sales: 1, pending_commission_cents: 1500, payable_commission_cents: 3000, refunds: 1, refunded_cents: 5000,
    months: [{ month: '2026-09', sales: 1, gross_cents: 5000, commission_cents: 1500 }, { month: '2026-08', sales: 1, gross_cents: 5000, commission_cents: 1500 }] },
  { code: 'paused', name: 'Paused Affiliate', email: 'paused@example.net', commission_pct: 25, active: false, created_at: '2026-10-02T00:00:00Z',
    sales: 0, gross_cents: 0, pending_sales: 0, pending_commission_cents: 0, payable_commission_cents: 0, refunds: 0, refunded_cents: 0, months: [] },
];

function client({ user = true, owner = true, permissionError = null, saveError = null } = {}) {
  const calls = [];
  return {
    calls,
    auth: { getUser: async () => ({ data: { user: user ? { id: 'session-user' } : null }, error: null }) },
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'owner_licence_status') return { data: owner, error: permissionError };
      if (name === 'owner_affiliates') return owner ? { data: AFFILIATES, error: null } : { data: null, error: { code: '42501' } };
      if (name === 'owner_save_affiliate') return saveError ? { data: null, error: saveError } : { data: { code: args.target_code }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

async function run(supabase) {
  const view = page();
  const source = (await read('docs/js/affiliates-admin.js')).replace(/\ncreateAdminClient\(\)[\s\S]*$/, '\n');
  const context = vm.createContext({ document: view.document, location: { hostname: 'localhost' }, window: {},
    navigator: { clipboard: { writeText: async (text) => { view.copied = text; } } } });
  vm.runInContext(`${source}\nglobalThis.start = initializeAffiliateAdmin;`, context);
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
  assert.deepEqual(supabase.calls.map(([rpc]) => rpc), ['owner_licence_status', 'owner_affiliates']);
  assert.equal(view.submit.disabled, false);

  const rows = view.byId('affiliate-list').findAll((node) => node.tag === 'tr').slice(1).map((row) => row.text);
  assert.equal(rows.length, 2);
  for (const expected of ['Example Affiliate', 'example · affiliate@example.net', 'https://wavread.com/?from=aff-example', '30%', 'Active',
                          '3 · $150.00', '1 · $15.00', '$30.00', '1 · $50.00', 'Deactivate']) {
    assert.ok(rows[0].includes(expected), `the row shows ${expected}: ${rows[0]}`);
  }
  assert.ok(rows[1].includes('Inactive') && rows[1].includes('Reactivate') && rows[1].includes('https://wavread.com/?from=aff-paused'));

  const months = view.byId('affiliate-months').findAll((node) => node.tag === 'tr').slice(1).map((row) => row.text);
  assert.deepEqual(months, ['2026-09 Example Affiliate (example) 1 $50.00 $15.00', '2026-08 Example Affiliate (example) 1 $50.00 $15.00']);
  assert.equal(view.byId('affiliate-months-empty').hidden, true);

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
    ['owner_affiliates', 'owner_licence_status', 'owner_save_affiliate']);
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
  const dashboard = await read('docs/dashboard.html');
  const ownerSection = dashboard.slice(dashboard.indexOf('id="licence-admin"'), dashboard.indexOf('</section>', dashboard.indexOf('id="licence-admin"')));
  assert.match(ownerSection, /href="\/admin\/affiliates"/, 'reached from the owner-only dashboard section');
  assert.equal(dashboard.indexOf('/admin/affiliates'), dashboard.lastIndexOf('/admin/affiliates'), 'and nowhere else');
});
