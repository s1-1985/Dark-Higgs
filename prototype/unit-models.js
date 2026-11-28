// Reviewed against source sprites and +X-facing renders. Generated axes vary by asset.
const REVERSED = new Set(['helios-fighter', 'crow-stealth', 'rustroad-carrier', 'rustroad-fighter', 'sanctum-stealth', 'sanctum-scout']);
const ROLLED = new Set(['rustroad-carrier', 'rustroad-fighter']);
export const UNIT_MODELS = Object.freeze(Object.fromEntries(
    ['helios', 'crow', 'valkyr', 'rustroad', 'sanctum', 'fogborn'].flatMap(faction => ['assault', 'stealth', 'carrier', 'fighter', 'scout', 'mech'].map(role => {
        const id = `${faction}-${role}`;
        return [id, Object.freeze({ id, role, url: new URL(`./assets/models/${id}.glb`, import.meta.url).href,
            yaw: id === 'rustroad-scout' ? 0 : REVERSED.has(id) ? -Math.PI / 2 : Math.PI / 2,
            roll: ROLLED.has(id) ? Math.PI / 2 : 0 })];
    }))
));
export function modelForSprite(img) {
    const match = /(?:^|\/)f2_(helios|crow|valkyr|rustroad|sanctum|fogborn)_(assault|stealth|carrier|fighter|scout|mech)(?:_(?:fire|ready|slash|thrust))?\.png(?:[?#]|$)/.exec(img.currentSrc || img.src || '');
    // Pose aliases exist only for Tech; never substitute another faction or role.
    if (!match || (match[2] !== 'mech' && /_(?:fire|ready|slash|thrust)\.png/.test(match[0]))) return null;
    return UNIT_MODELS[`${match[1]}-${match[2]}`];
}
// Loading starts only after the original draw/visibility gate and screen culling.
// Failed models stay as sprites; switching mode does not retry or duplicate downloads.
export function createModelCache(load, release, reportFailure, concurrency = 2) {
    const entries = new Map(), queue = [];
    let running = 0, disposed = false;
    function pump() {
        while (!disposed && running < concurrency && queue.length) {
            const entry = queue.shift(); running++;
            Promise.resolve().then(() => load(entry.spec)).then(value => {
                if (disposed) release(value);
                else { entry.value = value; entry.status = 'ready'; }
            }).catch(error => {
                entry.status = 'failed';
                if (!disposed) reportFailure(entry.spec, error);
            }).finally(() => { running--; pump(); });
        }
    }
    return {
        get(spec) {
            if (disposed) return null;
            let entry = entries.get(spec.id);
            if (!entry) { entry = { spec, status: 'loading', value: null }; entries.set(spec.id, entry); queue.push(entry); pump(); }
            return entry.value;
        },
        dispose() {
            disposed = true; queue.length = 0;
            for (const entry of entries.values()) if (entry.value) release(entry.value);
            entries.clear();
        }
    };
}
export function spritePlacement(transform, frame, len, screenScale) {
    const cos = Math.cos(35 * Math.PI / 180);
    // Fallback handles the projected canvas transform, including drone minimum-size scaling.
    const scale = screenScale ?? Math.hypot(transform.a, transform.b / cos) / frame.dpr;
    const length = len * scale, x = transform.e / frame.dpr, y = transform.f / frame.dpr;
    if (![x, y, length].every(Number.isFinite) || length <= 0 || x < -length || x > frame.width + length || y < -length || y > frame.height + length) return null;
    return { x, y, length };
}
