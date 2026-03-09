// Init canvas

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');

let FIELD_SIZE = 50000;
let BASE_RADAR_RANGE = 600;
let RADAR_RANGE = BASE_RADAR_RANGE;
let effectiveRadarRange = BASE_RADAR_RANGE; // Actual range after Higgs interference
let sectorCleared = false;
let scanCooldown = 0; // Active scan cooldown (frames)
let enemiesKilled = 0; // Stat tracking

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
    shipType: 'assault', // 'assault' | 'stealth' | 'carrier'
    mode: 'br',          // 'br' (Battle Royale) | 'sd' (Search & Destroy)
    sector: 1,
    credits: 0,
    hasAds: true,
    upgrades: {
        hull: 0,      // +20% HP per level
        radar: 0,     // +15% range per level
        weapons: 0    // +10% dmg per level
    }
};

function loadGame() {
    const saved = localStorage.getItem('darkEchoSave');
    if (saved) {
        gameState = JSON.parse(saved);
        updateTopUI();
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
    document.getElementById('currency-display').textContent = `クレジット: ${gameState.credits} CR`;
    const isMobile = window.innerWidth <= 768;
    const adH = isMobile ? '28px' : '30px';
    if (!gameState.hasAds) {
        document.getElementById('ad-banner').style.display = 'none';
        document.getElementById('bottom-console').style.bottom = '0';
    } else {
        document.getElementById('ad-banner').style.display = 'flex';
        document.getElementById('bottom-console').style.bottom = adH;
    }
}
updateTopUI();

// Event Listeners for Game UI saving/ads
document.getElementById('btn-save').addEventListener('click', saveGame);
document.getElementById('btn-reset').addEventListener('click', () => {
    localStorage.removeItem('darkEchoSave');
    location.reload();
});
document.getElementById('btn-remove-ads').addEventListener('click', () => {
    if (gameState.credits >= 500) {
        gameState.credits -= 500;
        gameState.hasAds = false;
        saveGame();
        updateTopUI();
        logMessage('SYS: プレミアム機能がアンロックされました。(広告削除)', 'system-msg');
    } else {
        logMessage('SYS: 広告削除のためのクレジットが不足しています (500 CR 必要)。', 'warning-msg');
    }
});


// Core Entities
let player;
let gameLoopRunning = false;
let enemies = [];
let projectiles = [];
let structures = [];
let talosDrones = [];
let effects = [];
let particles = [];
let debris = [];
let bgStars = [];
let bgMist = [];
let scrapDrops = [];
let stations = [];
let higgsWakes = [];    // ヒッグスウェイク軌跡 {x, y, intensity, life}
let resourceNodes = []; // リソースノード {x, y, active, emFlashTimer}

// GEN配分 (ゼロサム: エンジン/武器/センサー/AI の合計=100)
let genAlloc = { engine: 30, weapons: 25, sensors: 25, ai: 20 };

// ============================================================
// ヒッグス粒子強度計算 (Higgs Intensity)
// ============================================================
function getHiggsIntensity(x, y) {
    let total = 0;
    bgMist.forEach(m => {
        const dist = Math.hypot(x - m.x, y - m.y);
        if (dist < m.r) {
            const falloff = 1 - (dist / m.r);
            total += falloff * (m.density || 0.3);
        }
    });
    return Math.min(1.0, total);
}

// ヒッグス濃度の高い隠れ場所を探す (ジエンド戦スタイルAI用)
function findHidingSpot(nearX, nearY, searchRadius) {
    let best = {
        x: Math.max(200, Math.min(FIELD_SIZE - 200, nearX + (Math.random() - 0.5) * searchRadius)),
        y: Math.max(200, Math.min(FIELD_SIZE - 200, nearY + (Math.random() - 0.5) * searchRadius))
    };
    let bestScore = 0;
    for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * searchRadius;
        const tx = Math.max(200, Math.min(FIELD_SIZE - 200, nearX + Math.cos(angle) * dist));
        const ty = Math.max(200, Math.min(FIELD_SIZE - 200, nearY + Math.sin(angle) * dist));
        const score = getHiggsIntensity(tx, ty);
        if (score > bestScore) { bestScore = score; best = { x: tx, y: ty }; }
    }
    return best;
}

// Resize
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

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
    const margin = 200;
    camera.x = Math.max(-margin, Math.min(camera.x, FIELD_SIZE + margin - (canvas.width || window.innerWidth) / camera.zoom));
    camera.y = Math.max(-margin, Math.min(camera.y, FIELD_SIZE + margin - (canvas.height || window.innerHeight) / camera.zoom));
}

function centerCameraOnPlayer() {
    if (!player) return;
    const cw = canvas.width || window.innerWidth;
    const ch = canvas.height || window.innerHeight;
    camera.x = player.x - (cw / 2) / camera.zoom;
    camera.y = player.y - (ch / 2) / camera.zoom;
    clampCamera();
}

// カメラ追従フラグ (自艦追従ON/OFF)
let cameraFollowPlayer = false;

function updateCameraFollowBtn() {
    const btn = document.getElementById('btn-camera-follow');
    if (!btn) return;
    if (cameraFollowPlayer) {
        btn.textContent = '追従 ON';
        btn.classList.add('active');
    } else {
        btn.textContent = '追従 OFF';
        btn.classList.remove('active');
    }
}

// Input Handling
canvas.addEventListener('mousedown', (e) => {
    if (!player) return; // ship not selected yet
    if (e.target.closest('#ui-layer') && !e.target.closest('#gameCanvas')) return; // Ignore clicks on UI
    if (e.button === 0) {
        const worldX = (e.clientX / camera.zoom) + camera.x;
        const worldY = (e.clientY / camera.zoom) + camera.y;

        // Find clicked enemy
        let clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < en.radius * 2);

        if (clickedEnemy) {
            player.targetEntity = clickedEnemy;
            createClickEffect(clickedEnemy.x, clickedEnemy.y, '#ff4d4d');
            logMessage(`TACTICAL: ターゲットをロック。射撃解を計算中...`, 'system-msg');
        } else {
            player.targetEntity = null;
            player.setTarget(worldX, worldY);
            createClickEffect(worldX, worldY, '#00ffaa');
            const dist = Math.hypot(worldX - player.x, worldY - player.y);
            // Speed is generator output / 100 * base speed. Base speed is very slow (1.5)
            const speedEst = Math.max(0.1, (genAlloc.engine / 100) * 3.0);
            const timeSeconds = Math.max(1, Math.floor(dist / (speedEst * 60)));
            logMessage(`NAV: 進路設定完了。到着予定時間はおよそ ${timeSeconds} 秒です。`, 'system-msg');
        }
    } else if (e.button === 2) {
        camera.isDragging = true;
        camera.lastX = e.clientX;
        camera.lastY = e.clientY;
    }
});
window.addEventListener('mouseup', e => { if (e.button === 2) camera.isDragging = false; });
window.addEventListener('mousemove', e => {
    if (camera.isDragging) {
        camera.x -= (e.clientX - camera.lastX) / camera.zoom;
        camera.y -= (e.clientY - camera.lastY) / camera.zoom;
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
    const mx_b = (e.clientX / camera.zoom) + camera.x;
    const my_b = (e.clientY / camera.zoom) + camera.y;
    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * zoomAmount));
    camera.x += mx_b - ((e.clientX / camera.zoom) + camera.x);
    camera.y += my_b - ((e.clientY / camera.zoom) + camera.y);
    clampCamera();
}, { passive: false });
canvas.addEventListener('contextmenu', e => { if (e.target.id === 'gameCanvas') e.preventDefault() });

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
    isPinching: false
};

const TOUCH_WAYPOINT_DELAY = 250;  // 長押し判定: 250ms
const TOUCH_MOVE_THRESHOLD = 12;   // 長押し中の最大許容移動距離 (px)

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
        // 1本指ドラッグ = 即時カメラパン
        camera.isDragging = true;
        camera.lastX = t.clientX;
        camera.lastY = t.clientY;

        // 長押し検出: 250ms後にウェイポイント指定
        clearTimeout(touch.waypointTimer);
        touch.waypointTimer = setTimeout(() => {
            if (!touch.isPinching && !touch.moved && player) {
                const worldX = (touch.startX / camera.zoom) + camera.x;
                const worldY = (touch.startY / camera.zoom) + camera.y;
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
            // 動いた場合は長押しウェイポイントをキャンセル
            clearTimeout(touch.waypointTimer);
        }
        // 1本指ドラッグ = カメラパン (常時)
        camera.x -= (t.clientX - touch.lastX) / camera.zoom;
        camera.y -= (t.clientY - touch.lastY) / camera.zoom;
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
        const mx_b = (cx / camera.zoom) + camera.x;
        const my_b = (cy / camera.zoom) + camera.y;
        camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * zoomAmount));
        camera.x += mx_b - ((cx / camera.zoom) + camera.x);
        camera.y += my_b - ((cy / camera.zoom) + camera.y);
        touch.pinchDist = newDist;
        clampCamera();
    }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    clearTimeout(touch.waypointTimer);
    camera.isDragging = false;
    const elapsed = Date.now() - touch.startTime;

    // 短いタップ (移動なし, 250ms未満) → 敵の上なら ターゲットロック
    if (!touch.moved && !touch.waypointFired && !touch.isPinching && elapsed < TOUCH_WAYPOINT_DELAY && player) {
        const worldX = (touch.startX / camera.zoom) + camera.x;
        const worldY = (touch.startY / camera.zoom) + camera.y;
        // タッチはロックオン判定を広く取る（指で画面を押すと視認が難しいため）
        const tapRadius = en => en.radius * 6 + 20;
        let clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < tapRadius(en));
        if (clickedEnemy) {
            player.targetEntity = clickedEnemy;
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
        this.color = type === 'colony' ? 'rgba(34, 68, 170, 0.5)' : 'rgba(85, 85, 85, 0.5)';
    }
    draw(ctx) {
        const t = Date.now();
        const hColor = this.hacked ? '#00aaff' : null;

        if (this.type === 'colony') {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.strokeStyle = hColor || 'rgba(60,100,220,0.9)';
            ctx.fillStyle = hColor ? 'rgba(0,100,200,0.25)' : 'rgba(34,68,170,0.25)';
            ctx.lineWidth = 2;
            ctx.shadowColor = hColor || '#2244aa'; ctx.shadowBlur = 10;
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
                ctx.shadowBlur = 6;
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
            ctx.strokeStyle = hColor || 'rgba(140,115,80,0.9)';
            ctx.fillStyle = hColor ? 'rgba(0,100,200,0.2)' : 'rgba(70,60,45,0.55)';
            ctx.lineWidth = 2;
            ctx.shadowColor = hColor || '#554433'; ctx.shadowBlur = 6;
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
            ctx.lineWidth = 1; ctx.stroke();
        }
    }
}

class Station {
    constructor(x, y) {
        this.x = x; this.y = y;
        this.radius = 120;
        this.angle = 0;
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

        // Label
        ctx.fillStyle = '#4da6ff';
        ctx.font = 'bold 16px Orbitron';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 10; ctx.shadowColor = '#4da6ff';
        ctx.fillText("中立補給ステーション", this.x, this.y - 130);
        ctx.shadowBlur = 0;
    }
}

class Projectile {
    constructor(x, y, target, isPlayer, type) {
        this.x = x; this.y = y; this.isPlayer = isPlayer; this.type = type;
        this.target = target;
        this.active = true;
        this.distTraveled = 0;

        if (type === 'kinetic') {
            this.speed = 12; this.maxDist = 800; this.dmg = 15;
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'missile') {
            this.speed = 6; this.maxDist = 1500; this.dmg = 50;
            this.angle = Math.atan2(target.y - y, target.x - x);
        } else if (type === 'beam') {
            this.active = false;
            if (target && target.hp > 0) {
                const dmgMult = this.isPlayer ? (1 + (gameState.upgrades.weapons * 0.15)) : 1;
                // ヒッグス高濃度エリアではビームダメージ大幅低下 (設計確定仕様)
                const higgsBetween = getHiggsIntensity((x + target.x) / 2, (y + target.y) / 2);
                const higgsBeamPenalty = 1 - higgsBetween * 0.8; // 最大80%ダメージ減衰
                target.hp -= 150 * dmgMult * higgsBeamPenalty;
                createHitEffect(target.x, target.y, isPlayer ? '#00ffaa' : '#ff4d4d');
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
                }
            }
        }
    }
    update() {
        if (!this.active) return;

        if (this.type === 'missile' && this.target && this.target.hp > 0) {
            const targetAngle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
            let diff = targetAngle - this.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.angle += diff * 0.05;
        }

        this.x += Math.cos(this.angle) * this.speed;
        this.y += Math.sin(this.angle) * this.speed;
        this.distTraveled += this.speed;
        if (this.distTraveled > this.maxDist) this.active = false;

        const hitTarget = this.isPlayer ? enemies.find(e => Math.hypot(e.x - this.x, e.y - this.y) < e.radius * 1.5) : (Math.hypot(player.x - this.x, player.y - this.y) < player.radius * 1.5 ? player : null);

        if (hitTarget && hitTarget.hp > 0) {
            let dmgMult = this.isPlayer ? (1 + (gameState.upgrades.weapons * 0.15)) : 1;
            let preemptive = false;
            // 先制攻撃ボーナス: 2x damage on unaware enemies
            if (this.isPlayer && hitTarget.detectionState === 'unaware') {
                dmgMult *= 2.0;
                preemptive = true;
                hitTarget.detectionState = 'alerted'; // Now they know!
                hitTarget.isAggro = true; hitTarget.aggroTimer = 600;
            }
            if (!this.isPlayer) hitTarget.detectionState = 'alerted'; // Being hit alerts player too (no-op but consistent)
            hitTarget.hp -= this.dmg * dmgMult;
            this.active = false;
            createHitEffect(this.x, this.y, this.isPlayer ? '#ffaa00' : '#ff4d4d');
            addShake((this.dmg * dmgMult) / 10);
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
            const c = this.isPlayer ? '#00ffaa' : '#ff4d4d';
            ctx.shadowColor = c; ctx.shadowBlur = 5;
            ctx.fillStyle = c;
            ctx.beginPath();
            ctx.moveTo(7, 0);
            ctx.lineTo(0, -1.5); ctx.lineTo(-5, -1);
            ctx.lineTo(-5, 1); ctx.lineTo(0, 1.5);
            ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0;
        } else if (this.type === 'missile') {
            // Body
            ctx.fillStyle = '#ddd';
            ctx.beginPath();
            ctx.moveTo(8, 0);
            ctx.lineTo(2, -2.5); ctx.lineTo(-5, -2.5);
            ctx.lineTo(-6, -1.5); ctx.lineTo(-6, 1.5);
            ctx.lineTo(-5, 2.5); ctx.lineTo(2, 2.5);
            ctx.closePath(); ctx.fill();
            // Fins
            ctx.fillStyle = '#999';
            ctx.beginPath();
            ctx.moveTo(-3, -2.5); ctx.lineTo(-7, -5); ctx.lineTo(-6, -2.5);
            ctx.closePath(); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(-3, 2.5); ctx.lineTo(-7, 5); ctx.lineTo(-6, 2.5);
            ctx.closePath(); ctx.fill();
            // Exhaust
            ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 8;
            ctx.fillStyle = '#ff9900';
            ctx.beginPath();
            ctx.moveTo(-6, -1.2); ctx.lineTo(-12, 0); ctx.lineTo(-6, 1.2);
            ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0;
        }
        ctx.restore();
    }
}

class TalosDrone {
    constructor(x, y) {
        this.x = x; this.y = y;
        this.angle = 0;
        this.fireCooldown = 0;
        this.radius = 4;
    }
    update() {
        if (this.fireCooldown > 0) this.fireCooldown--;

        // Find closest enemy
        let closest = null; let cDist = 600;
        enemies.forEach(e => {
            const d = Math.hypot(e.x - this.x, e.y - this.y);
            if (d < cDist && e.hp > 0) { cDist = d; closest = e; }
        });

        if (closest) {
            // Attack run
            const targetAngle = Math.atan2(closest.y - this.y, closest.x - this.x);
            let diff = targetAngle - this.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.angle += diff * 0.1;

            if (cDist > 150) {
                this.x += Math.cos(this.angle) * 4;
                this.y += Math.sin(this.angle) * 4;
            } else {
                this.x += Math.cos(this.angle + Math.PI / 2) * 3; // Strafe
                this.y += Math.sin(this.angle + Math.PI / 2) * 3;
            }
            if (this.fireCooldown <= 0) {
                projectiles.push(new Projectile(this.x, this.y, closest, true, 'kinetic'));
                this.fireCooldown = 20;
            }
        } else {
            // Idle orbit player
            const dx = player.x - this.x;
            const dy = player.y - this.y;
            if (Math.hypot(dx, dy) > 150) {
                this.angle = Math.atan2(dy, dx);
                this.x += Math.cos(this.angle) * 3;
                this.y += Math.sin(this.angle) * 3;
            } else {
                this.angle += 0.05;
                this.x = player.x + Math.cos(this.angle) * 100;
                this.y = player.y + Math.sin(this.angle) * 100;
            }
        }
    }
    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        const spinAngle = this.angle + Date.now() * 0.002;
        ctx.rotate(spinAngle);
        const r = this.radius * 2.8;
        // Diamond outline
        ctx.shadowColor = '#4da6ff'; ctx.shadowBlur = 8;
        ctx.strokeStyle = '#4da6ff'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(r, 0); ctx.lineTo(0, -r); ctx.lineTo(-r, 0); ctx.lineTo(0, r);
        ctx.closePath(); ctx.stroke();
        // Glowing core
        ctx.fillStyle = '#4da6ff';
        ctx.beginPath(); ctx.arc(0, 0, this.radius * 0.9, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.restore();
    }
}

const WEAPON_COOLDOWNS = { kinetic: 15, missile: 100, beam: 200 };

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
            // 艦種別スタッツ
            const hpBase = { assault: 3500, stealth: 700, carrier: 2500 };
            this.radius = 20;
            this.maxHp = (hpBase[gameState.shipType] || 2000) * (1 + (gameState.upgrades.hull * 0.25));
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
        // マルチセンサーシグネチャ
        this.heatSig = 0;    // 熱源シグネチャ: 移動中に上昇
        this.opticalSig = 0; // 光学シグネチャ: 発砲フラッシュ・低ヒッグス時
        this.emSig = 0;      // 電磁波シグネチャ: 潜伏中の受動放射・発砲時スパイク
        this.higgsSig = 0;   // ヒッグスシグネチャ: ヒッグス雲内での乱流・ウェイク
        this.prevX = x;      // 移動量計算用
        this.prevY = y;
    }

    setTarget(tx, ty) { this.targetX = tx; this.targetY = ty; this.state = 'moving'; }

    update() {
        if (this.hp <= 0) return;
        if (this.fireCooldown > 0) this.fireCooldown--;

        if (this.isPlayer) {
            // Speed defined by GEN engine allocation + 艦種補正 + ヒッグス減速
            const speedMult = { assault: 0.8, stealth: 1.4, carrier: 0.6 };
            const higgsSlowdown = 1 - getHiggsIntensity(this.x, this.y) * 0.45; // 高濃度で最大45%減速
            this.speed = (genAlloc.engine / 100) * 3.0 * (speedMult[gameState.shipType] || 1.0) * higgsSlowdown;

            // Boundary detection for Sector Transition Dialog
            if ((this.x < 100 || this.x > FIELD_SIZE - 100 || this.y < 100 || this.y > FIELD_SIZE - 100) && !dialogOpen) {
                showDialog();
            }

            // Attacking logic
            if (this.targetEntity && this.targetEntity.hp > 0) {
                const dist = Math.hypot(this.targetEntity.x - this.x, this.targetEntity.y - this.y);
                const wType = document.getElementById('weapon-select').value;
                const wRange = wType === 'missile' ? 1300 : (wType === 'beam' ? 800 : 500);

                let targetAngle = Math.atan2(this.targetEntity.y - this.y, this.targetEntity.x - this.x);
                let diff = targetAngle - this.angle;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                this.angle += diff * 0.03; // Heavy slow turn

                if (dist > wRange * 0.8) {
                    this.x += Math.cos(this.angle) * this.speed;
                    this.y += Math.sin(this.angle) * this.speed;
                }

                if (dist < wRange && this.fireCooldown <= 0) {
                    this.weaponType = wType;
                    projectiles.push(new Projectile(this.x, this.y, this.targetEntity, true, wType));
                    // 攻撃型特殊: 3連装同時発射 (kinetic時のみ)
                    if (gameState.shipType === 'assault' && wType === 'kinetic') {
                        const spread = 0.12;
                        const baseAngle = Math.atan2(this.targetEntity.y - this.y, this.targetEntity.x - this.x);
                        [-spread, spread].forEach(offset => {
                            const p = new Projectile(this.x, this.y, this.targetEntity, true, 'kinetic');
                            p.angle = baseAngle + offset;
                            projectiles.push(p);
                        });
                    }
                    playSound('shoot');
                    this.fireCooldown = WEAPON_COOLDOWNS[wType];
                }
            } else if (this.state === 'moving') {
                const dist = Math.hypot(this.targetX - this.x, this.targetY - this.y);
                if (dist > this.speed) {
                    this.x += ((this.targetX - this.x) / dist) * this.speed;
                    this.y += ((this.targetY - this.y) / dist) * this.speed;
                    const ta = Math.atan2(this.targetY - this.y, this.targetX - this.x);
                    let diff = ta - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.angle += diff * 0.02; // slow turn
                } else this.state = 'idle';
            }

            // UI
            const hpP = Math.max(0, (this.hp / this.maxHp) * 100);
            document.querySelector('.hp-fill').style.width = hpP + '%';
            document.querySelector('.hp-fill').style.backgroundColor = hpP < 30 ? '#ff4d4d' : '#00ffaa';
            document.querySelector('.status-text').textContent = `船体耐久度: ${Math.floor(hpP)}%`;
            document.getElementById('hostile-count').textContent = enemies.filter(e => e.visible).length || '不明';

        } else {
            // ============================================================
            // 敵AI — ジエンド戦スタイル (一対一・潜伏・発砲後再配置)
            // ============================================================

            // 発砲フラッシュタイマー更新 (発砲直後だけ可視になる)
            if (this.fireFlashTimer > 0) {
                this.fireFlashTimer--;
                this.visible = true;
            } else if (this.detectionState !== 'alerted' || this.lurking) {
                // 潜伏中は通常の可視判定に委ねる (drawRadarSweepが制御)
            }

            // 被弾したら即時探知状態へ (先制攻撃されても反応する)
            if (this.hp < this.prevHp) {
                this.detectionState = 'alerted';
                this.lurking = false;
            }
            this.prevHp = this.hp;

            // ハッキング済み構造物への誘引 (EW対策)
            let decoyTarget = null;
            structures.forEach(s => {
                if (s.hacked) {
                    const d = Math.hypot(this.x - s.x, this.y - s.y);
                    if (d < RADAR_RANGE * 5) decoyTarget = s;
                }
            });
            if (decoyTarget) {
                // 囮に釣られている
                const dDist = Math.hypot(decoyTarget.x - this.x, decoyTarget.y - this.y);
                if (dDist > 200) {
                    const ta = Math.atan2(decoyTarget.y - this.y, decoyTarget.x - this.x);
                    let diff = ta - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.angle += diff * 0.05;
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
                        this.angle += diff * 0.04;
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
            // 自艦探知チェック — ヒッグスで探知範囲が変動
            // ──────────────────────────────────────
            const distToPlayer = Math.hypot(player.x - this.x, player.y - this.y);
            const higgsHereDetect = getHiggsIntensity(this.x, this.y);
            // EM ∝ AI配分: プレイヤーのAI配分が高いほどEM放射増→敵に探知されやすい (設計確定仕様)
            const playerEmBoost = 0.5 + (genAlloc.ai / 100) * 0.5; // AI=0%→0.5x, AI=100%→1.0x
            const myDetectRange = 800 * (1 - higgsHereDetect * 0.55) * (1 + gameState.sector * 0.05) * playerEmBoost;

            if (this.detectionState === 'unaware') {
                if (distToPlayer < myDetectRange) {
                    this.detectionTimer++;
                    if (this.detectionTimer > 80) {
                        this.detectionState = 'alerted';
                        this.lurking = false;
                        if (!this.alertLogged) {
                            this.alertLogged = true;
                            logMessage('WARN: 敵艦があなたを探知した！迎撃態勢に入ります。', 'warning-msg');
                        }
                    }
                } else {
                    this.detectionTimer = Math.max(0, this.detectionTimer - 1);
                }
            }

            // ──────────────────────────────────────
            // 潜伏モード — ヒッグス濃度の高い場所を探す
            // ──────────────────────────────────────
            if (this.lurking || this.detectionState === 'unaware') {
                this.speed = 0.07; // 極低速 (熱源シグネチャを検知閾値以下に抑える)
                if (this.state === 'idle' && Math.random() < 0.004) {
                    const hideSpot = findHidingSpot(this.x, this.y, 2000);
                    this.setTarget(hideSpot.x, hideSpot.y);
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
                        this.angle += diff * 0.02;
                    } else this.state = 'idle';
                }

            // ──────────────────────────────────────
            // 戦闘モード — 射程に入ったら発砲、即再配置
            // ──────────────────────────────────────
            } else if (this.detectionState === 'alerted') {
                const fireRange = 650 + gameState.sector * 20; // セクターが深いほど長射程
                this.speed = 0.7;

                if (distToPlayer < fireRange && this.fireCooldown <= 0) {
                    // 発砲！
                    const wType = gameState.sector <= 2 ? 'kinetic' : (gameState.sector <= 4 ? 'missile' : 'beam');
                    this.weaponType = wType;
                    projectiles.push(new Projectile(this.x, this.y, player, false, wType));
                    playSound('shoot');
                    this.fireCooldown = 180;

                    // 発砲フラッシュ — 約2秒間、位置が露わになる
                    this.fireFlashTimer = 120;
                    this.visible = true;
                    const sigLabel = { kinetic: '銃口炎[光学]', missile: '推進炎[熱源+EM]', beam: 'EMパルス[EM+光学]' };
                    effects.push({ x: this.x, y: this.y, r: 0, maxR: 200, a: 0.9, c: '#ff4d4d', type: 'circle' });
                    logMessage(`WARNING: 敵艦発砲検知 — ${sigLabel[wType] || '不明'}シグネチャ捕捉。`, 'warning-msg');

                    // 発砲後すぐに再配置開始
                    this.postFireCooldown = 300;

                } else if (distToPlayer > fireRange * 0.7) {
                    // 射程に入るまで慎重に接近
                    const ta = Math.atan2(player.y - this.y, player.x - this.x);
                    let diff = ta - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.angle += diff * 0.04;
                    this.x += Math.cos(this.angle) * this.speed;
                    this.y += Math.sin(this.angle) * this.speed;
                }
                // 射程内に入った後はじっと待って次の射撃機会を伺う
            }
        }

        // Exhaust particle logic
        if (this.state === 'moving' || (this.targetEntity && Math.hypot(this.targetEntity.x - this.x, this.targetEntity.y - this.y) > 200)) {
            if (Math.random() < 0.5) {
                const exX = this.x - Math.cos(this.angle) * this.radius;
                const exY = this.y - Math.sin(this.angle) * this.radius;
                particles.push({
                    x: exX + (Math.random() - 0.5) * 10, y: exY + (Math.random() - 0.5) * 10,
                    vx: -Math.cos(this.angle) * (1 + Math.random()), vy: -Math.sin(this.angle) * (1 + Math.random()),
                    life: 1.0, decay: 0.05,
                    color: this.isPlayer ? '#00ffaa' : '#ffaa00'
                });
            }
        }

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
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // 発砲フラッシュ中は全不透明
        const isFlashing = !this.isPlayer && this.fireFlashTimer > 0;
        if (isFlashing) ctx.globalAlpha = 1.0;

        if (this.isPlayer) {
            const r = this.radius;
            // Engine glow at rear
            const eng = ctx.createRadialGradient(-r * 0.7, 0, 0, -r * 0.7, 0, r * 0.9);
            eng.addColorStop(0, 'rgba(0,255,170,0.55)');
            eng.addColorStop(1, 'rgba(0,255,170,0)');
            ctx.fillStyle = eng;
            ctx.beginPath(); ctx.arc(-r * 0.7, 0, r * 0.9, 0, Math.PI * 2); ctx.fill();

            ctx.shadowColor = '#00ffaa'; ctx.shadowBlur = 15;
            ctx.fillStyle = '#00ffaa';
            // Main hull
            ctx.beginPath();
            ctx.moveTo(r * 1.1, 0);
            ctx.lineTo(r * 0.25, -r * 0.35);
            ctx.lineTo(-r * 0.5, -r * 0.28);
            ctx.lineTo(-r * 0.85, 0);
            ctx.lineTo(-r * 0.5, r * 0.28);
            ctx.lineTo(r * 0.25, r * 0.35);
            ctx.closePath(); ctx.fill();
            // Top wing
            ctx.beginPath();
            ctx.moveTo(r * 0.1, -r * 0.35);
            ctx.lineTo(-r * 0.25, -r * 1.05);
            ctx.lineTo(-r * 0.6, -r * 0.75);
            ctx.lineTo(-r * 0.5, -r * 0.28);
            ctx.closePath(); ctx.fill();
            // Bottom wing
            ctx.beginPath();
            ctx.moveTo(r * 0.1, r * 0.35);
            ctx.lineTo(-r * 0.25, r * 1.05);
            ctx.lineTo(-r * 0.6, r * 0.75);
            ctx.lineTo(-r * 0.5, r * 0.28);
            ctx.closePath(); ctx.fill();
            // Cockpit tinted glass
            ctx.fillStyle = 'rgba(0,80,60,0.85)';
            ctx.strokeStyle = '#00ffaa'; ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(r * 0.75, 0);
            ctx.lineTo(r * 0.2, -r * 0.22);
            ctx.lineTo(-r * 0.1, 0);
            ctx.lineTo(r * 0.2, r * 0.22);
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.shadowBlur = 0;
        } else {
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
            ctx.beginPath(); ctx.arc(0, 0, this.radius * 1.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,255,170,0.4)'; ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-40, 0); ctx.lineTo(-20, 0);
            ctx.moveTo(40, 0); ctx.lineTo(20, 0);
            ctx.moveTo(0, -40); ctx.lineTo(0, -20);
            ctx.moveTo(0, 40); ctx.lineTo(0, 20);
            ctx.strokeStyle = 'rgba(0,255,170,0.8)'; ctx.stroke();
        }
        ctx.restore();
        ctx.globalAlpha = 1;

        if (!this.isPlayer && this.visible) {
            // HP バー
            ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(this.x - 15, this.y - 28, 30, 4);
            ctx.fillStyle = this.hp / this.maxHp < 0.3 ? '#ff8800' : '#ff4d4d';
            ctx.fillRect(this.x - 15, this.y - 28, 30 * (this.hp / this.maxHp), 4);
            // 敵艦名表示 (発砲フラッシュ中のみ)
            if (isFlashing) {
                ctx.fillStyle = '#ff8888';
                ctx.font = 'bold 11px Orbitron';
                ctx.textAlign = 'center';
                ctx.shadowColor = '#ff4d4d'; ctx.shadowBlur = 6;
                ctx.fillText(`HOSTILE [${gameState.sector}]`, this.x, this.y - 35);
                ctx.shadowBlur = 0;
            }
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
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
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
            ctx.shadowColor = ef.c; ctx.shadowBlur = 8;
            ctx.textAlign = 'center';
            ctx.fillText(ef.text, ef.x, ef.y);
            ctx.shadowBlur = 0;
            ctx.restore();
            ctx.globalAlpha = 1;
            if (ef.life <= 0) effects.splice(i, 1);
        } else if (ef.type === 'beam') {
            ef.a -= 0.05;
            ctx.beginPath(); ctx.moveTo(ef.x, ef.y); ctx.lineTo(ef.tx, ef.ty);
            ctx.strokeStyle = ef.c; ctx.lineWidth = 4 * ef.a; ctx.stroke();
            if (ef.a <= 0) effects.splice(i, 1);
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
    const msg = document.createElement('div');
    msg.className = `message ${className}`; msg.textContent = text;
    log.appendChild(msg);
    if (log.children.length > 5) log.removeChild(log.firstChild);
    setTimeout(() => { if (msg.parentNode) msg.parentNode.removeChild(msg); }, 7000);
}

// Generate Sector
let higgsGrowthFrame = 0; // ヒッグス自然成長フレームカウンタ

function generateSector() {
    sectorCleared = false;
    enemiesKilled = 0;
    scanCooldown = 0;
    higgsGrowthFrame = 0;
    // Keep drones if transitioning, but set position
    const tCount = talosDrones.length;
    player = new Ship(FIELD_SIZE / 2, FIELD_SIZE / 2, true);
    player.generatorOutput = genAlloc.engine;
    enemies = []; structures = []; projectiles = []; effects = []; talosDrones = []; particles = []; debris = []; scrapDrops = [];
    stations = []; higgsWakes = []; resourceNodes = [];

    // Apply Upgrades to Stats
    RADAR_RANGE = BASE_RADAR_RANGE * (1 + (gameState.upgrades.radar * 0.2));

    // Environmental Background
    bgStars = [];
    const starColors = ['#ffffff','#ffffff','#ccddff','#ffeecc','#aabbff','#ffd8aa'];
    for (let i = 0; i < 3000; i++) {
        const layer = i < 1500 ? 0 : (i < 2400 ? 1 : 2); // 1500 far, 900 mid, 600 near
        const sizes  = [0.5, 1.1, 2.2];
        const alphas = [0.18, 0.45, 0.85];
        bgStars.push({
            x: Math.random() * FIELD_SIZE * 2.5,
            y: Math.random() * FIELD_SIZE * 2.5,
            size:  sizes[layer]  + Math.random() * sizes[layer],
            alpha: alphas[layer] * (0.6 + Math.random() * 0.4),
            color: starColors[Math.floor(Math.random() * starColors.length)],
            twinkle: Math.random() * Math.PI * 2,
            layer
        });
    }
    bgMist = [];
    const mistColors = ['50,20,110','20,50,110','90,20,50','10,65,85','55,35,10','15,80,60'];
    for (let i = 0; i < 80; i++) {
        const density = Math.random() * 0.65 + 0.1;
        bgMist.push({
            x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE,
            r: Math.random() * 4000 + 1500,
            // 高密度ゾーンは色を固定しない (drawBackground側で青緑に上書き)
            color: mistColors[Math.floor(Math.random() * mistColors.length)],
            density
        });
    }

    for (let i = 0; i < tCount; i++) talosDrones.push(new TalosDrone(player.x, player.y));

    // ===== ジエンド戦スタイル: 1セクター = 敵1機 =====
    // 敵をヒッグス濃度の高い場所に配置 (プレイヤーから遠い位置)
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist = 15000 + Math.random() * 10000; // 15000-25000u離れた場所 (50000マップ対応)
    const spawnCenterX = FIELD_SIZE / 2 + Math.cos(spawnAngle) * spawnDist * 0.5;
    const spawnCenterY = FIELD_SIZE / 2 + Math.sin(spawnAngle) * spawnDist * 0.5;
    const bossSpawn = findHidingSpot(
        Math.max(500, Math.min(FIELD_SIZE - 500, spawnCenterX)),
        Math.max(500, Math.min(FIELD_SIZE - 500, spawnCenterY)),
        1500
    );
    const boss = new Ship(bossSpawn.x, bossSpawn.y, false, 'destroyer');
    // セクターが深いほど高HP・高速化
    boss.maxHp = 500 + gameState.sector * 200;
    boss.hp = boss.maxHp;
    boss.lurking = true;
    enemies.push(boss);
    // S&Dモード: コロニーノードを多く配置 (ハック目標)
    const colonyCount = gameState.mode === 'sd' ? 5 : 3;
    for (let i = 0; i < colonyCount; i++) {
        structures.push(new Structure(
            Math.random() * (FIELD_SIZE - 2000) + 1000,
            Math.random() * (FIELD_SIZE - 2000) + 1000,
            'colony'
        ));
    }
    // 難破船 (デコイ・ハック・ルート用)
    for (let i = 0; i < 5; i++) {
        structures.push(new Structure(Math.random() * FIELD_SIZE, Math.random() * FIELD_SIZE, 'derelict'));
    }
    for (let i = 0; i < 3; i++) {
        stations.push(new Station(Math.random() * (FIELD_SIZE - 2000) + 1000, Math.random() * (FIELD_SIZE - 2000) + 1000));
    }

    // リソースノード: 5〜8個をマップ上にランダム配置 (ヒッグス雲内を優先)
    const nodeCount = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < nodeCount; i++) {
        // ヒッグス濃度の高い場所に配置 (暗黒物質の凝縮点)
        const spot = findHidingSpot(
            Math.random() * FIELD_SIZE,
            Math.random() * FIELD_SIZE,
            2000
        );
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

    // 艦種別初期処理
    if (gameState.shipType === 'carrier' && talosDrones.length === 0) {
        // 空母型: ドローン初期展開済み
        talosDrones.push(new TalosDrone(player.x + 50, player.y));
        logMessage('CARRIER: ドローン初期展開完了。', 'system-msg');
    }

    const shipLabel = { assault: '攻撃型', stealth: '潜航型', carrier: '空母型' };
    logMessage(`SYSTEM: ワープ完了。セクター ${gameState.sector} に到着しました [${shipLabel[gameState.shipType] || '不明'}]。環境マッピング中...`, 'system-msg');
}

function startGame(shipType) {
    gameState.shipType = shipType;
    document.getElementById('ship-select-lobby').classList.add('hidden');
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
    // Bump player back in
    player.x = Math.max(300, Math.min(player.x, FIELD_SIZE - 300));
    player.y = Math.max(300, Math.min(player.y, FIELD_SIZE - 300));
    player.setTarget(player.x, player.y);
    centerCameraOnPlayer();
    setTimeout(() => { dialogOpen = false; }, 2000);
});

// ============================================================
// GEN配分スライダー (ゼロサム: 合計100%)
// ============================================================
const GEN_KEYS = ['engine', 'weapons', 'sensors', 'ai'];

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
    cameraFollowPlayer = !cameraFollowPlayer;
    updateCameraFollowBtn();
    if (cameraFollowPlayer) centerCameraOnPlayer();
    logMessage(`NAV: カメラ追従 ${cameraFollowPlayer ? 'ON' : 'OFF'}`, 'system-msg');
    playSound('ui');
});
document.getElementById('btn-scan').addEventListener('click', () => {
    if (scanCooldown > 0) {
        logMessage(`SENSOR: スキャン再充電中... (残り ${Math.ceil(scanCooldown / 60)}秒)`, 'warning-msg');
        return;
    }
    playSound('ui');
    // Active scan temporarily reveals all enemies + alerts them (they hear the pulse)
    enemies.forEach(e => {
        e.visible = true;
        e.detectionState = 'alerted'; // Active scan is loud — enemies detect you too
        e.isAggro = true; e.aggroTimer = 400;
    });
    scanCooldown = 900; // 15 second cooldown (at 60fps)
    logMessage('SENSOR: アクティブスキャン発信。全敵性反応を一時的に捕捉。(敵にも探知される！ 再充填: 15秒)', 'system-msg');
    setTimeout(() => {
        enemies.forEach(e => { if (Math.hypot(e.x - player.x, e.y - player.y) > effectiveRadarRange) e.visible = false; });
    }, 4000);
});
document.getElementById('btn-hack').addEventListener('click', () => {
    playSound('ui');
    let closest = null; let cd = Infinity;
    structures.forEach(s => {
        const d = Math.hypot(player.x - s.x, player.y - s.y);
        // ヒッグス干渉を考慮した有効レンジを使用 (effectiveRadarRange)
        if (d < cd && d < effectiveRadarRange) { cd = d; closest = s; }
    });
    if (closest && !closest.hacked) {
        closest.hacked = true;
        logMessage(`EW: 構造物をハイジャック完了しました。自軍の熱源反応を偽装し、敵を誘因します。`, 'system-msg');
        createClickEffect(closest.x, closest.y, '#00aaff');
    } else {
        logMessage(`EW: 有効範囲内にハッキング可能な対象がいません。`, 'warning-msg');
    }
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
        document.querySelectorAll('.sensor-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        logMessage(`SENSOR: ${SENSOR_INFO[s].name}に切替。${SENSOR_INFO[s].tip}`, 'system-msg');
        playSound('ui');
    });
});

document.getElementById('btn-launch-talos').addEventListener('click', () => {
    if (gameState.credits >= 50) {
        gameState.credits -= 50;
        updateTopUI();
        talosDrones.push(new TalosDrone(player.x, player.y));
        logMessage('HANGER: 自律型兵器「TALOS」を出撃させました。', 'system-msg');
        document.getElementById('talos-count').textContent = `稼働中: ${talosDrones.length}`;
    } else {
        logMessage('SYS: 出撃に必要なクレジットが不足しています (必要: 50 CR)。', 'warning-msg');
    }
});


let scanAngle = 0;
function drawRadarSweep(ctx) {
    if (player.hp <= 0) return;
    scanAngle += 0.03;

    // ===== Higgs interference: reduce effective radar range =====
    const higgsAtPlayer = getHiggsIntensity(player.x, player.y);
    effectiveRadarRange = RADAR_RANGE * (1 - higgsAtPlayer * 0.65) * (1 + genAlloc.sensors / 100 * 0.5);

    // ============================================================
    // センサーモード別: 色・検出ロジック
    // HEAT  → 移動中の敵を捕捉 (heatSig)
    // OPTIC → 発砲フラッシュを捕捉 (opticalSig)
    // EM    → 潜伏中の受動放射を捕捉 (emSig)
    // HIGGS → ヒッグス雲乱流・ウェイク・リソースノード捕捉 (higgsSig)
    // ============================================================
    const sensorConfig = {
        heat:  { r:'255,80,0',    sig: e => e.heatSig,    rangeScale: 1.0,
                 higgsMod: 0.35, threshold: 0.3, label: '熱源' },
        optic: { r:'0,255,170',   sig: e => e.opticalSig,  rangeScale: 0.75,
                 higgsMod: 0.85, threshold: 0.2, label: '光学' },
        em:    { r:'180,50,255',  sig: e => e.emSig,       rangeScale: 0.85,
                 higgsMod: 0.1,  threshold: 0.3, label: '電磁波' },
        higgs: { r:'80,200,255',  sig: e => e.higgsSig,    rangeScale: 1.2,
                 higgsMod: 0.0,  threshold: 0.15, label: 'ヒッグス' }
    };
    const sc = sensorConfig[currentSensor];
    const CR = sc.r;
    const rc = {
        fill:   `rgba(${CR},0.04)`,
        stroke: `rgba(${CR},0.35)`,
        sweep:  `rgba(${CR},0.9)`,
        wedge:  `rgba(${CR},0.12)`
    };
    const sensorRange = effectiveRadarRange * sc.rangeScale;

    // センサー別可視判定
    enemies.forEach(e => {
        // 発砲フラッシュは常に可視 (物理的爆光)
        if (e.fireFlashTimer > 0) { e.visible = true; return; }

        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        const higgsAtEnemy = getHiggsIntensity(e.x, e.y);
        const effectiveSensorRange = sensorRange * (1 - higgsAtEnemy * sc.higgsMod);
        const sig = sc.sig(e);

        if (dist < effectiveSensorRange && sig > sc.threshold) {
            e.visible = true;
        } else if (dist < effectiveSensorRange * 0.6 && sig > sc.threshold * 0.5) {
            // 弱いシグナル: ノイズの中にチラつく
            e.visible = Math.random() < 0.12;
        } else {
            e.visible = false;
        }
    });

    ctx.save();
    ctx.translate(player.x, player.y);

    // Draw radar circle
    ctx.beginPath();
    ctx.arc(0, 0, effectiveRadarRange, 0, Math.PI * 2);
    ctx.fillStyle = rc.fill;
    ctx.fill();
    ctx.strokeStyle = rc.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw the sweeping line (センサー有効範囲まで)
    ctx.rotate(scanAngle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(sensorRange, 0);
    ctx.strokeStyle = rc.sweep;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Sweeping arc gradient wedge
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, sensorRange, 0, -0.6, true);
    ctx.closePath();
    ctx.fillStyle = rc.wedge;
    ctx.fill();

    ctx.restore();

    // EMセンサー専用: 収集直後のEMスパイク可視化
    if (currentSensor === 'em') {
        resourceNodes.forEach(n => {
            if (n.emFlashTimer <= 0) return;
            const dist = Math.hypot(n.x - player.x, n.y - player.y);
            if (dist < sensorRange) {
                const intensity = n.emFlashTimer / 180;
                ctx.save();
                ctx.globalAlpha = intensity * 0.9;
                ctx.fillStyle = '#cc44ff';
                ctx.shadowColor = '#cc44ff';
                ctx.shadowBlur = 20 * intensity;
                ctx.beginPath();
                ctx.arc(n.x, n.y, 7 * intensity, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.restore();
                ctx.globalAlpha = 1;
            }
        });
    }

    // ヒッグスセンサー専用: ウェイク軌跡 + リソースノード可視化
    if (currentSensor === 'higgs') {
        // ウェイク軌跡を描画
        higgsWakes.forEach(w => {
            const dist = Math.hypot(w.x - player.x, w.y - player.y);
            if (dist < sensorRange) {
                ctx.save();
                ctx.globalAlpha = w.life * 0.7;
                ctx.fillStyle = `rgba(${CR}, 0.8)`;
                ctx.beginPath();
                ctx.arc(w.x, w.y, 3 * w.intensity, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
                ctx.globalAlpha = 1;
            }
        });
        // リソースノードを輝点として表示
        resourceNodes.forEach(n => {
            if (!n.active) return;
            const dist = Math.hypot(n.x - player.x, n.y - player.y);
            if (dist < sensorRange) {
                const pulse = 0.6 + Math.sin(Date.now() * 0.004) * 0.4;
                ctx.save();
                ctx.globalAlpha = pulse;
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = `rgba(${CR}, 1)`;
                ctx.shadowBlur = 15;
                ctx.beginPath();
                ctx.arc(n.x, n.y, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 0.3;
                ctx.strokeStyle = `rgba(${CR}, 0.8)`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(n.x, n.y, 20, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                ctx.globalAlpha = 1;
            }
        });
    }

    // ヒッグス静電ノイズ (センサーカラーに合わせる)
    if (higgsAtPlayer > 0.4) {
        const staticAlpha = (higgsAtPlayer - 0.4) * 0.15;
        ctx.save();
        ctx.globalAlpha = staticAlpha;
        for (let i = 0; i < 6; i++) {
            const rx = player.x + (Math.random() - 0.5) * sensorRange * 2;
            const ry = player.y + (Math.random() - 0.5) * sensorRange * 2;
            if (Math.hypot(rx - player.x, ry - player.y) < sensorRange) {
                ctx.fillStyle = `rgba(${CR}, 0.8)`;
                ctx.fillRect(rx, ry, 2, 1);
            }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    // センサーモードラベルはUIパネル側に表示するためキャンバス上のテキストは除去
}

function drawMinimap() {
    minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    const sX = minimapCanvas.width / FIELD_SIZE; const sY = minimapCanvas.height / FIELD_SIZE;

    // ヒッグス濃度オーバーレイ (高密度ゾーンを青緑で表示)
    bgMist.forEach(m => {
        if (m.density <= 0.45) return;
        const mx = m.x * sX, my = m.y * sY, mr = m.r * sX;
        const g = minimapCtx.createRadialGradient(mx, my, 0, mx, my, mr);
        g.addColorStop(0,   `rgba(40,200,255,${(m.density * 0.35).toFixed(2)})`);
        g.addColorStop(0.5, `rgba(40,200,255,${(m.density * 0.12).toFixed(2)})`);
        g.addColorStop(1,   'rgba(0,0,0,0)');
        minimapCtx.fillStyle = g;
        minimapCtx.beginPath(); minimapCtx.arc(mx, my, mr, 0, Math.PI * 2); minimapCtx.fill();
    });

    // Viewport
    minimapCtx.strokeStyle = 'rgba(255,255,0,0.5)'; minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(camera.x * sX, camera.y * sY, (canvas.width / camera.zoom) * sX, (canvas.height / camera.zoom) * sY);

    // Structures
    structures.forEach(s => {
        minimapCtx.fillStyle = s.hacked ? '#00aaff' : 'rgba(255,255,255,0.2)';
        minimapCtx.fillRect(s.x * sX - 2, s.y * sY - 2, 4, 4);
    });

    // Player
    if (player && player.hp > 0) {
        minimapCtx.fillStyle = '#00ffaa'; minimapCtx.beginPath(); minimapCtx.arc(player.x * sX, player.y * sY, 3, 0, Math.PI * 2); minimapCtx.fill();
    }

    // Talos
    minimapCtx.fillStyle = '#4da6ff';
    talosDrones.forEach(t => { minimapCtx.beginPath(); minimapCtx.arc(t.x * sX, t.y * sY, 1.5, 0, Math.PI * 2); minimapCtx.fill(); });

    // Enemies (only visible ones; dead enemies are removed in game loop before minimap draws)
    minimapCtx.fillStyle = '#ff4d4d';
    enemies.forEach(e => {
        if (e.visible && e.hp > 0) { minimapCtx.beginPath(); minimapCtx.arc(e.x * sX, e.y * sY, 2, 0, Math.PI * 2); minimapCtx.fill(); }
    });

    // リソースノード (ヒッグスセンサー使用中のみミニマップ表示)
    if (currentSensor === 'higgs') {
        minimapCtx.fillStyle = '#50c8ff';
        resourceNodes.forEach(n => {
            if (!n.active) return;
            minimapCtx.beginPath();
            minimapCtx.arc(n.x * sX, n.y * sY, 2.5, 0, Math.PI * 2);
            minimapCtx.fill();
        });
    }
}

function handleMinimapInteraction(e) {
    const r = minimapCanvas.getBoundingClientRect();
    const mapX = e.clientX - r.left; const mapY = e.clientY - r.top;
    const wX = (mapX / minimapCanvas.width) * FIELD_SIZE; const wY = (mapY / minimapCanvas.height) * FIELD_SIZE;
    camera.x = wX - (canvas.width / 2 / camera.zoom); camera.y = wY - (canvas.height / 2 / camera.zoom);
    clampCamera();
}
let isMinimapDragging = false;
minimapCanvas.addEventListener('mousedown', e => { isMinimapDragging = true; handleMinimapInteraction(e); });
window.addEventListener('mouseup', () => isMinimapDragging = false);
minimapCanvas.addEventListener('mousemove', e => { if (isMinimapDragging) handleMinimapInteraction(e); });

// ミニマップ タッチ対応
function handleMinimapTouchInteraction(t) {
    const r = minimapCanvas.getBoundingClientRect();
    const mapX = t.clientX - r.left;
    const mapY = t.clientY - r.top;
    const wX = (mapX / minimapCanvas.width) * FIELD_SIZE;
    const wY = (mapY / minimapCanvas.height) * FIELD_SIZE;
    camera.x = wX - (canvas.width / 2 / camera.zoom);
    camera.y = wY - (canvas.height / 2 / camera.zoom);
    clampCamera();
}
minimapCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); isMinimapDragging = true; handleMinimapTouchInteraction(e.touches[0]); }, { passive: false });
minimapCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); e.stopPropagation(); if (isMinimapDragging) handleMinimapTouchInteraction(e.touches[0]); }, { passive: false });
minimapCanvas.addEventListener('touchend', () => { isMinimapDragging = false; });

// Background grid system
function drawBackground(ctx) {
    const vw = canvas.width / camera.zoom;
    const vh = canvas.height / camera.zoom;

    // Deep space base fill
    ctx.fillStyle = 'rgb(1,2,10)';
    ctx.fillRect(camera.x, camera.y, vw, vh);

    // Multi-layer parallax stars
    const parallaxes = [0.12, 0.32, 0.62];
    const now = Date.now() * 0.001;
    const cx = camera.x, cy = camera.y;

    bgStars.forEach(s => {
        const px = parallaxes[s.layer];
        const sx = s.x - cx * px;
        const sy = s.y - cy * px;
        // Cull off-screen
        if (sx < cx - 20 || sx > cx + vw + 20 || sy < cy - 20 || sy > cy + vh + 20) return;
        const twinkle = s.layer === 2
            ? s.alpha * (0.65 + Math.sin(now * 1.2 + s.twinkle) * 0.35)
            : s.alpha;
        ctx.globalAlpha = twinkle;
        ctx.fillStyle = s.color;
        if (s.layer === 2 && s.size > 2.5) {
            ctx.shadowColor = s.color;
            ctx.shadowBlur = 5;
        }
        ctx.fillRect(sx, sy, s.size, s.size);
        ctx.shadowBlur = 0;
    });
    ctx.globalAlpha = 1;

    // Nebula / Higgs mist clouds
    // 高密度(density>0.45)はヒッグス場として青緑の輝きで視覚化
    const pulse = 0.85 + Math.sin(now * 0.4) * 0.15;
    bgMist.forEach(m => {
        const isHiggs = m.density > 0.45;
        let baseAlpha = isHiggs ? 0.10 * pulse : 0.025;
        const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
        const col = isHiggs ? '40,200,255' : m.color;
        g.addColorStop(0,    `rgba(${col},${(baseAlpha * 2.2).toFixed(3)})`);
        g.addColorStop(0.30, `rgba(${col},${(baseAlpha * 1.0).toFixed(3)})`);
        g.addColorStop(0.65, `rgba(${col},${(baseAlpha * 0.4).toFixed(3)})`);
        g.addColorStop(1,    'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();

        // 高密度コアに輝点を追加
        if (isHiggs) {
            const cg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 0.25);
            cg.addColorStop(0, `rgba(80,240,255,${(0.07 * pulse).toFixed(3)})`);
            cg.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = cg;
            ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 0.25, 0, Math.PI * 2); ctx.fill();
        }
    });

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
}

// ============================================================
// 環境情報パネル動的更新
// ============================================================
function updateEnvInfo() {
    if (!player || player.hp <= 0) return;
    const intensity = getHiggsIntensity(player.x, player.y);
    const labels = ['低濃度', '中濃度', '高濃度', '危険領域'];
    const classes = ['', 'highlight-text', 'warning-text', 'warning-text'];
    const idx = Math.min(3, Math.floor(intensity * 4));

    const higgsSpan = document.getElementById('env-higgs');
    const radarSpan = document.getElementById('env-radar');
    if (higgsSpan) {
        higgsSpan.textContent = labels[idx];
        higgsSpan.className = classes[idx];
    }
    if (radarSpan) {
        radarSpan.textContent = `${Math.round(effectiveRadarRange)} u`;
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

    // 敵のシグネチャ強度を表示 (デバッグ兼ゲームプレイ情報)
    const sigEl = document.getElementById('env-signal');
    if (sigEl && enemies.length > 0) {
        const boss = enemies[0];
        const sc = { heat: boss.heatSig, optic: boss.opticalSig, em: boss.emSig, higgs: boss.higgsSig };
        const v = sc[currentSensor] || 0;
        const bars = '█'.repeat(Math.round(v * 5)) + '░'.repeat(5 - Math.round(v * 5));
        sigEl.textContent = bars;
        sigEl.style.color = v > 0.5 ? '#ff4d4d' : (v > 0.25 ? '#ffaa00' : '#444');
    }

    // GEN配分情報 (リソースノード数)
    const nodeEl = document.getElementById('env-nodes');
    if (nodeEl) {
        const activeNodes = resourceNodes.filter(n => n.active).length;
        nodeEl.textContent = `${activeNodes}/${resourceNodes.length}`;
    }
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
        ctx.setLineDash([5, 10]); ctx.strokeStyle = 'rgba(255, 77, 77, 0.4)'; ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(player.targetEntity.x, player.targetEntity.y, player.targetEntity.radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 77, 77, 0.8)'; ctx.stroke();
    } else if (player.state === 'moving') {
        ctx.beginPath(); ctx.moveTo(player.x, player.y); ctx.lineTo(player.targetX, player.targetY);
        ctx.setLineDash([5, 10]); ctx.strokeStyle = 'rgba(0, 255, 170, 0.3)'; ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(player.targetX, player.targetY, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 170, 0.5)'; ctx.fill();
    }
}

function gameLoop() {
    try {
        // ヒッグス自然成長 (Battle Royale的ゾーン圧縮 — 時間経過で濃度上昇)
        // 全ミスト密度を毎フレーム微増、最大0.95まで
        if (player && player.hp > 0 && Math.random() < 0.004) { // ~4フレームに1回更新
            bgMist.forEach(m => {
                m.density = Math.min(0.95, m.density + 0.0002);
            });
        }

        // Tick cooldowns
        if (scanCooldown > 0) {
            scanCooldown--;
            // Update scan button text
            const btnScan = document.getElementById('btn-scan');
            if (scanCooldown > 0) {
                btnScan.textContent = `スキャン (${Math.ceil(scanCooldown / 60)}s)`;
                btnScan.disabled = true;
            } else {
                btnScan.textContent = 'アクティブスキャン';
                btnScan.disabled = false;
            }
        }

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
        talosDrones.forEach(d => d.update());

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
                    logMessage(`TAC: スクラップ回収完了 (報酬: ${s.value} CR)`, 'system-msg');
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
        // プレイヤーの移動でもウェイクを生成
        if (player && player.hp > 0 && player.state === 'moving') {
            const playerHiggs = getHiggsIntensity(player.x, player.y);
            if (playerHiggs > 0.2 && Math.random() < 0.3) {
                higgsWakes.push({ x: player.x, y: player.y, intensity: playerHiggs * 0.6, life: 0.8 });
            }
        }

        // リソースノード収集チェック (プレイヤー接近で自動収集)
        for (let i = resourceNodes.length - 1; i >= 0; i--) {
            const n = resourceNodes[i];
            // EMスパイクタイマー: 収集後も非アクティブ状態でカウントダウン継続
            if (n.emFlashTimer > 0) n.emFlashTimer--;
            if (!n.active) continue;
            if (player && player.hp > 0) {
                const d = Math.hypot(player.x - n.x, player.y - n.y);
                if (d < player.radius + 40) {
                    // 収集！
                    n.active = false;
                    n.emFlashTimer = 180; // 3秒間EMスパイク
                    // EMスパイク: EM状態が高まった状態を記録 (敵に見える)
                    gameState.credits += 30; // リソース価値 (仮: 将来はアップグレードポイントに)
                    updateTopUI();
                    playSound('ui');
                    effects.push({ x: n.x, y: n.y, r: 0, maxR: 80, a: 1, c: '#50c8ff', type: 'circle' });
                    logMessage(`HIGGS: ヒッグス凝縮点を採取 (+30 CR)。EMスパイク発生中 — 敵に検知される可能性あり。`, 'system-msg');
                    createClickEffect(n.x, n.y, '#50c8ff');
                }
            }
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

        // カメラ追従
        if (cameraFollowPlayer && player) centerCameraOnPlayer();

        // Rendering
        ctx.clearRect(0, 0, canvas.width, canvas.height);

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

        // リソースノード描画 (HIGGSセンサー使用中のみ可視 — 設計仕様)
        if (currentSensor === 'higgs') {
            resourceNodes.forEach(n => {
                if (!n.active) return;
                const t = Date.now();
                const pulse = 0.5 + Math.sin(t * 0.003 + n.x * 0.001) * 0.3;
                const spin = (t * 0.0008 + n.x * 0.0003) % (Math.PI * 2);
                ctx.save();
                ctx.translate(n.x, n.y);
                ctx.rotate(spin);
                ctx.globalAlpha = 0.15 + pulse * 0.12;
                ctx.fillStyle = '#50c8ff';
                ctx.shadowColor = '#50c8ff'; ctx.shadowBlur = 20;
                // Crystal hexagon
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2;
                    const px = Math.cos(a) * 6, py = Math.sin(a) * 6;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath(); ctx.fill();
                // Inner highlight
                ctx.globalAlpha = 0.08 + pulse * 0.06;
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
                    const px = Math.cos(a) * 3, py = Math.sin(a) * 3;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath(); ctx.fill();
                ctx.shadowBlur = 0;
                ctx.restore();
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
            ctx.fillStyle = '#00ffaa'; ctx.shadowColor = '#00ffaa'; ctx.shadowBlur = 10;
            ctx.fillRect(-3, -3, 6, 6);
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#fff';
            ctx.fillRect(-1.5, -1.5, 3, 3);
            ctx.restore();
            ctx.globalAlpha = 1;
        });

        if (player && player.hp > 0) drawRadarSweep(ctx);

        projectiles.forEach(p => p.draw(ctx));
        updateDrawEffects(ctx);
        updateDrawDebrisParticles(ctx);

        enemies.forEach(e => e.draw(ctx));
        talosDrones.forEach(d => d.draw(ctx));
        if (player && player.hp > 0) player.draw(ctx);

        ctx.restore();

        drawMinimap();
        updateEnvInfo();

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

function updateDockingUI() {
    document.getElementById('dock-credits').textContent = gameState.credits;

    // Repair cost: 1 credit per 2 HP missing
    const missingHp = player.maxHp - player.hp;
    const repairCost = Math.ceil(missingHp / 2);
    const btnRepair = document.getElementById('btn-repair-all');
    btnRepair.textContent = `全艦修理 (${repairCost} CR)`;
    btnRepair.disabled = gameState.credits < repairCost || repairCost === 0;

    // Upgrade costs
    const getCost = (lvl) => (lvl + 1) * 300;

    const hLvl = gameState.upgrades.hull;
    const rLvl = gameState.upgrades.radar;
    const wLvl = gameState.upgrades.weapons;

    document.getElementById('level-hull').textContent = hLvl;
    document.getElementById('cost-hull').textContent = getCost(hLvl);
    document.getElementById('btn-upgrade-hull').disabled = gameState.credits < getCost(hLvl);

    document.getElementById('level-radar').textContent = rLvl;
    document.getElementById('cost-radar').textContent = getCost(rLvl);
    document.getElementById('btn-upgrade-radar').disabled = gameState.credits < getCost(rLvl);

    document.getElementById('level-weapons').textContent = wLvl;
    document.getElementById('cost-weapons').textContent = getCost(wLvl);
    document.getElementById('btn-upgrade-weapons').disabled = gameState.credits < getCost(wLvl);
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
        logMessage('MAINT: 全システムの修復が完了しました。', 'system-msg');
    }
});

function buyUpgrade(type) {
    const lvl = gameState.upgrades[type];
    const cost = (lvl + 1) * 300;
    if (gameState.credits >= cost) {
        gameState.credits -= cost;
        gameState.upgrades[type]++;
        playSound('ui');

        // Re-calculate stats
        if (type === 'hull') {
            const hpBase = { assault: 3500, stealth: 700, carrier: 2500 };
            player.maxHp = (hpBase[gameState.shipType] || 2000) * (1 + (gameState.upgrades.hull * 0.25));
        }
        if (type === 'radar') RADAR_RANGE = BASE_RADAR_RANGE * (1 + (gameState.upgrades.radar * 0.2));

        updateTopUI();
        updateDockingUI();
        saveGame();
        logMessage(`UPGRADE: ${type.toUpperCase()} システムを強化しました。レベル: ${gameState.upgrades[type]}`, 'system-msg');
    }
}

document.getElementById('btn-upgrade-hull').addEventListener('click', () => buyUpgrade('hull'));
document.getElementById('btn-upgrade-radar').addEventListener('click', () => buyUpgrade('radar'));
document.getElementById('btn-upgrade-weapons').addEventListener('click', () => buyUpgrade('weapons'));

// gameLoop is started by startGame() after ship selection

// Game Over / Restart
document.getElementById('btn-restart').addEventListener('click', () => {
    document.getElementById('game-over-overlay').classList.add('hidden');
    gameState.credits = Math.floor(gameState.credits * 0.5); // Keep half credits on death
    gameState.sector = Math.max(1, gameState.sector); // Keep sector progress
    generateSector();
    updateTopUI();
    logMessage('SYSTEM: TALOS-CMD 緊急再起動完了。クレジット50%喪失。', 'warning-msg');
});
