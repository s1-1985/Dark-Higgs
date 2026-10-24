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
**ビルド/テスト工程・.NET等の言語SDKは一切不要**（`.csproj`/`.sln`等は存在しない。`prototype/`を静的配信するだけ）。他リポジトリ向けの言語SDKインストールフック等を導入する指示が来たら、まず本プロジェクトに対象ファイルが実在するか確認する（経緯は`HANDOVER.md`「環境セットアップ関連の判断ログ」参照）。

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
├── game.js     # ゲームロジック全体（約8800行）
├── style.css   # SF緑パレット（Orbitronフォント）
└── assets/     # 生成スプライト（透過PNG）: ship_*/enemy_*/structure_*/node_higgs/fx_beam_main
```

> 旧 `MEMORY.md` / `game_design_v2.md` / `game_requirements.md` / `LESSONS_LEARNED.md` は
> 本書・`TODO.md`・`HANDOVER.md` に内容統合のうえ廃止（2026-06-14再編）。

## 確定仕様（コア）

### コアループ「聴く→測る→撃つ→消える」（2026-10-24 第13弾 ✅ → `TODO.md` §3-27）
> 原案（先に見つけて撃つ / ジ・エンド戦的1対1）に回帰するため、探知→射撃の導線を一本化した。**自機/敵は同じ受信モデル**。
- **聴く**: 4帯域ミキサー（左列 `#band-tuner`、`rxLevels()`）。太バー=受信・刻み(50%)=方位が取れる閾値 / 細バー=自艦の放射（同じ0.5基準）。タップ/キー1〜4で同調（同調外バンドの方位解析は×0.3）
- **測る**: `trackNextSignal()`（TRACK/キーT/ブリップタップ）で信号をロック → 方位線に**直交して動くほど**視差(`triParam`)が貯まり推定円が縮む（`R=300+34700*(1-q)^2`）→ `applyTrackContact()` で**推定位置を敵コンタクトに反映**
- **撃つ**: `issueFireOrder()`（FIRE/キーF）= 完全ロック or 想定ロック(推定位置)へ現在武器で発射（`dmgScale=0.3+0.5*acc`、命中見込み`assumedHitChance()`）。**自動攻撃は完全ロック時のみ**。ミサイルは終末シーカー付き（敵ミサイルも対称）
- **消える**: 発砲は位置を晒す（自機発砲フラッシュ／敵は被弾で射手方位を得てhuntingへ・逆も対称）。静粛(abar常設/キーS)・ヒッグス雲・直交回避で振り切る。奇襲×3.5は1回だけ（被弾した敵は45秒警戒）
- **副長(XO)バー**: 上帯中央。`xoEvaluate()` が優先度順に1件の状況判断+ワンタップ行動（キーX）を提示
- **司令部情報**: 開始時、自機はボス方面の粗い方位（`intelBearing`、最大4分）、敵は「マップ中央付近」の粗い情報（`boss.intelPos`）。正確な位置は誰も知らない
- **メタフロー**: 初回ブリーフィング（作戦要領4ステップ、`darkEchoBriefed`）→ 制圧後に戦闘詳報(`openDebrief`) →「次のセクターへ」or「ドックで改修」

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
- **物理法則**: AI配分↑ → EM放射↑（EMセンサーで検知されやすい）。第13弾で**停止中でもAI分のEMが漏れる**よう是正（EM=スラスト×0.35×emMult+センサー×0.18+AI×0.40）
- **AI精度制御**（独立配分✅ → `TODO.md` §3-2）: 命中率/回避/センサー解析精度

### 艦種3種

| 艦種 | HP | 速度 | 固有 | 弱点 |
|---|---|---|---|---|
| 攻撃型 Assault | 3500 | ×0.58 | 複数武器同時発射（kinetic3連装） | シグネチャ大・旋回時速度低下大 |
| 潜航型 Stealth | 700 | ×1.05 | ジャミング3種✅ + デコイ射出✅(ミサイル誘引) | HP極低・失敗即死 |
| 空母型 Carrier | 2500 | ×0.38 | ドローン4種✅+建設物4種✅ | 加速/旋回最鈍・建設中は停止＝最大脆弱 |

> 巡航速度は `shipCruiseSpeed(cls, enginePct, gain)` = enginePct/100×gain×`SPEED_BASE`(2.4)×`SHIP_MAX_SPEED_MULT`×`MOVE_SPEED_MULT`（自機/敵共用）。速度倍率は `SHIP_MAX_SPEED_MULT` による最高速倍率（慣性あり・旋回中はさらに低下）。加速レートは `SHIP_ACCEL_RATE`（carrier=0.003 / assault=0.008 / stealth=0.016）。

### 武器3種

| 武器 | レンジ | シグネチャ |
|---|---|---|
| 実弾 Kinetic | 短(800) ±150° | 光学強（発光・衝撃フラッシュ）。マガジン制 |
| ミサイル | 中長(2200) ±45° | 熱源（+AI型はEM）。リロード。HON/AI 2タイプ✅ |
| ビーム | 長(8000) ±10° | チャージ=熱+EM強 / 発射=光学軌跡+ヒッグスダークチャネル。GEN大量消費 |

- **射程は `WEAPON_RANGE` に一本化**（表示・AI判断・弾体飛距離で共通。`weaponRange()`=アップグレード倍率込み）
- GEN武器配分↑ → 発射レート↑（`weaponGenFactor`）
- ビーム発射後150fは機関出力×0.4（`BEAM_DRAIN_*`）
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
- **サブシステム損傷**: 奇襲初弾=確定 / 後方被弾=30% で 機関（減速+熱漏洩）/ センサー（探知激減）/ 武器（発砲不能）が一時破損。自機/敵対称。**対象毎CD5s**（連鎖マヒ防止・第7弾）
- **露出度メーター**: 隠密/痕跡/追跡/捕捉 の4段階を常時HUD表示（`playerExposureLevel`）。追跡以上で心音
- **ヒッグスサージ**: 90〜150s毎の周期イベント（`surgePhase`）。予兆8s→全探知×0.15縮退12s（ウェイク×2.2増幅・敵味方対称）→高感度×1.5 6s
- **ペーシング**: 敵スポーン13000〜17000u（パッシブ探知圏のすぐ外）/ ノード6割を自機-敵の争奪帯に配置 / ログ4秒重複抑制

### 音と決断（2026-07-03 第2弾 ✅ → `TODO.md` §3-16）
- **敵アクティブソナーピン**: 接触喪失した敵が探信音（距離連動音量+正確な方位ウェッジを自機が得る）。濃ヒッグス潜伏で反射回避 / デコイが偽エコー
- **魚雷警報**: 敵ミサイル2600u内で航走音警告+赤矢印 → デコイ/ジャミングが反応ツール化
- **静粛航行**: 全艦種「静粛」ボタン（速度×0.5・全シグネチャ×0.55）。発砲/ソナーで自動解除（`silentRunning`）
- **遭難信号**: 120〜180s毎のSOS収束イベント（先着回収: 自機=+300SCR+HP15% / 敵=回復+自己強化）`distressBeacon`
- **手負いの獲物**: HP20%未満で冷却材漏洩（heatSig下限0.45・熱trail滴下）。自機/敵対称

### 自機リングHUD（2026-07-04 第8弾 / 2026-07-05 第9弾で気配リング是正 ✅ → `TODO.md` §3-22,§3-23）
- **シグネチャハロー**(内): 艦体外に自機4センサー放射の弧。静粛/擬態で縮小・発砲で閃光=折りたたみ時の自SIGオシロ代替
- **気配リング**(中・第9弾でMGS4式に是正): 敵がプレイヤーを視認している強さ(`contactFreshness`×aiState)を敵方位に波で表現。背後から強く見られれば背後が大きく波打つ。沈黙で見られてなければ静か(対称)。**+受信シグネチャのブリップ、トラッキング中はLCKで識別**
- **レーダーリング**(外): 地形色反映(ヒッグス青→赤/デブリ灰/嵐紫/熱雲橙)+サージ伸縮+損傷明滅
- **武器射角アーク**: 全周円廃止→実射角の輪郭(kinetic±150/missile±45/beam±10)
- ~~コンパス(上部)~~: 第14弾で撤去（マップは常に北が上・方位は副長/ログの数値で示す）。露出度は上帯のDOMチップへ移設

### 探知・三角測量（2026-07-05 第9弾 ✅ → `TODO.md` §3-23）
> ⚠️ 第13弾で三角測量は**視差測量**（方位線と自機進路の角度`|sin α|`×移動距離で蓄積）に置換し、推定位置を敵コンタクトへ反映する方式に変更（§3-27）。下記の蓄積レート記述は旧方式。
- **ソナー2倍** `OMNI_SONAR_RANGE`。**三角測量ハードル低下**: 蓄積~1.3%/sec(60fps)・約1分で概位置サークル・`_sourcePos()`で真値から自動ジッタ配置・閾値dir>6
- **移動方向ガイド**: ロック中、方位線に垂直な最良進路を破線矢印で提示
- **ランドマーク特定**(第12弾でavg>18%に早期化): ノード/コロニー/難破船を永続記録(ヒッグス手前+ミニマップ)
- ~~RX SIGメーター~~(第11弾): 第13弾で撤去 → 第14弾の左列4帯域ミキサーに統合

### 追跡ルーティン明確化（2026-07-11 第12弾 ✅ → `TODO.md` §3-26）
- **移動速度1.5倍**: `MOVE_SPEED_MULT=1.5`（自機/敵対称。ドローン・弾体は据え置き）
- **発信源特定**: 静止源(ランドマーク/地形)=解析avg>18%で早期特定→ログ+**自動ロック解除**+「次のシグネチャへ」ガイド / 機動反応(敵・ドローン・デコイ)=avg>55%で「攻撃目標候補」分類通知(ロック維持)。SIGバーに解析フェーズ表示（解析n%→非ランドマーク→機動反応=目標）
- **特定済み地形効果**（熱雲帯/磁気嵐帯/ヒッグス高濃度域）はヒッグス手前+ミニマップに恒久マーカー（`drawIdentifiedTerrain`）
- **ソナーはヒッグス手前描画**: 波紋/充満/境界を`updateDrawSonarEffects`でフォグ後に描画 + コンタクトのエコーゴースト（`drawSensorTrace`拡張・有視界時は非表示）
- **痕跡**: 敵は通常航行でも heat/EM trail・higgsウェイクを航路に残す（per-entry `decay`で長寿命≈7〜11s）。可視条件は従来どおり「対応センサー選択中+自機センサーレンジ内」のみ＝全マップ可視にしない

### バランス調整（2026-07-04 第7弾 ✅ → `TODO.md` §3-21）
- 弾丸ダメージ: kinetic **18** / missile **55** / smart **70** / beam 150（自機/敵共通）
- 追跡鮮度減衰: `FRESHNESS_DECAY=0.0004/f`（第13弾で是正。旧0.012/fは約1.4秒で記憶喪失していた）。**静粛×1.5 / デブリ擬態×2.2** で加速（隠れる=振り切れる）
- fighterドローンは奇襲被弾の対象外

### 深淵の駆け引き（2026-07-03 第3弾 ✅ → `TODO.md` §3-17）
> ⚠️ **用語は宇宙世界観準拠**（2026-07-04 オーナー指摘で海洋用語を全面修正）: 着底→**デブリ擬態** / 魚雷航走音→**高速推進波** / 轟沈→**機関部誘爆・崩壊**。ソナー/岩礁帯は確定フレーバーとして維持。
- **デブリ擬態**: 岩礁帯(密度>0.30)で完全停止+静粛 → シグネチャ×0.30追加+敵近接ハード探知無効（`isBottomed`）。至近通過をやり過ごせる
- **ニアミス**: 未発見のまま敵1600u内通過 → 速い心音+「息を殺せ」表示（`nearMissActive`）
- **チャージビーム**: CHGトグルで2秒チャージ→×2.2。チャージ中は熱/EM激増=敵のcharging推定回避が本物化（即時発射の奇襲×3.5とのトレードオフ）
- **通信傍受**: EMセンサー+敵2600u内で敵の艦内通信（状態/意図）を傍受ログ表示
- **撃破シーケンス**: 敵撃破→3秒の崩壊演出（漂流・誘爆→最終爆発+衝撃波+スクラップ散乱）。勝利判定は最終爆発後
- **戦闘詳報**: `huntStats` をクリア時ログ+ゲームオーバー画面に表示

### 画面レイアウト = 横画面専用HUD（2026-10-24 第14弾 ✅ → `TODO.md` §3-28。第6弾の下部コンソール/折りたたみは廃止）
- **上帯** `#hud-top`: メニュー / セクター / HULLバー / 被探知チップ`#hud-expo`(隠密〜捕捉+「・静粛」「・擬態」) / 副長バー(2行まで) / `GEN`ボタン(配分要約)
- **左列** `#hud-left`: ミニマップ + 4帯域ミキサー（左手=聴く）
- **右列** `#hud-right`（下ほど重要=右手親指）: 航法 / 電子戦 or DRONE(空母) / 索敵 / 静粛 / 兵装(5モード循環+残弾バッジ) / 追跡(SIG-xx 解析%) / 射撃(命中予測)。親ボタンは右列の左にポップオーバー（実ボタンは非表示の`#action-store`に置き、開く時だけ移す）
- **GENドロワー** `#gen-drawer`: 上帯の`GEN`で左から開く。エンジン種別+艦体/AIスライダー
- **ログ**: フィールド左下の1行ティッカー（タップで展開）。パッシブ方位の2秒毎ログは廃止→**新規信号のみ**告知（`_passiveLastSeen`）
- **縦持ち**（タッチ端末）: `#rotate-overlay`で横向きを促し**進行を一時停止**（`_orientPaused`）。出撃タップ時に`requestLandscape()`=全画面+`screen.orientation.lock('landscape')`（Android Chromeのみ有効、iOSはオーバーレイで代替）。メニューに「全画面 切替」
- **カメラ補正**: `uiInsets()` = {left,right,top}（上帯・左右列の実測）。`centerCameraOnPlayer()` はフィールド中心に自機を置く。追従は既定ON（パンで解除・`#recenter-chip`で復帰）
- **ロビー**: 横画面（高さ≤600px）は左=キーアート+ロゴ / 右=出撃準備の2カラム。ブリーフィングは4ステップを2×2
- 撤去（重複）: 自SIG/環境SIGオシロ・解析ステータスバー・状態行(H/岩/嵐/熱/敵/弾/ノード)・センサー/エンジンGCB・キャンバス上の露出ピル/コンパステープ/RADAR・KINETICラベル/DIR・TRI文字/「測量に有効な進路」文字/静粛中の文字列
- ⚠️ 初期化IIFEから後方宣言letを参照するとtypeofガードでもTDZで全滅 → 状態変数は最上部宣言

### 霧の中の物語（2026-07-04 第5弾 ✅ → `TODO.md` §3-19）
- **環境音**: 常駐ドローン音（露出度で緊張音・サージでフィルタ変化）。ロビー「♪」トグル+localStorage永続化（`startAmbient`/`_amb`）
- **戦歴**: `gameState.career`（出撃/撃破/奇襲/最深セクター）をロビーに表示
- **前任艦の残骸**: 撃沈→次の出撃でサルベージ（`wreckSalvage`=喪失SCRの35%・`playerWreckObj`）
- **撃破残骸**: fighter以外の敵撃破地点にディレリクト残存（EWハック可）

### タイトル画面・UI（2026-07-04 第4弾 ✅ → `TODO.md` §3-18）
- **タイトルヒーロー**: Higgsfield生成キーアート `assets/title_keyart.jpg`(640px/33KB) + DARK ECHOロゴ(Orbitron+グロー) + ソナーリングCSSアニメ + タグライン
- **艦種カード**: 実スプライト表示（`mix-blend-mode: screen` で黒背景PNGをDOM透過）。敵艦種ボタンにもサムネイル
- **被弾方向インジケータ**: 被弾方位を自機周りの赤アークで1.25s表示（`playerHitDirs[]`）
- **ボタン押下フィードバック**: 全UIボタンに `:active` スケール+輝度CSS

### 敵AI設計原則
- **センサー制約型（全知禁止）**: プレイヤーと同じセンサールールで情報収集。直接位置は知らず、検知から行動を予測
- **受信モデル（第13弾）**: `ENEMY_PASSIVE_RANGE=11000`×(1-ヒッグス×0.3)×(1+sector×0.03)×(1-ジャム)、閾値×0.5。推定位置に誤差 `(1-q)*dist*0.25+50` + EMA平滑。推定位置へのミサイル射撃は `ENEMY_MISSILE_ENGAGE=2100` 以内
- 敵空母のファイターは有限（`droneStock=6+sector`、燃料3600f）
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
| `cameraFollowPlayer` | bool | 自艦追従フラグ（既定true、パンで解除） |
| `lockedSignalId` | string | 追跡(TRACK)中のシグネチャsourceId（敵は`'e-'+uid`） |
| `intelBearing` | object | 司令部情報の粗い方位 {ox,oy,angle,halfWidth,range,life} |
| `demoMode` | bool | デモモード（霧解除・全敵可視・敵AI通常動作） |
| `_orientPaused` | bool | 縦持ち（タッチ端末）中は `stepWorld` を止める |
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
| `WEAPON_RANGE` | const | {kinetic:800, missile:2200, beam:8000} 射程の唯一の正 |
| `SPEED_BASE` | const | 2.4（`shipCruiseSpeed()` の基準） |
| `ENEMY_PASSIVE_RANGE` / `FRESHNESS_DECAY` | const | 11000 / 0.0004 敵受信レンジ・記憶減衰 |

## 主要関数（game.js）

| 関数 | 説明 |
|---|---|
| `gameLoop()` | メインループ(rAF)。`stepWorld()`(ロジック) / `renderWorld()`(描画) に分離 |
| `window.__simSteps(n)` | 描画なしでロジックをnフレーム進める（ヘッドレスsim用） |
| `trackNextSignal()` | 未識別信号を順に追跡ロック（TRACK） |
| `issueFireOrder()` / `playerFireWeapon()` | 射撃命令（完全/想定ロック）/ 発射本体 |
| `assumedHitChance(te,w,lk)` | 想定ロック時の命中見込み |
| `xoEvaluate()` / `updateTacStrip()` | 副長の状況判断 / 副長バー・帯域ミキサー・射撃/追跡ボタン更新 |
| `rxLevels()` / `passiveRange()` | 4バンド受信レベル / パッシブ受信レンジ |
| `openDebrief()` / `showBriefing()` | 戦闘詳報 / 作戦要領 |
| `uiInsets()` / `centerCameraOnPlayer()` | HUDの上帯・左右列の実測 / フィールド中心へカメラ |
| `updateEnvInfo()` / `_updateExpoChip()` | 上帯HP・兵装残弾・GEN要約 / 被探知チップ |
| `requestLandscape()` / `toggleFullscreen()` | 全画面+横向きロック要求 / 全画面切替 |
| `worldToScreen(x,y)` | ワールド→スクリーン座標変換 |
| `drawHUDOverlay(ctx)` | スクリーン空間HUD描画 |
| `computeVisionRadius()` @748 | 有視界半径（ヒッグス濃度連動） |
| `updateVisionLockOn()` @873 | 有視界ロックオン |
| `checkPassiveDetection()` @5080 | パッシブ探知（2秒毎、方位ウェッジ生成） |
| `fireOmniSonar()` @5750 | アクティブ/指向性ソナー（CD15秒） |
| `drawPassiveBearings()` | パッシブ方位ウェッジ描画（`passiveBearings[]`） |
| `getHiggsIntensity(x,y)` | ヒッグス濃度（フレームキャッシュ付） |
| `buyUpgrade(type)` @8647 | アップグレード購入（engine/weapons/armor/sensor Lv0-3） |
| `generateSector()` @4224 | セクター生成 |
| `saveGame()` / `loadGame()` | localStorage 永続化 |
| `toggleDemoMode()` | デモモードON/OFF切替（メニュー内`btn-demo-mode`から呼出） |

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
