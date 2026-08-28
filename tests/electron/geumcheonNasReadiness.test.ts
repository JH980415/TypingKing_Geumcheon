import assert from "node:assert/strict";
import test from "node:test";
import {
  checkGeumcheonNasReadiness,
  requireGeumcheonCredential,
} from "../../electron/nas/readiness";

test("accepts only an authenticated identity and storage readiness probe", async () => {
  let authenticatedProbeCalled = false;
  const result = await checkGeumcheonNasReadiness({
    checkAuthenticatedReady: async () => {
      authenticatedProbeCalled = true;
      return {
        schema_version: 1,
        status: "ready",
        event_id: "geumcheon-science-festival-2026",
        device_id: "PC01",
        role: "writer",
        session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 1 },
      };
    },
  });

  assert.deepEqual(result, { ready: true });
  assert.equal(authenticatedProbeCalled, true);
});

test("blocks game start when authenticated readiness fails without leaking details", async () => {
  const result = await checkGeumcheonNasReadiness({
    checkAuthenticatedReady: async () => {
      throw new Error("AUTH_INVALID token-value-must-not-leak");
    },
  });

  assert.equal(result.ready, false);
  assert.match(result.message ?? "", /기록 서버/);
  assert.doesNotMatch(result.message ?? "", /AUTH_INVALID|token-value/);
});

test("does not accept public health when authenticated readiness fails", async () => {
  const result = await checkGeumcheonNasReadiness({
    checkAuthenticatedReady: async () => { throw new Error("ROLE_SCOPE"); },
  });
  assert.equal(result.ready, false);
});

test("credential bootstrap failures stop startup with a sanitized error", async () => {
  await assert.rejects(
    () => requireGeumcheonCredential(async () => { throw new Error("token-value-must-not-leak"); }),
    (error: unknown) => error instanceof Error
      && error.message === "GEUMCHEON_NAS_CREDENTIAL_REQUIRED"
      && !error.message.includes("token-value-must-not-leak"),
  );
});
