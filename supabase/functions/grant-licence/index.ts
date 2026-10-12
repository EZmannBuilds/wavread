import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {json,preflight,readJson,normalizeEmail,serviceClient} from '../_shared/mod.ts';
import {handleGrant} from './handler.mjs';
Deno.serve(async(req:Request)=>{
 const early=preflight(req); if(early) return early;
 const authed=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_ANON_KEY')??'',{
  global:{headers:{Authorization:req.headers.get('Authorization')??''}},auth:{persistSession:false,autoRefreshToken:false}
 });
 return handleGrant(req,{authed,admin:serviceClient(),json,readJson,normalizeEmail});
});
