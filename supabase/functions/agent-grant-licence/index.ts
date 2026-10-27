import {json,readJson,normalizeEmail,serviceClient} from '../_shared/mod.ts';
import {handleAgentGrant} from './handler.mjs';
// No browser calls this, so there is no CORS preflight: an OPTIONS request is
// refused like any other method that is not POST.
Deno.serve((req:Request)=>handleAgentGrant(req,{
 secret:Deno.env.get('OWNER_GRANT_SECRET')??'',admin:serviceClient(),json,readJson,normalizeEmail,log:console.error,
}));
