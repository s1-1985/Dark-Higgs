// A234: actual sitRaw/sitConf/trunkStep fragments, fixture state only.
const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const source={before:cp.execFileSync('git',['show','44533d4f2a829f7062e0e1b4b070699e480ec02b:prototype/game.js'],{encoding:'utf8',maxBuffer:8*1024*1024}),after:fs.readFileSync('prototype/game.js','utf8')};
function fragment(s,a,b){const i=s.indexOf(a),j=s.indexOf(b,i+1);assert(i>=0&&j>i);return s.slice(i,j)}
function make(s){
 const code=fragment(s,'function sitRaw(S) {','var SIT_HOLD =')+fragment(s,'const TRUNK_PERIOD =','// 幹の読み口');
 return new Function(`
 const structures=[],resourceNodes=[],gameState={mode:'br'},player={hp:200,maxHp:1000,x:0,y:0},_com={},THEORY={time:{earlyUntil:10800,openingUntil:5400,gatherUntil:36000}},CAP_RANGE=16000,PERS_DEF={aggression:.5,greed:.4,tech:.4,cunning:.4,patience:.4,stealth:.4,caution:.4}, REPAIR_KIT_HP=700;
 let _frameCount=12000,enabled=true;
 const coloniesOwned=()=>0,nodesOwned=()=>0,persAx=(p,k)=>p[k]??.4,envIntake=()=>({cover:0}),ENV_COVER_MIN=.3,ENV_VEIL_MAX=.3,ENV_AMBUSH_MAX=.2,_restockSite=()=>null,rewardNeeds=()=>({}),comThinkEvent=()=>{},SIT_PHASE_JP={},skillOn=()=>enabled;
 ${code}
 const e={hp:200,maxHp:1000,x:0,y:0};
 return {step(opts={},side='p',now=12000,phase='recover'){
  _frameCount=now;const who=side==='p'?player:e;
  const S={side,who,hpF:.2,retreatT:.29,ammo:1,wK:true,wM:true,expo:0,hitS:30,quietS:60,drones:0,oppDrone:0,seen:false,est:false,msl:false,kit:false,missing:800,n:()=>1,...opts};
  who.hp=who.maxHp*S.hpF;const F={side,who,P:PERS_DEF},J={phase,odds:'even'};
  const d=trunkStep(F,S,J),h=side==='p'?_com:e;
  return JSON.parse(JSON.stringify({id:d.id,score:d.score,all:d.all,why:d.why,hullRecovery:d.hullRecovery||null,principles:h._prin.list,t0:d.t0,sw:d.sw,lastF:d.lastF}));
 },setSkill(v){enabled=v}};
 `)();
}
const before=()=>make(source.before),after=()=>make(source.after);
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++};const ok=x=>{assert(x);checks++};
let a=after().step();eq(a.id,'recover');eq(a.hullRecovery,'available');eq(a.principles.preserve.aim,'recover');ok(a.why.includes('修理機会を優先'));ok(a.principles.preserve.str>.5);
eq(after().step({},'e').id,'recover');eq(after().step({},'e').hullRecovery,'available');eq(after().step({},'p',12000,'hide').id,'recover');eq(after().step({kit:true,n:()=>0}).hullRecovery,'active');
for(const [opts,phase] of [[{n:()=>0},'recover'],[{missing:560},'recover'],[{seen:true},'recover'],[{msl:true},'recover'],[{expo:2},'recover'],[{hitS:15},'recover'],[{hpF:.3},'recover'],[{},'escape'],[{},'combat'],[{},'contact'],[{},'quiet'],[{},'search']]){
 const b=before().step(opts,'p',12000,phase),a=after().step(opts,'p',12000,phase);eq(a.hullRecovery,null);eq(a.id,b.id);eq(a.all,b.all);
}
let t=after();t.setSkill(false);eq(t.step().hullRecovery,null);eq(t.step({kit:true,n:()=>0},'p',13200).hullRecovery,'active');
t=after();const initial=t.step({n:()=>0},'p',12000);eq(initial.hullRecovery,null);eq(t.step({},'p',12100).hullRecovery,null);eq(t.step({},'p',12240).id,'recover');eq(t.step({n:()=>0},'p',12300).hullRecovery,'available');let end=t.step({n:()=>0},'p',12480);eq(end.hullRecovery,null);eq(end.id,before().step({n:()=>0},'p',12480).id);
t=after();t.step({},'p',12000);eq(t.step({seen:true},'p',12240,'combat').hullRecovery,null);
// 修理開始や再開の可否も、両陣営で同じ間隔で判断に反映される。
for (const side of ['p', 'e']) {
 const sim = after();
 const available = sim.step({}, side, 12000);
 eq(available.hullRecovery, 'available');
 eq(sim.step({kit:true,n:()=>0}, side, 12239).hullRecovery, 'available');
 const active = sim.step({kit:true,n:()=>0}, side, 12240);
 eq(active.hullRecovery, 'active');
 ok(active.why.includes('修理中'));
 eq(active.t0, available.t0);
 eq(active.sw, available.sw);
 eq(sim.step({}, side, 12479).hullRecovery, 'active');
 eq(sim.step({}, side, 12480).hullRecovery, 'available');
}
// 再評価間隔の中で起きた局面転換は、次に評価できるフレームで処理する。
for (const side of ['p', 'e']) {
 const sim = after();
 const noKit = {n:()=>0};
 eq(sim.step(noKit, side, 12000, 'search').lastF, 12000);
 eq(sim.step({...noKit, seen:true}, side, 12100, 'combat').lastF, 12000);
 eq(sim.step({...noKit, seen:true}, side, 12240, 'combat').lastF, 12240);
}
// 実際の自機COMの事実層から、修理中フラグと耐久の不足量を取得できる。
const playerFacts = new Function(`
 const _frameCount = 12000, gameState = {shipType: 'assault'};
 const SHIP_DRONES = {assault: ['repair']}, cargo = {stock: {repair: 1}};
 const player = {x: 0, y: 0, hp: 200, maxHp: 1000, _kitT: 0};
 const enemies = [], THREATS = [], playerHitLog = [], HIDE_STRATS = {};
 const lockedSignalId = null, playerExposureLevel = 0, lullPhase = 'none', surgePhase = 'none';
 const getHiggsIntensity = () => 0, ammoOutOf = () => false, statusDazed = () => false;
 ${fragment(source.after, 'function itemFactsP(', 'function itemFactsE(')}
 return (kitTimer) => {
  player._kitT = kitTimer;
  return itemFactsP({mode: 'free'}, {}, player.hp / player.maxHp);
 };
`)();
eq(playerFacts(0).kit, false);
eq(playerFacts(360).kit, true);
eq(playerFacts(360).missing, 800);
eq(playerFacts(360).n('repair'), 1);
console.log('A234 stage assertions:',checks,'PASS; baseline',JSON.stringify(before().step()),'candidate',JSON.stringify(a));
