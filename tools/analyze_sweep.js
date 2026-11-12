// sweep の記録を、性格4軸・艦種ごとに集計する (勝率・決着率・初接触・撃ち合い・任務の使用)。
// 使い方: node tools/analyze_sweep.js [records/sim の下のパス]
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..', 'records', 'sim');
const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/^sw_.*\.json\.gz$/.test(f.name)) files.push(p); } })(root);
const R = []; for (const f of files) { try { R.push(JSON.parse(zlib.gunzipSync(fs.readFileSync(f)))); } catch (e) {} }
const AX = ['aggression', 'stealth', 'greed', 'caution'], AJ = { aggression: '攻撃性', stealth: '隠密性', greed: '貪欲さ', caution: '慎重さ' };
const P = (m, s) => { const x = m.sweep[s]; return x.p || (m.cfg && m.cfg[s === 'P' ? 'pp' : 'ep']) || null; };
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-', med = a => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0;
const dec = r => r.result.winner === 'player' || r.result.winner === 'enemy';
console.log('試合', R.length, ' 決着', pct(R.filter(dec).length, R.length), ' エラー判定は別');
// 艦種の組み合わせ
const sh = {}; for (const r of R) { const k = r.meta.ship + ' vs ' + r.meta.enemy; const g = sh[k] || (sh[k] = { n: 0, d: 0, pw: 0, t: [], c: [] }); g.n++; if (dec(r)) { g.d++; if (r.result.winner === 'player') g.pw++; g.t.push(r.result.sec); } const fc = r.result.stats && r.result.stats.firstContact; if (fc >= 0) g.c.push(Math.round(fc / 3600)); }
console.log('\n艦種の組み合わせ: 試合 / 決着 / (決着のうち)自機勝 / 決着までの中央値 / 初接触の中央値(分)');
for (const [k, g] of Object.entries(sh)) console.log(' ', k.padEnd(18), g.n, pct(g.d, g.n), pct(g.pw, g.d), Math.round(med(g.t) / 60) + '分', med(g.c) + '分(' + g.c.length + '件)');
// 4軸: 高(>=0.7)/中/低(<0.3) 別に 自機の側の 決着に絡む勝率 と 接触率
for (const side of ['P', 'E']) {
  console.log('\n' + (side === 'P' ? '自機COM' : '敵COM') + ' の性格軸ごと: 勝率(決着した試合のうち) / 接触した試合の割合 / 撃った試合の割合');
  for (const ax of AX) {
    const row = [];
    for (const [lab, f] of [['低', v => v < 0.3], ['中', v => v >= 0.3 && v < 0.7], ['高', v => v >= 0.7]]) {
      const g = R.filter(r => { const p = P(r.meta, side); return p && f(p[ax]); }); const d = g.filter(dec);
      const win = d.filter(r => r.result.winner === (side === 'P' ? 'player' : 'enemy')).length;
      const fc = g.filter(r => r.result.stats && r.result.stats.firstContact >= 0).length, sh2 = g.filter(r => r.result.stats && (r.result.stats.shots || r.result.stats.shotsFired || 0) > 0).length;
      row.push(lab + ' n=' + g.length + ' 勝' + pct(win, d.length) + ' 接触' + pct(fc, g.length) + ' 決着' + pct(d.length, g.length));
    }
    console.log('  ' + AJ[ax] + ': ' + row.join(' | '));
  }
}
// 任務
const tac = { p: {}, e: {} }; for (const r of R) for (const [, s, t] of (r.th || [])) { const m = /^【([^】]+)】/.exec(t); if (m && tac[s]) tac[s][m[1]] = (tac[s][m[1]] || 0) + 1; }
console.log('\n任務の登場回数 自機COM', JSON.stringify(tac.p)); console.log('任務の登場回数 敵COM', JSON.stringify(tac.e));
// 行動量
let tot = 0, still = 0; const ex = [0, 0, 0, 0]; for (const r of R) for (const x of (r.x || [])) { tot++; if (x.p.sp < 0.15) still++; ex[x.p.ex || 0]++; }
console.log('\n自艦が止まっている時間', pct(still, tot), ' 兆候 静穏/受信/照射/攻撃', ex.map(v => pct(v, tot)).join('/'));
