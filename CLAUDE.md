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
├── game.js     # ゲームロジック全体（約5200行）
├── style.css   # SF緑パレット（Orbitronフォント）
└── assets/     # 生成スプライト（透過PNG）: ship_*/enemy_*/structure_*/node_higgs/fx_beam_main
```

> 旧 `MEMORY.md` / `game_design_v2.md` / `game_requirements.md` / `LESSONS_LEARNED.md` は
> 本書・`TODO.md`・`HANDOVER.md` に内容統合のうえ廃止（2026-06-14再編）。

## 確定仕様（コア）

### マップ
- 円形マップ `MAP_RADIUS=35000`（`FIELD_SIZE`=直径70000）@`game.js:35`
- ヒッグス雲ランダム初期配置 + 時間経過で増加（ゾーン圧縮）。リソースノード5-10個（HIGGSのみ可視）

#### マップ4層構造（描画レイヤー）
最奥から手前へ、4つの論理レイヤーで構成する（2026-06-14確定）:
1. **背景層**: 星・星雲パララックス（`generateSpaceBackground`/`_drawNebula`）
2. **メインフィールド層**: 自機・敵・ノード・構造物（エンティティ）
3. **地形層（局所ハザード）**: デブリ帯（岩礁帯）/ 磁気嵐帯 / 熱雲 等。**センサー別**に作用するハザード地形。各々が `bgMist` 同様の濃度ブロブ集合を持つ
4. **ヒッグス層**: 全センサーに干渉するゲームの根幹。雲を下から見上げた濃淡表現＋濃度連動の局所視界

> ⚠️ 地形層（3）の詳細（4種目の地形・センサー対応・バフ/デバフ数値）と、ヒッグス局所視界のバランス設計は
> **仕様策定中** → `TODO.md` §3-13 を唯一の正とする。本書には確定したレイヤー構成のみ記載。

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
- **AI精度制御**（独立配分✅ → `TODO.md` §3-2）: 命中率/回避/センサー解析精度

### 艦種3種

| 艦種 | HP | 速度 | 固有 | 弱点 |
|---|---|---|---|---|
| 攻撃型 Assault | 3500 | ×0.58 | 複数武器同時発射（kinetic3連装） | シグネチャ大・旋回時速度低下大 |
| 潜航型 Stealth | 700 | ×1.05 | ジャミング3種✅ + デコイ射出✅(ミサイル誘引) | HP極低・失敗即死 |
| 空母型 Carrier | 2500 | ×0.38 | ドローン4種✅+建設物4種✅ | 加速/旋回最鈍・建設中は停止＝最大脆弱 |

> 速度倍率は `SHIP_MAX_SPEED_MULT` による最高速倍率（慣性あり・旋回中はさらに低下）。加速レートは `SHIP_ACCEL_RATE`（carrier=0.003 / assault=0.008 / stealth=0.016）。

### 武器3種

| 武器 | レンジ | シグネチャ |
|---|---|---|
| 実弾 Kinetic | 短(800) ±150° | 光学強（発光・衝撃フラッシュ）。マガジン制 |
| ミサイル | 中長(2200) ±45° | 熱源（+AI型はEM）。リロード。HON/AI 2タイプ✅ |
| ビーム | 長(8000) ±10° | チャージ=熱+EM強 / 発射=光学軌跡+ヒッグスダークチャネル。GEN大量消費 |

- GEN武器配分↑ → 発射レート↑（`weaponGenFactor`）
- ヒッグス高濃度でビームダメージ大幅低下
- **射角**: `WEAPON_FIRE_ARC = { kinetic: Math.PI*5/6, missile: Math.PI/4, beam: Math.PI/18 }`
- **右クリック自由射撃**: ミサイル/ビームのみ。射角チェックあり。外れると自位置シグネチャが露出
- **後方被弾ボーナス**: 後方弧（`|diff| > π×0.55`）から被弾時 ×1.5 ダメージ

### ヒッグス物理法則（3つ）
1. **ヒッグスウェイク**: 移動で軌跡が残る（HIGGSセンサーに見える）`higgsWakes[]`
2. **EM ∝ AI配分**: AI処理量↑ → EM放射↑
3. **ビームダークチャネル**: ビーム発射でヒッグスに筋が残る（方向特定される）
- 自然成長（時間経過で濃度上昇）/ 高濃度内は相互ブラインド・エンジン減速・ビーム減衰

### ロックオン2種
- **完全ロックオン**: 視野内で捉えた状態（フルダメージ）✅
- **想定ロックオン**: センサー検知→AI解析の推定位置（ダメージデバフ）✅（`TODO.md` §2-1）

### 狩りのリズム（2026-07-03 ゲーム性進化 ✅ → `TODO.md` §3-15）
- **奇襲**: 非警戒の敵への初弾 ×3.5 + 混乱（火器管制ダウン4s・追撃×1.75）。ビーム含む全武器。対称ルール: 未探知の敵からの被弾も奇襲扱い ×1.6
- **サブシステム損傷**: 奇襲初弾=確定 / 後方被弾=30% で 機関（減速+熱漏洩）/ センサー（探知激減）/ 武器（発砲不能）が一時破損。自機/敵対称
- **露出度メーター**: 隠密/痕跡/追跡/捕捉 の4段階を常時HUD表示（`playerExposureLevel`）。追跡以上で心音
- **ヒッグスサージ**: 90〜150s毎の周期イベント（`surgePhase`）。予兆8s→全探知×0.15縮退12s（ウェイク×2.2増幅・敵味方対称）→高感度×1.5 6s
- **ペーシング**: 敵スポーン13000〜17000u（パッシブ探知圏のすぐ外）/ ノード6割を自機-敵の争奪帯に配置 / ログ4秒重複抑制

### 敵AI設計原則
- **センサー制約型（全知禁止）**: プレイヤーと同じセンサールールで情報収集。直接位置は知らず、検知から行動を予測
- 4状態: lurking（潜伏）/ gathering（収集）/ hunting（追跡）/ combat（射程内発砲→再配置）✅
- 予測照準モデル `playerLastKnownPos`+`contactFreshness`（最終既知位置へリード外挿）は**実装済**（PR#35）✅
- `predictedBehavior` 適応戦略（収集→先回り/チャージ→回避/実弾→カイト&長射程）も**実装済** ✅（`TODO.md` §2-2）

### 構造物
- **colony**: S&Dハック目標（全ハックで勝利）/ **derelict**: 難破船。EWハックで偽コンタクト発生

## 主要グローバル変数（game.js）

| 変数 | 型 | 説明 |
|---|---|---|
| `gameState` | object | sector, credits, mode('br'\|'sd'), shipType, engineType, upgrades, **enemyType**('assault'\|'stealth'\|'carrier') |
| `currentSensor` | string | 'heat' \| 'optic' \| 'em' \| 'higgs' |
| `genAlloc` | object | {engine, weapons, sensors, ai} ゼロサム100% |
| `autoAttackEnabled` | bool | 自動攻撃ON/OFF |
| `cameraFollowPlayer` | bool | 自艦追従フラグ |
| `demoMode` | bool | デモモード（霧解除・全敵可視・敵AI通常動作） |
| `higgsWakes[]` | array | {x, y, intensity, life} 移動軌跡 |
| `passiveBearings[]` | array | パッシブ方位ウェッジ（計測位置アンカー、三角測量用） |
| `resourceNodes[]` | array | ヒッグスノード |
| `structures[]` | array | Structure('colony'\|'derelict') |
| `camera` | object | {x, y, zoom, vx, vy} |
| `MAP_RADIUS` / `FIELD_SIZE` | const | 35000 / 70000 |
| `ENGINE_TYPES` | const | thermonuclear/pulse/higgs/photon |
| `SHIP_MAX_SPEED_MULT` | const | {assault:0.58, stealth:1.05, carrier:0.38} 最高速倍率 |
| `SHIP_ACCEL_RATE` | const | {carrier:0.003, assault:0.008, stealth:0.016} 加速レート |
| `SHIP_TURN_SLOW` | const | {carrier:0.78, assault:0.52, stealth:0.22} 旋回中速度低下率 |
| `PLAYER_TURN_RATES` | const | {assault:0.010, stealth:0.015, carrier:0.004} 旋回レート(rad/frame) |
| `WEAPON_FIRE_ARC` | const | {kinetic:π×5/6, missile:π/4, beam:π/18} 射角（半角ラジアン） |

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
| `toggleDemoMode()` | デモモードON/OFF切替（`btn-demo-mode`から呼出） |

## Ship クラスの主要フィールド

`type`('corvette'\|'destroyer'\|'carrier'\|'fighter' ※敵), `heatSig`, `opticalSig`,
`emSig`, `higgsSig`, `weaponType`, `lurking`, `aiState`, `postFireCooldown`,
`fireFlashTimer`, `manualTarget`, `contactAccuracy`, `contactLife`,
`kineticAmmo`/`*Reloading`/`*ReloadTimer`,
**`currentSpeed`** (慣性実速度、0=停止)

## Git / PR / デプロイ反映ルール（厳守 — 過去に反映漏れ多発）

```bash
git checkout -b claude/feature-name-xxxxx   # 必ず claude/ プレフィックス
git push -u origin claude/feature-name-xxxxx
# → 【非Draft】PR作成 (マージボタンを必ず出す) → オーナーがマージ
# ❌ main への直接 push は 403 で拒否される
```

### ⚠️ 反映漏れ防止（最重要・過去に何度も発生）
1. **PRは必ず非Draft（ready）で作る**。Draft PRには**マージボタンが出ず**、オーナーが反映できない。
2. **マージ後の追加は必ず「新しいPR（別番号）」で出す**。マージ済み/クローズPRのブランチに push し続けても、その差分はどのPRにも入らず**反映されない**。`mcp__github__pull_request_read`でPRが`merged/closed`でないか確認してから push 先を判断する。
3. **「適用済み」と言う前に必ず検証**: `git log origin/main..HEAD --oneline` で**未マージコミットが無いこと**を確認する。1つでも残っていれば「まだ本番(main)に入っていない」＝GitHub Pagesに反映されない。
4. **GitHub Pages は `main` を配信**。PRをマージするまでゲーム本体には反映されない。マージ後も配信反映に1〜2分。
5. **キャッシュバスティング必須**: `game.js`/`style.css` を変更したら **`prototype/index.html` の `?v=YYYYMMDD?` を必ず更新する**。これを怠るとブラウザが旧ファイルをキャッシュし「修正が反映されない」と誤認する（実際に長期間発生）。`<head>`に no-cache メタも設定済み。
6. push 前に `git branch` でブランチ確認。

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
- **PRは非Draftで作成**（マージボタンを出す）。**マージ後の追加は新PR番号**で出す（上記「反映漏れ防止」厳守）
- `game.js`/`style.css`変更時は **index.html の `?v=` を更新**（キャッシュ対策）
