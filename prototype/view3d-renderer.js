import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

import { modelForSprite, createModelCache, spritePlacement } from './unit-models.js?v=20261128-units2';
const COS = Math.cos(35 * Math.PI / 180), SIN = Math.sin(35 * Math.PI / 180);
export async function createRenderer({ onFailure }) {
    const output = document.createElement('canvas');
    output.id = 'gameCanvas3D'; output.setAttribute('aria-hidden', 'true');
    let webgl;
    try { webgl = new THREE.WebGLRenderer({ canvas: output, alpha: false, antialias: true, powerPreference: 'high-performance' }); }
    catch (error) { throw new Error('WebGL2 is unavailable', { cause: error }); }
    webgl.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    webgl.outputColorSpace = THREE.SRGBColorSpace;
    webgl.autoClear = false;
    output.addEventListener('webglcontextlost', event => { event.preventDefault(); onFailure(new Error('WebGL context lost')); });
    const copy = document.createElement('canvas'), copyCtx = copy.getContext('2d');
    const texture = new THREE.CanvasTexture(copy);
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    const backdrop = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false, toneMapped: false }));
    backdrop.add(quad);
    const flatCamera = new THREE.Camera();
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xc2dded, 0x33303b, 2.6));
    const key = new THREE.DirectionalLight(0xffeee0, 3.5); key.position.set(-100, 300, 120); scene.add(key);
    const rim = new THREE.DirectionalLight(0x77b3d5, 1.7); rim.position.set(100, 50, -150); scene.add(rim);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100000);
    function release(template) {
        const geometries = new Set(), materials = new Set(), textures = new Set();
        template.traverse(o => { if (o.isMesh) { geometries.add(o.geometry); for (const m of [].concat(o.material)) { materials.add(m); for (const v of Object.values(m)) if (v?.isTexture) textures.add(v); } } });
        for (const t of textures) { t.dispose(); if (t.image?.close) t.image.close(); }
        for (const m of materials) m.dispose(); for (const g of geometries) g.dispose();
    }
    const cache = createModelCache(async spec => {
        const gltf = await new GLTFLoader().loadAsync(spec.url);
        // Some generated aircraft are rolled onto their side. Correct in model space
        // before measuring bounds so their width, height and length remain consistent.
        const model = new THREE.Group(); model.add(gltf.scene);
        model.rotation.z = spec.roll || 0;
        const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        // Tech is upright: include height in its size, rather than enlarging its narrow footprint.
        const length = spec.role === 'mech' ? Math.max(size.x, size.y, size.z) : Math.max(size.x, size.z);
        if (!Number.isFinite(length) || length <= 0) { release(model); throw new Error('Invalid model bounds'); }
        model.position.sub(center);
        const normalized = new THREE.Group(); normalized.add(model);
        normalized.scale.setScalar(1 / length); normalized.rotation.y = spec.yaw;
        return normalized;
    }, release, (spec, error) => console.warn(`3D model ${spec.id} unavailable; retaining sprite`, error));
    document.getElementById('game-container').insertBefore(output, document.getElementById('gameCanvas'));
    const pools = new Map();
    let disposed = false;
    let frame, width = 0, height = 0;
    return {
        setVisible(on) { output.style.display = on ? 'block' : 'none'; },
        dispose() {
            output.remove();
            if (disposed) return;
            disposed = true;
            for (const pool of pools.values()) for (const obj of pool.objects) obj.traverse(o => {
                if (o.isMesh) for (const material of [].concat(o.material)) material.dispose();
            });
            cache.dispose(); pools.clear();
            texture.dispose(); quad.geometry.dispose(); quad.material.dispose(); webgl.dispose();
        },
        beginFrame(info) {
            frame = info;
            for (const pool of pools.values()) { pool.count = 0; for (const model of pool.objects) model.visible = false; }
            if (info.width !== width || info.height !== height) {
                width = info.width; height = info.height;
                webgl.setSize(width, height, false);
                const pixels = webgl.getDrawingBufferSize(new THREE.Vector2());
                copy.width = pixels.x; copy.height = pixels.y;
                camera.left = -width / 2; camera.right = width / 2;
                camera.top = height / 2; camera.bottom = -height / 2;
                camera.updateProjectionMatrix();
            }
            camera.position.set(0, 20000 * COS, 20000 * SIN); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
        },
        captureSprite(ctx, img, role, len, angle, screenScale) {
            if (disposed || !frame || ctx.globalAlpha <= 0) return false;
            const spec = modelForSprite(img);
            if (!spec) return false;
            const placement = spritePlacement(ctx.getTransform(), frame, len, screenScale);
            if (!placement) return false;
            const template = cache.get(spec);
            if (!template) return false; // draw the original sprite while this specific model loads
            const { x, y, length } = placement;
            let pool = pools.get(spec.id);
            if (!pool) { pool = { objects: [], count: 0 }; pools.set(spec.id, pool); }
            let obj = pool.objects[pool.count++];
            if (!obj) {
                obj = new THREE.Group(); obj.add(template.clone(true));
                // Geometry/textures are shared; instance materials preserve existing fade/death alpha.
                obj.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
                scene.add(obj); pool.objects.push(obj);
            }
            const alpha = ctx.globalAlpha;
            obj.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) {
                const transparent = alpha < 1;
                if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
                m.opacity = alpha; m.depthWrite = !transparent;
            } });
            obj.position.set(x - width / 2, 0, (y - height / 2) / COS);
            obj.rotation.y = -angle;
            obj.scale.setScalar(length); obj.visible = true;
            return true;
        },
        present(source) {
            // Existing fog, terrain, contacts and weapon indicators are reused as drawn, not recomputed.
            copyCtx.clearRect(0, 0, copy.width, copy.height);
            copyCtx.drawImage(source, 0, 0, copy.width, copy.height);
            texture.needsUpdate = true;
            webgl.clear(); webgl.render(backdrop, flatCamera);
            webgl.clearDepth(); webgl.render(scene, camera);
        }
    };
}
