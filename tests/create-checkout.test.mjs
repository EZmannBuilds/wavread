import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkoutBuild, DEFAULT_PLATFORM } from '../supabase/functions/create-checkout/build.mjs';
import { checkoutAttribution } from '../supabase/functions/create-checkout/attribution.mjs';

// The catalog as it stands since 2026-10-12: the Mac and Windows builds of
// 1.5.6 both published, the Windows row the newer of the two, and a withdrawn
// Demucs-era build that must never be sold.
const MAC = { id: 15, version: '1.5.6', platform: 'macos', price_cents: 5000, published: true, released_at: '2026-10-01T12:00:00Z' };
const WINDOWS = { id: 16, version: '1.5.6', platform: 'windows', price_cents: 5000, published: true, released_at: '2026-10-12T12:00:00Z' };
const WITHDRAWN = { id: 3, version: '1.4.8', platform: 'macos', price_cents: 500, published: false, released_at: '2026-08-01T12:00:00Z' };
// Newer than every published Mac build, and not published: the default must
// not reach past the published filter to it.
const UNRELEASED = { id: 17, version: '1.5.7', platform: 'macos', price_cents: 5000, published: false, released_at: '2026-10-14T12:00:00Z' };

// A stand-in for the supabase-js query builder that applies the filters it is
// given to the rows it holds, so what comes back is what the query asked for.
function catalog(rows) {
  return {
    from(table) {
      assert.equal(table, 'builds');
      let result = [...rows];
      const query = {
        select: () => query,
        eq(column, value) { result = result.filter((row) => row[column] === value); return query; },
        order(column, { ascending }) {
          result.sort((a, b) => (ascending ? 1 : -1) * String(a[column]).localeCompare(String(b[column])));
          return query;
        },
        limit(count) { result = result.slice(0, count); return query; },
        async maybeSingle() {
          return result.length > 1
            ? { data: null, error: { message: 'more than one row' } }
            : { data: result[0] ?? null, error: null };
        },
      };
      return query;
    },
  };
}

const ALL = [MAC, WINDOWS, WITHDRAWN, UNRELEASED];

test('a checkout that names no build buys the newest published Mac build', async () => {
  assert.equal(DEFAULT_PLATFORM, 'macos');
  // The public buy page sends { email } and nothing else; an id that is not a
  // positive integer has always been read as no id.
  for (const buildId of [undefined, null, 0, -16, 'abc', 1.5]) {
    const build = await checkoutBuild(catalog(ALL), buildId);
    assert.equal(build?.id, MAC.id, `build_id ${buildId}`);
  }
});

test('the default is the newest Mac build, not the first one', async () => {
  const older = { ...MAC, id: 12, version: '1.5.4', released_at: '2026-09-10T12:00:00Z' };
  const build = await checkoutBuild(catalog([older, MAC, WINDOWS]), undefined);
  assert.equal(build?.id, MAC.id);
});

test('with only a Windows build published, a checkout naming no build sells nothing', async () => {
  // The product it would open is described as WavRead for macOS.
  assert.equal(await checkoutBuild(catalog([WINDOWS, WITHDRAWN]), undefined), null);
});

test('a checkout that names a published Windows build buys that build', async () => {
  for (const buildId of [16, '16']) {
    const build = await checkoutBuild(catalog(ALL), buildId);
    assert.equal(build?.id, WINDOWS.id, `build_id ${JSON.stringify(buildId)}`);
    assert.equal(build.price_cents, 5000);
  }
  assert.equal((await checkoutBuild(catalog(ALL), 15))?.id, MAC.id);
});

test('a checkout that names an unpublished or unknown build sells nothing', async () => {
  for (const buildId of [WITHDRAWN.id, UNRELEASED.id, 999]) {
    assert.equal(await checkoutBuild(catalog(ALL), buildId), null, `build_id ${buildId}`);
  }
});

test('a catalog that cannot be read sells nothing', async () => {
  const broken = {
    from: () => {
      const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: MAC, error: { message: 'connection reset' } }) };
      return query;
    },
  };
  assert.equal(await checkoutBuild(broken, undefined), null);
  assert.equal(await checkoutBuild(broken, 16), null);
});

test('the checkout function chooses its build with checkoutBuild', async () => {
  const fn = await readFile(new URL('../supabase/functions/create-checkout/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /import \{ checkoutBuild \} from "\.\/build\.mjs";/);
  assert.match(fn, /const build = await checkoutBuild\(serviceClient\(\), body\?\.build_id\);/);
  // No second, platform-blind query for the newest build left beside it.
  assert.doesNotMatch(fn, /released_at/);
});

test('an advertisement label reaches Stripe as metadata[source] alone', () => {
  assert.deepEqual(checkoutAttribution('reels-a'), { 'metadata[source]': 'reels-a' });
  assert.deepEqual(checkoutAttribution(' TIKTOK-Hook2 '), { 'metadata[source]': 'tiktok-hook2' });
});

test('an affiliate label also sets client_reference_id and metadata[affiliate]', () => {
  assert.deepEqual(checkoutAttribution('aff-example'), {
    'metadata[source]': 'aff-example',
    'client_reference_id': 'aff-example',
    'metadata[affiliate]': 'example',
  });
  assert.equal(checkoutAttribution(' AFF-Studio-2 ')['metadata[affiliate]'], 'studio-2');
});

test('a missing or unrecognized label adds nothing, and never stops the sale', () => {
  for (const value of [undefined, null, '', 'aff-a', 'aff_example', 'newsletter', 'reels-a plus prose', 42, { source: 'aff-example' }]) {
    assert.deepEqual(checkoutAttribution(value), {}, `${JSON.stringify(value)} adds no field`);
  }
});

test('the checkout function sends exactly those fields, after the price is fixed', async () => {
  const fn = await readFile(new URL('../supabase/functions/create-checkout/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /import \{ checkoutAttribution \} from "\.\/attribution\.mjs";/);
  assert.match(fn, /for \(const \[field, value\] of Object\.entries\(checkoutAttribution\(body\?\.source\)\)\) \{\s*params\.set\(field, value\);/);
  // The label can name an affiliate, never a price: amount and attribution are
  // separate, and nothing about the label reaches unit_amount.
  assert.ok(fn.indexOf('unit_amount]", String(amountCents)') < fn.indexOf('checkoutAttribution(body'));
  assert.doesNotMatch(fn, /client_reference_id|metadata\[affiliate\]/, 'set in one place only, attribution.mjs');
});
