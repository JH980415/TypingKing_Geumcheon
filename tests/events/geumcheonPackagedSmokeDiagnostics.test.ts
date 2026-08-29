import assert from "node:assert/strict";
import test from "node:test";
import { formatPackagedSmokeFallbackError } from "../../scripts/e2e-geumcheon-packaged-smoke-check";

test("preserves the primary CDP failure when the native fallback also fails", () => {
  const message = formatPackagedSmokeFallbackError(
    "CDP connect failed",
    new Error("native title missing")
  );

  assert.match(message, /CDP connect failed/);
  assert.match(message, /native title missing/);
});
