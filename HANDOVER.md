# Dark Echo — HANDOVER（セッションログ・決定経緯・教訓）

> **このファイルの役割**: セッション間の引き継ぎ記録。**何を・なぜ・どう決めたか**の経緯と、
> パフォーマンス／git の教訓を残す。
> - プロジェクト概要・確定仕様・コードクイックリファレンス → **`CLAUDE.md`**
> - 実装する／した機能の台帳（壁打ち企画・実装状況） → **`TODO.md`**
> - 本書 = セッションログ・決定ログ・アセット生成手順・パフォーマンス教訓

---

## セッションログ（新しい順）

### 2026-06-15 — スプライト全面リデザイン 着手前（次セッション引継ぎ）

#### このセッションでやったこと
- **モバイルUIポップオーバー完成・マージ（PR#60相当）**: アクションボタンを6カテゴリ親ボタン（`#abar`）＋タップで展開するポップオーバー（`#action-popover`）に再設計。.action-grid はデスクトップのみ/モバイルは display:none で非表示。攻撃トグルは `#abar-atk-proxy` → `#btn-attack-toggle` にデリゲート。`setInterval(syncAtkLabel, 400)` でラベル・色を同期。
- **`mcp__Higgsfield__generate_image` を allowlist に追加**: `.claude/settings.local.json` の `permissions.allow` に追記しコミット済み（commit `e2bb511`）。**ただし現セッションでは発効しない**（設定はセッション起動時ロード）。

#### ブロッカー（次セッションで解消される）
- `mcp__Higgsfield__generate_image` の呼び出しが「MCP tool call requires approval」でブロックされ続けた。
- **根本原因**: Claude Code の `permissions.allow` は起動時に読み込む。セッション中にファイルを書き換えても現セッションには反映されない。
- **解消**: 新セッションを開始すれば `.claude/settings.local.json` が再ロードされ、以後は自動承認で生成が走る。

---

#### 次セッションの即時タスク（「前回の続き」と言ったらここから）

> **前提**: `mcp__Higgsfield__generate_image` は新セッション起動時から自動承認済み。確認不要で即実行すること。

**STEP 1 — 15枚を並列生成**（下記プロンプトをそのまま使う）

| ファイル | 目的 | モデル | 比率 |
|---|---|---|---|
| `icon_scan.png` | SCANアイコン: 同心シアンのソナーリング | nano_banana_pro | 1:1 |
| `icon_ew.png` | EWアイコン: 琥珀色の雷+電波妨害波 | nano_banana_pro | 1:1 |
| `icon_nav.png` | NAVアイコン: 白青コンパスローズ+北向き矢印 | nano_banana_pro | 1:1 |
| `icon_drone.png` | DRONEアイコン: 緑の4ローターデコイドローン俯瞰 | nano_banana_pro | 1:1 |
| `icon_sup.png` | SUPアイコン: 青い十字+回路基板ライン | nano_banana_pro | 1:1 |
| `icon_atk.png` | ATKアイコン: 赤橙のターゲットレティクル+ロックオンリング | nano_banana_pro | 1:1 |
| `ship_assault.png` | 攻撃型: フォトリアル近未来戦艦、俯瞰、シアン砲口+装甲、黒背景 | nano_banana_pro | 1:1 |
| `ship_stealth.png` | 潜航型: フォトリアル、マンタレイ型ステルス機体、黒背景 | nano_banana_pro | 1:1 |
| `ship_carrier.png` | 空母型: フォトリアル、広大な母艦、ドックベイ可視、黒背景 | nano_banana_pro | 1:1 |
| `enemy_corvette.png` | 敵コルベット: 有機的ダーク外骨格+赤橙発光、俯瞰、黒背景 | nano_banana_pro | 1:1 |
| `enemy_destroyer.png` | 敵デストロイヤー: 重厚赤紫エミッター付き大型戦艦、俯瞰、黒背景 | nano_banana_pro | 1:1 |
| `enemy_carrier.png` | 敵空母: 巨大暗色バイオメカ、ドローン発射口、赤コア、俯瞰、黒背景 | nano_banana_pro | 1:1 |
| `enemy_fighter.png` | 敵ファイター: 小型デルタウィング、赤エンジン、俯瞰、黒背景 | nano_banana_pro | 1:1 |
| `fx_explosion_big.png` | 大爆発: フォトリアル、橙白核+衝撃波リング+デブリ、黒背景 | nano_banana_pro | 1:1 |
| `fx_explosion_small.png` | 小爆発: コンパクト着弾フラッシュ+破片、黒背景 | nano_banana_pro | 1:1 |

**STEP 2 — game.js 修正**（船体に `'lighter'` 加算合成を追加）

- **自機**: `drawSpriteCentered(ctx, _psprite, ...)` の直前に `ctx.globalCompositeOperation = 'lighter';`、直後に `= 'source-over';` を追加（`game.js` @`Ship.draw` playerブランチ ~2413行）
- **敵**: `drawSpriteCentered(ctx, _esprite, ...)` の前後も同様（~2764行）
- **理由**: 新スプライトは黒背景+glowing design → lighter合成で黒が消え、グロー部分だけ輝く

**STEP 3 — index.html の #abar に UIアイコン `<img>` を差し込む**

各 `.abar-btn` の `<span>` テキスト部分を以下の形式に置換:
```html
<img src="assets/icon_scan.png" style="width:60%;height:auto;mix-blend-mode:screen" alt="">
<span class="abar-label">SCAN</span>
```
`mix-blend-mode:screen` で CSS レベルでもブレンド（JS不要）。

**STEP 4 — バージョン文字列更新**

`index.html` の `?v=20260615a` → `?v=20260615b`（または当日付+適切なサフィックス）

**STEP 5 — コミット・push・PRが非Draft/未マージか確認**

現在のブランチ: `claude/higgsfield-visual-effects-nhbaey`

---

#### アセット生成プロンプト（コピペ用）

全部まとめて並列実行（`mcp__Higgsfield__generate_image` を15個同時呼び出し）:

```
icon_scan:   "Sci-fi tactical UI button icon, SCAN sensor. Bold concentric cyan sonar ping rings with directional arc indicator, bright neon cyan glow on pure black background, minimal geometric design, reads clearly at 48px size, no text, square"
icon_ew:     "Sci-fi tactical UI button icon, EW electronic warfare. Bold amber lightning bolt striking through radio interference wave pattern, glowing amber-orange energy disruption, neon glow on pure black background, minimal geometric design, reads clearly at 48px size, no text, square"
icon_nav:    "Sci-fi tactical UI button icon, NAV navigation. Bold compass rose with north arrow pointing up, white-blue navigation grid lines, glowing white-blue holographic design on pure black background, minimal geometric design, reads clearly at 48px size, no text, square"
icon_drone:  "Sci-fi tactical UI button icon, DRONE deploy. Quad-rotor drone seen from above with four rotating blades, glowing green rotor motion blur trails, angular military drone silhouette, neon green glow on pure black background, minimal geometric design, reads clearly at 48px size, no text, square"
icon_sup:    "Sci-fi tactical UI button icon, SUP support systems. Bold medical cross plus sign with circuit board trace lines branching from each arm, glowing blue on pure black background, minimal geometric design, reads clearly at 48px size, no text, square"
icon_atk:    "Sci-fi tactical UI button icon, ATK attack. Bold targeting reticle crosshair with circular lock-on ring, small tick marks at cardinal points, glowing red-orange on pure black background, minimal geometric design, reads clearly at 48px size, no text, square"
ship_assault: "Top-down aerial view of a near-future assault warship spacecraft, photorealistic, sleek aggressive angular hull with glowing cyan weapon ports and armor plating, dual forward-facing railgun barrels, bright blue-white engine exhaust plumes at rear, metallic surface with battle damage, pure black background, no text, centered"
ship_stealth: "Top-down aerial view of a near-future stealth submarine spacecraft, photorealistic, ultra-flat angular faceted stealth hull, matte dark surface with subtle blue-green bioluminescent running lights, minimal profile silhouette like a manta ray, hidden vectored thruster ports glowing faintly, pure black background, no text, centered"
ship_carrier: "Top-down aerial view of a near-future aircraft carrier mothership spacecraft, photorealistic, massive wide flat hull with visible drone launch bays and flight deck, glowing blue power conduits along hull, command tower structure, multiple engine nacelles glowing amber, pure black background, no text, centered"
enemy_corvette: "Top-down aerial view of an alien enemy corvette fast attack ship, photorealistic, menacing dark chitin-like hull with red-orange bioluminescent vein markings, sharp predatory forward profile, glowing red weapon arrays along flanks, organic-mechanical hybrid design, pure black background, no text, centered"
enemy_destroyer: "Top-down aerial view of an alien enemy heavy destroyer warship, photorealistic, massive angular armored hull with deep red-purple energy emitters, thick battle-scarred armor plating, multiple heavy gun turrets visible from above, glowing crimson power core at center, pure black background, no text, centered"
enemy_carrier: "Top-down aerial view of an alien enemy carrier mothership, photorealistic, enormous dark biomechanical hull, drone launch tubes visible across the surface, pulsing crimson power cores, asymmetric menacing silhouette, thick layered armor plating, pure black background, no text, centered"
enemy_fighter: "Top-down aerial view of a small alien enemy fighter drone spacecraft, photorealistic, compact aggressive delta-wing shape, razor-sharp leading edges, red glowing engine core, minimal profile, organic-tech hybrid design with glowing red markings, pure black background, no text, centered"
fx_explosion_big: "Large photorealistic space explosion in deep space, massive orange-white nuclear fireball with shockwave pressure rings, volumetric debris cloud with glowing fragments, high dynamic range bright core fading to dark smoke, centered composition, pure black background, no text"
fx_explosion_small: "Small photorealistic spacecraft impact explosion, bright flash of orange-white energy with small shrapnel debris cloud, glowing ember fragments radiating outward, compact intense burst, centered composition, pure black background, no text"
```

---

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
