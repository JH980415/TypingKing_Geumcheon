import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require(path.resolve("scripts", "r2-uat", "uat-runner-r2-0-1-base.js")) as {
  createLifecycle(): { childPids: Set<number>; temporaryRoot?: string; mock?: unknown };
  startMockNas(input: { temporaryRoot: string; tokens: Record<string, string>; records: unknown[] }): Promise<{ baseUrl: string; caPemPath: string }>;
  runOneApp(input: unknown): Promise<void>;
  stopMockNas(mock: unknown): Promise<void>;
};

test("break: tracked real UAT runner spawns an executable child with its isolated profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-real-runner-"));
  const lifecycle = runner.createLifecycle();
  try {
    const executablePath = path.join(root, "synthetic.exe");
    fs.copyFileSync(process.execPath, executablePath);
    const mock = await runner.startMockNas({ temporaryRoot: root, tokens: { PC01: "a".repeat(43), LEADERBOARD01: "b".repeat(43) }, records: [] });
    lifecycle.mock = mock;
    await runner.runOneApp({
      layout: { appPaths: new Map([["ai", executablePath]]), resourcePaths: [] },
      config: { runtimeConfig: {} },
      app: { key: "ai", fileName: "synthetic.exe", displayName: "synthetic app", role: "player", deviceId: "PC01", sessionKind: "official" },
      mock,
      tokens: { PC01: "a".repeat(43) },
      caseRoot: path.join(root, "case"),
      lifecycle
    });
    assert.equal(lifecycle.childPids.size, 0);
    assert.equal(fs.existsSync(path.join(root, "case", "executable", "device-profile.json")), true);
  } finally {
    await runner.stopMockNas(lifecycle.mock);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
