// Clients for the article functions: one that acts as the caller, under RLS,
// and the dependencies reviewerFrom needs to tell the owner or the service
// role from anyone else.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { timingSafeEqual } from "./mod.ts";

// The caller's own client: the anon key plus their Authorization header, so
// PostgREST applies RLS as them. The same construction grant-licence uses.
export function userClient(authorization: string): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export function reviewerDeps() {
  return {
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    timingSafeEqual,
    authedFor: userClient,
  };
}
