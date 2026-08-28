import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApprovedUiLaunchEnvironment,
  parseApprovedUiRunOptions
} from "../../scripts/geumcheon-approved-ui-options";

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
