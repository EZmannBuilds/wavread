// The dashboard's own script with a trial on the account: the standing card,
// the download buttons and the notes, run in a page that has only the
// elements they touch and a Supabase client answering canned rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const DAY_MS = 24 * 3600 * 1000;
const at = (days) => new Date(Date.now() + days * DAY_MS).toISOString();

// The paid build and, beside it, the trial build of the same version
// (20261027120000). Each account is shown only its own kind.
const CATALOG = [
  { id: 18, version: '1.5.6', platform: 'windows', kind: 'trial', file_name: 'WavRead-1.5.6-Trial-Setup.exe', price_cents: 5000, sha256: 'e'.repeat(64), size_bytes: 1, released_at: at(-14) },
  { id: 17, version: '1.5.6', platform: 'macos', kind: 'trial', file_name: 'WavRead-1.5.6-Trial.dmg', price_cents: 5000, sha256: 'd'.repeat(64), size_bytes: 1, released_at: at(-14) },
  { id: 16, version: '1.5.6', platform: 'windows', kind: 'full', file_name: 'WavRead-1.5.6-Setup.exe', price_cents: 5000, sha256: 'c'.repeat(64), size_bytes: 1, released_at: at(-14) },
  { id: 15, version: '1.5.6', platform: 'macos', kind: 'full', file_name: 'WavRead-1.5.6.dmg', price_cents: 5000, sha256: 'b'.repeat(64), size_bytes: 1, released_at: at(-14) },
];
const TRIAL = { source: 'trial', build_version: null, granted_at: at(-3), expires_at: at(11), revoked_at: null };
const EXPIRED = { ...TRIAL, granted_at: at(-15), expires_at: at(-1) };
const PURCHASE = { source: 'purchase', build_version: null, granted_at: at(-1), expires_at: null, revoked_at: null };

function element(id) {
  return {
    id, children: [], dataset: {}, hidden: true, disabled: false, className: '', textContent: '', href: 'buy.html', listeners: {},
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute() {},
  };
}

// A Supabase client that answers each table with fixed rows, whatever the
// filters. The filters the page sends are recorded, so a test can see them.
function client(tables) {
  const asked = [];
  return {
    asked,
    from(table) {
      const query = {
        filters: [],
        select(columns) { asked.push({ table, columns }); return query; },
        eq(column, value) { query.filters.push(['eq', column, value]); return query; },
        is(column, value) { query.filters.push(['is', column, value]); return query; },
        order() { return query; },
        maybeSingle() { query.single = true; return query; },
        then(resolve) {
          const rows = tables[table] ?? [];
          return resolve({ data: query.single ? rows[0] ?? null : rows, error: null });
        },
      };
      return query;
    },
  };
}

async function dashboard({ entitlements, purchases = [], account = { free_updates: false } }) {
  const ids = ['ownership-title', 'ownership-detail', 'ownership-action', 'builds-list', 'builds-empty', 'builds-locked',
    'builds-trial-ended', 'builds-status', 'current-build-date', 'platform-downloads', 'platform-note'];
  const page = Object.fromEntries(ids.map((id) => [id, element(id)]));
  const context = vm.createContext({
    Intl, URL, URLSearchParams, AbortSignal, Date,
    navigator: { userAgentData: { platform: 'macOS', mobile: false }, userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 },
    location: { hostname: 'wavread.com', origin: 'https://wavread.com' },
    document: { createElement: element, querySelector: (selector) => page[selector.replace(/^#/, '')] ?? null },
    supabaseStub: client({ accounts: [account], entitlements, purchases, builds: CATALOG }),
    downloaded: [], bought: [],
  });
  const source = (await readFile('docs/js/beta-auth.js', 'utf8')).replace('initializeSignIn();\ninitializeDashboard();', '');
  vm.runInContext(`${source}
supabase = supabaseStub;
currentUser = { id: 'user-1', email: 'trial@example.net' };
buildTable = (headers, rows) => ({ headers, rows });
downloadBuild = (build) => downloaded.push(build.id);
buyBuild = (build) => bought.push(build.id);`, context);
  const standing = await vm.runInContext('loadOwnership()', context);
  await vm.runInContext('(standing) => loadBuilds(standing)', context)(standing);
  const buttons = page['platform-downloads'].children.map((item) => ({ platform: item.dataset.platform, button: item.children[0] }));
  const table = page['builds-list'].children[0];
  return { page, standing, buttons, table, context };
}

test('a running trial shows when it ends, offers the $50 purchase, and downloads both trial builds', async () => {
  const { page, buttons, table, context } = await dashboard({ entitlements: [TRIAL] });
  assert.equal(page['ownership-title'].textContent, 'On a free trial');
  const ends = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .format(new Date(TRIAL.expires_at));
  assert.equal(page['ownership-detail'].textContent,
    `Your 14-day trial covers Mac and Windows until ${ends}. Buy WavRead to keep it after that.`, 'an absolute end date, to the minute');
  assert.equal(page['ownership-action'].hidden, false);
  assert.equal(page['ownership-action'].href, '/buy');
  assert.equal(page['ownership-action'].textContent, 'Buy WavRead — $50 →');

  assert.deepEqual(buttons.map((b) => b.button.textContent), ['Download for Mac', 'Download for Windows']);
  buttons.forEach((b) => b.button.listeners.click());
  assert.deepEqual(context.downloaded, [17, 18], 'the trial builds, never the paid ones');
  assert.equal(table.rows.length, 2, 'only the trial builds are listed');
  assert.equal(page['builds-locked'].hidden, true);
  assert.equal(page['builds-trial-ended'].hidden, true);
  assert.match(table.rows[0][5].textContent, /^trial until /);
});

test('an ended trial closes the downloads, says so, and offers the purchase', async () => {
  for (const ended of [EXPIRED, { ...TRIAL, revoked_at: at(-1) }]) {
    const { page, buttons, table, context } = await dashboard({ entitlements: [ended] });
    assert.equal(page['ownership-title'].textContent, 'Trial ended');
    assert.match(page['ownership-detail'].textContent, /^Your 14-day trial ended .+\. Downloads are closed until you buy WavRead\.$/);
    assert.equal(page['ownership-action'].href, '/buy');
    assert.equal(page['ownership-action'].hidden, false);

    assert.ok(buttons.every((b) => !/Download/.test(b.button.textContent)), 'no download button is offered');
    assert.deepEqual(buttons.map((b) => b.button.textContent), ['Buy — $50.00', 'Buy — $50.00']);
    buttons[0].button.listeners.click();
    assert.deepEqual(context.downloaded, []);
    assert.deepEqual(context.bought, [15]);
    assert.equal(page['builds-trial-ended'].hidden, false, 'the trial-ended note replaces the not-owned one');
    assert.equal(page['builds-locked'].hidden, true);
    assert.ok(table.rows.every((row) => row[5].textContent === 'not owned'));
  }
});

test('a revoked trial reports the day it was revoked, not the day it would have run out', async () => {
  const revoked = at(-1);
  const { page } = await dashboard({ entitlements: [{ ...TRIAL, revoked_at: revoked }] });
  const year = new Date(revoked).getFullYear();
  assert.match(page['ownership-detail'].textContent, new RegExp(`ended .*${year}`));
  const would = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(new Date(TRIAL.expires_at));
  assert.doesNotMatch(page['ownership-detail'].textContent, new RegExp(`${would},`));
});

test('a buyer who started on a trial sees exactly what any buyer sees', async () => {
  const converted = await dashboard({ entitlements: [{ ...TRIAL, revoked_at: at(-1) }, PURCHASE], purchases: [{ amount_cents: 5000, status: 'paid' }] });
  const plain = await dashboard({ entitlements: [PURCHASE], purchases: [{ amount_cents: 5000, status: 'paid' }] });
  for (const id of ['ownership-title', 'ownership-detail']) {
    assert.equal(converted.page[id].textContent, plain.page[id].textContent, id);
  }
  assert.equal(converted.page['ownership-title'].textContent, 'Owned');
  assert.equal(converted.page['ownership-action'].hidden, true);
  assert.deepEqual(converted.buttons.map((b) => b.button.textContent), ['Download for Mac', 'Download for Windows']);
  converted.buttons.forEach((b) => b.button.listeners.click());
  assert.deepEqual(converted.context.downloaded, [15, 16], 'a buyer gets the paid builds, never the trial ones');
  assert.equal(converted.table.rows.length, 2);
  assert.equal(converted.page['builds-trial-ended'].hidden, true);
  assert.ok(converted.table.rows.every((row) => row[5].textContent === 'included'));
  assert.equal(converted.standing.trial, null, 'a paid account is not on a trial');
});

test('a grantee and a contributor keep their standing, trial or not', async () => {
  const grantee = await dashboard({ entitlements: [{ ...PURCHASE, source: 'grant' }, EXPIRED] });
  assert.equal(grantee.page['ownership-title'].textContent, 'Owned');
  const contributor = await dashboard({ entitlements: [EXPIRED], account: { free_updates: true, free_updates_note: 'Thanks for the reports.' } });
  assert.equal(contributor.page['ownership-detail'].textContent, 'Thanks for the reports.');
  assert.deepEqual(contributor.buttons.map((b) => b.button.textContent), ['Download for Mac', 'Download for Windows']);
});

test('an account with nothing keeps the not-owned card it always had', async () => {
  const { page } = await dashboard({ entitlements: [] });
  assert.equal(page['ownership-title'].textContent, 'Not owned yet');
  assert.equal(page['ownership-action'].href, 'buy.html', 'the existing link is left alone');
  assert.equal(page['builds-locked'].hidden, false);
  assert.equal(page['builds-trial-ended'].hidden, true);
});

test('the page reads every entitlement row, so an ended trial can be named', async () => {
  const { context } = await dashboard({ entitlements: [TRIAL] });
  const read = context.supabaseStub.asked.find((q) => q.table === 'entitlements');
  assert.match(read.columns, /source/);
  assert.match(read.columns, /expires_at/);
  assert.match(read.columns, /revoked_at/);
  const html = await readFile('docs/dashboard.html', 'utf8');
  assert.match(html, /id="builds-trial-ended" class="note caution" hidden>[\s\S]*?href="\/buy"/);
  assert.match(html, /id="devices-trial-note"[^>]*hidden>During a trial, up to 2 devices can be linked/);
  assert.doesNotMatch(html, /href="\/try/, 'no trial marketing page in this change');
});
