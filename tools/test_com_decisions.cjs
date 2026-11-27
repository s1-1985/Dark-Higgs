const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('prototype/game.js', 'utf8');
function fragment(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert(from !== -1 && to > from);
    return source.slice(from, to);
}

const t = new Function(`
    let _frameCount = 20000, _com = {}, enabled = true, captainSearching = false, roll = 0;
    const Math = Object.create(globalThis.Math);
    Math.random = () => roll;
    const player = {hp: 100, maxHp: 100}, PERS_DEF = {}, window = {};
    const ENV_COVER_MIN = 0.3, ENEMY_DEPLOY_KINDS = ['attack', 'build', 'scout'];
    const HACK_ATTEMPT_H = 3, _hackAim = () => ({ang: 0, d: 1200});
    const DRONE_SPEC = {mech: {mat: 14}, attack: {mat: 4, label: 'fighter'}, scout: {mat: 3, label: 'scout'}};
    const itemFactsP = (c, P, hpF) => ({side: 'p', P, hpF});
    const itemFactsE = e => ({side: 'e', who: e, hpF: e.hp / e.maxHp});
    const sitAug = F => F, sitJudge = (h, F) => ({phase: F.hpF < 0.5 ? 'recover' : 'search'});
    const retreatThreshold = () => 0.29;
    const skillMatch = S => ({sceneOK: S._J.phase === 'search', frac: 1});
    const skillOn = () => enabled, skillUse = () => enabled;
    const _pct = String;
    const comDoctrine = () => ({partHunt: false, partRange: 9000});
    const comEarlyGather = () => false, capSeeking = () => captainSearching, capWants = () => false;
    const SUPPLY_RENEW = 18000, REWARD_VALUE_MAX = 0.75;
    const structures = [], resourceNodes = [];
    const persOfSide = () => ({}), persAx = () => 0.4;
    ${fragment('function doctrineOf(side, who)', '// ═══ 第232弾')}
    ${fragment('function rewardNeedsOf(side, who)', '// 検証専用の読み出し (原則の強さ').replace('const REWARD_VALUE_MAX = 0.75;', '')}
    ${fragment('const _sitCache = new WeakMap();', 'function skillScenesJp(')}
    ${fragment('function choosePositiveWeight(', 'function enemyHunterStep(')}
    ${fragment('function comFocusPlan(', '// 旧 (第39弾): 性格だけ')}
    ${fragment('function droneDeploymentOrder(', '// 空母の有機射出の判断')}
    ${fragment('function hackDecide(', 'function enemyHackAI(')}
    ${fragment('function gatherWants(', 'function comEarlyGather(used, max, now, P)')}
    return { actionFit, tacticFit, repairProtected, sitNow, sitWeightMul, choosePositiveWeight,
        comFocusPlan, droneOpsStep, hackDecide, gatherWants, rewardValueFor, structures, player,
        setPlayerContext(doc, needs) { _com.doc = doc; _com._reward = needs; },
        setRoll(v) { roll = v; }, setSkills(v) { enabled = v; }, setCaptain(v) { captainSearching = v; } };
`)();

const recover = {id: 'recover', hullRecovery: 'available', score: 0.8};
const veil = {id: 'veil', score: 0.5};
assert.equal(t.actionFit({score: 9}), 1.2);
assert.equal(t.actionFit({score: -1}), 1);
assert.equal(t.tacticFit(recover, 'def', 'tc_kite', 0), 1.2);
assert.equal(t.tacticFit(recover, 'off', 'tc_focus_weapon', 0), 1);
assert.equal(t.tacticFit(veil, 'info', 'tc_listen_spot', 1), 1.2);
assert.equal(t.tacticFit(veil, 'info', 'tc_sonar_fix', 0, false), 1);
assert.equal(t.tacticFit(veil, 'info', 'tc_sonar_fix', 0, true), 1.2);
assert.equal(t.tacticFit(null, 'info', 'tc_listen_spot', 0.5), 1.1);
assert.equal(t.tacticFit(null, 'info', 'tc_listen_spot', 0.2), 1);
assert.equal(t.choosePositiveWeight({disabled: 0, legal: 2}, 0), 'legal');
assert.equal(t.choosePositiveWeight({disabled: 0, legal: 0}, 0.5), null);
assert.equal(t.choosePositiveWeight({first: 1, second: 1}, 0.5), 'second');

const a = {hp: 200, maxHp: 1000};
const b = {hp: 900, maxHp: 1000};
assert.equal(t.sitNow('e', a)._J.phase, 'recover');
assert.equal(t.sitWeightMul('e', 'test', a), 0.3);
assert.equal(t.sitNow('e', b)._J.phase, 'search');
assert.equal(t.sitWeightMul('e', 'test', b), 1.4);
assert.equal(t.sitNow('e', a).who, a);

const search = {aggression: 0.6, greed: 0.45, stealth: 0.4, caution: 0.4};
assert.equal(t.comFocusPlan(search, 'search', true, veil, {fog: 0.6}), 'sensor');
assert.equal(t.comFocusPlan(search, 'search', true, veil, {fog: 0.6, badZone: true}), 'engine');
assert.equal(t.comFocusPlan(search, 'engage', true, veil, {fog: 0.6}), 'weapon');

for (const side of ['p', 'e']) {
    const who = {_doc: veil};
    const actor = {side, who, cls: 'assault', contact: true, expo: false, P: {aggression: 0.6},
        gapOK: () => true, canKind: k => ['scout', 'attack'].includes(k), roster: () => ({scout: {live: 0}}),
        stock: () => 1, markDeploy: () => {}, say: () => {}};
    const deployed = [];
    actor.execDeploy = actor.execStock = k => deployed.push(k);
    t.setPlayerContext(veil);
    t.droneOpsStep(side, actor);
    t.droneOpsStep(side, {...actor, expo: true});
    t.droneOpsStep(side, {...actor, roster: () => ({scout: {live: 1}})});
    t.setPlayerContext(recover);
    who._doc = recover;
    t.droneOpsStep(side, actor);
    t.droneOpsStep(side, {...actor, expo: true});
    assert.deepEqual(deployed, ['scout', 'attack', 'attack', 'attack']);

    const hack = {side, who, H: 3, credible: true};
    assert.equal(t.hackDecide(hack), null);
    assert.equal(t.hackDecide({...hack, incomingMsl: true}).eff, 'guide');
    t.setPlayerContext(veil);
    who._doc = veil;
    const effects = ['fcs', 'halt', 'sensor', 'optic', 'guide', 'comm'];
    for (const [i, effect] of effects.entries()) {
        t.setRoll((i + 0.5) / effects.length);
        assert.equal(t.hackDecide(hack).eff, effect);
    }
}

const who = {x: 0, y: 0};
const replenished = {x: 3000, y: 0, type: 'colony', owner: null};
const alreadyUsed = {x: 1000, y: 0, type: 'colony', owner: null, _usedP: true, _usedPF: 19000, _usedE: true, _usedEF: 19000};
const distant = {x: 8500, y: 0, type: 'colony', owner: null};
t.structures.push(replenished, alreadyUsed, distant);
for (const side of ['p', 'e']) {
    const P = {_side: side};
    const needs = {doc: 'expand', part: 0.75, ammo: 1, mat: 1, stance: 'even'};
    t.setPlayerContext(null, needs);
    who._reward = needs;
    assert(t.rewardValueFor(side, who, alreadyUsed, 'colony') < 0.55);
    assert(t.rewardValueFor(side, who, replenished, 'colony') > 0.55);
    assert.equal(t.gatherWants(P, 1, 4, 20000, who).opportunity, replenished);
    assert.equal(t.gatherWants(P, 4, 4, 20000, who).part, false);
    t.setSkills(false);
    assert.equal(t.gatherWants(P, 1, 4, 20000, who).part, false);
    t.setSkills(true);
}
t.setCaptain(true);
assert.equal(t.gatherWants({_side: 'p'}, 1, 4, 20000, who).part, false);
console.log('COM decision regressions passed');
