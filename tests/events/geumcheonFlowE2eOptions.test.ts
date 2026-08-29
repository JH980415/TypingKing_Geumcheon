import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as forcedExitHarness from "../../scripts/e2e-geumcheon-forced-exit-check";
import {
  resolveForcedExitArtifactRoot,
  startLocalHealthServer,
  stopHttpsServer,
  writeSyntheticProfiles
} from "../../scripts/e2e-geumcheon-forced-exit-check";
import {
  resolveCountdownArtifactRoot,
  shouldKeepCountdownEvidence,
  writeCountdownDeviceProfile
} from "../../scripts/e2e-geumcheon-countdown-interruption-check";

test("taskkill exit race is accepted only after the child actually exits", async () => {
  const waitForTaskkillExitRace = (forcedExitHarness as unknown as {
    waitForTaskkillExitRace?: (
      child: { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null },
      timeoutMs: number
    ) => Promise<boolean>;
  }).waitForTaskkillExitRace;

  assert.equal(typeof waitForTaskkillExitRace, "function");
  if (!waitForTaskkillExitRace) return;

  const exitingChild = { pid: process.pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  setTimeout(() => { exitingChild.exitCode = 1; }, 10);
  assert.equal(await waitForTaskkillExitRace(exitingChild, 250), true);
  assert.equal(
    await waitForTaskkillExitRace({ pid: process.pid, exitCode: null, signalCode: null }, 120),
    false
  );
  assert.equal(
    await waitForTaskkillExitRace({ pid: 2_147_483_647, exitCode: null, signalCode: null }, 120),
    true
  );
});

test("forced-exit evidence capture preserves screenshot errors as diagnostics", async () => {
  const captureEvidenceDiagnostic = (forcedExitHarness as unknown as {
    captureEvidenceDiagnostic?: (capture: () => Promise<void>) => Promise<{ ok: boolean; error?: string }>;
  }).captureEvidenceDiagnostic;

  assert.equal(typeof captureEvidenceDiagnostic, "function");
  if (!captureEvidenceDiagnostic) return;
  assert.deepEqual(await captureEvidenceDiagnostic(async () => undefined), { ok: true });
  assert.deepEqual(
    await captureEvidenceDiagnostic(async () => { throw new Error("screenshot timeout"); }),
    { ok: false, error: "screenshot timeout" }
  );
});

test("required Electron evaluation retries one garbage-collected promise only", async () => {
  const evaluateRequiredElectronProbe = (forcedExitHarness as unknown as {
    evaluateRequiredElectronProbe?: <T>(
      evaluate: () => Promise<T>
    ) => Promise<{ value: T; retryCount: number; errors: string[] }>;
  }).evaluateRequiredElectronProbe;

  assert.equal(typeof evaluateRequiredElectronProbe, "function");
  if (!evaluateRequiredElectronProbe) return;

  let recoveredAttempts = 0;
  const recovered = await evaluateRequiredElectronProbe(async () => {
    recoveredAttempts += 1;
    if (recoveredAttempts === 1) throw new Error("Resulting promise was garbage collected.");
    return 200;
  });
  assert.deepEqual(recovered, {
    value: 200,
    retryCount: 1,
    errors: ["Resulting promise was garbage collected."]
  });
  assert.equal(recoveredAttempts, 2);

  let nonGcAttempts = 0;
  await assert.rejects(
    () => evaluateRequiredElectronProbe(async () => {
      nonGcAttempts += 1;
      throw new Error("TLS certificate rejected");
    }),
    /retryCount=0.*TLS certificate rejected/
  );
  assert.equal(nonGcAttempts, 1);

  let exhaustedAttempts = 0;
  await assert.rejects(
    () => evaluateRequiredElectronProbe(async () => {
      exhaustedAttempts += 1;
      throw new Error("Resulting promise was garbage collected.");
    }),
    /retryCount=1.*Resulting promise was garbage collected/
  );
  assert.equal(exhaustedAttempts, 2);
});

function postJson(input: {
  url: string;
  caPemPath: string;
  token: string;
  deviceId: string;
  idempotencyKey: string;
  body: unknown;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const request = https.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      ca: fs.readFileSync(input.caPemPath),
      headers: {
        authorization: `Bearer ${input.token}`,
        "x-device-id": input.deviceId,
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
        connection: "close"
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.once("error", reject);
    request.end(JSON.stringify(input.body));
  });
}

test("Geumcheon flow E2E artifact override is limited to explicit R2 test_artifacts folders", () => {
  const projectRoot = path.resolve("C:\\project\\TypingKing");
  const forcedDefault = resolveForcedExitArtifactRoot({}, projectRoot);
  const countdownDefault = resolveCountdownArtifactRoot({}, projectRoot);

  assert.equal(forcedDefault, path.join(projectRoot, "test_artifacts", "geumcheon_forced_exit_e2e"));
  assert.equal(countdownDefault, path.join(projectRoot, "test_artifacts", "geumcheon_countdown_interruption_e2e"));

  const r2Root = path.join(projectRoot, "test_artifacts", "R2", "flow-run-001");
  assert.equal(resolveForcedExitArtifactRoot({ TYPINGKING_E2E_ARTIFACT_ROOT: r2Root }, projectRoot), r2Root);
  assert.equal(resolveCountdownArtifactRoot({ TYPINGKING_E2E_ARTIFACT_ROOT: r2Root }, projectRoot), r2Root);

  for (const unsafe of [
    path.join(projectRoot, "test_artifacts", "geumcheon_forced_exit_e2e"),
    path.join(projectRoot, "test_artifacts", "R1", "flow-run-001"),
    path.join(projectRoot, "outside"),
    path.join(projectRoot, "test_artifacts", "R2", "..", "..", "outside")
  ]) {
    assert.throws(
      () => resolveForcedExitArtifactRoot({ TYPINGKING_E2E_ARTIFACT_ROOT: unsafe }, projectRoot),
      /TYPINGKING_E2E_ARTIFACT_ROOT/
    );
    assert.throws(
      () => resolveCountdownArtifactRoot({ TYPINGKING_E2E_ARTIFACT_ROOT: unsafe }, projectRoot),
      /TYPINGKING_E2E_ARTIFACT_ROOT/
    );
  }
});

test("synthetic flow profiles write a non-placeholder admin password config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-flow-options-"));
  try {
    const forcedRoot = path.join(root, "forced");
    const countdownRoot = path.join(root, "countdown");

    writeSyntheticProfiles(forcedRoot, "https://127.0.0.1:1");
    writeCountdownDeviceProfile(countdownRoot);

    for (const dir of [forcedRoot, countdownRoot]) {
      const config = JSON.parse(fs.readFileSync(path.join(dir, "runtime", "config", "config.json"), "utf8")) as {
        adminPassword?: unknown;
      };
      assert.equal(typeof config.adminPassword, "string");
      assert.notEqual(config.adminPassword, "");
      assert.notEqual(config.adminPassword, "CHANGE_ME_BEFORE_EVENT");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("countdown synthetic profile binds bootstrap credentials to the same local API", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-countdown-profile-"));
  try {
    const apiBaseUrl = "https://127.0.0.1:10443";
    const writeWithApiBaseUrl = writeCountdownDeviceProfile as unknown as (
      dir: string,
      apiBaseUrl: string
    ) => void;

    writeWithApiBaseUrl(root, apiBaseUrl);

    const bootstrapPath = path.join(root, "bootstrap-credentials.json");
    assert.equal(fs.existsSync(bootstrapPath), true);
    const device = JSON.parse(fs.readFileSync(path.join(root, "device-profile.json"), "utf8")) as {
      apiBaseUrl?: unknown;
    };
    const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8")) as {
      apiBaseUrl?: unknown;
      token?: unknown;
    };
    assert.equal(device.apiBaseUrl, apiBaseUrl);
    assert.equal(bootstrap.apiBaseUrl, apiBaseUrl);
    assert.match(String(bootstrap.token), /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local health server captures only valid sanitized record envelopes when explicitly opted in", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-record-capture-"));
  let readinessOnly: Awaited<ReturnType<typeof startLocalHealthServer>> | undefined;
  let captureEnabled: Awaited<ReturnType<typeof startLocalHealthServer>> | undefined;
  try {
    readinessOnly = await startLocalHealthServer(path.join(root, "readiness-only-certs"));
    writeSyntheticProfiles(path.join(root, "readiness-only-profile"), readinessOnly.apiBaseUrl);
    const readinessCredentials = JSON.parse(fs.readFileSync(
      path.join(root, "readiness-only-profile", "bootstrap-credentials.json"),
      "utf8"
    )) as { token: string; deviceId: string };
    const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";
    const envelope = {
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      session: {
        kind: "official",
        session_id: "forced-exit-e2e-official",
        day_no: 1,
        round_no: 1
      },
      row: {
        record_id: recordId,
        participant_name: "Synthetic Participant",
        phone_full: "01000000000",
        memo: "사용자 중단:메인화면",
        game_mode: "ai_challenge",
        challenge_result_label: "중단 패배",
        ai_challenge_status: "FAILED",
        final_vs_ai_result: "AI_WIN",
        result_stage: "2",
        fairness: {
          catalogVersion: "geumcheon-draft-20260825-v1",
          totalUserTimeMs: 1200,
          stages: [{
            stageNumber: 2,
            textId: "gsc26-ai-s2-001",
            catalogVersion: "geumcheon-draft-20260825-v1",
            targetText: "두 번째 과학 문장",
            typedText: "",
            userTimeMs: 0,
            typingUnits: 0,
            aiCpm: 225,
            result: "INTERRUPTED"
          }]
        }
      }
    };
    const offline = await postJson({
      url: `${readinessOnly.apiBaseUrl}/api/v1/records`,
      caPemPath: readinessOnly.caPemPath,
      token: readinessCredentials.token,
      deviceId: readinessCredentials.deviceId,
      idempotencyKey: recordId,
      body: envelope
    });
    assert.equal(offline.statusCode, 503);
    assert.equal((readinessOnly.capturedRecords ?? []).length, 0);
    await stopHttpsServer(readinessOnly.server);
    readinessOnly = undefined;

    captureEnabled = await startLocalHealthServer(path.join(root, "capture-certs"), { captureRecords: true });
    writeSyntheticProfiles(path.join(root, "capture-profile"), captureEnabled.apiBaseUrl);
    const captureCredentials = JSON.parse(fs.readFileSync(
      path.join(root, "capture-profile", "bootstrap-credentials.json"),
      "utf8"
    )) as { token: string; deviceId: string };
    for (const mismatch of [
      {
        url: `${captureEnabled.apiBaseUrl}/api/v1/records?unexpected=1`,
        token: captureCredentials.token,
        deviceId: captureCredentials.deviceId,
        statusCode: 403
      },
      {
        url: `${captureEnabled.apiBaseUrl}/api/v1/records`,
        token: "0".repeat(64),
        deviceId: captureCredentials.deviceId,
        statusCode: 401
      },
      {
        url: `${captureEnabled.apiBaseUrl}/api/v1/records`,
        token: captureCredentials.token,
        deviceId: "PC02",
        statusCode: 403
      }
    ]) {
      const rejected = await postJson({
        ...mismatch,
        caPemPath: captureEnabled.caPemPath,
        idempotencyKey: recordId,
        body: envelope
      });
      assert.equal(rejected.statusCode, mismatch.statusCode);
    }
    assert.equal(captureEnabled.capturedRecords.length, 0);

    const stored = await postJson({
      url: `${captureEnabled.apiBaseUrl}/api/v1/records`,
      caPemPath: captureEnabled.caPemPath,
      token: captureCredentials.token,
      deviceId: captureCredentials.deviceId,
      idempotencyKey: recordId,
      body: envelope
    });
    assert.equal(stored.statusCode, 201);
    const acknowledgement = JSON.parse(stored.body) as Record<string, unknown>;
    assert.equal(acknowledgement.record_id, recordId);
    assert.equal(acknowledgement.disposition, "stored");
    assert.match(String(acknowledgement.payload_sha256), /^[0-9a-f]{64}$/);

    assert.equal(captureEnabled.capturedRecords.length, 1);
    const captured = captureEnabled.capturedRecords[0];
    assert.equal(captured?.schema_version, 1);
    assert.equal(captured?.event_id, "geumcheon-science-festival-2026");
    assert.deepEqual(captured?.session, {
      kind: "official",
      session_id: "forced-exit-e2e-official",
      day_no: 1,
      round_no: 1
    });
    assert.equal(captured?.row.record_id, recordId);
    assert.equal(captured?.row.memo, "사용자 중단:메인화면");
    assert.equal(captured?.row.game_mode, "ai_challenge");
    assert.equal(captured?.row.challenge_result_label, "중단 패배");
    assert.equal(captured?.row.ai_challenge_status, "FAILED");
    assert.equal(captured?.row.final_vs_ai_result, "AI_WIN");
    assert.equal(captured?.row.result_stage, "2");
    assert.equal(captured?.row.fairness.stages[0].aiCpm, 225);
    assert.equal(captured?.row.fairness.stages[0].result, "INTERRUPTED");
    assert.equal("participant_name" in captured?.row, false);
    assert.equal("phone_full" in captured?.row, false);
    const serializedCapture = JSON.stringify({ captured: captureEnabled.capturedRecords, observations: captureEnabled.observations });
    assert.equal(serializedCapture.includes(captureCredentials.token), false);
    assert.equal(/password|private[_-]?key|passphrase/i.test(serializedCapture), false);
    assert.deepEqual(captureEnabled.observations.at(-1), {
      method: "POST",
      pathname: "/api/v1/records",
      queryMatched: true,
      authorizationMatched: true,
      deviceMatched: true,
      probe: false
    });
  } finally {
    await stopHttpsServer(readinessOnly?.server);
    await stopHttpsServer(captureEnabled?.server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("countdown evidence retention is opt-in for explicit R2 runs only", () => {
  assert.equal(shouldKeepCountdownEvidence({}, path.resolve("test_artifacts", "geumcheon_countdown_interruption_e2e")), false);
  assert.equal(
    shouldKeepCountdownEvidence(
      { TYPINGKING_E2E_KEEP_EVIDENCE: "1", TYPINGKING_E2E_ARTIFACT_ROOT: path.resolve("test_artifacts", "R2", "countdown") },
      path.resolve("test_artifacts", "R2", "countdown")
    ),
    true
  );
  assert.equal(
    shouldKeepCountdownEvidence(
      { TYPINGKING_E2E_KEEP_EVIDENCE: "1" },
      path.resolve("test_artifacts", "geumcheon_countdown_interruption_e2e")
    ),
    false
  );
});
