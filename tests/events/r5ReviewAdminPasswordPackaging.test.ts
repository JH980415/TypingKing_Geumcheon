import assert from "node:assert/strict";
import test from "node:test";
import * as adminAccess from "../../electron/adminAccessSession";

test("review variants receive the fixed local review PIN while production placeholder remains fail-closed", () => {
  const resolve = (adminAccess as unknown as {
    resolveAdminPasswordForRuntime?: (configuredPassword: string, environment?: string) => string;
  }).resolveAdminPasswordForRuntime;
  assert.equal(typeof resolve, "function");

  for (const variant of ["ai", "ai-leaderboard", "practice", "practice-leaderboard"]) {
    const password = resolve!("CHANGE_ME_BEFORE_EVENT", "review");
    assert.equal(password, "0208", variant);
    assert.doesNotThrow(() => new adminAccess.AdminAccessSessions({ password, ttlMs: 60_000 }));
  }

  const productionPassword = resolve!("CHANGE_ME_BEFORE_EVENT");
  assert.equal(productionPassword, "CHANGE_ME_BEFORE_EVENT");
  assert.throws(
    () => new adminAccess.AdminAccessSessions({ password: productionPassword, ttlMs: 60_000 }),
    /ADMIN_PASSWORD_INVALID/
  );
});
