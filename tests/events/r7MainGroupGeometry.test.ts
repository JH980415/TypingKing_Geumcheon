import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import postcss from "postcss";

// Source-level regression only. The fixed rectangles below are measured from
// actual R6/R7 EXEs; this projection does not replace final EXE geometry proof.
const stylesheet = postcss.parse(fs.readFileSync("apps/typing-game/src/r7-geumcheon.css", "utf8"));
const heroSelector = 'html[data-event-profile="geumcheon-2026"] .game-app .hero-panel';

test("720p parent adjustment moves every measured group element above R6 without crossing the viewport", () => {
  const declarations: Record<string, string> = {};
  stylesheet.walkAtRules("media", (media) => {
    if (media.params !== "(max-width: 1366px), (max-height: 768px)") return;
    media.walkRules(heroSelector, (rule) => {
      rule.walkDecls((declaration) => { declarations[declaration.prop] = declaration.value; });
    });
  });
  assert.ok(declarations["padding-top"], "small viewport must explicitly set its parent padding");
  const padding = Number.parseFloat(declarations["padding-top"]);
  const margin = Number.parseFloat(declarations["margin-top"] ?? "0");
  assert.ok(Number.isFinite(padding) && Number.isFinite(margin));
  const additionalShift = margin + padding - 6;
  const panelTop = 14 + margin;
  const projected = [23, 221.078125, 279.078125, 488.671875].map((top) => top + additionalShift);
  const before = [31, 229.078125, 260.078125, 469.671875];
  projected.forEach((top, index) => assert.ok(top < before[index], `group element ${index + 1} must move up: projected ${top}, R6 ${before[index]}`));
  assert.ok(panelTop >= 0, "panel must remain within viewport");
  assert.ok(projected[0] >= panelTop + 3, "logo must remain below the panel's 3px top border");
  assert.ok(projected[3] + 167.296875 <= 710, "all guide lines remain inside the stretched panel");
  assert.deepEqual([
    projected[1] - (projected[0] + 180),
    projected[2] - (projected[1] + 54),
    projected[3] - (projected[2] + 201.59375)
  ], [18.078125, 4, 8]);
  assert.deepEqual(Object.keys(declarations).sort(), ["margin-top", "padding-top"], "correction only moves the parent; no child scaling, font or clipping changes");
});

test("desktop parent keeps the measured 24px upward move and no negative margin", () => {
  const declarations: Record<string, string> = {};
  stylesheet.walkRules(heroSelector, (rule) => {
    if (rule.parent?.type !== "root") return;
    rule.walkDecls((declaration) => { declarations[declaration.prop] = declaration.value; });
  });
  assert.deepEqual(declarations, { "padding-top": "calc(clamp(28px, 5.2vh, 76px) - 24px)" });
});
