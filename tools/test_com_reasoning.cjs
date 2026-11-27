const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('prototype/game.js', 'utf8');
function fragment(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert(from !== -1 && to > from);
    return source.slice(from, to);
}

const test = new Function(`
    let _frameCount = 10000;
    const IDENT_MIN_N = 3;
    const THEORY = {ship: {hpBase: {assault: 3500, stealth: 700, carrier: 2500}}};
    const ENEMY_CLASS = {destroyer: 'assault', corvette: 'stealth', carrier: 'carrier'};
    const gameState = {shipType: 'stealth'};
    const enemies = [];
    const player = {x: 0, y: 0}, _signalAnalysis = { 'e-1': {fix: {}} };
    const saAge = () => _frameCount - 9000, trackEstimate = () => ({x: 100, y: 200});
    const BANDS = ['heat', 'optic', 'em', 'higgs'];
    const sensorConfig = {heat: {threshold: 0.1}, optic: {threshold: 0.2}, em: {threshold: 0.3}, higgs: {threshold: 0.25}};
    const ENGINE_MAIN = {thermonuclear: 'heat', pulse: 'em', higgs: 'higgs', photon: 'optic'};
    const enemySid = target => 'e-' + target.uid;
    const comThinkEvent = () => {};
    const comDemo = false, reactionEvent = () => {};
    const persAx = () => 0.4;
    const clampToMapCircle = (x, y) => ({x, y});
    ${fragment('const OPP_CLS =', '// 自機側の発射観測 (被弾・ビーム軌跡の経路から)')}
    ${fragment('function _oppNeg(rec)', '// 収集型仮説の強さ')}
    ${fragment('function sitOdds(S)', 'var SIT_HOLD =')}
    ${fragment('function repairProtected(', 'function tacticFit(')}
    const branchOf = P => P;
    ${fragment('function branchWeight(', 'function branchOfShip(')}
    ${fragment('function huntApproach(HA, H, X)', '    const sp = X.plan(est, H.force);')}
    }
    ${fragment('function comDatumNote(c, te, lk)', 'function comWantsPress')}
    return { comDatumNote, expireComDatum, _oppNew, _oppBandObs, _oppView, _oppRead, _oppFire, _oppNeg, oppWakeE,
        observeHullDamageP, observeHullDamageE, _oppHullEstimate, oppRecP, sitOdds, huntApproach,
        observeRestockP, observeRestockE, enemies, strategyReview, branchWeight,
        advance: frames => { _frameCount += frames; } };
`)();

const assault = {uid: 1, type: 'destroyer'};
const stealth = {uid: 2, type: 'corvette', hp: 1};
const fighter = {uid: 3, type: 'fighter'};
const observer = {_B: {}, type: 'carrier', detectionTimer: 60};
test.observeHullDamageP(stealth, 350);
test.observeHullDamageP(fighter, 350);
test.observeHullDamageE(observer, 350);
assert.equal(test._oppHullEstimate(test.oppRecP('e-1')), null);
assert.equal(test._oppHullEstimate(test.oppRecP('e-3')), null);
assert.equal(test._oppHullEstimate(observer._B.opp), null);
observer.detectionTimer = 61;
test.observeHullDamageE(observer, 350);
const hull = test._oppHullEstimate(test.oppRecP('e-2'));
assert.equal(hull, 0.5);
assert.equal(test._oppHullEstimate(observer._B.opp), hull);
assert.equal(test.sitOdds({hpF: 0.9, ammo: 1, seen: true, oppHull: hull}), 'adv');
assert.equal(test.sitOdds({hpF: 0.9, ammo: 1, est: false, oppHull: hull}), 'even');
assert.equal(test.sitOdds({hpF: 0.3, ammoOut: true, seen: true, oppHull: hull}), 'disadv');
test.advance(5400);
assert.equal(test._oppHullEstimate(test.oppRecP('e-2')), 0.75);
test.observeHullDamageP(assault, 99999);
assert.equal(test._oppHullEstimate(test.oppRecP('e-1')), 0);
test.advance(16200);
assert.equal(test._oppHullEstimate(test.oppRecP('e-1')), null);

const opponent = test._oppNew();
test._oppFire(opponent, 'beam');
test._oppNeg(opponent);
assert.equal(opponent.ammo, 1);
assert.equal(opponent.wpn.beam, 1);
test._oppFire(opponent, 'missile');
assert.equal(opponent.ammo, 0.95);
test._oppFire(opponent, 'kinetic');
assert(Math.abs(opponent.ammo - 0.92) < 1e-9);

const lastAmmoEvidence = opponent.ammoF;
test.advance(5400);
assert(Math.abs(test._oppView(opponent).ammo - 0.92) < 1e-9);
test._oppFire(opponent, 'beam');
test.advance(10800);
assert.equal(opponent.ammoF, lastAmmoEvidence);
assert(Math.abs(test._oppView(opponent).ammo - 0.96) < 1e-9);

const aRec = test.oppRecP('e-1'), sRec = test.oppRecP('e-2');
test._oppFire(aRec, 'missile');
test._oppFire(sRec, 'missile');
test.observeRestockP(assault, true);
assert.equal(aRec.ammo, 0.95);
assault.inVision = true;
test.observeRestockP(assault, false);
assert.equal(aRec.ammo, 0.95);
test.observeRestockP(assault, true);
assert.equal(aRec.ammo, 1);
assert(aRec.restockF >= 0);
assert.equal(sRec.ammo, 0.95);
observer.hp = 1;
test.enemies.push(observer);
test._oppFire(observer._B.opp, 'missile');
test.observeRestockE(true);
assert.equal(observer._B.opp.ammo, 0.95); // 目視ロックの余韻では補給を確認できない
observer._sawPlayerF = observer._B.opp.ammoF;
test.observeRestockE(true);
assert.equal(observer._B.opp.ammo, 1);
assert.equal(observer._B.opp.restockF, observer._sawPlayerF);

const plan = {id:'ambush', ph:'wait', t0:0};
const expansion = {id:'expand', t0:1800};
const recovery = {id:'recover', hullRecovery:'active'};
const outlook = {paths:{hack:true, hackProg:0.5}};
const win = {aim:'hack'};
assert.match(test.strategyReview(plan, expansion, outlook, win, false, 3600), /コロニー制圧/);
assert.equal(test.strategyReview(plan, expansion, outlook, win, false, 3599), null);
assert.equal(test.strategyReview(plan, {...expansion, t0:1801}, outlook, win, false, 3600), null);
assert.equal(test.strategyReview(plan, expansion, outlook, {aim:'sink'}, false, 3600), null);
assert.equal(test.strategyReview({...plan, cap:true}, expansion, outlook, win, false, 3600), null);
assert.equal(test.strategyReview(plan, expansion, outlook, win, true, 3600), null);
assert.match(test.strategyReview({id:'screen'}, recovery, null, null, false, 100), /耐久を回復/);
assert.equal(test.strategyReview({id:'screen'}, {id:'recover'}, null, null, false, 100), null);
assert.equal(test.strategyReview({id:'restock'}, recovery, null, null, false, 100), null);
assert.equal(test.strategyReview({id:'screen'}, recovery, null, null, true, 100), null);

const branch = {traits:[{id:'hunter', v:1}, {id:'commander', v:0.75}],
    byTrait:{hunter:['hu_shadow', 'st_ambush', 'hu_stalk'], commander:['hu_screen']}};
assert.deepEqual(test.branchWeight(branch, 'hu_', {shadow:2, stalk:1, screen:1, lure:0}),
    {shadow:2.12, stalk:1.06, screen:1, lure:0});
assert.deepEqual(test.branchWeight(branch, 'st_', {ambush:1, push:1, trap:0}),
    {ambush:1.06, push:1, trap:0});
assert.deepEqual(test.branchWeight(branch, 'hu_', {shadow:1, stalk:0}), {shadow:1, stalk:0});
assert(test.branchWeight(branch, 'hu_', {shadow:0, screen:1, lure:1}).screen > 1);

const audio = test._oppNew();
test._oppBandObs(audio, {heat: 2, em: 1}, 1, ['heat', 'em']);
assert.equal(audio.bandBase.heat, 0.4);
assert.equal(audio.bandBase.em, 0.6);
for (let i = 0; i < 50; i++) test._oppBandObs(audio, {heat: 0.1, em: 3}, 1, ['heat', 'em']);
assert(audio.eng.n >= 3);
assert.equal(audio.eng.top, null);
assert.equal(test._oppRead(test._oppView(audio), {}).eng, null);
test._oppBandObs(audio, {heat: 1, optic: 1}, 1, ['heat', 'optic']);
assert.equal(audio.bandWinN, 0);
assert.equal(audio.bandBase.em, 0);
test.oppWakeE(observer, 'heat');
assert.equal(test._oppView(observer._B.opp).wake.band, 'heat');
assert.equal(observer._B.opp.eng.n, 0);

let goal, velocityReads = 0;
const actor = {x: 0, y: 0, go: (x, y) => { goal = [x, y]; }};
const hunt = {vh: [{}, {}], drLog: 1};
const context = {D: 5000, now: 1200, hard: false, say: () => {},
    vel: () => { velocityReads++; return {vx: 2, vy: 0}; }};
assert(test.huntApproach(actor, hunt, {...context, est: {x: 5000, y: 200, age: 1800, moving: true}}));
assert.deepEqual(goal, [5000, 200]);
assert.equal(velocityReads, 0);
assert(test.huntApproach(actor, hunt, {...context, est: {x: 5000, y: 200, age: 1800, moving: false}}));
assert.deepEqual(goal, [8600, 200]);
assert.equal(velocityReads, 1);
const datum = {pressAim: {}};
test.comDatumNote(datum, assault, {assumed: true});
assert.equal(datum.datum.observedF, 9000);
const saved = datum.datum;
test.advance(14401);
test.comDatumNote(datum, assault, {assumed: true});
assert.equal(datum.datum, saved);
assert(test.expireComDatum(datum, {aggression: 0.4}, null));
assert.equal(datum.datum, null);
assert.equal(datum.pressAim, null);
console.log('COM reasoning regressions passed');
