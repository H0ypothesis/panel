import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePreviewCursor,
  windowCursorPoint,
  type PreviewCursorSample,
} from "./cua-preview-cursor.ts";

test("native cursor uses screen points and refuses missing or outside window geometry", () => {
  const bounds = { x: -800, y: 30, width: 800, height: 500 };
  assert.deepEqual(windowCursorPoint({ x: -600, y: 130 }, bounds), {
    x: 0.25,
    y: 0.2,
  });
  for (const position of [null, {}, { x: NaN, y: 130 }, { x: 50, y: 130 }])
    assert.equal(windowCursorPoint(position, bounds), undefined);
  assert.equal(
    windowCursorPoint({ x: 1, y: 2 }, { ...bounds, width: 0 }),
    undefined,
  );
});

test("browser cursor uses CSS viewport dimensions including drag endpoints, and hides unproven geometry", () => {
  const sample: PreviewCursorSample = {
    type: "cursor",
    scopeId: "a",
    id: "click",
    visible: true,
    space: "viewport",
    x: 250,
    y: 100,
    toX: 750,
    toY: 300,
    action: "drag",
    pressed: false,
    durationMs: 650,
    reducedMotion: false,
    timestamp: 1,
  };
  const cursor = normalizePreviewCursor(sample, { width: 1000, height: 500 });
  assert.equal(cursor.x, 0.25);
  assert.equal(cursor.y, 0.2);
  assert.equal(cursor.toX, 0.75);
  assert.equal(cursor.toY, 0.6);
  assert.equal("space" in cursor, false);
  for (const viewport of [
    undefined,
    { width: 0, height: 500 },
    { width: 100, height: 50 },
  ])
    assert.equal(normalizePreviewCursor(sample, viewport).visible, false);
});
