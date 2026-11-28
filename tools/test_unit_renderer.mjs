// CPU integration of the real renderer and Three scene graph; no GPU/FPS claim.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as Three from '../prototype/vendor/three/three.module.js';
import * as Models from '../prototype/unit-models.js';
let meshScene, downloads=0, materialDisposals=0, geometryDisposals=0;
class WebGLRenderer {
    setPixelRatio() {} setSize(w,h) { this.width=w;this.height=h; }
    getDrawingBufferSize(v) { return v.set(this.width,this.height); }
    clear() {} clearDepth() {} dispose() {}
    render(scene) { if(scene.children.some(o=>o.isHemisphereLight)) meshScene=scene; }
}
class GLTFLoader {
    async loadAsync(url) {
        downloads++;
        const material=new Three.MeshStandardMaterial(); material.addEventListener('dispose',()=>materialDisposals++);
        const geometry=url.includes('rustroad-fighter') ? new Three.BoxGeometry(1,8,2) : new Three.BoxGeometry(2,1,8); geometry.addEventListener('dispose',()=>geometryDisposals++);
        const scene=new Three.Group();scene.add(new Three.Mesh(geometry,material));return {scene};
    }
}
const noop=()=>{};
const canvas=()=>({style:{},setAttribute:noop,addEventListener:noop,remove:noop,getContext:()=>({clearRect:noop,drawImage:noop})});
const context=vm.createContext({console,document:{createElement:canvas,getElementById:()=>({insertBefore:noop})},window:{devicePixelRatio:2}});
function synthetic(exports) { return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context}); }
const three=synthetic({...Three,WebGLRenderer}),loader=synthetic({GLTFLoader}),models=synthetic(Models);
const module=new vm.SourceTextModule(fs.readFileSync('prototype/view3d-renderer.js','utf8'),{context});
await module.link(name=>name.includes('three.module')?three:name.includes('GLTFLoader')?loader:models);await module.evaluate();
const renderer=await module.namespace.createRenderer({onFailure:e=>{throw e;}});
const frame={width:800,height:600,dpr:2,zoom:.5};renderer.beginFrame(frame);
const ctx={globalAlpha:1,getTransform:()=>({a:1,b:0,e:800,f:600})};
const helios={src:'assets/f2_helios_assault.png'},crow={src:'assets/f2_crow_assault.png'};
assert.equal(downloads,0,'initializing 3D must not download unseen models');
assert.equal(renderer.captureSprite(ctx,helios,'assault',100,.4,.5),false);
await new Promise(r=>setImmediate(r));
assert.equal(renderer.captureSprite(ctx,helios,'assault',100,.4,.5),true);
assert.equal(renderer.captureSprite(ctx,crow,'assault',100,0,.5),false);
await new Promise(r=>setImmediate(r));assert.equal(renderer.captureSprite(ctx,crow,'assault',100,0,.5),true);
renderer.present({});let objects=meshScene.children.filter(o=>o.isGroup);assert.equal(objects.length,2);
assert.equal(objects[0].rotation.y,-.4);assert.equal(objects[0].scale.x,50);assert.equal(objects[0].position.x,0);assert.equal(objects[0].position.z,0);
assert.equal(objects[0].children[0].rotation.y,Math.PI/2);assert.equal(objects[0].children[0].scale.x,1/8);
renderer.beginFrame(frame);assert(objects.every(o=>!o.visible));
ctx.globalAlpha=.4;renderer.captureSprite(ctx,helios,'assault',100,0,.5);renderer.present({});
objects=meshScene.children.filter(o=>o.isGroup);assert.equal(objects.length,2,'reuse pool per model');assert(!objects[1].visible,'no stale enemy model');
const materials=[];objects[0].traverse(o=>{if(o.isMesh)materials.push(o.material);});assert.equal(materials[0].opacity,.4);assert(materials[0].transparent);
assert.equal(downloads,2);
renderer.beginFrame(frame);ctx.globalAlpha=1;
const rolled={src:'assets/f2_rustroad_fighter.png'};
assert.equal(renderer.captureSprite(ctx,rolled,'fighter',100,0,.5),false);
await new Promise(r=>setImmediate(r));assert.equal(renderer.captureSprite(ctx,rolled,'fighter',100,0,.5),true);
renderer.present({});objects=meshScene.children.filter(o=>o.isGroup);
assert.equal(objects.length,3,'new faction has its own model pool');
const corrected=objects[2].children[0];
assert.equal(corrected.rotation.y,-Math.PI/2,'reviewed reverse heading');
assert(Math.abs(corrected.children[0].rotation.z-Math.PI/2)<1e-10,'sideways source gets roll correction');
assert(Math.abs(corrected.scale.x-1/8)<1e-10,'measure bounds after roll, so the 8-unit wing span sets scale');
assert.equal(downloads,3);renderer.dispose();renderer.dispose();assert.equal(geometryDisposals,3);assert.equal(materialDisposals,3);
console.log('PASS: real renderer scene graph / model bounds / yaw / scale / roll before sizing / separate faction pools / frame visibility reset / alpha / resource disposal (CPU).');
