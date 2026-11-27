const assert = require('node:assert/strict');
const fs = require('node:fs');

const game = fs.readFileSync('prototype/game.js', 'utf8');
function fragment(start, end) {
    const from = game.indexOf(start), to = game.indexOf(end, from + 1);
    assert(from >= 0 && to > from);
    return game.slice(from, to);
}

const sim = new Function(`
    let _frameCount = 0;
    const PERS_DEF = { aggression: 0.5, stealth: 0.4, greed: 0.4, caution: 0.4, cunning: 0.4, tech: 0.4, command: 0.4, patience: 0.4 };
    const player = { hp: 900, maxHp: 1000 };
    const COLONY_SUPPLY_MAT = 2, comDemo = true, _com = { pp: PERS_DEF }, ENEMY_CLASS = { corvette: 'stealth' };
    const persAx = (p, k) => p?.[k] ?? PERS_DEF[k];
    const envIntake = S => ({ cover: S.cover ?? 0 });
    const ammoOutOf = s => !!s.ammoOut;
    const doctrineOf = (_, s) => s.doc;
    ${fragment('function reactionPersonality(', '// ── 幹の周期処理')}
    ${fragment('function fireThreshold(', 'function stallStart(')}
    ${fragment('function repairProtected(', 'function tacticFit(')}
    return { reactionEvent, reactionTick, reactionRead, reactionPosture, reactionFireThreshold,
        fireThreshold, strategyReview, reactionProfile, reactionSupplyAmount, player, setFrame(f) { _frameCount = f; } };
`)();

const ship = personality => ({ hp: 900, maxHp: 1000, type: 'corvette', personality });
const aggressive = ship({ aggression: 0.9, caution: 0.1, patience: 0.25 });
const cautious = ship({ aggression: 0.2, caution: 0.9, patience: 0.75 });
const other = ship({});
for (const f of [0, 120]) {
    sim.setFrame(f);
    for (const s of [aggressive, cautious]) sim.reactionEvent(s, 'damage', 200);
}
const read = s => sim.reactionRead(s);
assert(read(aggressive).pressure.counter > read(aggressive).pressure.guard);
assert(read(cautious).pressure.guard > read(cautious).pressure.counter);
assert.equal(read(other), null);
const fire = (s, reliable, hp = 0.9, target = null) => sim.reactionFireThreshold(s.personality, s, hp, 0.35, reliable, target);
assert(fire(aggressive, true) < sim.fireThreshold(aggressive.personality));
assert(fire(cautious, true) > sim.fireThreshold(cautious.personality));
assert.equal(fire(aggressive, false), sim.fireThreshold(aggressive.personality));
assert.equal(fire(aggressive, true, 0.4), sim.fireThreshold(aggressive.personality));
sim.reactionEvent(aggressive, 'damage', 100, 'e-7');
assert(fire(aggressive, true, 0.9, 'e-7') < fire(aggressive, true, 0.9, 'e-8'));
aggressive.doc = { id: 'recover', hullRecovery: 'active' };
assert(fire(aggressive, true) >= sim.fireThreshold(aggressive.personality));

sim.reactionEvent(other, 'supply', 0);
assert.equal(read(other), null);
sim.reactionEvent(other, 'supply', 1);
sim.reactionEvent(other, 'hit', 400);
sim.reactionEvent(other, 'part', 1);
assert(read(other).pressure.confidence > 0);
assert(read(other).values.calm > 0);
const fresh = read(aggressive).values.counter;
sim.setFrame(6200);
assert(read(aggressive).values.counter < fresh);

const idle = ship({ patience: 0 });
const quiet = { hitS: 30, quietS: 130, cover: 1 };
const search = { phase: 'search' };
for (let f = 9000; f < 24000; f += 60) {
    sim.setFrame(f);
    sim.reactionTick(idle, quiet, search, null, f);
}
const impatience = read(idle).pressure.impatience;
assert(impatience >= 0.2);
const scores = { press: 1, veil: 1, recover: 1, ambush: 1 };
sim.reactionPosture(scores, read(idle), quiet, { stance: 'behind' }, false);
assert(scores.ambush < 1);
const ambush = { id: 'ambush', ph: 'wait', waitingSince: 0, t0: 0 };
assert(sim.strategyReview(ambush, null, null, null, false, 3600, read(idle)));
assert.equal(sim.strategyReview(ambush, null, null, null, false, 3599, read(idle)), null);
assert.equal(sim.strategyReview({ ...ambush, cap: true }, null, null, null, false, 3600, read(idle)), null);
assert.equal(sim.strategyReview(ambush, null, null, null, false, 3600, { ...read(idle), contact: true }), null);

const neutral = sim.reactionProfile({});
assert(sim.reactionProfile({aggression:0.9}).threshold.counter < neutral.threshold.counter);
assert(sim.reactionProfile({caution:0.9}).halfLife.guard > neutral.halfLife.guard);
assert(sim.reactionProfile({patience:0.9}).threshold.impatience > neutral.threshold.impatience);

sim.setFrame(25000);
const hidden = ship({stealth:0.9}), exposed = ship({stealth:0});
const technical = ship({tech:0.9}), untrained = ship({tech:0});
const greedy = ship({greed:0.9}), content = ship({greed:0});
const schemer = ship({cunning:0.9}), impulsive = ship({cunning:0});
const commander = ship({command:0.9}), loner = ship({command:0});
for (const e of [technical, untrained, commander, loner]) sim.reactionEvent(e, 'damage', 100);
for (const e of [greedy, content]) sim.reactionEvent(e, 'part', 1);
for (const e of [schemer, impulsive]) sim.reactionEvent(e, 'setback', 1);
for (const e of [hidden, exposed]) sim.reactionTick(e, quiet, search, null, 25000);

assert(read(technical).values.guard < read(untrained).values.guard);
assert(read(greedy).values.confidence > read(content).values.confidence);
assert(read(schemer).values.impatience < read(impulsive).values.impatience);

sim.setFrame(25060);
for (const e of [hidden, exposed]) sim.reactionTick(e, quiet, search, null, 25060);
for (const e of [commander, loner]) sim.reactionTick(e, {seen:true, escort:true}, {phase:'combat'}, null, 25060);
assert(read(hidden).values.calm > read(exposed).values.calm);
assert(read(commander).values.guard < read(loner).values.guard);

const alone = ship({command:0.9}), distantWing = ship({command:0.9});
for (const e of [alone, distantWing]) sim.reactionEvent(e, 'damage', 100);
sim.setFrame(25120);
sim.reactionTick(alone, {seen:true}, {phase:'combat'}, null, 25120);
sim.reactionTick(distantWing, {seen:true, mob:{attack:1}}, {phase:'combat'}, null, 25120);
assert.deepEqual(read(alone), read(distantWing));

const enemy = ship({});
const smallSupply = sim.reactionSupplyAmount(1, 0, 100, 4, 0);
const largeSupply = sim.reactionSupplyAmount(90, 4, 100, 4, 2);
assert(smallSupply > 0 && smallSupply < largeSupply && largeSupply === 1);
for (const e of [sim.player, enemy]) sim.reactionEvent(e, 'supply', largeSupply);
assert.deepEqual(read(sim.player), read(enemy));
sim.reactionEvent(enemy, 'damage', 100, 'e-1');
const directed = read(enemy).values.counter;
sim.reactionEvent(enemy, 'damage', 100);
sim.reactionEvent(enemy, 'damage', 100, 'e-2');
assert(Math.abs(read(enemy).values.counter - 2 * directed) < 1e-10);
assert.equal(read(enemy).source, 'e-2');
console.log('COM reaction regressions passed');
