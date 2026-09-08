import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildNasApp } from "../src/app.js";
import { envelope, headers, recordRow, tokenManifest, validationConfig } from "./fixtures.js";

test("validation errors do not echo participant PII, request bodies, or bearer tokens", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-pii-boundary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: { ...validationConfig(root), tokenManifest: tokenManifest() },
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const privateName = "비공개참가자-PII-CANARY";
  const privatePhone = "01099998888";
  const payload = envelope(recordRow({
    participant_name: privateName,
    phone_part2: "9999",
    phone_part3: "8888",
    phone_full: privatePhone,
    privacy_agreed: "false",
  }));
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: { ...headers("writer"), "idempotency-key": payload.row.record_id },
    payload,
  });

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), { schema_version: 1, code: "CONSENT_REQUIRED", message: "CONSENT_REQUIRED" });
  assert.doesNotMatch(response.body, new RegExp(`${privateName}|${privatePhone}|${headers("writer").authorization}`));
});

test("authentication failures expose only the stable error envelope", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-auth-boundary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: { ...validationConfig(root), tokenManifest: tokenManifest() },
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1",
    headers: { authorization: `Bearer ${"a".repeat(64)}`, "x-device-id": "LEADERBOARD01" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { schema_version: 1, code: "AUTH_INVALID", message: "AUTH_INVALID" });
  assert.doesNotMatch(response.body, /Bearer|a{32}/);
});
