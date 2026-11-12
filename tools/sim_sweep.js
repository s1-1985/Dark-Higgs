// COM対戦をパラメーターをばらして大量に回し、試合の記録を records/sim/sweep/ に貯める (ヘッドレス・並列)。
// 使い方 (リポジトリのルートで `python3 -m http.server 8099` を起動しておく):
//   node tools/sim_sweep.js <ワーカー数=3> <1試合の上限(分)=15> <全体の制限(分)=60> [バッチ名=sweep] [出力先]
// 1試合ごとに 艦種(自機/敵)・性格4軸 (攻撃性/隠密性/貪欲さ/慎重さ) をランダムに振る。
// 4軸は 規定のプリセット(30%) / 一様乱数(35%) / 極端 {0.05,0.5,0.95} の組み合わせ(35%) から。
const { chromium } = require('playwright'); const fs = require('fs'), zlib = require('zlib'), path = require('path');
const [W = '3', MIN = '15', TOTAL = '60', BATCH = 'sweep', OUT] = process.argv.slice(2);
const out = OUT || path.join(__dirname, '..', 'records', 'sim', BATCH); fs.mkdirSync(out, { recursive: true });
const deadline = Date.now() + (+TOTAL) * 60000;
const SHIPS = ['assault', 'stealth', 'carrier'], PRES = ['standard', 'aggressive', 'cautious', 'stealthy', 'greedy', 'adaptive'];
const rnd = a => a[Math.floor(Math.random() * a.length)], r2 = x => Math.round(x * 100) / 100;
function pers() {
  const u = Math.random();
  if (u < 0.3) return { pre: rnd(PRES) };
  if (u < 0.65) return { pre: 'custom', p: { aggression: r2(Math.random()), stealth: r2(Math.random()), greed: r2(Math.random()), caution: r2(Math.random()) } };
  const E = [0.05, 0.5, 0.95]; return { pre: 'custom', p: { aggression: rnd(E), stealth: rnd(E), greed: rnd(E), caution: rnd(E) } };
}
async function worker(id, browser) {
  let n = 0;
  while (Date.now() < deadline - (+MIN) * 1000 * 6) {
    const cfg = { ship: rnd(SHIPS), enemy: rnd(SHIPS), P: pers(), E: pers() };
    const p = await browser.newPage({ viewport: { width: 1000, height: 560 } }); const errs = []; p.on('pageerror', e => errs.push(e.message));
    try {
      await p.goto('http://localhost:8099/prototype/index.html?t=' + Date.now()); await p.waitForTimeout(1000);
      const rec = await p.evaluate(async ([cfg, mins]) => {
        localStorage.setItem('darkEchoBriefed', '1');
        comCfg = loadComCfg(); comCfg.ship = cfg.ship; comCfg.enemy = cfg.enemy; comCfg.mode = 'br';
        for (const [s, k, pk, ppk] of [['P', 'pPreset', 'pp'], ['E', 'ePreset', 'ep']].map(a => [a[0], a[1], a[2]])) {
          const c = cfg[s]; comCfg[k] = c.pre; if (c.p) comCfg[ppk || pk] = c.p; else if (COM_PRESETS[c.pre] && COM_PRESETS[c.pre].p) comCfg[pk] = Object.assign({}, COM_PRESETS[c.pre].p);
        }
        comCfg.higgsView = true; comCfg.think = false; comCfg.lo = null; gameLoopRunning = true; startComDemo();
        for (let t = 0; t < mins * 60; t++) { for (let k = 0; k < 6; k++) window.__simSteps(10); if (!player || player.hp <= 0 || sectorCleared) break; }
        return matchRecordData();
      }, [cfg, +MIN]);
      if (rec) {
        const tag = x => x.p ? ['aggression', 'stealth', 'greed', 'caution'].map(k => Math.round(x.p[k] * 100)).join('-') : x.pre;
        rec.meta.sweep = { batch: BATCH, P: cfg.P, E: cfg.E };
        const fn = path.join(out, `sw_${cfg.ship}-${tag(cfg.P)}_vs_${cfg.enemy}-${tag(cfg.E)}_${Date.now()}_${rec.result.winner}_${rec.result.sec}s.json.gz`);
        fs.writeFileSync(fn, zlib.gzipSync(JSON.stringify(rec))); n++;
        console.log(`[w${id}] #${n} ${path.basename(fn)}${errs.length ? ' ERR ' + errs[0] : ''}`);
      }
    } catch (e) { console.log(`[w${id}] 失敗 ${e.message.slice(0, 120)}`); }
    await p.close();
  }
}
(async () => { const b = await chromium.launch(); await Promise.all(Array.from({ length: +W }, (_, i) => worker(i, b))); await b.close(); console.log('終了'); })();
