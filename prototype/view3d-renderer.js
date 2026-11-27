import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

// One experimental asset. Unknown sprites retain the original renderer; never substitute another faction's model.
const MODEL_SOURCE = new URL('./assets/models/crow-assault.glb', import.meta.url).href;
const CROW_SPRITE = /(?:^|\/)f2_crow_assault\.png(?:\?|$)/;
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
    let template;
    try {
        const gltf = await new GLTFLoader().loadAsync(MODEL_SOURCE);
        template = gltf.scene;
        const box = new THREE.Box3().setFromObject(template), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        template.position.sub(center);
        const normalized = new THREE.Group(); normalized.add(template);
        const length = Math.max(size.x, size.z);
        if (!Number.isFinite(length) || length <= 0) throw new Error('Invalid ship model bounds');
        normalized.scale.setScalar(1 / length);
        normalized.rotation.y = Math.PI / 2; // glTF +Z bow -> simulation +X bow; world +Z = map down.
        template = normalized;
    } catch (error) {
        texture.dispose(); quad.geometry.dispose(); quad.material.dispose(); webgl.dispose(); throw error;
    }
    document.getElementById('game-container').insertBefore(output, document.getElementById('gameCanvas'));
    const pool = [];
    let frame, count = 0, width = 0, height = 0;
    return {
        setVisible(on) { output.style.display = on ? 'block' : 'none'; },
        dispose() {
            output.remove();
            const geometries = new Set(), materials = new Set(), textures = new Set();
            template.traverse(o => { if (o.isMesh) { geometries.add(o.geometry); for (const m of [].concat(o.material)) { materials.add(m); for (const v of Object.values(m)) if (v?.isTexture) textures.add(v); } } });
            for (const t of textures) t.dispose(); for (const m of materials) m.dispose(); for (const g of geometries) g.dispose();
            texture.dispose(); quad.geometry.dispose(); quad.material.dispose(); webgl.dispose();
        },
        beginFrame(info) {
            frame = info; count = 0;
            for (const model of pool) model.visible = false;
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
        captureSprite(ctx, img, role, len, angle) {
            if (role !== 'assault' || !CROW_SPRITE.test(img.currentSrc || img.src || '')) return false;
            const t = ctx.getTransform();
            const x = t.e / frame.dpr, y = t.f / frame.dpr;
            const length = len * frame.zoom;
            // Preserve the original viewport culling / tiny-ship icons. Nothing hidden gets a 3D model.
            if (x < -length || x > width + length || y < -length || y > height + length) return false;
            let obj = pool[count++];
            if (!obj) {
                obj = new THREE.Group(); obj.add(template.clone(true)); scene.add(obj); pool.push(obj);
            }
            obj.position.set(x - width / 2, 0, (y - height / 2) / COS);
            obj.rotation.y = -angle;
            obj.scale.setScalar(length);
            obj.visible = true;
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
