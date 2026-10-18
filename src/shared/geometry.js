'use strict';
(function (root) {
  function windowSize(scale) {
    const base = Math.round(260 * Math.max(0.5, Math.min(2.4, Number(scale) || 1)));
    const padding = Math.ceil(Math.max(12, base * 0.04));
    return { base, padding, width: base + padding * 2, height: base + padding * 2 };
  }
  function clampPosition(rect, area) {
    return {
      x: Math.max(area.x, Math.min(rect.x, area.x + Math.max(0, area.width - rect.width))),
      y: Math.max(area.y, Math.min(rect.y, area.y + Math.max(0, area.height - rect.height))),
    };
  }
  function workArea(display, taskbars) {
    const b = display.bounds, area = { ...display.workArea };
    // Native probing unavailable: retain Electron's safe fallback, including other app bars.
    if (!Array.isArray(taskbars)) return area;
    let right = area.x + area.width, bottom = area.y + area.height;
    for (const bar of taskbars) {
      if (bar.displayId !== display.id) continue;
      const r = bar.rect;
      const visibleWidth = Math.max(0, Math.min(r.right, b.x + b.width) - Math.max(r.left, b.x));
      const visibleHeight = Math.max(0, Math.min(r.bottom, b.y + b.height) - Math.max(r.top, b.y));
      const hidden = !bar.visible || bar.autoHide || (bar.edge === 'left' || bar.edge === 'right' ? visibleWidth : visibleHeight) <= 3;
      if (!hidden) {
        if (bar.edge === 'left') area.x = Math.max(area.x, r.right);
        if (bar.edge === 'right') right = Math.min(right, r.left);
        if (bar.edge === 'top') area.y = Math.max(area.y, r.bottom);
        if (bar.edge === 'bottom') bottom = Math.min(bottom, r.top);
        continue;
      }
      if (bar.edge === 'left') area.x = b.x;
      if (bar.edge === 'right') right = b.x + b.width;
      if (bar.edge === 'top') area.y = b.y;
      if (bar.edge === 'bottom') bottom = b.y + b.height;
    }
    area.width = right - area.x; area.height = bottom - area.y;
    return area;
  }
  const geometry = { windowSize, clampPosition, workArea };
  if (typeof module === 'object' && module.exports) module.exports = geometry;
  else root.PetGeometry = geometry;
})(typeof globalThis === 'object' ? globalThis : this);
