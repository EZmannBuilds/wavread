// article-submission-save — see handler.mjs. Deployed with verify_jwt on: the
// only caller is a signed-in writer in the site's editor.
import { json, preflight, readJson } from "../_shared/mod.ts";
import { userClient } from "../_shared/user-client.ts";
import { handleSave } from "./handler.mjs";

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  const authed = userClient(req.headers.get("Authorization") ?? "");
  return handleSave(req, { authed, json, readJson });
});
