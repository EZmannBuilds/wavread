import test from 'node:test';
import assert from 'node:assert/strict';
import {handleGrant} from '../supabase/functions/grant-licence/handler.mjs';
function harness({user=true,allowed=true,createError=null,grantError=null,already=false}={}) {
 const calls=[];
 const deps={json:(_,status,body)=>({status,body}),readJson:async r=>r.json(),normalizeEmail:e=>typeof e==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())?e.trim().toLowerCase():null,
 authed:{auth:{getUser:async()=>({data:{user:user?{id:'server-verified'}:null}})},rpc:async(name,args)=>{
 calls.push([name,args]);return name==='owner_licence_status'?{data:allowed}:{data:{email:args.recipient_email,already_owned:already,granted:!already},error:grantError};}},
 admin:{auth:{admin:{createUser:async args=>{calls.push(['create',args]);return {error:createError};}}}}};
 return {calls,run:body=>handleGrant(new Request('https://example.test',{method:'POST',body:JSON.stringify(body)}),deps)};
}
test('signed-out and ordinary accounts cannot create identities or licences',async()=>{
 for(const opts of [{user:false},{allowed:false}]){const h=harness(opts);const r=await h.run({email:'creator@example.com',admin:true});assert.ok([401,403].includes(r.status));assert.equal(h.calls.some(c=>c[0]==='create'),false);}
});
test('normalizes recipient and grants only after server permission; sends no email',async()=>{
 const h=harness();const r=await h.run({email:' Creator@Example.com '});assert.equal(r.status,200);assert.equal(r.body.email_sent,false);assert.deepEqual(h.calls.map(c=>c[0]),['owner_licence_status','create','owner_grant_licence']);assert.deepEqual(h.calls[1][1],{email:'creator@example.com',email_confirm:false});
});
test('invalid addresses never create accounts',async()=>{const h=harness();assert.equal((await h.run({email:'invalid'})).status,400);assert.equal(h.calls.length,1);});
test('existing users and previously owned licences remain successful without duplicate grants',async()=>{const h=harness({createError:{code:'email_exists'},already:true});const r=await h.run({email:'creator@example.com'});assert.equal(r.status,200);assert.equal(r.body.already_owned,true);});
test('identity and permission errors never claim a licence was granted',async()=>{
 let h=harness({createError:{code:'unexpected'}});assert.equal((await h.run({email:'creator@example.com'})).status,503);assert.equal(h.calls.length,2);
 h=harness({grantError:{code:'42501'}});assert.equal((await h.run({email:'creator@example.com'})).status,403);
});
