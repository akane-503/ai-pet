'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../src/shared/geometry');
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
const bar = { displayId: 1, edge: 'bottom', visible: true, autoHide: false, rect: { left: 0, top: 1032, right: 1920, bottom: 1080 } };
test('renderer and native window use bounded scale and padding on both sides', () => {
  for (const scale of [0, -1, 0.5, 1.25, 2.2, 2.4, 100, NaN, Infinity]) {
    const size = geometry.windowSize(scale);
    assert.ok(size.base >= 130 && size.base <= 624);
    assert.ok(size.padding >= 12 && size.padding >= size.base * 0.04);
    assert.equal(size.width, size.base + size.padding * 2);
    assert.equal(size.height, size.width);
  }
});
test('fixed visible taskbar reserves space; hidden and auto-hide taskbars release stale space', () => {
  assert.deepEqual(geometry.workArea(display, [bar]), display.workArea);
  for (const changed of [{ visible: false }, { autoHide: true }, { rect: { ...bar.rect, top: 1078 } }]) {
    assert.deepEqual(geometry.workArea(display, [{ ...bar, ...changed }]), display.bounds);
  }
  assert.deepEqual(geometry.workArea(display, null), display.workArea);
});
test('visible taskbar still reserves its rectangle when Electron reports a stale full work area', () => {
  assert.deepEqual(geometry.workArea({ ...display, workArea: display.bounds }, [bar]), display.workArea);
});

test('fullscreen occlusion releases the taskbar reserve only on the covered monitor and restores it afterwards', () => {
  assert.deepEqual(geometry.workArea(display, [{ ...bar, occludedByFullscreen: true }]), display.bounds);
  assert.deepEqual(geometry.workArea(display, [{ ...bar, displayId: 2, occludedByFullscreen: true }, bar]), display.workArea);
  assert.deepEqual(geometry.workArea(display, [{ ...bar, occludedByFullscreen: false }]), display.workArea);
});

test('fullscreen detection requires covering all four monitor edges, not just a maximized work area', () => {
  const monitor = { left: 1920, top: -100, right: 2820, bottom: 1340 };
  assert.equal(geometry.coversMonitor({ ...monitor }, monitor), true);
  assert.equal(geometry.coversMonitor({ ...monitor, left: 1919, bottom: 1341 }, monitor), true);
  assert.equal(geometry.coversMonitor({ ...monitor, bottom: 1292 }, monitor), false);
  assert.equal(geometry.coversMonitor({ ...monitor, left: 1950 }, monitor), false);
  assert.equal(geometry.coversMonitor(null, monitor), false);
});
test('taskbar visibility is applied per monitor and preserves reservations on other edges', () => {
  assert.deepEqual(geometry.workArea(display, [{ ...bar, displayId: 2, visible: false }]), display.workArea);
  assert.deepEqual(geometry.workArea({ ...display, workArea: { x: 40, y: 0, width: 1880, height: 1032 } }, [{ ...bar, visible: false }]), { x: 40, y: 0, width: 1880, height: 1080 });
  const portrait = { id: 2, bounds: { x: -900, y: 100, width: 900, height: 1440 }, workArea: { x: -852, y: 100, width: 852, height: 1440 } };
  assert.deepEqual(geometry.workArea(portrait, [{ displayId: 2, edge: 'left', visible: false, rect: { left: -900, top: 100, right: -852, bottom: 1540 } }]), portrait.bounds);
});
test('clamping keeps all four character edges inside the selected display without resizing it', () => {
  const area = { x: -900, y: 100, width: 900, height: 1440 };
  assert.deepEqual(geometry.clampPosition({ x: -1000, y: -20, width: 200, height: 250 }, area), { x: -900, y: 100 });
  assert.deepEqual(geometry.clampPosition({ x: -50, y: 1500, width: 200, height: 250 }, area), { x: -200, y: 1290 });
  assert.deepEqual(geometry.clampPosition({ x: -500, y: 600, width: 200, height: 250 }, area), { x: -500, y: 600 });
});
