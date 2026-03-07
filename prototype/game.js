// Init canvas

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');

let FIELD_SIZE = 8000;
let BASE_RADAR_RANGE = 600;
let RADAR_RANGE = BASE_RADAR_RANGE;
let effectiveRadarRange = BASE_RADAR_RANGE; // Actual range after Erebos interference
let sectorCleared = false;
let scanCooldown = 0; // Active scan cooldown (frames)
let enemiesKilled = 0; // Stat tracking

// ============================================================
// マルチセンサーシステム (じゃんけん方式)
// heat: 移動中の熱源検出  optic: 発砲フラッシュ検出  em: 潜伏中受動放射検出
// ============================================================
let currentSensor = 'heat'; // 'heat' | 'optic' | 'em'

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
    document.getElementById('sector-display').textContent = `セクター: ${gameState.sector}`;
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

// ============================================================
// エレボス濃度計算 (Erebos Intensity)
// ============================================================
function getErebosIntensity(x, y) {
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

// エレボスの濃い隠れ場所を探す (ジエンド戦スタイルAI用)
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
        const score = getErebosIntensity(tx, ty);
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
    zoom: 1, minZoom: 0.1, maxZoom: 3,
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

// Input Handling
canvas.addEventListener('mousedown', (e) => {
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
            const speedEst = Math.max(0.1, (player.generatorOutput / 100) * 1.5);
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
const touch = {
    startX: 0, startY: 0,
    lastX: 0, lastY: 0,
    moved: false,
    pinchDist: 0,
    isPinching: false
};

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
        const t = e.touches[0];
        touch.startX = t.clientX;
        touch.startY = t.clientY;
        touch.lastX = t.clientX;
        touch.lastY = t.clientY;
        touch.moved = false;
        touch.isPinching = false;
        camera.isDragging = true;
        camera.lastX = t.clientX;
        camera.lastY = t.clientY;
    } else if (e.touches.length === 2) {
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
        if (Math.hypot(dx, dy) > 8) touch.moved = true;
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
    camera.isDragging = false;
    if (!touch.moved && !touch.isPinching) {
        const worldX = (touch.startX / camera.zoom) + camera.x;
        const worldY = (touch.startY / camera.zoom) + camera.y;
        // タッチはロックオン判定を広く取る（指で画面を押すと視認が難しいため）
        const tapRadius = en => en.radius * 6 + 20;
        let clickedEnemy = enemies.find(en => en.visible && Math.hypot(en.x - worldX, en.y - worldY) < tapRadius(en));
        if (clickedEnemy) {
            player.targetEntity = clickedEnemy;
            createClickEffect(clickedEnemy.x, clickedEnemy.y, '#ff4d4d');
            logMessage(`TACTICAL: ターゲットをロック。射撃解を計算中...`, 'system-msg');
        } else {
            player.targetEntity = null;
            player.setTarget(worldX, worldY);
            createClickEffect(worldX, worldY, '#00ffaa');
            const dist = Math.hypot(worldX - player.x, worldY - player.y);
            const speedEst = Math.max(0.1, (player.generatorOutput / 100) * 1.5);
            const timeSeconds = Math.max(1, Math.floor(dist / (speedEst * 60)));
            logMessage(`NAV: 進路設定完了。到着予定時間はおよそ ${timeSeconds} 秒です。`, 'system-msg');
        }
    }
    if (e.touches.length < 2) touch.isPinching = false;
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
        ctx.beginPath();
        if (this.type === 'colony') {
            ctx.rect(this.x - 30, this.y - 30, 60, 60);
        } else {
            ctx.moveTo(this.x - 10, this.y - 20); ctx.lineTo(this.x + 10, this.y - 20);
            ctx.lineTo(this.x + 20, this.y + 20); ctx.lineTo(this.x - 20, this.y + 20);
            ctx.closePath();
        }
        ctx.strokeStyle = this.hacked ? '#00aaff' : this.color;
        ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = this.color; ctx.fill();

        if (this.hacked) {
            // Emitting Decoy Pulses
            ctx.beginPath();
            const r = 200 * ((Date.now() % 2000) / 2000);
            ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(0, 170, 255, ${1 - (r / 200)})`;
            ctx.stroke();
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
                target.hp -= 150 * dmgMult;
                createHitEffect(target.x, target.y, isPlayer ? '#00ffaa' : '#ff4d4d');
                effects.push({ x: this.x, y: this.y, tx: target.x, ty: target.y, type: 'beam', a: 1, c: isPlayer ? '#00ffaa' : '#ff4d4d' });
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
            ctx.fillStyle = this.isPlayer ? '#00ffaa' : '#ff4d4d';
            ctx.fillRect(-5, -1, 10, 2);
        } else if (this.type === 'missile') {
            ctx.fillStyle = '#fff';
            ctx.fillRect(-6, -2, 12, 4);
            ctx.fillStyle = '#ffaa00';
            ctx.fillRect(-10, -1, 4, 2); // exhaust
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
        ctx.rotate(this.angle);
        ctx.fillStyle = '#4da6ff';
        ctx.beginPath();
        ctx.moveTo(this.radius, 0); ctx.lineTo(-this.radius, -this.radius); ctx.lineTo(-this.radius, this.radius);
        ctx.fill();
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
            this.type = 'mothership';
            this.radius = 20;
            this.maxHp = 2000 * (1 + (gameState.upgrades.hull * 0.25));
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
        this.lurking = !isPlayer;       // 潜伏モード (エレボスの濃い場所へ移動)
        this.postFireCooldown = 0;      // 発砲後の再配置タイマー
        this.fireFlashTimer = 0;        // 発砲直後の可視フラッシュタイマー
        this.repositionLogged = false;  // 再配置ログ重複防止
        // マルチセンサーシグネチャ
        this.heatSig = 0;    // 熱源シグネチャ: 移動中に上昇
        this.opticalSig = 0; // 光学シグネチャ: 発砲フラッシュ・低エレボス時
        this.emSig = 0;      // 電磁波シグネチャ: 潜伏中の受動放射・発砲時スパイク
        this.prevX = x;      // 移動量計算用
        this.prevY = y;
    }

    setTarget(tx, ty) { this.targetX = tx; this.targetY = ty; this.state = 'moving'; }

    update() {
        if (this.hp <= 0) return;
        if (this.fireCooldown > 0) this.fireCooldown--;

        if (this.isPlayer) {
            // Speed defined by generator output slider
            this.speed = (this.generatorOutput / 100) * 1.5;

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
                    projectiles.push(new Projectile(this.x, this.y, this.targetEntity, true, wType));
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
                            logMessage('SENSOR: 敵艦の熱源反応が消失。エレボスの霧に再潜伏中...', 'warning-msg');
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
            // 自艦探知チェック — エレボスで探知範囲が変動
            // ──────────────────────────────────────
            const distToPlayer = Math.hypot(player.x - this.x, player.y - this.y);
            const erebosHere = getErebosIntensity(this.x, this.y);
            const myDetectRange = 800 * (1 - erebosHere * 0.55) * (1 + gameState.sector * 0.05);

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
            // 潜伏モード — エレボスの濃い場所を探す
            // ──────────────────────────────────────
            if (this.lurking || this.detectionState === 'unaware') {
                this.speed = 0.35; // ゆっくり移動 (潜望鏡を出すレベル)
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
                    const wType = gameState.sector <= 2 ? 'kinetic' : 'missile';
                    projectiles.push(new Projectile(this.x, this.y, player, false, wType));
                    playSound('shoot');
                    this.fireCooldown = 180;

                    // 発砲フラッシュ — 約2秒間、位置が露わになる
                    this.fireFlashTimer = 120;
                    this.visible = true;
                    effects.push({ x: this.x, y: this.y, r: 0, maxR: 200, a: 0.9, c: '#ff4d4d', type: 'circle' });
                    logMessage('WARNING: 砲撃フラッシュ検知！敵艦の位置を一時特定しました。', 'warning-msg');

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
            // postFireCooldown中の高速再配置は熱源強め、潜伏中はほぼゼロ
            if (this.postFireCooldown > 0) {
                this.heatSig = Math.min(1.0, this.heatSig + 0.05); // 再配置は激しく発熱
            } else {
                this.heatSig = Math.min(1.0, spd / 1.0); // 速度に比例
            }

            // 光学シグネチャ: 発砲フラッシュ時に最大、エレボスで大きく減衰
            const erebosHere = getErebosIntensity(this.x, this.y);
            if (this.fireFlashTimer > 50) {
                this.opticalSig = Math.min(1.0, this.opticalSig + 0.12); // 発砲フラッシュ急上昇
            } else {
                // 発光フェード + エレボス減衰
                this.opticalSig = Math.max(0, this.opticalSig * 0.92) * (1 - erebosHere * 0.95);
            }

            // 電磁波シグネチャ: 潜伏中は受動放射が漏れる、発砲時スパイク、移動中は無線封鎖
            if (this.fireFlashTimer > 60) {
                this.emSig = Math.min(1.0, this.emSig + 0.08); // 武器放電EM スパイク
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

        // 潜伏中は半透明 (ノイズの中にかすかに映る)
        const isLurking = !this.isPlayer && (this.lurking || this.detectionState === 'unaware');
        const isFlashing = !this.isPlayer && this.fireFlashTimer > 0;
        if (isLurking) ctx.globalAlpha = 0.4 + Math.sin(Date.now() * 0.003) * 0.15; // ゆらゆら点滅
        if (isFlashing) ctx.globalAlpha = 1.0;

        ctx.beginPath();
        if (this.isPlayer) {
            ctx.moveTo(this.radius, 0); ctx.lineTo(-this.radius, -this.radius * 0.6);
            ctx.lineTo(-this.radius * 0.5, 0); ctx.lineTo(-this.radius, this.radius * 0.6);
            ctx.fillStyle = '#00ffaa'; ctx.shadowColor = '#00ffaa';
            ctx.shadowBlur = 15;
        } else {
            // 敵は発砲フラッシュ中は大きく赤く光る
            const r = isFlashing ? this.radius * 1.5 : this.radius;
            ctx.moveTo(r, 0); ctx.lineTo(-r, -r * 0.8);
            ctx.lineTo(-r * 0.6, 0); ctx.lineTo(-r, r * 0.8);
            ctx.fillStyle = isFlashing ? '#ff8888' : '#ff4d4d';
            ctx.shadowColor = '#ff4d4d';
            ctx.shadowBlur = isFlashing ? 40 : 15;
        }
        ctx.closePath(); ctx.fill();
        ctx.shadowBlur = 0;

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
function generateSector() {
    sectorCleared = false;
    enemiesKilled = 0;
    scanCooldown = 0;
    // Keep drones if transitioning, but set position
    const tCount = talosDrones.length;
    player = new Ship(FIELD_SIZE / 2, FIELD_SIZE / 2, true);
    player.generatorOutput = document.getElementById('speedSlider').value;
    enemies = []; structures = []; projectiles = []; effects = []; talosDrones = []; particles = []; debris = []; scrapDrops = [];
    stations = [];

    // Apply Upgrades to Stats
    RADAR_RANGE = BASE_RADAR_RANGE * (1 + (gameState.upgrades.radar * 0.2));

    // Environmental Background
    bgStars = [];
    for (let i = 0; i < 500; i++) {
        bgStars.push({ x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE, size: Math.random() * 2, color: Math.random() > 0.8 ? '#ccddff' : '#ffffff' });
    }
    bgMist = [];
    for (let i = 0; i < 40; i++) {
        bgMist.push({
            x: Math.random() * FIELD_SIZE, y: Math.random() * FIELD_SIZE,
            r: Math.random() * 1000 + 500,
            color: Math.random() > 0.7 ? '50, 20, 100' : '20, 50, 80', // Magenta vs Blue Nebulae
            density: Math.random() * 0.65 + 0.1 // Gameplay density: affects radar + detection
        });
    }

    for (let i = 0; i < tCount; i++) talosDrones.push(new TalosDrone(player.x, player.y));

    // ===== ジエンド戦スタイル: 1セクター = 敵1機 =====
    // 敵をエレボスの濃い場所に配置 (プレイヤーから遠い位置)
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist = 3000 + Math.random() * 2000; // 3000-5000u離れた場所
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
    for (let i = 0; i < 8; i++) {
        structures.push(new Structure(Math.random() * FIELD_SIZE, Math.random() * FIELD_SIZE, Math.random() > 0.5 ? 'colony' : 'derelict'));
    }
    for (let i = 0; i < 3; i++) {
        stations.push(new Station(Math.random() * (FIELD_SIZE - 2000) + 1000, Math.random() * (FIELD_SIZE - 2000) + 1000));
    }

    centerCameraOnPlayer();

    // Add delay to ensure canvas is sized before centering camera again
    setTimeout(() => {
        centerCameraOnPlayer();
    }, 100);

    logMessage(`SYSTEM: ワープ完了。セクター ${gameState.sector} に到着しました。環境マッピング中...`, 'system-msg');
}
generateSector(); // Initial map

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

document.getElementById('speedSlider').addEventListener('input', e => {
    document.getElementById('speedValue').textContent = `${e.target.value}%`;
    if (player) player.generatorOutput = e.target.value;
});
document.getElementById('btn-cancel').addEventListener('click', () => {
    playSound('ui');
    if (!player) return;
    player.setTarget(player.x, player.y);
    player.targetEntity = null;
    logMessage('NAV: 待機命令を受諾。', 'system-msg');
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
        if (d < cd && d < RADAR_RANGE) { cd = d; closest = s; }
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
// センサーモード切替ハンドラ (heat / optic / em)
// ============================================================
const SENSOR_INFO = {
    heat:  { name: '熱源センサー',    tip: '敵の移動時エンジン熱を追跡 — 発砲後の再配置フェーズに有効' },
    optic: { name: '光学センサー',    tip: '発砲フラッシュを捕捉 — 砲撃直後の一瞬を逃さない' },
    em:    { name: '電磁波センサー',  tip: '潜伏中の受動EM漏洩を検出 — 索敵フェーズ最適' }
};
['heat', 'optic', 'em'].forEach(s => {
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

    // ===== Erebos interference: reduce effective radar range =====
    const erebosAtPlayer = getErebosIntensity(player.x, player.y);
    effectiveRadarRange = RADAR_RANGE * (1 - erebosAtPlayer * 0.65);

    // ============================================================
    // センサーモード別: 色・検出ロジック
    // HEAT  → 移動中の敵を捕捉 (heatSig)
    // OPTIC → 発砲フラッシュを捕捉 (opticalSig)
    // EM    → 潜伏中の受動放射を捕捉 (emSig)
    // ============================================================
    const sensorConfig = {
        heat:  { r:'255,80,0',   sig: e => e.heatSig,    rangeScale: 1.0,
                 erebosMod: 0.35, threshold: 0.3, label: '熱源' },
        optic: { r:'0,255,170',  sig: e => e.opticalSig,  rangeScale: 0.75,
                 erebosMod: 0.85, threshold: 0.2, label: '光学' },
        em:    { r:'180,50,255', sig: e => e.emSig,       rangeScale: 0.85,
                 erebosMod: 0.1,  threshold: 0.3, label: '電磁波' }
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
        const erebosAtEnemy = getErebosIntensity(e.x, e.y);
        const effectiveSensorRange = sensorRange * (1 - erebosAtEnemy * sc.erebosMod);
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

    // Erebos static noise (センサーカラーに合わせる)
    if (erebosAtPlayer > 0.4) {
        const staticAlpha = (erebosAtPlayer - 0.4) * 0.15;
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

    // センサーモードラベル (キャンバス右上付近)
    ctx.save();
    ctx.font = 'bold 11px Orbitron';
    ctx.fillStyle = `rgba(${CR}, 0.7)`;
    ctx.fillText(`[ ${sc.label}センサー ]`, player.x + sensorRange * 0.7, player.y - sensorRange * 0.1);
    ctx.restore();
}

function drawMinimap() {
    minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    const sX = minimapCanvas.width / FIELD_SIZE; const sY = minimapCanvas.height / FIELD_SIZE;

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

    // Enemies
    minimapCtx.fillStyle = '#ff4d4d';
    enemies.forEach(e => {
        if (e.visible || e.hp <= 0) { minimapCtx.beginPath(); minimapCtx.arc(e.x * sX, e.y * sY, 2, 0, Math.PI * 2); minimapCtx.fill(); }
    });
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
    // Render Mist Clouds (Erebos Dark Matter)
    bgMist.forEach(m => {
        let alpha = 0.03;
        if (player.hp > 0 && Math.hypot(player.x - m.x, player.y - m.y) < RADAR_RANGE) alpha = 0.07;
        const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
        g.addColorStop(0, `rgba(${m.color}, ${alpha})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
    });

    // Render Stars (parallax 0.5)
    ctx.save();
    // Shifting them slightly based on camera to give pseudo-parallax
    ctx.translate(camera.x * 0.5, camera.y * 0.5);
    bgStars.forEach(s => {
        ctx.fillStyle = s.color;
        ctx.globalAlpha = 0.3;
        ctx.fillRect(s.x, s.y, s.size, s.size);
    });
    ctx.restore();

    const gridSize = 200;
    const startX = Math.floor(camera.x / gridSize) * gridSize;
    const startY = Math.floor(camera.y / gridSize) * gridSize;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = startX; x < camera.x + canvas.width / camera.zoom; x += gridSize) {
        ctx.moveTo(x, camera.y); ctx.lineTo(x, camera.y + canvas.height / camera.zoom);
    }
    for (let y = startY; y < camera.y + canvas.height / camera.zoom; y += gridSize) {
        ctx.moveTo(camera.x, y); ctx.lineTo(camera.x + canvas.width / camera.zoom, y);
    }
    ctx.stroke();
}

// ============================================================
// 環境情報パネル動的更新
// ============================================================
function updateEnvInfo() {
    if (!player || player.hp <= 0) return;
    const intensity = getErebosIntensity(player.x, player.y);
    const labels = ['低濃度', '中濃度', '高濃度', '危険領域'];
    const classes = ['', 'highlight-text', 'warning-text', 'warning-text'];
    const idx = Math.min(3, Math.floor(intensity * 4));

    const erebosSpan = document.getElementById('env-erebos');
    const radarSpan = document.getElementById('env-radar');
    if (erebosSpan) {
        erebosSpan.textContent = labels[idx];
        erebosSpan.className = classes[idx];
    }
    if (radarSpan) {
        radarSpan.textContent = `${Math.round(effectiveRadarRange)} u`;
    }
    document.getElementById('hostile-count').textContent =
        enemies.filter(e => e.visible).length > 0 ? enemies.filter(e => e.visible).length + '機' : '不明';

    // センサーモード表示
    const sensorEl = document.getElementById('env-sensor');
    if (sensorEl) {
        const sensorLabels = { heat: '🔥 熱源', optic: '👁 光学', em: '📡 電磁波' };
        const sensorClasses = { heat: 'warning-text', optic: 'highlight-text', em: '' };
        sensorEl.textContent = sensorLabels[currentSensor] || '---';
        sensorEl.className = sensorClasses[currentSensor] || '';
        sensorEl.style.color = currentSensor === 'em' ? '#cc44ff' : '';
    }

    // 敵のシグネチャ強度を表示 (デバッグ兼ゲームプレイ情報)
    const sigEl = document.getElementById('env-signal');
    if (sigEl && enemies.length > 0) {
        const boss = enemies[0];
        const sc = { heat: boss.heatSig, optic: boss.opticalSig, em: boss.emSig };
        const v = sc[currentSensor] || 0;
        const bars = '█'.repeat(Math.round(v * 5)) + '░'.repeat(5 - Math.round(v * 5));
        sigEl.textContent = bars;
        sigEl.style.color = v > 0.5 ? '#ff4d4d' : (v > 0.25 ? '#ffaa00' : '#444');
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
        if (!sectorCleared && enemies.length === 0 && player && player.hp > 0) {
            sectorCleared = true;
            const bonus = 100 + gameState.sector * 75;
            gameState.credits += bonus;
            updateTopUI();
            saveGame();
            showSectorClear(bonus);
            logMessage(`MISSION: セクター${gameState.sector}の脅威排除完了。ボーナス: +${bonus} CR`, 'system-msg');
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

        // Render scrap
        scrapDrops.forEach(s => {
            ctx.fillStyle = '#00ffaa';
            ctx.shadowColor = '#00ffaa';
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
            ctx.fill();
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
        window.onerror(err.message, "game.js - gameLoop", 0, 0, err);
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
        if (type === 'hull') player.maxHp = 2000 * (1 + (gameState.upgrades.hull * 0.25));
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

try {
    gameLoop();
} catch (e) {
    window.onerror(e.toString(), "gameLoop", 0, 0, e);
}

// Game Over / Restart
document.getElementById('btn-restart').addEventListener('click', () => {
    document.getElementById('game-over-overlay').classList.add('hidden');
    gameState.credits = Math.floor(gameState.credits * 0.5); // Keep half credits on death
    gameState.sector = Math.max(1, gameState.sector); // Keep sector progress
    generateSector();
    updateTopUI();
    logMessage('SYSTEM: TALOS-CMD 緊急再起動完了。クレジット50%喪失。', 'warning-msg');
});
