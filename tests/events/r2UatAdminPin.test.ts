import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminAccessSessions } from "../../electron/adminAccessSession";

const projectRoot = path.resolve(__dirname, "..", "..");

test("isolated UAT profile accepts its configured local PIN and rejects another PIN", () => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-admin-pin-"));
  const executableDirectory = path.join(caseRoot, "executable");
  try {
    const runner = require(
      path.join(projectRoot, "scripts", "r2-uat", "uat-runner-r2-0-1-base.js")
    ) as {
      writeSyntheticProfile(input: {
        caseRoot: string;
        executableDirectory: string;
        app: { deviceId: string; role: string; sessionKind: string };
        baseUrl: string;
        token: string;
        runtimeConfig: Record<string, unknown>;
      }): void;
    };
    runner.writeSyntheticProfile({
      caseRoot,
      executableDirectory,
      app: { deviceId: "PC01", role: "player", sessionKind: "official" },
      baseUrl: "https://127.0.0.1:14443",
      token: "a".repeat(43),
      runtimeConfig: { adminPassword: "0208" }
    });
    const generatedConfig = JSON.parse(
      fs.readFileSync(path.join(executableDirectory, "config", "config.json"), "utf8")
    ) as { adminPassword: string };
    const sessions = new AdminAccessSessions({
      password: generatedConfig.adminPassword,
      ttlMs: 60_000
    });
    const sender = { id: 1, once: () => undefined };

    assert.deepEqual(sessions.authenticate(sender, "0208", "UAT 관리자"), {
      ok: true,
      adminName: "UAT 관리자"
    });
    assert.deepEqual(sessions.authenticate(sender, "9999", "UAT 관리자"), { ok: false });
  } finally {
    fs.rmSync(caseRoot, { recursive: true, force: true });
  }
});
