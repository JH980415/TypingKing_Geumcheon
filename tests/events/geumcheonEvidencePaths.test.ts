import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  toPortableCssFileReference,
  toPortableProjectPath
} from "../../scripts/geumcheon-evidence-paths";

test("writes project evidence paths without leaking the host absolute path", () => {
  const projectRoot = path.resolve("C:\\typingking");
  const screenshot = path.join(
    projectRoot,
    "test_artifacts",
    "geumcheon_approved_ui_r2_20260828",
    "1280x720",
    "main-ai.png"
  );

  assert.equal(
    toPortableProjectPath(projectRoot, screenshot),
    "test_artifacts/geumcheon_approved_ui_r2_20260828/1280x720/main-ai.png"
  );
  assert.throws(
    () => toPortableProjectPath(projectRoot, path.resolve("C:\\outside", "evidence.png")),
    /outside project root/
  );
});

test("stores computed file backgrounds as portable project paths", () => {
  const projectRoot = path.resolve("C:\\사용자\\typingking");
  const assetPath = path.join(projectRoot, "events", "geumcheon-2026", "assets", "background.png");
  const computedStyle = `url(\"${pathToFileURL(assetPath).href}\")`;

  assert.equal(
    toPortableCssFileReference(projectRoot, computedStyle),
    "events/geumcheon-2026/assets/background.png"
  );
});
