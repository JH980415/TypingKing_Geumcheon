import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { buildNasApp } from "../src/app.js";
import type { TokenManifestV1 } from "../src/auth.js";
import { envelope, recordRow, validationConfig } from "./fixtures.js";

const NOW = "2026-08-26T03:10:00.000Z";
const RECORDS_ROUTE =
  "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1";
const OPERATOR_DEVICE_ID = "LEADERBOARD01";
const OPERATOR_TOKEN = "ab".repeat(32);

type DeviceRequest = {
  deviceId: string;
  token: string;
  recordId: string;
  participantName: string;
  payload: ReturnType<typeof envelope>;
};

function fleet(): DeviceRequest[] {
  return Array.from({ length: 10 }, (_, offset) => {
    const pcNumber = offset + 1;
    const deviceId = `PC${String(pcNumber).padStart(2, "0")}`;
    const token = pcNumber.toString(16).padStart(2, "0").repeat(32);
    const uuidPart = pcNumber.toString(16);
    const recordId = [
      `gsc26-${deviceId.toLowerCase()}-`,
      uuidPart.padStart(8, "0"),
      "-",
      uuidPart.padStart(4, "0"),
      "-4",
      uuidPart.padStart(3, "0"),
      "-8",
      uuidPart.padStart(3, "0"),
      "-",
      uuidPart.padStart(12, "0"),
    ].join("");
    const phonePart3 = String(pcNumber).padStart(4, "0");
    const participantName = `참가자${String(pcNumber).padStart(2, "0")}`;
    const row = recordRow({
      record_id: recordId,
      participant_name: participantName,
      phone_part3: phonePart3,
      phone_full: `0100000${phonePart3}`,
      phone_masked: `010-****-${phonePart3}`,
    });
    return { deviceId, token, recordId, participantName, payload: envelope(row) };
  });
}

function tokenManifest(devices: readonly DeviceRequest[]): TokenManifestV1 {
  const writerTokens: TokenManifestV1["tokens"] = devices.map((device) => ({
    tokenId: `${device.deviceId}-write`,
    tokenHash: createHash("sha256").update(device.token, "utf8").digest("hex"),
    deviceId: device.deviceId,
    role: "writer",
    allowedSessions: ["official", "practice"],
    expiresAt: "2026-09-30T00:00:00.000Z",
    revokedAt: null,
  }));
  return {
    manifestVersion: 1,
    eventId: "geumcheon-science-festival-2026",
    tokens: [
      ...writerTokens,
      {
        tokenId: "leaderboard-operator",
        tokenHash: createHash("sha256").update(OPERATOR_TOKEN, "utf8").digest("hex"),
        deviceId: OPERATOR_DEVICE_ID,
        role: "operator",
        allowedSessions: ["official", "practice"],
        expiresAt: "2026-09-30T00:00:00.000Z",
        revokedAt: null,
      },
    ],
  };
}

function createApp(root: string, devices: readonly DeviceRequest[]): FastifyInstance {
  return buildNasApp({
    config: {
      ...validationConfig(root),
      tokenManifest: tokenManifest(devices),
    },
    now: () => NOW,
  });
}

function submit(app: FastifyInstance, device: DeviceRequest) {
  return app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: {
      authorization: `Bearer ${device.token}`,
      "x-device-id": device.deviceId,
      "idempotency-key": device.recordId,
      "content-type": "application/json",
    },
    payload: device.payload,
  });
}

function readAll(app: FastifyInstance) {
  return app.inject({
    method: "GET",
    url: RECORDS_ROUTE,
    headers: {
      authorization: `Bearer ${OPERATOR_TOKEN}`,
      "x-device-id": OPERATOR_DEVICE_ID,
    },
  });
}

function storedJsonCount(root: string): number {
  const directory = join(root, "기록저장", "1일차", "1회차", "incoming", "ai");
  return readdirSync(directory).filter((name) => name.endsWith(".json")).length;
}

test("PC01부터 PC10까지 서로 다른 기록을 동시에 저장하고 모두 조회한다", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-ten-pcs-"));
  const devices = fleet();
  const app = createApp(root, devices);
  context.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const responses = await Promise.all(devices.map((device) => submit(app, device)));

  assert.deepEqual(responses.map((response) => response.statusCode), Array(10).fill(201));
  assert.deepEqual(
    responses.map((response) => response.json().disposition),
    Array(10).fill("stored"),
  );
  assert.deepEqual(
    responses.map((response) => response.json().record_id).sort(),
    devices.map((device) => device.recordId).sort(),
  );

  const snapshot = await readAll(app);
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  const rows = snapshot.json().rows as Array<{ record_id: string; participant_name: string }>;
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((row) => row.record_id).sort(),
    devices.map((device) => device.recordId).sort(),
  );
  assert.deepEqual(
    rows.map((row) => row.participant_name).sort(),
    devices.map((device) => device.participantName).sort(),
  );
  assert.equal(storedJsonCount(root), 10);
});

test("PC01부터 PC10까지 같은 payload와 idempotency key를 재전송해도 중복 저장하지 않는다", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-ten-pcs-retry-"));
  const devices = fleet();
  const app = createApp(root, devices);
  context.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const firstResponses = await Promise.all(devices.map((device) => submit(app, device)));
  assert.deepEqual(firstResponses.map((response) => response.statusCode), Array(10).fill(201));

  const retryResponses = await Promise.all(devices.map((device) => submit(app, device)));
  assert.deepEqual(retryResponses.map((response) => response.statusCode), Array(10).fill(200));
  assert.deepEqual(
    retryResponses.map((response) => response.json().disposition),
    Array(10).fill("duplicate"),
  );
  assert.deepEqual(
    retryResponses.map((response) => response.json().record_id).sort(),
    devices.map((device) => device.recordId).sort(),
  );

  const snapshot = await readAll(app);
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.equal(snapshot.json().rows.length, 10);
  assert.equal(storedJsonCount(root), 10);
});
