// Shared pieces for WavRead's Edge Functions.
//
// Every function here runs on Supabase's Deno runtime. Secrets arrive as
// environment variables; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// injected by the platform, the rest are set with `supabase secrets set`.
// The service-role client exists only inside these functions — it is never
// sent to a browser or the desktop app.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Origins allowed to call the browser-facing functions. The desktop app is
// not a browser and sends no Origin; CORS never gates it.
function siteOrigin(): string {
  return (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
}

// One site can answer to several names — a custom domain, its www form, and
// the platform hostname — and a browser judges CORS by the exact one in the
// address bar. ALLOWED_ORIGINS lists every name the site legitimately serves;
// SITE_URL stays the canonical one used for redirects back from Stripe.
function allowedOrigins(): string[] {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const origins = [...configured, "http://127.0.0.1:4173", "http://localhost:4173"];
  const site = siteOrigin();
  if (site) origins.unshift(site);
  return [...new Set(origins)];
}

// Vercel gives every preview deployment its own hostname —
// `<project>-<hash>-<team>.vercel.app` — so a fixed list can only ever allow
// production. Previews are derived from whichever allowed origin is a
// vercel.app hostname, and nothing else on vercel.app is accepted.
function previewPatterns(): RegExp[] {
  return allowedOrigins()
    .map((origin) => origin.match(/^https:\/\/([a-z0-9-]+)\.vercel\.app$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const project = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^https://${project}-[a-z0-9-]+\\.vercel\\.app$`);
    });
}

function allowOrigin(origin: string): string {
  const allowed = allowedOrigins();
  if (allowed.includes(origin)) return origin;
  if (previewPatterns().some((pattern) => pattern.test(origin))) return origin;
  return allowed[0] ?? "";
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin(req.headers.get("Origin") ?? ""),
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(
  req: Request,
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(req),
    },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  return null;
}

// Reads a JSON body without trusting its size. A report can be a few tens of
// kilobytes; nothing this API accepts is legitimately a megabyte.
export async function readJson(
  req: Request,
  maxBytes = 128 * 1024,
): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (raw.length > maxBytes) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) {
    return null;
  }
  return email;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  const visible = user.slice(0, 1);
  return `${visible}${"•".repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function boundedText(
  value: unknown,
  min: number,
  max: number,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < min || text.length > max) return null;
  return text;
}

export function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim().slice(0, max);
}

// The desktop app's report token: random bytes the server only ever stores
// hashed. 32 bytes of entropy, base64url without padding.
export function newDeviceToken(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export interface CrashPayload {
  install_id: string;
  app_version: string;
  os_version: string | null;
  arch: string | null;
  kind: "exception" | "crash" | "startup_failure";
  summary: string;
  detail: string;
  fingerprint: string;
  occurred_at: string;
}

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const CRASH_KINDS = new Set(["exception", "crash", "startup_failure"]);

// Validates one crash record against the same bounds the database enforces,
// so a bad payload fails with a sentence instead of a constraint violation.
export function validateCrash(
  body: Record<string, unknown>,
): { crash: CrashPayload } | { error: string } {
  if (!isUuid(body.install_id)) return { error: "missing install id" };
  const appVersion = boundedText(body.app_version, 1, 40);
  if (!appVersion) return { error: "missing app version" };
  const kind = String(body.kind ?? "");
  if (!CRASH_KINDS.has(kind)) return { error: "unknown report kind" };
  const summary = boundedText(body.summary, 3, 300);
  if (!summary) return { error: "summary out of bounds" };
  const detail = boundedText(body.detail, 1, 20000);
  if (!detail) return { error: "detail out of bounds" };
  const fingerprint = String(body.fingerprint ?? "");
  if (!FINGERPRINT_RE.test(fingerprint)) return { error: "bad fingerprint" };
  const occurred = new Date(String(body.occurred_at ?? ""));
  if (Number.isNaN(occurred.getTime())) return { error: "bad occurred_at" };
  // A clock can drift; a report from the far future or decades past cannot
  // be trusted to mean anything. Clamp to the last year and the next day.
  const now = Date.now();
  if (
    occurred.getTime() > now + 24 * 3600 * 1000 ||
    occurred.getTime() < now - 365 * 24 * 3600 * 1000
  ) {
    return { error: "occurred_at out of range" };
  }
  return {
    crash: {
      install_id: body.install_id as string,
      app_version: appVersion,
      os_version: optionalText(body.os_version, 120),
      arch: optionalText(body.arch, 40),
      kind: kind as CrashPayload["kind"],
      summary,
      detail,
      fingerprint,
      occurred_at: occurred.toISOString(),
    },
  };
}

export interface DeviceIdentity {
  deviceId: number;
  testerId: string;
  installId: string;
  status: string;
}

// Resolves a device token to its account. Returns null for anything invalid:
// unknown token, revoked device, or an account that is no longer active.
export async function resolveDevice(
  db: SupabaseClient,
  token: unknown,
): Promise<DeviceIdentity | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 128) {
    return null;
  }
  const hash = await sha256Hex(token);
  const { data, error } = await db
    .from("devices")
    .select("id, tester_id, install_id, revoked_at, beta_testers ( status )")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  const account = data.beta_testers as unknown as { status?: string } | null;
  if (!account || account.status !== "active") return null;
  await db
    .from("devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    deviceId: data.id as number,
    testerId: data.tester_id as string,
    installId: data.install_id as string,
    status: account.status,
  };
}
