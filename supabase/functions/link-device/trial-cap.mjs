// How many devices a trial may link, and what link-device answers when it has.
// Plain JavaScript with no Deno globals, so tests/trial-functions.test.mjs runs
// it under node:test exactly as the function runs it.
//
// `standing` is account_standing(account, install)'s answer. The cap applies to
// an account whose only claim on WavRead is a trial, running or ended — an
// ended trial does not lift it. Owning WavRead (a purchase, a grant,
// contributor standing) keeps the policy linking always had, which has no cap,
// and so does an account that never had a trial. Linking an install that is
// already linked again is not a new device, so it is never refused here.

export const TRIAL_DEVICE_LIMIT = 2;

export function trialDeviceRefusal(standing) {
  if (!standing?.trial || standing.owned || standing.install_linked) return null;
  if (Number(standing.linked_devices ?? 0) < TRIAL_DEVICE_LIMIT) return null;
  return {
    error: `A trial can link ${TRIAL_DEVICE_LIMIT} devices, and this account has. `
      + 'Revoke one on your dashboard at wavread.com/dashboard, or buy WavRead to link more.',
    code: 'trial_device_limit',
    device_limit: TRIAL_DEVICE_LIMIT,
  };
}
