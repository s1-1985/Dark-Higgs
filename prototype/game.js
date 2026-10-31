// Init canvas

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
let minimapDpr = 1; // ミニマップのバッキングストア倍率 (高DPI対応・resizeCanvasで更新)
// 高精細(Retina)対応: 描画はCSSピクセル基準、バッキングストアを devicePixelRatio 倍に。
// レーダー/リング/文字のボケ防止。cssW/cssH=CSS px, _dpr=ピクセル比。
let cssW = window.innerWidth, cssH = window.innerHeight, _dpr = 1;
// UIインセット (宣言は最上部 — 初期化順序のTDZ回避)。第14弾: 横画面HUD = 上帯/左列/右列がフィールドを囲む
let _uiInsetCache = { left: 0, right: 0, top: 0, bottom: 0, topHud: 40, t: 0 };
let _orientPaused = false; // 縦持ち中は進行を止める (横画面専用HUD)
const _hudCache = { hp: -1, ammo: '', gen: '', expo: '' }; // HUD DOM更新の差分キャッシュ
let _ringMarks = []; // 第16弾: { deg, life, col } ログ・副長が口にした方位 (logMessage から初期化中にも触れるので最上部で宣言)
const _passiveLastSeen = {}; // sourceId → 最後に方位を取ったフレーム (新規信号の告知用)

// ── パフォーマンスデバッグフラグ ──────────────────────────────
const PERF_DISABLE_THREAT_RING = false;   // スレットリング描画をオフ
const PERF_DISABLE_SHADOW_BLUR  = false;  // shadowBlur を全オフ (モバイルで最も重い)
const PERF_DISABLE_BG           = false;  // 背景描画をオフ
let PERF_SHOW_FPS = localStorage.getItem('darkEchoFps') === '1'; // FPS表示 (第13弾: 既定OFF・メニューで切替)
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
// 第19弾: ヒッグス表示OFF (見た目だけ) — 霧の暗幕を外し、相手の艦影・航跡も全部描く観戦用の表示。
// 旧DEMOモードと違い、探知・ロック・COMの判断には一切影響しない (自機も敵も相手が見えない前提のまま)
let higgsViewOff = false;
// ═══ 第19弾: COM対戦デモ — 自機もCOMが操作する観戦モード (性格は自機/敵それぞれ設定) ═══
let comDemo = false;     // 自機COMが操作中
let thinkLogOn = true;   // 思考ログ欄を出すか
let comCfg = null;       // { ship, enemy, mode, pp, ep, pPreset, ePreset, higgsView, think } (ロビーの設定画面で決める)
let _com = null;         // 自機COMの作業メモ (startGame/generateSector でリセット)
// パッシブ方位ウェッジ: 計測時のワールド位置にアンカーした方位扇形。
// 強信号=狭い確信、弱信号=広いボケ。移動して2回計測→三角測量で敵位置が絞れる。
// { ox, oy, angle, halfWidth, range, quality, color, life, maxLife }
let passiveBearings = [];
// 第13弾: 開戦時の司令部情報 — 敵艦の「大まかな方面」(広い扇形)。最初の実探知が入るとフェードアウト
let intelBearing = null; // { ox, oy, angle, halfWidth, range, life, maxLife }
const INTEL_LIFE = 14400; // 最大4分 (最初の実探知でフェードアウト)
let lockedSignalId = null;       // 追跡(TRACK)中のシグネチャのsourceId
let _contactLabels = {};         // sourceId → 連番ラベル番号
let _contactLabelNext = 1;
// 第15弾: { [sourceId]: { obs:[{ox,oy,ang,sig,f}], fix:{x,y,r,n,f,chi2}|null, ping:{x,y,r,f}|null, base, displayCenterX/Y, displayR } }
// obs = 方位の記録 (観測点・方位・誤差・時刻)。fix = その記録だけから解いた推定位置。真の位置は持たない。
let _signalAnalysis = {};
function _newSignalAnalysis() {
    return { obs: [], fix: null, ping: null, base: 0, displayCenterX: null, displayCenterY: null };
}
window._lockSignal = function(sid) {
    lockedSignalId = sid;
    if (sid && !_signalAnalysis[sid]) _signalAnalysis[sid] = _newSignalAnalysis();
    else if (sid && _signalAnalysis[sid].dirty && typeof solveFix === 'function') solveFix(_signalAnalysis[sid]); // 溜めていた記録から解く
}; // index.htmlから呼出し
// 現在受信中のシグネチャ (sourceId → 最新の方位ウェッジ)。司令部情報など追跡不能なものは除く
function currentSignals() {
    const m = {};
    for (const b of passiveBearings) {
        if (b.life <= 0 || !b.sourceId || b.intel) continue;
        const cur = m[b.sourceId];
        // 自艦で聴いた方位を優先 (聴音局・コロニー起点の方位は自艦から見た方角ではない)
        if (!cur || (cur.relay && !b.relay) || (!!cur.relay === !!b.relay && b.life > cur.life)) m[b.sourceId] = b;
    }
    return m;
}
// 「追跡」: 受信中の信号を順にロック。未特定の信号を優先し、強い順に巡回する (第13弾: フィールドから1タップで追跡)
function trackNextSignal() {
    const sigs = Object.values(currentSignals());
    if (sigs.length === 0) { logMessage('TRACK: 追跡できる信号が無い — 反応のある帯域へ同調せよ', 'warning-msg'); return; }
    sigs.sort((a, b) => (b.strength || 0) - (a.strength || 0));
    let idx = sigs.findIndex(b => b.sourceId === lockedSignalId);
    const next = sigs[(idx + 1) % sigs.length];
    window._lockSignal(next.sourceId);
    playSound('ui');
    logMessage(next.relay
        ? `TRACK: SIG-${String(next.contactNo || '?').padStart(2, '0')} [${next.sensorLabel}] を追跡 — 聴音局の方位線と自艦の方位を重ねる`
        : `TRACK: SIG-${String(next.contactNo || '?').padStart(2, '0')} [${next.sensorLabel || next.sensor}] 方位${next.bearingDeg}° を追跡 — 場所を変えて方位を重ねると交点が出る`, 'system-msg');
    if (typeof window.syncSigLockedBar === 'function') window.syncSigLockedBar();
}
window.fireTriangulate = trackNextSignal; // 旧TRIボタン互換
let _lpmWorld = null;            // 長押しラジアルメニューのワールド座標
let _mouseHold = { on: false, timer: 0, x: 0, y: 0, fired: false }; // 第20弾: マウスの長押し
const PASSIVE_BEARING_LIFE = 480;  // 8秒フェード (@60fps)
const PASSIVE_BEARING_MAX  = 14;   // 同時表示上限 (第10弾: 24→14 でウェッジの過密・点滅を抑制)
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
const WEAPONS_UPG_RELOAD_MULT = [1.0, 1.0, 0.85, 0.70]; // 武装: リロード時間倍率 Lv0-3 (第20弾: 開始時のLv1で合意値どおり=ミサイル10秒・ビーム35秒。旧Lv1=0.85)
const ARMOR_RES_KINETIC = [0, 0.25, 0.25, 0.25]; // 装甲: kinetic耐性 Lv1+
const ARMOR_RES_MISSILE = [0, 0,    0.25, 0.25]; // 装甲: missile耐性 Lv2+
const ARMOR_RES_BEAM    = [0, 0,    0,    0.25]; // 装甲: beam耐性 Lv3+

const ENGINE_TYPES = {
    thermonuclear: { speedMult: 1.0,  heatMult: 2.0,  optMult: 0.2,  emMult: 0.4,  higgsSpeedBonus: 0.0 },
    pulse:         { speedMult: 1.2,  heatMult: 0.4,  optMult: 0.3,  emMult: 1.8,  higgsSpeedBonus: 0.0 },
    higgs:         { speedMult: 0.85, heatMult: 0.08, optMult: 0.1,  emMult: 0.2,  higgsSpeedBonus: 0.6 },
    photon:        { speedMult: 1.4,  heatMult: 0.0,  optMult: 3.0,  emMult: 0.2,  higgsSpeedBonus: 0.0 }
};
// 第23弾 (オーナー合意): 推進から出る信号はエンジンごとに主な1種類 (他はわずか)。熱核=熱 / パルス=EM / ヒッグス=航跡(霧の乱れ) / フォトン=光
// (旧: heatMult などの倍率が混ざり、ヒッグスエンジンでもEMや熱が目立っていた)。演算のEM (センサー・AIへの配分) はエンジンと別に残すが半分にした
const ENGINE_SIG = {
    thermonuclear: { heat: 1.0,  optic: 0.1,  em: 0.1,  higgs: 0.1 },
    pulse:         { heat: 0.1,  optic: 0.1,  em: 1.0,  higgs: 0.1 },
    higgs:         { heat: 0.05, optic: 0.05, em: 0.05, higgs: 1.0 },
    photon:        { heat: 0.1,  optic: 1.0,  em: 0.1,  higgs: 0.1 },
};
const COMPUTE_EM_MULT = 0.5;

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
    // 第21弾: Higgsfield生成 — ビーム(自機=緑/敵=赤)・損傷の煙(透過)と火花・衝撃波・ミサイル破片(透過6片)・囮
    fx_beam_player:     'assets/fx_beam_player.png',
    fx_beam_enemy:      'assets/fx_beam_enemy.png',
    fx_smoke:           'assets/fx_smoke.png',
    fx_sparks:          'assets/fx_sparks.png',
    fx_shockwave:       'assets/fx_shockwave.png',
    fx_debris_0: 'assets/fx_debris_0.png', fx_debris_1: 'assets/fx_debris_1.png', fx_debris_2: 'assets/fx_debris_2.png',
    fx_debris_3: 'assets/fx_debris_3.png', fx_debris_4: 'assets/fx_debris_4.png', fx_debris_5: 'assets/fx_debris_5.png',
    lure_sos:           'assets/lure_sos.png',
    lure_ship:          'assets/lure_ship.png',
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
    drone_mech:         'assets/drone_mech.png', // 第20弾: 人型 (Higgsfield生成・透過256px)
    drone_barrier:      'assets/drone_barrier.png',      // 第22弾: ビームの盾 (Higgsfield生成・透過256px)
    fx_barrier_shield:  'assets/fx_barrier_shield.png',  // 第22弾: 盾の泡 (黒背景・加算)
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
let currentSensor = 'heat'; // 'heat' | 'optic' | 'em' | 'higgs' (第21弾: ONの帯域のうち最初にONにしたもの = 表示の主帯域)
// 第21弾 (オーナー合意): 帯域ごとに ON/OFF。ONの帯域は全部で方位が取れる。最初にONにした1本は無料、
// 後からONにした帯域は1本ごとに自艦から漏れる (その帯域の種類): HEAT=熱+0.06 / OPT=光+0.06 / EM=EM+0.08 / HGS=ヒッグス+0.06。
// 旧: 方位が取れるのは同調した1帯域だけ (他の3帯域はミキサーにレベルが出るだけ)
let sensorsOn = { heat: true, optic: false, em: false, higgs: false };
let sensorOrder = ['heat']; // ONにした順 (先頭が無料)
const SENSOR_LEAK = { heat: 0.06, optic: 0.06, em: 0.08, higgs: 0.06 };

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
    wreckSalvage: 0,
    // 第16弾: 積み込み計画 (艦種ごと)。未設定なら DEFAULT_LOADOUT
    loadout: {}
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
            if (!gameState.loadout || typeof gameState.loadout !== 'object') gameState.loadout = {};
            updateTopUI();
        } catch (e) {
            console.warn('SYSTEM: 保存データの読み込みに失敗しました。初期状態で起動します。', e);
            localStorage.removeItem('darkEchoSave');
        }
    }
}
function saveGame() {
    if (comDemo) return; // 第19弾: COM対戦デモは保存しない (戦歴・クレジットに残さない。ロビーへ戻る時に読み直す)
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
})();

function updateTopUI() {
    const modeLabel = gameState.mode === 'sd' ? 'S&D' : 'BR';
    const _sd = document.getElementById('sector-display');
    if (_sd) _sd.textContent = `S${gameState.sector} · ${modeLabel}`;
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
let _higgsCache = new Map(), _higgsCacheFrame = -1; // (第21弾: 濃度はマス目から読むので未使用)
// ═══ 第21弾: ヒッグス濃度のマス目 (オーナー合意「もっと細かくまばらに」) ═══
// 100u四方のマス目 (700×700) に多重ノイズ (塊の大きさ 750〜6000u) で濃度を置く。読むのは双線形補間。
// 旧: 半径900〜7500uの大きな円31個 (500u単位でキャッシュ) — 視界を周りの濃度で歪ませるには粗すぎた
const HG_CELL = 100, HG_N = 700;
let higgsGrid = null;        // Float32Array(HG_N*HG_N) 基礎の濃さ 0..1
let higgsGrowth = 0;         // 自然成長 (時間で濃くなる割合)
let higgsClears = [];        // ビームが晴らした筋 {x0,y0,x1,y1,t}
const BEAM_CLEAR_W = 300, BEAM_CLEAR_HOLD = 1800, BEAM_CLEAR_RECOVER = 1800; // 合意: 幅300u・30秒晴れて30秒で戻る
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
const BEAM_FX_SEC = 6; // 第22弾: ビームの表示時間 (秒・オーナー指定5〜8秒)
let damagePuffs = []; // 第21弾: 損傷した艦の煙と火花 (艦影の上に描く・上限70)
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
let higgsWakes = [];    // ヒッグスの点状の乱れ (ビームのダークチャネル等) {x, y, intensity, life}
// 第15弾: ヒッグスの記録 — 動いた艦は霧に航跡を残す。約90秒残り、霧の流れに乗ってゆっくり漂う。
// 自機・敵・デコイすべて対称。敵も自機の航跡を読んで追ってくる (= 動けば記録が残る)。
let wakeRibbons = [];   // { owner: 'player' | 'e-<uid>' | 'decoy-<n>', pts: [{x, y, f, s}], closed }
let higgsCurrent = { x: 0.08, y: 0.03 }; // 霧の流れ (u/frame)。セクター毎に向きが変わる
let _wakeIdSeq = 0;
let heatTrails  = [];   // §3-12 HEATセンサー向け熱排気跡
let opticTrails = [];   // §3-12 OPTICセンサー向け発光跡(弾跡・ビーム)
let emTrails    = [];   // §3-12 EMセンサー向けEM放射跡
let resourceNodes = []; // リソースノード {x, y, active, emFlashTimer}

// ── ゲームスピード制御 ──────────────────────────────────────
// 第22弾: 倍速は「1フレームにロジックを何回進めるか」(0.5=2フレームに1回 / 2・4・8=n回)。物理の1ステップは常に同じ。
// 旧: gameSpeedFactor で艦の移動量とタイマーだけを倍にしていた → 1ステップの移動量が速さとして読まれ、
// 自艦のシグネチャ (速さで熱・EMが増える) が倍速で上がっていた / 弾・ミサイルは倍にならず釣り合いが崩れていた
const GAME_SPEEDS = [1, 2, 4, 8, 0.5];
let gameSpeed = 1, _speedAcc = 0;
const gameSpeedFactor = 1.0; // 1ステップの時間 (常に1。式に残っている掛け算は互換のため)
// 第22弾: 自艦の戦闘モード (ロックすると画面下に出るバー)。mode: 'manual'(手動) | 'face'(正対) | 'flank'(回り込み) /
// range: 'auto'(兵装に合わせる) | 'near' | 'mid' | 'far' / prio: 'attack' | 'evade'。移動命令を出すと手動に戻る
let combatMode = { mode: 'manual', range: 'auto', prio: 'attack' };
const PLAYER_TURN_RATE = 0.010; // 自機最大回頭レート (rad/frame) - assault基準
const PLAYER_TURN_RATES = { assault: 0.010, stealth: 0.015, carrier: 0.004 }; // 艦種別回頭レート (重量感重視)
const ENEMY_TURN_RATES  = { corvette: 0.018, fighter: 0.025, destroyer: 0.009, carrier: 0.006 }; // 敵艦種別回頭レート
// ── 敵センサー「間合い」チューニング (2026-06-23 レビュー: 探知が至近距離すぎて狩りが成立しない問題の解) ──
// 探知を2層に分離: ①近接ハード探知=無音でも至近では見つかる ②シグネチャ探知=派手な機体ほど遠方から捕捉。
// プレイヤーのパッシブ探知(range≧8000〜)に見合う遠距離で敵も能動的に狩れるようにする。静音プレイのステルスは維持。
const ENEMY_DETECT_BASE = 1100;  // 近接ハード探知レンジの基準(旧800)。playerEmBoost等で増減
// 第13弾: 敵のシグネチャ探知を「自機のパッシブ受信機と同じモデル」に統一 (到達11000u・閾値×0.5)。
// 旧式(近接レンジ×到達倍率・閾値×0.6)は自機より約1.5倍耳が悪く、先に見つけるのは常に自機だった。
// 敵は4帯域を同時に聴くが、自分の居るヒッグス濃度で耳が鈍る (雲に潜む=互いに盲目)。
const ENEMY_PASSIVE_RANGE = 11000;
const ENEMY_STALK_SPEED = 0.55;
// 第20弾: 司令部情報の撤去で「双方が黙って待つと永遠に会わない」ため、敵は長く何も聞こえなければ哨戒に出る
// (静けさの許容 = ENEMY_ROAM_QUIET × (1.4 − 攻撃性) → 攻撃性0.5で54秒・0.9で30秒・0.15で75秒)。行き先は海図の既知物 (ノード/コロニー/中央)
const ENEMY_ROAM_QUIET = 3600;
const FRESHNESS_DECAY = 0.0004;
const ENEMY_MISSILE_ENGAGE = 2100; // 敵がミサイルで推定位置を撃つ最大距離  // 敵の「最終既知位置」の鮮度減衰/フレーム (第13弾: 旧0.012は約1.4秒で記憶喪失)
const ENEMY_ALERT_MEMORY = 2700; // 撃たれた敵は45秒間「警戒」を解かない = 奇襲×3.5は最初の一撃だけ  // 残り香(contactFreshness)を追って徘徊する際のlurking速度(通常lurking=0.08)
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
// ═══ 第22弾 (オーナー合意): 戦艦の戦闘機動 — 自機の戦闘モード・自機COM・敵で同じ式 ═══
// 機動: 正対 (艦首を相手へ向けたまま間合いを保つ) / 回り込み (相手の後方へ大きく周回) / 手動 (自機のみ)
// 間合い: 兵装に合わせる (実弾600u・ミサイル1800u・ビーム5000u) / 近600・中1800・遠5000
// 優先: 攻撃 (射角に入れて撃つ) / 回避 (相手の射角から外れる・近づくミサイルを横へかわす)
// ストレイフ (横滑り・左右へ急に振る) は禁止 — 戦艦は艦首の向きにしか進まず、速さは慣性で変わる
const CM_RANGE = { kinetic: 600, missile: 1800, beam: 5000 };
const CM_DIST = { near: 600, mid: 1800, far: 5000 };
const CM_HOLD = 600;              // COM が選んだ機動を続ける最短 (10秒)
const CM_MISSILE_EVADE_R = 1500;  // 回避優先: この距離に入った相手のミサイルを横へかわす (実装で決めた値)
const ENEMY_CLASS = { destroyer: 'assault', corvette: 'stealth', carrier: 'carrier' }; // 敵の内部の型 → 同じ艦種の自機
// 戦闘機動の舵: 進む向き ang と 速さの割合 spd (0..1 = 最高速に対する割合) を返す
// tAng = 相手の艦首の向き (分からなければ null) / oppArc = 相手の今の兵装の射角 (半角) / incoming = 近づく相手のミサイル
function combatManeuver(me, tx, ty, tAng, D, mode, prio, oppArc, incoming) {
    const dx = tx - me.x, dy = ty - me.y, dist = Math.hypot(dx, dy) || 1, bearing = Math.atan2(dy, dx);
    if (prio === 'evade' && incoming) {
        const ma = Math.atan2(incoming.y - me.y, incoming.x - me.x); // ミサイルの来る向きと直角へ
        const a1 = ma + Math.PI / 2, a2 = ma - Math.PI / 2;
        return { ang: Math.abs(_angDiff(a1, me.angle)) < Math.abs(_angDiff(a2, me.angle)) ? a1 : a2, spd: 1, why: 'dodge' };
    }
    const polar = Math.atan2(me.y - ty, me.x - tx); // 相手から見た自分の方位
    const inArc = tAng !== null && oppArc ? Math.abs(_angDiff(polar, tAng)) < oppArc + 0.2 : false;
    if (tAng !== null && (mode === 'flank' || (prio === 'evade' && inArc))) {
        const dphi = _angDiff(tAng + Math.PI, polar); // 相手の真後ろまで、周りを何rad回るか
        if (Math.abs(dphi) > 0.4) {
            const dir = dphi >= 0 ? 1 : -1;
            const corr = Math.max(-0.9, Math.min(0.9, (dist - D) / Math.max(400, D) * 1.5)); // 遠ければ内へ・近ければ外へ
            return { ang: polar + dir * (Math.PI / 2 + corr), spd: 1, why: 'flank' };
        }
    }
    const band = Math.max(150, D * 0.15);
    if (dist > D + band) return { ang: bearing, spd: dist > D * 1.6 ? 1 : 0.6, why: 'close' };
    if (dist < D - band * 1.5) return { ang: bearing + Math.PI, spd: 0.8, why: 'open' };
    return { ang: bearing, spd: 0, why: 'hold' };
}
// 近づく相手のミサイル (自分を狙って CM_MISSILE_EVADE_R 以内・こちらへ向かっている)。byPlayer=撃った側
function incomingMissile(me, byPlayer) {
    let best = null, bd = CM_MISSILE_EVADE_R;
    for (const pr of projectiles) {
        if (!pr.active || pr.type !== 'missile' || pr.isPlayer !== byPlayer) continue;
        const d = Math.hypot(pr.x - me.x, pr.y - me.y);
        if (d >= bd || (pr.quiet && d >= CM_MISSILE_EVADE_R * 0.5)) continue; // 第32弾: 静音推進は気付かれるのが半分の距離
        const toMe = Math.atan2(me.y - pr.y, me.x - pr.x);
        if (Math.abs(_angDiff(toMe, pr.angle)) > 0.9) continue;
        bd = d; best = pr;
    }
    return best;
}
// COM (自機COM・敵) の機動の選び方: 性格と相手の兵装で決める
function comChooseManeuver(pers, hpFrac, myW, oppW) {
    let mode = (pers.aggression || 0) >= 0.6 ? 'flank' : 'face';
    if (oppW === 'missile' || oppW === 'beam') mode = 'flank';          // 相手がミサイル/ビーム → 射角から外れて後ろへ回る
    const prio = ((pers.caution || 0) >= 0.6 || hpFrac < 0.5 || oppW === 'missile') ? 'evade' : 'attack';
    return { mode, prio, D: CM_RANGE[myW] || CM_RANGE.missile };
}
// ── 敵の「性格」(マッチ毎ランダム・艦種でレンジを縛る) ──
// 艦種ドクトリン(ENEMY_COMBAT)が土台。性格はその上の"気質"で、ドクトリンを覆さない範囲で行動を変調する。
//  aggression: 距離を詰める/撃つ積極性  stealth: 隠密・低シグネチャ志向  greed: ノード奪取優先度  caution: 損傷時の退き際
// ═══ 第21弾 (オーナー合意): 状況で変わる性格「状況適応」 ═══
// 始めは隠密 → 90秒手掛かりが無ければ貪欲 (ノード・コロニーへ) → 相手を掴んだら (追跡以上) 攻撃的 → 耐久40%未満で慎重
// → 見失って60秒で隠密に戻る。一度変わったら30秒は変えない (耐久だけは例外)。4軸の値は各プリセットの値 (標準プリセットと同じ表)
const ADAPT_MODES = {
    stealth:    { label: '隠密',   p: { aggression: 0.4, stealth: 0.9,  greed: 0.3, caution: 0.6 } },
    greedy:     { label: '貪欲',   p: { aggression: 0.4, stealth: 0.4,  greed: 0.9, caution: 0.5 } },
    aggressive: { label: '攻撃的', p: { aggression: 0.9, stealth: 0.15, greed: 0.2, caution: 0.15 } },
    cautious:   { label: '慎重',   p: { aggression: 0.3, stealth: 0.5,  greed: 0.3, caution: 0.85 } },
};
const ADAPT_HOLD = 1800, ADAPT_QUIET = 5400, ADAPT_LOST = 3600, ADAPT_HP = 0.4;
const ENEMY_ADAPTIVE_CHANCE = 0.2; // 通常プレイで敵が「状況適応」になる割合 (実装で決めた値)
function makeAdaptivePersonality() {
    const p = Object.assign({}, ADAPT_MODES.stealth.p);
    p._adaptive = { mode: 'stealth', since: _frameCount, lastContact: -1e9, start: _frameCount };
    return p;
}
// contact=今相手を掴んでいるか (追跡以上) / hpFrac=耐久の割合。変わったらモード名を返す
function adaptPersonality(p, contact, hpFrac) {
    const A = p && p._adaptive;
    if (!A) return null;
    if (contact) A.lastContact = _frameCount;
    const held = _frameCount - A.since < ADAPT_HOLD;
    let want = A.mode;
    if (hpFrac < ADAPT_HP) want = 'cautious';
    else if (held) return null;
    else if (contact) want = 'aggressive';
    else if (A.mode === 'aggressive' || A.mode === 'cautious') { if (_frameCount - A.lastContact > ADAPT_LOST) want = 'stealth'; }
    else if (A.mode === 'stealth' && _frameCount - Math.max(A.since, A.lastContact) > ADAPT_QUIET) want = 'greedy';
    if (want === A.mode) return null;
    A.mode = want; A.since = _frameCount;
    Object.assign(p, ADAPT_MODES[want].p);
    return want;
}
function rollEnemyPersonality(type) {
    const R = (a, b) => a + Math.random() * (b - a);
    if (type !== 'fighter' && typeof _frameCount !== 'undefined' && Math.random() < ENEMY_ADAPTIVE_CHANCE) return makeAdaptivePersonality();
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
// 敵が向かう価値のあるノード (第16弾: 自分が既に持っていて回復も使い切ったノードは除く)
function _nodeUsefulForEnemy(n) { return n.owner !== 'enemy' || _frameCount - (n.eHeal || -1e9) > 3600; }
function nearestActiveNode(x, y, maxDist) {
    let best = null, bd = maxDist || Infinity;
    for (const n of resourceNodes) { if (!_nodeUsefulForEnemy(n)) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }
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
    else if (pick === 'armor')  { const _r = ship.hp / ship.maxHp; ship.maxHp = Math.min(5000, ship.maxHp * 1.20); ship.hp = ship.maxHp * _r; label = '装甲'; } // 第26弾: 回復はしない (割合はそのまま)
    else if (pick === 'engine') { ship.upgSpeed = Math.min(1.8, ship.upgSpeed * 1.12); label = '機関'; }
    else                        { ship.upgDetect = Math.min(2.5, ship.upgDetect * 1.18); label = '索敵'; }
    logMessage(`SENSOR: 敵艦がノードを奪取し【${label}】を強化 (強化Lv${ship.enemyUpgLv})。`, 'warning-msg');
}
// 慣性ベース速度システム
// 第16弾: 潜航型 1.05→1.45 (既定GENで巡航≈126u/s・全速≈189u/s)。旧値では巡航90u/sで、敵の潜航型(交戦時≈137u/s)や
// 艦載機(≈141u/s)から離脱できずヒット&アウェイが成立しなかった。速いほど自艦ノイズで耳が塞がる代償は同じ
const SHIP_MAX_SPEED_MULT = { assault: 0.58, stealth: 1.45, carrier: 0.38 }; // 艦種別最高速度倍率
const MOVE_SPEED_MULT = 1.5; // 全艦共通の移動速度倍率 (自機/敵対称・2026-07-11 テンポ改善)
// 第13弾: 機関出力→速度の基準係数 (旧1.4)。既定ENG40%で 攻撃型≈50u/s / 潜航型≈90u/s / 空母型≈33u/s。
// 旧値では敵まで15000uの航行に8分以上かかり「何も起きない時間」が支配的だった (シミュレーション実測)。
const SPEED_BASE = 2.4;
// 艦種・機関出力(%)・ゲインから巡航速度(u/frame)を求める共通式。シグネチャの「機関負荷」もこれで正規化する
function shipCruiseSpeed(cls, enginePct, gain) {
    return (enginePct / 100) * gain * SPEED_BASE * (SHIP_MAX_SPEED_MULT[cls] || 1) * MOVE_SPEED_MULT;
}
const SHIP_ACCEL_RATE = { carrier: 0.00075, assault: 0.002, stealth: 0.0065 }; // 最高速度到達まで加速率/frame。第16弾: 潜航型 0.004→0.0065 (撃って離れる初動を速く)
const STEALTH_WAKE_MULT = 0.55; // 第16弾: 潜航型の艦体は霧に残す航跡が浅い (自機/敵の潜航型とも)
const SHIP_TURN_SLOW  = { carrier: 0.78, assault: 0.52, stealth: 0.22 }; // 旋回時の速度低下率最大値 (空母最重・潜航身軽)
// 武器別射角 (前方からの角度差の許容最大値)
const WEAPON_FIRE_ARC = { kinetic: Math.PI * 5/6, missile: Math.PI/4, beam: Math.PI/18 }; // kinetic±150° / missile±45° / beam±10°
// 第13弾: 武器射程を1つの表に統一 (CLAUDE.md確定仕様 800/2200/8000)。
// 旧実装は発射判定(1000/2600/1600)・弾の飛距離(800/3000/—)・射程リング表示(1600/4400/16000)がバラバラで、
// 「リング内なのに当たらない/撃たない」状態を生んでいた。発射判定・表示・弾体はすべてこの値から導出する。
const WEAPON_RANGE = { kinetic: 800, missile: 2200, beam: 8000 };
function weaponRange(w) {
    return (WEAPON_RANGE[w] || 800) * (WEAPONS_UPG_RANGE_MULT[gameState.upgrades.weapons] || 1.0) * (w === 'kinetic' ? PM.kinRange : w === 'missile' ? PM.mslRange : 1); // 第32弾: 部品
}
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
// 第16弾: 積載枠・搭載物の仕様 (オーナー合意 2026-10-24)。初期化コード(ロビーの積み込み表示)から参照するため最上部で宣言する
// 第20弾: 弾も同じ積載枠で管理する (オーナー合意 2026-10-26) — 枠を空母16/攻撃10/潜航6に。1枠=実弾48斉射 か ミサイル3発。
// 弾を多く積めばドローンが積めず、ドローンを多く積めば弾が少なくなる。ビームは弾数無限 (リロードが長い)
const HOLD_CAP = { carrier: 16, assault: 10, stealth: 6 };
const MAT_PER_SLOT = 2;
const AMMO_PER_SLOT = { kinetic: 48, missile: 3 };
// w=完成品が食う枠 / mat=組み立てに要る資材(個) / build=組み立て時間(frame) / life=展開後の稼働時間(frame)
const DRONE_SPEC = {
    // 第20弾: 組み立て時間を2倍に (オーナー合意。8〜40秒)
    // 第22弾 (オーナー合意): 耐久はミサイル(350)何発で沈むかで決める・自機と敵で同じ —
    // 哨戒機1発 / 戦闘機3発 / 人型6発 / その他は1発。バリアはビームを1発だけ止める盾 (止めたら壊れる)
    attack:  { label: '戦闘機',       w: 1, mat: 1, build: 720,  life: 3600, hp: 1050 },
    scout:   { label: '哨戒機',       w: 1, mat: 1, build: 720,  life: 2400, hp: 350 },
    decoy:   { label: 'デコイ',       w: 1, mat: 1, build: 480,  life: 2400, hp: 350 },
    build:   { label: '砲台',         w: 2, mat: 2, build: 1200, life: 7200, hp: 350, placed: true },
    buoy:    { label: 'センサーブイ', w: 1, mat: 1, build: 720,  life: 7200, hp: 350, placed: true },
    mech:    { label: '人型',         w: 4, mat: 4, build: 2400, life: 5400, hp: 2100 },
    barrier: { label: 'ビームバリア', w: 2, mat: 2, build: 1200, life: 7200, hp: 350, placed: true },
    higgs:   { label: 'ヒッグス散布', w: 2, mat: 2, build: 1200, life: 7200, hp: 350, placed: true },
    // 第17弾: 離脱用の消耗品 (item=使い切り。同時展開の上限には数えない。資材から作ると完成した瞬間に使う)
    flash:   { label: '閃光弾',         w: 1, mat: 1, build: 480, item: true },
    noise:   { label: 'ノイズメーカー', w: 1, mat: 1, build: 480, item: true },
    smoke:   { label: '煙幕弾',         w: 1, mat: 1, build: 480, item: true },
    // 第21弾: 囮 (オーナー合意) — 長押し地点へ射出。偽SOS=本物と同じ遭難信号を90秒 / 偽艦影ブイ=熱・光・EM・航跡を巡航中の艦なみに60秒 (ゆっくり動く)
    fsos:    { label: '偽SOS',         w: 1, mat: 1, build: 480, item: true, lure: true },
    lure:    { label: '偽艦影ブイ',     w: 1, mat: 1, build: 480, item: true, lure: true },
    // 第26弾 (オーナー指示): 修理はリペアキットだけ。出撃前の積み込みでしか積めない (資材から作れない・補給できない)
    repair:  { label: 'リペアキット',   w: 1, mat: 0, build: 0, item: true, noBuild: true },
};
// 1個で耐久+700を6秒かけて (攻撃型3500が5個で全回復 — オーナーの目安)。量は艦種によらず同じ (実装で決めた値)
const REPAIR_KIT_HP = 700, REPAIR_KIT_TIME = 360;
// 第26弾 (オーナー指示): コロニーの補給は1つのコロニーで1回だけ — 弾は積み込み計画まで満タン・資材は+3個まで・完成品とキットは補給できない
const COLONY_SUPPLY_MAT = 3;
const SHIP_DRONES = {
    carrier: ['attack', 'mech', 'build', 'scout', 'decoy', 'buoy', 'barrier', 'higgs', 'flash', 'noise', 'smoke', 'fsos', 'lure', 'repair'],
    assault: ['attack', 'build', 'flash', 'noise', 'smoke', 'fsos', 'lure', 'repair'],
    stealth: ['decoy', 'scout', 'flash', 'noise', 'smoke', 'fsos', 'lure', 'repair'],
};
// 第17弾: 既定の積み方に離脱用の消耗品を入れる (オーナー合意 2026-10-25)。第20弾: 弾(ammoK=実弾の枠/ammoM=ミサイルの枠)を加える
const DEFAULT_LOADOUT = {
    // 第26弾: リペアキットを各1個 (空母は資材を1枠・攻撃型はミサイルを1枠・潜航型はミサイルを1枠減らして入れる — 実装で決めた既定)
    carrier: { ammoK: 1, ammoM: 3, attack: 2, build: 1, scout: 1, flash: 1, smoke: 1, mat: 4, repair: 1 },
    assault: { ammoK: 3, ammoM: 3, attack: 1, flash: 1, smoke: 1, mat: 0, repair: 1 },
    stealth: { ammoK: 1, ammoM: 1, decoy: 1, noise: 1, flash: 1, mat: 0, repair: 1 },
};
let cargo = { stock: {}, mat: 0, asm: null, ammoK: 0, ammoM: 0 }; // asm = { type, t, total, ready } / ammoK=実弾の残り(斉射) / ammoM=ミサイルの残り(発)
// ═══ 第17弾: 緊急離脱 (オーナー合意 2026-10-25) ═══
// 閃光弾: 自艦の位置で炸裂。半径内の敵はセンサー損傷(探知×0.1)・敵ミサイルは誘導を失う。閃光の瞬間の位置は周囲の敵に知られる
const FLASH_RADIUS = 2500, FLASH_BLIND = 300; // 第22弾: 1500→2500u (オーナー合意)
// ノイズメーカー: 投下時の艦首方向へ自艦の全速で直進し、全速並みの熱と航跡を出す囮
const NOISE_LIFE = 720, NOISE_HEAT = 0.7;
let noiseMakers = []; // {x, y, vx, vy, life, _wid}
// 第21弾: 囮 {owner:'p'|'e', kind:'sos'|'ship', x,y, tx,ty, vx,vy, phase:'fly'|'on', life, sid, wid}
const LURE_SOS_LIFE = 5400, LURE_SHIP_LIFE = 3600, LURE_FLY_SPEED = 12, LURE_SHIP_SPEED = 0.8, LURE_SIG = 0.55, LURE_REVEAL_R = 400;
let lures = [], _lureSeq = 0, pendingLure = null;
// 第31弾 (オーナー合意): 自然の信号・お宝の信号 {sid:'N-n', kind, x,y, b:{帯域:強さ}, life, age, on, flip, takeP, takeE}
// 監視網の円 (シグネチャサークル) {side:'p'|'e', x,y, r, life, sid}
let fieldSignals = [], _fieldSeq = 0, _fieldRespawn = [], sigZones = [];
// 煙幕弾: 自艦の位置にヒッグス雲 (半径の半分までは濃さ一定・外側は線形に薄れる)。後半で薄れる
const SMOKE_R = 900, SMOKE_DENS = 0.6, SMOKE_LIFE = 1800, SMOKE_FADE = 600; // 第22弾: 20→30秒 (最後の10秒で薄れる)
const HIGGS_DRONE_R = 700, HIGGS_DRONE_DENS = 0.4; // ヒッグス散布ドローン (稼働中ずっと)
let smokeClouds = []; // {x, y, r, dens, life, max, follow}
// 機関停止(惰性): 進路は変えられない (艦首は回せる)。速度は霧の外で20秒で半減、濃さ1.0で4倍早く減る
const COAST_DECAY = Math.LN2 / 1200, COAST_FOG_DRAG = 3;
let playerCoasting = false;
// 緊急噴射: 速度×2を4秒 → 過熱8秒 (既存の機関損傷と同じ: 最高速×0.45・熱漏れ) / 再使用45秒
const BOOST_MULT = 2, BOOST_DUR = 360, BOOST_OVERHEAT = 480, BOOST_CD = 2700, BOOST_ACCEL = 20; // 第22弾: 噴射4→6秒
let boostT = 0, boostCD = 0;
let _flashScreen = 0; // 閃光弾の画面フラッシュ (frame)
// 敵の潜伏: 後退時に半径5000u内の濃い霧/岩礁帯へ。潜んでいる間は止まってシグネチャ×0.55・毎秒0.5%修復・45秒で狩りへ戻る
const ENEMY_HIDE_SEARCH = 5000, ENEMY_HIDE_TIME = 2700, ENEMY_HIDE_HEAL = 0.005 / 60, ENEMY_HIDE_SIG = 0.55;
// 副長の離脱助言: 捕捉中・耐久50%未満で、近くの濃い霧(0.5以上)/岩礁帯を探す半径
const XO_ESCAPE_HP = 0.5, XO_ESCAPE_SEARCH = 4000;
// 第18弾: 地図の縮尺 — コロニー等の画面上の最小サイズ / ノードの画面上の最小サイズ / これより引いたらラベルを短く
const STRUCT_MIN_PX = 20, NODE_MIN_PX = 14, LABEL_FAR_ZOOM = 0.06;
// ═══ 第18弾: 混信 (オーナー合意 2026-10-25) ═══
// 周り1200u以内にある他の発信源の数n (ドローン・デコイ・ノイズメーカー・艦載機)。嵐・熱雲・岩礁の濃い所(0.3超)に居ればn+1。
// 相手の推定誤差×(1+0.5n)(最大×3)・至近で掴まれる距離×1/(1+0.25n)。自艦/敵とも同じ物理 (混戦に紛れれば見分けにくい)
const CLUTTER_R = 1200, CLUTTER_ERR = 0.5, CLUTTER_MAX = 3, CLUTTER_HARD = 0.25, CLUTTER_TERRAIN = 0.3;
let _clutterCache = { f: -1, n: 0 };
// 第16弾: ノード制圧 / コロニーハック (オーナー合意 2026-10-24)
const NODE_CAP_R = 450, NODE_CAP_TIME = 300, NODE_RELAY_RANGE = 6000, NODE_MAT_GAIN = 4, NODE_SCR = 150;
const COLONY_HACK_R = 600, COLONY_HACK_TIME = 480;
// 第20弾: 補給 (オーナー合意 2026-10-26) — 補給所=全部 / ハック済みコロニー=弾だけ・60秒に1回。600u以内に8秒留まる (その間EMが漏れる)。
// 敵も同じ弾数制限で、撃ち尽くしたら補給所か自機がハックしていないコロニーへ行く
const RESUPPLY_R = 600, RESUPPLY_TIME = 480, COLONY_RESUPPLY_CD = 3600;
// ═══ 第23弾 (オーナー合意): ランドマークの整理 — 補給所は廃止、補給と修理はコロニーに集約 ═══
// コロニーは奪い合い (自機/敵とも600u以内に8秒で占有・相手が裏返せば占有が減る)。同時に占有している数で敵の位置が分かる:
//   1つ=方角(幅120°) / 2つ=+距離(幅5000u) / 3つ以上=方角の幅30°・距離の幅1000u。10秒ごとに更新 (中心は真の位置から幅の内でずれる)
//   自分のノード1つごとに幅を10%狭める (最大40%)。ノードは聴音局のまま。難破船は一度だけ弾と資材を拾える。S&Dは全コロニーの占有で勝ち (奪われれば負け)
// 第24弾 (オーナー選択「コロニーを増やす」): 接触が少ない対策。近くにコロニーがあれば早く占有でき、情報 (方角→距離) が早く効く。双方が同じ所を取り合うので出会いも増える
const COLONY_COUNT = { br: 5, sd: 5 }; // 第26弾: 8→5 (倍速で試合時間を縮められるので、密集させない — オーナー)
const COLONY_INTEL_PERIOD = 600;
const COLONY_INTEL = [null, { ang: Math.PI / 3, dist: null }, { ang: Math.PI / 3, dist: 2500 }, { ang: Math.PI / 12, dist: 500 }]; // 半幅
const NODE_INTEL_BUFF = 0.10, NODE_INTEL_BUFF_MAX = 0.40;
const DERELICT_SALVAGE_R = 500, DERELICT_SALVAGE_TIME = 180;
let _resupply = null; // 自機が今補給している所 { obj, kind:'station'|'colony', p }

// ── 潜航型デコイ (強EM放射のダミー → 敵ミサイルを誘引・索敵妨害) ──
let decoys = [];
const DECOY_LIFE = 480;        // 8秒
const DECOY_LURE_RADIUS = 1600; // この半径内の敵ミサイルを誘引

// ── 空母型ドローン4種 (§3-6) ──
// 攻撃=自動追尾射撃(熱) / デコイ=ミサイル誘引(強EM) / 哨戒=センサー拡張(低シグ) / 建設=設置タレット
let playerDrones = [];
const DRONE_ATK_RANGE = 1400;   // 攻撃ドローンの索敵/射程
const DRONE_SCOUT_RANGE = 2200; // 哨戒ドローンのセンサー拡張半径
const DRONE_TURRET_RANGE = 1100;// 建設タレットの射程
// 第20弾: ドローンへの指示 (種類ごと: 哨戒/攻撃/帰還)。哨戒=その点の半径800uを周回 / 攻撃=その点へ向かい着いたら半径600uを周回 / 帰還=自艦の護衛 (既定)。
// ドローン自身の目 (1200u) で見えた敵も撃ち、データリンクで自艦に共有する。追いかけるのは指示点から1500uまで (実装で決めた値)
const DRONE_PATROL_R = 800, DRONE_ATTACK_ORBIT = 600, DRONE_SIGHT = 1200, DRONE_LEASH = 1500;
// 第21弾 (オーナー合意): ドローンの有視界 (自艦と同じ視線ルール・居る場所の濃度で縮む) と自艦との通信。
// 通信の強さ q: 自艦から3000uまで1 → 8000uで0 (線形)、間の霧が濃いほど弱い (平均濃度×0.7 を差し引く=実装で決めた値)。
// q≥0.6=見えた敵は自艦も「見える」(完全ロック可) / 0.15≤q<0.6=誤差つきの反応だけ / q<0.15=途切れ (指示も届かず最後の指示を続ける)
const DRONE_VIS = { attack: 600, scout: 1000, mech: 500, buoy: 800 };
const DRONE_LINK_FULL = 3000, DRONE_LINK_LOST = 8000, DRONE_LINK_FOG = 0.7, DRONE_LINK_STRONG = 0.6, DRONE_LINK_WEAK = 0.15;
const ENEMY_PD_RANGE = 800; // 第20弾: 敵の迎撃 (実弾の射程)
let droneOrders = {}; // 種類 → { kind:'patrol'|'attack', x, y } (帰還=無し)

// §3-7 建設物3種 (carrier) 定数
const DRONE_BARRIER_RADIUS = 600; // 第22弾: バリア=ビームの盾。この半径の内を通る相手のビームを1発止めて壊れる (半径は実装で決めた値。旧880u=周期ダメージの範囲)
const DRONE_BUOY_RANGE     = 3200;// センサーブイ: 探知半径
const DRONE_HIGGS_RADIUS   = 700; // ヒッグス散布: 影響半径

// §3-10 ミサイル2タイプ (homing=熱源誘導/smart=AI追跡)
let missileMode = 'homing'; // 'homing' | 'smart'

// §3-9 修復ドローン (完全停止HP回復)
let repairActive = false;
const REPAIR_RATE     = 1.2; // HP/frame
const REPAIR_SIG_MULT = 2.4; // 停止中シグネチャ増大倍率

// ============================================================
// 有視界システム — アメーバ形状視野 + ヒッグス連続濃度連動
// ============================================================
const BASE_VISION_RADIUS = 1800; // 0%ヒッグス時の基準視野半径 (ワールド単位)。第25弾 (オーナー指示「有視界をもう少し広げて」): 1200→1800
let playerVisionRadius = BASE_VISION_RADIUS;

const MIN_VISION_FACTOR = 0.05; // 100%ヒッグスでも最低限の視認性を残す
// 第16弾: 有視界 = 自艦の居る場所のヒッグス濃度で伸び縮みするアメーバ。その内側に入った敵は100%見える。
// (旧: 敵の居る場所の濃度でも視認を落とすゲート §3-13 C があり、視界内なのに半透明・想定ロック止まりになっていた → 撤去)

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
const AMBUSH_PREEMPT_BEAM_MULT = 1.5; // 第21弾 (オーナー合意): ビームの奇襲はこれだけ (背後でも875×1.5×1.5=1969 — 攻撃型は一撃では沈まない)
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
let powerStance = 'cruise';           // 第15弾: 出力スタンス 'silent'(潜航) | 'cruise'(巡航) | 'flank'(全速)
const SILENT_SPEED_MULT = 0.5;       // 静粛航行中の速度倍率
const SILENT_SIG_MULT = 0.55;        // 静粛航行中の全シグネチャ倍率
const TORPEDO_ALERT_RANGE = 2600;    // ミサイル接近警報の探知距離 (推進波)
let distressBeacon = null;           // {x, y, life, claimed} 遭難信号イベント
let distressNextTimer = 4200;        // 初回発生 ~70s
const DISTRESS_INTERVAL_MIN = 7200;  // 以降の発生間隔 120s〜
const DISTRESS_INTERVAL_VAR = 3600;  // +0〜60s
const DISTRESS_LIFE = 10800;         // ビーコン持続 180s (第21弾 オーナー合意: 旧60秒ではたどり着けなかった)
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
const BEAM_CHARGE_DUR = 120;         // チャージ時間 2s (第20弾: ビームはチャージ専用)
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
    return visionRadiusAt(player, player.x, player.y);
}
// 第21弾: 有視界の最大半径 (その艦の居る場所の濃度で決まる。自機/敵/ドローン共通の式)
function visionRadiusAt(s, x, y, base = BASE_VISION_RADIUS) {
    const h = getHiggsIntensity(x, y); // 0..1
    let factor = 1 - h * (1 - MIN_VISION_FACTOR);
    if (factor < MIN_VISION_FACTOR) factor = MIN_VISION_FACTOR;
    let r = base * factor;
    if (surgePhase === 'active') r *= SURGE_VISION_MULT;        // ヒッグスサージ: 有視界も縮む
    if (s && s._sysSensorTimer > 0) r *= 0.6;                    // センサー損傷
    if (s && s._daze > 0) r *= DAZE_VISION_MULT;                  // 第20弾: センサー撹乱
    return r;
}

// ═══ 第22弾 (オーナー合意): 視線 — 最大半径は居る場所 (直下) の濃度で決まる。300uより先で、直下より30ポイント以上
// 濃い所に視線が入るとそこで止まり、その奥 (影) も見えない → 周りの濃度に応じて歪な形になる。300u以内は必ず見える。
// 自機/敵/ドローンで同じ関数を使う。旧 (第21弾): 濃さを積み重ねて 100%なら400u進むと遮る (薄い霧でも遠くは欠けた)
const VIS_RAYS = 96, VIS_STEP = 30, VIS_CLOSE = 450, VIS_STEP_UP = 0.40; // 第25弾: 至近300→450u・止まる段差+30→+40ポイント
let _visRays = new Float32Array(VIS_RAYS), _visRaysF = -1;
function losReach(x, y, ang, maxR, h0) {
    if (maxR <= VIS_CLOSE) return maxR;
    if (h0 === undefined) h0 = getHiggsIntensity(x, y);
    const lim = h0 + VIS_STEP_UP;
    if (lim > 1.0001) return maxR; // 直下がほぼ最も濃い (70%超) なら、それより濃い所は無い
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let d = VIS_CLOSE; d < maxR; d += VIS_STEP) {
        if (getHiggsIntensity(x + ca * d, y + sa * d) >= lim) return d;
    }
    return maxR;
}
// 自艦の有視界 (1フレームに1回、96本の視線)
function updatePlayerVision() {
    _visRaysF = _frameCount;
    playerVisionRadius = Math.max(VIS_CLOSE, computeVisionRadius()); // 第22弾: 300u以内は必ず見える
    const h0 = getHiggsIntensity(player.x, player.y);
    for (let k = 0; k < VIS_RAYS; k++) _visRays[k] = losReach(player.x, player.y, k / VIS_RAYS * Math.PI * 2, playerVisionRadius, h0);
}
// 角度 ang の方向に、自艦から何uまで見えるか (視線の間は線形補間)
function visionReachAt(ang) {
    if (!player) return 0;
    if (_visRaysF !== _frameCount) updatePlayerVision();
    let f = ang / (Math.PI * 2) * VIS_RAYS;
    f = ((f % VIS_RAYS) + VIS_RAYS) % VIS_RAYS;
    const i = Math.floor(f), t = f - i;
    return _visRays[i] * (1 - t) + _visRays[(i + 1) % VIS_RAYS] * t;
}
function inPlayerVision(x, y) { return player && Math.hypot(x - player.x, y - player.y) <= visionReachAt(Math.atan2(y - player.y, x - player.x)); }
// 有視界の縁の頂点列 (k = 縁からの拡大率)
function getAmoebaPoints(cx, cy, baseR, numPts, timeSec, k = 1) {
    if (_visRaysF !== _frameCount) updatePlayerVision();
    const pts = [];
    for (let i = 0; i < VIS_RAYS; i++) {
        const a = (i / VIS_RAYS) * Math.PI * 2, r = _visRays[i] * k;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return pts;
}
function _amoebaPath(ctx, pts) {
    // 第22弾: 視線の端を直線でつなぐ (判定と同じ形)。旧: 中点を通る曲線で、濃い霧のくぼみでは描いた縁が判定より外へ膨らみ、
    // 「有視界の内に見えるのに敵が描かれない」場所ができていた
    const n = pts.length;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
}

function drawFogOfWar(ctx) {
    if (!player || player.hp <= 0) return;
    if (higgsViewOff) return; // ヒッグス表示OFF: 暗幕を描かない (見た目だけ)

    if (_visRaysF !== _frameCount) updatePlayerVision();
    const cx = player.x;
    const cy = player.y;
    const t = _frameCount / 60;
    const NUM_PTS = VIS_RAYS;

    // 霧の不透明度: ヒッグス高濃度で濃くなる
    const hHere = getHiggsIntensity(cx, cy);
    const fogAlpha = 0.86 + hHere * 0.10;
    // ヒッグス雲の中ではティール〜青みがかった霧色
    const fogCol = hHere > 0.5 ? '#04162c' : hHere > 0.2 ? '#030e22' : '#01030e';

    // 描画範囲: カメラビュー + マージン
    const vw = cssW  / camera.zoom;
    const vh = cssH / camera.zoom;
    const mx = camera.x - 500;
    const my = camera.y - 500;
    const mw = vw + 1000;
    const mh = vh + 1000;

    const pts   = getAmoebaPoints(cx, cy, playerVisionRadius, NUM_PTS, t);
    const ptsM  = getAmoebaPoints(cx, cy, playerVisionRadius, NUM_PTS, t, 1.06);
    const ptsO  = getAmoebaPoints(cx, cy, playerVisionRadius, NUM_PTS, t, 1.12);

    // ── アメーバ穴付きフォグ (even-odd)。第16弾: 縁の内側は一切暗くしない — ぼかしは縁の外側だけ ──
    ctx.save();
    ctx.fillStyle = fogCol;
    ctx.globalAlpha = fogAlpha;
    ctx.beginPath();
    ctx.moveTo(mx, my); ctx.lineTo(mx + mw, my); ctx.lineTo(mx + mw, my + mh); ctx.lineTo(mx, my + mh); ctx.closePath();
    _amoebaPath(ctx, ptsO);
    ctx.fill('evenodd');
    ctx.globalAlpha = fogAlpha * 0.65;
    ctx.beginPath(); _amoebaPath(ctx, ptsO); _amoebaPath(ctx, ptsM); ctx.fill('evenodd');
    ctx.globalAlpha = fogAlpha * 0.3;
    ctx.beginPath(); _amoebaPath(ctx, ptsM); _amoebaPath(ctx, pts); ctx.fill('evenodd');

    // ── 視界の縁 (この線の内側に入った敵は100%見える) ──
    ctx.beginPath(); _amoebaPath(ctx, pts);
    ctx.strokeStyle = '#00ffb4';
    ctx.globalAlpha = 0.22 + hHere * 0.1;
    ctx.lineWidth = 1.4 / camera.zoom;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // ── 視野内のヒッグス雲を「下から見上げた濃淡」で重ねる (§3-13 B) ──
    // 視野バブル内にクリップし、白い雲を 'lighter' 合成。艦・弾はこの後に描くので霞まない (第16弾)
    if (higgsCloudCanvas) {
        ctx.save();
        ctx.beginPath(); _amoebaPath(ctx, pts);
        ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(higgsCloudCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.restore();
    }
}

// 視野内の敵を自動ロックオン (毎フレーム呼び出し)
function updateVisionLockOn() {
    if (!player || player.hp <= 0) return;

    // 視野半径・視線をヒッグス濃度に応じて毎フレーム更新 (描画OFFでもロックオン判定が正しく動く)
    updatePlayerVision();
    enemies.forEach(e => {
        if (e.hp <= 0) return;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        // 第16弾: 描いているアメーバの縁と同じ形で判定。内側=完全に見える (完全ロック・位置ずれ無し)
        // 第21弾: 縁は視線で決まる (周りの濃い霧の向こうは見えない)。ドローンの目で見えている敵も見える (通信が強い時)
        if (dist <= visionReachAt(Math.atan2(e.y - player.y, e.x - player.x)) || droneSeesStrong(e)) {
            e.inVision = true;
            if (!(_sigIdent[enemySid(e)] && _sigIdent[enemySid(e)].sure)) identSure(enemySid(e), true); // 第23弾: 見えた=識別確定
            applyContact(e, 1.0, 90); // life=90 = 1.5秒 (更新されない間は維持)
            e.displayX = e.x;
            e.displayY = e.y;
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
    let total = higgsBaseAt(x, y);
    if (higgsGrowth > 0 && total > 0) total *= 1 + higgsGrowth;
    // 第17弾: 煙幕弾・ヒッグス散布ドローンの雲 (半径の半分までは濃さ一定)
    for (let i = 0; i < smokeClouds.length; i++) {
        const s = smokeClouds[i];
        const dx = x - s.x, dy = y - s.y;
        if (dx > s.r || dx < -s.r || dy > s.r || dy < -s.r) continue;
        const dist = Math.hypot(dx, dy);
        if (dist < s.r) total += Math.min(1, (1 - dist / s.r) * 2) * s.dens * _smokeFade(s);
    }
    if (higgsClears.length) total *= beamClearFactor(x, y);
    return total > 1.0 ? 1.0 : total;
}
// マス目の基礎の濃さ (双線形補間)
function higgsBaseAt(x, y) {
    if (!higgsGrid) return 0;
    const fx = x / HG_CELL - 0.5, fy = y / HG_CELL - 0.5;
    let i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    if (i < 0) { i = 0; } if (j < 0) { j = 0; }
    if (i > HG_N - 2) i = HG_N - 2; if (j > HG_N - 2) j = HG_N - 2;
    const k = j * HG_N + i, g = higgsGrid;
    const a = g[k], b = g[k + 1], c = g[k + HG_N], d = g[k + HG_N + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
// 第21弾: 濃度のマス目をキャンバスに焼く (white=視界内の白い雲 / それ以外=背景の色つきの霧)
function _bakeHiggsGrid(white) {
    if (!higgsGrid) return null;
    const N = HG_N, c = document.createElement('canvas');
    c.width = c.height = N;
    const cx = c.getContext('2d'), img = cx.createImageData(N, N), px = img.data;
    for (let k = 0; k < N * N; k++) {
        const d = higgsGrid[k], o = k * 4;
        if (d <= 0.01) continue;
        if (white) { px[o] = 225; px[o + 1] = 238; px[o + 2] = 255; px[o + 3] = Math.min(140, d * 150) | 0; continue; }
        let r, g, b, a;
        if (d >= 0.85)      { r = 100; g = 20;  b = 200; a = 0.20; }
        else if (d >= 0.70) { r = 40;  g = 80;  b = 220; a = 0.17; }
        else if (d >= 0.50) { r = 0;   g = 200; b = 240; a = 0.13; }
        else if (d >= 0.30) { r = 20;  g = 120; b = 160; a = 0.09; }
        else                { r = 15;  g = 40;  b = 100; a = 0.03 + d * 0.15; }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = (a * 255) | 0;
    }
    cx.putImageData(img, 0, 0);
    return c;
}
// 第21弾: ビームの軌跡は霧が晴れる (幅300u・30秒そのまま→30秒で元に戻る)。0=晴れ 1=元の濃さ
function beamClearFactor(x, y) {
    let f = 1;
    const hw = BEAM_CLEAR_W / 2;
    for (let i = 0; i < higgsClears.length; i++) {
        const c = higgsClears[i];
        if (_segDist(x, y, c.x0, c.y0, c.x1, c.y1) > hw) continue;
        const age = _frameCount - c.t;
        const k = age < BEAM_CLEAR_HOLD ? 0 : Math.min(1, (age - BEAM_CLEAR_HOLD) / BEAM_CLEAR_RECOVER);
        if (k < f) f = k;
    }
    return f;
}
function addHiggsClear(x0, y0, x1, y1) {
    higgsClears.push({ x0, y0, x1, y1, t: _frameCount });
    if (higgsClears.length > 12) higgsClears.shift();
}
function updateHiggsClears() {
    if (!higgsClears.length) return;
    const lim = BEAM_CLEAR_HOLD + BEAM_CLEAR_RECOVER;
    while (higgsClears.length && _frameCount - higgsClears[0].t > lim) higgsClears.shift();
}
// 濃度のマス目を作る: 4段の値ノイズ (6000/3000/1500/750u) を、面積の割合が狙いどおりになるよう順位で濃さへ写す
// (0%=約15% / 20%未満=約20% / 20〜50%=約35% / 50〜90%=約22% / 90%以上=約8% — 旧設計の「0%が1割・20〜50%が6割・51〜90%が2割・100%が1割」に近い形)
function generateHiggsGrid() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const hash = (x, y) => { let h = (x * 374761393 + y * 668265263 + seed) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const vn = (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const N = HG_N, g = new Float32Array(N * N);
    const BINS = 1024, hist = new Uint32Array(BINS);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let v = 0, amp = 0.5, f = 1 / 60, norm = 0;
        for (let o = 0; o < 4; o++) { v += vn(i * f + o * 17.3, j * f - o * 9.1) * amp; norm += amp; amp *= 0.55; f *= 2; }
        v /= norm;
        g[j * N + i] = v;
        hist[Math.min(BINS - 1, (v * BINS) | 0)]++;
    }
    // 順位 (累積の割合) → 濃さ
    const Q = [[0, 0], [0.15, 0], [0.35, 0.2], [0.70, 0.5], [0.92, 0.9], [1, 1]];
    const map = new Float32Array(BINS);
    let cum = 0;
    const total = N * N;
    for (let b = 0; b < BINS; b++) {
        cum += hist[b];
        const q = cum / total;
        let k = 1; while (k < Q.length - 1 && q > Q[k][0]) k++;
        const [q0, d0] = Q[k - 1], [q1, d1] = Q[k];
        map[b] = q1 > q0 ? d0 + (d1 - d0) * Math.min(1, Math.max(0, (q - q0) / (q1 - q0))) : d1;
    }
    for (let k = 0; k < N * N; k++) g[k] = map[Math.min(BINS - 1, (g[k] * BINS) | 0)];
    higgsGrid = g;
    higgsGrowth = 0;
    higgsClears = [];
}
function _smokeFade(s) { return s.follow ? 1 : Math.min(1, s.life / SMOKE_FADE); }

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
// 第18弾: 混信 — (x, y) の周りの発信源の数 (self は数えない)
function clutterCount(x, y, self) {
    const R2 = CLUTTER_R * CLUTTER_R;
    const near = (o) => o !== self && (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) < R2;
    let n = 0;
    for (const d of playerDrones) if (d.hp > 0 && near(d)) n++;
    for (const d of decoys) if (near(d)) n++;
    for (const m of noiseMakers) if (near(m)) n++;
    for (const e of enemies) if (e.type === 'fighter' && e.hp > 0 && !e._dying && near(e)) n++;
    if (getStormIntensity(x, y) > CLUTTER_TERRAIN || getThermalIntensity(x, y) > CLUTTER_TERRAIN || getDebrisIntensity(x, y) > CLUTTER_TERRAIN) n++;
    return n;
}
function clutterErrMult(n) { return Math.min(CLUTTER_MAX, 1 + CLUTTER_ERR * n); }
// 自艦の周りの混信 (敵の探知で毎フレーム参照するので1フレーム1回だけ数える)
function playerClutter() {
    if (_clutterCache.f !== _frameCount) _clutterCache = { f: _frameCount, n: player ? clutterCount(player.x, player.y, player) : 0 };
    return _clutterCache.n;
}
// 第17弾: 隠れ場所 — 半径R内で最も近い「濃い霧(敵の探信が埋もれる濃さ)」か「岩礁帯(擬態できる濃さ)」。無ければ null。
// 自機の副長の離脱助言と、敵の潜伏で共用 (霧と岩礁は海図の既知物なので、どちらも知っていてよい)
function findCoverSpot(x, y, R, avoidAng = null) {
    const ok = (px, py) => getHiggsIntensity(px, py) >= ENEMY_PING_HIGGS_BLOCK ? 'fog' : getDebrisIntensity(px, py) > BOTTOM_DEBRIS_MIN ? 'debris' : null;
    const here = ok(x, y);
    if (here) return { x, y, kind: here, d: 0 };
    for (let r = 400; r <= R; r += 400) {
        let best = null, bd = Infinity;
        for (let i = 0; i < 16; i++) {
            const a = (i + (r / 400) * 0.37) / 16 * Math.PI * 2;
            const p = clampToMapCircle(x + Math.cos(a) * r, y + Math.sin(a) * r);
            // 脅威の方角 (±70°) にある隠れ場所は選ばない (敵の懐へ飛び込まない)
            if (avoidAng !== null) { let da = Math.atan2(p.y - y, p.x - x) - avoidAng; while (da < -Math.PI) da += Math.PI * 2; while (da > Math.PI) da -= Math.PI * 2; if (Math.abs(da) < 1.22) continue; }
            const k = ok(p.x, p.y);
            if (!k) continue;
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < bd) { bd = d; best = { x: p.x, y: p.y, kind: k, d }; }
        }
        if (best) return best;
    }
    return null;
}

// Resize
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
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
// Defer one more resize call to ensure CSS layout is complete before reading getBoundingClientRect
requestAnimationFrame(resizeCanvas);

const camera = {
    x: 0,
    y: 0,
    zoom: 0.08, minZoom: 0.01, maxZoom: 2, // 第16弾: 0.01=マップ全体が収まる / 2=艦スプライトの解像度の上限
    zoomTarget: null, // ボタン/ホイールの滑らかなズーム先 (renderWorldで補間)
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
        const W = cssW || window.innerWidth;
        let left = 0, right = 0, top = 0;
        const tp = document.getElementById('hud-top'), lf = document.getElementById('hud-left'), rt = document.getElementById('hud-right');
        if (tp) { const r = tp.getBoundingClientRect(); if (r.height > 2) top = r.bottom; }
        if (lf) { const r = lf.getBoundingClientRect(); if (r.width > 2) left = r.right; }
        if (rt) { const r = rt.getBoundingClientRect(); if (r.width > 2) right = Math.max(0, W - r.left); }
        _uiInsetCache = { left, right, top, bottom: 0, topHud: top, t: now };
    }
    return _uiInsetCache;
}

function centerCameraOnPlayer() {
    if (!player) return;
    const cw = cssW || window.innerWidth;
    const ch = cssH || window.innerHeight;
    // コンソールに隠れていない「実フィールド」の中心に自機を置く
    const ins = uiInsets();
    camera.x = player.x - (ins.left + (cw - ins.left - ins.right) / 2) / camera.zoom;
    camera.y = player.y - (ins.top + (ch - ins.top - ins.bottom) / 2) / camera.zoom;
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

// ═══ 第16弾: ズーム ═══
// 追従中は自艦を中心に、追従していない時は指定した画面上の点を中心に拡大縮小する。
function _clampZoom(z) { return Math.max(camera.minZoom, Math.min(camera.maxZoom, z)); }
function zoomAt(newZoom, clientX, clientY) {
    newZoom = _clampZoom(newZoom);
    if (cameraFollowPlayer || clientX === undefined) { camera.zoom = newZoom; if (cameraFollowPlayer) centerCameraOnPlayer(); else clampCamera(); return; }
    const before = screenToWorld(clientX, clientY);
    camera.zoom = newZoom;
    const after = screenToWorld(clientX, clientY);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    clampCamera();
}
// ボタン用: 数フレームかけて滑らかに (フィールド中心基準)
function zoomStep(mult) {
    camera.zoomTarget = _clampZoom((camera.zoomTarget || camera.zoom) * mult);
    playSound('ui');
}
function _tickZoomAnim() {
    if (camera.zoomTarget == null) return;
    const ins = uiInsets();
    const cx = ins.left + ((cssW || window.innerWidth) - ins.left - ins.right) / 2, cy = ins.top + ((cssH || window.innerHeight) - ins.top) / 2;
    const rect = canvas.getBoundingClientRect();
    const z = camera.zoom + (camera.zoomTarget - camera.zoom) * 0.25;
    if (Math.abs(camera.zoomTarget - z) < camera.zoomTarget * 0.01) { zoomAt(camera.zoomTarget, rect.left + cx, rect.top + cy); camera.zoomTarget = null; }
    else zoomAt(z, rect.left + cx, rect.top + cy);
}

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

// カメラ追従フラグ (自艦追従ON/OFF)。第13弾: 既定ON (旧: OFFで、航行すると自艦が画面外へ流れていった)。
// 手でパンすると一時OFF → 「◎」チップで復帰
let cameraFollowPlayer = true;

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

        if (pendingLure) { const ty = pendingLure; pendingLure = null; deployDrone(ty, worldX, worldY); return; } // 第21弾: 囮の射出地点
        { const _mcr = canvas.getBoundingClientRect(); if (tryTapBlip(e.clientX - _mcr.left, e.clientY - _mcr.top) || tryTapCircle(e.clientX - _mcr.left, e.clientY - _mcr.top)) return; }
        // Find clicked enemy
        let clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < en.radius * 2);

        if (clickedEnemy) {
            player.targetEntity = clickedEnemy;
            player.manualTarget = true; // 手動ターゲット指定 (自動ロックオン上書き防止)
            createClickEffect(clickedEnemy.x, clickedEnemy.y, '#ff4d4d');
            logMessage(`TACTICAL: ターゲットをロック。射撃解を計算中...`, 'system-msg');
        } else {
            // 第20弾: マウスでも長押し(0.5秒・動かさない)で 移動/射撃/ドローン指示 のメニュー (旧: タッチだけだった)
            clearTimeout(_mouseHold.timer);
            _mouseHold.x = e.clientX; _mouseHold.y = e.clientY; _mouseHold.on = true; _mouseHold.fired = false;
            _mouseHold.timer = setTimeout(() => {
                if (!_mouseHold.on || !player || player.hp <= 0) return;
                _mouseHold.on = false; _mouseHold.fired = true;
                _lpmWorld = screenToWorld(_mouseHold.x, _mouseHold.y);
                showLongPressMenu(_mouseHold.x, _mouseHold.y);
            }, 500);
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
    if (!player || player.hp <= 0 || comDemo) return; // 第19弾: COM対戦デモ中は自機COMが操艦する
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
window.addEventListener('mouseup', e => { if (e.button === 2) camera.isDragging = false; if (e.button === 0) { _mouseHold.on = false; clearTimeout(_mouseHold.timer); if (_mouseHold.fired) setTimeout(() => { _mouseHold.fired = false; }, 0); } });
// 長押しでメニューを開いた後、ボタンを離した時の click で「メニュー外タップで閉じる」(index.html) が走らないよう1回だけ握りつぶす
window.addEventListener('click', e => { if (_mouseHold.fired) { _mouseHold.fired = false; e.stopPropagation(); } }, true);
window.addEventListener('mousemove', e => {
    if (_mouseHold.on && Math.hypot(e.clientX - _mouseHold.x, e.clientY - _mouseHold.y) > 8) { _mouseHold.on = false; clearTimeout(_mouseHold.timer); }
    const mw = screenToWorld(e.clientX, e.clientY);
    mouseWorldX = mw.x; mouseWorldY = mw.y;
    if (camera.isDragging) {
        if (cameraFollowPlayer) { cameraFollowPlayer = false; updateCameraFollowBtn(); }
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
    camera.zoomTarget = null;
    zoomAt(camera.zoom * (e.deltaY > 0 ? 0.88 : 1.14), e.clientX, e.clientY);
}, { passive: false });
canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!player || player.hp <= 0 || !gameLoopRunning || comDemo) return;
    if (player._weaponJamTimer > 0) { logMessage('WEP: 火器管制ダウン — 復旧まで発砲不能', 'warning-msg'); return; }
    const wType = document.getElementById('weapon-select')?.value;
    if (wType !== 'missile' && wType !== 'beam') return;
    const rect = canvas.getBoundingClientRect();
    const _ffSx = (e.clientX - rect.left) * (cssW / rect.width);
    const _ffSy = (e.clientY - rect.top) * (cssH / rect.height);
    const _ffWx = (_ffSx / camera.zoom) + camera.x;
    const _ffWy = (_ffSy / camera.zoom) + camera.y;
    freeFireAt(_ffWx, _ffWy); // 第20弾: 長押し「射撃」と共通 (ビームはチャージ2秒の後)
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
    // 第21弾: 囮の射出地点を選んでいる最中 → このタップの地点へ
    if (pendingLure && e.touches.length === 1 && player && player.hp > 0) {
        const t0 = e.touches[0], w = screenToWorld(t0.clientX, t0.clientY), ty = pendingLure;
        pendingLure = null; deployDrone(ty, w.x, w.y); return;
    }
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
        _beginPinch(e);
    }
}, { passive: false });
// 2本目の指が置かれた/見つかった時点でピンチを開始する。
// 第16弾: 2本目の指がHUD(左右の列)の上から始まると canvas の touchstart が来ず、古い距離のまま拡大率を計算して
// ズームが跳ねていた → touchmove 側でも未開始なら必ずここを通す
function _beginPinch(e) {
    clearTimeout(touch.waypointTimer);
    touch.isPinching = true;
    touch.holding = false;
    touch.moved = true;          // ピンチの後に指を離してもタップ扱いにしない
    camera.isDragging = false;
    camera.zoomTarget = null;
    touch.pinchDist = Math.max(1, Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY));
}

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && !touch.isPinching) {
        const t = e.touches[0];
        const dx = t.clientX - touch.startX;
        const dy = t.clientY - touch.startY;
        if (Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD) {
            if (!touch.moved && cameraFollowPlayer) { cameraFollowPlayer = false; updateCameraFollowBtn(); } // 手でパン → 追従を一時解除 (◎で復帰)
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
    } else if (e.touches.length >= 2) {
        if (!touch.isPinching) { _beginPinch(e); return; }
        const newDist = Math.max(1, Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY));
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        zoomAt(camera.zoom * (newDist / touch.pinchDist), cx, cy);
        touch.pinchDist = newDist;
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
        const _tcr = canvas.getBoundingClientRect();
        if (tryTapBlip(touch.startX - _tcr.left, touch.startY - _tcr.top) || tryTapCircle(touch.startX - _tcr.left, touch.startY - _tcr.top)) return;
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
    // 第16弾: ピンチ後に1本指が残っても、全部の指を離すまではパンしない
    // (旧: 残った指が「ピンチ前の位置」からの差分でパンし、画面が大きく跳んでいた)
    if (e.touches.length === 0) touch.isPinching = false;
}, { passive: false });

// Classes
class Structure {
    constructor(x, y, type) {
        this.x = x; this.y = y; this.type = type; // 'colony' or 'derelict'
        this.radius = type === 'colony' ? 60 : 30;
        this.hacked = false;
        this.owner = null; // 第23弾: null / 'player' / 'enemy' (hacked = owner==='player')
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
        const hColor = this.hacked ? '#00aaff' : (this.owner === 'enemy' ? '#ff8844' : null);

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
            drawSpriteCentered(ctx, _ssp, Math.max(this.radius * 2.6, STRUCT_MIN_PX / camera.zoom)); // 引いても見失わない最小の大きさ (第18弾: 34px→20px)
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
        const _lColor = this.type === 'colony' ? (this.hacked ? '#00ffcc' : this.owner === 'enemy' ? '#ff9955' : '#6699ff') : (this.salvaged ? '#00ffcc' : '#bb9966');
        // 第18弾: 引いた時は短い名前だけ・アイコンのすぐ上に (旧: 長い説明文を画面上60px上に大きく出していた)
        const _far = camera.zoom < LABEL_FAR_ZOOM;
        // 第28弾: 説明書きは消して名前だけ (オーナー)
        const _lText  = this.type === 'colony' ? (this.hacked ? (this._usedP ? '自コロニー (補給済)' : '自コロニー') : this.owner === 'enemy' ? '敵コロニー' : 'コロニー') : (this.salvaged ? '難破船 (回収済)' : '難破船');
        const _iconPx = Math.max(this.radius * 2.6 * camera.zoom, STRUCT_MIN_PX);
        ctx.fillStyle = _lColor;
        ctx.font = 'bold ' + Math.round(_far ? 9 : 11) / camera.zoom + 'px Orbitron, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(_lText, 0, -(_iconPx / 2 + 8) / camera.zoom);
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
        const _stnFar = camera.zoom < LABEL_FAR_ZOOM;
        ctx.font = 'bold ' + Math.round(_stnFar ? 9 : 11) / camera.zoom + 'px Orbitron, monospace';
        ctx.fillStyle = '#4da6ff';
        ctx.textAlign = 'center';
        ctx.fillText(_stnFar ? '補給所' : '中立補給ステーション', this.x, this.y - Math.max(130, 14 / camera.zoom));
        ctx.restore();
    }
}

// ═══ 奇襲・混乱・サブシステム損傷の一括判定 ═══
// kinetic/missile着弾(Projectile.update)と beam即着弾(Projectile constructor)の共通処理。
// 「先に見つけて撃つ」を決定的にする: 非警戒の敵への初弾=×3.5+混乱(火器管制ダウン)+確定クリット。
// 対称ルール: 未探知の敵から撃たれた自機も奇襲被弾(×1.6+火器管制ダウン)を受ける。
let _beamShooter = null; // 敵ビームの発射元 (constructorで即着弾するため直前にセットされる)
// ═══ 第20弾: 命中・回避・近接爆発・センサー撹乱 (自機/敵/ドローン共通) ═══
// 今の速さ (u/frame)。自艦=慣性速度 / 敵=前フレームからの移動量 / ドローン=巡航速度
function shipSpeedNow(t) {
    if (!t) return 0;
    if (t === player) return player.currentSpeed || 0;
    if (t._spd !== undefined) return t._spd;
    return t.speed || 0;
}
// 弾が当たった時に避けられる確率 (速いほど避ける)。ビームは光速なので避けられない
function evadeChance(type, t) {
    const f = Math.min(1, shipSpeedNow(t) / EVADE_SPEED_REF);
    return type === 'kinetic' ? EVADE_K_BASE + EVADE_K_SPD * f : type === 'missile' ? EVADE_M_BASE + EVADE_M_SPD * f : 0;
}
// センサー撹乱 (受信・探知の距離が一時的に落ちる)
function applyDaze(t, frames, why) {
    if (!t || t.hp <= 0) return;
    const was = (t._daze || 0) > 0;
    t._daze = Math.max(t._daze || 0, frames);
    if (t === player && !was) logMessage('SENSOR: ' + why + ' — センサー撹乱 ' + Math.round(frames / 60) + '秒 (受信・探知が鈍る)', 'warning-msg');
    else if (t !== player && comDemo && !was && t.type !== 'fighter') comThinkEvent('e', why + ' → センサーが乱れた (' + Math.round(frames / 60) + '秒)', 'e' + t.uid);
}
// 第22弾: バリア (自機のビームの盾)。相手のビームの線が盾の半径の内を通れば、撃った側から見て最初の盾で止まり、盾は壊れる。
// 実弾・ミサイルは止めない。止めた位置を返す (無ければ null)
function barrierBlocksBeam(x0, y0, x1, y1) {
    let best = null, bt = 2;
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
    for (const d of playerDrones) {
        if (d.type !== 'barrier' || d.hp <= 0) continue;
        const t = Math.max(0, Math.min(1, ((d.x - x0) * dx + (d.y - y0) * dy) / L2));
        if (Math.hypot(x0 + dx * t - d.x, y0 + dy * t - d.y) > DRONE_BARRIER_RADIUS) continue;
        // 盾の泡に入る点 (線と円の交点のうち撃った側に近い方)
        const fx = x0 - d.x, fy = y0 - d.y, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - DRONE_BARRIER_RADIUS * DRONE_BARRIER_RADIUS;
        const disc = b * b - 4 * L2 * c; const te = disc > 0 ? Math.max(0, (-b - Math.sqrt(disc)) / (2 * L2)) : t;
        if (te < bt) { bt = te; best = d; }
    }
    if (!best) return null;
    const px = x0 + dx * bt, py = y0 + dy * bt;
    best.hp = 0;
    createExplosion(best.x, best.y, '#66aaff', 12);
    effects.push({ x: px, y: py, r: 0, maxR: 260, a: 0.9, c: '#88ccff', type: 'circle' });
    logMessage('DRONE: ビームバリアが敵のビームを止めた — 盾は崩壊', 'system-msg');
    if (typeof matchRecEvent === 'function') matchRecEvent('shield', px, py, 'バリアがビームを止めた');
    return { x: px, y: py };
}
// 第22弾: 自艦が受けた被弾の記録 (撃沈した時に「何にやられたか」を出す)。最新8件
let playerHitLog = [];
const _HIT_JP = { beam: 'ビームの直撃', missile: 'ミサイル', smart: 'AIミサイル', kinetic: '実弾', nearmiss: 'ミサイルの至近弾' };
function notePlayerHit(kind, dmg, sx, sy, strike, byFighter) {
    if (!player) return;
    const h = { f: _frameCount, kind, dmg, hp: Math.max(0, player.hp), byFighter: !!byFighter,
        deg: compassDeg(Math.atan2(sy - player.y, sx - player.x)), dist: Math.round(Math.hypot(sx - player.x, sy - player.y) / 50) * 50,
        ambush: !!(strike && strike.preempt), back: !!(strike && strike.rear) };
    playerHitLog.push(h); if (playerHitLog.length > 8) playerHitLog.shift();
    if (typeof matchRecEvent === 'function') matchRecEvent('hitP', player.x, player.y, '自艦に被弾: ' + (byFighter ? '艦載機の' : '') + (_HIT_JP[kind] || kind) + ' −' + dmg + (h.ambush ? '・奇襲' : '') + (h.back ? '・後方' : ''));
}
function _hitText(h) {
    return (h.byFighter ? '艦載機の' : '') + (_HIT_JP[h.kind] || h.kind) + ' −' + h.dmg + (h.ambush ? '・奇襲' : '') + (h.back ? '・後方' : '') + ' (方位' + h.deg + '°' + (h.kind === 'nearmiss' ? '' : '・' + h.dist + 'u先から') + ')';
}
// ミサイルの近接爆発: 半径300uの相手側 (撃った側の反対) に威力15%とセンサー撹乱
function nearMissBlast(x, y, byPlayer, dmg) {
    effects.push({ x, y, r: 0, maxR: NEAR_MISS_R, a: 0.7, c: '#ffb070', type: 'circle' });
    if (spriteReady(SPRITES.fx_explosion_small)) effects.push({ type: 'fx-sprite', x, y, img: SPRITES.fx_explosion_small, r: 40, life: 1.0, decay: 0.035 }); // 第21弾
    spawnShrapnel(x, y, 5, 2.5);
    const hitOne = (t) => {
        if (!t || t.hp <= 0 || t._dying || Math.hypot(t.x - x, t.y - y) > NEAR_MISS_R) return;
        const d = Math.floor(dmg * NEAR_MISS_DMG);
        t.hp -= d;
        if (t === player) notePlayerHit('nearmiss', d, x, y, null);
        if (huntStats) { if (byPlayer && t !== player) huntStats.dmgDealt += d; else if (!byPlayer && t === player) huntStats.dmgTaken += d; }
        effects.push({ x: t.x, y: t.y - 30, text: '至近弾 -' + d, life: 1.0, type: 'floatText', c: byPlayer ? '#ffcc66' : '#ff8866' });
        applyDaze(t, NEAR_MISS_DAZE, 'ミサイルの至近弾');
    };
    if (byPlayer) { for (const e of enemies) hitOne(e); }
    else { hitOne(player); for (const dr of playerDrones) if (dr.hp > 0 && Math.hypot(dr.x - x, dr.y - y) < NEAR_MISS_R) dr.hp -= dmg * NEAR_MISS_DMG; }
}
// ビームの外れ: 線から400u以内の相手側にセンサー撹乱
function beamNearMiss(x0, y0, x1, y1, byPlayer, hitTarget) {
    const chk = (t) => { if (t && t !== hitTarget && t.hp > 0 && !t._dying && _segDist(t.x, t.y, x0, y0, x1, y1) < BEAM_NEAR_R) applyDaze(t, BEAM_NEAR_DAZE, 'ビームが至近を通過'); };
    if (byPlayer) { for (const e of enemies) chk(e); } else chk(player);
}
function applyStrikeBonuses(byPlayer, attacker, target, hitAng, wType) {
    let mult = 1, preempt = false;
    // 奇襲が成立するのは「本当に気付いていない」敵だけ (直近45秒以内に撃たれた敵は警戒を解かない)
    const _wasUnaware = byPlayer && target !== player && target.detectionState === 'unaware' && _frameCount > (target._alertUntil || 0);
    let diff = hitAng - target.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    const rear = Math.abs(diff) > Math.PI * 0.55;
    if (rear) {
        const _rm = target === player ? PM.rear : epm(target).rear; // 第32弾: 傾斜装甲は後ろが弱い (第33弾: 敵も)
        mult *= _rm;
        if (!byPlayer && target === player) {
            effects.push({ x: target.x, y: target.y - 28, text: '後方被弾 ×' + _rm, life: 1.0, type: 'floatText', c: '#ff6666' });
        }
    }
    // ── 第13弾「撃てば自分も露出する」を双方向に: 被弾した側は射線の来た方位を知る ──
    // 敵: 撃たれた方向から射手の概位置(距離に比例した誤差)を得て狩りに転じる
    // 自機: 撃ってきた敵の方位ウェッジ(被弾方位)を得る = 撃ち返す/逃げる判断材料
    if (byPlayer && target !== player && player && player.hp > 0) {
        const d = Math.hypot(player.x - target.x, player.y - target.y);
        target._alertUntil = _frameCount + ENEMY_ALERT_MEMORY;
        const err = d * 0.12 + 150, ea = Math.random() * Math.PI * 2, er = Math.sqrt(Math.random()) * err;
        target.playerLastKnownPos = { x: player.x + Math.cos(ea) * er, y: player.y + Math.sin(ea) * er, vx: 0, vy: 0 };
        target.contactFreshness = Math.max(target.contactFreshness || 0, 0.75);
        if (target.aiState === 'lurking' || target.aiState === 'gathering') {
            target.aiState = 'hunting'; target.lurking = false;
            target.huntTarget = { x: target.playerLastKnownPos.x, y: target.playerLastKnownPos.y };
            target.huntTimer = 600 + Math.round(d / 1.2); // 射線の来た方へ、到達できるだけの時間は追い続ける
        }
    }
    if (!byPlayer && target === player && attacker && attacker.hp > 0 && !attacker.isPlayer &&
        _frameCount - (attacker._revealFrame || -999) > 90) {
        attacker._revealFrame = _frameCount;
        const sid = enemySid(attacker);
        if (!_contactLabels[sid]) _contactLabels[sid] = _contactLabelNext++;
        const ang = Math.atan2(attacker.y - player.y, attacker.x - player.x) + (Math.random() - 0.5) * 0.12;
        passiveBearings.push({
            ox: player.x, oy: player.y, angle: ang, halfWidth: 0.10, range: 12000,
            quality: 0.8, color: '255,90,90', sensor: 'optic', strength: 0.8, sensorLabel: '被弾方位',
            bearingDeg: Math.round((Math.atan2(Math.cos(ang), -Math.sin(ang)) * 180 / Math.PI + 360) % 360), halfWidthDeg: 6,
            sourceId: sid, contactNo: _contactLabels[sid], life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
        });
        while (passiveBearings.length > PASSIVE_BEARING_MAX) passiveBearings.shift();
    }
    if (byPlayer && target !== player) {
        if (target.detectionState === 'unaware' && _wasUnaware) {
            // 奇襲成功: 大ダメージ + 混乱 (火器管制ダウン・追撃ボーナス窓)
            mult *= wType === 'beam' ? AMBUSH_PREEMPT_BEAM_MULT : AMBUSH_PREEMPT_MULT;
            preempt = true;
            _hitStop = 8; // ヒットストップ: 決定的瞬間を体感させる (ロジックだけ0.13秒止める)
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
        const _sm = target === player ? PM.subsys : epm(target).subsys; // 第32弾: ダメコン班 (第33弾: 敵も)
        if (roll < 0.40)      { target._sysEngineTimer = SYS_ENGINE_DUR * _sm; label = '機関損傷'; }
        else if (roll < 0.70) { target._sysSensorTimer = SYS_SENSOR_DUR * _sm; label = 'センサー損傷'; }
        else                  { target._weaponJamTimer = Math.max(target._weaponJamTimer || 0, SYS_WEAPON_DUR * _sm); label = '武器系統損傷'; }
        effects.push({ x: target.x, y: target.y - 58, text: label + '!', life: 1.3, type: 'floatText', c: '#ff9500' });
        logMessage(target === player ? `WARN: サブシステム被害 — ${label}` : `TAC: 敵艦に${label} — 好機`, 'warning-msg');
        if (huntStats && target !== player) huntStats.crits++;
    }
    return { mult, preempt, rear };
}

class Projectile {
    constructor(x, y, target, isPlayer, type, dmgScale = 1) {
        this.x = x; this.y = y; this.isPlayer = isPlayer; this.type = type;
        this.ox = x; this.oy = y; // 第22弾: 撃った位置 (撃沈の原因の表示用)
        this.target = target;
        this.active = true;
        this.distTraveled = 0;

        // §3-1 武装アップグレード: 射程倍率 (自機弾のみ)
        const _wRange = isPlayer ? (WEAPONS_UPG_RANGE_MULT[gameState.upgrades.weapons] || 1.0) : 1.0;
        if (type === 'kinetic') {
            this.speed = 12; this.maxDist = WEAPON_RANGE.kinetic * 1.1 * _wRange * (isPlayer ? PM.kinRange : 1); this.dmg = KINETIC_DMG * dmgScale * (isPlayer ? PM.kinDmg * PM.dmgAll : 1); // 第20弾: 18→30 (距離で落ち・回避あり)。第32弾: 部品
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'missile') {
            // §3-10 ミサイル2タイプ: homing=熱源誘導 / smart=AI追跡(EM強・デコイ耐性・大閃光)
            this.missileMode = isPlayer ? missileMode : 'homing';
            this.speed = (this.missileMode === 'smart' ? 7.5 : 6) * (isPlayer ? PM.mslSpeed : 1); // 第32弾: 静音推進
            // 追尾で航路が伸びるぶん飛距離は射程より長め (smartは燃焼時間が長い)
            this.maxDist = WEAPON_RANGE.missile * (this.missileMode === 'smart' ? 1.7 : 1.35) * _wRange * (isPlayer ? PM.mslRange : 1);
            this.dmg = (this.missileMode === 'smart' ? MISSILE_SMART_DMG : MISSILE_DMG) * dmgScale * (isPlayer ? PM.mslDmg * PM.dmgAll : 1); // 第20弾: 55/70→350/400 (攻撃型を10発前後)。第32弾: 部品
            if (isPlayer) { this.quiet = !!PM.mslQuiet; this.emp = !!PM.emp; } // 多弾頭 (this.mirv) は撃つ側で決める (弾を2発使えた時だけ)
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'beam') {
            this.active = false;
            if (target && target.hp > 0) {
                // ヒッグス高濃度エリアではビームダメージ大幅低下 (設計確定仕様)
                const higgsBetween = getHiggsIntensity((x + target.x) / 2, (y + target.y) / 2);
                const higgsBeamPenalty = 1 - higgsBetween * 0.8 * (isPlayer ? PM.beamFog : epm(_beamShooter).beamFog); // 最大80%ダメージ減衰 (第32弾: 霧貫通で半分)
                // §3-1 装甲: beam耐性 (敵ビームが自機に当たる時)
                const beamArmorRes = (!isPlayer && target === player) ? ARMOR_RES_BEAM[gameState.upgrades.armor] : 0;
                // 奇襲・後方・混乱・サブシステム損傷 (ビームこそ潜航狙撃の主役 — 旧実装は先制ボーナスが乗らなかった)
                const _bStrike = applyStrikeBonuses(isPlayer, isPlayer ? null : _beamShooter, target, Math.atan2(y - target.y, x - target.x), 'beam');
                addHiggsClear(x, y, target.x, target.y); // 第21弾: 命中したビームの軌跡も霧が晴れる
                const _beamDmg = Math.floor(BEAM_DMG * higgsBeamPenalty * dmgScale * (1 - beamArmorRes) * _bStrike.mult * (isPlayer ? PM.beamDmg * PM.dmgAll : epm(_beamShooter).beamDmg * epm(_beamShooter).dmgAll));
                target.hp -= _beamDmg;
                if (isPlayer && target !== player && target.type !== 'fighter') matchRecEvent('hitE', target.x, target.y, '敵に命中: ビーム −' + _beamDmg + (_bStrike.preempt ? '・奇襲' : ''));
                if (huntStats) { if (isPlayer && target !== player) huntStats.dmgDealt += _beamDmg; else if (!isPlayer && target === player) huntStats.dmgTaken += _beamDmg; }
                // 被弾方向インジケータ (敵ビームが自機に命中)
                if (!isPlayer && target === player) {
                    notePlayerHit('beam', _beamDmg, x, y, _bStrike);
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
            // 終末シーカー (第13弾): 「推定座標」へ撃たれたミサイルは、着弾予定点の手前で周囲の実体を捜索・捕捉する。
            // 自機/敵 対称。推定が良ければ当たり、外れていれば空振る = 解析の質がそのまま命中に効く。
            if (!this._seekDone && (this.target.seek || (!this.isPlayer && this.target !== player))) {
                if (Math.hypot(this.target.x - this.x, this.target.y - this.y) < 650) {
                    this._seekDone = true;
                    if (this.isPlayer && this.mirv) { mirvSplit(this, this.target.x, this.target.y); return; } // 第32弾: 多弾頭
                    if (this.isPlayer) {
                        let best = null, bd = PM.seeker ? 1300 : 900; // 第32弾: 囮耐性シーカー
                        for (const e of enemies) {
                            if (e.hp <= 0 || e._dying) continue;
                            const d = Math.hypot(e.x - this.x, e.y - this.y);
                            if (d < bd) { bd = d; best = e; }
                        }
                        if (best) this.target = best;
                        else {
                            // 第15弾: 推定点に何も居ない = 推理が外れた。自爆して「そこには居ない」ことを知らせる。
                            // 代償として、近くに居た敵は撃たれたことに気付き発射点の方角を掴む
                            createHitEffect(this.x, this.y, '#88aacc');
                            logMessage('WEP: 終末シーカー — 推定点に目標なし (推定が外れた/移動された)', 'warning-msg');
                            missRevealsShooter(this.ox ?? player.x, this.oy ?? player.y, this.x, this.y, false);
                            recordMiss(this.sid, { x: this.x, y: this.y, r: 1000 });
                            this.active = false;
                            return;
                        }
                    } else if (player && player.hp > 0 && Math.hypot(player.x - this.x, player.y - this.y) < (this.seekR || 600)) { // 第33弾: 囮耐性シーカー
                        this.target = player;
                    }
                }
            }
            if (this.isPlayer && this.mirv && !this.target.seek && Math.hypot(this.target.x - this.x, this.target.y - this.y) < 650) { mirvSplit(this, this.target.x, this.target.y); return; }
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
            // 第17弾: 閃光弾で誘導を失ったミサイルは直進するだけ
            const _missileTurn = this._blind ? 0 : 0.05 * (1 - getStormIntensity(this.x, this.y) * STORM_MISSILE_DEGRADE) * _jamMissileFactor;
            this.angle += diff * _missileTurn;
            // ミサイル接近警報: 敵ミサイルの推進波を探知。
            // 警告が出ることでデコイ射出/ジャミング/回避機動が「反応する道具」になる。
            if (!this.isPlayer && !this._torpAlerted && player && player.hp > 0 &&
                Math.hypot(player.x - this.x, player.y - this.y) < TORPEDO_ALERT_RANGE * (this.quiet ? 0.5 : 1)) { // 第33弾: 静音推進
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
        if (this.distTraveled > this.maxDist) {
            this.active = false;
            if (this.type === 'missile') nearMissBlast(this.x, this.y, this.isPlayer, this.dmg); // 第20弾: 燃え尽きたミサイルも近くに居れば至近弾
            return;
        }
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
        // 第32弾: 近接信管弾 — 当たらずに150u以内を通ったら50%の威力で炸裂 (回避されない)
        if (this.isPlayer && this.type === 'kinetic' && PM.kinProx && !hitTarget && !this._evaded) {
            const pe = enemies.find(e => e.hp > 0 && !e._dying && Math.hypot(e.x - this.x, e.y - this.y) < 150 + (e.radius || 0));
            if (pe) {
                const _fallP = PM.kinNoFall ? 1 : 1 - KINETIC_FALLOFF * Math.min(1, this.distTraveled / WEAPON_RANGE.kinetic);
                const d = Math.floor(this.dmg * 0.5 * _fallP);
                pe.hp -= d; this.active = false;
                createHitEffect(this.x, this.y, '#ffcc55');
                effects.push({ x: pe.x, y: pe.y - 30, text: '近接 -' + d, life: 0.9, type: 'floatText', c: '#ffdd66' });
                if (huntStats) huntStats.dmgDealt += d;
                if (pe.type !== 'fighter' && pe.maxHp) matchRecEvent('hitE', pe.x, pe.y, '敵に命中: 近接信管 −' + d);
                applyStrikeBonuses(true, null, pe, Math.atan2(this.y - pe.y, this.x - pe.x));
                return;
            }
        }

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
            // 第20弾: 回避 — 当たっても相手の速さで避けられる (自機/敵とも同じ式・1発につき1回だけ判定)。
            // 旧: 自機だけがAI配分(回避)で敵弾を避けていた
            if (!this._evaded && Math.random() < evadeChance(this.type, hitTarget) * (this.isPlayer && this.type === 'kinetic' && PM.kinClose && this.distTraveled < 300 ? 0.3 : 1)) {
                this._evaded = true;
                effects.push({ x: hitTarget.x, y: hitTarget.y - 30, text: '回避', life: 1.0, type: 'floatText', c: '#9fd8ff' });
                if (this.type === 'missile') { nearMissBlast(this.x, this.y, this.isPlayer, this.dmg); this.active = false; } // 避けられたミサイルは近くで爆発
                return;
            }
            if (this._evaded) return; // 避けられた実弾はそのまま抜けていく
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
            // 第32弾: 傾斜装甲 — 正面±30°からの被弾 −30%
            if (!this.isPlayer && hitTarget === player && PM.front > 0 && Math.abs(_angDiff(_hitAng, player.angle)) < Math.PI / 6) dmgMult *= 1 - PM.front;
            if (this.isPlayer && hitTarget.pm && hitTarget.pm.front > 0 && Math.abs(_angDiff(_hitAng, hitTarget.angle)) < Math.PI / 6) dmgMult *= 1 - hitTarget.pm.front; // 第33弾: 敵の傾斜装甲
            // 第20弾: 実弾は遠いほど威力が落ちる (射程いっぱいで半分)
            const _fall = this.type === 'kinetic' && !(this.isPlayer && PM.kinNoFall) && !(!this.isPlayer && this.owner && epm(this.owner).kinNoFall) ? 1 - KINETIC_FALLOFF * Math.min(1, this.distTraveled / WEAPON_RANGE.kinetic) : 1;
            const _hitDmg = Math.floor(this.dmg * dmgMult * _fall);
            hitTarget.hp -= _hitDmg;
            if (this.emp) applyDaze(hitTarget, 480, 'EMP弾頭'); // 第32弾 (第33弾: 敵のEMPも)
            if (this.isPlayer && hitTarget !== player && hitTarget.type !== 'fighter' && hitTarget.maxHp) matchRecEvent('hitE', hitTarget.x, hitTarget.y, '敵に命中: ' + (_HIT_JP[this.type] || this.type) + ' −' + _hitDmg + (preemptive ? '・奇襲' : ''));
            if (huntStats) { if (this.isPlayer) huntStats.dmgDealt += _hitDmg; else if (hitTarget === player) huntStats.dmgTaken += _hitDmg; }
            // 被弾方向インジケータ: どの方位から撃たれたか (自機のみ)
            if (!this.isPlayer && hitTarget === player) {
                notePlayerHit(this.type, _hitDmg, this.ox, this.oy, _strike, this.owner && this.owner.type === 'fighter');
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
            if (this.type === 'missile') spawnShrapnel(this.x, this.y, 6, 3); // 第21弾: ミサイルの破片
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
            if (hitDrone && !this._evaded && Math.random() < evadeChance(this.type, hitDrone)) this._evaded = true; // ドローンも速さで避ける
            if (hitDrone && !this._evaded) {
                hitDrone.hp -= this.dmg; // 第22弾: 全威力 (旧0.8倍 — 「ミサイル何発で沈む」と合わなかった・敵の艦載機は全威力で非対称だった)
                this.active = false;
                createHitEffect(this.x, this.y, '#ffaa00');
                if (hitDrone.hp <= 0) logMessage(`搭載: ${(DRONE_SPEC[hitDrone.type] || {}).label || hitDrone.type} 撃墜`, 'warning-msg');
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
                ctx.drawImage(_mslImg, -16, -16, 32, 32); // 透過スプライト (第16弾)
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
// ═══ 第20弾: 武器の再設計 (オーナー合意 2026-10-26。自機/敵とも同じ) ═══
// 威力 実弾 < ミサイル < ビーム / 射程 実弾 < ミサイル < ビーム / 弾数 実弾 > ミサイル (ビームは無限・リロードが長い)
// 目安: 攻撃型(耐久3500)をミサイル直撃10発・ビーム4発で沈める
const KINETIC_RELOAD_TIME = 120;  // 2秒 (8斉射マガジンを撃ち切った後)
const MISSILE_RELOAD_TIME = 600;  // 10秒 (次弾まで)
const BEAM_RELOAD_TIME = 2100;    // 35秒 (チャージ2秒は別)
const KINETIC_MAG = 8;
const KINETIC_DMG = 30, MISSILE_DMG = 350, MISSILE_SMART_DMG = 400, BEAM_DMG = 875;
// 命中: 弾が当たっても相手の速さで回避される (速さの割合=速さ/2.5u/f・上限1)。実弾は距離で威力が最大50%落ちる
// 第20弾: 攻撃型の3連装の散布 (隣の弾との角度・自機/敵共通)。旧: 自機0.12/敵0.06rad → 600u先で横に36〜72uずれ、当たり判定(艦の半径×1.5=27〜30u)を外れて
// 実弾だけでは1試合で相手を沈められなかった。0.04rad = 600u先で24u
const KINETIC_SPREAD = 0.04;
const EVADE_SPEED_REF = 2.5, EVADE_K_BASE = 0.25, EVADE_K_SPD = 0.35, EVADE_M_BASE = 0.10, EVADE_M_SPD = 0.20, KINETIC_FALLOFF = 0.5;
// 近接爆発: ミサイルが回避された/燃え尽きた所から半径300u = 威力15%＋センサー撹乱4秒 / ビームの線から400u以内の外れ = センサー撹乱3秒
const NEAR_MISS_R = 300, NEAR_MISS_DMG = 0.15, NEAR_MISS_DAZE = 240, BEAM_NEAR_R = 400, BEAM_NEAR_DAZE = 180;
const DAZE_SENSOR_MULT = 0.5, DAZE_VISION_MULT = 0.7; // センサー撹乱中: 受信・探知の距離×0.5 / 有視界×0.7 (実装で決めた値)
// 設計「ビーム=ジェネレータ出力を大量消費、使用中は他に回せない」の実装: 発射後2.5秒は機関出力×0.4
const BEAM_DRAIN_DUR = 150, BEAM_DRAIN_SPEED = 0.4;
const BEAM_HIT_WIDTH = 140; // ビームが「当たる」線からの距離 (第15弾: 想定ロックのビームはサイコロではなく線判定)
// 外れた射撃は相手に「撃たれた」ことと射手の方角を教える (第15弾: 試行錯誤には代償がある)。
// 弾の通り道/着弾点の近く(2500u)に居た敵は、発射点の方へ誤差付きの最終既知位置を得て狩りに来る。
function missRevealsShooter(ox, oy, ex, ey, isLine) {
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
        let d;
        if (isLine) {
            const L = Math.hypot(ex - ox, ey - oy) || 1, ux = (ex - ox) / L, uy = (ey - oy) / L;
            const tx = e.x - ox, ty = e.y - oy, along = Math.max(0, Math.min(L, tx * ux + ty * uy));
            d = Math.hypot(tx - ux * along, ty - uy * along);
        } else d = Math.hypot(e.x - ex, e.y - ey);
        if (d > 2500) continue;
        const err = 300 + Math.hypot(e.x - ox, e.y - oy) * 0.08;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * err;
        e.playerLastKnownPos = { x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r, vx: 0, vy: 0 };
        e.contactFreshness = Math.max(e.contactFreshness || 0, 0.8);
        e.detectionState = 'alerted';
        e._alertUntil = _frameCount + ENEMY_ALERT_MEMORY;
        if (e.aiState === 'lurking' || e.aiState === 'gathering') { e.aiState = 'hunting'; e.huntTimer = 600 + Math.hypot(e.x - ox, e.y - oy) / 1.2; }
    }
}

// 第20弾: ビームを撃つと霧に軌跡がくっきり残る (ヒッグス上の筋) → 撃った側の位置が、ビームの射程の2倍以内の相手に分かる。
// 自機が撃てば敵が射手の概位置を掴み、敵が撃てば自艦に射手の方位線が入る (自機/敵とも同じ)
const BEAM_REVEAL_RANGE = 16000;
function beamRevealsShooter(ox, oy, byPlayer, shooter) {
    if (byPlayer) {
        for (const e of enemies) {
            if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
            const d = Math.hypot(e.x - ox, e.y - oy);
            if (d > BEAM_REVEAL_RANGE * PM.beamReveal) continue; // 第32弾: 霧貫通は軌跡が遠くまで知れる
            const err = 150 + d * 0.05, a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * err;
            e.playerLastKnownPos = { x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r, vx: 0, vy: 0 };
            e.contactFreshness = Math.max(e.contactFreshness || 0, 0.85);
            e.detectionState = 'alerted';
            e._alertUntil = _frameCount + ENEMY_ALERT_MEMORY;
            if (e.aiState === 'lurking' || e.aiState === 'gathering') { e.aiState = 'hunting'; e.huntTimer = 600 + d / 1.2; }
            if (comDemo) comThinkEvent('e', '霧にビームの軌跡 → 射手は' + _dirTxt(e.x, e.y, ox, oy) + 'にいる', 'e' + e.uid);
        }
        return;
    }
    if (!player || player.hp <= 0 || !shooter) return;
    if (Math.hypot(player.x - ox, player.y - oy) > BEAM_REVEAL_RANGE * epm(shooter).beamReveal) return; // 第33弾: 敵の霧貫通
    const sid = enemySid(shooter);
    if (!_contactLabels[sid]) _contactLabels[sid] = _contactLabelNext++;
    const ang = Math.atan2(oy - player.y, ox - player.x) + (Math.random() - 0.5) * 0.04;
    passiveBearings.push({
        ox: player.x, oy: player.y, angle: ang, halfWidth: 0.04, range: BEAM_REVEAL_RANGE,
        quality: 0.9, color: '120,220,255', sensor: 'higgs', strength: 0.9, sensorLabel: 'ビーム軌跡',
        bearingDeg: compassDeg(ang), halfWidthDeg: 2,
        sourceId: sid, contactNo: _contactLabels[sid], life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
    });
    addBearingObs(sid, player.x, player.y, ang, 0.02, 0.9, '120,220,255');
    logMessage('SENSOR: 霧にビームの軌跡 — 射手は方位' + compassDeg(ang) + '°', 'warning-msg');
}

// ═══════════════════════════════════════════════════════════════
// 第13弾: 自機の射撃系を1か所に集約
//   ・自動攻撃は「完全ロック(有視界)」の目標にだけ撃つ
//   ・センサー推定(想定ロック)の目標へは「射撃命令」で自分の意思で撃つ
//     = 霧の中から撃つ決断 (撃てば自分も露出する) をプレイヤーの手に戻す
// ═══════════════════════════════════════════════════════════════
let _curWeapon = 'kinetic';
function currentWeapon() { return _curWeapon; }

// 目標に対するロック状態: full=有視界(またはその直後の保持) / assumed=センサー推定のみ
function playerLockInfo(te) {
    const dist = Math.hypot(te.x - player.x, te.y - player.y);
    if (te.inVision) te._wasLocked = true;
    const persist = computeVisionRadius() * LOCK_PERSIST_BASE * (1 + aiPrec('sensor') * 2.5);
    if (dist >= persist) te._wasLocked = false;
    const full = !!te.inVision || (!!te._wasLocked && dist < persist);
    const assumed = !full && te.contactLife > 0;
    const acc = full ? 1 : Math.max(0, Math.min(1, te.contactAccuracy || 0));
    // 第18弾: 想定ロックの距離は推定位置までの距離 (旧: 真の距離で射程外を判定していた = 見えない相手の距離が漏れていた)
    const dEst = !full && te.displayX != null ? Math.hypot(te.displayX - player.x, te.displayY - player.y) : dist;
    return { full, assumed, acc, dist: dEst };
}

// 命中見込み (表示用): プレイヤーが持っている情報 = 推定円の幅だけから見積もる。
// 第15弾: 実際の当たり外れはサイコロではなく物理 (弾が実際に敵の居る所を通るか) で決まる。
function assumedHitChance(te, w, lk) {
    lk = lk || playerLockInfo(te);
    if (lk.full) return 0.95;
    if (!lk.assumed) return 0;
    if (lk.dist > weaponRange(w)) return 0;
    // 第18弾: 弾が届く時刻の見越し点での幅 (着弾までに相手が動ける分を含む)
    const sd = Math.max(80, assumedAimPoint(te, w).r / 2); // 推定円R ≈ 2σ
    const reach = w === 'missile' ? 900 : w === 'beam' ? BEAM_HIT_WIDTH + 60 : 260; // 当たり得る幅 (シーカー/ビーム幅/散布)
    return Math.max(0, Math.min(0.95, 1 - Math.exp(-(reach * reach) / (2 * sd * sd))));
}

function playerWeaponReady(s, w) {
    // 第20弾: 実弾・ミサイルは積んだ弾が尽きたら撃てない (補給所/コロニーで補給)
    if (w === 'kinetic') return !s.kineticReloading && s.kineticAmmo > 0 && (s !== player || cargo.ammoK > 0);
    if (w === 'missile') return !s.missileReloading && (s !== player || cargo.ammoM > 0);
    return !s.beamReloading;
}
function playerTickReloads(s) {
    if (s.kineticReloading && (s.kineticReloadTimer -= gameSpeedFactor) <= 0) { s.kineticAmmo = s === player ? Math.min(s.kineticMaxAmmo, cargo.ammoK) : s.kineticMaxAmmo; s.kineticReloading = false; }
    if (s.missileReloading && (s.missileReloadTimer -= gameSpeedFactor) <= 0) s.missileReloading = false;
    if (s.beamReloading && (s.beamReloadTimer -= gameSpeedFactor) <= 0) s.beamReloading = false;
}

// ビームのヒッグス・ダークチャネル (発射点から着弾点まで、ヒッグスセンサーに筋が残る) + 光学/EM痕跡
function leaveBeamChannel(x0, y0, x1, y1) {
    addHiggsClear(x0, y0, x1, y1); // 第21弾: 軌跡の霧が晴れる (幅300u・30秒+30秒で戻る)
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(5, Math.floor(len / 60));
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const wx = x0 + (x1 - x0) * t, wy = y0 + (y1 - y0) * t;
        const h = getHiggsIntensity(wx, wy);
        if (h > 0.08 && higgsWakes.length < 800) higgsWakes.push({ x: wx, y: wy, intensity: h * 1.4, life: 1.0 });
        if (s % 3 === 0 && opticTrails.length < 600) opticTrails.push({ x: wx, y: wy, intensity: 0.9, life: 1.0 });
        if (s % 4 === 0 && emTrails.length < 600) emTrails.push({ x: wx, y: wy, intensity: 0.7, life: 0.9 });
    }
}

// 第32弾: 多弾頭はもう1発使えた時だけ分裂する (1発しか無ければ普通のミサイル)
function _armMirv(mp) { if (PM.mirv && cargo.ammoM > 0) { cargo.ammoM--; _hudCache.cargo = null; mp.mirv = true; } }
// 1射ぶんの発砲処理 (自動攻撃・射撃命令の共通口)。撃てたら true。
function playerFireWeapon(s, target, wType, lk) {
    const dmgScale = 1;
    // 想定ロックは「推定位置」を狙う (真の位置ではない)。第18弾: 運動解があれば弾が届く時刻の見越し点
    // 第20弾: 有視界の実弾は見えている動きから見越して撃つ (敵の射撃と同じ。旧: 今の位置へ撃ち、動く相手には500u先でほぼ当たらなかった)
    const _ap = lk.full ? (wType === 'kinetic' ? visibleLeadPoint(target, wType) : null) : assumedAimPoint(target, wType);
    const aimX = _ap ? _ap.x : target.x;
    const aimY = _ap ? _ap.y : target.y;
    const genF = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
    const reloadMult = WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0;
    const pct = Math.round(assumedHitChance(target, wType, lk) * 100);
    if (wType === 'kinetic') {
        const base = Math.atan2(aimY - s.y, aimX - s.x);
        const mk = (off) => { const p = new Projectile(s.x, s.y, { x: aimX, y: aimY }, true, 'kinetic', dmgScale); p.angle = base + off; p.ox = s.x; p.oy = s.y; projectiles.push(p); };
        mk(0);
        if (gameState.shipType === 'assault') { mk(-KINETIC_SPREAD); mk(KINETIC_SPREAD); } // 攻撃型: 3連装同時発射
        if (s === player) {
            _kinAmmoFrac += PM.kinAmmoUse; const use = Math.floor(_kinAmmoFrac); _kinAmmoFrac -= use; // 第32弾: 高速装填は弾の消費×1.5
            cargo.ammoK = Math.max(0, cargo.ammoK - use); _hudCache.cargo = null; if (cargo.ammoK === 0) logMessage('WEP: 実弾を撃ち尽くした — 占有したコロニーで補給', 'warning-msg');
        }
        if (--s.kineticAmmo <= 0 || (s === player && cargo.ammoK <= 0)) { s.kineticReloading = cargo.ammoK > 0 || s !== player; s.kineticReloadTimer = Math.round(KINETIC_RELOAD_TIME * reloadMult * (s === player ? PM.kinReload : 1)); }
        if (!lk.full) logMessage(`WEP: KINETIC 推定射撃 (命中予測${pct}%)`, 'warning-msg');
    } else if (wType === 'missile') {
        if (s === player && !useMissileAmmo()) return false;
        let tgt = target;
        // 推定座標へ飛翔 → 到達付近で終末シーカーが実体を探す。居なければ空振り (=「そこには居ない」という情報)
        if (!lk.full) tgt = { x: aimX, y: aimY, hp: 1, radius: 1, seek: true };
        const _mp = new Projectile(s.x, s.y, tgt, true, 'missile', dmgScale);
        _mp.ox = s.x; _mp.oy = s.y; _mp.sid = enemySid(target);
        if (s === player) _armMirv(_mp);
        projectiles.push(_mp);
        s.missileReloading = true;
        s.missileReloadTimer = Math.round(MISSILE_RELOAD_TIME * reloadMult * (s === player ? PM.mslReload : 1));
        if (!lk.full) logMessage(`WEP: MISSILE 推定座標へ発射 — 終末シーカー作動予定 (命中予測${pct}%)`, 'warning-msg');
        else if (missileMode === 'smart') logMessage('WEP: MISSILE [AI追跡] 発射 — EM強・ジャミング耐性・大閃光', 'system-msg');
    } else {
        // 第20弾: ビームはチャージ専用 — 発射前に2秒溜める。チャージ中は熱/EM/ヒッグスが漏れる=敵に読まれ回避される
        if ((s._beamCharge || 0) < BEAM_CHARGE_DUR * (s === player ? PM.beamCharge : 1)) {
            s.weaponType = 'beam';
            s._beamCharge = (s._beamCharge || 0) + gameSpeedFactor;
            s._chargeFrame = _frameCount;
            if (!s._chargeLogged) { s._chargeLogged = true; logMessage('WEP: ビームチャージ開始 — 熱/EM放射激増中', 'warning-msg'); }
            return false;
        }
        // ビームは推定点の方向へ射程いっぱいまで一直線。線上(幅BEAM_HIT_WIDTH)に実体が居れば当たる
        let hit = lk.full;
        const _ba = Math.atan2(aimY - s.y, aimX - s.x), _bL = weaponRange('beam');
        const _bex = s.x + Math.cos(_ba) * _bL, _bey = s.y + Math.sin(_ba) * _bL;
        if (!hit) {
            const tx = target.x - s.x, ty = target.y - s.y;
            const along = tx * Math.cos(_ba) + ty * Math.sin(_ba);
            const perp = Math.abs(-tx * Math.sin(_ba) + ty * Math.cos(_ba));
            hit = along > 0 && along < _bL && perp < (s === player ? PM.beamWidth : BEAM_HIT_WIDTH) + (target.radius || 0);
        }
        if (hit) {
            projectiles.push(new Projectile(s.x, s.y, target, true, 'beam', dmgScale));
        } else {
            effects.push({ x: s.x, y: s.y, tx: _bex, ty: _bey, type: 'beam', a: 1, c: '#00ffaa' });
            leaveBeamChannel(s.x, s.y, _bex, _bey);
            logMessage('WEP: BEAM 推定射撃 — 手応えなし (その線上には居ない)', 'warning-msg');
            missRevealsShooter(s.x, s.y, _bex, _bey, true);
            if (!lk.full) recordMiss(enemySid(target), { x: s.x, y: s.y, x2: _bex, y2: _bey, r: (s === player ? PM.beamWidth : BEAM_HIT_WIDTH) + 120 });
        }
        beamNearMiss(s.x, s.y, _bex, _bey, true, hit ? target : null); // 第20弾: 外れても線の近くの敵はセンサーが乱れる
        beamRevealsShooter(s.x, s.y, true);                                 // 第20弾: 霧の軌跡で射手の位置が知れる
        s._beamCharge = 0; s._chargeLogged = false;
        s.beamReloading = true;
        s.beamReloadTimer = Math.round(BEAM_RELOAD_TIME * reloadMult * (s === player ? PM.beamReload : 1));
        logMessage('WEP: ビーム発射 — 次まで' + Math.round(s.beamReloadTimer / 60) + '秒 (リロード中も熱/EM/ヒッグスが漏れる・霧に軌跡が残る)', 'system-msg');
    }
    s.weaponType = wType;
    s._fireFlash = 90; s._fireFlashType = wType; s._lastFireType = wType; s._lastFireF = _frameCount; // 第22弾: 敵は撃たれた兵装で機動を選ぶ
    matchRecEvent('fireP', s.x, s.y, '自艦: ' + _WPN_JP[wType] + 'を撃つ' + (lk && lk.full ? ' (有視界)' : ' (推定点へ)'));
    if (wType === 'beam') s._beamDrain = BEAM_DRAIN_DUR; // ビームはジェネレータを食う: 発射後しばらく機関出力が落ちる
    playSound('shoot');
    cancelSilentRunning('発砲');
    s.fireCooldown = WEAPON_COOLDOWNS[wType] * genF;
    if (huntStats) huntStats.shots = (huntStats.shots || 0) + 1;
    return true;
}

// 射撃命令の対象: 現在の目標 → 無ければ最も確度の高いコンタクト
function bestFireTarget() {
    const te = player.targetEntity;
    if (te && te.hp > 0 && !te._dying && (te.inVision || te.contactLife > 0)) return te;
    let best = null, bestA = 0;
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying) continue;
        if (e.type === 'fighter' && !e.inVision) continue; // 艦載機は推定で撃つ相手ではない (見えたら自動攻撃)
        const a = e.inVision ? 1 : (e.contactLife > 0 ? e.contactAccuracy : 0);
        if (a > bestA) { bestA = a; best = e; }
    }
    return best;
}

// UIからの「射撃命令」: 推定位置へ艦首を向け、射角に入ったら1射する (霧の中から撃つ決断)
function issueFireOrder() {
    if (!player || player.hp <= 0) return;
    if (player._weaponJamTimer > 0) { logMessage('WEP: 火器管制ダウン — 復旧まで発砲不能', 'warning-msg'); return; }
    const w = currentWeapon();
    // 第23弾: 追跡中の信号が艦でない (偽艦影・ノイズ) 場合も、プレイヤーには区別がつかないので推定点へ撃つ
    if (lockedSignalId && !/^e-/.test(lockedSignalId)) {
        const sa = _signalAnalysis[lockedSignalId];
        if (!sa || !sa.fix) { logMessage('WEP: 射撃解なし — 目標の推定位置が無い。信号を追跡して解析を進めろ', 'warning-msg'); return; }
        const est = trackEstimate(sa, 0), idn = identInfo(lockedSignalId);
        if (idn.low) logMessage('WEP: 注意 — SIG-' + String(_contactLabels[lockedSignalId] || '?').padStart(2, '0') + ' は' + idn.txt + '。外れれば位置を教える', 'warning-msg');
        if (w !== 'missile' && w !== 'beam') { logMessage('WEP: 推定点への射撃はミサイル/ビームのみ', 'warning-msg'); return; }
        freeFireAt(est.x, est.y);
        return;
    }
    const te = bestFireTarget();
    if (te && !te.inVision) { const idn = identInfo(enemySid(te)); if (idn.low) logMessage('WEP: 注意 — SIG-' + String(_contactLabels[enemySid(te)] || '?').padStart(2, '0') + ' は' + idn.txt + '。外れれば位置を教える', 'warning-msg'); }
    if (!te) { logMessage('WEP: 射撃解なし — 目標の推定位置が無い。信号を追跡して解析を進めろ', 'warning-msg'); return; }
    if (!playerWeaponReady(player, w)) { logMessage(`WEP: ${w.toUpperCase()} リロード中`, 'warning-msg'); return; }
    const lk = playerLockInfo(te);
    if (lk.dist > weaponRange(w)) {
        logMessage(`WEP: 射程外 (${Math.round(lk.dist)}u > ${Math.round(weaponRange(w))}u) — 接近するか武器を変えろ`, 'warning-msg');
        return;
    }
    // ※ manualTarget は立てない: 射撃命令は単発。終わればいつも通り視界内の最寄り(群がるファイター等)へ自動で向き直る
    player.targetEntity = te;
    player._fireOrder = { target: te, wType: w, ttl: 480 };
    playSound('ui');
    logMessage(`WEP: 射撃命令 [${w.toUpperCase()}] — 艦首を向けて発射 (命中予測 ${Math.round(assumedHitChance(te, w, lk) * 100)}%)`, 'system-msg');
}

let _shipUid = 0;
// 敵シグネチャの sourceId は配列添字ではなく固有ID (旧: 'e-'+添字 → 撃破で配列が詰まると別艦を指していた)
function enemySid(e) { return 'e-' + e.uid; }
function enemyBySid(sid) {
    const m = sid && sid.match(/^e-(\d+)$/);
    if (!m) return null;
    const uid = +m[1];
    return enemies.find(e => e.uid === uid) || null;
}
class Ship {
    constructor(x, y, isPlayer = false, type = 'corvette') {
        this.x = x; this.y = y; this.isPlayer = isPlayer;
        this.uid = ++_shipUid;
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
            this.maxHp = type === 'carrier' ? 800 : (type === 'destroyer' ? 500 : (type === 'fighter' ? DRONE_SPEC.attack.hp : 150)); // 第22弾: 敵の艦載機も自機の戦闘機と同じ耐久 (旧50)
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

    setTarget(tx, ty) {
        this.targetX = tx; this.targetY = ty; this.state = 'moving';
        if (this.isPlayer) { this._moveOrderF = _frameCount; if (playerCoasting) toggleCoast(false); if (!comDemo && combatMode.mode !== 'manual') { combatMode.mode = 'manual'; syncCombatBar(); } }
    }

    // 第16弾: 敵の「撃ったら移動」。行き先は撃った方位(=自分が晒した方位)と直交する方向。
    // 真の自機位置は使わない (撃った先の推定点 aimAng だけを基準にする)。far=ミサイル/ビーム、retreat=損傷・格下時は少し下がる
    // 第20弾: 今撃てる兵装 (弾数・リロード・間合い)。望む兵装が使えなければ使える物へ持ち替える。無ければ null
    // 第22弾: 敵の操舵 — 自機と同じ慣性 (加速・逆噴射)・回頭・旋回減速・最高速。艦首の向きにしか進まない
    _maxSpeeds() {
        const cls = ENEMY_CLASS[this.type];
        if (!cls) return null;
        const base = shipCruiseSpeed(cls, 40, 1) * (this.upgSpeed || 1) * this.terrainSpeedMult() * epm(this).speed; // 第33弾: 部品
        return { silent: base * SILENT_SPEED_MULT, cruise: base, flank: base * 1.5 };
    }
    _moveHeading(targetAng, desired) {
        const cls = ENEMY_CLASS[this.type];
        const d = _angDiff(targetAng, this.angle);
        if (!cls) { // 艦載機は小回りが利く (従来どおり)
            this.angle += Math.sign(d) * Math.min(Math.abs(d), ENEMY_TURN_RATES[this.type] || 0.035);
            this._v = desired;
        } else {
            this.angle += Math.sign(d) * Math.min(Math.abs(d), PLAYER_TURN_RATES[cls] * epm(this).turn);
            const tm = Math.min(1, Math.abs(d) / (Math.PI * 0.12));
            const ts = Math.max(0, desired) * (1 - (SHIP_TURN_SLOW[cls] || 0.5) * tm);
            const ar = SHIP_ACCEL_RATE[cls] * epm(this).accel;
            const brake = (this._sysEngineTimer || 0) > 0 ? 0.25 : 2.5;
            const v = this._v || 0;
            this._v = v < ts ? Math.min(ts, v + ar) : Math.max(ts, v - ar * brake);
        }
        this.x += Math.cos(this.angle) * this._v; this.y += Math.sin(this.angle) * this._v;
        this.speed = this._v; this.currentSpeed = this._v;
        this._movedF = _frameCount;
        return d;
    }
    // 舵を取らなかったフレーム: 慣性で進みながら減速する (急停止しない)
    _coastIfIdle() {
        if (this._movedF === _frameCount || !(this._v > 0.005)) return;
        const cls = ENEMY_CLASS[this.type];
        this._v = cls ? Math.max(0, this._v - SHIP_ACCEL_RATE[cls] * 3) : 0;
        this.x += Math.cos(this.angle) * this._v; this.y += Math.sin(this.angle) * this._v;
        this.speed = this._v; this.currentSpeed = this._v;
    }
    _usableWeapon(pref, d) {
        // 第20弾: 艦載機は機銃(実弾)だけ。旧: 実弾の射程外だとミサイルへ切り替え、弾数の管理外で撃ち放題だった (自機の戦闘機も機銃だけ)
        if (this.type === 'fighter') return d <= 760 ? 'kinetic' : null;
        const ok = (w) => w === 'kinetic' ? d <= 760 && (this.ammoK === undefined || this.ammoK > 0) && !(this._kReload > 0)
                        : w === 'missile' ? d <= ENEMY_MISSILE_ENGAGE * 1.05 * epm(this).mslRange && (this.ammoM === undefined || this.ammoM > 0) && !(this._mReload > 0)
                        : w === 'beam' ? !(this._bReload > 0) : false;
        if (ok(pref)) return pref;
        for (const w of ['missile', 'kinetic']) if (w !== pref && ok(w)) return w;
        return null;
    }
    _relocateAfterFire(far, aimAng, retreat) {
        const side = Math.random() < 0.5 ? 1 : -1;
        // 攻撃型(ブルーザー)は撃ちながら斜め前へ詰める (撃った場所には留まらないが、間合いは近接へ寄せる)。
        // それ以外は撃った方位と直交 (損傷・格下なら少し後ろへ)
        const brawl = far && this.type === 'destroyer' && !retreat;
        const ang = aimAng + side * (brawl ? Math.PI / 2 - 0.7 : Math.PI / 2 + (retreat ? 0.45 : 0)) + (Math.random() - 0.5) * 0.5;
        const len = far ? 1800 + Math.random() * 1200 : 600 + Math.random() * 300;
        const tx = this.x + Math.cos(ang) * len, ty = this.y + Math.sin(ang) * len;
        const spot = far ? findHidingSpot(tx, ty, 900) : clampToMapCircle(tx, ty, 600);
        this.setTarget(spot.x, spot.y);
        this.postFireCooldown = far ? 240 : 90;
        if (comDemo && this.type !== 'fighter') comThinkEvent('e', '撃った → 位置を変える (' + _dirTxt(this.x, this.y, spot.x, spot.y) + (brawl ? '・斜め前へ詰めながら' : retreat ? '・少し下がりながら' : '') + ')', 'e' + this.uid);
        // 長い再配置で霧へ消える時だけ、相手(自機)がその艦を掴んでいれば知らせる (掴んでいない情報は出さない)
        if (far && (this.inVision || this.contactLife > 0) && _frameCount - (this._relocLog || -9999) > 900) {
            this._relocLog = _frameCount;
            logMessage('SENSOR: 敵艦が撃った位置から移動 — 推定位置は古くなる', 'warning-msg');
        }
    }

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
        if (this._daze > 0)           this._daze           -= gameSpeedFactor; // 第20弾: センサー撹乱 (至近弾・ビームの至近通過)
        // 第20弾: 敵の武器のリロード・ビームのチャージ (自機は playerTickReloads)
        if (this._kReload > 0 && (this._kReload -= gameSpeedFactor) <= 0) this._kMag = Math.min(epm(this).kinMag, this.ammoK ?? KINETIC_MAG);
        if (this._mReload > 0) this._mReload -= gameSpeedFactor;
        if (this._bReload > 0) this._bReload -= gameSpeedFactor;
        if (this._eCharge > 0 && _frameCount - (this._eChargeF || 0) > 30) this._eCharge = Math.max(0, this._eCharge - 2 * gameSpeedFactor);
        if (this._critCD > 0)         this._critCD         -= gameSpeedFactor;

        if (this.isPlayer) {
            // ── 自機シグネチャ再設計 (速度+エンジン配分+ゲイン を統一指標化) ──
            const _spd = Math.hypot(this.x - (this.prevX ?? this.x), this.y - (this.prevY ?? this.y));
            // 第17弾: 「前フレームの位置」はここ(移動の前)で保存する。旧: 移動の後に保存していたため、次フレームの
            // この計算では常に速度0になり、自艦のシグネチャが速さに関係なく一定だった (敵の予測照準に渡す速度も0だった)
            this.prevX = this.x; this.prevY = this.y;
            const _engType = ENGINE_TYPES[gameState.engineType] || ENGINE_TYPES.thermonuclear;
            const _hHere = getHiggsIntensity(this.x, this.y);
            const _ep = genAlloc.engine / 100;
            const _gain = (typeof genGain === 'number' && genGain > 0) ? genGain : 1; // 0.5..2.0
            // 推進排気強度 0..1: 「機関負荷」(艦種の最大巡航速度に対する現在速度)を主体に、エンジン配分とゲインで増減。
            // 第13弾: 旧式は絶対速度/6で正規化しており実速度域(0.3〜2u/f)では熱がほぼ立たなかった → 艦種別の負荷で正規化。
            const _spdN = Math.min(1, _spd / Math.max(0.1, shipCruiseSpeed(this.type, 100, 1)));
            // 第17弾: 機関停止中は推力ゼロ (熱と推進のEMが消える) / 緊急噴射中は推力最大
            const _thrust = (playerCoasting || engineSwitchT > 0) ? 0 : boostT > 0 ? 1 : Math.min(1, (0.04 + _spdN * 0.75 + _ep * 0.06) * (0.55 + _gain * 0.45));
            // 各シグネチャ = 推進強度 × エンジン種別倍率。エンジンごとに支配的シグネチャが変わる。
            // §3-1 エンジンアップグレード: 熱効率改善でheatSig低下
            // 電力(genAlloc.ai)↑ → 処理熱放射も増大
            const _es = ENGINE_SIG[gameState.engineType] || ENGINE_SIG.thermonuclear;
            this.heatSig    = Math.min(1, _thrust * _es.heat * 0.6 * (1 - ENGINE_UPG_HEAT_REDUCE[gameState.upgrades.engine]) + genAlloc.ai / 100 * 0.05);
            // 機関損傷: 冷却系破損で熱漏洩 (自機も対称に狩られやすくなる)
            if (this._sysEngineTimer > 0) this.heatSig = Math.min(1, this.heatSig + 0.35);
            // 発砲閃光: 撃った瞬間だけ強く光り1.5秒で減衰 (旧: 一度ビームを撃つと光学+0.5が永久に残っていた)
            const _ff = Math.max(0, (this._fireFlash || 0)) / 90;
            if (this._fireFlash > 0) this._fireFlash -= gameSpeedFactor;
            const _ft = this._fireFlashType;
            this.opticalSig = Math.min(1, _thrust * _es.optic * 0.5 + _ff * (_ft === 'kinetic' ? 0.6 * PM.opticFire : _ft === 'beam' ? 0.9 : 0.15)); // 第20弾: ビームの発射は強い光 (第32弾: 近接信管弾は×1.5)
            // EM: 推進＋(センサー/AI処理放射)。ゲインで増幅。AI↑でEM↑(逆探知の法則)。
            // 第13弾: エンジン種別のEM倍率は推進由来の放射だけに掛ける。AI/センサーの演算放射は機関に関係なく漏れる
            // (旧: 全体に掛けていたため熱核エンジンではAI放射が×0.4に消え、完全停止した艦は至近以外で絶対に見つからなかった)
            this.emSig      = Math.min(1, _thrust * _es.em * 0.6 + (genAlloc.sensors / 100 * 0.18 + genAlloc.ai / 100 * 0.40) * COMPUTE_EM_MULT * (0.6 + (playerCoasting ? 1 : _gain) * 0.4));
            if (_ff > 0 && _ft === 'beam') this.emSig = Math.min(1, this.emSig + _ff * 0.6);   // 第20弾: ビームの発射は強いEM
            if (_ff > 0 && _ft === 'missile') { this.heatSig = Math.min(1, this.heatSig + _ff * 0.35 * PM.mslLaunchHeat); this.emSig = Math.min(1, this.emSig + _ff * 0.45); } // 第20弾: ミサイル発射はEMも
            // 第20弾: ドローンの発進は光とEMが漏れる
            if (this._launchFlash > 0) {
                const _lf = this._launchFlash / 60;
                this._launchFlash -= gameSpeedFactor;
                this.opticalSig = Math.min(1, this.opticalSig + _lf * 0.35);
                this.emSig = Math.min(1, this.emSig + _lf * 0.40);
            }
            // 磁気嵐帯: 嵐がEM放射を覆い隠す → AIを安全に高配分できる退避所 (§3-13 D)
            this.emSig     *= (1 - getStormIntensity(this.x, this.y) * STORM_EM_MASK);
            // 熱雲: 環境熱ノイズが熱署名を埋もれさせる → HEATセンサーから隠れやすい (§3-13 Phase3)
            this.heatSig   *= (1 - getThermalIntensity(this.x, this.y) * THERMAL_HEAT_MASK);
            // ヒッグス: ヒッグス雲内を動くほどウェイク乱流。ヒッグスエンジンは特に顕著。
            this.higgsSig   = Math.min(1, _thrust * _hHere * 1.6 + _thrust * _es.higgs * 0.5); // 霧の中を動けば乱れる＋ヒッグスエンジンは推進そのものが霧を乱す
            // 第17弾: 漂っていても霧の中を動けば霧が乱れる (推力の分は無い)
            if (playerCoasting) this.higgsSig = Math.min(1, _spdN * _hHere * 0.8);
            // 静粛航行: 全シグネチャ抑制 (速度も落ちる。発砲/ソナーで自動解除)。機関停止中も同じ
            if (silentRunning || playerCoasting) {
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
            // ビームチャージ中: 熱/EM/ヒッグス激増 — 敵の「chargingシグネチャ推定→回避行動」が本物になる
            // 第20弾: リロード中(35秒)も熱/EM/ヒッグスが漏れ続ける。ミサイルのリロード中はEM (オーナー指定・量は実装で決めた値)
            if (this.beamReloading) {
                this.heatSig  = Math.min(1, this.heatSig + 0.15);
                this.emSig    = Math.min(1, this.emSig + 0.20);
                this.higgsSig = Math.min(1, this.higgsSig + 0.15);
            }
            if (this.missileReloading) this.emSig = Math.min(1, this.emSig + 0.20);
            if ((this._beamCharge || 0) > 0) {
                const _cl = PM.chargeLeak; // 第32弾: 集束レンズは漏れ×1.5
                this.heatSig = Math.min(1, this.heatSig + 0.30 * _cl);
                this.emSig   = Math.min(1, this.emSig + 0.40 * _cl);
                this.higgsSig = Math.min(1, this.higgsSig + 0.30 * _cl);
                // チャージが中断されたら放熱 (発射条件が30f以上満たされない場合)
                if (_frameCount - (this._chargeFrame || 0) > 30) {
                    this._beamCharge = Math.max(0, this._beamCharge - 2 * gameSpeedFactor);
                    if (this._beamCharge === 0) this._chargeLogged = false;
                }
            }
            // 第16弾: ノード制圧・コロニーハック中 — 通信のEMが漏れる
            if (_capturing || _resupply) this.emSig = Math.min(1, this.emSig + 0.30); // 第20弾: 補給中も
            // 第16弾: 資材から組み立て中 — 工作機械のEMが漏れる (潜航でも隠せない)。第20弾: オーナー指定でEMだけに
            if (cargoAssembling()) this.emSig = Math.min(1, this.emSig + 0.35);
            // 第21弾: 2本目以降に聴いている帯域は、その種類で漏れる / エンジン切替中はEMが漏れる
            this.heatSig = Math.min(1, this.heatSig + sensorLeak('heat'));
            this.opticalSig = Math.min(1, this.opticalSig + sensorLeak('optic'));
            this.emSig = Math.min(1, this.emSig + sensorLeak('em') + (engineSwitchT > 0 ? ENGINE_SWITCH_EM : 0));
            this.higgsSig = Math.min(1, this.higgsSig + sensorLeak('higgs'));
            // 第32弾: 部品 (熱・光・電磁波の倍率と、常に漏れる分。潜航/機関停止中は漏れる分も小さい)
            { const _qm = (silentRunning || playerCoasting) ? SILENT_SIG_MULT : 1;
              this.heatSig = Math.min(1, this.heatSig * PM.heat + PM.heatAdd * _qm);
              this.opticalSig = Math.min(1, this.opticalSig * PM.optic);
              this.emSig = Math.min(1, this.emSig * PM.em + PM.emAdd * _qm); }
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
            if (this._beamDrain > 0) this._beamDrain -= gameSpeedFactor;
            updateEngineSwitch();
            const _baseTargetSpeed = (engineSwitchT > 0 ? 0 : 1) * PM.speed * (this._beamDrain > 0 ? BEAM_DRAIN_SPEED : 1) * (shipCruiseSpeed(gameState.shipType, genAlloc.engine, genGain) * _higgsSlowdown * _engTypeP.speedMult + _higgsBonusSpeed * MOVE_SPEED_MULT) * this.terrainSpeedMult() * gameSpeedFactor * (silentRunning ? SILENT_SPEED_MULT : 1) * (boostT > 0 ? BOOST_MULT : 1);
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
            if (this.manualTarget && (!this.targetEntity || this.targetEntity.hp <= 0)) this.manualTarget = false;
            if (this.targetEntity && (this.targetEntity.hp <= 0 || this.targetEntity._dying)) this.targetEntity = null;

            // 武器リロードは毎フレーム進行 (旧: 交戦中しか進まず、リロードが「止まる」ことがあった)
            playerTickReloads(this);

            // 第17弾: 機関停止 — 慣性で漂う。霧の中ほど早く止まる (霧の粘り)
            if (playerCoasting) {
                const k = COAST_DECAY * (1 + COAST_FOG_DRAG * getHiggsIntensity(this.x, this.y)) * gameSpeedFactor;
                this.currentSpeed *= Math.max(0, 1 - k);
                if (this.currentSpeed < 0.01) this.currentSpeed = 0;
                this.speed = this.currentSpeed;
                const ca = this._coastAng ?? this.angle;
                this.x += Math.cos(ca) * this.currentSpeed;
                this.y += Math.sin(ca) * this.currentSpeed;
            }

            // ── 操舵ヘルパー: 回頭レート制限 + 旋回減速 + 慣性加速 (全移動モード共通) ──
            const _steer = (targetAng, targetSpd) => {
                let d = targetAng - this.angle;
                while (d < -Math.PI) d += Math.PI * 2;
                while (d > Math.PI) d -= Math.PI * 2;
                const tr = (PLAYER_TURN_RATES[gameState.shipType] || PLAYER_TURN_RATE) * gameSpeedFactor * PM.turn; // 第32弾: 部品
                this.angle += Math.sign(d) * Math.min(Math.abs(d), tr);
                if (playerCoasting) return d; // 第17弾: 機関停止中は艦首だけ回す (進路は変わらない)
                const tm = Math.min(1, Math.abs(d) / (Math.PI * 0.12));
                const ts = targetSpd * (1 - (SHIP_TURN_SLOW[gameState.shipType] || 0.5) * tm);
                const ar = (SHIP_ACCEL_RATE[gameState.shipType] || 0.008) * gameSpeedFactor * (boostT > 0 ? BOOST_ACCEL : 1) * PM.accel;
                // 第17弾: 機関が損傷・過熱している間は逆噴射も効かず、ゆっくりしか減速できない (噴射で稼いだ速度が残る)
                const brake = (this._sysEngineTimer || 0) > 0 ? 0.25 : 2.5;
                this.currentSpeed = this.currentSpeed < ts ? Math.min(ts, this.currentSpeed + ar) : Math.max(ts, this.currentSpeed - ar * brake);
                this.speed = this.currentSpeed;
                this.x += Math.cos(this.angle) * this.currentSpeed;
                this.y += Math.sin(this.angle) * this.currentSpeed;
                return d;
            };
            const _coast = () => {
                if (playerCoasting) return;
                if (boostT > 0) { _steer(this.angle, _baseTargetSpeed); return; } // 噴射中は艦首方向へ
                const ar = (SHIP_ACCEL_RATE[gameState.shipType] || 0.008) * gameSpeedFactor;
                this.currentSpeed = Math.max(0, this.currentSpeed - ar * 3);
                this.speed = this.currentSpeed;
                if (this.currentSpeed > 0.02) {
                    this.x += Math.cos(this.angle) * this.currentSpeed;
                    this.y += Math.sin(this.angle) * this.currentSpeed;
                }
            };

            const wType = currentWeapon();
            const te = this.targetEntity;
            const lk = te ? playerLockInfo(te) : null;
            if (te && lk && (lk.full || lk.assumed) && lk.full !== this._fullLockPrev) {
                this._fullLockPrev = lk.full;
                if (lk.full) this._fullLockF = _frameCount;
                logMessage(lk.full
                    ? 'LOCK: 完全ロックオン — 有視界・フルダメージ'
                    : 'LOCK: 想定ロック — センサー推定のみ。撃つかは自分で決めろ (射撃命令)',
                    lk.full ? 'system-msg' : 'warning-msg');
            }
            // 射撃命令の失効
            const ord = this._fireOrder;
            if (ord && (!ord.target || ord.target.hp <= 0 || ord.target._dying || (ord.ttl -= gameSpeedFactor) <= 0)) {
                if (ord.ttl <= 0) logMessage('WEP: 射撃命令を取り消し — 射撃解が得られない', 'warning-msg');
                this._fireOrder = null;
            }

            if (this._fireOrder) {
                // ── 射撃命令: 推定位置へ艦首を向け、射角に入った瞬間に1射。その後は元の航路に戻る ──
                const o = this._fireOrder;
                const oLk = playerLockInfo(o.target);
                const aim = oLk.full ? { x: o.target.x, y: o.target.y } : assumedAimPoint(o.target, o.wType);
                const ang = Math.atan2(aim.y - this.y, aim.x - this.x);
                const moveSpd = this.state === 'moving' ? _baseTargetSpeed * 0.55 : 0;
                const d = _steer(ang, moveSpd);
                const arc = WEAPON_FIRE_ARC[o.wType] || Math.PI / 4;
                if (Math.abs(d) < arc * 0.9 && this._weaponJamTimer <= 0 && this.fireCooldown <= 0 && playerWeaponReady(this, o.wType)) {
                    if (playerFireWeapon(this, o.target, o.wType, oLk)) this._fireOrder = null;
                }
            } else if (combatMode.mode !== 'manual' && te && lk && (lk.full || lk.assumed) && !playerCoasting && boostT <= 0 && engineSwitchT <= 0) {
                // ── 第22弾: 戦闘モード — 正対 / 回り込み で操艦し、射角に入った完全ロックの目標を撃つ (横滑りしない) ──
                let tx, ty, tAng = null;
                if (lk.full) { tx = te.x; ty = te.y; tAng = te.angle; }
                else {
                    const sa = _signalAnalysis[enemySid(te)];
                    const est = sa && sa.fix ? trackEstimate(sa, 0) : null;
                    tx = est ? est.x : (te.displayX ?? te.x); ty = est ? est.y : (te.displayY ?? te.y);
                    if (sa && sa.motion && Math.hypot(sa.motion.vx, sa.motion.vy) > 0.2) tAng = Math.atan2(sa.motion.vy, sa.motion.vx);
                }
                const D = combatMode.range === 'auto' ? (CM_RANGE[wType] || CM_RANGE.missile) : CM_DIST[combatMode.range];
                const oppW = te._lastFireType && _frameCount - (te._lastFireF || -1e9) < 1200 ? te._lastFireType : null;
                const man = combatManeuver(this, tx, ty, tAng, D, combatMode.mode, combatMode.prio, oppW ? WEAPON_FIRE_ARC[oppW] : null, combatMode.prio === 'evade' ? incomingMissile(this, false) : null);
                this._cmWhy = man.why;
                const d = _steer(man.ang, man.spd * _baseTargetSpeed);
                // 射角と射程に入っている兵装で撃つ (今の兵装が射角の外なら、入っている実弾/ミサイルで — 敵と同じ)
                const da = _angDiff(Math.atan2(ty - this.y, tx - this.x), this.angle);
                if (autoAttackEnabled && lk.full && this.fireCooldown <= 0 && this._weaponJamTimer <= 0) {
                    for (const w of [wType, 'kinetic', 'missile']) {
                        if (lk.dist < weaponRange(w) && Math.abs(da) < (WEAPON_FIRE_ARC[w] || Math.PI / 4) && playerWeaponReady(this, w)) { playerFireWeapon(this, te, w, lk); break; }
                    }
                }
            } else if (autoAttackEnabled && te && lk && lk.full && !playerCoasting && boostT <= 0 &&
                       !(this.state === 'moving' && (this._moveOrderF || 0) > (this._fullLockF || 0))) {
                // 第17弾: 敵を視認した「後」に出した移動命令は自動攻撃より優先する (旧: 視界内に敵がいると移動命令が無視され、
                // 回頭して詰め続けた = 逃げられず殴り合いになった)。機関停止中・噴射中は自動では撃たない (撃てば位置を教える。
                // 撃つなら射撃命令で)
                // ── 有視界交戦 (自動攻撃ON・完全ロック時のみ): 目標へ回頭・間合いを詰めて自動射撃 ──
                const ang = Math.atan2(te.y - this.y, te.x - this.x);
                const range = weaponRange(wType);
                const d = _steer(ang, lk.dist > range * 0.8 ? _baseTargetSpeed : 0);
                const arc = WEAPON_FIRE_ARC[wType] || (Math.PI * 5 / 6);
                if (lk.dist < range && this.fireCooldown <= 0 && Math.abs(d) < arc && this._weaponJamTimer <= 0 && playerWeaponReady(this, wType)) {
                    playerFireWeapon(this, te, wType, lk);
                }
            } else if (this.state === 'moving' && !playerCoasting) {
                const _wpDist = Math.hypot(this.targetX - this.x, this.targetY - this.y);
                if (_wpDist > Math.max(20, this.currentSpeed * 2)) {
                    _steer(Math.atan2(this.targetY - this.y, this.targetX - this.x), _baseTargetSpeed);
                } else {
                    this.state = 'idle';
                    _coast();
                }
                // 移動命令を優先している間も、射角と射程に入った完全ロックの目標には撃つ (舵は取らない。噴射中は撃たない)
                if (autoAttackEnabled && boostT <= 0 && te && lk && lk.full && lk.dist < weaponRange(wType) && this.fireCooldown <= 0 && this._weaponJamTimer <= 0 && playerWeaponReady(this, wType)) {
                    let da = Math.atan2(te.y - this.y, te.x - this.x) - this.angle;
                    while (da < -Math.PI) da += Math.PI * 2;
                    while (da > Math.PI) da -= Math.PI * 2;
                    if (Math.abs(da) < (WEAPON_FIRE_ARC[wType] || Math.PI / 4)) playerFireWeapon(this, te, wType, lk);
                }
            } else {
                // idle: 慣性で停止へ
                _coast();
            }

            // (HP等のDOM表示は updateEnvInfo で10フレーム毎に更新 — 毎フレームのDOM書き換えを廃止)

        } else {
            // ============================================================
            // 敵AI — ジエンド戦スタイル (一対一・潜伏・発砲後再配置)
            // ============================================================

            // ファイターの燃料切れ (消滅)
            if (this.fuel !== undefined && (this.fuel -= gameSpeedFactor) <= 0) { this.hp = 0; this._dying = 1; this._noReward = true; return; }
            // 第21弾: 状況適応の性格 — 1秒ごとに 隠密/貪欲/攻撃的/慎重 を見直す (相手を掴んでいる=追跡か交戦で記憶が新しい)
            if (this.personality && this.personality._adaptive && (_frameCount + this.uid) % 60 === 0) {
                const _ac = (this.aiState === 'hunting' || this.aiState === 'combat') && (this.contactFreshness || 0) > 0.2;
                const _am = adaptPersonality(this.personality, _ac, this.hp / this.maxHp);
                if (_am && comDemo) comThinkEvent('e', '性格が変わる → ' + ADAPT_MODES[_am].label + ' (' + (_am === 'cautious' ? '耐久' + _pct(this.hp / this.maxHp) + ' < 40%' : _am === 'aggressive' ? '自機を掴んだ' : _am === 'greedy' ? '90秒手掛かりなし' : '見失って60秒') + ')', 'e' + this.uid);
            }
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

            // 第20弾: 迎撃 — 射程(800u)に入った自機の戦闘機・人型・哨戒機を実弾で撃つ (砲塔なので向きは変えない・撃てば光る)。
            // 母艦は積んだ実弾を使う (艦載機は無制限)。旧: 敵はドローンを狙わず、流れ弾が当たるだけだった
            if (playerDrones.length && (this._pdCD = (this._pdCD || 0) - gameSpeedFactor) <= 0) {
                let pdT = null, pdD = ENEMY_PD_RANGE;
                for (const dr of playerDrones) {
                    if (dr.hp <= 0 || !(dr.type === 'attack' || dr.type === 'mech' || dr.type === 'scout')) continue;
                    const d = Math.hypot(dr.x - this.x, dr.y - this.y);
                    if (d < pdD) { pdD = d; pdT = dr; }
                }
                if (pdT && (this.ammoK === undefined || this.ammoK > 0) && !(this._weaponJamTimer > 0)) {
                    const prof = ENEMY_COMBAT[this.type] || ENEMY_COMBAT.destroyer;
                    for (let k = 0; k < (prof.burst || 1); k++) {
                        const lead = pdD / 12; // 弾が届くまでに動く分を見越す
                        const pr = new Projectile(this.x, this.y, { x: pdT.x + Math.cos(pdT.angle) * pdT.speed * lead + (k - 1) * 14, y: pdT.y + Math.sin(pdT.angle) * pdT.speed * lead + (k - 1) * 14, hp: 1 }, false, 'kinetic', this.upgDmg || 1);
                        pr.owner = this;
                        projectiles.push(pr);
                    }
                    if (this.ammoK !== undefined) this.ammoK--;
                    this._pdCD = 45;
                    this.fireFlashTimer = Math.max(this.fireFlashTimer || 0, 40);
                    if (comDemo && this.type !== 'fighter' && _frameCount - (this._pdLog || -9999) > 600) { this._pdLog = _frameCount; comThinkEvent('e', '迎撃 — ' + (DRONE_SPEC[pdT.type] || {}).label + 'が' + Math.round(pdD / 100) * 100 + 'uに入った → 実弾で撃つ', 'e' + this.uid); }
                } else this._pdCD = 15;
            }

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
                    const _ms = this._maxSpeeds();
                    this._moveHeading(ta, Math.min(0.8 * MOVE_SPEED_MULT, _ms ? _ms.cruise : 99)); // 第22弾: 慣性つき
                } else this._coastIfIdle();
                return; // 囮を追ってる間は他のAIをスキップ
            }

            // ──────────────────────────────────────
            // 発砲後再配置フェーズ
            // ──────────────────────────────────────
            if (this.postFireCooldown > 0) {
                this.postFireCooldown--;
                // 第22弾: 再配置も艦首を回してから進む (旧: 艦首と関係なく目標点へ横滑りしていた)
                const _msR = this._maxSpeeds();
                const _relV = _msR ? _msR.flank : 1.2 * MOVE_SPEED_MULT * (this.upgSpeed || 1) * this.terrainSpeedMult();
                if (this.state === 'moving') {
                    const dist = Math.hypot(this.targetX - this.x, this.targetY - this.y);
                    if (dist > 150) {
                        this._moveHeading(Math.atan2(this.targetY - this.y, this.targetX - this.x), _relV);
                    } else {
                        this.state = 'idle';
                        this.postFireCooldown = 0; // 着いたら聴き直して次の一撃へ (交戦状態はそのまま)
                    }
                } else {
                    this.postFireCooldown = 0;
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
            const _clN = playerClutter(); // 第18弾: 混信 — 周りに発信源が多いほど自艦を見分けにくい
            // 第21弾: 至近の直接探知 = 自機の有視界と同じ式 (居る場所の濃度で最大半径・視線の先の霧で遮られる)。
            // 旧: 1100×(1−濃さ×0.55) の円で、濃い霧では自機の有視界 (1200×(1−濃さ×0.95)) より広く「敵だけ見える」場面があった
            let myDetectRange = BASE_VISION_RADIUS * Math.max(MIN_VISION_FACTOR, 1 - higgsHereDetect * (1 - MIN_VISION_FACTOR)) * (1 + gameState.sector * 0.05) * playerEmBoost * (1 - jamDegrade) * (this.upgDetect || 1) / (1 + CLUTTER_HARD * _clN);
            let sigRange = ENEMY_PASSIVE_RANGE * (1 - higgsHereDetect * 0.3) * (1 + gameState.sector * 0.03) * (1 - jamDegrade) * (this.upgDetect || 1);
            // ヒッグスサージ: 敵の探知も対称に縮退/ブースト (プレイヤーと同じ物理法則)
            if (surgePhase === 'active') { myDetectRange *= SURGE_DETECT_MULT; sigRange *= SURGE_DETECT_MULT; }
            else if (surgePhase === 'after') { myDetectRange *= SURGE_CLARITY_MULT; sigRange *= SURGE_CLARITY_MULT; }
            // センサー損傷: ほぼ盲目 (奇襲でセンサーを潰せば追跡を振り切れる)
            if (this._sysSensorTimer > 0) { myDetectRange *= 0.1; sigRange *= 0.1; }
            if (this._daze > 0) { myDetectRange *= DAZE_SENSOR_MULT; sigRange *= DAZE_SENSOR_MULT; } // 第20弾: センサー撹乱
            // 第15弾: 自艦ノイズ — 速く動いている敵ほど耳が塞がる (プレイヤーと同じ物理)
            sigRange *= 1 - 0.45 * shipSelfNoise(this);

            let playerSigDetected = false;
            let _hardDetect = false; // 至近の直接探知 (位置誤差ほぼ無し)
            let detectedSigStrength = 0;
            let domSig = null, domVal = 0; // 最も強く検知したシグネチャ種別 (行動推定用)
            if (player && player.hp > 0) {
                const pSigs = { heat: player.heatSig||0, optic: player.opticalSig||0, em: player.emSig||0, higgs: player.higgsSig||0 };
                const _mx = (player.x + this.x) / 2, _my = (player.y + this.y) / 2;
                const _debrisPath  = getDebrisIntensity(_mx, _my);
                const _stormPath   = getStormIntensity(_mx, _my);
                const _thermalPath = getThermalIntensity(_mx, _my);
                enemyBands(this).forEach(sName => { // 第21弾: 敵も聴いている帯域だけ (性格で本数が決まる)
                    const sc2 = sensorConfig[sName];
                    const higgsPath = getHiggsIntensity(_mx, _my);
                    const distAtten = Math.max(0, 1 - distToPlayer / sigRange);
                    // 地形ハザード: デブリ=OPTIC減衰 / 磁気嵐=EM減衰 / 熱雲=HEAT減衰 (§3-13)
                    let terrAtten = 1;
                    if (sName === 'optic') terrAtten = 1 - _debrisPath * DEBRIS_OPTIC_MOD;
                    else if (sName === 'em')   terrAtten = 1 - _stormPath   * STORM_EM_MOD;
                    else if (sName === 'heat') terrAtten = 1 - _thermalPath * THERMAL_HEAT_MOD;
                    const attenuated = pSigs[sName] * distAtten * (1 - higgsPath * sc2.higgsMod) * terrAtten;
                    if (attenuated > sc2.threshold * 0.5) { playerSigDetected = true; detectedSigStrength = Math.max(detectedSigStrength, attenuated); }
                    if (attenuated > domVal) { domVal = attenuated; domSig = sName; }
                });
                // 接近探知 (デブリ擬態中は岩塊に紛れて至近でも掴めない — 至近を通過されてもやり過ごせる)
                if (!isBottomed && distToPlayer < Math.max(VIS_CLOSE, myDetectRange) && losReach(this.x, this.y, Math.atan2(player.y - this.y, player.x - this.x), Math.max(VIS_CLOSE, myDetectRange)) >= distToPlayer) { // 第22弾: 自機と同じ視線ルール (300u以内は必ず)
                    this.detectionTimer++;
                    if (this.detectionTimer > 60) { playerSigDetected = true; _hardDetect = true; }
                } else {
                    this.detectionTimer = Math.max(0, this.detectionTimer - 1);
                }
            }

            // 第17弾: ノイズメーカー — 全速の自艦と同じ熱を出す囮。敵は強い方の音を自艦と思い込む (至近で直接掴んでいれば本物が勝つ)
            let _noiseSrc = null;
            if ((noiseMakers.length || lures.length) && !_hardDetect && player && player.hp > 0) {
                // 第21弾: 自機の偽艦影ブイも「自機の音」に見える (敵が聴いている帯域で一番強いもの)
                for (const L of lures) {
                    if (L.owner !== 'p' || L.kind !== 'ship' || L.phase !== 'on') continue;
                    const dn = Math.hypot(L.x - this.x, L.y - this.y);
                    if (dn >= sigRange) continue;
                    const sL = lureSigFor(this, L, dn, sigRange);
                    if (sL > sensorConfig.heat.threshold * 0.5 && sL > detectedSigStrength) { detectedSigStrength = sL; _noiseSrc = L; }
                }
                for (const nm of noiseMakers) {
                    const dn = Math.hypot(nm.x - this.x, nm.y - this.y);
                    if (dn >= sigRange) continue;
                    const hp = getHiggsIntensity((nm.x + this.x) / 2, (nm.y + this.y) / 2);
                    const s = NOISE_HEAT * Math.min(1, nm.life / 60) * (1 - dn / sigRange) * (1 - hp * sensorConfig.heat.higgsMod);
                    if (s > sensorConfig.heat.threshold * 0.5 && s > detectedSigStrength) { detectedSigStrength = s; _noiseSrc = nm; }
                }
                if (_noiseSrc) playerSigDetected = true;
            }
            // 第16弾: 敵が制圧したノードは敵の聴音局 (自機と対称)。ノードの近くで音を立てれば、敵は遠くからでも位置を掴む
            let _relayErr = -1;
            if (!playerSigDetected && this.type !== 'fighter' && player && player.hp > 0 && (_frameCount + this.uid) % 30 === 0) {
                for (const post of listeningPosts('enemy')) { // 第31弾: 敵のコロニーも聴音局 (8000u)
                    const n = post.o, RR = post.R;
                    const dn = Math.hypot(player.x - n.x, player.y - n.y);
                    if (dn > RR) continue;
                    const s = Math.max(player.heatSig || 0, player.emSig || 0, (player.opticalSig || 0) * 0.8) * (1 - dn / RR) * (1 - getHiggsIntensity((player.x + n.x) / 2, (player.y + n.y) / 2) * 0.5);
                    if (s > 0.12) { playerSigDetected = true; detectedSigStrength = Math.max(detectedSigStrength, s * 0.6); _relayErr = dn * 0.18 + 150; break; }
                }
            }
            // センサー制約型: 探知中のみ最終既知位置を更新。喪失後は古い予測が凍結される。
            if (!playerSigDetected) this._ana = (this._ana || 0) * Math.pow(0.9995, gameSpeedFactor); // 第29弾: 聞こえない間は解析量が薄れる (約23秒で半分)
            if (playerSigDetected && player && player.hp > 0) {
                // 第13弾: 敵の位置推定にも誤差を (プレイヤーの推定円と対称)。
                // 遠く・弱い信号ほど誤差が大きく、探知が続くほど観測を重ねて真値へ収束する(平滑化)。
                const _q = _hardDetect ? 1 : Math.min(1, detectedSigStrength / 0.5);
                // 聞こえた音の主 (自艦 or ノイズメーカー)。敵には区別がつかない
                const _sx = _noiseSrc ? _noiseSrc.x : player.x, _sy = _noiseSrc ? _noiseSrc.y : player.y;
                const _srcDist = _noiseSrc ? Math.hypot(_sx - this.x, _sy - this.y) : distToPlayer;
                // 第29弾: 敵も解析量が要る (聞こえない間は薄れる: 下の else) (自機と同じ式・演算力は敵のコロニーで上がる)。見えていれば一気に貯まる
                this._ana = (this._ana || 0) + (_hardDetect ? 0.5 : analysisPower('enemy') * (0.5 + 0.5 * _q) / 60) * gameSpeedFactor;
                const _err = Math.max((_relayErr >= 0 ? _relayErr : (1 - _q) * _srcDist * 0.25 + 50) * (_noiseSrc ? 1 : clutterErrMult(_clN)) * (_hardDetect ? 1 : PM.ecm), // 第32弾: ECM
                                      _hardDetect ? 0 : _srcDist * anaFloorFrac(this._ana) * 0.5);
                const _ea = Math.random() * Math.PI * 2, _er = Math.sqrt(Math.random()) * _err;
                let _lkx = _sx + Math.cos(_ea) * _er, _lky = _sy + Math.sin(_ea) * _er;
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
                const _prevLk = this.playerLastKnownPos;
                const _blend = (_prevLk && this.contactFreshness > 0.5) ? 0.08 : 1; // 連続探知中は観測を平均化
                this.playerLastKnownPos = {
                    x: _prevLk ? _prevLk.x + (_lkx - _prevLk.x) * _blend : _lkx,
                    y: _prevLk ? _prevLk.y + (_lky - _prevLk.y) * _blend : _lky,
                    vx: (_noiseSrc ? _noiseSrc.vx * gameSpeedFactor : player.x - (player.prevX ?? player.x)) * _q,
                    vy: (_noiseSrc ? _noiseSrc.vy * gameSpeedFactor : player.y - (player.prevY ?? player.y)) * _q
                };
                // 推定がノイズメーカー由来か (他の理由で推定が書き換わるまで = 本物を掴み直すまで)
                this._noiseLk = _noiseSrc ? this.playerLastKnownPos : null;
                this.contactFreshness = 1.0;
                this.intelPos = null; // 実探知を得たら司令部情報の捜索は終了
            } else {
                // 残り香の減衰: 通常0.012/f(83s)。静粛航行×1.5(55s)・デブリ擬態×2.2(38s)で加速=「隠れる」行動が振り切りに直結する
                // 第13弾: 旧0.012/フレームでは記憶が約1.4秒で消えていた(コメントの「83秒」と60倍ずれ)。
                // 0.0004/f → 通常≈42秒 / 静粛×1.5≈28秒 / デブリ擬態×2.2≈19秒 で「追われている」状態が抜ける
                const _decayMult = isBottomed ? 2.2 : (silentRunning ? 1.5 : 1);
                // 第22弾 (オーナー合意): 追い続ける長さは性格と残り耐久で変わる — 攻撃的で無傷なら約70秒・慎重で手負いなら約20秒
                const _pm = this.personality || { caution: 0.4 };
                const _memMult = (0.6 + 0.8 * (_pm.caution ?? 0.4)) * (1.6 - 0.6 * Math.max(0, Math.min(1, this.hp / this.maxHp)));
                this.contactFreshness = Math.max(0, this.contactFreshness - FRESHNESS_DECAY * _decayMult * _memMult);
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
            // 第15弾: 航跡を読む — 音が途絶えても、霧に残った足跡を辿って追ってくる (プレイヤーと対称)
            if (!playerSigDetected && this.type !== 'fighter' && this.contactFreshness < 0.35 && (_frameCount + this.uid * 7) % 45 === 0) {
                const clue = readWakeClue(this);
                if (clue) {
                    this.playerLastKnownPos = { x: clue.x, y: clue.y, vx: 0, vy: 0 };
                    this.contactFreshness = 0.4;
                    if (comDemo) comThinkEvent('e', '霧に残った航跡を見つけた → 辿る (' + _dirTxt(this.x, this.y, clue.x, clue.y) + ')', 'e' + this.uid);
                    if (this.aiState === 'lurking' || this.aiState === 'gathering') { this.aiState = 'hunting'; this.huntTimer = 900; }
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
                    const _hk = this.playerLastKnownPos; // 推定位置へ向かう (旧: 真の座標を参照していた)
                    this.huntTarget = { x: _hk.x, y: _hk.y };
                }
                this.huntTimer = 480 + Math.floor(detectedSigStrength * 300);
                const _distBelief = Math.hypot(this.playerLastKnownPos.x - this.x, this.playerLastKnownPos.y - this.y);
                if (_distBelief < 1800 || detectedSigStrength > 0.6) {
                    if (this.aiState !== 'combat') {
                        this.aiState = 'combat';
                        this.lurking = false;
                        this.detectionState = 'alerted';
                        if (!this.alertLogged) { this.alertLogged = true; logMessage(`WARN: 敵艦(${personalityTag(this.personality || {})}個体)があなたのシグネチャを捕捉。迎撃態勢に入ります。`, 'warning-msg'); }
                        if (comDemo && this.type !== 'fighter') comThinkEvent('e', (_hardDetect ? '至近で直接掴んだ' : _noiseSrc ? '強い音を捕捉 (実はノイズメーカー)' : _relayErr >= 0 ? '聴音局が自機の音を拾った' : '自機の' + ({ heat: '熱', optic: '光', em: 'EM', higgs: '航跡' }[domSig] || '') + 'を捕捉') + ' (推定' + Math.round(_distBelief / 100) * 100 + 'u) → 交戦', 'e' + this.uid);
                    }
                } else if (this.aiState === 'lurking' || this.aiState === 'gathering') {
                    this.aiState = 'hunting';
                    this.gatherTarget = null;
                    this.lurking = false;
                    logMessage(`SENSOR: 敵艦が索敵パターンに移行。接近警戒。`, 'warning-msg');
                    if (comDemo && this.type !== 'fighter') comThinkEvent('e', '遠くに微かな反応 (推定' + Math.round(_distBelief / 100) * 100 + 'u) → 索敵へ', 'e' + this.uid);
                }
            }

            // キャリア: ドローン製造 (空母型の主戦力)。コンタクトを得ている時だけ射出し、
            // 交戦中は射出間隔を短縮。ドローンは"自分が信じている位置(最終既知位置)"へ向かわせる。
            if (this.type === 'carrier') {
                this.droneSpawnTimer--;
                const _engaged = this.aiState === 'combat' || this.aiState === 'hunting';
                const _hasContact = _engaged || this.contactFreshness > 0.1;
                // 第22弾: 艦載機の数は自機の空母と同じ既定の積み方 (戦闘機2)。旧 6+セクター — 戦闘機の耐久を自機と同じ1050にしたため、自機の既定(2機)と数もそろえる
                if (this.droneStock === undefined) this.droneStock = DEFAULT_LOADOUT.carrier.attack || 2;
                if (this.droneSpawnTimer <= 0 && _hasContact && this.droneStock > 0 && enemies.filter(e => e.hp > 0 && e.type === 'fighter').length < CARGO_CAP.carrier) { // 第21弾: 同時に出せる数は自機の空母と同じ上限
                    this.droneStock--;
                    const _bel = this.playerLastKnownPos || (player ? { x: player.x, y: player.y } : { x: this.x, y: this.y });
                    const drone = new Ship(
                        this.x + (Math.random()-0.5)*300,
                        this.y + (Math.random()-0.5)*300, false, 'fighter'
                    );
                    drone.aiState = 'hunting';
                    drone.huntTarget = { x: _bel.x, y: _bel.y };
                    drone.huntTimer = 600;
                    drone.lurking = false;
                    // 第21弾: 燃料切れでは消えない (自機のドローンと同じく撃墜されるまで残る。母艦を失った時だけ燃え尽きる)
                    enemies.push(drone);
                    this._launchFlash = 60; // 第20弾: 発進は光とEMが漏れる (自機と同じ)
                    this.droneSpawnTimer = _engaged ? (380 + Math.floor(Math.random() * 320)) : (700 + Math.floor(Math.random() * 500));
                    logMessage('TACTICAL: 敵空母がファイタードローンを射出！', 'warning-msg');
                    if (comDemo) comThinkEvent('e', '戦闘機を射出 → 推定位置 (' + _dirTxt(this.x, this.y, _bel.x, _bel.y) + ') へ向かわせる (残り' + this.droneStock + '機)', 'e' + this.uid);
                }
            }

            // ── 第17弾: 潜伏 — 後退した敵は濃い霧/岩礁帯で止まって修復し、45秒で狩りに戻る ──
            // (旧: 後退中も全速で動き続け熱が最大になるため、追われて沈むまで殴り合いになっていた)
            let _hideActive = false;
            if (this._hideT > 0) {
                const hs = this._hideSpot;
                const lkH = this.playerLastKnownPos;
                const near = lkH && this.contactFreshness > 0.8 && Math.hypot(lkH.x - this.x, lkH.y - this.y) < 1200;
                if (near && this._hiding) {
                    // 至近まで来られたら潜伏を解いて応戦
                    this._hideT = 0; this._hiding = false;
                } else {
                    const dH = Math.hypot(hs.x - this.x, hs.y - this.y);
                    if (dH > 200) {
                        this._hiding = false;
                        const ang = Math.atan2(hs.y - this.y, hs.x - this.x);
                        const _msH = this._maxSpeeds();
                        this._moveHeading(ang, _msH ? _msH.flank : 1.5); // 第22弾: 隠れ場所へ全速 (自機の全速と同じ)
                    } else {
                        if (!this._hiding && (this.inVision || this.contactLife > 0)) logMessage('SENSOR: 敵艦が' + (hs.kind === 'fog' ? '濃い霧' : '岩礁帯') + 'で機関を止めた — 潜んで修復している', 'system-msg');
                        this._hiding = true;
                        // 第26弾: 修理はリペアキットだけ (旧: 潜伏中に毎秒0.5%回復)
                        if ((this.itemRepair || 0) > 0 && !(this._kitT > 0) && this.hp < this.maxHp - REPAIR_KIT_HP * 0.8) {
                            this.itemRepair--; this._kitT = REPAIR_KIT_TIME;
                            matchRecEvent('repairE', this.x, this.y, '敵: リペアキットを使う');
                            if (comDemo) comThinkEvent('e', '潜伏中 → リペアキットで修理 (残り' + this.itemRepair + '個)', 'e' + this.uid);
                        }
                        this._hideT -= gameSpeedFactor;
                    }
                    if (this._hideT <= 0) {
                        this._hideT = 0; this._hiding = false; this._hideCD = 3600;
                        if (comDemo) comThinkEvent('e', '潜伏を終える (耐久' + _pct(this.hp / this.maxHp) + ') → 狩りへ戻る', 'e' + this.uid);
                        this.aiState = 'hunting'; this.huntTimer = 900; this.lurking = false;
                    }
                    _hideActive = true; // 他のAIは止める (シグネチャの計算はこの後も毎フレーム行う)
                }
            }
            if (this._hideCD > 0) this._hideCD -= gameSpeedFactor;
            // ── 第20弾: 補給 — 弾が尽きたら交戦を離れ、補給所か (自機がハックしていない) コロニーへ。600u以内に8秒留まれば満タン ──
            let _supplyActive = false;
            if (!_hideActive && this.type !== 'fighter' && this.ammoM !== undefined) {
                const _profS = ENEMY_COMBAT[this.type] || ENEMY_COMBAT.destroyer;
                const _needS = (this.ammoK <= 0 && this.ammoM <= 0) || (this.ammoM <= 0 && (_profS.weaponEarly !== 'kinetic' || this.ammoK < (this._fullK || 1) * 0.25));
                if (_needS && !this._supply) {
                    let best = null, bd = Infinity, kind = '';
                    for (const c of structures) { if (c.type !== 'colony' || c.hacked || c._usedE) continue; const d = Math.hypot(c.x - this.x, c.y - this.y); if (d < bd) { bd = d; best = c; kind = 'コロニー'; } }
                    if (best) {
                        this._supply = { x: best.x, y: best.y, t: 0, col: best };
                        if (comDemo) comThinkEvent('e', '弾が尽きた (実弾' + this.ammoK + '・ミサイル' + this.ammoM + ') → 交戦を離れて' + kind + 'で補給 (' + _dirTxt(this.x, this.y, best.x, best.y) + ')', 'e' + this.uid);
                    }
                }
                const sp = this._supply;
                if (sp) {
                    const dS = Math.hypot(sp.x - this.x, sp.y - this.y);
                    if (dS > RESUPPLY_R * 0.6) {
                        const ang = Math.atan2(sp.y - this.y, sp.x - this.x);
                        const _msS = this._maxSpeeds();
                        this._moveHeading(ang, _msS ? _msS.cruise : 1.2); // 第22弾: 補給へは巡航
                    } else if (sp.col && sp.col._usedE) { this._supply = null; // 第26弾: 1つのコロニーで1回だけ
                    } else if ((sp.t += gameSpeedFactor) >= RESUPPLY_TIME) {
                        if (sp.col) sp.col._usedE = true;
                        this.ammoK = this._fullK; this.ammoM = this._fullM; this._kMag = KINETIC_MAG; this._kReload = 0; this._mReload = 0;
                        this._supply = null;
                        this.aiState = 'hunting'; this.huntTimer = 900; this.lurking = false;
                        if (comDemo) comThinkEvent('e', '補給完了 (実弾' + this.ammoK + '・ミサイル' + this.ammoM + ') → 狩りへ戻る', 'e' + this.uid);
                        if (this.inVision || this.contactLife > 0) logMessage('SENSOR: 敵艦が補給を終えた', 'warning-msg');
                    } else this.emSig = Math.max(this.emSig, 0.45); // 補給中は通信のEMが漏れる (自機と同じ)
                    _supplyActive = !!this._supply;
                }
            }

            // ──────────────────────────────────────
            // 状態別AI実行
            // ──────────────────────────────────────
            if (_hideActive || _supplyActive) {
                // 潜伏中 (上で処理済み)
            } else if (this.aiState === 'combat') {
                this.lurking = false;
                const prof = ENEMY_COMBAT[this.type] || ENEMY_COMBAT.destroyer;
                const pers = this.personality || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
                const fireRange = (700 + gameState.sector * 25) * prof.rangeMult;
                this.speed = Math.min(2.2, 0.9 + gameState.sector * 0.08) * prof.speedMult * (this.upgSpeed || 1) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT; // 艦載機の速さ (戦艦は _maxSpeeds)

                // センサー制約型照準: 実プレイヤーではなく「最終既知位置」へ撃つ。
                // 接触が新しいほど速度ぶんリード外挿、喪失するほど古い点で凍結 → 移動/沈黙で外れる。
                const lk = this.playerLastKnownPos;
                const lead = this.contactFreshness * 40; // 鮮度に応じた外挿フレーム (最大40)
                const aimX = lk ? lk.x + lk.vx * lead : (player ? player.x : this.x);
                const aimY = lk ? lk.y + lk.vy * lead : (player ? player.y : this.y);
                const distToBelief = Math.hypot(aimX - this.x, aimY - this.y);
                // 第22弾: ストレイフ (左右へ振る横移動) は撤去 — 戦艦の機動は combatManeuver (正対 / 回り込み) だけ

                // ── HP状況による行動変容 (自他HP比 + 性格caution) ──
                const hpFrac = this.hp / this.maxHp;
                const playerHpFrac = (player && player.hp > 0) ? player.hp / player.maxHp : 1;
                let retreatThresh = 0.12 + pers.caution * 0.43;          // 慎重なほど早く退く
                if (playerHpFrac > hpFrac + 0.30) retreatThresh += 0.12; // 相手が格上 → さらに早く退く
                const desperate = hpFrac < retreatThresh;
                const killInstinct = hpFrac > 0.5 && playerHpFrac < 0.35; // 自分は健在で相手が瀕死 → 仕留めに踏み込む
                // 第15弾: 相手の方が明らかに頑丈なら殴り合わない — 間合いを取り、推定位置へ撃っては位置を変える (ジ・エンド戦)。
                // 旧: 攻撃型は常に近接で殴り続け、待ち伏せしているだけの自機(耐久3500)に撃ち負けていた (放置が2戦2勝)
                const outmatched = !killInstinct && player && player.hp > this.hp * 2.3;
                // 第19弾: 思考ログ用に今の判断材料を控える (COM対戦デモで表示。挙動には影響しない)
                const _ct = this._cThink || (this._cThink = {});
                _ct.thr = retreatThresh; _ct.kill = killInstinct; _ct.out = outmatched; _ct.dist = distToBelief;
                if (desperate) _ct.mode = 'retreat';
                // 撤退中の自己修復: ノードに触れたら回収して回復 (経済↔生存の結節点)
                if (desperate) {
                    if (!this._desperateLogged) {
                        logMessage('SENSOR: 敵艦が損傷により後退 — 回復行動に移行。', 'system-msg'); this._desperateLogged = true;
                        // 第22弾: 退き始めに離脱の消耗品を使う — 近くに自機かミサイルがいれば閃光 / 追われていればノイズを横へ / 煙幕
                        if (this.type !== 'fighter') {
                            const _dP = player ? Math.hypot(player.x - this.x, player.y - this.y) : 1e9;
                            if (_dP < FLASH_RADIUS || incomingMissile(this, true)) enemyUseFlash(this);
                            if (this.contactFreshness > 0.5) enemyUseNoise(this, this.angle + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2);
                            if (_dP < 4000) enemyUseSmoke(this);
                        }
                    }
                    // 第17弾: 近くに濃い霧/岩礁帯があればそこへ潜む (ノードより優先。ノードは位置が知られている)
                    if (!(this._hideCD > 0) && this.type !== 'fighter') {
                        const lkC = this.playerLastKnownPos;
                        const cs = findCoverSpot(this.x, this.y, ENEMY_HIDE_SEARCH, lkC ? Math.atan2(lkC.y - this.y, lkC.x - this.x) : null);
                        if (cs) { this._hideSpot = cs; this._hideT = ENEMY_HIDE_TIME; this._hiding = false; if (comDemo) comThinkEvent('e', '耐久' + _pct(hpFrac) + ' < 退き際' + _pct(retreatThresh) + ' → 近くの' + (cs.kind === 'fog' ? '濃い霧' : '岩礁帯') + 'に潜んで修復する', 'e' + this.uid);
                            // 第21弾: 潜りに行く前に、反対方向へ偽艦影ブイを撃って追手の耳を逸らす (自機の囮と同じもの)
                            if ((this.lureShip || 0) > 0) {
                                this.lureShip--;
                                const _la = Math.atan2(this.y - cs.y, this.x - cs.x) + (Math.random() - 0.5) * 0.6;
                                launchLure('e', 'ship', this.x, this.y, this.x + Math.cos(_la) * 2500, this.y + Math.sin(_la) * 2500);
                                if (comDemo) comThinkEvent('e', '潜る前に偽艦影ブイを反対方向 (' + _dirTxt(this.x, this.y, this.x + Math.cos(_la) * 2500, this.y + Math.sin(_la) * 2500) + ') へ — 追手の耳を逸らす', 'e' + this.uid);
                            }
                        }
                    }
                    for (const n of resourceNodes) {
                        if (!_nodeUsefulForEnemy(n)) continue;
                        if (Math.hypot(n.x - this.x, n.y - this.y) < this.radius + 70) {
                            if (n.owner !== 'enemy') enemyCaptureNode(this, n);
                            n.eHeal = _frameCount;
                            // 第26弾: ノードでの修復は撤去 (修理はリペアキットだけ)
                            break;
                        }
                    }
                } else { this._desperateLogged = false; }

                // 撤退中は射撃より離脱を優先。たまに振り向きざまに撃つ(fighting retreat)。
                // 第13弾: ミサイルは推定位置へ2100uまで撃てる (終末シーカー付き)。旧: 全艦種が約1km以内でしか撃たず、
                // 自機の長距離射撃に一方的に削られていた。近接火器(kinetic)の間合いは従来どおり fireRange。
                const engageRange = Math.max(fireRange, ENEMY_MISSILE_ENGAGE);
                // ── 第22弾: 戦艦の戦闘機動 (毎フレーム・慣性つき)。機動の選び方は10秒続ける (相手の兵装が変わった時と耐久が半分を切った時は選び直す) ──
                let _plannedW = gameState.sector <= 3 ? prof.weaponEarly : prof.weaponLate;
                if (this.predictedBehavior === 'kinetic' && _plannedW === 'kinetic') _plannedW = 'missile';
                if (outmatched && _plannedW === 'kinetic') _plannedW = 'missile';
                if (ENEMY_CLASS[this.type]) {
                    const _ms = this._maxSpeeds();
                    const oppW = player && player._lastFireType && _frameCount - (player._lastFireF || -1e9) < 1200 && this.contactFreshness > 0.3 ? player._lastFireType : null;
                    const cp = this._cmPlan;
                    if (!cp || _frameCount - cp.f >= CM_HOLD || cp.oppW !== oppW || (cp.hp >= 0.5) !== (hpFrac >= 0.5)) {
                        const ch = comChooseManeuver(pers, hpFrac, _plannedW, oppW);
                        if (killInstinct) ch.prio = 'attack';
                        if (outmatched) { ch.D = Math.max(ch.D, CM_RANGE.missile); ch.prio = 'evade'; }
                        this._cmPlan = { f: _frameCount, oppW, hp: hpFrac, mode: ch.mode, prio: ch.prio, D: ch.D };
                        if (comDemo && (!cp || cp.mode !== ch.mode || cp.prio !== ch.prio)) comThinkEvent('e', '戦闘機動 → ' + (ch.mode === 'flank' ? '回り込み' : '正対') + '・間合い' + ch.D + 'u・' + (ch.prio === 'evade' ? '回避' : '攻撃') + '優先' + (oppW ? ' (相手は' + _WPN_JP[oppW] + ')' : ''), 'e' + this.uid);
                    }
                    const pl = this._cmPlan;
                    // 相手の艦首の向き: 近くで掴んでいれば見える / それ以外は推定の動きから (止まっていれば分からない)
                    let tAng = null;
                    if (distToBelief < 1500 && this.contactFreshness > 0.6 && player) tAng = player.angle;
                    else if (lk && Math.hypot(lk.vx, lk.vy) > 0.2) tAng = Math.atan2(lk.vy, lk.vx);
                    const oppArc = oppW ? WEAPON_FIRE_ARC[oppW] : null;
                    let man;
                    if (desperate) {
                        const nn = nearestActiveNode(this.x, this.y, 7000);
                        man = { ang: nn ? Math.atan2(nn.y - this.y, nn.x - this.x) : Math.atan2(this.y - aimY, this.x - aimX), spd: 1, why: 'retreat' };
                    } else man = combatManeuver(this, aimX, aimY, tAng, pl.D, pl.mode, pl.prio, oppArc, pl.prio === 'evade' ? incomingMissile(this, true) : null);
                    // 撃てる兵装が射角に入るまで艦首を向ける (攻撃優先・射程内・間合いを保っている時)
                    if (!desperate && pl.prio === 'attack' && man.why === 'hold') man.ang = Math.atan2(aimY - this.y, aimX - this.x);
                    this._moveHeading(man.ang, man.spd * (_ms ? _ms.flank : 1.5));
                    _ct.mode = desperate ? 'retreat' : man.why;
                }
                const _wantFire = distToBelief < engageRange && this.fireCooldown <= 0 && this._weaponJamTimer <= 0 && player && player.hp > 0 && (!desperate || Math.random() < 0.25);
                if (_wantFire) {
                    const ta = Math.atan2(aimY - this.y, aimX - this.x);
                    if (!ENEMY_CLASS[this.type]) { // 艦載機は撃つ時に向きを変える (小回り)
                        const _d0 = _angDiff(ta, this.angle);
                        this.angle += Math.sign(_d0) * Math.min(Math.abs(_d0), ENEMY_TURN_RATES[this.type] || 0.035);
                    }
                    const diff = _angDiff(ta, this.angle);
                    // 艦種別の武器選択 (序盤/終盤) + 既存の行動推定適応
                    let wType = gameState.sector <= 3 ? prof.weaponEarly : prof.weaponLate;
                    // 適応: プレイヤーが実弾近接戦と推定 & 自分も近接武器なら長射程へ (アウトレンジ)
                    if (this.predictedBehavior === 'kinetic' && wType === 'kinetic') wType = 'missile';
                    if (outmatched && wType === 'kinetic') wType = 'missile';
                    this.weaponType = wType;
                    // kinetic は射程800しか飛ばないので、それを超える間合いでは強制的にミサイルへ
                    if (wType === 'kinetic' && distToBelief > 760) wType = 'missile';
                    // 第20弾: 弾数・リロード・ビームのチャージ (自機と同じ)。使えない兵装は持ち替え、何も無ければ撃たない
                    wType = this._usableWeapon(wType, distToBelief);
                    // 第22弾: 自機と同じく射角に入っていなければ撃たない (旧: 艦首の向きに関係なく撃てた)。ビームのチャージは射角の外でもできる
                    if (wType && wType !== 'beam' && Math.abs(diff) > (WEAPON_FIRE_ARC[wType] || Math.PI / 4)) { wType = wType === 'missile' && this._usableWeapon('kinetic', distToBelief) === 'kinetic' && Math.abs(diff) < WEAPON_FIRE_ARC.kinetic ? 'kinetic' : null; if (!wType) this.fireCooldown = 10; }
                    let _canShoot = !!wType;
                    if (!wType) this.fireCooldown = Math.max(this.fireCooldown, 10);
                    else if (wType === 'beam' && (this._eCharge || 0) < BEAM_CHARGE_DUR * epm(this).beamCharge) {
                        if (!(this._eCharge > 0) && comDemo) comThinkEvent('e', 'ビームをチャージ (2秒・熱/EM/ヒッグスが漏れる)', 'e' + this.uid);
                        this._eCharge = (this._eCharge || 0) + gameSpeedFactor; this._eChargeF = _frameCount;
                        this.weaponType = 'beam';
                        _canShoot = false;
                    } else if (wType === 'beam' && Math.abs(diff) > WEAPON_FIRE_ARC.beam) { _canShoot = false; this._eChargeF = _frameCount; } // 溜まったまま艦首が向くのを待つ
                    if (_canShoot) {
                    // 攻撃型は3連装、それ以外は単発。kinetic時のみ弾幕、ミサイル/ビームは単発。
                    const shots = (wType === 'kinetic') ? prof.burst : 1;
                    const baseRange = Math.max(1, Math.hypot(aimX - this.x, aimY - this.y));
                    for (let s = 0; s < shots; s++) {
                        const spread = shots > 1 ? (s - (shots - 1) / 2) * KINETIC_SPREAD : 0; // 第20弾: 自機と同じ散布
                        const sa = ta + spread;
                        const tgX = this.x + Math.cos(sa) * baseRange;
                        const tgY = this.y + Math.sin(sa) * baseRange;
                        const aimTarget = { x: tgX, y: tgY, hp: 1 };
                        let projTarget = aimTarget;
                        if (wType === 'beam') {
                            // beamは即着弾。照準点が実プレイヤーに十分近い時だけ実弾化、外れなら空撃ち(無害だがダークチャネルは残る)。
                            const missDist = Math.hypot(player.x - tgX, player.y - tgY);
                            beamRevealsShooter(this.x, this.y, false, this); // 第20弾: 霧に軌跡が残る → 自艦に射手の方位線
                            const _blk = barrierBlocksBeam(this.x, this.y, tgX, tgY); // 第22弾: バリアがあれば1発止める
                            if (_blk) {
                                effects.push({ x: this.x, y: this.y, tx: _blk.x, ty: _blk.y, type: 'beam', a: 1, c: '#ff4d4d' });
                                leaveBeamChannel(this.x, this.y, _blk.x, _blk.y);
                                continue;
                            }
                            if (missDist >= player.radius * 2.2) {
                                effects.push({ x: this.x, y: this.y, tx: tgX, ty: tgY, type: 'beam', a: 1, c: '#ff4d4d' });
                                leaveBeamChannel(this.x, this.y, tgX, tgY);
                                beamNearMiss(this.x, this.y, tgX, tgY, false, null); // 外れても至近を通れば自艦のセンサーが乱れる
                                continue;
                            }
                            projTarget = player;
                        }
                        _beamShooter = this; // beam即着弾用: 発射元を渡す (奇襲被弾の対称判定)
                        const _eproj = new Projectile(this.x, this.y, projTarget, false, wType, this.upgDmg || 1);
                        _eproj.owner = this; // kinetic/missile着弾時の奇襲被弾判定用
                        { const _m = epm(this); // 第33弾: 敵の部品
                          if (wType === 'kinetic') _eproj.dmg *= _m.kinDmg * _m.dmgAll;
                          else if (wType === 'missile') { _eproj.dmg *= _m.mslDmg * _m.dmgAll; _eproj.maxDist *= _m.mslRange; _eproj.speed *= _m.mslSpeed; _eproj.quiet = !!_m.mslQuiet; _eproj.emp = !!_m.emp; _eproj.seekR = _m.seeker ? 900 : 600; } }
                        _beamShooter = null;
                        projectiles.push(_eproj);
                    }
                    playSound('shoot');
                    this.fireCooldown = prof.fireCD * (this.upgFireCD || 1); // 実弾の連射間隔 (ミサイル・ビームはリロードが律速)
                    // 第20弾: 弾を消費してリロード (実弾=8斉射マガジン / ミサイル=1発ごとに10秒 / ビーム=35秒)
                    if (wType === 'kinetic' && this.ammoK !== undefined) { this.ammoK--; if (this._kMag === undefined) this._kMag = epm(this).kinMag; if (--this._kMag <= 0 || this.ammoK <= 0) this._kReload = KINETIC_RELOAD_TIME * epm(this).kinReload; }
                    else if (wType === 'missile' && this.ammoM !== undefined) { this.ammoM--; this._mReload = MISSILE_RELOAD_TIME * epm(this).mslReload; }
                    else if (wType === 'beam') { this._bReload = BEAM_RELOAD_TIME * epm(this).beamReload; this._eCharge = 0; }
                    this.fireFlashTimer = 120;
                    this._lastFireType = wType; this._lastFireF = _frameCount; // 第22弾: 自機(COM)は撃たれた兵装で機動を選ぶ
                    if (this.type !== 'fighter') matchRecEvent('fireE', this.x, this.y, '敵: ' + _WPN_JP[wType] + 'を撃つ (推定点まで' + Math.round(distToBelief / 100) * 100 + 'u)');
                    this.visible = true;
                    const sigLabel = { kinetic: '銃口炎[光学]', missile: '推進炎[熱源+EM]', beam: 'EMパルス[EM+光学]' };
                    effects.push({ x: this.x, y: this.y, r: 0, maxR: 200, a: 0.9, c: '#ff4d4d', type: 'circle' });
                    logMessage(`WARNING: 敵艦発砲 — ${sigLabel[wType]||''}シグネチャ捕捉。`, 'warning-msg');
                    if (comDemo) comThinkEvent('e', '推定点へ' + _WPN_JP[wType] + 'を撃つ (' + Math.round(distToBelief / 100) * 100 + 'u先・確信' + _pct(this.contactFreshness) + (desperate ? '・後退しながら' : '') + ')', 'e' + this.uid);
                    // 第16弾: 撃ったら必ず位置を変える (全艦種・ファイター除く)。撃てば位置を教えるのは自機と同じ —
                    // 撃った場所に留まらない。ミサイル/ビーム=推定方位と直交する方向へ1800〜3000u (霧を選ぶ) /
                    // 実弾=近接戦は続けたまま横へ600〜900u跳ぶ。旧: 間合いを取る艦種だけで、攻撃型は撃った場所で殴り続けた
                    // 第22弾: 撃ったら移動は「遠くから撃って、相手に見られていない時」だけ (霧へ移る)。近接の撃ち合いでは機動を続ける
                    if (this.type !== 'fighter' && wType !== 'kinetic' && distToBelief > 2500 && !this.inVision) this._relocateAfterFire(true, Math.atan2(aimY - this.y, aimX - this.x), desperate || outmatched);
                    } // _canShoot
                } else if (!ENEMY_CLASS[this.type]) {
                    // 艦種別の機動 (ドクトリン) を性格とHP状況で変調。第22弾: 艦載機だけ (戦艦は上の combatManeuver)
                    const pbv = this.predictedBehavior;
                    // 性格: 攻撃的ほど間合いを詰め・近接でも逃げない / killInstinctでさらに踏み込む
                    let standoffDist = fireRange * prof.standoff * (1.25 - pers.aggression * 0.5);
                    let fleeCloseFrac = prof.fleeClose * (1.1 - pers.aggression * 0.4);
                    if (killInstinct) { standoffDist *= 0.5; fleeCloseFrac *= 0.35; }
                    if (outmatched) { standoffDist = Math.max(standoffDist, ENEMY_MISSILE_ENGAGE * 0.9); fleeCloseFrac = Math.max(fleeCloseFrac, 1.4); }
                    let moveAngle = Math.atan2(aimY - this.y, aimX - this.x); // 既定: 信念点へ前進
                    _ct.standoff = standoffDist;
                    _ct.mode = desperate ? 'retreat' : distToBelief > standoffDist ? 'approach' : (fleeCloseFrac > 0 && distToBelief < fireRange * fleeCloseFrac) ? 'flee' : (prof.kite && distToBelief < standoffDist * 0.8) ? 'kite' : 'hold';
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
                    // 第22弾: ストレイフ・ビームチャージ推定の横移動は撤去 (オーナー指示「ストレイフは一切禁止」)
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
                    if (this.huntTimer <= 0) { this.aiState = 'lurking'; this.lurking = true; this.alertLogged = false; if (_frameCount > (this._alertUntil || 0)) this.detectionState = 'unaware'; if (comDemo && this.type !== 'fighter') comThinkEvent('e', '自機の音が途絶えた → 交戦を解いて潜伏へ (残り香を追う)', 'e' + this.uid); }
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
                    if (comDemo) comThinkEvent('e', '接触が薄い (確信' + _pct(this.contactFreshness) + ') → 探信を打つ (位置を晒すが正確な位置が取れる)', 'e' + this.uid);
                }
                this.speed = Math.min(1.6, 0.8 + gameState.sector * 0.06) * _huntProf.speedMult * (this.upgSpeed || 1) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT;
                if (this.huntTimer > 0) this.huntTimer--;
                if (this.huntTarget) {
                    const dist = Math.hypot(this.huntTarget.x - this.x, this.huntTarget.y - this.y);
                    if (dist > this.speed * 2) {
                        const ta = Math.atan2(this.huntTarget.y - this.y, this.huntTarget.x - this.x);
                        const _msN = this._maxSpeeds();
                        this._moveHeading(ta, _msN ? Math.min(this.speed, _msN.cruise) : this.speed); // 第22弾: 追う時は巡航まで
                    } else {
                        this.huntTarget = null;
                    }
                }
                if (this.huntTimer <= 0 && !playerSigDetected) { this.aiState = 'lurking'; this.lurking = true; if (_frameCount > (this._alertUntil || 0)) this.detectionState = 'unaware'; }

            } else if (this.aiState === 'gathering') {
                this.lurking = false;
                this.speed = Math.min(1.2, 0.7 + gameState.sector * 0.05) * this.terrainSpeedMult() * gameSpeedFactor * MOVE_SPEED_MULT;
                // 最寄りノード探索 (第16弾: 自分のものでないノードを制圧しに行く)
                if (!this.gatherTarget || this.gatherTarget.owner === 'enemy') {
                    let closest = null, closestDist = Infinity;
                    resourceNodes.forEach(n => { if (n.owner === 'enemy') return; const d = Math.hypot(n.x-this.x, n.y-this.y); if (d < closestDist) { closestDist=d; closest=n; } });
                    this.gatherTarget = closest;
                    this._capT = 0;
                    if (!closest) { this.aiState = 'lurking'; this.lurking = true; }
                }
                if (this.gatherTarget) {
                    const dist = Math.hypot(this.gatherTarget.x - this.x, this.gatherTarget.y - this.y);
                    if (dist > 220) {
                        const ta = Math.atan2(this.gatherTarget.y - this.y, this.gatherTarget.x - this.x);
                        const _msG = this._maxSpeeds();
                        this._moveHeading(ta, _msG ? Math.min(this.speed, _msG.cruise) : this.speed);
                    } else if ((this._capT = (this._capT || 0) + gameSpeedFactor) >= NODE_CAP_TIME) {
                        // 自機と同じく近くに5秒留まって制圧 (その間EMが漏れる = 自機に聞かれうる)
                        enemyCaptureNode(this, this.gatherTarget);
                        this.resourcePoints++;
                        // ノード1個ごとに小回復。2個ごとに性格重み付けで自己強化 (放置すると相手が育つ)。
                        if (this.resourcePoints % 2 === 0) applyEnemyUpgrade(this); // 第26弾: ノードでの小回復は撤去
                        this.gatherTarget = null; this._capT = 0;
                        this.aiState = 'lurking'; this.lurking = true;
                    }
                }

            } else {
                // lurking (default)
                this.lurking = true;
                const _pers = this.personality || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
                // 残り香(contactFreshness)がある間は獲物を追って徘徊。攻撃的=速い追跡 / 隠密=低速で忍び寄る(低シグネチャ)。
                const _hasScent = this.playerLastKnownPos && this.contactFreshness > 0.04;
                let _bcs = null, _fpick = null;
                // 司令部情報(開戦時の概位置)へ向かう哨戒中も、残り香を追う時と同じ忍び足の速度
                const _stalking = _hasScent || !!this.intelPos || !!this._roam;
                if (_hasScent) this._lastScentF = _frameCount;
                this.speed = (_stalking ? ENEMY_STALK_SPEED * (0.6 + _pers.aggression * 0.6) * (1 - _pers.stealth * 0.4) : 0.08) * MOVE_SPEED_MULT;
                const activeNodes = resourceNodes.filter(n => n.owner !== 'enemy');
                // 第21弾: 潜伏中のゆっくりした移動 (隠れ場所へ0.08u/f) の途中でも4秒ごとに考え直す。
                // 旧: 着くまで (数分) 次の判断をせず、遭難信号・哨戒・ノードに反応できなかった
                if (this.state === 'idle' || (!this._roam && (_frameCount + this.uid) % 240 === 0)) {
                    if (_hasScent && Math.random() < 0.05) {
                        // 残り香あり: 最終既知位置周辺を集中捜索しながらじわじわ詰める(獲物がヒッグス雲に潜伏と推定)
                        const _lkp = this.playerLastKnownPos;
                        // 速度ベクトル方向へ少しリード(逃げた先を読む)
                        const _leadX = _lkp.x + (_lkp.vx || 0) * 40;
                        const _leadY = _lkp.y + (_lkp.vy || 0) * 40;
                        const searchSpot = findHidingSpot(_leadX, _leadY, 3000);
                        this.setTarget(searchSpot.x, searchSpot.y);
                    } else if (this.intelPos && this.type !== 'fighter' && Math.random() < 0.03) {
                        // 第13弾: 開戦時の司令部情報(自機の概位置)へ、隠れ場所伝いに区間ごとに前進する (ジエンド戦の"狩人")
                        const ip = this.intelPos;
                        const dI = Math.hypot(ip.x - this.x, ip.y - this.y);
                        if (dI < 2500) this.intelPos = null; // 到着 → 以降は通常の潜伏・捜索
                        else {
                            const a = Math.atan2(ip.y - this.y, ip.x - this.x), leg = Math.min(dI, 3500 + Math.random() * 1500);
                            const spot = findHidingSpot(this.x + Math.cos(a) * leg, this.y + Math.sin(a) * leg, 1500);
                            this.setTarget(spot.x, spot.y);
                        }
                    } else if (this.type !== 'fighter' && (_bcs = beaconsFor('e').filter(b => !(this._bcSeen || []).includes(b))).length
                               && ((this._bcSeen = (this._bcSeen || []).concat(_bcs).slice(-6)), Math.random() < (0.3 + _pers.greed * 0.6) * ((this._lureWary || 0) > _frameCount ? 0.3 : 1))) {
                        // 遭難信号へ向かう (貪欲な個体ほど食いつく) — プレイヤーと同じ海域へ収束
                        // 第20弾: 忍び足の速度で向かう (旧: 潜伏の0.08u/fのままで、着く前に信号が切れていた)
                        // 第21弾: 自機の偽SOSも本物と区別がつかない (一度騙されると60秒は食いつきが鈍る)。
                        // 新しい信号を聞いた時に一度だけ「行くか」を決める (確率 30%+貪欲さ×60% — 実装で決めた値)
                        let _bc = _bcs[0];
                        for (const b of _bcs) if (Math.hypot(b.x - this.x, b.y - this.y) < Math.hypot(_bc.x - this.x, _bc.y - this.y)) _bc = b;
                        this.setTarget(_bc.x, _bc.y);
                        if (this._roam !== 'beacon' && comDemo) comThinkEvent('e', '遭難信号 → 物資を取りに向かう (' + _dirTxt(this.x, this.y, _bc.x, _bc.y) + ')', 'e' + this.uid);
                        this._roam = 'beacon';
                    } else if (this.type !== 'fighter' && !_hasScent && (_fpick = enemyFieldPick(this, _pers))) {
                        // 第31弾: 聞こえた漂流コンテナ (と、たまに自然の信号) を見に行く — 動けば痕跡が残る
                        this.setTarget(_fpick.x, _fpick.y);
                        if (comDemo) comThinkEvent('e', (_fpick.kind === 'cache' ? '弱く平坦な信号 → 漂流コンテナと見て回収に向かう' : '信号を確かめに行く') + ' (' + _dirTxt(this.x, this.y, _fpick.x, _fpick.y) + ')', 'e' + this.uid);
                        this._roam = 'cache';
                    } else if (this.type !== 'fighter' && !_hasScent && (this.lureSOS || 0) > 0 && (_pers.caution >= 0.5 || _pers.stealth >= 0.5) && _frameCount - (this._lastScentF || 0) > ENEMY_ROAM_QUIET * (1.4 - _pers.aggression) && Math.random() < 0.01) {
                        // 第21弾: 慎重・隠密な個体は偽SOSで誘い出し、その近くの霧に潜んで待ち伏せる (自機と同じ偽SOS)
                        this.lureSOS--;
                        const _sa = Math.atan2(MAP_CY - this.y, MAP_CX - this.x) + (Math.random() - 0.5) * 1.2, _sd = 3000 + Math.random() * 2000;
                        const _sp = clampToMapCircle(this.x + Math.cos(_sa) * _sd, this.y + Math.sin(_sa) * _sd, 2000);
                        launchLure('e', 'sos', this.x, this.y, _sp.x, _sp.y);
                        const _amb = findHidingSpot(_sp.x, _sp.y, 1500);
                        this.setTarget(_amb.x, _amb.y); this._roam = 'patrol';
                        if (comDemo) comThinkEvent('e', '気配なし → 偽SOSを ' + _dirTxt(this.x, this.y, _sp.x, _sp.y) + ' に出し、その近くの霧で待ち伏せる', 'e' + this.uid);
                    } else if (this.type !== 'fighter' && !_hasScent && ((_frameCount - (this._lastScentF || 0) > ENEMY_ROAM_QUIET * (1.4 - _pers.aggression) && Math.random() < 0.02)
                               || (this._partHunt = enemySlotsUsed(this) < enemySlotsMax(this) && _frameCount - (this._lastScentF || 0) > ENEMY_PART_QUIET && Math.random() < 0.15 + _pers.greed * 0.3))) {
                        // 第33弾: 部品の枠が空いていれば、20秒気配が無いだけで部品を取りに出る (長い静けさを待たない)
                        // 第20弾: 長く何も聞こえない → 隠れ場所伝いに区間ごとに哨戒へ (行き先: 自分のものでないノード / コロニー / マップ中央)
                        let g = this._roamGoal;
                        if (g && g.der && g.der.salvaged) g = this._roamGoal = null; // 第33弾: 難破船は取られたら次へ
                        // 第33弾: 部品の枠が空いていれば、部品の取れる所 (まだ回収されていない難破船 / 部品をまだ取っていないノード・コロニー) を優先する
                        if (!g && enemySlotsUsed(this) < enemySlotsMax(this) && (this._partHunt || Math.random() < 0.35 + _pers.greed * 0.5)) {
                            let ps = null, pd = Infinity;
                            for (const st of structures) {
                                const ok = st.type === 'derelict' ? !st.salvaged : st.type === 'colony' ? !st._partE && st.owner !== 'enemy' : false;
                                if (!ok) continue; const d = Math.hypot(st.x - this.x, st.y - this.y); if (d < pd) { pd = d; ps = st; }
                            }
                            for (const n of resourceNodes) { if (n._partE || n.owner === 'enemy') continue; const d = Math.hypot(n.x - this.x, n.y - this.y); if (d < pd) { pd = d; ps = n; } }
                            if (ps) {
                                const isDer = ps.type === 'derelict', isCol = ps.type === 'colony';
                                g = this._roamGoal = { x: ps.x, y: ps.y, lbl: isDer ? '難破船 (部品)' : isCol ? 'コロニー (部品)' : 'ノード (部品)', der: isDer ? ps : null, col: isCol ? ps : null, node: !isDer && !isCol ? ps : null };
                                if (comDemo) comThinkEvent('e', '気配なし・部品の枠が空いている → ' + g.lbl + ' (' + _dirTxt(this.x, this.y, g.x, g.y) + ')', 'e' + this.uid);
                            }
                        }
                        if (!g || (g.col ? g.col.owner === 'enemy' : g.node ? g.node.owner === 'enemy' : g.der ? g.der.salvaged : Math.hypot(g.x - this.x, g.y - this.y) < 2500)) {
                            // 第23弾: コロニーを占有すれば自機の位置の手掛かり (方角・距離) が入る → 自分のでないコロニーを優先して取りに行く
                            let col = null, cd = Infinity;
                            for (const st of structures) { if (st.type !== 'colony' || st.owner === 'enemy') continue; const d = Math.hypot(st.x - this.x, st.y - this.y); if (d < cd) { cd = d; col = st; } }
                            if (col && Math.random() < 0.4 + _pers.greed * 0.5) {
                                g = this._roamGoal = { x: col.x, y: col.y, lbl: col.owner === 'player' ? '自機のコロニー (奪う)' : 'コロニー (占有する)', col };
                                if (comDemo) comThinkEvent('e', '気配なし → ' + g.lbl + ' (' + _dirTxt(this.x, this.y, g.x, g.y) + ')。占有すれば自機の方角が分かる', 'e' + this.uid);
                            }
                        }
                        if (!g || (!g.col && Math.hypot(g.x - this.x, g.y - this.y) < 2500)) {
                            const cands = [{ x: MAP_CX, y: MAP_CY, lbl: 'マップ中央' }];
                            for (const n of resourceNodes) if (n.owner !== 'enemy') cands.push({ x: n.x, y: n.y, lbl: 'ノード' });
                            for (const st of structures) if (st.type === 'colony') cands.push({ x: st.x, y: st.y, lbl: 'コロニー' });
                            const far = cands.filter(q => Math.hypot(q.x - this.x, q.y - this.y) > 4000);
                            g = this._roamGoal = (far.length ? far : cands)[Math.floor(Math.random() * (far.length || cands.length))];
                            if (comDemo) comThinkEvent('e', '長く気配なし (攻撃性' + _pct(_pers.aggression) + ') → ' + g.lbl + 'の方へ哨戒に出る (' + _dirTxt(this.x, this.y, g.x, g.y) + ')', 'e' + this.uid);
                        }
                        const dG = Math.hypot(g.x - this.x, g.y - this.y), aG = Math.atan2(g.y - this.y, g.x - this.x), leg = Math.min(dG, 3500 + Math.random() * 1500);
                        if ((g.col || g.der || g.node) && dG < 3000) { this.setTarget(g.x + Math.cos(aG + Math.PI) * 150, g.y + Math.sin(aG + Math.PI) * 150); if (g.node && dG < 600) this.aiState = 'gathering'; } // 最後は直接 (コロニー600u/8秒・難破船500u/3秒・ノードは収集へ)
                        else { const spot = findHidingSpot(this.x + Math.cos(aG) * leg, this.y + Math.sin(aG) * leg, 1500); this.setTarget(spot.x, spot.y); }
                        this._roam = 'patrol';
                    } else if (activeNodes.length > 0 && Math.random() < (0.0012 + _pers.greed * 0.012)) {
                        // 貪欲な個体ほど積極的にノードを奪取しに行く (性格による行動分岐)
                        this.aiState = 'gathering';
                        logMessage('SENSOR: 敵艦がリソース収集パターンに移行。', 'system-msg');
                        if (comDemo && this.type !== 'fighter') comThinkEvent('e', '気配なし・貪欲さ' + _pct(_pers.greed) + ' → ノードを取りに行く', 'e' + this.uid);
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
                    if (dist > Math.max(60, (this._v || 0) * 30)) {
                        const _msL = this._maxSpeeds();
                        this._moveHeading(Math.atan2(this.targetY - this.y, this.targetX - this.x), _msL ? Math.min(this.speed, _msL.cruise) : this.speed); // 第22弾: 横滑りしない
                    } else { this.state = 'idle'; this._roam = null; }
                }
            }
            this._coastIfIdle(); // 第22弾: 舵を取らなかった時は慣性で減速しながら進む
        }

        // 敵艦: エンジン排気エフェクトは非表示 (センサー検知のみで捕捉)

        // ============================================================
        // マルチセンサーシグネチャ更新 (敵のみ)
        // ============================================================
        if (!this.isPlayer) {
            // 熱源シグネチャ: 移動量から計算
            const spd = Math.hypot(this.x - this.prevX, this.y - this.prevY);
            this._vx = this.x - this.prevX; this._vy = this.y - this.prevY; // 第20弾: 見えている時の見越し射撃に使う (見えている動き)
            this._spd = spd; // 自艦ノイズ (探知の聴こえにくさ) に使う
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
                const target = (0.5 + Math.sin(Date.now() * 0.0015 + this.x * 0.001) * 0.1) * COMPUTE_EM_MULT; // 第23弾: 演算のEMは自機と同じく半分
                this.emSig += (target - this.emSig) * 0.03;
            } else if (this.postFireCooldown > 0) {
                // 再配置中: 無線封鎖 (熱源は上がるがEMは下がる)
                this.emSig = Math.max(0, this.emSig - 0.025);
            } else {
                this.emSig = Math.max(0, this.emSig - 0.01);
            }
            // 第16弾: ノードを制圧している間は通信のEMが漏れる (自機と対称)
            if (this.aiState === 'gathering' && this._capT > 0) this.emSig = Math.max(this.emSig, 0.45);
            // 第17弾: 潜伏中は機関を止めてシグネチャ×0.55 (自機の潜航と対称)。毎フレーム計算し直す熱にだけ掛ける
            // (EM・光学・ヒッグスは前フレームから減衰していく値なので、掛け続けると0へ潰れる。止まっていれば自然に消える)
            if (this._hiding) this.heatSig *= ENEMY_HIDE_SIG;
            // 第20弾: ビームのチャージ中・リロード中は熱/EM/ヒッグス、ミサイルのリロード中はEM、艦載機の発進は光とEMが漏れる (自機と同じ)
            if (this._eCharge > 0) { this.heatSig = Math.min(1, this.heatSig + 0.30); this.emSig = Math.max(this.emSig, 0.55); this.higgsSig = Math.min(1, this.higgsSig + 0.30); }
            else if (this._bReload > 0) { this.heatSig = Math.min(1, this.heatSig + 0.15); this.emSig = Math.max(this.emSig, 0.35); this.higgsSig = Math.min(1, this.higgsSig + 0.15); }
            if (this._mReload > 0) this.emSig = Math.max(this.emSig, 0.30);
            if (this._launchFlash > 0) { this._launchFlash -= gameSpeedFactor; this.opticalSig = Math.max(this.opticalSig, 0.5); this.emSig = Math.max(this.emSig, 0.5); }
            // 第21弾: 敵のエンジン (自機と同じ4種の倍率。動いている分だけ効く) と、2本目以降に聴いている帯域の漏れ (自機と同じ量)
            if (this.type !== 'fighter') {
                const _eg = ENGINE_TYPES[this.engine] || ENGINE_TYPES.thermonuclear;
                if (spd > 0.15) {
                    const _sn = Math.min(1, spd / 2);
                    const _ees = ENGINE_SIG[this.engine] || ENGINE_SIG.thermonuclear; // 第23弾: 自機と同じ表
                    this.heatSig = Math.min(1, this.heatSig * _ees.heat);
                    this.opticalSig = Math.min(1, this.opticalSig + _sn * 0.5 * _ees.optic);
                    this.emSig = Math.min(1, this.emSig + _sn * 0.6 * _ees.em);
                    this.higgsSig = Math.min(1, this.higgsSig + _sn * 0.5 * _ees.higgs);
                }
                const _bd = enemyBands(this);
                for (let bi = 1; bi < _bd.length; bi++) {
                    const b = _bd[bi], L = SENSOR_LEAK[b];
                    if (b === 'heat') this.heatSig = Math.min(1, this.heatSig + L);
                    else if (b === 'optic') this.opticalSig = Math.min(1, this.opticalSig + L);
                    else if (b === 'em') this.emSig = Math.min(1, this.emSig + L * epm(this).leakMul);
                    else this.higgsSig = Math.min(1, this.higgsSig + L * epm(this).leakMul);
                }
                // 第33弾: 敵の部品 (熱・光・電磁波の倍率と常に漏れる分。自機と同じ)。光学・EMは前フレームから減衰する値なので加算は「下限」として掛ける
                if (this.pm) {
                    const _m = this.pm, _q = this._hiding ? ENEMY_HIDE_SIG : 1;
                    this.heatSig = Math.min(1, this.heatSig * _m.heat + _m.heatAdd * _q);
                    this.opticalSig = Math.min(1, this.opticalSig * _m.optic);
                    this.emSig = Math.min(1, Math.max(this.emSig * _m.em, _m.emAdd * _q));
                }
            }
        }
    }

    draw(ctx) {
        // 第16弾: 敵の艦影は「見えている」時だけ描く (有視界の内側 / 発砲の閃光 / 崩壊中) — 見えたら不透明100%。
        // 音で掴んだだけのコンタクトは艦影ではなく drawSensorTrace の反応マーカーで示す (旧: 推定位置に半透明の艦影を重ねていた)
        if (!this.isPlayer && !(this.inVision || this.fireFlashTimer > 0 || this._dying || higgsViewOff)) { this._drawLockReticle(ctx); return; }
        ctx.save();
        ctx.translate(this.x, this.y);
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
                ctx.globalAlpha = 1;
                drawSpriteCentered(ctx, _psprite, this.radius * 6.4); // 第16弾: 透過スプライトをそのまま不透明で
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
                // 透過スプライト(第16弾)を不透明で描き、暗い艦体が霧に沈まないよう同じ絵を薄く加算して明るくする
                const _eLen = this.radius * (isFlashing ? 6.2 : 5.6);
                ctx.globalAlpha = 1;
                drawSpriteCentered(ctx, _esprite, _eLen);
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.3;
                drawSpriteCentered(ctx, _esprite, _eLen);
                ctx.globalCompositeOperation = 'source-over';
                // HP bar below sprite (local space, counter-rotate for axis-aligned bar)
                const _hpRatio = Math.max(0, this.hp / this.maxHp);
                ctx.save();
                ctx.rotate(-this.angle);
                const _bW = 36, _bH = 5, _bY = this.radius * 3.2 + 4;
                ctx.globalAlpha = 0.9;
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(-_bW / 2, _bY, _bW, _bH);
                ctx.fillStyle = _hpRatio < 0.3 ? '#ff4400' : _hpRatio < 0.6 ? '#ffaa00' : '#44ff88';
                ctx.fillRect(-_bW / 2, _bY, _bW * _hpRatio, _bH);
                ctx.globalAlpha = 1;
                ctx.restore();
                ctx.restore();
                this._drawLockReticle(ctx);
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

        if (!this.isPlayer) this._drawLockReticle(ctx);
    }

    // ロックオン・レティクル: 完全ロック(視野内)=緑実線 / 想定ロック(推定位置)=琥珀破線。画面上で一定の大きさ
    _drawLockReticle(ctx) {
        if (!player || player.targetEntity !== this || this.hp <= 0) return;
        const full = !!this.inVision;
        if (!full && !(this.contactLife > 0)) return;
        const lx = full ? this.x : this.displayX, ly = full ? this.y : this.displayY;
        const zc = 1 / camera.zoom;
        const lr = Math.max(this.radius * 3.2 + 6, 16 * zc);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.strokeStyle = full ? 'rgba(0,255,170,0.9)' : 'rgba(255,170,0,0.85)';
        ctx.lineWidth = 1.6 * zc;
        if (!full) ctx.setLineDash([6 * zc, 6 * zc]);
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

    // センサー痕跡(不確実性サークル + AIロックオン候補) — フォグ/ヒッグスの「手前」に描く専用パス
    drawSensorTrace(ctx) {
        if (this.isPlayer || this.hp <= 0) return;
        if (!(this.contactLife > 0)) return;
        let dispX = this.displayX, dispY = this.displayY;
        // 追跡(解析)由来: 推定円と同じ補間中心に描く (円とゴーストがずれないように)
        if (this.trackR) {
            const sa = _signalAnalysis[enemySid(this)];
            if (sa && sa.displayCenterX != null) { dispX = sa.displayCenterX; dispY = sa.displayCenterY; }
        }
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
            ctx.strokeStyle = 'rgb(' + col + ')';
            ctx.fillStyle = 'rgba(' + col + ',0.30)';
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
        if (this.trackR) return;   // 追跡由来は推定円(drawTriangulationCircle)が不確実性を表す
        // 第16弾: 精度%の文字と「AIロックオン候補」の菱形群は撤去 (同じ不確かさを円と数字と候補で3重に描いていた)
        ctx.save();
        ctx.globalAlpha = lifeA;
        ctx.beginPath();
        ctx.arc(dispX, dispY, uncertaintyR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(' + col + ',0.7)';
        ctx.lineWidth = 1.5 / camera.zoom;
        ctx.setLineDash([8 / camera.zoom, 8 / camera.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        ctx.globalAlpha = 1;
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
        ctx.beginPath(); ctx.arc(p.x, p.y, (p.size || 2) * p.life * 0.6 + (p.size || 2) * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; // (第21弾: shadowBlur を撤去 — モバイル規則)
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
        ctx.globalAlpha = d.life;
        if (d.img && spriteReady(d.img)) { const z = d.size * 2; ctx.drawImage(d.img, -z / 2, -z / 2, z, z); } // 第21弾: 破片の絵
        else { ctx.strokeStyle = d.color; ctx.beginPath(); ctx.moveTo(-d.size, 0); ctx.lineTo(d.size, 0); ctx.stroke(); }
        ctx.restore();
    }
}

// 第21弾: ミサイルの爆発の破片 (Higgsfieldの破片6種を回しながら飛ばす)
function spawnShrapnel(x, y, n, sp) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = sp * (0.4 + Math.random() * 0.8);
        if (debris.length > 160) break;
        debris.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: Math.random() * Math.PI * 2, vrot: (Math.random() - 0.5) * 0.4,
            size: 6 + Math.random() * 8, life: 1.0, decay: 0.012 + Math.random() * 0.012, color: '#ffaa66', img: SPRITES['fx_debris_' + Math.floor(Math.random() * 6)] });
    }
}
// 第21弾: 損傷した艦から煙 (耐久50%未満) と火花 (25%未満)。見えている艦だけ (自艦・見えている敵)
function emitDamageSmoke(s) {
    if (!s || s.hp <= 0 || s._dying) return;
    const f = s.hp / s.maxHp;
    if (f >= 0.5) return;
    if (s !== player && !s.inVision) return;
    const every = f < 0.25 ? 6 : 12;
    if ((_frameCount + (s.uid || 0)) % every || s._puffF === _frameCount) return; // 一時停止中は出さない
    s._puffF = _frameCount;
    if (damagePuffs.length >= 70) return;
    const a = Math.random() * Math.PI * 2, d = Math.random() * 22;
    const vx = Math.cos(a) * 0.5 - (s.x - (s.prevX ?? s.x)) * 0.25, vy = Math.sin(a) * 0.5 - (s.y - (s.prevY ?? s.y)) * 0.25; // 外へ流れる・航跡側へ残る
    damagePuffs.push({ spark: false, x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d, vx, vy, r: 18 + Math.random() * 12, life: 1.0, decay: 0.014, rot: Math.random() * 6.28 });
    if (f < 0.25 && Math.random() < 0.5)
        damagePuffs.push({ spark: true, x: s.x + Math.cos(a + 2) * d, y: s.y + Math.sin(a + 2) * d, vx: 0, vy: 0, r: 16 + Math.random() * 10, life: 1.0, decay: 0.07, rot: Math.random() * 6.28 });
}
function drawDamagePuffs(ctx) {
    if (!damagePuffs.length) return;
    const okS = spriteReady(SPRITES.fx_smoke), okK = spriteReady(SPRITES.fx_sparks);
    for (let i = damagePuffs.length - 1; i >= 0; i--) {
        const q = damagePuffs[i];
        q.life -= q.decay; q.x += q.vx; q.y += q.vy; q.rot += 0.012;
        if (q.life <= 0) { damagePuffs.splice(i, 1); continue; }
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot);
        if (q.spark) { if (okK) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = q.life; ctx.drawImage(SPRITES.fx_sparks, -q.r, -q.r, q.r * 2, q.r * 2); } }
        else if (okS) { const r = q.r * (1 + (1 - q.life) * 1.4); ctx.globalAlpha = q.life * 0.5; ctx.drawImage(SPRITES.fx_smoke, -r, -r, r * 2, r * 2); }
        ctx.restore();
    }
    ctx.globalAlpha = 1;
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

    // 第21弾: 大きな爆発 (艦の撃沈) は衝撃波の絵を重ねる
    if (size >= 20 && spriteReady(SPRITES.fx_shockwave)) effects.push({ type: 'fx-sprite', x, y, img: SPRITES.fx_shockwave, r: size * 2.2, life: 1.0, decay: 0.03 });
    // Debris (第21弾: 半分は破片の絵)
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
            color: color, img: i % 2 ? SPRITES['fx_debris_' + (i % 6)] : null
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
            ctx.textAlign = 'center';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; // 第21弾: shadowBlur の代わりに縁取り (モバイル規則)
            ctx.strokeText(ef.text, ef.x, ef.y);
            ctx.fillText(ef.text, ef.x, ef.y);
            ctx.restore();
            ctx.globalAlpha = 1;
            if (ef.life <= 0) effects.splice(i, 1);
        } else if (ef.type === 'pdtracer') {
            // 第28弾: 実弾の迎撃の曳光 (艦→ミサイル)
            ef.life -= 1;
            if (ef.life <= 0) { effects.splice(i, 1); continue; }
            ctx.globalAlpha = ef.life / 10; ctx.strokeStyle = ef.c; ctx.lineWidth = 2 / camera.zoom;
            ctx.setLineDash([10 / camera.zoom, 14 / camera.zoom]);
            ctx.beginPath(); ctx.moveTo(ef.x, ef.y); ctx.lineTo(ef.x2, ef.y2); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1;
        } else if (ef.type === 'beam') {
            continue; // 第22弾: ビームは霧の上に描く (updateDrawBeams)。旧: 霧の下で、視界の外のビームは見えなかった
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
// 第22弾: ビームは霧の上に描く — 強い光の筋は霧越しでも見える (旧: 霧の下に描いていて、視界の外から撃たれたビームが見えなかった)
function updateDrawBeams(ctx) {
    for (let i = effects.length - 1; i >= 0; i--) {
        const ef = effects[i];
        if (ef.type !== 'beam') continue;
        // 第22弾: ビームは6秒残す (最初の1.2秒は最大の明るさ → 消えるまで薄れる)。旧: 約0.4秒で消え、何を撃たれたか分からなかった
        const _now = performance.now();
        if (ef.born === undefined) ef.born = _now;
        const _age = (_now - ef.born) / 1000;
        if (_age >= BEAM_FX_SEC) { effects.splice(i, 1); continue; }
        ef.a = _age < 1.2 ? 1 : 1 - (_age - 1.2) / (BEAM_FX_SEC - 1.2);
        const _bdx = ef.tx - ef.x, _bdy = ef.ty - ef.y;
        const _bAng = Math.atan2(_bdy, _bdx);
        const _bLen = Math.hypot(_bdx, _bdy);
        ctx.save();
        ctx.translate(ef.x, ef.y);
        ctx.rotate(_bAng);
        ctx.lineCap = 'round';
        // 第21弾: Higgsfieldのビームの絵 (自機=緑 / 敵=赤) を加算で重ねる
        const _bImg = SPRITES[/^#ff/i.test(ef.c) ? 'fx_beam_enemy' : 'fx_beam_player'];
        if (spriteReady(_bImg)) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = Math.min(1, ef.a * 1.2);
            const _bw = 140 * (0.5 + ef.a * 0.5); // 第22弾: 太さ2倍
            ctx.drawImage(_bImg, 0, -_bw / 2, _bLen, _bw);
            ctx.globalCompositeOperation = 'source-over';
        }
        // 外側拡散グロウ
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(_bLen, 0);
        ctx.strokeStyle = ef.c; ctx.lineWidth = 56 * ef.a; ctx.globalAlpha = ef.a * 0.10; ctx.stroke();
        // 中間グロウ
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(_bLen, 0);
        ctx.lineWidth = 24 * ef.a; ctx.globalAlpha = ef.a * 0.35; ctx.stroke();
        // コア白線 (画面上で最低2pxは残す)
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(_bLen, 0);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(6 * ef.a, 2 / camera.zoom); ctx.globalAlpha = ef.a * 0.95; ctx.stroke();
        ctx.restore();
        // 着弾点フラッシュ
        if (ef.a > 0.65) {
            const _flashR = 40 * ef.a;
            ctx.beginPath(); ctx.arc(ef.tx, ef.ty, _flashR, 0, Math.PI * 2);
            ctx.fillStyle = ef.c; ctx.globalAlpha = ef.a * 0.5; ctx.fill();
            ctx.beginPath(); ctx.arc(ef.tx, ef.ty, _flashR * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff'; ctx.globalAlpha = ef.a * 0.9; ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}
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
    // 第16弾: 方位を含むログは自艦リング上でその方位を点灯 (ズームアウトせずに方角が分かる)
    const _bm = /方位\s?(\d{1,3})°/.exec(text);
    if (_bm && typeof ringMarkBearing === 'function') ringMarkBearing(+_bm[1], className === 'warning-msg' ? '#ffb070' : '#ffe08a');
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

// 第20弾: ランドマークの置き場所 — 面積で一様 (外周2000uは除く)・既に置いた物から5000u以上離す
const LANDMARK_SPACING = 5000;
// 第21弾 (オーナー合意): ランダムだが一箇所に集まりすぎず、遠くまで散らばりすぎない —
// 中心から半径24500u (マップの7割) 以内・面積で一様。種類ごとに6方向 (60°ずつ) へ順に割り振る (同じ方向に偏らない)。
// 間隔: コロニー・補給所・難破船は互いに5000u以上 / ノードは互いに3000u以上・他のランドマークから2000u以上
const LANDMARK_R = 24500, LANDMARK_MIN_R = 3000, NODE_SPACING = 3000, NODE_TO_LM = 2000;
function randomLandmarkSpot(placed, sector, minSp = LANDMARK_SPACING, others = null, otherSp = 0) {
    let p = null;
    for (let tries = 0; tries < 120; tries++) {
        const a = sector === undefined ? Math.random() * Math.PI * 2 : (sector + Math.random()) * (Math.PI / 3);
        const r = Math.sqrt(LANDMARK_MIN_R * LANDMARK_MIN_R / (LANDMARK_R * LANDMARK_R) + Math.random() * (1 - LANDMARK_MIN_R * LANDMARK_MIN_R / (LANDMARK_R * LANDMARK_R))) * LANDMARK_R;
        p = { x: MAP_CX + Math.cos(a) * r, y: MAP_CY + Math.sin(a) * r };
        if (placed.every(q => Math.hypot(q.x - p.x, q.y - p.y) >= minSp) && (!others || others.every(q => Math.hypot(q.x - p.x, q.y - p.y) >= otherSp))) break;
    }
    placed.push(p);
    return p;
}
// 6方向を種類ごとにばらばらの順で使う
function _sectorOrder() { const o = [0, 1, 2, 3, 4, 5]; for (let i = 5; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; }
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
    lockedSignalId = null; _contactLabels = {}; _contactLabelNext = 1; _signalAnalysis = {};
    for (const k in _passiveLastSeen) delete _passiveLastSeen[k];
    player = new Ship(MAP_CX, MAP_CY, true);
    player.generatorOutput = genAlloc.engine;
    enemies = []; structures = []; projectiles = []; effects = []; damagePuffs = []; particles = []; debris = []; scrapDrops = [];
    stations = []; playerIntel = null; higgsWakes = []; heatTrails = []; opticTrails = []; emTrails = [];
    wakeRibbons = [];
    { const ca = Math.random() * Math.PI * 2, cm = 0.08 + Math.random() * 0.08; higgsCurrent = { x: Math.cos(ca) * cm, y: Math.sin(ca) * cm }; }
    resourceNodes = []; decoys = []; playerDrones = []; droneOrders = {};
    // 第32弾: スカーミッシュは結果を持ち越さない — ドックの強化(Lv)は毎試合 初期値へ。艦の強化は試合中に拾う部品で
    gameState.upgrades = { engine: 1, weapons: 1, armor: 1, sensor: 1 };
    resetParts();
    resetCargo(); // 第16弾: 出撃のたびに積み込み計画どおりに積む

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
    bgMistCanvas = null; higgsOverlayCanvas = null;
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

    // 第21弾: ヒッグス濃度は円の集まり (bgMist) ではなくマス目 (細かく・まばら)。bgMist は空のまま
    generateHiggsGrid();
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
        const scale = 768 / FIELD_SIZE; // 地形 (岩礁・嵐・熱雲) の焼き込みは768px
        // 第21弾: 濃度のマス目を1マス1画素で焼く (700×700)。色は旧と同じ段階 (薄い=紺→濃い=紫)
        bgMistCanvas = _bakeHiggsGrid(false);
        higgsOverlayCanvas = _bakeHiggsOverlay();
        // ヒッグス雲(白) — 視野内で「下から見上げた雲」として 'lighter' 合成する用 (濃いほど白い)
        higgsCloudCanvas = _bakeHiggsGrid(true);

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
    // 第20弾: 敵の耐久は自機の同じ艦種とそろえる (攻撃型3500/潜航型700/空母型2500)。セクターごとに+10% (オーナー合意)
    const _bossHp = { destroyer: 3500, corvette: 700, carrier: 2500 };
    boss.maxHp = Math.round((_bossHp[boss.type] || 2000) * (1 + 0.1 * (gameState.sector - 1)));
    boss.hp = boss.maxHp;
    // 第20弾: 敵も自機の同じ艦種の既定の積み方と同じ弾数 (攻撃型 実弾144斉射・ミサイル12 / 潜航型 48・6 / 空母型 48・9)
    { const _es = { destroyer: 'assault', corvette: 'stealth', carrier: 'carrier' }[boss.type] || 'assault';
      // 第22弾: COM対戦では設定画面の「敵の積み込み」を使う (無ければ同じ艦種の既定)
      const _comLo = comDemo && comCfg && comCfg.lo && comCfg.lo.e && comCfg.lo.e[_es];
      const lo = _comLo || DEFAULT_LOADOUT[_es];
      boss._fullK = (lo.ammoK || 0) * AMMO_PER_SLOT.kinetic; boss._fullM = (lo.ammoM || 0) * AMMO_PER_SLOT.missile;
      boss.ammoK = boss._fullK; boss.ammoM = boss._fullM; boss._kMag = KINETIC_MAG;
      // 第22弾: 離脱の消耗品も積み込みどおり (旧: 敵は使わなかった)。空母の艦載機の数は COM対戦では積み込みの戦闘機の数
      boss.itemFlash = lo.flash || 0; boss.itemNoise = lo.noise || 0; boss.itemSmoke = lo.smoke || 0; boss.itemRepair = lo.repair || 0; boss._kitT = 0;
      boss._eLo = _comLo ? { fsos: lo.fsos, lure: lo.lure, attack: lo.attack } : null; }
    boss.lurking = true;
    enemies.push(boss);
    // 第19弾: COM対戦デモ — 敵の性格を設定どおりに (ランダムは試合ごとに艦種の範囲で振る)。自機COMの性格も試合ごとに決め直す
    if (comDemo && comCfg) {
        boss.personality = comPersonalityFor('e');
        _com = comNewMemo(); _thinkLast = {};
        const _tl = document.getElementById('think-log'); if (_tl) _tl.textContent = '';
        const _th = document.getElementById('think-who');
        if (_th) _th.textContent = '自機COM ' + SHIP_JP[comCfg.ship] + ' [' + persLabel(_com.pp) + ']  vs  敵COM ' + SHIP_JP[comCfg.enemy] + ' [' + persLabel(boss.personality) + ']';
    }
    // 第21弾: 敵のエンジン (性格で選ぶ。速さはエンジンの倍率) / 自機のエンジン切替をリセット
    boss.engine = pickEnemyEngine(boss.personality);
    boss.lureSOS = 1; boss.lureShip = 1; // 第21弾: 敵の囮 (各1個 — 実装で決めた数)
    if (boss._eLo) { boss.lureSOS = boss._eLo.fsos || 0; boss.lureShip = boss._eLo.lure || 0; if (boss.type === 'carrier') boss.droneStock = boss._eLo.attack || 0; } // 第22弾: COM対戦で敵の積み込みを編集した時だけ
    boss.upgSpeed = (ENGINE_TYPES[boss.engine] || ENGINE_TYPES.thermonuclear).speedMult;
    engineSwitchT = 0; engineSwitchTo = null; _engCoast = false; _syncEngineUI();
    // 第20弾: 開戦時の司令部情報は撤去 (オーナー指示「開始と同時に敵の方角が分かるのはいらない」・双方なくす)。
    // 互いに手掛かりなしで始め、聴いて・動いて見つける (第13弾で入れた intelBearing / boss.intelPos)
    intelBearing = null;
    boss.intelPos = null;
    // S&Dモード: コロニーノードを多く配置 (ハック目標)
    const colonyCount = COLONY_COUNT[gameState.mode] || COLONY_COUNT.br; // 第24弾: 3/5 → 8/8 (接触を増やす)
    // 第21弾: ランドマークは半径24500u以内・6方向に順に割り振る・間隔あり (randomLandmarkSpot)。難破船も最初から海図に載る
    const _lmPlaced = [];
    let _so = _sectorOrder();
    for (let i = 0; i < colonyCount; i++) {
        const lp = randomLandmarkSpot(_lmPlaced, _so[i % 6]);
        const col = new Structure(lp.x, lp.y, 'colony');
        col.discovered = true; // 第15弾: コロニーは海図に載っている既知物 (信号として追跡して確かめる対象ではない)
        structures.push(col);
    }
    _so = _sectorOrder();
    for (let i = 0; i < 5; i++) {
        const lp = randomLandmarkSpot(_lmPlaced, _so[i % 6]);
        const der = new Structure(lp.x, lp.y, 'derelict');
        der.discovered = true; // 第21弾 (オーナー指示): 難破船も初期配置で海図に載る (旧: 視界に入るまで出なかった)
        structures.push(der);
    }
    _so = _sectorOrder();
    for (let i = 0; i < 3; i++) {
        const lp = randomLandmarkSpot(_lmPlaced, _so[i % 6]);
        // 第23弾: 補給所は廃止 (補給と修理はコロニー)
    }

    // リソースノード: 5〜8個。第21弾: 6方向へ順に・互いに3000u以上・他のランドマークから2000u以上
    // (旧: 6割を自機と敵の間の帯に置いていた → 一箇所に固まっていた)
    const nodeCount = 5 + Math.floor(Math.random() * 4);
    const _nodePlaced = [];
    _so = _sectorOrder();
    for (let i = 0; i < nodeCount; i++) {
        const spot = randomLandmarkSpot(_nodePlaced, _so[i % 6], NODE_SPACING, _lmPlaced, NODE_TO_LM);
        resourceNodes.push({ x: spot.x, y: spot.y, active: true, emFlashTimer: 0, identified: false, owner: null, capP: 0 });
    }

    // 新システムのリセット (露出度・ヒッグスサージ・静粛航行・遭難信号)
    playerExposureLevel = 0; _exposureHeartbeatTimer = 0;
    surgePhase = 'none'; surgePhaseTimer = 0;
    surgeNextTimer = SURGE_INTERVAL_MIN + Math.floor(Math.random() * SURGE_INTERVAL_VAR);
    _logDedup = {};
    setStance('cruise', true);
    distressBeacon = null;
    distressNextTimer = 4200 + Math.floor(Math.random() * 1800);
    isBottomed = false; nearMissActive = false; _commsInterceptCD = 0;
    lures = []; pendingLure = null; // 第21弾
    generateFieldSignals(); sigZones = []; // 第31弾
    noiseMakers = []; smokeClouds = []; playerCoasting = false; boostT = 0; boostCD = 0; _flashScreen = 0; _xoEsc = null; // 第17弾
    huntStats = { startFrame: _frameCount, firstContact: -1, ambushes: 0, crits: 0, timesEngaged: 0, dmgDealt: 0, dmgTaken: 0, pings: 0 };
    matchRecStart(); // 第22弾: 試合の記録
    playerHitDirs = []; playerHitLog = []; // 第22弾: 被弾の記録もセクターごとに
    combatMode = { mode: 'manual', range: 'auto', prio: 'attack' }; _cbVis = null; // 第22弾: 戦闘モードは手動から
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
    if (sdText) sdText.textContent = `コロニー: 0/${COLONY_COUNT[gameState.mode] || COLONY_COUNT.br}`;

    centerCameraOnPlayer();

    // Add delay to ensure canvas is sized before centering camera again
    setTimeout(() => {
        centerCameraOnPlayer();
    }, 100);


    const shipLabel = { assault: '攻撃型', stealth: '潜航型', carrier: '空母型' };
    logMessage(`SYSTEM: ワープ完了。セクター ${gameState.sector} に到着しました [${shipLabel[gameState.shipType] || '不明'}]。環境マッピング中...`, 'system-msg');
}

// 第19弾: ヒッグス表示のオン・オフ (旧DEMOモードを置き換え。見た目だけで、探知・ロック・COMの判断には影響しない)
function toggleHiggsView(off) {
    higgsViewOff = off === undefined ? !higgsViewOff : !!off;
    const btn = document.getElementById('btn-higgs-view');
    if (btn) {
        btn.textContent = higgsViewOff ? 'ヒッグス表示: OFF' : 'ヒッグス表示: ON';
        btn.classList.toggle('btn-warn-on', higgsViewOff);
    }
    if (comCfg) comCfg.higgsView = !higgsViewOff;
    logMessage(higgsViewOff ? 'VIEW: ヒッグス表示OFF — 霧を外して全艦を表示 (見た目だけ。艦の探知・判断は変わらない)' : 'VIEW: ヒッグス表示ON', 'system-msg');
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
    // 第16弾: 搭載物ボタンは「その艦が積める種類」だけ表示 (空母=全種 / 攻撃型=戦闘機・砲台 / 潜航型=デコイ・哨戒機)
    document.querySelectorAll('.drone-btn').forEach(b => { b.style.display = (SHIP_DRONES[shipType] || []).includes(b.dataset.dtype) ? '' : 'none'; });
    // 全艦種共通ボタン (ミサイルモード・修復) — ゲーム開始後に表示
    document.querySelectorAll('.common-btn').forEach(b => { b.style.display = ''; });
    // 右列の2番目: 潜航型=電子戦 (ジャミング+デコイ・哨戒機) / 攻撃型・空母型=搭載 (ドローン・砲台・人型+ハック)
    { const ew = document.getElementById('abar-grp-ew'), dr = document.getElementById('abar-grp-drone');
      if (ew) ew.style.display = shipType === 'stealth' ? '' : 'none';
      if (dr) dr.style.display = shipType === 'stealth' ? 'none' : ''; }
    document.body.classList.add('in-game');
    if (window.matchMedia('(pointer: coarse)').matches) requestLandscape(); // 出撃タップ(ユーザー操作)の中で要求する必要がある
    _syncOrientPause();
    resizeCanvas(); // HUD表示後にミニマップの実寸を測り直す
    cameraFollowPlayer = true; updateCameraFollowBtn();
    setSensor(currentSensor, true);
    _xoState = null;
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
    let _briefed = false;
    try { _briefed = localStorage.getItem('darkEchoBriefed') === '1'; } catch (e) {}
    if (!_briefed && !comDemo) showBriefing();
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
// ═══ 第16弾: 積み込み画面 (ロビーの艦カード / ドックから) ═══
const SHIP_JP = { assault: '攻撃型', stealth: '潜航型', carrier: '空母型' };
let _loEdit = null; // { ship, lo, fromDock }
function loadoutSummary(ship) {
    const lo = shipLoadout(ship);
    const parts = ['実弾' + lo.ammoK * AMMO_PER_SLOT.kinetic, 'ミサイル' + lo.ammoM * AMMO_PER_SLOT.missile]; // 第20弾
    for (const t of SHIP_DRONES[ship] || []) if (lo[t]) parts.push(DRONE_SPEC[t].label + lo[t]);
    if (lo.mat) parts.push('資材' + lo.mat * MAT_PER_SLOT + '個');
    return '積載' + HOLD_CAP[ship] + '枠: ' + (parts.join('・') || '空');
}
function refreshLoadoutSummaries() {
    document.querySelectorAll('.ship-cargo').forEach(el => { el.textContent = loadoutSummary(el.dataset.type); });
    const ds = document.getElementById('dock-cargo-sum');
    if (ds && player) ds.textContent = ' 今の積み荷: ' + cargoSummaryNow();
}
function cargoSummaryNow() {
    const parts = ['実弾' + cargo.ammoK, 'ミサイル' + cargo.ammoM]; // 第20弾
    for (const t of SHIP_DRONES[gameState.shipType] || []) if (cargo.stock[t]) parts.push(DRONE_SPEC[t].label + cargo.stock[t]);
    parts.push('資材' + cargo.mat + '個');
    return parts.join('・');
}
// 第22弾: 敵COMが使える搭載物 (それ以外は積んでも使わないので敵の積み込みには出さない)
const ENEMY_USES = ['flash', 'noise', 'smoke', 'fsos', 'lure', 'repair'];
function comLoadout(side, ship) {
    const st = comCfg && comCfg.lo && comCfg.lo[side] && comCfg.lo[side][ship];
    const lo = Object.assign({ mat: 0 }, st || DEFAULT_LOADOUT[ship]);
    if (side === 'e') { // 敵が使わない物 (資材・設置物・人型など) は外す — 枠を空けて弾や消耗品に回せるように
        lo.mat = 0;
        for (const t of SHIP_DRONES[ship] || []) if (!(ENEMY_USES.includes(t) || (t === 'attack' && ship === 'carrier'))) lo[t] = 0;
    }
    return lo;
}
function loSummary(lo, ship, enemySide) {
    const parts = ['実弾' + (lo.ammoK || 0), 'ミサイル' + (lo.ammoM || 0)];
    for (const t of SHIP_DRONES[ship] || []) if (lo[t] && (!enemySide || ENEMY_USES.includes(t) || (t === 'attack' && ship === 'carrier'))) parts.push(DRONE_SPEC[t].label + lo[t]);
    if (!enemySide && lo.mat) parts.push('資材' + lo.mat);
    return parts.join('・') + ' (' + loadoutSlots(lo, ship) + '/' + HOLD_CAP[ship] + '枠)';
}
function openLoadout(ship, fromDock, comSide) {
    _loEdit = { ship, lo: comSide ? comLoadout(comSide, ship) : shipLoadout(ship), fromDock: !!fromDock, comSide: comSide || null };
    document.getElementById('lo-ship').textContent = (comSide ? (comSide === 'p' ? 'COM対戦 自機: ' : 'COM対戦 敵: ') : '') + SHIP_JP[ship] + ' — 積載' + HOLD_CAP[ship] + '枠';
    _renderLoadout();
    document.getElementById('loadout-overlay').classList.remove('hidden');
    playSound('ui');
}
function _renderLoadout() {
    const e = _loEdit; if (!e) return;
    const cap = HOLD_CAP[e.ship], used = loadoutSlots(e.lo, e.ship);
    const rows = [];
    // 第20弾: 弾も同じ枠 (1枠=実弾48斉射 / ミサイル3発)
    for (const [k, lbl, per] of [['ammoK', '実弾', AMMO_PER_SLOT.kinetic + '斉射'], ['ammoM', 'ミサイル', AMMO_PER_SLOT.missile + '発']]) {
        rows.push('<div class="lo-row lo-ammo"><span class="lo-name">' + lbl + '<small>1枠=' + per + ' — 計' + (e.lo[k] || 0) * AMMO_PER_SLOT[k === 'ammoK' ? 'kinetic' : 'missile'] + '</small></span>'
            + '<button data-k="' + k + '" data-d="-1"' + (e.lo[k] > 0 ? '' : ' disabled') + '>−</button><b>' + (e.lo[k] || 0) + '</b>'
            + '<button data-k="' + k + '" data-d="1"' + (used + 1 <= cap ? '' : ' disabled') + '>＋</button></div>');
    }
    const _eSide = e.comSide === 'e';
    for (const t of SHIP_DRONES[e.ship]) {
        if (_eSide && !(ENEMY_USES.includes(t) || (t === 'attack' && e.ship === 'carrier'))) continue; // 敵が使わない物は出さない
        const sp = DRONE_SPEC[t];
        rows.push('<div class="lo-row"><span class="lo-name">' + sp.label + '<small>' + sp.w + '枠' + (sp.placed ? '・設置' : sp.item ? '・使い切り' : '') + '</small></span>'
            + '<button data-k="' + t + '" data-d="-1"' + (e.lo[t] > 0 ? '' : ' disabled') + '>−</button><b>' + (e.lo[t] || 0) + '</b>'
            + '<button data-k="' + t + '" data-d="1"' + (used + sp.w <= cap ? '' : ' disabled') + '>＋</button></div>');
    }
    const matHint = SHIP_DRONES[e.ship].map(t => DRONE_SPEC[t].label + DRONE_SPEC[t].mat + '個').join('・');
    if (_eSide) rows.push('<div class="lo-row lo-note">敵が使う物だけ: 弾・' + (e.ship === 'carrier' ? '戦闘機 (艦載機)・' : '') + '閃光弾・ノイズ・煙幕 (退く時)・偽SOS・偽艦影ブイ。資材の組み立てはしない</div>');
    else rows.push('<div class="lo-row lo-mat"><span class="lo-name">資材<small>1枠=' + MAT_PER_SLOT + '個 — ' + matHint + 'で組み立て</small></span>'
        + '<button data-k="mat" data-d="-1"' + (e.lo.mat > 0 ? '' : ' disabled') + '>−</button><b>' + e.lo.mat + '</b>'
        + '<button data-k="mat" data-d="1"' + (used + 1 <= cap ? '' : ' disabled') + '>＋</button></div>');
    const box = document.getElementById('lo-rows');
    box.innerHTML = rows.join('');
    document.getElementById('lo-cap-fill').style.width = Math.round(used / cap * 100) + '%';
    document.getElementById('lo-cap-text').textContent = used + '/' + cap + '枠';
}
(() => {
    const ov = document.getElementById('loadout-overlay');
    if (!ov) return;
    document.getElementById('lo-rows').addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-k]');
        if (!b || b.disabled || !_loEdit) return;
        const k = b.dataset.k, d = +b.dataset.d;
        const lo = _loEdit.lo, cap = HOLD_CAP[_loEdit.ship];
        const w = (k === 'mat' || k === 'ammoK' || k === 'ammoM') ? 1 : DRONE_SPEC[k].w;
        if (d > 0 && loadoutSlots(lo, _loEdit.ship) + w > cap) return;
        lo[k] = Math.max(0, (lo[k] || 0) + d);
        _renderLoadout();
        playSound('ui');
    });
    document.getElementById('lo-default').addEventListener('click', () => {
        if (!_loEdit) return;
        if (_loEdit.comSide) { const keep = comCfg.lo[_loEdit.comSide][_loEdit.ship]; delete comCfg.lo[_loEdit.comSide][_loEdit.ship]; _loEdit.lo = comLoadout(_loEdit.comSide, _loEdit.ship); if (keep) comCfg.lo[_loEdit.comSide][_loEdit.ship] = keep; _renderLoadout(); return; }
        _loEdit.lo = Object.assign({ mat: 0 }, DEFAULT_LOADOUT[_loEdit.ship]);
        _renderLoadout();
    });
    document.getElementById('lo-ok').addEventListener('click', () => {
        if (!_loEdit) return;
        if (_loEdit.comSide) { // 第22弾: COM対戦の積み込み (自機/敵) — 設定画面に戻る
            if (comCfg) { if (!comCfg.lo) comCfg.lo = { p: {}, e: {} }; comCfg.lo[_loEdit.comSide][_loEdit.ship] = Object.assign({}, _loEdit.lo); saveComCfg(); _renderComCfg(); }
            _loEdit = null; ov.classList.add('hidden'); playSound('ui'); return;
        }
        if (!gameState.loadout) gameState.loadout = {};
        gameState.loadout[_loEdit.ship] = Object.assign({}, _loEdit.lo);
        try { localStorage.setItem('darkEchoSave', JSON.stringify(gameState)); } catch (e) {}
        // ドックで変更した場合はその場で積み替える
        if (_loEdit.fromDock && player && _loEdit.ship === gameState.shipType) {
            resetCargo();
            logMessage('補給: 積み込み計画を変更して積み替えた — ' + cargoSummaryNow(), 'system-msg');
        }
        _loEdit = null;
        ov.classList.add('hidden');
        refreshLoadoutSummaries();
        playSound('ui');
    });
    document.querySelectorAll('.loadout-btn').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); openLoadout(b.dataset.type, false); }));
    document.getElementById('btn-dock-loadout')?.addEventListener('click', () => openLoadout(gameState.shipType, true));
    refreshLoadoutSummaries();
})();


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

// 第15弾: GEN配分の「重点」プリセット — 8本のスライダーを毎回触らなくても、意図(何に力を割くか)で1タップ
const GEN_FOCUS = {
    balance: { engine: 40, weapons: 30, sensors: 30, prec: { sensor: 34, weapon: 33, engine: 33 } },
    engine:  { engine: 60, weapons: 20, sensors: 20, prec: { sensor: 20, weapon: 20, engine: 60 } },
    sensor:  { engine: 25, weapons: 20, sensors: 55, prec: { sensor: 60, weapon: 20, engine: 20 } },
    weapon:  { engine: 25, weapons: 55, sensors: 20, prec: { sensor: 20, weapon: 60, engine: 20 } },
};
function setGenFocus(key) {
    const f = GEN_FOCUS[key];
    if (!f) return;
    for (const k of GEN_KEYS) {
        genAlloc[k] = f[k];
        const el = document.getElementById(`gen-${k}`), v = document.getElementById(`gen-${k}-val`);
        if (el) el.value = f[k];
        if (v) v.textContent = f[k] + '%';
    }
    for (const k of ['sensor', 'weapon', 'engine']) {
        aiPrecision[k] = f.prec[k];
        const el = document.getElementById(`aiprec-${k}`), v = document.getElementById(`aiprec-${k}-val`);
        if (el) el.value = f.prec[k];
        if (v) v.textContent = f.prec[k] + '%';
    }
    updateGenTotal();
    document.querySelectorAll('.gd-focus-btn, .focus-btn').forEach(b => b.classList.toggle('active', b.dataset.focus === key));
    playSound('ui');
}
document.querySelectorAll('.gd-focus-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); setGenFocus(b.dataset.focus); }));

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
// ── 搭載物の展開ボタン (第16弾: 全艦種。data-dtype の種類を展開/組み立て) ──
document.querySelectorAll('.drone-btn').forEach(b => b.addEventListener('click', () => deployDrone(b.dataset.dtype)));

// ── §3-10 ミサイルモード切替 ──
function setMissileMode(m, quiet) {
    missileMode = m === 'smart' ? 'smart' : 'homing';
    const lbl = document.getElementById('missile-mode-label');
    if (lbl) lbl.textContent = missileMode === 'smart' ? 'MSL:AI' : 'MSL:HON';
    const btn = document.getElementById('btn-missile-mode');
    if (btn) { btn.style.borderColor = missileMode === 'smart' ? '#aaddff' : '#ffaa33'; btn.style.color = missileMode === 'smart' ? '#aaddff' : '#ffcc66'; }
    if (!quiet) { logMessage(`WEP: ミサイルモード → ${missileMode === 'smart' ? 'AI追跡型 (EM強・ジャミング耐性・大閃光)' : '熱源誘導型 (デコイ妨害可)'}`, 'system-msg'); playSound('ui'); }
    if (typeof window.syncWeaponUI === 'function') window.syncWeaponUI();
}
document.getElementById('btn-missile-mode')?.addEventListener('click', () => setMissileMode(missileMode === 'homing' ? 'smart' : 'homing'));

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

document.getElementById('weapon-select')?.addEventListener('change', e => {
    _curWeapon = e.target.value || 'kinetic';
    player && (player._fireOrder = null); // 武器を変えたら出しかけの射撃命令は取り消す
});
// 第21弾 (オーナー合意): エンジンは戦闘中も切り替えられるが、切替に10秒かかる (その間は推力ゼロ・EMが漏れる)
const ENGINE_JP = { thermonuclear: '熱核エンジン', pulse: 'パルスエンジン', higgs: 'ヒッグスエンジン', photon: 'フォトンエンジン' };
const ENGINE_SWITCH_TIME = 600, ENGINE_SWITCH_EM = 0.30; // EMの量は実装で決めた値 (制圧・補給中と同じ)
let engineSwitchT = 0, engineSwitchTo = null, _engCoast = false; // 切替中は機関停止と同じく惰性で漂う
function requestEngineSwitch(type) {
    if (!ENGINE_TYPES[type]) return;
    if (!player || player.hp <= 0) { gameState.engineType = type; _syncEngineUI(); return; } // 出撃前はすぐ
    if (type === (engineSwitchT > 0 ? engineSwitchTo : gameState.engineType)) return;
    if (type === gameState.engineType && engineSwitchT > 0) { engineSwitchT = 0; engineSwitchTo = null; _endEngCoast(); logMessage('ENG: 切替を取りやめ — ' + ENGINE_JP[type] + 'のまま', 'system-msg'); _syncEngineUI(); return; }
    engineSwitchTo = type; engineSwitchT = ENGINE_SWITCH_TIME;
    if (!playerCoasting) { if (boostT > 0) boostT = 0; playerCoasting = true; player._coastAng = player.angle; _engCoast = true; _updateEscapeBtns(); }
    logMessage('ENG: ' + ENGINE_JP[type] + 'へ切替開始 — 10秒は推力ゼロ (惰性) でEMが漏れる', 'warning-msg');
    playSound('ui');
    _syncEngineUI();
}
function updateEngineSwitch() {
    if (engineSwitchT <= 0) return;
    if (engineSwitchT % 60 === 0) _syncEngineUI(); // 残り秒の表示
    if ((engineSwitchT -= gameSpeedFactor) <= 0) {
        engineSwitchT = 0;
        gameState.engineType = engineSwitchTo; engineSwitchTo = null;
        _endEngCoast();
        logMessage('ENG: ' + ENGINE_JP[gameState.engineType] + 'に切替完了 — 再点火', 'system-msg');
        _syncEngineUI();
    }
}
function _endEngCoast() { if (_engCoast) { _engCoast = false; playerCoasting = false; _updateEscapeBtns(); } }
function _syncEngineUI() {
    const cur = engineSwitchT > 0 ? engineSwitchTo : gameState.engineType;
    document.querySelectorAll('#engine-icon-group .isel-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.val === cur);
        b.classList.toggle('switching', engineSwitchT > 0 && b.dataset.val === engineSwitchTo);
    });
    const sel = document.getElementById('engine-type-select'); if (sel) sel.value = cur;
    // 第22弾: 右列の「機関」
    document.querySelectorAll('.eng-btn').forEach(b => { b.classList.toggle('active', b.dataset.eng === cur); b.classList.toggle('switching', engineSwitchT > 0 && b.dataset.eng === engineSwitchTo); });
    const lb = document.getElementById('abar-engine-label');
    if (lb) lb.textContent = engineSwitchT > 0 ? '切替' + Math.ceil(engineSwitchT / 60) + 's' : (ENGINE_JP[cur] || '').replace('エンジン', '');
}
document.querySelectorAll('.eng-btn').forEach(b => b.addEventListener('click', () => requestEngineSwitch(b.dataset.eng)));
document.querySelectorAll('#combat-bar .cb-grp button').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); setCombatMode(b.parentElement.dataset.k, b.dataset.v); }));
document.querySelectorAll('.focus-btn').forEach(b => b.addEventListener('click', () => setGenFocus(b.dataset.focus)));
document.getElementById('engine-type-select')?.addEventListener('change', e => { requestEngineSwitch(e.target.value); });

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
        // 第16弾: コロニーは近くに留まってハックする (下の旧処理は通らない)
        logMessage(closest.hacked ? 'EW[コロニー]: ハック済み' : `EW[コロニー]: コロニーの${COLONY_HACK_R}u以内に${Math.round(COLONY_HACK_TIME / 60)}秒留まるとハックできる (EMが漏れる)`, 'system-msg');
        return;
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
// センサー(受信帯域)の同調。デスクトップのアイコン群・モバイルのGCB・バンドチューナーの全UIをここで同期する
function setSensor(s, quiet) { // 第21弾: その帯域をONにする (他は切らない)
    if (!sensorConfig[s]) return;
    if (!sensorsOn[s]) toggleBand(s, quiet); else _syncBandUI();
}
// 第21弾: 帯域の ON/OFF (最低1本はON)
function toggleBand(s, quiet) {
    if (!sensorConfig[s]) return;
    if (sensorsOn[s]) {
        if (sensorOrder.length <= 1) { if (!quiet) logMessage('SENSOR: 最低1帯域は聴いておく', 'system-msg'); return; }
        sensorsOn[s] = false; sensorOrder = sensorOrder.filter(b => b !== s);
    } else { sensorsOn[s] = true; sensorOrder.push(s); }
    currentSensor = sensorOrder[0];
    _syncBandUI();
    if (!quiet) {
        const leak = sensorOrder.slice(1).map(b => BAND_JP[b] || b).join('・');
        logMessage(`SENSOR: ${SENSOR_INFO[s].name} ${sensorsOn[s] ? 'ON' : 'OFF'} — 聴いている帯域 ${sensorOrder.length}本` + (leak ? ` (漏れる: ${leak})` : ' (漏れなし)'), 'system-msg');
        playSound('ui');
    }
}
function _syncBandUI() {
    document.querySelectorAll('.sns-btn').forEach(b => b.classList.toggle('active', sensorsOn[(b.id || '').replace('sensor-', '')]));
    if (typeof window.applySensorGcb === 'function') window.applySensorGcb(currentSensor);
    document.querySelectorAll('.band-btn').forEach(b => {
        const on = !!sensorsOn[b.dataset.band];
        b.classList.toggle('tuned', on);
        b.classList.toggle('off', !on);
        b.classList.toggle('leak', on && sensorOrder.indexOf(b.dataset.band) > 0);
    });
}
// 第21弾: 敵が聴いている帯域 — 性格で本数 (攻撃的・隠れない個体ほど多く聴いて漏らす)。順は 熱→EM→ヒッグス→光学
const ENEMY_BAND_ORDER = ['heat', 'em', 'higgs', 'optic'];
function enemyBands(e) {
    const p = e.personality || { aggression: 0.5, stealth: 0.4 };
    const n = Math.max(1, Math.min(4, 1 + Math.round(p.aggression * 2 + (1 - p.stealth))));
    return ENEMY_BAND_ORDER.slice(0, n);
}
// 第21弾: 敵のエンジン — 性格で選ぶ (隠密=ヒッグス / 攻撃的=フォトン / 貪欲=パルス / それ以外=熱核)
function pickEnemyEngine(p) {
    if (!p) return 'thermonuclear';
    if (p.stealth >= 0.7) return 'higgs';
    if (p.aggression >= 0.7) return 'photon';
    if (p.greed >= 0.7) return 'pulse';
    return 'thermonuclear';
}
// 自艦が帯域で漏らす量 (2本目以降)
function sensorLeak(kind) { return sensorsOn[kind] && sensorOrder.indexOf(kind) > 0 ? SENSOR_LEAK[kind] * PM.leakMul : 0; } // 第32弾: 多帯域受信機
['heat', 'optic', 'em', 'higgs'].forEach(s => {
    const btn = document.getElementById(`sensor-${s}`);
    if (!btn) return;
    btn.addEventListener('click', () => setSensor(s));
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
// ═══ 第15弾: パッシブ受信 = 「証拠」の収集 ═══
// 受信するのは機動する発信源だけ (敵艦・敵の艦載機)。地形/ランドマークは海図に載った既知物 = 信号にしない
// (旧: 熱雲やノードを1つずつ追跡して「ランドマークでした」と確かめる作業が狩りの大半を占めていた)。
// 方位は1回ごとに誤差を持つ「記録」として残る。推定位置はその記録の交点 (最小二乗) だけから計算する。
// ゲームは真の位置を答えとして渡さない — 方位線が交わらない・ずれる = 相手が動いた、という推理が成立する。
const TMA_KEEP   = 5400;  // 方位記録の保持 (90秒)
const TMA_TAU    = 1500;  // 新しい記録ほど重い (時定数25秒)
const TMA_MAXOBS = 24;    // 1信号あたりの記録数上限
const TMA_MERGE_D = 180;  // この距離内・4秒以内の再観測は1本にまとめて精度を上げる (止まって聴くほど方位が鋭くなる)
const TMA_MIN_BASE = 250; // 観測点の横の広がりがこれ未満なら交点は出さない (同じ場所で何度聴いても距離は分からない)
function _gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// 自艦ノイズ: 速く動くほど自分の機関音で耳が塞がる (0=停止 … 1=全速)。動く=測れるが聴こえにくい、のトレードオフ
function playerSelfNoise() {
    if (!player || player.hp <= 0) return 0;
    const cruise = shipCruiseSpeed(gameState.shipType, 100, 1) || 1;
    const f = Math.min(1.6, (player.currentSpeed || 0) / Math.max(0.1, gameSpeedFactor) / cruise);
    let n = playerCoasting ? 0 : Math.min(1, 0.9 * Math.pow(f, 1.4)); // 第17弾: 機関停止中は機関音が無い
    if ((player._beamCharge || 0) > 0) n = Math.max(n, 0.5);
    return n;
}
function shipSelfNoise(e) {
    const cruise = shipCruiseSpeed(e.type === 'carrier' ? 'carrier' : e.type === 'corvette' ? 'stealth' : 'assault', 100, 1) || 1;
    const f = Math.min(1.6, (e._spd || 0) / Math.max(0.1, gameSpeedFactor) / cruise);
    return Math.min(1, 0.9 * Math.pow(f, 1.4));
}
// 記録した方位線から推定位置を解く (方位だけの目標運動解析)。真値は一切参照しない。
// 「その点から各観測点を見た方位」と「記録した方位」の角度のずれ(÷各記録の誤差)の二乗和が最小の点を探す。
// 直線距離で解くと観測点の近くに偽の交点ができる(全ての線が自分の近くを通るため)ので、角度で評価する。
// R は「この記録から言える誤差の幅」(≈2σ, フィッシャー情報量の逆)。記録同士が矛盾する(=目標が動いた)ほど広がる。
function _angRes(px, py, o) {
    let d = Math.atan2(py - o.oy, px - o.ox) - o.ang;
    while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    return d;
}
function _fixCost(px, py, obs, now, ping, tau, misses) {
    let c = 0;
    for (const o of obs) { const r = _angRes(px, py, o) / o.sig; c += Math.exp(-(now - o.f) / tau) * r * r; }
    if (ping) c += Math.exp(-(now - ping.f) / tau) * ((px - ping.x) * (px - ping.x) + (py - ping.y) * (py - ping.y)) / (ping.r * ping.r);
    if (misses) for (const m of misses) { // 「そこには居なかった」(外れ) — 近い点ほど罰
        const d = m.x2 === undefined ? Math.hypot(px - m.x, py - m.y) : _segDist(px, py, m.x, m.y, m.x2, m.y2);
        if (d < m.r) { const k = 1 - d / m.r; c += 30 * k * k * Math.exp(-(now - m.f) / tau); }
    }
    return c;
}
function _segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
    return Math.hypot(px - x1 - dx * t, py - y1 - dy * t);
}
// 射撃が外れた: 否定の観測として記録し、推定を解き直す (同じ所を撃ち続けない — 外れから学ぶ)
function recordMiss(sid, m) {
    const sa = sid && _signalAnalysis[sid];
    if (!sa) return;
    m.f = _frameCount;
    (sa.misses || (sa.misses = [])).push(m);
    while (sa.misses.length > 4 || (sa.misses.length && _frameCount - sa.misses[0].f > TMA_KEEP)) sa.misses.shift();
    solveFix(sa);
    sa.motion = null; sa.alt = null; // 外れた = 針路の見立ても怪しい。次の方位で解き直すまで止まった仮定に戻す
    if (sa.fix) sa.fix.r = Math.max(sa.fix.r, 1200);
    const e = enemyBySid(sid);
    if (e && !e.inVision) { if (sa.fix) { e.displayX = sa.fix.x; e.displayY = sa.fix.y; e.trackR = sa.fix.r; e.contactAccuracy = Math.max(0.05, 1 - sa.fix.r / 5000); } else e.contactLife = 0; }
}
function solveFix(sa) {
    const obs = sa.obs || [];
    const now = _frameCount;
    const ping = sa.ping && now - sa.ping.f < TMA_KEEP ? sa.ping : null;
    sa.fix = null;
    if (obs.length < 2 && !ping) return;
    const prev = sa.fix0 && now - sa.fix0.f < 600 ? sa.fix0 : null; // 直近の解から詰め直す (毎回の格子探索を省く)
    let f = _solveFix(sa, obs, ping, TMA_TAU, prev);
    // 記録同士が大きく食い違う = 相手が動いている → 新しい記録だけを重く見て解き直す (動く目標に追従)
    if (f && f.chi2 > 3) { const f2 = _solveFix(sa, obs, ping, TMA_TAU * 0.35, f); if (f2) f = f2; }
    sa.fix = f;
    sa.fix0 = f ? { x: f.x, y: f.y, r: f.r, f: now } : null;
    sa.dirty = false;
    _solveMotion(sa); // 第18弾: 動いていると考えた方が記録とよく合うなら、針路と速さも解く
}
function _solveFix(sa, obs, ping, tau, warm) {
    const now = _frameCount;
    // 平均方位と、それに直交する方向への観測点の散らばり (基線)
    let cx = 0, cy = 0;
    for (const o of obs) { const r = Math.exp(-(now - o.f) / tau); cx += Math.cos(o.ang) * r; cy += Math.sin(o.ang) * r; }
    const mAng = Math.atan2(cy, cx);
    const mnx = -Math.sin(mAng), mny = Math.cos(mAng);
    let pmin = Infinity, pmax = -Infinity;
    for (const o of obs) { if (Math.exp(-(now - o.f) / tau) < 0.15) continue; const d = mnx * o.ox + mny * o.oy; if (d < pmin) pmin = d; if (d > pmax) pmax = d; }
    const base = pmax > pmin ? pmax - pmin : 0;
    sa.base = base;
    if (!ping && base < TMA_MIN_BASE) return null; // 同じ場所で何度聴いても距離は分からない
    // 粗い格子探索 (最新の観測点から、平均方位±0.6rad・距離400〜18000の対数格子)。直近の解があればそこから始める
    const L = obs.length ? obs[obs.length - 1] : { ox: player.x, oy: player.y };
    let bx = 0, by = 0, bc = Infinity;
    if (warm) { bx = warm.x; by = warm.y; bc = _fixCost(bx, by, obs, now, ping, tau, sa.misses); }
    const rMax = Math.max(6000, passiveRange() * 1.6);
    for (let i = 0; i < (warm ? 0 : 24); i++) {
        const rho = 400 * Math.pow(rMax / 400, i / 23);
        for (let j = -6; j <= 6; j++) {
            const th = mAng + j * 0.1;
            const px = L.ox + Math.cos(th) * rho, py = L.oy + Math.sin(th) * rho;
            const c = _fixCost(px, py, obs, now, ping, tau, sa.misses);
            if (c < bc) { bc = c; bx = px; by = py; }
        }
    }
    if (ping && obs.length < 2) { bx = ping.x; by = ping.y; bc = _fixCost(bx, by, obs, now, ping, tau, sa.misses); }
    // 局所の詰め (パターン探索)
    let step = warm ? Math.max(60, Math.min(warm.r || 800, 2000) * 0.5) : Math.max(60, Math.hypot(bx - L.ox, by - L.oy) * 0.08);
    for (let k = 0; k < 24 && step > 15; k++) {
        let moved = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
            const c = _fixCost(bx + dx * step, by + dy * step, obs, now, ping, tau, sa.misses);
            if (c < bc) { bc = c; bx += dx * step; by += dy * step; moved = true; break; }
        }
        if (!moved) step *= 0.5;
    }
    // フィッシャー情報量 → 誤差楕円の長軸
    let f11 = 0, f12 = 0, f22 = 0, wsum = 0, agesum = 0;
    for (const o of obs) {
        const rec = Math.exp(-(now - o.f) / tau);
        const dx = bx - o.ox, dy = by - o.oy, r2 = Math.max(1, dx * dx + dy * dy);
        const jx = -dy / r2 / o.sig, jy = dx / r2 / o.sig;
        f11 += rec * jx * jx; f12 += rec * jx * jy; f22 += rec * jy * jy; wsum += rec; agesum += rec * (now - o.f);
    }
    if (ping) { const w = Math.exp(-(now - ping.f) / tau); f11 += w / (ping.r * ping.r); f22 += w / (ping.r * ping.r); wsum += w; agesum += w * (now - ping.f); }
    const det = f11 * f22 - f12 * f12;
    if (!(det > 0)) return null;
    const cxx = f22 / det, cyy = f11 / det, cxy = -f12 / det;
    const tr = cxx + cyy, dd = cxx * cyy - cxy * cxy;
    let R = 2 * Math.sqrt(Math.max(0, tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - dd))));
    const chi2 = wsum > 0 ? bc / wsum : 0;
    if (chi2 > 1) R *= Math.sqrt(chi2); // 記録同士の食い違い = 目標が動いた → 幅を広げる
    // 記録の平均年齢ぶん相手が動けた距離を足す (動かない保証はない)。方位だけの推定は距離の1割強より細かくは言えない
    const age = wsum > 0 ? agesum / wsum / 60 : 0;
    const Ld = Math.hypot(bx - L.ox, by - L.oy);
    R = Math.max(150, Ld * 0.12, Math.hypot(R, 60 * age));
    if (R > 14000) return null;
    const cl = clampToMapCircle(bx, by, 300);
    return { x: cl.x, y: cl.y, r: R, n: obs.length, f: now, chi2 };
}

// ═══ 第18弾: 速度つきの運動解析 (オーナー合意 2026-10-25) ═══
// 方位の記録だけから「位置+針路+速さ」(等速直線) を解く。真値は一切参照しない。
// 記録が15秒・6本以上あり、動いていると考えた方が記録とよく合う (静止解の残差の6割未満) 時だけ採用する。
// 速さの見込み(事前分布)は標準60u/s。自艦が動かずに聴いた記録では速さは決まらない (見込みに引っ張られ、幅も広いまま)。
const CV_MIN_OBS = 6, CV_MIN_SPAN = 900, CV_SIGMA_V = 1.0 /* u/frame = 60u/s */, CV_VMAX = 200 / 60, CV_ACCEPT = 0.4, CV_R_FLOOR = 0.15, CV_STABLE = 3, CV_SIG = 9, CV_VMIN = 30 / 60;
function _solveMotion(sa) {
    sa.motion = null; sa.alt = null;
    const obs = sa.obs || [], fx = sa.fix, now = _frameCount;
    if (obs.length < CV_MIN_OBS || now - obs[0].f < CV_MIN_SPAN) return;
    if (!fx && (sa.base || 0) < TMA_MIN_BASE) return; // 同じ場所でしか聴いていなければ距離も速さも決まらない
    const ping = sa.ping && now - sa.ping.f < TMA_KEEP ? sa.ping : null;
    const tau = TMA_TAU, iv = 1 / (CV_SIGMA_V * CV_SIGMA_V);
    // 残差とヤコビアン (p = [x, y, vx, vy]、時刻は now 基準)
    const build = (p, wantJ) => {
        let cost = 0, wsum = 0;
        const H = wantJ ? new Float64Array(16) : null, g = wantJ ? new Float64Array(4) : null;
        const add = (r, j0, j1, j2, j3) => {
            cost += r * r;
            if (!wantJ) return;
            const J = [j0, j1, j2, j3];
            for (let a = 0; a < 4; a++) { g[a] += J[a] * r; for (let b = 0; b < 4; b++) H[a * 4 + b] += J[a] * J[b]; }
        };
        for (const o of obs) {
            const w = Math.exp(-(now - o.f) / tau), dt = o.f - now;
            const X = p[0] + p[2] * dt - o.ox, Y = p[1] + p[3] * dt - o.oy, r2 = Math.max(1, X * X + Y * Y);
            const res = _angRes(X + o.ox, Y + o.oy, o);
            // 外れ値に強く (誤差の2倍を超えるずれは重みを下げる)。方位の記録はときどき大きく外れる
            const z = Math.abs(res) / o.sig, sw = Math.sqrt(w * (z > 2 ? 2 / z : 1)) / o.sig;
            const ex = -Y / r2 * sw, ey = X / r2 * sw;
            add(res * sw, ex, ey, ex * dt, ey * dt);
            wsum += w;
        }
        if (ping) {
            const w = Math.exp(-(now - ping.f) / tau), s = Math.sqrt(w) / ping.r, dt = ping.f - now;
            add((p[0] + p[2] * dt - ping.x) * s, s, 0, s * dt, 0);
            add((p[1] + p[3] * dt - ping.y) * s, 0, s, 0, s * dt);
        }
        const obsCost = cost;
        cost += (p[2] * p[2] + p[3] * p[3]) * iv;
        if (wantJ) { H[10] += iv; H[15] += iv; g[2] += p[2] * iv; g[3] += p[3] * iv; }
        return { cost, obsCost, wsum, H, g };
    };
    // ガウス・ニュートン (レーベンバーグ・マーカート減衰)
    const gn = (p0) => {
        let p = p0, cur = build(p, true), lam = 1e-3;
        for (let it = 0; it < 20; it++) {
            const A = new Float64Array(16);
            for (let k = 0; k < 16; k++) A[k] = cur.H[k];
            for (let k = 0; k < 4; k++) A[k * 5] *= 1 + lam;
            const d = _solve4(A, [-cur.g[0], -cur.g[1], -cur.g[2], -cur.g[3]]);
            if (!d) break;
            const q = [p[0] + d[0], p[1] + d[1], p[2] + d[2], p[3] + d[3]];
            const nxt = build(q, true);
            if (nxt.cost < cur.cost) { p = q; cur = nxt; lam = Math.max(1e-6, lam * 0.3); if (Math.hypot(d[0], d[1]) < 1 && Math.hypot(d[2], d[3]) < 0.002) break; }
            else lam *= 10;
        }
        return { p, cur };
    };
    // 出発点: 前回の運動解 → 静止の交点 → (交点が無ければ) 最新の方位に沿って距離を何通りか試す
    const starts = [];
    const m0 = sa.motion0;
    if (m0 && now - m0.f < 600) { const dt = now - m0.f; starts.push([m0.x + m0.vx * dt, m0.y + m0.vy * dt, m0.vx, m0.vy]); }
    if (fx) starts.push([fx.x, fx.y, 0, 0]);
    // 方位だけの解析は「近くて遅い」と「遠くて速い」を取り違えやすい → 最新の方位に沿って距離を何通りか試し、いちばん合うものを採る
    const L = obs[obs.length - 1];
    for (const rho of [800, 1600, 3200, 6000, 10000, 15000]) starts.push([L.ox + Math.cos(L.ang) * rho, L.oy + Math.sin(L.ang) * rho, 0, 0]);
    let best = null;
    for (const s of starts) { const r = gn(s); if (!best || r.cur.cost < best.cur.cost) best = r; }
    const p = best.p, cur = best.cur;
    const speed = Math.hypot(p[2], p[3]);
    // 採用の条件: 静止の交点があれば、それより記録とよく合う (残差が6割未満) こと。
    // 交点が無い (止まった仮定では記録が矛盾する) 時は、動く仮定で記録が説明できること (1本あたりの残差が誤差の2倍以内)
    const chi2 = cur.wsum > 0 ? cur.obsCost / cur.wsum : 99;
    const st = fx ? build([fx.x, fx.y, 0, 0], false) : null;
    // 動いている仮定 (速さの見込み込み) の方が記録に合うなら、その解を控えておく → 止まった仮定の推定円をそこまで広げる (trackEstimate)。
    // 方位だけでは「止まっている」と「ゆっくり動いている」を見分けにくく、止まった仮定の円は動く目標を外しやすい
    // (計測: 20u/sで横切る目標が静止解の円に入ったのは108回中4〜8回)
    if (st && cur.cost < st.obsCost && speed <= CV_VMAX) sa.alt = { x: p[0], y: p[1], vx: p[2], vy: p[3], f: now };
    if (st && !(cur.cost < st.obsCost * CV_ACCEPT)) { sa.motion0 = null; return; }
    if (!st && chi2 > 4) { sa.motion0 = null; return; }
    if (speed > CV_VMAX) { sa.motion0 = null; return; }
    const C = _inv4(cur.H);
    if (!C) return;
    // 静止の交点がある時、運動解の「今の位置」がその幅から大きく外れるなら採らない (遠近の取り違え)
    if (fx) { const dNow = Math.hypot(p[0] - fx.x, p[1] - fx.y), dObs = Math.hypot(fx.x - L.ox, fx.y - L.oy); if (dNow > Math.max(fx.r, dObs * 0.25)) { sa.motion0 = null; return; } }
    // 速さが「誤差の3倍」よりはっきりしていて、30u/s以上でなければ動いているとは言えない (静止の解のまま)
    const vdet = C[10] * C[15] - C[11] * C[14];
    const mah = vdet > 0 ? (p[2] * p[2] * C[15] - 2 * p[2] * p[3] * C[11] + p[3] * p[3] * C[10]) / vdet : 0;
    if ((mah < CV_SIG && fx) || speed < CV_VMIN) { sa.motion0 = null; return; }
    // 針路と速さが前回の解と揃っている回数 (向き45°以内・速さ±50%以内)。4回続けて揃った時だけ射撃と矢印に使う
    // (敵は撃っては位置を変えるので、1回の解で動きを決めつけない)
    const pm = sa.motion0, sp0 = pm ? Math.hypot(pm.vx, pm.vy) : 0;
    let da = pm ? Math.abs(Math.atan2(p[3], p[2]) - Math.atan2(pm.vy, pm.vx)) : 9;
    if (da > Math.PI) da = Math.PI * 2 - da;
    const stable = pm && da < Math.PI / 4 && speed > sp0 * 0.5 && speed < sp0 * 1.5 ? (pm.stable || 0) + 1 : 0;
    sa.motion = { x: p[0], y: p[1], vx: p[2], vy: p[3], f: now, C, chi2, stable };
    sa.motion0 = sa.motion;
    if (stable < CV_STABLE) sa.motion = null; // まだ使わない (次の解の出発点としてだけ残す)
    // 止まった仮定では交点が出ない時も、運動解から「今の推定位置」を作る (射撃・表示はこれを使う)
    if (!fx && sa.motion) {
        const est = trackEstimate(sa, 0);
        if (est.r <= 14000) sa.fix = { x: est.x, y: est.y, r: est.r, n: obs.length, f: now, chi2, fromMotion: true };
        else sa.motion = null;
    }
}
// 4元連立一次方程式 (部分ピボットのガウス消去)。A は行優先の 4x4
function _solve4(A, b) {
    const M = [0, 1, 2, 3].map(i => [A[i * 4], A[i * 4 + 1], A[i * 4 + 2], A[i * 4 + 3], b[i]]);
    for (let c = 0; c < 4; c++) {
        let piv = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        if (Math.abs(M[piv][c]) < 1e-12) return null;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = 0; r < 4; r++) { if (r === c) continue; const k = M[r][c] / M[c][c]; for (let j = c; j < 5; j++) M[r][j] -= k * M[c][j]; }
    }
    return [M[0][4] / M[0][0], M[1][4] / M[1][1], M[2][4] / M[2][2], M[3][4] / M[3][3]];
}
function _inv4(H) {
    const out = new Float64Array(16);
    for (let k = 0; k < 4; k++) {
        const e = [0, 0, 0, 0]; e[k] = 1;
        const c = _solve4(H, e);
        if (!c) return null;
        for (let i = 0; i < 4; i++) out[i * 4 + k] = c[i];
    }
    return out;
}
// 推定位置を「今から ahead フレーム後」へ外挿する。運動解があれば針路と速さで進め、幅は共分散から広げる。
// 無ければ交点に留まる仮定 (幅は見込み60u/sぶん時間とともに広がる)。
function trackEstimate(sa, ahead = 0) {
    if (!sa) return null;
    const now = _frameCount, m = sa.motion;
    if (m) {
        const dt = now - m.f + ahead, C = m.C;
        const x = m.x + m.vx * dt, y = m.y + m.vy * dt;
        const pxx = C[0] + 2 * dt * C[2] + dt * dt * C[10];
        const pyy = C[5] + 2 * dt * C[7] + dt * dt * C[15];
        const pxy = C[1] + dt * (C[3] + C[6]) + dt * dt * C[11];
        const tr = pxx + pyy, det = pxx * pyy - pxy * pxy;
        let r = 2 * Math.sqrt(Math.max(0, tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)))) * Math.sqrt(Math.max(1, m.chi2));
        r = Math.max(150, Math.hypot(x - player.x, y - player.y) * Math.max(CV_R_FLOOR, anaFloorFrac(sa.ana)), r); // 等速の仮定そのものの誤差ぶん・第29弾: 解析量の下限
        return { x, y, r, vx: m.vx, vy: m.vy, moving: true };
    }
    const f = sa.fix;
    if (!f) return null;
    const dt = Math.max(0, now - f.f) + ahead;
    let r = Math.hypot(f.r, CV_SIGMA_V * dt);
    // 動いている仮定でも記録が同じくらい説明できるなら、その仮定の位置まで円を広げる (どちらか分からない、が正直な答え)
    const a = sa.alt;
    if (a && !f.fromMotion) { const ta = now - a.f + ahead; r = Math.max(r, Math.hypot(a.x + a.vx * ta - f.x, a.y + a.vy * ta - f.y) + 150); }
    r = Math.max(r, Math.hypot(f.x - player.x, f.y - player.y) * anaFloorFrac(sa.ana)); // 第29弾: 解析量の下限
    return { x: f.x, y: f.y, r, vx: 0, vy: 0, moving: false };
}
// 追跡ボタンの幅表示 (±850 / ±1.2k)
function _fmtR(r) { return '±' + (r >= 1000 ? (Math.round(r / 100) / 10) + 'k' : Math.round(r / 10) * 10); }
// 弾が届くまでのフレーム数 (ビームは即着)
function weaponFlightFrames(w, d) { return w === 'beam' ? 0 : w === 'missile' ? d / (missileMode === 'smart' ? 7.5 : 6) : d / 12; }
// 第20弾: 見えている相手の見越し点 (見えている動き=前フレームからの移動量を使う)
function visibleLeadPoint(t, w) {
    let x = t.x, y = t.y;
    const vx = t._vx || 0, vy = t._vy || 0;
    for (let i = 0; i < 2; i++) { const T = weaponFlightFrames(w, Math.hypot(x - player.x, y - player.y)); x = t.x + vx * T; y = t.y + vy * T; }
    return { x, y };
}
// 見越し点: 弾が届く時刻の予測位置 (2回反復で飛翔時間と距離を合わせる)
function leadPoint(sa, w) {
    let est = trackEstimate(sa, 0);
    if (!est || !player) return est;
    for (let i = 0; i < 2; i++) est = trackEstimate(sa, weaponFlightFrames(w, Math.hypot(est.x - player.x, est.y - player.y)));
    return est;
}
// 想定ロックで狙う点 (追跡の推定があれば見越し点、無ければソナー等の反応位置)
function assumedAimPoint(te, w) {
    const sa = _signalAnalysis[enemySid(te)];
    const lp = sa && (sa.fix || sa.motion) ? leadPoint(sa, w) : null;
    return lp ? lp : { x: te.displayX, y: te.displayY, r: te.trackR || 3000 };
}
// ═══ 第16弾: ノード(ヒッグス結晶) と コロニー — 「その場に留まる」行動に意味を持たせる ═══
// ノード: 近くに5秒留まって制圧 (その間EMが漏れる) → 150SCR・資材+4・以後は自分の聴音局 (周囲6000uの方位線を送ってくる)。
//         敵も制圧し返す。敵が持つノードは敵の聴音局になる (対称)。
// コロニー: 近くに8秒留まってハック (EMが漏れる) → 耐久25%修理・資材満タン・コロニーの観測記録から敵艦の方位線を1本。
let _capturing = null; // 今まさに制圧/ハックしている対象 { kind:'node'|'colony', obj, p }
// 第20弾: 補給 — 補給所(全部・積み込み計画どおり) / ハック済みコロニー(弾だけ・60秒に1回) の600u以内に8秒留まる
function cargoBelowPlan() {
    if (ammoBelowPlan()) return true;
    const lo = shipLoadout(gameState.shipType);
    if (cargo.mat < lo.mat * MAT_PER_SLOT) return true;
    for (const t of SHIP_DRONES[gameState.shipType] || []) if ((cargo.stock[t] || 0) < (lo[t] || 0)) return true;
    return false;
}
function nearestResupply(x, y) {
    let best = null, bd = Infinity, kind = '';
    for (const c of structures) { if (c.type !== 'colony' || !c.hacked || c._usedP) continue; const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = c; kind = 'colony'; } }
    return best ? { obj: best, kind, d: bd } : null;
}
function updateResupply() {
    if (!player || player.hp <= 0 || dockingOpen) { _resupply = null; return; }
    let best = null, bd = RESUPPLY_R, kind = '';
    for (const c of structures) {
        if (c.type !== 'colony' || !c.hacked || c._usedP) continue;
        const d = Math.hypot(c.x - player.x, c.y - player.y);
        if (d < bd && (ammoBelowPlan() || cargo.mat < Math.min(COLONY_SUPPLY_MAT, cargoMatCap()))) { bd = d; best = c; kind = 'colony'; }
    }
    if (!best) { _resupply = null; return; }
    if (!_resupply || _resupply.obj !== best) _resupply = { obj: best, kind, p: 0 };
    _resupply.p += gameSpeedFactor / RESUPPLY_TIME;
    if (_resupply.p < 1) return;
    // 第26弾 (オーナー指示): 1つのコロニーで1回だけ — 弾は積み込み計画まで満タン・資材は+3個まで。完成品・リペアキット・修理は無し
    { const gotA = refillAmmo(); const gotM = addMaterials(COLONY_SUPPLY_MAT); best._usedP = true;
      matchRecEvent('supplyP', best.x, best.y, '自艦: コロニーで補給');
      logMessage('補給: コロニーで弾を満タン' + (gotA ? ' (+' + gotA + ')' : '') + (gotM ? '・資材+' + gotM + '個' : '') + ' — ' + cargoSummaryNow() + '。このコロニーでの補給はこれで終わり', 'system-msg'); }
    if (comDemo) comThinkEvent('p', '補給完了 (実弾' + cargo.ammoK + '・ミサイル' + cargo.ammoM + ')');
    _resupply = null;
    playSound('ui');
}
function updateNodesAndColonies() {
    _capturing = null;
    for (const n of resourceNodes) { if (n.emFlashTimer > 0) n.emFlashTimer--; }
    if (!player || player.hp <= 0) return;
    for (const n of resourceNodes) {
        if (n.owner === 'player') { n.capP = 0; continue; }
        const d = Math.hypot(player.x - n.x, player.y - n.y);
        if (d < NODE_CAP_R) {
            n.capP = (n.capP || 0) + gameSpeedFactor / NODE_CAP_TIME;
            n.identified = true;
            _capturing = { kind: 'node', obj: n, p: n.capP };
            if (n.capP >= 1) captureNodeByPlayer(n);
        } else if (n.capP > 0) n.capP = Math.max(0, n.capP - 0.004);
    }
    for (const st of structures) {
        if (st.type === 'derelict' && !st.salvaged && Math.hypot(player.x - st.x, player.y - st.y) < DERELICT_SALVAGE_R) { // 第23弾: 難破船から一度だけ拾う
            st.salvP = (st.salvP || 0) + gameSpeedFactor / DERELICT_SALVAGE_TIME;
            if (st.salvP >= 0) _capturing = { kind: 'derelict', obj: st, p: st.salvP }; // 負=積む場所がなかった後の待ち
            if (st.salvP >= 1) salvageDerelictByPlayer(st);
            continue;
        }
        if (st.type !== 'colony' || st.hacked) continue;
        const d = Math.hypot(player.x - st.x, player.y - st.y);
        if (d < COLONY_HACK_R && enemies.some(e => e.hp > 0 && !e._dying && e.type !== 'fighter' && Math.hypot(e.x - st.x, e.y - st.y) < COLONY_HACK_R)) {
            _capturing = { kind: 'colony', obj: st, p: st.hackP || 0, contested: true }; // 第23弾: 双方が居る間は進まない
        } else if (d < COLONY_HACK_R) {
            st.hackP = (st.hackP || 0) + gameSpeedFactor / COLONY_HACK_TIME;
            _capturing = { kind: 'colony', obj: st, p: st.hackP };
            if (st.hackP >= 1) hackColonyByPlayer(st);
        } else if (st.hackP > 0) st.hackP = Math.max(0, st.hackP - 0.003);
    }
}
function captureNodeByPlayer(n) {
    n.owner = 'player'; n.capP = 0; n.emFlashTimer = 180; n.knownLost = false;
    matchRecEvent('nodeP', n.x, n.y, '自艦がノードを制圧');
    if (!n._partP) { n._partP = true; offerDraft('node'); } // 第32弾: 初めて制圧したノードで部品 (探知・電子戦が出やすい)
    gameState.credits += NODE_SCR;
    updateTopUI();
    const got = addMaterials(NODE_MAT_GAIN);
    effects.push({ x: n.x, y: n.y, r: 0, maxR: 800, a: 1, c: '#50c8ff', type: 'circle' });
    playSound('ui');
    logMessage(`NODE: ノードを制圧 — +${NODE_SCR} SCR・${got > 0 ? '資材+' + got + '個' : '資材は満載 (展開して空いた枠にだけ積める)'}。以後この結晶が聴音局になり、周囲${NODE_RELAY_RANGE}uの方位を送ってくる`, 'system-msg');
}
function hackColonyByPlayer(st) {
    const was = st.owner;
    st.hacked = true; st.owner = 'player'; st.hackP = 0; st.eHackP = 0;
    matchRecEvent('colonyP', st.x, st.y, '自艦がコロニーを占有' + (was === 'enemy' ? ' (敵から奪還)' : ''));
    if (!st._partP) { st._partP = true; offerDraft('colony'); } // 第32弾: 初めて占有したコロニーで部品 (機関・船体が出やすい)
    createClickEffect(st.x, st.y, '#00aaff');
    playSound('ui');
    const n = coloniesOwned('player');
    logMessage('COLONY: コロニーを占有 (' + n + 'つ' + (was === 'enemy' ? '・敵から奪還' : '') + ')' + (st._usedP ? ' — ここの補給はもう使った' : ' — ここで1回だけ補給できる (弾を満タン・資材+' + COLONY_SUPPLY_MAT + ')') + '。演算力 ×' + (Math.round(analysisPower('player') * 100) / 100) + ' (解析と識別が速くなる)', 'system-msg');
    updateColonyIntel(true);
}
function _colonyIntelHint(n) {
    return n >= 3 ? 'コロニー情報: 敵の方角±15°と距離±500u' : n === 2 ? 'コロニー情報: 敵の方角±60°と距離±2500u (3つで精度が上がる)' : n === 1 ? 'コロニー情報: 敵のおよその方角 (±60°)。2つで距離も分かる' : '';
}
function coloniesOwned(side) { let n = 0; for (const st of structures) if (st.type === 'colony' && st.owner === side) n++; return n; }
function nodesOwned(side) { let n = 0; for (const nd of resourceNodes) if (nd.owner === side) n++; return n; }
// 第23弾: コロニー情報 — 占有数で敵の方角・距離の範囲が分かる。observer=自艦/敵艦、target=相手。返す範囲の中に真の位置がある
function makeColonyIntel(side, observer, target) {
    const n = Math.min(3, coloniesOwned(side));
    if (!n || !observer || !target) return null;
    const k = 1 - Math.min(NODE_INTEL_BUFF_MAX, NODE_INTEL_BUFF * nodesOwned(side));
    const spec = COLONY_INTEL[n];
    const ang0 = Math.atan2(target.y - observer.y, target.x - observer.x), d0 = Math.hypot(target.x - observer.x, target.y - observer.y);
    const aHW = spec.ang * k, dHW = spec.dist ? spec.dist * k : null;
    return { f: _frameCount, n, nodes: nodesOwned(side), ang: ang0 + (Math.random() * 2 - 1) * aHW * 0.6, aHW,
        dist: dHW ? Math.max(dHW, d0 + (Math.random() * 2 - 1) * dHW * 0.6) : null, dHW, ox: observer.x, oy: observer.y };
}
let playerIntel = null;
function updateColonyIntel(now) {
    // 第29弾 (オーナー合意): コロニーは相手の位置を教えない (囮や偽装が無意味になるため) → 演算力 (analysisPower) に
    playerIntel = null; for (const e of enemies) e._colIntel = null;
    return;
    if (!player || player.hp <= 0) return;
    if (!now && _frameCount % COLONY_INTEL_PERIOD) return;
    const boss = enemies.find(e => e.hp > 0 && !e._dying && e.type !== 'fighter');
    const prev = playerIntel;
    playerIntel = makeColonyIntel('player', player, boss);
    if (playerIntel && (!prev || prev.n !== playerIntel.n)) {
        ringMarkBearing(compassDeg(playerIntel.ang), '#7fc8ff');
        logMessage('コロニー情報: 敵は方位' + compassDeg(playerIntel.ang) + '°±' + Math.round(playerIntel.aHW * 180 / Math.PI) + '°' + (playerIntel.dist ? '・距離' + Math.round(playerIntel.dist / 100) * 100 + 'u±' + Math.round(playerIntel.dHW / 100) * 100 + 'u' : '') + (playerIntel.nodes ? ' (ノード' + playerIntel.nodes + 'つで精度+' + Math.round(Math.min(NODE_INTEL_BUFF_MAX, NODE_INTEL_BUFF * playerIntel.nodes) * 100) + '%)' : ''), 'system-msg');
    }
    // 敵も同じ: 敵が占有しているコロニーの数で自艦の範囲を得る → 手掛かりが無ければその範囲へ向かう
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
        const it = makeColonyIntel('enemy', e, player);
        e._colIntel = it;
        if (it && (e.contactFreshness || 0) < 0.2 && !e._supply && !e._hiding && e.aiState !== 'combat') {
            const d = it.dist || 9000;
            const tx = e.x + Math.cos(it.ang) * d, ty = e.y + Math.sin(it.ang) * d;
            e.huntTarget = clampToMapCircle(tx, ty, 1500); e.aiState = 'hunting'; e.huntTimer = Math.max(e.huntTimer || 0, 600); e.lurking = false;
            if (comDemo && (!e._colIntelLog || _frameCount - e._colIntelLog > 1800)) { e._colIntelLog = _frameCount; comThinkEvent('e', 'コロニー情報 (' + it.n + 'つ占有) → 自機は' + _dirTxt(e.x, e.y, tx, ty) + 'の辺り。向かう', 'e' + e.uid); }
        }
    }
}
// 敵のコロニー占有 (自機と同じ600u・8秒)。自機のコロニーなら裏返る
function updateEnemyColonyCapture() {
    for (const st of structures) {
        if (st.type !== 'colony' || st.owner === 'enemy') continue;
        let near = null;
        for (const e of enemies) { if (e.hp > 0 && !e._dying && e.type !== 'fighter' && Math.hypot(e.x - st.x, e.y - st.y) < COLONY_HACK_R) { near = e; break; } }
        if (!near) { if (st.eHackP > 0) st.eHackP = Math.max(0, st.eHackP - 0.003); continue; }
        if (player && player.hp > 0 && Math.hypot(player.x - st.x, player.y - st.y) < COLONY_HACK_R) continue; // 双方が居る間は進まない
        st.eHackP = (st.eHackP || 0) + gameSpeedFactor / COLONY_HACK_TIME;
        near.emSig = Math.max(near.emSig || 0, 0.45);
        if (st.eHackP >= 1) {
            const was = st.owner;
            st.owner = 'enemy'; st.hacked = false; st.eHackP = 0; st.hackP = 0;
            if (!st._partE) { st._partE = true; enemyOfferDraft(near, 'colony', st.x, st.y); } // 第33弾: 敵も初めて占有したコロニーで部品
            // 第26弾: 占有しただけでは回復も補給もしない (補給は _supply の流れで1つのコロニーにつき1回)
            matchRecEvent('colonyE', st.x, st.y, '敵がコロニーを占有' + (was === 'player' ? ' (自艦のを奪った)' : ''));
            if (was === 'player') { logMessage('COLONY: コロニーとの通信途絶 — 敵に奪われた (占有' + coloniesOwned('player') + 'つ)', 'warning-msg'); playSound('alert'); updateColonyIntel(true); }
            if (comDemo) comThinkEvent('e', 'コロニーを占有 (' + coloniesOwned('enemy') + 'つ) — 自機の位置の手掛かりが増える', 'e' + near.uid);
        }
    }
}
function salvageDerelictByPlayer(st) {
    st.salvP = 0;
    if (!st._partDone) { st._partDone = true; offerDraft('derelict'); } // 第32弾: 難破船で部品 (兵装が出やすい)
    // 空いている枠の分だけ拾う (実弾1枠→ミサイル1枠→資材2個)。何も積めなければ残しておく
    const free = () => playerHoldCap() - cargoStockSlots() - Math.ceil((cargo.mat || 0) / MAT_PER_SLOT);
    let gK = 0, gM = 0;
    if (free() >= 1) { cargo.ammoK += AMMO_PER_SLOT.kinetic; gK = AMMO_PER_SLOT.kinetic; }
    if (free() >= 1) { cargo.ammoM += AMMO_PER_SLOT.missile; gM = AMMO_PER_SLOT.missile; }
    const got = addMaterials(2);
    if (!gK && !gM && !got) { st.salvaged = true; logMessage('SALVAGE: 難破船 — 弾と資材は積む場所がなかった', 'system-msg'); return; }
    if (false) { st.salvP = -5; logMessage('SALVAGE: 難破船 — 積む場所がない (弾か資材を使ってから)', 'warning-msg'); return; }
    st.salvaged = true;
    matchRecEvent('salvP', st.x, st.y, '自艦が難破船から回収');
    logMessage('SALVAGE: 難破船から回収 — ' + [gK ? '実弾+' + gK : '', gM ? 'ミサイル+' + gM : '', got ? '資材+' + got + '個' : ''].filter(Boolean).join('・'), 'system-msg');
    _hudCache.cargo = null; playSound('ui');
}
// ═══ 第32弾 (オーナー合意 2026-10-31): 部品のドラフト式カスタマイズ ═══
// 試合の中で拾った部品で艦を組む (結果は持ち越さない)。どの部品にも長所と代償 = 何かを伸ばすとどこかが弱くなる。
// 拾う所: コロニーを初めて占有 / ノードを制圧 / 難破船 / 漂流コンテナ → 3つから1つ選ぶ。拾う所で出やすい種類が違う。
// 取り付け枠: 攻撃型5・潜航型4・空母型4。枠が満杯なら予備に入る。付け替えは自分のコロニーのドックでだけ。
const PART_SLOTS = { assault: 5, stealth: 4, carrier: 4 };
const PART_CATS = { kin: '実弾', msl: 'ミサイル', beam: 'ビーム', fcs: '火器管制', sen: '探知', eng: '機関', hull: '船体', ew: '電子戦' };
const PARTS = {
    prox:      { cat: 'kin',  name: '近接信管弾',     up: '実弾が150u以内を外れても50%の威力で炸裂', down: '発砲の光+50%', f: m => { m.kinProx = 1; m.opticFire *= 1.5; } },
    ap:        { cat: 'kin',  name: '徹甲弾',         up: '実弾の威力×1.6・距離で減衰しない', down: '弾倉 8→5斉射', f: m => { m.kinDmg *= 1.6; m.kinNoFall = 1; m.kinMag = Math.min(m.kinMag, 5); } },
    autoload:  { cat: 'kin',  name: '高速装填機構',   up: '実弾のリロード 2→1秒', down: '熱+0.1・弾の消費×1.5', f: m => { m.kinReload *= 0.5; m.heatAdd += 0.1; m.kinAmmoUse *= 1.5; } },
    ciws:      { cat: 'kin',  name: '迎撃管制 (CIWS)', up: 'ミサイル迎撃 450→700u・確率+15%', down: '電磁波+0.05', f: m => { m.pdRange = 700; m.pdBonus += 0.15; m.emAdd += 0.05; } },
    shotgun:   { cat: 'kin',  name: '散弾砲身',       up: '300u以内では相手が実弾を避けにくい (回避×0.3)', down: '実弾の射程 800→550', f: m => { m.kinClose = 1; m.kinRange *= 550 / 800; } },
    mirv:      { cat: 'msl',  name: '多弾頭',         up: '着弾点の手前で5つに分裂 (中心＋半径600uの4点・それぞれ30%の威力。推定が外れていても当たりやすい)', down: '1回で2発使う', f: m => { m.mirv = 1; } },
    seeker:    { cat: 'msl',  name: '囮耐性シーカー', up: '終末シーカー 900→1300u・閃光で誘導を失わない (60%)', down: 'ミサイルのリロード+30%', f: m => { m.seeker = 1; m.mslReload *= 1.3; } },
    booster:   { cat: 'msl',  name: '長射程ブースター', up: 'ミサイルの射程 2200→3500', down: '発射の熱が2倍 (遠くまで聞かれる)', f: m => { m.mslRange *= 3500 / 2200; m.mslLaunchHeat *= 2; } },
    quietmsl:  { cat: 'msl',  name: '静音推進',       up: '相手がミサイルに気付く距離が半分', down: 'ミサイルの速さ×0.7', f: m => { m.mslQuiet = 1; m.mslSpeed *= 0.7; } },
    emp:       { cat: 'msl',  name: 'EMP弾頭',        up: 'ミサイル命中で相手のセンサーを8秒乱す', down: 'ミサイルの威力×0.6', f: m => { m.emp = 1; m.mslDmg *= 0.6; } },
    mine:      { cat: 'msl',  name: '機雷敷設',       up: '長押しメニューで機雷を置ける (400u以内に来た艦に350・最大4個)', down: 'ミサイルを1発使う・置く時に電磁波', f: m => { m.mine = 1; } },
    focus:     { cat: 'beam', name: '集束レンズ',     up: 'ビームのチャージ 2→1.2秒', down: 'チャージ中の漏れ×1.5', f: m => { m.beamCharge *= 0.6; m.chargeLeak *= 1.5; } },
    diffuse:   { cat: 'beam', name: '拡散照射',       up: 'ビームの当たり幅 140→400u', down: 'ビームの威力×0.6', f: m => { m.beamWidth = 400; m.beamDmg *= 0.6; } },
    pierce:    { cat: 'beam', name: '霧貫通',         up: '霧によるビームの減衰が半分', down: '霧の軌跡で射手が知れる距離×1.5', f: m => { m.beamFog *= 0.5; m.beamReveal *= 1.5; } },
    rapidcap:  { cat: 'beam', name: '速射コンデンサ', up: 'ビームのリロード 35→15秒', down: 'ビームの威力×0.5', f: m => { m.beamReload *= 15 / 35; m.beamDmg *= 0.5; } },
    fcs:       { cat: 'fcs',  name: '火器管制強化',   up: '全兵装の威力+15%', down: '目標を掴んでいる間、照準波で18000u以内の敵に概位置が知れる', f: m => { m.dmgAll *= 1.15; m.fcsLeak = 1; } },
    sonarx:    { cat: 'sen',  name: 'ソナー拡張',     up: '探信の範囲×1.5', down: '探信が聞かれる距離も×1.5', f: m => { m.sonarRange *= 1.5; m.sonarHeard *= 1.5; } },
    anacore:   { cat: 'sen',  name: '解析コア',       up: '演算力+0.5', down: '電磁波+0.08', f: m => { m.ana += 0.5; m.emAdd += 0.08; } },
    multiband: { cat: 'sen',  name: '多帯域受信機',   up: '2本目以降の帯域の漏れが半分', down: '取り付け枠を2つ使う', w: 2, f: m => { m.leakMul *= 0.5; } },
    towed:     { cat: 'sen',  name: '曳航アレイ',     up: '動いていても耳が塞がりにくい (自艦ノイズの影響が半分)', down: '旋回×0.85', f: m => { m.noiseHear *= 0.5; m.turn *= 0.85; } },
    vector:    { cat: 'eng',  name: 'ベクターノズル', up: '航跡×0.6・熱×0.8 (静粛)', down: '最高速×0.9', f: m => { m.wake *= 0.6; m.heat *= 0.8; m.speed *= 0.9; } },
    thruster:  { cat: 'eng',  name: '高出力スラスタ', up: '最高速×1.2・加速×1.3', down: '熱+0.15', f: m => { m.speed *= 1.2; m.accel *= 1.3; m.heatAdd += 0.15; } },
    rcs:       { cat: 'eng',  name: '姿勢制御強化',   up: '旋回×1.4 (回り込みやすい)', down: '電磁波+0.05', f: m => { m.turn *= 1.4; m.emAdd += 0.05; } },
    cooling:   { cat: 'eng',  name: '冷却ジャケット', up: '熱×0.7・噴射後の過熱が半分', down: '耐久−10%', f: m => { m.heat *= 0.7; m.overheat *= 0.5; m.hp -= 0.10; } },
    armor:     { cat: 'hull', name: '増加装甲',       up: '耐久+25%', down: '最高速×0.9・旋回×0.85', f: m => { m.hp += 0.25; m.speed *= 0.9; m.turn *= 0.85; } },
    slope:     { cat: 'hull', name: '傾斜装甲',       up: '正面±30°からの被弾−30%', down: '後ろからの被弾 ×1.5→×2.0', f: m => { m.front = 0.3; m.rear = 2.0; } },
    damcon:    { cat: 'hull', name: 'ダメコン班',     up: 'リペアキット×1.5・サブシステム損傷の時間が半分', down: '取り付け枠を2つ使う', w: 2, f: m => { m.kit *= 1.5; m.subsys *= 0.5; } },
    ram:       { cat: 'hull', name: '電波吸収塗装',   up: '光・電磁波×0.75', down: '耐久−15%', f: m => { m.optic *= 0.75; m.em *= 0.75; m.hp -= 0.15; } },
    ecm:       { cat: 'ew',   name: 'ECM',            up: '敵の推定の誤差×1.5', down: '電磁波+0.1 (ECM自体が聞こえる)', f: m => { m.ecm *= 1.5; m.emAdd += 0.1; } },
    lurel:     { cat: 'ew',   name: '囮発射機',       up: '偽艦影ブイを資材なしで90秒ごとに出せる', down: '枠を使う (他の部品が載らない)', f: m => { m.lureFree = 1; } },
    hangar:    { cat: 'ew',   name: '格納庫拡張',     up: '積載+3枠', down: '最高速×0.95', f: m => { m.hold += 3; m.speed *= 0.95; } },
};
const PM_DEF = { kinProx: 0, opticFire: 1, kinDmg: 1, kinNoFall: 0, kinMag: 8, kinReload: 1, heatAdd: 0, kinAmmoUse: 1, pdRange: 450, pdBonus: 0, emAdd: 0, kinClose: 0, kinRange: 1,
    mirv: 0, seeker: 0, mslReload: 1, mslRange: 1, mslLaunchHeat: 1, mslQuiet: 0, mslSpeed: 1, emp: 0, mslDmg: 1, mine: 0,
    beamCharge: 1, chargeLeak: 1, beamWidth: BEAM_HIT_WIDTH, beamDmg: 1, beamFog: 1, beamReveal: 1, beamReload: 1, dmgAll: 1, fcsLeak: 0,
    sonarRange: 1, sonarHeard: 1, ana: 0, leakMul: 1, noiseHear: 1, turn: 1, wake: 1, heat: 1, speed: 1, accel: 1, overheat: 1,
    hp: 0, front: 0, rear: 1.5, kit: 1, subsys: 1, optic: 1, em: 1, ecm: 1, lureFree: 0, hold: 0 };
const DRAFT_BIAS = { colony: ['eng', 'hull'], node: ['sen', 'ew'], derelict: ['kin', 'msl', 'beam', 'fcs'], cache: null };
const DRAFT_BIAS_W = 3, LURE_FREE_CD = 5400, MINE_MAX = 4, MINE_R = 400, MINE_ARM = 180, MINE_LIFE = 18000, FCS_LEAK_R = 18000;
const PLAYER_HP_BASE = { assault: 3500, stealth: 700, carrier: 2500 };
let PM = Object.assign({}, PM_DEF);
let partsOn = [], partsSpare = [], _draft = null, _draftQ = [], _lureFreeCD = 0, mines = [], _kinAmmoFrac = 0;
function partW(id) { return PARTS[id].w || 1; }
function partSlotsUsed() { let n = 0; for (const id of partsOn) n += partW(id); return n; }
function partSlotsMax() { return PART_SLOTS[gameState.shipType] || 4; }
function playerHoldCap() { return (HOLD_CAP[gameState.shipType] || 0) + PM.hold; }
function resetParts() { partsOn = []; partsSpare = []; _draft = null; _draftQ = []; _lureFreeCD = 0; mines = []; _kinAmmoFrac = 0; recomputeParts(); _closeDraftUI(); }
function recomputeParts() {
    const m = Object.assign({}, PM_DEF);
    for (const id of partsOn) PARTS[id].f(m);
    PM = m;
    if (player && player.hp > 0) {
        const nm = Math.round((PLAYER_HP_BASE[gameState.shipType] || 2000) * (1 + PM.hp));
        const d = nm - player.maxHp;
        player.maxHp = nm;
        player.hp = Math.max(1, Math.min(nm, player.hp + Math.max(0, d)));
        player.kineticMaxAmmo = PM.kinMag;
        player.kineticAmmo = Math.min(player.kineticAmmo || 0, PM.kinMag);
    }
    if (typeof _hudCache !== 'undefined') _hudCache.cargo = null;
    _updatePartsChip();
}
function partSummary() { return partsOn.map(id => PARTS[id].name).join('・') || 'なし'; }
// 3つの候補 (持っていない部品から。拾う所の得意な種類は3倍出やすい)
function draftPick3(src) {
    const owned = new Set(partsOn.concat(partsSpare));
    const pool = Object.keys(PARTS).filter(id => !owned.has(id));
    const bias = DRAFT_BIAS[src], out = [];
    while (out.length < 3 && pool.length) {
        let tot = 0; const ws = pool.map(id => { const w = bias && bias.includes(PARTS[id].cat) ? DRAFT_BIAS_W : 1; tot += w; return w; });
        let r = Math.random() * tot, k = 0;
        while (k < ws.length - 1 && r > ws[k]) { r -= ws[k]; k++; }
        out.push(pool.splice(k, 1)[0]);
    }
    return out;
}
const _SRC_JP = { colony: 'コロニー', node: 'ノード', derelict: '難破船', cache: '漂流コンテナ' };
function offerDraft(src) {
    const c = draftPick3(src);
    if (!c.length) { logMessage('部品: ' + _SRC_JP[src] + ' — 新しい部品は無かった (全部持っている)', 'system-msg'); return; }
    if (comDemo) { takePart(comPickPart(c)); return; }
    if (_draft) { _draftQ.push({ src, c }); return; }
    _draft = { src, c };
    _openDraftUI();
}
function takePart(id) {
    if (!id || !PARTS[id]) return;
    const P = PARTS[id];
    if (partSlotsUsed() + partW(id) <= partSlotsMax()) {
        partsOn.push(id); recomputeParts();
        logMessage('部品: ' + P.name + ' を取り付けた — ' + P.up + ' / 代償: ' + P.down + ' (枠' + partSlotsUsed() + '/' + partSlotsMax() + ')', 'system-msg');
    } else {
        partsSpare.push(id); _updatePartsChip();
        logMessage('部品: ' + P.name + ' — 取り付け枠が満杯。予備に入れた (自分のコロニーのドックで付け替え)', 'warning-msg');
    }
    matchRecEvent('partP', player ? player.x : 0, player ? player.y : 0, '部品: ' + P.name);
    if (comDemo) comThinkEvent('p', '部品「' + P.name + '」を選んだ (' + P.up + ' / 代償: ' + P.down + ')');
    playSound('ui');
}
// 自機COMの選び方: 性格に合う種類を重く見る (攻撃性→兵装 / 隠密性→機関・電子戦・電波吸収 / 慎重さ→船体 / 貪欲さ→探知)
function _comPartScore(id, pp) {
    const c = PARTS[id].cat;
    let s = c === 'kin' || c === 'msl' || c === 'beam' || c === 'fcs' ? pp.aggression : c === 'eng' || c === 'ew' ? pp.stealth : c === 'hull' ? pp.caution : pp.greed;
    if (id === 'ram' || id === 'vector') s = Math.max(s, pp.stealth);
    if (id === 'armor') s = Math.max(s, pp.caution);
    if (id === 'mine' || id === 'lurel') s *= 0.7; // 自機COMは手動の道具をあまり使わない
    return s + Math.random() * 0.25;
}
function comPickPart(c) {
    const pp = (_com && _com.pp) || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
    let best = c[0], bs = -1;
    for (const id of c) { const sc = _comPartScore(id, pp); if (sc > bs) { bs = sc; best = id; } }
    return best;
}
// 付け替え (ドックの中だけ)
function partUninstall(id) { const i = partsOn.indexOf(id); if (i < 0) return; partsOn.splice(i, 1); partsSpare.push(id); recomputeParts(); }
function partInstall(id) {
    const i = partsSpare.indexOf(id); if (i < 0) return false;
    if (partSlotsUsed() + partW(id) > partSlotsMax()) { logMessage('部品: 枠が足りない — 先に何か外す', 'warning-msg'); return false; }
    partsSpare.splice(i, 1); partsOn.push(id); recomputeParts(); return true;
}
function partsDocked() {
    if (!player || player.hp <= 0) return false;
    return structures.some(s => s.type === 'colony' && s.owner === 'player' && Math.hypot(player.x - s.x, player.y - s.y) < RESUPPLY_R);
}
// 毎フレーム: 囮発射機の再装填・機雷・火器管制の照準波・自機COMの付け替え
function updateParts() {
    if (_lureFreeCD > 0) _lureFreeCD -= gameSpeedFactor;
    updateEnemyDerelictSalvage(); // 第33弾
    if (_frameCount % 120 === 0) for (const e of enemies) if (e.hp > 0 && !e._dying && e.type !== 'fighter') enemySwapAtColony(e);
    for (let i = mines.length - 1; i >= 0; i--) {
        const mn = mines[i];
        mn.t += gameSpeedFactor;
        if (mn.t > MINE_LIFE) { mines.splice(i, 1); continue; }
        if (mn.t < MINE_ARM) continue;
        let hit = null;
        for (const e of enemies) if (e.hp > 0 && !e._dying && e.type !== 'fighter' && Math.hypot(e.x - mn.x, e.y - mn.y) < MINE_R) { hit = e; break; }
        if (!hit) continue;
        mines.splice(i, 1);
        const dmg = Math.round(MISSILE_DMG * PM.dmgAll);
        hit.hp -= dmg;
        createExplosion(mn.x, mn.y, '#ffcc66', 26); addShake(10); playSound('explosion');
        effects.push({ x: hit.x, y: hit.y - 30, text: '機雷 -' + dmg, life: 1.2, type: 'floatText', c: '#ffdd66' });
        logMessage('WEP: 機雷が炸裂 → ' + dmg + ' ダメージ (敵が触れた)', 'warning-msg');
        matchRecEvent('hitE', mn.x, mn.y, '敵に命中: 機雷 −' + dmg);
        if (huntStats) huntStats.dmgDealt += dmg;
        // 触れた敵は爆発の方から撃たれたと思う (機雷の位置を知る)
        hit._alertUntil = _frameCount + ENEMY_ALERT_MEMORY; hit.detectionState = 'alerted';
    }
    if (!player || player.hp <= 0) return;
    // 火器管制強化の代償: 目標を掴んでいる間は照準波が漏れ、18000u以内の敵に概位置が知れる (2秒ごと)
    if (PM.fcsLeak && _frameCount % 120 === 0) {
        const te = player.targetEntity, lk = te && te.hp > 0 ? playerLockInfo(te) : null;
        if (lk && (lk.full || lk.assumed)) for (const e of enemies) {
            if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
            const d = Math.hypot(e.x - player.x, e.y - player.y);
            if (d > FCS_LEAK_R || (e.contactFreshness || 0) > 0.7) continue;
            const err = d * 0.15 + 300, a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * err;
            e.playerLastKnownPos = { x: player.x + Math.cos(a) * r, y: player.y + Math.sin(a) * r, vx: 0, vy: 0 };
            e.contactFreshness = Math.max(e.contactFreshness || 0, 0.5);
            if (comDemo && Math.random() < 0.3) comThinkEvent('e', '照準波を受けた → 自機は ' + _dirTxt(e.x, e.y, player.x, player.y) + ' (火器管制強化)', 'e' + e.uid);
        }
    }
    // 自機COM: 自分のコロニーに居る時、予備の方が性格に合えば付け替える
    if (comDemo && partsSpare.length && _frameCount % 120 === 0 && partsDocked()) {
        const pp = (_com && _com.pp) || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 };
        for (const sp of partsSpare.slice()) {
            let worst = null, ws = 9;
            for (const id of partsOn) { const sc = _comPartScore(id, pp); if (sc < ws) { ws = sc; worst = id; } }
            if (partSlotsUsed() + partW(sp) <= partSlotsMax()) { partInstall(sp); comThinkEvent('p', 'ドック: 予備の「' + PARTS[sp].name + '」を取り付け'); continue; }
            if (worst && _comPartScore(sp, pp) > ws + 0.15 && partW(sp) <= partW(worst) + (partSlotsMax() - partSlotsUsed())) {
                partUninstall(worst); if (partInstall(sp)) comThinkEvent('p', 'ドック: 「' + PARTS[worst].name + '」を外して「' + PARTS[sp].name + '」に付け替え'); else partInstall(worst);
            }
        }
    }
}
function placeMine() {
    if (!player || player.hp <= 0 || !PM.mine) return;
    if (mines.length >= MINE_MAX) { logMessage('機雷: 置けるのは' + MINE_MAX + '個まで', 'warning-msg'); return; }
    if (!useMissileAmmo()) { logMessage('機雷: ミサイルが無い (機雷はミサイルを1発使う)', 'warning-msg'); return; }
    mines.push({ x: player.x, y: player.y, t: 0 });
    player._launchFlash = 60; // 置く時に電磁波が漏れる
    matchRecEvent('fireP', player.x, player.y, '自艦: 機雷を置く');
    logMessage('機雷: 設置 — 3秒後から400u以内に来た艦に炸裂 (' + mines.length + '/' + MINE_MAX + '個)', 'system-msg');
    playSound('ui');
}
function drawMines(ctx) {
    const inv = 1 / camera.zoom;
    for (const mn of mines) {
        ctx.save();
        ctx.globalAlpha = mn.t < MINE_ARM ? 0.4 : 0.85; ctx.strokeStyle = '#ffcc66'; ctx.lineWidth = 1.6 * inv;
        const r = Math.max(30, 6 * inv);
        ctx.beginPath(); ctx.arc(mn.x, mn.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mn.x - r * 1.5, mn.y); ctx.lineTo(mn.x + r * 1.5, mn.y); ctx.moveTo(mn.x, mn.y - r * 1.5); ctx.lineTo(mn.x, mn.y + r * 1.5); ctx.stroke();
        ctx.globalAlpha = 0.18; ctx.setLineDash([5 * inv, 8 * inv]); ctx.beginPath(); ctx.arc(mn.x, mn.y, MINE_R, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();
    }
}
// MIRV: 着弾点の手前で5つに分裂 — 中心と、半径600uの輪の4点へ。子弾はそれぞれ900u以内 (普通のミサイルの終末シーカーと同じ) の艦を探して当たる (30%の威力)。
// 推定点のそばに居れば最大5発 (=1.5発分)、推定が900〜1500uずれていても1〜2発は当たる (普通のミサイルは900uより外れると空振り)
function mirvSplit(pr, cx, cy) {
    let hits = 0;
    const rot = Math.random() * Math.PI * 2;
    for (let k = 0; k < 5; k++) {
        const bx = k === 0 ? cx : cx + Math.cos(rot + k * Math.PI / 2) * 600, by = k === 0 ? cy : cy + Math.sin(rot + k * Math.PI / 2) * 600;
        let tgt = null, td = 900; // 子弾の終末シーカーは普通のミサイルと同じ900u
        for (const e of enemies) { if (e.hp <= 0 || e._dying) continue; const d = Math.hypot(e.x - bx, e.y - by) - (e.radius || 0); if (d < td) { td = d; tgt = e; } }
        if (!tgt) { createExplosion(bx, by, '#ffaa55', 8); continue; }
        const d = Math.round(pr.dmg * 0.3);
        tgt.hp -= d; hits++;
        createExplosion(tgt.x + (Math.random() - 0.5) * 40, tgt.y + (Math.random() - 0.5) * 40, '#ffaa55', 12);
        effects.push({ x: tgt.x, y: tgt.y - 30 - k * 9, text: '-' + d, life: 1.0, type: 'floatText', c: '#ffdd00' });
        if (huntStats) huntStats.dmgDealt += d;
        if (tgt.type !== 'fighter') { matchRecEvent('hitE', tgt.x, tgt.y, '敵に命中: 多弾頭 −' + d); applyStrikeBonuses(true, null, tgt, Math.atan2(by - tgt.y, bx - tgt.x), 'missile'); }
    }
    logMessage(hits ? 'WEP: 多弾頭が分裂 — 子弾' + hits + '発が命中' : 'WEP: 多弾頭が分裂 — 子弾は何にも当たらなかった (推定が外れた)', hits ? 'warning-msg' : 'system-msg');
    if (!hits) { missRevealsShooter(pr.ox ?? player.x, pr.oy ?? player.y, cx, cy, false); if (pr.sid) recordMiss(pr.sid, { x: cx, y: cy, r: 1500 }); }
    addShake(6); playSound('explosion');
    pr.active = false;
}
// ═══ 第33弾 (段階C): 敵も部品を拾って付ける (自機と同じ所・同じ3択・同じ枠・付け替えは自分のコロニーで) ═══
// 敵の効果は e.pm (自機の PM と同じ形)。敵の動きに差し込めていない部品 (近接信管・散弾・多弾頭・機雷・拡散・ソナー・曳航・囮発射機・格納庫) は候補に出ない
const ENEMY_PART_QUIET = 1200; // 第33弾: 部品を取りに出るまでの静けさ (20秒・実装で決めた値)
const ENEMY_PART_OK = ['ap', 'autoload', 'ciws', 'seeker', 'booster', 'quietmsl', 'emp', 'focus', 'pierce', 'rapidcap', 'fcs', 'anacore', 'multiband',
                       'vector', 'thruster', 'rcs', 'cooling', 'armor', 'slope', 'damcon', 'ram', 'ecm'];
function epm(e) { return (e && e.pm) || PM_DEF; }
function enemySlotsMax(e) { return PART_SLOTS[ENEMY_CLASS[e.type]] || 4; }
function enemySlotsUsed(e) { let n = 0; for (const id of e.parts || []) n += partW(id); return n; }
function recomputeEnemyParts(e) {
    const m = Object.assign({}, PM_DEF);
    for (const id of e.parts || []) PARTS[id].f(m);
    if (e._baseHp === undefined) e._baseHp = e.maxHp;
    const nm = Math.round(e._baseHp * (1 + m.hp)), d = nm - e.maxHp;
    e.maxHp = nm; e.hp = Math.max(1, Math.min(nm, e.hp + Math.max(0, d)));
    e.pm = m;
}
function _enemyPersonality(e) { return e.personality || { aggression: 0.5, stealth: 0.3, greed: 0.4, caution: 0.4 }; }
function enemyOfferDraft(e, src, x, y) {
    if (!e || e.type === 'fighter' || !ENEMY_CLASS[e.type]) return;
    e.parts = e.parts || []; e.partsSpare = e.partsSpare || [];
    const owned = new Set(e.parts.concat(e.partsSpare));
    const pool = ENEMY_PART_OK.filter(id => !owned.has(id));
    const bias = DRAFT_BIAS[src], c = [];
    while (c.length < 3 && pool.length) {
        let tot = 0; const ws = pool.map(id => { const w = bias && bias.includes(PARTS[id].cat) ? DRAFT_BIAS_W : 1; tot += w; return w; });
        let r = Math.random() * tot, k = 0;
        while (k < ws.length - 1 && r > ws[k]) { r -= ws[k]; k++; }
        c.push(pool.splice(k, 1)[0]);
    }
    if (!c.length) return;
    const pp = _enemyPersonality(e);
    let best = c[0], bs = -1;
    for (const id of c) { const sc = _comPartScore(id, pp); if (sc > bs) { bs = sc; best = id; } }
    if (enemySlotsUsed(e) + partW(best) <= enemySlotsMax(e)) { e.parts.push(best); recomputeEnemyParts(e); }
    else e.partsSpare.push(best);
    matchRecEvent('partE', x ?? e.x, y ?? e.y, '敵が部品: ' + PARTS[best].name);
    if (comDemo) comThinkEvent('e', _SRC_JP[src] + 'で部品 → 「' + PARTS[best].name + '」を選んだ (' + c.map(id => PARTS[id].name).join('/') + 'から・' + PARTS[best].up + ')', 'e' + e.uid);
}
// 敵の付け替え: 自分のコロニーに居る時、予備の方が性格に合えば付け替える
function enemySwapAtColony(e) {
    if (!e.partsSpare || !e.partsSpare.length) return;
    if (!structures.some(s => s.type === 'colony' && s.owner === 'enemy' && Math.hypot(e.x - s.x, e.y - s.y) < RESUPPLY_R)) return;
    const pp = _enemyPersonality(e);
    for (const sp of e.partsSpare.slice()) {
        if (enemySlotsUsed(e) + partW(sp) <= enemySlotsMax(e)) { e.partsSpare.splice(e.partsSpare.indexOf(sp), 1); e.parts.push(sp); recomputeEnemyParts(e); continue; }
        let worst = null, ws = 9;
        for (const id of e.parts) { const sc = _comPartScore(id, pp); if (sc < ws) { ws = sc; worst = id; } }
        if (worst && _comPartScore(sp, pp) > ws + 0.15 && partW(sp) <= partW(worst) + enemySlotsMax(e) - enemySlotsUsed(e)) {
            e.parts.splice(e.parts.indexOf(worst), 1); e.partsSpare.splice(e.partsSpare.indexOf(sp), 1, worst); e.parts.push(sp); recomputeEnemyParts(e);
            if (comDemo) comThinkEvent('e', '自分のコロニーで「' + PARTS[worst].name + '」→「' + PARTS[sp].name + '」に付け替え', 'e' + e.uid);
        }
    }
}
// 敵が難破船を回収する (500u以内に3秒・自機と取り合い。先に取った方だけ)
function updateEnemyDerelictSalvage() {
    for (const st of structures) {
        if (st.type !== 'derelict' || st.salvaged) continue;
        let near = null;
        for (const e of enemies) if (e.hp > 0 && !e._dying && e.type !== 'fighter' && Math.hypot(e.x - st.x, e.y - st.y) < DERELICT_SALVAGE_R) { near = e; break; }
        if (!near) { st.eSalvP = 0; continue; }
        if (player && player.hp > 0 && Math.hypot(player.x - st.x, player.y - st.y) < DERELICT_SALVAGE_R) continue;
        st.eSalvP = (st.eSalvP || 0) + gameSpeedFactor / 180;
        if (st.eSalvP < 1) continue;
        st.salvaged = true; st._partDone = true; st.eSalvP = 0;
        matchRecEvent('salvE', st.x, st.y, '敵が難破船を回収');
        enemyOfferDraft(near, 'derelict', st.x, st.y);
    }
}

// ── 画面: ドラフト (3つから1つ) / 部品の一覧 (ドックでは付け替え) ──
function _partCard(id, btnLabel, onClick, disabled) {
    const P = PARTS[id], d = document.createElement('div');
    d.className = 'part-card';
    d.innerHTML = '<div class="pc-cat"></div><div class="pc-name"></div><div class="pc-up"></div><div class="pc-down"></div>';
    d.querySelector('.pc-cat').textContent = PART_CATS[P.cat] + (partW(id) > 1 ? '・枠' + partW(id) : '');
    d.querySelector('.pc-name').textContent = P.name;
    d.querySelector('.pc-up').textContent = '＋ ' + P.up;
    d.querySelector('.pc-down').textContent = '− ' + P.down;
    if (btnLabel) { const b = document.createElement('button'); b.className = 'btn btn-info pc-btn'; b.textContent = btnLabel; b.disabled = !!disabled; b.addEventListener('click', onClick); d.appendChild(b); }
    return d;
}
function _openDraftUI() {
    const ov = document.getElementById('draft-overlay'); if (!ov || !_draft) return;
    document.getElementById('draft-title').textContent = '部品を拾った — ' + _SRC_JP[_draft.src];
    document.getElementById('draft-sub').textContent = '3つから1つ選ぶ (取り付け枠 ' + partSlotsUsed() + '/' + partSlotsMax() + (partsSpare.length ? '・予備' + partsSpare.length : '') + ')。枠が満杯なら予備に入り、自分のコロニーのドックで付け替えられる';
    const box = document.getElementById('draft-cards'); box.innerHTML = '';
    for (const id of _draft.c) box.appendChild(_partCard(id, 'これにする', () => { const d = _draft; _closeDraftUI(); takePart(id); _nextDraft(); }));
    ov.classList.remove('hidden');
}
function _closeDraftUI() { const ov = document.getElementById('draft-overlay'); if (ov) ov.classList.add('hidden'); _draft = null; }
function _nextDraft() { const q = _draftQ.shift(); if (q) { _draft = q; _openDraftUI(); } }
function openPartsUI() {
    const ov = document.getElementById('parts-overlay'); if (!ov) return;
    const edit = partsDocked() && !comDemo;
    document.getElementById('parts-title').textContent = '部品 — 取り付け枠 ' + partSlotsUsed() + '/' + partSlotsMax();
    document.getElementById('parts-sub').textContent = edit ? 'ドック: 外すと予備へ・予備から付けられる' : '付け替えは自分のコロニーのドック (600u以内) でだけ';
    const on = document.getElementById('parts-on'), sp = document.getElementById('parts-spare');
    on.innerHTML = ''; sp.innerHTML = '';
    if (!partsOn.length) on.textContent = 'なし — コロニー・ノード・難破船・漂流コンテナで拾える';
    for (const id of partsOn) on.appendChild(_partCard(id, edit ? '外す' : null, () => { partUninstall(id); openPartsUI(); }));
    if (!partsSpare.length) sp.textContent = 'なし';
    for (const id of partsSpare) sp.appendChild(_partCard(id, edit ? '付ける' : null, () => { partInstall(id); openPartsUI(); }, partSlotsUsed() + partW(id) > partSlotsMax()));
    ov.classList.remove('hidden');
}
function _updatePartsChip() {
    const el = document.getElementById('hud-parts'); if (!el) return;
    el.textContent = '部品 ' + partSlotsUsed() + '/' + partSlotsMax() + (partsSpare.length ? '+' + partsSpare.length : '');
}
(() => {
    document.getElementById('parts-close')?.addEventListener('click', () => document.getElementById('parts-overlay').classList.add('hidden'));
    document.getElementById('draft-skip')?.addEventListener('click', () => { _closeDraftUI(); logMessage('部品: 見送った', 'system-msg'); _nextDraft(); });
    document.getElementById('hud-parts')?.addEventListener('click', openPartsUI);
    document.getElementById('btn-dock-parts')?.addEventListener('click', openPartsUI);
})();

// ═══ 第31弾 (オーナー合意 2026-10-31): 自然の信号・お宝の信号・コロニーの聴音局・監視網の円 ═══
// 信号の正体は 敵 / 囮 / 自然 / お宝 の4つ。見分け方は第23弾の識別と同じ (帯域の比・動き・探信の反響)。寄って見れば確定。
// 自然 (12個): 霧のゆらぎ=霧の乱れ0.3〜0.5・霧の流れで漂い120秒で消えて別の所に出る / 嵐の放電=電磁波0.4〜0.6・3〜8秒ごとに明滅 / 熱泉=熱0.3〜0.4
// お宝 (8個): 漂流コンテナ=全帯域とも弱い0.15〜0.25・止まっている。400u以内に3秒で回収 (今は弾と資材・部品は次の段階)。回収されると60秒後に別の所へ出る (実装で決めた値)
const FIELD_NATURE_N = 12, FIELD_CACHE_N = 8, FIELD_SPREAD_R = 24500;
const FIELD_KINDS = {
    cloud: { lbl: '霧のゆらぎ', band: 'higgs', lo: 0.30, hi: 0.50, col: '80,200,255' },
    storm: { lbl: '嵐の放電', band: 'em', lo: 0.40, hi: 0.60, col: '180,90,255' },
    vent:  { lbl: '熱泉', band: 'heat', lo: 0.30, hi: 0.40, col: '255,130,50' },
    cache: { lbl: '漂流コンテナ', band: null, lo: 0.15, hi: 0.25, col: '255,225,140' },
};
const CLOUD_LIFE = 7200, FIELD_FADE = 300, CACHE_R = 400, CACHE_TIME = 180, CACHE_RESPAWN = 3600, FIELD_IDENT_R = 2500;
function _fieldSpot() {
    for (let k = 0; k < 30; k++) {
        const a = Math.random() * Math.PI * 2, r = 3000 + Math.sqrt(Math.random()) * (FIELD_SPREAD_R - 3000);
        const x = MAP_CX + Math.cos(a) * r, y = MAP_CY + Math.sin(a) * r;
        if (player && Math.hypot(x - player.x, y - player.y) < 2500) continue;
        if (fieldSignals.some(f => Math.hypot(f.x - x, f.y - y) < 2000)) continue;
        return { x, y };
    }
    const a = Math.random() * Math.PI * 2; return { x: MAP_CX + Math.cos(a) * 12000, y: MAP_CY + Math.sin(a) * 12000 };
}
function makeFieldSignal(kind) {
    const k = FIELD_KINDS[kind], p = _fieldSpot(), str = k.lo + Math.random() * (k.hi - k.lo);
    const b = { heat: 0.03, optic: 0.03, em: 0.03, higgs: 0.03 };
    if (k.band) b[k.band] = str;
    else { for (const x of BANDS) b[x] = str * (0.85 + Math.random() * 0.3); b.optic += 0.04; }
    const id = ++_fieldSeq;
    return { sid: 'N-' + id, kind, x: p.x, y: p.y, b, age: 0, life: kind === 'cloud' ? CLOUD_LIFE * (0.6 + Math.random() * 0.8) : Infinity,
             on: true, flip: kind === 'storm' ? 180 + Math.random() * 300 : 0, takeP: 0, takeE: 0, ph: Math.random() * 6.28 };
}
function generateFieldSignals() {
    fieldSignals = []; _fieldRespawn = [];
    const kinds = ['cloud', 'storm', 'vent'];
    for (let i = 0; i < FIELD_NATURE_N; i++) fieldSignals.push(makeFieldSignal(kinds[i % 3]));
    for (let i = 0; i < FIELD_CACHE_N; i++) fieldSignals.push(makeFieldSignal('cache'));
}
// その帯域でその信号が出している強さ (出現と消える時は5秒でなめらかに)
function fieldSig(f, band) {
    if (!f.on) return 0;
    const fade = Math.min(1, f.age / FIELD_FADE, f.life / FIELD_FADE);
    return (f.b[band] || 0) * fade;
}
function fieldMaxSig(f) { let m = 0; for (const b of BANDS) m = Math.max(m, fieldSig(f, b)); return m; }
// お宝の回収 (自艦): 空いている枠の分だけ 実弾1枠→ミサイル1枠→資材2個 (難破船と同じ)。何も積めなければ残す
function collectCacheByPlayer(f) {
    // 第32弾: 漂流コンテナの中身は部品 (3つから1つ・全種類から)
    matchRecEvent('salvP', f.x, f.y, '自艦が漂流コンテナを回収');
    logMessage('SALVAGE: 漂流コンテナを回収 — 部品が入っていた', 'system-msg');
    offerDraft('cache');
    _hudCache.cargo = null; playSound('ui');
    return true;
}
function _collectCacheAmmoOld(f) { // 第31弾の中身 (弾・資材)。部品に置き換えたので使わない
    const free = () => playerHoldCap() - cargoStockSlots() - Math.ceil((cargo.mat || 0) / MAT_PER_SLOT);
    let gK = 0, gM = 0;
    if (free() >= 1) { cargo.ammoK += AMMO_PER_SLOT.kinetic; gK = AMMO_PER_SLOT.kinetic; }
    if (free() >= 1) { cargo.ammoM += AMMO_PER_SLOT.missile; gM = AMMO_PER_SLOT.missile; }
    const got = addMaterials(2);
    if (!gK && !gM && !got) { f.takeP = -120; logMessage('SALVAGE: 漂流コンテナ — 積む場所がない (弾か資材を使ってから)', 'warning-msg'); return false; }
    matchRecEvent('salvP', f.x, f.y, '自艦が漂流コンテナを回収');
    logMessage('SALVAGE: 漂流コンテナを回収 — ' + [gK ? '実弾+' + gK : '', gM ? 'ミサイル+' + gM : '', got ? '資材+' + got + '個' : ''].filter(Boolean).join('・'), 'system-msg');
    if (comDemo) comThinkEvent('p', '漂流コンテナを回収 (実弾' + cargo.ammoK + '・ミサイル' + cargo.ammoM + ')');
    _hudCache.cargo = null; playSound('ui');
    return true;
}
function collectCacheByEnemy(e, f) { // 第33弾: 敵も中身は部品 (自機と同じ)
    matchRecEvent('salvE', f.x, f.y, '敵が漂流コンテナを回収');
    enemyOfferDraft(e, 'cache', f.x, f.y);
}
function _fieldGone(i, respawnKind) {
    const f = fieldSignals[i];
    fieldSignals.splice(i, 1);
    _fieldRespawn.push({ kind: respawnKind || f.kind, at: _frameCount + (f.kind === 'cache' ? CACHE_RESPAWN : 0) });
}
function updateFieldSignals() {
    for (let i = _fieldRespawn.length - 1; i >= 0; i--) if (_frameCount >= _fieldRespawn[i].at) { fieldSignals.push(makeFieldSignal(_fieldRespawn[i].kind)); _fieldRespawn.splice(i, 1); }
    for (let i = fieldSignals.length - 1; i >= 0; i--) {
        const f = fieldSignals[i];
        f.age += gameSpeedFactor;
        if (f.kind === 'cloud') {
            f.x += higgsCurrent.x * 1.6 * gameSpeedFactor; f.y += higgsCurrent.y * 1.6 * gameSpeedFactor; // 霧の流れに乗って漂う (〜15u/s)
            if ((f.life -= gameSpeedFactor) <= 0 || Math.hypot(f.x - MAP_CX, f.y - MAP_CY) > MAP_RADIUS - 1000) { _fieldGone(i); continue; }
        } else if (f.kind === 'storm') {
            if ((f.flip -= gameSpeedFactor) <= 0) { f.on = !f.on; f.flip = 180 + Math.random() * 300; } // 3〜8秒ごとに明滅
        }
        // 寄って見れば正体が分かる (有視界の内・2500u以内)
        const id = _sigIdent[f.sid];
        if (player && player.hp > 0 && !(id && id.sure) && Math.hypot(f.x - player.x, f.y - player.y) < FIELD_IDENT_R && inPlayerVision(f.x, f.y)) {
            identSure(f.sid, false); _sigIdent[f.sid].lbl = FIELD_KINDS[f.kind].lbl;
            if (_contactLabels[f.sid]) logMessage('SIGNAL: SIG-' + String(_contactLabels[f.sid]).padStart(2, '0') + ' は' + FIELD_KINDS[f.kind].lbl + (f.kind === 'cache' ? ' — 近くに留まれば回収できる' : ' — 艦ではない'), 'system-msg');
        }
        if (f.kind !== 'cache') continue;
        // 回収 (400u以内に3秒。双方が居る間は進まない)
        const pNear = player && player.hp > 0 && !player._dying && Math.hypot(f.x - player.x, f.y - player.y) < CACHE_R;
        let eNear = null;
        for (const e of enemies) if (e.hp > 0 && !e._dying && e.type !== 'fighter' && Math.hypot(f.x - e.x, f.y - e.y) < CACHE_R) { eNear = e; break; }
        if (pNear && !eNear) {
            f.takeP += gameSpeedFactor;
            if (f.takeP >= CACHE_TIME) { if (collectCacheByPlayer(f)) { identSure(f.sid, false); _fieldGone(i); continue; } }
        } else if (f.takeP > 0) f.takeP = Math.max(0, f.takeP - gameSpeedFactor * 2);
        else if (f.takeP < 0) f.takeP = Math.min(0, f.takeP + gameSpeedFactor);
        if (eNear && !pNear) {
            f.takeE += gameSpeedFactor;
            if (f.takeE >= CACHE_TIME) { collectCacheByEnemy(eNear, f); if (eNear._roam === 'cache') { eNear._roam = null; eNear.state = 'idle'; } _fieldGone(i); continue; }
        } else f.takeE = Math.max(0, f.takeE - gameSpeedFactor * 2);
    }
}
// 敵が聞いた自然/お宝の信号へ向かうか (信号ごとに一度だけ決める)。
// 簡略: 敵はお宝 (帯域が平坦で止まっている) と自然の信号をおおよそ見分ける — お宝へは 30%+貪欲さ×60%、自然へは 12% (実装で決めた値)
function enemyFieldPick(e, pers) {
    const seen = e._fdSeen || (e._fdSeen = {});
    let best = null, bd = Infinity;
    for (const f of fieldSignals) {
        if (seen[f.sid]) continue;
        const d = Math.hypot(f.x - e.x, f.y - e.y);
        const s = fieldMaxSig(f) * Math.max(0, 1 - d / ENEMY_PASSIVE_RANGE) * (1 - getHiggsIntensity((f.x + e.x) / 2, (f.y + e.y) / 2) * 0.3);
        if (s < 0.08) continue;
        seen[f.sid] = true;
        const go = Math.random() < (f.kind === 'cache' ? 0.3 + (pers.greed || 0) * 0.6 : 0.12);
        if (go && d < bd) { bd = d; best = f; }
    }
    return best;
}
// ── 監視網の円 (シグネチャサークル): 自分のノード/コロニーから4000u以内で、相手のいちばん強い帯域が0.45以上を3秒続けたら、
//    10秒ごとに50%の確率で「半径1500uの円のどこか」(中心は真の位置から最大900uずれる)。20秒残る。自機/敵とも同じ
const SIGZ_R = 4000, SIGZ_TH = 0.45, SIGZ_HOLD = 180, SIGZ_PERIOD = 600, SIGZ_P = 0.5, SIGZ_RAD = 1500, SIGZ_OFF = 900, SIGZ_LIFE = 1200;
const COLONY_RELAY_RANGE = 8000;
function listeningPosts(side) {
    const out = [];
    for (const n of resourceNodes) if (n.owner === side) out.push({ o: n, x: n.x, y: n.y, R: NODE_RELAY_RANGE, lbl: 'ノード' });
    for (const st of structures) if (st.type === 'colony' && st.owner === side) out.push({ o: st, x: st.x, y: st.y, R: COLONY_RELAY_RANGE, lbl: 'コロニー' });
    return out;
}
function _maxBandSig(t) { let m = 0; for (const b of BANDS) m = Math.max(m, sensorConfig[b].sig(t) || 0); return m; }
function _sigZoneRoll(t, posts) {
    const near = posts.some(p => Math.hypot(t.x - p.x, t.y - p.y) < SIGZ_R);
    if (near && _maxBandSig(t) >= SIGZ_TH) t._szT = (t._szT || 0) + gameSpeedFactor; else t._szT = 0;
    if (t._szT < SIGZ_HOLD || _frameCount - (t._szLast || -1e9) < SIGZ_PERIOD) return null;
    t._szLast = _frameCount;
    if (Math.random() >= SIGZ_P) return null;
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * SIGZ_OFF;
    return { x: t.x + Math.cos(a) * r, y: t.y + Math.sin(a) * r };
}
function updateSigZones() {
    for (let i = sigZones.length - 1; i >= 0; i--) if ((sigZones[i].life -= gameSpeedFactor) <= 0) sigZones.splice(i, 1);
    if (!player || player.hp <= 0) return;
    // 自機の監視網 → 敵艦
    const pp = listeningPosts('player');
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
        const c = pp.length ? _sigZoneRoll(e, pp) : (e._szT = 0, null);
        if (!c) continue;
        const sid = enemySid(e);
        if (!_contactLabels[sid]) _contactLabels[sid] = _contactLabelNext++;
        sigZones.push({ side: 'p', x: c.x, y: c.y, r: SIGZ_RAD, life: SIGZ_LIFE, sid });
        const deg = compassDeg(Math.atan2(c.y - player.y, c.x - player.x));
        ringMarkBearing(deg, '#ff8ce0');
        logMessage('監視網: SIG-' + String(_contactLabels[sid]).padStart(2, '0') + ' の強いシグネチャ — 方位' + deg + '° ' + Math.round(Math.hypot(c.x - player.x, c.y - player.y) / 100) * 100 + 'u の円のどこか', 'warning-msg');
        matchRecEvent('zoneP', c.x, c.y, '監視網の円 (敵艦)');
        if (comDemo) comThinkEvent('p', '監視網の円 SIG-' + String(_contactLabels[sid]).padStart(2, '0') + ' (' + _dirTxt(player.x, player.y, c.x, c.y) + ')');
    }
    // 敵の監視網 → 自艦 (敵には円が渡り、そこへ向かう。自艦には見えない)
    const ep = listeningPosts('enemy');
    const c = ep.length ? _sigZoneRoll(player, ep) : (player._szT = 0, null);
    if (c) {
        sigZones.push({ side: 'e', x: c.x, y: c.y, r: SIGZ_RAD, life: SIGZ_LIFE, sid: null });
        matchRecEvent('zoneE', c.x, c.y, '敵の監視網の円 (自艦)');
        for (const e of enemies) {
            if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
            if (e.inVision || (e.contactFreshness || 0) > 0.6) continue; // もっと良い手掛かりがある
            e.playerLastKnownPos = { x: c.x, y: c.y, vx: 0, vy: 0 };
            e.contactFreshness = Math.max(e.contactFreshness || 0, 0.6);
            if (e.aiState === 'lurking' || e.aiState === 'gathering') { e.aiState = 'hunting'; e.huntTimer = 900; }
            if (comDemo) comThinkEvent('e', '監視網の円 — 自機は ' + _dirTxt(e.x, e.y, c.x, c.y) + ' の半径1500uのどこか', 'e' + e.uid);
        }
    }
}
function drawSigZones(ctx) {
    const inv = 1 / camera.zoom;
    for (const z of sigZones) {
        if (z.side !== 'p' && !higgsViewOff) continue;
        const a = Math.min(1, z.life / 300) * (z.side === 'p' ? 1 : 0.5);
        ctx.save();
        ctx.globalAlpha = 0.06 * a; ctx.fillStyle = '#ff8ce0';
        ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.7 * a; ctx.strokeStyle = '#ff8ce0'; ctx.lineWidth = 1.4 * inv;
        ctx.setLineDash([4 * inv, 7 * inv]);
        ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        if (z.sid) {
            ctx.font = 'bold ' + Math.round(11 * inv) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#ff8ce0';
            ctx.fillText('SIG-' + String(_contactLabels[z.sid] || '?').padStart(2, '0') + ' 監視網', z.x, z.y - z.r - 4 * inv);
        }
        ctx.restore();
    }
}
// 自然/お宝の信号の実体 (有視界の内か、ヒッグス表示OFFの時だけ描く)
function drawFieldSignals(ctx) {
    const inv = 1 / camera.zoom, t = _frameCount / 60;
    for (const f of fieldSignals) {
        if (!higgsViewOff && !(player && inPlayerVision(f.x, f.y))) continue;
        const k = FIELD_KINDS[f.kind], fade = Math.min(1, f.age / FIELD_FADE, f.life / FIELD_FADE);
        ctx.save();
        if (f.kind === 'cloud') {
            ctx.fillStyle = '#50c8ff';
            for (let j = 0; j < 4; j++) { const ang = f.ph + j * 1.6 + t * 0.1; ctx.globalAlpha = 0.07 * fade; ctx.beginPath(); ctx.arc(f.x + Math.cos(ang) * 160, f.y + Math.sin(ang) * 120, 260 + j * 40, 0, Math.PI * 2); ctx.fill(); }
        } else if (f.kind === 'storm') {
            ctx.strokeStyle = '#c08cff'; ctx.lineWidth = 2 * inv; ctx.globalAlpha = f.on ? 0.8 : 0.15;
            ctx.beginPath(); ctx.arc(f.x, f.y, 120, 0, Math.PI * 2); ctx.stroke();
            if (f.on) { ctx.beginPath(); let x = f.x, y = f.y; ctx.moveTo(x, y); for (let j = 0; j < 5; j++) { x += Math.cos(f.ph + j * 2.1 + t * 7) * 90; y += Math.sin(f.ph + j * 1.3 + t * 5) * 90; ctx.lineTo(x, y); } ctx.stroke(); }
        } else if (f.kind === 'vent') {
            ctx.fillStyle = '#ff8232'; ctx.globalAlpha = 0.18 + 0.1 * Math.sin(t * 2 + f.ph);
            ctx.beginPath(); ctx.arc(f.x, f.y, 180, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(f.x, f.y, 50, 0, Math.PI * 2); ctx.fill();
        } else {
            const h = Math.max(40, 9 * inv);
            ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffe18c'; ctx.lineWidth = 2 * inv;
            ctx.strokeRect(f.x - h, f.y - h * 0.7, h * 2, h * 1.4);
            ctx.beginPath(); ctx.moveTo(f.x - h, f.y); ctx.lineTo(f.x + h, f.y); ctx.stroke();
            if (f.takeP > 0) { ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(f.x, f.y, CACHE_R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, f.takeP / CACHE_TIME)); ctx.stroke(); }
            ctx.globalAlpha = 0.35; ctx.setLineDash([6 * inv, 8 * inv]); ctx.beginPath(); ctx.arc(f.x, f.y, CACHE_R, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.globalAlpha = 0.85; ctx.fillStyle = k.cs || (k.cs = 'rgb(' + k.col + ')');
        ctx.font = Math.round(10 * inv) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(k.lbl, f.x, f.y + Math.max(70, 14 * inv));
        ctx.restore();
    }
}
// 制圧したノード = 聴音局。周囲の機動する発信源の方位を送ってくる (観測点が増える = 交点が早く締まる)
function relayListen() {
    for (const post of listeningPosts('player')) { // 第31弾: 占有したコロニーも聴音局 (8000u)
        const n = post.o, RR = post.R;
        for (const e of enemies) {
            if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
            const d = Math.hypot(e.x - n.x, e.y - n.y);
            if (d > RR) continue;
            let s0 = 0;
            for (const b of BANDS) s0 = Math.max(s0, sensorConfig[b].sig(e) || 0);
            const sig = s0 * (1 - d / RR) * (1 - getHiggsIntensity((e.x + n.x) / 2, (e.y + n.y) / 2) * 0.5);
            if (sig < 0.12) continue;
            const conf = Math.min(1, (sig - 0.12) / 0.5);
            const sigma = (0.012 + 0.03 * (1 - conf)) * clutterErrMult(clutterCount(e.x, e.y, e)); // 第18弾: 混信
            const ang = Math.atan2(e.y - n.y, e.x - n.x) + _gauss() * sigma;
            const sid = enemySid(e);
            if (!_contactLabels[sid]) _contactLabels[sid] = _contactLabelNext++;
            const sa = addBearingObs(sid, n.x, n.y, ang, sigma, sig, '120,210,255');
            if (sid === lockedSignalId) { solveFix(sa); applyTrackContact(e, sa); } else sa.dirty = true;
            passiveBearings.push({ ox: n.x, oy: n.y, angle: ang, halfWidth: Math.max(0.02, sigma * 2), range: RR, quality: conf,
                color: '120,210,255', sensor: 'higgs', strength: sig, sensorLabel: '聴音局', bearingDeg: compassDeg(ang),
                halfWidthDeg: Math.round(sigma * 360 / Math.PI), sourceId: sid, contactNo: _contactLabels[sid],
                life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE, relay: true });
            if (!n._heard || _frameCount - n._heard > 1800) {
                n._heard = _frameCount;
                logMessage(`聴音局: ${post.lbl}が SIG-${String(_contactLabels[sid]).padStart(2, '0')} を捕捉 — 追跡すると推定に方位線が加わる`, 'system-msg');
            }
        }
    }
}
// 敵がノードを制圧 (自機と同じく近くに留まる)。自分の聴音局を奪われた時だけ通信途絶で分かる
function enemyCaptureNode(e, n) {
    const wasMine = n.owner === 'player';
    n.owner = 'enemy'; n.capP = 0; n.emFlashTimer = 120;
    if (!n._partE) { n._partE = true; enemyOfferDraft(e, 'node', n.x, n.y); } // 第33弾: 敵も初めて制圧したノードで部品
    matchRecEvent('nodeE', n.x, n.y, '敵がノードを制圧');
    if (wasMine) { n.knownLost = true; logMessage('聴音局: ノードとの通信途絶 — 敵に制圧された。敵の耳になる', 'warning-msg'); }
}

// 方位の記録を1本足す。同じ場所(180u・4秒以内)の再観測は1本にまとめて誤差を√nで縮める。
// 第16弾: 自艦と聴音局(ノード)の記録が交互に入るので、直前の1本だけでなく最近の数本から同じ場所のものを探す
// ═══ 第23弾 (オーナー合意): 信号の識別 — 受信した信号は最初「不明」。追跡すると手掛かりが溜まって「艦影n%」になる ═══
// 手掛かり (どれも観測から。ゆらぎがあるので必ず見破れるとは限らない):
//   帯域の比 (2帯域以上で聴いた時): 艦は帯域ごとにむらがある / 偽艦影・ノイズは4帯域が平坦
//   動き (速度つきの解が出た時): 艦らしい速さ / 遅く一定 (偽艦影の漂流) / 速すぎて直進 (ノイズメーカー・艦載機)
//   探信の反響 (ソナーの点が入った時): 艦は大きい / 囮・艦載機は小さい
//   有視界で見えた=確定・400u以内=正体が分かる
// ═══ 第29弾 (オーナー合意): 解析には時間と量が要る — 推定円は「解析量」で決まる下限より小さくならない ═══
// 解析量は方位を受けるたびに貯まる。1秒あたりの演算力 (1 + コロニー1つごとに+35%・最大3つ) を受信中の信号で分け合う
// (追跡中の信号に半分・残りを他で等分)。強い信号ほど・場所を変えて聴いた方位ほど多く貯まる (実装で決めた値)。
// 下限 = 距離 × (12% + 88%×exp(−解析量/6))。近づくだけでは絞れない / 囮やノイズメーカーは演算力を食う。敵も同じ式
const ANA_MIN = 0.12, ANA_TAU = 6, ANA_COLONY = 0.35, ANA_NEWPOS = 1.5;
function analysisPower(side) { let ea = 0; if (side !== 'player') for (const e of enemies) if (e.pm && e.hp > 0) ea = Math.max(ea, e.pm.ana); return 1 + ANA_COLONY * Math.min(3, coloniesOwned(side)) + (side === 'player' ? PM.ana : ea); } // 第32弾: 解析コア (第33弾: 敵も)
function anaFloorFrac(ana) { return ANA_MIN + (1 - ANA_MIN) * Math.exp(-(ana || 0) / ANA_TAU); }
function anaPct(ana) { return Math.round((1 - (anaFloorFrac(ana) - ANA_MIN) / (1 - ANA_MIN)) * 100); }
const _RX_WORD = { heat: '熱源', optic: '光', em: '電磁波', higgs: '霧の乱れ' };
const IDENT_MIN_N = 3, IDENT_WARN_P = 0.4;
const _sigIdent = {}; // sid → { L:対数オッズ(艦影), n:手掛かりの数, why:{理由:重み}, pingF }
function _identTruth(sid) {
    if (/^e-/.test(sid)) { const e = enemyBySid(sid); return !e ? null : e.type === 'fighter' ? 'small' : 'ship'; }
    const L = lures.find(l => l.sid === sid);
    if (L) return L.noise ? 'noise' : 'lure';
    const F = /^N-/.test(sid) ? fieldSignals.find(f => f.sid === sid) : null; // 第31弾
    return F ? (F.kind === 'cache' ? 'cache' : 'nature') : null;
}
function _identAdd(id, mean, sd, w, why) {
    const v = (mean + _gauss() * sd) * w;
    id.L = Math.max(-5, Math.min(5, id.L + v)); id.n++;
    if (why && mean < 0 && v < 0) id.why[why] = (id.why[why] || 0) - v;
}
function identStep(sid, tracked, nBands, sa, wOverride) {
    const truth = _identTruth(sid);
    if (!truth) return;
    const id = _sigIdent[sid] || (_sigIdent[sid] = { L: 0, n: 0, why: {}, pingF: -1, motF: -1 });
    if (id.sure) return;
    const w = wOverride !== undefined ? wOverride : (tracked ? 1 : 0.35);
    const ship = truth === 'ship';
    if (nBands >= 2) _identAdd(id, ship ? 0.22 : truth === 'small' ? -0.08 : truth === 'nature' ? -0.2 : -0.16, 0.40, w, truth === 'small' ? null : '帯域が平坦');
    else if (truth === 'nature' && sensorOrder.length >= 2) _identAdd(id, -0.3, 0.3, w, '1つの帯域だけ'); // 第31弾: 自然の信号は1つの帯域に偏る
    else _identAdd(id, ship ? 0.05 : -0.04, 0.2, w, null);
    if (sa && sa.motion && sa.motion.stable && _frameCount - id.motF > 300) {
        id.motF = _frameCount;
        _identAdd(id, ship ? 0.5 : -0.6, 0.5, 1, truth === 'lure' ? '遅く一定の動き' : truth === 'noise' ? '速すぎてまっすぐ' : truth === 'small' ? '速すぎる' : null);
    }
    if (sa && sa.ping && sa.ping.f !== id.pingF && _frameCount - sa.ping.f < 180) {
        id.pingF = sa.ping.f;
        _identAdd(id, ship ? 1.6 : truth === 'small' || truth === 'cache' ? -1.2 : -1.6, 0.6, 1, '探信の反響が小さい');
    }
}
function identSure(sid, isShip) { const id = _sigIdent[sid] || (_sigIdent[sid] = { L: 0, n: 0, why: {}, pingF: -1, motF: -1 }); id.L = isShip ? 6 : -6; id.n = 99; id.sure = true; }
// 表示: {p, txt:'不明'|'艦影70%'|'囮/小型? 理由', low}
function identInfo(sid) {
    const id = _sigIdent[sid];
    if (!id || id.n < IDENT_MIN_N) return { p: 0.5, txt: '不明', short: '不明', low: true, known: false };
    const p = 1 / (1 + Math.exp(-id.L));
    if (id.sure) return { p, txt: p > 0.5 ? '艦影 (確認)' : (id.lbl || '囮') + ' (確認)', short: p > 0.5 ? '艦影' : (id.lbl || '囮'), low: p <= 0.5, known: true };
    let why = '', wb = 0; for (const k in id.why) if (id.why[k] > wb) { wb = id.why[k]; why = k; }
    const pc = Math.round(p * 100);
    return { p, txt: '艦影' + pc + '%' + (p < IDENT_WARN_P && why ? ' (' + why + ')' : ''), short: '艦' + pc + '%', low: p < IDENT_WARN_P, known: true };
}
function addBearingObs(sid, ox, oy, angle, sigma, strength, colorRgb) {
    if (!_signalAnalysis[sid]) _signalAnalysis[sid] = _newSignalAnalysis();
    const sa = _signalAnalysis[sid];
    let lo = null;
    for (let i = sa.obs.length - 1; i >= Math.max(0, sa.obs.length - 4); i--) {
        const o = sa.obs[i];
        if (Math.hypot(ox - o.ox, oy - o.oy) < TMA_MERGE_D && _frameCount - o.f0 < 240) { lo = o; break; }
    }
    if (lo) {
        lo.n++;
        lo.sx += Math.cos(angle) / (sigma * sigma); lo.sy += Math.sin(angle) / (sigma * sigma); lo.sw += 1 / (sigma * sigma);
        lo.ang = Math.atan2(lo.sy, lo.sx);
        lo.sig = 1 / Math.sqrt(lo.sw);
        lo.f = _frameCount;
        lo.st = strength;
    } else {
        sa.obs.push({ ox, oy, ang: angle, sig: sigma, f: _frameCount, f0: _frameCount, n: 1, st: strength,
                      sx: Math.cos(angle) / (sigma * sigma), sy: Math.sin(angle) / (sigma * sigma), sw: 1 / (sigma * sigma), c: colorRgb });
    }
    while (sa.obs.length > TMA_MAXOBS || (sa.obs.length && _frameCount - sa.obs[0].f > TMA_KEEP)) sa.obs.shift();
    return sa;
}

function checkPassiveDetection() {
    passiveCheckTimer++;
    if (passiveCheckTimer < 60) return; // 1秒ごとに1計測
    passiveCheckTimer = 0;
    if (!player || player.hp <= 0) return;

    // 新しい方位が入らない間、推定の幅は時間とともに広がる (相手は動けるので古い交点ほど当てにならない)
    for (const sid in _signalAnalysis) {
        const fsa = _signalAnalysis[sid];
        if (!fsa.fix) continue;
        const lo = fsa.obs[fsa.obs.length - 1];
        if (lo && _frameCount - lo.f > 120) {
            fsa.fix.r += 35;
            if (fsa.fix.r > 14000) fsa.fix = null;
            else { const fe = enemyBySid(sid); if (fe && !fe.inVision && fe.trackR) fe.trackR = fsa.fix.r; }
        }
    }

    relayListen(); // 第16弾: 聴音局(制圧したノード)からの方位
    const range = passiveRange();
    const noise = playerSelfNoise() * PM.noiseHear; // 第32弾: 曳航アレイ
    const sensorPrec = 0.45 + (genAlloc.sensors / 100) * 0.55;

    // 第21弾: ONの帯域すべてで聴き、敵ごとに一番よく聴こえた帯域で方位を取る
    const allContacts = [];
    for (const e of enemies) {
        if (e.hp <= 0) continue;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        if (e.type === 'fighter' && dist > 2500) continue; // 艦載機は小さく静か — 近くでないと聴こえない (方位で追う相手ではない)
        const hPath = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
        const distAtten = Math.max(0, 1 - dist / range);
        let best = null, bestQ = 0, nb = 0;
        for (const b of sensorOrder) {
            const sc = sensorConfig[b];
            const sig = sc.sig(e) * distAtten * (1 - hPath * sc.higgsMod) * (1 - noise * 0.5);
            const q = sig / sc.threshold;
            if (sig > sc.threshold * 0.5) nb++;
            if (sig > sc.threshold * 0.5 && q > bestQ) { bestQ = q; best = { band: b, sig }; }
        }
        if (best) {
            allContacts.push({ x: e.x, y: e.y, sig: best.sig, band: best.band, nb, angle: Math.atan2(e.y - player.y, e.x - player.x), sourceId: enemySid(e), clN: e.type === 'fighter' ? 0 : clutterCount(e.x, e.y, e), ecm: epm(e).ecm });
            if (huntStats && huntStats.firstContact < 0) huntStats.firstContact = _frameCount - huntStats.startFrame; // 戦闘詳報: 初接触
        }
    }
    // 第21弾: 敵の偽艦影ブイも艦と同じように聴こえる (区別はつかない)
    for (const L of lures) {
        if (L.owner !== 'e' || L.kind !== 'ship' || L.phase !== 'on') continue;
        const dist = Math.hypot(L.x - player.x, L.y - player.y);
        if (dist >= range) continue;
        const hPath = getHiggsIntensity((L.x + player.x) / 2, (L.y + player.y) / 2);
        let best = null, bestQ = 0, nb = 0;
        for (const b of sensorOrder) {
            const sc = sensorConfig[b];
            const sig = LURE_SIG * Math.min(1, L.life / 60) * (1 - dist / range) * (1 - hPath * sc.higgsMod) * (1 - noise * 0.5);
            if (sig > sc.threshold * 0.5) nb++;
            if (sig > sc.threshold * 0.5 && sig / sc.threshold > bestQ) { bestQ = sig / sc.threshold; best = { band: b, sig }; }
        }
        if (best) allContacts.push({ x: L.x, y: L.y, sig: best.sig, band: best.band, nb, angle: Math.atan2(L.y - player.y, L.x - player.x), sourceId: L.sid, clN: 0 });
    }
    // 第31弾: 自然の信号・お宝の信号も同じ物理で聴こえる (ONの帯域だけ方位が取れる)
    for (const f of fieldSignals) {
        const dist = Math.hypot(f.x - player.x, f.y - player.y);
        if (dist >= range) continue;
        const hPath = getHiggsIntensity((f.x + player.x) / 2, (f.y + player.y) / 2);
        let best = null, bestQ = 0, nb = 0;
        for (const b of sensorOrder) {
            const sc = sensorConfig[b];
            const sig = fieldSig(f, b) * (1 - dist / range) * (1 - hPath * sc.higgsMod) * (1 - noise * 0.5);
            if (sig > sc.threshold * 0.5) nb++;
            if (sig > sc.threshold * 0.5 && sig / sc.threshold > bestQ) { bestQ = sig / sc.threshold; best = { band: b, sig }; }
        }
        if (best) allContacts.push({ x: f.x, y: f.y, sig: best.sig, band: best.band, nb, angle: Math.atan2(f.y - player.y, f.x - player.x), sourceId: f.sid, clN: 0 });
    }
    if (allContacts.length === 0) return;

    // 強い順に最大4件 + 追跡中の信号 (第31弾: 自然/お宝の信号が増えたので3→4)
    allContacts.sort((a, b) => b.sig - a.sig);
    const picks = allContacts.slice(0, 4);
    if (lockedSignalId && !picks.some(c => c.sourceId === lockedSignalId)) {
        const _lc = allContacts.find(c => c.sourceId === lockedSignalId);
        if (_lc) picks.push(_lc);
    }

    let _newSig = null; // このサイクルで新たに(または10秒ぶりに)受信した信号
    // 第29弾: 演算力を受信中の信号で分け合う (追跡中に半分・残りを等分)
    const _anaB = analysisPower('player'), _hasLock = picks.some(c => c.sourceId === lockedSignalId);
    const _shareOf = (sid) => _hasLock ? (sid === lockedSignalId ? (picks.length > 1 ? 0.5 : 1) : 0.5 / (picks.length - 1)) : 1 / picks.length;
    for (const sid in _signalAnalysis) { // 記録が消えたら解析量も無し / 30秒聞こえなければ少しずつ薄れる
        const sa0 = _signalAnalysis[sid], lo0 = sa0.obs && sa0.obs[sa0.obs.length - 1];
        if (!lo0) sa0.ana = 0; else if (_frameCount - lo0.f > 1800) sa0.ana = (sa0.ana || 0) * 0.95;
    }
    for (const c of picks) {
        const sc = sensorConfig[c.band], thr = sc.threshold, colorRgb = sc.r;
        const conf = Math.max(0, Math.min(1, (c.sig - thr * 0.5) / (1 - thr * 0.5)));
        const tracked = c.sourceId === lockedSignalId;
        // 方位誤差(1σ, rad): 強い信号ほど・静かなほど・追跡(狭帯域処理)中ほど鋭い
        const sigma = (0.005 + 0.035 * (1 - conf)) * (1 + 2 * noise) * (tracked ? 1 : 2.2)
                    / (0.6 + 0.4 * sensorPrec) / (1 + aiPrec('sensor') * 0.8) * clutterErrMult(c.clN || 0) * (c.ecm || 1); // 第18弾: 混信 (第33弾: 敵のECM)
        const angle = c.angle + _gauss() * sigma;
        const compassDeg = Math.round((Math.atan2(Math.cos(angle), -Math.sin(angle)) * 180 / Math.PI + 360) % 360);
        if (!_contactLabels[c.sourceId]) _contactLabels[c.sourceId] = _contactLabelNext++;
        const halfWidth = Math.max(0.02, Math.min(0.86, sigma * 2));
        passiveBearings.push({
            ox: player.x, oy: player.y,
            angle, halfWidth, range,
            quality: conf, color: colorRgb,
            sensor: c.band, strength: c.sig, sensorLabel: sc.label,
            bearingDeg: compassDeg, halfWidthDeg: Math.round(halfWidth * 180 / Math.PI),
            sourceId: c.sourceId,
            contactNo: _contactLabels[c.sourceId],
            life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
        });
        // 方位の記録 (推定位置の材料)
        const _n0 = (_signalAnalysis[c.sourceId] && _signalAnalysis[c.sourceId].obs.length) || 0;
        const sa = addBearingObs(c.sourceId, player.x, player.y, angle, sigma, c.sig, colorRgb);
        const _share = _shareOf(c.sourceId);
        sa.ana = (sa.ana || 0) + _anaB * _share * (0.5 + 0.5 * conf) * (sa.obs.length > _n0 ? ANA_NEWPOS : 1); // 第29弾: 解析量
        solveFix(sa); // 第26弾: 追跡していない信号も解く (地図に複数の推定円を出すため。追跡中は方位が鋭いので円も小さい)
        identStep(c.sourceId, tracked, c.nb || 1, sa, Math.max(0.2, Math.min(2, _anaB * _share * 2))); // 第23弾: 識別の手掛かり (第29弾: 演算力の取り分で速さが変わる)
        if (tracked) {
            const _te = enemyBySid(c.sourceId);
            if (_te && _te.hp > 0 && !_te._dying) applyTrackContact(_te, sa);
        }
        const _last = _passiveLastSeen[c.sourceId];
        if ((_last === undefined || _frameCount - _last > 600) && (!_newSig || c.sig > _newSig.sig))
            _newSig = { sig: c.sig, sid: c.sourceId, deg: compassDeg, label: sc.label, band: c.band };
        _passiveLastSeen[c.sourceId] = _frameCount;
    }
    while (passiveBearings.length > PASSIVE_BEARING_MAX) passiveBearings.shift();

    passiveAlertTimer = 180;
    if (_newSig) {
        logMessage(`RX: 方位${_newSig.deg}° ${_RX_WORD[_newSig.band] || '信号'}感知 — SIG-${String(_contactLabels[_newSig.sid]).padStart(2, '0')} (${identInfo(_newSig.sid).txt})`, 'warning-msg');
        const ind = document.getElementById('passive-indicator');
        if (ind) { ind.classList.add('alert'); setTimeout(() => ind.classList.remove('alert'), 3000); }
    }
}

const UNTRACKED_LINES = 2, TRACK_LINES_MAX = 8, TRACK_LINE_MERGE = 400; // 第18弾: 表示の整理 (オーナー合意 2026-10-25)
function drawPassiveBearings(ctx) {
    const invZoom = 1 / camera.zoom;
    // 追跡していない信号: 最新の方位を短い破線で1本だけ (「何かがあっちに居る」)。
    // 第18弾: 線を引くのは強い方から2つだけ (艦載機が群がると破線が飛び交って読めなかった)。残りは自艦リングの点で示す
    const _seen = {}, _latest = [];
    for (let i = passiveBearings.length - 1; i >= 0; i--) {
        const b = passiveBearings[i];
        if (b.life <= 0 || b.sourceId === lockedSignalId || _seen[b.sourceId] || b.relay) continue;
        _seen[b.sourceId] = true;
        _latest.push(b);
    }
    _latest.sort((p, q) => (q.strength || 0) - (p.strength || 0));
    for (let k = 0; k < Math.min(UNTRACKED_LINES, _latest.length); k++) {
        const b = _latest[k];
        const vis = (b.life / b.maxLife) * Math.min(1, (b.maxLife - b.life) / 45);
        ctx.save();
        ctx.globalAlpha = 0.4 * vis;
        ctx.strokeStyle = b.cs || (b.cs = 'rgb(' + b.color + ')'); // 色文字列は1回だけ作る (GC抑制)
        ctx.lineWidth = 1.2 * invZoom;
        ctx.setLineDash([10 * invZoom, 10 * invZoom]);
        ctx.beginPath(); ctx.moveTo(b.ox, b.oy); ctx.lineTo(b.ox + Math.cos(b.angle) * b.range * 0.35, b.oy + Math.sin(b.angle) * b.range * 0.35); ctx.stroke();
        ctx.restore();
    }
    // 追跡中の信号: 記録した方位線 (第15弾)。線が交わる所に相手が居る — 交わらなければ相手は動いている。
    // 第18弾: 近い場所(400u以内)で聴いた線は新しい1本で代表させ、最大8本。長さは推定位置の少し先まで
    // (旧: 最大24本を推定位置の2500u先まで描き、同じ所で聴いた平行な線が束になって読めなかった。解析はすべての記録を使う)
    const sa = lockedSignalId ? _signalAnalysis[lockedSignalId] : null;
    if (!sa || !sa.obs.length) return;
    const now = _frameCount;
    const fx = sa.fix;
    const pick = [];
    for (let i = sa.obs.length - 1; i >= 0 && pick.length < TRACK_LINES_MAX; i--) {
        const o = sa.obs[i];
        if (pick.some(q => Math.hypot(q.ox - o.ox, q.oy - o.oy) < TRACK_LINE_MERGE)) continue;
        pick.push(o);
    }
    ctx.save();
    for (let k = pick.length - 1; k >= 0; k--) {
        const o = pick[k];
        const rec = Math.exp(-(now - o.f) / TMA_TAU);
        const newest = k === 0;
        const L = fx ? Math.hypot(fx.x - o.ox, fx.y - o.oy) + Math.max(600, fx.r) : passiveRange() * 0.9;
        ctx.globalAlpha = (newest ? 0.75 : 0.15 + 0.45 * rec);
        ctx.strokeStyle = o.cs || (o.cs = 'rgb(' + (o.c || '0,255,170') + ')');
        ctx.lineWidth = (newest ? 1.8 : 1.1) * invZoom;
        ctx.beginPath(); ctx.moveTo(o.ox, o.oy); ctx.lineTo(o.ox + Math.cos(o.ang) * L, o.oy + Math.sin(o.ang) * L); ctx.stroke();
        // 観測点 (どこで聴いたか)
        ctx.globalAlpha *= 0.8;
        ctx.beginPath(); ctx.arc(o.ox, o.oy, 3.5 * invZoom, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
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
// §4-4: 三角測量精度円描画 (ワールド空間)
// 低精度=赤大円 / 中=橙 / 高=緑 / 超高=シアン
// 第26弾 (オーナー指示): 方角と距離がある程度割り出せた信号は全部「この円の中のどこか」で示す (追跡中以外も・複数同時)。
// 円の中心に目標が居るわけではない — 中心の十字は描かない。追跡中の信号だけ針路の矢印と見越し点を足す
const _circScreen = []; // 第27弾: 推定円のスクリーン座標 {sid, cx, cy, r} (タップで追跡)
function drawTriangulationCircle(ctx) {
    _circScreen.length = 0;
    for (const sid in _signalAnalysis) {
        const sa = _signalAnalysis[sid];
        if (!sa.fix) { sa.displayCenterX = null; continue; }
        const lo = sa.obs && sa.obs[sa.obs.length - 1];
        if (sid !== lockedSignalId && (!lo || _frameCount - lo.f > TMA_KEEP)) continue; // 古い記録の円は出さない
        _drawEstCircle(ctx, sid, sa, sid === lockedSignalId);
    }
}
function _drawEstCircle(ctx, sid, sa, locked) {
    // 第15弾: 記録した方位線の交点 (solveFix) をそのまま描く。真の位置とは無関係 — 外れていることもある
    // 第18弾: 運動解があれば推定位置は針路に沿って進む (円もそれに付いていく)
    const est = sa.fix ? trackEstimate(sa, 0) : null;
    if (!est) { sa.displayCenterX = null; return; }
    if (sa.displayCenterX == null) { sa.displayCenterX = est.x; sa.displayCenterY = est.y; sa.displayR = est.r; }
    const kc = est.moving ? 0.25 : 0.08;
    sa.displayCenterX += (est.x - sa.displayCenterX) * kc;
    sa.displayCenterY += (est.y - sa.displayCenterY) * kc;
    sa.displayR += (est.r - sa.displayR) * 0.06;
    const R = sa.displayR, cx = sa.displayCenterX, cy = sa.displayCenterY;
    // 幅で色分け: 広い=橙 / 撃てる幅(ミサイルの終末シーカーに収まる)=緑 / 精密=シアン
    const col = R > 2400 ? 'rgb(255,150,40)' : R > 900 ? 'rgb(255,220,90)' : R > 350 ? 'rgb(80,255,140)' : 'rgb(100,220,255)';
    const inv = 1 / camera.zoom;
    const fade = locked ? 1 : 0.6;
    { const sp = worldToScreen(cx, cy); _circScreen.push({ sid, cx: sp.sx, cy: sp.sy, r: R * camera.zoom }); }
    ctx.save();
    ctx.globalAlpha = 0.07 * fade;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.5 * fade;
    ctx.strokeStyle = col;
    ctx.lineWidth = (locked ? 1.6 : 1.1) * inv;
    ctx.setLineDash([12 * inv, 8 * inv]);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // 円の縁 (上) に「SIG-xx はこの円のどこか・艦影n%」— 中心に居るとは限らない
    {
        const fs = Math.round(11 * inv), idn = identInfo(sid);
        ctx.font = 'bold ' + fs + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.globalAlpha = 0.9 * fade; ctx.fillStyle = col;
        ctx.fillText('SIG-' + String(_contactLabels[sid] || '?').padStart(2, '0') + (idn.known ? ' ' + idn.short : ''), cx, cy - R - 4 * inv); // 第28弾: 説明書きは消す (オーナー)
    }
    if (!locked) { ctx.restore(); return; }
    ctx.globalAlpha = 0.85;
    ctx.font = 'bold ' + Math.round(11 * inv) + 'px Orbitron, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    // 第18弾: 推定した針路と速さ (10秒ぶんの矢印)。方位の記録だけから解いたもの — 外れていることもある
    if (est.moving) {
        const L = Math.hypot(est.vx, est.vy) * 600;
        if (L > 30 * inv) {
            const ux = est.vx / Math.hypot(est.vx, est.vy), uy = est.vy / Math.hypot(est.vx, est.vy);
            const tx = cx + ux * L, ty = cy + uy * L;
            ctx.globalAlpha = 0.8; ctx.lineWidth = 1.8 * inv;
            ctx.setLineDash([10 * inv, 6 * inv]);
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();
            ctx.setLineDash([]);
            const h = 12 * inv;
            ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - ux * h - uy * h * 0.5, ty - uy * h + ux * h * 0.5); ctx.lineTo(tx - ux * h + uy * h * 0.5, ty - uy * h - ux * h * 0.5); ctx.closePath();
            ctx.fillStyle = col; ctx.fill();
            ctx.fillText('針路' + compassDeg(Math.atan2(est.vy, est.vx)) + '° ' + Math.round(Math.hypot(est.vx, est.vy) * 60) + 'u/s', tx + 8 * inv, ty);
        }
    }
    // 第18弾: 見越し点 — 今の兵装で撃つと、弾が届く時刻にここに居るはず (射撃命令はここを狙う)
    const w = currentWeapon();
    const te = enemyBySid(sid);
    if (w !== 'beam' && te && !te.inVision) {
        const lp = leadPoint(sa, w);
        if (lp && Math.hypot(lp.x - cx, lp.y - cy) > 40 * inv) {
            const rr = 9 * inv;
            ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffe08a'; ctx.fillStyle = '#ffe08a'; ctx.lineWidth = 1.6 * inv;
            ctx.beginPath(); ctx.arc(lp.x, lp.y, rr, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(lp.x - rr * 1.7, lp.y); ctx.lineTo(lp.x - rr * 0.6, lp.y); ctx.moveTo(lp.x + rr * 0.6, lp.y); ctx.lineTo(lp.x + rr * 1.7, lp.y);
            ctx.moveTo(lp.x, lp.y - rr * 1.7); ctx.lineTo(lp.x, lp.y - rr * 0.6); ctx.moveTo(lp.x, lp.y + rr * 0.6); ctx.lineTo(lp.x, lp.y + rr * 1.7); ctx.stroke();
            ctx.globalAlpha = 0.5; ctx.setLineDash([4 * inv, 6 * inv]);
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(lp.x, lp.y); ctx.stroke(); ctx.setLineDash([]);
            ctx.globalAlpha = 0.9;
            ctx.fillText('見越し', lp.x + rr * 2, lp.y);
        }
    }
    ctx.restore();
}

// §4-4: 長押しラジアルメニュー表示/非表示
function showLongPressMenu(sx, sy) {
    const menu = document.getElementById('long-press-menu');
    if (!menu) return;
    // 第20弾: 出ている動くドローンの種類ごとに 哨戒 / 攻撃 / 帰還 の指示ボタン
    const box = document.getElementById('lpm-drones');
    if (box) {
        const counts = {};
        for (const d of playerDrones) if (d.hp > 0 && (d.type === 'attack' || d.type === 'mech' || d.type === 'scout')) counts[d.type] = (counts[d.type] || 0) + 1;
        const h = [];
        for (const t of ['attack', 'mech', 'scout']) {
            if (!counts[t]) continue;
            const o = droneOrders[t];
            h.push('<div class="lpm-drow"><span>' + DRONE_SPEC[t].label + '×' + counts[t] + '<small>' + (o ? (o.kind === 'patrol' ? '哨戒中' : '攻撃中') : '護衛中') + '</small></span>'
                + '<button data-t="' + t + '" data-k="patrol">哨戒</button><button data-t="' + t + '" data-k="attack">攻撃</button><button data-t="' + t + '" data-k="return">帰還</button></div>');
        }
        box.innerHTML = h.length ? '<div class="lpm-dhead">ドローン → この地点</div>' + h.join('') : '';
        // 第21弾: 囮 (積んでいれば・資材から作れれば) をこの地点へ
        const lb = document.getElementById('lpm-lures'), lh = [];
        if (lb) {
            for (const t of ['fsos', 'lure']) {
                if (!(SHIP_DRONES[gameState.shipType] || []).includes(t)) continue;
                const n = cargo.stock[t] || 0, can = n > 0 || (!cargo.asm && cargo.mat >= DRONE_SPEC[t].mat);
                if (can) lh.push('<button data-lure="' + t + '">' + DRONE_SPEC[t].label + (n > 0 ? '×' + n : '(資材)') + '</button>');
                else if (t === 'lure' && PM.lureFree && _lureFreeCD <= 0) lh.push('<button data-lure="lure">' + DRONE_SPEC.lure.label + '(発射機)</button>'); // 第32弾
            }
            if (PM.mine && cargo.ammoM > 0 && mines.length < MINE_MAX) lh.push('<button data-mine="1">機雷 (ここ=自艦の位置)</button>'); // 第32弾
            lb.innerHTML = lh.length ? '<div class="lpm-dhead">囮 → この地点</div><div class="lpm-drow">' + lh.join('') + '</div>' : '';
        }
        menu.style.width = (h.length || lh.length) ? '236px' : '108px';
    }
    menu.style.display = '';
    const vw = window.innerWidth, vh = window.innerHeight, mw = menu.offsetWidth || 108, mh = menu.offsetHeight || 130;
    let left = sx - mw / 2, top = sy - 90;
    if (left < 6) left = 6;
    if (left + mw > vw - 6) left = vw - mw - 6;
    if (top < 6) top = 6;
    if (top + mh > vh - 6) top = vh - mh - 6;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';
}
// 第20弾: ドローンへの指示 (種類ごと)。哨戒=その点の周りを周回 / 攻撃=その点へ向かい、見えた敵を撃つ / 帰還=自艦の護衛へ
function droneOrder(type, kind, x, y) {
    if (kind === 'return') { delete droneOrders[type]; logMessage('DRONE: ' + DRONE_SPEC[type].label + 'を帰還させる (自艦の護衛)', 'system-msg'); }
    else {
        droneOrders[type] = { kind, x, y };
        logMessage('DRONE: ' + DRONE_SPEC[type].label + 'に' + (kind === 'patrol' ? '哨戒' : '攻撃') + '指示 — 方位' + compassDeg(Math.atan2(y - player.y, x - player.x)) + '° ' + Math.round(Math.hypot(x - player.x, y - player.y) / 100) * 100 + 'u', 'system-msg');
        createClickEffect(x, y, kind === 'patrol' ? '#66ccff' : '#ff9966');
    }
    playSound('ui');
}
(() => {
    const lb = document.getElementById('lpm-lures');
    if (lb) lb.addEventListener('click', (ev) => {
        if (ev.target.closest('button[data-mine]')) { hideLongPressMenu(); if (!comDemo) placeMine(); return; } // 第32弾
        const b = ev.target.closest('button[data-lure]');
        if (!b || !_lpmWorld || !player) return;
        hideLongPressMenu();
        if (comDemo) return;
        deployDrone(b.dataset.lure, _lpmWorld.x, _lpmWorld.y);
    });
})();
(() => {
    const box = document.getElementById('lpm-drones');
    if (!box) return;
    box.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-t]');
        if (!b || !_lpmWorld || !player) return;
        hideLongPressMenu();
        if (comDemo) return;
        droneOrder(b.dataset.t, b.dataset.k, _lpmWorld.x, _lpmWorld.y);
    });
})();
function hideLongPressMenu() {
    const menu = document.getElementById('long-press-menu');
    if (menu) menu.style.display = 'none';
}
// 長押しメニュー「移動」選択
function lpmSelectMove() {
    hideLongPressMenu();
    if (!_lpmWorld || !player) return;
    if (comDemo) { logMessage('COM対戦デモ中は自機COMが操艦する (観戦のみ)', 'system-msg'); return; }
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
    // 第27弾: 射撃ボタンを撤去 — 長押しした点が推定円の内なら、その信号を追跡して射撃命令 (見越し点を狙う・実弾も撃てる)
    let hit = null, hd = Infinity;
    for (const sid in _signalAnalysis) {
        const sa = _signalAnalysis[sid]; if (!sa.fix) continue;
        const est = trackEstimate(sa, 0), d = Math.hypot(_lpmWorld.x - est.x, _lpmWorld.y - est.y);
        if (d <= est.r && d / est.r < hd) { hd = d / est.r; hit = sid; }
    }
    if (hit) { if (hit !== lockedSignalId) window._lockSignal(hit); issueFireOrder(); return; }
    freeFireAt(_lpmWorld.x, _lpmWorld.y);
}
function lpmSelectStop() {
    hideLongPressMenu();
    if (!player || player.hp <= 0) return;
    document.getElementById('btn-cancel')?.click();
}
function toggleAutoAttack() {
    document.getElementById('btn-attack-toggle')?.click();
    const m = document.getElementById('mm-autoatk'); if (m) m.textContent = '自動攻撃: ' + (autoAttackEnabled ? 'ON' : 'OFF');
}
// 第20弾: 座標への自由射撃 (右クリック / 長押し「射撃」共通)。ミサイル/ビームのみ・射角内のみ。
// ビームはチャージ専用 — 2秒溜めてから、その時の向きで撃つ (溜めている間は熱/EM/ヒッグスが漏れる)
function freeFireAt(wx, wy) {
    if (!player || player.hp <= 0) return;
    if (comDemo) return;
    if (player._weaponJamTimer > 0) { logMessage('WEP: 火器管制ダウン — 復旧まで発砲不能', 'warning-msg'); return; }
    const wType = document.getElementById('weapon-select')?.value;
    if (wType !== 'missile' && wType !== 'beam') { logMessage('WEP: 座標射撃はミサイル/ビームのみ有効', 'warning-msg'); return; }
    const ang = Math.atan2(wy - player.y, wx - player.x);
    const arc = WEAPON_FIRE_ARC[wType] || (Math.PI / 4);
    if (Math.abs(_angDiff(ang, player.angle)) > arc) { logMessage(`WEP: 射角外 — 艦首±${Math.round(arc * 180 / Math.PI)}°以内に向けてから発射`, 'warning-msg'); return; }
    if (player.fireCooldown > 0) return;
    const genF = Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
    if (wType === 'missile') {
        if (player.missileReloading) { logMessage('WEP: ミサイル リロード中 (' + Math.ceil(player.missileReloadTimer / 60) + '秒)', 'warning-msg'); return; }
        if (!useMissileAmmo()) return;
        const mp = new Projectile(player.x, player.y, { x: wx, y: wy, hp: 999, radius: 1 }, true, 'missile', 1.0);
        mp.ox = player.x; mp.oy = player.y;
        _armMirv(mp); // 第32弾
        projectiles.push(mp);
        playSound('shoot');
        cancelSilentRunning('発砲');
        player.fireCooldown = WEAPON_COOLDOWNS.missile * genF;
        player.missileReloading = true;
        player.missileReloadTimer = Math.round(MISSILE_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0) * PM.mslReload);
        player._fireFlash = 90; player._fireFlashType = 'missile'; player._lastFireType = 'missile'; player._lastFireF = _frameCount;
        logMessage('WEP: ミサイル座標射撃 — 自位置シグネチャ露出', 'warning-msg');
        return;
    }
    if (player.beamReloading) { logMessage('WEP: ビーム リロード中 (' + Math.ceil(player.beamReloadTimer / 60) + '秒)', 'warning-msg'); return; }
    if (player._ffBeam) return;
    player._ffBeam = { x: wx, y: wy };
    player._beamCharge = Math.max(1, player._beamCharge || 0); player._chargeFrame = _frameCount;
    logMessage('WEP: ビームをチャージ (' + (Math.round(BEAM_CHARGE_DUR * PM.beamCharge / 6) / 10) + '秒) — 熱/EM/ヒッグスが漏れる', 'warning-msg');
}
// 座標射撃のビーム: チャージが溜まったら撃つ (毎フレーム)
function updateFreeBeam() {
    const fb = player && player._ffBeam;
    if (!fb) return;
    if (player.hp <= 0 || player._weaponJamTimer > 0) { player._ffBeam = null; return; }
    player._beamCharge = (player._beamCharge || 0) + gameSpeedFactor; player._chargeFrame = _frameCount;
    if (player._beamCharge < BEAM_CHARGE_DUR * PM.beamCharge) return;
    player._ffBeam = null; player._beamCharge = 0; player._chargeLogged = false;
    const ang = Math.atan2(fb.y - player.y, fb.x - player.x);
    const len = Math.min(weaponRange('beam'), Math.max(100, Math.hypot(fb.x - player.x, fb.y - player.y)));
    const ex = player.x + Math.cos(ang) * len, ey = player.y + Math.sin(ang) * len;
    effects.push({ x: player.x, y: player.y, tx: ex, ty: ey, type: 'beam', a: 1, c: '#00ffaa' });
    let hitE = null;
    for (const en of enemies) {
        if (en.hp <= 0 || en._dying) continue;
        if (_segDist(en.x, en.y, player.x, player.y, ex, ey) < PM.beamWidth + (en.radius || 0)) { hitE = en; break; }
    }
    if (hitE) {
        const hb = getHiggsIntensity((player.x + hitE.x) / 2, (player.y + hitE.y) / 2);
        const st = applyStrikeBonuses(true, null, hitE, Math.atan2(player.y - hitE.y, player.x - hitE.x), 'beam');
        const d = Math.floor(BEAM_DMG * (1 - hb * 0.8 * PM.beamFog) * st.mult * PM.beamDmg * PM.dmgAll); // 第32弾: 部品
        hitE.hp -= d;
        if (huntStats) huntStats.dmgDealt += d;
        createHitEffect(hitE.x, hitE.y, '#00ffaa'); addShake(15);
        logMessage('WEP: ビーム命中 → ' + d + ' ダメージ', 'system-msg');
    } else missRevealsShooter(player.x, player.y, ex, ey, true);
    leaveBeamChannel(player.x, player.y, ex, ey);
    beamNearMiss(player.x, player.y, ex, ey, true, hitE);
    beamRevealsShooter(player.x, player.y, true);
    player.beamReloading = true;
    player.beamReloadTimer = Math.round(BEAM_RELOAD_TIME * (WEAPONS_UPG_RELOAD_MULT[gameState.upgrades.weapons] || 1.0) * PM.beamReload);
    player.fireCooldown = WEAPON_COOLDOWNS.beam * Math.max(0.3, 1.5 - (genAlloc.weapons / 100));
    player._fireFlash = 90; player._fireFlashType = 'beam'; player._lastFireType = 'beam'; player._lastFireF = _frameCount; player._beamDrain = BEAM_DRAIN_DUR;
    playSound('shoot');
    cancelSilentRunning('発砲');
    logMessage('WEP: ビーム座標射撃 — 次まで' + Math.round(player.beamReloadTimer / 60) + '秒 (霧に軌跡が残る)', 'warning-msg');
}

function calcAccuracy(dist, maxRange, distDecay0, higgsBlock) {
    const distDecay = 1.0 - distDecay0 * (dist / maxRange);
    const aiCoeff   = 0.5 + (genAlloc.ai / 100);
    return Math.max(0.05, Math.min(1.0, distDecay * aiCoeff * (1 - higgsBlock * 0.5)));
}

// アクティブソナーの反響 = 「点」の観測。方位の記録とは別枠で推定位置の計算に強く効く (第15弾)
function pingContact(e, acc, dist) {
    acc = Math.min(1, acc * (1 + aiPrec('sensor') * AI_SENSOR_ACC));
    const r = Math.max(120, (1 - acc) * 500 + dist * 0.02);
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 0.5;
    const px = e.x + Math.cos(a) * d, py = e.y + Math.sin(a) * d;
    const sid = enemySid(e);
    if (!_signalAnalysis[sid]) _signalAnalysis[sid] = _newSignalAnalysis();
    const sa = _signalAnalysis[sid];
    sa.ping = { x: px, y: py, r: r * 0.5, f: _frameCount };
    if (!_contactLabels[sid]) _contactLabels[sid] = _contactLabelNext++;
    solveFix(sa);
    if (!lockedSignalId && e.type !== 'fighter') window._lockSignal(sid); // 何も追跡していなければ反響した相手を追跡
    e.displayX = px; e.displayY = py; e.trackR = r;
    e.contactAccuracy = Math.max(e.contactAccuracy || 0, acc);
    e.contactLife = Math.max(e.contactLife, 600);
    e.visible = true;
}
// 探信音を聞いた敵は、こちらの位置を掴んで狩りに来る (dirAng指定時は照射方向ほど遠くまで届く)
function pingHeardBy(range, dirAng, halfAngle, sideRange) {
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
        const dx = e.x - player.x, dy = e.y - player.y, d = Math.hypot(dx, dy);
        let lim = range;
        if (dirAng !== null && dirAng !== undefined) {
            let df = Math.atan2(dy, dx) - dirAng;
            while (df < -Math.PI) df += Math.PI * 2; while (df > Math.PI) df -= Math.PI * 2;
            if (Math.abs(df) > halfAngle) lim = sideRange;
        }
        if (d > lim) continue;
        const err = 150 + d * 0.03;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * err;
        e.playerLastKnownPos = { x: player.x + Math.cos(a) * r, y: player.y + Math.sin(a) * r, vx: 0, vy: 0 };
        e.contactFreshness = 1.0;
        e.detectionState = 'alerted'; e.isAggro = true; e.aggroTimer = 400;
        e._alertUntil = _frameCount + ENEMY_ALERT_MEMORY;
        if (e.aiState === 'lurking' || e.aiState === 'gathering') { e.aiState = 'hunting'; e.huntTimer = 600 + d / 1.2; }
    }
}

function applyContact(e, accuracy, life = 600) {
    // AI解析精度: センサー配分が高いほどコンタクト精度が上がる(ジャミング/デコイに強い・候補が絞れる)
    accuracy = Math.min(1, accuracy * (1 + aiPrec('sensor') * AI_SENSOR_ACC));
    if (accuracy > e.contactAccuracy || e.contactLife < 60) {
        const jitter = (1 - accuracy) * 400;
        e.displayX = e.x + (Math.random() - 0.5) * jitter;
        e.displayY = e.y + (Math.random() - 0.5) * jitter;
        e.contactAccuracy = accuracy;
        e.trackR = null; // ソナー/有視界の方が確度が高い → 追跡推定円は使わない
    }
    e.contactLife = Math.max(e.contactLife, life);
    e.visible = true;
}

// パッシブ追跡の結果 (記録した方位線の交点) を敵艦のコンタクトに反映する = 射撃命令の狙い所になる。
function applyTrackContact(e, sa) {
    // 交点が出ていなければ「方位だけ」= 位置は分からない (撃てない)
    if (!sa.fix || e.inVision) return;
    const est = trackEstimate(sa, 0); // 第18弾: 運動解があれば針路と速さで今の位置へ進める
    e.contactAccuracy = Math.max(0.05, Math.min(0.95, 1 - est.r / 5000));
    e.displayX = est.x;
    e.displayY = est.y;
    e.trackR = est.r;
    e.contactLife = Math.max(e.contactLife, 260);
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
    const omniRange = baseRange * (genAlloc.sensors / 100) * genGain * (1 - stormAtPlayer * STORM_SONAR_DEGRADE) * PM.sonarRange; // 第32弾: ソナー拡張
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
        pingContact(e, acc, dist);
        detected++;
    });
    // 第31弾: 嵐の放電・熱泉・漂流コンテナも小さく反響する (霧のゆらぎは反響しない)
    for (const f of fieldSignals) {
        if (f.kind === 'cloud') continue;
        const dist = Math.hypot(f.x - player.x, f.y - player.y);
        if (dist > omniRange) continue;
        const acc = calcAccuracy(dist, omniRange, 0.6, getHiggsIntensity((f.x + player.x) / 2, (f.y + player.y) / 2));
        const r = Math.max(120, (1 - acc) * 500 + dist * 0.02), a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 0.5;
        if (!_signalAnalysis[f.sid]) _signalAnalysis[f.sid] = _newSignalAnalysis();
        const sa = _signalAnalysis[f.sid];
        sa.ping = { x: f.x + Math.cos(a) * d, y: f.y + Math.sin(a) * d, r: r * 0.5, f: _frameCount };
        if (!_contactLabels[f.sid]) _contactLabels[f.sid] = _contactLabelNext++;
        solveFix(sa); identStep(f.sid, f.sid === lockedSignalId, 1, sa);
    }
    omniSonarCooldown = 900;
    // 第15弾: 探信音は遠くまで届く — 反響が返る距離の2.2倍以内の敵は、こちらの位置をほぼ正確に掴む
    pingHeardBy(omniRange * 2.2 * PM.sonarHeard, null, 0);
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
        pingContact(e, acc, dist);
        detected++;
    });
    dirSonarCooldown = 300;
    // 指向性は照射方向にだけ強く響く (コーン内は2倍・それ以外は0.5倍の距離まで聞こえる)
    pingHeardBy(maxRange * 2, targetAngle, halfAngle, maxRange * 0.5);
    dirSonarVisual = { angle: targetAngle, halfAngle, range: maxRange, life: 1.0 };
    const deg = Math.round(targetAngle * 180 / Math.PI);
    logMessage(detected > 0
        ? `SONAR[指向性] Lv${sensorLv}: 方位${deg}° → ${detected}件捕捉`
        : `SONAR[指向性] Lv${sensorLv}: 方位${deg}° → 反応なし`,
        'system-msg');
}

// 近接センサー範囲 (痕跡の可視範囲・ハック範囲・パッシブ探知の基準) — ロジック側で毎フレーム更新。
// AI解析配分(aiPrec('sensor'))に連動。AI解析最大で≈2450。ヒッグス濃度で縮小。
function updateEffectiveRadarRange() {
    if (!player) return;
    effectiveRadarRange = (500 + aiPrec('sensor') * 1950) * (1 - getHiggsIntensity(player.x, player.y) * 0.55);
}

// ============================================================
// パッシブアンテナ描画 + ソナーコーン描画
// ============================================================
const _blipScreen = []; // { sid, sx, sy } 受信ブリップのスクリーン座標 (タップで追跡)
// 第27弾 (オーナー指示): 推定円をタップしても追跡 — 円の縁(±22px)・上の名札・小さい円は内側。円の中ほどのタップは移動のまま
function tryTapCircle(sx, sy) {
    let best = null, bd = Infinity;
    for (const c of _circScreen) {
        const d = Math.hypot(sx - c.cx, sy - c.cy);
        const edge = Math.abs(d - c.r), onLabel = Math.abs(sx - c.cx) < 110 && sy > c.cy - c.r - 30 && sy < c.cy - c.r + 26;
        const hit = edge < 22 || onLabel || d < Math.min(c.r, 44);
        const score = onLabel ? 0 : Math.min(edge, d);
        if (hit && score < bd) { bd = score; best = c; }
    }
    if (!best) return false;
    if (best.sid === lockedSignalId) return false; // 追跡中の円は移動のタップに譲る
    window._lockSignal(best.sid);
    playSound('ui');
    logMessage(`TRACK: SIG-${String(_contactLabels[best.sid] || '?').padStart(2, '0')} を追跡 (${identInfo(best.sid).txt})`, 'system-msg');
    return true;
}
// タップ位置の近くに受信ブリップがあればその信号を追跡する。処理したら true
function tryTapBlip(sx, sy) {
    let best = null, bd = 30;
    for (const b of _blipScreen) {
        const d = Math.hypot(b.sx - sx, b.sy - sy);
        if (d < bd) { bd = d; best = b; }
    }
    if (!best || best.sid === 'intel') return false;
    window._lockSignal(best.sid);
    playSound('ui');
    logMessage(`TRACK: SIG-${String(_contactLabels[best.sid] || '?').padStart(2, '0')} を追跡`, 'system-msg');
    if (typeof window.syncSigLockedBar === 'function') window.syncSigLockedBar();
    return true;
}
// ═══ 第16弾: 自艦リング — 「方角」にまつわる表示をすべてこの1本に集約 (画面上で一定の大きさ・常に自艦の周り) ═══
// 旧: 方位目盛りはマップの外周にしか無く、ログの「方位123°」を確かめるには毎回ズームアウトが要った。
// 気配・受信信号・被弾方向・ミサイル・司令部情報・測量ガイドもそれぞれ別の半径に散らばっていた。
// 0°=上(北)・時計回り。ログや副長が口にした方位は数秒間このリング上で点灯する。
const RING_R = 92;
function ringMarkBearing(deg, col) {
    deg = ((Math.round(deg) % 360) + 360) % 360;
    const ex = _ringMarks.find(m => Math.abs(m.deg - deg) < 3);
    if (ex) { ex.life = 300; ex.col = col || ex.col; return; }
    _ringMarks.push({ deg, life: 300, col: col || '#ffe08a' }); // 第18弾: 5秒・最新2つ (旧: 7秒・5つ)
    if (_ringMarks.length > 2) _ringMarks.shift();
}
function _degToScreen(deg) { return (deg - 90) * Math.PI / 180; }
function drawShipRing(ctx) {
    if (!player || player.hp <= 0) return;
    const { sx: cx, sy: cy } = worldToScreen(player.x, player.y);
    const R = RING_R;
    const t = Date.now(), tSec = t * 0.001;
    // ── 第23弾: 「気配」(敵の内部状態を読んでいた) は撤去。観測した兆候 (探信・照準波・ビームのチャージ・ミサイル) の方角だけ波打つ
    const gazes = [];
    let maxGaze = 0;
    if (playerExposureLevel >= 2 && threatObs.ang !== null) {
        maxGaze = playerExposureLevel >= 3 ? 1 : 0.6;
        gazes.push({ ang: threatObs.ang, gaze: maxGaze });
    } else if (playerExposureLevel >= 2) maxGaze = playerExposureLevel >= 3 ? 1 : 0.6;
    const gazeAt = (ang) => {
        let r = R;
        for (const g of gazes) {
            let d = ang - g.ang;
            if (d < -Math.PI) d += Math.PI * 2; else if (d > Math.PI) d -= Math.PI * 2;
            const env = Math.exp(-d * d * 2.0);
            r += env * (g.gaze * 14 + Math.sin(ang * 8 - tSec * 6.0) * g.gaze * 12 + Math.sin(ang * 15 + tSec * 3.5) * g.gaze * 5);
        }
        return r;
    };
    const ringCol = maxGaze > 0.55 ? '#ff6a6a' : maxGaze > 0.2 ? '#ffc070' : '#5fe0c4';
    ctx.save();
    ctx.lineCap = 'round';
    // (1) 目盛り: 10°毎の点・30°毎の線・90°毎の数字 (リングの外側)
    ctx.strokeStyle = '#7fe8d0';
    for (let deg = 0; deg < 360; deg += 10) {
        const a = _degToScreen(deg), c = Math.cos(a), s2 = Math.sin(a);
        const major = deg % 90 === 0, mid = deg % 30 === 0;
        ctx.globalAlpha = major ? 0.8 : mid ? 0.5 : 0.25;
        ctx.lineWidth = major ? 2 : 1;
        const r0 = R + 3, r1 = R + (major ? 10 : mid ? 7 : 4);
        ctx.beginPath(); ctx.moveTo(cx + c * r0, cy + s2 * r0); ctx.lineTo(cx + c * r1, cy + s2 * r1); ctx.stroke();
    }
    ctx.font = 'bold 9px Orbitron, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9ff5df';
    for (const deg of [0, 90, 180, 270]) {
        const a = _degToScreen(deg);
        ctx.globalAlpha = 0.75;
        ctx.fillText(String(deg), cx + Math.cos(a) * (R + (deg % 180 ? 24 : 19)), cy + Math.sin(a) * (R + 19));
    }
    // (2) リング本体 (色=脅威の段階: 静穏/受信=緑・照射=橙・攻撃=赤)
    ctx.globalAlpha = 0.28 + maxGaze * 0.5;
    ctx.strokeStyle = ringCol;
    ctx.lineWidth = 1.2 + maxGaze * 1.6;
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
        const a = i * Math.PI * 2 / 48, rr = gazeAt(a);
        if (i === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.stroke();
    // (3) 艦首: リングの内側に小さな三角。引いて艦が数px以下になったら中心にも小さな艦影の印
    if (camera.zoom * player.radius * 5.6 < 14) {
        const a = player.angle, c = Math.cos(a), s2 = Math.sin(a);
        ctx.globalAlpha = 0.95; ctx.fillStyle = '#00ffaa';
        ctx.beginPath();
        ctx.moveTo(cx + c * 9, cy + s2 * 9);
        ctx.lineTo(cx - c * 6 - s2 * 5, cy - s2 * 6 + c * 5);
        ctx.lineTo(cx - c * 3, cy - s2 * 3);
        ctx.lineTo(cx - c * 6 + s2 * 5, cy - s2 * 6 - c * 5);
        ctx.closePath(); ctx.fill();
    }
    {
        const a = player.angle, c = Math.cos(a), s2 = Math.sin(a);
        ctx.globalAlpha = 0.85; ctx.fillStyle = '#00ffaa';
        ctx.beginPath();
        ctx.moveTo(cx + c * (R - 3), cy + s2 * (R - 3));
        ctx.lineTo(cx + c * (R - 12) - s2 * 4, cy + s2 * (R - 12) + c * 4);
        ctx.lineTo(cx + c * (R - 12) + s2 * 4, cy + s2 * (R - 12) - c * 4);
        ctx.closePath(); ctx.fill();
    }
    // (4) 司令部情報: 敵艦の推定方面 (リングの外に矢印)
    if (intelBearing) {
        const ib = intelBearing;
        const tx = ib.ox + Math.cos(ib.angle) * 15000, ty = ib.oy + Math.sin(ib.angle) * 15000;
        const a = Math.atan2(ty - player.y, tx - player.x), c = Math.cos(a), s2 = Math.sin(a);
        const fade = Math.min(1, ib.life / 600);
        ctx.globalAlpha = (0.6 + Math.sin(t * 0.004) * 0.2) * fade;
        ctx.fillStyle = '#dfe9ff';
        const r0 = R + 26;
        ctx.beginPath(); // 細長い矢じり (外向き)
        ctx.moveTo(cx + c * (r0 + 14), cy + s2 * (r0 + 14));
        ctx.lineTo(cx + c * r0 - s2 * 4.5, cy + s2 * r0 + c * 4.5);
        ctx.lineTo(cx + c * (r0 + 4), cy + s2 * (r0 + 4));
        ctx.lineTo(cx + c * r0 + s2 * 4.5, cy + s2 * r0 - c * 4.5);
        ctx.closePath(); ctx.fill();
        ctx.font = 'bold 9px Orbitron, monospace';
        ctx.fillText('敵方面 ' + compassDeg(a) + '°', cx + c * (r0 + 32), cy + s2 * (r0 + 32));
    }
    // (5) 受信中の信号 (色=帯域)。タップでその信号を追跡。追跡中は SIG番号つき
    const S_HEX = { heat: '#ffa03c', optic: '#3cffb4', em: '#e664ff', higgs: '#3cf0ff' };
    const _sigBlips = {};
    _blipScreen.length = 0;
    for (const b of passiveBearings) {
        if (b.life <= 0 || b.relay) continue; // 聴音局・コロニー起点の方位は自艦リングに出さない (自艦から見た方角ではない)
        const prev = _sigBlips[b.sourceId];
        if (!prev || b.life > prev.life) _sigBlips[b.sourceId] = b;
    }
    ctx.font = 'bold 9px Orbitron, monospace';
    for (const sid in _sigBlips) {
        const bl = _sigBlips[sid];
        const isLocked = sid === lockedSignalId;
        const hex = S_HEX[bl.sensor] || '#cfe8e0';
        const appear = Math.min(1, ((bl.maxLife || 480) - bl.life) / 45);
        const fade = Math.max(0.3, bl.life / (bl.maxLife || 480)) * appear;
        const c = Math.cos(bl.angle), s2 = Math.sin(bl.angle);
        const rr = gazeAt(bl.angle);
        const tip = rr + (isLocked ? 14 : 9);
        _blipScreen.push({ sid, sx: cx + c * (tip + 4), sy: cy + s2 * (tip + 4) });
        ctx.globalAlpha = fade * (isLocked ? 1 : 0.75);
        ctx.strokeStyle = hex; ctx.fillStyle = hex;
        ctx.lineWidth = isLocked ? 2.4 : 1.5;
        ctx.beginPath(); ctx.moveTo(cx + c * (rr + 2), cy + s2 * (rr + 2)); ctx.lineTo(cx + c * tip, cy + s2 * tip); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx + c * tip, cy + s2 * tip, isLocked ? 3.6 : 2.4, 0, Math.PI * 2); ctx.fill();
        if (!isLocked) { // 第23弾: 「方位n° 熱源感知」— 何を感じたかを帯域の言葉で
            ctx.font = '8px Orbitron, monospace';
            ctx.fillText(_RX_WORD[bl.sensor] || '', cx + c * (tip + 16), cy + s2 * (tip + 16));
            ctx.font = 'bold 9px Orbitron, monospace';
        }
        if (isLocked) {
            ctx.lineWidth = 1.3;
            ctx.beginPath(); ctx.arc(cx + c * tip, cy + s2 * tip, 7, 0, Math.PI * 2); ctx.stroke();
            ctx.fillText('SIG-' + String(_contactLabels[sid] || '?').padStart(2, '0'), cx + c * (tip + 22), cy + s2 * (tip + 22));
            const _idn = identInfo(sid); // 第23弾: 識別
            ctx.fillStyle = _idn.low ? '#ffcc66' : '#cfe8e0';
            ctx.fillText(_idn.txt, cx + c * (tip + 22), cy + s2 * (tip + 22) + 11);
        }
    }
    // (6) 測量ガイド: 追跡中の方位線に直交する2方向 (そちらへ動くと交点が締まる)。推定が十分に絞れたら消える
    if (lockedSignalId && _sigBlips[lockedSignalId]) {
        const sa = _signalAnalysis[lockedSignalId];
        if (!sa || !sa.fix || trackEstimate(sa, 0).r > 900) {
            ctx.globalAlpha = 0.55 + Math.sin(t * 0.004) * 0.15;
            ctx.fillStyle = '#00ffd0';
            for (const k of [1, -1]) {
                const a = _sigBlips[lockedSignalId].angle + k * Math.PI / 2, c = Math.cos(a), s2 = Math.sin(a);
                const r0 = R - 16;
                ctx.beginPath();
                ctx.moveTo(cx + c * (r0 + 8), cy + s2 * (r0 + 8));
                ctx.lineTo(cx + c * r0 - s2 * 5, cy + s2 * r0 + c * 5);
                ctx.lineTo(cx + c * (r0 + 3), cy + s2 * (r0 + 3));
                ctx.lineTo(cx + c * r0 + s2 * 5, cy + s2 * r0 - c * 5);
                ctx.closePath(); ctx.fill();
            }
        }
    }
    // (7) 被弾方向: リング上の赤い弧
    for (let hd = playerHitDirs.length - 1; hd >= 0; hd--) {
        const h = playerHitDirs[hd];
        h.life -= gameSpeedFactor;
        if (h.life <= 0) { playerHitDirs.splice(hd, 1); continue; }
        ctx.globalAlpha = Math.min(0.9, h.life / HIT_DIR_LIFE);
        ctx.strokeStyle = '#ff3344'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(cx, cy, R, h.ang - 0.45, h.ang + 0.45); ctx.stroke();
    }
    // (8) 接近するミサイル (推進波を捉えたもの): リングの内側に赤い矢印
    for (const pr of projectiles) {
        if (pr.isPlayer || pr.type !== 'missile' || !pr._torpAlerted || !pr.active) continue;
        const a = Math.atan2(pr.y - player.y, pr.x - player.x), c = Math.cos(a), s2 = Math.sin(a);
        const r0 = R - 6;
        ctx.globalAlpha = 0.6 + Math.sin(t * 0.03) * 0.4;
        ctx.fillStyle = '#ff2233';
        ctx.beginPath();
        ctx.moveTo(cx + c * (r0 - 12), cy + s2 * (r0 - 12));
        ctx.lineTo(cx + c * r0 - s2 * 7, cy + s2 * r0 + c * 7);
        ctx.lineTo(cx + c * r0 + s2 * 7, cy + s2 * r0 - c * 7);
        ctx.closePath(); ctx.fill();
    }
    // (10) 資材から組み立て中: リングの内側に進み具合 (組み立て中はEMと熱が漏れている)
    if (cargo.asm) {
        const ca = cargo.asm, p = ca.ready ? 1 : 1 - ca.t / ca.total;
        ctx.globalAlpha = 0.85; ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, R - 22, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
        ctx.font = 'bold 9px Orbitron, monospace'; ctx.fillStyle = '#ffd27a';
        ctx.fillText((ca.ready ? '待機 ' : '組立 ') + DRONE_SPEC[ca.type].label, cx, cy + R + 33);
    }
    // (9) ログ・副長が口にした方位: リングを横切る明るい線 + 角度
    const _intelDeg = intelBearing ? compassDeg(Math.atan2(intelBearing.oy + Math.sin(intelBearing.angle) * 15000 - player.y, intelBearing.ox + Math.cos(intelBearing.angle) * 15000 - player.x)) : -99;
    for (let i = _ringMarks.length - 1; i >= 0; i--) {
        const m = _ringMarks[i];
        if ((m.life -= 1) <= 0) { _ringMarks.splice(i, 1); continue; }
        if (Math.abs(_angDiff(m.deg * Math.PI / 180, _intelDeg * Math.PI / 180)) < 0.12) continue; // 敵方面の矢印が既に角度を示している
        const a = _degToScreen(m.deg), c = Math.cos(a), s2 = Math.sin(a);
        const fa = Math.min(1, m.life / 60) * (m.life > 380 ? 0.6 + Math.sin(t * 0.03) * 0.4 : 1);
        ctx.globalAlpha = fa;
        ctx.strokeStyle = m.col; ctx.fillStyle = m.col;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx + c * (R - 10), cy + s2 * (R - 10)); ctx.lineTo(cx + c * (R + 12), cy + s2 * (R + 12)); ctx.stroke();
        ctx.font = 'bold 10px Orbitron, monospace';
        ctx.fillText(m.deg + '°', cx + c * (R + 34), cy + s2 * (R + 34));
    }
    // (10) 第21弾: 今いる場所の霧と地形 (リングの左下)
    {
        const hh = getHiggsIntensity(player.x, player.y), dbr = getDebrisIntensity(player.x, player.y), stm = getStormIntensity(player.x, player.y), thm = getThermalIntensity(player.x, player.y);
        const rows = [['霧 ' + Math.round(hh * 100) + '%', hh > 0.5 ? '#c79bff' : hh > 0.2 ? '#7fd8ff' : '#7fa8c8']];
        if (dbr > 0.1) rows.push(['岩礁 ' + Math.round(dbr * 100) + '%', '#c8c8b4']);
        if (stm > 0.1) rows.push(['嵐 ' + Math.round(stm * 100) + '%', '#c89cff']);
        if (thm > 0.1) rows.push(['熱雲 ' + Math.round(thm * 100) + '%', '#ffb070']);
        ctx.globalAlpha = 0.9; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.font = 'bold 10px Orbitron, sans-serif';
        for (let i = 0; i < rows.length; i++) { ctx.fillStyle = rows[i][1]; ctx.fillText(rows[i][0], cx - R * 0.78, cy + R * 0.78 + i * 12); }
    }
    ctx.restore();
}

// ═══ 第21弾: 霧の濃さと地形の表示 (オーナー合意「1と2両方」) ═══
// 普段: 自艦の周り3000uに色分け (霧=紺→水色→紫 / 岩礁・嵐・熱雲の模様) を霧の上に薄く / 「濃度」ボタンON: 全マップに重ねる
let densityViewOn = false;
let higgsOverlayCanvas = null;
const DENSITY_NEAR_R = 3000;
function _bakeHiggsOverlay() {
    if (!higgsGrid) return null;
    const N = HG_N, c = document.createElement('canvas');
    c.width = c.height = N;
    const cx = c.getContext('2d'), img = cx.createImageData(N, N), px = img.data;
    for (let k = 0; k < N * N; k++) {
        const d = higgsGrid[k], o = k * 4;
        if (d <= 0.03) continue;
        // 薄い=紺 → 中=水色 → 濃い=紫 → 最も濃い=白っぽい紫
        let r, g, b;
        if (d < 0.5) { const t = d / 0.5; r = 20 + 0 * t; g = 60 + 150 * t; b = 140 + 100 * t; }
        else if (d < 0.9) { const t = (d - 0.5) / 0.4; r = 20 + 150 * t; g = 210 - 160 * t; b = 240; }
        else { const t = (d - 0.9) / 0.1; r = 170 + 60 * t; g = 50 + 150 * t; b = 240 + 15 * t; }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.min(220, 40 + d * 180) | 0;
    }
    cx.putImageData(img, 0, 0);
    return c;
}
function toggleDensityView(on) {
    densityViewOn = on === undefined ? !densityViewOn : !!on;
    const b = document.getElementById('btn-density');
    if (b) b.classList.toggle('on', densityViewOn);
    logMessage('MAP: 濃度表示 ' + (densityViewOn ? 'ON — 全マップの霧の濃さと地形を重ねる' : 'OFF — 自艦の周りだけ'), 'system-msg');
}
function drawDensityOverlay(ctx) {
    if (!player || player.hp <= 0) return;
    if (!higgsOverlayCanvas && higgsGrid) higgsOverlayCanvas = _bakeHiggsOverlay();
    const layers = [[higgsOverlayCanvas, 0.55, HG_N * HG_CELL], [debrisCanvas, 0.7, FIELD_SIZE], [stormCanvas, 0.6, FIELD_SIZE], [thermalCanvas, 0.6, FIELD_SIZE]];
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if (!densityViewOn) {
        ctx.beginPath(); ctx.arc(player.x, player.y, DENSITY_NEAR_R, 0, Math.PI * 2); ctx.clip();
    }
    const k = densityViewOn ? 1 : 0.55;
    for (const [cv, a, size] of layers) { if (!cv) continue; ctx.globalAlpha = a * k; ctx.drawImage(cv, 0, 0, size, size); }
    ctx.restore();
    if (!densityViewOn) {
        ctx.save(); ctx.globalAlpha = 0.18; ctx.strokeStyle = '#7fd8ff'; ctx.lineWidth = 1 / camera.zoom;
        ctx.setLineDash([12 / camera.zoom, 10 / camera.zoom]);
        ctx.beginPath(); ctx.arc(player.x, player.y, DENSITY_NEAR_R, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
}

function drawPassiveAntenna(ctx) {
    if (!player || player.hp <= 0) return;
    drawWakes(ctx);

    const sc = sensorConfig[currentSensor];
    const CR = sc.r;
    const t  = Date.now();

    // センサー別 trail/wake 描画 (§3-12 全センサー一般化)
    const sensorRange = effectiveRadarRange * sc.rangeScale;
    // §3-12 HEAT trail: 橙色の熱排気跡 (エンジン移動・ミサイル推進)
    if (sensorsOn.heat) { // 第21弾: ONの帯域すべて
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
    if (sensorsOn.optic) { // 第21弾: ONの帯域すべて
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
    if (sensorsOn.em) { // 第21弾: ONの帯域すべて
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
    if (sensorsOn.higgs) { // 第21弾: ONの帯域すべて
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
        minimapCtx.globalAlpha = sensorsOn.higgs ? 0.85 : _mmDim;
        minimapCtx.drawImage(bgMistCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (debrisCanvas) {
        minimapCtx.globalAlpha = sensorsOn.optic ? 0.85 : _mmDim;
        minimapCtx.drawImage(debrisCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (stormCanvas) {
        minimapCtx.globalAlpha = sensorsOn.em ? 0.80 : _mmDim;
        minimapCtx.drawImage(stormCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }
    if (thermalCanvas) {
        minimapCtx.globalAlpha = sensorsOn.heat ? 0.80 : _mmDim;
        minimapCtx.drawImage(thermalCanvas, offX, offY, FIELD_SIZE * mmScale, FIELD_SIZE * mmScale);
        minimapCtx.globalAlpha = 1;
    }

    // 司令部情報の扇形 (敵艦推定方面)
    if (intelBearing) {
        const ib = intelBearing;
        minimapCtx.globalAlpha = 0.22 * Math.min(1, ib.life / 600);
        minimapCtx.fillStyle = '#cfe0ff';
        minimapCtx.beginPath();
        minimapCtx.moveTo(ib.ox * mmScale + offX, ib.oy * mmScale + offY);
        minimapCtx.arc(ib.ox * mmScale + offX, ib.oy * mmScale + offY, ib.range * mmScale, ib.angle - ib.halfWidth, ib.angle + ib.halfWidth);
        minimapCtx.closePath(); minimapCtx.fill();
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
        if (e.inVision || higgsViewOff) { // ヒッグス表示OFF(観戦)では真の位置も点で出す
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

    // リソースノード — 第18弾: 海図の既知物として常に点を打つ (未確認は薄く)
    resourceNodes.forEach(n => {
        const mine = n.owner === 'player', theirs = n.owner === 'enemy' && n.knownLost;
        const mx = n.x * mmScale + offX, my = n.y * mmScale + offY;
        minimapCtx.globalAlpha = mine || theirs || n.identified ? 1 : 0.45;
        minimapCtx.fillStyle = mine ? '#00ffd0' : theirs ? '#ff5a5a' : '#50c8ff';
        minimapCtx.beginPath(); minimapCtx.arc(mx, my, mine || theirs ? 3.2 : 2.5, 0, Math.PI * 2); minimapCtx.fill();
        if (mine) { // 第16弾: 自分の聴音局は聴音範囲も薄く
            minimapCtx.globalAlpha = 0.25; minimapCtx.strokeStyle = '#00ffd0'; minimapCtx.lineWidth = 1;
            minimapCtx.beginPath(); minimapCtx.arc(mx, my, NODE_RELAY_RANGE * mmScale, 0, Math.PI * 2); minimapCtx.stroke();
        }
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
    // 遭難信号ビーコン (SOS — 電波なので常時可視)。第21弾: 敵の偽SOSも同じ見た目 (自分の囮は別の印)
    for (const _bc of beaconsFor('p')) {
        const _bmx = _bc.x * mmScale + offX, _bmy = _bc.y * mmScale + offY;
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
    if (cameraFollowPlayer) { cameraFollowPlayer = false; updateCameraFollowBtn(); }
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
    if (cameraFollowPlayer) { cameraFollowPlayer = false; updateCameraFollowBtn(); }
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
        ctx.globalAlpha = (!mapMode || sensorsOn.higgs) ? 1.0 : _mapFade;
        ctx.drawImage(bgMistCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.globalAlpha = 1;
    }
    if (debrisCanvas) {
        ctx.globalAlpha = (!mapMode || sensorsOn.optic) ? 1.0 : _mapFade;
        ctx.drawImage(debrisCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE);
        ctx.globalAlpha = 1;
    }
    if (stormCanvas) {
        const _sa = (!mapMode || sensorsOn.em) ? 0.82 + Math.sin(Date.now() * 0.006) * 0.12 : _mapFade;
        ctx.save(); ctx.globalAlpha = _sa; ctx.imageSmoothingEnabled = true;
        ctx.drawImage(stormCanvas, 0, 0, FIELD_SIZE, FIELD_SIZE); ctx.restore();
    }
    if (thermalCanvas) {
        const _ta = (!mapMode || sensorsOn.heat) ? 0.78 + Math.sin(Date.now() * 0.003 + 2.1) * 0.12 : _mapFade;
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

// ============================================================
// 環境情報パネル動的更新
// ============================================================
function updateEnvInfo() {
    if (!player || player.hp <= 0) return;
    // 艦体耐久 (上帯)
    const hpP = Math.max(0, Math.round(player.hp / player.maxHp * 100));
    if (hpP !== _hudCache.hp) {
        _hudCache.hp = hpP;
        const col = hpP < 25 ? '#ff4d4d' : hpP < 55 ? '#ffaa44' : '#00ffaa';
        const f = document.getElementById('hud-hp-fill'), t = document.getElementById('hud-hp-text');
        if (f) { f.style.width = hpP + '%'; f.style.backgroundColor = col; }
        if (t) { t.textContent = hpP + '%'; t.style.color = col; }
    }
    // 兵装ボタンの残弾/リロード (旧: 状態行の「弾:」とSHIP STATUSの二重表示)
    const w = currentWeapon();
    let ammo, rld;
    // 第20弾: 実弾=マガジン·残り斉射 / ミサイル=残り発数 (リロード秒) / ビーム=チャージ・リロード秒
    if (w === 'kinetic') { rld = player.kineticReloading || cargo.ammoK <= 0; ammo = cargo.ammoK <= 0 ? '弾切れ' : player.kineticReloading ? 'RLD ' + Math.ceil(player.kineticReloadTimer / 60) + 's' : player.kineticAmmo + '·' + cargo.ammoK; }
    else if (w === 'missile') { rld = player.missileReloading || cargo.ammoM <= 0; ammo = cargo.ammoM <= 0 ? '弾切れ' : (player.missileReloading ? Math.ceil(player.missileReloadTimer / 60) + 's·' : '') + cargo.ammoM + '発'; }
    else { rld = player.beamReloading; ammo = (player._beamCharge || 0) > 0 ? 'CHG' : rld ? 'RLD ' + Math.ceil(player.beamReloadTimer / 60) + 's' : 'RDY'; }
    if (ammo !== _hudCache.ammo) {
        _hudCache.ammo = ammo;
        const el = document.getElementById('abar-wep-ammo');
        if (el) { el.textContent = ammo; el.classList.toggle('rld', !!rld); }
    }
    // GEN配分の要約 (上帯のGENボタン)
    const gs = 'E' + Math.round(genAlloc.engine) + ' W' + Math.round(genAlloc.weapons) + ' S' + Math.round(genAlloc.sensors);
    if (gs !== _hudCache.gen) { _hudCache.gen = gs; const el = document.getElementById('gen-summary'); if (el) el.textContent = gs; }
    // メニューモーダルのセクター/クレジット
    const mmSector = document.getElementById('mm-sector');
    const mmCredits = document.getElementById('mm-credits');
    if (mmSector) mmSector.textContent = `セクター: ${gameState.sector}`;
    if (mmCredits) mmCredits.textContent = `クレジット: ${gameState.credits} SCR`;
}
// ============================================================
// ゲームオーバー / セクタークリア
// ============================================================
// 第22弾: 撃沈の瞬間に何が起きたかを画面中央に出す (崩壊の演出の間)
function showDeathBanner(cause) {
    let el = document.getElementById('death-banner');
    if (!el) { el = document.createElement('div'); el.id = 'death-banner'; document.body.appendChild(el); }
    el.innerHTML = '';
    const a = document.createElement('div'); a.className = 'db-title'; a.textContent = '被弾 — 船体崩壊';
    const b = document.createElement('div'); b.className = 'db-cause'; b.textContent = cause;
    el.appendChild(a); el.appendChild(b);
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 4200);
}
function showGameOver() {
    document.getElementById('go-sector').textContent = gameState.sector;
    document.getElementById('go-credits').textContent = gameState.credits;
    document.getElementById('go-kills').textContent = enemiesKilled;
    const _rep = document.getElementById('go-report');
    if (_rep) _rep.textContent = '戦闘詳報 — ' + formatHuntReport();
    // 第22弾: 撃沈の原因と、その前の被弾 (新しい順に最大4件)
    const _cz = document.getElementById('go-cause');
    if (_cz) {
        _cz.innerHTML = '';
        const head = document.createElement('div'); head.className = 'go-cause-head'; head.textContent = '撃沈の原因: ' + (player && player._deathCause || '不明'); _cz.appendChild(head);
        const t0 = playerHitLog.length ? playerHitLog[playerHitLog.length - 1].f : 0;
        for (const h of playerHitLog.slice(-4).reverse()) {
            const row = document.createElement('div'); row.className = 'go-cause-row';
            row.textContent = (h.f === t0 ? '最後 ' : ((h.f - t0) / 60).toFixed(0) + '秒 ') + _hitText(h) + ' → 残り' + h.hp;
            _cz.appendChild(row);
        }
    }
    // 前任艦の残骸: 喪失クレジットの一部が次の出撃でサルベージ可能になる
    gameState.wreckSalvage = Math.max(100, Math.floor(gameState.credits * 0.35));
    saveGame();
    document.getElementById('game-over-overlay').classList.remove('hidden');
    setTimeout(() => openReplay(), 400); // 第23弾: 試合が終わったら記録を開く (閉じると終了画面)
}

function showSectorClear(bonus) {
    const el = document.getElementById('sector-clear-banner');
    if (!el) return;
    el.querySelector('#sc-bonus').textContent = bonus;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 4000);
}

function drawTargetLine(ctx) {
    // 第20弾: ロックした目標へ引いていた赤い線は撤去 (見えていない時も目標の真の位置へ線を引いており、答えを渡していた)。
    // 見えている目標は照準枠(_drawLockReticle)、見えていない目標は推定円で示す
    // ウェイポイントライン: 細い破線のみ (ワールド空間)
    if (player.state === 'moving') {
        ctx.beginPath(); ctx.moveTo(player.x, player.y); ctx.lineTo(player.targetX, player.targetY);
        ctx.setLineDash([Math.max(8, 12/camera.zoom), Math.max(5, 8/camera.zoom)]);
        ctx.strokeStyle = 'rgba(0,200,255,0.45)';
        ctx.lineWidth = Math.max(1, 1.5 / camera.zoom);
        ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 1;
    }
}

// 第20弾: 今の兵装の射程 — 艦首±射角の扇を射程の距離に薄い破線で描く (射程の数字を添える)
const _WR_LBL = { kinetic: '実弾', missile: 'ミサイル', beam: 'ビーム' };
function drawWeaponRange(ctx) {
    const w = currentWeapon(), R = weaponRange(w), arc = WEAPON_FIRE_ARC[w] || Math.PI / 4;
    const zc = 1 / camera.zoom;
    if (R * camera.zoom < 40) return; // 画面上で小さすぎる時は描かない (自艦リングの内側)
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = w === 'kinetic' ? '#ff8080' : w === 'missile' ? '#ffcc55' : '#7fc8ff';
    ctx.lineWidth = 1.2 * zc;
    ctx.setLineDash([10 * zc, 8 * zc]);
    ctx.beginPath();
    ctx.moveTo(player.x + Math.cos(player.angle - arc) * R * 0.15, player.y + Math.sin(player.angle - arc) * R * 0.15);
    ctx.lineTo(player.x + Math.cos(player.angle - arc) * R, player.y + Math.sin(player.angle - arc) * R);
    ctx.arc(player.x, player.y, R, player.angle - arc, player.angle + arc);
    ctx.lineTo(player.x + Math.cos(player.angle + arc) * R * 0.15, player.y + Math.sin(player.angle + arc) * R * 0.15);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = 'bold ' + Math.round(10 * zc) + 'px Orbitron, monospace';
    ctx.textAlign = 'center';
    // ラベルは艦首方向の弧の先。画面(上帯・左右の列を除く)からはみ出す時は、艦首方向の線上で画面の端に寄せる
    const ins = uiInsets(), p0 = worldToScreen(player.x, player.y), ca = Math.cos(player.angle), sa = Math.sin(player.angle);
    let t = (R + 14 * zc) * camera.zoom;
    const x0 = ins.left + 70, x1 = (cssW || window.innerWidth) - ins.right - 70, y0 = ins.top + 18, y1 = (cssH || window.innerHeight) - 40;
    if (ca > 1e-6) t = Math.min(t, (x1 - p0.sx) / ca); else if (ca < -1e-6) t = Math.min(t, (x0 - p0.sx) / ca);
    if (sa > 1e-6) t = Math.min(t, (y1 - p0.sy) / sa); else if (sa < -1e-6) t = Math.min(t, (y0 - p0.sy) / sa);
    t = Math.max(t, 110); // 自艦リング(半径92px)の外
    ctx.fillText(_WR_LBL[w] + ' 射程' + Math.round(R) + 'u', player.x + ca * t / camera.zoom, player.y + sa * t / camera.zoom);
    ctx.restore();
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
// 第23弾: 縮尺定規 (地図アプリのように、今のズームで画面上60〜150pxになる切りのよい距離)。フィールドの左下・ログの上
const SCALE_STEPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
function drawScaleBar(ctx) {
    const z = camera.zoom; let d = SCALE_STEPS[0];
    for (const v of SCALE_STEPS) { d = v; if (v * z >= 60) break; }
    const px = d * z, ins = uiInsets();
    const x0 = ins.left + 14, y0 = cssH - 58;
    ctx.save();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = '#bfeee0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 5); ctx.stroke();
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + px / 2, y0); ctx.lineTo(x0 + px / 2, y0 - 3); ctx.stroke();
    ctx.fillStyle = '#bfeee0'; ctx.font = 'bold 10px Orbitron, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(d >= 1000 ? (d / 1000) + ',000u' : d + 'u', x0 + 4, y0 - 6);
    ctx.restore();
}
function drawHUDOverlay(ctx) {
    if (!player || player.hp <= 0) return;
    const { sx: psx, sy: psy } = worldToScreen(player.x, player.y);
    const t = Date.now();

    // 第17弾: 閃光弾の画面フラッシュ
    if (_flashScreen > 0) {
        ctx.save(); ctx.globalAlpha = _flashScreen / 18 * 0.55; ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore();
    }
    // 第14弾: 被探知状態は上帯のDOMチップ(#hud-expo)へ移設。ここではフィールド内の演出と方向指示だけを描く
    drawShipRing(ctx);
    drawScaleBar(ctx); // 第23弾: 縮尺定規
    {
        const exL = playerExposureLevel;
        const _ins = uiInsets();
        const _fL = _ins.left, _fW = cssW - _ins.left - _ins.right; // 実フィールド (左右の列を除く)
        const _fCX = _fL + _fW / 2;
        const chipY = _ins.top + 4;
        ctx.save();
        // 攻撃を受けている (第23弾: 被弾・ミサイル・ビームのチャージ反応): フィールドの縁を赤くパルス
        if (exL === 3) {
            ctx.globalAlpha = 0.10 + Math.sin(t * 0.02) * 0.07;
            ctx.strokeStyle = '#ff2233'; ctx.lineWidth = 10;
            ctx.strokeRect(_fL + 5, _ins.top + 5, _fW - 10, cssH - _ins.top - 10);
        }
        ctx.textAlign = 'center';
        // ── ヒッグスサージ表示 ──
        let _infoY = chipY + 14; // 上帯の直下 (イベント告知の行)
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
        if (player._weaponJamTimer > 0 || player._sysEngineTimer > 0 || player._sysSensorTimer > 0 || player._daze > 0) {
            ctx.globalAlpha = 0.6 + Math.sin(t * 0.015) * 0.3;
            ctx.fillStyle = '#ff9500';
            ctx.font = 'bold 11px Orbitron, monospace';
            let dmgTxt = '';
            if (player._weaponJamTimer > 0) dmgTxt += '火器管制ダウン ';
            if (player._sysEngineTimer > 0) dmgTxt += '機関損傷 ';
            if (player._sysSensorTimer > 0) dmgTxt += 'センサー損傷 ';
            else if (player._daze > 0) dmgTxt += 'センサー撹乱';
            ctx.fillText(dmgTxt, _fCX, _infoY);
        }
        // ── 奇襲可能インジケータ: 完全ロック中 & 敵が自分に気付いていない ──
        const te = player.targetEntity;
        if (te && te.hp > 0 && te.inVision && te.detectionState === 'unaware') {
            const _tp = worldToScreen(te.x, te.y);
            ctx.globalAlpha = 0.75 + Math.sin(t * 0.012) * 0.25;
            ctx.fillStyle = '#ffd24a';
            ctx.font = 'bold 12px Orbitron, monospace';
            ctx.fillText(currentWeapon() === 'beam' ? '奇襲可能 ×1.5' : '奇襲可能 ×3.5', _tp.sx, _tp.sy - 36);
        }
        // ── ニアミス「息を殺せ」表示 ──
        if (nearMissActive) {
            ctx.globalAlpha = 0.6 + Math.sin(t * 0.02) * 0.35;
            ctx.fillStyle = '#ffcc66';
            ctx.font = 'bold 12px Orbitron, monospace';
            ctx.fillText('敵艦至近 — 息を殺せ', _fCX, _infoY + 16);
        }
        // ── チャージビーム進捗リング (自機周り) ──
        if ((player._beamCharge || 0) > 0) {
            const _cf = Math.min(1, player._beamCharge / (BEAM_CHARGE_DUR * PM.beamCharge));
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
        // ── 前任艦の残骸マーカー (第5弾): 灰色ダイヤ + WRECK ──
        if (playerWreckObj) {
            const _wp2 = worldToScreen(playerWreckObj.x, playerWreckObj.y);
            const wx2 = Math.max(_fL + 24, Math.min(_fL + _fW - 24, _wp2.sx));
            const wy2 = Math.max(_ins.top + 24, Math.min(cssH - 30, _wp2.sy));
            ctx.globalAlpha = 0.45 + Math.sin(t * 0.004) * 0.2;
            ctx.strokeStyle = '#9ab0bb'; ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(wx2, wy2 - 9); ctx.lineTo(wx2 + 9, wy2); ctx.lineTo(wx2, wy2 + 9); ctx.lineTo(wx2 - 9, wy2);
            ctx.closePath(); ctx.stroke();
            ctx.fillStyle = '#9ab0bb';
            ctx.font = 'bold 9px Orbitron, monospace';
            ctx.fillText('WRECK', wx2, wy2 + 20);
        }
        // ── 遭難信号マーカー: 画面内はその位置、画面外は縁にクランプして方向を示す (第21弾: 敵の偽SOSも同じ見た目) ──
        for (const _bc of beaconsFor('p')) {
            const _bp = worldToScreen(_bc.x, _bc.y);
            const bx = Math.max(_fL + 24, Math.min(_fL + _fW - 24, _bp.sx));
            const by = Math.max(_ins.top + 24, Math.min(cssH - 30, _bp.sy));
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

    // ── ウェイポイントライン + 目的地マーカー ──
    if (player.state === 'moving') {
        const { sx: tsx, sy: tsy } = worldToScreen(player.targetX, player.targetY);
        ctx.save();
        // 明るい破線
        ctx.setLineDash([10, 6]);
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.8;
        ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(psx, psy); ctx.lineTo(tsx, tsy); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;

        // 目的地マーカー (回転クロスヘア + リング)
        ctx.translate(tsx, tsy);
        const rot = t * 0.0008;
        const r = 16;
        // 外リング
        ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
        // 内側ダイヤ
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.5); ctx.lineTo(r * 0.5, 0); ctx.lineTo(0, r * 0.5); ctx.lineTo(-r * 0.5, 0);
        ctx.closePath(); ctx.stroke();
        // 回転腕
        ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 1.5;
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

    // (第13弾: 旧スクリーン空間スレットリング(4帯域リング)は撤去 — 気配リング・受信ブリップ・バンドチューナーと情報が重複していた)
}

// ═══ 第15弾: ヒッグスの航跡 ═══
const WAKE_LIFE = 5400;   // 90秒
const WAKE_SAMPLE = 30;   // 0.5秒毎に記録
const WAKE_READ_ENEMY = 3200; // 敵が航跡を読める距離
function _speedFrac(spd, cls) { return (spd || 0) / Math.max(0.1, gameSpeedFactor) / (shipCruiseSpeed(cls, 100, 1) || 1); }
function _shipClass(e) { return e.type === 'carrier' ? 'carrier' : e.type === 'corvette' ? 'stealth' : 'assault'; }
// 航跡の深さ = 速さ × 霧の濃さ。濃い霧の中を速く動くほど深く長く残る (霧は音を隠すが、動きは記録する)
function recordWake(owner, x, y, frac, hullMul = 1, exhaust = true) {
    if (frac < 0.06) return;
    const h = getHiggsIntensity(x, y);
    // 第17弾: 推力の排気が無い (機関停止) と、霧を乱す分だけが残る
    let st = Math.pow(Math.min(1.6, frac), 0.9) * ((exhaust ? 0.55 : 0) + 0.9 * h) * hullMul;
    if (surgePhase === 'active') st *= SURGE_WAKE_MULT;
    if (silentRunning && owner === 'player') st *= 0.7;
    if (owner === 'player') st *= PM.wake; // 第32弾: ベクターノズル
    if (st < 0.03) return;
    let rb = null;
    for (const w of wakeRibbons) if (w.owner === owner && !w.closed) { rb = w; break; }
    const last = rb && rb.pts[rb.pts.length - 1];
    if (!rb || Math.hypot(x - last.x, y - last.y) > 900) { if (rb) rb.closed = true; rb = { owner, pts: [] }; wakeRibbons.push(rb); }
    rb.pts.push({ x, y, f: _frameCount, s: Math.min(1, st) });
}
function updateWakes() {
    if (_frameCount % WAKE_SAMPLE === 0) {
        if (player && player.hp > 0) recordWake('player', player.x, player.y, _speedFrac(player.currentSpeed, gameState.shipType), gameState.shipType === 'stealth' ? STEALTH_WAKE_MULT : 1, !playerCoasting);
        // 第17弾: ノイズメーカーは自艦の全速と同じ航跡を引く (敵はこれも辿る)
        for (const n of noiseMakers) recordWake(n._wid, n.x, n.y, _speedFrac(Math.hypot(n.vx, n.vy) * gameSpeedFactor, gameState.shipType), gameState.shipType === 'stealth' ? STEALTH_WAKE_MULT : 1);
        for (const e of enemies) if (e.hp > 0 && !e._dying && e.type !== 'fighter') recordWake(enemySid(e), e.x, e.y, _speedFrac(e._spd, _shipClass(e)), (_shipClass(e) === 'stealth' ? STEALTH_WAKE_MULT : 1) * epm(e).wake);
        for (const d of decoys) recordWake(d._wid || (d._wid = 'decoy-' + (++_wakeIdSeq)), d.x, d.y, Math.hypot(d.vx, d.vy) / 2);
    }
    const cx = higgsCurrent.x * gameSpeedFactor, cy = higgsCurrent.y * gameSpeedFactor;
    for (let i = wakeRibbons.length - 1; i >= 0; i--) {
        const rb = wakeRibbons[i];
        let k = 0;
        while (k < rb.pts.length && _frameCount - rb.pts[k].f > WAKE_LIFE) k++;
        if (k) rb.pts.splice(0, k);
        if (!rb.pts.length) { wakeRibbons.splice(i, 1); continue; }
        for (const p of rb.pts) { p.x += cx; p.y += cy; }
    }
}
// 敵が自分の近くの航跡を読む: 新しい側へ辿った先にプレイヤーが居ると推測する。
// 自艦・僚艦の航跡は読まない。デコイの航跡は見分けられない (= 偽の足跡で釣れる)。
function readWakeClue(e) {
    const own = enemySid(e);
    const R = WAKE_READ_ENEMY * (1 + gameState.sector * 0.05) * (1 - shipSelfNoise(e) * 0.4);
    let best = null, bv = 0.12;
    for (const rb of wakeRibbons) {
        if (rb.owner === own || rb.owner.startsWith('e-')) continue;
        const pts = rb.pts;
        for (let i = pts.length - 1; i >= 0; i -= 2) {
            const p = pts[i], age = _frameCount - p.f;
            if (age > 3600) break;
            const d = Math.hypot(e.x - p.x, e.y - p.y);
            if (d > R) continue;
            const v = p.s * (1 - age / WAKE_LIFE) * (1 - d / R);
            if (v > bv) { bv = v; best = { rb, i }; }
        }
    }
    if (!best) return null;
    const pts = best.rb.pts, p = pts[best.i], q = pts[Math.min(pts.length - 1, best.i + 6)];
    const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy);
    if (L < 1) return { x: q.x, y: q.y };
    return { x: q.x + dx / L * 2000, y: q.y + dy / L * 2000 };
}
// 航跡の描画 (ワールド空間・フォグの手前)。自分の航跡は常に薄く見える (=記録を残していることの自覚)。
// 他艦の航跡は HIGGS 帯に同調している時だけ、受信範囲の半分まで見える。
function drawWakes(ctx) {
    if (!player) return;
    const zi = 1 / camera.zoom;
    const higgsOn = sensorsOn.higgs;
    const readR = passiveRange() * 0.55;
    ctx.save();
    ctx.lineCap = 'round';
    for (const rb of wakeRibbons) {
        const own = rb.owner === 'player';
        if (!own && !higgsOn && !higgsViewOff) continue;
        const pts = rb.pts;
        if (pts.length < 2) continue;
        ctx.strokeStyle = own ? '#bee1ff' : '#46ebff';
        for (let i = 1; i < pts.length; i += 5) {
            const j = Math.min(pts.length - 1, i + 5);
            const pm = pts[Math.min(pts.length - 1, i + 2)];
            if (!own && !higgsViewOff && Math.hypot(pm.x - player.x, pm.y - player.y) > readR) continue;
            const ageF = (_frameCount - pm.f) / WAKE_LIFE;
            const a = Math.min(1, pm.s * 1.3) * (1 - ageF) * (own ? 0.45 : 0.95);
            if (a < 0.02) continue;
            const w = 40 + 260 * ageF; // 時間とともに拡散
            ctx.beginPath();
            ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
            for (let k = i; k <= j; k++) ctx.lineTo(pts[k].x, pts[k].y);
            ctx.globalAlpha = a * 0.25;
            ctx.lineWidth = Math.max(4 * zi, w);
            ctx.stroke();
            ctx.globalAlpha = a;
            ctx.lineWidth = Math.max(1.6 * zi, w * 0.12);
            ctx.stroke();
        }
    }
    ctx.restore();
}

// 霧そのものを見せる (第15弾): 画面に漂う微粒子。霧の濃い所ほど濃く、霧の流れ(higgsCurrent)に乗って流れ、
// 自艦が動くと押し分けられる。情報ではなく「媒質の中に居る」感覚のための演出 (薄く・軽く)。
const _motes = [];
let _moteCam = null;
function drawHiggsMedium(ctx) {
    if (!player || player.hp <= 0 || mapMode) return;
    const ins = uiInsets();
    const L = ins.left, T = ins.top, W = cssW - ins.left - ins.right, H = cssH - ins.top;
    if (W < 50 || H < 50) return;
    const N = _isMobile ? 110 : 180;
    if (_motes.length !== N) {
        _motes.length = 0;
        for (let i = 0; i < N; i++) _motes.push({ x: L + Math.random() * W, y: T + Math.random() * H, d: 0.35 + Math.random() * 0.65, h: 0, k: i });
    }
    const z = camera.zoom;
    let dx = 0, dy = 0;
    if (_moteCam && _moteCam.z === z) { dx = (camera.x - _moteCam.x) * z; dy = (camera.y - _moteCam.y) * z; if (Math.abs(dx) > W || Math.abs(dy) > H) { dx = 0; dy = 0; } }
    _moteCam = { x: camera.x, y: camera.y, z };
    const fx = higgsCurrent.x * z * 6, fy = higgsCurrent.y * z * 6; // 流れは視認できるよう誇張
    const pp = worldToScreen(player.x, player.y);
    const pv = (player.currentSpeed || 0) * z;
    ctx.save();
    ctx.fillStyle = '#9fe9ff';
    for (const m of _motes) {
        m.x += (fx - dx) * m.d; m.y += (fy - dy) * m.d;
        const ex = m.x - pp.sx, ey = m.y - pp.sy, ed = ex * ex + ey * ey;
        if (pv > 0.15 && ed < 3600) { const e = Math.sqrt(ed) || 1; m.x += ex / e * pv * 0.7; m.y += ey / e * pv * 0.7; }
        if (m.x < L) m.x += W; else if (m.x > L + W) m.x -= W;
        if (m.y < T) m.y += H; else if (m.y > T + H) m.y -= H;
        if ((_frameCount + m.k) % 12 === 0) m.h = getHiggsIntensity(camera.x + m.x / z, camera.y + m.y / z);
        const a = (0.03 + m.h * 0.34) * m.d;
        if (a < 0.04) continue;
        ctx.globalAlpha = a;
        const sz = 1 + m.d * 1.2;
        ctx.fillRect(m.x, m.y, sz, sz);
    }
    ctx.restore();
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

// ═══ 第16弾: 積載 — 完成品はすぐ出せるが場所を食う / 資材は半分の場所で同じ数を作れるが、組み立てに時間とシグネチャがかかる ═══
// 数値はオーナー合意 (2026-10-24)。積載枠は艦種ごと、完成品の枠=強さ、資材1枠=2個。同時に出しておける数は従来の CARGO_CAP。
// 積み込み計画 (艦種ごと・保存される)。枠を超えていれば既定値に戻す
function shipLoadout(ship) {
    const src = (gameState.loadout && gameState.loadout[ship]) || DEFAULT_LOADOUT[ship] || {};
    // 第20弾: 弾の項目が無い古い積み込み計画 (第19弾まで) は既定に戻す (枠の大きさも変わったため)
    if (!('ammoK' in src)) return Object.assign({ mat: 0 }, DEFAULT_LOADOUT[ship]);
    const lo = { mat: Math.max(0, src.mat | 0), ammoK: Math.max(0, src.ammoK | 0), ammoM: Math.max(0, src.ammoM | 0) };
    for (const t of SHIP_DRONES[ship] || []) lo[t] = Math.max(0, src[t] | 0);
    return loadoutSlots(lo, ship) <= (HOLD_CAP[ship] || 0) ? lo : Object.assign({ mat: 0 }, DEFAULT_LOADOUT[ship]);
}
function loadoutSlots(lo, ship) {
    let n = (lo.mat || 0) + (lo.ammoK || 0) + (lo.ammoM || 0);
    for (const t of SHIP_DRONES[ship] || []) n += (lo[t] || 0) * DRONE_SPEC[t].w;
    return n;
}
function resetCargo() {
    const lo = shipLoadout(gameState.shipType);
    cargo = { stock: {}, mat: lo.mat * MAT_PER_SLOT, asm: null, ammoK: lo.ammoK * AMMO_PER_SLOT.kinetic, ammoM: lo.ammoM * AMMO_PER_SLOT.missile };
    for (const t of SHIP_DRONES[gameState.shipType] || []) cargo.stock[t] = lo[t] || 0;
    if (player) player.kineticAmmo = Math.min(player.kineticMaxAmmo || KINETIC_MAG, cargo.ammoK);
    _hudCache.cargo = null;
}
// 第20弾: 弾だけを計画どおりに補充 (コロニー)。減っていれば増やす
function refillAmmo() {
    const lo = shipLoadout(gameState.shipType);
    const k = lo.ammoK * AMMO_PER_SLOT.kinetic, m = lo.ammoM * AMMO_PER_SLOT.missile;
    const got = Math.max(0, k - cargo.ammoK) + Math.max(0, m - cargo.ammoM);
    cargo.ammoK = Math.max(cargo.ammoK, k); cargo.ammoM = Math.max(cargo.ammoM, m);
    if (player && !player.kineticReloading) player.kineticAmmo = Math.max(player.kineticAmmo, Math.min(KINETIC_MAG, cargo.ammoK));
    _hudCache.cargo = null;
    return got;
}
// 計画より弾が減っているか (補給が要るか)
function ammoBelowPlan() {
    const lo = shipLoadout(gameState.shipType);
    return cargo.ammoK < lo.ammoK * AMMO_PER_SLOT.kinetic || cargo.ammoM < lo.ammoM * AMMO_PER_SLOT.missile;
}
// ミサイルを1発使う (無ければ撃てない)
function useMissileAmmo() {
    if ((cargo.ammoM || 0) <= 0) { logMessage('WEP: ミサイル切れ — 占有したコロニーで補給', 'warning-msg'); return false; }
    cargo.ammoM--; _hudCache.cargo = null;
    if (cargo.ammoM === 0) logMessage('WEP: ミサイルを撃ち尽くした — 占有したコロニーで補給', 'warning-msg');
    return true;
}
function cargoStockSlots() {
    let n = 0;
    for (const t in cargo.stock) n += (cargo.stock[t] || 0) * DRONE_SPEC[t].w;
    return n + Math.ceil((cargo.ammoK || 0) / AMMO_PER_SLOT.kinetic) + Math.ceil((cargo.ammoM || 0) / AMMO_PER_SLOT.missile); // 第20弾: 弾も枠を使う
}
// 資材は「完成品と弾が占めていない枠」までしか積めない (展開・射撃して空いた枠に補給できる)
function cargoMatCap() { return Math.max(0, (playerHoldCap() - cargoStockSlots()) * MAT_PER_SLOT); } // 第32弾: 格納庫拡張
function addMaterials(n) {
    const before = cargo.mat;
    cargo.mat = Math.min(cargoMatCap(), cargo.mat + n);
    _hudCache.cargo = null;
    return cargo.mat - before;
}
function activeDeployCount() { return playerDrones.length + (gameState.shipType === 'stealth' ? decoys.length : 0); }
function canDeployNow(type) {
    const capOk = DRONE_SPEC[type].item || activeDeployCount() < (CARGO_CAP[gameState.shipType] || 0);
    return capOk && ((cargo.stock[type] || 0) > 0 || (!cargo.asm && cargo.mat >= DRONE_SPEC[type].mat));
}

// 展開ボタン: 完成品があれば即座に / 無ければ資材から組み立て (完成したら自動で出す)
function deployDrone(type, tx, ty) {
    if (!player || player.hp <= 0) return;
    const ship = gameState.shipType, spec = DRONE_SPEC[type];
    if (!spec || !(SHIP_DRONES[ship] || []).includes(type)) { logMessage(`搭載: ${spec ? spec.label : type} はこの艦に積めない`, 'warning-msg'); return; }
    // 第21弾: 囮は射出する地点が要る — 地点が無ければ「次にタップした地点」へ (長押しメニューからも撃てる)
    const _freeLure = type === 'lure' && (cargo.stock.lure || 0) <= 0 && PM.lureFree && _lureFreeCD <= 0; // 第32弾: 囮発射機
    if (_freeLure && tx !== undefined) {
        _lureFreeCD = LURE_FREE_CD;
        useEscapeItem('lure', tx, ty);
        logMessage('囮発射機: 次まで' + Math.round(LURE_FREE_CD / 60) + '秒', 'system-msg');
        return;
    }
    if (spec.lure && tx === undefined) {
        if (pendingLure === type) { pendingLure = null; logMessage('囮: 射出を取りやめ', 'system-msg'); return; }
        if (!_freeLure && (cargo.stock[type] || 0) <= 0 && (cargo.asm || cargo.mat < spec.mat)) { logMessage(`搭載: ${spec.label}の完成品が無く${cargo.asm ? '組み立て中' : '資材も足りない'}`, 'warning-msg'); return; }
        pendingLure = type;
        logMessage('囮: ' + spec.label + 'を射出する地点をタップ (もう一度押すと取りやめ)', 'warning-msg');
        playSound('ui');
        return;
    }
    if (type === 'repair') { // 第26弾: リペアキット — 完成品だけ (資材から作れない)
        if ((cargo.stock.repair || 0) <= 0) { logMessage('修理: リペアキットが無い — 出撃前の積み込みでしか積めない (補給もできない)', 'warning-msg'); return; }
        if (player._kitT > 0) { logMessage('修理: リペアキットを使っている最中 (残り' + Math.ceil(player._kitT / 60) + '秒)', 'warning-msg'); return; }
        if (player.hp >= player.maxHp) { logMessage('修理: 損傷なし — キットは取っておく', 'system-msg'); return; }
    }
    if ((cargo.stock[type] || 0) > 0) {
        if (!spec.item && activeDeployCount() >= CARGO_CAP[ship]) { logMessage(`搭載: 同時に出しておけるのは${CARGO_CAP[ship]}機まで`, 'warning-msg'); return; }
        cargo.stock[type]--;
        _hudCache.cargo = null;
        _spawnDrone(type, tx, ty);
        return;
    }
    if (spec.noBuild) return;
    if (cargo.asm) { logMessage(`搭載: ${DRONE_SPEC[cargo.asm.type].label}を組み立て中 (残り${Math.max(0, Math.ceil(cargo.asm.t / 60))}秒)`, 'warning-msg'); return; }
    if (cargo.mat < spec.mat) { logMessage(`搭載: ${spec.label}の完成品が無く資材も足りない (必要${spec.mat}個・残り${cargo.mat}個) — ノードを制圧すると補給できる`, 'warning-msg'); return; }
    cargo.mat -= spec.mat;
    cargo.asm = { type, t: spec.build, total: spec.build, ready: false, tx, ty };
    _hudCache.cargo = null;
    logMessage(`搭載: ${spec.label}を資材から組み立て開始 (${Math.round(spec.build / 60)}秒)${spec.item ? ' — 完成した瞬間に使う' : ''} — 組み立て中はEMが漏れる`, 'warning-msg');
    playSound('ui');
}
function _spawnDrone(type, tx, ty) {
    const spec = DRONE_SPEC[type];
    if (spec.item) { useEscapeItem(type, tx, ty); return; }
    if (type === 'decoy' && gameState.shipType === 'stealth') {
        // 潜航型のデコイは射出型 (§3-5: 慣性で飛ぶ強EM源・敵の推定位置を書き換える)
        const ang = player.angle, sp = 4;
        decoys.push({ x: player.x + Math.cos(ang) * 30, y: player.y + Math.sin(ang) * 30, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: DECOY_LIFE });
        logMessage('DECOY: 強EMデコイ射出 — 敵ミサイルを誘引', 'system-msg');
    } else {
        const ang = player.angle + (Math.random() - 0.5);
        playerDrones.push(new Drone(type, player.x + Math.cos(ang) * 45, player.y + Math.sin(ang) * 45));
        player._launchFlash = 60; // 第20弾: 発進は光とEMが漏れる
        if (spec.placed) {
            // 設置物は艦を止めて据え付ける (§3-6残: 停止中=脆弱ウィンドウ)
            buildingTimer = BUILD_STOP_DUR;
            logMessage(`搭載: ${spec.label}を設置 — ${Math.round(BUILD_STOP_DUR / 60)}秒停止・全センサーに脆弱`, 'warning-msg');
        } else {
            logMessage(`搭載: ${spec.label}を展開`, 'system-msg');
        }
    }
    playSound('ui');
}
function updateCargo() {
    const a = cargo.asm;
    if (!a || !player || player.hp <= 0) return;
    if (!a.ready) {
        a.t -= gameSpeedFactor;
        if (a.t <= 0) { a.ready = true; logMessage(`搭載: ${DRONE_SPEC[a.type].label} 組み立て完了`, 'system-msg'); }
    }
    if (a.ready && (DRONE_SPEC[a.type].item || activeDeployCount() < (CARGO_CAP[gameState.shipType] || 0))) { cargo.asm = null; _hudCache.cargo = null; _spawnDrone(a.type, a.tx, a.ty); }
}
// 組み立て中か (シグネチャ・表示用)
function cargoAssembling() { return !!(cargo.asm && !cargo.asm.ready); }

// ═══ 第17弾: 緊急離脱 — 敵が追ってくる鎖 (探知→推定位置→探信/航跡→速さ) のどこかを切る道具 ═══
// 数値はオーナー合意 (2026-10-25)。消耗品は積載の枠を使い、機関停止・緊急噴射は艦の機能 (枠を使わない)
function useEscapeItem(type, tx, ty) {
    if (!player || player.hp <= 0) return;
    if (type === 'flash') useFlash();
    else if (type === 'noise') useNoise();
    else if (type === 'smoke') useSmoke();
    else if (type === 'repair') {
        player._kitT = REPAIR_KIT_TIME;
        matchRecEvent('repairP', player.x, player.y, '自艦: リペアキットを使う');
        logMessage('修理: リペアキット — 6秒で耐久+' + Math.round(REPAIR_KIT_HP * PM.kit) + ' (残り' + (cargo.stock.repair || 0) + '個)', 'system-msg');
    }
    else if (type === 'fsos' || type === 'lure') {
        launchLure('p', type === 'fsos' ? 'sos' : 'ship', player.x, player.y, tx ?? player.x + Math.cos(player.angle) * 3000, ty ?? player.y + Math.sin(player.angle) * 3000);
        logMessage('囮: ' + DRONE_SPEC[type].label + 'を射出 — ' + _dirTxt(player.x, player.y, tx ?? player.x, ty ?? player.y) + (type === 'fsos' ? '。着いたら本物と同じ遭難信号を90秒出す' : '。着いたら巡航中の艦なみの熱・光・EM・航跡を60秒出す'), 'system-msg');
    }
    if (huntStats) huntStats.escapeItems = (huntStats.escapeItems || 0) + 1;
    _updateEscapeBtns();
}
// 閃光弾: 自艦の位置で炸裂。近くの敵の目を焼き、飛んでくるミサイルの誘導を切る。
// 代償: 閃光を見た敵は「その瞬間そこに居た」と分かる → 目が眩んでいる間に進路を変えて離れないと意味がない
function useFlash() {
    const px = player.x, py = player.y;
    const vx = player.x - (player.prevX ?? player.x), vy = player.y - (player.prevY ?? player.y);
    let blinded = 0, lost = 0;
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying) continue;
        const d = Math.hypot(e.x - px, e.y - py);
        if (d < FLASH_RADIUS) {
            e._sysSensorTimer = Math.max(e._sysSensorTimer || 0, FLASH_BLIND);
            blinded++;
        } else {
            // 範囲外でも光は見える (霧越しでは光学は減衰する)
            const hMid = getHiggsIntensity((e.x + px) / 2, (e.y + py) / 2);
            if (d > ENEMY_PASSIVE_RANGE * (1 - hMid * sensorConfig.optic.higgsMod)) continue;
        }
        e.playerLastKnownPos = { x: px, y: py, vx, vy };
        e.contactFreshness = Math.max(e.contactFreshness || 0, 0.9);
        if (e.aiState === 'lurking' || e.aiState === 'gathering') { e.aiState = 'hunting'; e.huntTimer = 600 + d / 1.2; }
        if (comDemo && e.type !== 'fighter') comThinkEvent('e', (d < FLASH_RADIUS ? '閃光でセンサーが焼けた (' + Math.round(FLASH_BLIND / 60) + '秒ほぼ盲目)。' : '') + '閃光を見た → 炸裂点 (' + _dirTxt(e.x, e.y, px, py) + ') に自機が居たと分かる', 'e' + e.uid);
    }
    for (const p of projectiles) {
        if (p.isPlayer || !p.active || p.type !== 'missile' || p._blind) continue;
        if (p.owner && epm(p.owner).seeker && Math.random() < 0.6) continue; // 第33弾: 敵の囮耐性シーカー
        if (Math.hypot(p.x - px, p.y - py) < FLASH_RADIUS) { p._blind = true; lost++; }
    }
    effects.push({ x: px, y: py, r: 0, maxR: FLASH_RADIUS, a: 0.9, c: '#ffffff', type: 'circle' });
    effects.push({ x: px, y: py, r: 0, maxR: FLASH_RADIUS * 0.55, a: 0.7, c: '#fff6cc', type: 'circle' });
    _flashScreen = 18;
    playSound('alert');
    matchRecEvent('flashP', px, py, '自艦: 閃光弾' + (blinded ? ' (敵' + blinded + '隻の目を焼いた)' : ''));
    logMessage('離脱: 閃光弾 — ' + (blinded ? '敵' + blinded + '隻の目を' + Math.round(FLASH_BLIND / 60) + '秒焼いた' : '半径' + FLASH_RADIUS + 'u内に敵なし')
        + (lost ? '・ミサイル' + lost + '発の誘導を切った' : '') + '。この位置は知られた — 進路を変えて離れろ', 'warning-msg');
}
// ノイズメーカー: 自艦の全速と同じ熱と航跡を出しながら艦首方向へ直進する囮。
// 敵は「強い方の音」を自艦と思い込む → こちらは潜航/機関停止で別方向へ
function useNoise() {
    if (player) matchRecEvent('escP', player.x, player.y, '自艦: ノイズメーカー');
    const sp = shipCruiseSpeed(gameState.shipType, genAlloc.engine, STANCE_GAIN.flank);
    const a = player.angle;
    noiseMakers.push({ x: player.x + Math.cos(a) * 40, y: player.y + Math.sin(a) * 40, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: NOISE_LIFE, _wid: 'noise-' + (++_wakeIdSeq) });
    playSound('ui');
    logMessage('離脱: ノイズメーカー投下 — 方位' + compassDeg(a) + '°へ全速の音を' + Math.round(NOISE_LIFE / 60) + '秒出す。こちらは音を消して別方向へ', 'system-msg');
}
// 煙幕弾: 自艦の位置に濃いヒッグス雲。濃さ0.5以上なら敵の探信が埋もれ、光学と至近探知が鈍る。
// ただし霧の中では自分の有視界も縮み、動けば航跡が深く残る (ヒッグス帯の受信は霧で減衰しない)
function useSmoke() {
    smokeClouds.push({ x: player.x, y: player.y, r: SMOKE_R, dens: SMOKE_DENS, life: SMOKE_LIFE, max: SMOKE_LIFE, follow: null });
    matchRecEvent('escP', player.x, player.y, '自艦: 煙幕弾');
    playSound('ui');
    logMessage('離脱: 煙幕弾 — 半径' + SMOKE_R + 'uにヒッグス雲 (' + Math.round(SMOKE_LIFE / 60) + '秒)。中では探信が埋もれる。動けば航跡は深く残る', 'system-msg');
}
// 第22弾: 敵も離脱の消耗品を使う (積み込みで持たせた分だけ・自機と同じ効き目)
function enemyUseFlash(e) {
    if (!(e.itemFlash > 0)) return false;
    e.itemFlash--;
    const d = player ? Math.hypot(player.x - e.x, player.y - e.y) : 1e9;
    if (player && player.hp > 0 && d < FLASH_RADIUS) player._sysSensorTimer = Math.max(player._sysSensorTimer || 0, FLASH_BLIND);
    let lost = 0;
    for (const p of projectiles) {
        if (!p.isPlayer || !p.active || p.type !== 'missile' || p._blind) continue;
        if (PM.seeker && Math.random() < 0.6) continue; // 第32弾: 囮耐性シーカー
        if (Math.hypot(p.x - e.x, p.y - e.y) < FLASH_RADIUS) { p._blind = true; lost++; }
    }
    effects.push({ x: e.x, y: e.y, r: 0, maxR: FLASH_RADIUS, a: 0.9, c: '#ffffff', type: 'circle' });
    effects.push({ x: e.x, y: e.y, r: 0, maxR: FLASH_RADIUS * 0.55, a: 0.7, c: '#fff6cc', type: 'circle' });
    // 閃光は見える (霧越しでは光学が減衰) → 炸裂点の方位線が入る
    const hMid = player ? getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2) : 0;
    if (player && player.hp > 0 && d < ENEMY_PASSIVE_RANGE * (1 - hMid * sensorConfig.optic.higgsMod)) {
        const ang = Math.atan2(e.y - player.y, e.x - player.x);
        addBearingObs(enemySid(e), player.x, player.y, ang, 0.03, 1, '255,255,255');
        ringMarkBearing(compassDeg(ang), '#ffffff');
        logMessage('SENSOR: 閃光 — 方位' + compassDeg(ang) + '°' + (d < FLASH_RADIUS ? '。センサーが焼けた (' + Math.round(FLASH_BLIND / 60) + '秒)' : '') + (lost ? '・ミサイル' + lost + '発の誘導が切れた' : ''), 'warning-msg');
        if (d < FLASH_RADIUS) _flashScreen = 18;
    }
    if (comDemo) comThinkEvent('e', '閃光弾 — 追手の目を焼く' + (lost ? ' (ミサイル' + lost + '発の誘導を切った)' : ''), 'e' + e.uid);
    if (typeof matchRecEvent === 'function') matchRecEvent('flashE', e.x, e.y, '敵の閃光弾');
    return true;
}
function enemyUseSmoke(e) {
    if (!(e.itemSmoke > 0)) return false;
    e.itemSmoke--;
    smokeClouds.push({ x: e.x, y: e.y, r: SMOKE_R, dens: SMOKE_DENS, life: SMOKE_LIFE, max: SMOKE_LIFE, follow: null });
    if (comDemo) comThinkEvent('e', '煙幕弾 — この場にヒッグス雲 (' + Math.round(SMOKE_LIFE / 60) + '秒)', 'e' + e.uid);
    if (typeof matchRecEvent === 'function') matchRecEvent('smokeE', e.x, e.y, '敵の煙幕弾');
    return true;
}
function enemyUseNoise(e, ang) {
    if (!(e.itemNoise > 0)) return false;
    e.itemNoise--;
    const ms = e._maxSpeeds ? e._maxSpeeds() : null, v = ms ? ms.flank : 1.5;
    // 偽艦影と同じ仕組みで、全速で12秒まっすぐ進む音源 (自機の受信には艦と同じに聞こえる)
    const seq = ++_lureSeq;
    lures.push({ owner: 'e', kind: 'ship', noise: true, x: e.x, y: e.y, tx: e.x, ty: e.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, a: ang, phase: 'on', life: NOISE_LIFE, sid: 'L-' + seq, wid: 'e-lure-' + seq });
    if (comDemo) comThinkEvent('e', 'ノイズメーカー — ' + _dirTxt(e.x, e.y, e.x + Math.cos(ang) * 3000, e.y + Math.sin(ang) * 3000) + 'へ走らせて耳を逸らす', 'e' + e.uid);
    return true;
}
// 機関停止 (惰性): 推力が無いので熱と推進のEMが消える。進路は変えられない (艦首は回して撃てる)。
// 速度は霧の外で20秒で半減、霧が濃いほど早く止まる。移動命令・出力の切替・もう一度押すと再点火
function toggleCoast(on) {
    if (!player || player.hp <= 0) return;
    if (on === undefined) on = !playerCoasting;
    if (on === playerCoasting) return;
    if (on) {
        if (repairActive || buildingTimer > 0) { logMessage('離脱: 修復・設置の最中は機関を止めて漂えない', 'warning-msg'); return; }
        if (boostT > 0) { boostT = 0; player._sysEngineTimer = Math.max(player._sysEngineTimer || 0, BOOST_OVERHEAT * PM.overheat); }
        playerCoasting = true;
        player._coastAng = player.angle;
        logMessage('離脱: 機関停止 — ' + Math.round(player.currentSpeed * 60) + 'u/sで方位' + compassDeg(player.angle) + '°へ漂う。推力の熱と音が消える (進路は変えられない・霧の中では航跡が残る)', 'system-msg');
    } else {
        if (engineSwitchT > 0) { logMessage('ENG: エンジン切替中は点火できない (あと' + Math.ceil(engineSwitchT / 60) + '秒)', 'warning-msg'); return; } // 第21弾
        playerCoasting = false;
        logMessage('離脱: 機関再点火 — 推力の熱が戻る', 'system-msg');
    }
    playSound('ui');
    _updateEscapeBtns();
}
// 緊急噴射: 4秒だけ速度×2。終わると機関が8秒過熱 (既存の機関損傷と同じ: 最高速×0.45・熱漏れ)。再使用45秒
function useBoost() {
    if (!player || player.hp <= 0) return;
    if (boostCD > 0) { logMessage('離脱: 緊急噴射は再使用まで' + Math.ceil(boostCD / 60) + '秒', 'warning-msg'); return; }
    if ((player._sysEngineTimer || 0) > 0) { logMessage('離脱: 機関が損傷・過熱中 — 噴射できない', 'warning-msg'); return; }
    if (repairActive || buildingTimer > 0) { logMessage('離脱: 修復・設置の最中は噴射できない', 'warning-msg'); return; }
    if (engineSwitchT > 0) { logMessage('離脱: エンジン切替中は噴射できない', 'warning-msg'); return; } // 第21弾
    if (playerCoasting) { playerCoasting = false; }
    if (silentRunning) setStance('cruise', true);
    boostT = BOOST_DUR; boostCD = BOOST_CD;
    matchRecEvent('escP', player.x, player.y, '自艦: 緊急噴射');
    playSound('alert');
    logMessage('離脱: 緊急噴射 — ' + Math.round(BOOST_DUR / 60) + '秒間 速度×' + BOOST_MULT + '。熱が最大になり、終わると機関が' + Math.round(BOOST_OVERHEAT / 60) + '秒過熱する', 'warning-msg');
    _updateEscapeBtns();
}
// ═══ 第28弾 (オーナー指示): 実弾を選んでいる時、飛んでくるミサイルを確率で撃ち落とす (自機/敵とも同じ) ═══
// 撃ち落としすぎないための要素 (実装で決めた値): ミサイル1発につき機会は1回だけ (450u以内に入った時) / 射角(±150°)の内だけ /
// 弾倉から2斉射ぶん使う (弾も減る・リロード中や弾切れは撃てない) / 撃った瞬間は砲口の閃光で位置が見える / 0.5秒は艦への射撃ができない /
// 確率 = 25% (正面±30°から来るミサイルは+10%) × AI誘導ミサイルは0.6 × センサー撹乱中は0.5
const PD_RANGE = 450, PD_BASE = 0.25, PD_HEADON = 0.10, PD_SMART_MULT = 0.6, PD_COST = 2, PD_COOLDOWN = 30;
function _pdReady(s, isPlayer) {
    if (!s || s.hp <= 0 || s._dying || (s._weaponJamTimer || 0) > 0) return false;
    if (isPlayer) return currentWeapon() === 'kinetic' && !s.kineticReloading && s.kineticAmmo > 0 && cargo.ammoK > 0;
    return s.type !== 'fighter' && s.weaponType === 'kinetic' && !(s._kReload > 0) && (s._kMag ?? KINETIC_MAG) > 0 && (s.ammoK ?? 1) > 0;
}
function _pdSpend(s, isPlayer) {
    if (isPlayer) {
        const n = Math.min(PD_COST, s.kineticAmmo, cargo.ammoK);
        s.kineticAmmo -= n; cargo.ammoK -= n; _hudCache.cargo = null;
        if (s.kineticAmmo <= 0 && cargo.ammoK > 0) { s.kineticReloading = true; s.kineticReloadTimer = KINETIC_RELOAD_TIME; }
    } else {
        const n = Math.min(PD_COST, s._kMag ?? KINETIC_MAG, s.ammoK ?? PD_COST);
        s._kMag = (s._kMag ?? KINETIC_MAG) - n; if (s.ammoK !== undefined) s.ammoK -= n;
        if (s._kMag <= 0) s._kReload = KINETIC_RELOAD_TIME;
    }
    s.fireCooldown = Math.max(s.fireCooldown || 0, PD_COOLDOWN);
    s.fireFlashTimer = Math.max(s.fireFlashTimer || 0, 40); // 砲口の閃光 (光学で見える)
}
function updatePointDefense() {
    for (const p of projectiles) {
        if (!p.active || p.type !== 'missile' || p._pdTried) continue;
        let def = null;
        if (!p.isPlayer) { if (player && Math.hypot(player.x - p.x, player.y - p.y) < PM.pdRange) def = player; } // 第32弾: 迎撃管制
        else for (const e of enemies) { if (e.hp > 0 && !e._dying && e.type !== 'fighter' && Math.hypot(e.x - p.x, e.y - p.y) < epm(e).pdRange) { def = e; break; } } // 第33弾: 敵の迎撃管制
        if (!def) continue;
        p._pdTried = true; // 機会は1回
        const isP = def === player;
        if (!_pdReady(def, isP)) continue;
        const ang = Math.atan2(p.y - def.y, p.x - def.x);
        if (Math.abs(_angDiff(ang, def.angle)) > WEAPON_FIRE_ARC.kinetic) continue; // 射角の外 (真後ろ) からは撃てない
        let ch = PD_BASE + (Math.abs(_angDiff(ang, def.angle)) < Math.PI / 6 ? PD_HEADON : 0) + (def === player ? PM.pdBonus : epm(def).pdBonus);
        if (p.missileMode === 'smart') ch *= PD_SMART_MULT;
        if ((def._daze || 0) > 0) ch *= 0.5;
        _pdSpend(def, isP);
        effects.push({ x: def.x, y: def.y, x2: p.x, y2: p.y, a: 0.9, c: isP ? '#ffe08a' : '#ff9a50', type: 'pdtracer', life: 10 });
        if (Math.random() < ch) {
            p.active = false;
            createExplosion(p.x, p.y, '#ffcc66', 8);
            matchRecEvent(isP ? 'pdP' : 'pdE', p.x, p.y, (isP ? '自艦' : '敵') + 'が実弾でミサイルを撃ち落とした');
            if (isP) logMessage('迎撃: 実弾でミサイルを撃ち落とした (見込み' + Math.round(ch * 100) + '%)', 'system-msg');
            else if (def.inVision || def.contactLife > 0) logMessage('迎撃: 敵艦がミサイルを撃ち落とした', 'warning-msg');
            if (comDemo) comThinkEvent(isP ? 'p' : 'e', '迎撃成功 — 実弾でミサイルを撃ち落とす (見込み' + Math.round(ch * 100) + '%)', isP ? undefined : 'e' + def.uid);
        } else if (isP) logMessage('迎撃: 実弾で撃ったが外れた (見込み' + Math.round(ch * 100) + '%)', 'warning-msg');
    }
}
function updateEscape() {
    if (_flashScreen > 0) _flashScreen--;
    // 第26弾: リペアキットの修理 (自機/敵とも同じ量・時間)
    if (player && player.hp > 0 && player._kitT > 0) { player._kitT -= gameSpeedFactor; player.hp = Math.min(player.maxHp, player.hp + REPAIR_KIT_HP * PM.kit / REPAIR_KIT_TIME * gameSpeedFactor); }
    for (const e of enemies) if (e.hp > 0 && !e._dying && e._kitT > 0) { e._kitT -= gameSpeedFactor; e.hp = Math.min(e.maxHp, e.hp + REPAIR_KIT_HP * epm(e).kit / REPAIR_KIT_TIME * gameSpeedFactor); }
    if (boostCD > 0) boostCD = Math.max(0, boostCD - gameSpeedFactor);
    if (boostT > 0) {
        boostT -= gameSpeedFactor;
        if (boostT <= 0) {
            boostT = 0;
            if (player && player.hp > 0) {
                player._sysEngineTimer = Math.max(player._sysEngineTimer || 0, BOOST_OVERHEAT * PM.overheat);
                logMessage('離脱: 噴射終了 — 機関過熱 ' + Math.round(BOOST_OVERHEAT * PM.overheat / 60) + '秒 (最高速×' + SYS_ENGINE_SLOW + '・熱が漏れる)', 'warning-msg');
            }
        }
    }
    for (let i = noiseMakers.length - 1; i >= 0; i--) {
        const n = noiseMakers[i];
        n.x += n.vx * gameSpeedFactor; n.y += n.vy * gameSpeedFactor;
        n.life -= gameSpeedFactor;
        if (n.life <= 0 || Math.hypot(n.x - MAP_CX, n.y - MAP_CY) > MAP_RADIUS) noiseMakers.splice(i, 1);
    }
    for (let i = smokeClouds.length - 1; i >= 0; i--) {
        const s = smokeClouds[i];
        if (s.follow) {
            if (s.follow.hp <= 0 || !playerDrones.includes(s.follow)) { smokeClouds.splice(i, 1); continue; }
            s.x = s.follow.x; s.y = s.follow.y;
        } else if ((s.life -= gameSpeedFactor) <= 0) smokeClouds.splice(i, 1);
    }
    if (_frameCount % 15 === 0) _updateEscapeBtns();
}
// 右列「離脱」グループのボタン表示 (噴射の残り秒・機関停止の点灯)
function _updateEscapeBtns() {
    const bb = document.getElementById('btn-boost'), bc = document.getElementById('btn-coast');
    if (bb) {
        const em = bb.querySelector('.cg-n');
        const txt = boostT > 0 ? '噴射' : boostCD > 0 ? Math.ceil(boostCD / 60) + 's' : '';
        if (em && em.textContent !== txt) em.textContent = txt;
        bb.classList.toggle('cg-empty', boostCD > 0 && boostT <= 0);
    }
    if (bc) bc.classList.toggle('on', playerCoasting);
    if (typeof _updateExpoChip === 'function') _updateExpoChip();
    const g = document.getElementById('abar-grp-escape');
    if (g) g.classList.toggle('on', playerCoasting || boostT > 0);
}
// ═══ 第21弾: 囮 (偽SOS / 偽艦影ブイ) — 自機/敵とも同じもの。射出 → 地点で作動 → 寿命で消える ═══
function launchLure(owner, kind, fx, fy, tx, ty) {
    const a = Math.atan2(ty - fy, tx - fx), seq = ++_lureSeq;
    matchRecEvent(owner === 'p' ? 'lureP' : 'lureE', tx, ty, (owner === 'p' ? '自艦: ' : '敵: ') + (kind === 'sos' ? '偽SOS' : '偽艦影ブイ') + 'を出す');
    // 航跡の持ち主: 敵の囮は 'e-lure-n' (自機は敵の航跡として読む・敵は自分の航跡として読まない) / 自機の囮は 'lure-n' (敵が自機の航跡として読む)
    lures.push({ owner, kind, x: fx, y: fy, tx, ty, vx: Math.cos(a) * LURE_FLY_SPEED, vy: Math.sin(a) * LURE_FLY_SPEED, a, phase: 'fly', life: 0, sid: 'L-' + seq, wid: (owner === 'e' ? 'e-lure-' : 'lure-') + seq });
    playSound('ui');
}
function updateLures() {
    for (let i = lures.length - 1; i >= 0; i--) {
        const L = lures[i];
        if (L.phase === 'fly') {
            const d = Math.hypot(L.tx - L.x, L.ty - L.y);
            if (d <= LURE_FLY_SPEED * gameSpeedFactor) {
                L.x = L.tx; L.y = L.ty; L.phase = 'on';
                L.life = L.kind === 'sos' ? LURE_SOS_LIFE : LURE_SHIP_LIFE;
                L.vx = Math.cos(L.a) * LURE_SHIP_SPEED; L.vy = Math.sin(L.a) * LURE_SHIP_SPEED;
                if (L.owner === 'e' && L.kind === 'sos' && player && player.hp > 0) {
                    logMessage('SIGNAL: 遭難信号を受信 — 発信源に物資反応 (SOSマーカー)。敵も同じ信号を聞いている', 'warning-msg'); // 本物と同じ告知 (見分けはつかない)
                    playSound('alert');
                }
            } else { L.x += L.vx * gameSpeedFactor; L.y += L.vy * gameSpeedFactor; }
            continue;
        }
        if (L.kind === 'ship') {
            L.x += L.vx * gameSpeedFactor; L.y += L.vy * gameSpeedFactor;
            recordWake(L.wid, L.x, L.y, 0.6, 1);
        }
        if ((L.life -= gameSpeedFactor) <= 0 || Math.hypot(L.x - MAP_CX, L.y - MAP_CY) > MAP_RADIUS) { lures.splice(i, 1); continue; }
        // 第23弾: 敵の偽艦影/ノイズが有視界に入れば正体が分かる
        if (L.kind === 'ship' && L.owner === 'e' && L.phase === 'on' && player && player.hp > 0 && !(_sigIdent[L.sid] && _sigIdent[L.sid].sure) && inPlayerVision(L.x, L.y)) {
            identSure(L.sid, false);
            if (_contactLabels[L.sid]) logMessage('SIGNAL: SIG-' + String(_contactLabels[L.sid]).padStart(2, '0') + ' は' + (L.noise ? 'ノイズメーカー' : '偽艦影ブイ') + ' — 囮だった', 'warning-msg');
        }
        // 偽SOSに相手がたどり着くと「何も無い」と分かる
        if (L.kind === 'sos') {
            if (L.owner === 'e' && player && player.hp > 0 && Math.hypot(player.x - L.x, player.y - L.y) < LURE_REVEAL_R) {
                logMessage('SIGNAL: 発信源に物資なし — 囮の信号だった。近くで待ち伏せている恐れ', 'warning-msg');
                playSound('alert'); lures.splice(i, 1); continue;
            }
            if (L.owner === 'p') for (const e of enemies) {
                if (e.hp <= 0 || e.type === 'fighter' || Math.hypot(e.x - L.x, e.y - L.y) >= LURE_REVEAL_R) continue;
                if (comDemo) comThinkEvent('e', '遭難信号の発信源に何も無い — 囮だった (罠を警戒)', 'e' + e.uid);
                e._lureWary = _frameCount + 3600; lures.splice(i, 1); break;
            }
        }
    }
}
// 相手側から見える遭難信号 (本物 + 相手の偽SOS。区別はつかない)。side='p'=自機から見た / 'e'=敵から見た
function beaconsFor(side) {
    const out = [];
    if (distressBeacon && !distressBeacon.claimed) out.push(distressBeacon);
    for (const L of lures) if (L.kind === 'sos' && L.phase === 'on' && L.owner !== side) out.push(L);
    return out;
}
// 自機の偽艦影ブイを、敵の受信に「自機の音」として見せる (ノイズメーカーと同じ扱い)。強さは敵が聴いている帯域で一番強いもの
function lureSigFor(e, L, dn, sigRange) {
    let best = 0;
    for (const b of enemyBands(e)) {
        const hp = getHiggsIntensity((L.x + e.x) / 2, (L.y + e.y) / 2);
        const v = LURE_SIG * Math.min(1, L.life / 60) * (1 - dn / sigRange) * (1 - hp * sensorConfig[b].higgsMod);
        if (v > best) best = v;
    }
    return best;
}
function drawLures(ctx) {
    const zc = 1 / camera.zoom, t = Date.now();
    for (const L of lures) {
        // 自分の囮は常に見える。相手の偽SOSは本物と同じ見た目で別に描く (SOSマーカー)。相手の偽艦影ブイは受信の反応としてだけ出る
        if (L.owner !== 'p') continue;
        const a = L.phase === 'fly' ? 0.9 : Math.min(1, L.life / 60) * (0.6 + Math.sin(t * 0.008) * 0.3);
        ctx.globalAlpha = a;
        ctx.strokeStyle = L.kind === 'sos' ? '#00e5ff' : '#c48bff'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.5 * zc;
        const r = 8 * zc;
        const _li = SPRITES[L.kind === 'sos' ? 'lure_sos' : 'lure_ship']; // 第21弾: 囮の絵
        if (spriteReady(_li)) { const z = 34 * zc; ctx.drawImage(_li, L.x - z / 2, L.y - z / 2, z, z); }
        else { ctx.beginPath(); ctx.arc(L.x, L.y, r, 0, Math.PI * 2); ctx.stroke(); }
        if (L.phase === 'on') { ctx.beginPath(); ctx.arc(L.x, L.y, r * 2.2 + (t % 1200) / 1200 * r * 2, 0, Math.PI * 2); ctx.globalAlpha = a * 0.4; ctx.stroke(); }
        ctx.globalAlpha = a; ctx.font = 'bold ' + Math.round(9 * zc) + 'px Orbitron, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(L.kind === 'sos' ? '囮SOS' : '囮艦影', L.x, L.y - r - 6 * zc);
    }
    ctx.globalAlpha = 1;
}
// 煙幕・ノイズメーカーの描画 (フォグの上 = 自分が出したものは見える)
function drawSmokeClouds(ctx) {
    for (const s of smokeClouds) {
        const a = (s.follow ? 0.22 : 0.32) * _smokeFade(s);
        if (a <= 0.01) continue;
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
        g.addColorStop(0, 'rgba(150,200,255,0.9)');
        g.addColorStop(0.5, 'rgba(120,175,240,0.75)');
        g.addColorStop(1, 'rgba(90,140,220,0)');
        ctx.globalAlpha = a;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
}
function drawNoiseMakers(ctx) {
    const zc = 1 / camera.zoom;
    for (const n of noiseMakers) {
        const a = Math.min(1, n.life / 60);
        ctx.globalAlpha = 0.85 * a;
        ctx.strokeStyle = '#ffaa55'; ctx.lineWidth = 1.5 * zc;
        const r = 7 * zc;
        ctx.beginPath(); ctx.moveTo(n.x, n.y - r); ctx.lineTo(n.x + r, n.y); ctx.lineTo(n.x, n.y + r); ctx.lineTo(n.x - r, n.y); ctx.closePath(); ctx.stroke();
        const sp = Math.hypot(n.vx, n.vy) || 1;
        ctx.globalAlpha = 0.35 * a;
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(n.x - n.vx / sp * 40 * zc, n.y - n.vy / sp * 40 * zc); ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

// ── ドローン本体 ──
class Drone {
    constructor(type, x, y) {
        const spec = DRONE_SPEC[type] || DRONE_SPEC.attack;
        this.type = type;
        this.x = x; this.y = y;
        this.angle = Math.random() * Math.PI * 2;
        this.life = this.maxLife = spec.life; // 第21弾: 寿命では消えない (撃墜されるまで残る。life は描画の残り火にだけ使う)
        this.hp = spec.hp;
        this._q = 1; this._seen = null; this._visPts = null; this._order = droneOrders[type] || null;
        this.fireCD = 0;
        this._meleeCD = 0;
        this.speed = type === 'attack' ? 4.4 : type === 'scout' ? 3.4 : type === 'mech' ? 2.2 : 0;
        if (type === 'decoy') { this.vx = Math.cos(this.angle) * 5; this.vy = Math.sin(this.angle) * 5; }
        this._scanCD = 0; // buoy/higgs用スキャンタイマー
        this._id = (Drone._n = (Drone._n || 0) + 1);
    }
    // 第20弾: このドローンが狙える敵 — 自艦が掴んでいる敵か、ドローン自身の目(1200u)で見えた敵。
    // 指示点(ax,ay)から leash を越えては追わない。自分で見つけた敵はデータリンクで自艦に知らせる
    _seeEnemy(range, ax, ay, leash) {
        let best = null, bd = range;
        for (const e of enemies) {
            if (e.hp <= 0 || e._dying) continue;
            const d = Math.hypot(e.x - this.x, e.y - this.y);
            const own = !!(this._seen && this._seen.has(e)); // 第21弾: ドローン自身の有視界 (視線) で見えている
            if (!e.visible && !own) continue;
            if (Math.hypot(e.x - ax, e.y - ay) > leash) continue;
            if (d < bd) { bd = d; best = e; }
        }
        return best;
    }
    // 第21弾: 自艦との通信の強さ (距離と間の霧) / 自分の有視界 (視線) — 6フレームに1回
    _senseAndLink() {
        if (!player) return;
        const dx = this.x - player.x, dy = this.y - player.y, dist = Math.hypot(dx, dy);
        let q = dist <= DRONE_LINK_FULL ? 1 : Math.max(0, 1 - (dist - DRONE_LINK_FULL) / (DRONE_LINK_LOST - DRONE_LINK_FULL));
        if (q > 0) {
            let hs = 0;
            for (let k = 1; k <= 8; k++) hs += getHiggsIntensity(player.x + dx * k / 9, player.y + dy * k / 9);
            q = Math.max(0, q - (hs / 8) * DRONE_LINK_FOG);
        }
        this._q = q;
        if (q >= DRONE_LINK_WEAK) this._order = droneOrders[this.type] || null; // 届いた指示だけ
        const base = DRONE_VIS[this.type] || 0;
        if (!base) { this._seen = null; this._visPts = null; return; }
        const R = Math.max(Math.min(VIS_CLOSE, base), visionRadiusAt(null, this.x, this.y, base)); // 第22弾: 至近は必ず見える
        const h0 = getHiggsIntensity(this.x, this.y);
        this._visR = R;
        const seen = this._seen || (this._seen = new Set());
        seen.clear();
        for (const e of enemies) {
            if (e.hp <= 0 || e._dying) continue;
            const d = Math.hypot(e.x - this.x, e.y - this.y);
            if (d > R) continue;
            if (losReach(this.x, this.y, Math.atan2(e.y - this.y, e.x - this.x), R, h0) < d) continue;
            seen.add(e);
            if (q >= DRONE_LINK_STRONG) e._dSeenF = _frameCount;              // 自艦も「見える」
            else if (q >= DRONE_LINK_WEAK) applyContact(e, 0.25 + 0.5 * q, 40); // 誤差つきの反応だけ
        }
        // 描画用の縁 (24本の視線)
        const pts = this._visPts || (this._visPts = new Float32Array(24));
        for (let k = 0; k < 24; k++) pts[k] = losReach(this.x, this.y, k / 24 * Math.PI * 2, R, h0);
    }
    _nearestEnemy(range) {
        let best = null, bd = range;
        for (const e of enemies) { if (e.hp <= 0 || !e.visible) continue; const d = Math.hypot(e.x - this.x, e.y - this.y); if (d < bd) { bd = d; best = e; } }
        return best;
    }
    update() {
        if (this.fireCD > 0) this.fireCD--;
        if ((_frameCount + this._id) % 6 === 0) this._senseAndLink();
        if (this.type === 'attack' || this.type === 'mech' || this.type === 'scout') {
            // 第20弾: 指示に従う (種類ごと)。指示点 (無ければ自艦) を基準に、見えた敵を撃ち、居なければ周回/護衛
            // 第21弾: 通信が途切れている間は新しい指示が届かない (最後に届いた指示を続ける)
            const o = this._order;
            const ax = o ? o.x : (player ? player.x : this.x), ay = o ? o.y : (player ? player.y : this.y);
            const engageR = this.type === 'attack' ? DRONE_ATK_RANGE * 1.6 : this.type === 'mech' ? 1600 : 0;
            const tgt = engageR > 0 ? this._seeEnemy(engageR, ax, ay, o ? DRONE_LEASH : Infinity) : null;
            if (this.type === 'scout') {
                if (this._q >= DRONE_LINK_WEAK) for (const e of enemies) { if (e.hp <= 0) continue; if (Math.hypot(e.x - this.x, e.y - this.y) < DRONE_SCOUT_RANGE) applyContact(e, 0.85 * this._q, 30); } // 第21弾: 探知も通信越し
            }
            if (tgt) {
                const a = Math.atan2(tgt.y - this.y, tgt.x - this.x), d = Math.hypot(tgt.x - this.x, tgt.y - this.y);
                this.angle += (((a - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (this.type === 'mech' ? 0.08 : 0.1);
                if (this.type === 'attack') {
                    if (d > 650) { this.x += Math.cos(this.angle) * this.speed; this.y += Math.sin(this.angle) * this.speed; }
                    if (d < DRONE_ATK_RANGE && this.fireCD <= 0 && tgt.hp > 0) { projectiles.push(new Projectile(this.x, this.y, tgt, true, 'kinetic', 0.5)); this.fireCD = 42; }
                } else {
                    // 人型 — 重装・低速。見えている敵へ重砲 (実弾×1.6)。至近に入れば格闘で大打撃
                    if (d > 220) { this.x += Math.cos(this.angle) * this.speed; this.y += Math.sin(this.angle) * this.speed; }
                    if (d < 1000 && this.fireCD <= 0 && tgt.hp > 0) { projectiles.push(new Projectile(this.x, this.y, tgt, true, 'kinetic', 1.6)); this.fireCD = 50; }
                    if (d < 200 && (this._meleeCD -= 1) <= 0 && tgt.hp > 0) {
                        tgt.hp -= 45;
                        if (huntStats) huntStats.dmgDealt += 45;
                        createHitEffect(tgt.x, tgt.y, '#9fe8ff');
                        this._meleeCD = 50;
                    }
                }
            } else if (o) {
                // 指示点へ向かい、着いたら周回 (哨戒=800u / 攻撃=600u)
                const R = o.kind === 'patrol' ? DRONE_PATROL_R : DRONE_ATTACK_ORBIT;
                if (this._orb === undefined) this._orb = Math.random() * Math.PI * 2;
                const dA = Math.hypot(ax - this.x, ay - this.y);
                if (dA > R * 1.3) { this._orb = Math.atan2(this.y - ay, this.x - ax); }
                else this._orb += (this.speed / R) * 0.9;
                const tx = ax + Math.cos(this._orb) * R, ty = ay + Math.sin(this._orb) * R;
                const a = Math.atan2(ty - this.y, tx - this.x);
                this.angle = a;
                const step = Math.min(this.speed, Math.hypot(tx - this.x, ty - this.y));
                this.x += Math.cos(a) * step; this.y += Math.sin(a) * step;
            } else if (player) {
                // 帰還 (既定): 自艦の護衛。哨戒機は自艦の前方を周回
                if (this.type === 'scout') {
                    const d = Math.hypot(player.x - this.x, player.y - this.y);
                    if (d > 2000) { const a = Math.atan2(player.y - this.y, player.x - this.x); this.x += Math.cos(a) * this.speed; this.y += Math.sin(a) * this.speed; }
                    else { this.angle += 0.018; this.x += Math.cos(this.angle) * 1.8; this.y += Math.sin(this.angle) * 1.8; }
                } else {
                    const a = Math.atan2(player.y - this.y, player.x - this.x), d = Math.hypot(player.x - this.x, player.y - this.y);
                    if (d > (this.type === 'mech' ? 380 : 520)) { this.angle = a; this.x += Math.cos(a) * this.speed; this.y += Math.sin(a) * this.speed; }
                }
            }
        } else if (this.type === 'decoy') {
            this.x += this.vx; this.y += this.vy; this.vx *= 0.985; this.vy *= 0.985;
            if ((_frameCount + this._id) % 24 === 0) effects.push({ x: this.x, y: this.y, r: 0, maxR: 240, a: 0.4, c: '#cc99ff', type: 'circle' });
            if (Math.hypot(this.vx, this.vy) < 0.05) { this.vx = 0; this.vy = 0; }
            const _cl = clampToMapCircle(this.x, this.y, 300); this.x = _cl.x; this.y = _cl.y;
        } else if (this.type === 'build') {
            const tgt = this._nearestEnemy(DRONE_TURRET_RANGE);
            if (tgt) { this.angle = Math.atan2(tgt.y - this.y, tgt.x - this.x); if (this.fireCD <= 0 && tgt.hp > 0) { projectiles.push(new Projectile(this.x, this.y, tgt, true, 'kinetic', 0.6)); this.fireCD = 55; } }
        } else if (this.type === 'barrier') {
            // 第22弾: ビームの盾 — 動作は barrierBlocksBeam (相手のビームが撃たれた時に判定)。周期ダメージは撤去
        } else if (this.type === 'buoy') {
            // §3-7 センサーブイ: 広域スキャンで敵コンタクト付与 (EM放射 = 位置特定されやすい)
            if (this._scanCD <= 0) {
                let found = 0;
                for (const e of enemies) {
                    if (e.hp <= 0) continue;
                    if (Math.hypot(e.x - this.x, e.y - this.y) < DRONE_BUOY_RANGE && this._q >= DRONE_LINK_WEAK) {
                        applyContact(e, 0.70 * Math.min(1, this._q / DRONE_LINK_STRONG), 90); // 第21弾: 通信越し
                        found++;
                    }
                }
                if (found > 0) effects.push({ x: this.x, y: this.y, r: 0, maxR: DRONE_BUOY_RANGE * 0.06, a: 0.4, c: '#44ccff', type: 'circle' });
                this._scanCD = 150; // 2.5秒ごとにスキャン
            }
            if (this._scanCD > 0) this._scanCD--;
        } else if (this.type === 'higgs') {
            // §3-7 ヒッグス散布装置: 周囲のヒッグス濃度を高める。
            // 第17弾: 旧実装は見た目の粒(higgsWakes)を撒くだけで、探知に使う濃度(getHiggsIntensity)は変わっていなかった → 稼働中は雲を張る
            if (!this._cloud) { this._cloud = { x: this.x, y: this.y, r: HIGGS_DRONE_R, dens: HIGGS_DRONE_DENS, life: 1, max: 1, follow: this }; smokeClouds.push(this._cloud); }
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
        // 第16弾: 縮小しても見失わないよう、画面上で最低限の大きさを保つ
        const _zs = Math.max(1, (14 / camera.zoom) / 16);
        if (_zs > 1) ctx.scale(_zs, _zs);
        if (this.type === 'mech' && spriteReady(SPRITES['drone_mech'])) {
            // 第20弾: 人型スプライト (上が前)。艦首方向へ向く
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(SPRITES['drone_mech'], -20, -20, 40, 40);
            ctx.rotate(-(this.angle + Math.PI / 2));
        } else if (this.type === 'mech') {
            // 人型 (スプライト読み込み前のベクター): 肩の重砲・胴・脚。艦首方向へ向く
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.fillStyle = '#5d6f86'; ctx.strokeStyle = '#9fe8ff'; ctx.lineWidth = 1.2;
            ctx.fillRect(-6, -2, 12, 13);                         // 胴
            ctx.strokeRect(-6, -2, 12, 13);
            ctx.beginPath(); ctx.arc(0, -6, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // 頭
            ctx.fillRect(-11, -1, 4, 11); ctx.fillRect(7, -1, 4, 11); // 腕
            ctx.fillRect(-5, 11, 4, 9); ctx.fillRect(1, 11, 4, 9);   // 脚
            ctx.fillStyle = '#c9d6e8'; ctx.fillRect(8, -9, 3, 10);    // 肩の重砲
            ctx.fillStyle = '#00ffd0'; ctx.fillRect(-2, -7, 4, 1.5);  // 目
            ctx.rotate(-(this.angle + Math.PI / 2));
        }
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
                ctx.drawImage(_sp, -16, -16, 32, 32);
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
                ctx.drawImage(_sp, -16, -16, 32, 32);
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
                ctx.drawImage(_sp, -16, -16, 32, 32);
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
            // 第22弾: ビームの盾 — 本体 (Higgsfield生成) と半径600uの六角セルの泡 (加算)
            const _bs = SPRITES.drone_barrier, _sh = SPRITES.fx_barrier_shield;
            if (spriteReady(_sh)) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = a * (0.22 + 0.08 * Math.sin(Date.now() * 0.004));
                const R2 = DRONE_BARRIER_RADIUS * 1.08 / _zs; // 盾は世界の大きさ (本体はズームで縮まない描き方なので割り戻す)
                ctx.drawImage(_sh, -R2, -R2, R2 * 2, R2 * 2);
                ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a;
            } else {
                ctx.globalAlpha = a * 0.3; ctx.strokeStyle = '#6699ff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(0, 0, DRONE_BARRIER_RADIUS / _zs, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = a;
            }
            if (spriteReady(_bs)) ctx.drawImage(_bs, -18, -18, 36, 36);
            else {
                ctx.strokeStyle = '#4499ff'; ctx.lineWidth = 1.5; ctx.beginPath();
                for (let i = 0; i < 6; i++) { const ba = (i / 6) * Math.PI * 2; (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, Math.cos(ba) * 8, Math.sin(ba) * 8); }
                ctx.closePath(); ctx.stroke();
            }
        } else if (this.type === 'buoy') {
            const _sp = _droneSprite;
            if (spriteReady(_sp)) {
                ctx.drawImage(_sp, -16, -16, 32, 32);
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
        const _tagMap = { attack: 'FTR', decoy: 'DCY', scout: 'SCT', build: 'TUR', barrier: 'BAR', buoy: 'BUY', higgs: 'HGS', mech: 'MCH' };
        const tag = _tagMap[this.type] || this.type.slice(0, 3).toUpperCase();
        ctx.fillText(tag, 0, -12);
        ctx.restore();
        ctx.globalAlpha = 1;
    }
}

function updatePlayerDrones() {
    for (let i = playerDrones.length - 1; i >= 0; i--) {
        const d = playerDrones[i];
        d.update();
        if (d.hp <= 0) playerDrones.splice(i, 1); // 第21弾: 撃墜されるまで消えない (旧: 寿命40〜120秒で消えていた)
    }
}
// 第21弾: ドローンが強い通信で見ている敵 (自艦の有視界と同じ扱い)
function droneSeesStrong(e) { return (e._dSeenF || -99) >= _frameCount - 7; }
function drawPlayerDrones(ctx) {
    // 第21弾: ドローンの有視界 (薄く) と、弱い/途切れた通信
    const zc = 1 / camera.zoom;
    ctx.save();
    for (const d of playerDrones) {
        if (d._visPts && d._q >= DRONE_LINK_WEAK) {
            ctx.beginPath();
            for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2, r = Math.max(20, d._visPts[k]); const px = d.x + Math.cos(a) * r, py = d.y + Math.sin(a) * r; if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
            ctx.closePath();
            ctx.globalAlpha = d._q >= DRONE_LINK_STRONG ? 0.07 : 0.035;
            ctx.fillStyle = '#9fffe0'; ctx.fill();
            ctx.globalAlpha = d._q >= DRONE_LINK_STRONG ? 0.35 : 0.18;
            ctx.strokeStyle = '#00ffb4'; ctx.lineWidth = 1 * zc; ctx.setLineDash(d._q >= DRONE_LINK_STRONG ? [] : [6 * zc, 6 * zc]); ctx.stroke();
            ctx.setLineDash([]);
        }
        if (d._q < DRONE_LINK_STRONG && player) {
            // 通信が弱い/途切れた: 自艦との破線 (橙=弱い / 赤=途切れ)
            ctx.globalAlpha = 0.35; ctx.strokeStyle = d._q >= DRONE_LINK_WEAK ? '#ffaa44' : '#ff5555';
            ctx.lineWidth = 1 * zc; ctx.setLineDash([10 * zc, 10 * zc]);
            ctx.beginPath(); ctx.moveTo(player.x, player.y); ctx.lineTo(d.x, d.y); ctx.stroke(); ctx.setLineDash([]);
        }
    }
    ctx.restore();
    for (const d of playerDrones) d.draw(ctx);
}
// ═══ 第16弾: ノード・コロニーの描画 (持ち主の輪・制圧/ハックの進み具合) ═══
function drawNodesAndColonies(ctx, vpX, vpY, vpW, vpH) {
    if (!player || player.hp <= 0) return;
    const zc = 1 / camera.zoom, t = Date.now();
    const isHiggsSnsr = sensorsOn.higgs;
    const higgsNodeRange = effectiveRadarRange * 6;
    const fontPx = Math.round(10 * zc * 10) / 10;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const n of resourceNodes) {
        const mine = n.owner === 'player', theirs = n.owner === 'enemy' && n.knownLost;
        if (isHiggsSnsr && Math.hypot(n.x - player.x, n.y - player.y) < higgsNodeRange) n.identified = true; // HIGGS帯で見たノードは海図に記録
        // 第18弾: ノードは海図に載っている既知物 — 常に描く (未確認は薄く)。旧: HIGGS帯で確認するまで描かれず「ノードが見えない」
        const mg = 90 * zc;
        if (n.x < vpX - mg || n.x > vpX + vpW + mg || n.y < vpY - mg || n.y > vpY + vpH + mg) continue;
        const pulse = 0.5 + Math.sin(t * 0.003 + n.x * 0.001) * 0.5;
        const bright = mine ? 0.95 : n.identified ? (isHiggsSnsr ? 0.55 + 0.45 * pulse : 0.45 + 0.2 * pulse) : (isHiggsSnsr ? 0.35 + 0.25 * pulse : 0.32);
        const size = Math.max(72, NODE_MIN_PX * zc);
        ctx.save();
        ctx.translate(n.x, n.y);
        ctx.rotate((t * 0.0008 + n.x * 0.0003) % (Math.PI * 2));
        ctx.globalAlpha = bright;
        if (spriteReady(SPRITES.node_higgs)) drawSpriteCentered(ctx, SPRITES.node_higgs, size);
        else { ctx.fillStyle = '#50c8ff'; ctx.beginPath(); ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
        // 引いた時はスプライトの細い線が霧に溶けるので、画面上で一定の大きさの輪と点を重ねる (未確認は薄め)
        ctx.globalAlpha = mine ? 0.9 : n.identified ? 0.8 : 0.55;
        ctx.strokeStyle = '#50c8ff'; ctx.fillStyle = '#50c8ff';
        ctx.lineWidth = 1.5 * zc;
        ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(36, NODE_MIN_PX * 0.5 * zc), 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(10, 2.5 * zc), 0, Math.PI * 2); ctx.fill();
        // 持ち主の輪: 自分の聴音局=青緑 / 奪われた聴音局=赤
        const rr = Math.max(60, (NODE_MIN_PX * 0.5 + 4) * zc);
        if (mine || theirs) {
            ctx.globalAlpha = 0.75;
            ctx.strokeStyle = mine ? '#00ffd0' : '#ff5a5a';
            ctx.lineWidth = 2 * zc;
            ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, Math.PI * 2); ctx.stroke();
            if (mine && camera.zoom < 0.06) { // 引いた時だけ聴音範囲を薄く
                ctx.globalAlpha = 0.18; ctx.lineWidth = 1.2 * zc; ctx.setLineDash([16 * zc, 14 * zc]);
                ctx.beginPath(); ctx.arc(n.x, n.y, NODE_RELAY_RANGE, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
            }
        }
        // ラベル: 寄った時は全部、引いた時は自分/敵の聴音局だけ (ノードの名札が並ぶと読めない)
        if (mine || theirs || camera.zoom >= LABEL_FAR_ZOOM) {
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = mine ? '#9ffff0' : theirs ? '#ff9a9a' : '#80e8ff';
            ctx.font = 'bold ' + fontPx + 'px Orbitron, monospace';
            ctx.fillText(mine ? '聴音局' : theirs ? '敵の聴音局' : 'ノード', n.x, n.y - rr - 10 * zc);
        }
        // 制圧の進み具合
        if (!mine && n.capP > 0) _drawHoldProgress(ctx, n.x, n.y, Math.max(76, 28 * zc), n.capP, '#ffe08a', '制圧', zc, fontPx);
    }
    for (const st of structures) {
        if (st.type === 'colony' && !st.hacked && st.hackP > 0) _drawHoldProgress(ctx, st.x, st.y, Math.max(110, 34 * zc), st.hackP, '#7fc8ff', 'ハック', zc, fontPx);
    }
    if (_resupply) _drawHoldProgress(ctx, _resupply.obj.x, _resupply.obj.y, Math.max(140, 40 * zc), _resupply.p, '#9fe8ff', '補給', zc, fontPx); // 第20弾
    ctx.restore();
}
function _drawHoldProgress(ctx, x, y, r, p, col, label, zc, fontPx) {
    ctx.globalAlpha = 0.25; ctx.strokeStyle = col; ctx.lineWidth = 4 * zc;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, p) * Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col; ctx.font = 'bold ' + fontPx + 'px Orbitron, monospace';
    ctx.fillText(label + ' ' + Math.round(Math.min(1, p) * 100) + '%', x, y + r + 12 * zc);
}
// 第16弾: 自分のミサイルは霧の中でもどこを飛んでいるか分かるように、画面上で一定の大きさの印を付ける
// 第23弾: コロニー情報の範囲 (霧の上) — 方角だけ=扇 / 距離つき=扇形の帯
// 方角±aHW・距離±dHW の扇形の帯を覆う円。中心は makeColonyIntel で真の位置から幅の0.6倍までずらしてあるので、真の位置は必ずこの円の内
function colonyIntelCircle(it) {
    if (!it || !it.dist) return null;
    return { x: it.ox + Math.cos(it.ang) * it.dist, y: it.oy + Math.sin(it.ang) * it.dist, r: Math.max(it.dHW, it.dist * Math.sin(Math.min(it.aHW, Math.PI / 2))) };
}
function drawColonyIntel(ctx) {
    const it = playerIntel;
    if (!it || !player) return;
    const age = (_frameCount - it.f) / COLONY_INTEL_PERIOD; // 次の更新で差し替わる
    const a0 = it.ang - it.aHW, a1 = it.ang + it.aHW;
    const r0 = it.dist ? Math.max(0, it.dist - it.dHW) : 1500, r1 = it.dist ? it.dist + it.dHW : 30000;
    const ic = colonyIntelCircle(it); // 第26弾: 距離まで分かれば円「この中のどこか」(中心に居るとは限らない)
    ctx.save();
    ctx.globalAlpha = 0.10 + 0.06 * Math.max(0, 1 - age);
    ctx.fillStyle = '#7fc8ff';
    ctx.beginPath();
    if (ic) ctx.arc(ic.x, ic.y, ic.r, 0, Math.PI * 2);
    else { ctx.arc(it.ox, it.oy, r1, a0, a1); ctx.arc(it.ox, it.oy, r0, a1, a0, true); ctx.closePath(); }
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#7fc8ff'; ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([12 / camera.zoom, 8 / camera.zoom]); ctx.stroke(); ctx.setLineDash([]);
    // 第28弾 (オーナー): 説明書きは消す (旧 第25弾の2行のラベル)
    ctx.restore();
}
function drawOwnOrdnanceMarkers(ctx) {
    const zc = 1 / camera.zoom;
    const pulse = 0.7 + Math.sin(Date.now() * 0.012) * 0.3;
    ctx.save();
    for (const p of projectiles) {
        if (!p.isPlayer || !p.active || p.type !== 'missile') continue;
        const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
        // 航跡 (後方へ伸びる線)
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = '#ffcc55';
        ctx.lineWidth = 1.5 * zc;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - ca * 36 * zc, p.y - sa * 36 * zc); ctx.stroke();
        // 本体の印 (矢じり + 輪)
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = '#ffe08a';
        ctx.beginPath();
        ctx.moveTo(p.x + ca * 8 * zc, p.y + sa * 8 * zc);
        ctx.lineTo(p.x - ca * 5 * zc - sa * 5 * zc, p.y - sa * 5 * zc + ca * 5 * zc);
        ctx.lineTo(p.x - ca * 5 * zc + sa * 5 * zc, p.y - sa * 5 * zc - ca * 5 * zc);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.5 * pulse;
        ctx.lineWidth = 1.2 * zc;
        ctx.beginPath(); ctx.arc(p.x, p.y, 11 * zc, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
}

// FPS計測用
// ═══ 第15弾: 出力スタンス (潜航 / 巡航 / 全速) ═══
// 旧: GAINスライダー + 静粛トグル + GEN配分 の3系統で同じ「どれだけ音を立てるか」を決めていた。
// 1つのトグルに統合: 潜航=遅い・静か・耳が澄む / 巡航=基準 / 全速=速い・うるさい・耳が塞がる。
// 発砲・ソナーで潜航は解ける (撃てば静かではいられない)。
const STANCE_GAIN  = { silent: 1, cruise: 1, flank: 1.5 };
const STANCE_LABEL = { silent: '潜航', cruise: '巡航', flank: '全速' };
function setStance(st, quiet) {
    if (!STANCE_GAIN[st]) return;
    powerStance = st;
    silentRunning = st === 'silent';
    genGain = STANCE_GAIN[st];
    _updateSilentBtn();
    if (!quiet) {
        logMessage(st === 'silent' ? 'STANCE: 潜航 — 機関を絞り全シグネチャ抑制。止まるほど耳が澄む (発砲/ソナーで解除)'
                 : st === 'flank' ? 'STANCE: 全速 — 速いが機関音で耳が塞がり、熱と航跡を撒き散らす'
                 : 'STANCE: 巡航 — 通常出力', st === 'flank' ? 'warning-msg' : 'system-msg');
        playSound('ui');
    }
}
function cycleStance() { if (playerCoasting) toggleCoast(false); setStance(powerStance === 'silent' ? 'cruise' : powerStance === 'cruise' ? 'flank' : 'silent'); }
function toggleSilentRunning() { setStance(silentRunning ? 'cruise' : 'silent'); }
function _updateSilentBtn() {
    const ab = document.getElementById('abar-silent');
    if (ab) { ab.classList.toggle('on', powerStance === 'silent'); ab.classList.toggle('flank', powerStance === 'flank'); }
    const al = document.getElementById('abar-silent-label');
    if (al) al.textContent = STANCE_LABEL[powerStance] || '巡航';
    _updateExpoChip(); // 上帯チップの「・静粛」を即時反映
}
function cancelSilentRunning(reason) {
    if (!silentRunning) return;
    setStance('cruise', true);
    logMessage('STANCE: 潜航解除 — ' + reason, 'warning-msg');
}

// ═══ チャージビーム (第3弾) ═══
// 発射前2秒チャージで威力×2.2。チャージ中は熱/EMが激増し、敵AIの「chargingシグネチャ推定→
// 側方回避」が本物の駆け引きになる。撃ち切りの決断 vs 露出のリスク。

// ═══ 通信傍受 (第3弾) ═══
// EMセンサー選択中、近距離でEM放射の強い敵の艦内通信を垣間見る。
// これまで完全に不可視だった敵AIの内面 (状態・性格・意図) がEMセンサーの新たな価値になる。
function interceptEnemyComms() {
    if (_commsInterceptCD > 0) { _commsInterceptCD -= gameSpeedFactor; return; }
    if (!sensorsOn.em || !player || player.hp <= 0) return;
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
        gameState.credits += 300; // 第26弾: 船体の回復は撤去 (修理はリペアキットだけ)
        updateTopUI();
        playSound('ui');
        effects.push({ x: distressBeacon.x, y: distressBeacon.y, r: 0, maxR: 700, a: 1, c: '#00e5ff', type: 'circle' });
        { const got = addMaterials(2); logMessage('SIGNAL: 遭難物資を回収 (+300 SCR' + (got ? '・資材+' + got + '個' : '') + ')。ここは敵も知っている — 長居は無用', 'system-msg'); }
        distressBeacon = null;
        distressNextTimer = DISTRESS_INTERVAL_MIN + Math.random() * DISTRESS_INTERVAL_VAR;
        return;
    }
    // 敵回収 (fighterは回収装備なし)
    for (const e of enemies) {
        if (e.hp <= 0 || e.type === 'fighter') continue;
        if (Math.hypot(e.x - distressBeacon.x, e.y - distressBeacon.y) < 400) {
            applyEnemyUpgrade(e); // 第26弾: 回復は撤去
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
    const esid = enemySid(e);
    if (!_contactLabels[esid]) _contactLabels[esid] = _contactLabelNext++;
    passiveBearings.push({
        ox: player.x, oy: player.y,
        angle: ang, halfWidth: 0.06, range: 16000,
        quality: 0.95, color: '255,120,80',
        sensor: 'em', strength: 0.9, sensorLabel: '探信音',
        bearingDeg: compassDeg, halfWidthDeg: 3,
        sourceId: esid,
        contactNo: _contactLabels[esid],
        life: PASSIVE_BEARING_LIFE, maxLife: PASSIVE_BEARING_LIFE
    });
    while (passiveBearings.length > PASSIVE_BEARING_MAX) passiveBearings.shift();
    logMessage(`SONAR: 敵アクティブソナー探信音！ — 方位 ${compassDeg}° (敵は接触を失っている。方位は正確だ)`, 'warning-msg');
    threatObs.pingF = _frameCount; threatObs.pingAng = ang; // 第23弾: 観測できる兆候
    if (huntStats) huntStats.pings++;
    // 敵への情報: 反射エコー。デコイが近くにあれば偽エコーで誤誘導。
    let echo = null, echoDist = ENEMY_PING_RANGE;
    for (const d of decoys) {
        const dd = Math.hypot(d.x - e.x, d.y - e.y);
        if (dd < echoDist) { echoDist = dd; echo = d; }
    }
    // 第17弾: ノイズメーカーも艦影のような反射を返す (自艦より近ければ敵はそちらを掴む)
    for (const n of noiseMakers) {
        const dd = Math.hypot(n.x - e.x, n.y - e.y);
        if (dd < echoDist && dd < distP) { echoDist = dd; echo = n; }
    }
    if (echo) {
        const _isNoise = noiseMakers.includes(echo);
        e.playerLastKnownPos = { x: echo.x, y: echo.y, vx: _isNoise ? echo.vx * gameSpeedFactor : 0, vy: _isNoise ? echo.vy * gameSpeedFactor : 0 };
        e._noiseLk = _isNoise ? e.playerLastKnownPos : null;
        e.contactFreshness = Math.max(e.contactFreshness, 0.85);
        logMessage(_isNoise ? '離脱: ノイズメーカーが敵の探信に反射 — 敵はそちらを掴んだ' : 'DECOY: デコイが偽エコー反射 — 敵ソナーを誤誘導', 'system-msg');
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
const FC_ILLUM_RANGE = 12000; // 第23弾: 火器管制の照準波が届く (感知できる) 距離 — 実装で決めた値
const threatObs = { kind: '', ang: null, deg: null, pingF: -1e9, pingAng: 0, lastKind: '' };
function updateHuntTension() {
    if (!player || player.hp <= 0) return;
    // ── デブリ擬態判定: 岩礁帯(デブリ帯)で完全停止+静粛 → 漂う岩塊に艦影が紛れる ──
    const _wasBottomed = isBottomed;
    isBottomed = silentRunning && player.currentSpeed < 0.05 &&
                 getDebrisIntensity(player.x, player.y) > BOTTOM_DEBRIS_MIN;
    if (isBottomed && !_wasBottomed) logMessage('TAC: デブリ擬態 — 機関完全停止。岩礁帯の岩塊に艦影が紛れる。至近でも探知されにくい', 'system-msg');
    else if (!isBottomed && _wasBottomed) logMessage('TAC: 擬態解除 — 岩礁帯の擬装を解いた', 'system-msg');
    // ═══ 第23弾 (オーナー合意): 「観測できる兆候」だけで脅威の段階を決める (旧: 敵の内部状態=追跡/交戦を読んでいた=情報漏れ) ═══
    //   0 静穏 / 1 受信 = 何かの信号を10秒以内に受けた / 2 照射 = 敵の探信を受けた(15秒)・火器管制の照準波(EM)を受けている
    //   3 攻撃 = 被弾8秒以内・ミサイルの高速推進波・ビームのチャージ反応
    const T = threatObs;
    T.kind = ''; T.ang = null;
    let lvl = 0;
    for (const b of passiveBearings) if (b.life > PASSIVE_BEARING_LIFE - 600 && !b.relay && !b.intel) { lvl = 1; T.kind = 'rx'; T.ang = b.angle; break; }
    if (_frameCount - T.pingF < 900) { lvl = 2; T.kind = 'ping'; T.ang = T.pingAng; }
    let fc = null, bc = null;
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying || e.type === 'fighter') continue;
        const d = Math.hypot(e.x - player.x, e.y - player.y);
        // 火器管制の照準波: 交戦中で自艦を掴んでいる敵は照準のEMを当ててくる → 方位が分かる (照射元)
        if (e.aiState === 'combat' && (e.contactFreshness || 0) > 0.4 && d < FC_ILLUM_RANGE * (epm(e).fcsLeak ? 1.5 : 1) && !(e._noiseLk && e._noiseLk === e.playerLastKnownPos)) fc = e;
        if ((e._beamCharge || 0) > 0 && d < passiveRange()) bc = e;
    }
    if (fc) { lvl = 2; T.kind = 'fc'; T.ang = Math.atan2(fc.y - player.y, fc.x - player.x) + (Math.random() - 0.5) * 0.12; }
    const hit = playerHitLog[playerHitLog.length - 1];
    const msl = projectiles.find(p => p.active && !p.isPlayer && p.type === 'missile' && p._torpAlerted);
    if (hit && _frameCount - hit.f < 480 && !hit.byFighter) { lvl = 3; T.kind = 'hit'; T.ang = null; T.deg = hit.deg; }
    if (bc) { lvl = 3; T.kind = 'beam'; T.ang = Math.atan2(bc.y - player.y, bc.x - player.x) + (Math.random() - 0.5) * 0.1; }
    if (msl) { lvl = 3; T.kind = 'msl'; T.ang = Math.atan2(msl.y - player.y, msl.x - player.x); }
    if (T.ang !== null && T.kind !== 'hit') T.deg = compassDeg(T.ang);
    if (lvl > playerExposureLevel || (lvl >= 2 && T.kind !== T.lastKind)) {
        if (lvl > playerExposureLevel) playSound('alert');
        const dg = T.deg !== undefined && T.deg !== null ? '方位' + T.deg + '° ' : '';
        if (T.kind === 'fc') logMessage('WARN: ' + dg + '火器管制の照準波を感知 — 撃たれる。射線から外れろ', 'warning-msg');
        else if (T.kind === 'beam') logMessage('WARN: ' + dg + 'ビームのチャージ反応 — 射線から外れろ', 'warning-msg');
        else if (T.kind === 'hit' && lvl > playerExposureLevel) { logMessage('CRITICAL: 攻撃を受けている — 交戦か離脱か', 'warning-msg'); if (huntStats) huntStats.timesEngaged++; }
    } else if (lvl === 0 && playerExposureLevel >= 2) {
        logMessage('TAC: 照射も攻撃も止んだ', 'system-msg');
    }
    T.lastKind = T.kind;
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

// ═══════════════════════════════════════════════════════════════
// 第13弾: 受信機(4バンド) と 副長(XO)
// 「聴く→測る→撃つ→消える」の中核ループを、隠れた状態機械のままにせず常に1行で示し、1タップで実行できるようにする。
// ═══════════════════════════════════════════════════════════════
const BANDS = ['heat', 'optic', 'em', 'higgs'];
const BAND_LABEL = { heat: 'HEAT', optic: 'OPTIC', em: 'EM', higgs: 'HIGGS' };
const BAND_JP = { heat: '熱', optic: '光学', em: '電磁波', higgs: 'ヒッグス' };
// パッシブ受信の到達距離 (方位ウェッジ生成・受信レベル表示で共通)
function passiveRange() {
    let range = Math.max(effectiveRadarRange * 10, 11000);
    if (surgePhase === 'active') range *= SURGE_DETECT_MULT;        // ヒッグスサージ: 敵味方対称に縮退
    else if (surgePhase === 'after') range *= SURGE_CLARITY_MULT;   // 通過後は高感度
    if (player && player._sysSensorTimer > 0) range *= 0.35;        // センサー損傷
    if (player && player._daze > 0) range *= DAZE_SENSOR_MULT;      // 第20弾: センサー撹乱
    return range;
}
// 帯域ごとの受信レベル(敵艦のみ)。0.5 = その帯域に同調すれば方位が取れる閾値、1.0 = 閾値の2倍。
// 「どの帯域に何かが居るか」は常に分かるが、「どの方位か」は同調しないと分からない = じゃんけんの核
// 第31弾 (オーナー): includeOff=true なら OFF の帯域も受信レベルだけは出す (左のバーが増減する)。方位はONの帯域でしか取れない
function rxLevels(includeOff) {
    const out = { heat: 0, optic: 0, em: 0, higgs: 0 };
    if (!player || player.hp <= 0) return out;
    const range = passiveRange();
    const mask = 1 - playerSelfNoise() * PM.noiseHear * 0.5; // 自艦ノイズに埋もれる (第32弾: 曳航アレイ)
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying) continue;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        if (dist >= range) continue;
        const hPath = getHiggsIntensity((e.x + player.x) / 2, (e.y + player.y) / 2);
        const da = 1 - dist / range;
        for (const b of BANDS) {
            if (!sensorsOn[b] && !includeOff) continue; // 第21弾: OFFの帯域は聴いていない (方位は取れない)
            const sc = sensorConfig[b];
            const lvl = sc.sig(e) * da * (1 - hPath * sc.higgsMod) * mask / sc.threshold;
            if (lvl > out[b]) out[b] = lvl;
        }
    }
    for (const f of fieldSignals) { // 第31弾: 自然/お宝の信号
        const dist = Math.hypot(f.x - player.x, f.y - player.y);
        if (dist >= range) continue;
        const hPath = getHiggsIntensity((f.x + player.x) / 2, (f.y + player.y) / 2), da = 1 - dist / range;
        for (const b of BANDS) {
            if (!sensorsOn[b] && !includeOff) continue;
            const sc = sensorConfig[b], lvl = fieldSig(f, b) * da * (1 - hPath * sc.higgsMod) * mask / sc.threshold;
            if (lvl > out[b]) out[b] = lvl;
        }
    }
    for (const L of lures) { // 第21弾: 敵の偽艦影ブイ
        if (L.owner !== 'e' || L.kind !== 'ship' || L.phase !== 'on') continue;
        const dist = Math.hypot(L.x - player.x, L.y - player.y);
        if (dist >= range) continue;
        const hPath = getHiggsIntensity((L.x + player.x) / 2, (L.y + player.y) / 2);
        for (const b of BANDS) { if (!sensorsOn[b] && !includeOff) continue; const sc = sensorConfig[b]; const lvl = LURE_SIG * (1 - dist / range) * (1 - hPath * sc.higgsMod) * mask / sc.threshold; if (lvl > out[b]) out[b] = lvl; }
    }
    const readR = range * 0.55;
    if (sensorsOn.higgs || includeOff) for (const rb of wakeRibbons) {
        if (!rb.owner.startsWith('e-')) continue;
        const pts = rb.pts;
        for (let i = pts.length - 1; i >= 0; i -= 3) {
            const p = pts[i], d = Math.hypot(p.x - player.x, p.y - player.y);
            if (d > readR) continue;
            const v = p.s * (1 - (_frameCount - p.f) / WAKE_LIFE) * (1 - d / readR) * 1.4 * mask;
            if (v > out.higgs) out.higgs = v;
        }
    }
    return out;
}

// ── XOの航法ヘルパー ──
function _angDiff(a, b) { let d = a - b; while (d < -Math.PI) d += Math.PI * 2; while (d > Math.PI) d -= Math.PI * 2; return d; }
function _setLeg(ang, dist, label) {
    const p = clampToMapCircle(player.x + Math.cos(ang) * dist, player.y + Math.sin(ang) * dist, 1500);
    player.setTarget(p.x, p.y);
    createClickEffect(p.x, p.y, '#00ffaa');
    logMessage(`NAV: ${label} — 方位${compassDeg(ang)}°へ ${Math.round(dist)}u`, 'system-msg');
    playSound('ui');
}
function compassDeg(ang) { return Math.round((Math.atan2(Math.cos(ang), -Math.sin(ang)) * 180 / Math.PI + 360) % 360); }
// 方位線に直交する2方向のうち、今の艦首に近い方へ (回頭が少なく済む) 測量レグを引く
function xoPerpendicularLeg(bearingAng) {
    const a1 = bearingAng + Math.PI / 2, a2 = bearingAng - Math.PI / 2;
    const ang = Math.abs(_angDiff(a1, player.angle)) < Math.abs(_angDiff(a2, player.angle)) ? a1 : a2;
    _setLeg(ang, 2800, '直交測量レグ');
}
function xoEvade(threatAng) { _setLeg(threatAng + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2, 1800, '回避機動'); }
// ═══ 第17弾: 副長の離脱助言 ═══
let _xoEscCache = { f: -9999, spot: null };
// 自艦が知っている脅威の方角: 視界内の敵 > 直近の被弾方向 (どちらも無ければ null)
function xoThreatAngle() {
    let best = null, bd = Infinity;
    for (const e of enemies) {
        if (e.hp <= 0 || e._dying || !e.inVision) continue;
        const d = Math.hypot(e.x - player.x, e.y - player.y);
        if (d < bd) { bd = d; best = Math.atan2(e.y - player.y, e.x - player.x); }
    }
    if (best !== null) return best;
    return playerHitDirs.length ? playerHitDirs[playerHitDirs.length - 1].ang : null;
}
function xoEscapeSpot() {
    if (_frameCount - _xoEscCache.f > 60) _xoEscCache = { f: _frameCount, spot: findCoverSpot(player.x, player.y, XO_ESCAPE_SEARCH, xoThreatAngle()) };
    return _xoEscCache.spot;
}
function xoEscapeAdvice() {
    const spot = xoEscapeSpot();
    const has = t => (cargo.stock[t] || 0) > 0;
    let where;
    if (!spot) where = has('smoke') ? '近くに隠れ場所なし — 離れてから煙幕で潜め' : '近くに隠れ場所なし — 敵の反対へ離れろ';
    else if (spot.d < 150) where = spot.kind === 'fog' ? '濃い霧の中 — 止まって潜め' : '岩礁帯の中 — 潜航で止まれば擬態';
    else where = '方位' + compassDeg(Math.atan2(spot.y - player.y, spot.x - player.x)) + '° ' + Math.round(spot.d / 100) * 100 + 'uに' + (spot.kind === 'fog' ? '濃い霧' : '岩礁帯');
    const steps = [];
    const near = (o) => Math.hypot(o.x - player.x, o.y - player.y) < FLASH_RADIUS;
    if (has('flash') && (enemies.some(e => e.hp > 0 && e.inVision && near(e)) || projectiles.some(p => p.active && !p.isPlayer && p.type === 'missile' && near(p)))) steps.push('閃光');
    if (has('noise')) steps.push('ノイズ');
    if (boostCD <= 0 && !(player._sysEngineTimer > 0) && !playerCoasting) steps.push('噴射');
    if (!playerCoasting) steps.push('機関停止');
    const sT = surgePhase === 'warn' ? surgePhaseTimer : surgePhase === 'none' ? surgeNextTimer + SURGE_WARN_DUR : -1;
    const surge = surgePhase === 'active' ? ' — サージ中、今が好機' : (sT >= 0 && sT < 1800) ? ' (サージまで' + Math.ceil(sT / 60) + '秒)' : '';
    return '離脱を — ' + where + (steps.length && !(spot && spot.d < 150) ? '。' + steps.join('→') : '') + surge;
}
// 副長の内部アクション (sim の副長ボットが2秒毎に実行する。画面には実行ボタンを出さない)
// 順番: 近くに敵/ミサイルがいれば閃光 → ノイズを今の艦首方向へ → 脅威の反対へ回頭 → 向いたら噴射 → 速いうちに機関停止
// → 追跡が外れたらその場で潜む (霧でも岩礁でもなければ煙幕)。敵に掴まれている間は止まらない (至近探知の内側に隠れても意味がない)
let _xoEsc = null; // 逃げる先 {tx, ty, until} — 10秒は変えない (旋回の遅い艦が目標の更新で振り回されないように)
function _angNorm(a) { while (a < -Math.PI) a += Math.PI * 2; while (a > Math.PI) a -= Math.PI * 2; return a; }
function xoEscapeStep() {
    const has = t => (cargo.stock[t] || 0) > 0;
    const flankV = shipCruiseSpeed(gameState.shipType, genAlloc.engine, STANCE_GAIN.flank);
    if (playerCoasting) {
        // 漂って止まりかけたら再点火して次の一手へ
        if (player.currentSpeed < flankV * 0.3) toggleCoast(false);
        return;
    }
    if (playerExposureLevel <= 1) {
        if (!findCoverSpot(player.x, player.y, 0) && has('smoke')) deployDrone('smoke');
        player.setTarget(player.x, player.y);
        if (!silentRunning) setStance('silent');
        _xoEsc = null;
        return;
    }
    const near = (o) => Math.hypot(o.x - player.x, o.y - player.y) < FLASH_RADIUS;
    if (has('flash') && (enemies.some(e => e.hp > 0 && e.inVision && near(e)) || projectiles.some(p => p.active && !p.isPlayer && p.type === 'missile' && near(p)))) deployDrone('flash');
    if (has('noise')) deployDrone('noise');
    if (!_xoEsc || _frameCount > _xoEsc.until || Math.hypot(_xoEsc.tx - player.x, _xoEsc.ty - player.y) < 150) {
        const th = xoThreatAngle();
        const away = th !== null ? th + Math.PI : player.angle;
        const spot = xoEscapeSpot();
        let tx, ty;
        if (spot && spot.d >= 150 && Math.abs(_angNorm(Math.atan2(spot.y - player.y, spot.x - player.x) - away)) < 0.8) { tx = spot.x; ty = spot.y; }
        else { const p = clampToMapCircle(player.x + Math.cos(away) * 4000, player.y + Math.sin(away) * 4000); tx = p.x; ty = p.y; }
        _xoEsc = { tx, ty, until: _frameCount + 600 };
    }
    player.setTarget(_xoEsc.tx, _xoEsc.ty);
    if (powerStance !== 'flank') setStance('flank', true);
    if (boostT > 0) return;
    if (Math.abs(_angNorm(Math.atan2(_xoEsc.ty - player.y, _xoEsc.tx - player.x) - player.angle)) > 0.5) return; // まず向きを変える
    if (boostCD <= 0 && !(player._sysEngineTimer > 0)) useBoost();
    else if (player.currentSpeed >= flankV * 0.8) toggleCoast(true);
}
function switchWeapon(w) {
    const sel = document.getElementById('weapon-select');
    if (sel && sel.value !== w) { sel.value = w; sel.dispatchEvent(new Event('change')); }
    if (typeof window.syncWeaponUI === 'function') window.syncWeaponUI();
    playSound('ui');
}

// ═══ 第19弾: COM対戦デモ — 自機もCOMが操作する (オーナー合意 2026-10-25) ═══
// 性格は4軸 (攻撃性・隠密性・貪欲さ・慎重さ 各0〜1)。プリセットで一括設定し、スライダーで微調整できる。ランダムは試合ごとに艦種の範囲で振る (敵の通常の決め方と同じ)
const COM_AXES = [['aggression', '攻撃性'], ['stealth', '隠密性'], ['greed', '貪欲さ'], ['caution', '慎重さ']];
const COM_PRESETS = {
    standard:   { label: '標準',     p: { aggression: 0.5, stealth: 0.4,  greed: 0.4, caution: 0.4 } },
    aggressive: { label: '攻撃的',   p: { aggression: 0.9, stealth: 0.15, greed: 0.2, caution: 0.15 } },
    cautious:   { label: '慎重',     p: { aggression: 0.3, stealth: 0.5,  greed: 0.3, caution: 0.85 } },
    stealthy:   { label: '隠密',     p: { aggression: 0.4, stealth: 0.9,  greed: 0.3, caution: 0.6 } },
    greedy:     { label: '貪欲',     p: { aggression: 0.4, stealth: 0.4,  greed: 0.9, caution: 0.5 } },
    adaptive:   { label: '状況適応', p: null }, // 第21弾: 状況で 隠密→貪欲→攻撃的→慎重 と変わる
    random:     { label: 'ランダム', p: null },
};
const COM_ITYPE = { assault: 'destroyer', stealth: 'corvette', carrier: 'carrier' }; // ロビーの艦種 → 性格の範囲
function comDefaultCfg() {
    return { ship: 'assault', enemy: 'assault', mode: 'br', pPreset: 'standard', ePreset: 'standard',
             pp: Object.assign({}, COM_PRESETS.standard.p), ep: Object.assign({}, COM_PRESETS.standard.p), higgsView: true, think: true,
             lo: { p: {}, e: {} } }; // 第22弾: COM対戦の積み込み (自機/敵・艦種ごと。無ければ既定)
}
function loadComCfg() {
    try { const c = JSON.parse(localStorage.getItem('darkEchoComDemo') || 'null'); if (c && c.pp && c.ep) { const r = Object.assign(comDefaultCfg(), c); if (!r.lo || !r.lo.p || !r.lo.e) r.lo = { p: {}, e: {} }; return r; } } catch (e) {}
    return comDefaultCfg();
}
function saveComCfg() { try { localStorage.setItem('darkEchoComDemo', JSON.stringify(comCfg)); } catch (e) {} }
// その試合で使う性格 ('p'=自機 / 'e'=敵)
function comPersonalityFor(side) {
    const pre = side === 'p' ? comCfg.pPreset : comCfg.ePreset;
    if (pre === 'adaptive') return makeAdaptivePersonality();
    if (pre === 'random') return rollEnemyPersonality(COM_ITYPE[side === 'p' ? comCfg.ship : comCfg.enemy]);
    return Object.assign({}, side === 'p' ? comCfg.pp : comCfg.ep);
}
function persLabel(p) { return (p && p._adaptive ? '状況適応(' + ADAPT_MODES[p._adaptive.mode].label + ') ' : '') + COM_AXES.map(([k, l]) => l.slice(0, 2) + Math.round((p[k] || 0) * 100)).join(' '); }

// ── 思考ログ (専用欄。自機COM=水色 / 敵COM=橙) ──
// 同じ判断の繰り返しは出さない (sig が変わった時だけ。同じ判断でも15秒たてば数字を更新して出し直す)
const COM_THINK_REPEAT = 900;
let _thinkLast = {}, _thinkLastP = -1e9;
function comThink(side, sig, text, key) {
    if (!comDemo || !thinkLogOn) return;
    // 同じ判断(sig)は15秒に1回まで (別の判断と交互に出ても数えるのは判断ごと)。15秒たっても文が同じなら出さない
    const m = _thinkLast[key || side] || (_thinkLast[key || side] = {});
    const L = m[sig];
    if (L && (_frameCount - L.t < COM_THINK_REPEAT || L.text === text)) return;
    m[sig] = { t: _frameCount, text };
    _thinkWrite(side, text);
}
// 出来事 (撃った・探信した等) は判断の要約とは別に、その都度出す (同じ文が2秒以内に続く時だけ省く)
function comThinkEvent(side, text, key) {
    if (!comDemo || !thinkLogOn) return;
    const m = _thinkLast[(key || side) + ':ev'] || (_thinkLast[(key || side) + ':ev'] = {});
    if (m.text === text && _frameCount - m.t < 120) return;
    m.text = text; m.t = _frameCount;
    _thinkWrite(side, text);
}
function _thinkWrite(side, text) {
    const box = document.getElementById('think-log');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'tk ' + (side === 'p' ? 'tk-p' : 'tk-e');
    if (side === 'p') _thinkLastP = _frameCount;
    const sec = Math.floor(_frameCount / 60);
    d.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + ' ' + (side === 'p' ? '自機COM' : '敵COM') + ' — ' + text;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.appendChild(d);
    while (box.children.length > 80) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
}
function toggleThinkLog(on) {
    thinkLogOn = on === undefined ? !thinkLogOn : !!on;
    if (comCfg) comCfg.think = thinkLogOn;
    document.body.classList.toggle('think-on', comDemo && thinkLogOn);
    const b = document.getElementById('btn-think-log');
    if (b) b.textContent = thinkLogOn ? '思考ログ: ON' : '思考ログ: OFF';
}
const _EXPO_JP = ['静穏', '受信', '照射', '攻撃']; // 第23弾: 観測できる兆候 (旧: 隠密/痕跡/追跡/捕捉=敵の内部状態)
const _WPN_JP = { kinetic: '実弾', missile: 'ミサイル', beam: 'ビーム' };
const _pct = (v) => Math.round(v * 100) + '%';
const _dirTxt = (fx, fy, tx, ty) => '方位' + compassDeg(Math.atan2(ty - fy, tx - fx)) + '° ' + Math.round(Math.hypot(tx - fx, ty - fy) / 100) * 100 + 'u';

// ── 自機COM — 見てよいのはプレイヤーと同じ情報だけ (方位の記録・推定・視界・被探知チップ)。敵の真の位置・耐久は見ない ──
//  退く: 耐久 < 0.12 + 慎重さ×0.43 (敵と同じ式。敵は相手の耐久も見て+0.12するが、自機COMは知らないので使わない) で、追跡以上 → 副長の離脱手順
//        振り切ったら未ハックのコロニーへ修理に / 無ければ止まって潜む (敵の潜伏と同じ45秒)
//  撃つ: 想定ロックの命中予測 ≥ 65% − 35%×攻撃性 (有視界の完全ロックは自動攻撃)
//  出力: 隠密性0.5以上=潜航・未満=巡航 / 攻撃性0.7以上は接近する時だけ全速
//  取る: 貪欲さ0.5以上なら、敵を掴んでいない間に近くのノード・未ハックのコロニーへ
//  出す: 攻撃性0.5以上なら、敵を掴んでいる間に人型・戦闘機・砲台・哨戒機を展開
//  あとは副長の助言に従う (追跡・直交航路・兵装の持ち替え・回避)。手掛かりが何も無ければ自分で捜索航路を引く
// 第20弾: 人間並みの操艦 (オーナー合意) — 判断は2秒ごと。一度引いた航路は到着するか20秒たつまで変えない (直交航路は到着まで走り切る)。
// 例外はミサイル回避と離脱。旧: 0.5秒ごとに判断し航路をすぐ引き直していた (人間には真似できない小刻みな三角測量)
const COM_TICK = 120, COM_LEG_HOLD = 1200, COM_GOAL_RANGE = 9000, COM_DEPLOY_GAP = 600, COM_HIDE_TIME = ENEMY_HIDE_TIME, COM_SEARCH_LEG = 4000;
const COM_SKIP = { '帰投': 1, 'ソナー': 1, '離脱': 1, '射撃': 1 }; // 自機COMが自分で決める (退く・撃つ) / 使わない (副長の「静寂ならソナー」は位置を晒すだけ)
function comNewMemo() { return { pp: comPersonalityFor('p'), lastDeploy: -1e9, hideUntil: 0, flankUntil: 0, silentUntil: 0, mode: '' }; }

// ═══ 第22弾: 試合の記録 — 1秒ごとの位置と出来事を残し、試合が終わったら地図と時間のスライダーで振り返る ═══
// (見た目だけ: 記録は判断に使わない。真の位置を記録するので、表示するのは試合が終わった後だけ)
let matchRec = null;
const REC_EVENTS_MAX = 3000;
const _AI_JP = { lurking: '潜伏', gathering: '収集', hunting: '追跡', combat: '交戦' };
function matchRecStart() {
    const lm = [];
    for (const st of structures) if (st.type === 'colony' || st.type === 'derelict') lm.push({ k: st.type, x: st.x, y: st.y });
    for (const st of stations) lm.push({ k: 'station', x: st.x, y: st.y });
    for (const n of resourceNodes) lm.push({ k: 'node', x: n.x, y: n.y });
    matchRec = { f0: _frameCount, ship: gameState.shipType, enemy: gameState.enemyType, com: !!comDemo, lm, s: [], ev: [], prevAi: {}, prevExpo: 0 };
}
function matchRecEvent(kind, x, y, text) {
    if (!matchRec || matchRec.ev.length >= REC_EVENTS_MAX) return;
    matchRec.ev.push({ t: _frameCount - matchRec.f0, kind, x: Math.round(x), y: Math.round(y), text });
}
function matchRecTick() {
    if (!matchRec || !player || (_frameCount - matchRec.f0) % 60) return;
    const P = { x: Math.round(player.x), y: Math.round(player.y), a: +player.angle.toFixed(2), hp: Math.max(0, player.hp / player.maxHp), ex: playerExposureLevel, st: powerStance };
    // 自艦の推定 (追跡中の信号)
    if (lockedSignalId && _signalAnalysis[lockedSignalId] && _signalAnalysis[lockedSignalId].fix) {
        const est = trackEstimate(_signalAnalysis[lockedSignalId], 0);
        if (est) P.est = { x: Math.round(est.x), y: Math.round(est.y), r: Math.round(est.r) };
    }
    const E = [], F = [];
    for (const e of enemies) {
        if (e.hp <= 0 && !e._dying) continue;
        if (e.type === 'fighter') { F.push([Math.round(e.x), Math.round(e.y)]); continue; }
        const b = e.playerLastKnownPos;
        E.push({ id: e.uid, x: Math.round(e.x), y: Math.round(e.y), a: +e.angle.toFixed(2), hp: Math.max(0, e.hp / e.maxHp), ai: e.aiState, fr: +(e.contactFreshness || 0).toFixed(2), bx: b ? Math.round(b.x) : null, by: b ? Math.round(b.y) : null, seen: !!e.inVision });
        const pv = matchRec.prevAi[e.uid];
        if (pv && pv !== e.aiState) matchRecEvent('aiE', e.x, e.y, '敵: ' + (_AI_JP[pv] || pv) + ' → ' + (_AI_JP[e.aiState] || e.aiState));
        matchRec.prevAi[e.uid] = e.aiState;
    }
    if (playerExposureLevel !== matchRec.prevExpo) { matchRecEvent('expoP', player.x, player.y, '自艦: ' + _EXPO_JP[matchRec.prevExpo] + ' → ' + _EXPO_JP[playerExposureLevel]); matchRec.prevExpo = playerExposureLevel; }
    const D = playerDrones.filter(d => d.hp > 0).map(d => [Math.round(d.x), Math.round(d.y)]);
    matchRec.s.push({ t: _frameCount - matchRec.f0, P, E, F, D });
}
// ── 再生画面 ──
let _rp = null;
function openReplay() {
    if (!matchRec || !matchRec.s.length) { logMessage('記録: この試合の記録がありません', 'system-msg'); return; }
    const ov = document.getElementById('replay-overlay'); if (!ov) return;
    ov.classList.remove('hidden');
    const sl = document.getElementById('rp-slider');
    sl.max = matchRec.s.length - 1; sl.value = matchRec.s.length - 1;
    // 表示範囲: 艦の通った所が収まる正方形 (最小8000u)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const sm of matchRec.s) { const pts = [sm.P].concat(sm.E); for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); } }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, half = Math.max(4000, (Math.max(x1 - x0, y1 - y0) / 2) * 1.15 + 600);
    _rp = { i: matchRec.s.length - 1, play: false, spd: 4, cx, cy, half, acc: 0, last: 0 };
    _rpRenderEvents();
    _rpDraw();
    _rpStartLoop();
}
function closeReplay() { const ov = document.getElementById('replay-overlay'); if (ov) ov.classList.add('hidden'); if (_rp) _rp.play = false; }
function _rpFmt(t) { const s2 = Math.floor(t / 60); return Math.floor(s2 / 60) + ':' + String(s2 % 60).padStart(2, '0'); }
const _EV_COL = { fireP: '#5ff0ff', fireE: '#ffa040', hitP: '#ff5050', hitE: '#7dff9a', deathP: '#ff3030', killE: '#7dff9a', nodeP: '#50c8ff', nodeE: '#ff9a50', colonyP: '#50c8ff', colonyE: '#ff9a50', salvP: '#9fffc0', aiE: '#ffcf88', expoP: '#ff8080', lureP: '#c48bff', lureE: '#c48bff', flashP: '#ffffff', flashE: '#ffffff', smokeE: '#9fb8ff', shield: '#88ccff', clear: '#7dff9a', supplyP: '#9fffc0', escP: '#ffe08a', salvE: '#ffcf88', zoneP: '#ff8ce0', zoneE: '#ff8ce0' };
function _rpRenderEvents() {
    const box = document.getElementById('rp-events'); if (!box) return;
    box.innerHTML = '';
    matchRec.ev.forEach((ev, k) => {
        const d = document.createElement('div'); d.className = 'rp-ev'; d.dataset.k = k; d.dataset.t = ev.t;
        const tm = document.createElement('b'); tm.textContent = _rpFmt(ev.t); d.appendChild(tm);
        const tx = document.createElement('span'); tx.textContent = ' ' + ev.text; tx.style.color = _EV_COL[ev.kind] || '#cfe'; d.appendChild(tx);
        box.appendChild(d);
    });
}
function _rpSetIndex(i) { if (!_rp) return; _rp.i = Math.max(0, Math.min(matchRec.s.length - 1, i)); document.getElementById('rp-slider').value = _rp.i; _rpDraw(); }
function _rpDraw() {
    if (!_rp || !matchRec) return;
    const cv = document.getElementById('rp-canvas'); if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 300, H = cv.clientHeight || 300;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#020a06'; g.fillRect(0, 0, W, H);
    const sc = Math.min(W, H) / (2 * _rp.half), ox = W / 2 - _rp.cx * sc, oy = H / 2 - _rp.cy * sc;
    const X = (x) => ox + x * sc, Y = (y) => oy + y * sc;
    // 地図の縁とランドマーク
    g.strokeStyle = 'rgba(0,255,170,0.25)'; g.lineWidth = 1; g.beginPath(); g.arc(X(MAP_CX), Y(MAP_CY), MAP_RADIUS * sc, 0, Math.PI * 2); g.stroke();
    for (const l of matchRec.lm) {
        g.fillStyle = l.k === 'colony' ? '#3aa8ff' : l.k === 'station' ? '#3fffa0' : l.k === 'derelict' ? '#8a8a8a' : '#c79bff';
        const r = l.k === 'node' ? 2.5 : 4; g.fillRect(X(l.x) - r, Y(l.y) - r, r * 2, r * 2);
    }
    const S = matchRec.s, i = _rp.i, cur = S[i];
    // 航跡: 全体を薄く、今までを濃く
    const trail = (get, col) => {
        g.strokeStyle = col; g.globalAlpha = 0.18; g.lineWidth = 1.5; g.beginPath(); let st = false;
        for (let k = 0; k < S.length; k++) { const q = get(S[k]); if (!q) { st = false; continue; } if (!st) { g.moveTo(X(q.x), Y(q.y)); st = true; } else g.lineTo(X(q.x), Y(q.y)); }
        g.stroke(); g.globalAlpha = 0.9; g.lineWidth = 2; g.beginPath(); st = false;
        for (let k = 0; k <= i; k++) { const q = get(S[k]); if (!q) { st = false; continue; } if (!st) { g.moveTo(X(q.x), Y(q.y)); st = true; } else g.lineTo(X(q.x), Y(q.y)); }
        g.stroke(); g.globalAlpha = 1;
    };
    trail(sm => sm.P, '#5ff0ff');
    const eIds = new Set(); for (const sm of S) for (const e of sm.E) eIds.add(e.id);
    for (const id of eIds) trail(sm => sm.E.find(e => e.id === id), '#ffa040');
    // 出来事 (今の時刻までの直近20秒)
    for (const ev of matchRec.ev) {
        if (ev.t > cur.t || ev.t < cur.t - 1200) continue;
        const a = 1 - (cur.t - ev.t) / 1200;
        g.globalAlpha = 0.3 + 0.7 * a; g.strokeStyle = g.fillStyle = _EV_COL[ev.kind] || '#cfe';
        const x = X(ev.x), y = Y(ev.y);
        if (ev.kind === 'fireP' || ev.kind === 'fireE') { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.stroke(); }
        else if (ev.kind === 'hitP' || ev.kind === 'hitE' || ev.kind === 'deathP' || ev.kind === 'killE') { g.lineWidth = 2; g.beginPath(); g.moveTo(x - 5, y - 5); g.lineTo(x + 5, y + 5); g.moveTo(x + 5, y - 5); g.lineTo(x - 5, y + 5); g.stroke(); g.lineWidth = 1; }
        else { g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.stroke(); }
    }
    g.globalAlpha = 1;
    // 艦 (今の時刻)
    const ship = (q, col) => { g.save(); g.translate(X(q.x), Y(q.y)); g.rotate(q.a); g.fillStyle = col; g.beginPath(); g.moveTo(9, 0); g.lineTo(-6, -5); g.lineTo(-6, 5); g.closePath(); g.fill(); g.restore(); };
    for (const f of cur.F) { g.fillStyle = '#ffb070'; g.fillRect(X(f[0]) - 1.5, Y(f[1]) - 1.5, 3, 3); }
    for (const d of cur.D) { g.fillStyle = '#8ff'; g.fillRect(X(d[0]) - 1.5, Y(d[1]) - 1.5, 3, 3); }
    for (const e of cur.E) {
        // 敵が「自艦はここ」と思っている点
        if (e.bx !== null && e.fr > 0.05) {
            g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,160,64,' + (0.3 + 0.6 * e.fr) + ')';
            g.beginPath(); g.moveTo(X(e.x), Y(e.y)); g.lineTo(X(e.bx), Y(e.by)); g.stroke();
            g.beginPath(); g.arc(X(e.bx), Y(e.by), 7, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        }
        ship(e, e.hp > 0 ? '#ff8030' : '#663');
    }
    if (cur.P.est) { g.setLineDash([3, 3]); g.strokeStyle = 'rgba(95,240,255,0.7)'; g.beginPath(); g.arc(X(cur.P.est.x), Y(cur.P.est.y), Math.max(6, cur.P.est.r * sc), 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
    ship(cur.P, '#5ff0ff');
    // 状態の文
    document.getElementById('rp-time').textContent = _rpFmt(cur.t) + ' / ' + _rpFmt(S[S.length - 1].t);
    const lines = ['<span style="color:#5ff0ff">自艦</span> 耐久' + Math.round(cur.P.hp * 100) + '%・' + (_EXPO_JP[cur.P.ex] || '') + (cur.P.est ? '・敵を推定±' + cur.P.est.r + 'u' : '')];
    for (const e of cur.E) {
        const dd = Math.round(Math.hypot(e.x - cur.P.x, e.y - cur.P.y) / 100) * 100;
        const err = e.bx !== null && e.fr > 0.05 ? '・自艦をここと推定 (ずれ' + Math.round(Math.hypot(e.bx - cur.P.x, e.by - cur.P.y) / 100) * 100 + 'u・確信' + Math.round(e.fr * 100) + '%)' : '・自艦を掴んでいない';
        lines.push('<span style="color:#ffa040">敵</span> ' + (_AI_JP[e.ai] || e.ai) + '・耐久' + Math.round(e.hp * 100) + '%・距離' + dd + 'u' + (e.seen ? '・自艦から見えている' : '') + err);
    }
    document.getElementById('rp-state').innerHTML = lines.join('<br>');
    // 出来事の一覧: 今より前を濃く、直近を枠で
    const box = document.getElementById('rp-events');
    let lastK = -1;
    box.querySelectorAll('.rp-ev').forEach(d => { const t = +d.dataset.t; d.classList.toggle('past', t <= cur.t); if (t <= cur.t) lastK = +d.dataset.k; d.classList.remove('now'); });
    if (lastK >= 0) { const el = box.querySelector('.rp-ev[data-k="' + lastK + '"]'); if (el) { el.classList.add('now'); if (_rp.play || _rp.follow !== false) el.scrollIntoView({ block: 'nearest' }); } }
}
function _rpLoop(ts) {
    // 第30弾: 開いている間だけ回す (旧: ページ読み込み時に _rp=null で即終了し、再生が二度と進まなかった)
    _rpLoopOn = false;
    if (!_rp) return;
    const ov = document.getElementById('replay-overlay');
    if (ov && !ov.classList.contains('hidden') && _rp.play) {
        const dt = _rp.last ? Math.min(0.25, (ts - _rp.last) / 1000) : 0;
        _rp.acc += dt * _rp.spd; // 1サンプル=1秒 → 再生の速さ倍
        if (_rp.acc >= 1) { const n = Math.floor(_rp.acc); _rp.acc -= n; _rpSetIndex(_rp.i + n); if (_rp.i >= matchRec.s.length - 1) { _rp.play = false; document.getElementById('rp-play').textContent = '▶'; } }
    }
    _rp.last = ts;
    if (ov && !ov.classList.contains('hidden')) { _rpLoopOn = true; requestAnimationFrame(_rpLoop); }
}
let _rpLoopOn = false;
function _rpStartLoop() { if (_rpLoopOn) return; _rpLoopOn = true; if (_rp) _rp.last = 0; requestAnimationFrame(_rpLoop); }
(() => {
    const ov = document.getElementById('replay-overlay'); if (!ov) return;
    document.getElementById('rp-close').addEventListener('click', closeReplay);
    document.getElementById('rp-slider').addEventListener('input', (ev) => { if (_rp) { _rp.play = false; document.getElementById('rp-play').textContent = '▶'; _rpSetIndex(+ev.target.value); } });
    document.getElementById('rp-play').addEventListener('click', () => { if (!_rp) return; if (_rp.i >= matchRec.s.length - 1) _rpSetIndex(0); _rp.play = !_rp.play; document.getElementById('rp-play').textContent = _rp.play ? '❚❚' : '▶'; });
    document.getElementById('rp-spd').addEventListener('click', (ev) => { if (!_rp) return; const L = [1, 4, 16, 60]; _rp.spd = L[(L.indexOf(_rp.spd) + 1) % L.length]; ev.target.textContent = '×' + _rp.spd; });
    document.getElementById('rp-events').addEventListener('click', (ev) => { const d = ev.target.closest('.rp-ev'); if (!d || !_rp) return; const t = +d.dataset.t; let k = matchRec.s.findIndex(sm => sm.t >= t); if (k < 0) k = matchRec.s.length - 1; _rp.play = false; document.getElementById('rp-play').textContent = '▶'; _rpSetIndex(k); });
    document.getElementById('btn-replay-go')?.addEventListener('click', openReplay);
    document.getElementById('btn-replay-db')?.addEventListener('click', openReplay);
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !ov.classList.contains('hidden')) { closeReplay(); ev.stopPropagation(); } }, true);
})();

// 第22弾: 戦闘モードのバー (画面下)。ロック (完全/想定) している間だけ出す。COM対戦では自機COMの選択を表示 (押せない)
const _CM_JP = { manual: '手動', face: '正対', flank: '回り込み', auto: '兵装', near: '近', mid: '中', far: '遠', attack: '攻撃', evade: '回避' };
const _CMWHY_JP = { dodge: 'ミサイルを横へかわす', flank: '後方へ回り込み中', close: '間合いを詰める', open: '間合いを開く', hold: '艦首を向けて保持' };
function syncCombatBar() {
    const bar = document.getElementById('combat-bar');
    if (!bar) return;
    bar.querySelectorAll('.cb-grp').forEach(g => g.querySelectorAll('button').forEach(b => b.classList.toggle('on', combatMode[g.dataset.k] === b.dataset.v)));
    bar.classList.toggle('com', !!comDemo);
}
function setCombatMode(k, v) {
    if (comDemo || !(k in combatMode)) return;
    combatMode[k] = v;
    syncCombatBar();
    if (typeof playSound === 'function') playSound('ui');
    logMessage('操艦: 戦闘モード — ' + _CM_JP[combatMode.mode] + '・間合い' + _CM_JP[combatMode.range] + '・' + _CM_JP[combatMode.prio] + '優先' + (combatMode.mode === 'manual' ? ' (移動は自分で指示)' : ''), 'system-msg');
}
let _cbVis = null, _cbWhy = null;
function updateCombatBar() {
    const bar = document.getElementById('combat-bar');
    if (!bar || !player) return;
    const te = player.targetEntity, lk = te && player.hp > 0 ? playerLockInfo(te) : null;
    const show = !!(lk && (lk.full || lk.assumed));
    if (show !== _cbVis) { _cbVis = show; bar.classList.toggle('hidden', !show); if (show) syncCombatBar(); }
    if (show) {
        const why = combatMode.mode === 'manual' ? '' : (_CMWHY_JP[player._cmWhy] || '');
        if (why !== _cbWhy) { _cbWhy = why; const st = document.getElementById('cb-state'); if (st) st.textContent = why; }
    }
}
function _comCMOff() { if (combatMode.mode !== 'manual') { combatMode.mode = 'manual'; syncCombatBar(); } }
function comPilotStep() {
    if (!comDemo || !player || player.hp <= 0 || sectorCleared || _frameCount % COM_TICK) return;
    const c = _com || (_com = comNewMemo());
    const P = c.pp, now = _frameCount;
    const hpF = player.hp / player.maxHp;
    const retreat = 0.12 + P.caution * 0.43;
    const fireThr = 0.65 - 0.35 * P.aggression;
    const sigs = currentSignals();
    // 第23弾: 内部IDで艦か囮かを見分けない (旧: 'e-' で始まる信号=敵艦と分かっていた)。囮と識別した信号だけ除く
    const contact = Object.keys(sigs).some(k => { const d = identInfo(k); return !(d.known && d.low && d.txt.includes('確認')); }) || enemies.some(e => e.hp > 0 && !e._dying && e.inVision);
    if (lockedSignalId && sigs[lockedSignalId]) {
        const d = identInfo(lockedSignalId);
        if (d.known && d.p < 0.25 && Object.keys(sigs).length > 1) { comThinkEvent('p', 'SIG-' + String(_contactLabels[lockedSignalId] || '?').padStart(2, '0') + ' は' + d.txt + ' — 囮と見て別の信号へ'); trackNextSignal(); }
    }
    const r = xoEvaluate();
    c.mode = '';
    // 第21弾: 状況適応の性格 (自機COM) — 相手を掴んでいる=受信中の敵信号か有視界
    {
        const am = adaptPersonality(P, contact, hpF);
        if (am) comThinkEvent('p', '性格が変わる → ' + ADAPT_MODES[am].label + ' (' + (am === 'cautious' ? '耐久' + _pct(hpF) + ' < 40%' : am === 'aggressive' ? '相手を掴んだ' : am === 'greedy' ? '90秒手掛かりなし' : '見失って60秒') + ')');
    }
    // 1) 退く
    if (hpF < retreat) {
        if (playerExposureLevel >= 2) {
            c.mode = 'escape'; c.hideUntil = 0; _comCMOff();
            xoEscapeStep(); _comSteered(c, 'free'); c.legF = -1e9; // 離脱は例外: 終わったらすぐ次の航路を引ける
            comThink('p', 'esc', '耐久' + _pct(hpF) + ' < 退き際' + _pct(retreat) + ' (慎重さ' + _pct(P.caution) + ')・' + _EXPO_JP[playerExposureLevel] + 'されている → 離脱手順 (閃光→ノイズ→噴射→機関停止)');
            return;
        }
        // 第26弾: 修理はリペアキットだけ (旧: コロニーへ修理しに行った)
        if ((cargo.stock.repair || 0) > 0 && !(player._kitT > 0)) {
            deployDrone('repair');
            comThinkEvent('p', '耐久' + _pct(hpF) + ' < 退き際' + _pct(retreat) + '・振り切った → リペアキットで修理 (残り' + (cargo.stock.repair || 0) + '個)');
        }
        if (!c.hideUntil) c.hideUntil = now + COM_HIDE_TIME;
        if (now < c.hideUntil) {
            c.mode = 'hide';
            if (playerCoasting) toggleCoast(false);
            player.setTarget(player.x, player.y);
            if (powerStance !== 'silent') setStance('silent', true);
            comThink('p', 'hide', '耐久' + _pct(hpF) + '・振り切った → 止まって潜む (残り' + Math.ceil((c.hideUntil - now) / 60) + '秒)');
            return;
        }
        comThink('p', 'hide-end', '潜伏を終える — 耐久' + _pct(hpF) + 'のまま狩りへ戻る (また追われたら退く)');
    }
    if (playerCoasting) toggleCoast(false);
    // 2) 迫るミサイル (副長の回避・デコイ)
    if (r && r.act && (r.act.label === '回避' || r.act.label === 'デコイ')) {
        if (r.act.label === '回避') _comCMOff();
        r.act.fn();
        if (r.act.label === '回避') { _comSteered(c, 'free'); c.legF = -1e9; } // 回避も例外
        comThink('p', 'evade' + r.act.label, '副長「' + r.text + '」→ ' + r.act.label);
        _comStance(c, P);
        return;
    }
    // 第20弾: 弾が尽きかけたら補給へ (補給所 / ハック済みのコロニー)。実弾が残っているうちはミサイル切れでも戦う
    {
        const loS = shipLoadout(gameState.shipType);
        if ((cargo.ammoK <= 0 && cargo.ammoM <= 0) || (cargo.ammoM <= 0 && cargo.ammoK < loS.ammoK * AMMO_PER_SLOT.kinetic * 0.25)) {
            const rs = nearestResupply(player.x, player.y);
            if (rs) {
                c.mode = 'supply'; _comCMOff();
                _comGoTo(rs.obj, RESUPPLY_R * 0.5, c);
                comThink('p', 'supply', '弾が尽きかけ (実弾' + cargo.ammoK + '・ミサイル' + cargo.ammoM + ') → ' + (rs.kind === 'station' ? '補給所' : 'コロニー') + 'で補給 (' + _dirTxt(player.x, player.y, rs.obj.x, rs.obj.y) + ')');
                _comStance(c, P);
                return;
            }
        }
    }
    // 3) 撃つ
    const te = bestFireTarget(), lk = te ? playerLockInfo(te) : null;
    let held = null;
    if (te && lk.full) {
        // 見えている間は自動攻撃に任せる (航路を引くと自動攻撃より移動命令が優先されて撃ち合いから外れる)
        // 第20弾: 撃てるものから持ち替える — ミサイル(リロード済み) → 実弾(射程内) → ビーム(射程の外側・溜まっていれば) → 届くもの
        // (ビームは射角±10°で2秒溜めるので、至近の撃ち合いでは実弾を止めてしまう)
        const wNow = currentWeapon();
        const mOk = cargo.ammoM > 0 && lk.dist > 250 && lk.dist < weaponRange('missile') * 0.9;
        const kOk = lk.dist < weaponRange('kinetic') * 0.9 && cargo.ammoK > 0;
        const wWant = mOk && playerWeaponReady(player, 'missile') ? 'missile'
            : kOk ? 'kinetic'
            : playerWeaponReady(player, 'beam') ? 'beam'
            : mOk ? 'missile' : 'beam';
        if (wWant !== wNow && (wNow !== 'beam' || !(player._beamCharge > 0))) {
            switchWeapon(wWant);
            comThinkEvent('p', '有視界 ' + Math.round(lk.dist / 100) * 100 + 'u → ' + _WPN_JP[wWant] + 'に持ち替える');
        }
        // 第22弾: 見えている間は戦闘モードで操艦する (性格と相手の兵装で 正対/回り込み・優先を選び、10秒は続ける)
        const oppW = te._lastFireType && now - (te._lastFireF || -1e9) < 1200 ? te._lastFireType : null;
        if (!c.cm || now - c.cm.f >= CM_HOLD || c.cm.oppW !== oppW || (c.cm.hp >= 0.5) !== (hpF >= 0.5)) {
            const ch = comChooseManeuver(P, hpF, wWant, oppW);
            const changed = !c.cm || c.cm.mode !== ch.mode || c.cm.prio !== ch.prio;
            c.cm = { f: now, oppW, hp: hpF, mode: ch.mode, prio: ch.prio };
            if (changed) comThinkEvent('p', '戦闘機動 → ' + (ch.mode === 'flank' ? '回り込み (後方へ周回)' : '正対 (艦首を向けて間合いを保つ)') + '・' + (ch.prio === 'evade' ? '回避' : '攻撃') + '優先・間合いは兵装' + (oppW ? ' — 相手は' + _WPN_JP[oppW] : '') + ' (攻撃性' + _pct(P.aggression) + '・慎重さ' + _pct(P.caution) + ')');
        }
        if (combatMode.mode !== c.cm.mode || combatMode.prio !== c.cm.prio || combatMode.range !== 'auto') { combatMode = { mode: c.cm.mode, range: 'auto', prio: c.cm.prio }; syncCombatBar(); }
        comThink('p', 'full', '有視界で捉えた (' + Math.round(lk.dist / 100) * 100 + 'u) → ' + (combatMode.mode === 'flank' ? '回り込み' : '正対') + 'で撃つ');
        if (contact && P.aggression >= 0.5 && now - c.lastDeploy > COM_DEPLOY_GAP) _comDeploy(c, P);
        _comStance(c, P);
        return;
    } else if (te && lk.assumed) {
        _comCMOff(); // 推定だけの間は測量の航路を引く (戦闘モードは見えている時だけ)
        const w = currentWeapon(), sa = _signalAnalysis[enemySid(te)];
        const lm = sa && sa.misses && sa.misses[sa.misses.length - 1], lo = sa && sa.obs[sa.obs.length - 1];
        const hc = assumedHitChance(te, w, lk);
        let bw = w, bh = hc;
        for (const w2 of ['beam', 'missile']) { const h2 = assumedHitChance(te, w2, lk); if (h2 > bh + 0.15) { bw = w2; bh = h2; } }
        const no = String(_contactLabels[enemySid(te)] || '?').padStart(2, '0');
        if (lm && (!lo || lo.f < lm.f + 90)) held = 'SIG-' + no + ' 推定点は外れた → 新しい方位を取るまで撃たない';
        else if (bw !== w && bh >= fireThr) {
            switchWeapon(bw);
            comThink('p', 'sw' + bw, 'SIG-' + no + ' ' + _WPN_JP[bw] + 'なら命中予測' + _pct(bh) + ' ≥ 撃つ基準' + _pct(fireThr) + ' → 持ち替える');
        } else if (hc >= fireThr && playerWeaponReady(player, w)) {
            issueFireOrder();
            comThinkEvent('p', 'SIG-' + no + ' 命中予測' + _pct(hc) + ' ≥ 撃つ基準' + _pct(fireThr) + ' (攻撃性' + _pct(P.aggression) + ') → ' + _WPN_JP[w] + 'で撃つ (推定' + Math.round(lk.dist / 100) * 100 + 'u)');
            _comStance(c, P);
            return;
        } else if (hc > 0) held = 'SIG-' + no + ' 命中予測' + _pct(hc) + ' < 撃つ基準' + _pct(fireThr) + ' → まだ撃たない';
    }
    // 4) 出す
    if (contact && P.aggression >= 0.5 && now - c.lastDeploy > COM_DEPLOY_GAP) _comDeploy(c, P);
    // 5) 取る — 第33弾: 部品の枠が空いていれば、貪欲さ0.25以上で部品の取れる所 (難破船・確かめた漂流コンテナ・部品をまだ取っていないノード/コロニー) へ寄り道する
    if (!contact && P.greed >= 0.25 && partSlotsUsed() < partSlotsMax()) {
        let ps = null, pd = COM_GOAL_RANGE * 1.5;
        for (const st of structures) {
            const ok = st.type === 'derelict' ? !st.salvaged : st.type === 'colony' ? !st._partP && !st.hacked : false;
            if (!ok) continue; const d = Math.hypot(st.x - player.x, st.y - player.y); if (d < pd) { pd = d; ps = st; }
        }
        for (const n of resourceNodes) { if (n._partP || n.owner === 'player') continue; const d = Math.hypot(n.x - player.x, n.y - player.y); if (d < pd) { pd = d; ps = n; } }
        for (const f of fieldSignals) { if (f.kind !== 'cache' || !(_sigIdent[f.sid] && _sigIdent[f.sid].sure)) continue; const d = Math.hypot(f.x - player.x, f.y - player.y); if (d < pd) { pd = d; ps = f; } }
        if (ps) {
            const kind = ps.kind === 'cache' ? '漂流コンテナ' : ps.type === 'derelict' ? '難破船' : ps.type === 'colony' ? 'コロニー' : 'ノード';
            const near = ps.kind === 'cache' ? CACHE_R * 0.5 : ps.type === 'derelict' ? DERELICT_SALVAGE_R * 0.6 : ps.type === 'colony' ? COLONY_HACK_R * 0.6 : NODE_CAP_R * 0.6;
            _comGoTo(ps, near, c);
            comThink('p', 'part' + kind, '敵の気配なし・部品の枠 ' + partSlotsUsed() + '/' + partSlotsMax() + ' → ' + kind + 'へ部品を取りに行く (' + _dirTxt(player.x, player.y, ps.x, ps.y) + ')');
            _comStance(c, P);
            return;
        }
    }
    if (!contact && P.greed >= 0.5) {
        const g = _comNearest(true, true);
        if (g) {
            const isNode = !g.type;
            _comGoTo(g, (isNode ? NODE_CAP_R : COLONY_HACK_R) * 0.6, c);
            comThink('p', 'greed' + (isNode ? 'n' : 'c'), '敵の気配なし・貪欲さ' + _pct(P.greed) + ' → ' + (isNode ? 'ノードを制圧しに行く' : 'コロニーをハックしに行く') + ' (' + _dirTxt(player.x, player.y, g.x, g.y) + ')');
            _comStance(c, P);
            return;
        }
    }
    // 6) 副長の助言に従う
    // 副長は移動中だと「直交航路」のボタンを出さない → 交点がまだ無い/広い時は、今の航路が方位線に直交していなければ自分で引く
    const bL = lockedSignalId && sigs[lockedSignalId], saL = lockedSignalId && _signalAnalysis[lockedSignalId];
    const towards = r && !r.act && /こちらへ向かってくる/.test(r.text);
    if (towards && bL && _comCanSteer(c)) {
        // 「横へ外すか、止まって待ち伏せろ」— 攻撃性0.5以上は止まって待ち伏せ (潜航)、未満は横へ外す
        if (P.aggression >= 0.5) {
            if (player.state === 'moving') { player.setTarget(player.x, player.y); _comSteered(c, 'stop'); }
            c.silentUntil = now + 600;
            comThink('p', 'ambush', 'SIG-' + String(_contactLabels[lockedSignalId] || '?').padStart(2, '0') + ' がこちらへ向かってくる・攻撃性' + _pct(P.aggression) + ' → 止まって潜航で待ち伏せる');
        } else {
            const hd = player.state === 'moving' ? Math.atan2(player.targetY - player.y, player.targetX - player.x) : null;
            if (hd === null || Math.abs(Math.sin(hd - bL.angle)) < 0.7) { xoPerpendicularLeg(bL.angle); _comSteered(c, 'perp'); }
            comThink('p', 'sidestep', 'SIG-' + String(_contactLabels[lockedSignalId] || '?').padStart(2, '0') + ' がこちらへ向かってくる・攻撃性' + _pct(P.aggression) + ' → 横へ外す');
        }
        _comStance(c, P);
        return;
    }
    if (r && !r.act && bL && !bL.relay && (!saL || !saL.fix || trackEstimate(saL, 0).r > 900) && _comCanSteer(c)) {
        const hd = player.state === 'moving' ? Math.atan2(player.targetY - player.y, player.targetX - player.x) : null;
        if (hd === null || Math.abs(Math.sin(hd - bL.angle)) < 0.5) {
            xoPerpendicularLeg(bL.angle); _comSteered(c, 'perp');
            comThink('p', 'perp', '副長「' + r.text + '」→ 方位線に直交する航路へ (場所を変えて聴き、交点を出す)');
            _comStance(c, P);
            return;
        }
    }
    const mv = r && r.act ? COM_MOVE_ACTS[r.act.label] : null;
    if (r && r.act && !COM_SKIP[r.act.label] && (!mv || _comCanSteer(c))) {
        r.act.fn();
        if (mv) _comSteered(c, mv);
        if (r.act.label === '接近' && P.aggression >= 0.7) c.flankUntil = now + 1200;
        if (r.act.label === '潜航') c.silentUntil = now + 1200;
        comThink('p', 'xo' + r.act.label, (held ? held + '。' : '') + '副長「' + r.text + '」→ ' + r.act.label + (c.flankUntil > now && r.act.label === '接近' ? ' (攻撃性' + _pct(P.aggression) + ' → 全速で)' : ''));
    } else if (held) {
        // 撃たないなら測り直す (方位線に直交して動く)
        const b = te && sigs[enemySid(te)];
        if (b && player.state !== 'moving') { xoPerpendicularLeg(b.angle); _comSteered(c, 'perp'); }
        comThink('p', 'held', held + (b ? ' — 直交して測り直す' : ''));
    } else if (player.state !== 'moving') {
        // 手掛かりが無い: 最後の推定位置 → マップ中央の順に捜索航路を引く
        let tx = MAP_CX, ty = MAP_CY, why = 'マップ中央方面';
        const sa = lockedSignalId && _signalAnalysis[lockedSignalId], est = sa && trackEstimate(sa, 0);
        if (est) { tx = est.x; ty = est.y; why = '最後の推定位置'; }
        let ang = Math.atan2(ty - player.y, tx - player.x);
        if (Math.hypot(tx - player.x, ty - player.y) < 1500) ang = Math.random() * Math.PI * 2;
        _setLeg(ang + (Math.random() - 0.5) * 0.6, COM_SEARCH_LEG, '捜索航路'); _comSteered(c, 'leg');
        comThink('p', 'search', (r ? '副長「' + r.text + '」。' : '') + '手掛かりなし → ' + why + 'へ捜索航路 (動けば痕跡が残る)');
    } else if (r && _frameCount - _thinkLastP > 180) { // 直前(3秒以内)に何か決めたばかりなら「続ける」は言わない
        comThink('p', 'xo-' + r.tone + r.text.replace(/[\d.±]+/g, '#'), '副長「' + r.text + '」→ 今の航路を続ける');
    }
    _comStance(c, P);
}
function _comDeploy(c, P) {
    for (const k of ['mech', 'attack', 'build', 'scout']) {
        if (!(SHIP_DRONES[gameState.shipType] || []).includes(k) || !canDeployNow(k)) continue;
        deployDrone(k); c.lastDeploy = _frameCount;
        comThinkEvent('p', '敵を掴んでいる・攻撃性' + _pct(P.aggression) + ' → ' + DRONE_SPEC[k].label + 'を出す');
        return;
    }
}
// 出力スタンス: 全速(接近中・攻撃的) > 潜航(隠密 or 副長が「追われている」と言った) > 巡航
function _comStance(c, P) {
    if (c.mode === 'escape' || c.mode === 'hide') return;
    const want = c.flankUntil > _frameCount ? 'flank' : (P.stealth >= 0.5 || c.silentUntil > _frameCount) ? 'silent' : 'cruise';
    if (powerStance !== want) setStance(want, true);
}
// 最寄りの「取れる」もの: ノード(自分のもの以外) / 未ハックのコロニー
function _comNearest(nodes, colonies) {
    let best = null, bd = COM_GOAL_RANGE;
    if (nodes) for (const n of resourceNodes) { if (n.owner === 'player') continue; const d = Math.hypot(n.x - player.x, n.y - player.y); if (d < bd) { bd = d; best = n; } }
    if (colonies) for (const st of structures) { if (st.type !== 'colony' || st.hacked) continue; const d = Math.hypot(st.x - player.x, st.y - player.y); if (d < bd) { bd = d; best = st; } }
    return best;
}
function _comGoTo(o, near, c) {
    if (Math.hypot(o.x - player.x, o.y - player.y) > near) {
        const same = player.state === 'moving' && Math.hypot(player.targetX - o.x, player.targetY - o.y) <= 50;
        if (!same && (!c || _comCanSteer(c))) { player.setTarget(o.x, o.y); if (c) _comSteered(c, 'goto'); }
    }
    else if (player.state === 'moving') player.setTarget(player.x, player.y); // 着いたら止まって制圧/ハック/補給
}
// 今の航路を変えてよいか (到着した・20秒たった。直交航路は到着まで)
function _comCanSteer(c) {
    if (player.state !== 'moving') return true;
    const age = _frameCount - (c.legF ?? -1e9);
    if (c.legKind === 'perp') return age >= COM_LEG_HOLD * 3; // 直交航路は走り切る (60秒で打ち切る安全弁)
    return age >= COM_LEG_HOLD;
}
function _comSteered(c, kind) { c.legF = _frameCount; c.legKind = kind; }
const COM_MOVE_ACTS = { '直交航路': 'perp', '接近': 'leg', 'その方面へ': 'leg', '補給へ': 'leg' };

// ── COM対戦デモの設定画面 (ロビー) ──
function openComDemo() {
    comCfg = loadComCfg();
    _renderComCfg();
    document.getElementById('com-overlay').classList.remove('hidden');
    playSound('ui');
}
function _renderComCfg() {
    const c = comCfg;
    for (const side of ['p', 'e']) {
        const box = document.querySelector('.com-side[data-side="' + side + '"]');
        if (!box) continue;
        const ship = side === 'p' ? c.ship : c.enemy, pre = side === 'p' ? c.pPreset : c.ePreset, pp = side === 'p' ? c.pp : c.ep;
        const h = ['<div class="com-side-title ' + (side === 'p' ? 'cs-p' : 'cs-e') + '">' + (side === 'p' ? '自機COM' : '敵COM') + '</div><div class="com-row">'];
        for (const k of ['assault', 'stealth', 'carrier']) h.push('<button class="com-chip' + (ship === k ? ' on' : '') + '" data-act="ship" data-v="' + k + '">' + SHIP_JP[k] + '</button>');
        h.push('</div><div class="com-row">');
        for (const k in COM_PRESETS) h.push('<button class="com-chip' + (pre === k ? ' on' : '') + '" data-act="preset" data-v="' + k + '">' + COM_PRESETS[k].label + '</button>');
        h.push('</div>');
        const rnd = pre === 'random';
        for (const [k, lbl] of COM_AXES) {
            const v = Math.round((pp[k] || 0) * 100);
            h.push('<label class="com-sl"><span>' + lbl + '</span><input type="range" min="0" max="100" step="5" value="' + v + '" data-act="axis" data-v="' + k + '"' + (rnd ? ' disabled' : '') + '><b>' + (rnd ? '—' : v) + '</b></label>');
        }
        if (rnd) h.push('<div class="com-note">ランダム: 試合ごとに' + SHIP_JP[ship] + 'の範囲で決まる (敵の通常の決め方と同じ)</div>');
        else if (pre === 'custom') h.push('<div class="com-note">カスタム (スライダーで調整)</div>');
        // 第22弾: 積み込み (自機/敵とも編集できる)
        h.push('<div class="com-row com-lo"><span class="com-lo-sum">積み込み: ' + loSummary(comLoadout(side, ship), ship, side === 'e') + '</span><button class="com-chip" data-act="loadout">編集</button></div>');
        box.innerHTML = h.join('');
    }
    const o = document.getElementById('com-opts');
    if (o) o.innerHTML = '<span class="com-opt-lbl">モード</span>'
        + '<button class="com-chip' + (c.mode === 'br' ? ' on' : '') + '" data-act="mode" data-v="br">バトルロワイアル</button>'
        + '<button class="com-chip' + (c.mode === 'sd' ? ' on' : '') + '" data-act="mode" data-v="sd">サーチ&amp;デストロイ</button>'
        + '<span class="com-opt-lbl">ヒッグス表示</span><button class="com-chip' + (c.higgsView ? ' on' : '') + '" data-act="higgs">' + (c.higgsView ? 'ON' : 'OFF (全艦が見える)') + '</button>'
        + '<span class="com-opt-lbl">思考ログ</span><button class="com-chip' + (c.think ? ' on' : '') + '" data-act="think">' + (c.think ? 'ON' : 'OFF') + '</button>'
        + '<span class="com-opt-lbl com-sector">セクター' + gameState.sector + '・今の改修のまま</span>';
}
function startComDemo() {
    saveComCfg();
    document.getElementById('com-overlay').classList.add('hidden');
    comDemo = true;
    document.body.classList.add('com-demo');
    document.querySelectorAll('.enemy-select-btn').forEach(b => b.classList.toggle('active', b.dataset.type === comCfg.enemy));
    document.querySelectorAll('.mode-card').forEach(m => m.classList.toggle('active', m.dataset.mode === comCfg.mode));
    gameState.mode = comCfg.mode;
    // 第22弾: 自機COMの積み込み (デモは保存しないので、この試合の間だけ使う)
    if (comCfg.lo && comCfg.lo.p && comCfg.lo.p[comCfg.ship]) gameState.loadout = Object.assign({}, gameState.loadout, { [comCfg.ship]: Object.assign({}, comCfg.lo.p[comCfg.ship]) });
    toggleThinkLog(comCfg.think);
    startGame(comCfg.ship);
    toggleHiggsView(!comCfg.higgsView);
    logMessage('COM対戦デモ: 自機もCOMが操作する (観戦のみ)。メニューで ヒッグス表示 / 思考ログ を切替、終わる時は「COM対戦を終えてロビーへ」', 'system-msg');
}
// デモは保存しないので、ページを読み直せば出撃前の状態 (戦歴・クレジット) に戻る
function exitComDemo() { location.reload(); }
(() => {
    const ov = document.getElementById('com-overlay');
    if (!ov) return;
    document.getElementById('btn-com-demo')?.addEventListener('click', openComDemo);
    document.getElementById('com-cancel').addEventListener('click', () => { saveComCfg(); ov.classList.add('hidden'); });
    document.getElementById('com-start').addEventListener('click', startComDemo);
    ov.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-act]');
        if (!b || !comCfg) return;
        const side = b.closest('.com-side')?.dataset.side, act = b.dataset.act, v = b.dataset.v;
        if (act === 'loadout') { openLoadout(side === 'p' ? comCfg.ship : comCfg.enemy, false, side); return; }
        if (act === 'ship') { if (side === 'p') comCfg.ship = v; else comCfg.enemy = v; }
        else if (act === 'preset') {
            if (side === 'p') comCfg.pPreset = v; else comCfg.ePreset = v;
            if (COM_PRESETS[v].p) Object.assign(side === 'p' ? comCfg.pp : comCfg.ep, COM_PRESETS[v].p);
        }
        else if (act === 'mode') comCfg.mode = v;
        else if (act === 'higgs') comCfg.higgsView = !comCfg.higgsView;
        else if (act === 'think') comCfg.think = !comCfg.think;
        _renderComCfg();
        playSound('ui');
    });
    ov.addEventListener('input', (ev) => {
        const r = ev.target.closest('input[data-act="axis"]');
        if (!r || !comCfg) return;
        const side = r.closest('.com-side').dataset.side;
        (side === 'p' ? comCfg.pp : comCfg.ep)[r.dataset.v] = +r.value / 100;
        if (side === 'p') comCfg.pPreset = 'custom'; else comCfg.ePreset = 'custom';
        r.nextElementSibling.textContent = r.value;
        r.closest('.com-side').querySelectorAll('button[data-act="preset"]').forEach(x => x.classList.remove('on'));
    });
    document.getElementById('think-head')?.addEventListener('click', () => document.getElementById('think-panel').classList.toggle('wide'));
})();

// ── 敵COMの思考 — 敵AIが今「何を信じ・何をしようとしているか」を1秒ごとに要約 (変わった時だけ出す) ──
const _ESTATE_SIG = (fr) => fr > 0.5 ? 'hi' : fr > 0.02 ? 'lo' : 'no';
function comEnemyThinkTick() {
    if (!comDemo || !thinkLogOn || _frameCount % 30) return;
    for (const e of enemies) {
        if (e.type === 'fighter' || e.hp <= 0 || e._dying) continue;
        const t = _enemyThought(e);
        comThink('e', t.sig, t.text, 'e' + e.uid);
    }
}
function _enemyThought(e) {
    const lk = e.playerLastKnownPos, fr = e.contactFreshness || 0;
    const belief = lk && fr > 0.02
        ? '自機は' + _dirTxt(e.x, e.y, lk.x, lk.y) + 'と見る (確信' + _pct(fr) + (e._noiseLk ? '・実はノイズメーカーの音' : '') + ')'
        : (e.intelPos ? '自機の位置は司令部情報の概位置だけ' : '自機の位置は掴めていない');
    const hp = _pct(e.hp / e.maxHp);
    const ct = e._cThink || {};
    let sig, act;
    if (e._hideT > 0) {
        if (e._hiding) { sig = 'hide'; act = '潜伏中 — 機関を止めて修復 (耐久' + hp + '・残り' + Math.ceil(e._hideT / 60) + '秒)'; }
        else { sig = 'tohide'; act = '耐久' + hp + ' → 隠れ場所の' + (e._hideSpot.kind === 'fog' ? '濃い霧' : '岩礁帯') + 'へ (' + _dirTxt(e.x, e.y, e._hideSpot.x, e._hideSpot.y) + ')'; }
    } else if (e.postFireCooldown > 0) {
        sig = 'reloc'; act = '撃った位置から離れている (撃てば位置を教えるので留まらない)';
    } else if (e.aiState === 'combat') {
        sig = 'c-' + (ct.mode || '');
        const why = (ct.kill ? '・相手は瀕死と見て踏み込む' : '') + (ct.out ? '・相手の方が頑丈 → 殴り合わず間合いを取る' : '');
        act = ct.mode === 'retreat' ? '耐久' + hp + ' < 退き際' + _pct(ct.thr || 0) + ' (慎重さ' + _pct((e.personality || {}).caution || 0) + ') → 後退・回復を探す'
            : ct.mode === 'approach' ? '交戦 — 推定位置まで' + Math.round((ct.dist || 0) / 100) * 100 + 'u > 間合い' + Math.round((ct.standoff || 0) / 100) * 100 + 'u → 詰める' + why
            : ct.mode === 'flee' ? '交戦 — 近すぎる (' + Math.round((ct.dist || 0) / 100) * 100 + 'u) → 離れる' + why
            : ct.mode === 'kite' ? '交戦 — 間合いを詰められた → 下がる' + why
            : '交戦 — 間合いを保ち横へ動く (読まれにくく)' + why;
    } else if (e.aiState === 'hunting') {
        sig = 'hunt'; act = '索敵 — 反応のあった所へ向かう (確信が45%を切ったら探信を打つ)';
    } else if (e.aiState === 'gathering') {
        const g = e.gatherTarget;
        sig = 'gather'; act = g ? 'ノードを取りに行く (' + _dirTxt(e.x, e.y, g.x, g.y) + '・貪欲さ' + _pct((e.personality || {}).greed || 0) + ')' : 'ノードを探す';
    } else if (lk && fr > 0.04) {
        sig = 'scent'; act = '潜伏 — 残り香を追って忍び寄る';
    } else if (e.intelPos) {
        sig = 'intel'; act = '潜伏 — 司令部情報の方面へ隠れ場所伝いに前進';
    } else {
        sig = 'lurk'; act = '潜伏 — 待ち伏せて聴いている';
    }
    return { sig: sig + '|' + _ESTATE_SIG(fr), text: act + '。' + belief };
}

// 副長の状況判断。優先度順に「今いちばん大事なこと」と、その場で押せる1アクションを返す
function xoEvaluate() {
    if (!player) return null;
    if (player.hp <= 0) return { tone: 'bad', text: '艦体崩壊 — 通信途絶' };
    if (sectorCleared) return { tone: 'good', text: '敵艦撃沈 — セクター制圧。帰投して補給・改修へ', act: { label: '帰投', fn: () => openDebrief() } };

    const w = currentWeapon();
    // 0) 第17弾: 捕捉され耐久が半分を切ったら、目の前のミサイルを避けるより離脱 (閃光でミサイルの誘導も切れる)
    if (playerExposureLevel >= 3 && player.hp / player.maxHp < XO_ESCAPE_HP)
        return { tone: 'bad', text: xoEscapeAdvice(), act: { label: '離脱', fn: xoEscapeStep } };
    // 1) 接近するミサイル
    const msl = projectiles.find(p => p.active && !p.isPlayer && p.type === 'missile' && p._torpAlerted);
    if (msl) {
        const ang = Math.atan2(msl.y - player.y, msl.x - player.x);
        if ((SHIP_DRONES[gameState.shipType] || []).includes('decoy') && (cargo.stock.decoy || 0) > 0 && activeDeployCount() < (CARGO_CAP[gameState.shipType] || 0))
            return { tone: 'bad', text: `ミサイル接近 方位${compassDeg(ang)}° — デコイで逸らせ`, act: { label: 'デコイ', fn: () => deployDrone('decoy') } };
        return { tone: 'bad', text: `ミサイル接近 方位${compassDeg(ang)}° — 横へ回避`, act: { label: '回避', fn: () => xoEvade(ang) } };
    }
    if (player._weaponJamTimer > 0) return { tone: 'bad', text: '火器管制ダウン — 復旧まで撃てない。距離を取れ' };
    // 第21弾: 囮の地点選び / エンジン切替中
    if (pendingLure) return { tone: 'info', text: '囮: ' + DRONE_SPEC[pendingLure].label + 'を射出する地点をタップ (もう一度押すと取りやめ)' };
    if (engineSwitchT > 0) return { tone: 'info', text: ENGINE_JP[engineSwitchTo] + 'へ切替中 あと' + Math.ceil(engineSwitchT / 60) + '秒 — 推力ゼロ (惰性)・EMが漏れる' };
    // 第20弾: 補給中 / 弾が尽きた
    if (_resupply) return { tone: 'info', text: (_resupply.kind === 'station' ? '補給所' : 'コロニー') + 'で補給中 ' + Math.round(Math.min(1, _resupply.p) * 100) + '% — EMが漏れる。離れると中断' };
    if (cargo.ammoK <= 0 && cargo.ammoM <= 0) {
        const rs = nearestResupply(player.x, player.y);
        return { tone: 'bad', text: '実弾もミサイルも尽きた — ' + (rs ? '離脱して' + (rs.kind === 'station' ? '補給所' : 'コロニー') + 'へ (方位' + compassDeg(Math.atan2(rs.obj.y - player.y, rs.obj.x - player.x)) + '° ' + Math.round(rs.d / 100) * 100 + 'u)。ビームは撃てる' : 'ビームしか撃てない (コロニーを占有すれば補給できる)'),
                 act: rs ? { label: '補給へ', fn: () => { player.setTarget(rs.obj.x, rs.obj.y); } } : null };
    }
    // 第16弾: ノード制圧・コロニーハック中 (留まっている間EMが漏れる)
    if (_capturing) {
        const pc = Math.round(Math.min(1, _capturing.p) * 100);
        return { tone: 'info', text: _capturing.kind === 'node'
            ? `ノード制圧中 ${pc}% — EMが漏れる。離れると中断 (制圧すると資材と聴音局が手に入る)`
            : _capturing.kind === 'derelict' ? `難破船を回収中 ${pc}% — 弾と資材`
            : _capturing.contested ? `コロニーに敵艦が居る — 占有が進まない (追い払うか、待つか)`
            : `コロニーを占有中 ${pc}% — EMが漏れる。離れると中断 (1回の補給・敵の位置の手掛かり)` };
    }

    const te = bestFireTarget();
    const lk = te ? playerLockInfo(te) : null;
    // 2) 有視界で捉えた目標
    if (te && lk.full) {
        const unaware = te.detectionState === 'unaware';
        if (!autoAttackEnabled) return { tone: 'go', text: unaware ? '奇襲可能 ×' + (w === 'beam' ? AMBUSH_PREEMPT_BEAM_MULT : AMBUSH_PREEMPT_MULT) + ' — 敵はまだ気付いていない' : '目標を有視界に捉えた — 長押し→射撃 (自動攻撃はメニューでOFFになっている)', act: { label: '射撃', fn: issueFireOrder } };
        return { tone: 'go', text: unaware ? '奇襲可能 ×' + (w === 'beam' ? AMBUSH_PREEMPT_BEAM_MULT : AMBUSH_PREEMPT_MULT) + ' — 自動攻撃で撃つ' : `交戦中 — 有視界・完全ロック (${Math.round(lk.dist)}u)` };
    }

    // 4) センサー推定の射撃解
    if (te && lk.assumed) {
        // 外れた後は、新しい方位を取るまで同じ推定で撃ち直さない (外れ=「そこには居ない」という情報)
        const saT = _signalAnalysis[enemySid(te)];
        const lm = saT && saT.misses && saT.misses[saT.misses.length - 1];
        const lo = saT && saT.obs[saT.obs.length - 1];
        if (lm && (!lo || lo.f < lm.f + 90)) {
            const b0 = currentSignals()[enemySid(te)];
            return { tone: 'info', text: '推定点は外れた (そこには居ない) — 場所を変えて方位を取り直せ', act: b0 && player.state !== 'moving' ? { label: '直交航路', fn: () => xoPerpendicularLeg(b0.angle) } : null };
        }
        const hc = assumedHitChance(te, w, lk);
        // 武器の向き不向き: 他の武器の方がはるかに当たるなら切替を勧める
        let bestW = w, bestHc = hc;
        for (const w2 of ['beam', 'missile']) {
            const h2 = assumedHitChance(te, w2, lk);
            if (h2 > bestHc + 0.15) { bestW = w2; bestHc = h2; }
        }
        if (bestW !== w && bestHc >= 0.5)
            return { tone: 'go', text: `射撃解あり — ${bestW === 'beam' ? 'ビーム' : 'ミサイル'}なら命中予測${Math.round(bestHc * 100)}%`, act: { label: bestW === 'beam' ? 'BEAMへ' : 'MSLへ', fn: () => switchWeapon(bestW) } };
        const fxT = saT && saT.fix;
        if (hc >= 0.5 && (!fxT || fxT.chi2 <= 3) && playerWeaponReady(player, w))
            return { tone: 'go', text: `射撃解 ${w.toUpperCase()} 命中予測${Math.round(hc * 100)}% — 推定円を長押し→射撃 (撃てば自位置も露出する)`, act: { label: '射撃', fn: issueFireOrder } };
    }
    // 5) 追跡中の信号 — 第15弾: 「記録した方位線の交点」の状態を読み上げる (答えは言わない)
    const sigs = currentSignals();
    if (lockedSignalId && !sigs[lockedSignalId] && !Object.keys(sigs).some(k => k !== lockedSignalId)) {
        // 追跡中の信号が途切れ、他に追える信号も無い → 下位の判断(同調・司令部情報など)へ落とす
        const sa0 = _signalAnalysis[lockedSignalId] || {};
        if (sa0.lostSince === undefined) sa0.lostSince = _frameCount;
    } else if (lockedSignalId) {
        const sa = _signalAnalysis[lockedSignalId] || { obs: [] };
        delete sa.lostSince;
        const b = sigs[lockedSignalId];
        const _idn = identInfo(lockedSignalId); // 第23弾: 識別を添える
        const no = String(_contactLabels[lockedSignalId] || '?').padStart(2, '0') + '〔' + _idn.txt + '〕';
        if (!b) return { tone: 'info', text: `SIG-${no} の音が途絶えた — 止まったか霧に入った。HIGGS帯で航跡を探すか、他の信号へ`, act: { label: '次の信号', fn: trackNextSignal } };
        if (b.relay && !sa.fix) return { tone: 'info', text: `SIG-${no} は${b.sensorLabel}の方位線だけ — 自艦でも聴ける所まで寄るか、別の聴音局で交差させろ` };
        const fx = sa.fix;
        const n = sa.obs ? sa.obs.length : 0;
        if (n >= 3) {
            const o1 = sa.obs[n - 3], o3 = sa.obs[n - 1];
            if (o3.f - o1.f >= 300 && Math.abs(_angDiff(o3.ang, o1.ang)) < 0.035 && (o3.st || 0) > (o1.st || 0) * 1.25)
                return { tone: 'bad', text: `SIG-${no} 方位が動かず信号が強まる — こちらへ向かってくる。横へ外すか、止まって待ち伏せろ` };
        }
        if (!fx) {
            // 第18弾: あと何u横へ動けば交点が出るか (基線=方位線に直交する向きへ聴いた場所の広がり)
            const need = Math.max(0, Math.ceil((TMA_MIN_BASE - (sa.base || 0)) / 50) * 50);
            const t = n < 3 ? `SIG-${no} 方位${b.bearingDeg}° — 方位だけでは距離が分からない。横へ動いて別の場所から聴け`
                            : need > 0 ? `SIG-${no} 方位線${n}本 — まだ交わらない。方位線に直交してあと約${need}u動け`
                                       : `SIG-${no} 方位線${n}本 — 線が食い違う (相手が動いている)。直交してもう一度聴け`;
            return { tone: 'info', text: t, act: player.state !== 'moving' ? { label: '直交航路', fn: () => xoPerpendicularLeg(b.angle) } : null };
        }
        const estR = (trackEstimate(sa, 0) || fx).r; // 表示・射撃と同じ幅 (時間と「動いているかも」で広がる)
        const rr = Math.round(estR / 100) * 100;
        if (fx.chi2 > 4) return { tone: 'info', text: `SIG-${no} 方位線が食い違う (±${rr}u) — 相手は動いている。新しい方位を重ねろ`, act: player.state !== 'moving' ? { label: '直交航路', fn: () => xoPerpendicularLeg(b.angle) } : null };
        const isEnemy = /^e-/.test(lockedSignalId);
        if (isEnemy && te && lk && lk.assumed && lk.dist > weaponRange(w)) {
            // 届いて当たり得る兵装があるなら、近づくより持ち替えを勧める (近づけば聞かれ、撃たれる)
            let reach = null, reachHc = 0;
            for (const w2 of ['missile', 'beam']) {
                if (w2 === w || weaponRange(w2) < lk.dist) continue;
                const h2 = assumedHitChance(te, w2, lk);
                if (!reach || h2 > reachHc) { reach = w2; reachHc = h2; }
            }
            if (reach && reachHc >= 0.35) return { tone: 'info', text: `SIG-${no} 推定 ±${rr}u・距離${Math.round(lk.dist)}u — ${reach === 'beam' ? 'ビーム' : 'ミサイル'}なら届く (命中予測${Math.round(reachHc * 100)}%)`, act: { label: reach === 'beam' ? 'BEAMへ' : 'MSLへ', fn: () => switchWeapon(reach) } };
            // ビームは届くが推定が広すぎる: ソナーで「点」を取れば狙える (ただし聞かれる → 撃ったら離れる)
            // 潜航型(狙撃とヒット&アウェイが役割)は近づかず、ソナーで点を取ってビームで撃ち、全速で離れる
            if (reach === 'beam' && omniSonarCooldown <= 0 && gameState.shipType === 'stealth')
                return { tone: 'info', text: `SIG-${no} ビームなら届くが推定が広い (±${rr}u) — ソナーで点を取れば狙える。聞かれるので撃ったら全速で離れろ`, act: { label: 'ソナーで測る', fn: () => { switchWeapon('beam'); fireOmniSonar(); } } };
            const a = Math.atan2(te.displayY - player.y, te.displayX - player.x);
            const heading = player.state === 'moving' && Math.abs(_angDiff(Math.atan2(player.targetY - player.y, player.targetX - player.x), a)) < 0.5;
            return { tone: 'info', text: `SIG-${no} 推定 ±${rr}u・距離${Math.round(lk.dist)}u — ${w.toUpperCase()}の射程外。詰めるか兵装を変えろ`, act: heading ? null : { label: '接近', fn: () => _setLeg(a, Math.min(lk.dist * 0.5, 5000), '接近') } };
        }
        // 遠い相手は方位だけでは推定が距離の12%より狭まらない — ビームで狙うならソナーで点を取る
        if (!sa.motion && sa.alt && estR > 900 && estR > fx.r * 1.5)
            return { tone: 'info', text: `SIG-${no} 推定 ±${rr}u — 止まっているとも、ゆっくり動いているとも取れる。直交してもう一度聴け`, act: player.state !== 'moving' ? { label: '直交航路', fn: () => xoPerpendicularLeg(b.angle) } : null };
        if (estR > 900 && w === 'beam' && te && lk && lk.assumed && lk.dist > 2800 && omniSonarCooldown <= 0)
            return { tone: 'info', text: `SIG-${no} 推定 ±${rr}u — 遠くて方位だけでは絞れない。ソナーで点を取ればビームで狙える (聞かれる)`, act: { label: 'ソナーで測る', fn: fireOmniSonar } };
        if (estR > 900) return { tone: 'info', text: `SIG-${no} 推定 ±${rr}u・解析${anaPct(sa.ana)}% — まだ広い。聴き続けるか、角度を変えて重ねろ`, act: player.state !== 'moving' ? { label: '直交航路', fn: () => xoPerpendicularLeg(b.angle) } : null };
        // 第18弾: 針路が読めていれば伝える (射撃命令は見越し点を狙う)
        if (_idn.known && _idn.low && !_idn.txt.includes('確認')) return { tone: 'info', text: `SIG-${no} 推定 ±${rr}u — 艦影らしくない。囮かもしれない — ソナーの反響で確かめるか、別の信号へ`, act: { label: 'ソナーで測る', fn: fireOmniSonar } };
        if (_idn.known && _idn.low) return { tone: 'info', text: `SIG-${no} — 囮だった。別の信号を追え`, act: { label: '次の信号', fn: trackNextSignal } };
        if (sa.motion) return { tone: 'go', text: `SIG-${no} 推定 ±${rr}u・針路${compassDeg(Math.atan2(sa.motion.vy, sa.motion.vx))}° 約${Math.round(Math.hypot(sa.motion.vx, sa.motion.vy) * 60)}u/s — 見越して撃てる。外せば自位置を教える` };
        return { tone: 'go', text: `SIG-${no} 推定 ±${rr}u — 撃てる幅だ。外せば自位置を教える` };
    }
    // 6) 受信中だが未追跡
    const sigList = Object.values(sigs).filter(b => b.sourceId !== lockedSignalId && !b.relay);
    const relayOnly = Object.values(sigs).find(b => b.sourceId !== lockedSignalId && b.relay);
    if (sigList.length === 0 && relayOnly)
        return { tone: 'info', text: `${relayOnly.sensorLabel}が SIG-${String(relayOnly.contactNo || '?').padStart(2, '0')} を捕捉 — 追跡すると方位線が推定に加わる`, act: { label: '追跡', fn: trackNextSignal } };
    if (sigList.length > 0) {
        sigList.sort((a, c) => (c.strength || 0) - (a.strength || 0));
        const b = sigList[0];
        return { tone: 'info', text: `${BAND_JP[b.sensor] || b.sensorLabel}反応 方位${b.bearingDeg}° (${sigList.length}件) — リングの点か地図の円をタップして追跡し、方位を記録しろ`, act: { label: '追跡', fn: trackNextSignal } };
    }
    // 7) 第21弾: 帯域はON/OFF (OFFの帯域は聴いていないので「別の帯域に反応」は分からない)
    const rx = rxLevels();
    // 第20弾: ミサイルを撃ち尽くした
    if (cargo.ammoM <= 0 && (SHIP_DRONES[gameState.shipType] || []).length) {
        const rs = nearestResupply(player.x, player.y);
        if (rs) return { tone: 'info', text: 'ミサイル切れ — ' + (rs.kind === 'station' ? '補給所' : 'コロニー') + 'で補給できる (方位' + compassDeg(Math.atan2(rs.obj.y - player.y, rs.obj.x - player.x)) + '° ' + Math.round(rs.d / 100) * 100 + 'u)。実弾とビームは撃てる', act: { label: '補給へ', fn: () => { player.setTarget(rs.obj.x, rs.obj.y); } } };
    }
    // 8) 追われている
    // 第26弾: 修理はリペアキットだけ — 攻撃を受けていない時に、損傷がキット1個分を超えていれば勧める
    if (playerExposureLevel <= 1 && (cargo.stock.repair || 0) > 0 && !(player._kitT > 0) && player.maxHp - player.hp >= REPAIR_KIT_HP * 0.8)
        return { tone: 'info', text: '耐久' + Math.round(player.hp / player.maxHp * 100) + '% — 今のうちにリペアキットで修理 (6秒で+' + REPAIR_KIT_HP + '・残り' + cargo.stock.repair + '個。補給はできない)', act: { label: '修理', fn: () => deployDrone('repair') } };
    if (player._kitT > 0) return { tone: 'info', text: '修理中 — あと' + Math.ceil(player._kitT / 60) + '秒 (耐久' + Math.round(player.hp / player.maxHp * 100) + '%)' };
    // 第23弾: 観測した兆候を根拠に言う (旧: 「追跡されている」=敵の内部状態を読んでいた)
    if (playerExposureLevel >= 2) {
        const dg = threatObs.deg !== null && threatObs.deg !== undefined ? '方位' + threatObs.deg + '°' : '';
        if (threatObs.kind === 'fc') return { tone: 'bad', text: dg + 'から火器管制の照準波 — 撃たれる。射線から外れろ' + (silentRunning ? '' : ' (潜航で気配も消せ)'), act: silentRunning ? null : { label: '潜航', fn: () => setStance('silent') } };
        if (threatObs.kind === 'ping' && !silentRunning) return { tone: 'bad', text: dg + 'から敵の探信を受けた — 反響で位置が知れた。潜航し、霧の濃い所(50%以上)へ', act: { label: '潜航', fn: () => setStance('silent') } };
    }
    if (surgePhase === 'warn') return { tone: 'info', text: 'ヒッグスサージ接近 — 通過中は互いに盲目。動けば航跡が濃く残る' };
    // 第31弾: 監視網の円 (自分のノード/コロニーの近くで強いシグネチャ)
    { let z = null; for (const q of sigZones) if (q.side === 'p' && (!z || q.life > z.life)) z = q;
      if (z) return { tone: 'go', text: '監視網の円 SIG-' + String(_contactLabels[z.sid] || '?').padStart(2, '0') + ' (方位' + compassDeg(Math.atan2(z.y - player.y, z.x - player.x)) + '° ' + Math.round(Math.hypot(z.x - player.x, z.y - player.y) / 100) * 100 + 'u) — 円の中のどこかで強いシグネチャ' }; }
    // 第31弾 (オーナー): OFFの帯域に反応 → ONにすれば方位が取れる
    { const rxa = rxLevels(true); let ob = null; for (const b of BANDS) if (!sensorsOn[b] && rxa[b] >= 0.5 && (!ob || rxa[b] > rxa[ob])) ob = b;
      if (ob) return { tone: 'info', text: 'OFFの' + (BAND_JP[ob] || ob) + '帯に反応 — ONにすれば方位が取れる (2本目以降は自艦も漏れる)' }; }
    // 9) 第20弾: 手掛かりが無い → 情報の取れる所を勧める (司令部情報は撤去)
    const src = xoInfoSource();
    if (src) {
        const heading = player.state === 'moving' && Math.hypot(player.targetX - src.x, player.targetY - src.y) < 800;
        return { tone: 'info', text: src.why + ' (方位' + compassDeg(Math.atan2(src.y - player.y, src.x - player.x)) + '° ' + Math.round(src.d / 100) * 100 + 'u)', act: heading ? null : { label: 'その方面へ', fn: () => player.setTarget(src.x, src.y) } };
    }
    // 司令部情報 (第20弾で開始時の配布は撤去。残すのは表示の互換だけ)
    if (intelBearing) {
        const ib = intelBearing;
        const heading = player.state === 'moving' && Math.abs(_angDiff(Math.atan2(player.targetY - player.y, player.targetX - player.x), ib.angle)) < 0.7;
        return { tone: 'info', text: `司令部情報: 敵艦は方位${compassDeg(ib.angle)}°方面 — 受信機で探りながら接近`, act: heading ? null : { label: 'その方面へ', fn: () => _setLeg(ib.angle + (Math.random() - 0.5) * 0.4, 4000, '捜索航路') } };
    }
    // 10) 何も無い
    const anyRx = BANDS.some(k => rx[k] > 0.15);
    if (anyRx) return { tone: 'info', text: '微弱な反応 — まだ方位は取れない。接近せよ' };
    return { tone: 'idle', text: '静寂 — 受信機に反応なし。' + (sensorOrder.length < 4 ? '聴く帯域を増やせば拾えるかも (2本目から漏れる) / ' : '') + 'ソナーは位置を晒す', act: { label: 'ソナー', fn: fireOmniSonar } };
}

// 第20弾: 手掛かりが無い時に情報の取れる所 — 遭難信号 (敵も来る) / 未ハックのコロニー (敵艦の方位線が1本入る) / 自分のものでないノード (聴音局)
function xoInfoSource() {
    if (!player) return null;
    // 第31弾: 監視網の円 (新しいもの) — その円の中のどこかで強いシグネチャ
    { let z = null; for (const q of sigZones) if (q.side === 'p' && (!z || q.life > z.life)) z = q;
      if (z) { const d = Math.hypot(z.x - player.x, z.y - player.y); if (d > z.r) return { x: z.x, y: z.y, d, why: '監視網の円 — 強いシグネチャがこの円のどこか。寄って聴け' }; } }
    // 記録に残っている敵の方位線 (コロニー・聴音局・以前の自艦の観測。90秒以内) → 推定位置か、線上の観測点から10000u先へ寄って自艦で聴く
    let lastO = null, lastSa = null;
    for (const sid in _signalAnalysis) {
        // 第31弾: 内部IDで艦を選ばない (旧: 'e-' で敵艦の記録だけを選んでいた)。正体が艦でないと分かった信号は除く
        const _id = _sigIdent[sid]; if (_id && _id.sure && _id.L < 0) continue;
        const sa = _signalAnalysis[sid], o = sa.obs[sa.obs.length - 1];
        if (o && _frameCount - o.f < TMA_KEEP && (!lastO || o.f > lastO.f)) { lastO = o; lastSa = sa; }
    }
    if (lastO) {
        const est = lastSa.fix ? trackEstimate(lastSa, 0) : null;
        const p = est ? { x: est.x, y: est.y } : clampToMapCircle(lastO.ox + Math.cos(lastO.ang) * 10000, lastO.oy + Math.sin(lastO.ang) * 10000, 1500);
        const d = Math.hypot(p.x - player.x, p.y - player.y);
        if (d > 1500) return { x: p.x, y: p.y, d, why: '記録の方位線 (' + Math.round((_frameCount - lastO.f) / 60) + '秒前) — 信号は' + (est ? '推定位置' : '方位' + compassDeg(lastO.ang) + '°の線上') + '。寄って自艦で聴け' };
    }
    // 第31弾: 正体を確かめた漂流コンテナ (回収すれば弾・資材)
    { let bc = null, bdc = Infinity;
      for (const f of fieldSignals) { if (f.kind !== 'cache' || !(_sigIdent[f.sid] && _sigIdent[f.sid].sure)) continue; const d = Math.hypot(f.x - player.x, f.y - player.y); if (d < bdc) { bdc = d; bc = f; } }
      if (bc && bdc > CACHE_R) return { x: bc.x, y: bc.y, d: bdc, why: '漂流コンテナ — 400u以内に3秒で回収 (弾・資材)' }; }
    // 遭難信号: 消える前に着けるなら (信号は60秒)
    for (const bc of beaconsFor('p')) { // 第21弾: 敵の偽SOSも見分けはつかない
        const d = Math.hypot(bc.x - player.x, bc.y - player.y);
        if (d / Math.max(0.8, player.currentSpeed || 0) < bc.life) return { x: bc.x, y: bc.y, d, why: '手掛かりなし — 遭難信号へ。敵も同じ信号を聞いている (先に着くか、待ち伏せるか)' };
    }
    // 第23弾: コロニー情報 — 距離まで分かっていればその範囲へ。方角だけならまずコロニーを増やす (無ければ方角へ)
    const it = playerIntel;
    if (it && it.dist) {
        const p = clampToMapCircle(it.ox + Math.cos(it.ang) * it.dist, it.oy + Math.sin(it.ang) * it.dist, 1500);
        const d = Math.hypot(p.x - player.x, p.y - player.y);
        if (d > 2000) return { x: p.x, y: p.y, d, why: 'コロニー情報 (' + it.n + 'つ占有) — 敵は方位' + compassDeg(it.ang) + '°±' + Math.round(it.aHW * 180 / Math.PI) + '°・' + Math.round(it.dist / 100) * 100 + 'u±' + Math.round(it.dHW / 100) * 100 + 'u の辺り。寄って聴け' };
    }
    let best = null, bd = Infinity;
    for (const st of structures) { if (st.type !== 'colony' || st.hacked) continue; const d = Math.hypot(st.x - player.x, st.y - player.y); if (d < bd) { bd = d; best = st; } }
    if (best && it && !it.dist && bd > 12000) {
        const p = clampToMapCircle(player.x + Math.cos(it.ang) * 8000, player.y + Math.sin(it.ang) * 8000, 1500);
        return { x: p.x, y: p.y, d: 8000, why: 'コロニー情報 — 敵は方位' + compassDeg(it.ang) + '°±' + Math.round(it.aHW * 180 / Math.PI) + '°。2つ目のコロニーは遠い (' + Math.round(bd / 1000) + 'k u) — 方角へ寄って聴け' };
    }
    if (best) return { x: best.x, y: best.y, d: bd, why: (best.owner === 'enemy' ? '敵のコロニーを奪え' : '手掛かりなし — コロニーを占有せよ') + ' (占有' + coloniesOwned('player') + 'つ: 1つごとに演算力+35%・解析と識別が速くなる)' };
    for (const n of resourceNodes) { if (n.owner === 'player') continue; const d = Math.hypot(n.x - player.x, n.y - player.y); if (d < bd) { bd = d; best = n; } }
    if (best) return { x: best.x, y: best.y, d: bd, why: '手掛かりなし — ノードを取れば聴音局になる (周囲' + NODE_RELAY_RANGE + 'uを聴く)' };
    return null;
}

// ── 戦術ストリップ(XOバー+バンドチューナー)の描画同期 — DOM更新は値が変わった時だけ (GC/レイアウト抑制) ──
let _xoState = null, _xoAct = null;
const _bandEls = {};
// 被探知状態 (上帯チップ)。静粛/デブリ擬態は同じチップに併記 (旧: フィールド上の文字列)
function _updateExpoChip() {
    const exL = playerExposureLevel;
    const exTxt = _EXPO_JP[exL] + (isBottomed ? '・擬態' : playerCoasting ? '・機関停止' : boostT > 0 ? '・噴射' : silentRunning ? '・潜航' : powerStance === 'flank' ? '・全速' : '')
        + (player && player.hp > 0 && playerClutter() > 0 ? '・混信' : ''); // 第18弾: 周りの発信源・地形に紛れている
    if (exTxt + exL === _hudCache.expo) return;
    _hudCache.expo = exTxt + exL;
    const ch = document.getElementById('hud-expo'), tx = document.getElementById('hud-expo-text');
    if (ch) ch.className = 'expo-' + exL;
    if (tx) tx.textContent = exTxt;
}
function updateTacStrip() {
    if (!player) return;
    // 4帯域ミキサー: 太=受信レベル (0.5の刻み=同調すれば方位が取れる) / 細=自艦の放射
    // 自艦側は「受信機の半分の距離にいる敵が、その帯域で方位を取れるか」を同じ0.5基準で表す (対称)
    const rx = rxLevels(true); // 第31弾: OFFの帯域もバーは動く
    const nz = Math.round(playerSelfNoise() * 50); // 自艦ノイズ: 受信バーの底から最大で刻み(50%)まで
    for (const b of BANDS) {
        let el = _bandEls[b];
        if (!el) {
            const btn = document.querySelector(`.band-btn[data-band="${b}"]`);
            if (!btn) continue;
            el = _bandEls[b] = { btn, fill: btn.querySelector('.bt-fill'), tx: btn.querySelector('.bt-tx-fill'), nz: btn.querySelector('.bt-noise'), w: -1, t: -1, n: -1, hot: null, txHi: null };
        }
        if (el.nz && nz !== el.n) { el.n = nz; el.nz.style.height = nz + '%'; }
        const w = Math.round(Math.min(1, rx[b]) * 100);
        if (w !== el.w) { el.w = w; el.fill.style.height = w + '%'; }
        const hot = rx[b] >= 0.5;
        if (hot !== el.hot) { el.hot = hot; el.btn.classList.toggle('hot', hot); }
        const sc = sensorConfig[b];
        const txv = Math.min(1, (sc.sig(player) || 0) * 0.5 / sc.threshold);
        const tw = Math.round(txv * 100);
        if (tw !== el.t && el.tx) { el.t = tw; el.tx.style.height = tw + '%'; }
        const txHi = txv >= 0.5;
        if (txHi !== el.txHi) { el.txHi = txHi; el.btn.classList.toggle('tx-hi', txHi); }
    }
    _updateExpoChip();
    // 副長
    const r = xoEvaluate();
    const key = r ? (r.tone + '|' + r.text + '|' + (r.act ? r.act.label : '')) : '';
    if (key !== _xoState) {
        _xoState = key;
        const bar = document.getElementById('xo-bar');
        const tx = document.getElementById('xo-text');
        const ab = document.getElementById('xo-act');
        if (bar) bar.className = 'xo-' + (r ? r.tone : 'idle');
        if (tx) { tx.textContent = r ? r.text : '—'; tx.title = r ? r.text : ''; }
        if (ab) ab.style.display = 'none'; // 第15弾: 副長は助言だけ。決断と操作はプレイヤーが行う
    }
    _xoAct = r && r.act ? r.act.fn : null;
    // 第16弾: 副長が方位を口にしている間は、自艦リング上のその方位を点灯し続ける
    if (r && r.text) { const _xm = /方位\s?(\d{1,3})°/.exec(r.text); if (_xm) ringMarkBearing(+_xm[1], r.tone === 'bad' ? '#ff8a7a' : '#ffe08a'); }
    // 射撃ボタン: 射撃解がある時だけ点灯し命中予測を出す
    const fb = document.getElementById('abar-fire');
    if (fb) {
        const te = bestFireTarget();
        let lbl = '射撃', on = false;
        if (te && !te._dying) {
            const lk = playerLockInfo(te);
            const w = currentWeapon();
            if (lk.full) { lbl = '射撃 視認'; on = true; }
            else if (lk.assumed) { const hc = assumedHitChance(te, w, lk); lbl = hc > 0 ? `射撃 ${Math.round(hc * 100)}%` : '射程外'; on = hc > 0; }
        }
        if (fb._lbl !== lbl) { fb._lbl = lbl; const l = document.getElementById('abar-fire-label'); if (l) l.textContent = lbl; }
        if (fb._on !== on) { fb._on = on; fb.classList.toggle('on', on); }
    }
    // 追跡ボタン: 追跡中の信号と解析度
    const tb = document.getElementById('abar-track');
    if (tb) {
        const sa = lockedSignalId ? _signalAnalysis[lockedSignalId] : null;
        // 第18弾: 2行に分けてボタン幅に収める (旧: 「SIG-01 方位16」がボタンからはみ出していた)
        const tl = sa ? 'SIG-' + String(_contactLabels[lockedSignalId] || '?').padStart(2, '0') + '\n' + identInfo(lockedSignalId).short + ' ' + (sa.fix ? _fmtR(trackEstimate(sa, 0).r) + (sa.motion ? '・動' : '') : '線' + (sa.obs ? sa.obs.length : 0)) : '追跡';
        if (tb._lbl !== tl) { tb._lbl = tl; const l = document.getElementById('abar-track-label'); if (l) l.textContent = tl; tb.classList.toggle('on', !!sa); }
    }
    const rc = document.getElementById('recenter-chip');
    if (rc) { const show = !cameraFollowPlayer && !mapMode; if (rc._show !== show) { rc._show = show; rc.style.display = show ? '' : 'none'; } }
    _updateCargoBadges();
}
// 第16弾: 搭載物ボタンの残数バッジ (×n=完成品 / 資材=組み立て可 / 秒=組み立て中 / 待機=完成・展開枠待ち / —=無し)
function _updateCargoBadges() {
    const a = cargo.asm;
    const key = JSON.stringify(cargo.stock) + '|' + cargo.mat + '|' + (a ? a.type + (a.ready ? 'R' : Math.ceil(a.t / 60)) : '');
    if (key === _hudCache.cargo) return;
    _hudCache.cargo = key;
    document.querySelectorAll('.drone-btn').forEach(b => {
        const t = b.dataset.dtype, spec = DRONE_SPEC[t], em = b.querySelector('.cg-n');
        if (!spec || !em) return;
        let txt, empty = false;
        if (a && a.type === t) txt = a.ready ? '待機' : Math.ceil(a.t / 60) + 's';
        else if ((cargo.stock[t] || 0) > 0) txt = '×' + cargo.stock[t];
        else if (cargo.mat >= spec.mat) txt = '資材';
        else { txt = '—'; empty = true; }
        em.textContent = txt;
        b.classList.toggle('cg-empty', empty);
    });
    const gtxt = (a ? (a.ready ? '待機' : '組' + Math.ceil(a.t / 60) + 's') : '資材' + cargo.mat);
    document.querySelectorAll('.abar-cargo').forEach(e => { e.textContent = gtxt; });
}
// 戦術ストリップの入力
(() => {
    document.querySelectorAll('.band-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); toggleBand(b.dataset.band); })); // 第21弾: ON/OFF
    const xa = document.getElementById('xo-act');
    if (xa) xa.addEventListener('click', (e) => { e.stopPropagation(); if (_xoAct) { const fn = _xoAct; _xoState = null; fn(); } });
    const rc = document.getElementById('recenter-chip');
    if (rc) rc.addEventListener('click', (e) => { e.stopPropagation(); cameraFollowPlayer = true; updateCameraFollowBtn(); centerCameraOnPlayer(); playSound('ui'); });
    // ログはコンパクト表示が既定。タップで展開/縮小
    const lp = document.getElementById('log-panel');
    if (lp) lp.addEventListener('click', () => { lp.classList.toggle('compact'); _uiInsetCache.t = 0; const ml = document.getElementById('message-log'); if (ml) ml.scrollTop = ml.scrollHeight; });
})();
// ═══ 第14弾: 横画面専用HUD — タッチ端末は出撃時に全画面+横向きロックを要求。縦持ちの間は進行を止める ═══
// (Android Chrome は全画面中のみ orientation.lock が効く。iOS Safari は非対応 → 回転を促すオーバーレイで代替)
function requestLandscape() {
    const lock = () => {
        try { const p = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 非対応 */ }
    };
    try {
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) {
            const p = el.requestFullscreen({ navigationUI: 'hide' });
            if (p && p.then) p.then(lock).catch(() => {}); else lock();
        } else lock();
    } catch (e) { /* 非対応 */ }
}
function toggleFullscreen() {
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    else requestLandscape();
}
const _portraitMQ = window.matchMedia('(orientation: portrait) and (pointer: coarse)');
function _syncOrientPause() {
    _orientPaused = _portraitMQ.matches && document.body.classList.contains('in-game');
}
if (_portraitMQ.addEventListener) _portraitMQ.addEventListener('change', _syncOrientPause);
else if (_portraitMQ.addListener) _portraitMQ.addListener(_syncOrientPause);
(() => {
    const b = document.getElementById('btn-rotate-fs');
    if (b) b.addEventListener('click', (e) => { e.stopPropagation(); requestLandscape(); });
})();

// キーボード (デスクトップ): F=射撃 T=追跡 1-4=帯域 S=出力(潜航/巡航/全速) Q=ソナー +/-=ズーム
window.addEventListener('keydown', (e) => {
    if (!player || player.hp <= 0) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === '+' || k === '=' || k === ';') { zoomStep(1.25); return; } // ズームは押しっぱなしでも続ける
    if (k === '-') { zoomStep(0.8); return; }
    if (e.repeat) return;
    if (k === 'f') issueFireOrder();
    else if (k === 't') trackNextSignal();
    else if (k === 's') cycleStance();
    else if (k === 'c') toggleCoast();   // 第17弾: 機関停止 (惰性)
    else if (k === 'b') useBoost();      // 第17弾: 緊急噴射
    else if (k === 'q') fireOmniSonar();
    else if (k >= '1' && k <= '4') toggleBand(BANDS[+k - 1]);
    else if (k === 'h') toggleDensityView(); // 第21弾: 濃度表示
});
function toggleFpsDisplay() {
    PERF_SHOW_FPS = !PERF_SHOW_FPS;
    localStorage.setItem('darkEchoFps', PERF_SHOW_FPS ? '1' : '0');
    const b = document.getElementById('mm-fps');
    if (b) b.textContent = 'FPS表示: ' + (PERF_SHOW_FPS ? 'ON' : 'OFF');
}

let _fpsLastTime = 0, _fpsFrameCount = 0, _fpsDisplay = 0;

// ═══ ゲームループ: ロジック(stepWorld) と描画(renderWorld) を分離 ═══
// 描画を伴わない高速シミュレーション(__simSteps)で数値バランスを検証できるようにするため。
let _hitStop = 0; // 奇襲命中時のヒットストップ (ロジックだけ数フレーム止めて描画は続ける)
function gameLoop() {
    try {
        if (_hitStop > 0) _hitStop--;
        else if (!gamePaused && !_orientPaused && !_draft) { // 第32弾: 部品を選んでいる間は止める
            // 第22弾: 倍速 = 1フレームにn回ロジックを進める。重くてフレームが詰まる時は打ち切る (固まらない)
            _speedAcc += gameSpeed;
            const t0 = performance.now();
            let n = 0;
            while (_speedAcc >= 1) {
                stepWorld(); _speedAcc -= 1; n++;
                if (n >= 1 && performance.now() - t0 > 24) { _speedAcc = 0; break; }
                if (!player || player.hp <= 0 || gamePaused) { _speedAcc = 0; break; }
            }
        }
        renderWorld();
    } catch (err) {
        console.error("Game loop error:", err);
        // エラー発生後もゲームループを継続する (一時的なエラーでフリーズしない)
    }
    requestAnimationFrame(gameLoop);
}
// 開発用: 描画なしでロジックだけ n フレーム進める (Playwrightでのバランス検証用)
window.__simSteps = function (n) {
    for (let i = 0; i < n; i++) {
        stepWorld();
        effects.length = 0; damagePuffs.length = 0; particles.length = 0; debris.length = 0;
    }
};

function stepWorld() {
        _frameCount++;
        updateEffectiveRadarRange();
        // ヒッグス自然成長 (Battle Royale的ゾーン圧縮 — 時間経過で濃度上昇)
        // 全ミスト密度を毎フレーム微増、最大0.95まで
        // 第21弾: マス目の濃さ全体に掛ける (旧: 円ごとの濃さを足していた。速さは旧と同じ ≈ 15分で+4%)
        if (player && player.hp > 0) higgsGrowth = Math.min(0.15, higgsGrowth + 0.0000008 * gameSpeedFactor);
        matchRecTick(); // 第22弾: 1秒ごとに位置を記録
        updateHiggsClears();

        // ソナークールダウン更新 — 表示は秒単位で変化する時のみ更新 (毎フレームinnerHTML禁止)
        if (omniSonarCooldown > 0) {
            omniSonarCooldown--;
            if (omniSonarCooldown % 60 === 0 || omniSonarCooldown === 0) {
                const btnOmni = document.getElementById('btn-scan');
                if (btnOmni) { // ラベルだけ更新 (旧: innerHTMLごと置換してSVGアイコンが消えていた)
                    const sp = btnOmni.querySelector('span');
                    if (sp) sp.textContent = omniSonarCooldown > 0 ? `${Math.ceil(omniSonarCooldown/60)}s` : 'SONAR';
                    btnOmni.disabled = omniSonarCooldown > 0;
                }
            }
        }
        if (dirSonarCooldown > 0) {
            dirSonarCooldown--;
            if (dirSonarCooldown % 60 === 0 || dirSonarCooldown === 0) {
                const btnDir = document.getElementById('btn-dir-sonar');
                if (btnDir) {
                    const sp = btnDir.querySelector('span');
                    if (sp) sp.textContent = dirSonarCooldown > 0 ? `${Math.ceil(dirSonarCooldown/60)}s` : 'DIR';
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
                // 表示位置を実位置へ寄せる (=目標の動きを追う推測航法)。確度が低いほど追随しない。
                // 追跡(解析)由来のコンタクトは解析サイクルで更新されるのでここでは動かさない。
                if (e.displayX !== undefined && !e.trackR) {
                    const k = 0.005 * e.contactAccuracy * e.contactAccuracy;
                    e.displayX += (e.x - e.displayX) * k;
                    e.displayY += (e.y - e.displayY) * k;
                } else if (e.trackR && !e.inVision) {
                    // 第18弾: 運動解のある追跡は、推定した針路と速さで推定位置を進める (解析のない時間も「今どこか」を示す)
                    const saM = _signalAnalysis[enemySid(e)];
                    if (saM && saM.motion) { const est = trackEstimate(saM, 0); e.displayX = est.x; e.displayY = est.y; e.trackR = est.r; e.contactAccuracy = Math.max(0.05, Math.min(0.95, 1 - est.r / 5000)); }
                }
            } else if (e.fireFlashTimer <= 0) {
                e.visible = false;
                e.contactAccuracy = 0;
                e.trackR = null;
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
                if (de._dying <= 0 && de._noReward) { enemies.splice(i, 1); continue; } // 燃料切れのファイターは静かに消える
                if (de._dying <= 0) {
                    // 母艦を失ったファイターは管制リンクが切れ、数秒で燃え尽きる
                    if (de.type === 'carrier') enemies.forEach(f => { if (f.type === 'fighter' && f.fuel !== undefined) f.fuel = Math.min(f.fuel, 240); });
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
                    matchRecEvent('killE', de.x, de.y, '敵艦撃沈');
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
            const allNodesHacked = colonyNodes.length > 0 && colonyNodes.every(s => s.owner === 'player');
            // 第23弾: S&D は敵が全コロニーを占有したら負け
            if (gameState.mode === 'sd' && colonyNodes.length > 0 && colonyNodes.every(s => s.owner === 'enemy') && player && player.hp > 0 && !player._defeat) {
                player._defeat = 'サーチ&デストロイ: 全コロニーを敵に占有された'; player.hp = 0;
            }
            const sdWin = gameState.mode === 'sd' && allNodesHacked;

            if (allEnemiesDown || sdWin) {
                sectorCleared = true;
                matchRecEvent('clear', player.x, player.y, allEnemiesDown ? 'セクター制圧 (敵艦撃沈)' : 'セクター制圧 (全コロニーをハック)');
                // 第23弾: スカーミッシュ — 勝敗が付いたら試合終了。作戦報告を出し、その上に試合の記録を開く (COM対戦も通常も)
                setTimeout(() => { if (!comDemo && typeof openDebrief === 'function') openDebrief(); openReplay(); }, 3500);
                const bonus = 100 + gameState.sector * 75 + (sdWin && !allEnemiesDown ? 50 : 0);
                gameState.credits += bonus;
                if (gameState.career) gameState.career.bestSector = Math.max(gameState.career.bestSector || 1, gameState.sector);
                updateTopUI();
                saveGame();
                showSectorClear(bonus);
                if (sdWin && !allEnemiesDown) {
                    logMessage(`MISSION: 全コロニーをハック。S&D目標達成。ボーナス: +${bonus} CR`, 'system-msg');
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
                    (document.getElementById('sd-progress-text').textContent = `コロニー: ${hackedCount}/${colonyNodes.length}`);
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
            // 第22弾: 自艦の撃沈 — 敵と同じく3秒の漂流・誘爆 → 最終爆発 → 原因を出してからゲームオーバー
            // (旧: その場で爆発して2.5秒後に終了画面。何にやられたか分からなかった)
            player.isDead = true;
            player._dying = 180;
            player._dvx = (player.x - (player.prevX ?? player.x)) * 0.7; player._dvy = (player.y - (player.prevY ?? player.y)) * 0.7;
            { const v = Math.hypot(player._dvx, player._dvy); if (v > 3) { player._dvx *= 3 / v; player._dvy *= 3 / v; } } // 漂流は最大3u/f
            const last = playerHitLog[playerHitLog.length - 1];
            player._deathCause = player._defeat || (last ? _hitText(last) : '原因不明');
            _hitStop = 18;
            createExplosion(player.x, player.y, '#ffaa44', 22);
            logMessage('CRITICAL: 被弾 — ' + player._deathCause + '。機関部誘爆、船体崩壊が始まる', 'system-msg');
            showDeathBanner(player._deathCause);
            { const f = document.getElementById('hud-hp-fill'), t = document.getElementById('hud-hp-text'); if (f) f.style.width = '0%'; if (t) t.textContent = '0%'; }
            if (typeof matchRecEvent === 'function') matchRecEvent('deathP', player.x, player.y, '自艦撃沈 — ' + player._deathCause);
            playSound('explosion');
        } else if (player && player._dying > 0) {
            player._dying--;
            player.x += player._dvx; player.y += player._dvy; player._dvx *= 0.985; player._dvy *= 0.985;
            player.angle += 0.004;
            if (player._dying % 28 === 0) { createExplosion(player.x + (Math.random() - 0.5) * 50, player.y + (Math.random() - 0.5) * 50, '#ff8844', 14); playSound('explosion'); }
            if (player._dying === 0) {
                createExplosion(player.x, player.y, '#00ffaa', 50);
                logMessage('CRITICAL: 船体崩壊。通信途絶...', 'system-msg');
                setTimeout(() => showGameOver(), 1800);
            }
        }
        enemies.forEach(e => e.update());
        updateDecoys();
        updateWakes();
        updatePlayerDrones();
        updateCargo();
        updateEscape(); // 第17弾: ノイズメーカー・煙幕・噴射
        updatePointDefense(); // 第28弾: 実弾でミサイルを迎撃
        updateLures();  // 第21弾: 囮
        updateFieldSignals(); updateSigZones(); // 第31弾: 自然/お宝の信号・監視網の円
        updateParts(); // 第32弾: 部品 (機雷・囮発射機・照準波・自機COMの付け替え)
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
            // §3-12 HEAT trail: エンジン熱排気 (移動時)
            if (!repairActive && player.heatSig > 0.07 && Math.random() < 0.22) {
                if (heatTrails.length < 600) heatTrails.push({ x: player.x, y: player.y, intensity: player.heatSig, life: 1.0, isPlayerTrail: true });
            }
        }
        // §3-12 EM trail: AI処理放射 — プレイヤー自身の紫粒子は削除済み

        // 第16弾: ノード制圧 / コロニーハック (近くに留まる)
        updateNodesAndColonies();
        updateEnemyColonyCapture(); updateColonyIntel(false); // 第23弾
        updateResupply(); // 第20弾

        // 構造物・ステーションの発見チェック (有視界距離内に入ると発見)
        if (player && player.hp > 0) {
            [...structures, ...stations].forEach(s => {
                if (!s.discovered && inPlayerVision(s.x, s.y)) { // 第21弾: 有視界の形 (視線) で
                    s.discovered = true;
                }
            });
        }

        // Docking Detection
        if (player && player.hp > 0 && !dockingOpen) {
            // 第23弾: 補給所は廃止 → 占有したコロニーでドック (改修・積み込み計画)。補充はコロニーの補給 (60秒に1回) で行う
            let nearStation = stations.find(s => Math.hypot(player.x - s.x, player.y - s.y) < s.radius + 50)
                || (!comDemo && structures.find(s => s.type === 'colony' && s.owner === 'player' && Math.hypot(player.x - s.x, player.y - s.y) < RESUPPLY_R));
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

        // パッシブ方位ウェッジの寿命 (旧: 描画関数内で減算していた → ロジックへ移動)
        for (let i = passiveBearings.length - 1; i >= 0; i--) {
            if (--passiveBearings[i].life <= 0) passiveBearings.splice(i, 1);
        }
        // 司令部情報: 実際の敵シグネチャを掴んだら役目を終えてフェードアウト
        if (intelBearing) {
            if (passiveBearings.some(b => /^e-/.test(b.sourceId))) intelBearing.life = Math.min(intelBearing.life, 600);
            if (--intelBearing.life <= 0) intelBearing = null;
        }
        // 第19弾: COM対戦デモ — 自機COMの判断と、双方の思考ログ
        updateFreeBeam(); // 第20弾: 座標射撃のビームのチャージ
        if (comDemo) { comPilotStep(); comEnemyThinkTick(); }
}

function renderWorld() {
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
        _tickZoomAnim();
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

        projectiles.forEach(p => { if (!p.isPlayer) p.draw(ctx); }); // 敵弾は霧の下 (視界の内側なら見える)
        if (!mapMode) { emitDamageSmoke(player); for (const e of enemies) emitDamageSmoke(e); } // 第21弾: 損傷の煙・火花
        if (_frameCount % 8 === 0) updateCombatBar(); // 第22弾
        updateDrawEffects(ctx);
        updateDrawDebrisParticles(ctx);

        // ── 有視界フォグ ──
        // マップモード中はフォグを抑制して全体を戦術マップとして表示(索敵済みの情報のみ可視)。
        if (player && (player.hp > 0 || player._dying > 0) && !mapMode) drawFogOfWar(ctx); // 第22弾: 撃沈の演出中も霧は残す
        if (player && player.hp > 0) drawDensityOverlay(ctx); // 第21弾: 霧の濃さと地形 (自艦の周り / ボタンで全マップ)

        // ── 第16弾: 「見えているもの」と「自分のもの」は霧の上に描く ──
        // 視界の内側の敵艦は100%の不透明度で (旧: 霧のグラデーションと雲の加算合成の下に描かれ半透明に見えた)。
        // 自分のミサイル・ドローン・デコイは霧の中でも位置が分かるように (自分が撃ったものの位置は知っている)。
        drawSmokeClouds(ctx); // 第17弾: 煙幕は艦影の下 (見えている敵を薄めない)
        enemies.forEach(e => e.draw(ctx));
        drawDecoys(ctx);
        drawPlayerDrones(ctx);
        projectiles.forEach(p => { if (p.isPlayer) p.draw(ctx); });
        drawNoiseMakers(ctx);
        drawLures(ctx); // 第21弾
        drawFieldSignals(ctx); // 第31弾
        drawMines(ctx); // 第32弾
        drawOwnOrdnanceMarkers(ctx);
        drawColonyIntel(ctx);
        if (player && (player.hp > 0 || player._dying > 0)) player.draw(ctx);
        drawDamagePuffs(ctx); // 第21弾: 損傷の煙・火花は艦影の上
        updateDrawBeams(ctx); // 第22弾: ビームは霧と艦影の上

        // ── ソナーエフェクト(波紋/充満/境界) — ヒッグスより手前に表示 ──
        updateDrawSonarEffects(ctx);

        // ── ランドマーク（ステーション・構造物・ヒッグスノード）— ヒッグスより手前に表示 ──
        // 未発見・未特定の構造物は非表示; 有視界発見(discovered)または信号特定(identified)時のみ表示
        stations.forEach(s => s.draw(ctx));
        structures.forEach(s => { if (s.discovered || s.identified) s.draw(ctx); });
        drawNodesAndColonies(ctx, _vpX, _vpY, _vpW, _vpH);

        // ── 特定済み地形効果 (熱雲帯/磁気嵐帯/ヒッグス高濃度域) — ヒッグスより手前に恒久マーカー ──
        drawIdentifiedTerrain(ctx, _vpX, _vpY, _vpW, _vpH);

        // ── センサー痕跡(ソナーの影/コンタクト) — ヒッグスより手前に表示 ──
        for (const e of enemies) e.drawSensorTrace(ctx);

        // ── シグネチャ・スレットリング (最前面・フォグの上) ──
        if (player && player.hp > 0) drawPassiveAntenna(ctx);

        // ── 武器射程 + 射角アーク: "実際にどこを撃てるか" (射角 kinetic±150/missile±45/beam±10) ──
        // 第15弾: 撃つ相手(推定位置/視認)が射程の1.5倍以内に居る時・射撃命令中だけ表示 (常時の同心円を減らす)
        const _arcTe = player && player.hp > 0 ? bestFireTarget() : null;
        const _arcShow = !!player && player.hp > 0 && (!!player._fireOrder || (_arcTe && Math.hypot((_arcTe.inVision ? _arcTe.x : _arcTe.displayX) - player.x, (_arcTe.inVision ? _arcTe.y : _arcTe.displayY) - player.y) < weaponRange(currentWeapon()) * 1.5));
        if (_arcShow) {
            const wType  = currentWeapon();
            const wRange = weaponRange(wType); // 発射判定と同じ射程 (第13弾: 旧表示1600/4400/16000は実射程と不一致だった)
            const wCol   = wType === 'missile' ? '#ffaa00' : (wType === 'beam' ? '#00aaff' : '#88ff44');
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
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        // ── パッシブ方位ウェッジ (ワールド空間・三角測量用) ──
        if (player && player.hp > 0) drawPassiveBearings(ctx);
        // §4-4: 三角測量精度円描画 (手動TRIボタンで実行した結果を表示)
        if (player && player.hp > 0) { drawTriangulationCircle(ctx); drawSigZones(ctx); }
        if (player && player.hp > 0) drawWeaponRange(ctx); // 第20弾: 今の兵装の射程 (霧の上)

        ctx.restore();

        drawHiggsMedium(ctx);
        drawHUDOverlay(ctx);
        if (_frameCount % 3 === 0) drawMinimap();
        if (_frameCount % 10 === 0) updateEnvInfo();
        if (_frameCount % 8 === 0) updateTacStrip();
        if (_frameCount % 20 === 0) updateLandmarkBanner();

        // FPS表示 (デバッグ用) — 左下コーナー・コンソール上方
        if (PERF_SHOW_FPS) {
            ctx.save();
            const _fpsColor = _fpsDisplay >= 50 ? '#00ff88' : (_fpsDisplay >= 30 ? '#ffaa00' : '#ff4444');
            const _fpsX = uiInsets().left + 8, _fpsY = uiInsets().top + 8; // フィールド左上 (左列/上帯に隠れない位置)
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(_fpsX - 2, _fpsY - 2, 58, 18);
            ctx.font = 'bold 11px monospace';
            ctx.fillStyle = _fpsColor;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`FPS: ${_fpsDisplay}`, _fpsX, _fpsY);
            ctx.restore();
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
    // 第16弾: 補給ステーションでは積み荷を計画どおりに補充する (資材・完成品)。第23弾: コロニーのドックは補充しない (補給は60秒に1回の方)
    if (stations.some(s => Math.hypot(player.x - s.x, player.y - s.y) < s.radius + 50)) {
        resetCargo();
        logMessage('補給: 積み荷を積み込み計画どおりに補充 — ' + cargoSummaryNow(), 'system-msg');
    }
    refreshLoadoutSummaries();
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
    if (sectorCleared && player && player.hp > 0) openDebrief(); // 作戦報告から来た場合は戻る
});

function getUpgradeCost(lv) { return lv * 300; } // Lv1→2: 300 SCR, Lv2→3: 600 SCR

function updateDockingUI() {
    document.getElementById('dock-credits').textContent = gameState.credits;

    const missingHp = player.maxHp - player.hp;
    const repairCost = Math.ceil(missingHp / 2);
    const btnRepair = document.getElementById('btn-repair-all');
    // 第26弾: 試合中の修理はリペアキットだけ (ドックの有料修理は使えない)
    btnRepair.textContent = '修理はリペアキットだけ';
    btnRepair.disabled = true;

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
function setGameSpeed(v) {
    gameSpeed = GAME_SPEEDS.indexOf(v) >= 0 ? v : 1; _speedAcc = 0;
    const lb = gameSpeed === 0.5 ? '0.5x' : gameSpeed + 'x';
    const sp = document.querySelector('#btn-game-speed span'); // ラベルだけ (旧: textContent で丸ごと置換しアイコンが消えていた)
    if (sp) sp.textContent = 'SPD:' + lb;
    const fx = document.getElementById('btn-speed-fixed'); // 第25弾: 画面端に常時表示する倍速ボタン
    if (fx) { fx.textContent = lb; fx.classList.toggle('on', gameSpeed !== 1); }
    logMessage('SYSTEM: ゲームスピード ' + lb + (gameSpeed > 1 ? ' (重い時は自動で抑える)' : ''), 'system-msg');
}
function cycleGameSpeed() { setGameSpeed(GAME_SPEEDS[(GAME_SPEEDS.indexOf(gameSpeed) + 1) % GAME_SPEEDS.length]); }
document.getElementById('btn-speed-fixed')?.addEventListener('click', cycleGameSpeed);
document.getElementById('btn-game-speed')?.addEventListener('click', () => {
    setGameSpeed(GAME_SPEEDS[(GAME_SPEEDS.indexOf(gameSpeed) + 1) % GAME_SPEEDS.length]); // 1→2→4→8→0.5→1
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

// ═══ 第13弾: 作戦報告 (セクター制圧後の帰投・補給) ═══
// 旧: 制圧後は「マップ外縁(最大35000u先)まで航行してワープ」しかなく、狩りの後に数分の空白があった。
// 1マッチ=1回の狩り として、戦闘詳報 → 補給・改修 → 次の狩りへ を1画面で回す。
let _debriefOpen = false;
function openDebrief() {
    if (!player) return;
    const st = huntStats || {};
    const fmt = (f) => { const s2 = Math.max(0, Math.round(f / 60)); return Math.floor(s2 / 60) + ':' + String(s2 % 60).padStart(2, '0'); };
    const rows = [
        ['作戦時間', fmt(_frameCount - (st.startFrame || 0))],
        ['初接触', st.firstContact >= 0 ? fmt(st.firstContact) : '—'],
        ['奇襲成功', st.ambushes || 0],
        ['システム破壊', st.crits || 0],
        ['射撃数', st.shots || 0],
        ['被捕捉', (st.timesEngaged || 0) + '回'],
        ['与ダメージ', st.dmgDealt || 0],
        ['被ダメージ', st.dmgTaken || 0],
        ['敵探信', (st.pings || 0) + '回'],
        ['艦体', Math.round(player.hp / player.maxHp * 100) + '%'],
    ];
    const rep = document.getElementById('db-report');
    if (rep) rep.innerHTML = rows.map(r => `<div><span>${r[0]}</span><b>${r[1]}</b></div>`).join('');
    const sec = document.getElementById('db-sector'); if (sec) sec.textContent = 'SECTOR ' + gameState.sector;
    const lead = document.getElementById('db-lead');
    if (lead) lead.textContent = (st.dmgTaken || 0) === 0 ? '無傷で敵艦を撃沈 — 完璧な狩りだ' : (st.ambushes ? '先に見つけ、先に撃った — セクター制圧' : '敵艦撃沈 — セクター制圧');
    document.getElementById('debrief-overlay')?.classList.remove('hidden');
    _debriefOpen = true;
    playSound('ui');
}
function _closeDebrief() { document.getElementById('debrief-overlay')?.classList.add('hidden'); _debriefOpen = false; }
document.getElementById('btn-db-next')?.addEventListener('click', () => {
    _closeDebrief();
    gameState.sector++;
    gameState.credits += 200; // 深宇宙への進出報酬 (旧ワープと同額)
    saveGame(); updateTopUI();
    generateSector();
    playSound('ui');
});
document.getElementById('btn-db-dock')?.addEventListener('click', () => {
    document.getElementById('debrief-overlay')?.classList.add('hidden');
    dockingOpen = true;
    document.getElementById('docking-menu')?.classList.remove('hidden');
    updateDockingUI();
    playSound('ui');
});

// ═══ 第13弾: 作戦要領 (初回出撃時・メニューから) — 表示中はゲームを止める ═══
let gamePaused = false;
function showBriefing(fromMenu) {
    document.getElementById('briefing-overlay')?.classList.remove('hidden');
    document.getElementById('mobile-menu-modal')?.classList.add('hidden');
    gamePaused = true;
}
document.getElementById('btn-brief-ok')?.addEventListener('click', () => {
    document.getElementById('briefing-overlay')?.classList.add('hidden');
    gamePaused = false;
    try { localStorage.setItem('darkEchoBriefed', '1'); } catch (e) {}
    playSound('ui');
});
(() => { const b = document.getElementById('mm-fps'); if (b) b.textContent = 'FPS表示: ' + (PERF_SHOW_FPS ? 'ON' : 'OFF'); })();
