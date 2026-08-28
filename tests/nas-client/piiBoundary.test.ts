import assert from "node:assert/strict";
import test from "node:test";
import { piiSafeError, piiSafeLogFields } from "../../electron/nas/piiBoundary";

test("reduces arbitrary errors to an allowlisted code without raw PII or tokens", () => {
  const safe = piiSafeError(new Error("홍길동 01012345678 2010-01-02 Bearer device-secret-token"));

  assert.equal(safe.message, "NAS_OPERATION_FAILED");
  assert.equal(JSON.stringify(safe).includes("홍길동"), false);
  assert.equal(JSON.stringify(safe).includes("01012345678"), false);
  assert.equal(JSON.stringify(safe).includes("device-secret-token"), false);
});

test("allows only operational identifiers in log fields", () => {
  const fields = piiSafeLogFields({
    operation: "record_upload",
    recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    status: 503,
    attempt: 2,
    participant_name: "홍길동",
    phone_full: "01012345678",
    token: "device-secret-token",
  });

  assert.deepEqual(fields, {
    operation: "record_upload",
    recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000",
    status: 503,
    attempt: 2,
  });
});

test("does not trust an arbitrary error code that contains personal data", () => {
  const safe = piiSafeError({ code: "PHONE_01012345678", status: 422 });

  assert.deepEqual(safe, { message: "NAS_OPERATION_FAILED", status: 422 });
});
