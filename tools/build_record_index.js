// records/ の試合の記録 (.json.gz) の一覧 records/index.json を作る — リプレイモードの「記録一覧」(Gitの記録を開く) が読む
// 使い方 (リポジトリのルートで): node tools/build_record_index.js
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const root = path.join(__dirname, '..', 'records'), files = [];
for (const dir of ['device', 'sim']) {
  const d = path.join(root, dir); if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter(f => f.endsWith('.json.gz') || f.endsWith('.json'))) {
    try {
      const buf = fs.readFileSync(path.join(d, f)), r = JSON.parse(f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf), M = r.meta || {}, R = r.result || {};
      files.push({ f: dir + '/' + f, dir, at: M.at || '', ship: M.ship, enemy: M.enemy, pPre: M.pPre, ePre: M.ePre, com: !!M.com, winner: R.winner, sec: R.sec, ver: M.ver || '', fmt: r.fmt || 1, kb: Math.round(buf.length / 1024) });
    } catch (err) { console.error('skip', f, String(err)); }
  }
}
files.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ built: new Date().toISOString(), files }, null, 1));
console.log('records/index.json:', files.length, 'files');
