// 鏡合わせ試合の偏りを測る: node tools/mirror_stats.js records/sim/mirror3 [...]  (勝ち数・占有・ノード・最初のコロニー占有の秒)
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const by = {};
for (const d of process.argv.slice(2)) for (const f of fs.readdirSync(d)) {
  if (!/\.json\.gz$/.test(f)) continue; const r = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(d, f))));
  const q = k => r.ev.filter(e => e.kind === k).map(e => Math.round(e.t / 60));
  const b = by[r.meta.ship] || (by[r.meta.ship] = { n: 0, pw: 0, ew: 0, cp: 0, ce: 0, np: 0, ne: 0, fp: [], fe: [] });
  b.n++; if (r.result.winner === 'player') b.pw++; if (r.result.winner === 'enemy') b.ew++;
  const cp = q('colonyP'), ce = q('colonyE'); b.cp += cp.length; b.ce += ce.length; b.np += q('nodeP').length; b.ne += q('nodeE').length; if (cp.length) b.fp.push(cp[0]); if (ce.length) b.fe.push(ce[0]);
}
const med = a => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : '-';
for (const k in by) { const b = by[k]; console.log(k.padEnd(8), 'n', b.n, ' 自機勝/敵勝', b.pw + '/' + b.ew, ' コロニー 自/敵', b.cp + '/' + b.ce, ' ノード 自/敵', b.np + '/' + b.ne, ' 最初の占有(秒) 自', med(b.fp), '敵', med(b.fe) + ' (' + b.fe.length + '試合)'); }
