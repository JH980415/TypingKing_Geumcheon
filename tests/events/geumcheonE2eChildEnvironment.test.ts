import assert from "node:assert/strict";
import test from "node:test";
import { buildForcedExitChildEnvironment } from "../../scripts/e2e-geumcheon-forced-exit-check";
import { buildPackagedSmokeChildEnvironment } from "../../scripts/e2e-geumcheon-packaged-smoke-check";

const inheritedEnvironment = {
  PATH: "C:\\Windows\\System32",
  NODE_EXTRA_CA_CERTS: "C:\\host\\untrusted-ca.pem",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  THIRD_PARTY_API_KEY: "inherited-api-key",
  TYPINGKING_TEST_ADMIN_PASSWORD: "inherited-password"
};

test("forced-exit child environment filters inherited secrets and TLS overrides", () => {
  const environment = buildForcedExitChildEnvironment(
    {
      NODE_EXTRA_CA_CERTS: "C:\\runtime\\local-ca.pem",
      NO_PROXY: "127.0.0.1,localhost",
      TK_E2E_TOKEN: "explicit-synthetic-token"
    },
    inheritedEnvironment
  );

  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "C:\\runtime\\local-ca.pem");
  assert.equal(environment.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(environment.TK_E2E_TOKEN, "explicit-synthetic-token");
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(environment.THIRD_PARTY_API_KEY, undefined);
  assert.equal(environment.TYPINGKING_TEST_ADMIN_PASSWORD, undefined);
});

test("packaged-smoke child environment filters inherited secrets and TLS overrides", () => {
  const environment = buildPackagedSmokeChildEnvironment(
    {
      NODE_EXTRA_CA_CERTS: "C:\\runtime\\local-ca.pem",
      NO_PROXY: "127.0.0.1,localhost",
      TK_SMOKE_PFX_PASSWORD: "explicit-synthetic-password"
    },
    inheritedEnvironment
  );

  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "C:\\runtime\\local-ca.pem");
  assert.equal(environment.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(environment.TK_SMOKE_PFX_PASSWORD, "explicit-synthetic-password");
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(environment.THIRD_PARTY_API_KEY, undefined);
  assert.equal(environment.TYPINGKING_TEST_ADMIN_PASSWORD, undefined);
});
