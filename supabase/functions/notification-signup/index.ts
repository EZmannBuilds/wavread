import { createHandler } from './handler.mjs';

// verify_jwt remains enabled. The site's public anon JWT admits signup
// requests; the handler never offers a read or a preference-overwrite route.
Deno.serve(createHandler({url: Deno.env.get('SUPABASE_URL') || '',
  key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}));
