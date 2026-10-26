// start-trial — fourteen days of WavRead for an email address, once.
//
// The browser sends an email and nothing else, as it does to create-checkout.
// This function makes sure a Supabase Auth user exists for that address, so the
// person signs in with the same one-time email links buyers use, then asks
// start_trial (migration 20261026120000) for the trial itself. Everything that
// matters is decided there, under the per-email lock an owner grant also takes:
// one trial per account ever, nobody who already owns WavRead, and an
// entitlement whose expires_at is fourteen days after it was granted.
//
// A trial is not a sale. No purchases row, no Stripe call, no affiliate credit;
// converting is the existing $50 checkout at /buy, and stripe-webhook ends the
// trial when that payment lands.
//
// The request is rate-limited before anything is created (take_trial_slot): by
// a keyed digest of the network address, of the email, and across everyone.
//
// Plain JavaScript with no Deno globals, so tests/start-trial.test.mjs runs it
// under node:test exactly as index.ts runs it.

export const SIGNIN_URL = 'https://wavread.com/signin';
export const BUY_URL = 'https://wavread.com/buy';

// What Auth answers when the address already has a sign-in identity — which is
// fine: it is the identity this person will sign in with.
const ALREADY_REGISTERED = new Set(['email_exists', 'user_already_exists']);

export async function handleStartTrial(req, deps) {
  const respond = (status, body) => deps.json(req, status, body);
  const unavailable = () => respond(503, { error: 'The trial could not be started right now. Nothing was created — try again shortly.' });
  if (req.method !== 'POST') return respond(405, { error: 'POST only' });

  const body = await deps.readJson(req, 4096);
  const email = deps.normalizeEmail(body?.email);
  if (!email) return respond(400, { error: 'Enter a valid email address.', code: 'invalid_email' });

  try {
    const slot = await deps.admin.rpc('take_trial_slot', {
      address_digest: await deps.keyedDigest(`trial:address:${deps.clientAddress(req)}`),
      email_digest: await deps.keyedDigest(`trial:email:${email}`),
    });
    if (slot.error) {
      console.error('trial rate limit unavailable', slot.error.code ?? '');
      return unavailable();
    }
    if (slot.data !== true) {
      return respond(429, { error: 'Too many trial requests right now. Wait a while and try again.', code: 'rate_limited' });
    }

    // A sign-in identity only. An admin-created user is sent no email, and no
    // marketing signup is added; the person proves the address is theirs by
    // requesting the usual sign-in link.
    const created = await deps.admin.auth.admin.createUser({ email, email_confirm: false });
    if (created.error && !ALREADY_REGISTERED.has(created.error.code)) {
      console.error('trial sign-in identity failed', created.error.code ?? '');
      return unavailable();
    }

    const started = await deps.admin.rpc('start_trial', { trial_email: email });
    if (started.error) {
      console.error('start_trial failed', started.error.code ?? '');
      return unavailable();
    }
    const result = started.data ?? {};
    switch (result.status) {
      case 'started':
        return respond(200, {
          trial: true,
          email: result.email,
          expires_at: result.expires_at,
          signin_url: SIGNIN_URL,
          email_sent: false,
        });
      case 'trial_used':
        return respond(409, {
          error: result.trial_active
            ? 'Your free trial is already running. Sign in to download WavRead.'
            : 'This email has already used its free trial. Buy WavRead to keep using it.',
          code: 'trial_used',
          trial_active: result.trial_active === true,
          expires_at: result.expires_at ?? null,
          signin_url: SIGNIN_URL,
          buy_url: BUY_URL,
        });
      case 'already_owned':
        return respond(409, {
          error: 'This email already owns WavRead. Sign in to download it.',
          code: 'already_owned',
          signin_url: SIGNIN_URL,
        });
      case 'account_inactive':
      case 'account_mismatch':
        return respond(409, {
          error: 'A trial cannot be started for this account. Email support@wavread.com and we will sort it out.',
          code: 'account_unavailable',
        });
      default:
        console.error('start_trial answered an unknown status');
        return unavailable();
    }
  } catch {
    return unavailable();
  }
}
