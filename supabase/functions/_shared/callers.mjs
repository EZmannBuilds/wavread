// Who is calling an Edge Function: which browser origins count as the site,
// and which network address a request came from. Plain JavaScript with no Deno
// globals, so tests/callers.test.mjs runs these rules under node:test exactly
// as the functions run them. mod.ts reads the deployment's settings and passes
// them in.

const LOCAL_ORIGINS = ["http://127.0.0.1:4173", "http://localhost:4173"];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// env: { siteUrl, allowedOrigins, allowLocal, vercelTeam }, the values of
// SITE_URL, ALLOWED_ORIGINS, ALLOW_LOCAL_ORIGINS and VERCEL_TEAM.
//
// One site can answer to several names (a custom domain, its www form, the
// platform hostname) and a browser judges CORS by the exact one in the address
// bar, so ALLOWED_ORIGINS lists every name the site legitimately serves.
//
// The local preview's origins used to be on this list in production too, which
// made any program listening on port 4173 of a visitor's own machine count as
// the site. They are allowed only where ALLOW_LOCAL_ORIGINS is "true", which is
// for the local Supabase stack.
export function allowedOrigins(env) {
  const site = String(env.siteUrl ?? "").trim().replace(/\/$/, "");
  const configured = String(env.allowedOrigins ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const local = env.allowLocal === "true" ? LOCAL_ORIGINS : [];
  return [...new Set([site, ...configured, ...local].filter(Boolean))];
}

// Vercel gives every preview deployment its own hostname, so a fixed list can
// only ever allow production. The first rule here accepted
// <project>-<anything>.vercel.app, and anybody can create a Vercel project
// whose name begins "wavread-", so any stranger's site counted as this one. A
// preview is now accepted only in the two shapes Vercel itself gives one,
// ending in the team named by VERCEL_TEAM:
//
//   <project>-<9-character hash>-<team>.vercel.app
//   <project>-git-<branch>-<team>.vercel.app
//
// That is narrower, not airtight: it still trusts that nobody else holds a
// project named in exactly that shape. So with VERCEL_TEAM unset, the
// production default, no preview is accepted at all. Previews are behind Vercel
// sign-in anyway, and checkout from a preview takes real money.
export function previewPatterns(env) {
  const team = String(env.vercelTeam ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(team)) return [];
  return allowedOrigins(env)
    .map((origin) => origin.match(/^https:\/\/([a-z0-9-]+)\.vercel\.app$/))
    .filter(Boolean)
    .flatMap((match) => {
      const project = escape(match[1]);
      const owner = escape(team);
      return [
        new RegExp(`^https://${project}-[a-z0-9]{9}-${owner}\\.vercel\\.app$`),
        new RegExp(`^https://${project}-git-[a-z0-9-]{1,63}-${owner}\\.vercel\\.app$`),
      ];
    });
}

// The Access-Control-Allow-Origin value for a request from `origin`. An origin
// that is not the site gets the site's own name back, which a browser reads as
// a refusal.
export function allowOriginFor(origin, env) {
  const allowed = allowedOrigins(env);
  if (allowed.includes(origin)) return origin;
  if (previewPatterns(env).some((pattern) => pattern.test(origin))) return origin;
  return allowed[0] ?? "";
}

// The network address a request came from, for rate limits only.
//
// X-Forwarded-For is a list the sender can start: Supabase appends the
// address it saw to whatever the request already carried, so the leftmost
// entry is whatever the sender chose to write
// (github.com/orgs/supabase/discussions/34647). A limit keyed on it is a
// limit the sender picks. Supabase's API sits behind Cloudflare, which sets
// cf-connecting-ip to the address it saw and overwrites any value a request
// arrives with, so that comes first. Failing it, the rightmost forwarded entry
// is the one the platform added. If that ever turns out to be an internal hop
// shared by everyone, the per-address limit degrades into one shared limit:
// stricter, never looser.
export function clientAddressFrom(headers) {
  const direct = String(headers.get("cf-connecting-ip") ?? "").trim();
  if (direct) return direct.slice(0, 64);
  const hops = String(headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return (hops.at(-1) ?? "unknown").slice(0, 64);
}

// A hex HMAC-SHA256 of `text` under `secret`. Rate-limit counters key on this
// rather than on the address itself, so the table never holds an address and a
// copy of it cannot be reversed without the function's secret.
export async function keyedDigest(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
