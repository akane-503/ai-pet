'use strict';
// 托盘应用的所有窗口都不占任务栏，显示/恢复也不能改变这个约定。
let nativeApi;
function forceToolWindow(win) {
  if(process.platform!=='win32'||!win.getNativeWindowHandle)return;
  if(!nativeApi){
    const koffi=require('koffi'),user32=koffi.load('user32.dll');
    nativeApi={koffi,
      isWindow:user32.func('bool __stdcall IsWindow(void *hwnd)'),
      pid:user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd,_Out_ uint32 *pid)'),
      get:user32.func('intptr __stdcall GetWindowLongPtrW(void *hwnd,int index)'),
      set:user32.func('intptr __stdcall SetWindowLongPtrW(void *hwnd,int index,intptr value)'),
      frame:user32.func('bool __stdcall SetWindowPos(void *hwnd,void *after,int x,int y,int width,int height,uint32 flags)')};
  }
  const a=nativeApi,b=win.getNativeWindowHandle(),id=b.length>=8?b.readBigUInt64LE(0):BigInt(b.readUInt32LE(0)),hwnd=a.koffi.as(id,'void *');
  if(!a.isWindow(hwnd))return;
  const pid=[0];a.pid(hwnd,pid);if(pid[0]!==process.pid)return;
  const before=Number(a.get(hwnd,-20)),after=(before|0x80)&~0x40000;
  if(before!==after){a.set(hwnd,-20,after);a.frame(hwnd,null,0,0,0,0,0x237);}
}
function keepOffTaskbar(win) {
  const apply=()=>{
    if(win.isDestroyed())return;
    win.setSkipTaskbar(true);
    try{forceToolWindow(win);}catch(e){console.warn('[taskbar]',e.message);}
  };
  apply();win.on('show',apply);win.on('restore',apply);
  return apply;
}
module.exports={keepOffTaskbar};
