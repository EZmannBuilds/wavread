// start-trial — see handler.mjs for what it does and why.
//
// Deployed with verify_jwt disabled, like create-checkout: starting a trial
// does not require an account — the email in the body is the request, and the
// account is created for it if needed. Everything privileged happens through
// the service-role client, inside this function.

import {
  clientAddress,
  json,
  keyedDigest,
  normalizeEmail,
  preflight,
  readJson,
  serviceClient,
} from "../_shared/mod.ts";
import { handleStartTrial } from "./handler.mjs";

Deno.serve((req: Request) => {
  const early = preflight(req);
  if (early) return early;
  return handleStartTrial(req, {
    admin: serviceClient(),
    json,
    readJson,
    normalizeEmail,
    clientAddress,
    keyedDigest,
  });
});
