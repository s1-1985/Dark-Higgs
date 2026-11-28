// 第252弾: 年輪(葉・系統)の効きを A/B 計測する。同じ種・同じ性格の鏡合わせで、片方の陣営だけ年輪を有効にする。
// 使い方: python3 -m http.server 8099 (ルート) → node tools/measure_leaf_ab.cjs <seed開始> <seed数> <分> <出力.json> [ワーカー数]
const { chromium } = require('playwright'); const fs = require('fs');
const [s0 = '1', n = '8', mins = '20', out = 'leaf_ab.json', W = '3'] = process.argv.slice(2);
const SHIPS = [['assault', 'assault', 'standard'], ['stealth', 'stealth', 'stealthy'], ['carrier', 'carrier', 'standard'], ['assault', 'assault', 'aggressive']];
const jobs = []; for (let i = 0; i < +n; i++) for (const sh of SHIPS) for (const arm of ['p', 'e', 'none']) jobs.push({ seed: +s0 + i, sh, arm });
const res = [];
async function worker(b, q) {
  while (q.length) {
    const j = q.shift(); const p = await b.newPage({ viewport: { width: 1280, height: 720 } }); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(seed => { let a = seed >>> 0; window.__rs = () => { a = seed >>> 0 }; Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }; window.requestAnimationFrame = () => 0; window.__spawnMin = 4500; window.__spawnVar = 2500 }, j.seed);
    try {
      await p.goto('http://127.0.0.1:8099/prototype/index.html'); await p.waitForTimeout(500);
      const r = await p.evaluate(([j, mins]) => {
        localStorage.setItem('darkEchoBriefed', '1'); const [ship, enemy, pre] = j.sh;
        comCfg = comDefaultCfg(); Object.assign(comCfg, { ship, enemy, mode: 'br', pPreset: pre, ePreset: pre, pp: { ...COM_PRESETS[pre].p }, ep: { ...COM_PRESETS[pre].p }, pCtl: 'com', higgsView: true, think: false, cap: false, lo: null });
        const orig = leafRingMul; window.__origMul = orig;
        leafRingMul = function (holder, id) { const isP = holder === _com; if (j.arm === 'none') return 1; if (j.arm === 'p' && !isP) return 1; if (j.arm === 'e' && isP) return 1; return orig(holder, id); };
        window.__rs(); window.__rpSeed = j.seed; gameLoopRunning = true; startComDemo();
        const lim = mins * 3600;
        while (_frameCount < lim) { const f = _frameCount; window.__simSteps(Math.min(60, lim - f)); if (_frameCount <= f) break; if (!player || player.hp <= 0 || sectorCleared) break; }
        const rec = matchRecordData(); const last = rec.s.at(-1);
        return { frames: _frameCount, winner: rec.result.winner, stats: rec.result.stats, last, ringP: !!(_com && _com._leafRing && Object.keys(_com._leafRing.m).length), recP: _com && _com._leafRing ? Object.keys(_com._leafRing.m).length : 0, recE: (enemies || []).reduce((a, e) => a + (e._leafRing ? Object.keys(e._leafRing.m).length : 0), 0) };
      }, [j, +mins]);
      res.push({ ...j, ...r, errs }); console.log(j.seed, j.sh[0], j.sh[2], j.arm, r.winner, r.frames, 'rec', r.recP, r.recE, errs.length ? 'ERR ' + errs[0] : '');
    } catch (e) { console.log('FAIL', JSON.stringify(j), e.message.slice(0, 100)); }
    await p.close(); fs.writeFileSync(out, JSON.stringify(res));
  }
}
(async () => { const b = await chromium.launch(); await Promise.all(Array.from({ length: +W }, () => worker(b, jobs))); await b.close(); })();
