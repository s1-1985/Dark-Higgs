// Local solid geometry. No entity lists, hidden positions, network assets or gameplay state.
import * as T from './vendor/three/three.module.js';
import { mergeGeometries } from './vendor/three/BufferGeometryUtils.js';
const FILES = {
    structure_colony:'colony', structure_derelict:'derelict', node_higgs:'node',
    terrain_rock:'rock', terrain_wreck:'wreck', field_convoy:'convoy', field_cache:'cache',
    field_trap:'cache', field_mine:'mine', drone_turret:'turret', drone_barrier:'barrier',
    drone_buoy:'beacon', drone_decoy:'decoy', fx_decoy:'decoy', lure_ship:'beacon', lure_sos:'beacon',
    fx_field_cloud:'cloud', fx_field_storm:'storm', fx_field_vent:'vent', drone_spray:'cloud',
    drone_missile:'missile', drone_missile_e:'missile', drone_boarder:'boarder',
    station_model:'station', noise_device:'beacon', smoke_cloud:'smoke',
};
const COLORS = { helios:0x8adeff,crow:0xff643d,valkyr:0xffcf35,rustroad:0xc68a46,sanctum:0xbe87ff,fogborn:0x38dfba };
export function worldForSprite(image) {
    const file = /(?:^|\/)([a-z0-9_]+)\.png(?:[?#]|$)/.exec(image.currentSrc || image.src || '')?.[1];
    if (!file) return null;
    const faction = /^f2_(helios|crow|valkyr|rustroad|sanctum|fogborn)_(missile|boarder)$/.exec(file);
    const base = file.replace(/_l(?:base|[0-3])$/, '');
    const kind = faction ? faction[2] : /^bcn_(heat|optic|em|higgs)$/.test(file) ? 'beacon' : FILES[base];
    if (!kind) return null;
    const color = faction ? COLORS[faction[1]] : kind==='vent' ? 0xff9146 : kind==='storm' ? 0xb58aff : 0x64cfff;
    return { id:`world-${kind}-${color}`,kind,role:kind,color,background:['rock','wreck','cloud','storm','vent'].includes(kind) };
}
export function createWorldTemplate(spec) {
    const group=new T.Group(), batches=[[],[],[]];
    const hull=new T.MeshStandardMaterial({color:0x465668,metalness:.62,roughness:.6});
    const glow=new T.MeshStandardMaterial({color:spec.color,emissive:spec.color,emissiveIntensity:.8,roughness:.4});
    const glass=new T.MeshStandardMaterial({color:spec.color,transparent:true,opacity:.24,depthWrite:false,roughness:.3,metalness:.1});
    const add=(g,x=0,y=0,z=0,mat=0,rx=0,ry=0,rz=0)=>{const q=g.index?g.toNonIndexed():g; if(q!==g)g.dispose();q.rotateX(rx);q.rotateY(ry);q.rotateZ(rz);q.translate(x,y,z);batches[mat].push(q);};
    const box=(x,y,z,w,h,d,m=0)=>add(new T.BoxGeometry(w,h,d),x,y,z,m);
    const ring=(r,t,y,m=0,arc=Math.PI*2)=>add(new T.TorusGeometry(r,t,6,24,arc),0,y,0,m,Math.PI/2);
    const core=(r,y,m=1)=>add(new T.IcosahedronGeometry(r,1),0,y,0,m);
    switch(spec.kind){
    case 'colony': case 'station':
        ring(.36,.035,.03);ring(.28,.022,.13);ring(.19,.015,.21,1);
        add(new T.CylinderGeometry(.29,.33,.05,16),0,.03,0);
        add(new T.SphereGeometry(.24,16,8,0,Math.PI*2,0,Math.PI/2),0,.12,0,2);
        for(let i=0;i<12;i++){const a=i*Math.PI/6;box(Math.cos(a)*.4,.015,Math.sin(a)*.4,.16,.05,.045);box(Math.cos(a)*.17,.16+(i%3)*.022,Math.sin(a)*.17,.035,.12,.035,i%3?0:1);}break;
    case 'node':
        ring(.34,.035,0);ring(.23,.016,.15,1);core(.13,.2);
        for(let i=0;i<6;i++){const a=i*Math.PI/3;box(Math.cos(a)*.25,.04,Math.sin(a)*.25,.065,.12,.065);}break;
    case 'rock': add(new T.DodecahedronGeometry(.5,0));break;
    case 'wreck': case 'derelict':
        ring(.33,.035,0,0,Math.PI*1.5);
        for(let i=0;i<9;i++)add(new T.BoxGeometry(.08+(i%3)*.08,.04+(i%2)*.06,.12),Math.sin(i*2.4)*.35,Math.cos(i*1.7)*.08,Math.cos(i*2.4)*.3,0,i*.5,i*.7);
        if(spec.kind==='derelict'){box(0,.08,0,.7,.13,.2);box(.3,.12,0,.18,.08,.15,1);}break;
    case 'convoy':
        box(0,.06,0,.95,.16,.28);box(.38,.15,0,.18,.17,.25);
        for(let i=0;i<4;i++)for(const z of [-.18,.18])box(-.3+i*.16,.15,z,.14,.15,.13,i%3===0?1:0);break;
    case 'cache':box(0,.1,0,.65,.35,.45);for(const x of [-.22,.22])box(x,.1,0,.025,.36,.46,1);break;
    case 'missile':case 'boarder':
        add(new T.CylinderGeometry(.045,.065,.65,8),0,0,0,0,0,0,Math.PI/2);
        add(new T.ConeGeometry(.065,.2,8),.4,0,0,1,0,0,-Math.PI/2);
        for(const z of [-.09,.09])box(-.24,0,z,.18,.025,.18);core(.055,0);break;
    case 'turret':add(new T.CylinderGeometry(.22,.29,.12,8),0,.04,0);core(.15,.16);box(.23,.19,0,.45,.055,.055);break;
    case 'barrier':core(.18,.05);add(new T.SphereGeometry(.48,16,10),0,0,0,2);ring(.38,.012,0,1);break;
    case 'cloud':case 'smoke':case 'storm':case 'vent':
        for(let i=0;i<6;i++)add(new T.SphereGeometry(.2+(i%3)*.035,10,7),Math.sin(i*2.4)*.22,Math.cos(i*1.9)*.1,Math.cos(i*2.4)*.22,2);
        if(spec.kind==='storm'){for(let i=0;i<5;i++)add(new T.CylinderGeometry(.006,.012,.3,4),Math.sin(i*2)*.2,.13,Math.cos(i*2)*.2,1,i*.8,0,i*.5);}
        if(spec.kind==='vent'){core(.1,0);ring(.15,.014,.12,1);ring(.24,.012,.26,1);}break;
    case 'mine':core(.19,.03);for(let i=0;i<3;i++)add(new T.BoxGeometry(.65,.035,.035),0,.03,0,0,0,i*Math.PI/3);break;
    default:core(.15,.06);ring(.25,.018,.02,1);box(0,.17,0,.035,.25,.035);break;
    }
    [hull,glow,glass].forEach((material,i)=>{
        if(!batches[i].length){material.dispose();return;}
        const geometry=mergeGeometries(batches[i]);for(const part of batches[i])part.dispose();
        const mesh=new T.Mesh(geometry,material);mesh.userData.baseOpacity=material.opacity;mesh.userData.volume=i===2;group.add(mesh);
    });
    group.userData.worldKind=spec.kind;
    return group;
}
