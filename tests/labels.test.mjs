import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AFFILIATE_RE, CAMPAIGN_CHANNELS, affiliateCodeFromLabel, campaignSource,
} from '../supabase/functions/_shared/labels.mjs';

test('advertisement labels keep the channel/variant contract', () => {
  for (const label of ['reels', 'reels-a', 'tiktok-hook2', 'shorts-ryma', 'yt-x', 'direct']) {
    assert.equal(campaignSource(label), label);
  }
  assert.deepEqual(CAMPAIGN_CHANNELS, ['reels', 'tiktok', 'shorts', 'yt', 'direct']);
  for (const label of ['email-ryma', 'reels-rym-a', `reels-${'x'.repeat(13)}`, 'xreels', 'reels-a plus prose']) {
    assert.equal(campaignSource(label), null, `${label} is not a label WavRead buys`);
  }
});

test('affiliate labels are aff- and a 2 to 32 character code', () => {
  for (const label of ['aff-ab', 'aff-example', 'aff-studio-2', `aff-${'a'.repeat(32)}`, 'aff-a-b-c']) {
    assert.equal(campaignSource(label), label, `${label} is accepted`);
  }
  for (const label of ['aff-a', `aff-${'a'.repeat(33)}`, 'aff-', 'aff', 'aff_example', 'affiliate-example',
                       'aff-ex ample', 'aff-exämple', 'aff-<script>', 'x-aff-example', 'aff-example\nreels']) {
    assert.equal(campaignSource(label), null, `${JSON.stringify(label)} is dropped`);
  }
});

test('labels are trimmed and lowercased, and anything that is not text is dropped', () => {
  assert.equal(campaignSource('  AFF-Example '), 'aff-example');
  assert.equal(campaignSource(' REELS-A '), 'reels-a');
  for (const value of [undefined, null, 42, {}, ['aff-example'], true]) {
    assert.equal(campaignSource(value), null);
  }
});

test('affiliateCodeFromLabel answers the code, and null for anything else', () => {
  assert.equal(affiliateCodeFromLabel('aff-example'), 'example');
  assert.equal(affiliateCodeFromLabel(' AFF-Studio-2 '), 'studio-2');
  for (const value of ['reels-a', 'direct', 'aff-a', 'aff_example', '', null, undefined]) {
    assert.equal(affiliateCodeFromLabel(value), null, `${value} names no affiliate`);
  }
});

test('the browser, the functions and the database agree on what an affiliate code is', () => {
  // The site stores and carries aff- labels with its own copy of the pattern;
  // if they drifted, a link could be stored that checkout then drops.
  for (const file of ['docs/js/navigation.js', 'docs/js/buy.js']) {
    assert.ok(readFileSync(file, 'utf8').includes(`/${AFFILIATE_RE.source}/`), `${file} uses ${AFFILIATE_RE}`);
  }
  // Every code the affiliates table can hold makes a label this accepts.
  const migration = readFileSync('supabase/migrations/20261021120000_affiliate_tracking.sql', 'utf8');
  assert.match(migration, /check \(code ~ '\^\[a-z0-9-\]\{2,32\}\$'\)/);
  assert.equal(AFFILIATE_RE.source, '^aff-[a-z0-9-]{2,32}$');
  // And every label fits the column the webhook writes it to.
  assert.match(migration, /source text\s+constraint purchases_source_check check \(source is null or source ~ '\^\[a-z0-9-\]\{1,40\}\$'\)/);
  assert.ok(`aff-${'a'.repeat(32)}`.length <= 40);
});

test('mod.ts hands the Edge Functions these rules rather than its own copy', () => {
  const shared = readFileSync('supabase/functions/_shared/mod.ts', 'utf8');
  assert.match(shared, /export \{ affiliateCodeFromLabel, campaignSource \} from "\.\/labels\.mjs";/);
  assert.doesNotMatch(shared, /CAMPAIGN_RE|AFFILIATE_RE/);
});
