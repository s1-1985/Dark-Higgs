const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('prototype/game.js', 'utf8');
const start = source.indexOf('function strategyReview(');
const end = source.indexOf('function tacticFit(', start);
assert(start >= 0 && end > start);
const sim = new Function(`
    const structures = [], disabled = new Set();
    const COLONY_HACK_R = 600, DRONE_AUTO_DIST = 6000, CAP_RANGE = 16000;
    const skillOn = (_, id) => !disabled.has(id);
    const repairProtected = doc => doc?.id === 'recover' && doc.hullRecovery;
    const findCoverSpot = () => ({x:1000, y:0}), _dirTxt = () => '東';
    ${source.slice(start, end)}
    return { strategyReview, makeOperation, runOperation, structures, disabled };
`)();

const old = {id:'ambush', ph:'wait', t0:0, waitingSince:0};
const expansion = {id:'expand', t0:0};
const outlook = {paths:{hack:true, hackProg:0.75}};
const review = sim.strategyReview(old, expansion, outlook, {aim:'hack'}, false, 3600);
assert.equal(review.goal, 'colony');
const first = {type:'colony', x:3000, y:0, owner:'neutral'};
const second = {type:'colony', x:7000, y:0, owner:'enemy'};
sim.structures.push(first, second, {type:'derelict', x:200, y:0, owner:'neutral'});
const calls = [], wing = {};
let kit = false, contested = null, estimate = null;
const A = {side:'p', owner:'player', x:0, y:0, expo:0,
    est: () => estimate, next: () => ({x:-3000, y:0}), kit: () => kit, can: () => true,
    use: k => { calls.push(k); kit = true; }, contested: site => site === contested,
    scout: () => wing, scoutWaiting: () => true, releaseScout: s => calls.push(s),
    go: (x,y) => calls.push([x,y]), hold: () => calls.push('hold'), say: () => {} };
const holder = {_operation: sim.makeOperation(A, review, 3600)};
assert.equal(holder._operation.target, first);
assert(sim.runOperation(A, holder, 3600, false));
assert.equal(holder._operation.phase, 'scout');
assert(sim.runOperation(A, holder, 4319, false));
assert.equal(calls.at(-1), 'hold');
assert(sim.runOperation(A, holder, 4320, false));
assert.equal(calls.at(-2), wing);
assert.deepEqual(calls.at(-1), [3000,0]);
contested = first;
assert(sim.runOperation(A, holder, 4400, false));
assert.equal(holder._operation.target, second);
assert(holder._operation.retried);
A.x = second.x;
assert(sim.runOperation(A, holder, 5000, false));
assert.equal(holder._operation.phase, 'capture');
second.owner = A.owner;
assert(!sim.runOperation(A, holder, 5480, false));
assert.equal(holder._operation, null);
A.x = 0; contested = null; estimate = {x:3000,y:0,r:500};
assert.equal(sim.makeOperation(A, review, 5500).goal, 'search');
sim.disabled.add('gt_stall');
assert.equal(sim.makeOperation(A, review, 5500), null);
sim.disabled.clear(); estimate = null;
holder._operation = sim.makeOperation(A, review, 6000);
assert(sim.runOperation(A, holder, 6000, false));
assert(!sim.runOperation(A, holder, 6001, true));
assert.equal(calls.at(-1), wing);
assert.equal(holder._operation, null);

const repair = sim.strategyReview({id:'push'}, {id:'recover',hullRecovery:'available'}, null, null, false, 6000);
assert.equal(repair.goal, 'repair');
holder._operation = sim.makeOperation(A, repair, 6600);
assert(sim.runOperation(A, holder, 6600, false));
assert.deepEqual(calls.at(-1), [1000,0]);
A.x = 1000;
assert(sim.runOperation(A, holder, 6700, false));
assert.equal(calls.at(-1), 'repair');
assert(sim.runOperation(A, holder, 6800, false));
assert.equal(holder._operation.phase, 'repair');
kit = false;
assert(!sim.runOperation(A, holder, 7000, false));
assert.equal(holder._operation, null);
const search = sim.strategyReview(old, null, null, null, false, 3600, {contact:false, pressure:{impatience:0.4}});
assert.equal(search.goal, 'search');
A.x = 0;
holder._operation = sim.makeOperation(A, search, 8000);
assert(sim.runOperation(A, holder, 8000, false));
assert.deepEqual(calls.at(-1), [-3000, 0]);
A.x = -3000;
assert(sim.runOperation(A, holder, 8100, false));
assert.equal(holder._operation.phase, 'listen');
assert(!sim.runOperation(A, holder, 9000, false));
assert.equal(holder._operation, null);
console.log('COM operation replanning regressions passed');
