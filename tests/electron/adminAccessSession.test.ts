import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AdminAccessSessions } from "../../electron/adminAccessSession";

class TestSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

test("grants one renderer a bounded admin session and returns the authenticated name", () => {
  let now = 1_000;
  const sessions = new AdminAccessSessions({
    password: "0208",
    ttlMs: 60_000,
    now: () => now,
  });
  const sender = new TestSender(7);

  assert.throws(() => sessions.require(sender), /ADMIN_AUTH_REQUIRED/);
  assert.deepEqual(sessions.authenticate(sender, "0208", "  현장 관리자  "), {
    ok: true,
    adminName: "현장 관리자",
  });
  assert.equal(sessions.require(sender).adminName, "현장 관리자");

  now += 60_001;
  assert.throws(() => sessions.require(sender), /ADMIN_AUTH_REQUIRED/);
});

test("failed authentication and renderer destruction revoke only that sender session", () => {
  const sessions = new AdminAccessSessions({ password: "0208", ttlMs: 60_000 });
  const first = new TestSender(1);
  const second = new TestSender(2);

  assert.equal(sessions.authenticate(first, "0208", "첫 관리자").ok, true);
  assert.equal(sessions.authenticate(second, "0208", "둘째 관리자").ok, true);
  assert.deepEqual(sessions.authenticate(first, "wrong", "위조 관리자"), { ok: false });
  assert.throws(() => sessions.require(first), /ADMIN_AUTH_REQUIRED/);
  assert.equal(sessions.require(second).adminName, "둘째 관리자");

  second.emit("destroyed");
  assert.throws(() => sessions.require(second), /ADMIN_AUTH_REQUIRED/);
});

test("rejects unsafe administrator names instead of trusting action arguments", () => {
  const sessions = new AdminAccessSessions({ password: "0208", ttlMs: 60_000 });
  const sender = new TestSender(1);

  assert.deepEqual(sessions.authenticate(sender, "0208", "\u0000관리자"), { ok: false });
  assert.throws(() => sessions.require(sender), /ADMIN_AUTH_REQUIRED/);
});
