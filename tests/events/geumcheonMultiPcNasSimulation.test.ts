import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(__dirname, "..", "..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const harness = path.join(projectRoot, "scripts", "e2e-geumcheon-multi-pc-nas-simulation.ts");

test("break: the 10+1 HTTPS simulation preserves every official attempt across duplicate, outage, and restart paths", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-multi-pc-test-"));
  try {
    const result = spawnSync(
      process.execPath,
      [tsxCli, harness, "--output", outputRoot, "--skip-screenshot"],
      { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 120_000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const produced = fs.readdirSync(outputRoot).sort();
    assert.deepEqual(produced, [
      "multi-pc-latency-report.md",
      "multi-pc-nas-simulation-summary.json",
      "multi-pc-record-inventory.csv",
    ]);

    const summary = JSON.parse(fs.readFileSync(
      path.join(outputRoot, "multi-pc-nas-simulation-summary.json"),
      "utf8",
    ));
    assert.equal(summary.status, "PASS");
    assert.deepEqual(summary.topology.writerDeviceIds, [
      "PC01", "PC02", "PC03", "PC04", "PC05",
      "PC06", "PC07", "PC08", "PC09", "PC10",
    ]);
    assert.equal(summary.topology.readerDeviceId, "LEADERBOARD01");
    assert.equal(summary.officialAttempts.total, 32);
    assert.equal(summary.officialAttempts.visible, 31);
    assert.equal(summary.officialAttempts.quarantined, 1);
    assert.deepEqual(summary.officialAttempts.interruptionStages, [1, 2, 3]);
    assert.equal(summary.officialAttempts.allDevicesVisible, true);
    assert.equal(summary.officialAttempts.recordIdCollisions, 0);
    assert.deepEqual(summary.contract.duplicate, { status: 200, rowGrowth: 0 });
    assert.deepEqual(summary.contract.conflict, { status: 409, rowGrowth: 0 });
    assert.deepEqual(summary.contract.newAttempt, { status: 201, rowGrowth: 1 });
    assert.equal(summary.isolation.practiceRowsInOfficial, 0);
    assert.equal(summary.integrity.lostRecords, 0);
    assert.equal(summary.integrity.contradictionsPublic, 0);
    assert.equal(summary.integrity.publicEligibilityValidated, true);
    assert.equal(summary.restart.sameDurableRoot, true);
    assert.equal(summary.restart.recordsPreserved, true);
    assert.deepEqual(summary.outbox, {
      cipher: "AES-256-GCM",
      plaintextLeak: false,
      pendingBeforeRecovery: 1,
      pendingAfterRecovery: 0,
      recoveredStatus: 201,
    });
    assert.deepEqual(summary.concurrentPost.statusCounts, { "201": 10 });
    assert.equal(summary.security.loopbackHttpsOnly, true);
    assert.equal(summary.security.tlsVerificationEnabled, true);
    assert.equal(summary.security.minimumTlsVersion, "TLSv1.2");
  assert.equal(summary.security.temporaryCaValidated, true);
    assert.equal(summary.security.actualNasUsed, false);
    assert.equal(summary.security.productionCredentialsUsed, false);
    assert.equal(summary.security.rawPiiUsed, false);
    assert.equal(summary.security.writerCredentialCount, 10);
    assert.equal(summary.security.distinctWriterCredentialCount, 10);
    assert.equal(summary.security.deviceBindingMismatchStatus, 422);
    assert.equal(summary.cleanup.serverClosed, true);
    assert.equal(summary.cleanup.temporaryRootRemoved, true);

    const inventory = fs.readFileSync(path.join(outputRoot, "multi-pc-record-inventory.csv"), "utf8");
    const lines = inventory.trim().split(/\r?\n/);
    assert.equal(lines.length, 33);
    for (const deviceId of summary.topology.writerDeviceIds) {
      assert.match(inventory, new RegExp(`(?:^|\\n)${deviceId},`));
    }

    const latency = fs.readFileSync(path.join(outputRoot, "multi-pc-latency-report.md"), "utf8");
    assert.match(latency, /nearest-rank.*ceil\(0\.95 × n\)/i);
    assert.match(latency, /record save p95: \d+(?:\.\d+)? ms/i);
    assert.match(latency, /leaderboard visibility p95: \d+(?:\.\d+)? ms/i);

    const publicEvidence = [JSON.stringify(summary), inventory, latency].join("\n");
    assert.doesNotMatch(publicEvidence, /(?:Bearer\s+|token|private[_ -]?key|010[- ]?\d{3,4}[- ]?\d{4})/i);
    assert.doesNotMatch(publicEvidence, /[A-Za-z]:\\(?:Users|Temp)\\/);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
