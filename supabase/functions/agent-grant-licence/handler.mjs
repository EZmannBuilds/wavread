// agent-grant-licence — the agents' way to grant a complimentary licence.
//
// grant-licence is the owner's: it wants the owner's own JWT and a live
// session. The Product Manager, Sales and Support agents have neither, so this
// one takes a shared secret instead, OWNER_GRANT_SECRET, sent as a bearer
// token. Deployed with verify_jwt disabled for that reason; the secret is
// checked before the body is read, and nothing else is trusted.
//
// The grant itself is the owner's flow, run as the service role: create the
// sign-in identity, then agent_grant_licence_service (see migration
// 20261027150000), which writes the account, the entitlement, the owner-grant
// row and the agent log in one transaction and caps grants at 20 an hour.
// No email is sent, nothing touches Stripe, no purchase row is written. The
// recipient signs in at /signin with the usual magic link.
//
// Plain JavaScript with its clients passed in, so node:test runs it.

const MIN_SECRET_LENGTH = 32;
const enc = new TextEncoder();

// Equal only when the strings are, in time that does not depend on where they
// first differ or on how long the guess was: both sides are hashed to 32 bytes
// before the comparison.
async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([given, expected].map(async (text) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bearer(req) {
  const match = String(req.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? '';
}

// The bounds agent_grant_licence enforces, checked here first so a bad request
// gets a sentence back instead of a database error.
function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

// deps: { secret, admin, json, readJson, normalizeEmail, log? } — secret is
// OWNER_GRANT_SECRET, admin a service-role client.
export async function handleAgentGrant(req, deps) {
  const respond = (code, body) => deps.json(req, code, body);
  if (req.method !== 'POST') return respond(405, { error: 'POST only' });

  // Unset, or too short to be the generated one: refuse everyone rather than
  // compare against it.
  const expected = String(deps.secret ?? '');
  if (expected.length < MIN_SECRET_LENGTH) {
    return respond(503, { error: 'Agent licence grants are not enabled.' });
  }
  const given = bearer(req);
  if (!given || !(await sameSecret(given, expected))) {
    return respond(401, { error: 'Not authorized.' });
  }

  const body = await deps.readJson(req, 4096);
  const email = deps.normalizeEmail(body?.email);
  if (!email) return respond(400, { error: 'Enter a valid recipient email.' });
  const requester = text(body?.requester, 64);
  if (!requester) return respond(400, { error: 'Say who is asking: requester, 1 to 64 characters.' });
  const reason = text(body?.reason, 500);
  if (!reason) return respond(400, { error: 'Give a short reason: 1 to 500 characters.' });

  try {
    // Creates the sign-in identity only. No invite, subscription or email.
    const created = await deps.admin.auth.admin.createUser({ email, email_confirm: false });
    if (created.error && !['email_exists', 'user_already_exists'].includes(created.error.code)) {
      deps.log?.('agent-grant-licence: createUser failed', created.error.code ?? created.error.status);
      return respond(503, { error: 'Could not prepare the account. Please retry.' });
    }
    const grant = await deps.admin.rpc('agent_grant_licence_service', {
      recipient_email: email, requester, reason,
    });
    if (grant.error) {
      const code = grant.error.code;
      deps.log?.('agent-grant-licence: grant failed', code);
      if (code === '53400') return respond(429, { error: 'Too many licence grants this hour. Try again later.' });
      // The recipient's account is inactive, bound to another sign-in, or
      // otherwise cannot take a licence: a person has to look at it.
      if (code === '22023' || code === '23505') {
        return respond(409, { error: 'The licence could not be granted. Check the account status first.' });
      }
      return respond(503, { error: 'The licence service is unavailable. Please retry.' });
    }
    return respond(200, {
      email: grant.data.email,
      already_owned: grant.data.already_owned,
      granted: grant.data.granted,
      signin_url: 'https://wavread.com/signin',
      email_sent: false,
    });
  } catch {
    return respond(503, { error: 'The licence service is unavailable. Please retry.' });
  }
}
