// article-review — see handler.mjs. Deployed with verify_jwt off: a caller
// holding the service role key may not present a JWT the gateway accepts, so
// the function decides who is a reviewer itself (reviewers.mjs) before it
// reads anything.
import { json, preflight, readJson, serviceClient } from "../_shared/mod.ts";
import { reviewerFrom } from "../_shared/reviewers.mjs";
import { reviewerDeps } from "../_shared/user-client.ts";
import { handleReview } from "./handler.mjs";

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  return handleReview(req, {
    admin: serviceClient(),
    json,
    readJson,
    reviewer: (request: Request) => reviewerFrom(request, reviewerDeps()),
  });
});
