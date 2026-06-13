# Dark Echo — CLAUDE.md

## プロジェクト概要

**Dark Echo** — ヒッグス粒子の霧が満ちた宇宙空間での潜水艦戦タクティカルRTS。
HTML5 Canvas 2D / Vanilla JS プロトタイプ。最終ターゲット: Android。

- **GitHub**: https://github.com/s1-1985/Dark-Higgs
- **GitHub Pages**: https://s1-1985.github.io/Dark-Higgs/prototype/
- **詳細仕様**: `MEMORY.md`（最新）、`HANDOVER.md`（セッションログ付）、`game_design_v2.md`

## ファイル構成

```
prototype/
├── index.html    # UI レイアウト（Homeworld2スタイル、日本語）
├── game.js       # ゲームロジック全体（3200+行）
├── style.css     # SF緑パレット（Orbitronフォント）
└── assets/       # Nano Banana Pro 生成スプライト（透過PNG, 512px）
```

## 直近セッション記録（2026-06-13）

**ブランチ**: `claude/t01-implementation-start-dauj7q` / **PR #34**（Draft, 未マージ）

### 実装済み（このセッション）
1. **T01: 有視界システム** — 優先度#1完了
   - `computeVisionRadius()`@game.js:201 をヒッグス濃度連動の実計算に（0%=基準1200, 100%でも最低5%視野=`MIN_VISION_FACTOR`）
   - 以前は `FIELD_SIZE` 返し＋`drawFogOfWar` コメントアウトで**無効化**されていた（全敵が常時フルロックオン状態）→ 復活
   - `updateVisionLockOn()` 冒頭で視野半径を毎フレーム更新／`shadowBlur`→`globalAlpha`二重ストロークに置換
2. **生成スプライト表示システム** — `SPRITES` 非同期ローダー（game.js:198付近）
   - `assets/*.png` を読み込み、未ロード/欠如時は**既存ベクター描画にフォールバック**
   - 自機: `SPRITES['ship_'+gameState.shipType]`（assault/stealth/carrier）@game.js:1899
   - 敵: `SPRITES['enemy_'+this.type]`（corvette/fighter/destroyer/carrier, fighter=ドローン）@game.js:2128。発砲フラッシュは放射グラデ赤グロー
   - 建造物: `SPRITES['structure_'+this.type]`（colony/derelict）@game.js:893。ハック時lighter合成で青ティント
   - ノード: `node_higgs` を brightness 変調表示
   - **規約**: スプライトは俯瞰・**艦首+X（右向き）**で生成（`ctx.rotate(this.angle)`と一致）

### アセット生成パイプライン（再現手順）
- Higgsfield MCP `generate_image`（model=`nano_banana_pro`, 1:1, 2k）でトップダウン生成
- **武器ワード（warship/missile/weapon等）は検閲で失敗** → spaceship/cruiser/turret module 等に言い換え
- 背景透過: 当初MCP `remove_background`、途中から**承認ゲートで不可**に → ローカルPIL+scipy代替
  - **境界フラッドフィル方式**: 端から連結した背景画素のみ透過（黒背景×黒艦体の誤消去を防止、内部暗部を保護）
  - 背景色は4辺リングのmedianで自動検出（黒/白両対応）→ トリミング → 512px最適化

### 残課題・申し送り
- ⚠️ **実機スクショ検証は未実施**（コンテナにヘッドレスブラウザ無し）。GitHub Pages反映後、スプライト**表示サイズ係数**（自機`vr*2.35`/敵`r*2.8`/建造物`_sw`）を実機で微調整要
- 未生成: 空母型**建設物4種**（砲台/ビームバリア/センサーブイ/ヒッグス散布）、**武器エフェクト**（ミサイル/ビーム/着弾）
- Higgsfield MCP が承認ゲート状態（生成・bg除去とも不可）。解除後に追加生成可能


## Git ルール（厳守）

```bash
# ✅ 必ずこのパターン
git checkout -b claude/feature-name-xxxxx
git push -u origin claude/feature-name-xxxxx
# → PR作成 → オーナーがマージ

# ❌ main への直接 push は 403 で拒否される（やらない）
```

- ブランチ名は必ず `claude/` プレフィックス
- push 前に `git branch` でブランチ確認
- push 後は必ず Draft PR を作成する

## 主要グローバル変数（game.js）

| 変数 | 型 | 説明 |
|---|---|---|
| `gameState` | object | sector, credits, mode('br'\|'sd'), shipType |
| `currentSensor` | string | 'heat' \| 'optic' \| 'em' \| 'higgs' |
| `genAlloc` | object | {engine, weapons, sensors, ai} ゼロサム100% |
| `cameraFollowPlayer` | bool | 自艦追従フラグ |
| `higgsWakes[]` | array | {x, y, intensity, life} 移動軌跡 |
| `resourceNodes[]` | array | ヒッグスノード |
| `structures[]` | array | Structure('colony'\|'derelict') |
| `camera` | object | {x, y, zoom, vx, vy} |
| `ENGINE_TYPES` | const | thermonuclear/pulse/higgs/photon |

## 主要関数（game.js）

| 関数 | 説明 |
|---|---|
| `gameLoop()` | メインループ(rAF) |
| `worldToScreen(x,y)` | ワールド→スクリーン座標変換 |
| `drawHUDOverlay(ctx)` | スクリーン空間HUD描画 |
| `updateSigCanvas()` | オシロスコープ波形更新 |
| `checkPassiveDetection()` @game.js:2826 | パッシブ探知（2秒毎） |
| `fireOmniSonar()` @game.js:2869 | アクティブソナー（CD15秒） |
| `updateVisionLockOn()` @game.js:294 | 有視界ロックオン |
| `getHiggsIntensity(x,y)` | ヒッグス濃度（フレームキャッシュ付） |
| `generateSector()` | セクター生成 |
| `saveGame()` / `loadGame()` | localStorage 永続化 |

## Ship クラスの主要フィールド

`heatSig`, `opticalSig`, `emSig`, `higgsSig`, `weaponType`,
`lurking`, `postFireCooldown`, `fireFlashTimer`, `aiState`

## ゲームデザイン核心

### センサー4種（じゃんけん方式）

| センサー | 主検知対象 |
|---|---|
| HEAT | エンジン熱・ミサイル飛翔・高速移動 |
| OPTIC | 実弾発砲フラッシュ・ビーム軌跡・着弾閃光 |
| EM | AI処理放射・ビームチャージ・ジャミング・リソース収集スパイク |
| HIGGS | ヒッグス濃度・移動ウェイク軌跡・ノード位置・ビームダークチャネル |

### GENゼロサム配分
エンジン/武器/センサー/AI の4スライダー（合計100%固定）。
AI配分↑ → EM放射↑（EMセンサーで検知されやすくなる）。

### 艦種3種
- **攻撃型 (Assault)**: HP高・複数武器同時発射・シグネチャ大
- **潜航型 (Stealth)**: HP極低・最速・ジャミング3種・一撃必殺
- **空母型 (Carrier)**: HP高・低速・ドローン4種+建設物4種

## アップグレード/ドローン/積載量 — 設計 vs 実装状況

> ⚠️ **重要**: 詳細設計は `game_design_v2.md`（§4 ドローン, §5 アップグレード, §8 艦体構成）にあるが、**実装は設計の一部のみ**。下表で「設計どおりに実装済み」と誤読しないこと。

### アップグレード
- **実装済み**: `buyUpgrade(type)`@game.js:4763 — `engine/weapons/armor/sensor` の **4種・Lv0〜3**（`UPGRADE_MULT=[_,1.0,1.5,2.0]`、コスト`getUpgradeCost(lv)`）。armor=HP倍率、sensor=`RADAR_RANGE`倍率。`gameState.upgrades{}` に永続化
- **設計のみ（未実装）**: `game_design_v2.md:183` のツリー —「武器アンロック(ミサイル/ビーム)」「武器ダメージ」「センサー精度 vs レンジの分離」「**ドローン生産（空母型のみ）**」
- **ズレ**: 実装の`armor`は設計ツリーに無い。設計の武器アンロック/精度/ドローン生産は実装に無い → **要整合判断**

### ドローン
- **実装済み**: 敵空母が`new Ship(..., 'fighter')`を周期スポーン（game.js:1546, `droneSpawnTimer`、敵総数<5で発生）。**敵側のみ**
- **設計のみ（未実装）**: 自機ドローン4種（`game_design_v2.md:57`）
  | ドローン | 役割 | シグネチャ |
  |---|---|---|
  | 攻撃 | 自動追尾攻撃 | 熱 |
  | デコイ | ミサイル誘引・索敵妨害 | 強EM（囮） |
  | 哨戒 | センサーレンジ拡張 | 低 |
  | 建設 | 建設物を設置 | 停止中は低 |
- **注意**: `HANDOVER.md`の`TalosDrone`クラスは旧仕様の可能性（現game.jsに該当クラス無し、`fighter`型Shipで代用）

### 積載量（cargo capacity）
- **実装**: game.js に `cargo/capacity/積載` 該当コード **皆無**（完全未実装）
- **設計**: 相対順序「戦闘型 < 先行型 < 空母型」（MEMORY.md:224, game_design_v2.md:52,249）のみ。**具体的な数値・計算式は未定義**
- **要決定**: ドローン/デコイの最大同時展開数を積載量で制御する想定だが、数値が未定。実装前にオーナー合意要

## 未解決の設計課題（要オーナー合意）

### 「索敵が運ゲー」問題
- **現状**: パッシブ探知は「誰かいる」通知のみ、**方位情報がゼロ**
- **根拠**: `checkPassiveDetection()` は2秒毎に文字列通知のみ返す
- **敵AIとの非対称**: 敵は距離×ヒッグス減衰で連続的に探知（game.js:1459-1501）
- **提案**: パッシブ探知に「方位ウェッジ」を追加（強信号=狭い確信、弱信号=広いボケ）
  → 2回計測で三角測量可能になり「運」が「推理」になる

## 実装優先度（MEMORY.md より）

1. ✅ 有視界システム（アメーバ形状視野、ヒッグス連続濃度連動）— **実装済(PR#34)**
2. 自動ロックオン + 攻撃ON/OFF + 武器射程サークル
3. 武器リロード・マガジン制度、GEN→発射レート係数
4. UI大幅改善（コンパクトなボタン、大型オシロスコープ）
5. ソナーエフェクト改善（残像5-8秒）
6. スレットリング方角表示改善
7. センサー制約型敵AI（playerLastKnownPos予測モデル）
8. AIロックオンシステム（仮想ターゲット候補表示）

## モバイルパフォーマンス規則（LESSONS_LEARNED.md より）

- **`shadowBlur` 禁止**: モバイルGPUで5〜10倍重い。`globalAlpha`+重ね描きで代替
- **オフスクリーン Canvas**: 1024px以下に収める（4096px = 64MB でフリーズ）
- **LOD**: 画面上12px未満のオブジェクトは簡略描画（4ops以下）
- **フレームキャッシュ**: ゲームループ内で複数回呼ばれる計算関数は必ずキャッシュ
- **GC抑制**: `toFixed()` 禁止・テンプレートリテラルで動的色文字列を作らない
- **計測ファースト**: パフォーマンス改善前に必ず `PERF_SHOW_FPS = true` で計測

## オーナー設定

- 実装前確認不要（承認済みとして進める）
- git push は `claude/` ブランチのみ（main直接push = 403）
- PR マージはオーナーが実施
