# Dark Echo — HANDOVER（セッションログ・決定経緯・教訓）

> **このファイルの役割**: セッション間の引き継ぎ記録。**何を・なぜ・どう決めたか**の経緯と、
> パフォーマンス／git の教訓を残す。
> - プロジェクト概要・確定仕様・コードクイックリファレンス → **`CLAUDE.md`**
> - 実装する／した機能の台帳（壁打ち企画・実装状況） → **`TODO.md`**
> - 本書 = セッションログ・決定ログ・アセット生成手順・パフォーマンス教訓

---

## セッションログ（新しい順）

### 2026-06-21（PR#107・#108・`claude/battleship-sprite-ui-layout-cdc1tw`）— ランドマーク発見/識別システム・sig-info-bar・UI整理

**背景**: 大型11項目リクエスト（PR#107）→ UIレイアウトフィードバック修正（PR#108）の2PR。

#### PR#107 — 11項目一括実装

1. **レーダーリンク削除**: ミニマップオーバーレイから「レーダーリンク」spanを削除。
2. **ミニマップ目盛り度数削除**: `drawMinimap`の15°刻みtick描画で `fillText` 数字を削除（tick線は維持）。
3. **システムログ高さ = ミニマップ高さ**: モバイルCSS `#log-panel { height:100px }` に統一。`top:40px; left:110px; right:4px; width:auto` でミニマップ右端まで拡張。
4. **システムログ幅**: ミニマップ右端〜ログパネル左端の隙間を埋めるよう `left:110px; right:4px` で自動伸縮。
5. **システムログ最大20件・スクロール**: `while (log.children.length > 20) log.removeChild(log.firstChild)`。`overflow-y:auto`。
6. **drawRadialScale をヒッグス霧の後へ移動**: `drawBackground`（fog前の旧位置`game.js:5842`付近）から削除→ gameLoop の `drawFogOfWar()` 直後に移動。距離チェックロジックをインラインで再現。
7. **ランドマーク未発見時は非表示**: `Structure`コンストラクタに `discovered=false; identified=false` 追加。`generateSector`で `col.discovered=true` / `der.discovered=true` を削除（発見前は不可視）。毎フレーム `computeVisionRadius()` 範囲内に入ると `discovered=true` に。フィールド描画は `if (s.discovered || s.identified) s.draw(ctx)`。ミニマップも発見/識別状態で分岐（未発見=非表示）。リソースノードにも `identified:false` を追加し、HIGGS/EMセンサー以外かつ未識別は非表示。
8. **ランドマークのパッシブ探知シグネチャ追加**:
   - colony: 既存HEAT/OPTIC(0.52)に加え EM 0.35 追加
   - derelict: OPTIC 0.40 + HEAT 0.20 を新規追加
   - resourceNode: HIGGS 0.70 + EM 0.25（旧0.62から分割）
9. **識別しきい値**: `(dirAnalysis + triParam) / 2 > 30%` → `identified=true`。識別時にシステムログ表示。
10. **識別済みランドマーク**: ヒッグス層の前面に表示（drawFogOfWar後に描画）。ミニマップ/フィールド上で `globalAlpha=0.65` のdimアイコン表示。
11. **sig-info-bar**: 両オシロスコープ（`sig-canvas` + `env-sig-canvas`）を合計幅70%（各35%）に縮小。右30%に `#sig-info-bar` を新設。LCKステータス・方向解析%・三角測量%・レートを表示。`updateSigInfoBar()` 関数を追加（`gameLoop`内で6フレーム毎呼出）。

- **キャッシュバスティング**: `?v=20260621c`

#### PR#108 — sig-info-bar レイアウト・レート修正

- **各パラメータ横1行化**: 初実装で label/value/rate が別divで縦3行になっていた問題を修正。`.sib-row` flex行に label+value+rate をまとめてインライン配置。
- **高さ上限28px固定**: `height:28px; max-height:28px` でレイアウト行がオシロスコープ高さを超えないよう制約。
- **1秒スナップショット方式レート表示**: 前実装は呼出間隔（≈100ms）でレートを計算→ほぼ0に見えていた。`_sibSnap`（dir/tri/snapTime）を保持し1秒ごとにΔ計算→ `_sibDirRate`/`_sibTriRate` に格納。表示: `(+X.XX%/s)` or `(-X.XX%/s)` 形式。
- **パッシブ検知サイクル 2秒→1秒**: `passiveCheckTimer < 60` (1秒)に変更。
- **dirAnalysis積算係数 ×2→×1**: サイクルを半分にしたため積算量も半分に→実効レートは同じまま。

#### Q&A: 赤い丸について
ユーザーから「移動中に自機から出ているあかいまるはなに？」という質問。
**回答**: シグネチャ・スレットリング（`drawPassiveAntenna`）のHEATセクター。移動で `heatSig` が速度比例で上昇し、HEAT弧（`#ffa03c` オレンジ赤）が光る。バグではなく仕様通り。止まれば冷える。

#### ⚠️ 申し送り
- **ランドマーク発見フロー未実機検証**: 発見→識別の2段階、ミニマップ表示切替のUXはGitHub Pagesで要確認。
- **識別30%しきい値のバランス**: 現状は固定値。ゲームセッションで溜まりやすすぎ/遅すぎの場合はしきい値調整。
- **sig-info-bar**: モバイル3列グリッド（`1fr 1fr 30%`）の3列目に配置。デスクトップでは `display:none`。
- **right-panel に border-right 追加**: 元 `border-right:none` だったが `1px solid rgba(0,255,170,0.12)` に変更（sig-info-barの視覚的区切り）。
- **キャッシュバスティング**: `?v=20260621c`（PR#108マージ時点）。

---

### 2026-06-20（PR#89〜#93・`claude/battleship-sprite-ui-layout-cdc1tw`）— 想定ロックジッター・解析パネル拡張・ラジアルメニュー・ダメージUI・敵HPバー

**背景**: 前セッションから続くTODO消化。計5PR。

#### PR#89 — kinetic/missile 想定ロックジッター
- **kinetic**: 発射角に `(rand-0.5) * (1-acc) * 0.55` rad の散弾ブレを追加。assault 3連装は同方向に統一されたジッター（3発がバラけすぎず体感が良い）。
- **missile**: ダミーターゲット座標を `(1-acc) * 500u` オフセットへ向けてホーミング発射。精度が低いほど明後日の方向へ飛ぶ。
- ログ出力あり（`game.js:1910付近`）。

#### PR#90 — §4-4 Phase3: 解析モーダル移動ペナルティ = なし（オーナー決定）
- 「解析モーダルを開いている間の移動ペナルティ有無」が未確定だったが、オーナーが**ペナルティ不採用**を決定。実装コスト0・仕様確定。

#### PR#91 — 右オシロスコープ (env-sig-canvas) タップ → 解析パネル
- `env-sig-canvas`（右側の環境シグネチャ波形キャンバス）にタッチイベントを追加。
- タップで左 `sig-canvas` と**同一の解析パネル**を開閉する（既存パネルを共用、新規UI不要）。
- `sig-canvas`（左・自機シグネチャ）と `env-sig-canvas`（右・環境/敵シグネチャ）の両方から解析を起動できるようになった。

#### PR#92 — 長押しラジアルメニュー + ミニマップ三角測量円
- **長押しラジアルメニュー**: 既存の「長押し=ウェイポイント設定」を拡張。長押し時に `[ここへ移動 / この座標に射撃 / キャンセル]` の3択メニューを表示。「この座標に射撃」= §4-4 E の座標射撃UI の実装。
- **ミニマップ三角測量円**: `drawTriangulationCircle()` をミニマップ上でも可視化。解析精度に連動した円の大きさ・色（赤/橙/緑）でミニマップ上に精度円を描画。

#### PR#93 — SUP削除・GEN配分2列化・ダメージ浮き文字・システムログ・敵HPバー
- **SUP ボタン削除**: アクションバーから `sup` グループ（修復ドローン用途）を完全削除。`ACTION_GROUPS` からも除去。
- **GEN配分UI 2列化**: エンジンアイコン(engine-gcb)と センサーアイコン(sensor-gcb) を左カラム(34px固定)に縦並び、全スライダーを右カラムに配置。ヘッダー行2本を廃止し操作UIの縦幅を圧縮、フィールド表示範囲が拡大。
- **ダメージ浮き文字**: kinetic/missile/beam のヒット時に `floatText` エフェクトを生成。自機→敵=黄色(`#ffdd00`)、敵→自機=赤(`#ff5555`)。先制ヒット時の既存 `先制! x2 (N)` テキストとの重複を `if (!preemptive)` ガードで防止。
- **システムログ HIT 表示**: 自機の攻撃がヒットした際に `HIT [TYPE] → N ダメージ` を `warning-msg` クラスでシステムログに出力。
- **敵HPバー常時表示**: スプライト描画の早期 `return` 前 (`Ship.draw()` 内のスプライトブロック末尾) に HPバー描画を追加。`ctx.rotate(-this.angle)` で逆回転してバーを水平固定。HP比率で色変化 (>60%=緑 / 30-60%=橙 / <30%=赤)。透明度は `visible` > `isFlashing` > `contactAccuracy` の優先度。

#### ⚠️ 申し送り
- **§4-4 座標射撃系** は概ね実装完了。未着手は §4-4 G. 残2点（ゴースト針路変更タイムラグ・解析結果サークル上限数）とデコイ解析フィードバック。
- 敵HPバーの **canvas フォールバック版**（スプライト非対応の描画パス、`game.js:3133-3141` 付近）も同様に更新済み。
- GEN配分2列化のCSS は `index.html` のインライン style で実装（`style.css` への抽出は任意）。
- キャッシュバスティング: `?v=20260702`（PR#93 マージ時点）

---

### 2026-06-15（PR#76+77・`claude/sleepy-davinci-alrc2s`）— 重慣性物理・武器射角・デモモード・敵艦種選択 + Round3スプライト + ビームVFX

**背景**: 7機能の大型壁打ち（慣性物理・後方被弾ボーナス・武器射角・フリー射撃・デモモード・敵艦種選択・ビームVFX）+ スプライトRound3更新。PR#76で全実装、PR#77でバグ修正。

#### スプライト Round 3 + ビームVFX
- 7種（自機3 + 敵4）を nano_banana_pro で全面再生成。PIL コーナー輝度チェック後、`ship_assault`/`ship_carrier`/`enemy_destroyer`/`enemy_carrier` の4種を flood-fill 修正。`enemy_carrier` は JPEG→PNG変換が必要だった（Higgsfield がJPEGで返した）。
- **新規**: `fx_beam_main.png`（荷電粒子砲VFX、黒背景・シアン白プラズマ・1376×768）をHiggsfieldで生成。ガンダムSEEDヴァリアント / ZOIDSデスザウラー荷電粒子砲モチーフ。`SPRITE_FILES` に `fx_beam_main` として登録済み。

#### 重慣性物理システム（PR#76）
- Ship コンストラクタに `currentSpeed = 0` プロパティ追加（慣性実速度）。
- **2層速度設計**: `_baseTargetSpeed`（フレーム毎に GEN/エンジン/ヒッグスから算出した目標速度）と `currentSpeed`（実速度、フレーム毎に target に向かって加速）を分離。
- **艦種別定数**:
  - `SHIP_MAX_SPEED_MULT = { assault: 0.58, stealth: 1.05, carrier: 0.38 }` — 最高速倍率
  - `SHIP_ACCEL_RATE = { carrier: 0.003, assault: 0.008, stealth: 0.016 }` — 加速レート
  - `SHIP_TURN_SLOW = { carrier: 0.78, assault: 0.52, stealth: 0.22 }` — 旋回中の速度低下率
  - `PLAYER_TURN_RATES = { assault: 0.010, stealth: 0.015, carrier: 0.004 }` — 旋回レート（ラジアン/フレーム）
  - `ENEMY_TURN_RATES = { corvette: 0.030, fighter: 0.040, destroyer: 0.014, carrier: 0.006 }`
- **旋回スロー**: 旋回量 `|diff| / (π × 0.12)` を 0〜1 に正規化したスロー係数を `SHIP_TURN_SLOW` に掛けてその分だけ target speed を低下させる。停止から最高速までは `SHIP_ACCEL_RATE` で徐々に加速。停止時は `SHIP_ACCEL_RATE × 3` で減速（停止が速い）。
- **全体速度低下**: GEN エンジン配分の速度係数 `genGain * 1.4` に抑制を加え、マップの広大感を維持。
- **デザイン意図**: 空母は重くて旋回も遅く加速も鈍い。潜航型は身軽で即座に反応。攻撃型は中間。空母で旋回しながら発砲しようとすると明確に速度が落ちる。

#### 武器射角（PR#76）
- `WEAPON_FIRE_ARC = { kinetic: Math.PI * 5/6, missile: Math.PI/4, beam: Math.PI/18 }`
  - kinetic: ±150°（前方300°） / missile: ±45°（前方90°） / beam: ±10°（前方20°）
- 自動射撃の発砲前に `Math.abs(diff) < _fireArc` を判定。射角外では発砲しない（回り込みが必要）。

#### 右クリック自由射撃（PR#76）
- `canvas.addEventListener('contextmenu', ...)` でミサイル/ビームのみ受付（canvas クリック座標 → カメラ行列でワールド座標変換）。
- 射角チェック（`WEAPON_FIRE_ARC`）あり。射角外は `logMessage` で通知して不発。
- **ミサイル**: 偽ターゲット `{ x, y, hp: 999 }` を作ってホーミング発射。外れても熱シグネチャを残す。
- **ビーム**: 直線コリジョン検査（line segment–circle intersection、`enemy.radius * 1.5`）で敵に判定。当たれば `beam` エフェクト生成+ダメージ。外れでもヒッグスダークチャネルが残り自位置が露出（EMシグネチャスパイクも追加）。
- **設計意図**: 「シグネチャから予想して勘打ちをし、外すと逆に位置がバレる」駆け引き。長押しウェイポイントと操作が被らないよう右クリックを選択。

#### 後方被弾ボーナス（PR#76）
- Projectile.update の被弾処理内で被弾角度 `_hitAng = atan2(this.y - hitTarget.y, this.x - hitTarget.x)` と `hitTarget.angle` の差分を計算。
- `|diff| > π × 0.55`（概ね後方 ±165° の弧）の場合 `dmgMult *= 1.5`。
- 自機が後方被弾した場合はフロートテキスト「後方被弾 ×1.5」（`#ff6666`）を表示。

#### デモモード（PR#76）
- `let demoMode = false;`（game.js 先頭付近）
- `drawFogOfWar()` 冒頭で `if (demoMode) return;` — ヒッグス暗幕を全解除。
- `updateVisionLockOn()` 冒頭で `if (demoMode) { enemies.forEach(e => { e.visible = true; e.inVision = true; }); return; }` — 全敵を常時視野内扱い。
- 敵AIの挙動は通常と同一（センサー制約型の検知ロジックをそのまま維持）。
- `toggleDemoMode()` 関数追加。`btn-demo-mode`（トップバー右上）でトグル。ON 時は黄色テキスト + `DEMO: ON` 表示。

#### 敵艦種選択（PR#76）
- ロビーに「敵艦種」セクション追加（`.enemy-select-btn`、3択）。
- 表示名: 攻撃型（高耐久・重装甲）/ 潜航型（高速・ステルス）/ 空母型（大型・ドローン）
- `gameState.enemyType` に `'assault' | 'stealth' | 'carrier'` を格納。
- `generateSector()` 内の敵スポーンで内部型にマップ: `{ assault: 'destroyer', stealth: 'corvette', carrier: 'carrier' }` → ボス敵の `new Ship(...)` 第4引数に渡す。

#### バグ修正（PR#77）
- **重複敵艦種選択ブロック**: PR#76 でバックグラウンドエージェントとメインスレッドが両方 index.html に enemy-select ブロックを追加したため2つ表示されていた。PR#77 で単一ブロックに統合。
- **敵艦種の内部名表示**: 初回実装では「コルベット / デストロイヤー / ファイター」（内部ゲーム型名）が表示されていたが、ユーザー期待は自機と対応する「攻撃型 / 潜航型 / 空母型」だった。PR#77 で修正。

#### キャッシュバスティング
- 最終バージョン: `?v=20260615j`（PR#77マージ時点）

#### ⚠️ 申し送り
- **実機未検証**: 慣性物理のバランス（重さ感・加速時間・旋回スロー）は実機 GitHub Pages で体感要確認。`SHIP_ACCEL_RATE` / `SHIP_TURN_SLOW` / `SHIP_MAX_SPEED_MULT` は全てチューニング可能な定数。
- `fx_beam_main.png` は `SPRITE_FILES` 登録済みだが、現在のビーム描画は 3層グロー（Canvas）で実装済み。スプライト合成追加は任意。
- デモモードは開発者確認用。本番でも ON/OFF 可。敵AIは通常挙動のまま。

---

### 2026-06-15（PR#71+72・`claude/sleepy-davinci-alrc2s`）— 船体スプライト全面再生成 + 白背景修正
- **PR#71（全面再生成）**: nano_banana_pro で7種全再生成（真上90度正射影・艦首右・黒背景・Homeworld2アニメSFスタイル）。
  - 自機3種: ship_assault（重装甲・シアン）/ ship_stealth（低プロファイル・紫）/ ship_carrier（広甲板・6スラスター）
  - 敵4種: enemy_corvette / enemy_destroyer / enemy_carrier / enemy_fighter（三角デルタ）
- **PR#72（白背景修正）**: 生成後に`ship_carrier`, `enemy_corvette`, `enemy_fighter` の3種が白背景(lum≈254)だったことが判明（他4種はlum≈1で黒背景）。PIL flood-fillでコーナーから連結白領域を純黒(0,0,0,255)に置換。
- **⚠️ スプライト黒背景の注意点（次セッション向け）**:
  - nano_banana_pro は約3/7の確率で白背景を生成する（モデルの確率的挙動）。生成後に必ずコーナー輝度を確認すること。
  - 修正スクリプト（Pillow flood-fill）: `from PIL import Image; import collections; ...` 上記PR#72コミットのログ参照。
  - recraft-v4-1 は `background_color="#000000"` パラメータで確実に黒背景指定可能（代替モデル）。ただし近黒(lum≈25)で完全黒ではない。
  - **最確実**: nano_banana_pro 生成後に PIL flood-fill 処理（既存デザイン保持）。

### 2026-06-15（PR#68・`claude/sprite-thruster-fix-20260615`）— スプライト screen合成復活 + 停止中スラスター修正
- **背景**: PR#65で「プレイヤー船体スプライトブロックを全削除してCanvasのみ」という修正を行ったが、ユーザーからのフィードバックは「前のクソダサデザインに戻っちゃったんだけど。機体のデザインはhiggsfieldでやり直し、スラスターはもとに戻せ」。
  - PR#65の解釈が間違いだった。正しい意図は「**Higgsfieldスプライトは残す（hull描画用）**、スラスターだけ元のCanvasグラデーションに戻せ」。
- **PR#68で実装した内容**:
  - **スプライト screen合成モード**: プレイヤー艦スプライトブロックを復元。`lighter`→`screen`に変更（`screen`の数式: `1-(1-src)(1-dst)`, 黒→透明, hull色は正常表示, 過飽和なし）
  - **スラスター速度ゲーティング**: 全艦種（assault/stealth/carrier）のスラスター描画を `state === 'moving'` でガード（停止中スラスター常時発光バグを修正）
  - **`drawThrusterParticles`削除**: PR#65で追加したパーティクルシステムを削除。元のCanvas放射グラデーション（`drawThruster`ヘルパー関数）を維持
  - `?v=20260615e`。PR#68マージ済み。
- **`screen` vs `lighter` の決着**（今後のスプライト追加時に参照）:
  - `lighter` = 加算合成 `src*alpha + dst`。暗いhull(0.2)×alpha(0.55)+bg(0.05)≈0.16 **→ ほぼ不可視（NG）**
  - `screen` = `1-(1-src)(1-dst)`。黒背景(0.05)×hull(0.2) → `1-0.95×0.8=0.24` **→ hull見える（OK）**。完全黒(0)は完全透明。加算合成の発光も適度に表現。
  - **結論**: 黒背景スプライトに `screen+globalAlpha=0.9` が最適。`lighter` は明るい発光エフェクト限定。
- **申し送り**: 船体スプライト全面再生成は PR#71+72 で完了（上記エントリ参照）。

### 2026-06-15（PR#63→65）— 船体スプライト視点修正・透明バグ修正・Canvas粒子スラスター復元
- **PR#63（真上視点再生成）**: 「空母がアイソメ・デザインが現実の軍艦寄り」の指摘受け、7種を真上90度正射影・SF宇宙潜水艦デザインで再生成。`globalAlpha=0.55`追加（→これが透明バグを悪化させた）。
- **PR#65（根本修正）**: 「透けてる・スラスター白四角・エンジン演出欲しい」の再フィードバックで根本原因を特定・修正。
  - **透明バグ原因**: `lighter`ブレンドは`src+dst`の加算。暗いhull(0.2)×alpha(0.55)+bg(0.05)=0.16でほぼ不可視
  - **修正**: プレイヤー船体スプライトブロック全削除 → 元のCanvas描画を常時使用
  - **スラスター**: `fx_thruster_jet`スプライト廃止 → `drawThrusterParticles()`で細かい丸粒子描画
  - **エンジン別演出**: thermonuclear=橙白12粒子広め / pulse=青紫9粒子バースト点滅 / higgs=暗紫5粒子ほぼ不可視 / photon=白青15粒子タイト
  - **敵スプライト**: `lighter+0.55` → `screen+0.92`（screenはblack=背景と同化、hull正常表示、過飽和なし）
  - `ENGINE_THRUST`にHex定数`p1/p2`追加（GC抑制: ループ内rgba文字列生成を廃止）
- **⚠️ 申し送り**:
  - `enemy_corvette`は旧スプライトのまま（Higgsfield承認問題で再生成できず。次セッションで可能、settings.local.jsonに承認済み）
  - 敵スプライト（destroyer/carrier/fighter）はscreen+0.92で描画 → 実機で暗すぎ/明るすぎなら`globalAlpha`調整
  - 船体スプライトは「photorealistic touchは良かった」評価あり。**PR#68で`screen`モードによる復活実装済み**（詳細は上記PR#68エントリ参照）

### 2026-06-15（PR#61・`claude/continuation-vm5eu3`）— フォトリアルスプライト全面刷新 + モバイルアイコン化
- **背景**: 前セッション（PR#60 モバイルアクションバー）のスクショに「戦艦デザインをフォトリアルでかっこよく / UIアイコン生成 / 爆発も画像で / lighter合成追加」の引き継ぎが記録されていた。HANDOVER.mdへのプロンプト記録はコミットされていなかったため、プロンプトを独自に再設計して実施。
- **船体7種フォトリアルリデザイン**（nano_banana_pro, 1k, black bg, top-down, bow=+x）:
  - 自機3種: `ship_assault`（重装甲バトルクルーザー・三連砲塔・シアン噴射）/ `ship_stealth`（超低シルエット・電波吸収フェイセット・紫噴射）/ `ship_carrier`（広幅甲板・両舷ベイドア・6スラスター）
  - 敵4種: `enemy_corvette`（スイープバック・橙赤噴射）/ `enemy_destroyer`（多連装砲台・橙アレイ）/ `enemy_carrier`（巨大矩形・赤橙エンジン）/ `enemy_fighter`（三角デルタ翼・単エンジン赤）
- **爆発エフェクト2種刷新**: `fx_explosion_big`（白橙コア＋衝撃波リング）/ `fx_explosion_small`（白青プラズマ＋炎ジェット）
- **UIアイコン6種新規**: `icon_scan`（シアン同心波）/ `icon_ew`（琥珀雷光）/ `icon_nav`（青コンパス）/ `icon_drone`（緑編隊）/ `icon_sup`（ティール十字）/ `icon_atk`（赤クロスヘア）
- **game.js**: 自機・敵船体スプライトに `globalCompositeOperation='lighter'` 追加（黒背景透明化・発光部浮き上がり）。`SPRITE_FILES`にアイコン6種追加。
- **index.html**: `#abar` 各ボタンのSVGを `<img class="abar-icon">` PNGに置換。`?v=20260615b`。
- **style.css**: `.abar-icon { 26px; object-fit: contain }` 追加。
- **⚠️ 申し送り**: `lighter`合成で船体の中間グレー部分が浮き上がりすぎる可能性あり（実機確認要）。調整が必要な場合は `globalAlpha` で強度調節 or `source-over` に戻す。アイコン画像は26×26pxで表示 — ボタンサイズに対して大小調整は実機確認後。

### 2026-06-14（深夜⑥）— Higgsfield ビジュアルエフェクト Phase2（PR#58・`claude/higgsfield-visual-effects-nhbaey`）
- **Phase1（PR#57、前セッションでマージ済み）**: `fx_explosion_big/small`, `fx_kinetic_flash`, `fx_beam_impact`, `fx_thruster_jet`, `fx_missile_exhaust` の6スプライトを生成・適用。
- **Phase2（本セッション・PR#58）**: さらに12スプライトを Higgsfield nano_banana_pro で生成し適用。
  - **ドローン6種**: `drone_attack`, `drone_scout`, `drone_decoy`, `drone_missile`, `drone_turret`, `drone_buoy`
  - **弾体**: `fx_bolt_player`（cyan-green）/ `fx_bolt_enemy`（red-orange）
  - **ステルスデコイ**: `fx_decoy`（EMジャマー外観）
  - **センサー粒子**: `particle_heat`（橙）/ `particle_optic`（黄白）/ `particle_higgs`（シアン青）
- **コード変更**:
  - `Drone.draw()`: 全5展開可能タイプ（attack/scout/decoy/build/buoy）を `'lighter'` 加算合成スプライト描画に変更。barrier/higgs はキャンバスフォールバック継続。
  - `drawDecoys()`: ステルスデコイを `fx_decoy.png` スプライト（加算合成）＋EMパルスリングに変更。
  - `drawPassiveAntenna()`: HEAT/OPTIC/HIGGS センサーtrailの `ctx.arc()` → 粒子スプライト描画へ置換。`globalCompositeOperation='lighter'` をループ外に1回設定（per-particle save/restore を廃止し描画コスト低減）。
  - `shadowBlur` 違反2箇所（EMフラッシュ / HIGGSノード）をアルファ重ね描きで代替（モバイルGPU規則遵守）。
- **加算合成ブラックバック方式**: 黒背景スプライトを `'lighter'` で描くと黒が透明になるため、背景除去不要。全スプライトに一貫適用。
- `?v=20260614m`。PR#58マージ済み。

### 2026-06-14（深夜⑤）— Higgsfield ビジュアルエフェクト Phase1 洗い出し→生成→実装（PR#57・`claude/higgsfield-visual-effects-nhbaey`）
- **依頼**: 「higgsfieldでnanobananapro使って攻撃/爆発/ジェット/ビジュアル面をブラッシュアップ」
- **洗い出し**: game.js全体で置き換え可能な視覚要素を棚卸し。FXエフェクト・ドローン・デコイ・センサー粒子・弾体・岩礁スポーン・熱雲Blob・ミサイル/ビーム本体 など18カテゴリを列挙。
- **Phase1スプライト生成**: `fx_explosion_big`, `fx_explosion_small`, `fx_kinetic_flash`, `fx_beam_impact`, `fx_thruster_jet`, `fx_missile_exhaust`（6種）
- **接続方針確立**: black bg + `globalCompositeOperation='lighter'` でPNG背景除去不要。`spriteReady(img)` ガード＋キャンバスフォールバック必須。
- **禁止語対策**: warship/missile/weapon → spaceship/cruiser/module/energy bolt で代替プロンプト。
- **実装ポイント**:
  - `effects[]` に `'fx-sprite'` タイプ追加（`updateDrawEffects`で加算合成展開フェード）
  - 爆発にスプライトオーバーレイ追加（`createExplosion`/`Projectile.update`）
  - スラスターを自機スプライト描画直前にオーバーレイ（`player.draw()`）
  - ミサイル弾体を `drone_missile.png` スプライトに（既存排気スプライトと共存）
  - キネティック弾を矩形→`fx_bolt_player/enemy.png` スプライトに
- PR#57マージ済み。`?v=20260614l`。

### 2026-06-14（深夜④）— §3-13 Phase3 熱雲(HEAT地形)実装（PR#55・`claude/reading-markdown-files-nm1nmj`）
- **熱雲**: `thermalField[]`(7ブロブ) + `getThermalIntensity()`(フレームキャッシュ+量子化) + `thermalCanvas`(768px、赤橙ベイク)。
- **効果**: `THERMAL_HEAT_MASK=0.60` → 熱雲内heatSig低減（HEATセンサーから隠れやすい）。`THERMAL_HEAT_MOD=0.80` → 敵HEAT探知経路減衰。
- **UI**: env-thermal/msb-thermal (橙色%表示) + ミニマップ赤橙オーバーレイ。`?v=20260614j`。
- **地形3種の対称性完成**: デブリ=OPTIC / 磁気嵐=EM / 熱雲=HEAT。
- **⚠️ 申し送り**: 全壁打ちタスク実装完了。残: 4種目地形(任意) / アクティブソナー嵐劣化(任意) / 実機30fps計測(未実施)。

### 2026-06-14（深夜③）— §3-1 アップグレードツリー再整合（PR#53・`claude/reading-markdown-files-nm1nmj`）
- **エンジン Lv1-3**: 旧「速度倍率」→ ヒッグス/デブリ減速軽減(20/35/50%) + heatSig低下(10/20/30%)
- **武装 Lv1-3**: 旧「ダメージ倍率」→ 射程×(1.15/1.30/1.50) + リロード×(0.85/0.70/0.55)
- **装甲 Lv1-3**: 旧「HP倍率」→ kinetic25%(Lv1) / +missile25%(Lv2) / +beam25%(Lv3) 武器種別耐性
- **センサー**: 変更なし（ソナー範囲×UPGRADE_MULT）
- 新定数: `ENGINE_UPG_HIGGS_RESIST/HEAT_REDUCE`, `WEAPONS_UPG_RANGE/RELOAD_MULT`, `ARMOR_RES_KINETIC/MISSILE/BEAM`
- HTML更新: アップグレードパネル説明文。`?v=20260614i`。
- **⚠️ 申し送り**: 残タスクは §3-13 Phase3（熱雲）のみ。実機30fps計測後に判断。その他は全タスク完了。

### 2026-06-14（深夜②）— §3-12 全センサーtrail一般化（PR#52・`claude/reading-markdown-files-nm1nmj`）
- **§3-12 HEAT/OPTIC/EM trail**: `heatTrails[]`/`opticTrails[]`/`emTrails[]`を追加（`higgsWakes`と同パターン）。
  - 源泉: 実弾→optic、ミサイル→heat+em+optic、ビーム→optic+em、プレイヤー移動→heat+em、敵Ship移動→heat+em。
  - センサー切替で色分け表示: HEAT=橙(255,120,20) / OPTIC=黄白(255,230,80) / EM=紫(180,80,255)。
  - 上限600エントリ、decay率: heat=0.004 / em=0.005 / optic=0.006。`shadowBlur`不使用。
  - `drawPassiveAntenna`内のEM/HIGGSブロックに他センサー分を追加。
- PR#52マージ済。`?v=20260614h`。
- **⚠️ 申し送り**: §3-1アップグレードツリー再整合は要オーナー決定（現`armor`を残すか設計ツリーへ寄せるか）。§3-13 Phase3（熱雲）は実機30fps計測後に判断。

### 2026-06-14（深夜）— 残機能3件実装（PR#51・`claude/reading-markdown-files-nm1nmj`）
- **§3-7 建設物3種（空母carrier専用）**: D-BAR(ビームバリア)/D-BUY(センサーブイ)/D-HGS(ヒッグス散布装置)。`DRONE_BUILDING_LIFE=7200`(2分)。Drone classを拡張し7タイプ対応に。
- **§3-10 ミサイル2タイプ**: `missileMode='homing'|'smart'`。MSL:HON/AIボタン(全艦種)。AI型はデコイ耐性(`aiPrec*0.9`確率)+着弾大閃光+射程2200。
- **§3-9 修復ドローン**: `repairActive`フラグ+REGENボタン(全艦種)。完全停止+HP回復(1.2/frame)+シグネチャ増大(×2.4)+緑パルスリング描画。
- `?v=20260614g`。**実機未検証**。
- **⚠️ 申し送り**: 建設物の「建設中艦停止＝最大脆弱」フローは未実装（現状は即時設置）。ジャミング(JAM系)へのAI型ミサイル耐性は未実装。アップグレードツリー再整合(§3-1)は要オーナー決定が必要。Phase3地形ハザード(熱雲)は実機30fps計測後に判断。

### 2026-06-14（夜）— マップ4層構造の仕様化＋ヒッグス視界 Phase1 実装（PR#43・`claude/higgs-terrain-layers-7c23xf`）
- **壁打ち**: ヒッグスのビジュアル改良。マップを4層（背景／メインフィールド／地形ハザード／ヒッグス）で表現し、ヒッグス以外にセンサー別地形（デブリ/磁気嵐/熱雲）を追加する構想。CLAUDE.mdに4層構造を確定記録、TODO §3-13に高解像度で台帳化。
- **オーナー決定**: 地形ハザードは**まずデブリ＋磁気嵐の2種で実装→実機30fps計測→熱雲/4種目を判断**の段階導入。デブリの呼称はHUD=`DEBRIS`／フレーバー=岩礁帯。
- **Phase1 実装（本ブランチ）**:
  1. **ヒッグス雲の見上げ表現（§3-13 B）**: 白い雲を事前焼き付け（`higgsCloudCanvas` 768px、濃度連動の白さ）→ `drawFogOfWar`で**視野アメーバにクリップして`'lighter'`合成**。濃密部=真っ白／疎部=青空透け。自機濃度の%表示は既存（`env-higgs`）と確認。
  2. **離れた濃いポイントの視界バランス（§3-13 C）**: `updateVisionLockOn`で**ターゲット地点の濃度ゲート**を追加。`clarity=1-clamp((hTarget-0.22)/0.55)`、`>=0.85`=完全ロック／未満は`inVision=false`で想定ロック止まり＋`contactAccuracy`を直接キャップ（0.45..0.87、濃密潜伏0.25）。既存の`_fullLock=!!inVision`経路を再利用＝ダメージデバフ/beam長射程ジッターが自動適用。定数`HIGGS_CLEAR_BELOW/SPAN`はtunable。
- **設計意図**: 「ヒッグスの影響を受ける主体が自機だけ」問題の解消。薄い所に居て視界が広くても、濃い雲ポケットに隠れた敵はクリーンに撃てない。
- **⚠️ 申し送り**: 実機未検証（コンテナにブラウザ無し、`node --check`のみ通過）。GitHub Pagesで①視野内の雲の白飛び具合②`'lighter'`合成のモバイル負荷（クリップ+768px drawImage 1枚追加）③ゲートのバランス（敵が雲に隠れた時の手応え）を要確認。全てtunable定数。次は Phase2（デブリ帯+磁気嵐帯）。

#### 空母型ドローン4種（新ブランチ `claude/carrier-drones-…`・§3-6）
- `Drone`クラス＋`playerDrones[]`＋`deployDrone()`/`updatePlayerDrones()`/`drawPlayerDrones()`。carrier専用の4ボタン`.drone-btn`（D-ATK/D-DCY/D-SCT/D-BLD、`startGame`で表示制御）。
- 攻撃=可視敵を自動追尾しkinetic(dmg×0.5) / デコイ=ミサイル誘引(missile homingに`playerDrones`のdecoyを追加) / 哨戒=`DRONE_SCOUT_RANGE`内の敵に`applyContact`(センサー前進) / 建設=固定タレット(自動射撃 dmg×0.6・§3-7最小実装)。
- 上限`CARGO_CAP.carrier=6`、`DRONE_LIFE=2400`(40秒)。`generateSector`で`playerDrones`/`decoys`リセット。`?v=20260614f`。
- **残**: ドローンの被弾/撃墜・ドローンのシグネチャを敵探知へ反映・§3-7正式建設フロー。

#### マップモード（新ブランチ `claude/map-mode-…`）
- **ミニマップのタップ**で全画面マップに切替（`toggleMapMode`）。ドラッグはカメラパン（移動量で判別）。
- 実装: `mapMode`フラグ。`enterMapMode`=現カメラ保存→追従OFF→ズームをマップ全体にフィット→マップ中心へ。`exitMapMode`=カメラ復元。
- マップモード中は`drawFogOfWar`をスキップ＝**索敵済みの戦術マップ**（未検知の敵は`visible=false`で非表示、検知済みコンタクトは痕跡として表示）。
- **通常操作がそのまま使える**: タッチ系は全てワールド座標で動くため、長押し=航路設定/ドラッグ=パン/ピンチ=ズーム/敵タップ=ロックが全画面マップ上でそのまま機能。
- バナー`#map-mode-banner`表示。追従ボタンを押すとマップモード解除。`generateSector`でリセット。`?v=20260614e`。

#### センサー表示＆シグネチャ改善（新ブランチ `claude/sensor-display-sig-…`）
実機フィードバック6点を実装:
1. **自機シグネチャ再設計**: 旧式は熱が一瞬で上限張り付き＆ゲイン非反映だった。「推進排気強度 `_thrust`=正規化速度+エンジン配分+ゲイン」を統一指標化し、各シグネチャ=`_thrust×エンジン種別倍率`に。熱核→熱/パルス→EM/フォトン→光学/ヒッグス→ヒッグスが移動で支配的に動く。ゲインで全体増減。
2. **レーダー範囲をAI解析連動**: `effectiveRadarRange=(500+aiPrec('sensor')*1950)*(1-higgs*0.55)`。AI解析最大で≈2450(ミサイル2200+α)。
3. **地形濃度表示**: モバイルステータスバーに `岩:% / 嵐:%`(`msb-debris`/`msb-storm`)追加。左パネルにも既存。
4. **自機マーカー自動非表示**: `camera.zoom*radius*5.6`(艦の画面径)が36px未満の時のみ緑三角を表示(28-36pxでフェード)。拡大すると消え縮小で再表示。
5. **センサー痕跡をヒッグス手前に**: 痕跡描画(不確実性サークル+§3-3候補)を`Ship.draw`から`Ship.drawSensorTrace()`へ分離し、`drawFogOfWar`の後に描画。ワールド座標スケール対応(`/camera.zoom`)。
6. **コンタクトをミニマップ表示**: 完全ロック=実位置(赤)/センサー痕跡=推定位置を精度色で。
- `?v=20260614d`。**マップモード(ミニマップタップで全画面マップ)は次PR**。

#### §3-2 AI精度スライダー（新ブランチ `claude/ai-precision-…`）
- `aiPrecision={sensor,weapon,engine}` ゼロサム3スライダー（GEN同方式UI、AI出力スライダーの下に配置）。`aiPrec(key)=(genAlloc.ai/100)*(aiPrecision[key]/100)`。
- 効果: 解析→`applyContact`精度ブースト(`AI_SENSOR_ACC`) / 命中→自機弾デブリミス率低減(`AI_WEAPON_AIM`) / 回避→敵弾を確率回避(`AI_ENGINE_DODGE`)。トレードオフはEM放射↑(既存`playerEmBoost`)。
- 候補表示§3-3はコンタクト精度経由で自動連動（解析配分↑→候補が絞れる）。数値はtunable。
- **運用変更**: 以後は機能ごとに**新ブランチ＋新PR**（マージ競合の再発防止）。

#### 🔴 反映漏れの根本原因と恒久対策（重要）
オーナーが「修正がずっと反映されない／背景がボケたまま」と繰り返し報告 → 原因は2つ:
1. **ブラウザ/GitHub Pagesキャッシュ**: `index.html` が `game.js` をバージョン無しで読み込んでいたため、main更新後もブラウザが**旧game.jsをキャッシュ**し続けた。→ `?v=YYYYMMDD?` クエリ付与＋`<head>`にno-cacheメタ追加。**game.js/style.css変更時は必ず`?v=`更新**（CLAUDE.mdに明記）。
2. **マージ後の同一ブランチへの push**: オーナーが #44 を早期マージ→その後の Phase2/§3-3 コミットを閉じた#44のブランチに積み続け、どのPRにも入らず未反映だった（#43でも同じ）。→ **マージ後の追加は新PR番号**、**PRは非Draft**、**`git log origin/main..HEAD`で未マージ確認してから「反映済み」と言う**、をCLAUDE.mdに恒久ルール化。
- **背景ボケ仕上げ**: 巨星に続き**焼き込み小星(6000+1800+200個)も廃止**（68倍拡大でボケる主因）。spaceBgCanvasは暗いグラデのみ、星は鮮明パララックス層`_drawStarfield`に一本化（密度を90/52/22へ増）。

#### §3-3 AIロックオン候補表示（同ブランチ・PR#44→#45で反映）
- `makeContactCandidates(acc)`: コンタクト精度から確率%付き候補群 `{dx,dy,p}` を生成（候補数=2+(1-acc)*4、分散=(1-acc)*360、本命=index0が支配的）。
- 描画: `Ship.draw` のコンタクト描画ブロックで `contactAccuracy<0.7` の非視野コンタクトに候補ダイヤモンド+%を表示。`_candAcc`で精度変化時のみ再生成（揺れ防止）。完全ロックでは非表示。
- 信頼度は既存 `contactAccuracy` を流用（§3-2 AI精度スライダー導入時に連動可）。バランスを変えない追加的UI（auto-targetは従来通り実体を狙う）。

#### Phase2 実装 — 地形ハザード2種（デブリ帯+磁気嵐帯）（同ブランチ・PR#44）
TODO §3-13 D を段階導入の方針通り2種だけ実装:
- **フィールド/描画**: `debrisField[]`(10) / `stormField[]`(6)。`getDebrisIntensity`/`getStormIntensity`(getHiggs同方式=フレームキャッシュ+500量子化)。`generateSector`の setTimeout 内で `debrisCanvas`(岩片点描・灰)/`stormCanvas`(紫青EMノイズ)をベイク。`drawBackground`で bgMist の後に描画(嵐は明滅)。
- **デブリ効果**: `Ship.terrainSpeedMult()` で移動減速(自機/敵共通、自機のみAI配分で最大70%軽減=逃げ込み戦術)／実弾・ミサイルのミス率↑(`DEBRIS_MISS`、ビームは即着弾でこの判定を通らない=貫通)／敵の光学探知を経路減衰(`DEBRIS_OPTIC_MOD`)。
- **磁気嵐効果**: 嵐内機体のEMシグネチャ低減(`STORM_EM_MASK`=AIを安全に回せる退避所)／敵のEM探知を経路減衰(`STORM_EM_MOD`)。
- **UI**: 左パネルに `岩礁:xx% / EM嵐:xx%`(`env-debris`/`env-storm`)。
- **創発**: デブリ帯=ビーム有利／ヒッグス帯=実弾有利、のじゃんけん。磁気嵐=AI退避所(EM∝AI法則の例外)。
- **Phase2仕上げ（同コミット群）**: 敵側デブリAI軽減(`DEBRIS_ENEMY_MITIGATE=0.35`で全停止防止)／磁気嵐内ミサイル誘導劣化(`STORM_MISSILE_DEGRADE`で旋回精度↓)／ミニマップにデブリ(灰)・嵐(紫)オーバーレイ。
- **⚠️ 申し送り**: 実機未検証。要確認=①地形3種重畳時の30fps維持(getHiggs/getDebris/getStorm が毎フレーム複数回)②デブリ減速+ミス率の手応え③嵐EMマスクの強さ。全数値tunable。残=熱雲/4種目(Phase3・実機計測ゲート)・デブリOPTIC専任化判断・アクティブソナーの嵐劣化。

#### 実機フィードバック反映（同ブランチ・追撃修正）
オーナーが実機スクショで指摘した問題を修正:
1. **ゲームリングがヒッグスに隠れる→最前面化**: 描画順を「エンティティ→`drawFogOfWar`→スレットリング(`drawPassiveAntenna`)→RADARリング→武器射程リング→方位ウェッジ」に並べ替え。従来 `drawPassiveAntenna`(5169)とRADARリングが fog より**前**に描画され雲に埋もれていた（"索敵・射撃ができずゲームにならない"）。
2. **Phase1の白い雲が強すぎ(H:1%でも画面が真っ白)**: `'lighter'`合成のalpha 0.85→0.5、白さ`coreA`上限 0.72→0.55に抑制。
3. **タッチ: スワイプがウェイポイント誤設定**: `TOUCH_WAYPOINT_DELAY` 250→400ms、`TOUCH_MOVE_THRESHOLD` 12→10px。さらに**長押し進捗リング**を`drawHUDOverlay`に追加（指を止めている間だけ充填、スワイプで即消える＝視覚フィードバック）。
4. **ミニマップ(レーダー)のボケ**: ミニマップだけ DPR 未適用だった。`minimapDpr`を導入しバッキングストアを DPR 倍化、`drawMinimap`を`setTransform`でCSS px基準描画に、クリック/タッチ座標変換も CSS px へ補正。
5. **確認した非バグ**: 自機SIGオシロ(`sig-canvas`)は `player.heatSig/opticalSig/emSig/higgsSig`(Ship.update 1369-1372で計算)を表示し**機能している**。停止中は heat/optic/higgs=0・em=GEN配分の定数のため平坦に見えるだけ（移動・発砲・AI配分変更で振れる）。ヒッグス濃度表示は mobile status barの「H:」＝`msb-higgs`／左パネル「Higgs:」＝`env-higgs`（既存）。
6. **背景の巨星ボケ → 鮮明パララックス層へ分離**: 巨星ハローは`spaceBgCanvas`(1024px)を約68倍拡大していたためボケていた。焼き込みを廃し、`_giantStarTile`(1400px・透過)に鮮明生成 → `_drawGiantStars()`でスクリーン空間パララックス(pf=0.035・最遠景)描画。星雲(`_drawNebula`)/星(`_drawStarfield`)と同方式。`generateSpaceBackground`でタイルをreset、`drawBackground`で nebula→巨星→starfield の順に重ねる。
- **残(任意)**: `spaceBgCanvas`内の小星(dim/medium/bright)も68倍拡大でボケるが、`_drawStarfield`の鮮明パララックス星が上に乗るため実害小。気になれば焼き込み廃止も可。

### 2026-06-14（後半）— ブランチ統一・4機能実装（PR#40, #41 マージ済み）

**ブランチ分岐の解消（PR#40 / #39クローズ）**
- 朝の統合作業中、開発枝 `claude/t01-…` が **PR#35〜#38を欠く取り残し枝**で、PR#34は実は**マージ済み**だったと判明（旧CLAUDE.mdの"未マージDraft"表記が誤り）。
- さらに**別セッション**（`claude-md-todos-u6cxld`）が並行して #39 を作成し、両者がTODO.md/game.jsを編集して衝突する状態だった。
- **対処**: 現mainから切り直した `docs-consolidation-3files` に統合（PR#40, マージ済み）。#39の機能コミット（想定ロックオンデバフ・ノード/構造物スプライト）は cherry-pick で取り込み、#39はクローズ。**今後の開発はこのセッション系統に一本化**（並行セッションの同時編集が分岐の根本原因）。

**4機能を実装（PR#41, マージ済み — `claude/impl-assumed-lock-jamming-k3p9`）** TODO §5を上から消化:
1. **想定ロックオン完成（§2-1）**: beam長射程狙撃（想定ロック時`wRange→8000`＝マップ端スナイプ）/ 命中ジッター（精度低で外れ・無害ビーム＝自位置のみ露出）/ レティクル色分け（完全=緑実線・想定=琥珀破線ブラケット）@`game.js` 自機発射ブロック・Ship.draw
2. **敵AI適応戦略 `predictedBehavior`（§2-2）**: 全知禁止のまま**検知した支配的シグネチャ**から行動推定→適応。収集(EM+ノード近接)→ノード先回り / チャージ(熱+EM・光学弱)→側方ストレイフ回避 / 実弾(光学支配)→カイト＋武器を長射程へ / 無反応→潜伏。検知ループ(`domSig`)＋combat移動分岐
3. **潜航型ジャミング3種（§3-4）**: `jamBurst`(範囲3500/60%/6s) / `jamCont`(継続EM 2400/35%) / `jamPulse`(6000/全ブラインド/CD20s)。敵`myDetectRange*(1-jamDegrade)`で劣化。発動中は自`emSig`増＝逆探知（情報↔露出）
4. **潜航型デコイ射出（§3-5）**: `decoys[]`、敵ミサイルが半径`DECOY_LURE_RADIUS=1600`内のデコイを優先追尾→到達で無害化。同時上限=積載量

**積載量 cargo 確定（§3-8, オーナー決定）**: `CARGO_CAP = { assault:2, stealth:3, carrier:6 }`（同時展開上限・tunable）。

**UI**: 潜航型選択時のみ JAM / EM-J / PULSE / DECOY の4ボタン表示（`.jam-btn`、`startGame`で制御。他艦種は無変化）。

**⚠️ 申し送り**:
- **実機未検証**: 環境にブラウザ無し。`node --check`のみ通過。**マージ後 GitHub Pages でバランス確認が必要**（敵の回避運動・beam長射程の強さ・ジャミング数値・潜航型UIの4ボタンがモバイルで収まるか）。数値は全てtunable定数。
- **次の大物 = 空母型ドローン4種＋建設物4種（§3-6/§3-7）**。積載量は**空母=6で確定済み**なので即着手可。建設物は建設中に空母停止＝最大脆弱、という設計に注意。スプライト未生成（砲台/ビームバリア/センサーブイ/ヒッグス散布）。
- 開発は**現mainから新ブランチを切る**こと（分岐再発防止）。

### 2026-06-14 — MD類の統合再編・実装状況のコード検証
- **動機**: 壁打ち（企画会議）で決めた仕様が、セッション切替で忠実に再現されず実装が抜け落ちる問題。
  MD類（CLAUDE/HANDOVER/MEMORY/game_design_v2/game_requirements/LESSONS_LEARNED の6本）が散在し、
  「実装済み／未実装」が判別不能だった。
- **実施**:
  1. 全6 MDを精読 → **3本に集約**: `CLAUDE.md`（概要・確定仕様）/ `HANDOVER.md`（本書）/ **`TODO.md`（新規・実装台帳）**
  2. `game.js` を全機能シンボル検証（初版は旧4800行コードで→**後述のブランチ齟齬発覚後 `origin/main` の5050行で再検証**）し、実装状況を実物ベースで確定
  3. 旧 `MEMORY.md` / `game_design_v2.md` / `game_requirements.md` / `LESSONS_LEARNED.md` を内容統合のうえ廃止
- **コード検証で判明した重大なドキュメントずれ**（"壁打ちが実行されてない"と感じる主因）:
  - 旧優先度リストで「未実装」とされた **#2（自動ロックオン+攻撃ON/OFF+射程サークル）/ #3（マガジン・リロード+GEN発射レート）は実は実装済み**
  - 他に **スレットリング方角 / ビームダークチャネル / ヒッグス自然成長 / EM∝AI / 先制攻撃2x / 想定コンタクト表示** も実装済みだった
  - 本当に未実装: 潜航型ジャミング・デコイ / 空母型ドローン4種・建設物4種 / 積載量 / AI精度スライダー / AIロックオン候補 / 修復ドローン / ミサイル2タイプ / 想定ロックオン射撃
- **⚠️ ブランチ齟齬の発覚と立て直し**: 作業中の `claude/t01-implementation-start-dauj7q` 枝が、
  別セッションがmainへマージした **PR #35〜#38 を欠いた状態**であることが判明。
  - PR #34 は既に**マージ済み**（旧CLAUDE.mdの"未マージDraft"表記は誤り）。t01枝はその後の取り残し枝
  - #35=方位ウェッジ+予測敵AI / #36=艦種シルエット+噴射色 / #37=スプライト+DPR / #38=星雲パララックス
  - 初版TODO.mdは古いt01コードで検証したため**方位ウェッジ/噴射色/予測敵AIを誤って未実装判定**していた → main基準で補正
  - **立て直し**: 現 main から新ブランチを切り直し、ドキュメント3点のみを最新コードベースに統合し直して新規Draft PR化（重複アセットコミットは破棄）
- **設計コンフリクト解決**（新しい方を採用）: マップ=円形`MAP_RADIUS=35000`（旧8000/50000を無効化）、勝利条件=2モード制、ドローン=`fighter`型Ship（TalosDrone廃止）。詳細は `TODO.md` §0

### 2026-06-13 — T01有視界システム + 生成スプライト表示（PR#34 — マージ済み）
- **ブランチ**: `claude/t01-implementation-start-dauj7q`
- **T01 有視界システム**（優先度#1完了）:
  - `computeVisionRadius()` @`game.js:201` をヒッグス濃度連動の実計算に（0%=基準1200, 100%でも最低5%視野=`MIN_VISION_FACTOR`）
  - 以前は `FIELD_SIZE` 返し＋`drawFogOfWar`コメントアウトで**無効化**（全敵が常時フルロックオン状態）→ 復活
  - `updateVisionLockOn()` 冒頭で視野半径を毎フレーム更新／`shadowBlur`→`globalAlpha`二重ストロークに置換
- **生成スプライト表示システム** — `SPRITES` 非同期ローダー（`game.js:198`付近）:
  - `assets/*.png` を読み込み、未ロード/欠如時は**既存ベクター描画にフォールバック**
  - 自機 `SPRITES['ship_'+shipType]`（assault/stealth/carrier）@`game.js:1899` / 敵 `SPRITES['enemy_'+type]` @`game.js:2128`（発砲フラッシュは放射グラデ赤グロー）/ 建造物 `SPRITES['structure_'+type]` @`game.js:893`（ハック時lighter合成で青ティント）/ ノード `node_higgs` brightness変調
  - **規約**: スプライトは俯瞰・**艦首+X（右向き）**で生成（`ctx.rotate(this.angle)`と一致）
- **残課題**: ⚠️実機スクショ検証は未実施（コンテナにヘッドレスブラウザ無し）。GitHub Pages反映後、表示サイズ係数（自機`vr*2.35`/敵`r*2.8`/建造物`_sw`）を実機で微調整要

### 2026-06-13 — セッション復旧・ゲームデザイン方針（"索敵が運ゲー"提起）
- 前セッションが `Prompt is too long`（トークン上限）でクラッシュ。会話ターン数でなく**ツール結果・差分の蓄積**が原因
- 失われたUI/ビジュアル改修は `claude/continue-handover-fix-v04Vg` にpush済→**PR#31**化
- **GitHubトークン手動発行は不要**（Webセッションは GitHub MCP 組込み）。旧PAT(`GH_TOKEN`)は失効
- **"索敵が運ゲー"問題の提起と提案**（パッシブ方位ウェッジ等）→ 現在は `TODO.md` §3-12 に詳細記録

---

## アセット生成パイプライン（再現手順）

- Higgsfield MCP `generate_image`（model=`nano_banana_pro`, 1:1, 2k）でトップダウン生成
- **武器ワード（warship/missile/weapon等）は検閲で失敗** → spaceship/cruiser/turret module 等に言い換え
- 背景透過: 当初MCP `remove_background`、途中から**承認ゲートで不可**に → ローカルPIL+scipy代替
  - **境界フラッドフィル方式**: 端から連結した背景画素のみ透過（黒背景×黒艦体の誤消去を防止、内部暗部を保護）
  - 背景色は4辺リングのmedianで自動検出（黒/白両対応）→ トリミング → 512px最適化
- **未生成**: 空母型建設物4種（砲台/ビームバリア/センサーブイ/ヒッグス散布）、武器エフェクト（ミサイル/ビーム/着弾）
- アートワーク方針の詳細・確定アセット（攻撃型バトルシップ）は `TODO.md` §4-3

---

## 決定ログ

| 決定事項 | 内容 |
|---|---|
| タイトル変遷 | Dark Current → Dark Signal → **Dark Echo**（最終）。リポジトリ名は `Dark-Higgs` |
| 物質名 | エレボス → **ヒッグス**に全面リネーム済 |
| プラットフォーム | Unity候補 → 「まずWebで」に方針転換（Web=HTML5 Canvas 2D / Vanilla JS） |
| 勝利条件 | 「敵撃破のみ」→ **2モード制（BR殲滅 / S&Dコロニーハック）** に拡張 |
| マップ | 8000→50000の記述があったが、現行は**円形`MAP_RADIUS=35000`（直径70000）** |
| ドローン実装 | `TalosDrone`クラス構想 → **`fighter`型`Ship`で代用**（TALOS出撃50CRは廃止） |
| コンソール位置 | 画面下部にまとめる（上部フィールド確保、Homeworld2スタイル） |
| マネタイズ | 無料+広告+広告削除課金（500SCR）— 後検討 |
| Git | GitHub repo: s1-1985/Dark-Higgs。`claude/`ブランチ運用、main直接push不可 |

---

## パフォーマンス & エンジニアリング教訓

> モバイルブラウザゲーム開発で発生したインシデントと再発防止策。**コード変更前に必読**。

### インシデント史（要点）
- **A: mainへの直接push** — ブランチ名確認を怠り main に直接コミット。diverge発生→強制マージで解決。
  教訓: 必ず `git branch` で `claude/` プレフィックスを確認してからpush
- **B: bgMistCanvas 起動10秒フリーズ（PR#20）** — `4096×4096`Canvas（=64MB）に200個のradialGradientを同期描画。
  `512×512`に縮小で解決。教訓: PC基準でCanvas解像度を決めない
- **パフォーマンス地獄（PR#17-19）** — 実測なしの当て推量パッチを5-6回繰り返し効果薄・コード複雑化。
  FPS計測導入後（PR#20-23）に根本原因（getHiggsキャッシュ/LOD/shadowBlur全廃/GC削減）から解決、FPS21達成

### 教訓ルール
1. **mainへ直接pushしない** — `claude/`ブランチ→PR→オーナーマージ。push前に`git branch`確認
2. **Canvas解像度はモバイル基準** — 512×512=1MB(安全) / 1024=4MB(ギリ) / 2048=16MB(注意) / 4096=64MB(**フリーズ確定**)。オフスクリーンは用途最小限、背景キャッシュは512-1024で十分
3. **`shadowBlur`はモバイルで致命的** — GPUガウシアンブラーで5-10倍重い。モバイルでは`Object.defineProperty`で無効化し、`globalAlpha`+重ね描きで代替。使用箇所は`// PERF: shadowBlur`コメント
4. **当て推量で直さず先に計測** — `PERF_SHOW_FPS`フラグ＋`console.time()`で最重処理を特定。「修正前X→後Yfps」を確認してマージ。効果なしパッチはリバート
5. **見えないものを描くな（LOD）** — 画面上12px未満は簡略描画（4ops）。`zoom*radius*5.6`でスクリーン径を判定。`ops×敵数×fps`でコスト見積（77ops×15敵×60fps=69,300ops/sec）
6. **同一フレーム内の重複計算をキャッシュ** — `getHiggsIntensity`等はフレームキャッシュ＋グリッド量子化（視覚識別できる最大スパン）。`_frameCount`をバージョンキーに次フレーム自動クリア
7. **ゲームループでGCを起こすな** — `toFixed()`禁止→`globalAlpha`。テンプレートリテラルで動的色文字列を作らない→定数hex。`ctx.save()/restore()`は高コスト、必要プロパティだけ手動保存

### チェックリスト
- **変更前**: `git branch`が`claude/`か / `PERF_SHOW_FPS=true`計測 / 処理の呼出頻度確認
- **Canvas追加時**: shadowBlur不使用 / オフスクリーン1024以下 / `ops×数×fps`見積 / 12px未満はLOD
- **ループ内追加時**: 動的文字列なし / `toFixed`なし / 重複計算キャッシュ / 毎フレーム必要か（2-6f間引き検討）
- **PRマージ前**: 修正前後FPS記録 / モバイル実機 or DevToolsエミュ確認 / `claude/`ブランチ確認

### パフォーマンス予算（モバイル目標 30fps = 33ms/frame）
背景~5ms / エフェクト~3ms / 船体敵~5ms / アンテナHUD~5ms / ロジック~5ms / ミニマップ(3f毎)~2ms / その他~8ms

---

## 技術スタック

| 要素 | 技術 |
|---|---|
| 描画 | HTML5 Canvas 2D API |
| ロジック | Vanilla JavaScript（ES6 class） |
| スタイル | CSS3（Orbitronフォント・SF緑パレット `#00ff88`系） |
| 音声 | Web Audio API（Oscillator生成） |
| 永続化 | localStorage |
| デプロイ | GitHub Pages |

---

*再編: 2026-06-14（旧6MDを CLAUDE/TODO/HANDOVER の3本に統合）*
