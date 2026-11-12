# Dark Echo — 効果音(SE)制作指示書 第3版(全面見直し)

> 対象リポジトリ: `s1-1985/Dark-Higgs`(公開)
> 目的: ChatGPT に効果音を**全部作り直して**もらい、Claude(コード担当)がゲームへ組み込む。
> 前の版: `docs/SE_SPEC_v2.md`(第2版・今ゲームで鳴っている音の指示書)。**第3版はこの文書だけを正とする。**
> 表記: 「**事実**」= ゲームのコードや音声ファイルの計測で確認した内容 / 「**推論**」= 確認していない見立て。

---

## 0. 最初に読むこと

### 0.1 なぜ作り直すのか(オーナーの評価と計測の事実)

オーナー(ゲームの作者)の評価:
- 「軽い音が多い。**ポコン、鍋の底を叩いたような音**がちょいちょいある。そういうのはナシ」
- 「**UI選択の音が最悪**。全然かっこよくない。世界観に合っていない」
- 「**実弾はピストルじゃない。戦艦の大砲**なんだから、重低音が響く火薬多めの発砲音に」
- 爆発・ミサイル・ビーム・ソナーは「このままでもいい」が、**今回のコンセプトに沿ってもっと洗練**してほしい

第2版の音を計測した結果(**事実**・Claudeが全200音の周波数と減衰を測った):

| 群 | 計測で分かったこと | 聞こえ方(推論) |
|---|---|---|
| UI・確認音・探知の短い音(**54音**: `ui_*` 全部・`wpn_switch_*`・`wpn_lock_*`・`draft_*`・`drone_order_*`・`det_ident_*`・`det_fix_acquired`・`supply_done`・`loot_container`・`cap_done_*`・`alm_exposure_*` など) | エネルギーの**94〜100%が 250〜1500Hz**(中域だけ)・**150Hz未満は0%**・1.5kHz以上もほぼ無し・音の重心は **300〜700Hz**・ピークから−20dBまで **0.06〜0.3秒**で消える | 中域の正弦波がポンと鳴ってすぐ消える = **「ポコン」の正体** |
| 実弾の発砲 `wpn_kinetic_fire` | 長さ0.7秒・**ピークから−20dBまで0.18秒** | 鋭く短い = 拳銃・小銃の質感。大砲の「腹に来る余韻」が無い |
| 爆発・被弾・撃沈 | 150Hz未満が 30〜60%・減衰 0.5〜1.1秒 | 重さはある。方向性は合っている |
| ソナー | 基音が一定で長く伸びる(減衰 2〜5秒) | 方向性は合っている |

### 0.2 第3版のコンセプト: 「高く冷たい電子」か「低く重い金属」。**中域だけの音は作らない**

すべての音を、次の**2つの音域のどちらか(または両方の重ね)**で作る。

| 音域 | 何を想起させるか | 作り方の要素 |
|---|---|---|
| **H(高・冷)** 2kHz〜16kHz が主役 | SF・宇宙・電子・データ・ホログラム端末・センサー・暗号通信 | 鋭い過渡(クリック・トランジェント)、**シュッ/シャッという空気の擦れ(フィルタを掃くノイズ)**、デジタルの粒(ビットの瞬き・グラニュラー)、ガラスのような高い倍音、短いディレイの反射、ステレオの広がり |
| **L(低・重)** 25Hz〜250Hz が主役 | 巨大な戦艦・装甲・金属の質量・火薬・兵器・機関 | サブベースの圧(30〜60Hz の一瞬の膨らみ)、**金属の共鳴(大きな鋼板・船殻が鳴る、非整数倍音のうなり)**、軋み・ボルトの締まる音、油圧・機械の作動音、長い余韻 |

**中域(300Hz〜1.5kHz)の扱い**: 禁止ではない。ただし**中域を主役にしない**。H か L の芯がある上に、厚み・肉付けとして薄く足すだけ。**「中域の音程のある短い音」単体は不可**。

#### 絶対に出さないもの(第2版で出てしまったもの)
- **ポコン・ポン・ピコ・ボッ・プッ**: 中域の正弦波・三角波が短く鳴って消える音。マリンバ・木琴・鍋の底・空き缶・プラスチックを叩いた音。
- **かわいい・おもちゃ・スマホアプリの既定音**のような通知音。和音の「ピロン」。
- 8bit・チップチューン・レトロゲーム風。
- 銃声の「パン」「パンッ」だけで終わる軽い発砲音。
- 同じ音のピッチ違い・音量違いのコピーを別バリエーションにすること。
- 既存作品の音のサンプリング・模写(権利)。

### 0.3 UI(艦内端末)の音のお手本

オーナーの言葉: 「**メタルギアソリッドシリーズのUIの音は近未来的でクール**。アイコンをタップしてメニューが表示される時に **シュッ** みたいなクールな音が鳴ると雰囲気が出る」

**特定の作品の音を真似る・再現するのではなく**、その**質感の特徴**だけを借りる。目指す特徴:

1. **短く、乾いていて、精密**。軍用の電子機器・作戦端末の確認音。
2. **H帯域が主役**: 高いクリック(1〜3ms の鋭い立ち上がり)+ 1〜2kHz 以上のデジタルな瞬き + **フィルタを素早く掃くノイズの「シュッ」**(開く=上へ掃く・閉じる=下へ掃く)。
3. 下に**ごく短い低域の「トッ」**(60〜120Hz・20〜40ms)を重ねると、端末が「重い機械」に繋がっている感じが出る(L の芯)。
4. **音程のある旋律にしない**。音程感は「ピッ」の高さ(2kHz以上)程度に留める。
5. 開く/閉じる、ON/OFF、決定/取消、上げる/下げるは**対になる音**(同じ素材を逆向きに)。
6. 残響はほぼ無し(ごく短い金属の箱鳴り 30〜60ms まで)。

### 0.4 世界の違い(同じ出来事でも世界が違えば別の音)

| 世界 | 例 | 質感 |
|---|---|---|
| **A 艦内・船体伝播**(自艦に起きたこと) | 自艦の発射・被弾・撃沈・機関 | **L が太い**(30〜200Hz の振動)。鋼板の共鳴と軋み。「骨に響く」 |
| **B センサー受信**(遠く・見えない所) | 敵の探信・視界外の命中・信号の受信 | **H 寄りの電子音+帯域を絞った遠い L**。ノイズ・ヒス混じり。「耳をすませて拾う」 |
| **C 艦内端末UI** | ボタン・メニュー・切替 | §0.3。乾いた H +ごく短い L の芯 |

### 0.5 音の作り方の共通ルール

- **三層**: ①過渡(0〜50ms・鋭い)②胴(厚み)③尾(余韻・自然に消える)。重い音ほど②③を作り込む。**UI は①が主役で③はごく短く**。
- **L の音は 100〜250Hz にも成分を入れる**(スマホのスピーカーでは 100Hz 未満がほぼ出ない — 推論。30〜80Hz の圧は「ある端末では感じる」おまけ。**重さの本体は 80〜250Hz の胴と金属の共鳴で作る**)。
- 金属感は**共鳴・軋み・うなり(ビート)**で作る。ノイズだけで作らない。
- 尾は切らない。必ず自然に消える。
- バリエーションは**短い間隔で何度も鳴る音だけ**(表の「数」欄)。別テイク(音色・衝撃の質が聞き分けられる)にする。

---

## 1. ファイル仕様

| 項目 | 指定 |
|---|---|
| 形式 | **WAV(PCM 16bit)・48kHz** |
| チャンネル | モノラル。**ステレオ可**: `amb_*`・`sonar_*`・`expl_large`・`ship_*`・`sys_*`・`ui_panel_*`・`ui_menu_*`・`alm_hack_*`・`env_*` |
| ピーク | 下表。**トゥルーピーク −1dBFS 以下・クリップ禁止** |
| 先頭 | 5ms 以内に音が始まる |
| 終端 | 単発は自然に0へ減衰(クリックなし) |
| ループ | ファイル名が `_loop`。繋ぎ目でクリックが出ない(始端と終端をクロスフェード)。1周 = ファイル長 |
| 残響 | **「尾込み」と書いた音は空間の残響を含めて書き出す**(ソナー・大爆発・撃沈・大砲の余韻)。それ以外は乾いたまま(ゲーム側の残響は 0.1〜0.2 秒しか足せない) |
| 命名 | `<ID>.wav`。バリエーションのある音だけ `<ID>_1.wav` `<ID>_2.wav` … |

### 1.1 音量(ファイルのピーク)

| 区分 | ピーク | 例 |
|---|---|---|
| 最大 | −1 dBFS | 撃沈・大爆発・自艦のミサイル直撃 |
| 大 | −3 dBFS | 自艦の発射・被弾・ビーム・ソナー |
| 中 | −6 dBFS | 爆発の小〜中・警報・ドローン |
| 小 | −9 dBFS | 探知・受信・アイテム |
| 極小 | −12 dBFS | UI |
| 環境ループ | 統合 −26 LUFS 前後 | `amb_*` |

**UI は小さく作るが、スマホで聞こえるよう H 帯域の過渡ははっきり**(極小でも 2〜5kHz のクリックは埋もれにくい — 推論)。

---

## 2. 納品の仕方(第2版と同じ方式)

1. **ZIP で納品**: `Dark-Higgs_SE_v3_Part01.zip`、`…_Part02.zip` …(1つ 50MB 以内)。中身は WAV と `list_PartNN.txt`(1行1音: `ID<TAB>ファイル名<TAB>長さ秒<TAB>ステレオ/モノ<TAB>一言メモ`)。
2. オーナーが ZIP を Claude に渡す。Claude が MP3 に変換し `prototype/assets/sfx_v3/` に置いて、台帳(manifest)を作る。**ChatGPT はリポジトリに書き込まなくてよい**。
3. 納品の順: **P0 → P1 → P2**(§3 の各表の「優」欄)。Part ごとに優先度が混ざってもよい。
4. ゲームは「第3版にある音は第3版・まだ無い音は第2版」で鳴らす。**途中まで納品しても試せる**。オーナーがメニューの「SE: 第3版 / 第2版」でいつでも元に戻せる(ロールバック)。
5. 作り直し: 同じ ID の WAV を次の Part に入れれば上書きする。

### 2.1 納品前の自己点検
1. WAV / 48kHz / 16bit。ピーク・クリップ・DCオフセット。
2. **中域だけの音になっていないか**: 各音の主なエネルギーが H(2kHz以上)か L(250Hz以下)にあるか。**UI を 1 秒ごとに 10 個並べて聴き、1つでも「ポコン」に聞こえたら作り直す**。
3. 実弾の発砲は**ピークから −20dB まで 0.6 秒以上**の余韻があるか(大砲の腹鳴り)。
4. ソナーは音程が下がっていないか。
5. ループの繋ぎ目(2 周連結して聴く)。
6. バリエーションが別テイクか。

---

## 3. SE 一覧と制作指示

凡例: **ID** | **鳴る場面** | **音の作り方** | **秒** | **域**(H/L/HL)| **数**(単=単発・ル=ループ・数字=ファイル数)| **優**(P0/P1/P2)
「**新**」= 第3版で増えた音(ゲーム側の割り当ては納品後に Claude が行う)。
**ID の省略**: `sonar_omni_weak` / `_mid` / `_strong` のように `_` で始まる ID は、前の ID の最後の語を置き換えた別の ID(= `sonar_omni_mid`・`sonar_omni_strong`)。`ui_level_1`〜`ui_level_4` は 1・2・3・4 の4つ。**全 ID の一覧は付録A**(これで数え漏れを点検する)。

### 3.1 UI・艦内端末(世界C)— **全部作り直し・最優先**

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `ui_tap` | 一般のボタン・アイコンを押した | 高く鋭いクリック(3〜6kHz・2ms)+ 2kHz 付近のごく短いデジタルの瞬き + 下に 80Hz の小さな「トッ」(25ms)。乾いて精密 | 0.08 | HL | 3 | P0 |
| `ui_select` | 選択肢・モード・目標などを選んだ | `ui_tap` より一段はっきり: 二重のクリック(10ms 間隔)+ 高い短い電子音の「チッ」+ 低い「トッ」 | 0.12 | HL | 2 | P0 |
| `ui_confirm` | 決定・実行 | 上へ短く掃くノイズ(0.06秒)→ 鋭いクリックで止まる。最後に 60〜90Hz の短い圧。「確定した」 | 0.2 | HL | 1 | P0 |
| `ui_cancel` | 取消・戻る | `ui_confirm` の逆: 下へ短く掃くノイズで消える・クリックは控えめ | 0.18 | HL | 1 | P0 |
| `ui_deny` / `ui_error` | 押せない・使えない・条件不足 | 2連の低い電子ブザー(**矩形波は不可**・帯域ノイズを 150Hz と 2.5kHz でゲートした「ザッザッ」)。不快すぎない | 0.3 | HL | 各1 | P0 |
| `ui_open` | ポップオーバー・小さな窓が開く(右列のアイコン → 選択肢が出る) | **「シュッ」**: 白色ノイズをバンドパス 1.5→7kHz へ素早く掃く(80ms)+ 終わりに高い小さなクリック(画面が展開し終わった)。ステレオで少し広がる | 0.15 | H | 1 | P0 |
| `ui_close` | ポップオーバーが閉じる | `ui_open` の逆: 7→1.5kHz へ下へ掃いて吸い込まれる | 0.13 | H | 1 | P0 |
| `ui_panel_open` **新** | 大きな画面(メニュー・積み込み・ドック・リプレイ・試合の記録)が開く | 長めの「シューッ」(0.25秒・上へ掃く)+ 走査線が走るような細かいデジタルの粒 + 着地の低い「ドッ」(60Hz・40ms) | 0.4 | HL | 1 | P0 |
| `ui_panel_close` **新** | 大きな画面が閉じる | `ui_panel_open` の逆(下へ掃く・最後の圧なし) | 0.3 | H | 1 | P0 |
| `ui_longpress_menu` | 地図を長押しして指示メニューが出る | 0.5秒溜めた後に出るので「起動」の感じ: 低いうなり(80Hz)が 50ms 立ち上がり → `ui_open` の「シュッ」 | 0.25 | HL | 1 | P0 |
| `ui_fab_open` / `ui_fab_close` **新** | 右下の丸ボタンが展開する / 閉じる | 小さな機械が展開する: 2〜3 連の細かいクリック(ラチェット)+ 短い掃くノイズ。閉じるは逆順 | 0.2 | H | 各1 | P1 |
| `ui_tab` **新** | タブの切り替え(デバッグ・リプレイの席・積み込みの分類) | 横へ滑る短い「シャッ」(高域ノイズ・30ms)+ クリック | 0.08 | H | 1 | P1 |
| `ui_toggle_on` / `ui_toggle_off` | ON/OFF の切り替え | ON = 上がる2つのクリック + 電源が入る短いハム(上昇)/ OFF = 下がる2つのクリック + ハムが落ちる | 0.15 | HL | 各1 | P0 |
| `ui_level_1`〜`ui_level_4` | 段階の切り替え(センサーの感度 弱/中/強、AIの解析力など) | **同じ素材で段階が上がるほど明るく・厚く**: 1 = 低い「トッ」+ 細いクリック / 2 = + 高い瞬き / 3 = + 短い上昇の掃き / 4 = + 二重の瞬き。旋律にしない | 0.15 | HL | 各1 | P0 |
| `ui_slider_tick` | スライダーを動かす目盛り | ごく小さな高いクリック(4〜8kHz・1ms) | 0.03 | H | 1 | P1 |
| `ui_warn` | 注意(画面の注意書き) | H の短い警告の瞬き 2 回 + 下に低い 1 回のうなり | 0.4 | HL | 1 | P1 |
| `ui_log_warn` | AI の助言で注意が出た | 通信が入る「ザッ」(短いノイズ・帯域を絞る)+ 高い 1 回の瞬き | 0.25 | H | 1 | P1 |
| `ui_ai_msg` **新** | AI の助言が新しく出た(通常) | ごく小さなデータの着信: 3 連の細かいデジタルの粒(上昇)。邪魔にならない小ささ | 0.12 | H | 1 | P1 |
| `ui_sensor_band_on` **新** | センサーの帯域を ON(弱)にした | 受信機が起動する: 高いノイズの「サッ」+ ヒスが一瞬開く + 低い「トッ」 | 0.2 | HL | 1 | P0 |
| `ui_sensor_all_off` **新** | センサーを全部 OFF にした(何も聴こえなくなる) | 受信のヒスが下へ閉じて**完全に無音になる**感じ + 低く重い「ドン」1つ(遮断) | 0.4 | HL | 1 | P1 |
| `ui_focus_change` **新** | 航行モード(配分の重点)を変えた | 艦内の配電が切り替わる: 低いハムの音程が滑る(80→110Hz・0.2秒)+ リレーのクリック 2 つ | 0.3 | L+H | 1 | P1 |
| `ui_sonar_band` **新** | ソナーの帯域(熱/光/電磁波/ヒッグス)を選んだ | 高いクリック + 帯域を絞る短い掃き。選ぶたびに鳴る | 0.1 | H | 1 | P1 |
| `ui_sonar_power` **新** | ソナーの出力(弱/中/強)を切り替えた | 充電音の段階: 低いハム + 高いコンデンサの「キュッ」が段階で強くなる(1ファイル。ゲーム側で音程を変えない) | 0.25 | HL | 1 | P1 |
| `ui_lock_cycle` **新** | ロックする目標を次へ切り替えた | 照準が滑る: 高い短い掃き + 照準器のクリック 2 つ | 0.12 | H | 1 | P1 |
| `ui_combat_bar` **新** | 画面下の戦闘メニューが出た | 戦闘態勢の端末が立ち上がる: 低い「ドッ」+ 高い走査の「シャッ」 | 0.25 | HL | 1 | P2 |
| `ui_tag_tap` **新** | 地図の信号の名札・推定円をタップ | `ui_select` の小さい版 + センサーの「ピッ」(3kHz・10ms) | 0.08 | H | 1 | P1 |
| `sys_pause_on` / `sys_pause_off` | 一時停止 / 再開 | ON = 全体が止まる: 下へ掃いて低い「ドン」/ OFF = 上へ掃いて動き出す | 0.35 | HL | 各1 | P1 |
| `sys_speed_up` / `sys_speed_down` | 倍速を上げる / 下げる | 機関の回転が上がる/下がる短いうなり(L)+ 高いクリック | 0.25 | HL | 各1 | P1 |
| `sys_report_open` | 作戦報告が開く | `ui_panel_open` に通信の着信の粒を足した版 | 0.6 | HL | 1 | P2 |

### 3.2 自艦の兵装(世界A)

> **実弾 = 戦艦の主砲・艦砲**。ピストル・小銃・機関銃ではない。「**ドォォン**」と腹に来る火薬の爆轟、砲身の金属が鳴る、船体が反動で軋む、余韻が長く尾を引く。攻撃型は**3連装**で、1回の発射 = 3門がほぼ同時(約0.08秒ずれ)に撃つ。

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `wpn_kinetic_fire` | 実弾を撃った(3連装の斉射) | ①砲口の爆轟(鋭い過渡・広帯域)②**火薬の燃焼の「ドォッ」(40〜150Hz の太い胴)**③砲身・砲塔の鋼が鳴る共鳴(200〜400Hz のうなり・短め)④船体に伝わる反動の軋み ⑤**長い余韻**(大きな空間の残響・1.5秒以上)。3 門を 0.06〜0.1 秒ずらして重ねた 1 ファイル。ピークから −20dB まで **0.6 秒以上**。**「パン」だけで終わらない** | 2.0 | L+H | 3(尾込み) | P0 |
| `wpn_pd_fire` | 実弾で敵のミサイルを迎撃する(近距離の速射) | 主砲より軽いが重さは残す: 機関砲の速い 4〜5 連(各発に 80〜150Hz の胴)+ 薬莢・機構の金属音(H) | 0.6 | L+H | 2 | P1 |
| `wpn_reload_kinetic` | 実弾の再装填 | 重い機械の装填: 油圧の作動(低いうなり)→ 砲弾が薬室に押し込まれる重い金属の「ガシャン」→ 閉鎖の「ガチン」 | 1.0 | L | 1 | P1 |
| `wpn_missile_launch` | ミサイル発射 | **今の方向性は維持して洗練**: ①発射筒からの圧縮ガスの低い「ドムッ」(L)②0.15 秒後にロケットモーター点火の轟音(広帯域の燃焼・L の胴+ H の噴流のシャー)③遠ざかりながら細くなる。船体を一瞬震わせる | 2.5 | L+H | 1(尾込み) | P0 |
| `wpn_missile_launch_ai` | AI 誘導ミサイル発射 | 上と同じ発射 + 誘導装置が起動する H の電子的な走査音(上昇)が重なる | 2.5 | L+H | 1(尾込み) | P1 |
| `wpn_reload_missile` | ミサイルの再装填 | 重いラックの移動(L の機械音)→ 発射筒への装填の金属の「ゴトン」→ ロックの音 | 1.2 | L | 1 | P2 |
| `wpn_beam_charge` | ビームのチャージ(10 秒溜める・ゲーム側で必要な長さまで繰り返す) | **洗練**: 巨大なコンデンサへ充電する低いうなり(L・ゆっくり上昇)+ H の電離のパチパチ・高い共鳴の鳴き(上昇)。不安を煽る | 2.0 | L+H | ル1 | P0 |
| `wpn_beam_fire` | ビーム発射(照射は 6 秒) | **洗練**: 解放の衝撃(L の「ドッ」)→ 太い照射のうなり(L の胴 + H の電離の擦れ)→ 減衰。重さと SF の両立 | 3.0 | L+H | 1(尾込み) | P0 |
| `wpn_beam_ready` | ビームの再充電が終わった | 低い充電完了のうなり + H の小さな「キン」 | 0.8 | L+H | 1 | P2 |
| `wpn_empty` | 弾切れで撃てない | 撃鉄が空を打つ重い金属の「ガチッ」+ 低い 1 回の機械音。**ポコン不可** | 0.3 | L | 1 | P1 |
| `wpn_switch_kinetic` / `wpn_switch_missile` / `wpn_switch_beam` | 兵装の切替 | 武器の系統が切り替わる: 実弾 = 重い金属のセレクター「ガチャッ」/ ミサイル = 発射管の扉が開く油圧の「シュコッ」/ ビーム = コンデンサが繋がる H の「キュイッ」+ L のハム | 0.3 | L/H | 各1 | P0 |
| `wpn_lock_acquire` | 目標をロックした | 照準器が掴む: 高い走査の 2 連「ピピッ」(3kHz 以上・音程は一定)+ 低い 1 回の機械の噛み合い | 0.3 | HL | 1 | P0 |
| `wpn_lock_release` | ロックを外した | 走査が下へ消える + 機械が外れる軽い音 | 0.2 | H | 1 | P1 |
| `wpn_mine_place` | 機雷を置いた | 重い物体を船外へ押し出す油圧 + 切り離しの金属音 | 0.8 | L | 1 | P2 |
| `wpn_mine_blast` | 機雷の爆発 | `expl_medium` の系統 + 金属の破片 | 1.8 | L+H | 1(尾込み) | P1 |

### 3.3 自艦が被弾(世界A)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `hit_player_kinetic` | 自艦が実弾を受けた | 砲弾が装甲を叩く重い金属の打撃(L の胴)+ 装甲板が鳴る共鳴 + 破片の H | 0.6 | L+H | 3 | P0 |
| `hit_player_missile` | 自艦がミサイルの直撃 | **洗練**: 爆発の衝撃が船殻を伝わる(サブベースの圧)+ 鋼板が歪む軋み + 内部の何かが壊れる金属音 + 長い余韻 | 3.0 | L+H | 1(尾込み) | P0 |
| `hit_player_beam` | 自艦がビームを受けた | 装甲が焼かれる: H の灼ける「ジュアッ」+ 金属が膨張して軋む L + 内部の電気系の火花 | 2.5 | L+H | 1 | P0 |
| `hit_player_beam_graze` | ビームが至近をかすめた | H の電離の擦れが通り過ぎる + 遠い L のうなり | 1.0 | H+L | 1 | P1 |
| `hit_player_blast_near` | ミサイルの近接爆発の破片 | 小石が鋼板を叩く H の雨 + 遠い L の衝撃 | 1.6 | L+H | 1 | P1 |
| `hit_player_ambush` | 奇襲を受けた(気付かない所から) | 不意の巨大な衝撃(L の圧が強い)+ 警報が一瞬鳴りかける | 1.2 | L | 1 | P1 |
| `hit_player_rear` | 後方(機関部)に被弾 | 機関が咳き込む L の不調音 + 金属の打撃 | 0.6 | L | 1 | P1 |
| `hit_player_drone_gun` | 敵の戦闘機・Tech の機銃を受けた | 装甲に小口径の弾が当たる連続の金属音(H 寄り・ただし各発に小さな L の胴) | 0.4 | H+L | 2 | P1 |
| `hit_player_saber` | Tech のビームサーベルで斬られた | H の灼き切る「ジュッ」+ 鋼板が裂ける L | 0.8 | H+L | 1 | P1 |

### 3.4 自機の攻撃が命中(見えている所・世界A〜B)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `hit_enemy_kinetic` | 自機の実弾が敵艦に当たった(見えている) | 遠くで鋼が叩かれる「ガァン」(L の胴 + 金属の共鳴)。自艦の被弾より遠く・丸い | 0.5 | L | 2 | P0 |
| `hit_enemy_missile` | 自機のミサイルが命中 | 遠景の爆発(L)+ 遅れて届く低い余韻 | 2.0 | L | 1(尾込み) | P0 |
| `hit_enemy_beam` | 自機のビームが命中 | 遠くで装甲が灼ける H + 低い爆ぜ | 2.0 | L+H | 1 | P0 |
| `hit_enemy_drone` | 敵の戦闘機・Tech・哨戒機に当たった | 小さな機体が叩かれる金属の H + 小さな L | 0.3 | H+L | 2 | P1 |
| `hit_enemy_saber` | 自機の Tech のサーベルが当たった | `hit_player_saber` の遠景版 | 0.8 | H+L | 1 | P2 |

### 3.5 視界の外の命中をセンサーで探知(世界B)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `det_impact_kinetic` / `det_impact_missile` / `det_impact_beam` | 遠くで何かに当たった光・熱を受信 | センサーが拾った遠い閃光: H の受信の「チリッ」+ 帯域を絞ったごく遠い L の鈍い衝撃。ミサイル=L が大きい・ビーム=H の電離が長い・実弾=短い | 1.0 | H+L | 各1 | P1 |
| `det_impact_unsure` | 何に当たったか分からない | 上より曖昧: ノイズの中に埋もれた鈍い衝撃 | 1.0 | H+L | 1 | P2 |

### 3.6 迎撃・爆発・撃沈(世界A)— **今の方向性は維持して洗練**

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `pd_intercept_hit` | 迎撃でミサイルを撃ち落とした | 空中で弾頭が砕ける H の破裂 + 小さな L | 0.8 | H+L | 1 | P1 |
| `pd_intercept_miss` | 迎撃が外れた | 機関砲の弾が空を切る H の擦れ(遠ざかる) | 0.5 | H | 1 | P2 |
| `pd_missile_lost` | ミサイルが誘導を失った | 推進が乱れる不安定な H のうなり | 0.8 | H | 1 | P2 |
| `expl_small` / `expl_medium` / `expl_large` | 爆発(小・中・大) | 大きさで L の圧と余韻の長さを変える。小 = 鋭い破裂 + 短い L / 中 = 太い L + 破片 / 大 = 地響きのような長い L + 遠くへ広がる余韻(ステレオ) | 0.9 / 2.0 / 3.5 | L+H | 各1(尾込み) | P0 |
| `ship_destruct_start_enemy` | 敵艦の崩壊が始まる | 船殻が引き裂かれる長い金属の軋み(L)+ 内部の誘爆の始まり | 2.5 | L | 1 | P1 |
| `ship_blast_chain` | 崩壊中の誘爆(何度も鳴る) | 船体の中で連続する小爆発(L)+ 金属の破片 | 1.0 | L+H | 3 | P1 |
| `ship_blast_final_enemy_small` / `_medium` / `_large` | 敵艦の最終爆発(艦の大きさ別) | 機関部の誘爆: 巨大な L の膨張 + 衝撃波の H + 長い余韻 | 2.0 / 3.0 / 4.0 | L+H | 各1(尾込み) | P0 |
| `ship_death_player_start` | 自艦の崩壊が始まる | 艦内から聞こえる: 船殻が裂ける軋み・警報が歪んで途切れる・空気が抜ける H | 3.5 | L+H | 1(尾込み) | P0 |
| `ship_blast_final_player` | 自艦の最終爆発 | 全てを飲み込む L + 白飛びするような H の衝撃 + 静寂へ消える長い尾 | 5.0 | L+H | 1(尾込み・ステレオ) | P0 |

### 3.7 ソナー(世界B)— **今の方向性は維持して洗練**

> 基本: 宇宙の闇に放たれる、**音程が一定のまま長く伸びる冷たい金属の「ピーーン」**(尾込み・ステレオ)。第3版では**出だしに L の「圧」(40〜80Hz の一瞬の膨らみ)を全出力に**入れ、巨大な艦から打ち出された重さを足す。基音は H 寄り(弱 1.4kHz・中 1.2kHz・強 1.0kHz)。音程を下げて尻すぼみにしない。

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `sonar_omni_weak` / `_mid` / `_strong` | 全周囲ソナー(出力 弱/中/強) | 上記。強ほど L の圧が大きく尾が長い | 3.0 / 4.5 / 6.5 | H+L | 各1 | P0 |
| `sonar_dir_weak` / `_mid` / `_strong` | 指向性ソナー | 出だしに 0.15 秒の「ビームを絞る」H の収束 → 細く真っすぐ伸びる。全周囲より尾は短い | 2.0 / 3.0 / 4.0 | H+L | 各1 | P0 |
| `sonar_echo_return` | 反響が返った | 打った音の小さく遠い写し(高域を丸く) | 2.0 | H | 1 | P1 |
| `sonar_ready` | ソナーの再充電完了 | **ポコン不可**: 低い充電完了のうなり(L)+ 高い小さな「キン」(H)。控えめ | 0.5 | L+H | 1 | P1 |
| `sonar_scout_ping` | 哨戒機が探信した | 全周囲より小さく遠い・基音 1.8kHz | 2.2 | H | 1 | P2 |
| `alm_ping_omni` | 敵の全周囲探信を受けた | 同じ系統で**基音が低く(0.8kHz)冷たく不穏**・壁越し | 4.5 | H+L | 1 | P0 |
| `alm_ping_dir` | 敵の指向性ソナーを受けた | 上に鋭い立ち上がり。こちらを向いて撃たれた | 3.0 | H+L | 1 | P0 |

### 3.8 探知・警報・兆候(世界B)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `det_rx_heat` / `det_rx_optic` / `det_rx_em` / `det_rx_higgs` | 新しい信号を初めて受けた(帯域別) | 静かな中に浮かぶ受信のブリップ。**帯域で質感を変える**(中域の音程で差をつけない): 熱 = 低いうねり(L)+ ヒス / 光 = 高いガラスの瞬き(H)/ 電磁波 = デジタルの粒の雑音(H)/ ヒッグス = 深い低いうなりが歪む(L) | 0.6 | H/L | 各1 | P1 |
| `det_fix_acquired` | 推定位置が絞れた | データが確定する: H の 3 連の上昇する粒 + 低い 1 回の「トッ」 | 0.4 | HL | 1 | P1 |
| `det_ident_ship` | 信号を艦影と識別 | 重い確信: L のうなりの 1 打 + H の短い警告の瞬き | 0.6 | L+H | 1 | P1 |
| `det_ident_decoy` | 囮と見抜いた | H の短い下降の掃き(拍子抜け)+ 小さな L | 0.4 | H | 1 | P2 |
| `det_ident_nature` | 自然の信号と判明 | 柔らかい H の「サッ」(聞き流す) | 0.4 | H | 1 | P2 |
| `det_wake_found` | 航跡を見つけた | 霧の乱れを拾う低いうねり(L)+ H のヒス | 0.6 | L+H | 1 | P2 |
| `det_loot_trace` | 空き巣の跡を見つけた | 小さな H の走査 + 遠い L | 0.5 | H | 1 | P2 |
| `det_convoy_iff` | 輸送船の識別信号 | 民間の識別ビーコン: 規則的な H のパルス 3 つ(音程は一定・高い) | 0.8 | H | 1 | P2 |
| `det_trap_revealed` **新** | 偽コンテナ(罠)を見抜いた | 危険の発見: H の鋭い 2 連 + 低い警告のうなり | 0.6 | HL | 1 | P1 |
| `det_visual_negative` **新** | 推定位置を目視したら何も居なかった | 空振り: H の走査が下へ抜けて消える | 0.4 | H | 1 | P2 |
| `alm_missile_launch_detect` | 敵のミサイル発射を探知 | 遠い点火の L + H の警告の瞬き | 1.0 | L+H | 1 | P0 |
| `alm_missile_warn_loop` | 敵ミサイル接近中(ループ) | 低く抑制された警報: L の脈動(1 秒周期)+ H の短い走査。不快すぎず緊張 | 2.0 | L+H | ル1 | P0 |
| `alm_missile_warn_close_loop` | ミサイルが至近(ループ) | 上の 2 倍の速さ・H がより鋭い | 1.0 | L+H | ル1 | P1 |
| `alm_fc_lock_loop` / `alm_fc_lock_fast_loop` | 敵の照準波を受けている(通常 / 至近) | 電子的なロック警告: H の断続音(音程一定・2〜3kHz)+ 下に L のうなり。fast は間隔が短い | 2.0 / 1.0 | H+L | 各ル1 | P0 |
| `alm_beam_charge_detect` | 敵のビームの高エネルギー反応 | 巨大なエネルギーが溜まる遠い L のうなり(上昇)+ H の電離のパチパチ。画面の紫の脈動と一緒に鳴る | 2.0 | L+H | 1 | P0 |
| `alm_exposure_1` / `_2` / `_3` | 兆候の段階が上がった(受信 / 照射 / 攻撃) | **ポコン不可**。段階が上がるほど L が太く H が鋭い警報: 1 = 遠い L の 1 打 + H のヒス / 2 = L の 2 打 + H の走査 / 3 = 重い L の 3 打 + 鋭い H | 0.6 / 0.8 / 1.0 | L+H | 各1 | P1 |
| `alm_heartbeat` | 緊張の心音 | 低い心音(L・40〜80Hz)の 2 拍。艦の中で自分の鼓動が聞こえる | 1.0 | L | 1 | P2 |
| `alm_hull_50` / `alm_hull_25` | 耐久 50% / 25% を切った | 船体の警報: 重い L の唸り + H の警告の断続。25% はより切迫 | 1.2 | L+H | 各1 | P1 |
| `alm_ambush_success` | 自機の奇襲が成功 | 決まった手応え: 重い L の 1 打 + 低く伸びる余韻(派手にしない) | 0.8 | L | 1 | P2 |
| `alm_colony_lost` | 自分のコロニーを奪われた | 通信が途絶する H のノイズ + 低い L の落ち込み | 1.2 | L+H | 1 | P1 |
| `alm_drone_link_lost` / `alm_drone_link_restore` | ドローンとの通信が途絶 / 回復 | 途絶 = H のノイズが砂嵐になって切れる / 回復 = H のノイズが晴れて同期する粒(上昇) | 0.6 | H | 各1 | P1 |
| `alm_distress_signal` / `alm_distress_false` | 遭難信号を受信 / 偽だった | 受信 = 遠い規則的な H のパルス(音程一定)/ 偽 = パルスが歪んで崩れる | 1.2 / 0.6 | H | 各1 | P2 |
| `alm_surge_warn` / `alm_lull_warn` | ヒッグスのサージ / 凪の予兆 | サージ = L の低いうなりが膨らむ + H の電離 / 凪 = 全体が静まり H のヒスが細くなる | 2.0 | L+H | 各1 | P2 |
| `alm_hack_probe` **新** | 自機のドローンが通信を探られた(母艦の方角を知られた) | H の不正なデータの粒が走る + 低い 1 回の警告 | 0.6 | H | 1 | P1 |
| `alm_hack_intrusion_loop` **新** | **侵入されている間**(画面にノイズが走る) | デジタルの干渉: H のグリッチ(切れ切れのビットノイズ・ステレオで左右に揺れる)+ L の不規則なうなり。侵入が進むほどゲーム側で音量を上げる | 2.0 | H+L | ル1(ステレオ) | P0 |
| `alm_drone_hijacked` **新** | 自機のドローンを奪われた | 通信が乗っ取られる: H のグリッチが一気に崩れ、低い L で切断 | 1.0 | H+L | 1 | P1 |

### 3.9 状態異常(世界A)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `alm_status_fcs` | 火器管制ダウン | 照準系が落ちる: H の電子音が途切れて消える + L の電源断 | 0.8 | H+L | 1 | P1 |
| `alm_status_engine` | 機関損傷 | 機関の L のうなりが咳き込み、低く沈む | 1.0 | L | 1 | P1 |
| `alm_status_halt` **新** | 機関停止(ハックされて推力ゼロ) | 主機が落ちる: L のうなりが下へ滑って止まる + 静寂の中の H のヒス | 1.2 | L+H | 1 | P1 |
| `alm_status_sensor` | センサー損傷 | 受信のヒスが白飛びして潰れる(H)+ L | 0.8 | H | 1 | P1 |
| `alm_status_daze` | センサー撹乱 | H のノイズがうねる | 0.8 | H | 1 | P2 |
| `alm_status_comm` | 通信障害 | 通信の H のノイズが途切れ途切れに | 0.8 | H | 1 | P2 |
| `alm_status_burn` | 延焼 | 船内で燃える L のごうごう + 金属の爆ぜ | 1.0 | L | 1 | P2 |
| `alm_status_recover` | 状態異常が回復 | **ポコン不可**: 系統が復帰する H の上昇する粒 + L の起動のハム | 0.5 | HL | 1 | P2 |

### 3.10 電子戦(ハック・ジャミング)— **全部新規**

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `ew_hack_wave_fire` **新** | ハック波を撃った(細い扇・大量の電磁波) | 強力な電子の照射: H の圧縮されたデータのバースト(ザザッ・高速のビット列)が一方向へ放たれる + L の発信器のうなり | 1.0 | H+L | 1 | P0 |
| `ew_hack_miss` **新** | ハック波が外れた(応答なし) | 何も返ってこない: H の残響が空しく消える | 0.6 | H | 1 | P2 |
| `ew_hack_intrude_loop` **新** | **こちらが侵入している間**(リンク維持中) | 暗号を解いていくデータ処理: H の規則的な粒(早い)+ L の低い演算のうなり。`alm_hack_intrusion_loop` より整然としている | 2.0 | H+L | ル1 | P1 |
| `ew_hack_success` **新** | 侵入に成功(相手の機能を奪った) | 錠前が開く: H のデータが一気に揃う上昇 + L の重い「ガチン」 | 0.8 | HL | 1 | P0 |
| `ew_hack_fail` **新** | 侵入が弾かれた | H のデータが弾かれて散る + L の拒絶の 1 打 | 0.6 | HL | 1 | P1 |
| `ew_hack_cut` **新** | 回線が切れた(距離・濃い霧・断線パルス) | H の回線が引き千切られる「ブツッ」+ 短い砂嵐(ただし過渡は鋭く) | 0.4 | H | 1 | P1 |
| `ew_linkcut` **新** | 断線パルスを使った | 強い電磁パルス: H の衝撃波の広がり + L の「ドン」 | 0.8 | H+L | 1 | P1 |
| `ew_drone_hack_omni` **新** | ドローン侵入の全周囲の波を出した | 周りへ広がる H のデータの波(ステレオで左右へ)+ L | 1.0 | H+L | 1 | P1 |
| `ew_drone_captured` **新** | 敵のドローンを奪って自分のものにした | H の同期が完了する粒 + 自機の系統に繋がる L のハム | 0.8 | HL | 1 | P1 |
| `ew_jam_area` **新** | 範囲ジャミング(6 秒) | 広帯域の H の妨害ノイズが一気に広がる + L の発信 | 1.5 | H+L | 1 | P1 |
| `ew_jam_cont_loop` **新** | 継続 EM ジャム(ON の間) | 一定の H のザー(うねりを含む)+ 低い L の発信器 | 2.0 | H+L | ル1 | P2 |
| `ew_emp_pulse` **新** | EM パルス(半径 6000u) | 巨大な電磁の衝撃: L の圧 + H の白い破裂 + 電子機器が一瞬落ちる静寂 | 1.5 | L+H | 1 | P1 |

### 3.11 機動・エンジン(世界A)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `eng_hum_thermonuclear_loop` | 熱核エンジン(推進中) | 重い炉と噴射の L の唸り + 高温の H の噴流。最も力強い | 4.0 | L+H | ル1 | P1 |
| `eng_hum_pulse_loop` | EM エンジン | 断続的な電磁の L の脈動(2.5 秒周期と合わせなくてよい)+ H の電気の唸り | 4.0 | L+H | ル1 | P1 |
| `eng_hum_higgs_loop` | ヒッグスエンジン | 霧を吸って押す深く歪んだ L のうねり + H の粒のざわめき | 4.0 | L+H | ル1 | P1 |
| `eng_hum_photon_loop` | フォトンエンジン | 静かで澄んだ H の高い光の唸り + 細い L | 4.0 | H+L | ル1 | P1 |
| `eng_stance_silent` / `_cruise` / `_flank` | 出力 潜航 / 巡航 / 全速 | 潜航 = L が下へ沈み静かに / 巡航 = 安定した L / 全速 = L が吠えて上がる + H の噴流 | 0.8 | L | 各1 | P1 |
| `eng_boost_start` | 緊急噴射 | 巨大な点火: L の爆発的な推力 + H の噴流の轟音 | 1.5 | L+H | 1 | P1 |
| `eng_boost_overheat` | 機関の過熱 | 金属が熱で軋む L + 警告の H | 1.0 | L+H | 1 | P2 |
| `eng_coast_on` | 機関停止(惰性) | 主機が落ちて L が消え、静寂の H のヒスだけが残る | 1.2 | L | 1 | P1 |
| `eng_restart` | 再点火 | L の点火 + うなりが立ち上がる | 1.0 | L | 1 | P2 |
| `eng_switch_start` / `eng_switch_done` | エンジン切替の開始 / 完了 | 開始 = 炉を落とす L + 切替機構の H / 完了 = 新しい炉が点火する L | 1.0 | L+H | 各1 | P1 |

### 3.12 ドローン

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `drone_launch_fighter` | 戦闘機の射出 | カタパルトの L の「ドンッ」+ 小さな機体の噴射 H が離れていく | 1.2 | L+H | 1 | P1 |
| `drone_launch_scout` | 哨戒機の射出 | 上より軽い射出 + H のセンサーが起動する粒 | 1.0 | L+H | 1 | P2 |
| `drone_deploy_turret` / `_barrier` / `_buoy` | 砲台・バリア・ブイを据えた | 重い物体を押し出して固定する L の機械音 + 起動の H(バリア = 力場の H のうなり) | 1.0 | L+H | 各1 | P2 |
| `drone_fire_fighter` | 戦闘機の機銃 | 小口径の速射: H の鋭い連射 + 各発に小さな L(軽いパンパンにしない) | 0.4 | H+L | 2 | P1 |
| `drone_tech_rifle` | Tech の小銃 3 連射 | 大型の人型兵器の小銃: L の胴が太い 3 連 | 0.6 | L+H | 2 | P1 |
| `drone_tech_missile` | Tech の肩のミサイル | 小型ミサイルの発射(`wpn_missile_launch` の小型版) | 1.2 | L+H | 1 | P2 |
| `drone_tech_dash` | Tech の突進 | 推進器の爆発的な噴射 L + H | 0.8 | L+H | 1 | P2 |
| `drone_saber_ignite` / `drone_saber_slash` | サーベルの起動 / 斬撃 | 起動 = H の電離が伸びる + L のうなり / 斬撃 = 空気を灼き切る「ブゥン」(L の胴 + H) | 0.8 / 0.6 | L+H | 各1 | P2 |
| `drone_saber_hum_loop` | サーベルを構えている間 | 低い L の唸り + H の電離のゆらぎ | 2.0 | L+H | ル1 | P2 |
| `drone_thruster_fighter_loop` / `_tech_loop` / `_scout_loop` | ドローンの推進(ループ) | 戦闘機 = H の噴流 / Tech = L の重い噴射 / 哨戒機 = 静かな H | 2.0 | 各 | 各ル1 | P2 |
| `drone_order_attack` / `_patrol` / `_return` | ドローンへ指示 | **ポコン不可**: 通信の送信。H の短いデータバースト(攻撃 = 鋭く 3 連 / 哨戒 = 2 連 / 帰還 = 下降の掃き)+ 低い 1 回の「トッ」 | 0.3 | HL | 各1 | P1 |
| `drone_recall` | 全機帰還 | `drone_order_return` の強い版(全機への一斉送信) | 0.5 | HL | 1 | P2 |
| `drone_resupply` | ドローンの補給完了 | 機械の装填 L + 完了の H | 0.6 | L+H | 1 | P2 |
| `drone_lost_own` | 自機のドローンが撃墜された | 通信が途絶する H の砂嵐 + 遠い L の爆発 | 1.0 | H+L | 1 | P1 |

### 3.13 アイテム(使った時)

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `item_flash` | 閃光弾 | 白い閃光の H の破裂 + 耳鳴りのような高い残り + L の圧 | 2.0 | H+L | 1 | P1 |
| `item_noise` | ノイズメーカーを射出 | 射出の L + 遠ざかっていく H と L の偽の機関音 | 1.5 | L+H | 1 | P2 |
| `item_smoke` | 煙幕弾 | 射出の L + 霧が噴き出す H のシューッ | 1.5 | L+H | 1 | P2 |
| `item_fogspray` / `item_fogblow` | 散布弾 / 吹き飛ばし弾 | 散布 = 霧が濃くなる深い L のうねり + H / 吹き飛ばし = L の衝撃波で霧が払われる + H の風 | 1.5 | L+H | 各1 | P2 |
| `item_lure_ship` / `item_lure_sos` | 偽艦影ブイ / 偽 SOS | 射出の L + 偽の信号が立ち上がる H | 1.0 / 1.2 | L+H | 各1 | P2 |
| `item_beacon_heat` / `_optic` / `_em` / `_higgs` | 帯域ビーコン | 射出の L + 帯域ごとの質感の H(§3.8 の det_rx と同じ考え方) | 1.0 | L+H | 各1 | P2 |
| `item_fakecache_place` **新** | 偽コンテナ(罠)を置いた | 重い箱を船外へ押し出す L + 起爆装置が作動する H の小さな電子音 | 1.0 | L+H | 1 | P1 |
| `item_trap_blast` **新** | 偽コンテナが爆発した | 罠の炸裂: 鋭い H + 太い L + 金属の破片。`expl_medium` より鋭く意地悪な音 | 2.0 | L+H | 1(尾込み) | P1 |
| `item_repair_start` / `item_repair_loop` / `item_repair_done` | リペアキット(開始 / 修理中 / 完了) | 開始 = 工具が動き出す L / 修理中 = 溶接の H のジジジ + 金属を叩く L / 完了 = **ポコン不可**: 重い L の締めの 1 打 + H の完了の粒 | 0.8 / 2.0 / 0.8 | L+H | 各1 | P2 |
| `item_assemble_start` / `item_assemble_loop` / `item_assemble_done` | 組み立て(開始 / 中 / 完成) | 工場の L の機械音 + H のロボットアーム。完成 = 重いロックの L + H の起動 | 0.8 / 2.0 / 0.9 | L+H | 各1 | P2 |
| `item_assemble_tech_loop` / `item_assemble_tech_done` | Tech の組み立て(中 / 完成) | 巨大な人型を組む重い L + 溶接の H / 完成 = 巨大な機体が起動する L の唸り + 目に光が灯る H | 2.0 / 2.0 | L+H | 各1 | P2 |

### 3.14 拠点・取得・補給・ドラフト

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `cap_start_node` / `cap_start_colony` | 制圧 / 占有を始めた | 通信の接続: H のハンドシェイクの粒 + L の 1 打 | 0.6 | HL | 各1 | P2 |
| `cap_loop_colony` | 占有中 | H の規則的なデータの粒 + 低い L のハム | 2.0 | H+L | ル1 | P2 |
| `cap_done_node` / `cap_done_colony` | 制圧 / 占有の完了 | **ポコン不可**: 重い L の確定の 1 打 + H の上昇するデータ。コロニーはより大きく | 1.0 / 1.8 | L+H | 各1 | P1 |
| `supply_start` / `supply_loop` / `supply_done` / `supply_used` | 補給の開始 / 中 / 完了 / もう使えない | 開始 = ドッキングの L / 中 = 弾を運ぶ機械の L + H / 完了 = 重いロックの L + H / 使えない = 低い拒絶 | 0.8 / 2.0 / 1.0 / 0.4 | L+H | 各1 | P2 |
| `loot_container` | 漂流コンテナを開けた | 重い扉の油圧 + 金属の箱が開く L + 中身の H | 1.0 | L+H | 1 | P1 |
| `loot_salvage_start` / `loot_salvage_done` | 難破船の回収(開始 / 完了) | 船殻を切る H のカッター + L の金属 / 完了 = 重い L | 0.8 / 1.0 | L+H | 各1 | P2 |
| `convoy_boarded` / `convoy_destroyed` | 輸送船を拿捕 / 撃沈 | 拿捕 = ドッキングの重い L + 通信の H / 撃沈 = `ship_blast_final_enemy_medium` 系 | 1.5 / 3.0 | L+H | 各1 | P2 |
| `draft_open` | 部品の3択が出た | `ui_panel_open` 系 + H のきらめき(宝箱の演出は控えめに・軍用の端末らしく) | 0.6 | HL | 1 | P1 |
| `draft_pick` / `draft_skip` | 部品を選んだ / 見送った | 選ぶ = 重い L の装着の「ガチン」+ H / 見送る = 下へ掃く H | 0.6 / 0.3 | L+H | 各1 | P1 |
| `draft_rarity_sr` / `draft_rarity_ssr` | SR / SSR が出た | SR = H の高い共鳴の輝き + L / SSR = より大きな L の圧 + 長い H のきらめき(ステレオ)。ガチャらしさは H と L の厚みで出し、**中域の旋律は使わない** | 1.2 / 2.0 | H+L | 各1 | P2 |

### 3.15 試合の節目・環境

| ID | 鳴る場面 | 音の作り方 | 秒 | 域 | 数 | 優 |
|---|---|---|---|---|---|---|
| `sys_battle_start` | 出撃 | 艦の全系統が起動する: L の主機の点火 + H の端末群が順に立ち上がる | 2.5 | L+H | 1(ステレオ) | P1 |
| `sys_victory` / `sys_defeat` | 勝利 / 敗北 | 勝利 = 重く荘厳な L の 1 打 + 長い H の余韻 / 敗北 = 全てが落ちる L + 静寂へ | 3.0 | L+H | 各1(ステレオ) | P1 |
| `env_surge_active` / `env_surge_end` / `env_lull_start` | サージ中 / サージ終わり / 凪の始まり | サージ = L の大きなうねりと H の電離 / 終わり = 収まる / 凪 = 霧が晴れる H の澄んだ広がり | 2.0 | L+H | 各1(ステレオ) | P2 |
| `env_dense_enter` / `env_dense_exit` **新** | 自艦が濃いヒッグス(70%以上)に入った / 出た | 入る = 外の音がこもり、L の圧が増し H が消える / 出る = 視界が開ける H | 1.0 | L/H | 各1(ステレオ) | P2 |
| `amb_drone_loop` | 常時の環境音 | 深い L の持続音(30〜120Hz のうねり)+ ごく小さな H のヒスと遠い金属の軋み | 40.0 | L+H | ル1(ステレオ) | P1 |
| `amb_tension_loop` | 緊張(兆候が照射以上) | L の不協和なうなり + H の細い電子の揺れ | 20.0 | L+H | ル1(ステレオ) | P1 |
| `amb_echo` | 遠いこだま(ときどき) | 遠い金属の軋みや遠い何かの衝突(L)+ H の残響 | 3.0 | L | 1(ステレオ・尾込み) | P2 |

---

## 4. 組み込み(Claude の作業・ChatGPT は考慮不要)

1. 届いた WAV を MP3 に変換して `prototype/assets/sfx_v3/` へ・台帳を作る。
2. 「新」の音をゲームの該当場面に割り当てる(今は第2版の流用か無音)。
3. ゲームのメニュー「SE: 第3版 / 第2版」で切り替えて聴き比べられる(第3版に無い音は第2版で鳴る)。
4. 聴感の確認はオーナーが実機で行う(Claude は音を聴けない。周波数と減衰の計測で「中域だけ」「余韻が短すぎる」を機械的に点検する)。

---

## 付録A 全 ID の一覧(237個・うち新規 37個)

```
ui_tap
ui_select
ui_confirm
ui_cancel
ui_deny
ui_error
ui_open
ui_close
ui_panel_open
ui_panel_close
ui_longpress_menu
ui_fab_open
ui_fab_close
ui_tab
ui_toggle_on
ui_toggle_off
ui_level_1
ui_level_4
ui_level_2
ui_level_3
ui_slider_tick
ui_warn
ui_log_warn
ui_ai_msg
ui_sensor_band_on
ui_sensor_all_off
ui_focus_change
ui_sonar_band
ui_sonar_power
ui_lock_cycle
ui_combat_bar
ui_tag_tap
sys_pause_on
sys_pause_off
sys_speed_up
sys_speed_down
sys_report_open
wpn_kinetic_fire
wpn_pd_fire
wpn_reload_kinetic
wpn_missile_launch
wpn_missile_launch_ai
wpn_reload_missile
wpn_beam_charge
wpn_beam_fire
wpn_beam_ready
wpn_empty
wpn_switch_kinetic
wpn_switch_missile
wpn_switch_beam
wpn_lock_acquire
wpn_lock_release
wpn_mine_place
wpn_mine_blast
hit_player_kinetic
hit_player_missile
hit_player_beam
hit_player_beam_graze
hit_player_blast_near
hit_player_ambush
hit_player_rear
hit_player_drone_gun
hit_player_saber
hit_enemy_kinetic
hit_enemy_missile
hit_enemy_beam
hit_enemy_drone
hit_enemy_saber
det_impact_kinetic
det_impact_missile
det_impact_beam
det_impact_unsure
pd_intercept_hit
pd_intercept_miss
pd_missile_lost
expl_small
expl_medium
expl_large
ship_destruct_start_enemy
ship_blast_chain
ship_blast_final_enemy_small
ship_blast_final_enemy_medium
ship_blast_final_enemy_large
ship_death_player_start
ship_blast_final_player
sonar_omni_weak
sonar_omni_mid
sonar_omni_strong
sonar_dir_weak
sonar_dir_mid
sonar_dir_strong
sonar_echo_return
sonar_ready
sonar_scout_ping
alm_ping_omni
alm_ping_dir
det_rx_heat
det_rx_optic
det_rx_em
det_rx_higgs
det_fix_acquired
det_ident_ship
det_ident_decoy
det_ident_nature
det_wake_found
det_loot_trace
det_convoy_iff
det_trap_revealed
det_visual_negative
alm_missile_launch_detect
alm_missile_warn_loop
alm_missile_warn_close_loop
alm_fc_lock_loop
alm_fc_lock_fast_loop
alm_beam_charge_detect
alm_exposure_1
alm_exposure_2
alm_exposure_3
alm_heartbeat
alm_hull_50
alm_hull_25
alm_ambush_success
alm_colony_lost
alm_drone_link_lost
alm_drone_link_restore
alm_distress_signal
alm_distress_false
alm_surge_warn
alm_lull_warn
alm_hack_probe
alm_hack_intrusion_loop
alm_drone_hijacked
alm_status_fcs
alm_status_engine
alm_status_halt
alm_status_sensor
alm_status_daze
alm_status_comm
alm_status_burn
alm_status_recover
ew_hack_wave_fire
ew_hack_miss
ew_hack_intrude_loop
ew_hack_success
ew_hack_fail
ew_hack_cut
ew_linkcut
ew_drone_hack_omni
ew_drone_captured
ew_jam_area
ew_jam_cont_loop
ew_emp_pulse
eng_hum_thermonuclear_loop
eng_hum_pulse_loop
eng_hum_higgs_loop
eng_hum_photon_loop
eng_stance_silent
eng_stance_cruise
eng_stance_flank
eng_boost_start
eng_boost_overheat
eng_coast_on
eng_restart
eng_switch_start
eng_switch_done
drone_launch_fighter
drone_launch_scout
drone_deploy_turret
drone_deploy_barrier
drone_deploy_buoy
drone_fire_fighter
drone_tech_rifle
drone_tech_missile
drone_tech_dash
drone_saber_ignite
drone_saber_slash
drone_saber_hum_loop
drone_thruster_fighter_loop
drone_thruster_tech_loop
drone_thruster_scout_loop
drone_order_attack
drone_order_patrol
drone_order_return
drone_recall
drone_resupply
drone_lost_own
item_flash
item_noise
item_smoke
item_fogspray
item_fogblow
item_lure_ship
item_lure_sos
item_beacon_heat
item_beacon_optic
item_beacon_em
item_beacon_higgs
item_fakecache_place
item_trap_blast
item_repair_start
item_repair_loop
item_repair_done
item_assemble_start
item_assemble_loop
item_assemble_done
item_assemble_tech_loop
item_assemble_tech_done
cap_start_node
cap_start_colony
cap_loop_colony
cap_done_node
cap_done_colony
supply_start
supply_loop
supply_done
supply_used
loot_container
loot_salvage_start
loot_salvage_done
convoy_boarded
convoy_destroyed
draft_open
draft_pick
draft_skip
draft_rarity_sr
draft_rarity_ssr
sys_battle_start
sys_victory
sys_defeat
env_surge_active
env_surge_end
env_lull_start
env_dense_enter
env_dense_exit
amb_drone_loop
amb_tension_loop
amb_echo
```
