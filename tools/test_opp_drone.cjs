const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('prototype/game.js', 'utf8');
function fragment(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert(from >= 0 && to > from);
    return source.slice(from, to);
}

const model = new Function(`
    const IDENT_MIN_N = 3;
    const DRONE_SPEC = { scout: { label: '哨戒機' } };
    const enemySid = enemy => 'e-' + enemy.uid;
    const _droneKindOfE = drone => drone._kind;
    const persAx = (personality, axis) => personality[axis] ?? 0.4;
    const _frameCount = 1200;
    const lockedSignalId = 'e-1';
    const comThinkEvent = () => {};
    ${fragment('const OPP_CLS =', '// 推進機関の検証に使う帯域傾向。')}
    ${fragment('const OPP_DRONE_CLS =', '// 瞬時行動推定 (predictedBehavior)')}
    ${fragment('function _oppView(', '// 収集型仮説の強さ')}
    return { _oppNew, _oppAddM, _oppDrone, _oppView, _oppRead, oppDroneSeenE, oppDroneSeenP, oppRecP };
`)();
const { _oppNew, _oppAddM, _oppDrone, _oppView, _oppRead, oppDroneSeenE, oppDroneSeenP, oppRecP } = model;
const standard = { caution: 0.4, aggression: 0.4 };

for (const kind of ['scout', 'attack', 'build']) {
    const record = _oppNew();
    const other = kind === 'scout' ? 'stealth' : 'assault';
    for (let i = 1; i <= 6; i++) {
        const drone = {};
        _oppDrone(record, drone, kind);
        _oppDrone(record, drone, kind);
        assert.equal(record.drones, i);
        assert.equal(record.cls.n, i);
        assert.equal(record.cls.L.carrier, record.cls.L[other]);
        assert.equal(record.cls.top, null);
        assert.equal(_oppRead(_oppView(record), standard).cls, null);
    }
}

const enemy = { uid: 1, _B: {} };
const acoustic = { _home: enemy, _kind: 'scout', type: 'scout' };
for (let i = 0; i < 2; i++) {
    oppDroneSeenP(acoustic, false);
    oppDroneSeenE(enemy, acoustic, false);
}
const records = [oppRecP('e-1'), enemy._B.opp];
for (const record of records) {
    assert.equal(record.drones, 1);
    assert.equal(record.cls.n, 0);
    assert.equal(record.sty.n, 0);
}
oppDroneSeenP(acoustic);
oppDroneSeenE(enemy, acoustic);
oppDroneSeenP(acoustic);
oppDroneSeenE(enemy, acoustic);
for (const record of records) {
    assert.equal(record.drones, 1);
    assert.equal(record.cls.n, 1);
    assert.equal(record.sty.n, 1);
}

const differingRoles = _oppNew();
for (let i = 0; i < 4; i++) {
    _oppDrone(differingRoles, {}, 'scout');
    _oppDrone(differingRoles, {}, 'attack');
}
assert.equal(_oppRead(_oppView(differingRoles), standard).cls, 'carrier');

const tech = _oppNew();
for (let i = 0; i < 3; i++) _oppDrone(tech, {}, 'mech');
assert.equal(_oppRead(_oppView(tech), standard).cls, 'carrier');

const prior = _oppNew();
for (let i = 0; i < 3; i++) _oppAddM(prior, 'cls', { assault: 0.3 });
assert.equal(prior.cls.top, 'assault');
for (let i = 0; i < 6; i++) _oppDrone(prior, {}, 'scout');
assert.equal(prior.cls.top, 'assault');
assert.equal(_oppRead(_oppView(prior), standard).cls, null);
console.log('Opponent model drone observations passed');
