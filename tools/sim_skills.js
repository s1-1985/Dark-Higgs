// 接触を早めた COM対戦で スキルの発動を数える (第151弾)。使い方: node tools/sim_skills.js <試合数=12> <分=8> <開始距離=4500>
// 要: リポジトリのルートで python3 -m http.server 8099
const { chromium } = require('playwright');
const [N = '12', MIN = '8', DIST = '4500'] = process.argv.slice(2);
const SHIPS = ['assault', 'stealth', 'carrier'], PRES = ['standard', 'aggressive', 'cautious', 'stealthy', 'greedy', 'adaptive'];
const rnd = a => a[Math.floor(Math.random() * a.length)];
const AX = ['aggression','stealth','greed','caution','cunning','tech','command','patience'];
const rp = () => Math.random() < 0.5 ? { pre: rnd(PRES) } : { pre: 'custom', p: Object.fromEntries(AX.map(k => [k, Math.round(Math.random() * 100) / 100])) };
(async () => {
  const b = await chromium.launch(); const tot = {}; let errs = 0, deaths = 0; const FT = {};
  const run = async (i) => {
    const p = await b.newPage({ viewport: { width: 1000, height: 560 } }); p.on('pageerror', e => { errs++; console.log('ERR', e.message.slice(0, 100)); });
    await p.addInitScript(d => { window.__spawnMin = +d; window.__spawnVar = 1500; window.__tacDbg = {}; window.__facts = {}; }, DIST);
    await p.goto('http://localhost:8099/prototype/index.html?t=' + Date.now()); await p.waitForTimeout(800);
    const r = await p.evaluate(async ([cfg, mins]) => {
      localStorage.setItem('darkEchoBriefed', '1');
      comCfg = loadComCfg(); comCfg.ship = cfg.s; comCfg.enemy = cfg.e; comCfg.mode = 'br'; for (const [k, pk, c] of [['pPreset', 'pp', cfg.p], ['ePreset', 'ep', cfg.q]]) { comCfg[k] = c.pre; if (c.p) comCfg[pk] = c.p; else if (COM_PRESETS[c.pre] && COM_PRESETS[c.pre].p) comCfg[pk] = Object.assign({}, COM_PRESETS[c.pre].p); }
      comCfg.higgsView = true; comCfg.think = false; comCfg.lo = null; gameLoopRunning = true; startComDemo();
      for (let t = 0; t < mins * 60; t++) { for (let k = 0; k < 6; k++) window.__simSteps(10); if (!player || player.hp <= 0 || sectorCleared) break; }
      return { facts: window.__facts, dbg: window.__tacDbg, over: !player || player.hp <= 0 || sectorCleared };
    }, [{ s: rnd(SHIPS), e: rnd(SHIPS), p: rp(), q: rp() }, +MIN]);
    for (const [k, d] of Object.entries(r.dbg)) { const t = tot[k] || (tot[k] = { n: 0, on: 0, cond: 0, p: 0, e: 0 }); t.n += d.n; t.on += d.on; t.cond += d.cond; t.p += d.side.p; t.e += d.side.e; }
    for (const [k, v] of Object.entries(r.facts || {})) FT[k] = (FT[k] || 0) + v;
    if (r.over) deaths++; await p.close();
  };
  const W = 3; let next = 0; await Promise.all(Array.from({ length: W }, async () => { while (next < +N) await run(next++); }));
  console.log('試合', N, '決着', deaths, 'エラー', errs);
  console.log('スキル\t判定\t使える\t条件成立\t自機\t敵');
  for (const [k, t] of Object.entries(tot).sort((a, b) => a[1].cond - b[1].cond)) console.log([k, t.n, t.on, t.cond, t.p, t.e].join('\t'));
  console.log('前提の成立回数:', JSON.stringify(FT));
  await b.close();
})();
