import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { UNIT_MODELS, modelForSprite, createModelCache, spritePlacement } from '../prototype/unit-models.js';
const specs = Object.values(UNIT_MODELS);
assert.equal(specs.length,12);
for (const spec of specs) {
    assert.equal(modelForSprite({ src: `https://game/assets/f2_${spec.id.replace('-', '_')}.png?v=2` }),spec);
    if(spec.role==='mech') for(const pose of ['ready','fire','thrust','slash']) assert.equal(modelForSprite({src:`assets/f2_${spec.id.replace('-','_')}_${pose}.png`}),spec);
    const data=fs.readFileSync(new URL(spec.url));
    assert.equal(data.toString('ascii',0,4),'glTF'); assert.equal(data.readUInt32LE(4),2); assert.equal(data.readUInt32LE(8),data.length);
    const doc=JSON.parse(data.toString('utf8',20,20+data.readUInt32LE(12)));
    assert(doc.images.every(im=>im.bufferView!==undefined&&!im.uri));
    assert(doc.buffers.every(buffer=>!buffer.uri));
    assert(doc.materials.every(m=>(m.alphaMode||'OPAQUE')==='OPAQUE'));
    const triangles=doc.meshes.flatMap(m=>m.primitives).reduce((n,p)=>n+doc.accessors[p.indices].count/3,0);
    assert(triangles<=((spec.role==='fighter'||spec.role==='scout')?5000:12000));
    const record=JSON.parse(fs.readFileSync('prototype/assets/models/model-preparation-report.json')).find(x=>x.id===spec.id);
    assert.equal(triangles,record.triangles); assert.equal(crypto.createHash('sha256').update(data).digest('hex'),record.sha256);
}
for (const src of ['assets/f2_valkyr_assault.png','assets/f2_crow_missile.png','assets/f2_crow_boarder.png','assets/f2_crow_assault_fire.png','assets/e_fighter.png']) assert.equal(modelForSprite({src}),null);
const frame={width:844,height:390,dpr:2,zoom:.08};
assert.equal(spritePlacement({a:2,b:0,e:100,f:200},frame,32,.24).length,7.68,'drone minimum size must survive the 3D hook');
assert.equal(spritePlacement({a:0,b:2*Math.cos(35*Math.PI/180),e:100,f:200},frame,32).length,32,'projected rotated scale');
assert.equal(spritePlacement({a:2,b:0,e:-2000,f:200},frame,32,.24),null,'offscreen sprites must not start loading');
// Loader is deliberately deferred to prove deduplication, throttling, failure isolation and late disposal.
let pending=[],loads=[],released=[],failed=[];
const cache=createModelCache(spec=>new Promise((resolve,reject)=>{loads.push(spec.id);pending.push({id:spec.id,resolve,reject});}),v=>released.push(v),(spec)=>failed.push(spec.id));
const tick=()=>new Promise(r=>setImmediate(r));
for(const spec of specs.slice(0,3)){assert.equal(cache.get(spec),null);assert.equal(cache.get(spec),null);}
await tick();assert.deepEqual(loads,specs.slice(0,2).map(s=>s.id));
pending[0].resolve('first');await tick();assert.equal(cache.get(specs[0]),'first');assert.equal(loads.length,3);
pending[1].reject(new Error('missing'));await tick();assert.equal(cache.get(specs[1]),null);assert.equal(failed.length,1);assert.equal(loads.length,3);
cache.dispose();assert.deepEqual(released,['first']);pending[2].resolve('late');await tick();assert.deepEqual(released,['first','late']);assert.equal(cache.get(specs[0]),null);
console.log('PASS: 12 embedded GLBs / hashes / triangle budgets; exact sprite mapping and Tech aliases; screen scale and culling; lazy load concurrency / dedup / isolated failure / disposal.');
