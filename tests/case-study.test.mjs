import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
const script = readFileSync('docs/js/case-study.js','utf8');
function setup() {
  const handlers = {}, global = {};
  const audio = {paused:true,ended:false,currentTime:0,duration:32,attrs:{},plays:0,loads:0,
    addEventListener(k,f){handlers[k]=f},setAttribute(k,v){this.attrs[k]=v},
    load(){this.loads++;this.currentTime=0},play(){this.plays++;this.paused=false;return Promise.resolve()},pause(){this.paused=true},matches(s){return s==='audio'}};
  const full = {paused:false,pause(){this.paused=true}};
  const status = {textContent:''};
  const buttons = ['first','v03'].map(key=>({dataset:{caseVersion:key},attrs:{},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,f){this.click=f}}));
  const document = {querySelector:s=>s==='#case-audio'?audio:status,querySelectorAll:s=>s==='audio'?[audio,full]:buttons,addEventListener:(k,f)=>global[k]=f};
  vm.runInNewContext(script,{document});return {audio,full,status,buttons,handlers,global};
}
test('switching paused versions preserves the same moment without autoplay',()=>{
 const x=setup();x.audio.currentTime=12.4;x.buttons[1].click();assert.equal(x.audio.plays,0);x.handlers.loadedmetadata();assert.equal(x.audio.currentTime,12.4);assert.equal(x.buttons[1].attrs['aria-pressed'],'true');assert.match(x.audio.src,/v03-matched/);
});
test('switching while playing resumes the matching moment',()=>{
 const x=setup();x.audio.currentTime=7;x.audio.paused=false;x.buttons[1].click();assert.equal(x.audio.plays,1);x.handlers.loadedmetadata();assert.equal(x.audio.currentTime,7);
});
test('rapid selection before metadata retains the original position',()=>{
 const x=setup();x.audio.currentTime=19;x.buttons[1].click();x.buttons[0].click();x.handlers.loadedmetadata();assert.equal(x.audio.currentTime,19);assert.match(x.audio.src,/first-matched/);
});
test('a completed excerpt restarts the alternative at zero',()=>{
 const x=setup();x.audio.currentTime=32;x.audio.ended=true;x.buttons[1].click();x.handlers.loadedmetadata();assert.equal(x.audio.currentTime,0);assert.equal(x.audio.plays,0);
});
test('comparison and full song never play over each other',()=>{
 const x=setup();x.global.play({target:x.audio});assert.equal(x.full.paused,true);x.audio.paused=false;x.full.matches=()=>true;x.global.play({target:x.full});assert.equal(x.audio.paused,true);
});
test('network errors give a recovery instruction and reselecting is a no-op',()=>{
 const x=setup();x.buttons[0].click();assert.equal(x.audio.loads,0);x.handlers.error();assert.match(x.status.textContent,/connection.*retry/);
});
test('published excerpts are matched, equal duration and described honestly',()=>{
 const data=JSON.parse(readFileSync('docs/assets/case-study/method.json'));const a=data.excerpts.first,b=data.excerpts.v03;
 assert.equal(a.duration_seconds,32);assert.equal(b.duration_seconds,32);assert.ok(Math.abs(a.decoded_lufs-b.decoded_lufs)<.2);
 for(const item of [a,b]) assert.ok(existsSync(`docs/assets/case-study/${item.file}`));
 const html=readFileSync('docs/index.html','utf8');assert.match(html,/id="case-study"/);assert.match(html,/constructed demonstration/);assert.match(html,/Whole-track measurements/);assert.match(html,/73\.0%/);assert.match(html,/26\.8%/);
});
