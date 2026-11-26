const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync('prototype/game.js','utf8');
function part(a,b){const i=s.indexOf(a),j=s.indexOf(b,i+1);assert(i>=0&&j>i);return s.slice(i,j)}
const w={THEORY:{time:{gatherUntil:36000,openingUntil:5400,earlyUntil:10800}},CAP_RANGE:16000,structures:[],resourceNodes:[],gameState:{mode:'br'}};
vm.runInNewContext(part('function trunkBaseOpportunity(c) {','const PRINCIPLE_JP =')+part('const PRINCIPLE_POSTURE = {','// ── 幹の周期処理:')+'\nthis.api={trunkBaseOpportunity,PRINCIPLES,PRINCIPLE_POSTURE}',w);
const a=w.api,P=id=>a.PRINCIPLES.find(p=>p.id===id),f=()=>({side:'p',S:{seen:false,est:false,expo:0,ammoOut:false,oppCls:null},J:{phase:'quiet'},who:{x:0,y:0},now:0,O:{phase:'early',ownCols:0,foeCols:0,ownNodes:0,foeNodes:0}});
const opp=c=>{c.baseOpp=a.trunkBaseOpportunity(c);return [c.baseOpp.cols,c.baseOpp.nodes]},close=(a,b)=>assert(Math.abs(a-b)<1e-9);
let c=f();assert.deepEqual(opp(c),[0,0]);close(P('bases').eval(c).str,.4);assert.equal(P('infoFirst').eval(c).aim,undefined);
w.structures.push({type:'colony',owner:null,x:100,y:0},{type:'colony',owner:'player',x:100,y:0},{type:'colony',owner:null,x:16000,y:0},{type:'derelict',owner:null,x:100,y:0});w.resourceNodes.push({owner:null,x:200,y:0},{owner:'player',x:200,y:0});
c=f();assert.deepEqual(opp(c),[1,1]);close(P('bases').eval(c).str,.68);assert.equal(P('infoFirst').eval(c).aim,'expand');close(P('infoFirst').eval(c).str,1);
w.structures[0].owner='enemy';assert.deepEqual(opp(c),[1,1]);w.structures[0].owner=null;c=f();c.side='e';assert.deepEqual(opp(c),[2,2]);
for(const [k,v] of [['seen',true],['est',true],['expo',1],['ammoOut',true]]){c=f();c.S[k]=v;assert.deepEqual(opp(c),[0,0]);assert.equal(P('infoFirst').eval(c).aim,undefined)}
for(const p of ['combat','contact','escape','recover','hide']){c=f();c.J.phase=p;assert.deepEqual(opp(c),[0,0])}
c=f();c.now=10800;assert.deepEqual(opp(c),[0,0]);c=f();c.who=null;assert.deepEqual(opp(c),[0,0]);c=f();c.O.phase='early';c.now=10799;assert.deepEqual(opp(c),[1,1]);close(P('bases').eval(c).str,.68);c.O.ownCols=2;close(P('bases').eval(c).str,.68*.6);w.gameState.mode='sd';close(P('bases').eval(c).str,.68*1.3*.6);
assert.equal(a.PRINCIPLE_POSTURE['infoFirst.expand'].expand,a.PRINCIPLE_POSTURE.infoFirst.veil);assert.equal(a.PRINCIPLE_POSTURE['infoFirst.expand'].veil,a.PRINCIPLE_POSTURE.infoFirst.expand);console.log('A233 unit checks passed');
