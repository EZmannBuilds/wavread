// Who may review and publish articles, and who is the writer of one.
//
// Plain JavaScript with no Deno globals, so node:test runs these as the
// functions do; each index.ts hands in its clients.

// A writer: a signed-in caller with an active account. The client passed in
// carries the caller's own JWT, so every read and write after this runs under
// RLS as them.
export async function authorFrom(authed) {
  const { data, error } = await authed.auth.getUser();
  if (error || !data?.user) return { status: 401, error: "Sign in to continue." };
  const account = await authed
    .from("accounts")
    .select("tester_id, status")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (account.error) return { status: 503, error: "Your account could not be read. Try again shortly." };
  if (!account.data) {
    return { status: 403, error: "Open your account page once to finish setting up your account, then try again.", code: "no_account" };
  }
  if (account.data.status !== "active") return { status: 403, error: "This account is not active.", code: "inactive" };
  return { userId: data.user.id, testerId: account.data.tester_id };
}

// A reviewer: whoever holds the service role key (the review helper run by the
// owner, or a script), or the owner signed in — the same identity
// owner_licence_status pins for licence grants. Answers null when the caller
// is nobody (401) and { kind: "denied" } when they are signed in but not the
// owner (403).
//
// deps: { serviceKey, timingSafeEqual, authedFor(authorizationHeader) }
export async function reviewerFrom(req, deps) {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  if (deps.serviceKey && deps.timingSafeEqual(token, deps.serviceKey)) return { kind: "service" };
  const authed = deps.authedFor(header);
  const { data, error } = await authed.auth.getUser();
  if (error || !data?.user) return null;
  const permission = await authed.rpc("owner_licence_status");
  if (permission.error || permission.data !== true) return { kind: "denied" };
  return { kind: "owner", userId: data.user.id };
}
