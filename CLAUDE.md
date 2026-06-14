# Dark Echo — CLAUDE.md

> **このファイルの役割**: プロジェクト概要・**確定仕様**・コードクイックリファレンス（毎セッション自動読込）。
> - **実装する／したタスクの管理 → `TODO.md`**（壁打ちで決まった全機能・実装状況・未実装仕様の高解像度台帳）
> - **セッションログ・決定経緯・パフォーマンス教訓 → `HANDOVER.md`**
>
> ⚠️ 「設計どおり実装済み」と早合点しないこと。実装状況は必ず `TODO.md` で確認する。

## プロジェクト概要

**Dark Echo** — ヒッグス粒子の霧が満ちた宇宙空間での潜水艦戦タクティカルRTS。
「先に相手を見つけて撃つ」が核心。動く・索敵する・隠れるの3要素のバランス。
HTML5 Canvas 2D / Vanilla JS プロトタイプ。最終ターゲット: Android。

- **GitHub**: https://github.com/s1-1985/Dark-Higgs （リポジトリ名は `Dark-Higgs`、ゲーム名は Dark Echo）
- **GitHub Pages**: https://s1-1985.github.io/Dark-Higgs/prototype/
- **世界観元ネタ**: 無限のリヴァイアス（閉塞感）/ Homeworld 2（UI・操作系）
- **物質名**: ヒッグス粒子の霧（旧称エレボス→Higgsに全面リネーム済）

## ファイル構成

```
CLAUDE.md       # 本書: 概要・確定仕様・クイックリファレンス
TODO.md         # 実装タスク台帳（壁打ち企画・実装状況・未実装仕様）★着手前に必読
HANDOVER.md     # セッションログ・決定経緯・パフォーマンス教訓
prototype/
├── index.html  # UI レイアウト（Homeworld2スタイル、日本語）
├── game.js     # ゲームロジック全体（約5050行）
├── style.css   # SF緑パレット（Orbitronフォント）
└── assets/     # 生成スプライト（透過PNG, 512px）: ship_*/enemy_*/structure_*/node_higgs
```

> 旧 `MEMORY.md` / `game_design_v2.md` / `game_requirements.md` / `LESSONS_LEARNED.md` は
> 本書・`TODO.md`・`HANDOVER.md` に内容統合のうえ廃止（2026-06-14再編）。

## 確定仕様（コア）

### マップ
- 円形マップ `MAP_RADIUS=35000`（`FIELD_SIZE`=直径70000）@`game.js:35`
- ヒッグス雲ランダム初期配置 + 時間経過で増加（ゾーン圧縮）。リソースノード5-10個（HIGGSのみ可視）

### ゲームモード（2種）
- **バトルロワイアル (br)**: 敵殲滅で勝利
- **サーチ&デストロイ (sd)**: 全コロニーノードハック OR 殲滅で勝利（コロニー S&D=5 / BR=3）
- `gameState.mode` — 'br' | 'sd'

### センサー4種（じゃんけん方式）

| センサー | 主検知対象 |
|---|---|
| HEAT | エンジン熱・ミサイル熱源・高速移動 |
| OPTIC | 実弾発砲フラッシュ・ビーム軌跡・ミサイル着弾閃光 |
| EM | AI処理放射・ビームチャージ・ジャミング逆探知・リソース収集スパイク |
| HIGGS | ヒッグス濃度・移動ウェイク軌跡・ノード位置・ビームダークチャネル |

検知マトリクス（行動×センサー）の詳細は `TODO.md`／旧game_design_v2を統合した本表で代替。
◎=強検知の代表例: 高速移動→HEAT/HIGGS、実弾→OPTIC、ビームチャージ→HEAT/EM、ビーム発射→OPTIC/HIGGS、AI高配分→EM。

### GEN ゼロサム配分 + AI
- **GEN**: エンジン/武器/センサー/AI の4スライダー（合計100%固定）`genAlloc`
  - エンジン→速度 / 武器→火力・連射 / センサー→探知レンジ / AI→AI基礎量
- **物理法則**: AI配分↑ → EM放射↑（EMセンサーで検知されやすい）
- **AI精度制御**（独立配分・**未実装** → `TODO.md` §3-2）: 命中率/回避/センサー解析精度

### 艦種3種

| 艦種 | HP | 速度 | 固有 | 弱点 |
|---|---|---|---|---|
| 攻撃型 Assault | 3500 | ×0.8 | 複数武器同時発射（kinetic3連装） | シグネチャ大 |
| 潜航型 Stealth | 700 | ×1.4 | ジャミング3種+デコイ（**未実装**） | HP極低・失敗即死 |
| 空母型 Carrier | 2500 | ×0.6 | ドローン4種+建設物4種（**未実装**） | 建設中は停止＝最大脆弱 |

### 武器3種

| 武器 | レンジ | シグネチャ |
|---|---|---|
| 実弾 Kinetic | 短(800) | 光学強（発光・衝撃フラッシュ）。マガジン制 |
| ミサイル | 中長(2200) | 熱源（+AI型はEM）。リロード。※2タイプは**未実装** |
| ビーム | 長(8000) | チャージ=熱+EM強 / 発射=光学軌跡+ヒッグスダークチャネル。GEN大量消費 |

- GEN武器配分↑ → 発射レート↑（`weaponGenFactor`）
- ヒッグス高濃度でビームダメージ大幅低下

### ヒッグス物理法則（3つ）
1. **ヒッグスウェイク**: 移動で軌跡が残る（HIGGSセンサーに見える）`higgsWakes[]`
2. **EM ∝ AI配分**: AI処理量↑ → EM放射↑
3. **ビームダークチャネル**: ビーム発射でヒッグスに筋が残る（方向特定される）
- 自然成長（時間経過で濃度上昇）/ 高濃度内は相互ブラインド・エンジン減速・ビーム減衰

### ロックオン2種
- **完全ロックオン**: 視野内で捉えた状態（フルダメージ）✅
- **想定ロックオン**: センサー検知→AI解析の推定位置（ダメージデバフ）🚧部分（`TODO.md` §2-1）

### 敵AI設計原則
- **センサー制約型（全知禁止）**: プレイヤーと同じセンサールールで情報収集。直接位置は知らず、検知から行動を予測
- 4状態: lurking（潜伏）/ gathering（収集）/ hunting（追跡）/ combat（射程内発砲→再配置）✅
- 予測照準モデル `playerLastKnownPos`+`contactFreshness`（最終既知位置へリード外挿）は**実装済**（PR#35）✅
- `predictedBehavior` 行動別適応戦略テーブルのみ**未実装**（`TODO.md` §2-2）

### 構造物
- **colony**: S&Dハック目標（全ハックで勝利）/ **derelict**: 難破船。EWハックで偽コンタクト発生

## 主要グローバル変数（game.js）

| 変数 | 型 | 説明 |
|---|---|---|
| `gameState` | object | sector, credits, mode('br'\|'sd'), shipType, engineType, upgrades |
| `currentSensor` | string | 'heat' \| 'optic' \| 'em' \| 'higgs' |
| `genAlloc` | object | {engine, weapons, sensors, ai} ゼロサム100% |
| `autoAttackEnabled` | bool | 自動攻撃ON/OFF |
| `cameraFollowPlayer` | bool | 自艦追従フラグ |
| `higgsWakes[]` | array | {x, y, intensity, life} 移動軌跡 |
| `passiveBearings[]` | array | パッシブ方位ウェッジ（計測位置アンカー、三角測量用） |
| `resourceNodes[]` | array | ヒッグスノード |
| `structures[]` | array | Structure('colony'\|'derelict') |
| `camera` | object | {x, y, zoom, vx, vy} |
| `MAP_RADIUS` / `FIELD_SIZE` | const | 35000 / 70000 |
| `ENGINE_TYPES` | const | thermonuclear/pulse/higgs/photon |

## 主要関数（game.js）

| 関数 | 説明 |
|---|---|
| `gameLoop()` | メインループ(rAF) |
| `worldToScreen(x,y)` | ワールド→スクリーン座標変換 |
| `drawHUDOverlay(ctx)` | スクリーン空間HUD描画 |
| `updateSigCanvas()` | オシロスコープ波形更新 |
| `computeVisionRadius()` @254 | 有視界半径（ヒッグス濃度連動） |
| `updateVisionLockOn()` @355 | 有視界ロックオン |
| `checkPassiveDetection()` @3042 | パッシブ探知（2秒毎、方位ウェッジ生成） |
| `fireOmniSonar()` @3177 | アクティブ/指向性ソナー（CD15秒） |
| `drawPassiveBearings()` | パッシブ方位ウェッジ描画（`passiveBearings[]`） |
| `getHiggsIntensity(x,y)` | ヒッグス濃度（フレームキャッシュ付） |
| `buyUpgrade(type)` @5013 | アップグレード購入（engine/weapons/armor/sensor Lv0-3） |
| `generateSector()` @2534 | セクター生成 |
| `saveGame()` / `loadGame()` | localStorage 永続化 |

## Ship クラスの主要フィールド

`type`('corvette'\|'destroyer'\|'carrier'\|'fighter' ※敵), `heatSig`, `opticalSig`,
`emSig`, `higgsSig`, `weaponType`, `lurking`, `aiState`, `postFireCooldown`,
`fireFlashTimer`, `manualTarget`, `contactAccuracy`, `contactLife`,
`kineticAmmo`/`*Reloading`/`*ReloadTimer`

## Git ルール（厳守）

```bash
git checkout -b claude/feature-name-xxxxx   # 必ず claude/ プレフィックス
git push -u origin claude/feature-name-xxxxx
# → Draft PR作成 → オーナーがマージ
# ❌ main への直接 push は 403 で拒否される
```

- push 前に `git branch` でブランチ確認 / push 後は必ず Draft PR を作成

## モバイルパフォーマンス規則（詳細は HANDOVER.md）

- **`shadowBlur` 禁止**: モバイルGPUで5〜10倍重い。`globalAlpha`+重ね描きで代替
- **オフスクリーンCanvas**: 1024px以下（4096px=64MBでフリーズ）
- **LOD**: 画面上12px未満は簡略描画（4ops以下）
- **フレームキャッシュ**: ループ内で複数回呼ばれる計算は必ずキャッシュ
- **GC抑制**: `toFixed()`禁止・テンプレートリテラルで動的色文字列を作らない
- **計測ファースト**: 改善前に必ず `PERF_SHOW_FPS = true` で計測
- パフォーマンス予算: モバイル30fps = 33ms/frame

## オーナー設定

- 実装前確認不要（承認済みとして進める）。ただし**数値未定義の仕様**（積載量等）は実装前に合意
- git push は `claude/` ブランチのみ（main直接push = 403）。PRマージはオーナー実施
- コミットは機能実装後に実施
