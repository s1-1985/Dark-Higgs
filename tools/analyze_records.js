// 試合の記録 (records/**/*.json, *.json.gz) をまとめて集計する。
// 使い方: node tools/analyze_records.js [records のパス=records]
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..', 'records');
const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.json(\.gz)?$/.test(f.name)) files.push(p); } })(root);
const recs = []; for (const f of files) { try { let b = fs.readFileSync(f); if (/\.gz$/.test(f)) b = zlib.gunzipSync(b); const d = JSON.parse(b); d._f = path.basename(f); recs.push(d); } catch (e) { console.error('読めない:', f, e.message); } }
if (!recs.length) { console.log('記録がありません:', root); process.exit(0); }
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
const by = {}; // 組み合わせごと
for (const r of recs) {
  const m = r.meta || {}, k = (m.ship || '?') + '(' + (m.pPre || '') + ') vs ' + (m.enemy || '?') + '(' + (m.ePre || '') + ')';
  const g = by[k] || (by[k] = { n: 0, pw: 0, ew: 0, none: 0, secs: [], kill: {}, amb: 0, contact: [] }); g.n++;
  const w = r.result.winner; if (w === 'player') g.pw++; else if (w === 'enemy') g.ew++; else g.none++;
  g.secs.push(r.result.sec);
  if (w === 'enemy' && r.result.cause) { const c = r.result.cause; const t = (c.kind || '?') + (c.preempt || /奇襲/.test(JSON.stringify(c)) ? '・奇襲' : '') + (c.rear ? '・後方' : ''); g.kill[t] = (g.kill[t] || 0) + 1; }
  if (r.result.stats) { g.amb += r.result.stats.ambushes || 0; if (r.result.stats.firstContact >= 0) g.contact.push(Math.round(r.result.stats.firstContact / 3600)); }
}
console.log('記録', recs.length, '件 /', Object.keys(by).length, '通りの組み合わせ\n');
for (const [k, g] of Object.entries(by)) {
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  console.log(k + ' — ' + g.n + '試合 自機勝 ' + g.pw + ' / 敵勝 ' + g.ew + ' / 決着なし ' + g.none + '  時間(中央値) ' + Math.round(med(g.secs) / 60) + '分' + (g.contact.length ? '  初接触(中央値) ' + med(g.contact) + '分' : '') + (g.ew ? '  自機の死因 ' + JSON.stringify(g.kill) : ''));
}
// 任務・戦略の使用回数 (思考ログの【…】から)
const tac = { p: {}, e: {} };
for (const r of recs) for (const [, side, text] of (r.th || [])) { const m = /^【([^】]+)】/.exec(text); if (m && tac[side]) tac[side][m[1]] = (tac[side][m[1]] || 0) + 1; }
console.log('\n任務の登場回数 (自機COM)', JSON.stringify(tac.p)); console.log('任務の登場回数 (敵)', JSON.stringify(tac.e));
// 停止している時間の割合・移動距離 (5秒ごとの詳細から)
let still = 0, tot = 0, silentRun = 0, exp = [0, 0, 0, 0];
for (const r of recs) for (const x of (r.x || [])) { tot++; if (x.p.sp < 0.15) still++; if (x.p.st === 'silent') silentRun++; exp[x.p.ex || 0]++; }
console.log('\n自艦が止まっている時間', pct(still, tot), ' 潜航の時間', pct(silentRun, tot), ' 兆候 静穏/受信/照射/攻撃 =', exp.map(v => pct(v, tot)).join('/'));
// 死ぬ直前30秒の自艦の兆候 (気付けていたか)
let dead = 0, quiet = 0; for (const r of recs) if (r.result.winner === 'enemy') { dead++; const xs = (r.x || []).slice(-6); if (xs.length && xs.every(x => (x.p.ex || 0) <= 1)) quiet++; }
if (dead) console.log('自機が負けた' + dead + '試合のうち、直前30秒の兆候が「静穏/受信」のまま = ' + quiet + ' (気付けないまま撃たれた)');
