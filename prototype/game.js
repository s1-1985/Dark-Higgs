// Init canvas

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
let minimapDpr = 1; // ミニマップのバッキングストア倍率 (高DPI対応・resizeCanvasで更新)
// 高精細(Retina)対応: 描画はCSSピクセル基準、バッキングストアを devicePixelRatio 倍に。
// レーダー/リング/文字のボケ防止。cssW/cssH=CSS px, _dpr=ピクセル比。
let cssW = window.innerWidth, cssH = window.innerHeight, _dpr = 1;
// 第6弾: UIインセット/コンソール折りたたみ状態 (宣言は最上部 — 初期化順序のTDZ回避)
let _uiInsetCache = { right: 0, bottom: 0, t: 0 };
let consoleMin = localStorage.getItem('darkEchoConsoleMin') !== '0'; // デフォルト=折りたたみ (視界優先)

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
// §4-4: 三角測量エンジン状態
let triangulationResult = null; // {x, y, precision, radius, frame}
let _prevTrigResult = null;      // Phase3: 前回の三角測量結果 (速度外挿用)
let triangulationVelocity = null; // Phase3: 推定速度ベクトル {vx, vy} (world units/frame)
let lockedSignalId = null;       // 解析モードでロックしたシグネチャのsourceId
let _contactLabels = {};         // sourceId → 連番ラベル番号
let _contactLabelNext = 1;
let _signalAnalysis = {}; // §4-4 H/I: { [sourceId]: { dirAnalysis, triParam, lockOriginX/Y, displayCenterX/Y, lastPosX/Y } }
window._lockSignal = function(sid) {
    lockedSignalId = sid;
    triangulationResult = null;
    if (sid) {
        if (!_signalAnalysis[sid]) {
            _signalAnalysis[sid] = { dirAnalysis: 0.1, triParam: 0, displayCenterX: null, displayCenterY: null, lockOriginX: 0, lockOriginY: 0, lastPosX: 0, lastPosY: 0 };
        }
        const _lsSa = _signalAnalysis[sid];
        _lsSa.lockOriginX = player ? player.x : 0;
        _lsSa.lockOriginY = player ? player.y : 0;
        _lsSa.lastPosX = player ? player.x : 0;
        _lsSa.lastPosY = player ? player.y : 0;
    }
}; // index.htmlから呼出し
window.fireTriangulate = function() {
    if (!lockedSignalId) {
        logMessage('ANALYSIS: 特定のシグネチャの解析を開始してください', 'system-msg');
        return;
    }
    computeTriangulation();
    logMessage(`ANALYSIS: SIG ${lockedSignalId} — 三角測量実行`, 'system-msg');
    if (typeof window.runSigAnalysis === 'function') window.runSigAnalysis();
};
let _lpmWorld = null;            // 長押しラジアルメニューのワールド座標
const PASSIVE_BEARING_LIFE = 480;  // 8秒フェード (@60fps)
const PASSIVE_BEARING_MAX  = 14;   // 同時表示上限 (第10弾: 24→14 でウェッジの過密・点滅を抑制)
const ID_THRESHOLD_STATIC  = 18;   // 静止発信源(ランドマーク/地形)の特定閾値 — 早い段階で判別できる (旧35)
const ID_THRESHOLD_MOBILE  = 55;   // 機動反応(艦船等)の分類通知閾値 — じっくり追跡して判別
let mouseWorldX = MAP_CX;
let mouseWorldY = MAP_CY;
let dirSonarVisual = null; // { angle, halfAngle, range, life }
let dirSonarPendingFire = false;
let enemiesKilled = 0;
let genGain = 1.0;

// センサーLv別性能定数
const OMNI_SONAR_RANGE  = [0, MAP_RADIUS/3, MAP_RADIUS*2/3, MAP_RADIUS]; // Lv1,2,3 @100%SEN (第9弾: 探知距離2倍)
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

function playSound(type, vol = 1) {
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
    } else if (type === 'alert') {
        // 露出度エスカレーション / 奇襲: 2音の警告スティンガー
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(660, now + 0.09);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.22);
        osc.start(now); osc.stop(now + 0.22);
    } else if (type === 'heartbeat') {
        // 被追跡中の低音パルス (潜水艦の心音)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(55, now);
        osc.frequency.exponentialRampToValueAtTime(38, now + 0.16);
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.18);
        osc.start(now); osc.stop(now + 0.18);
    } else if (type === 'enemyPing') {
        // 敵アクティブソナーの探信音 — 距離で音量が変わる (volで指定)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1250, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.5);
        gain.gain.setValueAtTime(0.10 * vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        osc.start(now); osc.stop(now + 0.55);
    } else if (type === 'ambientEcho') {
        // 遠くの空間の唸り — 情報価値ゼロの環境フレーバー (霧の閉塞感)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 1.3);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.022 * vol, now + 0.4);
        gain.gain.linearRampToValueAtTime(0.0, now + 1.4);
        osc.start(now); osc.stop(now + 1.4);
    }
}

// ═══════════════════════════════════════════════════════════════
// 環境音システム (第5弾): ヒッグスの霧の閉塞感を持続低音ドローンで表現。
// 露出度が上がると不協和な緊張音が浮かび上がり、サージ中はフィルタが開いて空気が変わる。
// 全て Web Audio ノード5個の常駐構成 (CPU負荷ほぼゼロ)。設定は localStorage に永続化。
// ═══════════════════════════════════════════════════════════════
let ambientOn = localStorage.getItem('darkEchoAmbient') !== '0';
let _amb = null;
function startAmbient() {
    if (!ambientOn || _amb || !audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const master = audioCtx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.055, now + 4); // ゆっくり立ち上がる
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 220;
    lp.connect(master); master.connect(audioCtx.destination);
    // 二重ドローン (わずかにデチューンして「うなり」を作る)
    const d1 = audioCtx.createOscillator(); d1.type = 'sine';     d1.frequency.value = 55;
    const d2 = audioCtx.createOscillator(); d2.type = 'triangle'; d2.frequency.value = 55.35;
    const g1 = audioCtx.createGain(); g1.gain.value = 0.55;
    const g2 = audioCtx.createGain(); g2.gain.value = 0.20;
    d1.connect(g1); g1.connect(lp);
    d2.connect(g2); g2.connect(lp);
    // 緊張音 (露出度2+で浮かび上がる短3度上)
    const tn = audioCtx.createOscillator(); tn.type = 'sine'; tn.frequency.value = 65.4;
    const tg = audioCtx.createGain(); tg.gain.value = 0.0;
    tn.connect(tg); tg.connect(lp);
    // ゆらぎLFO (呼吸)
    const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = audioCtx.createGain(); lg.gain.value = 0.016;
    lfo.connect(lg); lg.connect(master.gain);
    d1.start(); d2.start(); tn.start(); lfo.start();
    _amb = { master, tensionGain: tg, lp, nodes: [d1, d2, tn, lfo], echoTimer: 900 + Math.random() * 1500 };
}
function stopAmbient() {
    if (!_amb) return;
    const old = _amb; _amb = null;
    try { old.master.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.8); } catch (e) {}
    setTimeout(() => { try { old.nodes.forEach(n => n.stop()); old.master.disconnect(); } catch (e) {} }, 1200);
}
function toggleAmbient() {
    ambientOn = !ambientOn;
    localStorage.setItem('darkEchoAmbient', ambientOn ? '1' : '0');
    if (ambientOn) startAmbient(); else stopAmbient();
    const b = document.getElementById('btn-ambient');
    if (b) b.textContent = ambientOn ? '♪ SOUND ON' : '♪ SOUND OFF';
}
// 露出度/サージの遷移時に呼ぶ (毎フレームではない)
function updateAmbient() {
    if (!_amb) return;
    const now = audioCtx.currentTime;
    const t = playerExposureLevel >= 3 ? 0.34 : playerExposureLevel === 2 ? 0.16 : 0;
    _amb.tensionGain.gain.linearRampToValueAtTime(t, now + 1.5);
    _amb.lp.frequency.linearRampToValueAtTime(surgePhase === 'active' ? 520 : 220, now + 2.0);
}

// Game State Storage
let gameState = {
    shipType: 'assault',
    mode: 'br',
    enemyType: 'assault', // 敵艦種 (ロビーで選択: assault/stealth/carrier → 内部型にマップ)
    sector: 1,
    credits: 0,       // スクラップ (アップグレード素材 + 修理費)
    engineType: 'thermonuclear',
    upgrades: {
        engine:  1,   // エンジン  Lv1-3: 移動速度
        weapons: 1,   // 武装      Lv1-3: 火力
        armor:   1,   // 装甲      Lv1-3: HP
        sensor:  1    // センサー  Lv1-3: ソナー範囲・精度
    },
    // 第5弾: 戦歴 (出撃を跨いで積み重なる記録 — localStorageに永続化)
    career: { sorties: 0, kills: 0, ambushes: 0, bestSector: 1 },
    // 第5弾: 前任艦の残骸 — 撃沈時に記録され、次の出撃でサルベージ可能
    wreckSalvage: 0
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
            // 戦歴: 旧セーブに無ければデフォルト補完
            gameState.career = Object.assign({ sorties: 0, kills: 0, ambushes: 0, bestSector: 1 }, loaded.career || {});
            if (typeof gameState.wreckSalvage !== 'number') gameState.wreckSalvage = 0;
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

// ═══ 戦歴パネル (第5弾): ロビーに累計記録を表示 ═══
function updateCareerPanel() {
    const c = gameState.career || { sorties: 0, kills: 0, ambushes: 0, bestSector: 1 };
    const _set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    _set('cr-sorties', c.sorties);
    _set('cr-kills', c.kills);
    _set('cr-ambushes', c.ambushes);
    _set('cr-best', c.bestSector);
}
updateCareerPanel();
// 環境音: 保存設定をトグルボタンへ反映 + ロビー初タッチで開始 (自動再生制限対応)
(() => {
    const _ab = document.getElementById('btn-ambient');
    if (_ab) _ab.textContent = ambientOn ? '♪ SOUND ON' : '♪ SOUND OFF';
    const _lb = document.getElementById('ship-select-lobby');
    if (_lb) _lb.addEventListener('pointerdown', () => startAmbient(), { once: true });
    _applyConsoleMin(); // コンソール折りたたみ状態の復元 (第6弾)
})();

function updateTopUI() {
    const modeLabel = gameState.mode === 'sd' ? 'S&D' : 'BR';
    document.getElementById('sector-display').textContent = `SECTOR ${gameState.sector} · ${modeLabel}`;
    const _cd = document.getElementById('currency-display');
    if (_cd) _cd.textContent = `${gameState.credits}`;
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
const ENEMY_TURN_RATES  = { corvette: 0.018, fighter: 0.025, destroyer: 0.009, carrier: 0.006 }; // 敵艦種別回頭レート
// ── 敵センサー「間合い」チューニング (2026-06-23 レビュー: 探知が至近距離すぎて狩りが成立しない問題の解) ──
// 探知を2層に分離: ①近接ハード探知=無音でも至近では見つかる ②シグネチャ探知=派手な機体ほど遠方から捕捉。
// プレイヤーのパッシブ探知(range≧8000〜)に見合う遠距離で敵も能動的に狩れるようにする。静音プレイのステルスは維持。
const ENEMY_DETECT_BASE = 1100;  // 近接ハード探知レンジの基準(旧800)。playerEmBoost等で増減
const ENEMY_SIG_REACH   = 8.0;   // シグネチャ探知の到達倍率(旧2.5固定)。大きいほど遠方からシグネチャを拾う
const ENEMY_STALK_SPEED = 0.55;  // 残り香(contactFreshness)を追って徘徊する際のlurking速度(通常lurking=0.08)
// ── 艦種別 戦闘プロファイル (2026-06-23: 艦種ごとに戦い方を分ける) ──
// rangeMult: 交戦距離(基準fireRange倍率) / speedMult: 戦闘移動速度倍率 / standoff: 維持したい距離(自fireRange比)
// fireCD: 連射間隔(小=速い) / kite: 間合いを保ち撃ったら離脱するか / strafe: 側方機動の強さ(0..1)
// fleeClose: プレイヤーがこの距離(fireRange比)まで近づくと逃走 / weaponEarly/Late: 序盤/終盤の武器 / burst: kinetic同時発射数
const ENEMY_COMBAT = {
    // 攻撃型(destroyer): ブルーザー。正面から距離を詰め、3連装kineticで殴り続ける。退かない。
    destroyer: { rangeMult: 1.05, speedMult: 1.05, standoff: 0.50, fireCD: 105, kite: false, strafe: 0.10, fleeClose: 0,    weaponEarly: 'kinetic', weaponLate: 'missile', burst: 3 },
    // 潜航型(corvette): ヒット&アウェイ。高速で間合いを取り、ミサイルを撃ったら側方へ離脱して再び潜む。
    corvette:  { rangeMult: 1.55, speedMult: 1.55, standoff: 0.88, fireCD: 165, kite: true,  strafe: 0.55, fleeClose: 0.55, weaponEarly: 'missile', weaponLate: 'missile', burst: 1 },
    // 空母型(carrier): スタンドオフ。長射程から撃ちつつドローンを射出し、近づかれたら逃げる(近接=最大脆弱)。
    carrier:   { rangeMult: 2.10, speedMult: 0.72, standoff: 0.90, fireCD: 200, kite: true,  strafe: 0.18, fleeClose: 0.70, weaponEarly: 'missile', weaponLate: 'beam',    burst: 1 },
    // ファイター(ドローン): 突撃ハラサー。一直線に肉薄してkineticを浴びせる。
    fighter:   { rangeMult: 0.55, speedMult: 1.60, standoff: 0.32, fireCD: 90,  kite: false, strafe: 0.12, fleeClose: 0,    weaponEarly: 'kinetic', weaponLate: 'kinetic', burst: 1 },
};
// ── 敵の「性格」(マッチ毎ランダム・艦種でレンジを縛る) ──
// 艦種ドクトリン(ENEMY_COMBAT)が土台。性格はその上の"気質"で、ドクトリンを覆さない範囲で行動を変調する。
//  aggression: 距離を詰める/撃つ積極性  stealth: 隠密・低シグネチャ志向  greed: ノード奪取優先度  caution: 損傷時の退き際
function rollEnemyPersonality(type) {
    const R = (a, b) => a + Math.random() * (b - a);
    if (type === 'destroyer')     return { aggression: R(0.45, 1.00), stealth: R(0.00, 0.50), greed: R(0.15, 0.80), caution: R(0.10, 0.55) };
    if (type === 'corvette')      return { aggression: R(0.20, 0.65), stealth: R(0.50, 1.00), greed: R(0.20, 0.85), caution: R(0.40, 0.95) };
    if (type === 'carrier')       return { aggression: R(0.10, 0.45), stealth: R(0.25, 0.70), greed: R(0.45, 1.00), caution: R(0.50, 1.00) };
    return { aggression: R(0.70, 1.00), stealth: R(0.00, 0.25), greed: R(0.00, 0.20), caution: R(0.00, 0.20) }; // fighter=無謀
}
// 検知時フレーバー: 性格をふわっと言語化 (毎マッチ違う相手を感じさせる)
function personalityTag(p) {
    if (p.greed > 0.72)      return '物資集積を優先する';
    if (p.aggression > 0.82) return '極めて攻撃的な';
    if (p.stealth > 0.82)    return '隠密性を重んじる';
    if (p.caution > 0.82)    return '慎重な';
    if (p.aggression < 0.30) return '消極的な';
    return '標準的な';
}
function nearestActiveNode(x, y, maxDist) {
    let best = null, bd = maxDist || Infinity;
    for (const n of resourceNodes) { if (!n.active) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }
    return best;
}
// 敵のノード奪取による自己強化。強化先を性格で重み付け抽選 (攻撃的→火力 / 慎重→装甲 / 隠密→機関 / 貪欲→索敵)。
function applyEnemyUpgrade(ship) {
    const p = ship.personality || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
    const w = { weapon: 0.30 + p.aggression, armor: 0.30 + p.caution, engine: 0.20 + p.stealth, sensor: 0.20 + p.greed };
    const total = w.weapon + w.armor + w.engine + w.sensor;
    let r = Math.random() * total, pick = 'weapon';
    for (const k of ['weapon', 'armor', 'engine', 'sensor']) { if ((r -= w[k]) <= 0) { pick = k; break; } }
    ship.enemyUpgLv = (ship.enemyUpgLv || 0) + 1;
    let label;
    if (pick === 'weapon')      { ship.upgFireCD = Math.max(0.45, ship.upgFireCD * 0.86); ship.upgDmg = Math.min(2.2, ship.upgDmg * 1.13); label = '武装'; }
    else if (pick === 'armor')  { ship.maxHp = Math.min(5000, ship.maxHp * 1.20); ship.hp = Math.min(ship.maxHp, ship.hp + ship.maxHp * 0.15); label = '装甲'; }
    else if (pick === 'engine') { ship.upgSpeed = Math.min(1.8, ship.upgSpeed * 1.12); label = '機関'; }
    else                        { ship.upgDetect = Math.min(2.5, ship.upgDetect * 1.18); label = '索敵'; }
    logMessage(`SENSOR: 敵艦がノードを奪取し【${label}】を強化 (強化Lv${ship.enemyUpgLv})。`, 'warning-msg');
}
// 慣性ベース速度システム
const SHIP_MAX_SPEED_MULT = { assault: 0.58, stealth: 1.05, carrier: 0.38 }; // 艦種別最高速度倍率(全体的に低速化)
const MOVE_SPEED_MULT = 1.5; // 全艦共通の移動速度倍率 (自機/敵対称・2026-07-11 テンポ改善)
const SHIP_ACCEL_RATE = { carrier: 0.00075, assault: 0.002, stealth: 0.004 }; // 最高速度到達まで加速率/frame (×0.25: 初速を遅く)
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
const STORM_SONAR_DEGRADE = 0.70; // 磁気嵐内でのアクティブソナー最大レンジ減衰率 (§3-13残)
// §4-4: 三角測量エンジン定数
const TRIG_MIN_BASELINE     = 500;    // 有効ベースライン最小値 (wu)
const TRIG_MAX_RADIUS       = 4500;   // 最低精度の誤差円半径 (wu)
const TRIG_DECAY_PER_FRAME  = 0.0025; // 精度の経時劣化レート (per frame)
const DECOY_MISDIRECT_RADIUS = 2500; // デコイの強EMで敵lastKnownPosを書き換える半径 (§3-5残)
// §3-6残: 建設停止フロー
let buildingTimer = 0;

// ═══════════════════════════════════════════════════════════════
// ゲーム性進化 (2026-07-03): 「先に見つけて撃つ」を決定的にする4システム
//   1. 奇襲(アンブッシュ): 非警戒の敵への初弾が大ダメージ+混乱
//   2. サブシステム損傷: 奇襲/後方被弾で機関・センサー・武器が一時破損
//   3. 露出度メーター: 敵にどれだけ掴まれているかの常時フィードバック
//   4. ヒッグスサージ: 周期的な全センサー攪乱イベント (マッチのリズム)
// 全数値は実機調整前提の tunable
// ═══════════════════════════════════════════════════════════════
const AMBUSH_PREEMPT_MULT = 3.5;   // 非警戒の敵への初弾ダメージ倍率 (旧: 先制2.0)
const AMBUSH_STAGGER_DUR  = 300;   // 奇襲被弾後の混乱時間 5s (混乱中は追撃被ダメ増)
const AMBUSH_FOLLOW_MULT  = 1.75;  // 混乱中の追撃ダメージ倍率
const AMBUSH_WEAPON_JAM   = 240;   // 奇襲された敵の火器管制ダウン 4s
const PLAYER_SURPRISE_MULT = 1.6;  // 未探知の敵から自機への奇襲被弾倍率
const PLAYER_SURPRISE_JAM  = 150;  // 奇襲された自機の火器管制ダウン 2.5s
const SYS_CRIT_REAR_CHANCE = 0.30; // 後方被弾時のサブシステム損傷確率 (奇襲初弾は確定)
const SYS_CRIT_CD = 300;           // 同一艦への次のクリットまで5s (kinetic連射での連鎖マヒ防止・自機/敵対称)
const SYS_ENGINE_SLOW = 0.45;      // 機関損傷: 速度倍率 (遅くなり、熱漏洩で見つかりやすい)
const SYS_ENGINE_DUR  = 480;       // 機関損傷 8s
const SYS_SENSOR_DUR  = 480;       // センサー損傷 8s (探知ほぼ不能)
const SYS_WEAPON_DUR  = 300;       // 武器系統損傷 5s (発砲不能)
// 露出度 (敵にどれだけ掴まれているか): 0=隠密 / 1=痕跡 / 2=追跡 / 3=捕捉
let playerExposureLevel = 0;
let _exposureHeartbeatTimer = 0;
// ヒッグスサージ (周期イベント: 全探知系が縮退→通過後に高感度ウィンドウ)
let surgePhase = 'none';           // 'none' | 'warn' | 'active' | 'after'
let surgePhaseTimer = 0;
let surgeNextTimer = 7200;
const SURGE_INTERVAL_MIN = 5400;   // 次サージまで最短 90s
const SURGE_INTERVAL_VAR = 3600;   // +0〜60s のランダム
const SURGE_WARN_DUR   = 480;      // 予兆 8s (行動を決める猶予)
const SURGE_ACTIVE_DUR = 720;      // サージ本体 12s (両陣営とも探知激減・ウェイクは濃く残る)
const SURGE_AFTER_DUR  = 360;      // 通過後クリアリング 6s (探知ブースト)
const SURGE_DETECT_MULT  = 0.15;   // サージ中の探知レンジ倍率 (敵味方対称)
const SURGE_VISION_MULT  = 0.6;    // サージ中の有視界倍率
const SURGE_CLARITY_MULT = 1.5;    // クリアリング中の探知倍率
const SURGE_WAKE_MULT    = 2.2;    // サージ中の移動ウェイク増幅 (動けば痕跡が残る)
// 敵スポーン距離: パッシブ探知圏(11000)のすぐ外 → 接敵まで数分の空白を1〜2分に短縮
const ENEMY_SPAWN_MIN = 13000;
const ENEMY_SPAWN_VAR = 4000;

// ═══════════════════════════════════════════════════════════════
// ゲーム性進化 第2弾「音と決断」(2026-07-03):
//   5. 敵アクティブソナーピン: 敵が探信音を放つ (恐怖 + 正確な方位の対称的な情報交換)
//   6. ミサイル接近警報: 接近ミサイルの推進波警告 → デコイ/ジャミングが「反応する道具」になる
//   7. 静粛航行: ワンボタンで速度と全シグネチャを絞る (潜水艦の象徴的動作)
//   8. 遭難信号: 両ハンターを同じ海域へ引き寄せる収束イベント (待ち伏せの舞台)
//   9. 手負いの獲物: HP20%未満で冷却材漏洩 = 熱痕跡を引きずる (追撃戦)
// 全数値は実機調整前提の tunable
// ═══════════════════════════════════════════════════════════════
const ENEMY_PING_CD_MIN = 720;       // 敵アクティブソナーの最短間隔 12s
const ENEMY_PING_CD_VAR = 480;       // +0〜8s (隠密気質の個体はさらに探信を控える)
const ENEMY_PING_RANGE = 4200;       // 探信の有効距離
const ENEMY_PING_HIGGS_BLOCK = 0.5;  // 自機地点のヒッグス濃度がこれ以上なら反射が埋もれる
let silentRunning = false;           // 静粛航行モード
const SILENT_SPEED_MULT = 0.5;       // 静粛航行中の速度倍率
const SILENT_SIG_MULT = 0.55;        // 静粛航行中の全シグネチャ倍率
const TORPEDO_ALERT_RANGE = 2600;    // ミサイル接近警報の探知距離 (推進波)
let distressBeacon = null;           // {x, y, life, claimed} 遭難信号イベント
let distressNextTimer = 4200;        // 初回発生 ~70s
const DISTRESS_INTERVAL_MIN = 7200;  // 以降の発生間隔 120s〜
const DISTRESS_INTERVAL_VAR = 3600;  // +0〜60s
const DISTRESS_LIFE = 3600;          // ビーコン持続 60s
const WOUNDED_HP_FRAC = 0.20;        // 手負い判定: HP20%未満
const WOUNDED_HEAT_FLOOR = 0.45;     // 手負いの熱シグネチャ下限 (冷却材漏洩)

// ═══════════════════════════════════════════════════════════════
// ゲーム性進化 第3弾「深淵の駆け引き」(2026-07-03):
//   10. デブリ擬態: 岩礁帯(デブリ帯)で完全停止+静粛 → 岩塊に紛れて至近でも探知されない
//   11. ニアミス「息を殺せ」: 未発見のまま敵艦が至近を通過する恐怖演出
//   12. チャージビーム: 2秒チャージで威力増。チャージ中は熱/EM激増=敵のcharging適応が本物になる
//   13. 通信傍受: EMセンサーで敵の艦内通信 (状態・意図) を垣間見る
//   14. 撃沈シーケンス: 漂流・誘爆→最終爆発+衝撃波。狩りの感情的報酬
//   15. 戦闘詳報: クリア/撃沈時に狩りの統計を表示
// 全数値は実機調整前提の tunable
// ═══════════════════════════════════════════════════════════════
let isBottomed = false;              // デブリ擬態状態 (岩礁帯+完全停止+静粛)
const BOTTOM_DEBRIS_MIN = 0.30;      // デブリ擬態に必要な岩礁帯密度
const BOTTOM_SIG_MULT = 0.30;        // 擬態中の追加シグネチャ倍率 (静粛×0.55にさらに乗算)
let nearMissActive = false;          // ニアミス状態 (息を殺せ)
const NEAR_MISS_DIST = 1600;         // ニアミス発動距離
const NEAR_MISS_CLEAR = 2100;        // ニアミス解除距離 (ヒステリシス)
let beamChargeMode = false;          // チャージビームモード
const BEAM_CHARGE_DUR = 120;         // チャージ時間 2s
const BEAM_CHARGE_MULT = 2.2;        // チャージビーム威力倍率
let _commsInterceptCD = 0;           // 通信傍受クールダウン
const COMMS_INTERCEPT_RANGE = 2600;  // 傍受可能距離
let huntStats = null;                // 戦闘詳報 (セクター毎リセット)
// 第4弾: 被弾方向インジケータ — どちらから撃たれたかを自機周りの赤アークで即座に伝える
let playerHitDirs = [];              // { ang, life } 被弾方位 (ワールド角)
const HIT_DIR_LIFE = 75;             // 表示時間 1.25s
// 第5弾: 前任艦の残骸 — 撃沈された自艦の残骸が次の出撃のマップに漂い、サルベージできる
let playerWreckObj = null;           // { x, y, value } 回収で value SCR
const BUILD_STOP_DUR  = 180; // 建設中停止フレーム数 (3秒)
const BUILD_SIG_MULT  = 2.0; // 建設中シグネチャ増大倍率
function computeVisionRadius() {
    // ヒッグス連続濃度連動: 0% = 基準視野(100%), 濃度上昇に比例して縮小, 100%でほぼゼロ
    if (!player) return BASE_VISION_RADIUS;
    const h = getHiggsIntensity(player.x, player.y); // 0..1
    let factor = 1 - h * (1 - MIN_VISION_FACTOR);
    if (factor < MIN_VISION_FACTOR) factor = MIN_VISION_FACTOR;
    let r = BASE_VISION_RADIUS * factor;
    if (surgePhase === 'active') r *= SURGE_VISION_MULT;        // ヒッグスサージ: 有視界も縮む
    if (player._sysSensorTimer > 0) r *= 0.6;                    // センサー損傷
    return r;
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
    _uiInsetCache.t = 0; // 回転/リサイズでUIインセット再計測 (第6弾)
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

// ═══ 第6弾: UIインセット — コンソールが覆う領域を除いた「実フィールド」の中心を求める ═══
// 縦持ち=下部コンソール / 横持ち=右サイドコンソール。折りたたみ状態でも自動計測。
function uiInsets() {
    const now = Date.now();
    if (now - _uiInsetCache.t > 600) {
        let right = 0, bottom = 0;
        const bc = document.getElementById('bottom-console');
        if (bc) {
            const r = bc.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) {
                if (r.left > (cssW || 1) * 0.5) {
                    right = Math.max(0, (cssW || window.innerWidth) - r.left);   // 右サイドコンソール (横持ち)
                } else {
                    bottom = Math.min((cssH || 1) * 0.7, Math.max(0, (cssH || window.innerHeight) - r.top)); // 下部コンソール (縦持ち)
                }
            }
        }
        _uiInsetCache = { right, bottom, t: now };
    }
    return _uiInsetCache;
}

function centerCameraOnPlayer() {
    if (!player) return;
    const cw = cssW || window.innerWidth;
    const ch = cssH || window.innerHeight;
    // コンソールに隠れていない「実フィールド」の中心に自機を置く
    const ins = uiInsets();
    camera.x = player.x - ((cw - ins.right) / 2) / camera.zoom;
    camera.y = player.y - ((ch - ins.bottom * 0.75) / 2) / camera.zoom; // 縦は75%補正 (完全に上げすぎない)
    clampCamera();
}

// ═══ 第6弾: コンソール折りたたみ — フィールドを広く使う (状態はlocalStorage永続化) ═══
function toggleConsoleMin() {
    consoleMin = !consoleMin;
    localStorage.setItem('darkEchoConsoleMin', consoleMin ? '1' : '0');
    _applyConsoleMin();
    playSound('ui');
}
function _applyConsoleMin() {
    document.body.classList.toggle('console-min', consoleMin);
    const b = document.getElementById('btn-console-toggle');
    if (b) b.textContent = consoleMin ? '▲ 操作' : '▼ 閉じる';
    _uiInsetCache.t = 0; // インセット再計測
    // 初期化IIFE(スクリプト冒頭)からも呼ばれる。後方宣言のlet(TDZ)はtypeofでも例外を投げるため
    // try/catchで初期化前の呼び出しを無害化する (ゲーム中の呼び出しは正常に動く)
    try { if (cameraFollowPlayer && player) centerCameraOnPlayer(); } catch (e) { /* 初期化前は無視 */ }
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
    // map-mode-banner は廃止（非表示）
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
    if (player._weaponJamTimer > 0) { logMessage('WEP: 火器管制ダウン — 復旧まで発砲不能', 'warning-msg'); return; }
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
        cancelSilentRunning('発砲');
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
                // 勘打ちビームでも奇襲・後方・混乱ボーナス適用 (盲撃ちが刺さる爽快感)
                const _ffSt = applyStrikeBonuses(true, null, en, Math.atan2(player.y - en.y, player.x - en.x));
                const _ffD = Math.floor(150 * (1 - _hb * 0.8) * _ffSt.mult);
                en.hp -= _ffD;
                if (huntStats) huntStats.dmgDealt += _ffD;
                createHitEffect(en.x, en.y, '#00ffaa');
                addShake(15);
                logMessage(`WEP: BEAM 命中！ → ${_ffD} ダメージ`, 'system-msg');
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
        playSound('shoot');
        cancelSilentRunning('発砲');
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
                // 長押しラジアルメニューを表示（移動/射撃/キャンセル）
                _lpmWorld = { x: worldX, y: worldY };
                showLongPressMenu(touch.holdSX, touch.holdSY);
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
        this.identified = false;
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

        // アイコンスケール: 最低20px画面サイズを保証（Stationと同様の視認性）
        const _iconS = Math.max(20, Math.min(28, camera.zoom * 28)) / (camera.zoom * 28);
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

        // ランドマークラベル: Station スタイルで最低9px確保
        ctx.save();
        ctx.translate(this.x, this.y);
        const _lColor = this.type === 'colony' ? (this.hacked ? '#00ffcc' : '#6699ff') : (this.hacked ? '#00ffcc' : '#bb9966');
        const _lText  = this.type === 'colony' ? (this.hacked ? 'COLONY [HACKED]' : 'COLONY NODE') : (this.hacked ? 'DERELICT [HACKED]' : 'DERELICT');
        const _lFontPx = Math.max(9, Math.min(14, camera.zoom * 14)) / camera.zoom;
        ctx.fillStyle = _lColor;
        ctx.font = `bold ${_lFontPx.toFixed(1)}px Orbitron, monospace`;
        ctx.textAlign = 'center';
        ctx.shadowColor = _lColor; ctx.shadowBlur = 2;
        ctx.fillText(_lText, 0, -60 / camera.zoom);
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

// ═══ 奇襲・混乱・サブシステム損傷の一括判定 ═══
// kinetic/missile着弾(Projectile.update)と beam即着弾(Projectile constructor)の共通処理。
// 「先に見つけて撃つ」を決定的にする: 非警戒の敵への初弾=×3.5+混乱(火器管制ダウン)+確定クリット。
// 対称ルール: 未探知の敵から撃たれた自機も奇襲被弾(×1.6+火器管制ダウン)を受ける。
let _beamShooter = null; // 敵ビームの発射元 (constructorで即着弾するため直前にセットされる)
function applyStrikeBonuses(byPlayer, attacker, target, hitAng) {
    let mult = 1, preempt = false;
    let diff = hitAng - target.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    const rear = Math.abs(diff) > Math.PI * 0.55;
    if (rear) {
        mult *= 1.5;
        if (!byPlayer && target === player) {
            effects.push({ x: target.x, y: target.y - 28, text: '後方被弾 ×1.5', life: 1.0, type: 'floatText', c: '#ff6666' });
        }
    }
    if (byPlayer && target !== player) {
        if (target.detectionState === 'unaware') {
            // 奇襲成功: 大ダメージ + 混乱 (火器管制ダウン・追撃ボーナス窓)
            mult *= AMBUSH_PREEMPT_MULT;
            preempt = true;
            target.detectionState = 'alerted';
            target.isAggro = true; target.aggroTimer = 600;
            target._staggerTimer = AMBUSH_STAGGER_DUR;
            target._weaponJamTimer = Math.max(target._weaponJamTimer || 0, AMBUSH_WEAPON_JAM);
            logMessage('TAC: 奇襲成功！ 敵艦混乱 — 火器管制ダウン中は追撃ダメージ増', 'warning-msg');
            playSound('alert');
            if (huntStats) huntStats.ambushes++;
            if (gameState.career) gameState.career.ambushes++;
        } else if (target._staggerTimer > 0) {
            mult *= AMBUSH_FOLLOW_MULT; // 混乱中の追撃
        }
    }
    if (!byPlayer && target === player) {
        target.detectionState = 'alerted';
        // 自機が攻撃元を全く掴めていなかった → 奇襲被弾 (対称ルール)
        const unseen = attacker && attacker.type !== 'fighter' && !attacker.visible && !attacker.inVision && (attacker.contactAccuracy || 0) < 0.25; // fighterドローンの体当たり射撃は奇襲扱いしない (雑魚に×1.6+火器管制ダウンが連発される問題)
        if (unseen && target._staggerTimer <= 0) {
            mult *= PLAYER_SURPRISE_MULT;
            target._staggerTimer = AMBUSH_STAGGER_DUR;
            target._weaponJamTimer = Math.max(target._weaponJamTimer || 0, PLAYER_SURPRISE_JAM);
            logMessage('CRITICAL: 未探知の敵からの奇襲被弾 — 火器管制リセット中！', 'warning-msg');
            effects.push({ x: target.x, y: target.y - 44, text: '奇襲被弾!', life: 1.2, type: 'floatText', c: '#ff3333' });
            playSound('alert');
        } else if (target._staggerTimer > 0) {
            mult *= AMBUSH_FOLLOW_MULT;
        }
    }
    // サブシステム損傷: 奇襲初弾=確定 / 後方被弾=確率 (機関40% / センサー30% / 武器30%)。
    // クリットは対象毎に5sのCD — assault3連装の後方salvo(1発30%×3)で毎秒クリットが出る連鎖マヒを防ぐ
    if ((preempt || (rear && Math.random() < SYS_CRIT_REAR_CHANCE)) && !(target._critCD > 0)) {
        target._critCD = SYS_CRIT_CD;
        const roll = Math.random();
        let label;
        if (roll < 0.40)      { target._sysEngineTimer = SYS_ENGINE_DUR; label = '機関損傷'; }
        else if (roll < 0.70) { target._sysSensorTimer = SYS_SENSOR_DUR; label = 'センサー損傷'; }
        else                  { target._weaponJamTimer = Math.max(target._weaponJamTimer || 0, SYS_WEAPON_DUR); label = '武器系統損傷'; }
        effects.push({ x: target.x, y: target.y - 58, text: label + '!', life: 1.3, type: 'floatText', c: '#ff9500' });
        logMessage(target === player ? `WARN: サブシステム被害 — ${label}` : `TAC: 敵艦に${label} — 好機`, 'warning-msg');
        if (huntStats && target !== player) huntStats.crits++;
    }
    return { mult, preempt };
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
            this.speed = 12; this.maxDist = 800 * _wRange; this.dmg = 18 * dmgScale; // バランス調整: 15→18 (近距離高リスクに見合うリターン。非assaultのkinetic DPS 22→26)
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'missile') {
            // §3-10 ミサイル2タイプ: homing=熱源誘導 / smart=AI追跡(EM強・デコイ耐性・大閃光)
            this.missileMode = isPlayer ? missileMode : 'homing';
            this.speed = this.missileMode === 'smart' ? 7.5 : 6;
            this.maxDist = (this.missileMode === 'smart' ? 4400 : 3000) * _wRange;
            this.dmg = (this.missileMode === 'smart' ? 70 : 55) * dmgScale; // バランス調整: 警報+デコイ対抗策の追加で実効命中率が下がった分を補填
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'beam') {
            this.active = false;
            if (target && target.hp > 0) {
                // ヒッグス高濃度エリアではビームダメージ大幅低下 (設計確定仕様)
                const higgsBetween = getHiggsIntensity((x + target.x) / 2, (y + target.y) / 2);
                const higgsBeamPenalty = 1 - higgsBetween * 0.8; // 最大80%ダメージ減衰
                // §3-1 装甲: beam耐性 (敵ビームが自機に当たる時)
                const beamArmorRes = (!isPlayer && target === player) ? ARMOR_RES_BEAM[gameState.upgrades.armor] : 0;
                // 奇襲・後方・混乱・サブシステム損傷 (ビームこそ潜航狙撃の主役 — 旧実装は先制ボーナスが乗らなかった)
                const _bStrike = applyStrikeBonuses(isPlayer, isPlayer ? null : _beamShooter, target, Math.atan2(y - target.y, x - target.x));
                const _beamDmg = Math.floor(150 * higgsBeamPenalty * dmgScale * (1 - beamArmorRes) * _bStrike.mult);
                target.hp -= _beamDmg;
                if (huntStats) { if (isPlayer && target !== player) huntStats.dmgDealt += _beamDmg; else if (!isPlayer && target === player) huntStats.dmgTaken += _beamDmg; }
                // 被弾方向インジケータ (敵ビームが自機に命中)
                if (!isPlayer && target === player) {
                    playerHitDirs.push({ ang: Math.atan2(y - target.y, x - target.x), life: HIT_DIR_LIFE });
                    if (playerHitDirs.length > 6) playerHitDirs.shift();
                }
                createHitEffect(target.x, target.y, isPlayer ? '#00ffaa' : '#ff4d4d');
                effects.push({ x: target.x, y: target.y - 30, text: _bStrike.preempt ? `奇襲! -${_beamDmg}` : `-${_beamDmg}`, life: 1.0, type: 'floatText', c: _bStrike.preempt ? '#ffff00' : (isPlayer ? '#00ffdd' : '#ff5555') });
                if (isPlayer) logMessage(`HIT [BEAM] → ${_beamDmg} ダメージ`, 'warning-msg');
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
            // §3-10残: プレイヤーのジャミングが敵ミサイル誘導に干渉 (HON/AI共通)
            let _jamMissileFactor = 1.0;
            if (!this.isPlayer && player && player.hp > 0) {
                const _jdist = Math.hypot(this.x - player.x, this.y - player.y);
                if (jamPulse > 0 && _jdist < JAM_PULSE_RADIUS) {
                    _jamMissileFactor = 0.02; // パルス: ほぼ誘導無効
                    if (Math.random() < 0.15) this.angle += (Math.random() - 0.5) * 0.6;
                } else {
                    if (jamBurst > 0 && _jdist < JAM_BURST_RADIUS) _jamMissileFactor = Math.min(_jamMissileFactor, 0.40);
                    if (jamCont      && _jdist < JAM_CONT_RADIUS)  _jamMissileFactor = Math.min(_jamMissileFactor, 0.65);
                }
            }
            const _missileTurn = 0.05 * (1 - getStormIntensity(this.x, this.y) * STORM_MISSILE_DEGRADE) * _jamMissileFactor;
            this.angle += diff * _missileTurn;
            // ミサイル接近警報: 敵ミサイルの推進波を探知。
            // 警告が出ることでデコイ射出/ジャミング/回避機動が「反応する道具」になる。
            if (!this.isPlayer && !this._torpAlerted && player && player.hp > 0 &&
                Math.hypot(player.x - this.x, player.y - this.y) < TORPEDO_ALERT_RANGE) {
                this._torpAlerted = true;
                playSound('alert');
                logMessage('WARNING: 高速推進波を探知 — ミサイル接近中！ (デコイ/ジャミング/回避)', 'warning-msg');
            }
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
            // 奇襲(×3.5+混乱)・後方被弾(×1.5)・混乱中追撃(×1.75)・サブシステム損傷を一括判定
            const _hitAng = Math.atan2(this.y - hitTarget.y, this.x - hitTarget.x);
            const _strike = applyStrikeBonuses(this.isPlayer, this.owner || null, hitTarget, _hitAng);
            let dmgMult = _strike.mult;
            const preemptive = _strike.preempt;
            // §3-1 装甲: 武器種別耐性 (敵弾が自機に当たる時のみ)
            if (!this.isPlayer && hitTarget === player) {
                const armorLv = gameState.upgrades.armor;
                const res = (this.type === 'kinetic' ? ARMOR_RES_KINETIC[armorLv]
                           : this.type === 'missile' ? ARMOR_RES_MISSILE[armorLv] : 0);
                dmgMult *= (1 - res);
            }
            const _hitDmg = Math.floor(this.dmg * dmgMult);
            hitTarget.hp -= _hitDmg;
            if (huntStats) { if (this.isPlayer) huntStats.dmgDealt += _hitDmg; else if (hitTarget === player) huntStats.dmgTaken += _hitDmg; }
            // 被弾方向インジケータ: どの方位から撃たれたか (自機のみ)
            if (!this.isPlayer && hitTarget === player) {
                playerHitDirs.push({ ang: _hitAng, life: HIT_DIR_LIFE });
                if (playerHitDirs.length > 6) playerHitDirs.shift();
            }
            this.active = false;
            createHitEffect(this.x, this.y, this.isPlayer ? '#ffaa00' : '#ff4d4d');
            if (!preemptive) {
                effects.push({ x: hitTarget.x, y: hitTarget.y - 30, text: `-${_hitDmg}`, life: 1.0, type: 'floatText', c: this.isPlayer ? '#ffdd00' : '#ff5555' });
            }
            if (this.isPlayer) logMessage(`HIT [${this.type.toUpperCase()}] → ${_hitDmg} ダメージ`, 'warning-msg');
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
                effects.push({ x: hitTarget.x, y: hitTarget.y - 30, text: `奇襲! ×3.5 (${_hitDmg})`, life: 1.2, type: 'floatText', c: '#ffff00' });
            }
        }
        // §3-6残: 敵弾がプレイヤードローンに被弾 (自機を外れた弾のみ判定)
        if (!this.isPlayer && this.active && playerDrones.length > 0) {
            const hitDrone = playerDrones.find(d => d.hp > 0 && Math.hypot(d.x - this.x, d.y - this.y) < 18);
            if (hitDrone) {
                hitDrone.hp -= this.dmg * 0.8;
                this.active = false;
                createHitEffect(this.x, this.y, '#ffaa00');
                if (hitDrone.hp <= 0) logMessage(`DRONE: ${DRONE_LABELS[hitDrone.type] || hitDrone.type} 撃墜`, 'warning-msg');
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


const WEAPON_COOLDOWNS = { kinetic: 15, missile: 65, beam: 140 }; // 発射後クールダウン(frame)。beamが射撃サイクルの律速

// 武器マガジン・リロード定数 (2026-06-23: missile/beamのリロードが体感的に遅いとの指摘で短縮)
const KINETIC_RELOAD_TIME = 180; // 3秒 @60fps (マガジン8発撃ち切り後)
const MISSILE_RELOAD_TIME = 90;  // 1.5秒 @60fps (旧150=2.5s)
const BEAM_RELOAD_TIME = 90;     // 1.5秒 @60fps (旧120=2s)

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
            this.personality = rollEnemyPersonality(type); // マッチ毎の気質 (艦種でレンジを縛る)
            this.upgFireCD = 1; this.upgDmg = 1; this.upgSpeed = 1; this.upgDetect = 1; // ノード奪取で変動
            this.enemyUpgLv = 0;
            this._desperateLogged = false;
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
        // 奇襲・サブシステム損傷 (自機/敵 対称)
        this._staggerTimer = 0;   // 奇襲被弾後の混乱 (被ダメ増)
        this._weaponJamTimer = 0; // 火器管制ダウン (発砲不能)
        this._sysEngineTimer = 0; // 機関損傷 (減速+熱漏洩)
        this._sysSensorTimer = 0; // センサー損傷 (探知ほぼ不能)
    }

    setTarget(tx, ty) { this.targetX = tx; this.targetY = ty; this.state = 'moving'; }

    // デブリ帯(岩礁帯)による移動減速 (§3-13 D)。AI配分で姿勢制御補助=軽減 (プレイヤーのみ)。
    terrainSpeedMult() {
        // 機関損傷: 速度大幅低下 (奇襲/後方被弾のサブシステム・クリット)
        const _sysEng = (this._sysEngineTimer > 0) ? SYS_ENGINE_SLOW : 1;
        const deb = getDebrisIntensity(this.x, this.y);
        if (deb <= 0) return _sysEng;
        // AI配分で姿勢制御補助=軽減。自機はGEN AI配分、敵は固定の軽減(全く動けなくなるのを防ぐ)。
        const aiMit = this.isPlayer ? (genAlloc.ai / 100) * DEBRIS_AI_MITIGATE : DEBRIS_ENEMY_MITIGATE;
        // §3-1 エンジンアップグレード: デブリ減速もヒッグスの50%相当で軽減
        const engMit = this.isPlayer ? ENGINE_UPG_HIGGS_RESIST[gameState.upgrades.engine] * 0.5 : 0;
        return _sysEng * (1 - deb * DEBRIS_SLOW * (1 - aiMit) * (1 - engMit));
    }

    update() {
        if (this.hp <= 0) return;
        if (this.fireCooldown > 0) this.fireCooldown -= gameSpeedFactor;
        // 奇襲・サブシステム損傷タイマー減衰
        if (this._staggerTimer > 0)   this._staggerTimer   -= gameSpeedFactor;
        if (this._weaponJamTimer > 0) this._weaponJamTimer -= gameSpeedFactor;
        if (this._sysEngineTimer > 0) this._sysEngineTimer -= gameSpeedFactor;
        if (this._sysSensorTimer > 0) this._sysSensorTimer -= gameSpeedFactor;
        if (this._critCD > 0)         this._critCD         -= gameSpeedFactor;

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
            // 電力(genAlloc.ai)↑ → 処理熱放射も増大
            this.heatSig    = Math.min(1, _thrust * _engType.heatMult * 0.55 * (1 - ENGINE_UPG_HEAT_REDUCE[gameState.upgrades.engine]) + genAlloc.ai / 100 * 0.10);
            // 機関損傷: 冷却系破損で熱漏洩 (自機も対称に狩られやすくなる)
            if (this._sysEngineTimer > 0) this.heatSig = Math.min(1, this.heatSig + 0.35);
            this.opticalSig = Math.min(1, _thrust * _engType.optMult * 0.45 + (this.weaponType === 'beam' ? 0.5 : 0));
            // EM: 推進＋(センサー/AI処理放射)。ゲインで増幅。AI↑でEM↑(逆探知の法則)。
            this.emSig      = Math.min(1, (_thrust * 0.35 + genAlloc.sensors / 100 * 0.18 + genAlloc.ai / 100 * 0.40) * (0.6 + _gain * 0.4) * _engType.emMult);
            // 磁気嵐帯: 嵐がEM放射を覆い隠す → AIを安全に高配分できる退避所 (§3-13 D)
            this.emSig     *= (1 - getStormIntensity(this.x, this.y) * STORM_EM_MASK);
            // 熱雲: 環境熱ノイズが熱署名を埋もれさせる → HEATセンサーから隠れやすい (§3-13 Phase3)
            this.heatSig   *= (1 - getThermalIntensity(this.x, this.y) * THERMAL_HEAT_MASK);
            // ヒッグス: ヒッグス雲内を動くほどウェイク乱流。ヒッグスエンジンは特に顕著。
            this.higgsSig   = Math.min(1, _thrust * _hHere * 1.6 + (_engType.higgsSpeedBonus > 0 ? _thrust * _engType.higgsSpeedBonus * 0.7 : _thrust * 0.08));
            // 静粛航行: 全シグネチャ抑制 (速度も落ちる。発砲/ソナーで自動解除)
            if (silentRunning) {
                this.heatSig    *= SILENT_SIG_MULT;
                this.opticalSig *= SILENT_SIG_MULT;
                this.emSig      *= SILENT_SIG_MULT;
                this.higgsSig   *= SILENT_SIG_MULT;
            }
            // デブリ擬態: 岩塊に艦影が紛れ、さらに大幅低減 (敵の近接ハード探知も無効)
            if (isBottomed) {
                this.heatSig    *= BOTTOM_SIG_MULT;
                this.opticalSig *= BOTTOM_SIG_MULT;
                this.emSig      *= BOTTOM_SIG_MULT;
                this.higgsSig   *= BOTTOM_SIG_MULT;
            }
            // ビームチャージ中: 熱/EM激増 — 敵の「chargingシグネチャ推定→回避行動」が本物になる
            if ((this._beamCharge || 0) > 0) {
                this.heatSig = Math.min(1, this.heatSig + 0.30);
                this.emSig   = Math.min(1, this.emSig + 0.40);
                // チャージが中断されたら放熱 (発射条件が30f以上満たされない場合)
                if (_frameCount - (this._chargeFrame || 0) > 30) {
                    this._beamCharge = Math.max(0, this._beamCharge - 2 * gameSpeedFactor);
                    if (this._beamCharge === 0) this._chargeLogged = false;
                }
            }
            // 手負い: HP20%未満で冷却材漏洩 — 熱は隠しきれない (静粛航行でも下限あり)
            if (this.hp / this.maxHp < WOUNDED_HP_FRAC) {
                this.heatSig = Math.max(this.heatSig, WOUNDED_HEAT_FLOOR * (silentRunning ? 0.7 : 1));
                if (!this._woundedLogged) { this._woundedLogged = true; logMessage('WARN: 冷却材漏出 — 熱シグネチャを抑えられない。敵に追われやすい', 'warning-msg'); }
            } else this._woundedLogged = false;

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
            const _baseTargetSpeed = ((genAlloc.engine / 100) * genGain * 1.4 * (SHIP_MAX_SPEED_MULT[gameState.shipType] || 1.0) * _higgsSlowdown * _engTypeP.speedMult + _higgsBonusSpeed) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT * (silentRunning ? SILENT_SPEED_MULT : 1);
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
                // 停止中は全センサーに脆弱 (艦種別シグネチャ増大)
                // assault=装甲溶接→高熱+光学閃光 / stealth=電子修復→EM急騰 / carrier=複合システム→EM+ヒッグス
                const _rSig = { assault: [0.38, 0.28, 0.22, 0.10], stealth: [0.15, 0.55, 0.08, 0.07], carrier: [0.22, 0.42, 0.14, 0.14] }[gameState.shipType] || [0.28, 0.35, 0.15, 0.10];
                this.heatSig    = Math.min(1, this.heatSig    + _rSig[0] * REPAIR_SIG_MULT);
                this.emSig      = Math.min(1, this.emSig      + _rSig[1] * REPAIR_SIG_MULT);
                this.opticalSig = Math.min(1, this.opticalSig + _rSig[2] * REPAIR_SIG_MULT);
                this.higgsSig   = Math.min(1, this.higgsSig   + _rSig[3] * REPAIR_SIG_MULT);
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

            // §3-6残: 建設中停止フロー (carrier が建設系ドローン展開中は完全停止 + シグネチャ増大)
            if (buildingTimer > 0) {
                buildingTimer--;
                this.currentSpeed = 0;
                this._baseTargetSpeed = 0;
                this.heatSig    = Math.min(1, this.heatSig    + 0.20 * BUILD_SIG_MULT);
                this.emSig      = Math.min(1, this.emSig      + 0.30 * BUILD_SIG_MULT);
                this.opticalSig = Math.min(1, this.opticalSig + 0.10 * BUILD_SIG_MULT);
                this.higgsSig   = Math.min(1, this.higgsSig   + 0.08 * BUILD_SIG_MULT);
                if (buildingTimer === 0) logMessage('DRONE: 建設完了 — 航行再開', 'system-msg');
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
                let wRange = wType === 'missile' ? 2600 : (wType === 'beam' ? 1600 : 1000);
                // 想定ロック時、beamはヒッグスダークチャネル狙撃で長射程化 (設計: マップ端から狙撃可)
                if (wType === 'beam' && _assumedLock) wRange = 16000;

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
                if (dist < wRange && this.fireCooldown <= 0 && Math.abs(diff) < _fireArc && this._weaponJamTimer <= 0) {
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
                            // §2-1残: 想定ロック時はキネティックに射角ジッター (精度低いほど外れやすい)
                            const _kBaseAng = Math.atan2(this.targetEntity.y - this.y, this.targetEntity.x - this.x);
                            const _kJit = _assumedLock ? (Math.random() - 0.5) * (1 - _acc) * 0.55 : 0;
                            const proj = new Projectile(this.x, this.y, this.targetEntity, true, wType, _lockDmg);
                            if (_kJit !== 0) proj.angle = _kBaseAng + _kJit;
                            projectiles.push(proj);
                            // 攻撃型特殊: 3連装同時発射 (kinetic時のみ)
                            if (gameState.shipType === 'assault') {
                                const spread = 0.12;
                                [-spread, spread].forEach(offset => {
                                    const p = new Projectile(this.x, this.y, this.targetEntity, true, 'kinetic', _lockDmg);
                                    p.angle = _kBaseAng + offset + _kJit;
                                    projectiles.push(p);
                                });
                            }
                            if (_assumedLock && Math.abs(_kJit) > 0.1) logMessage('WEP: KINETIC 想定射撃 — 推定位置ブレで射角散弾', 'warning-msg');
                            playSound('shoot');
                            cancelSilentRunning('発砲');
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
                            // §2-1残: 想定ロック時はミサイル誘導先に位置ジッター (精度低いほど外れやすい)
                            let _mTgt = this.targetEntity;
                            if (_assumedLock) {
                                const _mJit = (1 - _acc) * 500;
                                _mTgt = { x: this.targetEntity.x + (Math.random() - 0.5) * _mJit,
                                          y: this.targetEntity.y + (Math.random() - 0.5) * _mJit, hp: 1 };
                            }
                            const proj = new Projectile(this.x, this.y, _mTgt, true, wType, _lockDmg);
                            projectiles.push(proj);
                            if (_assumedLock) logMessage('WEP: MISSILE 想定射撃 — 推定座標へ誘導 (外れる可能性あり)', 'warning-msg');
                            else if (missileMode === 'smart') logMessage('WEP: MISSILE [AI追跡] 発射 — EM強・ジャミング耐性・大閃光', 'system-msg');
                            playSound('shoot');
                            cancelSilentRunning('発砲');
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
                        } else if (beamChargeMode && (this._beamCharge || 0) < BEAM_CHARGE_DUR) {
                            // チャージビーム: 発射前に2秒溜める。チャージ中は熱/EM激増=敵に読まれ回避される
                            this.weaponType = wType;
                            this._beamCharge = (this._beamCharge || 0) + gameSpeedFactor;
                            this._chargeFrame = _frameCount;
                            if (!this._chargeLogged) { this._chargeLogged = true; logMessage('WEP: ビームチャージ開始 — 熱/EM放射激増中', 'warning-msg'); }
                        } else {
                            this.weaponType = wType;
                            const _chgMult = (beamChargeMode && (this._beamCharge || 0) >= BEAM_CHARGE_DUR) ? BEAM_CHARGE_MULT : 1;
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
                                const proj = new Projectile(this.x, this.y, this.targetEntity, true, wType, _lockDmg * _chgMult);
                                projectiles.push(proj);
                                if (_chgMult > 1) logMessage('WEP: チャージビーム解放 — 威力×2.2', 'system-msg');
                            }
                            this._beamCharge = 0; this._chargeLogged = false;
                            playSound('shoot');
                            cancelSilentRunning('発砲');
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
                    this.speed = 0.8 * MOVE_SPEED_MULT;
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
                this.speed = 1.2 * MOVE_SPEED_MULT; // 素早く移動して新しい潜伏場所へ
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
                    // 少し待ってから新しい隠れ場所へ移動 (プレイヤーから遠ざかる方向)
                    const _fleeAng = Math.atan2(this.y - player.y, this.x - player.x);
                    const _jitter = (Math.random() - 0.5) * Math.PI * 0.5;
                    const _fleeDist = 3500 + Math.random() * 2000;
                    const hideSpot = findHidingSpot(
                        this.x + Math.cos(_fleeAng + _jitter) * _fleeDist,
                        this.y + Math.sin(_fleeAng + _jitter) * _fleeDist,
                        2500
                    );
                    this.setTarget(hideSpot.x, hideSpot.y);
                    this.aiState = 'lurking'; // 逃走中は潜伏状態に戻す
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
            let myDetectRange = ENEMY_DETECT_BASE * (1 - higgsHereDetect * 0.55) * (1 + gameState.sector * 0.05) * playerEmBoost * (1 - jamDegrade) * (this.upgDetect || 1);
            // ヒッグスサージ: 敵の探知も対称に縮退/ブースト (プレイヤーと同じ物理法則)
            if (surgePhase === 'active') myDetectRange *= SURGE_DETECT_MULT;
            else if (surgePhase === 'after') myDetectRange *= SURGE_CLARITY_MULT;
            // センサー損傷: ほぼ盲目 (奇襲でセンサーを潰せば追跡を振り切れる)
            if (this._sysSensorTimer > 0) myDetectRange *= 0.1;

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
                    const distAtten = Math.max(0, 1 - distToPlayer / (myDetectRange * ENEMY_SIG_REACH * sc2.rangeScale));
                    // 地形ハザード: デブリ=OPTIC減衰 / 磁気嵐=EM減衰 / 熱雲=HEAT減衰 (§3-13)
                    let terrAtten = 1;
                    if (sName === 'optic') terrAtten = 1 - _debrisPath * DEBRIS_OPTIC_MOD;
                    else if (sName === 'em')   terrAtten = 1 - _stormPath   * STORM_EM_MOD;
                    else if (sName === 'heat') terrAtten = 1 - _thermalPath * THERMAL_HEAT_MOD;
                    const attenuated = pSigs[sName] * distAtten * (1 - higgsPath * sc2.higgsMod) * terrAtten;
                    if (attenuated > sc2.threshold * 0.6) { playerSigDetected = true; detectedSigStrength = Math.max(detectedSigStrength, attenuated); }
                    if (attenuated > domVal) { domVal = attenuated; domSig = sName; }
                });
                // 接近探知 (デブリ擬態中は岩塊に紛れて至近でも掴めない — 至近を通過されてもやり過ごせる)
                if (!isBottomed && distToPlayer < myDetectRange) {
                    this.detectionTimer++;
                    if (this.detectionTimer > 60) playerSigDetected = true;
                } else {
                    this.detectionTimer = Math.max(0, this.detectionTimer - 1);
                }
            }

            // センサー制約型: 探知中のみ最終既知位置を更新。喪失後は古い予測が凍結される。
            if (playerSigDetected && player && player.hp > 0) {
                let _lkx = player.x, _lky = player.y;
                // §3-12残: ジャミングで相手の方位を広げる — JAM中は探知位置にノイズを加算
                // 方位の不確かさ↑＝位置推定がズレる＝発砲精度が下がる
                if (gameState.shipType === 'stealth') {
                    if (jamBurst > 0 && distToPlayer < JAM_BURST_RADIUS) {
                        const _ja = Math.random() * Math.PI * 2;
                        _lkx += Math.cos(_ja) * Math.random() * 400;
                        _lky += Math.sin(_ja) * Math.random() * 400;
                    } else if (jamCont && distToPlayer < JAM_CONT_RADIUS) {
                        const _ja = Math.random() * Math.PI * 2;
                        _lkx += Math.cos(_ja) * Math.random() * 250;
                        _lky += Math.sin(_ja) * Math.random() * 250;
                    }
                }
                this.playerLastKnownPos = {
                    x: _lkx, y: _lky,
                    vx: player.x - (player.prevX ?? player.x),
                    vy: player.y - (player.prevY ?? player.y)
                };
                this.contactFreshness = 1.0;
            } else {
                // 残り香の減衰: 通常0.012/f(83s)。静粛航行×1.5(55s)・デブリ擬態×2.2(38s)で加速=「隠れる」行動が振り切りに直結する
                const _decayMult = isBottomed ? 2.2 : (silentRunning ? 1.5 : 1);
                this.contactFreshness = Math.max(0, this.contactFreshness - 0.012 * _decayMult);
                // §3-6残: 攻撃型ドローンの熱シグネチャ — コンタクト薄い時のみ誤誘引
                if (playerDrones.length > 0 && this.contactFreshness < 0.3) {
                    for (const dr of playerDrones) {
                        if (dr.type !== 'attack') continue;
                        if (Math.hypot(this.x - dr.x, this.y - dr.y) < myDetectRange * 0.7) {
                            this.playerLastKnownPos = { x: dr.x, y: dr.y, vx: 0, vy: 0 };
                            this.contactFreshness = 0.35;
                            break;
                        }
                    }
                }
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
                        if (!this.alertLogged) { this.alertLogged = true; logMessage(`WARN: 敵艦(${personalityTag(this.personality || {})}個体)があなたのシグネチャを捕捉。迎撃態勢に入ります。`, 'warning-msg'); }
                    }
                } else if (this.aiState === 'lurking' || this.aiState === 'gathering') {
                    this.aiState = 'hunting';
                    this.gatherTarget = null;
                    this.lurking = false;
                    logMessage(`SENSOR: 敵艦が索敵パターンに移行。接近警戒。`, 'warning-msg');
                }
            }

            // キャリア: ドローン製造 (空母型の主戦力)。コンタクトを得ている時だけ射出し、
            // 交戦中は射出間隔を短縮。ドローンは"自分が信じている位置(最終既知位置)"へ向かわせる。
            if (this.type === 'carrier') {
                this.droneSpawnTimer--;
                const _engaged = this.aiState === 'combat' || this.aiState === 'hunting';
                const _hasContact = _engaged || this.contactFreshness > 0.1;
                if (this.droneSpawnTimer <= 0 && _hasContact && enemies.filter(e=>e.hp>0).length < 6) {
                    const _bel = this.playerLastKnownPos || (player ? { x: player.x, y: player.y } : { x: this.x, y: this.y });
                    const drone = new Ship(
                        this.x + (Math.random()-0.5)*300,
                        this.y + (Math.random()-0.5)*300, false, 'fighter'
                    );
                    drone.aiState = 'hunting';
                    drone.huntTarget = { x: _bel.x, y: _bel.y };
                    drone.huntTimer = 600;
                    drone.lurking = false;
                    enemies.push(drone);
                    this.droneSpawnTimer = _engaged ? (380 + Math.floor(Math.random() * 320)) : (700 + Math.floor(Math.random() * 500));
                    logMessage('TACTICAL: 敵空母がファイタードローンを射出！', 'warning-msg');
                }
            }

            // ──────────────────────────────────────
            // 状態別AI実行
            // ──────────────────────────────────────
            if (this.aiState === 'combat') {
                this.lurking = false;
                const prof = ENEMY_COMBAT[this.type] || ENEMY_COMBAT.destroyer;
                const pers = this.personality || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
                const fireRange = (700 + gameState.sector * 25) * prof.rangeMult;
                this.speed = Math.min(2.2, 0.9 + gameState.sector * 0.08) * prof.speedMult * (this.upgSpeed || 1) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT;

                // センサー制約型照準: 実プレイヤーではなく「最終既知位置」へ撃つ。
                // 接触が新しいほど速度ぶんリード外挿、喪失するほど古い点で凍結 → 移動/沈黙で外れる。
                const lk = this.playerLastKnownPos;
                const lead = this.contactFreshness * 40; // 鮮度に応じた外挿フレーム (最大40)
                const aimX = lk ? lk.x + lk.vx * lead : (player ? player.x : this.x);
                const aimY = lk ? lk.y + lk.vy * lead : (player ? player.y : this.y);
                const distToBelief = Math.hypot(aimX - this.x, aimY - this.y);
                // 側方機動の向きは時々反転させ、ストレイフを読まれにくくする
                if (this._dodgeDir === undefined || Math.random() < 0.004) this._dodgeDir = (Math.random() < 0.5 ? 1 : -1);

                // ── HP状況による行動変容 (自他HP比 + 性格caution) ──
                const hpFrac = this.hp / this.maxHp;
                const playerHpFrac = (player && player.hp > 0) ? player.hp / player.maxHp : 1;
                let retreatThresh = 0.12 + pers.caution * 0.43;          // 慎重なほど早く退く
                if (playerHpFrac > hpFrac + 0.30) retreatThresh += 0.12; // 相手が格上 → さらに早く退く
                const desperate = hpFrac < retreatThresh;
                const killInstinct = hpFrac > 0.5 && playerHpFrac < 0.35; // 自分は健在で相手が瀕死 → 仕留めに踏み込む
                // 撤退中の自己修復: ノードに触れたら回収して回復 (経済↔生存の結節点)
                if (desperate) {
                    if (!this._desperateLogged) { logMessage('SENSOR: 敵艦が損傷により後退 — 回復行動に移行。', 'system-msg'); this._desperateLogged = true; }
                    for (const n of resourceNodes) {
                        if (!n.active) continue;
                        if (Math.hypot(n.x - this.x, n.y - this.y) < this.radius + 70) {
                            n.active = false; n.emFlashTimer = 120;
                            this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.30);
                            logMessage('SENSOR: 敵艦がノードで損傷を修復した。', 'warning-msg');
                            break;
                        }
                    }
                } else { this._desperateLogged = false; }

                // 撤退中は射撃より離脱を優先。たまに振り向きざまに撃つ(fighting retreat)。
                const _wantFire = distToBelief < fireRange && this.fireCooldown <= 0 && this._weaponJamTimer <= 0 && player && player.hp > 0 && (!desperate || Math.random() < 0.25);
                if (_wantFire) {
                    const ta = Math.atan2(aimY - this.y, aimX - this.x);
                    let diff = ta - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    const _eTR_cb = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                    this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_cb);
                    // 艦種別の武器選択 (序盤/終盤) + 既存の行動推定適応
                    let wType = gameState.sector <= 3 ? prof.weaponEarly : prof.weaponLate;
                    // 適応: プレイヤーが実弾近接戦と推定 & 自分も近接武器なら長射程へ (アウトレンジ)
                    if (this.predictedBehavior === 'kinetic' && wType === 'kinetic') wType = 'missile';
                    this.weaponType = wType;
                    // kinetic は射程800しか飛ばないので、それを超える間合いでは強制的にミサイルへ
                    if (wType === 'kinetic' && distToBelief > 760) wType = 'missile';
                    // 攻撃型は3連装、それ以外は単発。kinetic時のみ弾幕、ミサイル/ビームは単発。
                    const shots = (wType === 'kinetic') ? prof.burst : 1;
                    const baseRange = Math.max(1, Math.hypot(aimX - this.x, aimY - this.y));
                    for (let s = 0; s < shots; s++) {
                        const spread = shots > 1 ? (s - (shots - 1) / 2) * 0.06 : 0; // 約3.4°/発
                        const sa = ta + spread;
                        const tgX = this.x + Math.cos(sa) * baseRange;
                        const tgY = this.y + Math.sin(sa) * baseRange;
                        const aimTarget = { x: tgX, y: tgY, hp: 1 };
                        let projTarget = aimTarget;
                        if (wType === 'beam') {
                            // beamは即着弾。照準点が実プレイヤーに十分近い時だけ実弾化、外れなら空撃ち(無害)。
                            const missDist = Math.hypot(player.x - tgX, player.y - tgY);
                            projTarget = (missDist < player.radius * 2.2) ? player : aimTarget;
                        }
                        _beamShooter = this; // beam即着弾用: 発射元を渡す (奇襲被弾の対称判定)
                        const _eproj = new Projectile(this.x, this.y, projTarget, false, wType, this.upgDmg || 1);
                        _eproj.owner = this; // kinetic/missile着弾時の奇襲被弾判定用
                        _beamShooter = null;
                        projectiles.push(_eproj);
                    }
                    playSound('shoot');
                    this.fireCooldown = prof.fireCD * (this.upgFireCD || 1);
                    this.fireFlashTimer = 120;
                    this.visible = true;
                    const sigLabel = { kinetic: '銃口炎[光学]', missile: '推進炎[熱源+EM]', beam: 'EMパルス[EM+光学]' };
                    effects.push({ x: this.x, y: this.y, r: 0, maxR: 200, a: 0.9, c: '#ff4d4d', type: 'circle' });
                    logMessage(`WARNING: 敵艦発砲 — ${sigLabel[wType]||''}シグネチャ捕捉。`, 'warning-msg');
                    this.postFireCooldown = 280;
                } else {
                    // 艦種別の機動 (ドクトリン) を性格とHP状況で変調。
                    const pbv = this.predictedBehavior;
                    // 性格: 攻撃的ほど間合いを詰め・近接でも逃げない / killInstinctでさらに踏み込む
                    let standoffDist = fireRange * prof.standoff * (1.25 - pers.aggression * 0.5);
                    let fleeCloseFrac = prof.fleeClose * (1.1 - pers.aggression * 0.4);
                    if (killInstinct) { standoffDist *= 0.5; fleeCloseFrac *= 0.35; }
                    let moveAngle = Math.atan2(aimY - this.y, aimX - this.x); // 既定: 信念点へ前進
                    let doMove = false;
                    if (desperate) {
                        // 損傷大: 近くにノードがあれば回復に向かう、なければ獲物から離脱
                        const nn = nearestActiveNode(this.x, this.y, 7000);
                        moveAngle = nn ? Math.atan2(nn.y - this.y, nn.x - this.x) : Math.atan2(this.y - aimY, this.x - aimX);
                        doMove = true;
                    } else if (distToBelief > standoffDist) {
                        doMove = true;                                                                // 遠い → 接近
                    } else if (fleeCloseFrac > 0 && distToBelief < fireRange * fleeCloseFrac) {
                        moveAngle += Math.PI; doMove = true;                                          // 近すぎ(脆弱) → 全力離脱
                    } else if (prof.kite && distToBelief < standoffDist * 0.8) {
                        moveAngle += Math.PI; doMove = true;                                          // 間合い詰められた → 下がる
                    }
                    // 側方ストレイフ (潜航型ほど強い)。間合いを保つ局面でのみ実施 — 大きく離れている時は
                    // 直進で詰める(さもないと遠方を周回するだけで近寄れない)。撤退中・キル踏込時は抑制。
                    const _nearHold = distToBelief <= standoffDist * 1.3;
                    if (!desperate && prof.strafe > 0 && _nearHold) {
                        moveAngle += this._dodgeDir * (Math.PI / 2) * prof.strafe * (killInstinct ? 0.4 : 1);
                        doMove = true;
                    }
                    // ビームチャージ推定: 側方回避を上乗せ
                    if (!desperate && pbv === 'charging') {
                        moveAngle += this._dodgeDir * (Math.PI / 2.5);
                        doMove = true;
                    }
                    if (doMove) {
                        let diff = moveAngle - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        const _eTR_cm = (ENEMY_TURN_RATES[this.type] || 0.035) * gameSpeedFactor;
                        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), _eTR_cm);
                        const _turnFrac_cm = Math.abs(diff) / Math.PI;
                        const _spdMult_cm = 1 - Math.min(0.6, _turnFrac_cm * 0.7);
                        this.x += Math.cos(this.angle) * this.speed * _spdMult_cm;
                        this.y += Math.sin(this.angle) * this.speed * _spdMult_cm;
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
                const _huntProf = ENEMY_COMBAT[this.type] || ENEMY_COMBAT.destroyer;
                // アクティブソナー探信: 接触が薄い時、探信音を放って正確な位置を得ようとする。
                // 隠密気質の個体ほど探信を控える (自分の方位を晒すため)。fighterは探信装置なし。
                if (this._pingCD === undefined) this._pingCD = ENEMY_PING_CD_MIN * 0.5;
                this._pingCD -= gameSpeedFactor;
                if (this._pingCD <= 0 && this.contactFreshness < 0.45 && this.type !== 'fighter') {
                    this._pingCD = ENEMY_PING_CD_MIN + Math.random() * ENEMY_PING_CD_VAR
                                 + ((this.personality && this.personality.stealth) || 0.3) * 900;
                    firePingFromEnemy(this);
                }
                this.speed = Math.min(1.6, 0.8 + gameState.sector * 0.06) * _huntProf.speedMult * (this.upgSpeed || 1) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT;
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
                        const _turnFrac_hn = Math.abs(diff) / Math.PI;
                        const _spdMult_hn = 1 - Math.min(0.5, _turnFrac_hn * 0.6);
                        this.x += Math.cos(this.angle) * this.speed * _spdMult_hn;
                        this.y += Math.sin(this.angle) * this.speed * _spdMult_hn;
                    } else {
                        this.huntTarget = null;
                    }
                }
                if (this.huntTimer <= 0 && !playerSigDetected) { this.aiState = 'lurking'; this.lurking = true; this.detectionState = 'unaware'; }

            } else if (this.aiState === 'gathering') {
                this.lurking = false;
                this.speed = Math.min(1.2, 0.7 + gameState.sector * 0.05) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT;
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
                        // ノード1個ごとに小回復。2個ごとに性格重み付けで自己強化 (放置すると相手が育つ)。
                        this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.06);
                        if (this.resourcePoints % 2 === 0) applyEnemyUpgrade(this);
                        this.gatherTarget = null;
                        this.aiState = 'lurking'; this.lurking = true;
                    }
                }

            } else {
                // lurking (default)
                this.lurking = true;
                const _pers = this.personality || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
                // 残り香(contactFreshness)がある間は獲物を追って徘徊。攻撃的=速い追跡 / 隠密=低速で忍び寄る(低シグネチャ)。
                const _hasScent = this.playerLastKnownPos && this.contactFreshness > 0.04;
                this.speed = (_hasScent ? ENEMY_STALK_SPEED * (0.6 + _pers.aggression * 0.6) * (1 - _pers.stealth * 0.4) : 0.08) * MOVE_SPEED_MULT;
                const activeNodes = resourceNodes.filter(n => n.active);
                if (this.state === 'idle') {
                    if (_hasScent && Math.random() < 0.05) {
                        // 残り香あり: 最終既知位置周辺を集中捜索しながらじわじわ詰める(獲物がヒッグス雲に潜伏と推定)
                        const _lkp = this.playerLastKnownPos;
                        // 速度ベクトル方向へ少しリード(逃げた先を読む)
                        const _leadX = _lkp.x + (_lkp.vx || 0) * 40;
                        const _leadY = _lkp.y + (_lkp.vy || 0) * 40;
                        const searchSpot = findHidingSpot(_leadX, _leadY, 3000);
                        this.setTarget(searchSpot.x, searchSpot.y);
                    } else if (distressBeacon && this.type !== 'fighter' && Math.random() < (0.010 + _pers.greed * 0.020)) {
                        // 遭難信号へ向かう (貪欲な個体ほど食いつく) — プレイヤーと同じ海域へ収束
                        this.setTarget(distressBeacon.x, distressBeacon.y);
                    } else if (activeNodes.length > 0 && Math.random() < (0.0012 + _pers.greed * 0.012)) {
                        // 貪欲な個体ほど積極的にノードを奪取しに行く (性格による行動分岐)
                        this.aiState = 'gathering';
                        logMessage('SENSOR: 敵艦がリソース収集パターンに移行。', 'system-msg');
                    } else if (this.predictedBehavior === 'silent' && Math.random() < 0.014) {
                        // silent推定（接触喪失）: 最終既知位置周辺のヒッグス濃密域を集中捜索
                        const _lkp = this.playerLastKnownPos;
                        const _searchCX = (_lkp && this.contactFreshness > 0.05) ? _lkp.x : this.x;
                        const _searchCY = (_lkp && this.contactFreshness > 0.05) ? _lkp.y : this.y;
                        const searchSpot = findHidingSpot(_searchCX, _searchCY, 4500);
                        this.setTarget(searchSpot.x, searchSpot.y);
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
            // 機関損傷: 冷却系破損で熱漏洩 — 損傷した獲物は熱で追える
            if (this._sysEngineTimer > 0) this.heatSig = Math.min(1.0, this.heatSig + 0.35);
            // 手負いの獲物: HP20%未満で冷却材漏洩 — 熱痕跡を引きずる (追撃戦の演出)
            if (this.hp / this.maxHp < WOUNDED_HP_FRAC) {
                this.heatSig = Math.max(this.heatSig, WOUNDED_HEAT_FLOOR);
                if (!this._woundedLogged) { this._woundedLogged = true; logMessage('SENSOR: 敵艦から冷却材漏出を検知 — 熱痕跡で追い詰めろ', 'system-msg'); }
                if (Math.random() < 0.10 && heatTrails.length < 600) heatTrails.push({ x: this.x, y: this.y, intensity: 0.7, life: 1.0, decay: 0.0015 });
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
                // ウェイクを残す (サージ中は増幅 — 動けば痕跡がくっきり残る)
                if (higgsAtThisShip > 0.15 && spd > 0.2) {
                    const _wAmp = surgePhase === 'active' ? SURGE_WAKE_MULT : 1;
                    higgsWakes.push({ x: this.x, y: this.y, intensity: Math.min(1, higgsAtThisShip * 0.8 * _wAmp), life: 1.0, decay: 0.0022 });
                }
                // §3-12 敵 HEAT trail (高速移動時の熱排気跡)
                if (this.heatSig > 0.08 && spd > 0.3 && Math.random() < 0.18) {
                    if (heatTrails.length < 600) heatTrails.push({ x: this.x, y: this.y, intensity: this.heatSig * 0.85, life: 1.0, decay: 0.0015 });
                }
                // §3-12 敵 EM trail (AI処理/ミサイル誘導放射)
                if (this.emSig > 0.12 && Math.random() < 0.12) {
                    if (emTrails.length < 600) emTrails.push({ x: this.x, y: this.y, intensity: this.emSig * 0.9, life: 1.0, decay: 0.0025 });
                }
            } else {
                // 通常航行: 移動していればヒッグス濃度×速度でウェイクシグネチャが立つ (仕様: 高速移動→HIGGS◎)
                this.higgsSig = Math.max(this.higgsSig - 0.02, Math.min(1.0, higgsAtThisShip * spd * 1.2));
            }

            // 痕跡 (2026-07-11): 通常航行でもエンジン痕跡を航路上に残す — 「解析で痕跡を辿り追い詰める」狩りの核。
            // decay指定で武器エフェクト由来のtrailより長寿命 (熱≈11s / ウェイク≈7.5s / EM≈6.7s)。
            // 可視化は従来どおり「対応センサー選択中 + 自機センサーレンジ内」のみ = どこからでも見える訳ではない。
            if (this.postFireCooldown === 0 && spd > 0.25) {
                if (higgsAtThisShip > 0.12 && Math.random() < 0.22) {
                    const _wAmp2 = surgePhase === 'active' ? SURGE_WAKE_MULT : 1;
                    if (higgsWakes.length < 800) higgsWakes.push({ x: this.x, y: this.y, intensity: Math.min(1, higgsAtThisShip * 0.7 * _wAmp2), life: 1.0, decay: 0.0022 });
                }
                if (this.heatSig > 0.10 && Math.random() < 0.15) {
                    if (heatTrails.length < 600) heatTrails.push({ x: this.x, y: this.y, intensity: this.heatSig * 0.8, life: 1.0, decay: 0.0015 });
                }
                if (this.emSig > 0.15 && Math.random() < 0.08) {
                    if (emTrails.length < 600) emTrails.push({ x: this.x, y: this.y, intensity: this.emSig * 0.85, life: 1.0, decay: 0.0025 });
                }
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
                // HP bar below sprite (local space, counter-rotate for axis-aligned bar)
                ctx.globalCompositeOperation = 'source-over';
                const _hpRatio = Math.max(0, this.hp / this.maxHp);
                const _barA = isFlashing ? 1.0 : (this.visible ? 0.85 : (this.contactAccuracy > 0.4 ? Math.min(1, this.contactLife / 60) * this.contactAccuracy : 0));
                if (_barA > 0.05) {
                    ctx.save();
                    ctx.rotate(-this.angle);
                    const _bW = 36, _bH = 5, _bY = this.radius * 3.2 + 4;
                    ctx.globalAlpha = _barA;
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    ctx.fillRect(-_bW / 2, _bY, _bW, _bH);
                    ctx.fillStyle = _hpRatio < 0.3 ? '#ff4400' : _hpRatio < 0.6 ? '#ffaa00' : '#44ff88';
                    ctx.fillRect(-_bW / 2, _bY, _bW * _hpRatio, _bH);
                    ctx.globalAlpha = 1;
                    ctx.restore();
                }
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
            // §3-4残: ジャミング範囲可視リング (stealth専用 — burst=琥珀点線 / cont=紫点線)
            if (gameState.shipType === 'stealth') {
                if (jamBurst > 0) {
                    const p = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
                    ctx.globalAlpha = 0.18 + 0.12 * p;
                    ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 2;
                    ctx.setLineDash([30, 20]);
                    ctx.beginPath(); ctx.arc(0, 0, JAM_BURST_RADIUS, 0, Math.PI * 2); ctx.stroke();
                    ctx.setLineDash([]);
                }
                if (jamCont) {
                    ctx.globalAlpha = 0.15;
                    ctx.strokeStyle = '#aa66ff'; ctx.lineWidth = 1.5;
                    ctx.setLineDash([20, 14]);
                    ctx.beginPath(); ctx.arc(0, 0, JAM_CONT_RADIUS, 0, Math.PI * 2); ctx.stroke();
                    ctx.setLineDash([]);
                }
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

            // HP バー (常時: visible時は常に表示、コンタクト精度が高い時も表示)
            if (this.visible || isFlashing || this.contactAccuracy > 0.6) {
                const a = isFlashing ? 1.0 : (this.visible ? 0.85 : Math.min(1, this.contactLife / 60) * this.contactAccuracy);
                ctx.globalAlpha = a;
                const _hpR2 = Math.max(0, this.hp / this.maxHp);
                const _bY2 = dispY + this.radius * 3.2 + 4;
                ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(dispX - 18, _bY2, 36, 5);
                ctx.fillStyle = _hpR2 < 0.3 ? '#ff4400' : _hpR2 < 0.6 ? '#ffaa00' : '#44ff88';
                ctx.fillRect(dispX - 18, _bY2, 36 * _hpR2, 5);
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
        if (!(this.contactLife > 0)) return;
        const dispX = this.displayX, dispY = this.displayY;
        const uncertaintyR = Math.max(20, (1 - this.contactAccuracy) * 400);
        const acc = this.contactAccuracy;
        const col = acc > 0.7 ? '0,255,170' : (acc > 0.4 ? '255,170,0' : '255,77,77');
        const lifeA = Math.min(1, this.contactLife / 60) * 0.4;

        // ソナーエコー・ゴースト: コンタクト中の反応点をヒッグス雲の手前に描く。
        // 有視界(inVision)なら実スプライトが見えているので重ねない。雲越しの反応を「見える成果」にする。
        if (!this.inVision) {
            const _gz = 1 / camera.zoom;
            const _ga = Math.min(1, this.contactLife / 90) * (0.35 + acc * 0.55);
            ctx.save();
            ctx.translate(dispX, dispY);
            ctx.rotate(this.angle);
            ctx.globalAlpha = _ga;
            ctx.strokeStyle = `rgba(${col},0.95)`;
            ctx.fillStyle = `rgba(${col},0.30)`;
            ctx.lineWidth = 1.5 * _gz;
            const _gr = Math.max(this.radius * 1.6, 10 * _gz);
            ctx.beginPath();
            ctx.moveTo(_gr, 0);
            ctx.lineTo(-_gr * 0.7, -_gr * 0.6);
            ctx.lineTo(-_gr * 0.4, 0);
            ctx.lineTo(-_gr * 0.7, _gr * 0.6);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.restore();
            ctx.globalAlpha = 1;
        }

        if (!(acc < 0.95)) return; // 高精度コンタクトは不確実性サークル省略 (ゴーストのみ)
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
        } else if (ef.type === 'sonar' || ef.type === 'sonar-fill' || ef.type === 'sonar-boundary') {
            // ソナー系エフェクトはヒッグスフォグより手前に描く: updateDrawSonarEffects() で更新+描画
            continue;
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

// ソナー系エフェクト専用パス — フォグ/ヒッグス層の「手前」に描画する (updateDrawEffectsから分離)。
// 探信音の波紋・充満・境界リングはプレイヤーの索敵成果なので、ヒッグス雲に隠されると視認できず意味を失う。
function updateDrawSonarEffects(ctx) {
    for (let i = effects.length - 1; i >= 0; i--) {
        const ef = effects[i];
        if (ef.type === 'sonar') {
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
        }
    }
}

let _logDedup = {};
function logMessage(text, className) {
    const log = document.getElementById('message-log');
    if (!log) return;
    // 重複抑制: 同一メッセージは4秒間再表示しない (PASSIVEスパムで重要イベントが流れるのを防ぐ)
    const _now = Date.now();
    if (_logDedup[text] && _now - _logDedup[text] < 4000) return;
    let _ldKeys = 0;
    for (const _k in _logDedup) { if (++_ldKeys > 60) { _logDedup = {}; break; } }
    _logDedup[text] = _now;
    const msg = document.createElement('div');
    msg.className = `message ${className}`;
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    msg.textContent = `[${ts}] ${text}`;
    log.appendChild(msg);
    // 最大20件
    while (log.children.length > 20) log.removeChild(log.firstChild);
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
    triangulationResult = null; _prevTrigResult = null; triangulationVelocity = null;
    lockedSignalId = null; _contactLabels = {}; _contactLabelNext = 1; _signalAnalysis = {};
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
    // 円内ランダム配置ヘルパー (uniformなdisk sampling)
    const _rndCirc = (maxR) => {
        const r = Math.sqrt(Math.random()) * maxR;
        const a = Math.random() * Math.PI * 2;
        return { x: MAP_CX + r * Math.cos(a), y: MAP_CY + r * Math.sin(a) };
    };
    // 均等角度セクターで配置するヘルパー (地形ブロブの偏り防止)
    const _rndSector = (i, n, maxR) => {
        const a = (i + Math.random()) * (Math.PI * 2 / n);
        const r = Math.sqrt(0.1 + Math.random() * 0.9) * maxR;
        return { x: MAP_CX + r * Math.cos(a), y: MAP_CY + r * Math.sin(a) };
    };

    // 星雲色: 紫・青・赤紫・緑青・琥珀
    const mistColors = ['70,20,140','25,60,160','130,20,70','10,90,110','80,50,10','15,110,80'];
    // ヒッグス濃度設計: 20-50%が60%/0%が10%/51-90%が20%/100%が10%
    // Layer1: 中密度ベース (20-50%, マップ面積60%をカバー)
    for (let i = 0; i < 20; i++) {
        const p = _rndCirc(MAP_RADIUS * 0.90);
        bgMist.push({ ...p, r: Math.random() * 3000 + 4500, color: mistColors[i % mistColors.length], density: 0.20 + Math.random() * 0.25, phase: Math.random() * Math.PI * 2 });
    }
    // Layer2: 高密度 (51-90%, 20%カバー)
    for (let i = 0; i < 7; i++) {
        const p = _rndCirc(MAP_RADIUS * 0.72);
        bgMist.push({ ...p, r: Math.random() * 1800 + 2400, color: mistColors[i % mistColors.length], density: 0.48 + Math.random() * 0.35, phase: Math.random() * Math.PI * 2 });
    }
    // Layer3: 超高密度スポット (100%, 10%カバー)
    for (let i = 0; i < 4; i++) {
        const p = _rndCirc(MAP_RADIUS * 0.65);
        bgMist.push({ ...p, r: Math.random() * 1100 + 900, color: mistColors[i % mistColors.length], density: 0.85 + Math.random() * 0.15, phase: Math.random() * Math.PI * 2 });
    }
    // デブリ帯 (岩礁帯): 2倍・均等分散 (旧10→20)
    for (let i = 0; i < 20; i++) {
        const p = _rndSector(i, 20, MAP_RADIUS * 0.90);
        debrisField.push({ ...p, r: Math.random() * 3500 + 1800, density: Math.random() * 0.5 + 0.25 });
    }
    // 磁気嵐帯: 2倍・均等分散 (旧6→12)
    for (let i = 0; i < 12; i++) {
        const p = _rndSector(i, 12, MAP_RADIUS * 0.85);
        stormField.push({ ...p, r: Math.random() * 4000 + 2200, density: Math.random() * 0.55 + 0.25 });
    }
    // 熱雲(プラズマ雲): 2倍・均等分散 (旧7→14)
    for (let i = 0; i < 14; i++) {
        const p = _rndSector(i, 14, MAP_RADIUS * 0.88);
        thermalField.push({ ...p, r: Math.random() * 3800 + 1600, density: Math.random() * 0.50 + 0.20 });
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
            // ベース(岩礁の影) + 岩片の点描 — 濃度高いほど視認しやすく
            const g = dcx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0, `rgba(160,155,140,${(0.22 * m.density).toFixed(3)})`);
            g.addColorStop(0.6, `rgba(100,98,88,${(0.12 * m.density).toFixed(3)})`);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            dcx.fillStyle = g;
            dcx.beginPath(); dcx.arc(sx, sy, sr, 0, Math.PI * 2); dcx.fill();
            const rocks = Math.floor(sr * sr * 0.0016 * m.density);
            for (let k = 0; k < rocks; k++) {
                const a = drng() * Math.PI * 2;
                const rr = Math.sqrt(drng()) * sr;
                const px = sx + Math.cos(a) * rr, py = sy + Math.sin(a) * rr;
                const sz = 0.6 + drng() * 1.8;
                const sh = 90 + (drng() * 80) | 0;
                dcx.globalAlpha = 0.35 + drng() * 0.55;
                dcx.fillStyle = `rgb(${sh},${sh - 4},${sh - 14})`;
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
            const a = 0.25 + m.density * 0.50; // 濃度連動: 0.38-0.69
            const g = scx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0,    `rgba(160,60,240,${a.toFixed(3)})`);
            g.addColorStop(0.4,  `rgba(80,130,255,${(a * 0.55).toFixed(3)})`);
            g.addColorStop(0.75, `rgba(40,80,180,${(a * 0.20).toFixed(3)})`);
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
            const a = 0.22 + m.density * 0.52; // 濃度連動: 0.33-0.58
            const g = tcx.createRadialGradient(sx, sy, 0, sx, sy, sr);
            g.addColorStop(0,    `rgba(255,90,10,${a.toFixed(3)})`);
            g.addColorStop(0.4,  `rgba(240,140,0,${(a * 0.55).toFixed(3)})`);
            g.addColorStop(0.75, `rgba(180,60,0,${(a * 0.20).toFixed(3)})`);
            g.addColorStop(1,    'rgba(0,0,0,0)');
            tcx.fillStyle = g;
            tcx.beginPath(); tcx.arc(sx, sy, sr, 0, Math.PI * 2); tcx.fill();
        });
        thermalCanvas = tc;
    }, 50);

    // 敵を円形マップ内のヒッグス濃度の高い場所に配置。
    // 距離はパッシブ探知圏(11000)のすぐ外側 13000〜17000: 数分航行して微弱信号を拾い始める
    // 「狩りの立ち上がり」を1〜2分に圧縮する (旧: 10000〜33000で接敵まで最大8分の空白があった)
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist  = ENEMY_SPAWN_MIN + Math.random() * ENEMY_SPAWN_VAR;
    const spawnCenterX = MAP_CX + Math.cos(spawnAngle) * spawnDist;
    const spawnCenterY = MAP_CY + Math.sin(spawnAngle) * spawnDist;
    const bossSpawn = findHidingSpot(spawnCenterX, spawnCenterY, 2000);
    // 敵艦種: ロビー選択(assault/stealth/carrier)→内部型にマップ
    const _enemyTypeMap = { assault: 'destroyer', stealth: 'corvette', carrier: 'carrier' };
    const boss = new Ship(bossSpawn.x, bossSpawn.y, false, _enemyTypeMap[gameState.enemyType] || 'destroyer');
    // セクターが深いほど高HP・高速化。艦種ラベル(攻撃型=高耐久 / 潜航型=脆い / 空母型=中)とHPを整合(2026-06-23)
    const _bossHpMult = { destroyer: 2.4, corvette: 0.95, carrier: 1.7 };
    boss.maxHp = Math.round((500 + gameState.sector * 200) * (_bossHpMult[boss.type] || 1));
    boss.hp = boss.maxHp;
    boss.lurking = true;
    enemies.push(boss);
    // S&Dモード: コロニーノードを多く配置 (ハック目標)
    const colonyCount = gameState.mode === 'sd' ? 5 : 3;
    for (let i = 0; i < colonyCount; i++) {
        const a = (i / colonyCount) * Math.PI * 2 + Math.random() * 0.8;
        const r = 5000 + Math.random() * (MAP_RADIUS - 7000);
        const col = new Structure(MAP_CX + Math.cos(a) * r, MAP_CY + Math.sin(a) * r, 'colony');
        structures.push(col);
    }
    for (let i = 0; i < 5; i++) {
        const sp = clampToMapCircle(
            MAP_CX + (Math.random() - 0.5) * MAP_RADIUS * 1.6,
            MAP_CY + (Math.random() - 0.5) * MAP_RADIUS * 1.6
        );
        const der = new Structure(sp.x, sp.y, 'derelict');
        structures.push(der);
    }
    for (let i = 0; i < 3; i++) {
        const a2 = Math.random() * Math.PI * 2, r2 = 4000 + Math.random() * (MAP_RADIUS - 6000);
        stations.push(new Station(MAP_CX + Math.cos(a2) * r2, MAP_CY + Math.sin(a2) * r2));
    }

    // リソースノード: 5〜8個 (ヒッグス雲内を優先)。
    // 6割は自機と敵スポーンを結ぶ「争奪帯」に置く — 双方の経済動線が同じ海域で交差し、
    // ノードの奪い合い(敵はノードで自己強化する)が自然に接敵と情報戦を生む。
    const nodeCount = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < nodeCount; i++) {
        let ncx, ncy;
        if (i < Math.ceil(nodeCount * 0.6)) {
            const t2 = 0.30 + Math.random() * 0.45; // 回廊の中間帯
            const ja = Math.random() * Math.PI * 2, jr = Math.random() * 3500;
            ncx = MAP_CX + (bossSpawn.x - MAP_CX) * t2 + Math.cos(ja) * jr;
            ncy = MAP_CY + (bossSpawn.y - MAP_CY) * t2 + Math.sin(ja) * jr;
        } else {
            const na = Math.random() * Math.PI * 2, nr = Math.random() * (MAP_RADIUS - 3000);
            ncx = MAP_CX + Math.cos(na) * nr;
            ncy = MAP_CY + Math.sin(na) * nr;
        }
        const spot = findHidingSpot(ncx, ncy, 2000);
        resourceNodes.push({ x: spot.x, y: spot.y, active: true, emFlashTimer: 0, identified: false });
    }

    // 新システムのリセット (露出度・ヒッグスサージ・静粛航行・遭難信号)
    playerExposureLevel = 0; _exposureHeartbeatTimer = 0;
    surgePhase = 'none'; surgePhaseTimer = 0;
    surgeNextTimer = SURGE_INTERVAL_MIN + Math.floor(Math.random() * SURGE_INTERVAL_VAR);
    _logDedup = {};
    silentRunning = false; _updateSilentBtn();
    distressBeacon = null;
    distressNextTimer = 4200 + Math.floor(Math.random() * 1800);
    isBottomed = false; nearMissActive = false; _commsInterceptCD = 0;
    huntStats = { startFrame: _frameCount, firstContact: -1, ambushes: 0, crits: 0, timesEngaged: 0, dmgDealt: 0, dmgTaken: 0, pings: 0 };
    playerHitDirs = [];
    // 前任艦の残骸: 前回撃沈されていれば争奪帯の途中に漂う (回収でサルベージ)
    playerWreckObj = null;
    if (gameState.wreckSalvage > 0) {
        const _wt = 0.35 + Math.random() * 0.30;
        const _wja = Math.random() * Math.PI * 2, _wjr = Math.random() * 2500;
        const _wSpot = findHidingSpot(
            MAP_CX + (bossSpawn.x - MAP_CX) * _wt + Math.cos(_wja) * _wjr,
            MAP_CY + (bossSpawn.y - MAP_CY) * _wt + Math.sin(_wja) * _wjr, 1500);
        playerWreckObj = { x: _wSpot.x, y: _wSpot.y, value: gameState.wreckSalvage };
        logMessage('SIGNAL: 前任艦の遭難ビーコンを検知 — 残骸から物資をサルベージ可能 (WRECKマーカー)', 'system-msg');
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

function updateLandmarkBanner() { /* ランドマーク距離表示廃止 */ }

function startGame(shipType) {
    gameState.shipType = shipType;
    // 敵艦種: ロビーで選択された値をセット
    const _selEt = document.querySelector('.enemy-select-btn.active')?.dataset?.type || 'assault';
    gameState.enemyType = _selEt;
    // 第5弾: 戦歴 (出撃回数) + 環境音開始
    if (gameState.career) gameState.career.sorties++;
    startAmbient();
    document.getElementById('ship-select-lobby').classList.add('hidden');
    // 潜航型専用ジャミングボタンの表示制御
    document.querySelectorAll('.jam-btn').forEach(b => { b.style.display = shipType === 'stealth' ? '' : 'none'; });
    // 空母型専用ドローン展開ボタンの表示制御 (§3-6/§3-7)
    document.querySelectorAll('.drone-btn').forEach(b => { b.style.display = shipType === 'carrier' ? '' : 'none'; });
    // 全艦種共通ボタン (ミサイルモード・修復) — ゲーム開始後に表示
    document.querySelectorAll('.common-btn').forEach(b => { b.style.display = ''; });
    // 修復/建設状態をリセット
    repairActive = false;
    buildingTimer = 0;
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
        btn.style.borderColor = '#ff4444';
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
    const menuBtn = document.getElementById('menu-btn');
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
    if (valEl) valEl.textContent = `${e.target.value}%`;
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
// パッシブアンテナ常時検知チェック (敵 + 地形 + 構造物 + ノード)
// ============================================================
function checkPassiveDetection() {
    passiveCheckTimer++;
    if (passiveCheckTimer < 60) return; // 1秒ごとに1計測
    passiveCheckTimer = 0;
    if (!player || player.hp <= 0) return;

    // ソース特定チェック (2026-07-11 刷新)。コンタクト0件の早期returnより前に置く=蓄積済み解析値で常に評価:
    // - ランドマーク/地形効果 = 静止発信源 → 「早い段階」(avg>18%) で特定。特定と同時にロック解除し
    //   「次のシグネチャへ切替」をログでガイド (追跡ルーティンの判断タイミングを明確化)
    // - 敵艦などの機動反応 = avg>55% で「機動反応=攻撃目標候補」と分類通知 (ロックは維持して追跡続行)
    if (lockedSignalId && _signalAnalysis[lockedSignalId]) {
        const _idSa = _signalAnalysis[lockedSignalId];
        const _idAvg = (_idSa.dirAnalysis + _idSa.triParam) / 2;
        // ─ 静止発信源 (ランドマーク・地形効果): 早期特定 ─
        if (_idAvg > ID_THRESHOLD_STATIC && !_idSa.identified) {
            let _idLabel = null;
            let m;
            if ((m = lockedSignalId.match(/^colony-(\d+)$/)) || (m = lockedSignalId.match(/^derelict-(\d+)$/))) {
                const s = structures[+m[1]];
                if (s) { s.identified = true; _idLabel = s.type === 'colony' ? 'コロニーノード (ランドマーク)' : 'ディレリクト (ランドマーク)'; }
            } else if ((m = lockedSignalId.match(/^node-(\d+)$/))) {
                const n = resourceNodes[+m[1]];
                if (n) { n.identified = true; _idLabel = 'HIGGSクリスタルノード (ランドマーク)'; }
            } else if ((m = lockedSignalId.match(/^thermal-(\d+)$/))) {
                const f = thermalField[+m[1]];
                if (f) { f.identified = true; _idLabel = '熱雲帯 (地形効果)'; }
            } else if ((m = lockedSignalId.match(/^storm-(\d+)$/))) {
                const f = stormField[+m[1]];
                if (f) { f.identified = true; _idLabel = '磁気嵐帯 (地形効果)'; }
            } else if ((m = lockedSignalId.match(/^higgs-hot-(\d+)$/))) {
                const f = bgMist[+m[1]];
                if (f) { f.identified = true; _idLabel = 'ヒッグス高濃度域 (地形効果)'; }
            }
            if (_idLabel) {
                _idSa.identified = true;
                logMessage(`ANALYSIS: 発信源特定 — ${_idLabel}。マップに恒久記録`, 'system-msg');
                logMessage('TRACKING: 解析完了・ロック解除 — 次のシグネチャをロックオンせよ', 'warning-msg');
                playSound('ui');
                lockedSignalId = null;
            }
        }
        // ─ 機動反応 (敵艦・ドローン・デコイ等 = ランドマーク以外): 分類通知のみ。追跡は続く ─
        if (lockedSignalId && _idAvg > ID_THRESHOLD_MOBILE && !_idSa.classified && /^(e|decoy|drone)-/.test(lockedSignalId)) {
            _idSa.classified = true;
            logMessage('ANALYSIS: 発信源特定 — 機動反応。ランドマーク/地形ではない — 攻撃目標候補だ', 'warning-msg');
            playSound('ui');
        }
    }

    const sc = sensorConfig[currentSensor];
    const thr = sc.threshold;
    let range = Math.max(effectiveRadarRange * 10, 11000); // パッシブ探知の下限を拡張(8000→11000): 接近フェーズで早めに微弱方位を拾い「空白の航行」を緊張に変える
    // ヒッグスサージ: パッシブ探知も対称に縮退/ブースト
    if (surgePhase === 'active') range *= SURGE_DETECT_MULT;
    else if (surgePhase === 'after') range *= SURGE_CLARITY_MULT;
    // センサー損傷: 探知レンジ激減
    if (player._sysSensorTimer > 0) range *= 0.35;
    const sensorPrec = 0.45 + (genAlloc.sensors / 100) * 0.55;
    const colorRgb = sc.r;
    const terrRange = range * 1.4; // 地形は広範囲から放射

    // 全コンタクト (敵 + 地形 + 構造物 + ノード) を統一フォーマットで収集
    const allContacts = [];

    // ─ 敵艦シグネチャ ─
    enemies.forEach((e, ei) => {
        if (e.hp <= 0) return;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        const hPath = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
        const distAtten = Math.max(0, 1 - dist / range);
        const sig = sc.sig(e) * distAtten * (1 - hPath * sc.higgsMod);
        if (sig > thr * 0.5) {
            allContacts.push({ x: e.x, y: e.y, sig, angle: Math.atan2(e.y - player.y, e.x - player.x), sourceId: 'e-' + ei });
            if (huntStats && huntStats.firstContact < 0) huntStats.firstContact = _frameCount - huntStats.startFrame; // 戦闘詳報: 初接触
        }
    });

    // ─ 熱雲 → HEATセンサー ─
    if (currentSensor === 'heat') {
        let best = null;
        thermalField.forEach((tf, ti) => {
            const dist = Math.max(0, Math.hypot(tf.x - player.x, tf.y - player.y) - tf.r * 0.4);
            if (dist > terrRange) return;
            const sig = (tf.density || 0.4) * Math.max(0, 1 - dist / terrRange) * 0.80;
            if (!best || sig > best.sig)
                best = { x: tf.x, y: tf.y, sig, angle: Math.atan2(tf.y - player.y, tf.x - player.x), sourceId: 'thermal-' + ti };
        });
        if (best && best.sig > thr * 0.25) allContacts.push(best);
    }

    // ─ 磁気嵐 → EMセンサー ─
    if (currentSensor === 'em') {
        let best = null;
        stormField.forEach((sf, si) => {
            const dist = Math.max(0, Math.hypot(sf.x - player.x, sf.y - player.y) - sf.r * 0.4);
            if (dist > terrRange) return;
            const sig = sf.density * Math.max(0, 1 - dist / terrRange) * 0.75;
            if (!best || sig > best.sig)
                best = { x: sf.x, y: sf.y, sig, angle: Math.atan2(sf.y - player.y, sf.x - player.x), sourceId: 'storm-' + si };
        });
        if (best && best.sig > thr * 0.25) allContacts.push(best);
    }

    // ─ ヒッグス高密度スポット(density≥0.78) → HIGGSセンサー ─
    if (currentSensor === 'higgs') {
        let best = null;
        bgMist.forEach((m, mi) => {
            if ((m.density || 0.3) < 0.78) return;
            const dist = Math.max(0, Math.hypot(m.x - player.x, m.y - player.y) - m.r * 0.4);
            if (dist > terrRange * 0.8) return;
            const sig = m.density * Math.max(0, 1 - dist / (terrRange * 0.8)) * 0.70;
            if (!best || sig > best.sig)
                best = { x: m.x, y: m.y, sig, angle: Math.atan2(m.y - player.y, m.x - player.x), sourceId: 'higgs-hot-' + mi };
        });
        if (best && best.sig > thr * 0.2) allContacts.push(best);
    }

    // ─ 中立コロニー → HEAT + OPTIC + EM ─
    if (currentSensor === 'heat' || currentSensor === 'optic') {
        structures.forEach((s, si) => {
            if (s.type !== 'colony') return;
            const dist = Math.hypot(s.x - player.x, s.y - player.y);
            if (dist > terrRange) return;
            const sig = 0.52 * Math.max(0, 1 - dist / terrRange);
            if (sig > thr * 0.25)
                allContacts.push({ x: s.x, y: s.y, sig, angle: Math.atan2(s.y - player.y, s.x - player.x), sourceId: 'colony-' + si });
        });
    }
    if (currentSensor === 'em') {
        structures.forEach((s, si) => {
            if (s.type !== 'colony') return;
            const dist = Math.hypot(s.x - player.x, s.y - player.y);
            if (dist > terrRange) return;
            const sig = 0.35 * Math.max(0, 1 - dist / terrRange);
            if (sig > thr * 0.25)
                allContacts.push({ x: s.x, y: s.y, sig, angle: Math.atan2(s.y - player.y, s.x - player.x), sourceId: 'colony-' + si });
        });
    }
    // ─ 難破船 → OPTIC (残骸フラッシュ) + HEAT (残留熱) ─
    if (currentSensor === 'optic') {
        structures.forEach((s, si) => {
            if (s.type !== 'derelict') return;
            const dist = Math.hypot(s.x - player.x, s.y - player.y);
            if (dist > terrRange) return;
            const sig = 0.40 * Math.max(0, 1 - dist / terrRange);
            if (sig > thr * 0.25)
                allContacts.push({ x: s.x, y: s.y, sig, angle: Math.atan2(s.y - player.y, s.x - player.x), sourceId: 'derelict-' + si });
        });
    }
    if (currentSensor === 'heat') {
        structures.forEach((s, si) => {
            if (s.type !== 'derelict') return;
            const dist = Math.hypot(s.x - player.x, s.y - player.y);
            if (dist > terrRange) return;
            const sig = 0.20 * Math.max(0, 1 - dist / terrRange);
            if (sig > thr * 0.25)
                allContacts.push({ x: s.x, y: s.y, sig, angle: Math.atan2(s.y - player.y, s.x - player.x), sourceId: 'derelict-' + si });
        });
    }

    // ─ ヒッグスノード → HIGGS 0.70 + EM 0.25 ─
    if (currentSensor === 'higgs') {
        resourceNodes.forEach((n, ni) => {
            if (!n.active) return;
            const dist = Math.hypot(n.x - player.x, n.y - player.y);
            if (dist > terrRange) return;
            const sig = 0.70 * Math.max(0, 1 - dist / terrRange);
            if (sig > thr * 0.25)
                allContacts.push({ x: n.x, y: n.y, sig, angle: Math.atan2(n.y - player.y, n.x - player.x), sourceId: 'node-' + ni });
        });
    }
    if (currentSensor === 'em') {
        resourceNodes.forEach((n, ni) => {
            if (!n.active) return;
            const dist = Math.hypot(n.x - player.x, n.y - player.y);
            if (dist > terrRange) return;
            const sig = 0.25 * Math.max(0, 1 - dist / terrRange);
            if (sig > thr * 0.25)
                allContacts.push({ x: n.x, y: n.y, sig, angle: Math.atan2(n.y - player.y, n.x - player.x), sourceId: 'node-' + ni });
        });
    }

    if (allContacts.length === 0) return;

    // 強い順に最大3件だけ方位ウェッジ化
    allContacts.sort((a, b) => b.sig - a.sig);
    const picks = allContacts.slice(0, 3);
    // 第9弾: ロック中(トラッキング)の対象が上位3件から漏れても、検知できていれば解析対象に含める
    if (lockedSignalId && !picks.some(c => c.sourceId === lockedSignalId)) {
        const _lc = allContacts.find(c => c.sourceId === lockedSignalId);
        if (_lc) picks.push(_lc);
    }

    let strongestDeg = 0, strongestWidthDeg = 0, strongest = -1;
    for (const c of picks) {
        const conf = Math.max(0, Math.min(1, (c.sig - thr * 0.25) / (1 - thr * 0.25)));
        const quality = Math.min(1, conf * sensorPrec * 1.35);
        const halfWidth = 0.86 - quality * 0.74;
        const noise = (Math.random() - 0.5) * 2 * halfWidth * 0.55;
        const angle = c.angle + noise;
        const compassDeg = Math.round((Math.atan2(c.x - player.x, -(c.y - player.y)) * 180 / Math.PI + 360) % 360);
        // コンタクトラベルを連番割当 (sourceId初出時のみ)
        if (!_contactLabels[c.sourceId]) _contactLabels[c.sourceId] = _contactLabelNext++;
        passiveBearings.push({
            ox: player.x, oy: player.y,
            angle, halfWidth, range,
            quality, color: colorRgb,
            sensor: currentSensor, strength: c.sig, sensorLabel: sc.label,
            bearingDeg: compassDeg, halfWidthDeg: Math.round(halfWidth * 180 / Math.PI),
            sourceId: c.sourceId,
            contactNo: _contactLabels[c.sourceId],
            life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
        });
        if (c.sig > strongest) {
            strongest = c.sig;
            strongestDeg = compassDeg;
            strongestWidthDeg = Math.round(halfWidth * 180 / Math.PI);
        }
    }
    while (passiveBearings.length > PASSIVE_BEARING_MAX) passiveBearings.shift();

    // §4-4 H: dirAnalysis 積算 (検知できたコンタクト単位)。第9弾: 蓄積を大幅に高速化。
    // 受信しているだけで緩く貯まり、ロック(トラッキング)中の対象は集中解析で速く貯まる=「1分で概位置」。
    for (const c of picks) {
        if (!_signalAnalysis[c.sourceId]) {
            _signalAnalysis[c.sourceId] = { dirAnalysis: 0.1, triParam: 0, displayCenterX: null, displayCenterY: null, lockOriginX: 0, lockOriginY: 0, lastPosX: 0, lastPosY: 0 };
        }
        const _pdSa = _signalAnalysis[c.sourceId];
        const _pdAP = aiPrec('sensor'); // 0-1
        const _pdFocus = (c.sourceId === lockedSignalId) ? 1.0 : 0.35; // ロック中は集中解析
        // 検知サイクルは約2秒。ロック中は ~2.3/cycle → 60秒(30cycle)で ~70%。非ロックはその35%。
        const _pdRate = (2.0 + c.sig * 0.8) * (1 + _pdAP * 0.5) * _pdFocus;
        _pdSa.dirAnalysis = Math.min(100, _pdSa.dirAnalysis + _pdRate);
    }

    // §4-4 I: triParam 積算 (ロック中シグネチャ)。良い機動(方位線に垂直移動)でボーナス加算。
    if (lockedSignalId && _signalAnalysis[lockedSignalId] && player && player.hp > 0) {
        const _ptSa = _signalAnalysis[lockedSignalId];
        const _ptDx = player.x - _ptSa.lastPosX;
        const _ptDy = player.y - _ptSa.lastPosY;
        const _ptD = Math.hypot(_ptDx, _ptDy);
        if (_ptD > 120) {
            const _ptBearings = passiveBearings.filter(b => b.sourceId === lockedSignalId && b.life > 0);
            if (_ptBearings.length > 0) {
                _ptBearings.sort((a, b) => b.life - a.life);
                const _ptBearing = _ptBearings[0];
                const _ptMoveAngle = Math.atan2(_ptDy, _ptDx);
                const _ptAlpha = _ptMoveAngle - _ptBearing.angle;
                const _ptQuality = Math.abs(Math.sin(_ptAlpha)) * Math.min(_ptD / 1500, 1.0);
                const _ptAP = aiPrec('sensor');
                const _ptGain = 12 * (1 + _ptAP * 0.6);
                _ptSa.triParam = Math.min(100, _ptSa.triParam + _ptQuality * _ptGain);
            }
        }
        _ptSa.lastPosX = player.x;
        _ptSa.lastPosY = player.y;
        // 推定位置の表示"目標"を更新 (第10弾: ジッタ方向を固定し精度で収束。毎サイクルの乱数テレポートを廃止)。
        // 描画側(drawTriangulationCircle)が毎フレーム目標へ補間するので、サークルは滑らかにドリフト・収束する。
        const _srcP = _sourcePos(lockedSignalId);
        if (_srcP) {
            if (_ptSa.jitAngle === undefined) { _ptSa.jitAngle = Math.random() * Math.PI * 2; _ptSa.jitFrac = Math.sqrt(Math.random()); }
            const _ptAvg = (_ptSa.dirAnalysis + _ptSa.triParam) / 2;
            const _ptR = Math.max(1200, MAP_RADIUS * Math.pow(1 - _ptAvg / 100, 1.5));
            const _ptOff = _ptSa.jitFrac * (_ptR / 2); // 固定方向・精度連動で縮む → 真値へ収束
            _ptSa.targetCenterX = _srcP.x + _ptOff * Math.cos(_ptSa.jitAngle);
            _ptSa.targetCenterY = _srcP.y + _ptOff * Math.sin(_ptSa.jitAngle);
            _ptSa.targetR = _ptR;
        }
    }

    passiveAlertTimer = 180;
    logMessage(`PASSIVE: ${sc.label}放射源 ─ 方位 ${strongestDeg}° ±${strongestWidthDeg}°`, 'warning-msg');
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
        const lifeT = b.life / b.maxLife;        // 1→0 (フェードアウト)
        const appear = Math.min(1, (b.maxLife - b.life) / 45); // 0→1 出現から0.75秒でフェードイン(突然のポップを解消・第10弾)
        const vis = lifeT * appear;
        const R = b.range;
        const col = b.color;
        ctx.save();
        // §4-4 H: dirAnalysis に基づく表示制御
        const _bSa = _signalAnalysis[b.sourceId];
        const _bDa = _bSa ? (_bSa.dirAnalysis || 0) : 0;
        if (_bDa > 0 && _bDa < 20) { ctx.restore(); continue; }
        if (_bDa >= 20 && _bDa < 40) {
            ctx.globalAlpha = 0.5 * vis; ctx.strokeStyle = `rgb(${col})`; ctx.lineWidth = 1.2 * invZoom;
            ctx.beginPath(); ctx.arc(b.ox, b.oy, 6 * invZoom, 0, Math.PI * 2); ctx.stroke();
            ctx.restore(); continue;
        }
        const _bHW = _bDa >= 100 ? 5 * Math.PI / 180 :
                     _bDa >= 80  ? 10 * Math.PI / 180 :
                     _bDa >= 60  ? 15 * Math.PI / 180 :
                     _bDa >= 40  ? 20 * Math.PI / 180 : b.halfWidth;
        const a0 = b.angle - _bHW;
        const a1 = b.angle + _bHW;
        // 扇形フィル (弱信号ほど広い半透明のボケ) — shadowBlur不使用(モバイル配慮)
        ctx.globalAlpha = 0.10 * vis * (0.4 + b.quality * 0.6);
        ctx.beginPath();
        ctx.moveTo(b.ox, b.oy);
        ctx.arc(b.ox, b.oy, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgb(${col})`;
        ctx.fill();
        // 扇の両エッジ
        ctx.globalAlpha = 0.45 * vis;
        ctx.strokeStyle = `rgb(${col})`;
        ctx.lineWidth = 1.2 * invZoom;
        ctx.beginPath();
        ctx.moveTo(b.ox, b.oy); ctx.lineTo(b.ox + Math.cos(a0) * R, b.oy + Math.sin(a0) * R);
        ctx.moveTo(b.ox, b.oy); ctx.lineTo(b.ox + Math.cos(a1) * R, b.oy + Math.sin(a1) * R);
        ctx.stroke();
        // 中心方位線 (破線)
        ctx.globalAlpha = 0.6 * vis;
        ctx.setLineDash([14 * invZoom, 10 * invZoom]);
        ctx.beginPath();
        ctx.moveTo(b.ox, b.oy);
        ctx.lineTo(b.ox + Math.cos(b.angle) * R, b.oy + Math.sin(b.angle) * R);
        ctx.stroke();
        ctx.setLineDash([]);
        // 計測位置マーカー (小円) — 移動による三角測量の起点を可視化
        ctx.globalAlpha = 0.5 * vis;
        ctx.beginPath();
        ctx.arc(b.ox, b.oy, 6 * invZoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

// 特定済み地形効果マーカー描画 (2026-07-11): 解析で特定した熱雲帯/磁気嵐帯/ヒッグス高濃度域を
// ヒッグスフォグの手前に恒久表示する。「一度特定した地形は二度と疑わない」= 消去法の航海図が育つ。
function drawIdentifiedTerrain(ctx, vpX, vpY, vpW, vpH) {
    const zc = 1 / camera.zoom;
    const _terrSets = [
        { arr: (typeof thermalField !== 'undefined' ? thermalField : []), col: '#ffaa44', label: 'THERMAL' },
        { arr: (typeof stormField   !== 'undefined' ? stormField   : []), col: '#b47af0', label: 'STORM' },
        { arr: (typeof bgMist       !== 'undefined' ? bgMist       : []), col: '#5a9cff', label: 'HIGGS DENSE' }
    ];
    ctx.save();
    for (const set of _terrSets) {
        for (const f of set.arr) {
            if (!f || !f.identified) continue;
            const mg = f.r || 800;
            if (f.x < vpX - mg || f.x > vpX + vpW + mg || f.y < vpY - mg || f.y > vpY + vpH + mg) continue;
            // 範囲リング (地形効果の及ぶ範囲を破線で)
            ctx.globalAlpha = 0.20;
            ctx.strokeStyle = set.col;
            ctx.lineWidth = 1.2 * zc;
            ctx.setLineDash([20 * zc, 14 * zc]);
            ctx.beginPath(); ctx.arc(f.x, f.y, mg * 0.75, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
            // 中心の菱形マーカー
            const ms = 9 * zc;
            ctx.globalAlpha = 0.75;
            ctx.beginPath();
            ctx.moveTo(f.x, f.y - ms); ctx.lineTo(f.x + ms, f.y);
            ctx.lineTo(f.x, f.y + ms); ctx.lineTo(f.x - ms, f.y);
            ctx.closePath(); ctx.stroke();
            // ラベル
            ctx.globalAlpha = 0.65;
            ctx.fillStyle = set.col;
            ctx.font = `bold ${Math.round(9 * zc)}px Orbitron, monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(set.label, f.x, f.y - ms - 6 * zc);
        }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
}

// ============================================================
// sourceId → 実座標を解決 (推定位置サークルの中心/ランドマーク特定用・第9弾)
function _sourcePos(sid) {
    if (!sid) return null;
    let m;
    if ((m = sid.match(/^e-(\d+)$/)))         { const e = enemies[+m[1]];       return e && e.hp > 0 ? { x: e.x, y: e.y } : null; }
    if ((m = sid.match(/^thermal-(\d+)$/)))   { const f = thermalField[+m[1]];  return f ? { x: f.x, y: f.y } : null; }
    if ((m = sid.match(/^storm-(\d+)$/)))     { const f = stormField[+m[1]];    return f ? { x: f.x, y: f.y } : null; }
    if ((m = sid.match(/^higgs-hot-(\d+)$/))) { const f = bgMist[+m[1]];        return f ? { x: f.x, y: f.y } : null; }
    if ((m = sid.match(/^(?:colony|derelict)-(\d+)$/))) { const s = structures[+m[1]]; return s ? { x: s.x, y: s.y } : null; }
    if ((m = sid.match(/^node-(\d+)$/)))      { const n = resourceNodes[+m[1]]; return n ? { x: n.x, y: n.y } : null; }
    return null;
}

// §4-4: 三角測量エンジン
// ============================================================
// 複数のパッシブ方位線の交点から推定位置と精度を算出する。手動TRIボタンで呼び出す。
function computeTriangulation() {
    // ロック中シグネチャがあれば、そのsourceIdの方位線だけで三角測量
    const bs = passiveBearings.filter(b => b.life > 60 && (!lockedSignalId || b.sourceId === lockedSignalId));
    if (bs.length < 2) { triangulationResult = null; return; }
    let sumX = 0, sumY = 0, sumW = 0;
    for (let i = 0; i < bs.length - 1; i++) {
        for (let j = i + 1; j < bs.length; j++) {
            const bi = bs[i], bj = bs[j];
            const baseline = Math.hypot(bj.ox - bi.ox, bj.oy - bi.oy);
            if (baseline < TRIG_MIN_BASELINE) continue;
            // 2直線の交点: Cramer則
            // Ray i: (bi.ox + t*cos(ai), bi.oy + t*sin(ai))
            // det = sin(ai - aj)
            const det = Math.sin(bi.angle - bj.angle);
            if (Math.abs(det) < 0.05) continue; // ほぼ平行
            const dx = bj.ox - bi.ox, dy = bj.oy - bi.oy;
            const t = (-dx * Math.sin(bj.angle) + dy * Math.cos(bj.angle)) / det;
            const s = ( dx * Math.sin(bi.angle) - dy * Math.cos(bi.angle)) / (-det);
            if (t < 50 || s < 50) continue; // 後方 or 近すぎる交差は無効
            const ix = bi.ox + t * Math.cos(bi.angle);
            const iy = bi.oy + t * Math.sin(bi.angle);
            // 重み: ベースライン × sin(角度差) × 新鮮度 / 方位線幅
            const freshI = bi.life / bi.maxLife, freshJ = bj.life / bj.maxLife;
            const angQ = Math.abs(det); // sin(角度差), 直角=1が最大
            const w = (baseline / 4000) * angQ * Math.sqrt(freshI * freshJ)
                      / ((bi.halfWidth + bj.halfWidth) * 1.5 + 0.1);
            sumX += ix * w; sumY += iy * w; sumW += w;
        }
    }
    if (sumW < 0.01) { triangulationResult = null; return; }
    const ex = sumX / sumW, ey = sumY / sumW;
    const precision = Math.min(0.97, sumW / (1.5 + sumW)); // 漸近: 重みが増えるほど精度↑
    const radius = TRIG_MAX_RADIUS * (1 - precision) + 200;
    // §4-4 Phase3: 前回結果と比較して速度ベクトルを推定
    if (_prevTrigResult && precision >= 0.55 && _prevTrigResult.precision >= 0.55) {
        const _dt = _frameCount - _prevTrigResult.frame;
        if (_dt >= 60 && _dt <= 1800) { // 1秒以上・30秒以内の測定差を有効とする
            const _vx = (ex - _prevTrigResult.x) / _dt;
            const _vy = (ey - _prevTrigResult.y) / _dt;
            const _spd = Math.hypot(_vx, _vy);
            // 異常速度（光速超など）は無効化
            if (_spd < 5.0) {
                triangulationVelocity = { vx: _vx, vy: _vy, speed: _spd, frame: _frameCount };
            }
        }
    }
    _prevTrigResult = { x: ex, y: ey, precision, frame: _frameCount };
    triangulationResult = { x: ex, y: ey, precision, radius, frame: _frameCount };
}

// §4-4: 三角測量精度円描画 (ワールド空間)
// 低精度=赤大円 / 中=橙 / 高=緑 / 超高=シアン
// 三角測量の移動方向ガイド (第9弾): ロック中、方位線に垂直な進路を自機周りに提示。
// 垂直に動くほどベースラインが伸び triParam が速く貯まる=「どっちに進めばいいか」を可視化。
function drawTriangulationGuide(ctx) {
    if (!lockedSignalId || !player || player.hp <= 0) return;
    const sa = _signalAnalysis[lockedSignalId];
    if (!sa || (sa.triParam || 0) > 88) return; // 十分に測量できたら消す
    // 最新の方位から目標角を求め、毎フレーム角度補間 → 方位が更新されても矢印が滑らかに向き直る(第10弾: パッと反転する点滅を解消)
    const bl = passiveBearings.filter(b => b.sourceId === lockedSignalId && b.life > 0).sort((a, b) => b.life - a.life)[0];
    if (bl) {
        let target = bl.angle + Math.PI / 2;
        if (sa.guideAngle === undefined) sa.guideAngle = target;
        let d = target - sa.guideAngle;
        while (d < -Math.PI) d += Math.PI * 2; while (d > Math.PI) d -= Math.PI * 2;
        // 垂直軸は180°対称なので、反対向き(±π)の方が近ければそちらへ寄せる(急な180°反転を防ぐ)
        if (d > Math.PI / 2) d -= Math.PI; else if (d < -Math.PI / 2) d += Math.PI;
        sa.guideAngle += d * 0.08;
    }
    if (sa.guideAngle === undefined) return;
    const perp = sa.guideAngle;
    const zc = 1 / camera.zoom;
    const L = 120 * zc, gap = 34 * zc;
    const t = Date.now() * 0.003;
    const pulse = 0.55 + Math.sin(t) * 0.12; // 穏やかな明滅に
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.strokeStyle = '#00ffd0'; ctx.fillStyle = '#00ffd0';
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 2 * zc;
    ctx.setLineDash([9 * zc, 7 * zc]);
    for (const dir of [perp, perp + Math.PI]) {
        const dx = Math.cos(dir), dy = Math.sin(dir);
        ctx.beginPath(); ctx.moveTo(dx * gap, dy * gap); ctx.lineTo(dx * L, dy * L); ctx.stroke();
        // 矢じり
        ctx.setLineDash([]);
        const ax = dx * L, ay = dy * L, aa = 0.4;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(dir - aa) * 16 * zc, ay - Math.sin(dir - aa) * 16 * zc);
        ctx.lineTo(ax - Math.cos(dir + aa) * 16 * zc, ay - Math.sin(dir + aa) * 16 * zc);
        ctx.closePath(); ctx.fill();
        ctx.setLineDash([9 * zc, 7 * zc]);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    ctx.font = `bold ${Math.round(9 * zc)}px Orbitron, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('測量に有効な進路 →', Math.cos(perp) * (L + 22 * zc), Math.sin(perp) * (L + 22 * zc));
    ctx.restore();
}

function drawTriangulationCircle(ctx) {
    drawTriangulationGuide(ctx);
    // §4-4 I: sig-analysis ベースの推定位置円 (lockedSignalId がある場合に優先)
    if (lockedSignalId && _signalAnalysis[lockedSignalId]) {
        const _siSa = _signalAnalysis[lockedSignalId];
        const _siDa = _siSa.dirAnalysis || 0;
        const _siTp = _siSa.triParam || 0;
        if (_siDa > 6 && _siSa.targetCenterX != null) {
            const _siAvg = (_siDa + _siTp) / 2;
            // 毎フレーム目標へ補間 → サークルが滑らかにドリフト・収束 (毎秒テレポートを解消・第10弾)
            if (_siSa.displayCenterX == null) { _siSa.displayCenterX = _siSa.targetCenterX; _siSa.displayCenterY = _siSa.targetCenterY; _siSa.displayR = _siSa.targetR; }
            _siSa.displayCenterX += (_siSa.targetCenterX - _siSa.displayCenterX) * 0.06;
            _siSa.displayCenterY += (_siSa.targetCenterY - _siSa.displayCenterY) * 0.06;
            _siSa.displayR += ((_siSa.targetR || 1200) - (_siSa.displayR || _siSa.targetR)) * 0.04;
            const _siR = _siSa.displayR;
            const _siCx = _siSa.displayCenterX, _siCy = _siSa.displayCenterY;
            const _siCol = _siAvg < 30 ? '255,80,0' : _siAvg < 60 ? '255,160,0' : _siAvg < 85 ? '80,255,120' : '100,200,255';
            const _siInv = 1 / camera.zoom;
            ctx.save();
            ctx.globalAlpha = 0.25;
            ctx.strokeStyle = `rgb(${_siCol})`;
            ctx.lineWidth = 2 * _siInv;
            ctx.setLineDash([12 * _siInv, 8 * _siInv]);
            ctx.beginPath(); ctx.arc(_siCx, _siCy, _siR, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.65;
            ctx.lineWidth = 1.5 * _siInv;
            const _siMs = 20 * _siInv;
            ctx.beginPath(); ctx.moveTo(_siCx - _siMs, _siCy); ctx.lineTo(_siCx + _siMs, _siCy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(_siCx, _siCy - _siMs); ctx.lineTo(_siCx, _siCy + _siMs); ctx.stroke();
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = `rgb(${_siCol})`;
            ctx.font = `bold ${Math.round(9 * _siInv)}px Orbitron, monospace`;
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.fillText(`DIR ${Math.round(_siDa)}%  TRI ${Math.round(_siTp)}%`, _siCx + _siR * 0.12 + 8 * _siInv, _siCy - 6 * _siInv);
            ctx.restore();
            return;
        }
    }
    if (!triangulationResult) return;
    const { x, y, precision, radius, frame } = triangulationResult;
    const age = _frameCount - frame;
    const ageFactor = Math.max(0, 1 - age * TRIG_DECAY_PER_FRAME);
    if (ageFactor <= 0.01) { triangulationResult = null; return; }
    let color;
    if      (precision < 0.3) color = '255,80,0';
    else if (precision < 0.6) color = '255,160,0';
    else if (precision < 0.9) color = '80,255,120';
    else                      color = '100,200,255';
    const inv = 1 / camera.zoom;
    ctx.save();
    ctx.globalAlpha = 0.25 * ageFactor;
    ctx.strokeStyle = `rgb(${color})`;
    ctx.lineWidth = 2 * inv;
    ctx.setLineDash([12 * inv, 8 * inv]);
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // 十字マーカー
    ctx.globalAlpha = 0.65 * ageFactor;
    ctx.lineWidth = 1.5 * inv;
    const ms = 20 * inv;
    ctx.beginPath(); ctx.moveTo(x - ms, y); ctx.lineTo(x + ms, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - ms); ctx.lineTo(x, y + ms); ctx.stroke();
    // 精度ラベル
    ctx.globalAlpha = 0.8 * ageFactor;
    ctx.fillStyle = `rgb(${color})`;
    ctx.font = `bold ${Math.round(9 * inv)}px Orbitron, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`TRI ${Math.round(precision * 100)}%`, x + (radius + 8) * 0.12, y - 6 * inv);
    // §4-4 Phase2+3: ゴースト表示 (精度≥80%で半透明シルエット) + Phase3: 速度外挿で動くゴースト
    if (precision >= 0.80) {
        // Phase3: 速度ベクトルが有効なら測定位置から外挿して現在推定位置へ移動
        let gx = x, gy = y, hasVel = false;
        if (triangulationVelocity && (_frameCount - triangulationVelocity.frame) < 1200) {
            const _velAge = _frameCount - frame; // 測定フレームからの経過
            gx = x + triangulationVelocity.vx * _velAge;
            gy = y + triangulationVelocity.vy * _velAge;
            hasVel = triangulationVelocity.speed > 0.02; // 有意な速度のみ表示
        }
        const ghostA = Math.min(0.55, (precision - 0.80) / 0.17) * ageFactor;
        ctx.globalAlpha = ghostA;
        ctx.strokeStyle = `rgb(${color})`;
        ctx.lineWidth = 1.5 * inv;
        // Phase3: 測定位置(x,y)→外挿位置(gx,gy)へのベクトル線 (速度が有意な場合)
        if (hasVel && (gx !== x || gy !== y)) {
            ctx.globalAlpha = 0.22 * ageFactor;
            ctx.setLineDash([6 * inv, 10 * inv]);
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(gx, gy); ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.save();
        ctx.translate(gx, gy);
        // 艦形シルエット (菱形; 速度方向が既知なら向きを向ける、不明=真上)
        const fw = 42 * inv, sw = 14 * inv, rw = 24 * inv;
        if (hasVel && triangulationVelocity.speed > 0.02) {
            ctx.rotate(Math.atan2(triangulationVelocity.vy, triangulationVelocity.vx) + Math.PI / 2);
        }
        ctx.globalAlpha = ghostA;
        ctx.beginPath();
        ctx.moveTo(0, -fw);  ctx.lineTo(sw, 0);
        ctx.lineTo(0, rw);   ctx.lineTo(-sw, 0);
        ctx.closePath(); ctx.stroke();
        // 「?」マーカー (精度<95%では不確定を明示)
        if (precision < 0.95) {
            ctx.globalAlpha = (ghostA + 0.1) * ageFactor;
            ctx.fillStyle = `rgb(${color})`;
            ctx.font = `bold ${18 * inv}px monospace`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('?', 0, 0);
        } else {
            // 95%超: ゴーストに「GHOST」ラベル + 速度表示
            ctx.globalAlpha = 0.5 * ageFactor;
            ctx.fillStyle = `rgb(${color})`;
            ctx.font = `${7 * inv}px Orbitron, monospace`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            const _velLabel = hasVel ? `GHOST v${(triangulationVelocity.speed * 60).toFixed(1)}/s` : 'GHOST';
            ctx.fillText(_velLabel, 0, rw + 4 * inv);
        }
        ctx.restore();
    }
    ctx.restore();
}

// フィールド外縁 360° ラジアル方位目盛り (ワールド空間)
function drawRadialScale(ctx) {
    ctx.save();
    ctx.translate(MAP_CX, MAP_CY);
    const r = MAP_RADIUS;
    const iZ = 1 / camera.zoom;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 10) {
        const rad = (deg - 90) * Math.PI / 180; // 0°=北(上)
        const isCardinal = deg % 90 === 0;
        const isMid     = deg % 30 === 0;
        // 画面上 20/14/9 px 相当（colonyラベルの文字高さ程度）
        const tickLen   = iZ * (isCardinal ? 20 : isMid ? 14 : 9);
        const lw        = iZ * (isCardinal ? 2.5 : isMid ? 1.8 : 1.2);
        const alpha     = isCardinal ? 0.75 : isMid ? 0.55 : 0.35;
        const x0 = Math.cos(rad) * r, y0 = Math.sin(rad) * r;
        const x1 = Math.cos(rad) * (r + tickLen), y1 = Math.sin(rad) * (r + tickLen);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#00ffcc';
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        // 数字: tickの先端から更に 36px 外側（リング外縁のすぐ外に収まる）
        const labelR = r + tickLen + iZ * 36;
        const lx = Math.cos(rad) * labelR;
        const ly = Math.sin(rad) * labelR;
        ctx.globalAlpha = isCardinal ? 0.80 : isMid ? 0.60 : 0.40;
        ctx.fillStyle = '#00ffcc';
        ctx.font = `${Math.round(iZ * (isCardinal ? 12 : 9))}px "Orbitron",monospace`;
        ctx.fillText(deg + '°', lx, ly);
    }
    ctx.restore();
}

// §4-4: 長押しラジアルメニュー表示/非表示
function showLongPressMenu(sx, sy) {
    const menu = document.getElementById('long-press-menu');
    if (!menu) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = sx - 52, top = sy - 90;
    if (left < 6) left = 6;
    if (left + 108 > vw) left = vw - 114;
    if (top < 6) top = 6;
    if (top + 130 > vh) top = vh - 136;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';
    menu.style.display = '';
}
function hideLongPressMenu() {
    const menu = document.getElementById('long-press-menu');
    if (menu) menu.style.display = 'none';
}
// 長押しメニュー「移動」選択
function lpmSelectMove() {
    hideLongPressMenu();
    if (!_lpmWorld || !player) return;
    player.targetEntity = null;
    player.setTarget(_lpmWorld.x, _lpmWorld.y);
    createClickEffect(_lpmWorld.x, _lpmWorld.y, '#00ffaa');
    const dist = Math.hypot(_lpmWorld.x - player.x, _lpmWorld.y - player.y);
    const speedEst = Math.max(0.1, (genAlloc.engine / 100) * 3.0);
    const timeSeconds = Math.max(1, Math.floor(dist / (speedEst * 60)));
    logMessage(`NAV: 進路設定完了。到着予定時間はおよそ ${timeSeconds} 秒です。`, 'system-msg');
    playSound('ui');
}
// 長押しメニュー「射撃」選択 — 指定ワールド座標へ自由射撃 (MSL/BEAM)
function lpmSelectFire() {
    hideLongPressMenu();
    if (!_lpmWorld || !player || player.hp <= 0) return;
    if (player._weaponJamTimer > 0) { logMessage('WEP: 火器管制ダウン — 復旧まで発砲不能', 'warning-msg'); return; }
    const wx = _lpmWorld.x, wy = _lpmWorld.y;
    const wType = document.getElementById('weapon-select')?.value;
    if (wType !== 'missile' && wType !== 'beam') {
        logMessage('WEP: 座標射撃はミサイル/ビームのみ有効', 'warning-msg'); return;
    }
    const _ffAng = Math.atan2(wy - player.y, wx - player.x);
    let _ffDiff = _ffAng - player.angle;
    while (_ffDiff < -Math.PI) _ffDiff += Math.PI * 2;
    while (_ffDiff >  Math.PI) _ffDiff -= Math.PI * 2;
    const _ffMaxArc = WEAPON_FIRE_ARC[wType] || (Math.PI / 4);
    if (Math.abs(_ffDiff) > _ffMaxArc) {
        logMessage(`WEP: 射角外 — 艦首±${Math.round(_ffMaxArc * 180 / Math.PI)}°以内に向けてから発射`, 'warning-msg'); return;
    }
    if (player.fireCooldown > 0) return;
    const _ffGen = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
    if (wType === 'missile') {
        if (player.missileReloading) { logMessage('WEP: MISSILEリロード中', 'warning-msg'); return; }
        projectiles.push(new Projectile(player.x, player.y, { x: wx, y: wy, hp: 999, radius: 1 }, true, 'missile', 1.0));
        playSound('shoot');
        cancelSilentRunning('発砲');
        player.fireCooldown = WEAPON_COOLDOWNS.missile * _ffGen;
        player.missileReloading = true;
        player.missileReloadTimer = Math.round(MISSILE_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0));
        if (heatTrails.length < 600) heatTrails.push({ x: player.x, y: player.y, intensity: 0.9, life: 1.0, isPlayerTrail: false });
        logMessage('WEP: 座標射撃(MSL) — 自位置シグネチャ露出', 'warning-msg');
    } else {
        if (player.beamReloading) { logMessage('WEP: BEAMリロード中', 'warning-msg'); return; }
        const _bRange = 8000 * (WEAPONS_UPG_RANGE_MULT[gameState.upgrades.weapons] || 1.0);
        const _bLen = Math.min(_bRange, Math.max(100, Math.hypot(wx - player.x, wy - player.y)));
        const _bEx = player.x + Math.cos(_ffAng) * _bLen, _bEy = player.y + Math.sin(_ffAng) * _bLen;
        effects.push({ x: player.x, y: player.y, tx: _bEx, ty: _bEy, type: 'beam', a: 1, c: '#00ffaa' });
        enemies.forEach(en => {
            if (en.hp <= 0) return;
            const _bdx = _bEx - player.x, _bdy = _bEy - player.y, _bSq = _bdx*_bdx + _bdy*_bdy;
            const _bt = _bSq > 0 ? Math.max(0, Math.min(1, ((en.x - player.x)*_bdx + (en.y - player.y)*_bdy) / _bSq)) : 0;
            if (Math.hypot(en.x - (player.x + _bt*_bdx), en.y - (player.y + _bt*_bdy)) < en.radius * 1.5) {
                const _hb = getHiggsIntensity((player.x + _bt*_bdx + en.x)/2, (player.y + _bt*_bdy + en.y)/2);
                const _lpSt = applyStrikeBonuses(true, null, en, Math.atan2(player.y - en.y, player.x - en.x));
                const _lpD = Math.floor(150 * (1 - _hb * 0.8) * _lpSt.mult);
                en.hp -= _lpD;
                if (huntStats) huntStats.dmgDealt += _lpD;
                createHitEffect(en.x, en.y, '#00ffaa'); addShake(15);
                logMessage(`WEP: BEAM 命中！ → ${_lpD} ダメージ`, 'system-msg');
            }
        });
        player.emSig = Math.min(1, player.emSig + 0.3);
        player.opticalSig = Math.min(1, player.opticalSig + 0.35);
        player.beamReloading = true;
        player.beamReloadTimer = Math.round(BEAM_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0));
        player.fireCooldown = WEAPON_COOLDOWNS.beam * _ffGen;
        addHiggsWake(player.x, player.y, 0.5);
        cancelSilentRunning('発砲');
        logMessage('WEP: 座標射撃(BEAM) — 自位置シグネチャ露出', 'warning-msg');
    }
}

// §4-4 Phase2: 三角測量推定座標への射撃 (解析パネルの「COORD FIRE」ボタンから呼ぶ)
function coordFireAtTriangulation() {
    if (!triangulationResult || !player || player.hp <= 0) {
        logMessage('COORD: 三角測量データなし — まず解析を実行してください', 'warning-msg');
        return;
    }
    if (player._weaponJamTimer > 0) { logMessage('WEP: 火器管制ダウン — 復旧まで発砲不能', 'warning-msg'); return; }
    const wType = document.getElementById('weapon-select')?.value;
    if (wType !== 'missile' && wType !== 'beam') {
        logMessage('COORD: ミサイル / ビームのみ座標射撃可能', 'warning-msg');
        return;
    }
    const tri = triangulationResult;
    // §4-4 Phase3: 速度外挿で現在の推定位置を計算
    const _ageFrames = _frameCount - tri.frame;
    let _tgtX = tri.x, _tgtY = tri.y;
    if (triangulationVelocity && (_frameCount - triangulationVelocity.frame) < 1200) {
        _tgtX = tri.x + triangulationVelocity.vx * _ageFrames;
        _tgtY = tri.y + triangulationVelocity.vy * _ageFrames;
    }
    const _ang = Math.atan2(_tgtY - player.y, _tgtX - player.x);
    let _diff = _ang - player.angle;
    while (_diff < -Math.PI) _diff += Math.PI * 2;
    while (_diff > Math.PI) _diff -= Math.PI * 2;
    const _maxArc = WEAPON_FIRE_ARC[wType] || (Math.PI / 4);
    if (Math.abs(_diff) > _maxArc) {
        logMessage(`COORD: 推定位置が射角外 (±${Math.round(_maxArc * 180 / Math.PI)}°以内に艦首を向けてから発射)`, 'warning-msg');
        return;
    }
    if (player.fireCooldown > 0) { logMessage('COORD: 武器クールダウン中', 'warning-msg'); return; }
    const precPct  = Math.round(tri.precision * 100);
    const _gf = Math.max(0.3, 1.5 - genAlloc.weapons / 100);
    if (wType === 'missile') {
        if (player.missileReloading) { logMessage('COORD: MISSILEリロード中', 'warning-msg'); return; }
        // §4-4 Phase3: ミサイル飛翔時間で命中率を補正
        const _mSpd = missileMode === 'smart' ? 7.5 : 6;
        const _dist = Math.hypot(_tgtX - player.x, _tgtY - player.y);
        const _flightFrames = _dist / _mSpd;
        const _velSpd = triangulationVelocity ? triangulationVelocity.speed : 0;
        const _drift = _velSpd * _flightFrames; // 飛翔中に目標が動く推定距離
        const _driftPenalty = Math.min(0.70, _drift / Math.max(1, tri.radius));
        const hitChance = Math.round(tri.precision * 65 * (1 - _driftPenalty * 0.6));
        const _ft = { x: _tgtX, y: _tgtY, hp: 999, radius: 1 };
        projectiles.push(new Projectile(player.x, player.y, _ft, true, 'missile', 1.0));
        playSound('shoot');
        cancelSilentRunning('発砲');
        player.fireCooldown = WEAPON_COOLDOWNS.missile * _gf;
        player.missileReloading = true;
        player.missileReloadTimer = Math.round(MISSILE_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0));
        if (heatTrails.length < 600) heatTrails.push({ x: player.x, y: player.y, intensity: 0.9, life: 1.0 });
        const _flightSec = (_flightFrames / 60).toFixed(1);
        const _driftInfo = _velSpd > 0.02 ? ` 飛翔${_flightSec}s/ドリフト${Math.round(_drift)}` : '';
        logMessage(`COORD[MISSILE] 精度 ${precPct}%${_driftInfo} → 推定命中率 ${hitChance}% — 自位置シグネチャ露出`, 'warning-msg');
    } else {
        if (player.beamReloading) { logMessage('COORD: BEAMリロード中', 'warning-msg'); return; }
        // ビームは即着弾なので飛翔ペナルティなし。データ経過時間を精度に反映
        const _beamAgeDecay = Math.max(0.4, 1 - _ageFrames * TRIG_DECAY_PER_FRAME);
        const hitChance = Math.round(tri.precision * 65 * _beamAgeDecay);
        const _bRange = 8000 * (WEAPONS_UPG_RANGE_MULT[gameState.upgrades.weapons] || 1.0);
        const _dist  = Math.hypot(_tgtX - player.x, _tgtY - player.y);
        const _bLen  = Math.min(_bRange, Math.max(100, _dist));
        const _bEx = player.x + Math.cos(_ang) * _bLen;
        const _bEy = player.y + Math.sin(_ang) * _bLen;
        effects.push({ x: player.x, y: player.y, tx: _bEx, ty: _bEy, type: 'beam', a: 1, c: '#00ffaa' });
        enemies.forEach(en => {
            if (en.hp <= 0) return;
            const _bdx = _bEx - player.x, _bdy = _bEy - player.y;
            const _bSq = _bdx * _bdx + _bdy * _bdy;
            const _bt = _bSq > 0 ? Math.max(0, Math.min(1, ((en.x - player.x) * _bdx + (en.y - player.y) * _bdy) / _bSq)) : 0;
            const _bcx = player.x + _bt * _bdx, _bcy = player.y + _bt * _bdy;
            if (Math.hypot(en.x - _bcx, en.y - _bcy) < en.radius * 1.5) {
                const _hb = getHiggsIntensity((_bcx + en.x) / 2, (_bcy + en.y) / 2);
                const _cfSt = applyStrikeBonuses(true, null, en, Math.atan2(player.y - en.y, player.x - en.x));
                const _cfD = Math.floor(150 * (1 - _hb * 0.8) * _cfSt.mult);
                en.hp -= _cfD;
                if (huntStats) huntStats.dmgDealt += _cfD;
                createHitEffect(en.x, en.y, '#00ffaa');
                addShake(15);
            }
        });
        const _bSteps = Math.max(5, Math.floor(_bLen / 60));
        for (let _bi = 0; _bi <= _bSteps; _bi++) {
            const _bT = _bi / _bSteps;
            if (higgsWakes.length < 400) higgsWakes.push({ x: player.x + (_bEx - player.x) * _bT, y: player.y + (_bEy - player.y) * _bT, intensity: 0.7, life: 1.0 });
        }
        if (opticTrails.length < 600) opticTrails.push({ x: player.x, y: player.y, intensity: 1.0, life: 1.0 });
        player.beamReloading = true;
        player.beamReloadTimer = 300;
        player.fireCooldown = WEAPON_COOLDOWNS.beam * _gf;
        cancelSilentRunning('発砲');
        logMessage(`COORD[BEAM] 精度 ${precPct}% → 推定命中率 ${hitChance}% — ダークチャネル暴露`, 'warning-msg');
    }
}
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
    const stormAtPlayer = getStormIntensity(player.x, player.y);
    const omniRange = baseRange * (genAlloc.sensors / 100) * genGain * (1 - stormAtPlayer * STORM_SONAR_DEGRADE);
    const sc = sensorConfig[currentSensor];

    playSound('ui');
    cancelSilentRunning('アクティブソナー使用');
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
    const stormSuffix = stormAtPlayer > 0.3 ? ` ⚡EM嵐による減衰 (${Math.round(stormAtPlayer * STORM_SONAR_DEGRADE * 100)}%低下)` : '';
    logMessage(detected > 0
        ? `SONAR[全周囲] Lv${sensorLv}: ${detected}件の反応捕捉 (範囲: ${rStr}u) ─ 位置暴露注意${stormSuffix}`
        : `SONAR[全周囲] Lv${sensorLv}: 有効範囲 ${rStr}u 内に反応なし${stormSuffix}`,
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
    const stormAtPlayer2 = getStormIntensity(player.x, player.y);
    const maxRange  = DIR_SONAR_MAX_RANGE * (genAlloc.sensors / 100) * genGain * (1 - stormAtPlayer2 * STORM_SONAR_DEGRADE);

    playSound('ui');
    cancelSilentRunning('アクティブソナー使用');
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

    // ═══ 自機周りの多層リングHUD (第8弾リデザイン) ═══
    // 折りたたみモードでオシロ波形が見えない代替。リング形状で自シグネチャと脅威方位を伝える。
    // 原則: 各リングに役割ひとつ / 非アクティブ要素はアルファで沈めて非煩雑に保つ。
    if (player && player.hp > 0) {
        const tSec = Date.now() * 0.001;
        const zi = 1 / camera.zoom;
        const S_HEX = { heat:'#ffa03c', optic:'#3cffb4', em:'#e664ff', higgs:'#3cf0ff' };
        const S_DIR = { heat:-Math.PI*0.5, optic:0, em:Math.PI*0.5, higgs:Math.PI }; // 上/右/下/左

        ctx.save();
        ctx.translate(player.x, player.y);

        // ── (1) 自シグネチャ・ハロー (内側・"自分の声の大きさ") ──
        // 静粛航行/デブリ擬態で沈黙すると弧が縮む=即座に「静かになった」と分かる。発砲で閃く。
        const selfSig = { heat: player.heatSig||0, optic: player.opticalSig||0, em: player.emSig||0, higgs: player.higgsSig||0 };
        const haloR = 24 * zi;
        for (const s2 of ['heat','optic','em','higgs']) {
            const v = selfSig[s2];
            if (v < 0.02) continue;
            const half = (0.12 + v * 0.32) * Math.PI;      // sig量で弧が伸びる
            ctx.globalAlpha = 0.28 + v * 0.55;
            ctx.strokeStyle = S_HEX[s2];
            ctx.lineWidth = (1 + v * 3.5) * zi;
            ctx.beginPath();
            ctx.arc(0, 0, haloR, S_DIR[s2] - half, S_DIR[s2] + half);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // ── (2) 気配リング (MGS4式) — "自機がどれだけ敵に見られているか" を六感的に表現 ──
        // 敵がプレイヤーを捉えている強さ(contactFreshness×状態)を、その敵の方角に「波」として出す。
        // 背後から強く見られていれば背後側が大きく波打つ。かすかなら小さく波打つ。沈黙で見られてなければ静か。
        const baseR = 86 * zi;
        const breath = Math.sin(tSec * 0.7) * 2.0 * zi;
        const GAZE_RANGE = 18000;
        const gazes = [];
        for (const e of enemies) {
            if (e.hp <= 0 || e._dying) continue;
            const dx = e.x - player.x, dy = e.y - player.y;
            const dist = Math.hypot(dx, dy);
            if (dist > GAZE_RANGE) continue;
            // 視認強度: 接触鮮度 × 状態重み (交戦=はっきり見られている / 追跡=気配 / それ以外=残り香)
            const stateW = e.aiState === 'combat' ? 1.0 : e.aiState === 'hunting' ? 0.85 : 0.5;
            const gaze = Math.min(1, (e.contactFreshness || 0) * stateW);
            if (gaze < 0.06) continue; // 見られていない敵は波を出さない(=居場所も分からない・対称)
            gazes.push({ ang: Math.atan2(dy, dx), gaze });
        }
        let maxGaze = 0;
        for (const g of gazes) if (g.gaze > maxGaze) maxGaze = g.gaze;

        const ringLw = zi;
        const N = 40, step = (Math.PI * 2) / N;
        const gazeAt = (ang) => {
            let r = baseR + breath;
            for (const g of gazes) {
                let d = ang - g.ang;
                if (d < -Math.PI) d += Math.PI * 2; else if (d > Math.PI) d -= Math.PI * 2;
                const env = Math.exp(-d * d * 2.0);            // その敵の方角に局在(やや広め)
                const bulge = g.gaze * 22 * zi;                 // 見られている側が張り出す
                const wave  = Math.sin(ang * 8 - tSec * 6.0) * g.gaze * 20 * zi
                            + Math.sin(ang * 15 + tSec * 3.5) * g.gaze * 9 * zi; // 波打ち(強いほど大)
                r += env * (bulge + wave);
            }
            return r;
        };
        // 気配の強さで色を穏やかな青緑→警戒の赤へ
        const gr = Math.round(120 + maxGaze * 135), gg = Math.round(220 - maxGaze * 150), gb = Math.round(210 - maxGaze * 140);
        ctx.globalAlpha = 0.24 + maxGaze * 0.5;
        ctx.strokeStyle = `rgb(${gr},${gg},${gb})`;
        ctx.lineWidth = (1.3 + maxGaze * 1.6) * ringLw;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
            const a = i * step, rr = gazeAt(a);
            const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
        // 強く見られている方角に薄いグロー弧 (危険方向の強調)。閾値付近の点滅を避けフェードで
        for (const g of gazes) {
            if (g.gaze < 0.25) continue;
            ctx.globalAlpha = Math.min(1, (g.gaze - 0.25) / 0.25) * (g.gaze - 0.2) * 0.5;
            ctx.strokeStyle = `rgb(${gr},${gg},${gb})`;
            ctx.lineWidth = (2 + g.gaze * 3) * ringLw;
            ctx.beginPath();
            const span = 0.5, segN = 12;
            for (let i = 0; i <= segN; i++) {
                const a = g.ang - span + (i / segN) * span * 2, rr = gazeAt(a);
                const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // ── (3) 受信シグネチャのブリップ (リング外周) — トラッキング中は識別 ──
        // 「今どんなシグネチャを受信しているか」をリング外周のマーカーで。ロック中の対象は強調表示。
        const _sigBlips = {}; // sourceId → { ang, sensor, life }
        for (const b of passiveBearings) {
            if (b.life <= 0) continue;
            const prev = _sigBlips[b.sourceId];
            if (!prev || b.life > prev.life) _sigBlips[b.sourceId] = { ang: b.angle, sensor: b.sensor, life: b.life, maxLife: b.maxLife };
        }
        for (const sid in _sigBlips) {
            const bl = _sigBlips[sid];
            const hex = S_HEX[bl.sensor] || '#cfe8e0';
            const rr = gazeAt(bl.ang);
            const isLocked = (sid === lockedSignalId);
            const _blAppear = Math.min(1, ((bl.maxLife || 480) - bl.life) / 45); // 出現をなじませる(第10弾)
            const fade = Math.max(0.25, bl.life / (bl.maxLife || 480)) * _blAppear;
            const bx = Math.cos(bl.ang), by = Math.sin(bl.ang);
            // 外向きの短いティック + ドット
            ctx.globalAlpha = fade * (isLocked ? 1 : 0.7);
            ctx.strokeStyle = hex;
            ctx.lineWidth = (isLocked ? 2.4 : 1.4) * ringLw;
            ctx.beginPath();
            ctx.moveTo(bx * (rr + 5 * zi), by * (rr + 5 * zi));
            ctx.lineTo(bx * (rr + (isLocked ? 20 : 13) * zi), by * (rr + (isLocked ? 20 : 13) * zi));
            ctx.stroke();
            ctx.fillStyle = hex;
            ctx.beginPath();
            ctx.arc(bx * (rr + (isLocked ? 20 : 13) * zi), by * (rr + (isLocked ? 20 : 13) * zi), (isLocked ? 3.2 : 2) * zi, 0, Math.PI * 2);
            ctx.fill();
            // トラッキング中: 二重リング(ロックブラケット)で識別
            if (isLocked) {
                ctx.globalAlpha = fade;
                ctx.lineWidth = 1.4 * ringLw;
                ctx.beginPath();
                ctx.arc(bx * (rr + 20 * zi), by * (rr + 20 * zi), 6 * zi, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = hex;
                ctx.font = `bold ${Math.round(8 * zi)}px Orbitron, monospace`;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('LCK', bx * (rr + 34 * zi), by * (rr + 34 * zi));
            }
        }
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

    // ミニマップ地形オーバーレイ: 現在センサーに対応する層を強調、他は薄く
    const _mmDim = 0.10; // 非対応層のフェード値
    if (bgMistCanvas) {
        minimapCtx.globalAlpha = currentSensor === 'higgs' ? 0.85 : _mmDim;
        minimapCtx.drawImage(bgMistCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (debrisCanvas) {
        minimapCtx.globalAlpha = currentSensor === 'optic' ? 0.85 : _mmDim;
        minimapCtx.drawImage(debrisCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (stormCanvas) {
        minimapCtx.globalAlpha = currentSensor === 'em' ? 0.80 : _mmDim;
        minimapCtx.drawImage(stormCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (thermalCanvas) {
        minimapCtx.globalAlpha = currentSensor === 'heat' ? 0.80 : _mmDim;
        minimapCtx.drawImage(thermalCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }

    // Viewport
    minimapCtx.strokeStyle = 'rgba(255,255,0,0.5)'; minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(camera.x * mmScale + offX, camera.y * mmScale + offY, (cssW / camera.zoom) * mmScale, (cssH / camera.zoom) * mmScale);

    // Structures (discovered/identified: with icon; unknown: hidden)
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
        } else if (st.identified) {
            // 特定済み: やや薄い菱形アイコンで表示
            minimapCtx.globalAlpha = 0.65;
            minimapCtx.fillStyle = st.type === 'colony' ? '#ffaa00' : '#888888';
            minimapCtx.shadowColor = minimapCtx.fillStyle; minimapCtx.shadowBlur = 1;
            minimapCtx.beginPath();
            minimapCtx.moveTo(mx, my - 3); minimapCtx.lineTo(mx + 3, my);
            minimapCtx.lineTo(mx, my + 3); minimapCtx.lineTo(mx - 3, my);
            minimapCtx.closePath(); minimapCtx.fill();
            minimapCtx.shadowBlur = 0;
            minimapCtx.globalAlpha = 1;
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

    // リソースノード (特定済みは通常表示; HIGGSセンサー時は微かに表示)
    resourceNodes.forEach(n => {
        if (!n.active) return;
        if (!n.identified && currentSensor !== 'higgs') return; // HIGGS以外で未特定は非表示
        const _nAlpha = n.identified ? 1 : 0.35;
        minimapCtx.globalAlpha = _nAlpha;
        minimapCtx.fillStyle = currentSensor === 'higgs' ? '#50c8ff' : 'rgba(80,200,255,0.4)';
        minimapCtx.shadowColor = '#50c8ff';
        minimapCtx.shadowBlur = currentSensor === 'higgs' ? 6 : 2;
        minimapCtx.beginPath();
        minimapCtx.arc(n.x * mmScale + offX, n.y * mmScale + offY, currentSensor === 'higgs' ? 4 : 2.5, 0, Math.PI * 2);
        minimapCtx.fill();
        minimapCtx.shadowBlur = 0;
        minimapCtx.globalAlpha = 1;
    });

    // 特定済み地形効果 (熱雲帯=橙 / 磁気嵐帯=紫 / ヒッグス高濃度域=青) — 小リングで恒久表示
    {
        const _mmTerr = [
            { arr: (typeof thermalField !== 'undefined' ? thermalField : []), col: '#ffaa44' },
            { arr: (typeof stormField   !== 'undefined' ? stormField   : []), col: '#b47af0' },
            { arr: (typeof bgMist       !== 'undefined' ? bgMist       : []), col: '#5a9cff' }
        ];
        minimapCtx.globalAlpha = 0.75;
        minimapCtx.lineWidth = 1;
        for (const set of _mmTerr) {
            minimapCtx.strokeStyle = set.col;
            for (const f of set.arr) {
                if (!f || !f.identified) continue;
                minimapCtx.beginPath();
                minimapCtx.arc(f.x * mmScale + offX, f.y * mmScale + offY, Math.max(2, (f.r || 800) * mmScale * 0.6), 0, Math.PI * 2);
                minimapCtx.stroke();
            }
        }
        minimapCtx.globalAlpha = 1;
    }

    // 前任艦の残骸 (灰色ダイヤ)
    if (playerWreckObj) {
        const _wmx = playerWreckObj.x * mmScale + offX, _wmy = playerWreckObj.y * mmScale + offY;
        minimapCtx.globalAlpha = 0.7;
        minimapCtx.strokeStyle = '#9ab0bb';
        minimapCtx.lineWidth = 1;
        minimapCtx.beginPath();
        minimapCtx.moveTo(_wmx, _wmy - 3.5); minimapCtx.lineTo(_wmx + 3.5, _wmy);
        minimapCtx.lineTo(_wmx, _wmy + 3.5); minimapCtx.lineTo(_wmx - 3.5, _wmy);
        minimapCtx.closePath(); minimapCtx.stroke();
        minimapCtx.globalAlpha = 1;
    }
    // 遭難信号ビーコン (SOS — 電波なので常時可視)
    if (distressBeacon && !distressBeacon.claimed) {
        const _bmx = distressBeacon.x * mmScale + offX, _bmy = distressBeacon.y * mmScale + offY;
        minimapCtx.globalAlpha = 0.55 + Math.sin(Date.now() * 0.008) * 0.35;
        minimapCtx.strokeStyle = '#00e5ff';
        minimapCtx.lineWidth = 1.2;
        minimapCtx.beginPath();
        minimapCtx.moveTo(_bmx, _bmy - 4); minimapCtx.lineTo(_bmx + 4, _bmy);
        minimapCtx.lineTo(_bmx, _bmy + 4); minimapCtx.lineTo(_bmx - 4, _bmy);
        minimapCtx.closePath(); minimapCtx.stroke();
        minimapCtx.globalAlpha = 1;
    }

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

    // §4-4: 三角測量サークルをミニマップに表示
    if (triangulationResult) {
        const { x: tx, y: ty, precision: tp, radius: tr, frame: tf } = triangulationResult;
        const _mmAf = Math.max(0, 1 - (_frameCount - tf) * TRIG_DECAY_PER_FRAME);
        if (_mmAf > 0.01) {
            const _mmx = tx * mmScale + offX, _mmy = ty * mmScale + offY;
            const _mmr = Math.max(3, tr * mmScale);
            const _mmCol = tp < 0.3 ? '255,80,0' : tp < 0.6 ? '255,160,0' : tp < 0.9 ? '80,255,120' : '100,200,255';
            minimapCtx.globalAlpha = 0.7 * _mmAf;
            minimapCtx.strokeStyle = `rgb(${_mmCol})`;
            minimapCtx.lineWidth = 1;
            minimapCtx.setLineDash([3, 3]);
            minimapCtx.beginPath(); minimapCtx.arc(_mmx, _mmy, _mmr, 0, Math.PI * 2); minimapCtx.stroke();
            minimapCtx.setLineDash([]);
            minimapCtx.lineWidth = 1;
            minimapCtx.beginPath(); minimapCtx.moveTo(_mmx - 4, _mmy); minimapCtx.lineTo(_mmx + 4, _mmy); minimapCtx.stroke();
            minimapCtx.beginPath(); minimapCtx.moveTo(_mmx, _mmy - 4); minimapCtx.lineTo(_mmx, _mmy + 4); minimapCtx.stroke();
            // ゴースト点 (精度≥80%かつ速度既知)
            if (tp >= 0.80 && triangulationVelocity && (_frameCount - triangulationVelocity.frame) < 1200) {
                const _mmDt = _frameCount - tf;
                const _gmx = (tx + triangulationVelocity.vx * _mmDt) * mmScale + offX;
                const _gmy = (ty + triangulationVelocity.vy * _mmDt) * mmScale + offY;
                minimapCtx.globalAlpha = 0.75 * _mmAf;
                minimapCtx.fillStyle = `rgb(${_mmCol})`;
                minimapCtx.beginPath(); minimapCtx.arc(_gmx, _gmy, 3, 0, Math.PI * 2); minimapCtx.fill();
            }
            minimapCtx.globalAlpha = 1;
        }
    }

    // クリップ解除後に円形境界線
    minimapCtx.restore();
    minimapCtx.beginPath();
    minimapCtx.arc(cxM, cyM, rM, 0, Math.PI * 2);
    minimapCtx.strokeStyle = 'rgba(0,255,170,0.5)';
    minimapCtx.lineWidth = 1.5;
    minimapCtx.stroke();
    // ミニマップ外縁ラジアル目盛り (10°ごとティック・30°ごと数字)
    minimapCtx.save();
    minimapCtx.textAlign = 'center'; minimapCtx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 10) {
        const rad = (deg - 90) * Math.PI / 180;
        const isCardinal = deg % 90 === 0;
        const isMid      = deg % 30 === 0;
        const tickIn     = isCardinal ? 6 : isMid ? 4 : 2.5;
        const x0 = cxM + Math.cos(rad) * rM, y0 = cyM + Math.sin(rad) * rM;
        const x1 = cxM + Math.cos(rad) * (rM - tickIn), y1 = cyM + Math.sin(rad) * (rM - tickIn);
        minimapCtx.globalAlpha = isCardinal ? 0.75 : isMid ? 0.50 : 0.28;
        minimapCtx.strokeStyle = '#00ffcc';
        minimapCtx.lineWidth = isCardinal ? 1.5 : isMid ? 1.0 : 0.6;
        minimapCtx.beginPath(); minimapCtx.moveTo(x0, y0); minimapCtx.lineTo(x1, y1); minimapCtx.stroke();
    }
    minimapCtx.restore();
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

    // 地形層描画: 通常プレイは全層表示、マップモード時は現在センサーに対応する層のみ強調
    // (センサー依存型マップ: HIGGS→ヒッグス雲 / OPTIC→デブリ / EM→磁気嵐 / HEAT→熱雲)
    const _mapFade = 0.07; // マップモード時の非対応層のフェード値
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (bgMistCanvas) {
        ctx.globalAlpha = (!mapMode || currentSensor === 'higgs') ? 1.0 : _mapFade;
        ctx.drawImage(bgMistCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.globalAlpha = 1;
    }
    if (debrisCanvas) {
        ctx.globalAlpha = (!mapMode || currentSensor === 'optic') ? 1.0 : _mapFade;
        ctx.drawImage(debrisCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.globalAlpha = 1;
    }
    if (stormCanvas) {
        const _sa = (!mapMode || currentSensor === 'em') ? 0.82 + Math.sin(Date.now() * 0.006) * 0.12 : _mapFade;
        ctx.save(); ctx.globalAlpha = _sa; ctx.imageSmoothingEnabled = true;
        ctx.drawImage(stormCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE); ctx.restore();
    }
    if (thermalCanvas) {
        const _ta = (!mapMode || currentSensor === 'heat') ? 0.78 + Math.sin(Date.now() * 0.003 + 2.1) * 0.12 : _mapFade;
        ctx.save(); ctx.globalAlpha = _ta; ctx.imageSmoothingEnabled = true;
        ctx.drawImage(thermalCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE); ctx.restore();
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
    // ラジアル方位目盛りはヒッグスフォグより手前に描画するためgameLoopへ移動
}

// オシロスコープ風シグネチャ表示
const _sigHistory = { heat: [], optic: [], em: [], higgs: [] };
const _SIG_HIST_LEN = 60;

// 環境シグネチャ履歴 (周囲の敵シグネチャ合算)
const _envSigHistory = { heat: [], optic: [], em: [], higgs: [] };
const ENV_SIG_HIST_LEN = 60;
// 折りたたみ時の受信シグネチャ(RX)メーター用の平滑化値 (env-sig-canvasの代替)
const _rxSig = { heat: 0, optic: 0, em: 0, higgs: 0 };

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
// シグネチャ解析ステータスバー更新 (sig-info-bar)
// 1秒前スナップショットとの差分でレートを計算
// ============================================================
let _sibSnap = { dir: 0, tri: 0, snapTime: 0 };  // 1秒前のスナップショット
let _sibLastDir = 0, _sibLastTri = 0;             // 直前値 (レート保持用)
let _sibDirRate = 0, _sibTriRate = 0;             // 最新レート (%/sec)
function updateSigInfoBar() {
    const lockEl  = document.getElementById('sib-lock-status');
    const dirEl   = document.getElementById('sib-dir');
    const dirRate = document.getElementById('sib-dir-rate');
    const triEl   = document.getElementById('sib-tri');
    const triRate = document.getElementById('sib-tri-rate');
    if (!lockEl) return;

    if (!lockedSignalId || !_signalAnalysis[lockedSignalId]) {
        lockEl.textContent = 'UNLOCKED';
        lockEl.className = '';
        if (dirEl) dirEl.textContent = '--.--%';
        if (triEl) triEl.textContent = '--.--%';
        if (dirRate) dirRate.textContent = '';
        if (triRate) triRate.textContent = '';
        _sibSnap.snapTime = 0;
        return;
    }

    const sa  = _signalAnalysis[lockedSignalId];
    const dir = sa.dirAnalysis || 0;
    const tri = sa.triParam   || 0;
    const now = Date.now();

    // 1秒ごとにスナップを更新し、その差分をレートとして確定
    if (_sibSnap.snapTime === 0) {
        _sibSnap = { dir, tri, snapTime: now };
    } else if (now - _sibSnap.snapTime >= 1000) {
        const elapsed = (now - _sibSnap.snapTime) / 1000;
        _sibDirRate = (dir - _sibSnap.dir) / elapsed;
        _sibTriRate = (tri - _sibSnap.tri) / elapsed;
        _sibSnap = { dir, tri, snapTime: now };
    }

    const fmtRate = r => Math.abs(r) < 0.005 ? '' : `(${r >= 0 ? '+' : ''}${r.toFixed(2)}%/s)`;

    // 解析フェーズ表示 (2026-07-11): 「いつ次のシグネチャへ切替えるか」の判断材料。
    // 静止源(ランドマーク/地形)なら閾値18%で自動特定→ロック解除されるため、
    // 18%を超えてもロックが残っている = 機動反応 (=攻撃目標候補) と絞り込める。
    const _sibAvg = (dir + tri) / 2;
    let _sibPhase;
    if (sa.classified) _sibPhase = '機動反応=目標';
    else if (_sibAvg > ID_THRESHOLD_STATIC) _sibPhase = '非ランドマーク';
    else _sibPhase = `解析${Math.round(_sibAvg)}%`;
    lockEl.textContent = `LCK:${lockedSignalId} [${_sibPhase}]`;
    lockEl.className = 'locked';
    if (dirEl) dirEl.textContent = dir.toFixed(1) + '%';
    if (triEl) triEl.textContent = tri.toFixed(1) + '%';
    if (dirRate) dirRate.textContent = fmtRate(_sibDirRate);
    if (triRate) triRate.textContent = fmtRate(_sibTriRate);
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
        if (msbHpText) { msbHpText.textContent = hpPct + '%'; msbHpText.style.color = hpPct < 25 ? '#ff4d4d' : hpPct < 55 ? '#ffaa44' : '#00ffaa'; }
        if (msbHiggs) msbHiggs.textContent = Math.round(getHiggsIntensity(player.x, player.y) * 100) + '%';
        if (msbDebris) msbDebris.textContent = Math.round(getDebrisIntensity(player.x, player.y) * 100) + '%';
        if (msbStorm) msbStorm.textContent = Math.round(getStormIntensity(player.x, player.y) * 100) + '%';
        const msbThermal = document.getElementById('msb-thermal');
        if (msbThermal) msbThermal.textContent = Math.round(getThermalIntensity(player.x, player.y) * 100) + '%';
        if (msbEnemies) msbEnemies.textContent = enemies.filter(e => e.visible).length || '?';
        if (msbAmmo) {
            const wTypeMsb = document.getElementById('weapon-select')?.value || 'kinetic';
            if (wTypeMsb === 'kinetic') {
                if (player.kineticReloading) {
                    const _kMax = KINETIC_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0);
                    const _kPct = Math.round((1 - player.kineticReloadTimer / _kMax) * 100);
                    msbAmmo.textContent = `RLD(${_kPct}%)`;
                } else {
                    msbAmmo.textContent = `${player.kineticAmmo}/${player.kineticMaxAmmo}`;
                }
                msbAmmo.style.color = player.kineticReloading ? '#ff4444' : '#ffaa00';
            } else {
                const _rld = (wTypeMsb === 'missile' ? player.missileReloading : player.beamReloading);
                if (_rld) {
                    const _rldTimer = wTypeMsb === 'missile' ? player.missileReloadTimer : player.beamReloadTimer;
                    const _rldMax = wTypeMsb === 'missile'
                        ? MISSILE_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0)
                        : BEAM_RELOAD_TIME;
                    const _rldPct = Math.round((1 - _rldTimer / _rldMax) * 100);
                    msbAmmo.textContent = `RLD(${_rldPct}%)`;
                } else {
                    msbAmmo.textContent = 'RDY';
                }
                msbAmmo.style.color = _rld ? '#ff4444' : '#00ff88';
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
    const _rep = document.getElementById('go-report');
    if (_rep) _rep.textContent = '戦闘詳報 — ' + formatHuntReport();
    // 前任艦の残骸: 喪失クレジットの一部が次の出撃でサルベージ可能になる
    gameState.wreckSalvage = Math.max(100, Math.floor(gameState.credits * 0.35));
    saveGame();
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
function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function drawHUDOverlay(ctx) {
    if (!player || player.hp <= 0) return;
    const { sx: psx, sy: psy } = worldToScreen(player.x, player.y);
    const t = Date.now();

    // ── 露出度メーター (被探知状態) — フィールド上部中央の常時チップ ──
    // 「今、隠れられているのか?」を1目で分かるように。潜水艦ゲームの緊張の芯。
    {
        const exL = playerExposureLevel;
        const exCol = exL === 0 ? '#00ff88' : exL === 1 ? '#ffdd00' : exL === 2 ? '#ff9500' : '#ff3344';
        const exTxt = exL === 0 ? '隠密' : exL === 1 ? '痕跡' : exL === 2 ? '追跡' : '捕捉';
        const _fW = cssW - uiInsets().right; // 実フィールド幅 (横持ちは右コンソール分を除く)
        const _fCX = _fW / 2;
        const chipY = 158;
        ctx.save();
        // ── 露出度ピル (小型化): ドット + 短い状態名。隠れている時は控えめ、見られるほど強調 ──
        const _pl = exL >= 2 ? (0.6 + Math.sin(t * (exL === 3 ? 0.02 : 0.01)) * 0.35) : 0.7;
        ctx.font = 'bold 10px Orbitron, monospace';
        const _pillTextW = ctx.measureText(exTxt).width;
        const _pillW = _pillTextW + 26, _pillH = 15, _pillX = _fCX - _pillW / 2;
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#000d08';
        _roundRect(ctx, _pillX, chipY, _pillW, _pillH, 7); ctx.fill();
        ctx.globalAlpha = _pl;
        ctx.strokeStyle = exCol; ctx.lineWidth = 1;
        _roundRect(ctx, _pillX, chipY, _pillW, _pillH, 7); ctx.stroke();
        ctx.fillStyle = exCol;
        ctx.beginPath(); ctx.arc(_pillX + 9, chipY + _pillH / 2, 3, 0, Math.PI * 2); ctx.fill();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(exTxt, _pillX + 16, chipY + _pillH / 2 + 0.5);
        const chipH = _pillH; // 後続のサージ/損傷表示の基準に流用
        // 捕捉中: 画面縁を赤くパルス (狩られている感)
        if (exL === 3) {
            ctx.globalAlpha = 0.10 + Math.sin(t * 0.02) * 0.07;
            ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 10;
            ctx.strokeRect(5, 5, cssW - 10, cssH - 10);
        }
        // ── コンパス (磁気方位・360°) — 艦首の向きを水平テープで表示 ──
        {
            const headingDeg = (Math.atan2(Math.cos(player.angle), -Math.sin(player.angle)) * 180 / Math.PI + 360) % 360;
            const tapeY = chipY + _pillH + 26, halfW = 78, spanDeg = 90; // ピルと重ならないよう十分下げる
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = '#00e0c0'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(_fCX - halfW, tapeY); ctx.lineTo(_fCX + halfW, tapeY); ctx.stroke();
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            const CARD = { 0:'N', 90:'E', 180:'S', 270:'W' };
            for (let off = -spanDeg; off <= spanDeg; off += 15) {
                let deg = Math.round(headingDeg + off); deg = ((deg % 360) + 360) % 360;
                const x = _fCX + (off / spanDeg) * halfW;
                const isCard = deg % 90 === 0;
                ctx.globalAlpha = 0.35 + (1 - Math.abs(off) / spanDeg) * 0.4;
                ctx.strokeStyle = isCard ? '#5affd0' : '#2a8c7c'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x, tapeY - (isCard ? 5 : 3)); ctx.lineTo(x, tapeY); ctx.stroke();
                if (isCard) { ctx.fillStyle = '#5affd0'; ctx.font = 'bold 8px Orbitron, monospace'; ctx.fillText(CARD[deg] || '', x, tapeY + 2); }
            }
            // 中央キャレット + 数値
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = '#eafff8';
            ctx.beginPath(); ctx.moveTo(_fCX, tapeY - 7); ctx.lineTo(_fCX - 4, tapeY - 12); ctx.lineTo(_fCX + 4, tapeY - 12); ctx.closePath(); ctx.fill();
            ctx.font = 'bold 10px Orbitron, monospace'; ctx.textBaseline = 'bottom';
            ctx.fillText(('' + Math.round(headingDeg)).padStart(3, '0') + '°', _fCX, tapeY - 13);
        }
        // ── 受信シグネチャ(RX)メーター — 折りたたみ時のみ。env-sig-canvas(環境SIGオシロ)の代替 ──
        // 「今どのセンサーchをどれだけ受信しているか」を4本の小バーで。平滑化して穏やか・無受信時は静か。
        if (consoleMin) {
            const envDetectRange = FIELD_SIZE;
            const _rxTarget = { heat: 0, optic: 0, em: 0, higgs: 0 };
            for (const e of enemies) {
                if (e.hp <= 0) continue;
                const dist = Math.hypot(e.x - player.x, e.y - player.y);
                const hPath = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
                const dAtt = Math.max(0, 1 - dist / envDetectRange);
                for (const k of ['heat', 'optic', 'em', 'higgs']) {
                    const sc2 = sensorConfig[k];
                    _rxTarget[k] = Math.min(1, _rxTarget[k] + sc2.sig(e) * dAtt * (1 - hPath * sc2.higgsMod));
                }
            }
            const RX_HEX = { heat: '#ff8a3c', optic: '#ffee55', em: '#c86bff', higgs: '#4fe6ff' };
            const RX_LABEL = { heat: 'H', optic: 'O', em: 'E', higgs: 'G' };
            let _rxMax = 0;
            for (const k of ['heat', 'optic', 'em', 'higgs']) {
                _rxSig[k] += (_rxTarget[k] - _rxSig[k]) * 0.12; // 平滑化(パッパッしない)
                if (_rxSig[k] > _rxMax) _rxMax = _rxSig[k];
            }
            // 左辺・ミニマップの下に小さく配置
            const mx = 10, myTop = 176, barW = 52, rowH = 11, panelPad = 5;
            const panelW = 20 + barW + panelPad * 2, panelH = 14 + rowH * 4 + panelPad;
            ctx.save();
            ctx.globalAlpha = 0.28 + _rxMax * 0.45;
            ctx.fillStyle = 'rgba(0,10,16,0.72)';
            _roundRect(ctx, mx, myTop, panelW, panelH, 4); ctx.fill();
            ctx.globalAlpha = 0.5 + _rxMax * 0.4;
            ctx.fillStyle = '#7fd8bb';
            ctx.font = 'bold 7px Orbitron, monospace';
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText('RX SIG', mx + panelPad, myTop + 7);
            let ry = myTop + 14 + panelPad;
            for (const k of ['heat', 'optic', 'em', 'higgs']) {
                const v = _rxSig[k];
                const bx = mx + panelPad + 12, by = ry + rowH / 2;
                // ラベル
                ctx.globalAlpha = 0.5 + v * 0.5;
                ctx.fillStyle = RX_HEX[k];
                ctx.font = 'bold 8px monospace';
                ctx.fillText(RX_LABEL[k], mx + panelPad, by + 0.5);
                // トラック
                ctx.globalAlpha = 0.35;
                ctx.fillStyle = 'rgba(255,255,255,0.10)';
                ctx.fillRect(bx, by - 2.5, barW, 5);
                // 受信量バー (sqrtで微弱でも視認)
                const fillW = Math.sqrt(Math.max(0, v)) * barW;
                ctx.globalAlpha = 0.35 + v * 0.6;
                ctx.fillStyle = RX_HEX[k];
                ctx.fillRect(bx, by - 2.5, fillW, 5);
                ry += rowH;
            }
            ctx.restore();
            ctx.globalAlpha = 1;
        }
        // ── ヒッグスサージ表示 ──
        let _infoY = chipY + chipH + 46; // コンパステープの下から
        if (surgePhase !== 'none') {
            const sTxt = surgePhase === 'warn' ? '⚠ ヒッグスサージ接近' : surgePhase === 'active' ? 'サージ通過中 — 全センサー縮退' : 'クリアリング — 高感度ウィンドウ';
            const sCol = surgePhase === 'active' ? '#66aaff' : surgePhase === 'warn' ? '#ffdd00' : '#00ffcc';
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = sCol;
            ctx.font = 'bold 11px Orbitron, monospace';
            ctx.fillText(sTxt, _fCX, _infoY);
            _infoY += 15;
            if (surgePhase === 'active') {
                // サージ中の白靄オーバーレイ (センサーが利かない体感)
                ctx.globalAlpha = 0.06 + Math.sin(t * 0.004) * 0.03;
                ctx.fillStyle = '#bfd9ff';
                ctx.fillRect(0, 0, cssW, cssH);
            }
        }
        // ── 自機サブシステム損傷表示 ──
        if (player._weaponJamTimer > 0 || player._sysEngineTimer > 0 || player._sysSensorTimer > 0) {
            ctx.globalAlpha = 0.6 + Math.sin(t * 0.015) * 0.3;
            ctx.fillStyle = '#ff9500';
            ctx.font = 'bold 11px Orbitron, monospace';
            let dmgTxt = '';
            if (player._weaponJamTimer > 0) dmgTxt += '火器管制ダウン ';
            if (player._sysEngineTimer > 0) dmgTxt += '機関損傷 ';
            if (player._sysSensorTimer > 0) dmgTxt += 'センサー損傷';
            ctx.fillText(dmgTxt, _fCX, _infoY);
        }
        // ── 奇襲可能インジケータ: 完全ロック中 & 敵が自分に気付いていない ──
        const te = player.targetEntity;
        if (te && te.hp > 0 && te.inVision && te.detectionState === 'unaware') {
            const _tp = worldToScreen(te.x, te.y);
            ctx.globalAlpha = 0.75 + Math.sin(t * 0.012) * 0.25;
            ctx.fillStyle = '#ffd24a';
            ctx.font = 'bold 12px Orbitron, monospace';
            ctx.fillText('奇襲可能 ×3.5', _tp.sx, _tp.sy - 36);
        }
        // ── 静粛航行 / デブリ擬態 インジケータ ──
        if (isBottomed) {
            ctx.globalAlpha = 0.75 + Math.sin(t * 0.004) * 0.2;
            ctx.fillStyle = '#99bbcc';
            ctx.font = 'bold 11px Orbitron, monospace';
            ctx.fillText('デブリ擬態中 — 岩塊に艦影が紛れている', _fCX, chipY - 10);
        } else if (silentRunning) {
            ctx.globalAlpha = 0.7 + Math.sin(t * 0.006) * 0.2;
            ctx.fillStyle = '#66ccff';
            ctx.font = 'bold 11px Orbitron, monospace';
            ctx.fillText('静粛航行中 — 速度/シグネチャ抑制', _fCX, chipY - 10);
        }
        // ── ニアミス「息を殺せ」表示 ──
        if (nearMissActive) {
            ctx.globalAlpha = 0.6 + Math.sin(t * 0.02) * 0.35;
            ctx.fillStyle = '#ffcc66';
            ctx.font = 'bold 12px Orbitron, monospace';
            ctx.fillText('敵艦至近 — 息を殺せ', _fCX, chipY + chipH + 28);
        }
        // ── チャージビーム進捗リング (自機周り) ──
        if ((player._beamCharge || 0) > 0) {
            const _cf = Math.min(1, player._beamCharge / BEAM_CHARGE_DUR);
            ctx.globalAlpha = 0.30 + _cf * 0.55;
            ctx.strokeStyle = '#00eaff';
            ctx.lineWidth = 2 + _cf * 3;
            ctx.beginPath();
            ctx.arc(psx, psy, 26 + _cf * 16, -Math.PI / 2, -Math.PI / 2 + _cf * Math.PI * 2);
            ctx.stroke();
            if (_cf >= 1) {
                ctx.globalAlpha = 0.8;
                ctx.fillStyle = '#00eaff';
                ctx.font = 'bold 11px Orbitron, monospace';
                ctx.fillText('CHARGED', psx, psy - 48);
            }
        }
        // ── 被弾方向インジケータ: 撃たれた方位を自機周りの赤アークで表示 (第4弾) ──
        for (let hd = playerHitDirs.length - 1; hd >= 0; hd--) {
            const h = playerHitDirs[hd];
            h.life -= gameSpeedFactor;
            if (h.life <= 0) { playerHitDirs.splice(hd, 1); continue; }
            ctx.globalAlpha = Math.min(0.85, h.life / HIT_DIR_LIFE);
            ctx.strokeStyle = '#ff3344';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(psx, psy, 44, h.ang - 0.5, h.ang + 0.5);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // ── ミサイル接近警報マーカー: 接近中の敵ミサイルの方位を自機周りに赤矢印表示 ──
        for (const pr of projectiles) {
            if (pr.isPlayer || pr.type !== 'missile' || !pr._torpAlerted || !pr.active) continue;
            const bAng = Math.atan2(pr.y - player.y, pr.x - player.x);
            ctx.save();
            ctx.translate(psx + Math.cos(bAng) * 54, psy + Math.sin(bAng) * 54);
            ctx.rotate(bAng);
            ctx.globalAlpha = 0.55 + Math.sin(t * 0.03) * 0.45;
            ctx.fillStyle = '#ff2233';
            ctx.beginPath();
            ctx.moveTo(9, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6);
            ctx.closePath(); ctx.fill();
            ctx.restore();
        }
        // ── 前任艦の残骸マーカー (第5弾): 灰色ダイヤ + WRECK ──
        if (playerWreckObj) {
            const _wp2 = worldToScreen(playerWreckObj.x, playerWreckObj.y);
            const wx2 = Math.max(24, Math.min(cssW - 24, _wp2.sx));
            const wy2 = Math.max(90, Math.min(cssH - 30, _wp2.sy));
            ctx.globalAlpha = 0.45 + Math.sin(t * 0.004) * 0.2;
            ctx.strokeStyle = '#9ab0bb'; ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(wx2, wy2 - 9); ctx.lineTo(wx2 + 9, wy2); ctx.lineTo(wx2, wy2 + 9); ctx.lineTo(wx2 - 9, wy2);
            ctx.closePath(); ctx.stroke();
            ctx.fillStyle = '#9ab0bb';
            ctx.font = 'bold 9px Orbitron, monospace';
            ctx.fillText('WRECK', wx2, wy2 + 20);
        }
        // ── 遭難信号マーカー: 画面内はその位置、画面外は縁にクランプして方向を示す ──
        if (distressBeacon && !distressBeacon.claimed) {
            const _bp = worldToScreen(distressBeacon.x, distressBeacon.y);
            const bx = Math.max(24, Math.min(cssW - 24, _bp.sx));
            const by = Math.max(90, Math.min(cssH - 30, _bp.sy));
            const _bPulse = 0.55 + Math.sin(t * 0.008) * 0.35;
            ctx.globalAlpha = _bPulse;
            ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(bx, by - 10); ctx.lineTo(bx + 10, by); ctx.lineTo(bx, by + 10); ctx.lineTo(bx - 10, by);
            ctx.closePath(); ctx.stroke();
            ctx.fillStyle = '#00e5ff';
            ctx.font = 'bold 10px Orbitron, monospace';
            ctx.fillText('SOS', bx, by + 22);
        }
        ctx.restore();
    }

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
        // §3-5残: 強EMで接触が薄い敵のlastKnownPosをデコイ位置へ書き換える (誤誘導)
        // contactFreshness < 0.5 = プレイヤーを~25フレーム以上未探知。視野外デコイ誘引の補完として機能。
        if (d.life % 30 === 0 && enemies) {
            for (const e of enemies) {
                if (e.hp <= 0 || e.contactFreshness >= 0.5) continue;
                const dd = Math.hypot(e.x - d.x, e.y - d.y);
                if (dd < DECOY_MISDIRECT_RADIUS) {
                    e.playerLastKnownPos = { x: d.x, y: d.y, vx: d.vx * 8, vy: d.vy * 8 };
                    e.contactFreshness = 0.45; // 偽の確信 (次の真の探知で即上書き可)
                    if (!d.misdirected) { d.misdirected = true; logMessage('DECOY: 敵AIが誤誘引 — 追尾が偽位置へシフト', 'warning-msg'); }
                }
            }
        }
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
    // §3-6残: 建設系ドローン展開中は空母が停止 (脆弱ウィンドウ)
    if (['build', 'barrier', 'buoy', 'higgs'].includes(type)) {
        buildingTimer = BUILD_STOP_DUR;
        logMessage(`DRONE: ${DRONE_LABELS[type]} 展開 — 建設中 (${(BUILD_STOP_DUR/60).toFixed(0)}秒停止・全センサーに脆弱)`, 'warning-msg');
    } else {
        logMessage(`DRONE: ${DRONE_LABELS[type]} 展開 (${playerDrones.length}/${CARGO_CAP.carrier})`, 'system-msg');
    }
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
// ═══ 静粛航行 (Silent Running) ═══
// ワンボタンで機関出力とシグネチャを絞る潜水艦の象徴的動作。発砲・ソナー使用で自動解除。
function toggleSilentRunning() {
    silentRunning = !silentRunning;
    _updateSilentBtn();
    logMessage(silentRunning
        ? 'SILENT: 静粛航行 — 機関出力を絞り全シグネチャ抑制。発砲/ソナーで解除される'
        : 'SILENT: 静粛航行解除 — 通常出力に復帰', 'system-msg');
    playSound('ui');
}
function _updateSilentBtn() {
    const b = document.getElementById('btn-silent');
    if (!b) return;
    b.style.borderColor = silentRunning ? '#66ccff' : '#1a3a4a';
    b.style.color = silentRunning ? '#aaddff' : '#6699bb';
    const lbl = document.getElementById('silent-label');
    if (lbl) lbl.textContent = silentRunning ? '静粛 ON' : '静粛 OFF';
}
function cancelSilentRunning(reason) {
    if (!silentRunning) return;
    silentRunning = false;
    _updateSilentBtn();
    logMessage('SILENT: 静粛航行解除 — ' + reason, 'warning-msg');
}

// ═══ チャージビーム (第3弾) ═══
// 発射前2秒チャージで威力×2.2。チャージ中は熱/EMが激増し、敵AIの「chargingシグネチャ推定→
// 側方回避」が本物の駆け引きになる。撃ち切りの決断 vs 露出のリスク。
function toggleBeamCharge() {
    beamChargeMode = !beamChargeMode;
    const b = document.getElementById('btn-beam-charge');
    if (b) { b.style.borderColor = beamChargeMode ? '#00ddff' : '#1a3a4a'; b.style.color = beamChargeMode ? '#66eeff' : '#6699bb'; }
    const l = document.getElementById('beam-charge-label');
    if (l) l.textContent = beamChargeMode ? 'CHG ON' : 'CHG OFF';
    logMessage(beamChargeMode
        ? 'WEP: チャージビームモード — 発射前2秒チャージで威力×2.2。チャージ中は熱/EM激増'
        : 'WEP: チャージビームモード解除 — 即時発射', 'system-msg');
    playSound('ui');
}

// ═══ 通信傍受 (第3弾) ═══
// EMセンサー選択中、近距離でEM放射の強い敵の艦内通信を垣間見る。
// これまで完全に不可視だった敵AIの内面 (状態・性格・意図) がEMセンサーの新たな価値になる。
function interceptEnemyComms() {
    if (_commsInterceptCD > 0) { _commsInterceptCD -= gameSpeedFactor; return; }
    if (currentSensor !== 'em' || !player || player.hp <= 0) return;
    for (const e of enemies) {
        if (e.hp <= 0 || e.type === 'fighter') continue;
        if (Math.hypot(e.x - player.x, e.y - player.y) > COMMS_INTERCEPT_RANGE) continue;
        if ((e.emSig || 0) < 0.20) continue;
        let line;
        const hpFrac = e.hp / e.maxHp;
        if (hpFrac < 0.25)                line = '『被害甚大…離脱ベクトル要請…』';
        else if (e.aiState === 'combat')  line = '『目標捕捉、火器管制回せ！』';
        else if (e.aiState === 'hunting') line = (e.contactFreshness > 0.4) ? '『痕跡は新しい。近いぞ…』' : '『接触ロスト。捜索パターン継続』';
        else if (e.aiState === 'gathering') line = '『資源回収を先行する』';
        else line = (e.personality && e.personality.stealth > 0.55) ? '『無線封鎖を維持…静かにやれ』' : '『哨戒継続。異常なし』';
        logMessage(`EM傍受: ${line}`, 'system-msg');
        _commsInterceptCD = 900 + Math.random() * 600; // 15〜25s
        return;
    }
}

// ═══ 戦闘詳報 (第3弾) ═══
function formatHuntReport() {
    if (!huntStats) return '';
    const _fmt = (f) => { const s = Math.max(0, Math.round(f / 60)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const fc = huntStats.firstContact >= 0 ? _fmt(huntStats.firstContact) : '—';
    const dur = _fmt(_frameCount - huntStats.startFrame);
    return `作戦時間 ${dur} / 初接触 ${fc} / 奇襲成功 ${huntStats.ambushes} / システム破壊 ${huntStats.crits} / 被捕捉 ${huntStats.timesEngaged}回 / 与ダメ ${huntStats.dmgDealt} / 被ダメ ${huntStats.dmgTaken} / 敵探信 ${huntStats.pings}回`;
}

// ═══ 遭難信号イベント (収束装置) ═══
// 周期的に遭難信号が発生し、報酬 (SCR+修復 / 敵は自己強化) を賭けて両ハンターを
// 同じ海域へ引き寄せる。先に着くか、着く敵を待ち伏せるか — 「場所を知っている」こと自体が武器になる。
function updateDistressBeacon() {
    if (!player || player.hp <= 0) return;
    if (!distressBeacon) {
        distressNextTimer -= gameSpeedFactor;
        if (distressNextTimer <= 0) {
            let bx, by;
            const ders = structures.filter(s => s.type === 'derelict');
            if (ders.length > 0 && Math.random() < 0.6) {
                const d = ders[Math.floor(Math.random() * ders.length)];
                bx = d.x; by = d.y;
            } else {
                const a = Math.random() * Math.PI * 2, r = Math.random() * MAP_RADIUS * 0.5;
                bx = MAP_CX + Math.cos(a) * r; by = MAP_CY + Math.sin(a) * r;
            }
            distressBeacon = { x: bx, y: by, life: DISTRESS_LIFE, claimed: false };
            logMessage('SIGNAL: 遭難信号を受信 — 発信源に物資反応 (SOSマーカー)。敵も同じ信号を聞いている', 'warning-msg');
            playSound('alert');
        }
        return;
    }
    distressBeacon.life -= gameSpeedFactor;
    if (distressBeacon.life <= 0) {
        logMessage('SIGNAL: 遭難信号が途絶えた — 回収機会喪失', 'system-msg');
        distressBeacon = null;
        distressNextTimer = DISTRESS_INTERVAL_MIN + Math.random() * DISTRESS_INTERVAL_VAR;
        return;
    }
    // プレイヤー回収
    if (Math.hypot(player.x - distressBeacon.x, player.y - distressBeacon.y) < 400) {
        player.hp = Math.min(player.maxHp, player.hp + player.maxHp * 0.15);
        gameState.credits += 300;
        updateTopUI();
        playSound('ui');
        effects.push({ x: distressBeacon.x, y: distressBeacon.y, r: 0, maxR: 700, a: 1, c: '#00e5ff', type: 'circle' });
        logMessage('SIGNAL: 遭難物資を回収 (+300 SCR / 船体+15%)。ここは敵も知っている — 長居は無用', 'system-msg');
        distressBeacon = null;
        distressNextTimer = DISTRESS_INTERVAL_MIN + Math.random() * DISTRESS_INTERVAL_VAR;
        return;
    }
    // 敵回収 (fighterは回収装備なし)
    for (const e of enemies) {
        if (e.hp <= 0 || e.type === 'fighter') continue;
        if (Math.hypot(e.x - distressBeacon.x, e.y - distressBeacon.y) < 400) {
            e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.15);
            applyEnemyUpgrade(e);
            effects.push({ x: distressBeacon.x, y: distressBeacon.y, r: 0, maxR: 700, a: 1, c: '#ff6644', type: 'circle' });
            logMessage('SIGNAL: 敵艦が遭難物資を回収 — 敵性能が向上した', 'warning-msg');
            distressBeacon = null;
            distressNextTimer = DISTRESS_INTERVAL_MIN + Math.random() * DISTRESS_INTERVAL_VAR;
            break;
        }
    }
}

// ═══ 敵アクティブソナー探信 (the ping) ═══
// 接触を失った敵が探信音を放つ。敵は正確な情報を得るチャンスと引き換えに、
// 自分の正確な方位をプレイヤーに晒す — 潜水艦戦の象徴的な情報交換。
// カウンタープレイ: 濃いヒッグスに潜れば反射が埋もれる / デコイが偽エコーを返す。
function firePingFromEnemy(e) {
    if (!player || player.hp <= 0) return;
    // 演出: 音波リング (フォグ無視 — 音はヒッグスの霧を越えて聞こえる)
    effects.push({ x: e.x, y: e.y, r: 0, maxR: ENEMY_PING_RANGE, a: 0.7, c: '#ff8866', type: 'circle' });
    effects.push({ x: e.x, y: e.y, r: 0, maxR: ENEMY_PING_RANGE * 0.55, a: 0.5, c: '#ffbb99', type: 'circle' });
    const distP = Math.hypot(player.x - e.x, player.y - e.y);
    playSound('enemyPing', Math.max(0.15, Math.min(1, 1 - distP / 16000)));
    // プレイヤーへの情報: 探信音の正確な方位 (敵は自ら方位を晒した)
    const compassDeg = Math.round((Math.atan2(e.x - player.x, -(e.y - player.y)) * 180 / Math.PI + 360) % 360);
    const ang = Math.atan2(e.y - player.y, e.x - player.x);
    const ei = enemies.indexOf(e);
    if (!_contactLabels['e-' + ei]) _contactLabels['e-' + ei] = _contactLabelNext++;
    passiveBearings.push({
        ox: player.x, oy: player.y,
        angle: ang, halfWidth: 0.06, range: 16000,
        quality: 0.95, color: '255,120,80',
        sensor: 'em', strength: 0.9, sensorLabel: '探信音',
        bearingDeg: compassDeg, halfWidthDeg: 3,
        sourceId: 'e-' + ei,
        contactNo: _contactLabels['e-' + ei],
        life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
    });
    while (passiveBearings.length > PASSIVE_BEARING_MAX) passiveBearings.shift();
    logMessage(`SONAR: 敵アクティブソナー探信音！ — 方位 ${compassDeg}° (敵は接触を失っている。方位は正確だ)`, 'warning-msg');
    if (huntStats) huntStats.pings++;
    // 敵への情報: 反射エコー。デコイが近くにあれば偽エコーで誤誘導。
    let echo = null, echoDist = ENEMY_PING_RANGE;
    for (const d of decoys) {
        const dd = Math.hypot(d.x - e.x, d.y - e.y);
        if (dd < echoDist) { echoDist = dd; echo = d; }
    }
    if (echo) {
        e.playerLastKnownPos = { x: echo.x, y: echo.y, vx: 0, vy: 0 };
        e.contactFreshness = Math.max(e.contactFreshness, 0.85);
        logMessage('DECOY: デコイが偽エコー反射 — 敵ソナーを誤誘導', 'system-msg');
    } else if (distP < ENEMY_PING_RANGE) {
        // 濃いヒッグスに潜んでいれば反射が背景に埋もれる
        const hHere = getHiggsIntensity(player.x, player.y);
        if (hHere < ENEMY_PING_HIGGS_BLOCK) {
            e.playerLastKnownPos = {
                x: player.x, y: player.y,
                vx: player.x - (player.prevX ?? player.x),
                vy: player.y - (player.prevY ?? player.y)
            };
            e.contactFreshness = Math.max(e.contactFreshness, 0.85);
            logMessage('WARN: 敵ソナーがこちらを捉えた — エコー反射', 'warning-msg');
        } else {
            logMessage('TAC: ヒッグス雲がエコーを散乱 — 反射をやり過ごした', 'system-msg');
        }
    }
}

// ═══ 露出度メーター + ヒッグスサージ進行 (毎フレーム・軽量) ═══
// 露出度 = 敵が自機をどれだけ掴んでいるか。潜水艦ゲームの核心「今、隠れられているのか?」に
// 常時フィードバックを与える。エスカレーション時は警告音、追跡中は心音が鳴る。
function updateHuntTension() {
    if (!player || player.hp <= 0) return;
    // ── デブリ擬態判定: 岩礁帯(デブリ帯)で完全停止+静粛 → 漂う岩塊に艦影が紛れる ──
    const _wasBottomed = isBottomed;
    isBottomed = silentRunning && player.currentSpeed < 0.05 &&
                 getDebrisIntensity(player.x, player.y) > BOTTOM_DEBRIS_MIN;
    if (isBottomed && !_wasBottomed) logMessage('TAC: デブリ擬態 — 機関完全停止。岩礁帯の岩塊に艦影が紛れる。至近でも探知されにくい', 'system-msg');
    else if (!isBottomed && _wasBottomed) logMessage('TAC: 擬態解除 — 岩礁帯の擬装を解いた', 'system-msg');
    let lvl = 0;
    for (const e of enemies) {
        if (e.hp <= 0) continue;
        if (e.aiState === 'combat') { lvl = 3; break; }
        const f = e.contactFreshness || 0;
        if (e.aiState === 'hunting' || f > 0.4) { if (lvl < 2) lvl = 2; }
        else if (f > 0.05) { if (lvl < 1) lvl = 1; }
    }
    if (lvl > playerExposureLevel) {
        playSound('alert');
        if (lvl === 1)      logMessage('WARN: 敵が痕跡を掴んだ — シグネチャ管理を', 'warning-msg');
        else if (lvl === 2) logMessage('WARN: 敵艦が追跡行動 — 進路と出力を変えろ', 'warning-msg');
        else {
            logMessage('CRITICAL: 捕捉された — 交戦か離脱か', 'warning-msg');
            if (huntStats) huntStats.timesEngaged++;
        }
    } else if (lvl === 0 && playerExposureLevel > 0) {
        logMessage('TAC: 追跡を振り切った — 隠密状態に復帰', 'system-msg');
    }
    if (lvl !== playerExposureLevel) { playerExposureLevel = lvl; updateAmbient(); }
    playerExposureLevel = lvl;
    // 環境音: 遠くの空間の唸り (25〜50s毎のランダムな環境フレーバー)
    if (_amb) {
        _amb.echoTimer -= gameSpeedFactor;
        if (_amb.echoTimer <= 0) {
            playSound('ambientEcho', 0.7 + Math.random() * 0.5);
            _amb.echoTimer = 1500 + Math.random() * 1500;
        }
    }
    // 被追跡中の心音 (追跡=遅い鼓動 / 捕捉=速い鼓動)
    if (lvl >= 2) {
        _exposureHeartbeatTimer -= gameSpeedFactor;
        if (_exposureHeartbeatTimer <= 0) {
            playSound('heartbeat');
            _exposureHeartbeatTimer = lvl === 3 ? 42 : 78;
        }
    }
    // ── ニアミス「息を殺せ」: 未発見のまま敵艦が至近を通過 ──
    if (lvl <= 1) {
        let nm = false;
        for (const e of enemies) {
            if (e.hp <= 0 || e.type === 'fighter') continue;
            if (Math.hypot(e.x - player.x, e.y - player.y) < (nearMissActive ? NEAR_MISS_CLEAR : NEAR_MISS_DIST)) { nm = true; break; }
        }
        if (nm && !nearMissActive) logMessage('WARN: 敵艦が至近を通過中 — 息を殺せ', 'warning-msg');
        nearMissActive = nm;
        if (nearMissActive) {
            _exposureHeartbeatTimer -= gameSpeedFactor;
            if (_exposureHeartbeatTimer <= 0) { playSound('heartbeat'); _exposureHeartbeatTimer = 34; } // 速い鼓動
        }
    } else nearMissActive = false;
    // ── ヒッグスサージ: 予兆8s → 本体12s(全探知縮退・ウェイク増幅) → クリアリング6s(高感度) ──
    if (surgePhase === 'none') {
        surgeNextTimer -= gameSpeedFactor;
        if (surgeNextTimer <= 0) {
            surgePhase = 'warn'; surgePhaseTimer = SURGE_WARN_DUR;
            logMessage('SENSOR: ヒッグス濃度急変を検知 — 広域センサーサージ接近 (全探知系に干渉)', 'warning-msg');
            playSound('alert');
        }
    } else {
        surgePhaseTimer -= gameSpeedFactor;
        if (surgePhaseTimer <= 0) {
            if (surgePhase === 'warn') {
                surgePhase = 'active'; surgePhaseTimer = SURGE_ACTIVE_DUR;
                logMessage('SENSOR: サージ到達 — 全センサー縮退。動けばウェイクが濃く残る', 'warning-msg');
            } else if (surgePhase === 'active') {
                surgePhase = 'after'; surgePhaseTimer = SURGE_AFTER_DUR;
                logMessage('SENSOR: サージ通過 — 短時間の高感度ウィンドウ。今なら遠くまで見える', 'system-msg');
            } else {
                surgePhase = 'none';
                surgeNextTimer = SURGE_INTERVAL_MIN + Math.floor(Math.random() * SURGE_INTERVAL_VAR);
            }
            updateAmbient(); // サージ位相で音像を変える
        }
    }
}

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

        // Process Enemy deaths — 撃沈シーケンス: 数秒の漂流・誘爆 → 最終爆発+衝撃波 (狩りの報酬)
        for (let i = enemies.length - 1; i >= 0; i--) {
            const de = enemies[i];
            if (de.hp <= 0 && !de._dying) {
                de._dying = de.type === 'fighter' ? 1 : 170; // 約3秒。fighterは即散
                de._dyingVx = (de.x - (de.prevX ?? de.x)) * 0.7;
                de._dyingVy = (de.y - (de.prevY ?? de.y)) * 0.7;
                if (de.type !== 'fighter') {
                    logMessage('TAC: 敵艦機関部誘爆 — 崩壊シーケンス進行中', 'system-msg');
                    playSound('explosion');
                }
            }
            if (de._dying) {
                de._dying -= gameSpeedFactor;
                de.x += de._dyingVx || 0;
                de.y += de._dyingVy || 0;
                de.angle += 0.012; // 姿勢制御を失って回頭
                de.visible = true;
                if (de._dying > 0 && Math.random() < 0.10) {
                    createExplosion(de.x + (Math.random() - 0.5) * de.radius * 2.2,
                                    de.y + (Math.random() - 0.5) * de.radius * 2.2, '#ff8844', 6 + Math.random() * 8);
                }
                if (de._dying <= 0) {
                    createExplosion(de.x, de.y, '#ff4d4d', de.type === 'carrier' ? 46 : (de.type === 'destroyer' ? 26 : 12));
                    effects.push({ x: de.x, y: de.y, r: 0, maxR: 900, a: 0.9, c: '#ffddaa', type: 'circle' }); // 衝撃波
                    playSound('explosion');
                    const reward = de.type === 'carrier' ? 300 : (de.type === 'destroyer' ? 100 : (de.type === 'fighter' ? 10 : 30));
                    // スクラップを散らす (大型ほど多い) — 撃沈跡が漁場になる
                    const _scraps = de.type === 'fighter' ? 1 : (de.type === 'carrier' ? 4 : 3);
                    for (let s2 = 0; s2 < _scraps; s2++) {
                        const _sa = Math.random() * Math.PI * 2, _sr = Math.random() * de.radius * 3;
                        scrapDrops.push({ x: de.x + Math.cos(_sa) * _sr, y: de.y + Math.sin(_sa) * _sr, value: Math.ceil(reward / _scraps), life: 1.0 });
                    }
                    enemiesKilled++;
                    if (gameState.career) gameState.career.kills++;
                    // 撃破残骸: fighter以外は戦場にディレリクトとして残る (EWハック可能・戦場に歴史が積もる)
                    if (de.type !== 'fighter') {
                        const _wk = new Structure(de.x, de.y, 'derelict');
                        _wk.discovered = true;
                        structures.push(_wk);
                        logMessage('TAC: 撃破残骸が漂流を開始 — ディレリクトとして残存 (EWハック可)', 'system-msg');
                    }
                    enemies.splice(i, 1);
                }
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
                if (gameState.career) gameState.career.bestSector = Math.max(gameState.career.bestSector || 1, gameState.sector);
                updateTopUI();
                saveGame();
                showSectorClear(bonus);
                if (sdWin && !allEnemiesDown) {
                    logMessage(`MISSION: 全ノードハック完了。S&D目標達成。ボーナス: +${bonus} CR`, 'system-msg');
                } else {
                    logMessage(`MISSION: セクター${gameState.sector}の脅威排除完了。ボーナス: +${bonus} CR`, 'system-msg');
                }
                logMessage('戦闘詳報 — ' + formatHuntReport(), 'system-msg');
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
        updateHuntTension();
        updateDistressBeacon();
        interceptEnemyComms();
        // 前任艦の残骸サルベージ (第5弾): 接近で回収
        if (playerWreckObj && player && player.hp > 0 &&
            Math.hypot(player.x - playerWreckObj.x, player.y - playerWreckObj.y) < 350) {
            gameState.credits += playerWreckObj.value;
            gameState.wreckSalvage = 0;
            updateTopUI(); saveGame(); playSound('ui');
            effects.push({ x: playerWreckObj.x, y: playerWreckObj.y, r: 0, maxR: 650, a: 1, c: '#9ab0bb', type: 'circle' });
            logMessage(`SALVAGE: 前任艦の残骸から物資を回収 (+${playerWreckObj.value} SCR) — 帰らなかった艦に敬礼`, 'system-msg');
            playerWreckObj = null;
        }

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

        // ヒッグスウェイク更新 (時間経過でフェードアウト)。decay指定エントリは航路痕跡=長寿命
        for (let i = higgsWakes.length - 1; i >= 0; i--) {
            higgsWakes[i].life -= (higgsWakes[i].decay || 0.005);
            if (higgsWakes[i].life <= 0) higgsWakes.splice(i, 1);
        }
        // §3-12 センサーtrail decay (各センサー軸の足跡フェード)。decay指定エントリは航路痕跡=長寿命
        for (let i = heatTrails.length  - 1; i >= 0; i--) { heatTrails[i].life  -= (heatTrails[i].decay  || 0.004); if (heatTrails[i].life  <= 0) heatTrails.splice(i,  1); }
        for (let i = opticTrails.length - 1; i >= 0; i--) { opticTrails[i].life -= (opticTrails[i].decay || 0.006); if (opticTrails[i].life <= 0) opticTrails.splice(i, 1); }
        for (let i = emTrails.length    - 1; i >= 0; i--) { emTrails[i].life    -= (emTrails[i].decay    || 0.005); if (emTrails[i].life    <= 0) emTrails.splice(i,    1); }

        // プレイヤーの移動でウェイク・trail を生成
        if (player && player.hp > 0 && player.state === 'moving') {
            const playerHiggs = getHiggsIntensity(player.x, player.y);
            const _pwAmp = surgePhase === 'active' ? SURGE_WAKE_MULT : 1; // サージ中: 移動の痕跡が濃く残る
            if (playerHiggs > 0.2 && Math.random() < 0.3 * _pwAmp) {
                higgsWakes.push({ x: player.x, y: player.y, intensity: Math.min(1, playerHiggs * 0.6 * _pwAmp), life: 0.8, decay: 0.0022 });
            }
            // §3-12 HEAT trail: エンジン熱排気 (移動時)
            if (!repairActive && player.heatSig > 0.07 && Math.random() < 0.22) {
                if (heatTrails.length < 600) heatTrails.push({ x: player.x, y: player.y, intensity: player.heatSig, life: 1.0, isPlayerTrail: true });
            }
        }
        // §3-12 EM trail: AI処理放射 — プレイヤー自身の紫粒子は削除済み

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

        // 構造物・ステーションの発見チェック (有視界距離内に入ると発見)
        if (player && player.hp > 0) {
            const _visionR = computeVisionRadius();
            [...structures, ...stations].forEach(s => {
                if (!s.discovered && Math.hypot(player.x - s.x, player.y - s.y) < _visionR) {
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
        drawTargetLine(ctx);

        // ズームアウト時 or デバッグフラグでshadowBlurをスキップ (描画コスト削減)
        const _blurEnabled = !PERF_DISABLE_SHADOW_BLUR && camera.zoom >= 0.12;
        // ビューポート境界 (ワールド座標)
        const _vpX = camera.x, _vpY = camera.y;
        const _vpW = cssW / camera.zoom, _vpH = cssH / camera.zoom;

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

        // ── ソナーエフェクト(波紋/充満/境界) — ヒッグスより手前に表示 ──
        updateDrawSonarEffects(ctx);

        // ── ラジアル方位目盛り: ヒッグスフォグより手前に描画 ──
        {
            const _rlVw = cssW / camera.zoom, _rlVh = cssH / camera.zoom;
            const _rlCx = camera.x + _rlVw * 0.5, _rlCy = camera.y + _rlVh * 0.5;
            const _rlDist = Math.abs(Math.hypot(_rlCx - MAP_CX, _rlCy - MAP_CY) - MAP_RADIUS);
            if (_rlDist < Math.max(_rlVw, _rlVh) * 0.9 + 2000) drawRadialScale(ctx);
        }

        // ── ランドマーク（ステーション・構造物・ヒッグスノード）— ヒッグスより手前に表示 ──
        // 未発見・未特定の構造物は非表示; 有視界発見(discovered)または信号特定(identified)時のみ表示
        stations.forEach(s => s.draw(ctx));
        structures.forEach(s => { if (s.discovered || s.identified) s.draw(ctx); });
        if (player && player.hp > 0) {
            const higgsNodeRange = effectiveRadarRange * 6;
            const isHiggsSnsr = currentSensor === 'higgs';
            resourceNodes.forEach(n => {
                if (!n.active) return;
                // 未特定かつHIGGSセンサー以外では非表示
                if (!n.identified && !isHiggsSnsr) return;
                if (n.x < _vpX - 60 || n.x > _vpX + _vpW + 60 ||
                    n.y < _vpY - 60 || n.y > _vpY + _vpH + 60) return;
                const distToNode = Math.hypot(n.x - player.x, n.y - player.y);
                const t = Date.now();
                const pulse = 0.5 + Math.sin(t * 0.003 + n.x * 0.001) * 0.5;
                const spin = (t * 0.0008 + n.x * 0.0003) % (Math.PI * 2);
                const inRange = distToNode < higgsNodeRange;
                // 未特定時(HIGGSセンサーのみ)は微かな輝き; 特定済みは通常表示
                const _nodeVis = n.identified ? 1 : 0.4;
                const brightness = _nodeVis * (isHiggsSnsr
                    ? (0.5 + pulse * 0.5)
                    : (inRange ? 0.15 + pulse * 0.12 : 0.04 + pulse * 0.04));
                ctx.save();
                ctx.translate(n.x, n.y);
                ctx.rotate(spin);
                const _nsp = SPRITES.node_higgs;
                if (spriteReady(_nsp)) {
                    ctx.globalAlpha = brightness;
                    drawSpriteCentered(ctx, _nsp, 72);
                    ctx.globalAlpha = 1;
                } else {
                ctx.globalAlpha = brightness * 0.5;
                ctx.fillStyle = '#50c8ff';
                if (_blurEnabled) { ctx.shadowColor = '#50c8ff'; ctx.shadowBlur = isHiggsSnsr ? 20 : 8; }
                ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = brightness * 0.35;
                ctx.strokeStyle = '#80e0ff'; ctx.lineWidth = 1.5 / camera.zoom;
                ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.stroke();
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
                if (n.identified && (inRange || isHiggsSnsr)) {
                    ctx.save();
                    ctx.translate(n.x, n.y);
                    ctx.globalAlpha = brightness;
                    ctx.fillStyle = '#80e8ff';
                    const _nFontPx = Math.max(9, Math.min(13, camera.zoom * 13)) / camera.zoom;
                    ctx.font = `bold ${_nFontPx.toFixed(1)}px Orbitron, monospace`;
                    ctx.textAlign = 'center';
                    if (_blurEnabled) { ctx.shadowColor = '#50c8ff'; ctx.shadowBlur = 3; }
                    ctx.fillText('HIGGS CRYSTAL', 0, -52 / camera.zoom);
                    ctx.shadowBlur = 0;
                    ctx.restore();
                }
                ctx.globalAlpha = 1;
            });
        }

        // ── 特定済み地形効果 (熱雲帯/磁気嵐帯/ヒッグス高濃度域) — ヒッグスより手前に恒久マーカー ──
        drawIdentifiedTerrain(ctx, _vpX, _vpY, _vpW, _vpH);

        // ── センサー痕跡(ソナーの影/コンタクト) — ヒッグスより手前に表示 ──
        for (const e of enemies) e.drawSensorTrace(ctx);

        // ── シグネチャ・スレットリング (最前面・フォグの上) ──
        if (player && player.hp > 0) drawPassiveAntenna(ctx);

        // ── レーダー範囲リング: 探知到達 + 現在地形の色 + サージ/センサー損傷への反応 ──
        // 折りたたみモードで環境シグネチャパネルが見えない代替: リングの色で「今どの遮蔽に居るか」を伝える。
        if (player && player.hp > 0) {
            const t2 = Date.now();
            const hHere   = getHiggsIntensity(player.x, player.y);
            const debHere = getDebrisIntensity(player.x, player.y);
            const stmHere = getStormIntensity(player.x, player.y);
            const thmHere = getThermalIntensity(player.x, player.y);
            // 表示半径: 探知reach × サージ反応 (active=縮小 / after=高感度で拡大)
            let ringR = effectiveRadarRange;
            if (surgePhase === 'active') ringR *= 0.5;
            else if (surgePhase === 'after') ringR *= 1.4;
            // 地形色: 今一番濃い遮蔽で決定 (ヒッグス=青→濃赤 / デブリ=灰 / 嵐=紫 / 熱雲=橙 / クリア=緑)
            let col = '#00ffaa';
            const terr = Math.max(hHere, debHere, stmHere, thmHere);
            if (terr > 0.15) {
                if (hHere >= debHere && hHere >= stmHere && hHere >= thmHere) col = hHere > 0.6 ? '#ff5a6e' : '#5a9cff';
                else if (debHere >= stmHere && debHere >= thmHere) col = '#c8c4b0';
                else if (stmHere >= thmHere) col = '#b47af0';
                else col = '#ffaa44';
            }
            const vpulse = 0.5 + Math.sin(t2 * 0.0015) * 0.5;
            const damaged = player._sysSensorTimer > 0;
            ctx.save();
            ctx.setLineDash([28 / camera.zoom, 18 / camera.zoom]);
            ctx.lineDashOffset = (t2 * 0.03) / camera.zoom; // 微回転で走査している感
            ctx.beginPath();
            ctx.arc(player.x, player.y, ringR, 0, Math.PI * 2);
            ctx.strokeStyle = damaged ? '#ff4444' : col;
            ctx.lineWidth = 1.5 / camera.zoom;
            ctx.globalAlpha = damaged ? (0.15 + Math.random() * 0.35) : (0.28 + vpulse * 0.22); // 損傷=明滅
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineDashOffset = 0;
            // ラベル: サージ縮退▼/高感度▲/損傷を明示
            ctx.font = `bold ${Math.round(8 / camera.zoom)}px Orbitron, monospace`;
            ctx.fillStyle = damaged ? '#ff4444' : col;
            ctx.globalAlpha = 0.42;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const rlabel = damaged ? 'SENSOR HIT' : (surgePhase === 'active' ? 'RADAR ▼' : (surgePhase === 'after' ? 'RADAR ▲' : 'RADAR'));
            ctx.fillText(rlabel, player.x + ringR + 6 / camera.zoom, player.y);
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        // ── 武器射程 + 射角アーク: "実際にどこを撃てるか" (射角 kinetic±150/missile±45/beam±10) ──
        if (player && player.hp > 0) {
            const wType  = document.getElementById('weapon-select') ? document.getElementById('weapon-select').value : 'kinetic';
            const wRange = wType === 'missile' ? 4400 : (wType === 'beam' ? 16000 : 1600);
            const wCol   = wType === 'missile' ? '#ffaa00' : (wType === 'beam' ? '#00aaff' : '#88ff44');
            const wLabel = wType === 'missile' ? 'MISSILE' : (wType === 'beam' ? 'BEAM' : 'KINETIC');
            const arc    = WEAPON_FIRE_ARC[wType] || Math.PI; // 射角(半角)
            const a0 = player.angle - arc, a1 = player.angle + arc;
            const zc = 1 / camera.zoom;
            const wideArc = arc >= Math.PI * 0.66; // kinetic(±150°)はほぼ全周
            ctx.save();
            // 射角の外縁アーク (破線) — 実際に撃てる範囲。塗りは使わず輪郭だけで非煩雑に。
            ctx.globalAlpha = 0.45;
            ctx.strokeStyle = wCol;
            ctx.lineWidth = 1.6 * zc;
            ctx.setLineDash([14 * zc, 12 * zc]);
            ctx.beginPath();
            ctx.arc(player.x, player.y, wRange, a0, a1);
            ctx.stroke();
            ctx.setLineDash([]);
            // 射角の限界を示す2辺 (狭い射角=missile/beamでは強調、広い射角=kineticでは死角のみ示す薄線)
            ctx.globalAlpha = wideArc ? 0.18 : 0.34;
            ctx.lineWidth = 1.2 * zc;
            ctx.beginPath();
            ctx.moveTo(player.x, player.y); ctx.lineTo(player.x + Math.cos(a0) * wRange, player.y + Math.sin(a0) * wRange);
            ctx.moveTo(player.x, player.y); ctx.lineTo(player.x + Math.cos(a1) * wRange, player.y + Math.sin(a1) * wRange);
            ctx.stroke();
            // ラベル (艦首方向の射程端)
            ctx.globalAlpha = 0.6;
            ctx.font = `bold ${Math.round(8 * zc)}px Orbitron, monospace`;
            ctx.fillStyle = wCol;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(wLabel, player.x + Math.cos(player.angle) * (wRange + 20 * zc), player.y + Math.sin(player.angle) * (wRange + 20 * zc));
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        // ── パッシブ方位ウェッジ (ワールド空間・三角測量用) ──
        if (player && player.hp > 0) drawPassiveBearings(ctx);
        // §4-4: 三角測量精度円描画 (手動TRIボタンで実行した結果を表示)
        if (player && player.hp > 0) drawTriangulationCircle(ctx);

        ctx.restore();

        drawHUDOverlay(ctx);
        if (_frameCount % 2 === 0) updateSigCanvas();
        if (_frameCount % 3 === 0) drawMinimap();
        if (_frameCount % 6 === 0) updateSigInfoBar();
        if (_frameCount % 10 === 0) updateEnvInfo();
        if (_frameCount % 20 === 0) updateLandmarkBanner();

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
