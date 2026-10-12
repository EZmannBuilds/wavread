import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync('docs/js/navigation.js','utf8');
function navigate(href, links) {
 const nodes=links.map(item=>({href:typeof item==='string'?item:item.href,download:!!item.download,getAttribute(){return this.href},setAttribute(_,v){this.href=v},hasAttribute(){return this.download}}));
 vm.runInNewContext(source,{URL,URLSearchParams,location:new URL(href),document:{querySelector:()=>null,querySelectorAll:()=>nodes}});
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
 const backend=readFileSync('supabase/functions/_shared/mod.ts','utf8');
 const fragment=backend.slice(backend.indexOf('const CAMPAIGN_CHANNELS'),backend.indexOf('export function newDeviceToken'));
 const js=fragment.replace('export function campaignSource(value: unknown): string | null','function campaignSource(value)');
 const ctx=vm.createContext({});vm.runInContext(js,ctx);
 for(const label of ['reels-ryma','tiktok-ryma','shorts-ryma']) assert.equal(vm.runInContext(`campaignSource('${label}')`,ctx),label);
 assert.equal(vm.runInContext("campaignSource('reels-rym-a')",ctx),null);
});
