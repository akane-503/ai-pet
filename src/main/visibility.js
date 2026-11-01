'use strict';
const { coversMonitor } = require('../shared/geometry');
function shouldHideForFullscreen({showOverFullscreen=true,foreground,rect,monitor,ownWindows=[]}) {
  if(showOverFullscreen!==false||!foreground||!rect||!monitor)return false;
  if(ownWindows.includes(String(foreground.hwnd))||/^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$/i.test(foreground.cls||''))return false;
  return coversMonitor(rect,monitor);
}
function petVisible({manualHidden=false,fullscreenHidden=false}) {return !manualHidden&&!fullscreenHidden;}
module.exports={shouldHideForFullscreen,petVisible};
