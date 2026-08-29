import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import {
  buildForcedExitChildEnvironment,
  forceKillExactProcess,
  isExactProcessAlive,
  resolveElectronMainPid
} from "../../scripts/e2e-geumcheon-forced-exit-check";
import {
  buildPackagedSmokeChildEnvironment,
  buildPackagedSmokeRuntimeConfig
} from "../../scripts/e2e-geumcheon-packaged-smoke-check";

const inheritedEnvironment = {
  PATH: "C:\\Windows\\System32",
  NODE_EXTRA_CA_CERTS: "C:\\host\\untrusted-ca.pem",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  THIRD_PARTY_API_KEY: "inherited-api-key",
  TYPINGKING_TEST_ADMIN_PASSWORD: "inherited-password"
};

test("forced-exit child environment filters inherited secrets and TLS overrides", () => {
  const environment = buildForcedExitChildEnvironment(
    {
      NODE_EXTRA_CA_CERTS: "C:\\runtime\\local-ca.pem",
      NO_PROXY: "127.0.0.1,localhost",
      TK_E2E_TOKEN: "explicit-synthetic-token"
    },
    inheritedEnvironment
  );

  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "C:\\runtime\\local-ca.pem");
  assert.equal(environment.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(environment.TK_E2E_TOKEN, "explicit-synthetic-token");
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(environment.THIRD_PARTY_API_KEY, undefined);
  assert.equal(environment.TYPINGKING_TEST_ADMIN_PASSWORD, undefined);
});

test("packaged-smoke child environment filters inherited secrets and TLS overrides", () => {
  const environment = buildPackagedSmokeChildEnvironment(
    {
      NODE_EXTRA_CA_CERTS: "C:\\runtime\\local-ca.pem",
      NO_PROXY: "127.0.0.1,localhost",
      TK_SMOKE_PFX_PASSWORD: "explicit-synthetic-password"
    },
    inheritedEnvironment
  );

  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "C:\\runtime\\local-ca.pem");
  assert.equal(environment.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(environment.TK_SMOKE_PFX_PASSWORD, "explicit-synthetic-password");
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(environment.THIRD_PARTY_API_KEY, undefined);
  assert.equal(environment.TYPINGKING_TEST_ADMIN_PASSWORD, undefined);
});

test("forced-exit child environment opts into the hidden functional-flow profile", () => {
  const environment = buildForcedExitChildEnvironment({}, inheritedEnvironment);

  assert.deepEqual({
    profile: environment.TYPINGKING_E2E_PROFILE,
    suppressDialogs: environment.TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS,
    hideWindow: environment.TYPINGKING_E2E_HIDE_WINDOW
  }, {
    profile: "functional-flow",
    suppressDialogs: "1",
    hideWindow: "1"
  });
});

test("packaged-smoke child environment opts into the hidden packaged profile", () => {
  const environment = buildPackagedSmokeChildEnvironment({}, inheritedEnvironment);

  assert.deepEqual({
    profile: environment.TYPINGKING_E2E_PROFILE,
    suppressDialogs: environment.TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS,
    hideWindow: environment.TYPINGKING_E2E_HIDE_WINDOW
  }, {
    profile: "packaged-smoke",
    suppressDialogs: "1",
    hideWindow: "1"
  });
});

test("packaged-smoke runtime config uses a non-placeholder synthetic admin password", () => {
  const config = buildPackagedSmokeRuntimeConfig("synthetic-admin-password-20260828");

  assert.equal(config.adminPassword, "synthetic-admin-password-20260828");
  assert.notEqual(config.adminPassword, DEFAULT_CONFIG.adminPassword);
  assert.notEqual(config.adminPassword, "CHANGE_ME_BEFORE_EVENT");
});

test("forced-exit resolves the Electron main PID instead of the launcher wrapper PID", async () => {
  const application = {
    evaluate: async () => 27_496
  };

  assert.equal(await resolveElectronMainPid(application), 27_496);
});

test("forced-exit rejects an unsafe Electron main PID", async () => {
  const application = {
    evaluate: async () => 0
  };

  await assert.rejects(() => resolveElectronMainPid(application), /exact positive PID/);
});

test("forced-exit terminates the exact process without a taskkill wrapper", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  try {
    await once(child, "spawn");
    assert.ok(child.pid);
    assert.equal(isExactProcessAlive(child.pid), true);
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });

    forceKillExactProcess(child.pid);

    await exited;
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    assert.equal(isExactProcessAlive(child.pid), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
