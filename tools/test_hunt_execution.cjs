// Run from the repository root with Playwright and a local server:
// python3 -m http.server 8099
// node tools/test_hunt_execution.cjs
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
    const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
        await page.goto((process.env.TEST_BASE_URL || 'http://127.0.0.1:8099') + '/prototype/index.html');
        const result = await page.evaluate(() => {
            const results = [];
            function check(ok, reason) { if (!ok) throw Error(reason); results.push(reason); }
            localStorage.setItem('darkEchoBriefed','1');
            comCfg = {...comDefaultCfg(), ship:'assault', enemy:'assault', mode:'sd', pCtl:'com', cap:false, think:false};
            window.__rpSeed = 123;
            gameLoopRunning = true;
            startComDemo();
            window.__simSteps(1);
            _inStep = true;
            const e = enemies.find(q => q.type !== 'fighter');
            const sid = enemySid(e);
            const P = {aggression:0.65, caution:0.3, stealth:0.6, greed:0.3};
            const updateHunt = () => comHunterStep(_com, P, {}, 1, 0.3, null, null);
            const prime = (s, weapon = 'missile') => {
                _signalAnalysis[s] = {..._newSignalAnalysis(), _solid:true, ana:1, cp:2,
                    obs:[{f:_frameCount}], fix:{x:player.x+(weapon === 'beam' ? 250 : 1100), y:player.y, r:40, f:_frameCount}};
                window._lockSignal(s);
                _com.hunt = {k:'hold', jp:'待ち伏せ', ph:'wait', hp0:player.hp, strikes:0, sid:s, R:1800,
                    side:1, w:weapon, force:weapon === 'beam' ? 'beam' : null, t0:_frameCount, waitF:_frameCount};
                player.angle = 0; player.fireCooldown = 0; player._weaponJamTimer = 0;
                player.missileReloading = false; player.beamReloading = false; cargo.ammoM = 3; switchWeapon(weapon);
                return _com.hunt;
            };
            e.inVision = false; e._visF = -1e9; e.contactLife = 1000; e.contactAccuracy = 0.99;
            e.displayX = player.x+1100; e.displayY = player.y;
            const h = prime(sid);
            const countBefore = projectiles.length;
            updateHunt();
            const order = player._fireOrder;
            check(order && order.target === e && h.shot === order && h.strikes === 0 && h.ph === 'wait', 'queue keeps the original target and waits');
            updateHunt();
            check(player._fireOrder === order && h.strikes === 0, 'repeat tick does not overwrite the pending order');
            player.update();
            check(order.fired && projectiles.length > countBefore, 'actual ship update discharges the queued order');
            updateHunt();
            check(h.strikes === 1 && h.ph === 'egress', 'hunt egress follows the confirmed shot');

            check(obsOnly(), 'demo blocks manual coordinate fire');
            const fake = 'fixture-unknown';
            const h2 = prime(fake);
            const count2 = projectiles.length;
            freeFireAt(player.x+1100, player.y);
            check(projectiles.length === count2, 'manual coordinate input stays disabled in demo');
            player._weaponJamTimer = 20;
            updateHunt();
            check(projectiles.length === count2 && h2.ph === 'wait' && h2.strikes === 0, 'held fire does not count during jamming');
            player._weaponJamTimer = 0;
            updateHunt();
            check(projectiles.length > count2 && h2.strikes === 1 && h2.ph === 'egress', 'autonomous coordinate attack fires in demo');

            const h3 = prime(sid);
            e.contactLife = 1000;
            updateHunt();
            const canceled = player._fireOrder;
            h3.ph = 'approach';
            _sigIdent[sid] = {L:-3,n:99,sure:true,why:{}};
            updateHunt();
            check(canceled && !canceled.fired && !player._fireOrder && !_com.hunt, 'discredited target cancels pursuit and its queued shot');

            const h4 = prime(fake, 'beam');
            updateHunt();
            const beam = player._ffBeam;
            check(beam && h4.shot === beam && h4.strikes === 0, 'charging is not counted as firing');
            player._beamCharge = BEAM_CHARGE_DUR * PM.beamCharge;
            updateFreeBeam();
            updateHunt();
            check(beam.fired && h4.strikes === 1 && h4.ph === 'egress', 'coordinate beam egress follows discharge');

            const restocking = {id:'supply_hunt', t0:_frameCount-1};
            const seenRestock = stratRun({side:'e',owner:'enemy',x:0,y:0,est:()=>null,oppRestockF:()=>_frameCount}, restocking, _frameCount);
            check(seenRestock.includes('補給完了を目撃'), 'running supply ambush ends after witnessed restock');
            return results;
        });
        assert.deepEqual(errors, []);
        console.log(result.join('\n'));
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
