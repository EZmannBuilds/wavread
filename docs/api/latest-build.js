// The updater's stable address.
//
// An installed copy of WavRead cannot be edited afterwards, so the one URL
// baked into it has to be a name that will still mean WavRead in five years.
// That name is wavread.com, not a Supabase project reference — so the app asks
// here, and this forwards to the Edge Function that reads the build catalog.
// If the backend ever moves, the app does not have to.
//
// Cached at the edge: the answer changes on release day, and every copy of
// WavRead asks the same question and gets the same answer.
module.exports = async function handler(request, response) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  // Read-only, so nothing else is answered. A POST that quietly returned the
  // same thing would suggest this endpoint accepts something; it does not.
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Cache-Control", "no-store");
    return response.status(405).json({ error: "GET only" });
  }

  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  if (!url) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({ error: "not configured" });
  }

  try {
    const upstream = await fetch(`${url}/functions/v1/latest-build`, {
      headers: { Accept: "application/json" },
    });
    const body = await upstream.text();
    // Only a good answer is worth caching. A failure cached for five minutes
    // is five minutes of every installation being told the same wrong thing.
    //
    // Both headers, because they are read by different things and the platform
    // does not always pass the first one through to its own edge: CDN-Cache-
    // Control is what the edge obeys, Cache-Control is what anything between
    // here and the app obeys.
    const caching = upstream.ok
      ? "public, s-maxage=300, stale-while-revalidate=3600"
      : "no-store";
    response.setHeader("Cache-Control", caching);
    response.setHeader("CDN-Cache-Control", caching);
    return response.status(upstream.status).send(body);
  } catch {
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({ error: "the catalog could not be reached" });
  }
};
