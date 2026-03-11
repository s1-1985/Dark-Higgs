# Dark Echo Project Memory

## Project Overview
- **Title**: Dark Echo
- **Genre**: Space RTS with submarine warfare mechanics (1v1 ジエンド戦スタイル)
- **Platform**: Android (Web prototype first)
- **UI Reference**: Homeworld 2
- **Lore**: ヒッグス粒子の霧 (Higgs Particle Fog) fills space (inspired by 無限のリヴァイアス)
- **NOTE**: エレボス(Erebos) → ヒッグス(Higgs) に全面リネーム済み

## Repository
- **GitHub**: https://github.com/s1-1985/Dark-Higgs.git
- **GitHub Pages**: https://s1-1985.github.io/Dark-Higgs/prototype/
- **Branch**: main (開発ブランチ: claude/review-handover-docs-lvIUV)

## File Structure
```
Dark-Higgs/
├── MEMORY.md                   # ← このファイル (別PCからの引き継ぎ用)
├── game_design_v2.md           # ゲームデザイン仕様書 (詳細版)
├── HANDOVER.md                 # AI引き継ぎ用ドキュメント
├── server.ps1                  # ローカルプレビュー用 PowerShell HTTP サーバー
├── .claude/launch.json         # Claude Code dev server 設定
└── prototype/
    ├── index.html              # Main UI (Homeworld2-style, Japanese)
    ├── game.js                 # Main game logic (~3200+ lines)
    └── style.css               # Sci-fi styling (Orbitron font, green palette)
```

## Implemented Features (Latest — 2026-03-11)

### コア
- Canvas 2D field (50000×50000)
- Radar/minimap (top-left, camera view frame付き)
- Bottom console: ship status / weapon select / environment info
- Web Audio API SFX
- Sector warp dialog
- Docking menu (repair + upgrades: hull/radar/weapons)
- Credit (SCR) system
- ジエンド戦スタイル: 1 boss per sector, lurk→fire→reposition AI
- 先制攻撃 bonus: 2x damage on unaware enemies
- ゲームオーバー overlay + sector clear banner

### スマホ操作
- **1本指ドラッグ (即時)** = カメラパン
- **1本指長押し (250ms, 移動量小)** = ウェイポイント指定
- **短いタップ (敵の上)** = ターゲットロック
- **ピンチ / 2本指ドラッグ** = ズーム / パン

### カメラ
- **追従ボタン (btn-camera-follow)**: ON時は毎フレーム自艦を中心に追従
- `cameraFollowPlayer` フラグ (default: false)

### ゲームモード
- **バトルロワイアル (br)**: 敵殲滅で勝利
- **サーチ&デストロイ (sd)**: 全コロニーノードハック OR 敵殲滅で勝利
  - コロニーノード: S&D=5個, BR=3個
  - ミニマップ下に進捗バー (sd-progress-bar / sd-progress-fill)
  - 全ハック達成ボーナス +50SCR
- ロビーでモード選択 (mode-card, data-mode='br'|'sd')
- `gameState.mode` — 'br' | 'sd'

### センサー・GEN
- **センサー4種**: HEAT / OPTIC / EM / HIGGS (じゃんけん方式)
- **GEN配分システム**: エンジン/武器/センサー/AI の4スライダー (ゼロサム100%)

### ヒッグス (0-100%連続値管理)
- **濃度**: 0〜100%で無段階管理（低中高の3段階ではない）
- **リソースノード**: マップ5-8個、HIGGSセンサーのみ可視、収集でEMスパイク+30SCR
- **ヒッグスウェイク軌跡**: 移動でヒッグス雲に軌跡、HIGGSセンサーで追跡可
- **higgsSig**: 敵が潜伏中にヒッグス乱流シグネチャを発生
- **ビームダークチャネル**: beamがヒッグス雲を通ると軌跡がHIGGSセンサーで見える
- **自然成長**: 時間経過でミスト密度が上昇 (Battle Royale的ゾーン圧縮)
- **エンジン減速**: ヒッグス高濃度内で最大45%速度低下
- **ビームダメージ減衰**: ヒッグス経路上で最大80%ダメージ低下

### 有視界システム (視野範囲)
- **基準**: 0%ヒッグス時 = 画像で示した範囲が100%視野
- **形状**: 円形ではなくアメーバ形状（ヒッグス濃度の影響で不定形）
- **縮小**: ヒッグス濃度上昇に比例して視野が狭まる（100%で視野ほぼゼロ）
- **自動ロックオン**: 視野範囲内の敵は自動的にロックオン
- **攻撃ON/OFF**: 攻撃ボタンで自動攻撃の有効/無効を切り替え

### ロックオン種別
- **完全ロックオン**: 視野範囲内で実際に捉えた状態（フルダメージ）
- **想定ロックオン**: センサー検知→AI解析による推定位置（ダメージデバフ）
  - 視野ゼロでもセンサーで想定ロックオンが可能
  - 極論: マップ端から端までビームで狙撃可能（センサー検知条件）

### 武器システム
- **実弾 (Kinetic)**: 短距離、マガジン制（一定弾数でリロード）
- **ミサイル**: 中距離、リロード時間あり
- **ビーム**: 長距離、リロード時間あり、マップ端まで到達
- **レート**: GEN→武器割り振り量が発射間隔に影響（多いほど高レート）
- **射程インジケータ**: 選択中武器の届く距離を示すサークルを自機周りに表示

### EM ∝ AI配分
- プレイヤーのAI配分が高いほど敵の探知範囲が広がる
- AI=0%: 敵探知範囲×0.5倍, AI=100%: 敵探知範囲×1.0倍

### 武器シグネチャ
- **kinetic**: 銃口炎→光学スパイク大、EM微弱
- **missile**: 推進剤燃焼→熱源スパイク大、誘導系EM持続、光学小
- **beam**: チャージ中→熱源+EM急上昇、発射→光学+ヒッグスダークチャネル
- 敵AI: sector3以降ミサイル、sector5以降ビーム
- ログに武器種シグネチャ名表示

### 艦種システム (ロビー選択)
- 攻撃型 (Assault): HP 3500、速度0.8x、kinetic 3連装同時発射
- 潜航型 (Stealth): HP 700、速度1.4x
- 空母型 (Carrier): HP 2500、速度0.6x、ドローン初期展開済み

### HUDオーバーレイ（ズーム不変）
- 自機マーカー: 14px固定船型シルエット + パルスリング
- ウェイポイントライン: 細い破線のみ（シアン）
- 目的地マーカー: 回転クロスヘア + リング
- 敵コンタクト: ダイヤ形マーカー + 不確かさリング
- スレットリング: H/O/E/G 4センサー別（方角表示付き膨らみエフェクト）

### エンジン噴射エフェクト色 (未実装・構想)
エンジン種別に応じて機体後部の噴射エフェクト（スラスタートレイル）の色を変える。

| エンジン | 噴射色（案） | イメージ |
|---------|------------|---------|
| thermonuclear（熱核） | オレンジ〜白熱 `#ff6600`→`#ffffff` | 核融合炉の超高温プラズマ |
| pulse（パルス） | 青紫〜電気系 `#4466ff`→`#aa44ff` | 電磁パルス推進 |
| higgs（ヒッグス） | 暗い紫〜ほぼ不可視 `#330066`→透明 | ヒッグス場操作、目立たない |
| photon（フォトン） | 純白〜虹色 `#ffffff`→レインボー | 光子推進、可視光大量放射 |

### エンジン特性 (ENGINE_TYPES)
| エンジン | 熱源 | 光学 | EM |
|---------|------|------|-----|
| thermonuclear | ×2.0 | ×0.2 | ×0.4 |
| pulse | ×0.4 | ×0.3 | ×1.8 |
| higgs | ×0.08 | ×0.1 | ×0.2 |
| photon | ×0.0 | ×3.0 | ×0.2 |

### オシロスコープ表示
- 自機シグネチャ: H/O/E/G 4チャネルを sig-canvas に波形表示
- 環境シグネチャ: 同様に4チャネルオシロスコープ形式
- 両者を大きく見やすく表示

### ソナーエフェクト (改善要望)
- 波形伝播: ゆっくり
- エフェクト: 派手な色彩
- 残像: 半透明オーバーレイ 5〜8秒間フェードアウト
- 指向性ソナーも同様

### エフェクト4状態敵AI
- lurking: ヒッグス雲内潜伏
- gathering: リソースノード収集→HP強化
- hunting: シグネチャ探知→最終位置追跡
- combat: 射程内発砲→即再配置

### ストラクチャ・残骸
- **colony**: S&Dハック目標。全ハックでS&D勝利
- **derelict**: 難破船。EWボタンでハック可能 → 偽装熱源として敵を欺く

## Key Code Globals (game.js)
- `gameState.shipType` — 'assault' | 'stealth' | 'carrier'
- `gameState.mode` — 'br' | 'sd'
- `currentSensor` — 'heat' | 'optic' | 'em' | 'higgs'
- `cameraFollowPlayer` — bool (自艦追従フラグ)
- `genAlloc` — { engine: 30, weapons: 25, sensors: 25, ai: 20 } (ゼロサム)
- `higgsWakes[]` — {x, y, intensity, life}
- `resourceNodes[]` — {x, y, active, emFlashTimer}
- `structures[]` — Structure instances ('colony' | 'derelict')
- Ship fields: `heatSig`, `opticalSig`, `emSig`, `higgsSig`, `weaponType`, `lurking`, `postFireCooldown`, `fireFlashTimer`, `aiState`
- `ENGINE_TYPES` — {thermonuclear, pulse, higgs, photon}
- `worldToScreen()` — ワールド座標→スクリーン座標変換
- `drawHUDOverlay(ctx)` — スクリーン空間HUD描画
- `updateSigCanvas()` — オシロスコープ波形更新
- `drawTargetLine(ctx)` — ウェイポイント/ターゲットライン

## 将来構想 (未実装 - 構想段階)

### 自機クラスシステム
クラス（小→大順）:
- コルベット (Corvette)
- フリゲート (Frigate)
- デストロイヤー (Destroyer)
- バトルシップ (Battleship)
- マザーシップ (Mothership)

タイプ別利用可能クラス:
- **攻撃型 (Attack)**: コルベット、フリゲート、デストロイヤー、バトルシップ
- **先行型 (Advance)**: コルベット、フリゲート、デストロイヤー、バトルシップ
- **空母型 (Carrier)**: デストロイヤー、バトルシップ、マザーシップ

クラスによる差異: HP、搭載武器数、速度、ジェネレータ出力、積載量

### 自機乗り換えシステム
- ゲーム内報酬（SCR）で自機を乗り換え・装備を購入
- 各クラスのカスタマイズ要素で自分の戦略に合った艦に改造
- 将来的なショップ/カスタマイズメニューを検討

### アートワーク (naobanapro制作予定)
- 現状のシンプルな多角形イラストをnaobanproの精細なイラストに置き換え
- ゲームの世界観: **戦艦同士の戦い** (ファイターはドローン扱い)
- 各クラスのプロファイル・トップダウン両方のアセットが必要

## 設計確定済み事項 (未実装)

### AIロックオンシステム
- センサー検知 → AI解析 → 仮想ターゲット候補を確率%付きでマップ表示
- 高信頼度: 候補2〜3個 (62%/28%/10%) + デバフ小
- 低信頼度: 候補5〜6個 (均等%) + デバフ大
- デコイ・ドローンが偽候補を常に混入

### デコイ・ドローンシステム
- 積載量: 戦闘型<先行型<空母型
- 製造ドローン: マップリソースを消費して戦闘中に追加生産
- デコイシグネチャ偽装精度: 機体・装備依存

### 潜航型ジャミング3種
1. 範囲ジャミング (Active) — 半径X内の全センサーをY%劣化
2. 継続EMジャム — GEN消費で持続的に周辺センサー妨害
3. EMパルス (一発) — 広域瞬間ブラインド

### 空母型建設物4種
| 建設物 | 機能 |
|--------|------|
| 砲台 | 範囲内敵を自動攻撃 |
| ビームバリア | 透過不可の防衛ライン |
| センサーブイ | センサーネットワーク拡張 |
| ヒッグス散布装置 | 能動的にヒッグスを生成 |

## Next Implementation Priorities
1. 有視界システム（アメーバ形状視野、ヒッグス連続濃度連動）
2. 自動ロックオン + 攻撃ON/OFF + 武器射程サークル
3. 武器リロード・マガジン制度、GEN→発射レート係数
4. UI大幅改善（コンパクトなボタン、アイコン選択、大型オシロスコープ）
5. ソナーエフェクト改善（残像5-8秒）
6. スレットリング方角表示改善
7. センサー制約型敵AI (playerLastKnownPos予測モデル)
8. AIロックオンシステム (仮想ターゲット候補表示)

## User Preferences
- 実装前に確認不要 (承認済みとして進める)
- コミットは機能実装後に実施
- git push は `claude/` プレフィックスブランチに (mainへは直接push不可)
- PRはGitHub API経由でマージ (gh CLI なし): `curl -X PUT https://api.github.com/repos/s1-1985/Dark-Higgs/pulls/{N}/merge`
- GH_TOKEN: 環境変数 GH_TOKEN に設定済み（MEMORY.mdには記載しない）

## 別PCでの引き継ぎ手順
1. `git clone https://github.com/s1-1985/Dark-Higgs.git`
2. Claude Code を起動
3. 「MEMORY.md を読んで引き継いで」と伝える

*最終更新: 2026-03-11*
