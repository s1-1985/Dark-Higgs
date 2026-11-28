/* Experimental drawing adapter. It never receives simulation entities or changes game state. */
(function (root) {
    'use strict';
    const COS = Math.cos(35 * Math.PI / 180);
    const P = {
        cos: COS,
        screenY: (y, h, active) => active ? h / 2 + (y - h / 2) * COS : y,
        unprojectY: (y, h, active) => active ? h / 2 + (y - h / 2) / COS : y,
        bounds: (camera, width, height, active) => {
            const h = height / camera.zoom / (active ? COS : 1);
            return { x: camera.x, y: camera.y + height / camera.zoom / 2 - h / 2, w: width / camera.zoom, h };
        }
    };
    let wanted = false, active = false, pending = null, renderer = null, frame = null, notify = () => {};
    const badge = () => document.getElementById('view3d-label');
    function sync() {
        const el = badge();
        if (el) el.textContent = pending && wanted ? '3D 読込中…' : active ? '3D 試験中 · 押すと2D' : '2D · 押すと3D';
        const mm = document.getElementById('minimapCanvas');
        if (mm) {
            mm.setAttribute('aria-label', active ? '2D表示に戻す' : '試験的な3D表示に切り替える');
            mm.setAttribute('aria-pressed', String(active));
        }
        document.getElementById('game-container')?.classList.toggle('view3d-active', active);
        renderer?.setVisible(active);
    }
    function fail(error) {
        wanted = active = false;
        renderer?.dispose(); renderer = null;
        sync();
        console.warn('Experimental 3D disabled:', error);
        notify('表示: 3Dを開始・継続できないため2Dに戻した（WebGLまたは素材の読込を確認）');
    }
    async function toggle(onNotice) {
        if (typeof onNotice === 'function') notify = onNotice;
        wanted = !wanted;
        if (!wanted) { active = false; sync(); return false; }
        if (renderer) { active = true; sync(); return true; }
        if (!pending) {
            pending = import('./view3d-renderer.js?v=20261128-units2')
                .then(m => m.createRenderer({ onFailure: fail }));
        }
        sync();
        const operation = pending;
        try {
            renderer = await operation;
            active = wanted;
        } catch (error) { fail(error); }
        finally { if (pending === operation) pending = null; sync(); }
        return active;
    }
    root.Experimental3D = {
        projection: P,
        isActive: () => active,
        toggle,
        beginFrame(info) {
            if (active && info.enemyReplay) {
                wanted = active = false;
                sync(); notify('表示: 敵視点リプレイは2Dで表示する');
            }
            frame = active ? Object.freeze({ ...info }) : null;
            if (frame) { try { renderer.beginFrame(frame); } catch (error) { frame = null; fail(error); } }
        },
        captureSprite(ctx, img, role, len, angle, screenScale) {
            // Called only after the existing visibility gate. No entity list or true positions enter the renderer.
            if (!frame || !active) return false;
            try { return renderer.captureSprite(ctx, img, role, len, angle, screenScale); }
            catch (error) { fail(error); return false; }
        },
        present(source) {
            if (!active || !frame) return false;
            try { renderer.present(source); return true; }
            catch (error) { fail(error); return false; }
        },
        set2D() { wanted = active = false; frame = null; sync(); }
    };
    sync();
})(window);
