import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildApprovedUiLaunchEnvironment,
  parseApprovedUiRunOptions,
  resolveGeumcheonE2eArtifactRoot,
  resolveGeumcheonR2ReleaseRoot
} from "../../scripts/geumcheon-approved-ui-options";

test("routes R2 E2E artifacts under test_artifacts and rejects path escape", () => {
  const projectRoot = path.resolve("C:\\typingking");

  assert.equal(
    resolveGeumcheonE2eArtifactRoot(projectRoot, "geumcheon_approved_ui"),
    path.join(projectRoot, "test_artifacts", "geumcheon_approved_ui")
  );
  assert.equal(
    resolveGeumcheonE2eArtifactRoot(
      projectRoot,
      "geumcheon_approved_ui",
      "test_artifacts/geumcheon_approved_ui_r2_20260828"
    ),
    path.join(projectRoot, "test_artifacts", "geumcheon_approved_ui_r2_20260828")
  );
  assert.throws(
    () => resolveGeumcheonE2eArtifactRoot(projectRoot, "geumcheon_approved_ui", "Codex/Evidence/R2"),
    /outside test_artifacts/
  );
  assert.throws(
    () => resolveGeumcheonE2eArtifactRoot(projectRoot, "geumcheon_approved_ui", "test_artifacts/R2/nested"),
    /direct child/
  );
});

test("routes R2 release output only under Codex Outputs R2 release", () => {
  const projectRoot = path.resolve("C:\\typingking");

  assert.equal(
    resolveGeumcheonR2ReleaseRoot(projectRoot, "Codex/Outputs/R2/01_Release/geumcheon-client-release"),
    path.join(projectRoot, "Codex", "Outputs", "R2", "01_Release", "geumcheon-client-release")
  );
  assert.throws(
    () => resolveGeumcheonR2ReleaseRoot(projectRoot, "release-geumcheon"),
    /outside Codex\/Outputs\/R2\/01_Release/
  );
  assert.throws(
    () => resolveGeumcheonR2ReleaseRoot(projectRoot, "Codex/Outputs/R2/01_Release"),
    /must be a child directory/
  );
  assert.throws(
    () => resolveGeumcheonR2ReleaseRoot(projectRoot, "Codex/Outputs/R2/01_Release/nested/release"),
    /direct child/
  );
});

test("keeps the automated review hidden and screenshot-driven by default", () => {
  const options = parseApprovedUiRunOptions([]);

  assert.deepEqual(options, {
    mode: "automated",
    captureScreens: true,
    waitForUserClose: false
  });
  assert.deepEqual(buildApprovedUiLaunchEnvironment(options), {
    TYPINGKING_E2E_PROFILE: "approved-ui",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1",
    TYPINGKING_E2E_HIDE_WINDOW: "1"
  });
});

test("keeps every interactive review visible until the user closes it", () => {
  for (const variant of ["ai", "ai-leaderboard", "practice", "practice-leaderboard"] as const) {
    const options = parseApprovedUiRunOptions(["--interactive", `--variant=${variant}`]);
    const environment = buildApprovedUiLaunchEnvironment(options);

    assert.deepEqual(options, {
      mode: "interactive",
      variant,
      captureScreens: false,
      waitForUserClose: true
    });
    assert.equal("TYPINGKING_E2E_HIDE_WINDOW" in environment, false);
    assert.equal("NODE_TLS_REJECT_UNAUTHORIZED" in environment, false);
  }
});

test("rejects incomplete or unsupported interactive review options", () => {
  assert.throws(
    () => parseApprovedUiRunOptions(["--interactive"]),
    /requires --variant/
  );
  assert.throws(
    () => parseApprovedUiRunOptions(["--interactive", "--variant=production"]),
    /Unsupported Geumcheon review variant/
  );
  assert.throws(
    () => parseApprovedUiRunOptions(["--variant=ai"]),
    /requires --interactive/
  );
  assert.throws(
    () => parseApprovedUiRunOptions(["--interactive", "--variant=ai", "--use-production-nas"]),
    /Unknown Geumcheon review option/
  );
});
