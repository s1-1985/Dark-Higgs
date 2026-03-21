# Dark-Higgs 開発教訓録

> 本文書はモバイルブラウザゲーム「Dark Higgs」の開発中に発生したインシデントと、
> その根本原因・再発防止策をまとめたものです。

---

## 経緯タイムライン

### フェーズ1: 機能開発期（PR #1〜#16）

宇宙背景テクスチャ・ヒッグス密度可視化・スレットリング・ソナーシステム・
モバイルUI改善などの機能を順次追加。この時点でパフォーマンスは後回し。

### インシデント A: mainへの直接プッシュ

```
964e44c Merge remote-tracking branch 'origin/main'  ← 競合が発生
617b88a feat: HUD/AI/オシロスコープ・ゲーム性改善をmainに統合  ← main直接push
```

**何が起きたか**: `claude/` プレフィックスブランチで作業すべきところを、
`main` ブランチに直接コミット・プッシュした。
その後リモートの `main` と diverge が発生し、強制マージで解決。

**原因**:
- ブランチ名の確認を怠った
- タスクに集中するあまりgit操作の確認フローが抜けた
- PRを経ないショートカットへの誘惑（「早く終わらせたい」）

---

### フェーズ2: パフォーマンス地獄（PR #17〜#19）

機能追加の蓄積により、モバイルで**体感できるレベルの遅延**が発生。
複数のPRで「修正したつもり」が繰り返された。

```
80e79b3 perf: viewport culling for bgMist radial gradients  ← 効果薄
43b431e perf: throttle heavy draws and reduce shadowBlur reduction  ← 効果薄
fa8310e perf: viewport culling, frame throttling  ← 効果薄
07f6f0b perf: 起動遅延修正・shadowBlur全面削減  ← 部分的
71a6cfe perf: 背景復元・星雲キャッシュ・スレットリング軽量化  ← 部分的
07f7716 perf: 根本原因を修正 — getHiggsキャッシュ等  ← やっと根本へ
```

**何が起きたか**: 症状（重い）は分かるが根本原因を特定せずに当て推量で修正を繰り返した。
5〜6回のPRが「効果薄」で終わり、コードが複雑化した。

**原因**:
- 実測なしの当て推量（"これが重そう"という感覚）
- 1つの問題を修正したつもりが別の問題は残っていた
- FPS計測機能がなかったため、修正前後の効果が不明

---

### インシデント B: bgMistCanvas — 起動10秒フリーズ（PR #20）

```
// 問題のあったコード
mc.width = mc.height = 4096;  // ← 4096×4096 = 64MB! Canvasを確保
// その上にcreateRadialGradient を 200個描画
```

**何が起きたか**:
- モバイルで**起動直後に10秒フリーズ**
- 4096×4096 px の Canvas を生成 → **GPU/RAM に 64 MB のバッファ確保**
- その上に 200個の `createRadialGradient()` を同期で描画
- ゲームループが一切動かない（UIスレッドをブロック）

**修正**: `mc.width = mc.height = 512` に縮小し、512×512に解決（PR #20）

**根本原因**: PC開発機で動くからといって、モバイルのメモリ・GPU帯域を考慮しなかった。

---

### フェーズ3: 正しいアプローチ（PR #20〜#23）

実測(FPS表示)を追加し、根本原因から攻めた。

| PR | 変更内容 | 効果 |
|----|---------|------|
| #20 | bgMistCanvas 4096→512 | **起動フリーズ解消** |
| #21 | shadowBlur をモバイルで prototype-patch で全オフ | 90箇所のGPUコスト→ゼロ |
| #21 | FPS表示追加（画面中央） | 改善効果の可視化 |
| #22 | Ship.draw() LOD: zoom=0.08で77ops→4ops | 95%削減 |
| #22 | getHiggsIntensity キャッシュグリッド 200→500 | 重複計算を大幅削減 |
| #22 | checkPassiveDetection を2フレーム間引き | 50%削減 |
| #23 | アンテナリング N_POINTS 36→18, segN 24→12 | 49%削減 |
| #23 | while→if、toFixed廃止、hex色事前定義 | GCプレッシャー削減 |

**結果**: FPS 21（スクリーンショット確認済み、改善継続中）

---

## 教訓

### 教訓 1: mainへの直接pushを絶対にしない

```
# ❌ NG
git checkout main
git commit -m "feat: ..."
git push origin main

# ✅ OK
git checkout -b claude/feature-name-xxxxx
git commit -m "feat: ..."
git push -u origin claude/feature-name-xxxxx
# → PR作成 → レビュー → マージ
```

**ルール**:
- `main` ブランチには直接 push しない（403エラーが出る設定になっているが意識も必要）
- ブランチ名は必ず `claude/` で始める（PR merge 権限の確認）
- push 前に `git branch` で今いるブランチを確認する

---

### 教訓 2: Canvas 解像度はモバイルを基準に設計する

モバイルのメモリ・GPU帯域はPCの 1/10〜1/100。

| Canvas サイズ | メモリ (RGBA) | 備考 |
|-------------|------------|------|
| 512×512 | 1 MB | モバイル: 安全 |
| 1024×1024 | 4 MB | モバイル: ギリギリ |
| 2048×2048 | 16 MB | モバイル: 要注意 |
| 4096×4096 | 64 MB | **モバイルでフリーズ確定** |

**ルール**:
- オフスクリーン Canvas は用途に応じた必要最低限のサイズにする
- 背景キャッシュ用途なら 512〜1024 で十分（縮小 drawImage で可）
- 変更前後で `canvas.width * canvas.height * 4 / 1024 / 1024` MB を計算して確認

---

### 教訓 3: shadowBlur はモバイルで致命的

`ctx.shadowBlur` は GPU が **ガウシアンブラー** をかける処理。
PC では問題ないが、モバイル GPU では描画コストが 5〜10倍になる。

```js
// ❌ モバイルで重い
ctx.shadowBlur = 15;
ctx.shadowColor = '#00ffaa';
ctx.arc(...); ctx.fill();  // ← GPU がブラー処理

// ✅ モバイルでは無効化
// prototype patch でモバイル時はshadowBlurを無効化
if (_isMobile) {
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', {
        set() {}, get() { return 0; }
    });
}
```

**ルール**:
- `shadowBlur` を使う箇所は必ず `// PERF: shadowBlur` コメントを付ける
- モバイルでは shadowBlur を使わず、`globalAlpha` + 重ね描きで代替する
- 追加する時は「このエフェクトはモバイルで何msかかるか」を想定する

---

### 教訓 4: 当て推量で直さない — まず計測する

```
症状: "重い"
     ↓
❌ 当て推量: "これが怪しい" → patch → "あれが怪しい" → patch (×5回)
     ↓
✅ 正しいアプローチ:
  1. FPS計測を追加する (PERF_SHOW_FPS フラグ)
  2. console.time() でゲームループの各フェーズを計測
  3. 最も重い処理を特定してから修正する
```

**ルール**:
- パフォーマンス改善に着手する前に必ず FPS 計測を有効化する
- 「修正前 X fps → 修正後 Y fps」を確認してからマージする
- 効果がなかったパッチはリバートする（コードを複雑にしない）

---

### 教訓 5: 画面に見えないものを描くな（LOD）

zoom=0.08 の状態で、船の詳細な艦体を 77回の Canvas 操作で描いていた。
実際の画面上のサイズは **4〜9 CSS ピクセル**。肉眼では識別不能。

```js
// 画面上のサイズを計算
const screenDiameter = camera.zoom * ship.radius * 5.6;

if (screenDiameter < 12) {
    // 4ops で描画 (LOD低)
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(-r*0.7, -r*0.6); ctx.lineTo(-r*0.7, r*0.6);
    ctx.closePath(); ctx.fill();
    return;
}
// 77ops の詳細描画は zoom が大きい時だけ
```

**ルール**:
- 画面上 12px 未満のオブジェクトは LOD（簡略描画）を使う
- `canvas operations × object count × frame rate` でコストを見積もる
  - 77ops × 15敵 × 60fps = **69,300 canvas ops/sec** → 重くなるのは当然
- ズームレベルに応じた詳細度を設計段階から組み込む

---

### 教訓 6: 同一フレーム内の重複計算をキャッシュする

```js
// ❌ 毎フレーム 23回、同じ座標で同じ計算をしていた
function getHiggsIntensity(x, y) {
    let total = 0;
    for (const m of bgMist) {  // 200個ループ
        total += Math.max(0, 1 - Math.hypot(x-m.x, y-m.y) / m.r) * m.density;
    }
    return total;
}

// ✅ フレームキャッシュ + 適切なグリッド量子化
const key = (Math.round(x / 500) * 100000 + Math.round(y / 500)) | 0;
if (cache.has(key)) return cache.get(key);
// 計算して cache.set(key, v);
```

**ルール**:
- ゲームループ内で複数回呼ばれる計算関数は**フレームキャッシュ**を実装する
- キャッシュキーの量子化グリッドは「視覚的に識別できる最大スパン」で設定する
- `_frameCount` をキャッシュのバージョンキーにすることで、次フレームで自動クリア

---

### 教訓 7: ゲームループで GC を起こすな

JavaScript の GC（ガベージコレクション）はゲームループの天敵。
毎フレーム文字列やオブジェクトを生成するとフレームドロップの原因になる。

```js
// ❌ 毎フレーム文字列オブジェクトを生成
ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;  // GCゴミ
ctx.fillStyle   = `rgba(${color},${(sig * 0.85).toFixed(3)})`; // GCゴミ

// ✅ globalAlpha + 定数カラーを使う
ctx.globalAlpha = sig * 0.85;
ctx.fillStyle = '#ffa03c';  // ← 文字列リテラル (インターン済み)
```

**ルール**:
- ゲームループ内では `toFixed()` を使わない → `globalAlpha` で代替
- テンプレートリテラルで動的な色文字列を作らない → 定数 hex か `globalAlpha` で対応
- `ctx.save()/restore()` は高コスト。必要なプロパティだけ手動で保存・復元する

---

## チェックリスト（修正前に確認）

### コード変更前
- [ ] 今いるブランチが `claude/` で始まっているか確認: `git branch`
- [ ] `PERF_SHOW_FPS = true` でFPS計測を有効化したか
- [ ] 変更対象の処理がどのくらいの頻度で呼ばれるか確認したか

### Canvas 操作を追加する時
- [ ] モバイルで `shadowBlur` を使っていないか
- [ ] オフスクリーン Canvas のサイズは 1024 以下か
- [ ] オブジェクト数 × ops数 × フレームレート のコストを見積もったか
- [ ] 画面上のサイズが 12px 未満の場合、LODを実装しているか

### ゲームループ内のコードを追加する時
- [ ] テンプレートリテラルで動的文字列を生成していないか
- [ ] `toFixed()` を使っていないか（`globalAlpha` で代替）
- [ ] 同じ計算を複数回呼んでいないか（フレームキャッシュを検討）
- [ ] 毎フレーム必要か、間引けないか（2〜6フレームごとで十分なケースが多い）

### PRマージ前
- [ ] 修正前後の FPS を記録したか
- [ ] モバイル実機（または Chrome DevTools モバイルエミュレーター）で確認したか
- [ ] ブランチが `claude/` で始まり、mainへ直接pushしていないか

---

## パフォーマンス予算（モバイル目標: 30fps = 33ms/frame）

| カテゴリ | 予算 |
|--------|------|
| 背景描画 (drawBackground) | ~5ms |
| エフェクト・パーティクル | ~3ms |
| 船体・敵描画 | ~5ms |
| パッシブアンテナ + HUD | ~5ms |
| ゲームロジック更新 | ~5ms |
| ミニマップ (3f毎) | ~2ms |
| その他 | ~8ms |
| **合計** | **~33ms** |

---

*最終更新: 2026-03-21*
*対象バージョン: PR #20〜#23 適用後*
