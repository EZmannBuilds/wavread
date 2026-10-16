// Which build a checkout buys. Plain JavaScript with no Deno globals, so
// tests/create-checkout.test.mjs runs it under node:test exactly as the
// function runs it. index.ts hands over the service client and whatever the
// browser sent as build_id.

// The public buy page sends an email and nothing else, and the Stripe product
// it opens says "WavRead for macOS". Mac and Windows share one catalog, so
// "the newest published build" without a platform became the Windows
// installer the day one was published (1.5.6 Setup.exe). A checkout that names
// no build buys the newest Mac build, the same answer latest-build gives the
// Mac updater when it asks with no platform.
export const DEFAULT_PLATFORM = 'macos';

// A checkout that names a build buys that build, on whichever platform it is
// for: the dashboard sends the id of the row the buyer clicked. The id must
// still be a published row. `published` is the gate download-build and
// latest-build use, and a checkout for an unpublished build would take money
// for something nothing will hand over. It is applied in the query on both
// paths, so a row that is not published is never returned at all.
//
// Answers the row, or null when there is nothing to sell. A build_id that is
// not a positive integer is read as no build_id, as it always has been.
export async function checkoutBuild(db, buildId) {
  const wanted = Number(buildId);
  const query = db
    .from('builds')
    .select('id, version, price_cents')
    .eq('published', true);
  const found = Number.isInteger(wanted) && wanted > 0
    ? await query.eq('id', wanted).maybeSingle()
    : await query
      .eq('platform', DEFAULT_PLATFORM)
      .order('released_at', { ascending: false })
      .limit(1)
      .maybeSingle();
  return !found.error && found.data ? found.data : null;
}
