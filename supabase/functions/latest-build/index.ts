// latest-build — what the newest published build is, for the desktop updater.
//
// The app used to ask GitHub's releases API, which worked only for as long as
// somebody remembered to cut a release there by hand. Twice nobody did: 1.4.47
// and 1.4.48 were finished, and every installation went on being told that
// 1.4.46 was current. The catalog is what decides which build a customer may
// download, so it should also be what answers "is there a newer one" —
// publishing once rather than twice, with no second place to forget.
//
// What comes back is deliberately thin: a version, when it was released, and
// the checksum and size of its disk image. No storage path, no signed URL,
// nothing that can become a download. The build itself stays behind
// download-build and an entitlement; this only says that one exists.
//
// Public on purpose (verify_jwt = false). The version number is printed on the
// website already, and requiring a sign-in to learn it would mean the desktop
// app either carries a credential or stops checking — and an updater that has
// to be trusted with a credential is a worse thing to ship than one that
// announces a number.
//
// No CORS helper, unlike every other function here: no browser calls this. The
// desktop app is not a browser, and the website reaches it through its own
// /api/latest-build handler, server side. Nothing would be served by pretending
// otherwise.

import { createClient } from "jsr:@supabase/supabase-js@2";

// The version changes on release day, not between two checks a second apart.
const CACHE_SECONDS = 300;

function reply(status: number, body: unknown, cache: boolean): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? `public, max-age=${CACHE_SECONDS}` : "no-store",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return reply(405, { error: "GET only" }, false);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // The newest published row, whichever channel it sits on. `published` is the
  // whole gate, and it already carries this meaning: the three Demucs-era
  // builds are unpublished precisely so that nothing can offer them. A build
  // that should not be offered to everyone must not be published — that rule is
  // now load-bearing for the announcement as well as for the download.
  const build = await db
    .from("builds")
    .select("version, released_at, sha256, size_bytes")
    .eq("published", true)
    .order("released_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (build.error) {
    console.error("catalog read failed", build.error);
    return reply(500, { error: "the catalog could not be read" }, false);
  }
  if (!build.data) {
    // Not an error: a catalog with nothing published is a real state, and the
    // app should read it as "nothing newer", not as "something went wrong".
    return reply(200, { version: null }, false);
  }

  const site = (Deno.env.get("SITE_URL") ?? "https://wavread.com")
    .replace(/\/$/, "");

  return reply(200, {
    version: build.data.version,
    released_at: build.data.released_at,
    sha256: build.data.sha256,
    size_bytes: build.data.size_bytes,
    // Where a person goes to get it. The download needs a signed-in account
    // holding an entitlement, so the app sends them here rather than
    // pretending it can fetch the file itself.
    url: `${site}/dashboard`,
  }, true);
});
