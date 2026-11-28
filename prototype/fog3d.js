// Bounded 12-step volume integration over the already visibility-clipped cloud density.
// The unchanged darkness mask is also applied at the final screen pixel: parallax
// cannot reveal clouds outside the authoritative visible region.
import * as T from './vendor/three/three.module.js';
export function createVolumeFog(){
    const density=new T.CanvasTexture(null),visibility=new T.CanvasTexture(null);
    for(const t of [density,visibility]){t.generateMipmaps=false;t.minFilter=T.LinearFilter;t.magFilter=T.LinearFilter;}
    const material=new T.ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,
        uniforms:{density:{value:density},darkness:{value:visibility},time:{value:0},strength:{value:0},shift:{value:0},steps:{value:12}},
        vertexShader:'varying vec2 uv0; void main(){uv0=uv;gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader:`precision mediump float;
        varying vec2 uv0; uniform sampler2D density; uniform sampler2D darkness;
        uniform float time; uniform float strength; uniform float shift; uniform float steps;
        float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
        float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
        void main(){float visible=1.-texture2D(darkness,uv0).a;
        if(visible<.001||strength<=0.)discard;
        float alpha=0.; vec3 rgb=vec3(0.);
        for(int i=0;i<12;i++){if(float(i)>=steps)break;float z=(float(i)+.5)/steps;
          vec2 p=uv0+vec2(0.,(z-.5)*shift);
          if(p.x<0.||p.y<0.||p.x>1.||p.y>1.)continue;
          vec4 sample0=texture2D(density,p);
          float turbulence=.6+.4*noise(vec3(p*18.+vec2(time*.025,-time*.018),z*3.+time*.035));
          float d=sample0.a*turbulence*sin(z*3.14159265)*strength*2.4/steps;
          float a=(1.-alpha)*d; rgb+=mix(vec3(.08,.22,.36),vec3(.45,.72,.87),z)*a; alpha+=a;
        }
        alpha*=visible;gl_FragColor=vec4(rgb/max(alpha/visible,.0001),alpha);
        }`});
    const scene=new T.Scene();scene.name='visible cloud volume';scene.add(new T.Mesh(new T.PlaneGeometry(2,2),material));
    return {scene,update(source,mask,time,strength,shift,mobile=false){density.image=source;visibility.image=mask;density.needsUpdate=visibility.needsUpdate=true;material.uniforms.time.value=time;material.uniforms.strength.value=strength;material.uniforms.shift.value=shift;material.uniforms.steps.value=mobile?6:12;},dispose(){density.dispose();visibility.dispose();scene.children[0].geometry.dispose();material.dispose();}};
}
