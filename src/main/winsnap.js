'use strict';
// 通过 koffi 调用 user32/dwmapi 枚举可见顶层窗口，用于“吸附到窗口”。加载失败时退化为只吸附屏幕边缘。
let koffi = null;
let api = null;

function init() {
  if (api !== null) return api;
  try {
    koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr lParam)');
    api = {
      RECT, EnumWindowsProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(void *hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ char16_t *buf, int n)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ char16_t *buf, int n)'),
      GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(void *hwnd, int idx)'),
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
      OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ char16_t *buf, _Inout_ uint32 *size)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *handle)'),
      DwmGetRect: dwmapi.func('DwmGetWindowAttribute', 'int', ['void *', 'uint32', koffi.out(koffi.pointer(RECT)), 'uint32']),
      DwmGetInt: dwmapi.func('DwmGetWindowAttribute', 'int', ['void *', 'uint32', koffi.out(koffi.pointer('int32')), 'uint32']),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *r)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hwnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)'),
    };
  } catch (e) {
    console.warn('[winsnap] koffi 不可用，仅吸附屏幕边缘:', e.message);
    api = false;
  }
  return api;
}

function identityOf(hwnd) {
  const a = init(); if (!a) return {};
  const pid = [0], clsBuf = ['\0'.repeat(128)];
  const n = a.GetClassNameW(hwnd, clsBuf, 128);
  a.GetWindowThreadProcessId(hwnd, pid);
  let processName = '';
  const handle = a.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid[0]);
  if (handle) {
    try {
      const size = [32768], buf = ['\0'.repeat(size[0])];
      if (a.QueryFullProcessImageNameW(handle, 0, buf, size)) processName = buf[0].slice(0, size[0]).split(/[\\/]/).pop();
    } finally { a.CloseHandle(handle); }
  }
  return { pid: pid[0], processName, cls: clsBuf[0].slice(0, n) };
}

const SKIP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'ApplicationFrameWindow_Hidden']);

function rectOf(hwnd) {
  const a = init();
  const r = {};
  const hr = a.DwmGetRect(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, r, 16);
  if (hr !== 0) { if (!a.GetWindowRect(hwnd, r)) return null; }
  if (!(r.right > r.left && r.bottom > r.top)) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

// 返回物理像素坐标的窗口列表 [{hwnd(string), title, cls, rect}]，按 Z 序（前→后）
function listWindows(excludeHwnds = []) {
  const a = init();
  if (!a) return [];
  const excl = new Set(excludeHwnds.map(String));
  const out = [];
  const cb = koffi.register((hwnd) => {
    try {
      if (!a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) return true;
      const addr = String(koffi.address(hwnd));
      if (excl.has(addr)) return true;
      const ex = Number(a.GetWindowLongPtrW(hwnd, -20));
      if (ex & 0x80) return true; // WS_EX_TOOLWINDOW
      const tb = ['\0'.repeat(256)];
      let n = a.GetWindowTextW(hwnd, tb, 256);
      const title = n > 0 ? tb[0].slice(0, n) : '';
      if (!title) return true;
      const cbuf = ['\0'.repeat(128)];
      n = a.GetClassNameW(hwnd, cbuf, 128);
      const cls = cbuf[0].slice(0, n);
      if (SKIP_CLASSES.has(cls)) return true;
      const cl = [0];
      a.DwmGetInt(hwnd, 14 /* DWMWA_CLOAKED */, cl, 4);
      if (cl[0]) return true;
      const rect = rectOf(hwnd);
      if (!rect) return true;
      if (rect.right - rect.left < 120 || rect.bottom - rect.top < 80) return true;
      out.push({ hwnd: addr, title, cls, rect, maximized: !!a.IsZoomed(hwnd) });
    } catch (_) { /* ignore */ }
    return true;
  }, koffi.pointer(a.EnumWindowsProc));
  try { a.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return out;
}

function windowRect(hwndStr) {
  const a = init();
  if (!a) return null;
  try {
    const hwnd = koffi.as(BigInt(hwndStr), 'void *');
    if (!a.IsWindow(hwnd) || !a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) return null;
    return rectOf(hwnd);
  } catch (_) { return null; }
}

// 按标题正则找顶层窗口（包含最小化和隐藏到托盘的），返回 { hwnd, title, visible, iconic } 或 null；可见的优先
function findWindow(pattern, processName = null) {
  const a = init(); if (!a) return null;
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  const cands = [];
  const cb = koffi.register((hwnd) => {
    try {
      const ex = Number(a.GetWindowLongPtrW(hwnd, -20)); if (ex & 0x80) return true;
      const style = Number(a.GetWindowLongPtrW(hwnd, -16)) >>> 0;
      const visible = !!a.IsWindowVisible(hwnd);
      if (!visible && (style & 0xC00000) !== 0xC00000) return true; // 隐藏窗口只认带标题栏的主窗口
      const tb = ['\0'.repeat(256)]; const n = a.GetWindowTextW(hwnd, tb, 256); const title = n > 0 ? tb[0].slice(0, n) : '';
      const identity = processName ? identityOf(hwnd) : {};
      if (processName && String(identity.processName).toLowerCase() !== processName.toLowerCase()) return true;
      if (!title || (!processName && !re.test(title))) return true;
      cands.push({ hwnd: String(koffi.address(hwnd)), title, visible, iconic: !!a.IsIconic(hwnd) });
    } catch (_) { /* */ }
    return true;
  }, koffi.pointer(a.EnumWindowsProc));
  try { a.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  cands.sort((x, y) => Number(y.visible) - Number(x.visible));
  return cands[0] || null;
}
// 当前前台窗口 { hwnd, title } 或 null
function foregroundWindow() {
  const a = init(); if (!a) return null;
  try {
    const hwnd = a.GetForegroundWindow(); if (!hwnd) return null;
    const tb = ['\0'.repeat(256)]; const n = a.GetWindowTextW(hwnd, tb, 256);
    return { hwnd: String(koffi.address(hwnd)), title: n > 0 ? tb[0].slice(0, n) : '', ...identityOf(hwnd) };
  } catch (_) { return null; }
}
// 所有带标题的可见顶层窗口（含最小化） [{hwnd,title}]
function titledWindows() {
  const a = init(); if (!a) return [];
  const out = [];
  const cb = koffi.register((hwnd) => {
    try {
      if (!a.IsWindowVisible(hwnd)) return true;
      const ex = Number(a.GetWindowLongPtrW(hwnd, -20)); if (ex & 0x80) return true;
      const tb = ['\0'.repeat(256)]; const n = a.GetWindowTextW(hwnd, tb, 256); if (n <= 0) return true;
      out.push({ hwnd: String(koffi.address(hwnd)), title: tb[0].slice(0, n), iconic: !!a.IsIconic(hwnd), ...identityOf(hwnd) });
    } catch (_) { /* */ }
    return true;
  }, koffi.pointer(a.EnumWindowsProc));
  try { a.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return out;
}
function focusWindow(hwndStr) {
  const a = init(); if (!a) return false;
  try {
    const hwnd = koffi.as(BigInt(hwndStr), 'void *');
    if (!a.IsWindowVisible(hwnd)) a.ShowWindow(hwnd, 5 /* SW_SHOW */);
    if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, 9 /* SW_RESTORE */);
    return !!a.SetForegroundWindow(hwnd);
  } catch (_) { return false; }
}
function available() { return !!init(); }

module.exports = { listWindows, windowRect, available, focusWindow, findWindow, foregroundWindow, titledWindows };
