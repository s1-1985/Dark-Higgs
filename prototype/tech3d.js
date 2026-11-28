// Automatic regional rig for the existing unrigged GLBs. Rest vertices/UVs stay intact.
// Animation receives only the sprite's existing pose and simulation time, never a target.
import * as T from './vendor/three/three.module.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function prepareTechGeometry(root){
    root.traverse(mesh=>{
        if(!mesh.isMesh||mesh.isSkinnedMesh)return;
        const g=mesh.geometry.clone();g.computeBoundingBox();const b=g.boundingBox,h=b.max.y-b.min.y,w=b.max.x-b.min.x;
        if(h<=0||w<=0){g.dispose();return;}
        const p=g.attributes.position,indices=new Uint16Array(p.count*4),weights=new Float32Array(p.count*4);
        for(let i=0;i<p.count;i++){
            const y=(p.getY(i)-b.min.y)/h,x=(p.getX(i)-(b.min.x+b.max.x)/2)/w;
            let bone=1,second=0,blend=.1;
            if(y>.83){bone=2;second=1;blend=.12;}
            else if(y<.4){const left=x<0;bone=y<.21?(left?9:10):(left?7:8);second=left?7:8;blend=y<.21?.15:.05;}
            else if(Math.abs(x)>.2&&y<.83){const left=x<0;bone=y<.57?(left?4:6):(left?3:5);second=left?3:5;blend=.15;}
            indices[i*4]=bone;indices[i*4+1]=second;weights[i*4]=1-blend;weights[i*4+1]=blend;
        }
        g.setAttribute('skinIndex',new T.Uint16BufferAttribute(indices,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
        g.userData.techBounds={min:b.min.toArray(),max:b.max.toArray()};mesh.geometry=g;
    });
}
export function rigTechInstance(root,color=0x71dfff){
    const originals=[];root.traverse(o=>{if(o.isMesh&&o.geometry.userData.techBounds)originals.push(o);});
    const rigs=[],owned=[];
    for(const old of originals){
        const bounds=old.geometry.userData.techBounds,lo=new T.Vector3().fromArray(bounds.min),hi=new T.Vector3().fromArray(bounds.max),size=hi.clone().sub(lo),h=size.y,cx=(lo.x+hi.x)/2,cz=(lo.z+hi.z)/2;
        const bone=()=>new T.Bone(),bones=Array.from({length:11},bone);
        const bind=(id,parent,x,y,z)=>{bones[parent].add(bones[id]);bones[id].position.set(x,y,z);};
        bind(1,0,cx,lo.y+h*.48,cz);bind(2,1,0,h*.34,0);
        bind(3,1,-size.x*.23,h*.23,0);bind(4,3,0,-h*.19,0);
        bind(5,1,size.x*.23,h*.23,0);bind(6,5,0,-h*.19,0);
        bind(7,0,cx-size.x*.12,lo.y+h*.4,cz);bind(8,0,cx+size.x*.12,lo.y+h*.4,cz);
        bind(9,7,0,-h*.19,0);bind(10,8,0,-h*.19,0);
        const mesh=new T.SkinnedMesh(old.geometry,old.material);mesh.name=old.name;mesh.position.copy(old.position);mesh.rotation.copy(old.rotation);mesh.scale.copy(old.scale);mesh.frustumCulled=false;mesh.add(bones[0]);old.parent.add(mesh);old.parent.remove(old);mesh.updateMatrixWorld(true);
        root.updateMatrixWorld(true);
        const skeleton=new T.Skeleton(bones);mesh.bind(skeleton);mesh.normalizeSkinWeights();
        const glow=new T.MeshBasicMaterial({color,transparent:true,opacity:.85,depthWrite:false});
        const bladeGeometry=new T.CylinderGeometry(h*.012,h*.012,h*.38,5),flashGeometry=new T.SphereGeometry(h*.045,6,4),jetGeometry=new T.ConeGeometry(h*.07,h*.23,7);
        const blade=new T.Mesh(bladeGeometry,glow),flash=new T.Mesh(flashGeometry,glow),jet=new T.Mesh(jetGeometry,glow);
        // Anchor effects to the lowest points in the actual weighted forearm,
        // rather than assuming every faction's hand has the same rest position.
        const positions=old.geometry.attributes.position,skin=old.geometry.attributes.skinIndex,candidates=[];
        for(let i=0;i<positions.count;i++)if(skin.getX(i)===6)candidates.push(new T.Vector3().fromBufferAttribute(positions,i));
        candidates.sort((a,b)=>a.y-b.y);
        const hand=new T.Vector3(cx+size.x*.23,lo.y+h*.4,cz);
        if(candidates.length){hand.set(0,0,0);const n=Math.max(1,Math.ceil(candidates.length*.2));for(let i=0;i<n;i++)hand.add(candidates[i]);hand.multiplyScalar(1/n);}
        mesh.localToWorld(hand);bones[6].worldToLocal(hand);
        blade.position.copy(hand).add(new T.Vector3(0,-h*.19,0));flash.position.copy(hand).add(new T.Vector3(0,0,h*.08));jet.rotation.x=-Math.PI/2;jet.position.set(0,-h*.03,-size.z*.6-h*.08);
        bones[6].add(blade,flash);bones[1].add(jet);rigs.push({bones,blade,flash,jet});owned.push(skeleton,bladeGeometry,flashGeometry,jetGeometry);
    }
    let lastTime=null,blend={fire:0,slash:0,ready:0,thrust:0};
    return {
        update(pose,time){
            const dt=lastTime===null?1/60:clamp(time-lastTime,0,.1);lastTime=time;const k=1-Math.exp(-dt*18);
            for(const key of Object.keys(blend))blend[key]+=(Number(pose===key)-blend[key])*k;
            const wave=Math.sin(time*9),recoil=Math.max(0,Math.sin(time*33));
            for(const {bones:b,blade,flash,jet} of rigs){
                b[1].rotation.x=-.32*blend.thrust;b[1].rotation.y=Math.sin(time*13)*.3*blend.slash;
                b[2].rotation.y=wave*.035;
                b[3].rotation.x=.25*wave*blend.thrust-.4*blend.ready;
                b[5].rotation.x=-1.2*blend.fire-(.8+wave*.8)*blend.slash-.7*blend.ready-.25*wave*blend.thrust;
                b[6].rotation.x=-.6*blend.fire-.4*blend.ready-recoil*.18*blend.fire;
                b[7].rotation.x=wave*.3*blend.thrust;b[8].rotation.x=-wave*.3*blend.thrust;
                b[9].rotation.x=.4*blend.thrust;b[10].rotation.x=.4*blend.thrust;
                blade.visible=blend.ready+blend.slash>.15;flash.visible=blend.fire>.15&&recoil>.6;jet.visible=blend.thrust>.1;
                jet.scale.y=.7+.3*Math.sin(time*28);b[0].updateMatrixWorld(true);
            }
        },
        dispose(){for(const resource of owned)resource.dispose();},
        rigs,
    };
}
