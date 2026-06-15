// Init canvas

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
let minimapDpr = 1; // ミニマップのバッキングストア倍率 (高DPI対応・resizeCanvasで更新)
// 高精細(Retina)対応: 描画はCSSピクセル基準、バッキングストアを devicePixelRatio 倍に。
// レーダー/リング/文字のボケ防止。cssW/cssH=CSS px, _dpr=ピクセル比。
let cssW = window.innerWidth, cssH = window.innerHeight, _dpr = 1;

// ── パフォーマンスデバッグフラグ ──────────────────────────────
const PERF_DISABLE_THREAT_RING = false;   // スレットリング描画をオフ
const PERF_DISABLE_SHADOW_BLUR  = false;  // shadowBlur を全オフ (モバイルで最も重い)
const PERF_DISABLE_BG           = false;  // 背景描画をオフ
const PERF_SHOW_FPS             = true;   // FPS表示
// ─────────────────────────────────────────────────────────────

// ── モバイル自動検出 & shadowBlur全オフ ──────────────────────
// shadowBlurはCanvas 2Dで最も重いAPI。モバイルGPUでは1フレームの
// コストの大半を占める。コード中90箇所に散在するため、
// プロトタイプを一括パッチして全オフにする。
const _isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0)
                || (window.innerWidth <= 768);
if (_isMobile || PERF_DISABLE_SHADOW_BLUR) {
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', {
        get: () => 0,
        set: () => {},   // 全てのshadowBlur代入を無視
        configurable: true
    });
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowColor', {
        get: () => 'transparent',
        set: () => {},
        configurable: true
    });
}
// ─────────────────────────────────────────────────────────────

const MAP_RADIUS = 35000;
const MAP_CX = MAP_RADIUS;
const MAP_CY = MAP_RADIUS;
let FIELD_SIZE = MAP_RADIUS * 2;
let BASE_RADAR_RANGE = 600;
let RADAR_RANGE = BASE_RADAR_RANGE;
let effectiveRadarRange = BASE_RADAR_RANGE;
let sectorCleared = false;
let omniSonarCooldown = 0;
let dirSonarCooldown = 0;
let passiveAlertTimer = 0;
let passiveCheckTimer = 0;
let demoMode = false; // デモモード: フォグなし・全エンティティ可視
// パッシブ方位ウェッジ: 計測時のワールド位置にアンカーした方位扇形。
// 強信号=狭い確信、弱信号=広いボケ。移動して2回計測→三角測量で敵位置が絞れる。
// { ox, oy, angle, halfWidth, range, quality, color, life, maxLife }
let passiveBearings = [];
const PASSIVE_BEARING_LIFE = 480;  // 8秒フェード (@60fps)
const PASSIVE_BEARING_MAX  = 8;    // 同時表示上限 (古いものから破棄)
let mouseWorldX = MAP_CX;
let mouseWorldY = MAP_CY;
let dirSonarVisual = null; // { angle, halfAngle, range, life }
let dirSonarPendingFire = false;
let enemiesKilled = 0;
let genGain = 1.0;

// センサーLv別性能定数
const OMNI_SONAR_RANGE  = [0, MAP_RADIUS/6, MAP_RADIUS/3, MAP_RADIUS/2]; // Lv1,2,3 @100%SEN
const DIR_SONAR_HALF_ANGLE = [0, Math.PI/36, Math.PI/12, Math.PI/9];     // 5°/15°/20° 半角
const DIR_SONAR_MAX_RANGE  = MAP_RADIUS * 2;                               // マップ直径
const UPGRADE_MULT = [0, 1.0, 1.5, 2.0]; // Lv別性能倍率 (sensor用)
// §3-1 アップグレードツリー再整合
const ENGINE_UPG_HIGGS_RESIST = [0, 0.20, 0.35, 0.50]; // エンジン: ヒッグス/デブリ減速軽減 Lv0-3
const ENGINE_UPG_HEAT_REDUCE  = [0, 0.10, 0.20, 0.30]; // エンジン: heatSig低下率 Lv0-3
const WEAPONS_UPG_RANGE_MULT  = [1.0, 1.15, 1.30, 1.50]; // 武装: 射程倍率 Lv0-3
const WEAPONS_UPG_RELOAD_MULT = [1.0, 0.85, 0.70, 0.55]; // 武装: リロード時間倍率 Lv0-3
const ARMOR_RES_KINETIC = [0, 0.25, 0.25, 0.25]; // 装甲: kinetic耐性 Lv1+
const ARMOR_RES_MISSILE = [0, 0,    0.25, 0.25]; // 装甲: missile耐性 Lv2+
const ARMOR_RES_BEAM    = [0, 0,    0,    0.25]; // 装甲: beam耐性 Lv3+

const ENGINE_TYPES = {
    thermonuclear: { speedMult: 1.0,  heatMult: 2.0,  optMult: 0.2,  emMult: 0.4,  higgsSpeedBonus: 0.0 },
    pulse:         { speedMult: 1.2,  heatMult: 0.4,  optMult: 0.3,  emMult: 1.8,  higgsSpeedBonus: 0.0 },
    higgs:         { speedMult: 0.85, heatMult: 0.08, optMult: 0.1,  emMult: 0.2,  higgsSpeedBonus: 0.6 },
    photon:        { speedMult: 1.4,  heatMult: 0.0,  optMult: 3.0,  emMult: 0.2,  higgsSpeedBonus: 0.0 }
};

// エンジン種別 → 噴射(スラスター)炎の色。core=中心の高温色, mid=外周色, a=全体アルファ。
// ヒッグスは低アルファ=ほぼ不可視(目立たない推進)。MEMORY.md「エンジン噴射エフェクト色」準拠。
const ENGINE_THRUST = {
    thermonuclear: { core:'255,210,140', mid:'255,90,0',   a:1.0, p1:'#ffd28c', p2:'#ff5a00' }, // 橙白熱
    pulse:         { core:'180,150,255', mid:'70,90,255',  a:1.0, p1:'#b496ff', p2:'#465aff' }, // 青紫電気
    higgs:         { core:'150,90,210',  mid:'40,0,90',    a:0.4, p1:'#965ad2', p2:'#28005a' }, // 暗紫ほぼ不可視
    photon:        { core:'255,255,255', mid:'120,210,255',a:1.0, p1:'#ffffff', p2:'#78d2ff' }  // 純白青白
};

// バーニア位置定義 [lxFrac, lyFrac] × vr(=radius*2.8)。bow=+X、stern=-X。
// 移動時のみCanvasグロー描画。スプライト自体にはスラスター不要（船体のみ生成）。
const THRUSTER_DEFS = {
    assault: [[-0.88,-0.35],[-0.88,-0.12],[-0.88, 0.12],[-0.88, 0.35]], // 4基
    stealth: [[-0.88,-0.07],[-0.88, 0.07]],                              // 2基
    carrier: [[-0.90,-0.30],[-0.90,-0.10],[-0.90, 0.10],[-0.90, 0.30]], // 4基(新スプライト合わせ)
};

// ============================================================
// スプライト画像 (Higgsfield生成・背景除去済みPNG / prototype/assets/)
// 全て bow=+x (右向き) なのでゲームの angle 規約と一致。読み込み完了まではベクター描画にフォールバック。
// ============================================================
const SPRITE_FILES = {
    assault:    'assets/ship_assault.png',
    stealth:    'assets/ship_stealth.png',
    carrier:    'assets/ship_carrier.png',
    e_corvette: 'assets/enemy_corvette.png',
    e_fighter:  'assets/enemy_fighter.png',
    e_destroyer:'assets/enemy_destroyer.png',
    e_carrier:  'assets/enemy_carrier.png',
    node_higgs: 'assets/node_higgs.png',
    colony:     'assets/structure_colony.png',
    derelict:   'assets/structure_derelict.png',
    // Higgsfield生成エフェクトスプライト (黒背景 → 'lighter'加算合成で黒=透明)
    fx_beam_main:       'assets/fx_beam_main.png',
    fx_explosion_big:   'assets/fx_explosion_big.png',
    fx_explosion_small: 'assets/fx_explosion_small.png',
    fx_kinetic_flash:   'assets/fx_kinetic_flash.png',
    fx_beam_impact:     'assets/fx_beam_impact.png',
    fx_thruster_jet:    'assets/fx_thruster_jet.png',
    fx_missile_exhaust: 'assets/fx_missile_exhaust.png',
    // 弾体スプライト
    fx_bolt_player:     'assets/fx_bolt_player.png',
    fx_bolt_enemy:      'assets/fx_bolt_enemy.png',
    drone_missile:      'assets/drone_missile.png',
    // ドローン・デコイスプライト
    drone_attack:       'assets/drone_attack.png',
    drone_scout:        'assets/drone_scout.png',
    drone_decoy:        'assets/drone_decoy.png',
    drone_turret:       'assets/drone_turret.png',
    drone_buoy:         'assets/drone_buoy.png',
    fx_decoy:           'assets/fx_decoy.png',
    // センサーtrailパーティクル
    particle_heat:      'assets/particle_heat.png',
    particle_optic:     'assets/particle_optic.png',
    particle_higgs:     'assets/particle_higgs.png',
    // モバイルアクションバーアイコン
    icon_scan:   'assets/icon_scan.png',
    icon_ew:     'assets/icon_ew.png',
    icon_nav:    'assets/icon_nav.png',
    icon_drone:  'assets/icon_drone.png',
    icon_sup:    'assets/icon_sup.png',
    icon_atk:    'assets/icon_atk.png',
};
const SPRITES = {};
for (const k in SPRITE_FILES) {
    const img = new Image();
    img.src = SPRITE_FILES[k];
    SPRITES[k] = img;
}
// 敵タイプ → スプライトキー
const ENEMY_SPRITE_KEY = { corvette: 'e_corvette', fighter: 'e_fighter', destroyer: 'e_destroyer', carrier: 'e_carrier' };
function spriteReady(img) { return img && img.complete && img.naturalWidth > 0; }
// 既に translate(x,y)+rotate(angle) 済みのコンテキストへ、中心合わせ・最長辺=targetLen で描画
function drawSpriteCentered(ctx, img, targetLen) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = targetLen / Math.max(iw, ih);
    ctx.drawImage(img, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
}

// ============================================================
// マルチセンサーシステム (じゃんけん方式)
// heat: 移動中の熱源検出  optic: 発砲フラッシュ検出  em: 潜伏中受動放射検出
// ============================================================
let currentSensor = 'heat'; // 'heat' | 'optic' | 'em' | 'higgs'

let dialogOpen = false;
let dockingOpen = false;

// Audio System
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();

function playSound(type) {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;

    if (type === 'shoot') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'explosion') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(10, now + 0.5);
        osc.detune.setValueAtTime(Math.random() * 1000, now);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.5);
        osc.start(now); osc.stop(now + 0.5);
    } else if (type === 'ui') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.setValueAtTime(800, now + 0.05);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.1);
        osc.start(now); osc.stop(now + 0.1);
    }
}

// Game State Storage
let gameState = {
    shipType: 'assault',
    mode: 'br',
    enemyType: 'destroyer', // 敵艦種 (ロビーで選択)
    sector: 1,
    credits: 0,       // スクラップ (アップグレード素材 + 修理費)
    engineType: 'thermonuclear',
    upgrades: {
        engine:  1,   // エンジン  Lv1-3: 移動速度
        weapons: 1,   // 武装      Lv1-3: 火力
        armor:   1,   // 装甲      Lv1-3: HP
        sensor:  1    // センサー  Lv1-3: ソナー範囲・精度
    }
};

function loadGame() {
    const saved = localStorage.getItem('darkEchoSave');
    if (saved) {
        try {
            const loaded = JSON.parse(saved);
            // デフォルト値とマージ (古い保存データにないフィールドをデフォルト値で補完)
            gameState = Object.assign({}, gameState, loaded);
            // upgrades: デフォルト値を先に置き旧スキーマの欠損キー(armor/sensor)を補完
            const defaultUpgrades = { engine: 1, weapons: 1, armor: 1, sensor: 1 };
            gameState.upgrades = Object.assign({}, defaultUpgrades, loaded.upgrades || {});
            gameState.engineType = gameState.engineType || 'thermonuclear';
            updateTopUI();
        } catch (e) {
            console.warn('SYSTEM: 保存データの読み込みに失敗しました。初期状態で起動します。', e);
            localStorage.removeItem('darkEchoSave');
        }
    }
}
function saveGame() {
    localStorage.setItem('darkEchoSave', JSON.stringify(gameState));
    logMessage('SYSTEM: Game state saved to local storage.', 'system-msg');
}
loadGame();

function updateTopUI() {
    const modeLabel = gameState.mode === 'sd' ? 'S&D' : 'BR';
    document.getElementById('sector-display').textContent = `セクター: ${gameState.sector} [${modeLabel}]`;
    document.getElementById('currency-display').textContent = `スクラップ: ${gameState.credits} SCR`;
}
updateTopUI();

// Event Listeners for Game UI saving/ads
document.getElementById('btn-save').addEventListener('click', saveGame);
document.getElementById('btn-reset').addEventListener('click', () => {
    localStorage.removeItem('darkEchoSave');
    location.reload();
});


// Core Entities
let player;
let gameLoopRunning = false;
let _frameCount = 0;
let _higgsCache = new Map(), _higgsCacheFrame = -1;
// Phase2 地形ハザード (§3-13 D): デブリ帯 / 磁気嵐帯
let debrisField = [], stormField = [];
let debrisCanvas = null, stormCanvas = null;
let _debrisCache = new Map(), _debrisCacheFrame = -1;
let _stormCache  = new Map(), _stormCacheFrame  = -1;
// Phase3 地形ハザード (§3-13 Phase3): 熱雲 (HEAT)
let thermalField = [], thermalCanvas = null;
let _thermalCache = new Map(), _thermalCacheFrame = -1;
let enemies = [];
let projectiles = [];
let structures = [];
let effects = [];
let particles = [];
let debris = [];
let bgStars = [];
let bgMist = [];
let spaceBgCanvas = null; // 事前生成の宇宙背景テクスチャ
let _nebulaTile = null;   // シームレスな星雲タイル (スクリーン空間パララックス層用)
const _NEB_TILE = 1024;   // 星雲タイルのピクセルサイズ
let _giantStarTile = null; // 明るい巨星タイル (スクリーン空間パララックス層用・鮮明)
const _GSTAR_TILE = 1400;  // 巨星タイルのピクセルサイズ (繰り返しを目立たせない大きさ)
let bgMistCanvas = null;  // bgMist事前焼き付けキャンバス
let higgsCloudCanvas = null; // ヒッグス雲(白)事前焼き付け — 視野内で「下から見上げた雲」として合成
let scrapDrops = [];
let stations = [];
let higgsWakes = [];    // ヒッグスウェイク軌跡 {x, y, intensity, life}
let heatTrails  = [];   // §3-12 HEATセンサー向け熱排気跡
let opticTrails = [];   // §3-12 OPTICセンサー向け発光跡(弾跡・ビーム)
let emTrails    = [];   // §3-12 EMセンサー向けEM放射跡
let resourceNodes = []; // リソースノード {x, y, active, emFlashTimer}

// ── ゲームスピード制御 ──────────────────────────────────────
let gameSpeedFactor = 1.0; // 0.5=低速 / 1.0=通常 / 2.0=高速
const PLAYER_TURN_RATE = 0.010; // 自機最大回頭レート (rad/frame) - assault基準
const PLAYER_TURN_RATES = { assault: 0.010, stealth: 0.015, carrier: 0.004 }; // 艦種別回頭レート (重量感重視)
const ENEMY_TURN_RATES  = { corvette: 0.030, fighter: 0.040, destroyer: 0.014, carrier: 0.006 }; // 敵艦種別回頭レート
// 慣性ベース速度システム
const SHIP_MAX_SPEED_MULT = { assault: 0.58, stealth: 1.05, carrier: 0.38 }; // 艦種別最高速度倍率(全体的に低速化)
const SHIP_ACCEL_RATE = { carrier: 0.003, assault: 0.008, stealth: 0.016 }; // 最高速度到達まで加速率/frame (空母最遅・潜航最速)
const SHIP_TURN_SLOW  = { carrier: 0.78, assault: 0.52, stealth: 0.22 }; // 旋回時の速度低下率最大値 (空母最重・潜航身軽)
// 武器別射角 (前方からの角度差の許容最大値)
const WEAPON_FIRE_ARC = { kinetic: Math.PI * 5/6, missile: Math.PI/4, beam: Math.PI/18 }; // kinetic±150° / missile±45° / beam±10°
const LOCK_PERSIST_BASE = 2.0; // ロック保持倍率 (visionRadius × N)
// ─────────────────────────────────────────────────────────────

// GEN配分 (ゼロサム: エンジン/武器/センサー/AI の合計=100)
let genAlloc = { engine: 40, weapons: 30, sensors: 30, ai: 50 };

// AI精度配分 (§3-2): GEN AI出力(genAlloc.ai)を 解析/命中/回避 の3つにゼロサム配分。
// 実効精度 = (AI出力) × (各配分)。AIを上げるほど精度↑だが EM放射も増える(逆探知トレードオフ)。
let aiPrecision = { sensor: 34, weapon: 33, engine: 33 };
// 実効精度 0..1 (AI=100%かつ当該100%配分で1.0)。各効果の係数は AI_* 定数で調整。
function aiPrec(key) { return (genAlloc.ai / 100) * (aiPrecision[key] / 100); }
const AI_SENSOR_ACC   = 0.6;  // 解析精度→コンタクト精度ブースト上限
const AI_WEAPON_AIM   = 0.7;  // 命中精度→デブリ等のミス率低減上限
const AI_ENGINE_DODGE = 0.45; // 回避精度→被弾回避率上限

// 自動攻撃ON/OFFフラグ
let autoAttackEnabled = true;

// ── 潜航型ジャミング3種 (stealth専用) ──────────────────────
// 敵の探知レンジを劣化させる。発動中はEM放射が増え逆探知されやすくなる(情報↔露出のトレードオフ)。
// 数値は調整用デフォルト (バランスは実機調整前提)。
let jamBurst = 0;     // 範囲ジャミング: 残りフレーム
let jamCont = false;  // 継続EMジャム: ON/OFF (持続的にEM放射)
let jamPulse = 0;     // EMパルス: 広域瞬間ブラインドの残りフレーム
let jamPulseCD = 0;   // EMパルス: 再チャージ残り
const JAM_BURST_RADIUS = 3500, JAM_BURST_DUR = 360, JAM_BURST_DEGRADE = 0.6;  // 半径3500を60%劣化, 6秒
const JAM_CONT_RADIUS = 2400, JAM_CONT_DEGRADE = 0.35;                        // 半径2400を35%劣化(持続)
const JAM_PULSE_RADIUS = 6000, JAM_PULSE_DUR = 75, JAM_PULSE_CD = 1200;       // 半径6000を1.25秒全ブラインド, CD20秒

// ── 積載量 (同時展開上限) — オーナー確定値 2026-06-14 ──
const CARGO_CAP = { assault: 2, stealth: 3, carrier: 6 };

// ── 潜航型デコイ (強EM放射のダミー → 敵ミサイルを誘引・索敵妨害) ──
let decoys = [];
const DECOY_LIFE = 480;        // 8秒
const DECOY_LURE_RADIUS = 1600; // この半径内の敵ミサイルを誘引

// ── 空母型ドローン4種 (§3-6) ──
// 攻撃=自動追尾射撃(熱) / デコイ=ミサイル誘引(強EM) / 哨戒=センサー拡張(低シグ) / 建設=設置タレット
let playerDrones = [];
const DRONE_LIFE = 2400;        // 40秒で帰投(消滅)
const DRONE_ATK_RANGE = 1400;   // 攻撃ドローンの索敵/射程
const DRONE_SCOUT_RANGE = 2200; // 哨戒ドローンのセンサー拡張半径
const DRONE_TURRET_RANGE = 1100;// 建設タレットの射程
const DRONE_LABELS = { attack: '攻撃ドローン', decoy: 'デコイドローン', scout: '哨戒ドローン', build: '建設タレット', barrier: 'ビームバリア', buoy: 'センサーブイ', higgs: 'ヒッグス散布装置' };

// §3-7 建設物3種 (carrier) 定数
const DRONE_BARRIER_RADIUS = 880; // バリア: この半径内の敵に周期ダメージ
const DRONE_BUOY_RANGE     = 3200;// センサーブイ: 探知半径
const DRONE_HIGGS_RADIUS   = 700; // ヒッグス散布: 影響半径
const DRONE_BUILDING_LIFE  = 7200;// 建設物寿命 (2分)

// §3-10 ミサイル2タイプ (homing=熱源誘導/smart=AI追跡)
let missileMode = 'homing'; // 'homing' | 'smart'

// §3-9 修復ドローン (完全停止HP回復)
let repairActive = false;
const REPAIR_RATE     = 1.2; // HP/frame
const REPAIR_SIG_MULT = 2.4; // 停止中シグネチャ増大倍率

// ============================================================
// 有視界システム — アメーバ形状視野 + ヒッグス連続濃度連動
// ============================================================
const BASE_VISION_RADIUS = 1200; // 0%ヒッグス時の基準視野半径 (ワールド単位)
let playerVisionRadius = BASE_VISION_RADIUS;

const MIN_VISION_FACTOR = 0.05; // 100%ヒッグスでも最低限の視認性を残す
// ── ターゲットローカル濃度ゲート (§3-13 C) ──
// 視野リーチ内でも、敵が居る地点のヒッグス濃度が高ければ完全ロックにならず想定ロック止まりにする。
// 「自機の濃度だけで視界が決まる」非対称を解消し、濃い雲ポケットを真の隠れ場所にする。
const HIGGS_CLEAR_BELOW = 0.22; // この濃度未満なら完全クリア視認 (完全ロック)
const HIGGS_CLEAR_SPAN  = 0.55; // +0.55 (≈0.77) で完全に雲隠れ (clarity→0)

// ── Phase2 地形ハザード (§3-13 D) tunable定数 ──
// デブリ帯=岩礁帯(OPTIC干渉・移動/命中デバフ・ビーム貫通) / 磁気嵐帯(EM干渉・AI退避所)
const DEBRIS_SLOW        = 0.40; // デブリ密度100%での最大移動減速率
const DEBRIS_AI_MITIGATE = 0.70; // AI配分100%で減速を最大70%軽減 (姿勢制御補助)
const DEBRIS_ENEMY_MITIGATE = 0.35; // 敵の固定デブリ軽減 (動けなくなるのを防ぐ)
const STORM_MISSILE_DEGRADE = 0.7; // 磁気嵐内でのミサイル誘導(旋回)劣化率
const DEBRIS_MISS        = 0.55; // デブリ内ターゲットへの実弾/ミサイル最大ミス率 (ビームは貫通=対象外)
const DEBRIS_OPTIC_MOD   = 0.85; // デブリ経路による光学(OPTIC)探知の減衰係数
const STORM_EM_MOD       = 0.90; // 磁気嵐経路によるEM探知の減衰係数
const STORM_EM_MASK      = 0.65; // 磁気嵐内に居る機体のEMシグネチャ低減率 (AIを安全に回せる)
const THERMAL_HEAT_MASK  = 0.60; // 熱雲内の機体のheatSig低減率 (HEATセンサーから隠れやすい)
const THERMAL_HEAT_MOD   = 0.80; // 熱雲経路によるHEAT探知の減衰係数
function computeVisionRadius() {
    // ヒッグス連続濃度連動: 0% = 基準視野(100%), 濃度上昇に比例して縮小, 100%でほぼゼロ
    if (!player) return BASE_VISION_RADIUS;
    const h = getHiggsIntensity(player.x, player.y); // 0..1
    let factor = 1 - h * (1 - MIN_VISION_FACTOR);
    if (factor < MIN_VISION_FACTOR) factor = MIN_VISION_FACTOR;
    return BASE_VISION_RADIUS * factor;
}

// アメーバ形状の頂点列を生成 (毎フレームアニメーション)
function getAmoebaPoints(cx, cy, baseR, numPts, timeSec) {
    const pts = [];
    for (let i = 0; i < numPts; i++) {
        const a = (i / numPts) * Math.PI * 2;
        const noise =
            Math.sin(a * 3 + timeSec * 0.8)  * 0.14 +
            Math.sin(a * 5 - timeSec * 0.5)  * 0.08 +
            Math.sin(a * 7 + timeSec * 0.35) * 0.04 +
            Math.sin(a * 11 - timeSec * 0.2) * 0.02;
        const r = baseR * (1.0 + noise);
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return pts;
}

function drawFogOfWar(ctx) {
    if (!player || player.hp <= 0) return;
    if (demoMode) return; // デモモード: ヒッグス暗幕解除

    playerVisionRadius = computeVisionRadius();
    const cx = player.x;
    const cy = player.y;
    const t = Date.now() * 0.001;
    const NUM_PTS = 32;

    // 霧の不透明度: ヒッグス高濃度で濃くなる
    const hHere = getHiggsIntensity(cx, cy);
    const fogAlpha = 0.86 + hHere * 0.10;
    // ヒッグス雲の中ではティール〜青みがかった霧色
    const fogR = Math.round(1  + hHere * 4);
    const fogG = Math.round(3  + hHere * 22);
    const fogB = Math.round(14 + hHere * 32);

    // 描画範囲: カメラビュー + マージン
    const vw = cssW  / camera.zoom;
    const vh = cssH / camera.zoom;
    const mx = camera.x - 500;
    const my = camera.y - 500;
    const mw = vw + 1000;
    const mh = vh + 1000;

    const pts = getAmoebaPoints(cx, cy, playerVisionRadius, NUM_PTS, t);

    // ── アメーバ穴付きフォグ (even-odd fill rule) ──
    ctx.save();
    ctx.beginPath();
    // 外側 (大きい矩形)
    ctx.moveTo(mx,      my);
    ctx.lineTo(mx + mw, my);
    ctx.lineTo(mx + mw, my + mh);
    ctx.lineTo(mx,      my + mh);
    ctx.closePath();
    // 内側 (アメーバ穴) — スムーズな二次ベジェ曲線
    ctx.moveTo((pts[NUM_PTS - 1].x + pts[0].x) / 2, (pts[NUM_PTS - 1].y + pts[0].y) / 2);
    for (let i = 0; i < NUM_PTS; i++) {
        const next = pts[(i + 1) % NUM_PTS];
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + next.x) / 2, (pts[i].y + next.y) / 2);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(${fogR},${fogG},${fogB},${fogAlpha.toFixed(3)})`;
    ctx.fill('evenodd');

    // ── ソフトエッジグラデーション (視野境界のフェード) ──
    // ヒッグス高濃度では内側クリア領域が狭く、外側フェード帯が広くなる
    const innerR = playerVisionRadius * (0.78 - hHere * 0.18);
    const outerR = playerVisionRadius * (1.18 + hHere * 0.5);
    const edgeGrad = ctx.createRadialGradient(cx, cy, Math.max(1, innerR), cx, cy, outerR);
    edgeGrad.addColorStop(0, 'rgba(0,0,0,0)');
    edgeGrad.addColorStop(1, `rgba(${fogR},${fogG},${fogB},${fogAlpha.toFixed(3)})`);
    ctx.beginPath();
    ctx.arc(cx, cy, outerR * 1.05, 0, Math.PI * 2);
    ctx.fillStyle = edgeGrad;
    ctx.fill();

    // ── 視野境界のグロウリング (微光) ──
    // shadowBlur はモバイルGPUで重いため使用しない (HANDOVER.md パフォーマンス教訓)。
    // globalAlpha を変えた二重ストロークで擬似グロウを表現。
    ctx.beginPath();
    ctx.arc(cx, cy, playerVisionRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,180,1)';
    ctx.globalAlpha = 0.04 + hHere * 0.03;
    ctx.lineWidth = 5 / camera.zoom;
    ctx.stroke();
    ctx.globalAlpha = 0.10 + hHere * 0.05;
    ctx.lineWidth = 2 / camera.zoom;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();

    // ── 視野内のヒッグス雲を「下から見上げた濃淡」で重ねる (§3-13 B) ──
    // 視野バブル内にクリップし、白い雲を 'lighter' 合成。濃密ポケットは真っ白に近づき、
    // 自機の濃度が低く視界が広くても、視界内の濃い箇所は曇って見えづらくなる。
    if (higgsCloudCanvas) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo((pts[NUM_PTS - 1].x + pts[0].x) / 2, (pts[NUM_PTS - 1].y + pts[0].y) / 2);
        for (let i = 0; i < NUM_PTS; i++) {
            const next = pts[(i + 1) % NUM_PTS];
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + next.x) / 2, (pts[i].y + next.y) / 2);
        }
        ctx.closePath();
        ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5; // washout防止 (0.85→0.5)。ゲームリングは fog の後に描画して最前面に
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(higgsCloudCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.restore();
    }
}

// 視野内の敵を自動ロックオン (毎フレーム呼び出し)
function updateVisionLockOn() {
    if (!player || player.hp <= 0) return;
    if (demoMode) { enemies.forEach(e => { e.visible = true; e.inVision = true; }); return; }

    // 視野半径をヒッグス濃度に応じて毎フレーム更新 (描画OFFでもロックオン判定が正しく動く)
    playerVisionRadius = computeVisionRadius();
    const vr = playerVisionRadius;
    enemies.forEach(e => {
        if (e.hp <= 0) return;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        if (dist <= vr) {
            // ターゲット地点のヒッグス濃度で「視認のクリアさ」を判定 (§3-13 C)。
            // 濃い雲ポケットに居る敵は視野リーチ内でも完全ロックにならず想定ロック止まり。
            const hTarget = getHiggsIntensity(e.x, e.y);
            const clarity = 1 - Math.min(1, Math.max(0, (hTarget - HIGGS_CLEAR_BELOW) / HIGGS_CLEAR_SPAN));
            if (clarity >= 0.85) {
                // 完全ロックオン: クリアに視認 — 高精度コンタクト、毎フレーム更新
                e.inVision = true;
                applyContact(e, 1.0, 90); // life=90 = 1.5秒 (更新されない間は維持)
                e.displayX = e.x; // 位置ジッター無し
                e.displayY = e.y;
            } else {
                // 雲に紛れた敵: 視野内でも完全ロック不可 → 想定ロック (精度デバフ)。
                // inVision=false により _fullLock=false となり、武器側で自動的に想定ロック扱い。
                // applyContactは精度を下げない(max挙動)ため、ここで上限を直接キャップする。
                e.inVision = false;
                const accCap = clarity > 0.1 ? (0.4 + clarity * 0.5) : 0.25; // 0.45..0.87 / 濃密潜伏=0.25
                if (e.contactAccuracy > accCap || e.contactLife < 60) {
                    const jitter = (1 - accCap) * 400;
                    e.displayX = e.x + (Math.random() - 0.5) * jitter;
                    e.displayY = e.y + (Math.random() - 0.5) * jitter;
                    e.contactAccuracy = accCap;
                }
                e.contactLife = Math.max(e.contactLife, clarity > 0.1 ? 75 : 45);
                e.visible = true;
            }
        } else {
            e.inVision = false;
        }
    });

    // autoAttack有効時: 視野内の敵の中から最近傍を自動ターゲット設定
    if (autoAttackEnabled && !player.manualTarget) {
        let closest = null;
        let closestDist = Infinity;
        enemies.forEach(e => {
            if (e.hp <= 0 || !e.inVision) return;
            const d = Math.hypot(e.x - player.x, e.y - player.y);
            if (d < closestDist) { closestDist = d; closest = e; }
        });
        if (closest) {
            player.targetEntity = closest;
        } else if (!player.targetEntity || player.targetEntity.hp <= 0) {
            // 視野内に敵なし → センサーコンタクト済みの敵を推定ロックオン
            let bestContact = null;
            let bestAcc = 0;
            enemies.forEach(e => {
                if (e.hp <= 0 || !e.visible) return;
                if (e.contactAccuracy > bestAcc) { bestAcc = e.contactAccuracy; bestContact = e; }
            });
            player.targetEntity = bestContact;
        }
    }
}

// ============================================================
// 宇宙背景テクスチャ生成 (ゲーム開始時に1回だけ実行、ランダムシード)
// ============================================================
function generateSpaceBackground() {
    const TEX = 1024; // 512→1024: 引き伸ばし時の粗さ改善（生成は1回のみ）
    spaceBgCanvas = document.createElement('canvas');
    spaceBgCanvas.width  = TEX;
    spaceBgCanvas.height = TEX;
    const bc = spaceBgCanvas.getContext('2d');

    // 簡易LCG乱数 (Math.random()で毎回異なるシード)
    let _s = (Math.random() * 0xffffffff) >>> 0;
    const rng = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };

    // 1. ベースグラジェント (暗い深宇宙ブルー)
    const bg = bc.createLinearGradient(0, 0, TEX * 0.7, TEX);
    bg.addColorStop(0,   '#020816');
    bg.addColorStop(0.3, '#010610');
    bg.addColorStop(0.6, '#030a1a');
    bg.addColorStop(1,   '#020714');
    bc.fillStyle = bg;
    bc.fillRect(0, 0, TEX, TEX);

    // 星雲(ネビュラ)は68倍引き伸ばしでボケるため焼き込まない。
    // → スクリーン空間パララックス層 (_drawNebula / シームレスタイル) へ分離。
    _nebulaTile = null; // 背景再生成に合わせて星雲タイルも作り直す

    // 星も68倍拡大でボケるため焼き込まない (旧: 6000+1800+200個をTEXに焼いていた)。
    // → 鮮明なスクリーン空間パララックス層 (_drawStarfield) が担当。
    // spaceBgCanvas は「暗い深宇宙グラデーション」のみ (滑らかなので拡大してもボケが目立たない)。
    _giantStarTile = null; // 明るい巨星も鮮明パララックス層 (_drawGiantStars) へ。再生成に合わせreset
}

// ============================================================
// ヒッグス粒子強度計算 (Higgs Intensity)
// ============================================================
function getHiggsIntensity(x, y) {
    // フレームキャッシュ: 500単位グリッドに量子化 (200→500で6倍少ないキャッシュミス)
    if (_higgsCacheFrame !== _frameCount) { _higgsCache.clear(); _higgsCacheFrame = _frameCount; }
    const key = (Math.round(x / 500) * 100000 + Math.round(y / 500)) | 0;
    let v = _higgsCache.get(key);
    if (v !== undefined) return v;
    let total = 0;
    for (let i = 0; i < bgMist.length; i++) {
        const m = bgMist[i];
        const dist = Math.hypot(x - m.x, y - m.y);
        if (dist < m.r) total += (1 - dist / m.r) * (m.density || 0.3);
    }
    v = total > 1.0 ? 1.0 : total;
    _higgsCache.set(key, v);
    return v;
}

// ============================================================
// 地形ハザード強度計算 (デブリ帯 / 磁気嵐帯) — getHiggsIntensity と同方式
// フレームキャッシュ + 500グリッド量子化 (毎フレーム・全エンティティで複数回呼ばれる)
// ============================================================
function getDebrisIntensity(x, y) {
    if (_debrisCacheFrame !== _frameCount) { _debrisCache.clear(); _debrisCacheFrame = _frameCount; }
    const key = (Math.round(x / 500) * 100000 + Math.round(y / 500)) | 0;
    let v = _debrisCache.get(key);
    if (v !== undefined) return v;
    let total = 0;
    for (let i = 0; i < debrisField.length; i++) {
        const m = debrisField[i];
        const dist = Math.hypot(x - m.x, y - m.y);
        if (dist < m.r) total += (1 - dist / m.r) * m.density;
    }
    v = total > 1.0 ? 1.0 : total;
    _debrisCache.set(key, v);
    return v;
}
function getStormIntensity(x, y) {
    if (_stormCacheFrame !== _frameCount) { _stormCache.clear(); _stormCacheFrame = _frameCount; }
    const key = (Math.round(x / 500) * 100000 + Math.round(y / 500)) | 0;
    let v = _stormCache.get(key);
    if (v !== undefined) return v;
    let total = 0;
    for (let i = 0; i < stormField.length; i++) {
        const m = stormField[i];
        const dist = Math.hypot(x - m.x, y - m.y);
        if (dist < m.r) total += (1 - dist / m.r) * m.density;
    }
    v = total > 1.0 ? 1.0 : total;
    _stormCache.set(key, v);
    return v;
}
function getThermalIntensity(x, y) {
    if (_thermalCacheFrame !== _frameCount) { _thermalCache.clear(); _thermalCacheFrame = _frameCount; }
    const key = (Math.round(x / 500) * 100000 + Math.round(y / 500)) | 0;
    let v = _thermalCache.get(key);
    if (v !== undefined) return v;
    let total = 0;
    for (let i = 0; i < thermalField.length; i++) {
        const m = thermalField[i];
        const dist = Math.hypot(x - m.x, y - m.y);
        if (dist < m.r) total += (1 - dist / m.r) * m.density;
    }
    v = total > 1.0 ? 1.0 : total;
    _thermalCache.set(key, v);
    return v;
}

// ============================================================
// AIロックオン候補生成 (§3-3): センサー検知→AI解析の推定位置を
// 確率%付き候補群で表現。精度が低いほど候補数が多く分散も大きい。
// 候補は推定中心(displayX/Y)からのオフセット {dx,dy,p}。本命(index0)が支配的。
// ============================================================
function makeContactCandidates(acc) {
    const n = Math.max(2, Math.round(2 + (1 - acc) * 4)); // acc 0.7→3, 0.2→5, 0→6
    const spread = (1 - acc) * 360;
    const cands = [{ dx: (Math.random() - 0.5) * spread * 0.25, dy: (Math.random() - 0.5) * spread * 0.25 }];
    for (let i = 1; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = (0.45 + Math.random() * 0.55) * spread;
        cands.push({ dx: Math.cos(a) * r, dy: Math.sin(a) * r });
    }
    // 確率割当: 本命=高精度ほど支配的 / 低精度ほど均等に近づく
    const w = cands.map((c, i) => i === 0 ? (0.4 + acc * 0.5) : (0.15 + Math.random() * 0.35));
    const sum = w.reduce((a, b) => a + b, 0);
    cands.forEach((c, i) => { c.p = w[i] / sum; });
    return cands;
}

// ヒッグス濃度の高い隠れ場所を探す (ジエンド戦スタイルAI用)
function clampToMapCircle(x, y, margin = 200) {
    const dx = x - MAP_CX, dy = y - MAP_CY;
    const d = Math.hypot(dx, dy);
    const limit = MAP_RADIUS - margin;
    if (d > limit) {
        const a = Math.atan2(dy, dx);
        return { x: MAP_CX + Math.cos(a) * limit, y: MAP_CY + Math.sin(a) * limit };
    }
    return { x, y };
}

function findHidingSpot(nearX, nearY, searchRadius) {
    let best = clampToMapCircle(nearX + (Math.random() - 0.5) * searchRadius, nearY + (Math.random() - 0.5) * searchRadius);
    let bestScore = 0;
    for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * searchRadius;
        const raw = clampToMapCircle(nearX + Math.cos(angle) * dist, nearY + Math.sin(angle) * dist);
        const score = getHiggsIntensity(raw.x, raw.y);
        if (score > bestScore) { bestScore = score; best = raw; }
    }
    return best;
}

// Resize
// SIGキャンバスの内部解像度を表示サイズ×DPRに合わせる (波形を鮮明に)
function _fitSigCanvas(c) {
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
}

function resizeCanvas() {
    _dpr = Math.min(2, window.devicePixelRatio || 1);
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    // バッキングストアは物理ピクセル、CSS表示はCSSピクセル → 描画は毎フレーム _dpr 倍に
    canvas.width = Math.round(cssW * _dpr);
    canvas.height = Math.round(cssH * _dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    // ミニマップ解像度を表示サイズ×DPRに合わせる (高DPI端末でのボケ解消)
    const mmr = minimapCanvas.getBoundingClientRect();
    if (mmr.width > 0 && mmr.height > 0) {
        minimapDpr = Math.min(2, window.devicePixelRatio || 1);
        minimapCanvas.width = Math.floor(mmr.width * minimapDpr);
        minimapCanvas.height = Math.floor(mmr.height * minimapDpr);
    }
    _fitSigCanvas(document.getElementById('sig-canvas'));
    _fitSigCanvas(document.getElementById('env-sig-canvas'));
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
// Defer one more resize call to ensure CSS layout is complete before reading getBoundingClientRect
requestAnimationFrame(resizeCanvas);

const camera = {
    x: 0,
    y: 0,
    zoom: 0.08, minZoom: 0.005, maxZoom: 3,
    isDragging: false, lastX: 0, lastY: 0,
    shake: 0
};

function addShake(amt) {
    camera.shake = Math.min(camera.shake + amt, 50);
}

function clampCamera() {
    // マップの一部が画面内に残る程度まで自由にスクロール可能
    const vw = (cssW || window.innerWidth) / camera.zoom;
    const vh = (cssH || window.innerHeight) / camera.zoom;
    const minVisible = 400; // この分だけマップが画面内に残る (ワールド単位)
    camera.x = Math.max(minVisible - vw, Math.min(camera.x, FIELD_SIZE - minVisible));
    camera.y = Math.max(minVisible - vh, Math.min(camera.y, FIELD_SIZE - minVisible));
}

function centerCameraOnPlayer() {
    if (!player) return;
    const cw = cssW || window.innerWidth;
    const ch = cssH || window.innerHeight;
    camera.x = player.x - (cw / 2) / camera.zoom;
    camera.y = player.y - (ch / 2) / camera.zoom;
    clampCamera();
}

// ── マップモード (§ミニマップタップで全画面マップ) ──
// カメラをマップ全体にズームアウト＋追従OFF＋フォグ抑制(索敵済みの戦術マップ)。
// 通常のタッチ操作(ウェイポイント長押し・パン・ピンチ・敵タップ)はワールド座標で動くのでそのまま使える。
let mapMode = false;
let _preMapCamera = null;
function enterMapMode() {
    if (mapMode || !player) return;
    mapMode = true;
    _preMapCamera = { x: camera.x, y: camera.y, zoom: camera.zoom, follow: cameraFollowPlayer };
    cameraFollowPlayer = false;
    const cw = cssW || window.innerWidth, ch = cssH || window.innerHeight;
    camera.zoom = Math.max(camera.minZoom, Math.min(cw, ch) / FIELD_SIZE * 0.92);
    camera.x = MAP_CX - (cw / camera.zoom) / 2;
    camera.y = MAP_CY - (ch / camera.zoom) / 2;
    const banner = document.getElementById('map-mode-banner');
    if (banner) banner.style.display = 'block';
    const fb = document.getElementById('btn-camera-follow');
    if (fb) fb.textContent = '追従 OFF';
    logMessage('NAV: マップモード ON — タップで航路設定、ミニマップ再タップで戻る', 'system-msg');
}
function exitMapMode() {
    if (!mapMode) return;
    mapMode = false;
    if (_preMapCamera) {
        camera.zoom = _preMapCamera.zoom;
        camera.x = _preMapCamera.x;
        camera.y = _preMapCamera.y;
        cameraFollowPlayer = _preMapCamera.follow;
        if (cameraFollowPlayer) centerCameraOnPlayer();
    }
    const banner = document.getElementById('map-mode-banner');
    if (banner) banner.style.display = 'none';
    const fb = document.getElementById('btn-camera-follow');
    if (fb) fb.textContent = cameraFollowPlayer ? '追従 ON' : '追従 OFF';
    logMessage('NAV: マップモード OFF', 'system-msg');
}
function toggleMapMode() { mapMode ? exitMapMode() : enterMapMode(); }

// スクリーン座標 → ワールド座標変換 (getBoundingClientRect でCSS/canvas解像度差を補正)
function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const cx = (clientX - rect.left) * (cssW / rect.width);
    const cy = (clientY - rect.top) * (cssH / rect.height);
    return { x: cx / camera.zoom + camera.x, y: cy / camera.zoom + camera.y };
}
function worldToScreen(wx, wy) {
    return {
        sx: (wx - camera.x) * camera.zoom,
        sy: (wy - camera.y) * camera.zoom
    };
}
// ドラッグ差分をワールド単位に変換 (CSS/canvas解像度差を補正)
function dragDeltaWorld(dClientX, dClientY) {
    const rect = canvas.getBoundingClientRect();
    return {
        dx: dClientX * (cssW / rect.width) / camera.zoom,
        dy: dClientY * (cssH / rect.height) / camera.zoom
    };
}

// カメラ追従フラグ (自艦追従ON/OFF)
let cameraFollowPlayer = false;

function updateCameraFollowBtn() {
    const btn = document.getElementById('btn-camera-follow');
    if (!btn) return;
    if (cameraFollowPlayer) {
        btn.classList.add('active-follow');
        const lbl = document.getElementById('follow-label');
        if (lbl) lbl.textContent = '追従 ON';
    } else {
        btn.classList.remove('active-follow');
        const lbl = document.getElementById('follow-label');
        if (lbl) lbl.textContent = '追従 OFF';
    }
}

// Input Handling
canvas.addEventListener('mousedown', (e) => {
    if (!player) return; // ship not selected yet
    if (e.target.closest('#ui-layer') && !e.target.closest('#gameCanvas')) return; // Ignore clicks on UI
    if (e.button === 0) {
        const { x: worldX, y: worldY } = screenToWorld(e.clientX, e.clientY);

        // 指向性ソナー待機中: 次のクリックで発射方向を決定
        if (dirSonarPendingFire) {
            dirSonarPendingFire = false;
            canvas.style.cursor = 'default';
            document.getElementById('btn-dir-sonar').classList.remove('pending-fire');
            const angle = Math.atan2(worldY - player.y, worldX - player.x);
            fireDirectionalSonar(angle);
            return;
        }

        // Find clicked enemy
        let clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < en.radius * 2);

        if (clickedEnemy) {
            player.targetEntity = clickedEnemy;
            player.manualTarget = true; // 手動ターゲット指定 (自動ロックオン上書き防止)
            createClickEffect(clickedEnemy.x, clickedEnemy.y, '#ff4d4d');
            logMessage(`TACTICAL: ターゲットをロック。射撃解を計算中...`, 'system-msg');
        }
        // Single click on empty space: no waypoint (use double-click instead)
    } else if (e.button === 2) {
        camera.isDragging = true;
        camera.lastX = e.clientX;
        camera.lastY = e.clientY;
    }
});

// Double-click to set waypoint
canvas.addEventListener('dblclick', (e) => {
    if (!player || player.hp <= 0) return;
    if (dirSonarPendingFire) return; // sonar takes priority
    const { x: worldX, y: worldY } = screenToWorld(e.clientX, e.clientY);
    const clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < en.radius * 2);
    if (!clickedEnemy) {
        player.targetEntity = null;
        player.manualTarget = false; // 手動ターゲット解除
        player.setTarget(worldX, worldY);
        createClickEffect(worldX, worldY, '#00ffaa');
        const dist = Math.hypot(worldX - player.x, worldY - player.y);
        const speedEst = Math.max(0.1, (genAlloc.engine / 100) * 3.0);
        const timeSeconds = Math.max(1, Math.floor(dist / (speedEst * 60)));
        logMessage(`NAV: 進路設定完了。到着予定時間はおよそ ${timeSeconds} 秒です。`, 'system-msg');
    }
});
window.addEventListener('mouseup', e => { if (e.button === 2) camera.isDragging = false; });
window.addEventListener('mousemove', e => {
    const mw = screenToWorld(e.clientX, e.clientY);
    mouseWorldX = mw.x; mouseWorldY = mw.y;
    if (camera.isDragging) {
        const d = dragDeltaWorld(e.clientX - camera.lastX, e.clientY - camera.lastY);
        camera.x -= d.dx; camera.y -= d.dy;
        camera.lastX = e.clientX;
        camera.lastY = e.clientY;
        clampCamera();
    }
});
canvas.addEventListener('wheel', e => {
    // only if on canvas
    if (e.target.id !== 'gameCanvas') return;
    e.preventDefault();
    const zoomAmount = e.deltaY > 0 ? 0.9 : 1.1;
    const { x: mx_b, y: my_b } = screenToWorld(e.clientX, e.clientY);
    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * zoomAmount));
    const after = screenToWorld(e.clientX, e.clientY);
    camera.x += mx_b - after.x;
    camera.y += my_b - after.y;
    clampCamera();
}, { passive: false });
canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!player || player.hp <= 0 || !gameLoopRunning) return;
    const wType = document.getElementById('weapon-select')?.value;
    if (wType !== 'missile' && wType !== 'beam') return;
    const rect = canvas.getBoundingClientRect();
    const _ffSx = (e.clientX - rect.left) * (cssW / rect.width);
    const _ffSy = (e.clientY - rect.top) * (cssH / rect.height);
    const _ffWx = (_ffSx / camera.zoom) + camera.x;
    const _ffWy = (_ffSy / camera.zoom) + camera.y;
    const _ffAng = Math.atan2(_ffWy - player.y, _ffWx - player.x);
    let _ffDiff = _ffAng - player.angle;
    while (_ffDiff < -Math.PI) _ffDiff += Math.PI * 2;
    while (_ffDiff > Math.PI) _ffDiff -= Math.PI * 2;
    const _ffMaxArc = WEAPON_FIRE_ARC[wType] || (Math.PI / 4);
    if (Math.abs(_ffDiff) > _ffMaxArc) {
        logMessage(`WEP: 射角外 — 艦首±${Math.round(_ffMaxArc * 180 / Math.PI)}°以内に向けてから発射`, 'warning-msg');
        return;
    }
    if (player.fireCooldown > 0) return;
    const _ffGenFactor = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
    if (wType === 'missile') {
        if (player.missileReloading) { logMessage('WEP: MISSILEリロード中', 'warning-msg'); return; }
        const _ffTarget = { x: _ffWx, y: _ffWy, hp: 999, radius: 1 };
        projectiles.push(new Projectile(player.x, player.y, _ffTarget, true, 'missile', 1.0));
        playSound('shoot');
        player.fireCooldown = WEAPON_COOLDOWNS.missile * _ffGenFactor;
        player.missileReloading = true;
        player.missileReloadTimer = Math.round(MISSILE_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0));
        if (opticTrails.length < 600) opticTrails.push({ x: player.x, y: player.y, intensity: 0.8, life: 1.0 });
        if (heatTrails.length < 600) heatTrails.push({ x: player.x, y: player.y, intensity: 0.9, life: 1.0, isPlayerTrail: false });
        logMessage('WEP: MISSILE 自由射撃 — 命中不問・自位置シグネチャ露出', 'warning-msg');
    } else if (wType === 'beam') {
        if (player.beamReloading) { logMessage('WEP: BEAMリロード中', 'warning-msg'); return; }
        const _bRange = 8000 * (WEAPONS_UPG_RANGE_MULT[gameState.upgrades.weapons] || 1.0);
        const _bDistToClick = Math.hypot(_ffWx - player.x, _ffWy - player.y);
        const _bLen = Math.min(_bRange, Math.max(100, _bDistToClick));
        const _bEndX = player.x + Math.cos(_ffAng) * _bLen;
        const _bEndY = player.y + Math.sin(_ffAng) * _bLen;
        effects.push({ x: player.x, y: player.y, tx: _bEndX, ty: _bEndY, type: 'beam', a: 1, c: '#00ffaa' });
        enemies.forEach(en => {
            if (en.hp <= 0) return;
            const _bdx = _bEndX - player.x, _bdy2 = _bEndY - player.y;
            const _bSqLen = _bdx * _bdx + _bdy2 * _bdy2;
            const _bt = _bSqLen > 0 ? Math.max(0, Math.min(1, ((en.x - player.x) * _bdx + (en.y - player.y) * _bdy2) / _bSqLen)) : 0;
            const _bcx = player.x + _bt * _bdx, _bcy = player.y + _bt * _bdy2;
            if (Math.hypot(en.x - _bcx, en.y - _bcy) < en.radius * 1.5) {
                const _hb = getHiggsIntensity((_bcx + en.x) / 2, (_bcy + en.y) / 2);
                en.hp -= 150 * (1 - _hb * 0.8);
                createHitEffect(en.x, en.y, '#00ffaa');
                addShake(15);
                logMessage('WEP: BEAM 命中！', 'system-msg');
            }
        });
        const _bSteps = Math.max(5, Math.floor(_bLen / 60));
        for (let _bs = 0; _bs <= _bSteps; _bs++) {
            const _bT = _bs / _bSteps;
            const _bwx = player.x + (_bEndX - player.x) * _bT;
            const _bwy = player.y + (_bEndY - player.y) * _bT;
            const _bh = getHiggsIntensity(_bwx, _bwy);
            if (_bh > 0.08 && higgsWakes.length < 800) higgsWakes.push({ x: _bwx, y: _bwy, intensity: _bh * 1.4, life: 1.0 });
            if (_bs % 3 === 0 && opticTrails.length < 600) opticTrails.push({ x: _bwx, y: _bwy, intensity: 0.9, life: 1.0 });
        }
        if (emTrails.length < 600) emTrails.push({ x: player.x, y: player.y, intensity: 1.0, life: 1.0 });
        playSound('shoot');
        player.fireCooldown = WEAPON_COOLDOWNS.beam * _ffGenFactor;
        player.beamReloading = true;
        player.beamReloadTimer = BEAM_RELOAD_TIME;
        logMessage('WEP: BEAM 自由射撃 — ダークチャネル生成・EM/光学シグネチャ全露出', 'warning-msg');
    }
});

// ============================================================
// タッチ入力対応（スマホ用）
// ============================================================
// 操作方式:
//   1本指ドラッグ (即時)      → カメラパン (最も頻繁な操作なので即時)
//   1本指タップ (敵の上)      → ターゲットロック
//   1本指長押し (250ms, 移動量小) → ウェイポイント指定
//   2本指ドラッグ            → カメラパン
//   ピンチ                  → ズーム
// ============================================================
const touch = {
    startX: 0, startY: 0,
    lastX: 0, lastY: 0,
    startTime: 0,
    moved: false,
    waypointFired: false, // 長押しウェイポイント発動済み
    waypointTimer: null,  // 長押し判定タイマー
    pinchDist: 0,
    isPinching: false,
    holding: false,       // 単指ホールド進行中 (進捗リング表示用)
    holdSX: 0, holdSY: 0  // ホールド位置 (キャンバス相対スクリーン座標)
};

// 長押し=ウェイポイント / スワイプ=パン の取り違え対策:
// ・判定を 400ms に延長 (スワイプ開始の猶予を確保)
// ・許容移動を 10px に縮小 (少しでも動かしたらウェイポイントをキャンセル=パン優先)
const TOUCH_WAYPOINT_DELAY = 400;  // 長押し判定: 400ms
const TOUCH_MOVE_THRESHOLD = 10;   // 長押し中の最大許容移動距離 (px)

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
        const t = e.touches[0];
        touch.startX = t.clientX;
        touch.startY = t.clientY;
        touch.lastX = t.clientX;
        touch.lastY = t.clientY;
        touch.startTime = Date.now();
        touch.moved = false;
        touch.waypointFired = false;
        touch.isPinching = false;
        // ホールド進捗リング用 (キャンバス相対座標)
        const _cr = canvas.getBoundingClientRect();
        touch.holdSX = t.clientX - _cr.left;
        touch.holdSY = t.clientY - _cr.top;
        touch.holding = true;
        // 1本指ドラッグ = 即時カメラパン
        camera.isDragging = true;
        camera.lastX = t.clientX;
        camera.lastY = t.clientY;

        // 長押し検出: TOUCH_WAYPOINT_DELAY後にウェイポイント指定
        clearTimeout(touch.waypointTimer);
        touch.waypointTimer = setTimeout(() => {
            touch.holding = false;
            if (!touch.isPinching && !touch.moved && player) {
                const { x: worldX, y: worldY } = screenToWorld(touch.startX, touch.startY);
                // 指向性ソナー待機中: 長押しで発射方向を決定
                if (dirSonarPendingFire) {
                    dirSonarPendingFire = false;
                    canvas.style.cursor = 'default';
                    document.getElementById('btn-dir-sonar').classList.remove('pending-fire');
                    const angle = Math.atan2(worldY - player.y, worldX - player.x);
                    fireDirectionalSonar(angle);
                    touch.waypointFired = true;
                    return;
                }
                player.targetEntity = null;
                player.setTarget(worldX, worldY);
                createClickEffect(worldX, worldY, '#00ffaa');
                const dist = Math.hypot(worldX - player.x, worldY - player.y);
                const speedEst = Math.max(0.1, (genAlloc.engine / 100) * 3.0);
                const timeSeconds = Math.max(1, Math.floor(dist / (speedEst * 60)));
                logMessage(`NAV: 進路設定完了。到着予定時間はおよそ ${timeSeconds} 秒です。`, 'system-msg');
                playSound('ui');
                touch.waypointFired = true;
            }
        }, TOUCH_WAYPOINT_DELAY);
    } else if (e.touches.length === 2) {
        clearTimeout(touch.waypointTimer);
        touch.isPinching = true;
        touch.holding = false;
        camera.isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touch.pinchDist = Math.hypot(dx, dy);
    }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && !touch.isPinching) {
        const t = e.touches[0];
        const dx = t.clientX - touch.startX;
        const dy = t.clientY - touch.startY;
        if (Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD) {
            touch.moved = true;
            touch.holding = false; // スワイプ確定 → ウェイポイント進捗を中止 (パン優先)
            clearTimeout(touch.waypointTimer);
        }
        // タッチ位置をワールド座標で追跡 (指向性ソナー方向用)
        const mwt = screenToWorld(t.clientX, t.clientY);
        mouseWorldX = mwt.x; mouseWorldY = mwt.y;
        // 1本指ドラッグ = カメラパン (getBoundingClientRect補正済み)
        const dtd = dragDeltaWorld(t.clientX - touch.lastX, t.clientY - touch.lastY);
        camera.x -= dtd.dx; camera.y -= dtd.dy;
        touch.lastX = t.clientX;
        touch.lastY = t.clientY;
        clampCamera();
    } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const newDist = Math.hypot(dx, dy);
        const zoomAmount = newDist / touch.pinchDist;
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const { x: mx_b, y: my_b } = screenToWorld(cx, cy);
        camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * zoomAmount));
        const afterP = screenToWorld(cx, cy);
        camera.x += mx_b - afterP.x;
        camera.y += my_b - afterP.y;
        touch.pinchDist = newDist;
        clampCamera();
    }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    clearTimeout(touch.waypointTimer);
    touch.holding = false;
    camera.isDragging = false;
    const elapsed = Date.now() - touch.startTime;

    // 短いタップ (移動なし, 250ms未満) → 敵の上なら ターゲットロック
    if (!touch.moved && !touch.waypointFired && !touch.isPinching && elapsed < TOUCH_WAYPOINT_DELAY && player) {
        const { x: worldX, y: worldY } = screenToWorld(touch.startX, touch.startY);
        // タッチはロックオン判定を広く取る（指で画面を押すと視認が難しいため）
        const tapRadius = en => en.radius * 6 + 20;
        let clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < tapRadius(en));
        if (clickedEnemy) {
            player.targetEntity = clickedEnemy;
            player.manualTarget = true;
            createClickEffect(clickedEnemy.x, clickedEnemy.y, '#ff4d4d');
            logMessage(`TACTICAL: ターゲットをロック。射撃解を計算中...`, 'system-msg');
        }
        // 空き領域タップは何もしない (ウェイポイントは長押しで)
    }
    if (e.touches.length < 2) {
        touch.isPinching = false;
    }
}, { passive: false });

// Classes
class Structure {
    constructor(x, y, type) {
        this.x = x; this.y = y; this.type = type; // 'colony' or 'derelict'
        this.radius = type === 'colony' ? 60 : 30;
        this.hacked = false;
        this.discovered = false;
        this.color = type === 'colony' ? 'rgba(34, 68, 170, 0.5)' : 'rgba(85, 85, 85, 0.5)';
        // 偽装ビーコン (ハッキング後)
        this.decoyActive = false;
        this.decoyTimer = 0;       // 偽装発信の残り時間 (フレーム数)
        this.decoyType = null;     // 'colony' = 全センサー偽装, 'derelict' = 熱源移動偽装
        this.decoyWaypoint = null; // 難破船: 偽装目標の移動先 {x, y}
        this.decoyMoveX = 0;       // 移動偽装の現在位置
        this.decoyMoveY = 0;
    }
    draw(ctx) {
        const t = Date.now();
        const hColor = this.hacked ? '#00aaff' : null;

        // Adaptive icon scale: full size at zoom>=1, shrinks proportionally below
        const _iconS = Math.max(4, Math.min(28, camera.zoom * 28)) / (camera.zoom * 28);
        // スプライト優先 (読み込めていればベクターより優先)
        const _ssp = SPRITES[this.type === 'colony' ? 'colony' : 'derelict'];
        if (spriteReady(_ssp)) {
            ctx.save();
            ctx.translate(this.x, this.y);
            if (this.type === 'colony') ctx.rotate(t * 0.00008); // 母船はごくゆっくり自転
            if (this.hacked) {
                // ハック済み: シアンのグローを背後に
                ctx.globalAlpha = 0.35 + Math.sin(t * 0.004) * 0.2;
                const hg = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 1.6);
                hg.addColorStop(0, 'rgba(0,200,255,0.5)');
                hg.addColorStop(1, 'rgba(0,170,255,0)');
                ctx.fillStyle = hg;
                ctx.beginPath(); ctx.arc(0, 0, this.radius * 1.6, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = 1;
            }
            drawSpriteCentered(ctx, _ssp, this.radius * 2.6);
            ctx.restore();
        } else if (this.type === 'colony') {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.scale(_iconS, _iconS);
            ctx.strokeStyle = hColor || 'rgba(60,100,220,0.9)';
            ctx.fillStyle = hColor ? 'rgba(0,100,200,0.25)' : 'rgba(34,68,170,0.25)';
            ctx.lineWidth = 2;
            ctx.shadowColor = hColor || '#2244aa'; ctx.shadowBlur = 3;
            // Octagonal body
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
                const px = Math.cos(a) * 28, py = Math.sin(a) * 28;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath(); ctx.fill(); ctx.stroke();
            // Cross frame
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(-28, 0); ctx.lineTo(28, 0);
            ctx.moveTo(0, -28); ctx.lineTo(0, 28);
            ctx.stroke();
            // Rotating corner nodes
            const rAngle = t * 0.0006;
            for (let i = 0; i < 4; i++) {
                const a = (i / 4) * Math.PI * 2 + rAngle;
                ctx.fillStyle = hColor ? '#00ffaa' : '#4466cc';
                ctx.shadowBlur = 2;
                ctx.beginPath();
                ctx.arc(Math.cos(a) * 36, Math.sin(a) * 36, 4, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.shadowBlur = 0;
            ctx.restore();
        } else {
            // Derelict wreckage
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.scale(_iconS, _iconS);
            ctx.strokeStyle = hColor || 'rgba(140,115,80,0.9)';
            ctx.fillStyle = hColor ? 'rgba(0,100,200,0.2)' : 'rgba(70,60,45,0.55)';
            ctx.lineWidth = 2;
            ctx.shadowColor = hColor || '#554433'; ctx.shadowBlur = 2;
            // Irregular hull fragment
            ctx.beginPath();
            ctx.moveTo(-6, -18); ctx.lineTo(13, -9);
            ctx.lineTo(18, 6); ctx.lineTo(4, 15);
            ctx.lineTo(-14, 12); ctx.lineTo(-17, -4);
            ctx.closePath(); ctx.fill(); ctx.stroke();
            // Internal fracture lines
            ctx.strokeStyle = hColor ? 'rgba(0,200,255,0.5)' : 'rgba(130,105,70,0.65)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-6, -18); ctx.lineTo(4, -3); ctx.lineTo(18, 6);
            ctx.moveTo(-14, 12); ctx.lineTo(4, -3);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.restore();
        }

        if (this.hacked) {
            ctx.beginPath();
            const r = 200 * ((t % 2000) / 2000);
            ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(0, 170, 255, ${1 - r / 200})`;
            ctx.lineWidth = 1 / camera.zoom; ctx.stroke();
        }

        // Name label (same adaptive scale as icon)
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(_iconS, _iconS);
        const _lColor = this.type === 'colony' ? (this.hacked ? '#00ffcc' : '#6699ff') : (this.hacked ? '#00ffcc' : '#bb9966');
        const _lText  = this.type === 'colony' ? (this.hacked ? 'COLONY [HACKED]' : 'COLONY NODE') : (this.hacked ? 'DERELICT [HACKED]' : 'DERELICT');
        ctx.fillStyle = _lColor;
        ctx.font = 'bold 11px Orbitron, monospace';
        ctx.textAlign = 'center';
        ctx.shadowColor = _lColor; ctx.shadowBlur = 3;
        ctx.fillText(_lText, 0, -46);
        ctx.shadowBlur = 0;
        ctx.restore();

        // 偽装ビーコン エフェクト
        if (this.decoyActive && this.decoyTimer > 0) {
            const pulse = 0.5 + Math.sin(t * 0.008) * 0.5;
            const col = this.decoyType === 'derelict' ? '255,80,0' : '255,50,200';
            const bx = this.decoyType === 'derelict' ? this.decoyMoveX : this.x;
            const by = this.decoyType === 'derelict' ? this.decoyMoveY : this.y;
            ctx.save();
            ctx.globalAlpha = pulse * 0.7;
            ctx.fillStyle = `rgba(${col},0.9)`;
            ctx.shadowColor = `rgba(${col},1)`; ctx.shadowBlur = 5;
            ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 0;
            // 拡散リング
            const rr = 300 * ((t % 1500) / 1500);
            ctx.beginPath(); ctx.arc(bx, by, rr, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${col},${(1 - rr / 300) * 0.6})`;
            ctx.lineWidth = 2 / camera.zoom;
            ctx.stroke();
            ctx.restore(); ctx.globalAlpha = 1;
        }
    }
}

class Station {
    constructor(x, y) {
        this.x = x; this.y = y;
        this.radius = 120;
        this.angle = 0;
        this.discovered = false;
    }
    draw(ctx) {
        this.angle += 0.005;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // Main core (Hexagon)
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const px = Math.cos(a) * 45;
            const py = Math.sin(a) * 45;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = '#4da6ff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = 'rgba(77, 166, 255, 0.2)';
        ctx.fill();

        // Outer rings
        ctx.beginPath();
        ctx.arc(0, 0, 85, 0, Math.PI * 2);
        ctx.setLineDash([20, 15]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Docking lights
        for (let i = 0; i < 4; i++) {
            const la = (i / 4) * Math.PI * 2 + this.angle * 2.5;
            ctx.fillStyle = (Date.now() % 1000 < 500) ? '#00ffaa' : '#004422';
            ctx.beginPath();
            ctx.arc(Math.cos(la) * 105, Math.sin(la) * 105, 6, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();

        // Label (adaptive font size so it remains readable at all zoom levels)
        ctx.save();
        const _stnFontPx = Math.max(9, Math.min(16, camera.zoom * 16)) / camera.zoom;
        ctx.font = `bold ${_stnFontPx.toFixed(1)}px Orbitron, monospace`;
        ctx.fillStyle = '#4da6ff';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 3; ctx.shadowColor = '#4da6ff';
        ctx.fillText("中立補給ステーション", this.x, this.y - 130);
        ctx.shadowBlur = 0;
        ctx.restore();
    }
}

class Projectile {
    constructor(x, y, target, isPlayer, type, dmgScale = 1) {
        this.x = x; this.y = y; this.isPlayer = isPlayer; this.type = type;
        this.target = target;
        this.active = true;
        this.distTraveled = 0;

        // §3-1 武装アップグレード: 射程倍率 (自機弾のみ)
        const _wRange = isPlayer ? (WEAPONS_UPG_RANGE_MULT[gameState.upgrades.weapons] || 1.0) : 1.0;
        if (type === 'kinetic') {
            this.speed = 12; this.maxDist = 800 * _wRange; this.dmg = 15 * dmgScale;
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'missile') {
            // §3-10 ミサイル2タイプ: homing=熱源誘導 / smart=AI追跡(EM強・デコイ耐性・大閃光)
            this.missileMode = isPlayer ? missileMode : 'homing';
            this.speed = this.missileMode === 'smart' ? 7.5 : 6;
            this.maxDist = (this.missileMode === 'smart' ? 2200 : 1500) * _wRange;
            this.dmg = (this.missileMode === 'smart' ? 65 : 50) * dmgScale;
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'beam') {
            this.active = false;
            if (target && target.hp > 0) {
                // ヒッグス高濃度エリアではビームダメージ大幅低下 (設計確定仕様)
                const higgsBetween = getHiggsIntensity((x + target.x) / 2, (y + target.y) / 2);
                const higgsBeamPenalty = 1 - higgsBetween * 0.8; // 最大80%ダメージ減衰
                // §3-1 装甲: beam耐性 (敵ビームが自機に当たる時)
                const beamArmorRes = (!isPlayer && target === player) ? ARMOR_RES_BEAM[gameState.upgrades.armor] : 0;
                target.hp -= 150 * higgsBeamPenalty * dmgScale * (1 - beamArmorRes);
                createHitEffect(target.x, target.y, isPlayer ? '#00ffaa' : '#ff4d4d');
                // ビーム着弾スプライトエフェクト
                const _bfxImg = SPRITES['fx_beam_impact'];
                if (spriteReady(_bfxImg)) {
                    effects.push({ type: 'fx-sprite', x: target.x, y: target.y, img: _bfxImg, r: target.radius * 4.5, life: 1.0, decay: 0.045 });
                }
                effects.push({ x: this.x, y: this.y, tx: target.x, ty: target.y, type: 'beam', a: 1, c: isPlayer ? '#00ffaa' : '#ff4d4d' });
                // ヒッグスダークチャネル: ビームがヒッグス雲を押し分けて通路を作る
                // ヒッグスセンサーで軌跡として可視化される
                const dx = target.x - x;
                const dy = target.y - y;
                const beamLen = Math.hypot(dx, dy);
                const steps = Math.max(5, Math.floor(beamLen / 60));
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const wx = x + dx * t;
                    const wy = y + dy * t;
                    const localHiggs = getHiggsIntensity(wx, wy);
                    if (localHiggs > 0.08) {
                        higgsWakes.push({ x: wx, y: wy, intensity: localHiggs * 1.4, life: 1.0 });
                    }
                    // §3-12 ビーム軌跡: optic trail (光学センサーで光跡が残る)
                    if (s % 3 === 0 && opticTrails.length < 600) {
                        opticTrails.push({ x: wx, y: wy, intensity: 0.9, life: 1.0 });
                    }
                    // §3-12 ビームチャージ: EM trail (チャージ＋発射でEM放射)
                    if (s % 4 === 0 && emTrails.length < 600) {
                        emTrails.push({ x: wx, y: wy, intensity: 0.7, life: 0.9 });
                    }
                }
            }
        }
    }
    update() {
        if (!this.active) return;

        if (this.type === 'missile' && this.target && this.target.hp > 0) {
            // 敵ミサイルはデコイ(強EM)に誘引される: 近傍デコイがあれば本標的より優先して追尾
            let homeX = this.target.x, homeY = this.target.y;
            if (!this.isPlayer) {
                // §3-10 AI追跡型ミサイル: aiPrec('sensor')確率でデコイ誘引を無効化
                const _smartResist = (this.missileMode === 'smart') ? aiPrec('sensor') * 0.9 : 0;
                if (Math.random() >= _smartResist) {
                    let best = null, bestD = DECOY_LURE_RADIUS;
                    for (const d of decoys) { const dd = Math.hypot(d.x - this.x, d.y - this.y); if (dd < bestD) { bestD = dd; best = d; } }
                    // 空母デコイドローンも強EM源としてミサイルを誘引 (§3-6)
                    for (const dr of playerDrones) { if (dr.type !== 'decoy') continue; const dd = Math.hypot(dr.x - this.x, dr.y - this.y); if (dd < bestD) { bestD = dd; best = dr; } }
                    if (best) { homeX = best.x; homeY = best.y; this._luredBy = best; }
                }
            }
            const targetAngle = Math.atan2(homeY - this.y, homeX - this.x);
            let diff = targetAngle - this.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            // 磁気嵐帯: EM誘導が乱れ旋回精度が落ちる (§3-13 D) → 嵐内のミサイルは外れやすい
            const _missileTurn = 0.05 * (1 - getStormIntensity(this.x, this.y) * STORM_MISSILE_DEGRADE);
            this.angle += diff * _missileTurn;
            // デコイに到達したらミサイルは消費される(無害化)
            if (this._luredBy && Math.hypot(this._luredBy.x - this.x, this._luredBy.y - this.y) < 40) {
                createHitEffect(this.x, this.y, '#cc99ff');
                this._luredBy.life = Math.min(this._luredBy.life, 30); // デコイも消耗
                this.active = false;
                return;
            }
        }

        this.x += Math.cos(this.angle) * this.speed;
        this.y += Math.sin(this.angle) * this.speed;
        this.distTraveled += this.speed;
        if (this.distTraveled > this.maxDist) this.active = false;
        // §3-12 弾跡trail生成 (センサー別の足跡)
        if (this.type === 'kinetic' && _frameCount % 2 === 0) {
            if (opticTrails.length < 600) opticTrails.push({ x: this.x, y: this.y, intensity: 0.75, life: 1.0 });
        } else if (this.type === 'missile') {
            if (_frameCount % 3 === 0) {
                if (heatTrails.length  < 600) heatTrails.push({  x: this.x, y: this.y, intensity: 0.85, life: 1.0 });
                if (emTrails.length    < 600) emTrails.push({    x: this.x, y: this.y, intensity: 0.55, life: 0.8 }); // 誘導EM
                if (opticTrails.length < 600) opticTrails.push({ x: this.x, y: this.y, intensity: 0.5,  life: 0.7 }); // 噴射光
            }
        }

        const hitTarget = this.isPlayer ? enemies.find(e => Math.hypot(e.x - this.x, e.y - this.y) < e.radius * 1.5) : (Math.hypot(player.x - this.x, player.y - this.y) < player.radius * 1.5 ? player : null);

        if (hitTarget && hitTarget.hp > 0) {
            // デブリ帯(岩礁帯): 遮蔽で実弾/ミサイルが外れやすい (ビームは貫通=Projectile生成時に即着弾でここを通らない)
            // AI命中精度(武器配分): 自機の弾はミス率を低減
            const _debHit = getDebrisIntensity(hitTarget.x, hitTarget.y);
            const _missChance = _debHit * DEBRIS_MISS * (this.isPlayer ? (1 - aiPrec('weapon') * AI_WEAPON_AIM) : 1);
            if (_missChance > 0 && Math.random() < _missChance) {
                this.active = false; // 岩片に阻まれ命中せず
                createHitEffect(this.x, this.y, '#8a8a7a');
                return;
            }
            // AI回避精度(エンジン配分): 自機への被弾を確率回避 (敵弾のみ対象)
            if (!this.isPlayer && hitTarget === player) {
                if (Math.random() < aiPrec('engine') * AI_ENGINE_DODGE) {
                    this.active = false;
                    effects.push({ x: player.x, y: player.y - 30, text: '回避', life: 1.0, type: 'floatText', c: '#00e0ff' });
                    return;
                }
            }
            let dmgMult = 1;
            let preemptive = false;
            // 後部取得ボーナス: 背後±99°から被弾=+50%ダメージ
            const _hitAng = Math.atan2(this.y - hitTarget.y, this.x - hitTarget.x);
            let _hitAngDiff = _hitAng - hitTarget.angle;
            while (_hitAngDiff < -Math.PI) _hitAngDiff += Math.PI * 2;
            while (_hitAngDiff > Math.PI) _hitAngDiff -= Math.PI * 2;
            if (Math.abs(_hitAngDiff) > Math.PI * 0.55) {
                dmgMult *= 1.5;
                if (!this.isPlayer && hitTarget === player) {
                    effects.push({ x: hitTarget.x, y: hitTarget.y - 28, text: '後方被弾 ×1.5', life: 1.0, type: 'floatText', c: '#ff6666' });
                }
            }
            // 先制攻撃ボーナス: 2x damage on unaware enemies
            if (this.isPlayer && hitTarget.detectionState === 'unaware') {
                dmgMult *= 2.0;
                preemptive = true;
                hitTarget.detectionState = 'alerted'; // Now they know!
                hitTarget.isAggro = true; hitTarget.aggroTimer = 600;
            }
            if (!this.isPlayer) hitTarget.detectionState = 'alerted'; // Being hit alerts player too (no-op but consistent)
            // §3-1 装甲: 武器種別耐性 (敵弾が自機に当たる時のみ)
            if (!this.isPlayer && hitTarget === player) {
                const armorLv = gameState.upgrades.armor;
                const res = (this.type === 'kinetic' ? ARMOR_RES_KINETIC[armorLv]
                           : this.type === 'missile' ? ARMOR_RES_MISSILE[armorLv] : 0);
                dmgMult *= (1 - res);
            }
            hitTarget.hp -= this.dmg * dmgMult;
            this.active = false;
            createHitEffect(this.x, this.y, this.isPlayer ? '#ffaa00' : '#ff4d4d');
            addShake((this.dmg * dmgMult) / 10);
            // kinetic着弾フラッシュスプライト
            if (this.type === 'kinetic') {
                const _kfxImg = SPRITES['fx_kinetic_flash'];
                if (spriteReady(_kfxImg)) {
                    effects.push({ type: 'fx-sprite', x: this.x, y: this.y, img: _kfxImg, r: 18, life: 1.0, decay: 0.10 });
                }
            }
            // §3-10 AI追跡型ミサイル: 着弾時に大閃光 (光学強) — HIGGSセンサー+OPTICで位置特定される
            if (this.type === 'missile' && this.missileMode === 'smart') {
                effects.push({ x: this.x, y: this.y, r: 0, maxR: 550, a: 0.75, c: '#ffffff', type: 'circle' });
                effects.push({ x: this.x, y: this.y, r: 0, maxR: 380, a: 0.65, c: '#aaddff', type: 'circle' });
                const _sfxImg = SPRITES['fx_explosion_big'];
                if (spriteReady(_sfxImg)) {
                    effects.push({ type: 'fx-sprite', x: this.x, y: this.y, img: _sfxImg, r: 38, life: 1.0, decay: 0.020 });
                }
            }
            if (preemptive) {
                effects.push({ x: hitTarget.x, y: hitTarget.y - 30, text: `先制! x2 (${Math.floor(this.dmg * dmgMult)})`, life: 1.0, type: 'floatText', c: '#ffff00' });
            }
        }
    }
    draw(ctx) {
        if (!this.active) return;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);
        if (this.type === 'kinetic') {
            const _boltKey = this.isPlayer ? 'fx_bolt_player' : 'fx_bolt_enemy';
            const _boltImg = SPRITES[_boltKey];
            if (spriteReady(_boltImg)) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.92;
                ctx.drawImage(_boltImg, -14, -9, 28, 18);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
            } else {
                const c = this.isPlayer ? '#00ffaa' : '#ff4d4d';
                ctx.fillStyle = c;
                ctx.beginPath();
                ctx.moveTo(7, 0); ctx.lineTo(0, -1.5); ctx.lineTo(-5, -1);
                ctx.lineTo(-5, 1); ctx.lineTo(0, 1.5);
                ctx.closePath(); ctx.fill();
            }
        } else if (this.type === 'missile') {
            // ミサイル弾体スプライト
            const _mslImg = SPRITES['drone_missile'];
            if (spriteReady(_mslImg)) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.88;
                ctx.drawImage(_mslImg, -16, -11, 32, 22);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
            } else {
                ctx.fillStyle = '#ddd';
                ctx.beginPath();
                ctx.moveTo(8, 0); ctx.lineTo(2, -2.5); ctx.lineTo(-5, -2.5);
                ctx.lineTo(-6, -1.5); ctx.lineTo(-6, 1.5); ctx.lineTo(-5, 2.5); ctx.lineTo(2, 2.5);
                ctx.closePath(); ctx.fill();
                ctx.fillStyle = '#999';
                ctx.beginPath(); ctx.moveTo(-3, -2.5); ctx.lineTo(-7, -5); ctx.lineTo(-6, -2.5); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(-3, 2.5); ctx.lineTo(-7, 5); ctx.lineTo(-6, 2.5); ctx.closePath(); ctx.fill();
            }
            // Exhaust
            ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 3;
            ctx.fillStyle = '#ff9900';
            ctx.beginPath();
            ctx.moveTo(-6, -1.2); ctx.lineTo(-12, 0); ctx.lineTo(-6, 1.2);
            ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0;
            // ミサイル噴射スプライト (加算合成)
            const _mexImg = SPRITES['fx_missile_exhaust'];
            if (spriteReady(_mexImg)) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.80;
                ctx.drawImage(_mexImg, -28, -10, 20, 20);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
            }
        }
        ctx.restore();
    }
}


const WEAPON_COOLDOWNS = { kinetic: 15, missile: 100, beam: 200 };

// 武器マガジン・リロード定数
const KINETIC_RELOAD_TIME = 180; // 3秒 @60fps
const MISSILE_RELOAD_TIME = 300; // 5秒
const BEAM_RELOAD_TIME = 240;    // 4秒

class Ship {
    constructor(x, y, isPlayer = false, type = 'corvette') {
        this.x = x; this.y = y; this.isPlayer = isPlayer;
        this.targetX = x; this.targetY = y;
        this.state = 'idle';
        this.angle = 0;
        this.targetEntity = null;
        this.fireCooldown = 0;
        this.generatorOutput = 50;

        if (isPlayer) {
            this.type = gameState.shipType || 'assault';
            const hpBase = { assault: 3500, stealth: 700, carrier: 2500 };
            this.radius = 20;
            this.maxHp = hpBase[gameState.shipType] || 2000; // §3-1 装甲=耐性(HP増加なし)
        } else {
            this.type = type; // corvette, destroyer, carrier, fighter
            this.radius = type === 'carrier' ? 30 : (type === 'destroyer' ? 18 : (type === 'fighter' ? 6 : 12));
            this.maxHp = type === 'carrier' ? 800 : (type === 'destroyer' ? 500 : (type === 'fighter' ? 50 : 150));
        }
        this.hp = this.maxHp;
        this.prevHp = this.hp;
        this.visible = isPlayer;
        this.isAggro = false; // Tactical AI extension
        this.aggroTimer = 0;
        this.detectionState = isPlayer ? 'alerted' : 'unaware'; // 'unaware'|'scanning'|'alerted'
        this.detectionTimer = 0;
        this.alertLogged = false; // Prevent spam logging
        // ジエンド戦スタイル AIプロパティ
        this.lurking = !isPlayer;       // 潜伏モード (ヒッグス濃度の高い場所へ移動)
        this.postFireCooldown = 0;      // 発砲後の再配置タイマー
        this.fireFlashTimer = 0;        // 発砲直後の可視フラッシュタイマー
        this.weaponType = 'kinetic';    // 最後に発射した武器種 (シグネチャ計算用)
        this.repositionLogged = false;  // 再配置ログ重複防止
        if (!isPlayer) {
            this.aiState = 'lurking';   // 'lurking' | 'gathering' | 'hunting' | 'combat'
            this.huntTarget = null;      // {x,y} last known player position
            this.huntTimer = 0;
            this.gatherTarget = null;    // resource node being gathered
            this.resourcePoints = 0;
            this.droneSpawnTimer = 300 + Math.floor(Math.random() * 300); // carrier drone timer
            this.inVision = false;       // 有視界システム: プレイヤーの視野内フラグ
            // センサー制約型AI: 探知中のみ更新される最終既知位置(+速度)。
            // 接触を断つと古い予測のまま撃つ→ステルス/沈黙で回避できる (プレイヤーと対称)。
            this.playerLastKnownPos = null; // {x, y, vx, vy}
            this.contactFreshness = 0;      // 1.0=今フレーム探知, 喪失で減衰
        }
        if (isPlayer) {
            this.manualTarget = false;   // 手動ターゲット指定フラグ (自動ロックオン上書き防止)
        }
        // 武器マガジン・リロードシステム (プレイヤー用)
        this.kineticAmmo = 8;
        this.kineticMaxAmmo = 8;
        this.kineticReloading = false;
        this.kineticReloadTimer = 0;
        this.missileReloading = false;
        this.missileReloadTimer = 0;
        this.beamReloading = false;
        this.beamReloadTimer = 0;

        // マルチセンサーシグネチャ
        this.heatSig = 0;    // 熱源シグネチャ: 移動中に上昇
        this.opticalSig = 0; // 光学シグネチャ: 発砲フラッシュ・低ヒッグス時
        this.emSig = 0;      // 電磁波シグネチャ: 潜伏中の受動放射・発砲時スパイク
        this.higgsSig = 0;   // ヒッグスシグネチャ: ヒッグス雲内での乱流・ウェイク
        this.prevX = x;
        this.prevY = y;
        this.currentSpeed = 0; // 慣性: 現在速度 (0=停止、移動ブロックで徐々に加速)
        // ソナーコンタクト
        this.contactAccuracy = 0;
        this.contactLife = 0;
        this.displayX = x;
        this.displayY = y;
    }

    setTarget(tx, ty) { this.targetX = tx; this.targetY = ty; this.state = 'moving'; }

    // デブリ帯(岩礁帯)による移動減速 (§3-13 D)。AI配分で姿勢制御補助=軽減 (プレイヤーのみ)。
    terrainSpeedMult() {
        const deb = getDebrisIntensity(this.x, this.y);
        if (deb <= 0) return 1;
        // AI配分で姿勢制御補助=軽減。自機はGEN AI配分、敵は固定の軽減(全く動けなくなるのを防ぐ)。
        const aiMit = this.isPlayer ? (genAlloc.ai / 100) * DEBRIS_AI_MITIGATE : DEBRIS_ENEMY_MITIGATE;
        // §3-1 エンジンアップグレード: デブリ減速もヒッグスの50%相当で軽減
        const engMit = this.isPlayer ? ENGINE_UPG_HIGGS_RESIST[gameState.upgrades.engine] * 0.5 : 0;
        return 1 - deb * DEBRIS_SLOW * (1 - aiMit) * (1 - engMit);
    }

    update() {
        if (this.hp <= 0) return;
        if (this.fireCooldown > 0) this.fireCooldown -= gameSpeedFactor;

        if (this.isPlayer) {
            // ── 自機シグネチャ再設計 (速度+エンジン配分+ゲイン を統一指標化) ──
            const _spd = Math.hypot(this.x - (this.prevX ?? this.x), this.y - (this.prevY ?? this.y));
            const _engType = ENGINE_TYPES[gameState.engineType] || ENGINE_TYPES.thermonuclear;
            const _hHere = getHiggsIntensity(this.x, this.y);
            const _ep = genAlloc.engine / 100;
            const _gain = (typeof genGain === 'number' && genGain > 0) ? genGain : 1; // 0.5..2.0
            // 推進排気強度 0..1: 速度を主体に、エンジン配分とゲインで増減。停止中も僅かなアイドル放射。
            const _spdN = Math.min(1, _spd / 6);
            const _thrust = Math.min(1, (0.05 + _spdN * 0.85 + _ep * 0.10) * (0.55 + _gain * 0.45));
            // 各シグネチャ = 推進強度 × エンジン種別倍率。エンジンごとに支配的シグネチャが変わる。
            // §3-1 エンジンアップグレード: 熱効率改善でheatSig低下
            this.heatSig    = Math.min(1, _thrust * _engType.heatMult * 0.55 * (1 - ENGINE_UPG_HEAT_REDUCE[gameState.upgrades.engine]));
            this.opticalSig = Math.min(1, _thrust * _engType.optMult * 0.45 + (this.weaponType === 'beam' ? 0.5 : 0));
            // EM: 推進＋(センサー/AI処理放射)。ゲインで増幅。AI↑でEM↑(逆探知の法則)。
            this.emSig      = Math.min(1, (_thrust * 0.35 + genAlloc.sensors / 100 * 0.18 + genAlloc.ai / 100 * 0.40) * (0.6 + _gain * 0.4) * _engType.emMult);
            // 磁気嵐帯: 嵐がEM放射を覆い隠す → AIを安全に高配分できる退避所 (§3-13 D)
            this.emSig     *= (1 - getStormIntensity(this.x, this.y) * STORM_EM_MASK);
            // 熱雲: 環境熱ノイズが熱署名を埋もれさせる → HEATセンサーから隠れやすい (§3-13 Phase3)
            this.heatSig   *= (1 - getThermalIntensity(this.x, this.y) * THERMAL_HEAT_MASK);
            // ヒッグス: ヒッグス雲内を動くほどウェイク乱流。ヒッグスエンジンは特に顕著。
            this.higgsSig   = Math.min(1, _thrust * _hHere * 1.6 + (_engType.higgsSpeedBonus > 0 ? _thrust * _engType.higgsSpeedBonus * 0.7 : _thrust * 0.08));

            // 潜航型ジャミング: 発動中はEM放射が増し逆探知されやすい(情報↔露出のトレードオフ)。タイマー減衰もここで。
            if (gameState.shipType === 'stealth') {
                if (jamPulse > 0)  this.emSig = 1;
                else if (jamBurst > 0) this.emSig = Math.min(1, this.emSig + 0.4);
                else if (jamCont)  this.emSig = Math.min(1, this.emSig + 0.25);
            }
            if (jamBurst > 0)   jamBurst--;
            if (jamPulse > 0)   jamPulse--;
            if (jamPulseCD > 0) jamPulseCD--;

            // §P1 慣性ベース速度: 最高速度目標(_baseTargetSpeed)を計算。実加速は各移動ブロックで行う
            const _engTypeP = ENGINE_TYPES[gameState.engineType] || ENGINE_TYPES.thermonuclear;
            const _higgsHereEng = getHiggsIntensity(this.x, this.y);
            const _higgsSlowdown = 1 - _higgsHereEng * 0.45 * (1 - ENGINE_UPG_HIGGS_RESIST[gameState.upgrades.engine]);
            const _higgsBonusSpeed = _higgsHereEng * _engTypeP.higgsSpeedBonus;
            const _baseTargetSpeed = ((genAlloc.engine / 100) * genGain * 1.4 * (SHIP_MAX_SPEED_MULT[gameState.shipType] || 1.0) * _higgsSlowdown * _engTypeP.speedMult + _higgsBonusSpeed) * this.terrainSpeedMult() * gameSpeedFactor;
            if (this.currentSpeed === undefined) this.currentSpeed = 0;
            this.speed = this.currentSpeed; // 移動ブロックで更新される

            // 円形マップ境界検知
            if (Math.hypot(this.x - MAP_CX, this.y - MAP_CY) > MAP_RADIUS - 100 && !dialogOpen) {
                showDialog();
            }

            // §3-9 修復モード: 完全停止 + HP回復 + シグネチャ増大
            if (repairActive) {
                const _maxHp = { assault: 3500, stealth: 700, carrier: 2500 }[gameState.shipType] || 1500;
                this.hp = Math.min(_maxHp, this.hp + REPAIR_RATE);
                // 停止中は全センサーに脆弱 (シグネチャ増大)
                this.heatSig    = Math.min(1, this.heatSig    + 0.28 * REPAIR_SIG_MULT);
                this.emSig      = Math.min(1, this.emSig      + 0.35 * REPAIR_SIG_MULT);
                this.opticalSig = Math.min(1, this.opticalSig + 0.15 * REPAIR_SIG_MULT);
                this.higgsSig   = Math.min(1, this.higgsSig   + 0.10 * REPAIR_SIG_MULT);
                // 修復完了で自動解除
                if (this.hp >= _maxHp) {
                    repairActive = false;
                    logMessage('REGEN: 修復完了 — 全システム正常', 'system-msg');
                    const _rbl = document.getElementById('repair-drone-label');
                    const _rbtn = document.getElementById('btn-repair-drone');
                    if (_rbl) _rbl.textContent = 'REGEN';
                    if (_rbtn) { _rbtn.style.borderColor = '#44bbff'; _rbtn.style.color = '#88ddff'; }
                }
                return; // 移動・発射をスキップ
            }

            // 手動ターゲットが死亡したらフラグをリセット
            if (this.manualTarget && (!this.targetEntity || this.targetEntity.hp <= 0)) {
                this.manualTarget = false;
            }

            // Attacking logic
            if (!autoAttackEnabled) {
                // 自動攻撃OFF時は発射処理をスキップ
            } else if (this.targetEntity && this.targetEntity.hp > 0) {
                const dist = Math.hypot(this.targetEntity.x - this.x, this.targetEntity.y - this.y);
                const wType = document.getElementById('weapon-select').value;
                // ロック種別: 視野内=完全ロック / 視野外でセンサーコンタクトのみ=想定ロック
                // lock-on persistence: 有視界内ならフラグ記録
                if (this.targetEntity.inVision) this.targetEntity._wasLocked = true;
                // ロック保持距離: visionRadius × LOCK_PERSIST_BASE × AI精度補正
                const _visionR = computeVisionRadius();
                const _lockPersistRange = _visionR * LOCK_PERSIST_BASE * (1 + aiPrec('sensor') * 2.5);
                const _distToTgt = Math.hypot(this.targetEntity.x - this.x, this.targetEntity.y - this.y);
                if (_distToTgt >= _lockPersistRange) this.targetEntity._wasLocked = false;
                const _fullLock = !!this.targetEntity.inVision || (!!this.targetEntity._wasLocked && _distToTgt < _lockPersistRange);
                const _hasContact = (this.targetEntity.contactLife > 0) || ((this.targetEntity.contactAccuracy || 0) > 0);
                const _assumedLock = !_fullLock && _hasContact;
                let wRange = wType === 'missile' ? 1300 : (wType === 'beam' ? 800 : 500);
                // 想定ロック時、beamはヒッグスダークチャネル狙撃で長射程化 (設計: マップ端から狙撃可)
                if (wType === 'beam' && _assumedLock) wRange = 8000;

                let targetAngle = Math.atan2(this.targetEntity.y - this.y, this.targetEntity.x - this.x);
                let diff = targetAngle - this.angle;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                // 艦種別最大回頭レート制限
                const _pTR = (PLAYER_TURN_RATES[gameState.shipType] || PLAYER_TURN_RATE) * gameSpeedFactor;
                this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _pTR);

                // 旋回量に応じた速度低下 + 慣性加速
                const _tmC = Math.min(1, Math.abs(diff) / (Math.PI * 0.12));
                const _tsC = _baseTargetSpeed * (1 - (SHIP_TURN_SLOW[gameState.shipType] || 0.5) * _tmC);
                const _arC = (SHIP_ACCEL_RATE[gameState.shipType] || 0.008) * gameSpeedFactor;
                this.currentSpeed = this.currentSpeed < _tsC ? Math.min(_tsC, this.currentSpeed + _arC) : Math.max(_tsC, this.currentSpeed - _arC * 2.5);
                this.speed = this.currentSpeed;

                if (dist > wRange * 0.8) {
                    this.x += Math.cos(this.angle) * this.speed;
                    this.y += Math.sin(this.angle) * this.speed;
                } else if (this.currentSpeed > 0.02) {
                    this.x += Math.cos(this.angle) * this.currentSpeed;
                    this.y += Math.sin(this.angle) * this.currentSpeed;
                }

                // 射撃弧チェック: kinetic±150°/missile±45°/beam±10° (武器別射角)
                const _fireArc = WEAPON_FIRE_ARC[wType] || (Math.PI * 5/6);
                if (dist < wRange && this.fireCooldown <= 0 && Math.abs(diff) < _fireArc) {
                    // 想定ロックオン: 完全ロック=フルダメージ / 想定ロック=精度依存のダメージデバフ。
                    const _acc = _fullLock ? 1 : Math.max(0, Math.min(1, this.targetEntity.contactAccuracy || 0));
                    const _lockDmg = _fullLock ? 1 : (0.3 + 0.5 * _acc); // 想定=30〜80%
                    if (_fullLock !== this._fullLockPrev) {
                        this._fullLockPrev = _fullLock;
                        logMessage(_fullLock
                            ? 'LOCK: 完全ロックオン — フルダメージ'
                            : `LOCK: 想定ロックオン — センサー推定射撃 (威力${Math.round(_lockDmg * 100)}%)`,
                            _fullLock ? 'system-msg' : 'warning-msg');
                    }
                    // ── kinetic マガジン・リロード処理 ──
                    if (wType === 'kinetic') {
                        if (this.kineticReloading) {
                            this.kineticReloadTimer -= gameSpeedFactor;
                            if (this.kineticReloadTimer <= 0) {
                                this.kineticAmmo = this.kineticMaxAmmo;
                                this.kineticReloading = false;
                                logMessage('WEP: KINETICリロード完了', 'system-msg');
                            }
                            // リロード中は発射しない
                        } else {
                            this.weaponType = wType;
                            const proj = new Projectile(this.x, this.y, this.targetEntity, true, wType, _lockDmg);
                            projectiles.push(proj);
                            // 攻撃型特殊: 3連装同時発射 (kinetic時のみ)
                            if (gameState.shipType === 'assault') {
                                const spread = 0.12;
                                const baseAngle = Math.atan2(this.targetEntity.y - this.y, this.targetEntity.x - this.x);
                                [-spread, spread].forEach(offset => {
                                    const p = new Projectile(this.x, this.y, this.targetEntity, true, 'kinetic', _lockDmg);
                                    p.angle = baseAngle + offset;
                                    projectiles.push(p);
                                });
                            }
                            playSound('shoot');
                            const weaponGenFactor = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
                            this.fireCooldown = WEAPON_COOLDOWNS[wType] * weaponGenFactor;
                            this.kineticAmmo--;
                            if (this.kineticAmmo <= 0) {
                                this.kineticReloading = true;
                                // §3-1 武装アップグレード: リロード時間短縮
                                this.kineticReloadTimer = Math.round(KINETIC_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0));
                                logMessage('WEP: KINETICリロード中...', 'system-msg');
                            }
                        }
                    // ── missile マガジン・リロード処理 ──
                    } else if (wType === 'missile') {
                        if (this.missileReloading) {
                            this.missileReloadTimer -= gameSpeedFactor;
                            if (this.missileReloadTimer <= 0) {
                                this.missileReloading = false;
                                logMessage('WEP: MISSILEリロード完了', 'system-msg');
                            }
                            // リロード中は発射しない
                        } else {
                            this.weaponType = wType;
                            const proj = new Projectile(this.x, this.y, this.targetEntity, true, wType, _lockDmg);
                            projectiles.push(proj);
                            if (missileMode === 'smart') logMessage('WEP: MISSILE [AI追跡] 発射 — EM強・ジャミング耐性・大閃光', 'system-msg');
                            playSound('shoot');
                            const weaponGenFactor = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
                            this.fireCooldown = WEAPON_COOLDOWNS[wType] * weaponGenFactor;
                            this.missileReloading = true;
                            // §3-1 武装アップグレード: リロード時間短縮
                            this.missileReloadTimer = Math.round(MISSILE_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0));
                        }
                    // ── beam マガジン・リロード処理 ──
                    } else if (wType === 'beam') {
                        if (this.beamReloading) {
                            this.beamReloadTimer -= gameSpeedFactor;
                            if (this.beamReloadTimer <= 0) {
                                this.beamReloading = false;
                                logMessage('WEP: BEAMリロード完了', 'system-msg');
                            }
                            // リロード中は発射しない
                        } else {
                            this.weaponType = wType;
                            // 想定ロック長射程狙撃: 精度が低いほど推定位置を外す (命中ジッター)
                            const _beamMiss = _assumedLock && (Math.random() < (1 - _acc) * 0.6);
                            if (_beamMiss) {
                                // 外れ: ジッター点へビーム描画 (ダメージなし)。発射で自位置は露出する
                                const _jit = (1 - _acc) * 700 + 80;
                                const _ex = this.targetEntity.x + (Math.random() - 0.5) * 2 * _jit;
                                const _ey = this.targetEntity.y + (Math.random() - 0.5) * 2 * _jit;
                                effects.push({ x: this.x, y: this.y, tx: _ex, ty: _ey, type: 'beam', a: 1, c: '#00ffaa' });
                                logMessage('WEP: BEAM 想定射撃 — 推定位置を外れた (命中せず)', 'warning-msg');
                            } else {
                                const proj = new Projectile(this.x, this.y, this.targetEntity, true, wType, _lockDmg);
                                projectiles.push(proj);
                            }
                            playSound('shoot');
                            const weaponGenFactor = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
                            this.fireCooldown = WEAPON_COOLDOWNS[wType] * weaponGenFactor;
                            this.beamReloading = true;
                            this.beamReloadTimer = BEAM_RELOAD_TIME;
                        }
                    }
                }
            } else if (this.state === 'moving') {
                const _wpDist = Math.hypot(this.targetX - this.x, this.targetY - this.y);
                if (_wpDist > Math.max(20, this.currentSpeed * 2)) {
                    const _wpTa = Math.atan2(this.targetY - this.y, this.targetX - this.x);
                    let _wpDiff = _wpTa - this.angle;
                    while (_wpDiff < -Math.PI) _wpDiff += Math.PI * 2;
                    while (_wpDiff > Math.PI) _wpDiff -= Math.PI * 2;
                    const _wpTR = (PLAYER_TURN_RATES[gameState.shipType] || PLAYER_TURN_RATE) * gameSpeedFactor;
                    this.angle += Math.sign(_wpDiff) * Math.min(Math.abs(_wpDiff), _wpTR);
                    // 旋回量→速度低下 + 慣性加速
                    const _tmWP = Math.min(1, Math.abs(_wpDiff) / (Math.PI * 0.12));
                    const _tsWP = _baseTargetSpeed * (1 - (SHIP_TURN_SLOW[gameState.shipType] || 0.5) * _tmWP);
                    const _arWP = (SHIP_ACCEL_RATE[gameState.shipType] || 0.008) * gameSpeedFactor;
                    this.currentSpeed = this.currentSpeed < _tsWP ? Math.min(_tsWP, this.currentSpeed + _arWP) : Math.max(_tsWP, this.currentSpeed - _arWP * 2.5);
                    this.speed = this.currentSpeed;
                    this.x += Math.cos(this.angle) * this.speed;
                    this.y += Math.sin(this.angle) * this.speed;
                } else {
                    this.state = 'idle';
                    const _arStop = (SHIP_ACCEL_RATE[gameState.shipType] || 0.008) * gameSpeedFactor;
                    this.currentSpeed = Math.max(0, this.currentSpeed - _arStop * 3);
                    this.speed = this.currentSpeed;
                    if (this.currentSpeed > 0.02) {
                        this.x += Math.cos(this.angle) * this.currentSpeed;
                        this.y += Math.sin(this.angle) * this.currentSpeed;
                    }
                }
            } else {
                // idle: 慣性で停止へ
                const _arIdle = (SHIP_ACCEL_RATE[gameState.shipType] || 0.008) * gameSpeedFactor;
                this.currentSpeed = Math.max(0, this.currentSpeed - _arIdle * 3);
                this.speed = this.currentSpeed;
            }

            // 前フレーム位置を保存 (次フレームの速度計算用)
            this.prevX = this.x; this.prevY = this.y;

            // UI
            const hpP = Math.max(0, (this.hp / this.maxHp) * 100);
            const hpFill = document.querySelector('.hp-fill');
            if (hpFill) {
                hpFill.style.width = hpP + '%';
                hpFill.style.backgroundColor = hpP < 30 ? '#ff4d4d' : '#00ffaa';
            }
            const stEl = document.querySelector('.status-text');
            if (stEl) stEl.textContent = `船体耐久度: ${Math.floor(hpP)}%`;
            const hcEl = document.getElementById('hostile-count');
            if (hcEl) hcEl.textContent = enemies.filter(e => e.visible).length || '不明';

        } else {
            // ============================================================
            // 敵AI — ジエンド戦スタイル (一対一・潜伏・発砲後再配置)
            // ============================================================

            // 発砲フラッシュタイマー更新 (発砲直後だけ可視になる)
            if (this.fireFlashTimer > 0) {
                this.fireFlashTimer--;
                this.visible = true;
            } else if (this.detectionState !== 'alerted' || this.lurking) {
                // 潜伏中はソナーコンタクトで制御
            }

            // 被弾したら即時探知状態へ (先制攻撃されても反応する)
            if (this.hp < this.prevHp) {
                this.detectionState = 'alerted';
                this.lurking = false;
            }
            this.prevHp = this.hp;

            // 偽装ビーコンへの誘引 (アクティブなデコイのみ)
            let decoyTarget = null;
            let decoyPosX = 0, decoyPosY = 0;
            structures.forEach(s => {
                if (!s.decoyActive || s.decoyTimer <= 0) return;
                const dx = s.decoyType === 'derelict' ? s.decoyMoveX : s.x;
                const dy = s.decoyType === 'derelict' ? s.decoyMoveY : s.y;
                const d = Math.hypot(this.x - dx, this.y - dy);
                if (d < RADAR_RANGE * 8) { decoyTarget = s; decoyPosX = dx; decoyPosY = dy; }
            });
            if (decoyTarget) {
                // 囮に釣られている
                const dDist = Math.hypot(decoyPosX - this.x, decoyPosY - this.y);
                if (dDist > 200) {
                    const ta = Math.atan2(decoyPosY - this.y, decoyPosX - this.x);
                    let diff = ta - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    const _eTR_dc = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                    this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_dc);
                    this.speed = 0.8;
                    this.x += Math.cos(this.angle) * this.speed;
                    this.y += Math.sin(this.angle) * this.speed;
                }
                return; // 囮を追ってる間は他のAIをスキップ
            }

            // ──────────────────────────────────────
            // 発砲後再配置フェーズ
            // ──────────────────────────────────────
            if (this.postFireCooldown > 0) {
                this.postFireCooldown--;
                this.speed = 1.2; // 素早く移動して新しい潜伏場所へ
                if (this.state === 'moving') {
                    const dist = Math.hypot(this.targetX - this.x, this.targetY - this.y);
                    if (dist > this.speed) {
                        this.x += ((this.targetX - this.x) / dist) * this.speed;
                        this.y += ((this.targetY - this.y) / dist) * this.speed;
                        const ta = Math.atan2(this.targetY - this.y, this.targetX - this.x);
                        let diff = ta - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        const _eTR_pf = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_pf);
                    } else {
                        this.state = 'idle';
                        this.lurking = true; // 新しい場所に着いたら潜伏再開
                        if (!this.repositionLogged) {
                            this.repositionLogged = true;
                            logMessage('SENSOR: 敵艦の熱源反応が消失。ヒッグス粒子の霧に再潜伏中...', 'warning-msg');
                        }
                    }
                } else if (this.postFireCooldown < 200) {
                    // 少し待ってから新しい隠れ場所へ移動
                    const hideSpot = findHidingSpot(
                        player.x + (Math.random() - 0.5) * FIELD_SIZE * 0.6,
                        player.y + (Math.random() - 0.5) * FIELD_SIZE * 0.6,
                        3000
                    );
                    this.setTarget(hideSpot.x, hideSpot.y);
                    this.repositionLogged = false;
                }
                return; // 再配置フェーズ中は他AIスキップ
            }

            // ──────────────────────────────────────
            // 自機シグネチャ探知チェック
            // ──────────────────────────────────────
            const distToPlayer = Math.hypot(player.x - this.x, player.y - this.y);
            const higgsHereDetect = getHiggsIntensity(this.x, this.y);
            const playerEmBoost = 0.5 + (genAlloc.ai / 100) * 0.5;
            // 潜航型ジャミング: ジャミング半径内の敵は探知レンジが劣化する
            let jamDegrade = 0;
            if (gameState.shipType === 'stealth') {
                if (jamPulse > 0 && distToPlayer < JAM_PULSE_RADIUS) {
                    jamDegrade = 1; // 瞬間全ブラインド
                } else {
                    if (jamBurst > 0 && distToPlayer < JAM_BURST_RADIUS) jamDegrade = Math.max(jamDegrade, JAM_BURST_DEGRADE);
                    if (jamCont && distToPlayer < JAM_CONT_RADIUS) jamDegrade = Math.max(jamDegrade, JAM_CONT_DEGRADE);
                }
            }
            const myDetectRange = 800 * (1 - higgsHereDetect * 0.55) * (1 + gameState.sector * 0.05) * playerEmBoost * (1 - jamDegrade);

            let playerSigDetected = false;
            let detectedSigStrength = 0;
            let domSig = null, domVal = 0; // 最も強く検知したシグネチャ種別 (行動推定用)
            if (player && player.hp > 0) {
                const pSigs = { heat: player.heatSig||0, optic: player.opticalSig||0, em: player.emSig||0, higgs: player.higgsSig||0 };
                const _mx = (player.x + this.x) / 2, _my = (player.y + this.y) / 2;
                const _debrisPath  = getDebrisIntensity(_mx, _my);
                const _stormPath   = getStormIntensity(_mx, _my);
                const _thermalPath = getThermalIntensity(_mx, _my);
                ['heat','optic','em','higgs'].forEach(sName => {
                    const sc2 = sensorConfig[sName];
                    const higgsPath = getHiggsIntensity(_mx, _my);
                    const distAtten = Math.max(0, 1 - distToPlayer / (myDetectRange * 2.5 * sc2.rangeScale));
                    // 地形ハザード: デブリ=OPTIC減衰 / 磁気嵐=EM減衰 / 熱雲=HEAT減衰 (§3-13)
                    let terrAtten = 1;
                    if (sName === 'optic') terrAtten = 1 - _debrisPath * DEBRIS_OPTIC_MOD;
                    else if (sName === 'em')   terrAtten = 1 - _stormPath   * STORM_EM_MOD;
                    else if (sName === 'heat') terrAtten = 1 - _thermalPath * THERMAL_HEAT_MOD;
                    const attenuated = pSigs[sName] * distAtten * (1 - higgsPath * sc2.higgsMod) * terrAtten;
                    if (attenuated > sc2.threshold * 0.6) { playerSigDetected = true; detectedSigStrength = Math.max(detectedSigStrength, attenuated); }
                    if (attenuated > domVal) { domVal = attenuated; domSig = sName; }
                });
                // 接近探知
                if (distToPlayer < myDetectRange) {
                    this.detectionTimer++;
                    if (this.detectionTimer > 60) playerSigDetected = true;
                } else {
                    this.detectionTimer = Math.max(0, this.detectionTimer - 1);
                }
            }

            // センサー制約型: 探知中のみ最終既知位置を更新。喪失後は古い予測が凍結される。
            if (playerSigDetected && player && player.hp > 0) {
                this.playerLastKnownPos = {
                    x: player.x, y: player.y,
                    vx: player.x - (player.prevX ?? player.x),
                    vy: player.y - (player.prevY ?? player.y)
                };
                this.contactFreshness = 1.0;
            } else {
                this.contactFreshness = Math.max(0, this.contactFreshness - 0.02);
            }

            // ──────────────────────────────────────
            // センサー制約型 行動推定 (predictedBehavior): 全知禁止 — 検知シグネチャだけから
            // プレイヤーの行動を推測し、状態別AIで適応戦略を取る。
            // ──────────────────────────────────────
            let pb = this.predictedBehavior || 'unknown';
            if (playerSigDetected && player) {
                const pm = { heat: player.heatSig||0, optic: player.opticalSig||0, em: player.emSig||0 };
                // 最寄りアクティブノードがプレイヤー近傍か (EMスパイク+ノード近接=収集)
                let nearNode = false;
                for (const n of resourceNodes) { if (n.active && Math.hypot(n.x-player.x, n.y-player.y) < 650) { nearNode = true; this._predNode = n; break; } }
                if (domSig === 'em' && nearNode)               pb = 'gathering';   // リソース収集 → 先回り
                else if (pm.heat > 0.4 && pm.em > 0.4 && pm.optic < 0.3) pb = 'charging'; // ビームチャージ → 回避
                else if (domSig === 'optic')                   pb = 'kinetic';     // 実弾多用 → アウトレンジ
                else                                            pb = 'moving';
            } else {
                pb = 'silent'; // 無反応 → 潜伏とみなす
            }
            if (pb !== this.predictedBehavior) {
                this.predictedBehavior = pb;
                if (this.aiState === 'combat' || this.aiState === 'hunting') {
                    const lbl = { gathering:'リソース収集を推定 — 先回り', charging:'ビームチャージを推定 — 回避運動', kinetic:'実弾戦を推定 — 距離を取り長射程へ', moving:'移動を捕捉', silent:'接触喪失 — 推定航路を捜索' };
                    if (lbl[pb]) logMessage(`敵AI: ${lbl[pb]}`, 'system-msg');
                }
            }

            // 探知時: 状態遷移
            if (playerSigDetected && this.aiState !== 'combat') {
                // 適応: リソース収集を推定したらノードへ先回り (プレイヤー周辺ではなくノードを抑える)
                if (this.predictedBehavior === 'gathering' && this._predNode && this._predNode.active) {
                    this.huntTarget = { x: this._predNode.x, y: this._predNode.y };
                } else {
                    this.huntTarget = { x: player.x + (Math.random()-0.5)*300, y: player.y + (Math.random()-0.5)*300 };
                }
                this.huntTimer = 480 + Math.floor(detectedSigStrength * 300);
                if (distToPlayer < 1800 || detectedSigStrength > 0.6) {
                    if (this.aiState !== 'combat') {
                        this.aiState = 'combat';
                        this.lurking = false;
                        this.detectionState = 'alerted';
                        if (!this.alertLogged) { this.alertLogged = true; logMessage('WARN: 敵艦があなたのシグネチャを捕捉。迎撃態勢に入ります。', 'warning-msg'); }
                    }
                } else if (this.aiState === 'lurking' || this.aiState === 'gathering') {
                    this.aiState = 'hunting';
                    this.gatherTarget = null;
                    this.lurking = false;
                    logMessage(`SENSOR: 敵艦が索敵パターンに移行。接近警戒。`, 'warning-msg');
                }
            }

            // キャリア: ドローン製造
            if (this.type === 'carrier') {
                this.droneSpawnTimer--;
                if (this.droneSpawnTimer <= 0 && enemies.filter(e=>e.hp>0).length < 5) {
                    const drone = new Ship(
                        this.x + (Math.random()-0.5)*300,
                        this.y + (Math.random()-0.5)*300, false, 'fighter'
                    );
                    drone.aiState = 'hunting';
                    drone.huntTarget = { x: player.x, y: player.y };
                    drone.huntTimer = 600;
                    drone.lurking = false;
                    enemies.push(drone);
                    this.droneSpawnTimer = 600 + Math.floor(Math.random() * 600);
                    logMessage('TACTICAL: 敵空母がファイタードローンを射出！', 'warning-msg');
                }
            }

            // ──────────────────────────────────────
            // 状態別AI実行
            // ──────────────────────────────────────
            if (this.aiState === 'combat') {
                this.lurking = false;
                const fireRange = 700 + gameState.sector * 25;
                this.speed = Math.min(2.0, 0.9 + gameState.sector * 0.08) * this.terrainSpeedMult() * gameSpeedFactor;

                // センサー制約型照準: 実プレイヤーではなく「最終既知位置」へ撃つ。
                // 接触が新しいほど速度ぶんリード外挿、喪失するほど古い点で凍結 → 移動/沈黙で外れる。
                const lk = this.playerLastKnownPos;
                const lead = this.contactFreshness * 40; // 鮮度に応じた外挿フレーム (最大40)
                const aimX = lk ? lk.x + lk.vx * lead : (player ? player.x : this.x);
                const aimY = lk ? lk.y + lk.vy * lead : (player ? player.y : this.y);
                const distToBelief = Math.hypot(aimX - this.x, aimY - this.y);

                if (distToBelief < fireRange && this.fireCooldown <= 0 && player && player.hp > 0) {
                    const ta = Math.atan2(aimY - this.y, aimX - this.x);
                    let diff = ta - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    const _eTR_cb = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                    this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_cb);
                    let wType = gameState.sector <= 2 ? 'kinetic' : (gameState.sector <= 4 ? 'missile' : 'beam');
                    // 適応: プレイヤーが実弾近接戦と推定されたら長射程へ切替 (アウトレンジ)
                    if (this.predictedBehavior === 'kinetic' && wType === 'kinetic') wType = 'missile';
                    this.weaponType = wType;
                    // 信じている照準点に向けて発射。kinetic/missileは飛翔体の命中判定が
                    // 実プレイヤーとのズレを自然に処理する。beamは即着弾のため、照準点が
                    // 実プレイヤーに十分近い時だけ実弾化し、外れていれば空撃ち(無害)にする。
                    const aimTarget = { x: aimX, y: aimY, hp: 1 };
                    let projTarget = aimTarget;
                    if (wType === 'beam') {
                        const missDist = Math.hypot(player.x - aimX, player.y - aimY);
                        projTarget = (missDist < player.radius * 2.2) ? player : aimTarget;
                    }
                    projectiles.push(new Projectile(this.x, this.y, projTarget, false, wType));
                    playSound('shoot');
                    this.fireCooldown = 150;
                    this.fireFlashTimer = 120;
                    this.visible = true;
                    const sigLabel = { kinetic: '銃口炎[光学]', missile: '推進炎[熱源+EM]', beam: 'EMパルス[EM+光学]' };
                    effects.push({ x: this.x, y: this.y, r: 0, maxR: 200, a: 0.9, c: '#ff4d4d', type: 'circle' });
                    logMessage(`WARNING: 敵艦発砲 — ${sigLabel[wType]||''}シグネチャ捕捉。`, 'warning-msg');
                    this.postFireCooldown = 280;
                } else {
                    // 適応移動: kinetic推定=距離を保つ(カイト) / charging推定=側方回避 / 他=予測点へ接近
                    const pbv = this.predictedBehavior;
                    const standoff = pbv === 'kinetic' ? fireRange * 1.15 : fireRange * 0.8;
                    let moveAngle = Math.atan2(aimY - this.y, aimX - this.x);
                    let doMove = false;
                    if (distToBelief > standoff) { doMove = true; }                                  // 接近
                    else if (pbv === 'kinetic' && distToBelief < fireRange * 0.85) { moveAngle += Math.PI; doMove = true; } // 離脱(カイト)
                    if (pbv === 'charging') {                                                          // ビーム回避: 側方ストレイフ
                        const dodgeDir = this._dodgeDir || (this._dodgeDir = (Math.random() < 0.5 ? 1 : -1));
                        moveAngle += dodgeDir * (Math.PI / 2.5);
                        doMove = true;
                    }
                    if (doMove) {
                        let diff = moveAngle - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        const _eTR_cm = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_cm);
                        this.x += Math.cos(this.angle) * this.speed;
                        this.y += Math.sin(this.angle) * this.speed;
                    }
                }
                // シグネチャ喪失 → lurking
                if (!playerSigDetected) {
                    this.huntTimer = Math.max(0, this.huntTimer - 1);
                    if (this.huntTimer <= 0) { this.aiState = 'lurking'; this.lurking = true; this.alertLogged = false; this.detectionState = 'unaware'; }
                } else {
                    this.huntTimer = Math.min(600, this.huntTimer + 2);
                }

            } else if (this.aiState === 'hunting') {
                this.lurking = false;
                this.speed = Math.min(1.5, 0.8 + gameState.sector * 0.06) * this.terrainSpeedMult() * gameSpeedFactor;
                if (this.huntTimer > 0) this.huntTimer--;
                if (this.huntTarget) {
                    const dist = Math.hypot(this.huntTarget.x - this.x, this.huntTarget.y - this.y);
                    if (dist > this.speed * 2) {
                        const ta = Math.atan2(this.huntTarget.y - this.y, this.huntTarget.x - this.x);
                        let diff = ta - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        const _eTR_hn = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_hn);
                        this.x += Math.cos(this.angle) * this.speed;
                        this.y += Math.sin(this.angle) * this.speed;
                    } else {
                        this.huntTarget = null;
                    }
                }
                if (this.huntTimer <= 0 && !playerSigDetected) { this.aiState = 'lurking'; this.lurking = true; this.detectionState = 'unaware'; }

            } else if (this.aiState === 'gathering') {
                this.lurking = false;
                this.speed = Math.min(1.2, 0.7 + gameState.sector * 0.05) * this.terrainSpeedMult() * gameSpeedFactor;
                // 最寄りノード探索
                if (!this.gatherTarget || !this.gatherTarget.active) {
                    let closest = null, closestDist = Infinity;
                    resourceNodes.forEach(n => { if (!n.active) return; const d = Math.hypot(n.x-this.x, n.y-this.y); if (d < closestDist) { closestDist=d; closest=n; } });
                    this.gatherTarget = closest;
                    if (!closest) { this.aiState = 'lurking'; this.lurking = true; }
                }
                if (this.gatherTarget) {
                    const dist = Math.hypot(this.gatherTarget.x - this.x, this.gatherTarget.y - this.y);
                    if (dist > 50) {
                        const ta = Math.atan2(this.gatherTarget.y - this.y, this.gatherTarget.x - this.x);
                        let diff = ta - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        const _eTR_ga = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_ga);
                        this.x += Math.cos(this.angle) * this.speed;
                        this.y += Math.sin(this.angle) * this.speed;
                    } else if (this.gatherTarget.active) {
                        this.gatherTarget.active = false;
                        this.gatherTarget.emFlashTimer = 120;
                        this.resourcePoints++;
                        if (this.resourcePoints >= 2) {
                            this.maxHp = Math.min(this.maxHp * 1.25, 4000);
                            this.hp = Math.min(this.hp + 150, this.maxHp);
                            this.resourcePoints = 0;
                            logMessage('SENSOR: 敵艦がリソースを回収し戦力を強化した。警戒せよ！', 'warning-msg');
                        }
                        this.gatherTarget = null;
                        this.aiState = 'lurking'; this.lurking = true;
                    }
                }

            } else {
                // lurking (default)
                this.lurking = true;
                this.speed = 0.08;
                const activeNodes = resourceNodes.filter(n => n.active);
                if (this.state === 'idle') {
                    if (activeNodes.length > 0 && Math.random() < 0.003) {
                        this.aiState = 'gathering';
                        logMessage('SENSOR: 敵艦がリソース収集パターンに移行。', 'system-msg');
                    } else if (Math.random() < 0.004) {
                        const hideSpot = findHidingSpot(this.x, this.y, 2500);
                        this.setTarget(hideSpot.x, hideSpot.y);
                    }
                }
                if (this.state === 'moving') {
                    const dist = Math.hypot(this.targetX - this.x, this.targetY - this.y);
                    if (dist > this.speed) {
                        this.x += ((this.targetX - this.x) / dist) * this.speed;
                        this.y += ((this.targetY - this.y) / dist) * this.speed;
                        const ta = Math.atan2(this.targetY - this.y, this.targetX - this.x);
                        let diff = ta - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        const _eTR_lk = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_lk);
                    } else this.state = 'idle';
                }
            }
        }

        // 敵艦: エンジン排気エフェクトは非表示 (センサー検知のみで捕捉)

        // ============================================================
        // マルチセンサーシグネチャ更新 (敵のみ)
        // ============================================================
        if (!this.isPlayer) {
            // 熱源シグネチャ: 移動量から計算
            const spd = Math.hypot(this.x - this.prevX, this.y - this.prevY);
            this.prevX = this.x;
            this.prevY = this.y;
            // 熱源シグネチャ: 武器種と状態で変化
            // - missile: 推進剤燃焼で長時間高熱
            // - beam: チャージ中に廃熱上昇
            // - 再配置中: エンジン全開で発熱
            const higgsHere = getHiggsIntensity(this.x, this.y);
            if (this.weaponType === 'missile' && this.fireFlashTimer > 20) {
                this.heatSig = Math.min(1.0, this.heatSig + 0.07); // ミサイル推進剤燃焼
            } else if (this.weaponType === 'beam' && this.fireFlashTimer > 60) {
                this.heatSig = Math.min(1.0, this.heatSig + 0.04); // ビームチャージ廃熱
            } else if (this.postFireCooldown > 0) {
                this.heatSig = Math.min(1.0, this.heatSig + 0.05); // 再配置エンジン全開
            } else {
                this.heatSig = Math.min(1.0, spd / 1.0); // 速度に比例
            }

            // 光学シグネチャ: 武器種で異なる
            // - kinetic: 銃口炎 (短く強烈な光学スパイク)
            // - missile: 打ち出し時の小フラッシュ
            // - beam: 中程度の光学 (エネルギー放射)
            if (this.weaponType === 'kinetic' && this.fireFlashTimer > 50) {
                this.opticalSig = Math.min(1.0, this.opticalSig + 0.18); // 銃口炎フラッシュ
            } else if (this.weaponType === 'beam' && this.fireFlashTimer > 40) {
                this.opticalSig = Math.min(1.0, this.opticalSig + 0.10); // ビーム光
            } else if (this.weaponType === 'missile' && this.fireFlashTimer > 100) {
                this.opticalSig = Math.min(1.0, this.opticalSig + 0.04); // 打ち出し小フラッシュ
            } else {
                // 発光フェード + ヒッグス減衰
                this.opticalSig = Math.max(0, this.opticalSig * 0.92) * (1 - higgsHere * 0.95);
            }

            // ヒッグスシグネチャ: ヒッグス雲内で潜伏すると乱流が生じる
            const higgsAtThisShip = higgsHere;
            if (this.lurking && this.postFireCooldown === 0) {
                // 潜伏中はヒッグス内の微妙な乱流 (濃度に比例)
                const target = higgsAtThisShip * 0.6 + Math.sin(Date.now() * 0.002 + this.y * 0.001) * 0.1;
                this.higgsSig += (target - this.higgsSig) * 0.04;
            } else if (this.postFireCooldown > 0) {
                // 再配置中: 高速移動でヒッグスウェイクが強まる
                // spd は prevX/prevY更新前 (line 863) に計算済み — ここで再宣言しない
                this.higgsSig = Math.min(1.0, higgsAtThisShip * spd * 1.5);
                // ウェイクを残す
                if (higgsAtThisShip > 0.15 && spd > 0.2) {
                    higgsWakes.push({ x: this.x, y: this.y, intensity: higgsAtThisShip * 0.8, life: 1.0 });
                }
                // §3-12 敵 HEAT trail (高速移動時の熱排気跡)
                if (this.heatSig > 0.08 && spd > 0.3 && Math.random() < 0.18) {
                    if (heatTrails.length < 600) heatTrails.push({ x: this.x, y: this.y, intensity: this.heatSig * 0.85, life: 1.0 });
                }
                // §3-12 敵 EM trail (AI処理/ミサイル誘導放射)
                if (this.emSig > 0.12 && Math.random() < 0.12) {
                    if (emTrails.length < 600) emTrails.push({ x: this.x, y: this.y, intensity: this.emSig * 0.9, life: 1.0 });
                }
            } else {
                this.higgsSig = Math.max(0, this.higgsSig - 0.02);
            }

            // 電磁波シグネチャ: 武器種で異なる
            // - beam: チャージ中に強いEMパルス (最大の特徴量)
            // - missile: 誘導系EMが持続
            // - kinetic: 薬莢排出の微弱EMのみ
            if (this.weaponType === 'beam' && this.fireFlashTimer > 50) {
                this.emSig = Math.min(1.0, this.emSig + 0.14); // ビームチャージ強EM
            } else if (this.weaponType === 'missile' && this.fireFlashTimer > 30) {
                this.emSig = Math.min(1.0, this.emSig + 0.05); // ミサイル誘導EM
            } else if (this.weaponType === 'kinetic' && this.fireFlashTimer > 90) {
                this.emSig = Math.min(1.0, this.emSig + 0.02); // 薬莢微弱EM
            } else if (this.lurking && this.postFireCooldown === 0) {
                // 潜伏中の受動EM漏洩 (ゆらぎあり)
                const target = 0.5 + Math.sin(Date.now() * 0.0015 + this.x * 0.001) * 0.1;
                this.emSig += (target - this.emSig) * 0.03;
            } else if (this.postFireCooldown > 0) {
                // 再配置中: 無線封鎖 (熱源は上がるがEMは下がる)
                this.emSig = Math.max(0, this.emSig - 0.025);
            } else {
                this.emSig = Math.max(0, this.emSig - 0.01);
            }
        }
    }

    draw(ctx) {
        if (!this.visible && !this.isPlayer) return;
        ctx.save();

        // ソナーコンタクト: 精度に基づいた表示位置とアルファ
        let drawX = this.x, drawY = this.y;
        if (!this.isPlayer && this.contactLife > 0) {
            drawX = this.displayX;
            drawY = this.displayY;
            const lifeAlpha = Math.min(1, this.contactLife / 60);
            const accAlpha  = 0.3 + this.contactAccuracy * 0.7;
            ctx.globalAlpha = lifeAlpha * accAlpha;
            // 低精度: 点滅
            if (this.contactAccuracy < 0.4 && Math.random() < 0.35) ctx.globalAlpha = 0;
        }

        ctx.translate(drawX, drawY);
        ctx.rotate(this.angle);

        // 発砲フラッシュ中は全不透明
        const isFlashing = !this.isPlayer && this.fireFlashTimer > 0;
        if (isFlashing) ctx.globalAlpha = 1.0;

        // ── LOD: 画面上のサイズが小さい時は超簡略描画 ──────────
        // zoom*radius*5.6 = 画面上の直径(CSSピクセル)。12px未満は詳細不要
        const _screenDiam = camera.zoom * this.radius * 5.6;
        if (_screenDiam < 12) {
            const r = this.radius * (_screenDiam < 6 ? 1.5 : 1.0);
            if (this.isPlayer) {
                ctx.fillStyle = '#00ffaa';
                ctx.beginPath();
                ctx.moveTo(r, 0); ctx.lineTo(-r * 0.7, -r * 0.6); ctx.lineTo(-r * 0.7, r * 0.6);
                ctx.closePath(); ctx.fill();
            } else {
                ctx.fillStyle = isFlashing ? '#ff8888' : '#ff4d4d';
                ctx.beginPath();
                ctx.moveTo(r, 0); ctx.lineTo(0, -r * 0.7); ctx.lineTo(-r, 0); ctx.lineTo(0, r * 0.7);
                ctx.closePath(); ctx.fill();
            }
            ctx.restore();
            return;
        }

        if (this.isPlayer) {
            // ── スプライト描画 (screen合成: 黒=背景と同化・hull正常表示・過飽和なし) ──
            const _pstype = gameState.shipType || 'assault';
            const _psprite = SPRITES[_pstype];
            if (spriteReady(_psprite)) {
                if (this.state === 'moving') {
                    // バーニア数連動スラスターグロー: THRUSTER_DEFS で艦種別位置を定義
                    const ecp = ENGINE_THRUST[gameState.engineType] || ENGINE_THRUST.thermonuclear;
                    const tpz = 0.6 + Math.sin(Date.now() * 0.008) * 0.4;
                    const vr  = this.radius * 2.8;
                    const slots = THRUSTER_DEFS[_pstype] || THRUSTER_DEFS.assault;
                    slots.forEach(([lxF, lyF]) => {
                        const tx = lxF * vr - vr * 0.10; // バーニア口から後方へ
                        const ty = lyF * vr;
                        const tg = ctx.createRadialGradient(tx, ty, 0, tx, ty, vr * 0.28);
                        tg.addColorStop(0,   `rgba(${ecp.core},${0.88 * tpz * ecp.a})`);
                        tg.addColorStop(0.4, `rgba(${ecp.mid},${0.48 * tpz * ecp.a})`);
                        tg.addColorStop(1,   'rgba(0,10,40,0)');
                        ctx.fillStyle = tg;
                        ctx.beginPath();
                        ctx.ellipse(tx, ty, vr * 0.28, vr * 0.10, 0, 0, Math.PI * 2);
                        ctx.fill();
                    });
                }
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = 0.9;
                drawSpriteCentered(ctx, _psprite, this.radius * 6.4);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                ctx.restore();
                return;
            }
            const vr = this.radius * 2.8; // ビジュアルスケール (当たり判定はthis.radius)
            const thrPulse = 0.65 + Math.sin(Date.now() * 0.008) * 0.35;
            const stype = gameState.shipType || 'assault';
            // エンジン種別 → 噴射色 (全艦種共通)
            const ec = ENGINE_THRUST[gameState.engineType] || ENGINE_THRUST.thermonuclear;
            // 噴射グロー描画ヘルパー: 中心(tx,ty)・長さlen・縦半径halfH
            const drawThruster = (tx, ty, len, halfH) => {
                const tg = ctx.createRadialGradient(tx, ty, 0, tx, ty, len);
                tg.addColorStop(0,   `rgba(${ec.core},${0.95 * thrPulse * ec.a})`);
                tg.addColorStop(0.3, `rgba(${ec.mid},${0.55 * thrPulse * ec.a})`);
                tg.addColorStop(1,   'rgba(0,10,40,0)');
                ctx.fillStyle = tg;
                ctx.beginPath();
                ctx.ellipse(tx, ty, len, halfH, 0, 0, Math.PI * 2);
                ctx.fill();
            };

            if (stype === 'assault') {
            // ============================================================
            // 攻撃型戦艦 (俯瞰トップダウン)
            // ============================================================
            // ── スラスター炎グロー (船体の後ろに描く) ──────────
            const thrOffsets = [-vr * 0.38, vr * 0.38];
            if (this.state === 'moving') {
                thrOffsets.forEach(yo => drawThruster(-vr * 0.88, yo, vr * 0.48, vr * 0.13));
            }

            // ── エンジンポッド (船尾) ────────────────────────────
            ctx.fillStyle = '#3e4455';
            // 上ポッド
            ctx.beginPath();
            ctx.moveTo(-vr * 0.10, -vr * 0.22);
            ctx.lineTo(-vr * 0.48, -vr * 0.22);
            ctx.lineTo(-vr * 0.88, -vr * 0.52);
            ctx.lineTo(-vr * 0.70, -vr * 0.58);
            ctx.lineTo(-vr * 0.08, -vr * 0.40);
            ctx.closePath(); ctx.fill();
            // 下ポッド
            ctx.beginPath();
            ctx.moveTo(-vr * 0.10,  vr * 0.22);
            ctx.lineTo(-vr * 0.48,  vr * 0.22);
            ctx.lineTo(-vr * 0.88,  vr * 0.52);
            ctx.lineTo(-vr * 0.70,  vr * 0.58);
            ctx.lineTo(-vr * 0.08,  vr * 0.40);
            ctx.closePath(); ctx.fill();
            // ポッドのアウトライン
            ctx.strokeStyle = '#555e70'; ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(-vr * 0.10, -vr * 0.22);
            ctx.lineTo(-vr * 0.48, -vr * 0.22);
            ctx.lineTo(-vr * 0.88, -vr * 0.52);
            ctx.lineTo(-vr * 0.70, -vr * 0.58);
            ctx.lineTo(-vr * 0.08, -vr * 0.40);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-vr * 0.10,  vr * 0.22);
            ctx.lineTo(-vr * 0.48,  vr * 0.22);
            ctx.lineTo(-vr * 0.88,  vr * 0.52);
            ctx.lineTo(-vr * 0.70,  vr * 0.58);
            ctx.lineTo(-vr * 0.08,  vr * 0.40);
            ctx.stroke();

            // ── メインハル ────────────────────────────────────────
            const hullGrad = ctx.createLinearGradient(-vr * 0.9, 0, vr * 1.05, 0);
            hullGrad.addColorStop(0,   '#353c4a');
            hullGrad.addColorStop(0.3, '#50586a');
            hullGrad.addColorStop(0.6, '#636e82');
            hullGrad.addColorStop(1,   '#464e5e');
            ctx.fillStyle = hullGrad;
            ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3;
            ctx.beginPath();
            ctx.moveTo( vr * 1.05,  0);
            ctx.lineTo( vr * 0.62, -vr * 0.20);
            ctx.lineTo( vr * 0.18, -vr * 0.22);
            ctx.lineTo(-vr * 0.10, -vr * 0.22);
            ctx.lineTo(-vr * 0.48, -vr * 0.22);
            ctx.lineTo(-vr * 0.85,  0);
            ctx.lineTo(-vr * 0.48,  vr * 0.22);
            ctx.lineTo(-vr * 0.10,  vr * 0.22);
            ctx.lineTo( vr * 0.18,  vr * 0.22);
            ctx.lineTo( vr * 0.62,  vr * 0.20);
            ctx.closePath();
            ctx.fill();
            ctx.shadowBlur = 0;

            // ハルアウトライン
            ctx.strokeStyle = '#6a7488'; ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo( vr * 1.05,  0);
            ctx.lineTo( vr * 0.62, -vr * 0.20);
            ctx.lineTo( vr * 0.18, -vr * 0.22);
            ctx.lineTo(-vr * 0.10, -vr * 0.22);
            ctx.lineTo(-vr * 0.48, -vr * 0.22);
            ctx.lineTo(-vr * 0.85,  0);
            ctx.lineTo(-vr * 0.48,  vr * 0.22);
            ctx.lineTo(-vr * 0.10,  vr * 0.22);
            ctx.lineTo( vr * 0.18,  vr * 0.22);
            ctx.lineTo( vr * 0.62,  vr * 0.20);
            ctx.closePath();
            ctx.stroke();

            // ── パネルライン ────────────────────────────────────
            ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.6;
            // 縦断面ライン
            [ vr * 0.18, -vr * 0.10, -vr * 0.48 ].forEach(xf => {
                const hw = xf > 0 ? vr * 0.21 : vr * 0.21;
                ctx.beginPath();
                ctx.moveTo(xf, -hw); ctx.lineTo(xf, hw);
                ctx.stroke();
            });
            // 中心縦ライン
            ctx.beginPath();
            ctx.moveTo(-vr * 0.85, 0); ctx.lineTo(vr * 0.85, 0);
            ctx.stroke();
            // 斜めリブライン
            ctx.beginPath();
            ctx.moveTo( vr * 0.62, -vr * 0.20); ctx.lineTo( vr * 0.18, -vr * 0.22);
            ctx.moveTo( vr * 0.62,  vr * 0.20); ctx.lineTo( vr * 0.18,  vr * 0.22);
            ctx.stroke();

            // ── 上部構造物 (艦橋) ───────────────────────────────
            ctx.fillStyle = '#404858';
            ctx.strokeStyle = '#5a6475'; ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo( vr * 0.30, -vr * 0.13);
            ctx.lineTo(-vr * 0.08, -vr * 0.16);
            ctx.lineTo(-vr * 0.28, -vr * 0.13);
            ctx.lineTo(-vr * 0.28,  vr * 0.13);
            ctx.lineTo(-vr * 0.08,  vr * 0.16);
            ctx.lineTo( vr * 0.30,  vr * 0.13);
            ctx.closePath();
            ctx.fill(); ctx.stroke();

            // ── 前部砲塔 ──────────────────────────────────────────
            ctx.fillStyle = '#303844';
            ctx.strokeStyle = '#4a5260'; ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.arc(vr * 0.50, -vr * 0.06, vr * 0.095, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
            // 砲身 (連装)
            ctx.strokeStyle = '#8090a8'; ctx.lineWidth = 1.6;
            [-vr * 0.035, vr * 0.035].forEach(by => {
                ctx.beginPath();
                ctx.moveTo(vr * 0.54, -vr * 0.06 + by);
                ctx.lineTo(vr * 0.76, -vr * 0.06 + by);
                ctx.stroke();
            });
            // 砲塔ハイライト
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.arc(vr * 0.48, -vr * 0.085, vr * 0.045, 0, Math.PI * 2);
            ctx.fill();

            // ── 後部砲塔 ─────────────────────────────────────────
            ctx.fillStyle = '#303844';
            ctx.strokeStyle = '#4a5260'; ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.arc(-vr * 0.12, 0, vr * 0.082, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
            // 砲身
            ctx.strokeStyle = '#8090a8'; ctx.lineWidth = 1.4;
            [-vr * 0.030, vr * 0.030].forEach(by => {
                ctx.beginPath();
                ctx.moveTo(-vr * 0.08, by);
                ctx.lineTo( vr * 0.12, by);
                ctx.stroke();
            });

            // ── ミサイルポッド (上側面前方) ────────────────────
            ctx.fillStyle = '#252c36';
            ctx.strokeStyle = '#3a4250'; ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.rect(vr * 0.08, -vr * 0.245, vr * 0.17, vr * 0.07);
            ctx.fill(); ctx.stroke();
            // 弾頭 (4発)
            ctx.fillStyle = '#aa2828';
            [0, 1, 2, 3].forEach(mi => {
                ctx.beginPath();
                ctx.arc(vr * 0.12 + mi * vr * 0.038, -vr * 0.215, 1.6, 0, Math.PI * 2);
                ctx.fill();
            });
            // 下側ポッド (対称)
            ctx.fillStyle = '#252c36';
            ctx.strokeStyle = '#3a4250'; ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.rect(vr * 0.08, vr * 0.175, vr * 0.17, vr * 0.07);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#aa2828';
            [0, 1, 2, 3].forEach(mi => {
                ctx.beginPath();
                ctx.arc(vr * 0.12 + mi * vr * 0.038, vr * 0.205, 1.6, 0, Math.PI * 2);
                ctx.fill();
            });

            // ── スラスターノズル ─────────────────────────────────
            thrOffsets.forEach(yo => {
                ctx.fillStyle = '#121820';
                ctx.strokeStyle = '#283040'; ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.ellipse(-vr * 0.84, yo, vr * 0.085, vr * 0.072, 0, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                // ノズル内グロー
                const nGrad = ctx.createRadialGradient(-vr * 0.84, yo, 0, -vr * 0.84, yo, vr * 0.07);
                nGrad.addColorStop(0,  `rgba(${ec.core},${0.9 * thrPulse * ec.a})`);
                nGrad.addColorStop(0.5,`rgba(${ec.mid},${0.4 * thrPulse * ec.a})`);
                nGrad.addColorStop(1,  'rgba(0,0,20,0)');
                ctx.fillStyle = nGrad;
                ctx.beginPath();
                ctx.ellipse(-vr * 0.84, yo, vr * 0.075, vr * 0.062, 0, 0, Math.PI * 2);
                ctx.fill();
            });

            // ── 戦闘ダメージ跡 ─────────────────────────────────
            ctx.strokeStyle = 'rgba(10,8,5,0.5)'; ctx.lineWidth = 0.9;
            [
                [ vr * 0.30,  vr * 0.10,  vr * 0.44,  vr * 0.18],
                [-vr * 0.25, -vr * 0.09, -vr * 0.14,  vr * 0.02],
                [ vr * 0.40, -vr * 0.16,  vr * 0.52, -vr * 0.08],
            ].forEach(([x1, y1, x2, y2]) => {
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
            });

            // ── グリーンアクセントライト ───────────────────────
            const lPulse = 0.55 + Math.sin(Date.now() * 0.003) * 0.45;
            const accentLights = [
                { x:  vr * 0.82,  y:  0 },
                { x:  vr * 0.18,  y: -vr * 0.225 },
                { x:  vr * 0.18,  y:  vr * 0.225 },
                { x: -vr * 0.42,  y: -vr * 0.225 },
                { x: -vr * 0.42,  y:  vr * 0.225 },
                { x: -vr * 0.72,  y: -vr * 0.44 },
                { x: -vr * 0.72,  y:  vr * 0.44 },
            ];
            ctx.shadowColor = '#00ff60';
            accentLights.forEach(l => {
                ctx.globalAlpha = lPulse * 0.85;
                ctx.shadowBlur  = 5;
                ctx.fillStyle   = '#30ff70';
                ctx.beginPath(); ctx.arc(l.x, l.y, 1.6, 0, Math.PI * 2); ctx.fill();
            });
            ctx.shadowBlur = 0; ctx.globalAlpha = 1;

            } else if (stype === 'stealth') {
            // ============================================================
            // 潜航型 (細く鋭いステルス艦・暗色・低被視認)
            // ============================================================
            const sr = vr * 0.95;
            // 単一の絞られた噴射 (ヒッグスエンジンならほぼ不可視)
            if (this.state === 'moving') {
                drawThruster(-sr * 0.86, 0, sr * 0.40, sr * 0.085);
            }
            // ── ハル (細長い鋭利な菱形) ──
            const sg = ctx.createLinearGradient(-sr * 0.85, 0, sr * 1.2, 0);
            sg.addColorStop(0,   '#161b24');
            sg.addColorStop(0.5, '#28303e');
            sg.addColorStop(1,   '#1b2230');
            ctx.fillStyle = sg;
            ctx.beginPath();
            ctx.moveTo( sr * 1.20,  0);
            ctx.lineTo( sr * 0.10, -sr * 0.14);
            ctx.lineTo(-sr * 0.55, -sr * 0.16);
            ctx.lineTo(-sr * 0.85,  0);
            ctx.lineTo(-sr * 0.55,  sr * 0.16);
            ctx.lineTo( sr * 0.10,  sr * 0.14);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = '#3a4760'; ctx.lineWidth = 0.8; ctx.stroke();
            // 中央リッジ
            ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.6;
            ctx.beginPath(); ctx.moveTo(sr * 1.10, 0); ctx.lineTo(-sr * 0.80, 0); ctx.stroke();
            // スウェプト翼 (薄く後退)
            ctx.fillStyle = '#1d2530';
            ctx.beginPath();
            ctx.moveTo(-sr * 0.10, -sr * 0.13); ctx.lineTo(-sr * 0.50, -sr * 0.52);
            ctx.lineTo(-sr * 0.62, -sr * 0.48); ctx.lineTo(-sr * 0.40, -sr * 0.14);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(-sr * 0.10,  sr * 0.13); ctx.lineTo(-sr * 0.50,  sr * 0.52);
            ctx.lineTo(-sr * 0.62,  sr * 0.48); ctx.lineTo(-sr * 0.40,  sr * 0.14);
            ctx.closePath(); ctx.fill();
            // パネルライン
            ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(sr * 0.10, -sr * 0.14); ctx.lineTo(sr * 0.10, sr * 0.14); ctx.stroke();
            // センサーアイ (控えめなシアン点滅)
            const sPulse = 0.5 + Math.sin(Date.now() * 0.004) * 0.5;
            ctx.globalAlpha = 0.45 + sPulse * 0.4;
            ctx.fillStyle = '#00ffcc';
            ctx.beginPath(); ctx.arc(sr * 0.55, 0, 1.4, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;

            } else {
            // ============================================================
            // 空母型 (横長フラットデッキ・ドローンベイ・低速重装)
            // ============================================================
            const cr = vr * 1.12;
            // 3基のスラスター
            if (this.state === 'moving') {
                [-cr * 0.34, 0, cr * 0.34].forEach(yo => drawThruster(-cr * 0.94, yo, cr * 0.38, cr * 0.10));
            }
            // ── ワイドハル ──
            const cg = ctx.createLinearGradient(-cr * 0.95, 0, cr * 0.9, 0);
            cg.addColorStop(0,   '#33414a');
            cg.addColorStop(0.5, '#566571');
            cg.addColorStop(1,   '#3e4a54');
            ctx.fillStyle = cg;
            ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
            ctx.beginPath();
            ctx.moveTo( cr * 0.86,  0);
            ctx.lineTo( cr * 0.50, -cr * 0.50);
            ctx.lineTo(-cr * 0.55, -cr * 0.60);
            ctx.lineTo(-cr * 0.92, -cr * 0.40);
            ctx.lineTo(-cr * 0.92,  cr * 0.40);
            ctx.lineTo(-cr * 0.55,  cr * 0.60);
            ctx.lineTo( cr * 0.50,  cr * 0.50);
            ctx.closePath();
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#6a7888'; ctx.lineWidth = 0.9; ctx.stroke();
            // フライトデッキ (中央の暗いスロット)
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.beginPath(); ctx.rect(-cr * 0.80, -cr * 0.16, cr * 1.30, cr * 0.32); ctx.fill();
            // デッキセンターライン
            ctx.strokeStyle = 'rgba(120,200,255,0.5)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(-cr * 0.75, 0); ctx.lineTo(cr * 0.45, 0); ctx.stroke();
            // ドローンベイ仕切り
            ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.6;
            [-cr * 0.40, -cr * 0.10, cr * 0.20].forEach(xf => {
                ctx.beginPath(); ctx.moveTo(xf, -cr * 0.16); ctx.lineTo(xf, cr * 0.16); ctx.stroke();
            });
            // 艦橋ブロック (右舷)
            ctx.fillStyle = '#404858'; ctx.strokeStyle = '#5a6475'; ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.rect(cr * 0.22, -cr * 0.50, cr * 0.18, cr * 0.20); ctx.fill(); ctx.stroke();
            // グリーンアクセントライト
            const cPulse = 0.55 + Math.sin(Date.now() * 0.003) * 0.45;
            ctx.fillStyle = '#30ff70'; ctx.globalAlpha = cPulse * 0.85;
            [{ x: cr * 0.70, y: 0 }, { x: -cr * 0.50, y: -cr * 0.55 }, { x: -cr * 0.50, y: cr * 0.55 }].forEach(l => {
                ctx.beginPath(); ctx.arc(l.x, l.y, 1.6, 0, Math.PI * 2); ctx.fill();
            });
            ctx.globalAlpha = 1;
            }
        } else {
            // ── 敵スプライト描画 (読み込めていればベクターより優先) ──
            const _eskey = ENEMY_SPRITE_KEY[this.type] || 'e_corvette';
            const _esprite = SPRITES[_eskey];
            if (spriteReady(_esprite)) {
                if (isFlashing) {
                    const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 3.5);
                    fg.addColorStop(0, 'rgba(255,90,90,0.5)');
                    fg.addColorStop(1, 'rgba(255,0,0,0)');
                    ctx.fillStyle = fg;
                    ctx.beginPath(); ctx.arc(0, 0, this.radius * 3.5, 0, Math.PI * 2); ctx.fill();
                }
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = 0.92;
                drawSpriteCentered(ctx, _esprite, this.radius * (isFlashing ? 6.2 : 5.6));
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                ctx.restore();
                return;
            }
            // 敵は発砲フラッシュ中は大きく赤く光る
            const r = isFlashing ? this.radius * 1.5 : this.radius;
            ctx.fillStyle = isFlashing ? '#ff8888' : '#ff4d4d';
            ctx.shadowColor = '#ff4d4d';
            ctx.shadowBlur = isFlashing ? 40 : 15;
            if (this.type === 'destroyer') {
                // Heavy warship - broad and angular
                ctx.beginPath();
                ctx.moveTo(r, 0);
                ctx.lineTo(r * 0.3, -r * 0.65);
                ctx.lineTo(-r * 0.4, -r * 0.85);
                ctx.lineTo(-r, -r * 0.4);
                ctx.lineTo(-r, r * 0.4);
                ctx.lineTo(-r * 0.4, r * 0.85);
                ctx.lineTo(r * 0.3, r * 0.65);
                ctx.closePath(); ctx.fill();
                ctx.shadowBlur = 0;
                ctx.fillStyle = isFlashing ? '#ffaaaa' : '#cc2222';
                ctx.beginPath(); ctx.rect(-r*0.35, -r*0.95, r*0.45, r*0.2); ctx.fill();
                ctx.beginPath(); ctx.rect(-r*0.35, r*0.75, r*0.45, r*0.2); ctx.fill();
            } else if (this.type === 'carrier') {
                // Capital ship - wide and flat
                ctx.beginPath();
                ctx.moveTo(r * 0.7, 0);
                ctx.lineTo(r * 0.35, -r * 0.45);
                ctx.lineTo(-r * 0.5, -r * 0.65);
                ctx.lineTo(-r, -r * 0.35);
                ctx.lineTo(-r, r * 0.35);
                ctx.lineTo(-r * 0.5, r * 0.65);
                ctx.lineTo(r * 0.35, r * 0.45);
                ctx.closePath(); ctx.fill();
                ctx.shadowBlur = 0;
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.beginPath(); ctx.rect(-r*0.8, -r*0.25, r*0.9, r*0.5); ctx.fill();
                ctx.strokeStyle = isFlashing ? '#ffaaaa' : '#cc2222';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(-r*0.8, 0); ctx.lineTo(-r*0.1, 0); ctx.stroke();
            } else if (this.type === 'fighter') {
                // Small dart with swept wings
                ctx.beginPath();
                ctx.moveTo(r * 1.2, 0);
                ctx.lineTo(-r * 0.2, -r * 0.45);
                ctx.lineTo(-r * 0.9, -r * 1.1);
                ctx.lineTo(-r * 0.9, -r * 0.3);
                ctx.lineTo(-r, 0);
                ctx.lineTo(-r * 0.9, r * 0.3);
                ctx.lineTo(-r * 0.9, r * 1.1);
                ctx.lineTo(-r * 0.2, r * 0.45);
                ctx.closePath(); ctx.fill();
            } else {
                // corvette - sleek raider
                ctx.beginPath();
                ctx.moveTo(r, 0);
                ctx.lineTo(r * 0.1, -r * 0.5);
                ctx.lineTo(-r * 0.5, -r * 0.75);
                ctx.lineTo(-r * 0.9, -r * 0.45);
                ctx.lineTo(-r * 0.7, 0);
                ctx.lineTo(-r * 0.9, r * 0.45);
                ctx.lineTo(-r * 0.5, r * 0.75);
                ctx.lineTo(r * 0.1, r * 0.5);
                ctx.closePath(); ctx.fill();
            }
            ctx.shadowBlur = 0;
        }

        if (this.isPlayer) {
            // 選択リング (ビジュアル半径に合わせて拡大)
            const vr2 = this.radius * 2.8;
            ctx.beginPath(); ctx.arc(0, 0, vr2 * 1.05, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,200,255,0.20)'; ctx.lineWidth = 1; ctx.stroke();
            // クロスヘア
            const cx2 = vr2 * 1.18, cx1 = vr2 * 1.06;
            ctx.beginPath();
            ctx.moveTo(-cx2, 0); ctx.lineTo(-cx1, 0);
            ctx.moveTo( cx2, 0); ctx.lineTo( cx1, 0);
            ctx.moveTo(0, -cx2); ctx.lineTo(0, -cx1);
            ctx.moveTo(0,  cx2); ctx.lineTo(0,  cx1);
            ctx.strokeStyle = 'rgba(0,200,255,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
            // §3-9 修復モード: 緑パルスリングで視覚フィードバック
            if (repairActive) {
                const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.007);
                ctx.globalAlpha = 0.35 + 0.3 * pulse;
                ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2.5;
                ctx.beginPath(); ctx.arc(0, 0, vr2 * (1.35 + 0.18 * pulse), 0, Math.PI * 2); ctx.stroke();
                ctx.globalAlpha = 0.15 + 0.1 * pulse;
                ctx.beginPath(); ctx.arc(0, 0, vr2 * (1.65 + 0.22 * pulse), 0, Math.PI * 2); ctx.stroke();
            }
        }
        ctx.restore();
        ctx.globalAlpha = 1;

        // ロックオン・レティクル: 完全ロック(視野内)=緑実線 / 想定ロック(センサー)=琥珀破線
        if (!this.isPlayer && player && player.targetEntity === this && this.hp > 0) {
            const lx = this.contactLife > 0 ? this.displayX : this.x;
            const ly = this.contactLife > 0 ? this.displayY : this.y;
            const lr = this.radius * 3.2 + 6;
            const full = !!this.inVision;
            ctx.save();
            ctx.translate(lx, ly);
            ctx.strokeStyle = full ? 'rgba(0,255,170,0.9)' : 'rgba(255,170,0,0.85)';
            ctx.lineWidth = 1.6;
            if (!full) ctx.setLineDash([6, 6]);
            const b = lr * 0.55; // コーナーブラケットの腕の長さ
            for (let q = 0; q < 4; q++) {
                const sx = (q & 1) ? 1 : -1;
                const sy = (q & 2) ? 1 : -1;
                ctx.beginPath();
                ctx.moveTo(sx * lr, sy * (lr - b));
                ctx.lineTo(sx * lr, sy * lr);
                ctx.lineTo(sx * (lr - b), sy * lr);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        if (!this.isPlayer && this.visible) {
            const dispX = this.contactLife > 0 ? this.displayX : this.x;
            const dispY = this.contactLife > 0 ? this.displayY : this.y;

            // 精度サークル (不確実性ゾーン)
            // センサー痕跡(不確実性サークル+候補)は drawSensorTrace() でフォグの後に描画(ヒッグスより手前)

            // HP バー (発砲フラッシュ中 or 高精度コンタクト時)
            if (isFlashing || this.contactAccuracy > 0.6) {
                const a = isFlashing ? 1.0 : Math.min(1, this.contactLife / 60) * this.contactAccuracy;
                ctx.globalAlpha = a;
                ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(dispX - 15, dispY - 28, 30, 4);
                ctx.fillStyle = this.hp / this.maxHp < 0.3 ? '#ff8800' : '#ff4d4d';
                ctx.fillRect(dispX - 15, dispY - 28, 30 * (this.hp / this.maxHp), 4);
                ctx.globalAlpha = 1;
            }
            // 敵艦名 (発砲フラッシュ中のみ)
            if (isFlashing) {
                ctx.fillStyle = '#ff8888';
                ctx.font = 'bold 11px Orbitron';
                ctx.textAlign = 'center';
                ctx.shadowColor = '#ff4d4d'; ctx.shadowBlur = 2;
                ctx.fillText(`HOSTILE [${gameState.sector}]`, dispX, dispY - 35);
                ctx.shadowBlur = 0;
            }
        }
    }

    // センサー痕跡(不確実性サークル + AIロックオン候補) — フォグ/ヒッグスの「手前」に描く専用パス
    drawSensorTrace(ctx) {
        if (this.isPlayer || this.hp <= 0) return;
        if (!(this.contactLife > 0 && this.contactAccuracy < 0.95)) return;
        const dispX = this.displayX, dispY = this.displayY;
        const uncertaintyR = Math.max(20, (1 - this.contactAccuracy) * 400);
        const acc = this.contactAccuracy;
        const col = acc > 0.7 ? '0,255,170' : (acc > 0.4 ? '255,170,0' : '255,77,77');
        const lifeA = Math.min(1, this.contactLife / 60) * 0.4;
        ctx.save();
        ctx.globalAlpha = lifeA;
        ctx.beginPath();
        ctx.arc(dispX, dispY, uncertaintyR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},0.7)`;
        ctx.lineWidth = 1.5 / camera.zoom;
        ctx.setLineDash([8 / camera.zoom, 8 / camera.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(${col},0.9)`;
        ctx.font = `${Math.round(9 / camera.zoom)}px Orbitron`;
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(acc * 100)}%`, dispX, dispY - uncertaintyR - 5 / camera.zoom);
        ctx.restore();
        ctx.globalAlpha = 1;

        // AIロックオン候補マーカー (§3-3): 低〜中精度のセンサー推定時のみ
        if (acc < 0.7) {
            if (this._candAcc !== acc || !this.candidates) {
                this._candAcc = acc;
                this.candidates = makeContactCandidates(acc);
            }
            ctx.save();
            ctx.globalAlpha = Math.min(1, lifeA * 2.2);
            ctx.font = `${Math.round(8 / camera.zoom)}px Orbitron`;
            ctx.textAlign = 'center';
            let bestP = 0;
            for (const c of this.candidates) if (c.p > bestP) bestP = c.p;
            for (const c of this.candidates) {
                const cxp = dispX + c.dx, cyp = dispY + c.dy;
                const dom = c.p === bestP;
                const cc = dom ? col : '160,160,170';
                const ms = (dom ? 7 : 5) / camera.zoom;
                ctx.strokeStyle = `rgba(${cc},0.9)`;
                ctx.lineWidth = (dom ? 1.5 : 1) / camera.zoom;
                ctx.beginPath();
                ctx.moveTo(cxp, cyp - ms); ctx.lineTo(cxp + ms, cyp);
                ctx.lineTo(cxp, cyp + ms); ctx.lineTo(cxp - ms, cyp);
                ctx.closePath(); ctx.stroke();
                ctx.fillStyle = `rgba(${cc},0.95)`;
                ctx.fillText(`${Math.round(c.p * 100)}%`, cxp, cyp - ms - 3 / camera.zoom);
            }
            ctx.restore();
            ctx.globalAlpha = 1;
        }
    }
}

function updateDrawDebrisParticles(ctx) {
    // Engine particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.shadowColor = p.color;
        ctx.shadowBlur  = (p.size || 2) > 2.5 ? 5 : 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, (p.size || 2) * p.life * 0.6 + (p.size || 2) * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur  = 0;
        ctx.globalAlpha = 1;
    }

    // Explosion debris fragments
    for (let i = debris.length - 1; i >= 0; i--) {
        let d = debris[i];
        d.x += d.vx; d.y += d.vy;
        d.rot += d.vrot;
        d.life -= d.decay;
        if (d.life <= 0) { debris.splice(i, 1); continue; }
        ctx.save();
        ctx.translate(d.x, d.y); ctx.rotate(d.rot);
        ctx.strokeStyle = d.color;
        ctx.globalAlpha = d.life;
        ctx.beginPath(); ctx.moveTo(-d.size, 0); ctx.lineTo(d.size, 0); ctx.stroke();
        ctx.restore();
    }
}

function createExplosion(x, y, color, size) {
    addShake(size * 0.5);
    playSound('explosion');
    // スプライトベース爆発エフェクト (加算合成: 黒=透明)
    const _exKey = size >= 20 ? 'fx_explosion_big' : 'fx_explosion_small';
    const _exImg = SPRITES[_exKey];
    if (spriteReady(_exImg)) {
        effects.push({ type: 'fx-sprite', x, y, img: _exImg, r: size * 1.3, life: 1.0, decay: 0.024 });
        if (size >= 20) {
            effects.push({ type: 'fx-sprite', x, y, img: _exImg, r: size * 0.75, life: 0.85, decay: 0.038 });
        }
    }
    for (let j = 0; j < 8; j++) createHitEffect(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 30, color);

    if (size < 5 && Math.random() < 0.3) {
        effects.push({ x, y, r: 0, maxR: 40, a: 0.5, c: '#4da6ff', type: 'circle' });
    }

    // Debris
    const fragmentCount = size;
    for (let i = 0; i < fragmentCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = Math.random() * 5 + 2;
        debris.push({
            x: x, y: y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 0.5,
            size: Math.random() * 10 + 5,
            life: 1.0, decay: Math.random() * 0.02 + 0.01,
            color: color
        });
    }
}

// Visual Effects
function createClickEffect(x, y, color) { effects.push({ x, y, r: 0, maxR: 30, a: 1, c: color, type: 'circle' }); }
function createHitEffect(x, y, color) { effects.push({ x, y, r: 0, maxR: 15, a: 1, c: color, type: 'hit' }); }

function updateDrawEffects(ctx) {
    for (let i = effects.length - 1; i >= 0; i--) {
        let ef = effects[i];
        if (ef.type === 'floatText') {
            // Floating damage text
            ef.y -= 0.8;
            ef.life -= 0.02;
            ctx.save();
            ctx.font = 'bold 18px Orbitron';
            ctx.fillStyle = ef.c;
            ctx.globalAlpha = ef.life;
            ctx.shadowColor = ef.c; ctx.shadowBlur = 3;
            ctx.textAlign = 'center';
            ctx.fillText(ef.text, ef.x, ef.y);
            ctx.shadowBlur = 0;
            ctx.restore();
            ctx.globalAlpha = 1;
            if (ef.life <= 0) effects.splice(i, 1);
        } else if (ef.type === 'beam') {
            ef.a -= 0.04;
            if (ef.a <= 0) { effects.splice(i, 1); continue; }
            const _bdx = ef.tx - ef.x, _bdy = ef.ty - ef.y;
            const _bAng = Math.atan2(_bdy, _bdx);
            const _bLen = Math.hypot(_bdx, _bdy);
            ctx.save();
            ctx.translate(ef.x, ef.y);
            ctx.rotate(_bAng);
            ctx.lineCap = 'round';
            // 外側拡散グロウ
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(_bLen, 0);
            ctx.strokeStyle = ef.c; ctx.lineWidth = 28 * ef.a; ctx.globalAlpha = ef.a * 0.10; ctx.stroke();
            // 中間グロウ
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(_bLen, 0);
            ctx.lineWidth = 12 * ef.a; ctx.globalAlpha = ef.a * 0.35; ctx.stroke();
            // コア白線
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(_bLen, 0);
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3 * ef.a; ctx.globalAlpha = ef.a * 0.95; ctx.stroke();
            ctx.restore();
            // 着弾点フラッシュ
            if (ef.a > 0.65) {
                const _flashR = 20 * ef.a;
                ctx.beginPath(); ctx.arc(ef.tx, ef.ty, _flashR, 0, Math.PI * 2);
                ctx.fillStyle = ef.c; ctx.globalAlpha = ef.a * 0.5; ctx.fill();
                ctx.beginPath(); ctx.arc(ef.tx, ef.ty, _flashR * 0.4, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff'; ctx.globalAlpha = ef.a * 0.9; ctx.fill();
            }
            ctx.globalAlpha = 1;
        } else if (ef.type === 'sonar') {
            ef.r += ef.speed;
            if (ef.r >= ef.maxR) {
                // 最大半径到達時: sonar-fillエフェクトを追加してフェードアウト
                effects.push({ type: 'sonar-fill', x: ef.x, y: ef.y, r: ef.maxR, a: 0.18, c: ef.c, life: 360 });
                effects.splice(i, 1);
            } else {
                ef.a = 0.7 * (1 - ef.r / ef.maxR) + 0.3;
                ctx.beginPath(); ctx.arc(ef.x, ef.y, ef.r, 0, Math.PI*2);
                ctx.strokeStyle = ef.c; ctx.globalAlpha = Math.max(0, ef.a);
                // 太いライン + 強いglow
                ctx.lineWidth = 5 / camera.zoom; ctx.shadowColor = 'rgba(0,255,220,1)'; ctx.shadowBlur = 5;
                ctx.stroke(); ctx.shadowBlur = 0;
                ctx.globalAlpha = 1;
            }
        } else if (ef.type === 'sonar-fill') {
            // ソナー到達後: 半透明フィルエフェクトとして5〜8秒かけてフェードアウト
            ef.a = 0.18 * (ef.life / 360);
            ef.life--;
            ctx.beginPath();
            ctx.arc(ef.x, ef.y, ef.r, 0, Math.PI * 2);
            ctx.fillStyle = ef.c;
            ctx.globalAlpha = ef.a;
            ctx.fill();
            ctx.globalAlpha = 1;
            if (ef.life <= 0) effects.splice(i, 1);
        } else if (ef.type === 'sonar-boundary') {
            ef.life--;
            ef.a = (ef.life / 60) * 0.5;
            ctx.beginPath(); ctx.arc(ef.x, ef.y, ef.r, 0, Math.PI*2);
            ctx.strokeStyle = ef.c; ctx.globalAlpha = ef.a;
            ctx.lineWidth = 1; ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            if (ef.life <= 0) effects.splice(i, 1);
        } else if (ef.type === 'fx-sprite') {
            // Higgsfieldスプライトエフェクト: 黒背景画像を'lighter'加算合成で描画 (黒=透明)
            if (!spriteReady(ef.img)) { effects.splice(i, 1); continue; }
            ef.life -= ef.decay || 0.025;
            if (ef.life <= 0) { effects.splice(i, 1); continue; }
            const _fxR = ef.r * (1 + (1 - ef.life) * 0.45);
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = Math.min(1, ef.life * 1.6);
            ctx.drawImage(ef.img, ef.x - _fxR, ef.y - _fxR, _fxR * 2, _fxR * 2);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            ctx.restore();
        } else {
            ef.r += ef.type === 'hit' ? 2 : 3; ef.a -= ef.type === 'hit' ? 0.1 : 0.05;
            ctx.beginPath(); ctx.arc(ef.x, ef.y, ef.r, 0, Math.PI * 2);
            if (ef.type === 'hit') { ctx.fillStyle = ef.c; ctx.globalAlpha = Math.max(0, ef.a); ctx.fill(); }
            else { ctx.strokeStyle = ef.c; ctx.globalAlpha = Math.max(0, ef.a); ctx.lineWidth = 2; ctx.stroke(); }
            ctx.globalAlpha = 1;
            if (ef.a <= 0) effects.splice(i, 1);
        }
    }
}

function logMessage(text, className) {
    const log = document.getElementById('message-log');
    if (!log) return;
    const msg = document.createElement('div');
    msg.className = `message ${className}`;
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    msg.textContent = `[${ts}] ${text}`;
    log.appendChild(msg);
    // 最大100件
    while (log.children.length > 100) log.removeChild(log.firstChild);
    // 自動スクロール (下端付近の時のみ)
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    if (atBottom) log.scrollTop = log.scrollHeight;
}

// Generate Sector

function generateSector() {
    mapMode = false; _preMapCamera = null;
    { const b = document.getElementById('map-mode-banner'); if (b) b.style.display = 'none'; }
    sectorCleared = false;
    enemiesKilled = 0;
    omniSonarCooldown = 0;
    dirSonarCooldown = 0;
    dirSonarVisual = null;
    dirSonarPendingFire = false;
    passiveBearings = [];
    player = new Ship(MAP_CX, MAP_CY, true);
    player.generatorOutput = genAlloc.engine;
    enemies = []; structures = []; projectiles = []; effects = []; particles = []; debris = []; scrapDrops = [];
    stations = []; higgsWakes = []; heatTrails = []; opticTrails = []; emTrails = [];
    resourceNodes = []; decoys = []; playerDrones = [];

    // センサーLvによるレーダー基本範囲の反映
    RADAR_RANGE = BASE_RADAR_RANGE * UPGRADE_MULT[gameState.upgrades.sensor];

    // 宇宙背景テクスチャ生成 (非同期化: UIスレッドをブロックしないようsetTimeoutで遅延実行)
    // → 艦種選択→プレイ画面の切り替えが即座になる (2048×2048の同期描画は10秒以上かかる)
    setTimeout(() => generateSpaceBackground(), 0);

    // Environmental Background
    bgStars = [];
    // 星の色: 青白(O/B型)・白(A型)・淡黄(F/G型)・橙赤(K/M型)・青紫(Wolf-Rayet)
    const starColors = [
        '#ffffff','#ffffff','#ddeeff','#ddeeff',  // 白・青白 (多め)
        '#aaccff','#88bbff',                       // 青白 (O/B型)
        '#fff5cc','#ffeeaa',                       // 淡黄 (F/G型)
        '#ffcc88','#ffaa66',                       // 橙 (K型)
        '#ff8866',                                 // 赤 (M型)
        '#cc99ff'                                  // 青紫 (Wolf-Rayet)
    ];
    // レイヤー0: 遠景(微星5000), レイヤー1: 中景(1500), レイヤー2: 近景(800 + 輝く星)
    const layerDist = [0, 5000, 6500, 7300];
    for (let i = 0; i < 7300; i++) {
        const layer = i < 5000 ? 0 : (i < 6500 ? 1 : 2);
        const sizes  = [0.4, 1.0, 2.5];
        const alphas = [0.12, 0.40, 0.90];
        // 近景の一部は特に大きく輝かせる
        const isBright = layer === 2 && Math.random() < 0.15;
        bgStars.push({
            x: Math.random() * FIELD_SIZE * 3.0,
            y: Math.random() * FIELD_SIZE * 3.0,
            size:  isBright
                ? 2.8 + Math.random() * 2.0
                : sizes[layer] + Math.random() * sizes[layer],
            alpha: isBright ? 1.0 : alphas[layer] * (0.55 + Math.random() * 0.45),
            color: starColors[Math.floor(Math.random() * starColors.length)],
            twinkle: Math.random() * Math.PI * 2,
            isBright,
            layer
        });
    }
    bgMist = [];
    bgMistCanvas = null;
    higgsCloudCanvas = null;
    debrisField = []; stormField = []; thermalField = [];
    debrisCanvas = null; stormCanvas = null; thermalCanvas = null;
    // 星雲色: 紫・青・赤紫・緑青・琥珀 — より鮮やかな値
    const mistColors = ['70,20,140','25,60,160','130,20,70','10,90,110','80,50,10','15,110,80'];
    for (let i = 0; i < 30; i++) {
        const density = Math.random() * 0.65 + 0.1;
        bgMist.push({
            x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE,
            r: Math.random() * 5000 + 2000,
            color: mistColors[Math.floor(Math.random() * mistColors.length)],
            density,
            phase: Math.random() * Math.PI * 2
        });
    }
    // デブリ帯 (岩礁帯): ヒッグスより薄く散在 (スピード感を損なわない程度=「程々」)
    for (let i = 0; i < 10; i++) {
        debrisField.push({
            x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE,
            r: Math.random() * 3500 + 1800,
            density: Math.random() * 0.5 + 0.25
        });
    }
    // 磁気嵐帯: さらに少なめ
    for (let i = 0; i < 6; i++) {
        stormField.push({
            x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE,
            r: Math.random() * 4000 + 2200,
            density: Math.random() * 0.55 + 0.25
        });
    }
    // 熱雲(プラズマ雲): 少なめ (§3-13 Phase3)
    for (let i = 0; i < 7; i++) {
        thermalField.push({
            x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE,
            r: Math.random() * 3800 + 1600,
            density: Math.random() * 0.50 + 0.20
        });
    }
    // bgMistをオフスクリーンキャンバスに事前焼き付け (毎フレームのcreateRadialGradientを排除)
    // サイズを512に抑える: 4096x4096=64MBは生成に数秒かかりモバイルをフリーズさせるため
    setTimeout(() => {
        const mc = document.createElement('canvas');
        mc.width = mc.height = 768; // 512→768: Higgsフォグの輪郭が少し鮮明に
        const mx = mc.getContext('2d');
        const scale = 768 / FIELD_SIZE;
        bgMist.forEach(m => {
            const d = m.density;
            let col;
            if (d >= 0.85)      col = '100,20,200';
            else if (d >= 0.70) col = '40,80,220';
            else if (d >= 0.50) col = '0,200,240';
            else if (d >= 0.30) col = '20,120,160';
            else                col = '15,40,100';
            // 30個の雲が重なると画面全体が白飛びするためアルファを抑制 (×0.55)
            const baseAlpha = (d >= 0.85 ? 0.18 : d >= 0.70 ? 0.15 : d >= 0.50 ? 0.13 : d >= 0.30 ? 0.08 : 0.04 + d * 0.04) * 0.55;
            const sx = m.x * scale, sy = m.y * scale, sr = m.r * scale;
            const g = mx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0,    `rgba(${col},${Math.min(0.35, baseAlpha * 2.5).toFixed(3)})`);
            g.addColorStop(0.25, `rgba(${col},${(baseAlpha * 1.2).toFixed(3)})`);
            g.addColorStop(0.60, `rgba(${col},${(baseAlpha * 0.45).toFixed(3)})`);
            g.addColorStop(1,    'rgba(0,0,0,0)');
            mx.fillStyle = g;
            mx.beginPath(); mx.arc(sx, sy, sr, 0, Math.PI * 2); mx.fill();
        });
        bgMistCanvas = mc;

        // ヒッグス雲(白) — 視野内で「下から見上げた雲」として 'lighter' 合成する用。
        // 濃密部=ほぼ真っ白 / 疎部=青空が透ける薄さ。drawFogOfWar内で視野にクリップして重ねる。
        const wc = document.createElement('canvas');
        wc.width = wc.height = 768;
        const wcx = wc.getContext('2d');
        bgMist.forEach(m => {
            const d = m.density;
            const coreA = Math.min(0.55, 0.04 + d * 0.6); // 濃度連動の白さ (washout防止に抑制)
            const sx = m.x * scale, sy = m.y * scale, sr = m.r * scale;
            const g = wcx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0,    `rgba(225,238,255,${coreA.toFixed(3)})`);
            g.addColorStop(0.45, `rgba(175,205,245,${(coreA * 0.4).toFixed(3)})`);
            g.addColorStop(1,    'rgba(0,0,0,0)');
            wcx.fillStyle = g;
            wcx.beginPath(); wcx.arc(sx, sy, sr, 0, Math.PI * 2); wcx.fill();
        });
        higgsCloudCanvas = wc;

        // ── デブリ帯 (岩礁帯) ベイク: 散らばった岩片の点描 (灰色) ──
        const dc = document.createElement('canvas');
        dc.width = dc.height = 768;
        const dcx = dc.getContext('2d');
        let _ds = 0x9e3779b9 >>> 0;
        const drng = () => { _ds = (_ds * 1664525 + 1013904223) >>> 0; return _ds / 4294967296; };
        debrisField.forEach(m => {
            const sx = m.x * scale, sy = m.y * scale, sr = m.r * scale;
            // 薄いベース(岩礁の影) + 岩片の点描
            const g = dcx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0, `rgba(120,118,110,${(0.10 * m.density).toFixed(3)})`);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            dcx.fillStyle = g;
            dcx.beginPath(); dcx.arc(sx, sy, sr, 0, Math.PI * 2); dcx.fill();
            const rocks = Math.floor(sr * sr * 0.0016 * m.density); // 面積×密度
            for (let k = 0; k < rocks; k++) {
                const a = drng() * Math.PI * 2;
                const rr = Math.sqrt(drng()) * sr;
                const px = sx + Math.cos(a) * rr, py = sy + Math.sin(a) * rr;
                const sz = 0.6 + drng() * 1.6;
                const sh = 80 + (drng() * 70) | 0;
                dcx.globalAlpha = 0.25 + drng() * 0.4;
                dcx.fillStyle = `rgb(${sh},${sh - 4},${sh - 12})`;
                dcx.fillRect(px, py, sz, sz);
            }
            dcx.globalAlpha = 1;
        });
        debrisCanvas = dc;

        // ── 磁気嵐帯 ベイク: 紫〜シアンのEMノイズ雲 (描画時に明滅) ──
        const sc2c = document.createElement('canvas');
        sc2c.width = sc2c.height = 768;
        const scx = sc2c.getContext('2d');
        stormField.forEach(m => {
            const sx = m.x * scale, sy = m.y * scale, sr = m.r * scale;
            const a = 0.10 + m.density * 0.16;
            const g = scx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0,    `rgba(150,70,220,${a.toFixed(3)})`);
            g.addColorStop(0.5,  `rgba(70,120,230,${(a * 0.5).toFixed(3)})`);
            g.addColorStop(1,    'rgba(0,0,0,0)');
            scx.fillStyle = g;
            scx.beginPath(); scx.arc(sx, sy, sr, 0, Math.PI * 2); scx.fill();
        });
        stormCanvas = sc2c;

        // ── 熱雲(プラズマ雲) ベイク: 赤橙のゆらぎ (§3-13 Phase3) ──
        const tc = document.createElement('canvas');
        tc.width = tc.height = 768;
        const tcx = tc.getContext('2d');
        thermalField.forEach(m => {
            const sx = m.x * scale, sy = m.y * scale, sr = m.r * scale;
            const a = 0.08 + m.density * 0.13;
            const g = tcx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0,    `rgba(255,80,20,${a.toFixed(3)})`);
            g.addColorStop(0.5,  `rgba(220,120,0,${(a * 0.5).toFixed(3)})`);
            g.addColorStop(1,    'rgba(0,0,0,0)');
            tcx.fillStyle = g;
            tcx.beginPath(); tcx.arc(sx, sy, sr, 0, Math.PI * 2); tcx.fill();
        });
        thermalCanvas = tc;
    }, 50);

    // 敵を円形マップ内のヒッグス濃度の高い場所に配置
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist  = 10000 + Math.random() * (MAP_RADIUS - 12000);
    const spawnCenterX = MAP_CX + Math.cos(spawnAngle) * spawnDist;
    const spawnCenterY = MAP_CY + Math.sin(spawnAngle) * spawnDist;
    const bossSpawn = findHidingSpot(spawnCenterX, spawnCenterY, 2000);
    const boss = new Ship(bossSpawn.x, bossSpawn.y, false, gameState.enemyType || 'destroyer');
    // セクターが深いほど高HP・高速化
    boss.maxHp = 500 + gameState.sector * 200;
    boss.hp = boss.maxHp;
    boss.lurking = true;
    enemies.push(boss);
    // S&Dモード: コロニーノードを多く配置 (ハック目標)
    const colonyCount = gameState.mode === 'sd' ? 5 : 3;
    for (let i = 0; i < colonyCount; i++) {
        const a = (i / colonyCount) * Math.PI * 2 + Math.random() * 0.8;
        const r = 5000 + Math.random() * (MAP_RADIUS - 7000);
        const col = new Structure(MAP_CX + Math.cos(a) * r, MAP_CY + Math.sin(a) * r, 'colony');
        col.discovered = true; // ゲーム開始時からミニマップに表示
        structures.push(col);
    }
    for (let i = 0; i < 5; i++) {
        const sp = clampToMapCircle(
            MAP_CX + (Math.random() - 0.5) * MAP_RADIUS * 1.6,
            MAP_CY + (Math.random() - 0.5) * MAP_RADIUS * 1.6
        );
        const der = new Structure(sp.x, sp.y, 'derelict');
        der.discovered = true; // ゲーム開始時からミニマップに表示
        structures.push(der);
    }
    for (let i = 0; i < 3; i++) {
        const a2 = Math.random() * Math.PI * 2, r2 = 4000 + Math.random() * (MAP_RADIUS - 6000);
        stations.push(new Station(MAP_CX + Math.cos(a2) * r2, MAP_CY + Math.sin(a2) * r2));
    }

    // リソースノード: 5〜8個をマップ上にランダム配置 (ヒッグス雲内を優先)
    const nodeCount = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < nodeCount; i++) {
        const na = Math.random() * Math.PI * 2, nr = Math.random() * (MAP_RADIUS - 3000);
        const spot = findHidingSpot(MAP_CX + Math.cos(na) * nr, MAP_CY + Math.sin(na) * nr, 2000);
        resourceNodes.push({ x: spot.x, y: spot.y, active: true, emFlashTimer: 0 });
    }

    // S&D進捗バーをリセット
    const sdFill = document.getElementById('sd-progress-fill');
    const sdText = document.getElementById('sd-progress-text');
    if (sdFill) sdFill.style.width = '0%';
    if (sdText) sdText.textContent = `ノード: 0/${gameState.mode === 'sd' ? 5 : 3}`;

    centerCameraOnPlayer();

    // Add delay to ensure canvas is sized before centering camera again
    setTimeout(() => {
        centerCameraOnPlayer();
    }, 100);


    const shipLabel = { assault: '攻撃型', stealth: '潜航型', carrier: '空母型' };
    logMessage(`SYSTEM: ワープ完了。セクター ${gameState.sector} に到着しました [${shipLabel[gameState.shipType] || '不明'}]。環境マッピング中...`, 'system-msg');
}

function toggleDemoMode() {
    demoMode = !demoMode;
    const btn = document.getElementById('btn-demo-mode');
    if (btn) {
        btn.style.borderColor = demoMode ? '#ffff00' : '';
        btn.style.color = demoMode ? '#ffff00' : '';
        btn.textContent = demoMode ? 'DEMO: ON' : 'DEMO';
    }
    logMessage(demoMode ? 'DEMO MODE: 全視界・ヒッグス暗幕解除 (AI挙動は通常と同一)' : 'DEMO MODE: 解除', 'system-msg');
}

function startGame(shipType) {
    gameState.shipType = shipType;
    // 敵艦種: ロビーで選択された値をセット
    const _selEt = document.querySelector('.enemy-select-btn.active')?.dataset?.type || 'destroyer';
    gameState.enemyType = _selEt;
    document.getElementById('ship-select-lobby').classList.add('hidden');
    // 潜航型専用ジャミングボタンの表示制御
    document.querySelectorAll('.jam-btn').forEach(b => { b.style.display = shipType === 'stealth' ? '' : 'none'; });
    // 空母型専用ドローン展開ボタンの表示制御 (§3-6/§3-7)
    document.querySelectorAll('.drone-btn').forEach(b => { b.style.display = shipType === 'carrier' ? '' : 'none'; });
    // 全艦種共通ボタン (ミサイルモード・修復) — ゲーム開始後に表示
    document.querySelectorAll('.common-btn').forEach(b => { b.style.display = ''; });
    // 修復状態をリセット
    repairActive = false;
    missileMode = 'homing';
    const _mml = document.getElementById('missile-mode-label'); if (_mml) _mml.textContent = 'MSL:HON';
    const _rgl = document.getElementById('repair-drone-label'); if (_rgl) _rgl.textContent = 'REGEN';
    // S&D進捗バーの表示制御
    const sdBar = document.getElementById('sd-progress-bar');
    if (sdBar) sdBar.style.display = gameState.mode === 'sd' ? 'block' : 'none';
    updateTopUI();
    generateSector();
    if (!gameLoopRunning) {
        gameLoopRunning = true;
        gameLoop();
    }
}

// ゲームモード選択ボタン
document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        gameState.mode = card.dataset.mode;
        playSound('ui');
    });
});

// 艦種選択ボタン
document.querySelectorAll('.ship-select-btn').forEach(btn => {
    btn.addEventListener('click', () => startGame(btn.dataset.type));
});

// 敵艦種選択ボタン
document.querySelectorAll('.enemy-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.enemy-select-btn').forEach(b => {
            b.classList.remove('active');
            b.style.borderColor = '';
        });
        btn.classList.add('active');
        btn.style.borderColor = '#00ffaa';
        playSound('ui');
    });
});

// UI Binding Logic for gameplay
function showDialog() {
    dialogOpen = true;
    document.getElementById('dialog-overlay').classList.remove('hidden');
    player.setTarget(player.x, player.y); // Stop moving
}
document.getElementById('btn-dialog-yes').addEventListener('click', () => {
    gameState.sector++;
    gameState.credits += 200; // Reward for penetrating deep space
    saveGame();
    updateTopUI();
    document.getElementById('dialog-overlay').classList.add('hidden');
    generateSector();
    dialogOpen = false;
});
document.getElementById('btn-dialog-no').addEventListener('click', () => {
    document.getElementById('dialog-overlay').classList.add('hidden');
    // 円形境界内に押し戻す
    const pushBack = clampToMapCircle(player.x, player.y, 500);
    player.x = pushBack.x; player.y = pushBack.y;
    player.setTarget(player.x, player.y);
    centerCameraOnPlayer();
    setTimeout(() => { dialogOpen = false; }, 2000);
});

// ============================================================
// GEN配分スライダー (ゼロサム: 合計100% — ENG/WEP/SEN のみ)
// AI は独立スライダー (0〜100% 自由設定、GEN合計に含まない)
// ============================================================
const GEN_KEYS = ['engine', 'weapons', 'sensors'];

function updateGenTotal() {
    const total = GEN_KEYS.reduce((sum, k) => sum + genAlloc[k], 0);
    const totalEl = document.getElementById('gen-total');
    if (totalEl) {
        totalEl.textContent = `計${total}%`;
        totalEl.style.color = total === 100 ? '#00ffaa' : '#ff4d4d';
    }
    // プレイヤー速度をエンジン配分で決定
    if (player) player.generatorOutput = genAlloc.engine;
}

GEN_KEYS.forEach(key => {
    const slider = document.getElementById(`gen-${key}`);
    if (!slider) return;
    slider.addEventListener('input', e => {
        const newVal = parseInt(e.target.value);
        const oldVal = genAlloc[key];
        const delta = newVal - oldVal;
        genAlloc[key] = newVal;

        // ゼロサム: 他のスライダーを按分調整
        const others = GEN_KEYS.filter(k => k !== key);
        const otherTotal = others.reduce((sum, k) => sum + genAlloc[k], 0);
        if (delta !== 0) {
            let remaining = -delta;
            if (otherTotal > 0) {
                // 按分配分 (クリップ後の実変化量でremainingを追跡)
                others.forEach((k, i) => {
                    const prevVal = genAlloc[k];
                    if (i === others.length - 1) {
                        genAlloc[k] = Math.min(100, Math.max(0, genAlloc[k] + remaining));
                    } else {
                        const adj = Math.round(remaining * (genAlloc[k] / otherTotal));
                        genAlloc[k] = Math.min(100, Math.max(0, genAlloc[k] + adj));
                        remaining -= (genAlloc[k] - prevVal); // クリップ後の実変化量を引く
                    }
                    const el = document.getElementById(`gen-${k}`);
                    const valEl = document.getElementById(`gen-${k}-val`);
                    if (el) el.value = genAlloc[k];
                    if (valEl) valEl.textContent = genAlloc[k] + '%';
                });
            } else {
                // 他が全て0 → 最後のスライダーに全て割り当て
                const last = others[others.length - 1];
                genAlloc[last] = Math.min(100, Math.max(0, genAlloc[last] + remaining));
                const el = document.getElementById(`gen-${last}`);
                const valEl = document.getElementById(`gen-${last}-val`);
                if (el) el.value = genAlloc[last];
                if (valEl) valEl.textContent = genAlloc[last] + '%';
            }
            // 端数誤差補正: 合計が100になるよう最終調整
            const total = GEN_KEYS.reduce((sum, k) => sum + genAlloc[k], 0);
            if (total !== 100) {
                const diff = 100 - total;
                // 最も大きい配分のキーで調整
                const adjustKey = others.reduce((best, k) => genAlloc[k] > genAlloc[best] ? k : best, others[0]);
                genAlloc[adjustKey] = Math.min(100, Math.max(0, genAlloc[adjustKey] + diff));
                const el = document.getElementById(`gen-${adjustKey}`);
                const valEl = document.getElementById(`gen-${adjustKey}-val`);
                if (el) el.value = genAlloc[adjustKey];
                if (valEl) valEl.textContent = genAlloc[adjustKey] + '%';
            }
        }

        const valEl = document.getElementById(`gen-${key}-val`);
        if (valEl) valEl.textContent = newVal + '%';
        updateGenTotal();
    });
});
updateGenTotal();

// AI スライダー: GENゼロサムとは独立して 0〜100% 自由設定
const aiSlider = document.getElementById('gen-ai');
const aiValEl  = document.getElementById('gen-ai-val');
if (aiSlider) {
    aiSlider.addEventListener('input', e => {
        genAlloc.ai = parseInt(e.target.value);
        if (aiValEl) aiValEl.textContent = genAlloc.ai + '%';
    });
}

// AI精度配分 (§3-2): 解析/命中/回避 のゼロサム3スライダー (GENと同方式)
const AIPREC_KEYS = ['sensor', 'weapon', 'engine'];
AIPREC_KEYS.forEach(key => {
    const slider = document.getElementById(`aiprec-${key}`);
    if (!slider) return;
    slider.addEventListener('input', e => {
        const newVal = parseInt(e.target.value);
        const delta = newVal - aiPrecision[key];
        aiPrecision[key] = newVal;
        const others = AIPREC_KEYS.filter(k => k !== key);
        const otherTotal = others.reduce((s, k) => s + aiPrecision[k], 0);
        if (delta !== 0) {
            let remaining = -delta;
            if (otherTotal > 0) {
                others.forEach((k, i) => {
                    const prev = aiPrecision[k];
                    if (i === others.length - 1) aiPrecision[k] = Math.min(100, Math.max(0, aiPrecision[k] + remaining));
                    else { const adj = Math.round(remaining * (aiPrecision[k] / otherTotal)); aiPrecision[k] = Math.min(100, Math.max(0, aiPrecision[k] + adj)); remaining -= (aiPrecision[k] - prev); }
                });
            } else {
                const last = others[others.length - 1];
                aiPrecision[last] = Math.min(100, Math.max(0, aiPrecision[last] + remaining));
            }
            const total = AIPREC_KEYS.reduce((s, k) => s + aiPrecision[k], 0);
            if (total !== 100) {
                const adjustKey = others.reduce((b, k) => aiPrecision[k] > aiPrecision[b] ? k : b, others[0]);
                aiPrecision[adjustKey] = Math.min(100, Math.max(0, aiPrecision[adjustKey] + (100 - total)));
            }
        }
        AIPREC_KEYS.forEach(k => {
            const el = document.getElementById(`aiprec-${k}`);
            const valEl = document.getElementById(`aiprec-${k}-val`);
            if (el) el.value = aiPrecision[k];
            if (valEl) valEl.textContent = aiPrecision[k] + '%';
        });
    });
});

// 旧スライダー互換 (参照が残っている場合のフォールバック)
const legacySlider = document.getElementById('speedSlider');
if (legacySlider) {
    legacySlider.addEventListener('input', e => {
        document.getElementById('speedValue').textContent = `${e.target.value}%`;
        if (player) player.generatorOutput = e.target.value;
    });
}
document.getElementById('btn-cancel').addEventListener('click', () => {
    playSound('ui');
    if (!player) return;
    player.setTarget(player.x, player.y);
    player.targetEntity = null;
    logMessage('NAV: 待機命令を受諾。', 'system-msg');
});
document.getElementById('btn-camera-follow').addEventListener('click', () => {
    if (mapMode) exitMapMode(); // 追従操作はマップモードを抜けてから
    cameraFollowPlayer = !cameraFollowPlayer;
    updateCameraFollowBtn();
    if (cameraFollowPlayer) centerCameraOnPlayer();
    logMessage(`NAV: カメラ追従 ${cameraFollowPlayer ? 'ON' : 'OFF'}`, 'system-msg');
    playSound('ui');
});
// 攻撃ON/OFFボタン
document.getElementById('btn-attack-toggle')?.addEventListener('click', () => {
    autoAttackEnabled = !autoAttackEnabled;
    const btn = document.getElementById('btn-attack-toggle');
    if (btn) {
        const atkLbl = document.getElementById('attack-label');
        if (autoAttackEnabled) {
            if (atkLbl) atkLbl.textContent = '攻撃 ON';
            btn.style.borderColor = '#00b43c';
            btn.style.color = '#00ff66';
        } else {
            if (atkLbl) atkLbl.textContent = '攻撃 OFF';
            btn.style.borderColor = '#b40000';
            btn.style.color = '#ff4444';
        }
    }
    logMessage(`WEP: 自動攻撃 ${autoAttackEnabled ? 'ON' : 'OFF'}`, 'system-msg');
    playSound('ui');
});

document.getElementById('btn-scan').addEventListener('click', fireOmniSonar);

// ── 潜航型ジャミング3種 ──
document.getElementById('btn-jam-burst')?.addEventListener('click', () => {
    if (gameState.shipType !== 'stealth') return;
    if (jamBurst > 0) { logMessage('JAM: 範囲ジャミングは既に発動中', 'warning-msg'); return; }
    jamBurst = JAM_BURST_DUR;
    logMessage(`JAM: 範囲ジャミング展開 — 半径内の敵センサーを${Math.round(JAM_BURST_DEGRADE*100)}%劣化 (発動中はEM放射増)`, 'system-msg');
    playSound('ui');
});
document.getElementById('btn-jam-cont')?.addEventListener('click', () => {
    if (gameState.shipType !== 'stealth') return;
    jamCont = !jamCont;
    const b = document.getElementById('btn-jam-cont');
    if (b) { b.style.borderColor = jamCont ? '#ff66cc' : '#aa66ff'; b.style.color = jamCont ? '#ff99dd' : '#cc99ff'; }
    logMessage(`JAM: 継続EMジャム ${jamCont ? 'ON — 周辺センサーを持続妨害(常時EM放射)' : 'OFF'}`, 'system-msg');
    playSound('ui');
});
document.getElementById('btn-jam-pulse')?.addEventListener('click', () => {
    if (gameState.shipType !== 'stealth') return;
    if (jamPulseCD > 0) { logMessage(`JAM: EMパルス再チャージ中 (${Math.ceil(jamPulseCD/60)}秒)`, 'warning-msg'); return; }
    jamPulse = JAM_PULSE_DUR;
    jamPulseCD = JAM_PULSE_CD;
    effects.push({ x: player.x, y: player.y, r: 0, maxR: JAM_PULSE_RADIUS, a: 0.5, c: '#cc99ff', type: 'circle' });
    logMessage('JAM: EMパルス発射 — 広域瞬間ブラインド！(自EM放射が最大に)', 'warning-msg');
    playSound('ui');
});
document.getElementById('btn-decoy')?.addEventListener('click', () => {
    if (gameState.shipType !== 'stealth') return;
    if (!player || player.hp <= 0) return;
    if (decoys.length >= CARGO_CAP.stealth) { logMessage(`DECOY: 同時展開上限 (${CARGO_CAP.stealth}機) に到達`, 'warning-msg'); return; }
    const ang = player.angle, sp = 4;
    decoys.push({ x: player.x + Math.cos(ang) * 30, y: player.y + Math.sin(ang) * 30, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: DECOY_LIFE });
    logMessage(`DECOY: 強EMデコイ射出 (${decoys.length}/${CARGO_CAP.stealth}) — 敵ミサイルを誘引`, 'system-msg');
    playSound('ui');
});

// ── 空母型ドローン展開ボタン (§3-6) ──
document.getElementById('btn-drone-attack')?.addEventListener('click', () => deployDrone('attack'));
document.getElementById('btn-drone-decoy')?.addEventListener('click', () => deployDrone('decoy'));
document.getElementById('btn-drone-scout')?.addEventListener('click', () => deployDrone('scout'));
document.getElementById('btn-drone-build')?.addEventListener('click', () => deployDrone('build'));
// §3-7 建設物3種
document.getElementById('btn-drone-barrier')?.addEventListener('click', () => deployDrone('barrier'));
document.getElementById('btn-drone-buoy')?.addEventListener('click', () => deployDrone('buoy'));
document.getElementById('btn-drone-higgs')?.addEventListener('click', () => deployDrone('higgs'));

// ── §3-10 ミサイルモード切替 ──
document.getElementById('btn-missile-mode')?.addEventListener('click', () => {
    missileMode = missileMode === 'homing' ? 'smart' : 'homing';
    const lbl = document.getElementById('missile-mode-label');
    if (lbl) lbl.textContent = missileMode === 'smart' ? 'MSL:AI' : 'MSL:HON';
    const btn = document.getElementById('btn-missile-mode');
    if (btn) { btn.style.borderColor = missileMode === 'smart' ? '#aaddff' : '#ffaa33'; btn.style.color = missileMode === 'smart' ? '#aaddff' : '#ffcc66'; }
    logMessage(`WEP: ミサイルモード → ${missileMode === 'smart' ? 'AI追跡型 (EM強・ジャミング耐性・大閃光)' : '熱源誘導型 (デコイ妨害可)'}`, 'system-msg');
    playSound('ui');
});

// ── §3-9 修復ドローン ──
document.getElementById('btn-repair-drone')?.addEventListener('click', () => {
    if (!player || player.hp <= 0) return;
    repairActive = !repairActive;
    const lbl = document.getElementById('repair-drone-label');
    const btn = document.getElementById('btn-repair-drone');
    if (repairActive) {
        if (lbl) lbl.textContent = 'REGEN ON';
        if (btn) { btn.style.borderColor = '#00ff88'; btn.style.color = '#00ff88'; }
        logMessage('REGEN: 修復モード起動 — 完全停止・HP回復 (全センサー脆弱)', 'warning-msg');
    } else {
        if (lbl) lbl.textContent = 'REGEN';
        if (btn) { btn.style.borderColor = '#44bbff'; btn.style.color = '#88ddff'; }
        logMessage('REGEN: 修復モード解除 — 行動再開', 'system-msg');
    }
    playSound('ui');
});

// ── モバイルメニュー ──
(function initMobileMenu() {
    const menuBtn = document.getElementById('mobile-menu-btn');
    const menuModal = document.getElementById('mobile-menu-modal');
    if (!menuBtn || !menuModal) return;
    menuBtn.addEventListener('click', () => menuModal.classList.toggle('hidden'));
    document.getElementById('mm-close')?.addEventListener('click', () => menuModal.classList.add('hidden'));
    document.getElementById('mm-save')?.addEventListener('click', () => {
        document.getElementById('btn-save').click();
        menuModal.classList.add('hidden');
    });
    document.getElementById('mm-reset')?.addEventListener('click', () => {
        document.getElementById('btn-reset').click();
        menuModal.classList.add('hidden');
    });
})();

document.getElementById('engine-type-select')?.addEventListener('change', e => {
    gameState.engineType = e.target.value;
    const labels = { thermonuclear: '熱核エンジン', pulse: 'パルスエンジン', higgs: 'ヒッグスエンジン', photon: 'フォトンエンジン' };
    logMessage(`ENG: エンジンタイプを${labels[gameState.engineType]}に変更。`, 'system-msg');
    playSound('ui');
});

document.getElementById('gen-gain')?.addEventListener('input', e => {
    genGain = parseInt(e.target.value) / 100;
    const valEl = document.getElementById('gen-gain-val');
    if (valEl) valEl.textContent = `×${genGain.toFixed(1)}`;
});
document.getElementById('btn-dir-sonar').addEventListener('click', () => {
    if (dirSonarCooldown > 0) {
        logMessage(`SENSOR: 指向性ソナー再充電中... (残り ${Math.ceil(dirSonarCooldown / 60)}秒)`, 'warning-msg');
        return;
    }
    if (dirSonarPendingFire) {
        // Cancel pending
        dirSonarPendingFire = false;
        canvas.style.cursor = 'default';
        document.getElementById('btn-dir-sonar').classList.remove('pending-fire');
        logMessage('SENSOR: 指向性ソナー — 照射キャンセル。', 'system-msg');
        return;
    }
    dirSonarPendingFire = true;
    canvas.style.cursor = 'crosshair';
    document.getElementById('btn-dir-sonar').classList.add('pending-fire');
    logMessage('SENSOR: 指向性ソナー待機中 — 照射方向をタップ/クリックしてください。', 'system-msg');
    playSound('ui');
});
document.getElementById('btn-hack').addEventListener('click', () => {
    if (!player || player.hp <= 0) return;
    playSound('ui');
    let closest = null; let cd = Infinity;
    structures.forEach(s => {
        const d = Math.hypot(player.x - s.x, player.y - s.y);
        if (d < cd && d < effectiveRadarRange * 1.5) { cd = d; closest = s; }
    });
    if (!closest) {
        logMessage(`EW: 有効範囲内にハッキング可能な対象がいません。`, 'warning-msg');
        return;
    }

    if (closest.type === 'colony') {
        // ── 廃棄されたコロニー ──
        if (!closest.hacked) {
            closest.hacked = true;
            createClickEffect(closest.x, closest.y, '#00aaff');
            // HP回復 or リソース回収 (ランダム)
            if (Math.random() < 0.5) {
                const heal = Math.floor(player.maxHp * 0.25);
                player.hp = Math.min(player.maxHp, player.hp + heal);
                logMessage(`EW[コロニー]: ハッキング完了 — 医療ポッド起動。HP +${heal} 回復。`, 'system-msg');
            } else {
                const reward = 50 + gameState.sector * 20;
                gameState.credits += reward;
                updateTopUI();
                logMessage(`EW[コロニー]: ハッキング完了 — 物資倉庫接収。+${reward} SCR 獲得。`, 'system-msg');
            }
        }
        // 偽装ビーコン発動 (ハック済みでも再発動可)
        closest.decoyActive = true;
        closest.decoyTimer = 1800; // 30秒
        closest.decoyType = 'colony';
        logMessage(`EW[コロニー]: 全センサー偽装ビーコン発信中 (30秒)。熱源・EM・光学・ヒッグス全偽装。`, 'system-msg');
        // S&D勝利進捗更新
        const colonyNodes = structures.filter(s => s.type === 'colony');
        if (gameState.mode === 'sd') {
            const hackedCount = colonyNodes.filter(s => s.hacked).length;
            const fill = document.getElementById('sd-progress-fill');
            const text = document.getElementById('sd-progress-text');
            if (fill) fill.style.width = `${(hackedCount / colonyNodes.length) * 100}%`;
            if (text) text.textContent = `ノード: ${hackedCount}/${colonyNodes.length}`;
        }
    } else if (closest.type === 'derelict') {
        // ── 難破船 ──
        if (!closest.hacked) {
            closest.hacked = true;
            createClickEffect(closest.x, closest.y, '#00aaff');
            // リソース回収 + ランダムLvアップ
            const reward = 30 + gameState.sector * 15;
            gameState.credits += reward;
            updateTopUI();
            const upgradeKeys = ['weapons', 'sensor', 'armor'];
            const key = upgradeKeys[Math.floor(Math.random() * upgradeKeys.length)];
            const MAX_UPGRADE_LV = 3;
            if (gameState.upgrades[key] < MAX_UPGRADE_LV) {
                gameState.upgrades[key]++;
                if (key === 'sensor') RADAR_RANGE = BASE_RADAR_RANGE * UPGRADE_MULT[gameState.upgrades.sensor];
                const keyLabel = { weapons: '武装', sensor: 'センサー', armor: '装甲' };
                logMessage(`EW[難破船]: ハッキング完了 — +${reward} SCR。${keyLabel[key]} Lv${gameState.upgrades[key]} に強化。`, 'system-msg');
            } else {
                logMessage(`EW[難破船]: ハッキング完了 — +${reward} SCR。(ランダムLvアップ: 既に最大Lv)`, 'system-msg');
            }
        }
        // 熱源移動偽装発動 (ハック済みでも再発動可) — 最寄りウェイポイント方向へ
        const decoyTarget = player.targetX && player.targetY
            ? { x: player.targetX, y: player.targetY }
            : { x: closest.x + (Math.random() - 0.5) * 8000, y: closest.y + (Math.random() - 0.5) * 8000 };
        closest.decoyActive = true;
        closest.decoyTimer = 1200; // 20秒
        closest.decoyType = 'derelict';
        closest.decoyMoveX = closest.x;
        closest.decoyMoveY = closest.y;
        closest.decoyWaypoint = decoyTarget;
        logMessage(`EW[難破船]: 熱源偽装目標を発進。ウェイポイント方向へ移動する囮を展開 (20秒)。`, 'system-msg');
    }
    saveGame();
});
// ============================================================
// センサーモード切替ハンドラ (heat / optic / em / higgs)
// ============================================================
const SENSOR_INFO = {
    heat:  { name: '熱源センサー',       tip: '敵の移動時エンジン熱を追跡 — 発砲後の再配置フェーズに有効' },
    optic: { name: '光学センサー',       tip: '発砲フラッシュを捕捉 — 砲撃直後の一瞬を逃さない' },
    em:    { name: '電磁波センサー',     tip: '潜伏中の受動EM漏洩を検出 — 索敵フェーズ最適' },
    higgs: { name: 'ヒッグスセンサー',   tip: 'ヒッグス雲の乱流・ウェイク軌跡・リソースノードを検出' }
};
['heat', 'optic', 'em', 'higgs'].forEach(s => {
    const btn = document.getElementById(`sensor-${s}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
        currentSensor = s;
        document.querySelectorAll('.sns-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        logMessage(`SENSOR: ${SENSOR_INFO[s].name}に切替。${SENSOR_INFO[s].tip}`, 'system-msg');
        playSound('ui');
    });
});



// ============================================================
// センサーモード設定
// ============================================================
const sensorConfig = {
    heat:  { r:'255,80,0',   sig: e => e.heatSig,    rangeScale: 1.0,  higgsMod: 0.35, threshold: 0.3,  label: '熱源' },
    optic: { r:'0,255,170',  sig: e => e.opticalSig, rangeScale: 0.75, higgsMod: 0.85, threshold: 0.2,  label: '光学' },
    em:    { r:'180,50,255', sig: e => e.emSig,       rangeScale: 0.85, higgsMod: 0.1,  threshold: 0.3,  label: '電磁波' },
    higgs: { r:'80,200,255', sig: e => e.higgsSig,    rangeScale: 1.2,  higgsMod: 0.0,  threshold: 0.15, label: 'ヒッグス' }
};

// ============================================================
// パッシブアンテナ常時検知チェック
// ============================================================
function checkPassiveDetection() {
    passiveCheckTimer++;
    if (passiveCheckTimer < 120) return; // 2秒ごとに1計測
    passiveCheckTimer = 0;
    if (!player || player.hp <= 0) return;

    const sc = sensorConfig[currentSensor];
    const thr = sc.threshold;
    // スレットリング/敵探知モデルと対称な距離・ヒッグス減衰でシグネチャを評価。
    const range = Math.max(effectiveRadarRange * 10, 8000);
    // センサー配分 → 方位精度 (高いほど扇が鋭く・揺らぎが小さい)
    const sensorPrec = 0.45 + (genAlloc.sensors / 100) * 0.55; // 0.45..1.0

    // 検知できた敵ごとに減衰後シグネチャと方位を集計
    const contacts = [];
    for (const e of enemies) {
        if (e.hp <= 0) continue;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        const hPath = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
        const distAtten = Math.max(0, 1 - dist / range);
        const sig = sc.sig(e) * distAtten * (1 - hPath * sc.higgsMod);
        if (sig > thr * 0.5) {
            contacts.push({ e, sig, angle: Math.atan2(e.y - player.y, e.x - player.x) });
        }
    }
    if (contacts.length === 0) return;

    // 強い順に最大2件だけ方位ウェッジ化 (画面を埋めない)
    contacts.sort((a, b) => b.sig - a.sig);
    const picks = contacts.slice(0, 2);

    const colorRgb = sc.r; // 'r,g,b' 文字列
    let strongestDeg = 0, strongestWidthDeg = 0, strongest = -1;
    for (const c of picks) {
        // 閾値超過分を 0..1 の確信度へ。センサー精度で更に補正。
        const conf = Math.max(0, Math.min(1, (c.sig - thr * 0.5) / (1 - thr * 0.5)));
        const quality = Math.min(1, conf * sensorPrec * 1.35);
        // 強信号=狭い (約7°)、弱信号=広いボケ (約49°)
        const halfWidth = 0.86 - quality * 0.74;
        // 扇の中心を真方位から少しだけ揺らす (弱いほど大きくズレる)。
        // ズレは halfWidth 内に収まるので、別位置からの2計測で交差が真値付近に絞れる。
        const noise = (Math.random() - 0.5) * 2 * halfWidth * 0.55;
        const angle = c.angle + noise;
        passiveBearings.push({
            ox: player.x, oy: player.y,
            angle, halfWidth, range,
            quality, color: colorRgb,
            life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
        });
        if (c.sig > strongest) {
            strongest = c.sig;
            // コンパス方位 (0°=上/北, 時計回り) — ログ表示用
            strongestDeg = Math.round((Math.atan2(c.e.x - player.x, -(c.e.y - player.y)) * 180 / Math.PI + 360) % 360);
            strongestWidthDeg = Math.round(halfWidth * 180 / Math.PI);
        }
    }
    // 上限超過分は古いものから破棄
    while (passiveBearings.length > PASSIVE_BEARING_MAX) passiveBearings.shift();

    passiveAlertTimer = 180;
    logMessage(`PASSIVE: ${sc.label}放射源 ─ 方位 ${strongestDeg}° ±${strongestWidthDeg}°（移動して再計測→三角測量）`, 'warning-msg');
    const ind = document.getElementById('passive-indicator');
    if (ind) { ind.classList.add('alert'); setTimeout(() => ind.classList.remove('alert'), 3000); }
}

// パッシブ方位ウェッジ描画 (ワールド空間)。計測位置にアンカーした扇形をフェード表示。
function drawPassiveBearings(ctx) {
    if (passiveBearings.length === 0) return;
    const invZoom = 1 / camera.zoom;
    for (let i = passiveBearings.length - 1; i >= 0; i--) {
        const b = passiveBearings[i];
        b.life--;
        if (b.life <= 0) { passiveBearings.splice(i, 1); continue; }
        const lifeT = b.life / b.maxLife;        // 1→0
        const a0 = b.angle - b.halfWidth;
        const a1 = b.angle + b.halfWidth;
        const R = b.range;
        const col = b.color;
        ctx.save();
        // 扇形フィル (弱信号ほど広い半透明のボケ) — shadowBlur不使用(モバイル配慮)
        ctx.globalAlpha = 0.10 * lifeT * (0.4 + b.quality * 0.6);
        ctx.beginPath();
        ctx.moveTo(b.ox, b.oy);
        ctx.arc(b.ox, b.oy, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgb(${col})`;
        ctx.fill();
        // 扇の両エッジ
        ctx.globalAlpha = 0.45 * lifeT;
        ctx.strokeStyle = `rgb(${col})`;
        ctx.lineWidth = 1.2 * invZoom;
        ctx.beginPath();
        ctx.moveTo(b.ox, b.oy); ctx.lineTo(b.ox + Math.cos(a0) * R, b.oy + Math.sin(a0) * R);
        ctx.moveTo(b.ox, b.oy); ctx.lineTo(b.ox + Math.cos(a1) * R, b.oy + Math.sin(a1) * R);
        ctx.stroke();
        // 中心方位線 (破線)
        ctx.globalAlpha = 0.6 * lifeT;
        ctx.setLineDash([14 * invZoom, 10 * invZoom]);
        ctx.beginPath();
        ctx.moveTo(b.ox, b.oy);
        ctx.lineTo(b.ox + Math.cos(b.angle) * R, b.oy + Math.sin(b.angle) * R);
        ctx.stroke();
        ctx.setLineDash([]);
        // 計測位置マーカー (小円) — 移動による三角測量の起点を可視化
        ctx.globalAlpha = 0.5 * lifeT;
        ctx.beginPath();
        ctx.arc(b.ox, b.oy, 6 * invZoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

// ============================================================
// 精度計算ユーティリティ
// ============================================================
function calcAccuracy(dist, maxRange, distDecay0, higgsBlock) {
    const distDecay = 1.0 - distDecay0 * (dist / maxRange);
    const aiCoeff   = 0.5 + (genAlloc.ai / 100);
    return Math.max(0.05, Math.min(1.0, distDecay * aiCoeff * (1 - higgsBlock * 0.5)));
}

function applyContact(e, accuracy, life = 600) {
    // AI解析精度: センサー配分が高いほどコンタクト精度が上がる(ジャミング/デコイに強い・候補が絞れる)
    accuracy = Math.min(1, accuracy * (1 + aiPrec('sensor') * AI_SENSOR_ACC));
    if (accuracy > e.contactAccuracy || e.contactLife < 60) {
        const jitter = (1 - accuracy) * 400;
        e.displayX = e.x + (Math.random() - 0.5) * jitter;
        e.displayY = e.y + (Math.random() - 0.5) * jitter;
        e.contactAccuracy = accuracy;
    }
    e.contactLife = Math.max(e.contactLife, life);
    e.visible = true;
}

// ============================================================
// 全周囲ソナー
// ============================================================
function fireOmniSonar() {
    if (!player || player.hp <= 0) return;
    if (omniSonarCooldown > 0) {
        logMessage(`SENSOR: 全周囲ソナー再充電中... (残り ${Math.ceil(omniSonarCooldown / 60)}秒)`, 'warning-msg');
        return;
    }
    const sensorLv  = gameState.upgrades.sensor;
    const baseRange = OMNI_SONAR_RANGE[sensorLv];
    const omniRange = baseRange * (genAlloc.sensors / 100) * genGain;
    const sc = sensorConfig[currentSensor];

    playSound('ui');
    let detected = 0;
    enemies.forEach(e => {
        if (e.hp <= 0) return;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        if (dist > omniRange) return;
        const higgsBlock = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
        const acc = calcAccuracy(dist, omniRange, 0.6, higgsBlock);
        applyContact(e, acc);
        detected++;
    });
    omniSonarCooldown = 900;
    enemies.forEach(e => { e.detectionState = 'alerted'; e.isAggro = true; e.aggroTimer = 400; });
    const rStr = Math.round(omniRange);
    logMessage(detected > 0
        ? `SONAR[全周囲] Lv${sensorLv}: ${detected}件の反応捕捉 (範囲: ${rStr}u) ─ 位置暴露注意`
        : `SONAR[全周囲] Lv${sensorLv}: 有効範囲 ${rStr}u 内に反応なし`,
        'system-msg');
    // ソナー伝播速度を遅く (1/3)、色はシアン系で鮮やかに
    effects.push({ x: player.x, y: player.y, r: 0, maxR: omniRange, a: 0.9, c: `rgba(0,255,220,1)`, type: 'sonar', speed: omniRange/60 });
    effects.push({ x: player.x, y: player.y, r: omniRange, maxR: omniRange, a: 0.5, c: `rgba(${sc.r},0.8)`, type: 'sonar-boundary', life: 60 });
}

// ============================================================
// 指向性ソナー
// ============================================================
function fireDirectionalSonar(targetAngle) {
    if (!player || player.hp <= 0) return;
    if (dirSonarCooldown > 0) return;
    if (targetAngle === undefined) targetAngle = Math.atan2(mouseWorldY - player.y, mouseWorldX - player.x);
    const sensorLv  = gameState.upgrades.sensor;
    const halfAngle = DIR_SONAR_HALF_ANGLE[sensorLv];
    const maxRange  = DIR_SONAR_MAX_RANGE * (genAlloc.sensors / 100) * genGain;

    playSound('ui');
    let detected = 0;
    enemies.forEach(e => {
        if (e.hp <= 0) return;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        if (dist > maxRange) return;
        let diff = Math.atan2(e.y - player.y, e.x - player.x) - targetAngle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        if (Math.abs(diff) > halfAngle) return;
        const higgsBlock = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
        const acc = calcAccuracy(dist, maxRange, 0.5, higgsBlock);
        applyContact(e, acc);
        detected++;
    });
    dirSonarCooldown = 300;
    dirSonarVisual = { angle: targetAngle, halfAngle, range: maxRange, life: 1.0 };
    const deg = Math.round(targetAngle * 180 / Math.PI);
    logMessage(detected > 0
        ? `SONAR[指向性] Lv${sensorLv}: 方位${deg}° → ${detected}件捕捉`
        : `SONAR[指向性] Lv${sensorLv}: 方位${deg}° → 反応なし`,
        'system-msg');
}

// ============================================================
// パッシブアンテナ描画 + ソナーコーン描画
// ============================================================
function drawPassiveAntenna(ctx) {
    if (!player || player.hp <= 0) return;

    const higgsAtPlayer = getHiggsIntensity(player.x, player.y);
    // レーダー範囲は AI解析配分(aiPrec('sensor')) に連動。AI解析最大(=ai・解析とも高)で
    // ≈2450 (ミサイル射程2200より少し大)。ヒッグス濃度で縮小。
    effectiveRadarRange = (500 + aiPrec('sensor') * 1950) * (1 - higgsAtPlayer * 0.55);

    const sc = sensorConfig[currentSensor];
    const CR = sc.r;
    const t  = Date.now();

    // センサー別 trail/wake 描画 (§3-12 全センサー一般化)
    const sensorRange = effectiveRadarRange * sc.rangeScale;
    // §3-12 HEAT trail: 橙色の熱排気跡 (エンジン移動・ミサイル推進)
    if (currentSensor === 'heat') {
        const _hsp = SPRITES['particle_heat'];
        ctx.globalCompositeOperation = 'lighter';
        heatTrails.forEach(w => {
            if (w.isPlayerTrail) return; // 自機の排気は自センサーには映らない
            if (Math.hypot(w.x - player.x, w.y - player.y) > sensorRange) return;
            const r = Math.max(3, 6 * w.intensity);
            ctx.globalAlpha = w.life * 0.65;
            if (spriteReady(_hsp)) {
                ctx.drawImage(_hsp, w.x - r, w.y - r, r * 2, r * 2);
            } else {
                ctx.fillStyle = 'rgba(255,120,20,0.85)';
                ctx.beginPath(); ctx.arc(w.x, w.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
            }
        });
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }
    // §3-12 OPTIC trail: 黄白の発光跡 (弾跡・ビーム軌跡・ミサイル噴射)
    if (currentSensor === 'optic') {
        const _osp = SPRITES['particle_optic'];
        ctx.globalCompositeOperation = 'lighter';
        opticTrails.forEach(w => {
            if (Math.hypot(w.x - player.x, w.y - player.y) > sensorRange) return;
            const r = Math.max(3, 5 * w.intensity);
            ctx.globalAlpha = w.life * 0.6;
            if (spriteReady(_osp)) {
                ctx.drawImage(_osp, w.x - r, w.y - r, r * 2, r * 2);
            } else {
                ctx.fillStyle = 'rgba(255,230,80,0.85)';
                ctx.beginPath(); ctx.arc(w.x, w.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
            }
        });
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }
    if (currentSensor === 'em') {
        resourceNodes.forEach(n => {
            if (n.emFlashTimer <= 0) return;
            if (Math.hypot(n.x - player.x, n.y - player.y) > sensorRange) return;
            const intensity = n.emFlashTimer / 180;
            ctx.save(); ctx.globalAlpha = intensity * 0.9;
            ctx.fillStyle = '#cc44ff';
            ctx.beginPath(); ctx.arc(n.x, n.y, 7 * intensity, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = intensity * 0.4;
            ctx.beginPath(); ctx.arc(n.x, n.y, 11 * intensity, 0, Math.PI * 2); ctx.fill();
            ctx.restore(); ctx.globalAlpha = 1;
        });
        // §3-12 EM trail: 紫のEM放射跡 (AI処理・ミサイル誘導・ビームチャージ)
        emTrails.forEach(w => {
            if (Math.hypot(w.x - player.x, w.y - player.y) > sensorRange) return;
            ctx.save(); ctx.globalAlpha = w.life * 0.55;
            ctx.fillStyle = 'rgba(180,80,255,0.85)';
            ctx.beginPath(); ctx.arc(w.x, w.y, Math.max(1.5, 3 * w.intensity), 0, Math.PI * 2); ctx.fill();
            ctx.restore(); ctx.globalAlpha = 1;
        });
    }
    if (currentSensor === 'higgs') {
        const _hgsp = SPRITES['particle_higgs'];
        ctx.globalCompositeOperation = 'lighter';
        higgsWakes.forEach(w => {
            if (Math.hypot(w.x - player.x, w.y - player.y) > sensorRange) return;
            const r = Math.max(3, 6 * w.intensity);
            ctx.globalAlpha = w.life * 0.7;
            if (spriteReady(_hgsp)) {
                ctx.drawImage(_hgsp, w.x - r, w.y - r, r * 2, r * 2);
            } else {
                ctx.fillStyle = `rgba(${CR},0.8)`;
                ctx.beginPath(); ctx.arc(w.x, w.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
            }
        });
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        resourceNodes.forEach(n => {
            if (!n.active || Math.hypot(n.x - player.x, n.y - player.y) > sensorRange) return;
            const pulse = 0.6 + Math.sin(t * 0.004) * 0.4;
            ctx.save(); ctx.globalAlpha = pulse;
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(n.x, n.y, 5, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = pulse * 0.35;
            ctx.fillStyle = `rgba(${CR},0.9)`;
            ctx.beginPath(); ctx.arc(n.x, n.y, 9, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 0.3;
            ctx.strokeStyle = `rgba(${CR},0.8)`; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(n.x, n.y, 20, 0, Math.PI * 2); ctx.stroke();
            ctx.restore(); ctx.globalAlpha = 1;
        });
    }

    // ヒッグス静電ノイズ
    if (higgsAtPlayer > 0.4) {
        const staticAlpha = (higgsAtPlayer - 0.4) * 0.15;
        ctx.save(); ctx.globalAlpha = staticAlpha;
        for (let i = 0; i < 6; i++) {
            const rx = player.x + (Math.random() - 0.5) * sensorRange * 2;
            const ry = player.y + (Math.random() - 0.5) * sensorRange * 2;
            if (Math.hypot(rx - player.x, ry - player.y) < sensorRange) {
                ctx.fillStyle = `rgba(${CR},0.8)`; ctx.fillRect(rx, ry, 2, 1);
            }
        }
        ctx.restore(); ctx.globalAlpha = 1;
    }

    // パッシブアンテナビジュアル: 不要 (スレットリングで代替)

    // スレットリング: 自機周囲に常に浮かぶ形状変化リング
    // 普段は穏やかな多角形。環境シグネチャ受信により各センサー方向に変形する。
    if (player && player.hp > 0) {
        const tRing = Date.now();
        const tSec  = tRing * 0.001;

        // 各センサーの受信シグネチャ集計
        // ベースリングは常に白。各センサーセグメントのみ色付き。
        const RING_SENSOR_COLORS = {
            heat: '255,160,60', optic: '60,255,180', em: '230,100,255', higgs: '60,240,255'
        };
        const RING_SENSOR_DIRS = {
            heat: -Math.PI * 0.5,    // 上 (北)
            optic: 0,                // 右 (東)
            em: Math.PI * 0.5,       // 下 (南)
            higgs: Math.PI           // 左 (西)
        };
        const ringSigVals = {};
        const ringDetectRange = FIELD_SIZE;
        // enemy毎のhiggsBlk・distを事前計算 (4センサーループで再利用)
        const _eCache = enemies.map(e => {
            if (e.hp <= 0) return null;
            return {
                e,
                dist: Math.hypot(e.x - player.x, e.y - player.y),
                hBlk: getHiggsIntensity((e.x + player.x)/2, (e.y + player.y)/2)
            };
        }).filter(Boolean);
        ['heat','optic','em','higgs'].forEach(sName => {
            const sc2 = sensorConfig[sName];
            let tot = 0;
            for (const c of _eCache) {
                const att = Math.max(0, 1 - c.dist / ringDetectRange);
                tot += sc2.sig(c.e) * att * (1 - c.hBlk * sc2.higgsMod);
            }
            ringSigVals[sName] = tot > 1.0 ? 1.0 : tot;
        });

        // 優勢センサーの色を決定
        let maxRingSig = 0, maxRingName = 'heat';
        ['heat','optic','em','higgs'].forEach(n => {
            if (ringSigVals[n] > maxRingSig) { maxRingSig = ringSigVals[n]; maxRingName = n; }
        });

        // リングの各点の半径を計算
        // 画面上で約90px半径に固定 (ズームアウト時に肥大化しないようクランプ)
        const _ringScreenR = Math.min(110, Math.max(55, 90));
        const BASE_R    = _ringScreenR / camera.zoom;
        const MAX_BULGE = (50 / camera.zoom);
        const N_POINTS  = 28;  // 18は角ばりが目立った。28で滑らか・コスト微増のみ
        const idleBreath = Math.sin(tSec * 0.7) * (3 / camera.zoom);
        const _rot = tSec * 0.08; // ループ外で事前計算

        const getRingRadius = (angle) => {
            let r = BASE_R + idleBreath;
            // センサー毎のローブ加算 (whileループ→if文に変更)
            const _sensorKeys = ['heat','optic','em','higgs'];
            for (let _si = 0; _si < 4; _si++) {
                const sName = _sensorKeys[_si];
                const sig = ringSigVals[sName];
                if (sig < 0.01) continue;
                let diff = angle - (RING_SENSOR_DIRS[sName] + _rot);
                if (diff < -Math.PI) diff += Math.PI * 2;
                else if (diff > Math.PI) diff -= Math.PI * 2;
                const lobe   = Math.exp(-diff * diff * 1.6) * sig * sig * MAX_BULGE;
                const ripple = Math.cos(diff * 5 + tSec * 2.5) * sig * 3.0 * Math.exp(-diff * diff * 4);
                r += lobe + ripple;
            }
            r += Math.sin(angle * 4 + tSec * 1.2) * 1.5;
            return r;
        };

        ctx.save();
        ctx.translate(player.x, player.y);

        // ── "THREAT SENSORS" ラベル (リング上部) ──────────────
        {
            const labelAngle = -Math.PI / 2; // 真上
            const labelR = BASE_R + idleBreath + 20 / camera.zoom;
            ctx.globalAlpha = 0.3 + maxRingSig * 0.4;
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.round(8 / camera.zoom)}px Orbitron, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('THREAT SENSORS', Math.cos(labelAngle) * labelR, Math.sin(labelAngle) * labelR);
            ctx.globalAlpha = 1;
        }

        // ── ベースリング (常に白で表示) ────────────────────────
        const idleAlpha = 0.7 + maxRingSig * 0.3;
        const ringLw = 1.0 / camera.zoom;

        ctx.globalAlpha = idleAlpha;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.0 * ringLw;
        ctx.beginPath();
        const _angStep = (Math.PI * 2) / N_POINTS;
        for (let i = 0; i <= N_POINTS; i++) {
            const ang = i * _angStep;
            const rr  = getRingRadius(ang);
            if (i === 0) ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
            else ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 1;

        // ── 各センサーの活性セグメントを色付きで強調 ──────────
        const SENSOR_NAMES = { heat: 'HEAT', optic: 'OPT', em: 'EM', higgs: 'HGS' };
        const RING_SENSOR_HEX = { heat: '#ffa03c', optic: '#3cffb4', em: '#e664ff', higgs: '#3cf0ff' };
        ['heat','optic','em','higgs'].forEach(sName => {
            const sig = ringSigVals[sName];
            if (sig < 0.04) return;
            const hex      = RING_SENSOR_HEX[sName];
            const dir      = RING_SENSOR_DIRS[sName];
            const halfSpan = Math.PI * (0.35 + sig * 0.4);
            const segN = 12;  // 24→12: 視覚差なし、計算半減
            ctx.globalAlpha = sig * 0.85;
            ctx.strokeStyle = hex;
            ctx.lineWidth   = (1.5 + sig * 2.5) * ringLw;
            ctx.beginPath();
            for (let i = 0; i <= segN; i++) {
                const ang = (dir - halfSpan) + (i / segN) * halfSpan * 2;
                const rr  = getRingRadius(ang);
                if (i === 0) ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
                else ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
            }
            ctx.stroke();

            // センサー方向のティックマーカー + ラベル
            const tickDir = dir + _rot;
            const tickR = getRingRadius(tickDir);
            ctx.globalAlpha = 0.4 + sig * 0.55;
            ctx.strokeStyle = hex;
            ctx.lineWidth = 2 * ringLw;
            ctx.beginPath();
            ctx.moveTo(Math.cos(tickDir) * (tickR + 3 / camera.zoom),  Math.sin(tickDir) * (tickR + 3 / camera.zoom));
            ctx.lineTo(Math.cos(tickDir) * (tickR + 14 / camera.zoom), Math.sin(tickDir) * (tickR + 14 / camera.zoom));
            ctx.stroke();
            const labelDist = tickR + 26 / camera.zoom;
            ctx.globalAlpha = 0.3 + sig * 0.6;
            ctx.fillStyle = hex;
            ctx.font = `bold ${Math.round(9 / camera.zoom)}px Orbitron, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(SENSOR_NAMES[sName], Math.cos(tickDir) * labelDist, Math.sin(tickDir) * labelDist);
        });
        ctx.globalAlpha = 1;

        ctx.restore();
    }

    // 指向性ソナーコーン描画 (強化版)
    if (dirSonarVisual && dirSonarVisual.life > 0) {
        const sv = dirSonarVisual;
        const sonarNow = Date.now() * 0.001;
        ctx.save();
        ctx.translate(player.x, player.y);
        ctx.rotate(sv.angle);

        // ── レイヤー1: グラデーション塗り ───────────────────
        const coneGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, sv.range);
        coneGrad.addColorStop(0,   `rgba(0,255,220,${(sv.life * 0.35).toFixed(3)})`);
        coneGrad.addColorStop(0.5, `rgba(0,255,220,${(sv.life * 0.12).toFixed(3)})`);
        coneGrad.addColorStop(1,   'rgba(0,255,220,0)');
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, sv.range, -sv.halfAngle, sv.halfAngle);
        ctx.closePath();
        ctx.fillStyle = coneGrad;
        ctx.fill();

        // ── レイヤー2: 輝くコーンエッジライン ───────────────
        ctx.shadowColor = 'rgba(0,255,220,1)';
        ctx.shadowBlur  = 4 * sv.life;
        ctx.strokeStyle = `rgba(0,255,220,${(sv.life * 0.95).toFixed(3)})`;
        ctx.lineWidth   = 1.8;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(-sv.halfAngle) * sv.range, Math.sin(-sv.halfAngle) * sv.range);
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(sv.halfAngle) * sv.range, Math.sin(sv.halfAngle) * sv.range);
        ctx.stroke();

        // ── レイヤー3: 外縁アーク ────────────────────────────
        ctx.strokeStyle = `rgba(0,255,220,${(sv.life * 0.6).toFixed(3)})`;
        ctx.lineWidth   = 1.2;
        ctx.shadowBlur  = 2 * sv.life;
        ctx.beginPath();
        ctx.arc(0, 0, sv.range, -sv.halfAngle, sv.halfAngle);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // ── レイヤー4: 拡張リングパルス (3本) ──────────────
        const ringSpeed = 0.9;
        for (let ri = 0; ri < 3; ri++) {
            const phase   = (sonarNow * ringSpeed + ri * (1 / 3)) % 1;
            const ringR   = phase * sv.range;
            const ringAlpha = sv.life * (1 - phase) * 0.55;
            if (ringAlpha <= 0.01) continue;
            ctx.strokeStyle = `rgba(0,255,220,${ringAlpha.toFixed(3)})`;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.arc(0, 0, ringR, -sv.halfAngle, sv.halfAngle);
            ctx.stroke();
        }

        // ── レイヤー5: スキャンライン (コーン内を往復) ──────
        if (sv.life > 0.15) {
            const sweepT    = (sonarNow * 1.2) % 1;
            const pingback  = sweepT < 0.5 ? sweepT * 2 : 2 - sweepT * 2; // 往復
            const sweepAng  = -sv.halfAngle + pingback * sv.halfAngle * 2;
            ctx.shadowColor = 'rgba(120,255,255,1)';
            ctx.shadowBlur  = 5;
            ctx.strokeStyle = `rgba(120,255,255,${(sv.life * 0.9).toFixed(3)})`;
            ctx.lineWidth   = 2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(sweepAng) * sv.range, Math.sin(sweepAng) * sv.range);
            ctx.stroke();
            ctx.shadowBlur = 0;
            // スキャン先端の輝点
            ctx.fillStyle = `rgba(255,255,255,${(sv.life * 0.8).toFixed(3)})`;
            ctx.shadowColor = 'rgba(0,255,220,1)';
            ctx.shadowBlur  = 6;
            ctx.beginPath();
            ctx.arc(Math.cos(sweepAng) * sv.range, Math.sin(sweepAng) * sv.range, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        // ── 発射元の輝き ────────────────────────────────────
        ctx.shadowColor = 'rgba(0,255,220,1)';
        ctx.shadowBlur  = 7 * sv.life;
        ctx.fillStyle   = `rgba(0,255,220,${(sv.life * 0.7).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(0, 0, 5 * sv.life, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.restore();
        ctx.globalAlpha = 1;

        dirSonarVisual.life -= 0.004;
        if (dirSonarVisual.life <= 0) {
            effects.push({ type: 'sonar-fill', x: player.x, y: player.y, r: sv.range, a: 0.12, c: `rgba(0,255,220,1)`, life: 240 });
            dirSonarVisual = null;
        }
    }
}

function drawMinimap() {
    // バッキングストアはDPR倍。描画はCSS px基準にして DPR でスケール (ボケ防止)。
    minimapCtx.setTransform(minimapDpr, 0, 0, minimapDpr, 0, 0);
    const mW = minimapCanvas.width / minimapDpr, mH = minimapCanvas.height / minimapDpr;
    minimapCtx.clearRect(0, 0, mW, mH);
    // Uniform scale to keep circular map as a circle
    const mmScale = Math.min(mW, mH) / FIELD_SIZE;
    const offX = (mW - FIELD_SIZE * mmScale) / 2;
    const offY = (mH - FIELD_SIZE * mmScale) / 2;
    const cxM = MAP_CX * mmScale + offX;
    const cyM = MAP_CY * mmScale + offY;
    const rM  = MAP_RADIUS * mmScale;

    // 円形クリップ
    minimapCtx.save();
    minimapCtx.beginPath();
    minimapCtx.arc(cxM, cyM, rM, 0, Math.PI * 2);
    minimapCtx.clip();

    // ヒッグス濃度オーバーレイ: bgMistCanvasを縮小drawImageで代替 (毎回createRadialGradientせず)
    if (bgMistCanvas) {
        minimapCtx.globalAlpha = 0.35;
        minimapCtx.drawImage(bgMistCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    // 地形オーバーレイ: デブリ帯(灰)/磁気嵐帯(紫) — 退避先の把握用
    if (debrisCanvas) {
        minimapCtx.globalAlpha = 0.45;
        minimapCtx.drawImage(debrisCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (stormCanvas) {
        minimapCtx.globalAlpha = 0.4;
        minimapCtx.drawImage(stormCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (thermalCanvas) {
        minimapCtx.globalAlpha = 0.35;
        minimapCtx.drawImage(thermalCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }

    // Viewport
    minimapCtx.strokeStyle = 'rgba(255,255,0,0.5)'; minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(camera.x * mmScale + offX, camera.y * mmScale + offY, (cssW / camera.zoom) * mmScale, (cssH / camera.zoom) * mmScale);

    // Structures (discovered: with icon, undiscovered: very faint)
    structures.forEach(st => {
        const mx = st.x * mmScale + offX, my = st.y * mmScale + offY;
        if (st.discovered || st.hacked) {
            minimapCtx.fillStyle = st.hacked ? '#00aaff' : (st.type === 'colony' ? '#ffaa00' : '#888888');
            minimapCtx.shadowColor = minimapCtx.fillStyle; minimapCtx.shadowBlur = 2;
            minimapCtx.beginPath();
            minimapCtx.moveTo(mx, my - 4); minimapCtx.lineTo(mx + 4, my);
            minimapCtx.lineTo(mx, my + 4); minimapCtx.lineTo(mx - 4, my);
            minimapCtx.closePath(); minimapCtx.fill();
            minimapCtx.shadowBlur = 0;
        } else {
            minimapCtx.fillStyle = 'rgba(255,255,255,0.1)';
            minimapCtx.fillRect(mx - 2, my - 2, 4, 4);
        }
    });

    // Stations (discovered: hexagon icon)
    stations.forEach(stn => {
        const mx = stn.x * mmScale + offX, my = stn.y * mmScale + offY;
        if (stn.discovered) {
            minimapCtx.fillStyle = '#00ffff';
            minimapCtx.shadowColor = '#00ffff'; minimapCtx.shadowBlur = 2;
            minimapCtx.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = (i/6)*Math.PI*2;
                if (i===0) minimapCtx.moveTo(mx+Math.cos(a)*5, my+Math.sin(a)*5);
                else minimapCtx.lineTo(mx+Math.cos(a)*5, my+Math.sin(a)*5);
            }
            minimapCtx.closePath(); minimapCtx.fill();
            minimapCtx.shadowBlur = 0;
        } else {
            minimapCtx.fillStyle = 'rgba(0,255,255,0.15)';
            minimapCtx.beginPath(); minimapCtx.arc(mx, my, 2, 0, Math.PI*2); minimapCtx.fill();
        }
    });

    // Player — improved visible marker
    if (player && player.hp > 0) {
        const px = player.x * mmScale + offX, py = player.y * mmScale + offY;
        const t = Date.now();
        // Pulsing outer ring
        const pulse = 0.5 + Math.sin(t * 0.005) * 0.5;
        minimapCtx.strokeStyle = `rgba(0,255,170,${0.4 + pulse * 0.4})`;
        minimapCtx.lineWidth = 1.5;
        minimapCtx.beginPath(); minimapCtx.arc(px, py, 7 + pulse * 2, 0, Math.PI * 2); minimapCtx.stroke();
        // Bright center
        minimapCtx.shadowColor = '#00ffaa'; minimapCtx.shadowBlur = 2;
        minimapCtx.fillStyle = '#ffffff';
        minimapCtx.beginPath(); minimapCtx.arc(px, py, 4, 0, Math.PI * 2); minimapCtx.fill();
        minimapCtx.shadowBlur = 0;
        // Direction arrow
        const arrowLen = 10;
        minimapCtx.strokeStyle = '#00ffaa'; minimapCtx.lineWidth = 1.5;
        minimapCtx.beginPath();
        minimapCtx.moveTo(px, py);
        minimapCtx.lineTo(px + Math.cos(player.angle) * arrowLen, py + Math.sin(player.angle) * arrowLen);
        minimapCtx.stroke();
    }

    // Enemies / センサー痕跡 (完全ロック=実位置 / センサー検知=推定位置を精度色で)
    enemies.forEach(e => {
        if (e.hp <= 0) return;
        if (e.inVision) {
            minimapCtx.fillStyle = '#ff4d4d';
            minimapCtx.beginPath(); minimapCtx.arc(e.x * mmScale + offX, e.y * mmScale + offY, 2.4, 0, Math.PI * 2); minimapCtx.fill();
        } else if (e.contactLife > 0 && e.visible) {
            const acc = e.contactAccuracy || 0;
            minimapCtx.globalAlpha = 0.35 + acc * 0.6;
            minimapCtx.fillStyle = acc > 0.7 ? '#ff4d4d' : (acc > 0.4 ? '#ffaa00' : '#ff8866');
            minimapCtx.beginPath(); minimapCtx.arc((e.displayX) * mmScale + offX, (e.displayY) * mmScale + offY, acc > 0.6 ? 2.2 : 1.5, 0, Math.PI * 2); minimapCtx.fill();
            minimapCtx.globalAlpha = 1;
        }
    });

    // リソースノード (常時ミニマップ表示; HIGGSセンサーで明るく)
    resourceNodes.forEach(n => {
        if (!n.active) return;
        minimapCtx.fillStyle = currentSensor === 'higgs' ? '#50c8ff' : 'rgba(80,200,255,0.4)';
        minimapCtx.shadowColor = '#50c8ff';
        minimapCtx.shadowBlur = currentSensor === 'higgs' ? 6 : 2;
        minimapCtx.beginPath();
        minimapCtx.arc(n.x * mmScale + offX, n.y * mmScale + offY, currentSensor === 'higgs' ? 4 : 2.5, 0, Math.PI * 2);
        minimapCtx.fill();
        minimapCtx.shadowBlur = 0;
    });

    // ソナーリング & 探知コンタクト (ミニマップ上)
    effects.forEach(ef => {
        if (ef.type === 'sonar' || ef.type === 'sonar-boundary') {
            const mx = ef.x * mmScale + offX, my = ef.y * mmScale + offY;
            const mr = ef.r * mmScale;
            minimapCtx.beginPath();
            minimapCtx.arc(mx, my, Math.max(1, mr), 0, Math.PI * 2);
            minimapCtx.strokeStyle = `rgba(0,255,220,${(ef.a * 0.8).toFixed(3)})`;
            minimapCtx.lineWidth = ef.type === 'sonar' ? 1.5 : 1;
            minimapCtx.shadowColor = 'rgba(0,255,220,0.8)'; minimapCtx.shadowBlur = 2;
            minimapCtx.stroke();
            minimapCtx.shadowBlur = 0;
        }
    });
    // ソナー探知済みコンタクトをミニマップに表示
    if (player && player.hp > 0) {
        enemies.forEach(e => {
            if (e.hp <= 0 || !e.visible || e.contactLife <= 0) return;
            const mx = (e.displayX || e.x) * mmScale + offX;
            const my = (e.displayY || e.y) * mmScale + offY;
            const lifeA = Math.min(1, e.contactLife / 120);
            minimapCtx.fillStyle = `rgba(255,80,80,${lifeA})`;
            minimapCtx.shadowColor = '#ff4444'; minimapCtx.shadowBlur = 2;
            minimapCtx.beginPath(); minimapCtx.arc(mx, my, 3, 0, Math.PI * 2); minimapCtx.fill();
            minimapCtx.shadowBlur = 0;
        });
    }

    // クリップ解除後に円形境界線
    minimapCtx.restore();
    minimapCtx.beginPath();
    minimapCtx.arc(cxM, cyM, rM, 0, Math.PI * 2);
    minimapCtx.strokeStyle = 'rgba(0,255,170,0.5)';
    minimapCtx.lineWidth = 1.5;
    minimapCtx.stroke();
}

function handleMinimapInteraction(e) {
    const r = minimapCanvas.getBoundingClientRect();
    const mapX = e.clientX - r.left; const mapY = e.clientY - r.top;
    const mW = minimapCanvas.width / minimapDpr, mH = minimapCanvas.height / minimapDpr;
    const mmScale = Math.min(mW, mH) / FIELD_SIZE;
    const offX = (mW - FIELD_SIZE * mmScale) / 2;
    const offY = (mH - FIELD_SIZE * mmScale) / 2;
    const wX = (mapX - offX) / mmScale;
    const wY = (mapY - offY) / mmScale;
    camera.x = wX - (cssW / 2 / camera.zoom); camera.y = wY - (cssH / 2 / camera.zoom);
    clampCamera();
}
let isMinimapDragging = false;
let _mmDownPos = null, _mmMoved = false;
minimapCanvas.addEventListener('mousedown', e => { isMinimapDragging = true; _mmDownPos = { x: e.clientX, y: e.clientY }; _mmMoved = false; });
minimapCanvas.addEventListener('mousemove', e => {
    if (!isMinimapDragging) return;
    if (_mmDownPos && Math.hypot(e.clientX - _mmDownPos.x, e.clientY - _mmDownPos.y) > 6) { _mmMoved = true; handleMinimapInteraction(e); }
});
window.addEventListener('mouseup', () => { if (isMinimapDragging && !_mmMoved) toggleMapMode(); isMinimapDragging = false; _mmDownPos = null; });

// ミニマップ タッチ対応
function handleMinimapTouchInteraction(t) {
    const r = minimapCanvas.getBoundingClientRect();
    const mapX = t.clientX - r.left;
    const mapY = t.clientY - r.top;
    const mW = minimapCanvas.width / minimapDpr, mH = minimapCanvas.height / minimapDpr;
    const mmScale = Math.min(mW, mH) / FIELD_SIZE;
    const offX = (mW - FIELD_SIZE * mmScale) / 2;
    const offY = (mH - FIELD_SIZE * mmScale) / 2;
    const wX = (mapX - offX) / mmScale;
    const wY = (mapY - offY) / mmScale;
    camera.x = wX - (cssW / 2 / camera.zoom);
    camera.y = wY - (cssH / 2 / camera.zoom);
    clampCamera();
}
// タップ=マップモード切替 / ドラッグ=カメラパン (移動量で判別)
minimapCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); const t = e.touches[0]; _mmDownPos = { x: t.clientX, y: t.clientY }; _mmMoved = false; }, { passive: false });
minimapCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault(); e.stopPropagation();
    const t = e.touches[0];
    if (_mmDownPos && Math.hypot(t.clientX - _mmDownPos.x, t.clientY - _mmDownPos.y) > 10) { _mmMoved = true; handleMinimapTouchInteraction(t); }
}, { passive: false });
minimapCanvas.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); if (!_mmMoved) toggleMapMode(); _mmDownPos = null; }, { passive: false });

// Background grid system
// ── パララックス・スターフィールド (スクリーン空間・事前焼き付けタイル) ──
// 背景テクスチャの引き伸ばしボケを補う「常に鮮明な」星层。
// 512pxタイル3層を起動時に1回生成し、毎フレームは drawImage 数回のみ。
let _starTileLayers = null;
const _STAR_TILE = 512;
function _initStarTiles() {
    _starTileLayers = [];
    // 焼き込み星を廃止したぶん鮮明パララックス星の密度を増やす (ボケ解消)
    const defs = [
        { n: 90, pf: 0.045, smin: 0.6, smax: 1.1, amin: 0.20, amax: 0.45 }, // 遠景
        { n: 52, pf: 0.110, smin: 0.9, smax: 1.7, amin: 0.35, amax: 0.70 }, // 中景
        { n: 22, pf: 0.240, smin: 1.4, smax: 2.6, amin: 0.55, amax: 1.00 }, // 近景
    ];
    for (const L of defs) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = _STAR_TILE;
        const tc = tile.getContext('2d');
        for (let i = 0; i < L.n; i++) {
            const v = Math.random();
            tc.globalAlpha = L.amin + Math.random() * (L.amax - L.amin);
            tc.fillStyle = v < 0.55 ? '#cdd9ff' : (v < 0.80 ? '#ffffff' : (v < 0.92 ? '#ffd9a8' : '#a8c8ff'));
            const s = L.smin + Math.random() * (L.smax - L.smin);
            tc.fillRect(Math.random() * _STAR_TILE, Math.random() * _STAR_TILE, s, s);
        }
        tc.globalAlpha = 1;
        _starTileLayers.push({ pf: L.pf, tile });
    }
}

function _drawStarfield(ctx) {
    if (!_starTileLayers) _initStarTiles();
    const W = cssW, H = cssH;
    ctx.save();
    ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0); // スクリーン空間(CSS px)で描画
    for (const L of _starTileLayers) {
        // カメラ移動にパララックス係数を掛けてオフセット (mod でタイルラップ)
        let ox = (-camera.x * camera.zoom * L.pf) % _STAR_TILE;
        let oy = (-camera.y * camera.zoom * L.pf) % _STAR_TILE;
        if (ox > 0) ox -= _STAR_TILE;
        if (oy > 0) oy -= _STAR_TILE;
        for (let ty = oy; ty < H; ty += _STAR_TILE) {
            for (let tx = ox; tx < W; tx += _STAR_TILE) {
                ctx.drawImage(L.tile, tx, ty);
            }
        }
    }
    ctx.restore();
}

// シームレスな星雲タイルを生成 (透過背景・端ラップで継ぎ目なし)
function _initNebulaTile() {
    const T = _NEB_TILE;
    const c = document.createElement('canvas');
    c.width = T; c.height = T;
    const b = c.getContext('2d');
    let _s = (Math.random() * 0xffffffff) >>> 0;
    const rng = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
    const palettes = ['14,110,170', '50,60,180', '60,25,150', '12,150,180', '40,90,170'];
    // 大小の柔らかい雲を配置。各ブロブを3x3オフセットで描いて端をシームレスにラップ。
    const blobs = 16;
    for (let i = 0; i < blobs; i++) {
        const bx = rng() * T, by = rng() * T;
        const r = 150 + rng() * 280;
        const col = palettes[(rng() * palettes.length) | 0];
        const a = 0.05 + rng() * 0.11;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const cx = bx + ox * T, cy = by + oy * T;
            if (cx < -r || cx > T + r || cy < -r || cy > T + r) continue;
            const g = b.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0,   `rgba(${col},${a})`);
            g.addColorStop(0.5, `rgba(${col},${a * 0.5})`);
            g.addColorStop(1,   `rgba(${col},0)`);
            b.fillStyle = g;
            b.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
    }
    _nebulaTile = c;
}

// 星雲をスクリーン空間のパララックス層として描画 (常にほぼ等倍=シャープ)
function _drawNebula(ctx) {
    if (!_nebulaTile) _initNebulaTile();
    const W = cssW, H = cssH;
    const pf = 0.05;                 // ごく遅いパララックス (遠景)
    const TS = _NEB_TILE * 1.5;       // 大きめに敷いて繰り返しを目立たせない
    ctx.save();
    ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0); // スクリーン空間(CSS px)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    let ox = (-camera.x * camera.zoom * pf) % TS; if (ox > 0) ox -= TS;
    let oy = (-camera.y * camera.zoom * pf) % TS; if (oy > 0) oy -= TS;
    for (let ty = oy; ty < H; ty += TS) {
        for (let tx = ox; tx < W; tx += TS) {
            ctx.drawImage(_nebulaTile, tx, ty, TS, TS);
        }
    }
    ctx.restore();
}

// 明るい巨星タイルを生成 (透過背景・鮮明)。1〜2個をタイル内に配置し、ほぼ等倍で描いてボケを排除。
function _initGiantStarTile() {
    const T = _GSTAR_TILE;
    const c = document.createElement('canvas');
    c.width = T; c.height = T;
    const b = c.getContext('2d');
    let _s = (Math.random() * 0xffffffff) >>> 0;
    const rng = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
    const count = 1 + (rng() < 0.5 ? 1 : 0);
    for (let si = 0; si < count; si++) {
        const sx = T * (0.18 + rng() * 0.64), sy = T * (0.12 + rng() * 0.5);
        const sr = 120 + rng() * 150; // ハロー半径 (CSS px相当・鮮明)
        const haloCol = rng() < 0.5 ? '180,80,200' : '200,60,100';
        // 後光
        const hg = b.createRadialGradient(sx, sy, 0, sx, sy, sr);
        hg.addColorStop(0,   `rgba(${haloCol},0.20)`);
        hg.addColorStop(0.4, `rgba(${haloCol},0.08)`);
        hg.addColorStop(0.7, `rgba(${haloCol},0.03)`);
        hg.addColorStop(1,   'rgba(0,0,0,0)');
        b.fillStyle = hg; b.beginPath(); b.arc(sx, sy, sr, 0, Math.PI * 2); b.fill();
        // 白いコア
        const cr = 8 + rng() * 4;
        const cg = b.createRadialGradient(sx, sy, 0, sx, sy, cr * 2.4);
        cg.addColorStop(0,   'rgba(255,255,255,1)');
        cg.addColorStop(0.3, 'rgba(220,240,255,0.85)');
        cg.addColorStop(1,   'rgba(0,0,0,0)');
        b.fillStyle = cg; b.beginPath(); b.arc(sx, sy, cr * 2.4, 0, Math.PI * 2); b.fill();
        // 光芒 (4本)
        for (let ray = 0; ray < 4; ray++) {
            const a = ray * Math.PI / 2;
            b.save();
            b.translate(sx, sy); b.rotate(a);
            const rg = b.createLinearGradient(0, 0, sr * 1.6, 0);
            rg.addColorStop(0,   'rgba(255,255,255,0.5)');
            rg.addColorStop(0.3, 'rgba(200,230,255,0.12)');
            rg.addColorStop(1,   'rgba(0,0,0,0)');
            b.fillStyle = rg;
            b.beginPath(); b.moveTo(0, -3); b.lineTo(sr * 1.6, 0); b.lineTo(0, 3); b.closePath(); b.fill();
            b.restore();
        }
    }
    _giantStarTile = c;
}

// 巨星を最遠景のスクリーン空間パララックス層として描画 (ほぼ等倍=鮮明)
function _drawGiantStars(ctx) {
    if (!_giantStarTile) _initGiantStarTile();
    const W = cssW, H = cssH;
    const pf = 0.035;          // 最も遅いパララックス (最遠景)
    const TS = _GSTAR_TILE;
    ctx.save();
    ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0); // スクリーン空間(CSS px)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    let ox = (-camera.x * camera.zoom * pf) % TS; if (ox > 0) ox -= TS;
    let oy = (-camera.y * camera.zoom * pf) % TS; if (oy > 0) oy -= TS;
    for (let ty = oy; ty < H; ty += TS) {
        for (let tx = ox; tx < W; tx += TS) {
            ctx.drawImage(_giantStarTile, tx, ty);
        }
    }
    ctx.restore();
}

function drawBackground(ctx) {
    if (PERF_DISABLE_BG) {
        const vw = cssW / camera.zoom;
        const vh = cssH / camera.zoom;
        ctx.fillStyle = 'rgb(1,3,14)';
        ctx.fillRect(camera.x, camera.y, vw, vh);
        return;
    }
    const vw = cssW / camera.zoom;
    const vh = cssH / camera.zoom;
    const cx = camera.x, cy = camera.y;

    // 宇宙背景テクスチャ (事前生成、ゲーム毎に異なる星雲配置)
    if (spaceBgCanvas) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(spaceBgCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        _drawNebula(ctx);      // シャープな星雲パララックス層 (引き伸ばしボケ解消)
        _drawGiantStars(ctx);  // 鮮明な巨星パララックス層 (68倍拡大のボケ解消)
        _drawStarfield(ctx);   // 鮮明なパララックス星層を重ねる
    } else {
        ctx.fillStyle = 'rgb(1,3,14)';
        ctx.fillRect(cx, cy, vw, vh);
    }

    // Higgs mist clouds — 密度別カラーで可視化
    // bgMist: オフスクリーンキャンバスに事前焼き付け済み → drawImageで一発描画
    if (bgMistCanvas) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bgMistCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
    }

    // 地形層 (§3-13 D): デブリ帯=岩片の点描 / 磁気嵐帯=EMノイズ(明滅)
    if (debrisCanvas) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(debrisCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
    }
    if (stormCanvas) {
        ctx.save();
        ctx.globalAlpha = 0.6 + Math.sin(Date.now() * 0.006) * 0.18; // EMノイズの明滅
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(stormCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.restore();
    }
    if (thermalCanvas) {
        ctx.save();
        ctx.globalAlpha = 0.50 + Math.sin(Date.now() * 0.003 + 2.1) * 0.14; // 熱ゆらぎ (嵐より遅い)
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(thermalCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.restore();
    }

    // Sparse coordinate grid (large cells)
    const gridSize = 2000;
    const startX = Math.floor(cx / gridSize) * gridSize;
    const startY = Math.floor(cy / gridSize) * gridSize;
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < cx + vw; x += gridSize) {
        ctx.moveTo(x, cy); ctx.lineTo(x, cy + vh);
    }
    for (let y = startY; y < cy + vh; y += gridSize) {
        ctx.moveTo(cx, y); ctx.lineTo(cx + vw, y);
    }
    ctx.stroke();

    // 円形マップ境界 — ビューポートが境界に近い場合のみ描画 (毎フレームのarc計算削減)
    const _camCenterX = cx + vw * 0.5, _camCenterY = cy + vh * 0.5;
    const _distToEdge = Math.abs(Math.hypot(_camCenterX - MAP_CX, _camCenterY - MAP_CY) - MAP_RADIUS);
    if (_distToEdge < Math.max(vw, vh) * 0.8 + 500) {
        ctx.save();
        // 境界ライン
        ctx.beginPath();
        ctx.arc(MAP_CX, MAP_CY, MAP_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,255,170,0.18)';
        ctx.lineWidth = 80;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,255,170,0.5)';
        ctx.lineWidth = 3;
        ctx.stroke();
        // マップ外を暗く塗り潰す (クリッピングの逆)
        ctx.beginPath();
        ctx.rect(cx, cy, vw, vh);
        ctx.arc(MAP_CX, MAP_CY, MAP_RADIUS + 2, 0, Math.PI * 2, true);
        ctx.fillStyle = 'rgba(0,0,5,0.92)';
        ctx.fill();
        ctx.restore();
    }
}

// オシロスコープ風シグネチャ表示
const _sigHistory = { heat: [], optic: [], em: [], higgs: [] };
const _SIG_HIST_LEN = 60;

// 環境シグネチャ履歴 (周囲の敵シグネチャ合算)
const _envSigHistory = { heat: [], optic: [], em: [], higgs: [] };
const ENV_SIG_HIST_LEN = 60;

function updateSigCanvas() {
    if (!player || player.hp <= 0) return;
    const sigCanvas = document.getElementById('sig-canvas');
    if (!sigCanvas) return;
    const sc = sigCanvas.getContext('2d');
    const w = sigCanvas.width, h = sigCanvas.height;
    sc.clearRect(0, 0, w, h);
    sc.fillStyle = 'rgba(0,5,12,0.95)';
    sc.fillRect(0, 0, w, h);

    const spd = Math.hypot(player.x-(player.prevX||player.x), player.y-(player.prevY||player.y));
    const engType = ENGINE_TYPES[gameState.engineType]||ENGINE_TYPES.thermonuclear;
    const hHere = getHiggsIntensity(player.x, player.y);
    // Ship.update()で計算済みの自機シグネチャをそのまま使用
    const currentVals = {
        heat:  player.heatSig  || 0,
        optic: player.opticalSig || 0,
        em:    player.emSig    || 0,
        higgs: player.higgsSig || 0
    };

    const sigs = [
        { key: 'heat',  color: '#ff6600', rgb: '255,102,0',   label: 'H', baseFreq: 1.8 },
        { key: 'optic', color: '#00ffaa', rgb: '0,255,170',   label: 'O', baseFreq: 2.6 },
        { key: 'em',    color: '#cc44ff', rgb: '204,68,255',  label: 'E', baseFreq: 1.3 },
        { key: 'higgs', color: '#50c8ff', rgb: '80,200,255',  label: 'G', baseFreq: 4.0 }
    ];

    sigs.forEach(sig => {
        _sigHistory[sig.key].push(currentVals[sig.key]);
        if (_sigHistory[sig.key].length > _SIG_HIST_LEN) _sigHistory[sig.key].shift();
    });

    const nowSec = Date.now() * 0.001;
    const rowH = h / 4;

    sigs.forEach((sig, i) => {
        const cy = (i + 0.5) * rowH;
        const v = currentVals[sig.key];

        // グリッド線
        sc.strokeStyle = 'rgba(255,255,255,0.07)';
        sc.lineWidth = 0.5;
        sc.beginPath(); sc.moveTo(0, cy); sc.lineTo(w, cy); sc.stroke();

        // ラベル
        sc.fillStyle = sig.color;
        sc.font = 'bold 7px monospace';
        sc.fillText(sig.label, 2, cy + 3);

        const xStart = 10;
        const xEnd = w - 6;

        // 波の高さ = v * rowH * 0.43 (値が大きいほど振幅大)
        // 波の間隔 = baseFreq + v*9 (値が大きいほど密)
        // スクロール速度も値に比例
        // sqrt スケーリング: 微小シグネチャでも視覚的に明確な波形を表示
        const amp   = Math.sqrt(v) * rowH * 0.38;
        const freq  = sig.baseFreq + v * 9.0;
        const scroll = nowSec * (1.5 + v * 4.0);

        // 常時ベースライン波形 (値ゼロでも動く)
        const idleAmp  = rowH * 0.06;
        const idleFreq = 0.8;

        sc.save();
        sc.shadowColor = sig.color;
        sc.shadowBlur  = v > 0.02 ? 2 : 1;
        sc.strokeStyle = sig.color;
        sc.lineWidth   = v > 0.02 ? 1.4 : 0.9;
        sc.globalAlpha = 0.35 + v * 0.65;
        sc.beginPath();
        // ループを2pxステップに (Math.sin()コスト半減、視覚差なし)
        const _tScale   = 1 / (xEnd - xStart);
        const _piFreq   = 2 * Math.PI * freq;
        const _piFreq21 = 2 * Math.PI * freq * 2.1;
        const _piIdle   = 2 * Math.PI * idleFreq;
        const _phOff    = scroll * 2 * Math.PI;
        const _phOff2   = scroll * 1.05 * 2 * Math.PI;
        const _idleOff  = nowSec * 0.6 * 2 * Math.PI;
        for (let x = xStart; x <= xEnd; x += 2) {
            const t = (x - xStart) * _tScale;
            const wave = amp * Math.sin(t * _piFreq - _phOff)
                       + amp * 0.28 * Math.sin(t * _piFreq21 - _phOff2)
                       + idleAmp * Math.sin(t * _piIdle - _idleOff);
            const y = cy - wave;
            if (x === xStart) sc.moveTo(x, y); else sc.lineTo(x, y);
        }
        sc.stroke();

        // 走査線先端を明るく (右端の輝点)
        const tipX = xEnd;
        const tipT = 1.0;
        const tipWave = amp * Math.sin(2 * Math.PI * (tipT * freq - scroll))
                      + amp * 0.28 * Math.sin(2 * Math.PI * (tipT * freq * 2.1 - scroll * 1.05))
                      + idleAmp * Math.sin(2 * Math.PI * (tipT * idleFreq - nowSec * 0.6));
        sc.shadowBlur = v > 0.05 ? 3 : 1;
        sc.fillStyle = '#ffffff';
        sc.globalAlpha = 0.5 + v * 0.5;
        sc.beginPath();
        sc.arc(tipX, cy - tipWave, v > 0.05 ? 1.8 : 1.0, 0, Math.PI * 2);
        sc.fill();
        sc.restore();
    });

    // 右端に現在値バー
    sigs.forEach((sig, i) => {
        const cy = (i + 0.5) * rowH;
        const v = currentVals[sig.key];
        const barH = Math.max(2, v * rowH * 0.85);
        sc.fillStyle = sig.color;
        sc.globalAlpha = 0.7;
        sc.fillRect(w - 4, cy - barH/2, 3, barH);
        sc.globalAlpha = 1;
    });
}

// ============================================================
// 環境シグネチャオシロスコープ描画
// ============================================================
function updateEnvSigCanvas() {
    if (!player || player.hp <= 0) return;
    const envCanvas = document.getElementById('env-sig-canvas');
    if (!envCanvas) return;
    const ec = envCanvas.getContext('2d');
    const w = envCanvas.width, h = envCanvas.height;
    ec.clearRect(0, 0, w, h);
    ec.fillStyle = 'rgba(0,5,12,0.9)';
    ec.fillRect(0, 0, w, h);

    // 周囲の敵シグネチャを各センサータイプごとに合算
    // 検出範囲: パッシブ検知と同じ全マップ範囲 (距離減衰のみ適用)
    const envDetectRange = FIELD_SIZE; // 環境SIGは全マップ対象 (距離で減衰)
    const envVals = { heat: 0, optic: 0, em: 0, higgs: 0 };
    enemies.forEach(e => {
        if (e.hp <= 0) return;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        const higgsPath = getHiggsIntensity((e.x + player.x)/2, (e.y + player.y)/2);
        const distAtten = Math.max(0, 1 - dist / envDetectRange);
        ['heat', 'optic', 'em', 'higgs'].forEach(key => {
            const sc2 = sensorConfig[key];
            envVals[key] = Math.min(1, envVals[key] + sc2.sig(e) * distAtten * (1 - higgsPath * sc2.higgsMod));
        });
    });

    const sigs = [
        { key: 'heat',  color: '#ff6600', label: 'H', baseFreq: 1.8 },
        { key: 'optic', color: '#ffee00', label: 'O', baseFreq: 2.6 },
        { key: 'em',    color: '#cc44ff', label: 'E', baseFreq: 1.3 },
        { key: 'higgs', color: '#00ffff', label: 'G', baseFreq: 4.0 }
    ];

    sigs.forEach(sig => {
        _envSigHistory[sig.key].push(envVals[sig.key]);
        if (_envSigHistory[sig.key].length > ENV_SIG_HIST_LEN) _envSigHistory[sig.key].shift();
    });

    const nowSec = Date.now() * 0.001;
    const rowH = h / 4;

    sigs.forEach((sig, i) => {
        const cy = (i + 0.5) * rowH;
        const v = envVals[sig.key];

        // グリッド線
        ec.strokeStyle = 'rgba(255,255,255,0.07)';
        ec.lineWidth = 0.5;
        ec.beginPath(); ec.moveTo(0, cy); ec.lineTo(w, cy); ec.stroke();

        // ラベル
        ec.fillStyle = sig.color;
        ec.font = 'bold 7px monospace';
        ec.fillText(sig.label, 2, cy + 3);

        const xStart = 10;
        const xEnd = w - 6;

        // sqrt スケーリング: 微小シグネチャでも視覚的に明確な波形を表示
        const amp    = Math.sqrt(v) * rowH * 0.38;
        const freq   = sig.baseFreq + v * 9.0;
        const scroll = nowSec * (1.5 + v * 4.0) + i * 2.1; // 位相オフセット

        const idleAmp  = rowH * 0.06;
        const idleFreq = 0.7 + i * 0.2;

        ec.save();
        ec.shadowColor = sig.color;
        ec.shadowBlur  = v > 0.02 ? 5 : 2;
        ec.strokeStyle = sig.color;
        ec.lineWidth   = v > 0.02 ? 1.4 : 0.9;
        ec.globalAlpha = 0.35 + v * 0.65;
        ec.beginPath();
        // ステップ2でサンプリング (視覚的に同等、Math.sin()コストを半減)
        const tScale   = 1 / (xEnd - xStart);
        const piFreq   = 2 * Math.PI * freq;
        const piFreq21 = 2 * Math.PI * freq * 2.1;
        const piIdle   = 2 * Math.PI * idleFreq;
        const phaseOff = scroll * 2 * Math.PI;
        const phaseOff2 = scroll * 1.05 * 2 * Math.PI;
        const idleOff  = nowSec * 0.5 * 2 * Math.PI;
        for (let x = xStart; x <= xEnd; x += 2) {
            const t = (x - xStart) * tScale;
            const wave = amp * Math.sin(t * piFreq - phaseOff)
                       + amp * 0.28 * Math.sin(t * piFreq21 - phaseOff2)
                       + idleAmp * Math.sin(t * piIdle - idleOff);
            const y = cy - wave;
            if (x === xStart) ec.moveTo(x, y); else ec.lineTo(x, y);
        }
        ec.stroke();

        // 走査線先端輝点
        const tipWave = amp * Math.sin(2 * Math.PI * (1.0 * freq - scroll))
                      + amp * 0.28 * Math.sin(2 * Math.PI * (1.0 * freq * 2.1 - scroll * 1.05))
                      + idleAmp * Math.sin(2 * Math.PI * (1.0 * idleFreq - nowSec * 0.5));
        ec.shadowBlur = v > 0.05 ? 8 : 2;
        ec.fillStyle = '#ffffff';
        ec.globalAlpha = 0.5 + v * 0.5;
        ec.beginPath();
        ec.arc(xEnd, cy - tipWave, v > 0.05 ? 1.8 : 1.0, 0, Math.PI * 2);
        ec.fill();
        ec.restore();
    });

    // 右端に現在値バー
    sigs.forEach((sig, i) => {
        const cy = (i + 0.5) * rowH;
        const v = envVals[sig.key];
        const barH = Math.max(2, v * rowH * 0.85);
        ec.fillStyle = sig.color;
        ec.globalAlpha = 0.7;
        ec.fillRect(w - 4, cy - barH/2, 3, barH);
        ec.globalAlpha = 1;
    });
}

// ============================================================
// 環境情報パネル動的更新
// ============================================================
function updateEnvInfo() {
    if (!player || player.hp <= 0) return;
    const intensity = getHiggsIntensity(player.x, player.y);
    // ヒッグス濃度を0-100%の連続値で表示
    const higgsSpan = document.getElementById('env-higgs');
    const radarSpan = document.getElementById('env-radar');
    if (higgsSpan) {
        higgsSpan.textContent = Math.round(intensity * 100) + '%';
        higgsSpan.className = intensity > 0.75 ? 'warning-text' : (intensity > 0.4 ? 'highlight-text' : '');
    }
    // 地形ハザード密度 (§3-13 D)
    const debrisSpan = document.getElementById('env-debris');
    if (debrisSpan) debrisSpan.textContent = Math.round(getDebrisIntensity(player.x, player.y) * 100) + '%';
    const stormSpan = document.getElementById('env-storm');
    if (stormSpan) stormSpan.textContent = Math.round(getStormIntensity(player.x, player.y) * 100) + '%';
    const thermalSpan = document.getElementById('env-thermal');
    if (thermalSpan) thermalSpan.textContent = Math.round(getThermalIntensity(player.x, player.y) * 100) + '%';
    if (radarSpan) {
        const sLv = gameState.upgrades.sensor;
        const omniR = Math.round(OMNI_SONAR_RANGE[sLv] * (genAlloc.sensors / 100) * genGain);
        radarSpan.textContent = `全周囲 ${omniR}u / 指向 ${Math.round(DIR_SONAR_MAX_RANGE * genAlloc.sensors / 100 * genGain)}u`;
    }
    document.getElementById('hostile-count').textContent =
        enemies.filter(e => e.visible).length > 0 ? enemies.filter(e => e.visible).length + '機' : '不明';

    // センサーモード表示
    const sensorEl = document.getElementById('env-sensor');
    if (sensorEl) {
        const sensorLabels = { heat: '🔥 熱源', optic: '👁 光学', em: '📡 電磁波', higgs: '〰 ヒッグス' };
        const sensorColors = { heat: '#ff6600', optic: '#00ffaa', em: '#cc44ff', higgs: '#50c8ff' };
        sensorEl.textContent = sensorLabels[currentSensor] || '---';
        sensorEl.className = '';
        sensorEl.style.color = sensorColors[currentSensor] || '';
    }

    // 受信シグネチャ強度表示 (複数の敵の最大値)
    const sigEl = document.getElementById('env-signal');
    if (sigEl) {
        const sc_map = sensorConfig[currentSensor];
        let maxSig = 0;
        enemies.forEach(e => {
            if (!e.visible) return;
            const dist = Math.hypot(e.x - player.x, e.y - player.y);
            const higgsBlock = getHiggsIntensity((e.x + player.x)/2, (e.y + player.y)/2);
            const attenuated = sc_map.sig(e) * (1 - higgsBlock * sc_map.higgsMod);
            maxSig = Math.max(maxSig, attenuated);
        });
        const bars = '█'.repeat(Math.round(maxSig * 5)) + '░'.repeat(5 - Math.round(maxSig * 5));
        sigEl.textContent = bars;
        sigEl.style.color = maxSig > 0.6 ? '#ff4d4d' : (maxSig > 0.3 ? '#ffaa00' : '#888');
    }
    // updateSigCanvas は gameLoop から毎2フレームで呼ばれるためここでは省略 (二重呼び出し防止)
    updateEnvSigCanvas();

    // GEN配分情報 (リソースノード数)
    const nodeEl = document.getElementById('env-nodes');
    if (nodeEl) {
        const activeNodes = resourceNodes.filter(n => n.active).length;
        nodeEl.textContent = `${activeNodes}/${resourceNodes.length}`;
    }

    // 弾薬・リロード状態表示
    const ammoEl = document.getElementById('ammo-display');
    if (ammoEl && player) {
        const wTypeCur = document.getElementById('weapon-select') ? document.getElementById('weapon-select').value : 'kinetic';
        let ammoText = '';
        if (wTypeCur === 'kinetic') {
            ammoText = player.kineticReloading
                ? `RELOAD ${Math.ceil(player.kineticReloadTimer / 60)}s`
                : `${player.kineticAmmo}/${player.kineticMaxAmmo}`;
            ammoEl.style.color = player.kineticReloading ? '#ff4444' : '#ffaa00';
        } else if (wTypeCur === 'missile') {
            ammoText = player.missileReloading
                ? `RELOAD ${Math.ceil(player.missileReloadTimer / 60)}s`
                : 'READY';
            ammoEl.style.color = player.missileReloading ? '#ff4444' : '#00ff88';
        } else if (wTypeCur === 'beam') {
            ammoText = player.beamReloading
                ? `RELOAD ${Math.ceil(player.beamReloadTimer / 60)}s`
                : 'READY';
            ammoEl.style.color = player.beamReloading ? '#ff4444' : '#00aaff';
        }
        ammoEl.textContent = ammoText;
    }

    // ── モバイルステータスバー同期 ──
    const msbHpFill = document.getElementById('msb-hp-fill');
    const msbHpText = document.getElementById('msb-hp-text');
    const msbHiggs  = document.getElementById('msb-higgs');
    const msbEnemies = document.getElementById('msb-enemies');
    const msbAmmo   = document.getElementById('msb-ammo');
    const msbNodes  = document.getElementById('msb-nodes');
    const msbDebris = document.getElementById('msb-debris');
    const msbStorm  = document.getElementById('msb-storm');
    if (player && player.hp > 0) {
        const hpPct = Math.max(0, Math.round((player.hp / player.maxHp) * 100));
        if (msbHpFill) msbHpFill.style.width = hpPct + '%';
        if (msbHpText) msbHpText.textContent = hpPct + '%';
        if (msbHiggs) msbHiggs.textContent = Math.round(getHiggsIntensity(player.x, player.y) * 100) + '%';
        if (msbDebris) msbDebris.textContent = Math.round(getDebrisIntensity(player.x, player.y) * 100) + '%';
        if (msbStorm) msbStorm.textContent = Math.round(getStormIntensity(player.x, player.y) * 100) + '%';
        const msbThermal = document.getElementById('msb-thermal');
        if (msbThermal) msbThermal.textContent = Math.round(getThermalIntensity(player.x, player.y) * 100) + '%';
        if (msbEnemies) msbEnemies.textContent = enemies.filter(e => e.visible).length || '?';
        if (msbAmmo) {
            const wTypeMsb = document.getElementById('weapon-select')?.value || 'kinetic';
            if (wTypeMsb === 'kinetic') {
                msbAmmo.textContent = player.kineticReloading ? 'RLD' : `${player.kineticAmmo}/${player.kineticMaxAmmo}`;
                msbAmmo.style.color = player.kineticReloading ? '#ff4444' : '#ffaa00';
            } else {
                const rld = (wTypeMsb === 'missile' ? player.missileReloading : player.beamReloading);
                msbAmmo.textContent = rld ? 'RLD' : 'RDY';
                msbAmmo.style.color = rld ? '#ff4444' : '#00ff88';
            }
        }
        if (msbNodes) {
            const an = resourceNodes.filter(n => n.active).length;
            msbNodes.textContent = `${an}/${resourceNodes.length}`;
        }
    }
    // メニューモーダルのセクター/クレジットも同期
    const mmSector = document.getElementById('mm-sector');
    const mmCredits = document.getElementById('mm-credits');
    if (mmSector) mmSector.textContent = `セクター: ${gameState.sector}`;
    if (mmCredits) mmCredits.textContent = `クレジット: ${gameState.credits} SCR`;
}

// ============================================================
// ゲームオーバー / セクタークリア
// ============================================================
function showGameOver() {
    document.getElementById('go-sector').textContent = gameState.sector;
    document.getElementById('go-credits').textContent = gameState.credits;
    document.getElementById('go-kills').textContent = enemiesKilled;
    document.getElementById('game-over-overlay').classList.remove('hidden');
}

function showSectorClear(bonus) {
    const el = document.getElementById('sector-clear-banner');
    if (!el) return;
    el.querySelector('#sc-bonus').textContent = bonus;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 4000);
}

function drawTargetLine(ctx) {
    if (player.targetEntity && player.targetEntity.hp > 0) {
        ctx.beginPath(); ctx.moveTo(player.x, player.y); ctx.lineTo(player.targetEntity.x, player.targetEntity.y);
        ctx.setLineDash([5, 10]); ctx.strokeStyle = 'rgba(255, 77, 77, 0.5)';
        ctx.lineWidth = Math.max(2, 4 / camera.zoom); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(player.targetEntity.x, player.targetEntity.y, player.targetEntity.radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 77, 77, 0.9)';
        ctx.lineWidth = Math.max(2, 3 / camera.zoom); ctx.stroke();
    }
    // ウェイポイントライン: 細い破線のみ (ワールド空間)
    else if (player.state === 'moving') {
        ctx.beginPath(); ctx.moveTo(player.x, player.y); ctx.lineTo(player.targetX, player.targetY);
        ctx.setLineDash([Math.max(8, 12/camera.zoom), Math.max(5, 8/camera.zoom)]);
        ctx.strokeStyle = 'rgba(0,200,255,0.45)';
        ctx.lineWidth = Math.max(1, 1.5 / camera.zoom);
        ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 1;
    }
}

// ============================================================
// HUDオーバーレイ描画 (スクリーン空間 — ズームに関わらず固定サイズ)
// ============================================================
function drawHUDOverlay(ctx) {
    if (!player || player.hp <= 0) return;
    const { sx: psx, sy: psy } = worldToScreen(player.x, player.y);
    const t = Date.now();

    // ── 長押し進捗リング (ウェイポイント設定のフィードバック) ──
    // 指を止めて押している間だけ充填。スワイプ(パン)では即消える=取り違え防止の視覚手がかり。
    if (touch.holding) {
        const prog = Math.max(0, Math.min(1, (t - touch.startTime) / TOUCH_WAYPOINT_DELAY));
        if (prog > 0.04) {
            ctx.save();
            ctx.translate(touch.holdSX, touch.holdSY);
            ctx.strokeStyle = 'rgba(0,255,170,0.22)';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeStyle = '#00ffaa';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(0, 0, 26, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = 0.3 + prog * 0.6;
            ctx.fillStyle = '#00ffaa';
            ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
            ctx.restore();
        }
    }

    // ── 自機マーカー: 縮小時のみ表示。拡大して艦本体が十分見える時は自然に消す ──
    const _shipScreenDiam = camera.zoom * player.radius * 5.6; // 艦の画面上の直径(px)
    if (_shipScreenDiam < 36) {
        const mS = 14; // marker size in screen pixels
        // 艦が見え始める手前でフェードアウト (28px〜36pxで薄くなる)
        const markerAlpha = _shipScreenDiam > 28 ? Math.max(0, (36 - _shipScreenDiam) / 8) : 1;
        ctx.save();
        ctx.globalAlpha = markerAlpha;
        ctx.translate(psx, psy);
        ctx.rotate(player.angle);
        ctx.shadowColor = '#00ffaa'; ctx.shadowBlur = 3;
        ctx.fillStyle = '#00ffaa';
        ctx.beginPath();
        ctx.moveTo(mS, 0);
        ctx.lineTo(-mS * 0.6, -mS * 0.55);
        ctx.lineTo(-mS * 0.25, 0);
        ctx.lineTo(-mS * 0.6, mS * 0.55);
        ctx.closePath();
        ctx.fill();
        // パルスリング
        const pulse = 0.4 + Math.sin(t * 0.005) * 0.3;
        ctx.globalAlpha = markerAlpha * pulse;
        ctx.strokeStyle = '#00ffaa';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, mS * 1.6 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.restore();
    }

    // ── ウェイポイントライン + 目的地マーカー ──
    if (player.state === 'moving') {
        const { sx: tsx, sy: tsy } = worldToScreen(player.targetX, player.targetY);
        ctx.save();
        // 明るい破線
        ctx.setLineDash([10, 6]);
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.8;
        ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.moveTo(psx, psy); ctx.lineTo(tsx, tsy); ctx.stroke();
        ctx.setLineDash([]); ctx.shadowBlur = 0;

        // 目的地マーカー (回転クロスヘア + リング)
        ctx.translate(tsx, tsy);
        const rot = t * 0.0008;
        const r = 16;
        // 外リング
        ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 2; ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 3;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
        // 内側ダイヤ
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.shadowBlur = 2;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.5); ctx.lineTo(r * 0.5, 0); ctx.lineTo(0, r * 0.5); ctx.lineTo(-r * 0.5, 0);
        ctx.closePath(); ctx.stroke();
        // 回転腕
        ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 1.5; ctx.shadowBlur = 3;
        for (let arm = 0; arm < 4; arm++) {
            const a = arm * Math.PI / 2 + rot;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
            ctx.lineTo(Math.cos(a) * (r + 8), Math.sin(a) * (r + 8));
            ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.restore();
    }

    // ── 可視敵コンタクト (固定サイズダイヤ) ──
    enemies.forEach(e => {
        if (!e.visible || e.hp <= 0) return;
        const dispX = e.contactLife > 0 ? e.displayX : e.x;
        const dispY = e.contactLife > 0 ? e.displayY : e.y;
        const { sx: esx, sy: esy } = worldToScreen(dispX, dispY);
        // 画面外はスキップ
        if (esx < -30 || esx > cssW + 30 || esy < -30 || esy > cssH + 30) return;
        const er = 9;
        const acc = e.contactAccuracy;
        const col = acc > 0.7 ? '#ff4d4d' : (acc > 0.4 ? '#ff8800' : '#aaaaaa');
        ctx.save();
        ctx.translate(esx, esy);
        // ダイヤマーカー
        ctx.shadowColor = col; ctx.shadowBlur = 3;
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.8 + Math.sin(t * 0.008) * 0.2;
        ctx.beginPath();
        ctx.moveTo(0, -er); ctx.lineTo(er, 0); ctx.lineTo(0, er); ctx.lineTo(-er, 0);
        ctx.closePath(); ctx.fill();
        // 不確かさリング
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = col; ctx.lineWidth = 1;
        const unc = er + (1 - acc) * 14;
        ctx.beginPath(); ctx.arc(0, 0, unc, 0, Math.PI * 2);
        ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
        ctx.restore();
    });

    // ── MGS4スレットリング改善版 (スクリーン空間) ──
    if (PERF_DISABLE_THREAT_RING) return; // デバッグ用: スレットリングをオフ
    // 鮮やかな色に変更: heat→#ff6600, optic→#ffee00, em→#cc44ff, higgs→#00ffff
    const sensorColors2 = {
        heat:  { rgb: '255,102,0',   hex: '#ff6600' },
        optic: { rgb: '255,238,0',   hex: '#ffee00' },
        em:    { rgb: '204,68,255',  hex: '#cc44ff' },
        higgs: { rgb: '0,255,255',   hex: '#00ffff' }
    };
    // enemy毎のhiggsPath・dist・角度を事前計算 (4センサーループで再利用)
    const _hudRange = Math.max(effectiveRadarRange * 10, 8000);
    const _hudECache = enemies.filter(e => e.hp > 0).map(e => ({
        e,
        dist:    Math.hypot(e.x - player.x, e.y - player.y),
        hPath:   getHiggsIntensity((e.x + player.x)/2, (e.y + player.y)/2),
        angle:   Math.atan2(e.y - player.y, e.x - player.x)
    }));
    ['heat','optic','em','higgs'].forEach((sName, si) => {
        const sc2 = sensorConfig[sName];
        let totalSig = 0;
        const enemyAngles = [];
        for (const c of _hudECache) {
            const distAtten = Math.max(0, 1 - c.dist / _hudRange);
            const sig = sc2.sig(c.e) * distAtten * (1 - c.hPath * sc2.higgsMod);
            totalSig += sig;
            if (sig > 0.05 && c.e.detectionState && c.e.detectionState !== 'unaware') {
                enemyAngles.push(c.angle);
            }
        }
        totalSig = Math.min(1.0, totalSig);
        if (totalSig < 0.02) return;
        const baseR = 55 + si * 18; // screen pixels (大きく)
        const colInfo = sensorColors2[sName];
        const pulse2 = 0.55 + Math.sin(t * 0.003 + si * 1.5) * 0.45;
        const baseAlpha = Math.min(1.0, totalSig * pulse2 * 1.4); // 明るく

        ctx.save();
        ctx.translate(psx, psy);

        // 背景フルリング (薄く常時表示) — toFixed削除: globalAlpha使用でstring生成ゼロ
        ctx.globalAlpha = baseAlpha * 0.25;
        ctx.beginPath();
        ctx.arc(0, 0, baseR, 0, Math.PI * 2);
        ctx.strokeStyle = colInfo.hex;
        ctx.lineWidth = 2;
        if (!PERF_DISABLE_SHADOW_BLUR) { ctx.shadowColor = colInfo.hex; ctx.shadowBlur = 2 * totalSig; }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // リングを小弧に分割して描画 (敵方角付近を膨らませる) — 24セグメント
        const segments = 24;
        const segAngle = (Math.PI * 2) / segments;
        const alphaFar  = baseAlpha * 0.5;
        const alphaNear = Math.min(1, baseAlpha * 1.8);
        for (let seg = 0; seg < segments; seg++) {
            const segA = seg * segAngle;
            let nearEnemy = false;
            for (const ea of enemyAngles) {
                let diff = segA - ea;
                if (diff < -Math.PI) diff += Math.PI * 2;
                else if (diff > Math.PI) diff -= Math.PI * 2;
                if (diff > -0.55 && diff < 0.55) { nearEnemy = true; break; }
            }
            ctx.globalAlpha = nearEnemy ? alphaNear : alphaFar;
            ctx.beginPath();
            ctx.arc(0, 0, nearEnemy ? baseR + 20 : baseR, segA - segAngle * 0.5, segA + segAngle * 0.5);
            ctx.lineWidth = nearEnemy ? (5 + totalSig * 4) : (2 + totalSig * 1.5);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // 外側の薄いリング (2本目)
        ctx.globalAlpha = baseAlpha * 0.2;
        ctx.beginPath();
        ctx.arc(0, 0, baseR + 6, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.restore();
    });
}

// ── 潜航型デコイ: 更新・描画 ──
function updateDecoys() {
    for (let i = decoys.length - 1; i >= 0; i--) {
        const d = decoys[i];
        d.x += d.vx; d.y += d.vy;
        d.vx *= 0.985; d.vy *= 0.985; // 慣性で減速
        d.life--;
        // デコイは強EM源 → ヒッグスウェイクは出さないがEM波紋演出
        if (d.life % 24 === 0) effects.push({ x: d.x, y: d.y, r: 0, maxR: 220, a: 0.4, c: '#cc99ff', type: 'circle' });
        if (d.life <= 0) decoys.splice(i, 1);
    }
}
function drawDecoys(ctx) {
    const _dsp = SPRITES['fx_decoy'];
    for (const d of decoys) {
        const a = Math.min(1, d.life / 60);
        ctx.save();
        ctx.globalAlpha = a * 0.9;
        ctx.translate(d.x, d.y);
        if (spriteReady(_dsp)) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(_dsp, -20, -20, 40, 40);
            ctx.globalCompositeOperation = 'source-over';
        } else {
            // フォールバック: 菱形コア
            ctx.fillStyle = '#cc99ff';
            ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(6, 0); ctx.lineTo(0, 7); ctx.lineTo(-6, 0); ctx.closePath(); ctx.fill();
        }
        // EMパルスリング (スプライト有無に関わらず表示)
        const pr = 10 + (Math.sin(Date.now() * 0.01 + d.x) * 0.5 + 0.5) * 8;
        ctx.globalAlpha = a * 0.5;
        ctx.strokeStyle = '#aa66ff'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ffffff'; ctx.font = '8px Orbitron'; ctx.textAlign = 'center';
        ctx.fillText('DECOY', 0, -14);
        ctx.restore();
    }
    ctx.globalAlpha = 1;
}

// ── 空母型ドローン (§3-6) ──
class Drone {
    constructor(type, x, y) {
        this.type = type;
        this.x = x; this.y = y;
        this.angle = Math.random() * Math.PI * 2;
        const isBuilding = type === 'barrier' || type === 'buoy' || type === 'higgs';
        this.life = isBuilding ? DRONE_BUILDING_LIFE : DRONE_LIFE;
        this.hp = (type === 'build' || isBuilding) ? 400 : 150;
        this.fireCD = 0;
        this.speed = type === 'attack' ? 4.4 : (type === 'scout' ? 3.4 : 0);
        if (type === 'decoy') { this.vx = Math.cos(this.angle) * 5; this.vy = Math.sin(this.angle) * 5; }
        this._scanCD = 0; // buoy/higgs用スキャンタイマー
    }
    _nearestEnemy(range) {
        let best = null, bd = range;
        for (const e of enemies) { if (e.hp <= 0 || !e.visible) continue; const d = Math.hypot(e.x - this.x, e.y - this.y); if (d < bd) { bd = d; best = e; } }
        return best;
    }
    update() {
        this.life--;
        if (this.fireCD > 0) this.fireCD--;
        if (this.type === 'attack') {
            const tgt = this._nearestEnemy(DRONE_ATK_RANGE * 1.6);
            if (tgt) {
                const a = Math.atan2(tgt.y - this.y, tgt.x - this.x);
                this.angle += (((a - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.1;
                const d = Math.hypot(tgt.x - this.x, tgt.y - this.y);
                if (d > 650) { this.x += Math.cos(this.angle) * this.speed; this.y += Math.sin(this.angle) * this.speed; }
                if (d < DRONE_ATK_RANGE && this.fireCD <= 0 && tgt.hp > 0) { projectiles.push(new Projectile(this.x, this.y, tgt, true, 'kinetic', 0.5)); this.fireCD = 42; }
            } else if (player) { // 敵が居なければ自機周辺を護衛
                const a = Math.atan2(player.y - this.y, player.x - this.x), d = Math.hypot(player.x - this.x, player.y - this.y);
                if (d > 520) { this.angle = a; this.x += Math.cos(a) * this.speed; this.y += Math.sin(a) * this.speed; }
            }
        } else if (this.type === 'scout') {
            // 自機の前方を周回しつつ近傍の敵を探知(コンタクト付与)=センサーの目耳を前進配置
            if (player) {
                const d = Math.hypot(player.x - this.x, player.y - this.y);
                if (d > 2000) { const a = Math.atan2(player.y - this.y, player.x - this.x); this.x += Math.cos(a) * this.speed; this.y += Math.sin(a) * this.speed; }
                else { this.angle += 0.018; this.x += Math.cos(this.angle) * 1.8; this.y += Math.sin(this.angle) * 1.8; }
            }
            for (const e of enemies) { if (e.hp <= 0) continue; if (Math.hypot(e.x - this.x, e.y - this.y) < DRONE_SCOUT_RANGE) applyContact(e, 0.85, 30); }
        } else if (this.type === 'decoy') {
            this.x += this.vx; this.y += this.vy; this.vx *= 0.985; this.vy *= 0.985;
            if (this.life % 24 === 0) effects.push({ x: this.x, y: this.y, r: 0, maxR: 240, a: 0.4, c: '#cc99ff', type: 'circle' });
        } else if (this.type === 'build') {
            const tgt = this._nearestEnemy(DRONE_TURRET_RANGE);
            if (tgt) { this.angle = Math.atan2(tgt.y - this.y, tgt.x - this.x); if (this.fireCD <= 0 && tgt.hp > 0) { projectiles.push(new Projectile(this.x, this.y, tgt, true, 'kinetic', 0.6)); this.fireCD = 55; } }
        } else if (this.type === 'barrier') {
            // §3-7 ビームバリア: 周囲の敵に周期ダメージ + EMシグネチャ放射 (位置バレ)
            if (this.fireCD <= 0) {
                let hit = 0;
                for (const e of enemies) {
                    if (e.hp <= 0) continue;
                    if (Math.hypot(e.x - this.x, e.y - this.y) < DRONE_BARRIER_RADIUS) {
                        e.hp -= 10;
                        createHitEffect(e.x, e.y, '#4499ff');
                        hit++;
                    }
                }
                if (hit > 0) effects.push({ x: this.x, y: this.y, r: 0, maxR: DRONE_BARRIER_RADIUS * 0.06, a: 0.5, c: '#4499ff', type: 'circle' });
                this.fireCD = 45;
            }
        } else if (this.type === 'buoy') {
            // §3-7 センサーブイ: 広域スキャンで敵コンタクト付与 (EM放射 = 位置特定されやすい)
            if (this._scanCD <= 0) {
                let found = 0;
                for (const e of enemies) {
                    if (e.hp <= 0) continue;
                    if (Math.hypot(e.x - this.x, e.y - this.y) < DRONE_BUOY_RANGE) {
                        applyContact(e, 0.70, 90);
                        found++;
                    }
                }
                if (found > 0) effects.push({ x: this.x, y: this.y, r: 0, maxR: DRONE_BUOY_RANGE * 0.06, a: 0.4, c: '#44ccff', type: 'circle' });
                this._scanCD = 150; // 2.5秒ごとにスキャン
            }
            if (this._scanCD > 0) this._scanCD--;
        } else if (this.type === 'higgs') {
            // §3-7 ヒッグス散布装置: 周囲にヒッグスウェイクを生成し局所濃度を高める
            if (this._scanCD <= 0) {
                for (let h = 0; h < 6; h++) {
                    const ha = Math.random() * Math.PI * 2;
                    const hr = Math.random() * DRONE_HIGGS_RADIUS;
                    higgsWakes.push({ x: this.x + Math.cos(ha) * hr, y: this.y + Math.sin(ha) * hr, intensity: 0.55 + Math.random() * 0.3, life: 1.0 });
                }
                this._scanCD = 20;
            }
            if (this._scanCD > 0) this._scanCD--;
        }
    }
    draw(ctx) {
        const a = Math.min(1, this.life / 90);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(this.x, this.y);
        // スプライトキー (各タイプに対応)
        const _droneSprite = {
            attack: SPRITES['drone_attack'], scout: SPRITES['drone_scout'],
            decoy:  SPRITES['drone_decoy'],  build: SPRITES['drone_turret'],
            buoy:   SPRITES['drone_buoy']
        }[this.type];

        if (this.type === 'attack' || this.type === 'scout') {
            const _sp = _droneSprite;
            if (spriteReady(_sp)) {
                ctx.rotate(this.angle);
                ctx.globalCompositeOperation = 'lighter';
                ctx.drawImage(_sp, -16, -16, 32, 32);
                ctx.globalCompositeOperation = 'source-over';
                ctx.rotate(-this.angle);
            } else {
                const col = this.type === 'attack' ? '#00ffaa' : '#66ccff';
                ctx.rotate(this.angle);
                ctx.fillStyle = col;
                ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -4); ctx.lineTo(-3, 0); ctx.lineTo(-5, 4); ctx.closePath(); ctx.fill();
                ctx.rotate(-this.angle);
            }
        } else if (this.type === 'decoy') {
            const _sp = _droneSprite;
            if (spriteReady(_sp)) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.drawImage(_sp, -16, -16, 32, 32);
                ctx.globalCompositeOperation = 'source-over';
            } else {
                ctx.fillStyle = '#cc99ff';
                ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(6, 0); ctx.lineTo(0, 7); ctx.lineTo(-6, 0); ctx.closePath(); ctx.fill();
            }
            const pr = 10 + (Math.sin(Date.now() * 0.01 + this.x) * 0.5 + 0.5) * 8;
            ctx.globalAlpha = a * 0.5; ctx.strokeStyle = '#aa66ff'; ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.stroke();
        } else if (this.type === 'build') {
            const _sp = _droneSprite;
            if (spriteReady(_sp)) {
                ctx.rotate(this.angle);
                ctx.globalCompositeOperation = 'lighter';
                ctx.drawImage(_sp, -16, -16, 32, 32);
                ctx.globalCompositeOperation = 'source-over';
                ctx.rotate(-this.angle);
            } else {
                ctx.fillStyle = '#ffaa33';
                ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
                ctx.rotate(this.angle); ctx.fillStyle = '#ffcc66'; ctx.fillRect(0, -2, 12, 4);
                ctx.rotate(-this.angle);
            }
            ctx.globalAlpha = a * 0.3; ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(0, 0, DRONE_TURRET_RANGE * 0.04 + 9, 0, Math.PI * 2); ctx.stroke();
        } else if (this.type === 'barrier') {
            // §3-7 ビームバリア: 六角形コア + 周期で光るバリアリング (スプライト未生成→キャンバス)
            ctx.strokeStyle = '#4499ff'; ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < 6; i++) { const ba = (i / 6) * Math.PI * 2; (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, Math.cos(ba) * 8, Math.sin(ba) * 8); }
            ctx.closePath(); ctx.stroke();
            ctx.globalAlpha = a * (0.15 + 0.1 * Math.sin(Date.now() * 0.006));
            ctx.strokeStyle = '#6699ff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(0, 0, DRONE_BARRIER_RADIUS * 0.04 + 8, 0, Math.PI * 2); ctx.stroke();
        } else if (this.type === 'buoy') {
            const _sp = _droneSprite;
            if (spriteReady(_sp)) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.drawImage(_sp, -16, -16, 32, 32);
                ctx.globalCompositeOperation = 'source-over';
            } else {
                ctx.fillStyle = '#44ccff';
                ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
            }
            const phase = (Date.now() % 2500) / 2500;
            [0, 0.4, 0.7].forEach(off => {
                const p2 = (phase + off) % 1;
                ctx.globalAlpha = a * (1 - p2) * 0.45;
                ctx.strokeStyle = '#44ccff'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(0, 0, p2 * DRONE_BUOY_RANGE * 0.05 + 6, 0, Math.PI * 2); ctx.stroke();
            });
        } else if (this.type === 'higgs') {
            // §3-7 ヒッグス散布装置: 白青のパルスコア (スプライト未生成→キャンバス)
            const hp2 = 0.5 + 0.5 * Math.sin(Date.now() * 0.008);
            ctx.fillStyle = '#cce8ff';
            ctx.globalAlpha = a * (0.5 + 0.4 * hp2);
            ctx.beginPath(); ctx.arc(0, 0, 6 + hp2 * 3, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = a * 0.25;
            ctx.strokeStyle = '#aaddff'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(0, 0, DRONE_HIGGS_RADIUS * 0.04 + 9, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = a; ctx.fillStyle = '#dffff5'; ctx.font = '7px Orbitron'; ctx.textAlign = 'center';
        const _tagMap = { attack: 'ATK', decoy: 'DCY', scout: 'SCT', build: 'TUR', barrier: 'BAR', buoy: 'BUY', higgs: 'HGS' };
        const tag = _tagMap[this.type] || this.type.slice(0, 3).toUpperCase();
        ctx.fillText(tag, 0, -12);
        ctx.restore();
        ctx.globalAlpha = 1;
    }
}

function deployDrone(type) {
    if (!player || player.hp <= 0) return;
    if (gameState.shipType !== 'carrier') { logMessage('DRONE: ドローンは空母型のみ展開可能', 'warning-msg'); return; }
    if (playerDrones.length >= CARGO_CAP.carrier) { logMessage(`DRONE: 同時展開上限 (${CARGO_CAP.carrier}機) に到達`, 'warning-msg'); return; }
    const ang = player.angle + (Math.random() - 0.5);
    playerDrones.push(new Drone(type, player.x + Math.cos(ang) * 45, player.y + Math.sin(ang) * 45));
    logMessage(`DRONE: ${DRONE_LABELS[type]} 展開 (${playerDrones.length}/${CARGO_CAP.carrier})`, 'system-msg');
    playSound('ui');
}
function updatePlayerDrones() {
    for (let i = playerDrones.length - 1; i >= 0; i--) {
        const d = playerDrones[i];
        d.update();
        if (d.life <= 0 || d.hp <= 0) playerDrones.splice(i, 1);
    }
}
function drawPlayerDrones(ctx) { for (const d of playerDrones) d.draw(ctx); }

// FPS計測用
let _fpsLastTime = 0, _fpsFrameCount = 0, _fpsDisplay = 0;

function gameLoop() {
    try {
        _frameCount++;
        // FPS計測
        if (PERF_SHOW_FPS) {
            const now = performance.now();
            _fpsFrameCount++;
            if (now - _fpsLastTime >= 1000) {
                _fpsDisplay = _fpsFrameCount;
                _fpsFrameCount = 0;
                _fpsLastTime = now;
            }
        }
        // ヒッグス自然成長 (Battle Royale的ゾーン圧縮 — 時間経過で濃度上昇)
        // 全ミスト密度を毎フレーム微増、最大0.95まで
        if (player && player.hp > 0 && Math.random() < 0.004) { // ~4フレームに1回更新
            bgMist.forEach(m => {
                m.density = Math.min(0.95, m.density + 0.0002);
            });
        }

        // ソナークールダウン更新 — 表示は秒単位で変化する時のみ更新 (毎フレームinnerHTML禁止)
        if (omniSonarCooldown > 0) {
            omniSonarCooldown--;
            if (omniSonarCooldown % 60 === 0 || omniSonarCooldown === 0) {
                const btnOmni = document.getElementById('btn-scan');
                if (btnOmni) {
                    btnOmni.innerHTML = omniSonarCooldown > 0
                        ? `<span class="aicon">◎</span><span class="alabel">${Math.ceil(omniSonarCooldown/60)}s</span>`
                        : `<span class="aicon">◎</span><span class="alabel">SONAR</span>`;
                    btnOmni.disabled = omniSonarCooldown > 0;
                }
            }
        }
        if (dirSonarCooldown > 0) {
            dirSonarCooldown--;
            if (dirSonarCooldown % 60 === 0 || dirSonarCooldown === 0) {
                const btnDir = document.getElementById('btn-dir-sonar');
                if (btnDir) {
                    btnDir.innerHTML = dirSonarCooldown > 0
                        ? `<span class="aicon">⟶</span><span class="alabel">${Math.ceil(dirSonarCooldown/60)}s</span>`
                        : `<span class="aicon">⟶</span><span class="alabel">DIR</span>`;
                    btnDir.disabled = dirSonarCooldown > 0;
                }
            }
        }
        if (passiveAlertTimer > 0) passiveAlertTimer--;

        // コンタクトライフ更新 (ソナー探知結果の消滅管理)
        enemies.forEach(e => {
            if (e.contactLife > 0) {
                e.contactLife--;
                e.visible = true;
                // ゆっくり表示位置を実位置に近づける
                if (e.displayX !== undefined) {
                    e.displayX += (e.x - e.displayX) * 0.005;
                    e.displayY += (e.y - e.displayY) * 0.005;
                }
            } else if (e.fireFlashTimer <= 0) {
                e.visible = false;
                e.contactAccuracy = 0;
            }
        });

        // パッシブアンテナ検知チェック (2フレームごとで十分、人間の反応時間>100ms)
        if (player && player.hp > 0 && _frameCount % 2 === 0) checkPassiveDetection();
        if (player && player.hp > 0) updateVisionLockOn();

        // Process Enemy deaths
        for (let i = enemies.length - 1; i >= 0; i--) {
            if (enemies[i].hp <= 0) {
                createExplosion(enemies[i].x, enemies[i].y, '#ff4d4d', enemies[i].type === 'carrier' ? 40 : (enemies[i].type === 'destroyer' ? 20 : 10));
                const reward = enemies[i].type === 'carrier' ? 300 : (enemies[i].type === 'destroyer' ? 100 : (enemies[i].type === 'fighter' ? 10 : 30));
                scrapDrops.push({ x: enemies[i].x, y: enemies[i].y, value: reward, life: 1.0 });
                enemiesKilled++;
                enemies.splice(i, 1);
            }
        }

        // Sector Clear detection
        if (!sectorCleared && player && player.hp > 0) {
            // 勝利条件チェック
            const allEnemiesDown = enemies.length === 0;
            const colonyNodes = structures.filter(s => s.type === 'colony');
            const allNodesHacked = colonyNodes.length > 0 && colonyNodes.every(s => s.hacked);
            const sdWin = gameState.mode === 'sd' && allNodesHacked;

            if (allEnemiesDown || sdWin) {
                sectorCleared = true;
                const bonus = 100 + gameState.sector * 75 + (sdWin && !allEnemiesDown ? 50 : 0);
                gameState.credits += bonus;
                updateTopUI();
                saveGame();
                showSectorClear(bonus);
                if (sdWin && !allEnemiesDown) {
                    logMessage(`MISSION: 全ノードハック完了。S&D目標達成。ボーナス: +${bonus} CR`, 'system-msg');
                } else {
                    logMessage(`MISSION: セクター${gameState.sector}の脅威排除完了。ボーナス: +${bonus} CR`, 'system-msg');
                }
            }

            // S&Dモード: ハック進捗をUIに反映
            if (gameState.mode === 'sd' && colonyNodes.length > 0) {
                const hackedCount = colonyNodes.filter(s => s.hacked).length;
                document.getElementById('sd-progress-bar') &&
                    (document.getElementById('sd-progress-fill').style.width = `${(hackedCount / colonyNodes.length) * 100}%`);
                document.getElementById('sd-progress-text') &&
                    (document.getElementById('sd-progress-text').textContent = `ノード: ${hackedCount}/${colonyNodes.length}`);
            }
        }

        // ── 偽装ビーコン更新 ──
        structures.forEach(s => {
            if (!s.decoyActive || s.decoyTimer <= 0) return;
            s.decoyTimer--;
            if (s.decoyTimer <= 0) {
                s.decoyActive = false;
                logMessage(`EW: 偽装ビーコン終了 (${s.type === 'colony' ? 'コロニー' : '難破船'})`, 'system-msg');
                return;
            }
            if (s.decoyType === 'derelict' && s.decoyWaypoint) {
                // 移動偽装: ウェイポイントへ向けて毎フレーム移動
                const dx = s.decoyWaypoint.x - s.decoyMoveX;
                const dy = s.decoyWaypoint.y - s.decoyMoveY;
                const dist = Math.hypot(dx, dy);
                if (dist > 5) {
                    const spd = 1.2; // 偽装目標の移動速度
                    s.decoyMoveX += (dx / dist) * spd;
                    s.decoyMoveY += (dy / dist) * spd;
                }
            }
        });

        // Projectiles
        for (let i = projectiles.length - 1; i >= 0; i--) {
            projectiles[i].update();
            if (!projectiles[i].active) projectiles.splice(i, 1);
        }

        // Updates
        if (player && player.hp > 0) {
            player.update();
        } else if (player && !player.isDead) {
            player.isDead = true;
            createExplosion(player.x, player.y, '#00ffaa', 50);
            logMessage(`CRITICAL: 船体崩壊。通信途絶...`, 'system-msg');
            setTimeout(() => showGameOver(), 2500);
        }
        enemies.forEach(e => e.update());
        updateDecoys();
        updatePlayerDrones();

        // Scrap Collection
        for (let i = scrapDrops.length - 1; i >= 0; i--) {
            let s = scrapDrops[i];
            // 時間経過でフェードアウト (約30秒 = 1800フレーム)
            s.life -= 0.00055;
            if (s.life <= 0) { scrapDrops.splice(i, 1); continue; }
            if (player && player.hp > 0) {
                const d = Math.hypot(player.x - s.x, player.y - s.y);
                if (d < 200) {
                    s.x += (player.x - s.x) * 0.05;
                    s.y += (player.y - s.y) * 0.05;
                }
                if (d < player.radius + 10) {
                    gameState.credits += s.value;
                    updateTopUI();
                    playSound('ui');
                    logMessage(`TAC: スクラップ回収 +${s.value} SCR`, 'system-msg');
                    createClickEffect(s.x, s.y, '#00ffaa');
                    scrapDrops.splice(i, 1);
                }
            }
        }

        // ヒッグスウェイク更新 (時間経過でフェードアウト)
        for (let i = higgsWakes.length - 1; i >= 0; i--) {
            higgsWakes[i].life -= 0.005;
            if (higgsWakes[i].life <= 0) higgsWakes.splice(i, 1);
        }
        // §3-12 センサーtrail decay (各センサー軸の足跡フェード)
        for (let i = heatTrails.length  - 1; i >= 0; i--) { heatTrails[i].life  -= 0.004; if (heatTrails[i].life  <= 0) heatTrails.splice(i,  1); }
        for (let i = opticTrails.length - 1; i >= 0; i--) { opticTrails[i].life -= 0.006; if (opticTrails[i].life <= 0) opticTrails.splice(i, 1); }
        for (let i = emTrails.length    - 1; i >= 0; i--) { emTrails[i].life    -= 0.005; if (emTrails[i].life    <= 0) emTrails.splice(i,    1); }

        // プレイヤーの移動でウェイク・trail を生成
        if (player && player.hp > 0 && player.state === 'moving') {
            const playerHiggs = getHiggsIntensity(player.x, player.y);
            if (playerHiggs > 0.2 && Math.random() < 0.3) {
                higgsWakes.push({ x: player.x, y: player.y, intensity: playerHiggs * 0.6, life: 0.8 });
            }
            // §3-12 HEAT trail: エンジン熱排気 (移動時)
            if (!repairActive && player.heatSig > 0.07 && Math.random() < 0.22) {
                if (heatTrails.length < 600) heatTrails.push({ x: player.x, y: player.y, intensity: player.heatSig, life: 1.0, isPlayerTrail: true });
            }
        }
        // §3-12 EM trail: AI処理放射 (移動に関係なく高EM時)
        if (player && player.hp > 0 && !repairActive && player.emSig > 0.2 && Math.random() < 0.14) {
            if (emTrails.length < 600) emTrails.push({ x: player.x, y: player.y, intensity: player.emSig * 0.9, life: 1.0 });
        }

        // リソースノード収集チェック (プレイヤー接近で自動収集)
        for (let i = resourceNodes.length - 1; i >= 0; i--) {
            const n = resourceNodes[i];
            // EMスパイクタイマー: 収集後も非アクティブ状態でカウントダウン継続
            if (n.emFlashTimer > 0) n.emFlashTimer--;
            if (!n.active) continue;
            if (player && player.hp > 0) {
                const d = Math.hypot(player.x - n.x, player.y - n.y);
                if (d < player.radius + 300) {
                    // 収集！
                    n.active = false;
                    n.emFlashTimer = 180; // 3秒間EMスパイク
                    // EMスパイク: EM状態が高まった状態を記録 (敵に見える)
                    gameState.credits += 150; // ヒッグスクリスタル採取報酬
                    updateTopUI();
                    playSound('ui');
                    effects.push({ x: n.x, y: n.y, r: 0, maxR: 800, a: 1, c: '#50c8ff', type: 'circle' });
                    logMessage(`HIGGS: ヒッグス凝縮クリスタル採取 (+150 SCR)。EMスパイク発生中 — 敵に検知される可能性あり。`, 'system-msg');
                    createClickEffect(n.x, n.y, '#50c8ff');
                }
            }
        }

        // 構造物・ステーションの発見チェック
        if (player && player.hp > 0) {
            [...structures, ...stations].forEach(s => {
                if (!s.discovered && Math.hypot(player.x - s.x, player.y - s.y) < effectiveRadarRange * 2) {
                    s.discovered = true;
                }
            });
        }

        // Docking Detection
        if (player && player.hp > 0 && !dockingOpen) {
            let nearStation = stations.find(s => Math.hypot(player.x - s.x, player.y - s.y) < s.radius + 50);
            const prompt = document.getElementById('dock-prompt');
            if (nearStation) {
                prompt.classList.add('active');
            } else {
                prompt.classList.remove('active');
            }
        }

        // Structure proximity hint (EW/Hack notification)
        if (player && player.hp > 0) {
            const _hackRange = 800;
            const _nearStruct = structures.find(s => Math.hypot(player.x - s.x, player.y - s.y) < _hackRange);
            if (_nearStruct) {
                if (!window._hackNotifiedSet) window._hackNotifiedSet = new Set();
                if (!window._hackNotifiedSet.has(_nearStruct.id || _nearStruct.name)) {
                    window._hackNotifiedSet.add(_nearStruct.id || _nearStruct.name);
                    logMessage(`[EW] ${_nearStruct.name || '構造物'} を検出 — EW/HACKボタンでハッキング可能`);
                }
            }
        }

        // カメラ追従
        if (cameraFollowPlayer && player) centerCameraOnPlayer();

        // Rendering — ベース変換を _dpr 倍に固定 (高精細でくっきり)。以降の描画は全てCSS px基準。
        ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        ctx.save();
        ctx.scale(camera.zoom, camera.zoom);

        // Screen Shake calculation
        let sx = 0, sy = 0;
        if (camera.shake > 0) {
            sx = (Math.random() - 0.5) * camera.shake;
            sy = (Math.random() - 0.5) * camera.shake;
            camera.shake *= 0.9;
            if (camera.shake < 0.5) camera.shake = 0;
        }

        ctx.translate(-camera.x + sx, -camera.y + sy);

        drawBackground(ctx);
        stations.forEach(s => s.draw(ctx));
        structures.forEach(s => s.draw(ctx));
        drawTargetLine(ctx);

        // ズームアウト時 or デバッグフラグでshadowBlurをスキップ (描画コスト削減)
        const _blurEnabled = !PERF_DISABLE_SHADOW_BLUR && camera.zoom >= 0.12;
        // ビューポート境界 (ワールド座標)
        const _vpX = camera.x, _vpY = camera.y;
        const _vpW = cssW / camera.zoom, _vpH = cssH / camera.zoom;

        // リソースノード描画 (全センサーで常時表示; HIGGSで最大輝度)
        if (player && player.hp > 0) {
            const higgsNodeRange = effectiveRadarRange * 6;
            const isHiggsSnsr = currentSensor === 'higgs';
            resourceNodes.forEach(n => {
                if (!n.active) return;
                // ビューポートカリング
                if (n.x < _vpX - 60 || n.x > _vpX + _vpW + 60 ||
                    n.y < _vpY - 60 || n.y > _vpY + _vpH + 60) return;
                const distToNode = Math.hypot(n.x - player.x, n.y - player.y);
                const t = Date.now();
                const pulse = 0.5 + Math.sin(t * 0.003 + n.x * 0.001) * 0.5;
                const spin = (t * 0.0008 + n.x * 0.0003) % (Math.PI * 2);
                const inRange = distToNode < higgsNodeRange;
                const brightness = isHiggsSnsr
                    ? (0.5 + pulse * 0.5)
                    : (inRange ? 0.15 + pulse * 0.12 : 0.04 + pulse * 0.04);
                ctx.save();
                ctx.translate(n.x, n.y);
                ctx.rotate(spin);
                const _nsp = SPRITES.node_higgs;
                if (spriteReady(_nsp)) {
                    // スプライト (被探知ステルス: brightnessでアルファ変調)
                    ctx.globalAlpha = brightness;
                    drawSpriteCentered(ctx, _nsp, 72);
                    ctx.globalAlpha = 1;
                } else {
                // 外側グロー
                ctx.globalAlpha = brightness * 0.5;
                ctx.fillStyle = '#50c8ff';
                if (_blurEnabled) { ctx.shadowColor = '#50c8ff'; ctx.shadowBlur = isHiggsSnsr ? 20 : 8; }
                ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
                // 外リング
                ctx.globalAlpha = brightness * 0.35;
                ctx.strokeStyle = '#80e0ff'; ctx.lineWidth = 1.5 / camera.zoom;
                ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.stroke();
                // メインクリスタル六角形
                ctx.globalAlpha = brightness;
                ctx.fillStyle = '#50c8ff';
                if (_blurEnabled) { ctx.shadowColor = '#50c8ff'; ctx.shadowBlur = isHiggsSnsr ? 12 : 5; }
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2;
                    const px = Math.cos(a) * 16, py = Math.sin(a) * 16;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath(); ctx.fill();
                // インナーコア (白)
                ctx.globalAlpha = brightness * 0.9;
                ctx.fillStyle = '#ffffff';
                if (_blurEnabled) ctx.shadowBlur = 4;
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
                    const px = Math.cos(a) * 7, py = Math.sin(a) * 7;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath(); ctx.fill();
                ctx.shadowBlur = 0;
                }
                ctx.restore();
                // Crystal name label (adaptive scale)
                if (inRange || isHiggsSnsr) {
                    const _cIconS = Math.max(4, Math.min(28, camera.zoom * 28)) / (camera.zoom * 28);
                    ctx.save();
                    ctx.translate(n.x, n.y);
                    ctx.scale(_cIconS, _cIconS);
                    ctx.globalAlpha = brightness;
                    ctx.fillStyle = '#80e8ff';
                    ctx.font = 'bold 10px Orbitron, monospace';
                    ctx.textAlign = 'center';
                    if (_blurEnabled) { ctx.shadowColor = '#50c8ff'; ctx.shadowBlur = 4; }
                    ctx.fillText('HIGGS CRYSTAL', 0, -36);
                    ctx.shadowBlur = 0;
                    ctx.restore();
                }
                ctx.globalAlpha = 1;
            });
        }

        // Render scrap (rotating data fragment squares, fades over time)
        scrapDrops.forEach(s => {
            const angle = (Date.now() * 0.001 + s.x * 0.01) % (Math.PI * 2);
            ctx.save();
            ctx.globalAlpha = Math.min(1, s.life * 2); // フェードアウト (lifeが0.5を下回ると透過開始)
            ctx.translate(s.x, s.y);
            ctx.rotate(angle);
            ctx.fillStyle = '#00ffaa'; ctx.shadowColor = '#00ffaa'; ctx.shadowBlur = 3;
            ctx.fillRect(-3, -3, 6, 6);
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#fff';
            ctx.fillRect(-1.5, -1.5, 3, 3);
            ctx.restore();
            ctx.globalAlpha = 1;
        });

        projectiles.forEach(p => p.draw(ctx));
        drawDecoys(ctx);
        drawPlayerDrones(ctx);
        updateDrawEffects(ctx);
        updateDrawDebrisParticles(ctx);

        enemies.forEach(e => e.draw(ctx));
        if (player && player.hp > 0) player.draw(ctx);

        // ── 有視界フォグ (エンティティの上・ゲームリングの下) ──
        // ヒッグス雲/フォグはここで描画し、以降のスレットリング/レーダー/武器射程リングを
        // すべて最前面に重ねる。これらがヒッグスに隠れると索敵・射撃ができずゲームにならないため。
        // マップモード中はフォグを抑制して全体を戦術マップとして表示(索敵済みの情報のみ可視)。
        if (player && player.hp > 0 && !mapMode) drawFogOfWar(ctx);

        // ── センサー痕跡(ソナーの影/コンタクト) — ヒッグスより手前に表示 ──
        for (const e of enemies) e.drawSensorTrace(ctx);

        // ── シグネチャ・スレットリング (最前面・フォグの上) ──
        if (player && player.hp > 0) drawPassiveAntenna(ctx);

        // ── レーダー範囲リング + ラベル ──
        if (player && player.hp > 0) {
            const higgsHere = getHiggsIntensity(player.x, player.y);
            const visionRingR = effectiveRadarRange;
            const t2 = Date.now();
            const vpulse = 0.5 + Math.sin(t2 * 0.0015) * 0.5;
            const vRingColor = higgsHere > 0.6 ? '#ff4444' : (higgsHere > 0.3 ? '#ffaa44' : '#00ffaa');
            ctx.save();
            ctx.setLineDash([30 / camera.zoom, 20 / camera.zoom]);
            ctx.beginPath();
            ctx.arc(player.x, player.y, visionRingR, 0, Math.PI * 2);
            ctx.strokeStyle = vRingColor;
            ctx.lineWidth = 1.5 / camera.zoom;
            ctx.globalAlpha = 0.3 + vpulse * 0.2;
            ctx.stroke();
            ctx.setLineDash([]);
            // レーダー範囲ラベル (右側)
            ctx.font = `bold ${Math.round(8 / camera.zoom)}px Orbitron, monospace`;
            ctx.fillStyle = vRingColor;
            ctx.globalAlpha = 0.35 + vpulse * 0.1;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('RADAR', player.x + visionRingR + 6 / camera.zoom, player.y);
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        // ── 武器射程サークルインジケータ + ラベル (ワールド空間) ──
        if (player && player.hp > 0) {
            const wTypeCircle = document.getElementById('weapon-select') ? document.getElementById('weapon-select').value : 'kinetic';
            const wRangeCircle = wTypeCircle === 'missile' ? 2200 : (wTypeCircle === 'beam' ? 8000 : 800);
            const wRangeColor = wTypeCircle === 'missile' ? '#ffaa00' : (wTypeCircle === 'beam' ? '#00aaff' : '#88ff44');
            const wLabel = wTypeCircle === 'missile' ? 'MISSILE' : (wTypeCircle === 'beam' ? 'BEAM' : 'KINETIC');
            ctx.save();
            ctx.beginPath();
            ctx.arc(player.x, player.y, wRangeCircle, 0, Math.PI * 2);
            ctx.setLineDash([20 / camera.zoom, 20 / camera.zoom]);
            ctx.strokeStyle = wRangeColor;
            ctx.lineWidth = 2 / camera.zoom;
            ctx.globalAlpha = 0.55;
            ctx.shadowColor = wRangeColor;
            ctx.shadowBlur = 2;
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.setLineDash([]);
            // 武器射程ラベル (上部)
            ctx.font = `bold ${Math.round(8 / camera.zoom)}px Orbitron, monospace`;
            ctx.fillStyle = wRangeColor;
            ctx.globalAlpha = 0.65;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`WEAPON RANGE — ${wLabel}`, player.x, player.y - wRangeCircle - 4 / camera.zoom);
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        // ── パッシブ方位ウェッジ (ワールド空間・三角測量用) ──
        if (player && player.hp > 0) drawPassiveBearings(ctx);

        ctx.restore();

        drawHUDOverlay(ctx);
        if (_frameCount % 2 === 0) updateSigCanvas();
        if (_frameCount % 3 === 0) drawMinimap();
        if (_frameCount % 10 === 0) updateEnvInfo();

        // FPS表示 (デバッグ用) — 左下コーナー・コンソール上方
        if (PERF_SHOW_FPS) {
            ctx.save();
            const _fpsColor = _fpsDisplay >= 50 ? '#00ff88' : (_fpsDisplay >= 30 ? '#ffaa00' : '#ff4444');
            const _fpsX = 8, _fpsY = 150; // ミニマップ(40-140px)直下・コンソールに隠れない位置
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(_fpsX - 2, _fpsY - 2, 58, 18);
            ctx.font = 'bold 11px monospace';
            ctx.fillStyle = _fpsColor;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`FPS: ${_fpsDisplay}`, _fpsX, _fpsY);
            ctx.restore();
        }

        requestAnimationFrame(gameLoop);
    } catch (err) {
        console.error("Game loop error:", err);
        // エラー発生後もゲームループを継続する (一時的なエラーでフリーズしない)
        requestAnimationFrame(gameLoop);
    }
}
// Docking Logic
const dockPrompt = document.getElementById('dock-prompt');
const dockingMenu = document.getElementById('docking-menu');
const btnDock = document.getElementById('btn-dock');
const btnLeave = document.getElementById('btn-leave-dock');

btnDock.addEventListener('click', () => {
    if (!player || player.hp <= 0) return;
    dockingOpen = true;
    dockPrompt.classList.remove('active');
    dockingMenu.classList.remove('hidden');
    player.setTarget(player.x, player.y);
    playSound('ui');
    updateDockingUI();
});

btnLeave.addEventListener('click', () => {
    dockingOpen = false;
    dockingMenu.classList.add('hidden');
    playSound('ui');
});

function getUpgradeCost(lv) { return lv * 300; } // Lv1→2: 300 SCR, Lv2→3: 600 SCR

function updateDockingUI() {
    document.getElementById('dock-credits').textContent = gameState.credits;

    const missingHp = player.maxHp - player.hp;
    const repairCost = Math.ceil(missingHp / 2);
    const btnRepair = document.getElementById('btn-repair-all');
    btnRepair.textContent = `全艦修理 (${repairCost} SCR)`;
    btnRepair.disabled = gameState.credits < repairCost || repairCost === 0;

    ['engine', 'weapons', 'armor', 'sensor'].forEach(type => {
        const lv   = gameState.upgrades[type];
        const cost = getUpgradeCost(lv);
        const maxed = lv >= 3;
        const lvEl   = document.getElementById(`level-${type}`);
        const costEl = document.getElementById(`cost-${type}`);
        const btnEl  = document.getElementById(`btn-upgrade-${type}`);
        if (lvEl)   lvEl.textContent  = lv;
        if (costEl) costEl.textContent = maxed ? 'MAX' : cost;
        if (btnEl)  btnEl.disabled = maxed || gameState.credits < cost;
    });
}

document.getElementById('btn-repair-all').addEventListener('click', () => {
    const missingHp = player.maxHp - player.hp;
    const repairCost = Math.ceil(missingHp / 2);
    if (gameState.credits >= repairCost) {
        gameState.credits -= repairCost;
        player.hp = player.maxHp;
        playSound('ui');
        updateTopUI();
        updateDockingUI();
        logMessage(`MAINT: 全システム修復完了 (-${repairCost} SCR)`, 'system-msg');
    }
});

function buyUpgrade(type) {
    const lv   = gameState.upgrades[type];
    if (lv >= 3) return;
    const cost = getUpgradeCost(lv);
    if (gameState.credits >= cost) {
        gameState.credits -= cost;
        gameState.upgrades[type]++;
        playSound('ui');
        if (type === 'sensor') RADAR_RANGE = BASE_RADAR_RANGE * UPGRADE_MULT[gameState.upgrades.sensor];
        updateTopUI();
        updateDockingUI();
        saveGame();
        // §3-1 各アップグレードの効果説明
        const newLv = gameState.upgrades[type];
        const upgradeDescs = {
            engine:  ['', 'ヒッグス/デブリ減速-20% / 熱署名-10%', 'ヒッグス/デブリ減速-35% / 熱署名-20%', 'ヒッグス/デブリ減速-50% / 熱署名-30%'],
            weapons: ['', '射程×1.15 / リロード×0.85', '射程×1.30 / リロード×0.70', '射程×1.50 / リロード×0.55'],
            armor:   ['', 'kinetic耐性25%付与', 'missile耐性25%追加', 'beam耐性25%追加 (全3種耐性)'],
            sensor:  ['', 'ソナー範囲×1.0', 'ソナー範囲×1.5', 'ソナー範囲×2.0'],
        };
        const names = { engine:'エンジン', weapons:'武装', armor:'装甲', sensor:'センサー' };
        logMessage(`UPGRADE: ${names[type]} Lv${newLv} 強化完了 ─ ${upgradeDescs[type][newLv]}`, 'system-msg');
    }
}

['engine', 'weapons', 'armor', 'sensor'].forEach(type => {
    const btn = document.getElementById(`btn-upgrade-${type}`);
    if (btn) btn.addEventListener('click', () => buyUpgrade(type));
});

// ── ゲームスピードトグル ──────────────────────────────────────
document.getElementById('btn-game-speed')?.addEventListener('click', () => {
    if (gameSpeedFactor === 1.0) gameSpeedFactor = 0.5;
    else if (gameSpeedFactor === 0.5) gameSpeedFactor = 2.0;
    else gameSpeedFactor = 1.0;
    const labels = { 0.5: '0.5x 低速', 1.0: '1x 通常', 2.0: '2x 高速' };
    document.getElementById('btn-game-speed').textContent = `SPD:${labels[gameSpeedFactor]}`;
    logMessage(`SYSTEM: ゲームスピード ${labels[gameSpeedFactor]} に変更`, 'system-msg');
});
// ─────────────────────────────────────────────────────────────

// gameLoop is started by startGame() after ship selection

// Game Over / Restart
document.getElementById('btn-restart').addEventListener('click', () => {
    document.getElementById('game-over-overlay').classList.add('hidden');
    gameState.credits = Math.floor(gameState.credits * 0.5); // Keep half credits on death
    gameState.sector = Math.max(1, gameState.sector); // Keep sector progress
    generateSector();
    updateTopUI();
    logMessage('SYSTEM: 艦体緊急再起動完了。クレジット50%喪失。', 'warning-msg');
});
