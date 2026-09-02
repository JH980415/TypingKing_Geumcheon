import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require(path.resolve("scripts", "r2-uat", "uat-runner-r2-0-1-base.js")) as {
  buildIsolatedAppArguments(userDataPath: string): string[];
  createLifecycle(): { childPids: Set<number>; temporaryRoot?: string; mock?: unknown };
  startMockNas(input: { temporaryRoot: string; tokens: Record<string, string>; records: unknown[] }): Promise<{ baseUrl: string; caPemPath: string }>;
  runOneApp(input: unknown): Promise<void>;
  stopMockNas(mock: unknown): Promise<void>;
};

const sessionQuery = "session_kind=official&session_id=r2-uat-official&day_no=1&round_no=1";

function requestMock(
  mock: { baseUrl: string; caPemPath: string },
  token: string,
  method: "GET" | "POST",
  pathname: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, mock.baseUrl);
    const payload = method === "POST" ? "{}" : undefined;
    const request = https.request({
      protocol: "https:",
      hostname: "127.0.0.1",
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      ca: fs.readFileSync(mock.caPemPath),
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "x-device-id": "LEADERBOARD01",
        ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {})
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode || 0,
          body: JSON.parse(body || "{}") as Record<string, unknown>
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function makeBaseRunnerPackage(root: string): string {
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.resolve("scripts", "r2-uat", "uat-default-config.json"), "utf8")
  ) as { apps: Array<{ fileName: string }>; requiredResources: string[] };
  const runnerPath = path.join(runtime, "uat-runner-r2-0-1-base.js");
  fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
  fs.copyFileSync(
    path.resolve("scripts", "r2-uat", "uat-runner-r2-0-1-base.js"),
    runnerPath
  );
  fs.copyFileSync(
    path.resolve("scripts", "r2-uat", "uat-default-config.json"),
    path.join(runtime, "uat-default-config.json")
  );
  const releaseRoot = path.join(root, "release");
  fs.mkdirSync(releaseRoot, { recursive: true });
  const noOpExecutable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe");
  for (const app of config.apps) fs.copyFileSync(noOpExecutable, path.join(releaseRoot, app.fileName));
  for (const resource of config.requiredResources) {
    const target = path.join(releaseRoot, resource);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      resource.endsWith("stage_texts.csv")
        ? [
            "id,catalog_version,game_mode,stage_number,text,is_active,created_at,updated_at",
            "s1,v1,ai_challenge,1,첫 번째 합성 문구,true,2026-08-31T00:00:00.000Z,2026-08-31T00:00:00.000Z",
            "s2,v1,ai_challenge,2,두 번째 합성 문구,true,2026-08-31T00:00:00.000Z,2026-08-31T00:00:00.000Z",
            "s3,v1,ai_challenge,3,세 번째 합성 문구,true,2026-08-31T00:00:00.000Z,2026-08-31T00:00:00.000Z"
          ].join("\n")
        : "synthetic UAT resource",
      "utf8"
    );
  }
  return runnerPath;
}

test("UAT runner builds an explicit Chromium userData switch", () => {
  const userDataPath = path.join(os.tmpdir(), "typingking-r2-uat-user-data");

  assert.deepEqual(runner.buildIsolatedAppArguments(userDataPath), [
    `--user-data-dir=${path.resolve(userDataPath)}`
  ]);
});
test("tracked real UAT runner passes its isolated profile to the executable child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-real-runner-"));
  const lifecycle = runner.createLifecycle();
  try {
    const executablePath = path.join(root, "synthetic.exe");
    fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), executablePath);
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

test("base mock keeps leaderboard reads and operator administration on distinct tokens", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-base-token-scope-"));
  const tokens = {
    PC01: "w".repeat(43),
    LEADERBOARD01: "l".repeat(43),
    LEADERBOARD01_OPERATOR: "o".repeat(43)
  };
  let mock: { baseUrl: string; caPemPath: string } | undefined;
  try {
    mock = await runner.startMockNas({ temporaryRoot: root, tokens, records: [] });
    const leaderboardReady = await requestMock(
      mock,
      tokens.LEADERBOARD01,
      "GET",
      `/api/v1/ready?${sessionQuery}`
    );
    const operatorReady = await requestMock(
      mock,
      tokens.LEADERBOARD01_OPERATOR,
      "GET",
      `/api/v1/ready?${sessionQuery}`
    );

    assert.deepEqual(
      { statusCode: leaderboardReady.statusCode, role: leaderboardReady.body.role },
      { statusCode: 200, role: "leaderboard" }
    );
    assert.deepEqual(
      { statusCode: operatorReady.statusCode, role: operatorReady.body.role },
      { statusCode: 200, role: "operator" }
    );
    assert.equal(
      (await requestMock(mock, tokens.LEADERBOARD01, "GET", `/api/v1/records?${sessionQuery}`)).statusCode,
      200
    );
    assert.equal(
      (await requestMock(mock, tokens.LEADERBOARD01_OPERATOR, "GET", `/api/v1/records?${sessionQuery}`)).statusCode,
      403
    );
    assert.equal(
      (await requestMock(mock, tokens.LEADERBOARD01_OPERATOR, "POST", "/api/v1/admin/actions")).statusCode,
      200
    );
    assert.equal(
      (await requestMock(mock, tokens.LEADERBOARD01, "POST", "/api/v1/admin/actions")).statusCode,
      403
    );
  } finally {
    await runner.stopMockNas(mock);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("base direct leaderboard path provisions a separate operator token before launch", { timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-base-direct-"));
  try {
    const runnerPath = makeBaseRunnerPackage(root);
    const result = spawnSync(process.execPath, [runnerPath, "--app=ai-leaderboard"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 25_000
    });

    assert.doesNotMatch(result.stderr, /SYNTHETIC_OPERATOR_TOKEN_INVALID/);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});



