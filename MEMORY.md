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
- **Branch**: main

## File Structure
```
Dark higgs/
├── MEMORY.md                   # ← このファイル (別PCからの引き継ぎ用)
├── game_design_v2.md           # Full design spec v2 (完全版 — 全設計仕様)
├── server.ps1                  # ローカルプレビュー用 PowerShell HTTP サーバー
├── .claude/launch.json         # Claude Code dev server 設定
└── prototype/
    ├── index.html              # Main UI (Homeworld2-style, Japanese)
    ├── game.js                 # Main game logic (~2100+ lines)
    └── style.css               # Sci-fi styling (Orbitron font, green palette)
```

## Implemented Features (Latest — commit 89bbb3d)

### コア
- Canvas 2D field (8000×8000)
- Radar/minimap (top-left, camera view frame付き)
- Bottom console: ship status / weapon select / environment info
- Web Audio API SFX
- Sector warp dialog
- Docking menu (repair + upgrades: hull/radar/weapons)
- Credit (CR) system + ad banner
- ジエンド戦スタイル: 1 boss per sector, lurk→fire→reposition AI
- 先制攻撃 bonus: 2x damage on unaware enemies
- ゲームオーバー overlay + sector clear banner

### センサー・GEN
- **センサー4種**: HEAT / OPTIC / EM / HIGGS (じゃんけん方式)
- **GEN配分システム**: エンジン/武器/センサー/AI の4スライダー (ゼロサム100%)

### ヒッグス
- **リソースノード**: マップ5-8個、HIGGSセンサーのみ可視、収集でEMスパイク+30CR
- **ヒッグスウェイク軌跡**: 移動でヒッグス雲に軌跡、HIGGSセンサーで追跡可
- **higgsSig**: 敵が潜伏中にヒッグス乱流シグネチャを発生
- **ビームダークチャネル**: beamがヒッグス雲を通ると軌跡がHIGGSセンサーで見える

### 武器シグネチャ
- **kinetic**: 銃口炎→光学スパイク大、EM微弱
- **missile**: 推進剤燃焼→熱源スパイク大、誘導系EM持続、光学小
- **beam**: チャージ中→熱源+EM急上昇、発射→光学+ヒッグスダークチャネル
- 敵AI: sector3以降ミサイル、sector5以降ビーム
- ログに武器種シグネチャ名表示

### 艦種選択ロビー
- ゲーム起動時フルスクリーン表示
- **攻撃型**: HP 3500、速度0.8x、kinetic 3連装同時発射
- **潜航型**: HP 700、速度1.4x
- **空母型**: HP 2500、速度0.6x、ドローン初期展開済み

## Key Code Globals (game.js)
- `gameState.shipType` — 'assault' | 'stealth' | 'carrier'
- `currentSensor` — 'heat' | 'optic' | 'em' | 'higgs'
- `genAlloc` — { engine: 30, weapons: 25, sensors: 25, ai: 20 } (ゼロサム)
- `higgsWakes[]` — {x, y, intensity, life}
- `resourceNodes[]` — {x, y, active, emFlashTimer}
- Ship fields: `heatSig`, `opticalSig`, `emSig`, `higgsSig`, `weaponType`, `lurking`, `postFireCooldown`, `fireFlashTimer`

## Key Design Notes (game_design_v2.md 参照)
- ヒッグス粒子の霧: 自然成長 (Battle Royale的), 武器で分散, 高濃度=相互ブラインド
- 敵AI: センサー制約型 (全知禁止) — playerLastKnownPos予測モデル (未実装)
- 潜航型ジャミング: 3種すべて使い分け可能
- 空母型建設物: 砲台・ビームバリア・センサーブイ・ヒッグス散布装置

## Next Implementation Priorities
1. センサー制約型敵AI (playerLastKnownPos予測モデル)
2. ヒッグス自然成長 (時間経過で濃度上昇)
3. 潜航型ジャミング実装 (3種)
4. 空母型建設物

## User Preferences
- 実装前に確認不要 (承認済みとして進める)
- コミットは機能実装後に実施
- ローカルファイル編集 → git push で運用 (gh CLI なし)
- 別PCからの引き継ぎ: このファイル + game_design_v2.md を最初に読む

## 別PCでの引き継ぎ手順
1. `git clone https://github.com/s1-1985/Dark-Higgs.git`
2. Claude Code を起動
3. 「MEMORY.md と game_design_v2.md を読んで引き継いで」と伝える
