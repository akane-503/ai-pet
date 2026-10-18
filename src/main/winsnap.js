'use strict';
// 通过 koffi 调用 user32/dwmapi 枚举可见顶层窗口，用于“吸附到窗口”。加载失败时退化为只吸附屏幕边缘。
let koffi = null;
let api = null;
const { coversMonitor } = require('../shared/geometry');

function init() {
  if (api !== null) return api;
  try {
    koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const shell32 = koffi.load('shell32.dll');
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr lParam)');
    const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
    const APPBARDATA = koffi.struct('APPBARDATA', { cbSize: 'uint32', hWnd: 'void *', uCallbackMessage: 'uint32', uEdge: 'uint32', rc: RECT, lParam: 'intptr' });
    api = {
      RECT, EnumWindowsProc, MONITORINFO, APPBARDATA,
      MonitorFromWindow: user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32 flags)'),
      GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ MONITORINFO *info)'),
      SHAppBarMessage: shell32.func('uintptr __stdcall SHAppBarMessage(uint32 msg, _Inout_ APPBARDATA *data)'),
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
      WindowFromPoint: user32.func('void * __stdcall WindowFromPoint(POINT point)'),
      GetAncestor: user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 flags)'),
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

// WS_VISIBLE remains set when fullscreen video covers the taskbar. Probe its actual
// screen surface, including when the pet or a small floating window has focus.
function coveredByFullscreen(a, taskbar, rect, monitor) {
  const left = Math.max(rect.left, monitor.left), top = Math.max(rect.top, monitor.top);
  const right = Math.min(rect.right, monitor.right), bottom = Math.min(rect.bottom, monitor.bottom);
  if (right <= left || bottom <= top) return false;
  const horizontal = right - left >= bottom - top;
  for (const fraction of [0.15, 0.5, 0.85]) {
    const point = { x: Math.floor(left + (right - left) * (horizontal ? fraction : 0.5)), y: Math.floor(top + (bottom - top) * (horizontal ? 0.5 : fraction)) };
    const hit = a.WindowFromPoint(point);
    if (!hit) continue;
    const root = a.GetAncestor(hit, 2 /* GA_ROOT */);
    if (!root || koffi.address(root) === koffi.address(taskbar)) continue;
    const cls = ['\0'.repeat(128)];
    const n = a.GetClassNameW(root, cls, 128);
    if (/^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$/.test(cls[0].slice(0, n))) continue;
    // Both APIs use the calling process's DPI coordinate system. DWM bounds do not.
    const bounds = {};
    if (a.GetWindowRect(root, bounds) && coversMonitor(bounds, monitor)) return true;
  }
  return false;
}

// 只读查询任务栏状态与所属显示器；不修改系统自动隐藏设置。
function taskbars() {
  const a = init(); if (!a) return null;
  const out = [];
  let failed = false;
  const cb = koffi.register(hwnd => {
    try {
      const name = ['\0'.repeat(128)];
      const n = a.GetClassNameW(hwnd, name, 128);
      if (!/^Shell_(Secondary)?TrayWnd$/.test(name[0].slice(0, n))) return true;
      const info = { cbSize: koffi.sizeof(a.MONITORINFO) };
      if (!a.GetMonitorInfoW(a.MonitorFromWindow(hwnd, 2), info)) { failed = true; return true; }
      const rect = {}; if (!a.GetWindowRect(hwnd, rect)) { failed = true; return true; }
      const monitor = info.rcMonitor;
      const horizontal = rect.right - rect.left >= rect.bottom - rect.top;
      const edge = horizontal
        ? (Math.abs(rect.top - monitor.top) < Math.abs(rect.bottom - monitor.bottom) ? 'top' : 'bottom')
        : (Math.abs(rect.left - monitor.left) < Math.abs(rect.right - monitor.right) ? 'left' : 'right');
      const state = a.SHAppBarMessage(4, { cbSize: koffi.sizeof(a.APPBARDATA) });
      out.push({ rect, monitor, edge, visible: !!a.IsWindowVisible(hwnd), autoHide: !!(Number(state) & 1), occludedByFullscreen: coveredByFullscreen(a, hwnd, rect, monitor) });
    } catch (_) { failed = true; }
    return true;
  }, koffi.pointer(a.EnumWindowsProc));
  try { if (!a.EnumWindows(cb, 0)) failed = true; } finally { koffi.unregister(cb); }
  return failed ? null : out;
}

module.exports = { listWindows, windowRect, available, focusWindow, findWindow, foregroundWindow, titledWindows, taskbars };
