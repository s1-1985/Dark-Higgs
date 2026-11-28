import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { worldForSprite, createWorldTemplate } from './world3d.js?v=20261128-world1';
import { createVolumeFog } from './fog3d.js?v=20261128-world1';
import { prepareTechGeometry, rigTechInstance } from './tech3d.js?v=20261128-world1';

import { modelForSprite, createModelCache, spritePlacement } from './unit-models.js?v=20261128-world1';
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
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    backdrop.add(quad);
    const flatCamera = new THREE.Camera();
    const scene = new THREE.Scene();
    scene.name = 'visible entities';
    scene.add(new THREE.HemisphereLight(0xc2dded, 0x33303b, 2.6));
    const key = new THREE.DirectionalLight(0xffeee0, 3.5); key.position.set(-100, 300, 120); scene.add(key);
    const rim = new THREE.DirectionalLight(0x77b3d5, 1.7); rim.position.set(100, 50, -150); scene.add(rim);
    const terrain = new THREE.Scene();
    terrain.name = 'terrain under darkness';
    for (const light of scene.children) terrain.add(light.clone());
    const medium = new THREE.Scene(); medium.name = 'local smoke under entities';
    for (const light of scene.children) medium.add(light.clone());
    const fog = createVolumeFog();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100000);
    function release(template) {
        const geometries = new Set(), materials = new Set(), textures = new Set();
        template.traverse(o => { if (o.isMesh) { geometries.add(o.geometry); for (const m of [].concat(o.material)) { materials.add(m); for (const v of Object.values(m)) if (v?.isTexture) textures.add(v); } } });
        for (const t of textures) { t.dispose(); if (t.image?.close) t.image.close(); }
        for (const m of materials) m.dispose(); for (const g of geometries) g.dispose();
    }
    const cache = createModelCache(async spec => {
        if (spec.kind) return createWorldTemplate(spec);
        const gltf = await new GLTFLoader().loadAsync(spec.url);
        if (spec.role === 'mech') prepareTechGeometry(gltf.scene);
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
    let frame, width = 0, height = 0, backgroundReady = false, fogFrame = null;
    const placementTransform = new THREE.Object3D();
    function transfer(source) {
        copyCtx.clearRect(0, 0, copy.width, copy.height);
        copyCtx.drawImage(source, 0, 0, copy.width, copy.height);
        texture.needsUpdate = true;
        webgl.render(backdrop, flatCamera);
    }
    return {
        setVisible(on) { output.style.display = on ? 'block' : 'none'; },
        dispose() {
            output.remove();
            if (disposed) return;
            disposed = true;
            for (const pool of pools.values()) for (const obj of pool.objects) {
                obj.userData.tech?.dispose(); const materials = new Set();
                obj.traverse(o => { if (o.isMesh) for (const material of [].concat(o.material)) materials.add(material); });
                for (const material of materials) material.dispose();
            }
            for (const pool of pools.values()) for (const batch of pool.batches || []) { batch.geometry.dispose(); batch.material.dispose(); }
            cache.dispose(); pools.clear();
            fog.dispose();
            texture.dispose(); quad.geometry.dispose(); quad.material.dispose(); webgl.dispose();
        },
        beginFrame(info) {
            frame = info;
            backgroundReady = false; fogFrame = null;
            for (const pool of pools.values()) { pool.count = 0; for (const model of pool.objects) model.visible = false; for (const batch of pool.batches || []) { batch.count = 0; batch.visible = false; } }
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
            const spec = modelForSprite(img) || worldForSprite(img);
            if (!spec) return false;
            const placement = spritePlacement(ctx.getTransform(), frame, len, screenScale);
            if (!placement) return false;
            const template = cache.get(spec);
            if (!template) return false; // draw the original sprite while this specific model loads
            const { x, y, length } = placement;
            let pool = pools.get(spec.id);
            if (!pool) { pool = { objects: [], count: 0 }; pools.set(spec.id, pool); }
            const limit = spec.kind ? (spec.kind === 'rock' ? 160 : spec.kind === 'wreck' ? 80 : 40) : 128;
            if (pool.count >= limit) return false; // bounded 3D work; retain the existing sprite above budget
            if (spec.kind === 'rock' || spec.kind === 'wreck') {
                if (!pool.batches) {
                    pool.batches = [];
                    template.traverse(o => { if (o.isMesh) {
                        const geometry = o.geometry.clone(), material = o.material.clone();
                        geometry.setAttribute('instanceAlpha', new THREE.InstancedBufferAttribute(new Float32Array(limit), 1));
                        material.transparent = true;
                        material.onBeforeCompile = shader => {
                            shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float instanceAlpha; varying float vInstanceAlpha;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha=instanceAlpha;');
                            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vInstanceAlpha;').replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a *= vInstanceAlpha;');
                        };
                        material.customProgramCacheKey = () => 'world-instance-alpha-v1';
                        const batch = new THREE.InstancedMesh(geometry, material, limit); batch.frustumCulled = false; batch.count = 0;
                        terrain.add(batch); pool.batches.push(batch);
                    } });
                }
                const transform = placementTransform;
                transform.position.set(x - width / 2, 0, (y - height / 2) / COS); transform.rotation.y = -angle;
                transform.scale.set(length, length * (spec.kind === 'rock' ? .5 : 1), length * (spec.kind === 'rock' ? .8 : 1)); transform.updateMatrix();
                for (const batch of pool.batches) {
                    batch.setMatrixAt(pool.count, transform.matrix); batch.instanceMatrix.needsUpdate = true;
                    batch.geometry.attributes.instanceAlpha.setX(pool.count, ctx.globalAlpha); batch.geometry.attributes.instanceAlpha.needsUpdate = true;
                    batch.count = pool.count + 1; batch.visible = true;
                }
                pool.count++; return true;
            }
            let obj = pool.objects[pool.count++];
            if (!obj) {
                obj = new THREE.Group(); obj.add(template.clone(true));
                // Geometry/textures are shared; instance materials preserve existing fade/death alpha.
                obj.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
                if (spec.role === 'mech') obj.userData.tech = rigTechInstance(obj);
                (spec.background ? terrain : spec.kind === 'smoke' ? medium : scene).add(obj); pool.objects.push(obj);
            }
            const alpha = ctx.globalAlpha;
            obj.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) {
                const opacity = alpha * (o.userData.baseOpacity ?? 1);
                const transparent = opacity < 1;
                if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
                m.opacity = opacity; m.depthWrite = !transparent;
            } });
            obj.position.set(x - width / 2, 0, (y - height / 2) / COS);
            obj.rotation.y = -angle;
            obj.scale.setScalar(length); obj.visible = true;
            if (spec.kind === 'rock') obj.scale.set(length, length * .5, length * .8);
            if (spec.kind === 'cloud' || spec.kind === 'storm' || spec.kind === 'vent') obj.rotation.y += (frame.time || 0) * .06;
            if (obj.userData.tech) {
                const pose = /_mech_(fire|ready|slash|thrust)\.png/.exec(img.currentSrc || img.src || '')?.[1] || '';
                obj.userData.tech.update(pose, frame.time || 0);
            }
            return true;
        },
        background(source) {
            if (!frame || disposed) return false;
            webgl.clear(); transfer(source); webgl.clearDepth(); webgl.render(terrain, camera);
            backgroundReady = true;
            return true;
        },
        captureFog(source, mask, strength) {
            if (!frame || disposed || !source?.width || !mask?.width) return false;
            fogFrame = { source, mask, strength }; return true;
        },
        present(source) {
            // Darkness/2D effects cover the terrain pass before the clipped cloud volume.
            if (!backgroundReady) webgl.clear();
            transfer(source);
            if (fogFrame) {
                fog.update(fogFrame.source, fogFrame.mask, frame.time || 0, fogFrame.strength,
                    Math.min(.09, Math.max(.004, frame.zoom * 160 / height)), frame.mobile);
                webgl.render(fog.scene, flatCamera);
            }
            webgl.clearDepth(); webgl.render(medium, camera);
            webgl.clearDepth(); webgl.render(scene, camera);
        }
    };
}
