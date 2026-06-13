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
└── style.css     # SF緑パレット（Orbitronフォント）
```

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

## 設計課題の対応状況

### 「索敵が運ゲー」問題 → ✅ 方位ウェッジ実装済み
- **旧課題**: パッシブ探知は「誰かいる」通知のみで**方位情報がゼロ**＝運ゲー
- **対応**: `checkPassiveDetection()` を方位ウェッジ方式に刷新（`passiveBearings[]` +
  `drawPassiveBearings()`）。2秒毎の計測で現在センサーの減衰後シグネチャ強度に応じた
  方位扇形を**計測したワールド位置にアンカー**して描画。
  - 強信号=狭い確信（約7°）、弱信号=広いボケ（約49°）。`genAlloc.sensors`で精度補正。
  - 移動して再計測→**別位置からの扇形が交差＝三角測量で敵位置が絞れる**（運→推理）。
  - 扇は8秒フェード、最大8本。ログにコンパス方位「方位 NNN° ±MM°」表示。

### 敵AIの非対称 → ✅ センサー制約型AI実装済み（T07）
- **旧課題**: 敵は実プレイヤー位置を常時知って撃つ＝不公平
- **対応**: `playerLastKnownPos`（探知中のみ更新）＋`contactFreshness`を追加。combat時は
  実プレイヤーではなく**最終既知位置へ予測照準**（鮮度に応じ速度ぶんリード外挿、
  接触喪失で凍結）。沈黙/ステルスで照準が外れる＝プレイヤーと**対称**な探知に。

## 実装優先度（MEMORY.md より）

1. ✅ 有視界システム（アメーバ形状視野、ヒッグス連続濃度連動）
2. ✅ 自動ロックオン + 攻撃ON/OFF + 武器射程サークル
3. ✅ 武器リロード・マガジン制度、GEN→発射レート係数
4. ✅ UI大幅改善（コンパクトなボタン、大型オシロスコープ）
5. ✅ ソナーエフェクト改善（残像5-8秒、`sonar-fill`）
6. ✅ スレットリング方角表示改善（敵方角の膨らみエフェクト）
7. ✅ センサー制約型敵AI（playerLastKnownPos予測モデル）
8. ⬜ AIロックオンシステム（仮想ターゲット候補表示）— 未着手
   - パッシブ方位ウェッジで「推理」要素は導入済み。確率%付き候補表示は今後。

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
