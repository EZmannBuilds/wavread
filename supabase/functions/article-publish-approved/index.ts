// article-publish-approved — see handler.mjs. Deployed with verify_jwt off for
// the same reason as article-review: the function authenticates the owner or
// the service role itself before it reads anything.
import { json, preflight, readJson, serviceClient } from "../_shared/mod.ts";
import { isoDay } from "../_shared/submissions.mjs";
import { reviewerFrom } from "../_shared/reviewers.mjs";
import { reviewerDeps } from "../_shared/user-client.ts";
import { handlePublish } from "./handler.mjs";

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  return handlePublish(req, {
    admin: serviceClient(),
    json,
    readJson,
    today: () => isoDay(),
    reviewer: (request: Request) => reviewerFrom(request, reviewerDeps()),
  });
});
