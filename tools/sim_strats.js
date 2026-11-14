// 戦略の登場回数を数える (第153弾)。使い方: node tools/sim_strats.js <試合数=18> <分=15> <ワーカー=3>  (要: python3 -m http.server 8099)
const { chromium } = require('playwright');
const [N = '18', MIN = '15', W = '3'] = process.argv.slice(2);
const SHIPS = ['assault', 'stealth', 'carrier'], PRES = ['standard', 'aggressive', 'cautious', 'stealthy', 'greedy', 'adaptive'];
const rnd = a => a[Math.floor(Math.random() * a.length)];
(async () => {
  const b = await chromium.launch(); const tot = { p: {}, e: {} }; let errs = 0, next = 0;
  const run = async () => { while (next++ < +N) {
    const p = await b.newPage({ viewport: { width: 1000, height: 560 } }); p.on('pageerror', e => { errs++; console.log('ERR', e.message.slice(0, 100)); });
    await p.goto('http://localhost:8099/prototype/index.html?t=' + Date.now()); await p.waitForTimeout(800);
    const r = await p.evaluate(async ([cfg, mins]) => {
      localStorage.setItem('darkEchoBriefed', '1'); comCfg = loadComCfg(); comCfg.ship = cfg.s; comCfg.enemy = cfg.e; comCfg.mode = 'br'; comCfg.pPreset = cfg.p; comCfg.ePreset = cfg.q;
      for (const [k, pk, pre] of [['pPreset', 'pp', cfg.p], ['ePreset', 'ep', cfg.q]]) if (COM_PRESETS[pre] && COM_PRESETS[pre].p) comCfg[pk] = Object.assign({}, COM_PRESETS[pre].p);
      comCfg.higgsView = true; comCfg.think = false; comCfg.lo = null; gameLoopRunning = true; startComDemo();
      const seen = { p: {}, e: {} }, last = { p: null, e: null };
      for (let t = 0; t < mins * 60; t++) { window.__simSteps(60); if (!player || player.hp <= 0 || sectorCleared) break;
        const e = enemies.find(q => q.type !== 'fighter'); const a = _com && _com.st ? _com.st.id + '@' + _com.st.t0 : null, c = e && e._strat ? e._strat.id + '@' + e._strat.t0 : null;
        if (a && a !== last.p) { last.p = a; const id = a.split('@')[0]; seen.p[id] = (seen.p[id] || 0) + 1; } if (c && c !== last.e) { last.e = c; const id = c.split('@')[0]; seen.e[id] = (seen.e[id] || 0) + 1; } }
      return seen;
    }, [{ s: rnd(SHIPS), e: rnd(SHIPS), p: rnd(PRES), q: rnd(PRES) }, +MIN]);
    for (const w of ['p', 'e']) for (const k in r[w]) tot[w][k] = (tot[w][k] || 0) + r[w][k];
    await p.close(); } };
  await Promise.all(Array.from({ length: +W }, run));
  console.log('試合', N, 'エラー', errs); const ids = [...new Set([...Object.keys(tot.p), ...Object.keys(tot.e)])].sort((a, c) => (tot.p[c] || 0) + (tot.e[c] || 0) - (tot.p[a] || 0) - (tot.e[a] || 0));
  console.log('戦略\t自機\t敵'); for (const k of ids) console.log(k + '\t' + (tot.p[k] || 0) + '\t' + (tot.e[k] || 0));
  await b.close();
})();
