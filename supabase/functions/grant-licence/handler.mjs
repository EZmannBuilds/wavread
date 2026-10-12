export async function handleGrant(req, deps) {
 const respond=(code,body)=>deps.json(req,code,body);
 if(req.method!=='POST') return respond(405,{error:'POST only'});
 const {data,error}=await deps.authed.auth.getUser();
 if(error || !data?.user) return respond(401,{error:'Sign in to continue.'});
 const permission=await deps.authed.rpc('owner_licence_status');
 if(permission.error || permission.data!==true) return respond(403,{error:'Only the designated owner can grant licences.'});
 const body=await deps.readJson(req,4096);
 const email=deps.normalizeEmail(body?.email);
 if(!email) return respond(400,{error:'Enter a valid recipient email.'});
 try {
  // Creates sign-in identity only. No invite, marketing subscription or email is sent.
  const created=await deps.admin.auth.admin.createUser({email,email_confirm:false});
  if(created.error && !['email_exists','user_already_exists'].includes(created.error.code)) {
   return respond(503,{error:'Could not prepare the account. Please retry.'});
  }
  const grant=await deps.authed.rpc('owner_grant_licence',{recipient_email:email});
  if(grant.error) return respond(grant.error.code==='42501'?403:409,{error:'The licence could not be granted. Check account status or retry.'});
  return respond(200,{...grant.data,signin_url:'https://wavread.com/signin',email_sent:false});
 } catch { return respond(503,{error:'The licence service is unavailable. Please retry.'}); }
}
