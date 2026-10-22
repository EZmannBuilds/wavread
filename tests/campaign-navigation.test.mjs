import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {campaignSource} from '../supabase/functions/_shared/labels.mjs';
const source=readFileSync('docs/js/navigation.js','utf8');
const DAY=24*60*60*1000;
// A localStorage stand-in; `entries` is what the browser holds afterwards.
function storage(initial={}) {
 const entries={...initial};
 return {entries,getItem:k=>k in entries?entries[k]:null,setItem:(k,v)=>{entries[k]=String(v);},removeItem:k=>{delete entries[k];}};
}
function navigate(href, links, {localStorage, now=Date.now()}={}) {
 const nodes=links.map(item=>({href:typeof item==='string'?item:item.href,download:!!item.download,getAttribute(){return this.href},setAttribute(_,v){this.href=v},hasAttribute(){return this.download}}));
 const clock={now:()=>now};
 vm.runInNewContext(source,{URL,URLSearchParams,JSON,Date:clock,localStorage,location:new URL(href),document:{querySelector:()=>null,querySelectorAll:()=>nodes}});
 return nodes.map(n=>n.href);
}
test('campaign survives homepage, requirements and buy with fragments',()=>{
 const [requirements,section,buy]=navigate('https://wavread.com/?from=reels-ryma#case-study',['/requirements.html','#pricing','/buy.html']);
 assert.equal(requirements,'/requirements.html?from=reels-ryma');assert.equal(section,'/?from=reels-ryma#pricing');assert.equal(buy,'/buy.html?from=reels-ryma');
 assert.equal(navigate('https://wavread.com'+requirements,['/buy.html'])[0],buy);
});
test('only public same-origin page links carry labels',()=>{
 const links=['https://elsewhere.test/buy','mailto:support@wavread.com','/signin.html','/dashboard','/api/latest-build','/assets/case-study/method.json',{href:'/buy',download:true}];
 assert.deepEqual(navigate('https://wavread.com/?from=reels-ryma',links),links.map(x=>typeof x==='string'?x:x.href));
});
test('invalid campaign labels are ignored without changing purchase links',()=>{
 for(const label of ['email-ryma','reels-rym-a','reels-abcdefghijklmn','<script>','']) assert.equal(navigate('https://wavread.com/?from='+encodeURIComponent(label),['/buy'])[0],'/buy');
});
test('normalizes valid labels and preserves unrelated query parameters',()=>{
 assert.equal(navigate('https://wavread.com/?from=%20REELS-RYMA%20',['/buy?other=ok#from'])[0],'/buy?other=ok&from=reels-ryma#from');
});
test('brief labels satisfy the actual server validator',()=>{
 for(const label of ['reels-ryma','tiktok-ryma','shorts-ryma','aff-example','aff-studio-2']) {
  assert.equal(campaignSource(label),label);
  assert.equal(navigate('https://wavread.com/?from='+label,['/buy'])[0],'/buy?from='+label,`${label} is carried to checkout`);
 }
 assert.equal(campaignSource('reels-rym-a'),null);
});
test('an affiliate link is kept for 30 days, and the newest one wins',()=>{
 const local=storage();
 const now=Date.UTC(2026,9,1);
 assert.equal(navigate('https://wavread.com/?from=AFF-First',['/buy'],{localStorage:local,now})[0],'/buy?from=aff-first');
 assert.deepEqual(JSON.parse(local.entries['wavread-referral']),{label:'aff-first',savedAt:now},'stored with the time it was followed');
 navigate('https://wavread.com/how-it-works',[],{localStorage:local,now:now+29*DAY});
 assert.equal(JSON.parse(local.entries['wavread-referral']).label,'aff-first','a page without a label keeps a fresh referral');
 navigate('https://wavread.com/?from=aff-second',[],{localStorage:local,now:now+5*DAY});
 assert.deepEqual(JSON.parse(local.entries['wavread-referral']),{label:'aff-second',savedAt:now+5*DAY},'the newest affiliate link replaces the older one');
 navigate('https://wavread.com/',[],{localStorage:local,now:now+35*DAY-1});
 assert.ok(local.entries['wavread-referral'],'still inside 30 days of the newest link');
 navigate('https://wavread.com/',[],{localStorage:local,now:now+35*DAY});
 assert.equal(local.entries['wavread-referral'],undefined,'removed once 30 days have passed');
});
test('advertisement labels are never stored, and do not disturb a referral',()=>{
 const local=storage();
 navigate('https://wavread.com/?from=reels-ryma',['/buy'],{localStorage:local});
 assert.deepEqual(local.entries,{},'an ad label is carried in links only');
 const kept=JSON.stringify({label:'aff-example',savedAt:Date.now()});
 const withReferral=storage({'wavread-referral':kept});
 assert.equal(navigate('https://wavread.com/?from=tiktok-a',['/buy'],{localStorage:withReferral})[0],'/buy?from=tiktok-a');
 assert.equal(withReferral.entries['wavread-referral'],kept);
 for(const bad of ['aff-x','aff-'+'a'.repeat(33),'aff_example','affiliate-example','aff-ex ample']) {
  const local2=storage();
  assert.equal(navigate('https://wavread.com/?from='+encodeURIComponent(bad),['/buy'],{localStorage:local2})[0],'/buy',`${bad} is not a label`);
  assert.deepEqual(local2.entries,{},`${bad} is not stored`);
 }
});
test('a stored referral that is unreadable, foreign or from the future is removed',()=>{
 const now=Date.UTC(2026,9,1);
 for(const raw of ['{not json','null','"aff-example"',JSON.stringify({label:'<script>',savedAt:now}),JSON.stringify({label:'aff-example',savedAt:now+DAY})]) {
  const local=storage({'wavread-referral':raw});
  navigate('https://wavread.com/',[],{localStorage:local,now});
  assert.equal(local.entries['wavread-referral'],undefined,raw);
 }
});
test('blocked storage never stops a label from being carried',()=>{
 const blocked={getItem(){throw new Error('SecurityError');},setItem(){throw new Error('SecurityError');},removeItem(){throw new Error('SecurityError');}};
 assert.equal(navigate('https://wavread.com/?from=aff-example',['/buy'],{localStorage:blocked})[0],'/buy?from=aff-example');
 assert.equal(navigate('https://wavread.com/',['/buy'],{localStorage:blocked})[0],'/buy');
});
