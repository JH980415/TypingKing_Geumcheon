import assert from "node:assert/strict";
import test from "node:test";
import * as startupProfileModule from "../../electron/startupProfile";

type TlsEnvironmentGuard = (
  environment: Record<string, string | undefined>,
  isPackaged: boolean,
  target?: {
    eventProfileId: "skillup-2026" | "geumcheon-2026";
    apiBaseUrl: string;
  },
) => void;

type StartupErrorFormatter = (error: unknown) => string;

function guard(): TlsEnvironmentGuard | undefined {
  return (
    startupProfileModule as typeof startupProfileModule & {
      assertSafeTlsEnvironment?: TlsEnvironmentGuard;
    }
  ).assertSafeTlsEnvironment;
}

function formatStartupError(): StartupErrorFormatter | undefined {
  return (
    startupProfileModule as typeof startupProfileModule & {
      formatStartupErrorForDisplay?: StartupErrorFormatter;
    }
  ).formatStartupErrorForDisplay;
}

test("rejects case-insensitive TLS bypass and mixed-case extra CA environment keys", () => {
  assert.equal(typeof guard(), "function");
  for (const environment of [
    { node_tls_reject_unauthorized: "1" },
    { Node_Tls_Reject_Unauthorized: "0" },
    {
      TYPINGKING_E2E_PROFILE: "functional-flow",
      Node_Extra_Ca_Certs: "C:\\test\\mixed-case-ca.pem",
    },
    {
      TYPINGKING_E2E_PROFILE: "functional-flow",
      NODE_EXTRA_CA_CERTS: "C:\\test\\canonical-ca.pem",
      node_extra_ca_certs: "C:\\test\\alias-ca.pem",
    },
  ]) {
    assert.throws(
      () => guard()?.(environment, false),
      (error: unknown) => error instanceof Error && error.message === "TLS_ENVIRONMENT_REJECTED",
    );
  }
});

test("authorizes exactly one canonical extra CA only for the mode-matched isolated profile", () => {
  const authorized = {
    TYPINGKING_E2E_PROFILE: "functional-flow",
    NODE_EXTRA_CA_CERTS: "C:\\isolated-uat\\temporary-ca.pem",
  };
  const loopbackTarget = {
    eventProfileId: "geumcheon-2026" as const,
    apiBaseUrl: "https://127.0.0.1:43123",
  };

  assert.equal(typeof guard(), "function");
  assert.doesNotThrow(() => guard()?.(authorized, false, loopbackTarget));
  assert.throws(
    () => guard()?.(authorized, true, loopbackTarget),
    (error: unknown) => error instanceof Error && error.message === "TLS_ENVIRONMENT_REJECTED",
  );
  assert.throws(
    () => guard()?.({ NODE_EXTRA_CA_CERTS: authorized.NODE_EXTRA_CA_CERTS }, false),
    (error: unknown) => error instanceof Error && error.message === "TLS_ENVIRONMENT_REJECTED",
  );
});

test("rejects a packaged-smoke extra CA unless the validated Geumcheon target is an exact loopback origin", () => {
  const packagedSmoke = {
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    NODE_EXTRA_CA_CERTS: "C:\\isolated-uat\\temporary-ca.pem",
  };
  const rejectedTargets = [
    undefined,
    { eventProfileId: "geumcheon-2026" as const, apiBaseUrl: "https://nas.internal:9443" },
    { eventProfileId: "skillup-2026" as const, apiBaseUrl: "https://127.0.0.1:43123" },
    { eventProfileId: "geumcheon-2026" as const, apiBaseUrl: "https://127.0.0.1" },
    { eventProfileId: "geumcheon-2026" as const, apiBaseUrl: "https://127.0.0.1:65536" },
    { eventProfileId: "geumcheon-2026" as const, apiBaseUrl: "https://127.0.0.1:43123/api" },
  ];

  for (const target of rejectedTargets) {
    assert.throws(
      () => guard()?.(packagedSmoke, true, target),
      (error: unknown) => error instanceof Error && error.message === "TLS_ENVIRONMENT_REJECTED",
      target?.apiBaseUrl ?? "missing target",
    );
  }
  assert.doesNotThrow(() => guard()?.(packagedSmoke, true, {
    eventProfileId: "geumcheon-2026",
    apiBaseUrl: "https://127.0.0.1:43123",
  }));
});

test("formats startup failures without codes paths filenames tokens bodies or stacks", () => {
  const privateDetail = new Error(
    "BOOTSTRAP_CREDENTIAL_AUTH_FAILED C:\\Users\\tester\\bootstrap-credentials.json "
      + "Bearer synthetic-token response-body",
  );
  privateDetail.stack = `Error: ${privateDetail.message}\n at C:\\private\\electron\\main.ts:1:1`;

  assert.equal(typeof formatStartupError(), "function");
  const message = formatStartupError()?.(privateDetail) ?? "";
  assert.match(message, /시작|설정|관리자/);
  assert.doesNotMatch(
    message,
    /BOOTSTRAP|C:\\|bootstrap-credentials|Bearer|synthetic-token|response-body|main\.ts/i,
  );
});
