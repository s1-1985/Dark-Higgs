#!/usr/bin/env python3
"""Compile the actual fog shaders and test pixels in an offscreen Mesa GLES context.
No browser, display, gameplay or network is involved. Requires libEGL with surfaceless GLES.
"""
import ctypes as C
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]
E=C.CDLL('libEGL.so.1');V=C.c_void_p;I=C.c_int;U=C.c_uint;F=C.c_float
E.eglGetProcAddress.restype=V;E.eglGetProcAddress.argtypes=[C.c_char_p]
def gl(name,ret,*args):
    address=E.eglGetProcAddress(name.encode())
    if not address: raise RuntimeError('Unavailable GLES entry point: '+name)
    return C.CFUNCTYPE(ret,*args)(address)
get_display=C.CFUNCTYPE(V,U,V,C.POINTER(I))(E.eglGetProcAddress(b'eglGetPlatformDisplayEXT'))
display=get_display(0x31DD,None,None)
E.eglInitialize.argtypes=[V,C.POINTER(I),C.POINTER(I)];major=I();minor=I()
assert E.eglInitialize(display,C.byref(major),C.byref(minor)), 'Surfaceless EGL unavailable'
E.eglBindAPI(0x30A0);E.eglChooseConfig.argtypes=[V,C.POINTER(I),C.POINTER(V),I,C.POINTER(I)]
config=V();count=I();attributes=(I*13)(0x3033,1,0x3040,4,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3038)
assert E.eglChooseConfig(display,attributes,C.byref(config),1,C.byref(count)) and count.value
E.eglCreatePbufferSurface.restype=V;E.eglCreatePbufferSurface.argtypes=[V,V,C.POINTER(I)]
surface=E.eglCreatePbufferSurface(display,config,(I*5)(0x3057,32,0x3056,32,0x3038))
E.eglCreateContext.restype=V;E.eglCreateContext.argtypes=[V,V,V,C.POINTER(I)]
context=E.eglCreateContext(display,config,None,(I*3)(0x3098,3,0x3038))
E.eglMakeCurrent.argtypes=[V,V,V,V];assert E.eglMakeCurrent(display,surface,surface,context)

shaders=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {createVolumeFog} from './prototype/fog3d.js'; const f=createVolumeFog(); const m=f.scene.children[0].material; console.log(JSON.stringify({v:m.vertexShader,f:m.fragmentShader})); f.dispose();"],cwd=ROOT,text=True))
create_shader=gl('glCreateShader',U,U);source=gl('glShaderSource',None,U,I,C.POINTER(C.c_char_p),C.POINTER(I));compile_shader=gl('glCompileShader',None,U);shader_iv=gl('glGetShaderiv',None,U,U,C.POINTER(I));shader_log=gl('glGetShaderInfoLog',None,U,I,C.POINTER(I),C.c_char_p)
def compile_one(kind,text):
    shader=create_shader(kind);string=C.c_char_p(text.encode());source(shader,1,C.byref(string),None);compile_shader(shader);status=I();shader_iv(shader,0x8B81,C.byref(status))
    if not status.value:
        log=C.create_string_buffer(8192);shader_log(shader,8192,None,log);raise AssertionError(log.value.decode())
    return shader
vertex=compile_one(0x8B31,'precision highp float; attribute vec3 position; attribute vec2 uv;\n'+shaders['v'])
fragment=compile_one(0x8B30,shaders['f'])
program=gl('glCreateProgram',U)();gl('glAttachShader',None,U,U)(program,vertex);gl('glAttachShader',None,U,U)(program,fragment);gl('glLinkProgram',None,U)(program)
status=I();gl('glGetProgramiv',None,U,U,C.POINTER(I))(program,0x8B82,C.byref(status));assert status.value,'Fog shader link failed'
gl('glUseProgram',None,U)(program)
vertices=(F*20)(-1,-1,0,0,0, 1,-1,0,1,0, -1,1,0,0,1, 1,1,0,1,1)
buffer=U();gl('glGenBuffers',None,I,C.POINTER(U))(1,C.byref(buffer));gl('glBindBuffer',None,U,U)(0x8892,buffer);gl('glBufferData',None,U,C.c_ssize_t,V,U)(0x8892,C.sizeof(vertices),vertices,0x88E4)
for name,offset,n in [(b'position',0,3),(b'uv',12,2)]:
    index=gl('glGetAttribLocation',I,U,C.c_char_p)(program,name);gl('glEnableVertexAttribArray',None,U)(index);gl('glVertexAttribPointer',None,U,I,U,U,I,V)(index,n,0x1406,0,20,V(offset))
location=gl('glGetUniformLocation',I,U,C.c_char_p);uniform=gl('glUniform1f',None,I,F)
for name,value in [('time',4),('strength',.8),('shift',.06),('steps',6)]:uniform(location(program,name.encode()),value)
textures=(U*2)();gl('glGenTextures',None,I,C.POINTER(U))(2,textures)
def texture(unit,data):
    gl('glActiveTexture',None,U)(0x84C0+unit);gl('glBindTexture',None,U,U)(0x0DE1,textures[unit])
    for name,value in [(0x2801,0x2601),(0x2800,0x2601),(0x2802,0x812F),(0x2803,0x812F)]:gl('glTexParameteri',None,U,U,I)(0x0DE1,name,value)
    pixels=(C.c_ubyte*len(data))(*data);gl('glTexImage2D',None,U,I,I,I,I,I,U,U,V)(0x0DE1,0,0x1908,32,32,0,0x1908,0x1401,pixels)
    gl('glUniform1i',None,I,I)(location(program,b'density' if unit==0 else b'darkness'),unit)
def render():
    gl('glClearColor',None,F,F,F,F)(0,0,0,0);gl('glClear',None,U)(0x4000);gl('glViewport',None,I,I,I,I)(0,0,32,32);gl('glDrawArrays',None,U,I,I)(0x0005,0,4)
    pixels=(C.c_ubyte*(32*32*4))();gl('glReadPixels',None,I,I,I,I,U,U,V)(0,0,32,32,0x1908,0x1401,pixels);assert gl('glGetError',U)()==0;return list(pixels)
texture(0,[255,255,255,230]*1024)
texture(1,[component for y in range(32) for x in range(32) for component in (0,0,0,255 if x<16 else 0)])
for steps in [6,12]:
    uniform(location(program,b'steps'),steps);pixels=render();hidden=[pixels[(y*32+x)*4+3] for y in range(32) for x in range(14)];visible=[pixels[(y*32+x)*4+3] for y in range(32) for x in range(18,32)]
    assert max(hidden)==0, 'Parallax fog leaked outside the darkness mask';assert min(visible)>0,'Visible density missing'
uniform(location(program,b'strength'),0);assert max(render())==0,'Disabled fog must leave no pixels'
uniform(location(program,b'strength'),.8);texture(1,[0,0,0,255]*1024);assert max(render())==0,'Unknown area must be completely clipped'
texture(1,[0,0,0,0]*1024);texture(0,[0,0,0,0]*1024);assert max(render())==0,'Beam-cleared density must remain clear'
print('PASS: actual fog GLSL compiled/linked/rendered with Mesa GLES; 6/12 steps, zero hidden pixels, zero disabled/unknown/beam-cleared pixels.')
