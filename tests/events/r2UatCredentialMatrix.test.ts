import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runner = require(path.resolve("scripts", "r2-uat", "uat-runner.js")) as {
  writeSyntheticProfile(input: {
    caseRoot: string;
    executableDirectory: string;
    app: { deviceId: string; role: "player" | "leaderboard"; sessionKind: "official" };
    baseUrl: string;
    token: string;
    operatorToken?: string;
  }): void;
  startPersistentMock(input: {
    temporaryRoot: string;
    packageRoot: string;
    tokens: Record<string, string>;
    records?: unknown[];
  }): Promise<{ baseUrl: string; caPemPath: string; server: unknown }>;
  requestJson(
    url: string,
    ca: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  closeMock(mock: unknown): Promise<void>;
};
const baseRunner = require(path.resolve("scripts", "r2-uat", "uat-runner-r2-0-1-base.js")) as {
  writeSyntheticProfile(input: {
    caseRoot: string;
    executableDirectory: string;
    app: { deviceId: string; role: "leaderboard"; sessionKind: "official" };
    baseUrl: string;
    token: string;
    operatorToken: string;
    runtimeConfig: Record<string, unknown>;
  }): void;
};

const leaderboardToken = "l".repeat(43);
const operatorToken = "o".repeat(43);
const writerToken = "w".repeat(43);
const sessionQuery = "session_kind=official&session_id=r2-uat-official&day_no=1&round_no=1";

test("writes distinct synthetic leaderboard and operator bootstrap credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-credentials-"));
  try {
    const executableDirectory = path.join(root, "leaderboard");
    runner.writeSyntheticProfile({
      caseRoot: root,
      executableDirectory,
      app: { deviceId: "LEADERBOARD01", role: "leaderboard", sessionKind: "official" },
      baseUrl: "https://127.0.0.1:14443",
      token: leaderboardToken,
      operatorToken,
    });

    const primary = JSON.parse(fs.readFileSync(path.join(executableDirectory, "bootstrap-credentials.json"), "utf8"));
    const operator = JSON.parse(fs.readFileSync(path.join(executableDirectory, "bootstrap-operator-credentials.json"), "utf8"));
    assert.equal(primary.token, leaderboardToken);
    assert.equal(operator.token, operatorToken);
    assert.notEqual(primary.token, operator.token);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real UAT launch profile writer stages the distinct operator bootstrap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-base-credentials-"));
  try {
    const executableDirectory = path.join(root, "leaderboard");
    baseRunner.writeSyntheticProfile({
      caseRoot: root,
      executableDirectory,
      app: { deviceId: "LEADERBOARD01", role: "leaderboard", sessionKind: "official" },
      baseUrl: "https://127.0.0.1:14443",
      token: leaderboardToken,
      operatorToken,
      runtimeConfig: {},
    });
    const operator = JSON.parse(fs.readFileSync(path.join(executableDirectory, "bootstrap-operator-credentials.json"), "utf8"));
    assert.equal(operator.token, operatorToken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loopback HTTPS mock enforces writer leaderboard and operator endpoint scopes", async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-matrix-store-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-matrix-cert-"));
  const tokens = {
    PC01: writerToken,
    LEADERBOARD01: leaderboardToken,
    LEADERBOARD01_OPERATOR: operatorToken,
  };
  let mock: Awaited<ReturnType<typeof runner.startPersistentMock>> | undefined;
  try {
    mock = await runner.startPersistentMock({ temporaryRoot, packageRoot, tokens, records: [] });
    const leaderboardHeaders = { authorization: `Bearer ${leaderboardToken}`, "x-device-id": "LEADERBOARD01" };
    const operatorHeaders = { authorization: `Bearer ${operatorToken}`, "x-device-id": "LEADERBOARD01" };
    const writerHeaders = { authorization: `Bearer ${writerToken}`, "x-device-id": "PC01" };

    const leaderboardReady = await runner.requestJson(`${mock.baseUrl}/api/v1/ready?${sessionQuery}`, mock.caPemPath, leaderboardHeaders);
    const operatorReady = await runner.requestJson(`${mock.baseUrl}/api/v1/ready?${sessionQuery}`, mock.caPemPath, operatorHeaders);
    assert.equal(leaderboardReady.status, 200);
    assert.equal(leaderboardReady.body.role, "leaderboard");
    assert.equal(operatorReady.status, 200);
    assert.equal(operatorReady.body.role, "operator");

    assert.equal((await runner.requestJson(`${mock.baseUrl}/api/v1/records?${sessionQuery}`, mock.caPemPath, leaderboardHeaders)).status, 200);
    assert.equal((await runner.requestJson(`${mock.baseUrl}/api/v1/records?${sessionQuery}`, mock.caPemPath, operatorHeaders)).status, 403);
    assert.equal((await runner.requestJson(`${mock.baseUrl}/api/v1/records?${sessionQuery}`, mock.caPemPath, writerHeaders)).status, 403);

    const action = {
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      action_id: "gsc26-action-123e4567-e89b-42d3-a456-426614174000",
      action_type: "reset_session",
      created_at: "2026-09-18T01:02:00.000Z",
      session: { kind: "official", session_id: "r2-uat-official", day_no: 1, round_no: 1 },
      admin_name: "UAT 운영자",
    };
    assert.equal((await runner.requestJson(`${mock.baseUrl}/api/v1/admin/actions`, mock.caPemPath, operatorHeaders, action)).status, 200);
    assert.equal((await runner.requestJson(`${mock.baseUrl}/api/v1/admin/actions`, mock.caPemPath, leaderboardHeaders, action)).status, 403);
  } finally {
    await runner.closeMock(mock);
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("loopback HTTPS mock fails closed when the operator token is not provisioned", async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-missing-operator-store-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-missing-operator-cert-"));
  let mock: Awaited<ReturnType<typeof runner.startPersistentMock>> | undefined;
  try {
    mock = await runner.startPersistentMock({
      temporaryRoot,
      packageRoot,
      tokens: { PC01: writerToken, LEADERBOARD01: leaderboardToken },
      records: [],
    });
    const response = await runner.requestJson(
      `${mock.baseUrl}/api/v1/ready?${sessionQuery}`,
      mock.caPemPath,
      { authorization: "Bearer undefined", "x-device-id": "LEADERBOARD01" },
    );
    assert.equal(response.status, 401);
  } finally {
    await runner.closeMock(mock);
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
