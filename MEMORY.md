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
├── server.ps1                  # ローカルプレビュー用 PowerShell HTTP サーバー
├── .claude/launch.json         # Claude Code dev server 設定
└── prototype/
    ├── index.html              # Main UI (Homeworld2-style, Japanese)
    ├── game.js                 # Main game logic (~2400+ lines)
    └── style.css               # Sci-fi styling (Orbitron font, green palette)
```

## Implemented Features (Latest — commit ad99ade+)

### コア
- Canvas 2D field (50000×50000)
- Radar/minimap (top-left, camera view frame付き)
- Bottom console: ship status / weapon select / environment info
- Web Audio API SFX
- Sector warp dialog
- Docking menu (repair + upgrades: hull/radar/weapons)
- Credit (CR) system + ad banner
- ジエンド戦スタイル: 1 boss per sector, lurk→fire→reposition AI
- 先制攻撃 bonus: 2x damage on unaware enemies
- ゲームオーバー overlay + sector clear banner

### スマホ操作 (最新)
- **1本指ドラッグ (即時)** = カメラパン
- **1本指長押し (250ms, 移動量小)** = ウェイポイント指定
- **短いタップ (敵の上)** = ターゲットロック
- **ピンチ / 2本指ドラッグ** = ズーム / パン
- `TOUCH_WAYPOINT_DELAY = 250ms`, `TOUCH_MOVE_THRESHOLD = 12px`

### カメラ
- **追従ボタン (btn-camera-follow)**: ON時は毎フレーム自艦を中心に追従
- `cameraFollowPlayer` フラグ (default: false)

### ゲームモード
- **バトルロワイアル (br)**: 敵殲滅で勝利
- **サーチ&デストロイ (sd)**: 全コロニーノードハック OR 敵殲滅で勝利
  - コロニーノード: S&D=5個, BR=3個
  - ミニマップ下に進捗バー (sd-progress-bar / sd-progress-fill)
  - 全ハック達成ボーナス +50CR
- ロビーでモード選択 (mode-card, data-mode='br'|'sd')
- `gameState.mode` — 'br' | 'sd'

### センサー・GEN
- **センサー4種**: HEAT / OPTIC / EM / HIGGS (じゃんけん方式)
- **GEN配分システム**: エンジン/武器/センサー/AI の4スライダー (ゼロサム100%)

### ヒッグス
- **リソースノード**: マップ5-8個、HIGGSセンサーのみ可視、収集でEMスパイク+30CR
- **ヒッグスウェイク軌跡**: 移動でヒッグス雲に軌跡、HIGGSセンサーで追跡可
- **higgsSig**: 敵が潜伏中にヒッグス乱流シグネチャを発生
- **ビームダークチャネル**: beamがヒッグス雲を通ると軌跡がHIGGSセンサーで見える
- **自然成長**: 時間経過でミスト密度が上昇 (Battle Royale的ゾーン圧縮)
- **エンジン減速**: ヒッグス高濃度内で最大45%速度低下
- **ビームダメージ減衰**: ヒッグス経路上で最大80%ダメージ低下 (高濃度エリアでビーム無力化)

### EM ∝ AI配分 (設計確定仕様)
- プレイヤーのAI配分が高いほど敵の探知範囲が広がる (高AIモード=EM放射増=発見されやすい)
- AI=0%: 敵探知範囲×0.5倍, AI=100%: 敵探知範囲×1.0倍

### 武器シグネチャ
- **kinetic**: 銃口炎→光学スパイク大、EM微弱
- **missile**: 推進剤燃焼→熱源スパイク大、誘導系EM持続、光学小
- **beam**: チャージ中→熱源+EM急上昇、発射→光学+ヒッグスダークチャネル
- 敵AI: sector3以降ミサイル、sector5以降ビーム
- ログに武器種シグネチャ名表示

### 艦種選択ロビー
- ゲーム起動時フルスクリーン表示 + ゲームモード選択
- **攻撃型**: HP 3500、速度0.8x、kinetic 3連装同時発射
- **潜航型**: HP 700、速度1.4x
- **空母型**: HP 2500、速度0.6x、ドローン初期展開済み

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
- Ship fields: `heatSig`, `opticalSig`, `emSig`, `higgsSig`, `weaponType`, `lurking`, `postFireCooldown`, `fireFlashTimer`

## 設計確定済み事項 (未実装)

### 武器メカニクス
- **ビーム**: 光速でマップ端まで到達。ヒッグス雲で減衰。ロックオンなしでも方向で撃てるがダメージ低下
- **実弾・ミサイル**: ロックオン必須
- **ロックオン種別**:
  - 完璧: 視野範囲内で実際の敵を捉えた状態
  - 不完全: センサー検知→AI解析→仮想位置候補をプレイヤーが選択 (ダメージデバフ)

### AIロックオンシステム (未実装)
- センサー検知 → AI解析 → 仮想ターゲット候補を確率%付きでマップ表示
- 高信頼度: 候補2〜3個 (62%/28%/10%) + デバフ小
- 低信頼度: 候補5〜6個 (均等%) + デバフ大
- デコイ・ドローンが偽候補を常に混入 → 候補は最低2〜3以上

### デコイ・ドローンシステム (未実装)
- 積載量: 戦闘型<先行型<空母型
- 製造ドローン: マップリソースを消費して戦闘中に追加生産
- デコイシグネチャ偽装精度: 機体・装備依存 (Q22=C)

### ハッキング方法 (未実装)
- A) 近距離直接ハッキング (時間消費・リスク大)
- B) ハッキングドローン送り込み (安全・積載量消費)

### 残骸インタラクション (未実装)
- ルート: 製造ドローンで回収 (リソース/低確率でドローン・武器)
- ハッキング: 偽装熱源化 / エンジン生存時は任意方向へ航行させる
- 破壊: ミサイルぶつけてシグネチャ発生 → 敵をあぶり出す

## Next Implementation Priorities
1. センサー制約型敵AI (playerLastKnownPos予測モデル、適応戦略パターン)
2. AIロックオンシステム (仮想ターゲット候補表示、確率%UI)
3. 潜航型ジャミング3種実装 (範囲ジャミング/継続EMジャム/EMパルス)
4. 空母型建設物4種 (砲台/ビームバリア/センサーブイ/ヒッグス散布装置)
5. ドローン4種 (攻撃/デコイ/哨戒/建設)
6. リソースノードをアップグレードポイント化 (現状は+30CRのみ → 設計はアップグレードツリー)

## User Preferences
- 実装前に確認不要 (承認済みとして進める)
- コミットは機能実装後に実施
- ローカルファイル編集 → git push で運用 (gh CLI なし)
- 別PCからの引き継ぎ: このファイルを最初に読む

## 別PCでの引き継ぎ手順
1. `git clone https://github.com/s1-1985/Dark-Higgs.git`
2. Claude Code を起動
3. 「MEMORY.md を読んで引き継いで」と伝える
