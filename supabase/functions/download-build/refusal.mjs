// What download-build answers when has_build_access says no. Plain JavaScript
// with no Deno globals, so tests/trial-functions.test.mjs runs it under
// node:test exactly as the function runs it.
//
// `standing` is account_standing()'s answer for the account, or null when it
// could not be read — and then the refusal is the plain one, never a guess.
// An account whose trial has ended (expired, or revoked) and that owns nothing
// is told exactly that, with a flag a client can branch on and where to buy.
// Everyone else gets the refusal this function always gave.

export const BUY_URL = 'https://wavread.com/buy';

export function accessRefusal(standing, buildId) {
  if (standing?.trial === 'ended' && !standing.owned) {
    return {
      error: 'Your 14-day trial has ended. Buy WavRead to keep downloading it.',
      code: 'trial_expired',
      trial_expired: true,
      purchasable: true,
      buy_url: BUY_URL,
      build_id: buildId,
    };
  }
  return {
    error: 'This build has not been purchased on this account.',
    purchasable: true,
    build_id: buildId,
  };
}
