// COM対戦をヘッドレスで一括実行し、試合の記録 (matchRecordData) を records/ に保存する。
// 使い方 (リポジトリのルートで `python3 -m http.server 8099` を起動しておく):
//   node tools/sim_matches.js <自機艦種> <敵艦種> <自機性格> <敵性格> <分> <回数> [出力先=records/sim]
//   例) node tools/sim_matches.js stealth assault stealthy aggressive 15 8
// 艦種: assault / stealth / carrier   性格: COM_PRESETS のキー (standard aggressive cautious stealthy greedy ...)
const { chromium } = require('playwright'); const fs = require('fs'); const zlib = require('zlib'); const path = require('path');
const [ship = 'assault', enemy = 'assault', pP = 'standard', eP = 'standard', mins = '15', reps = '4', out = path.join(__dirname, '..', 'records', 'sim')] = process.argv.slice(2);
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  for (let n = 0; n < +reps; n++) {
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8099/prototype/index.html?t=' + Date.now()); await p.waitForTimeout(1200);
    const rec = await p.evaluate(async ([ship, enemy, pP, eP, mins]) => {
      localStorage.setItem('darkEchoBriefed', '1');
      comCfg = loadComCfg(); comCfg.ship = ship; comCfg.enemy = enemy; comCfg.mode = 'br'; comCfg.pPreset = pP; comCfg.ePreset = eP;
      if (COM_PRESETS[pP] && COM_PRESETS[pP].p) comCfg.pp = Object.assign({}, COM_PRESETS[pP].p);
      if (COM_PRESETS[eP] && COM_PRESETS[eP].p) comCfg.ep = Object.assign({}, COM_PRESETS[eP].p);
      comCfg.higgsView = true; comCfg.think = false; comCfg.lo = null; gameLoopRunning = true; startComDemo();
      for (let t = 0; t < mins * 60; t++) { for (let k = 0; k < 6; k++) window.__simSteps(10); if (!player || player.hp <= 0 || sectorCleared) break; }
      return matchRecordData();
    }, [ship, enemy, pP, eP, mins]);
    if (rec) { const fn = path.join(out, `sim_${ship}-${pP}_vs_${enemy}-${eP}_${Date.now()}_${rec.result.winner}_${rec.result.sec}s.json.gz`); fs.writeFileSync(fn, zlib.gzipSync(JSON.stringify(rec))); console.log(fn, rec.result.winner, rec.result.sec + 's', errs.length ? 'ERR ' + errs[0] : ''); }
    await p.close();
  }
  await b.close();
})();
