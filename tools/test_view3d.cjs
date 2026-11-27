const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process');
const game=fs.readFileSync('prototype/game.js','utf8');
const base=cp.execFileSync('git',['show','dbaba2128ca6674a8999145b8cfc7bb200e6fc16:prototype/game.js'],{encoding:'utf8',maxBuffer:5e6});
function fragment(s,a,b){const i=s.indexOf(a),j=s.indexOf(b,i+1);assert(i>=0&&j>i);return s.slice(i,j)}
// Display integration must not modify the authoritative step or the enemy visibility gate.
assert.equal(fragment(game,'function stepWorld(', 'let _rfc ='),fragment(base,'function stepWorld(', 'let _rfc ='));
assert.equal(fragment(game,'    draw(ctx) {\n        // 第16弾: 敵の艦影', '    drawSensorTrace('),fragment(base,'    draw(ctx) {\n        // 第16弾: 敵の艦影','    drawSensorTrace('));
const sandbox={window:{},document:{getElementById:()=>null},console:{warn(){}}};vm.createContext(sandbox);vm.runInContext(fs.readFileSync('prototype/view3d.js','utf8'),sandbox);
assert.equal(sandbox.window.Experimental3D.isActive(),false,'2D must remain the startup default');
let active=false;const camera={x:1234,y:5678,zoom:.08};const rect={left:7,top:9,width:844,height:390};
const env={window:{Experimental3D:sandbox.window.Experimental3D},Experimental3D:{isActive:()=>active,projection:sandbox.window.Experimental3D.projection},cssW:844,cssH:390,camera,canvas:{getBoundingClientRect:()=>rect},player:{},logMessage(){}};
vm.createContext(env);vm.runInContext(fragment(game,'function view3DActive()', '// カメラ追従フラグ'),env);
for(const on of [false,true])for(const [width,height] of [[844,390],[390,844],[1366,900]])for(const zoom of [.01,.08,2]){
 active=on;env.cssW=width;env.cssH=height;camera.zoom=zoom;rect.width=width;rect.height=height;
 for(const [x,y] of [[camera.x,camera.y],[2000,9000],[10000,10000]]){
  const screen=env.worldToScreen(x,y),world=env.screenToWorld(screen.sx+rect.left,screen.sy+rect.top);
  assert(Math.abs(world.x-x)<1e-8&&Math.abs(world.y-y)<1e-8,'project/unproject must preserve target coordinates');
 }
 for(const sc of [.5,1]){const t=env.viewWorldTransform(zoom*sc),p=env.worldToScreen(2000,9000);assert(Math.abs((t[0]*2000+t[4])-p.sx*sc)<1e-8&&Math.abs((t[3]*9000+t[5])-p.sy*sc)<1e-8,'offscreen fog/cloud mask must align with world projection');}
 const b=env.viewBounds(),top=env.screenToWorld(rect.left,rect.top),bottom=env.screenToWorld(rect.left+width,rect.top+height);
 assert(Math.abs(b.y-top.y)<1e-8&&Math.abs(b.h-(bottom.y-top.y))<1e-8,'radar must show actual tilted viewport');
 const delta=env.dragDeltaWorld(15,20),a=env.screenToWorld(rect.left+100,rect.top+100),bb=env.screenToWorld(rect.left+115,rect.top+120);
 assert(Math.abs(delta.dx-(bb.x-a.x))<1e-8&&Math.abs(delta.dy-(bb.y-a.y))<1e-8,'pan must match picking coordinates');
}
// Exercise the actual radar handlers: click/touch primary, drag, cancellation, and keyboard.
const handlers={};let toggles=0;env.minimapCanvas={addEventListener:(k,f)=>{handlers[k]=f},setPointerCapture(){}};env.toggleField3D=()=>toggles++;
vm.runInContext(fragment(game,'// Radar tap:','// Background grid system'),env);
const event=(x=10,y=10,extra={})=>({clientX:x,clientY:y,pointerId:1,button:0,isPrimary:true,preventDefault(){},stopPropagation(){},...extra});
const saved=JSON.stringify(camera);
handlers.pointerdown(event());handlers.pointerup(event());assert.equal(toggles,1);
handlers.pointerdown(event());handlers.pointermove(event(80,80));handlers.pointerup(event(80,80));assert.equal(toggles,1);
handlers.pointerdown(event());handlers.pointercancel();handlers.pointerup(event());assert.equal(toggles,1);
handlers.pointerdown(event());handlers.pointerdown(event(10,10,{isPrimary:false,pointerId:2}));handlers.pointerup(event());assert.equal(toggles,1);
handlers.keydown(event(0,0,{key:'Enter'}));assert.equal(toggles,2);
assert.equal(JSON.stringify(camera),saved,'radar interactions must not move camera or change zoom');
console.log('PASS: original simulation and visibility gate unchanged; 2D default; projection/picking/pan/radar across 3 sizes × 3 zooms × 2 modes; radar tap/drag/cancel/multitouch/keyboard.');
