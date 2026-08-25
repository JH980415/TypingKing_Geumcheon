import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import * as bootstrapDataModule from "../../shared/events/bootstrapData";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { loadEventProfile, validateDeviceProfile, variantPolicyFor } from "../../shared/events/eventProfile";

const validDeviceProfile = {
  schemaVersion: 1,
  eventProfileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026",
  deviceId: "PC10",
  role: "player",
  apiBaseUrl: "https://records.example.test",
  sessions: {
    official: { sessionId: "day-1-round-1", dayNo: 1, roundNo: 1 },
    practice: { sessionId: "practice" }
  },
  requestTimeoutMs: 5000,
  retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
} as const;

test("loads the AI-only Geumcheon variant policy", () => {
  const profile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
  assert.equal(profile.eventName, "제8회 금천과학축제");
  assert.equal(variantPolicyFor(profile, "typing").enabled, false);
  assert.deepEqual(variantPolicyFor(profile, "ai").gameModes, ["ai_challenge"]);
});

test("resolves SkillUp runtime theme overrides while keeping the Geumcheon profile theme", () => {
  const resolveTheme = (
    bootstrapDataModule as typeof bootstrapDataModule & {
      resolveBootstrapTheme?: (bootstrap: {
        config: typeof DEFAULT_CONFIG;
        eventProfile: ReturnType<typeof loadEventProfile>;
      }) => typeof DEFAULT_CONFIG.theme;
    }
  ).resolveBootstrapTheme;
  const skillUpProfile = loadEventProfile(path.resolve("events/skillup-2026/event.config.json"));
  const geumcheonProfile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
  const customTheme = { ...DEFAULT_CONFIG.theme, primaryColor: "#123456" };

  assert.equal(typeof resolveTheme, "function");
  assert.equal(
    resolveTheme?.({ config: { ...DEFAULT_CONFIG, theme: customTheme }, eventProfile: skillUpProfile }).primaryColor,
    "#123456"
  );
  assert.equal(
    resolveTheme?.({ config: { ...DEFAULT_CONFIG, theme: customTheme }, eventProfile: geumcheonProfile }).primaryColor,
    geumcheonProfile.theme.primaryColor
  );
});

test("accepts each permitted Geumcheon device profile", () => {
  for (const deviceId of ["PC01", "PC10", "LEADERBOARD01"] as const) {
    const role = deviceId === "LEADERBOARD01" ? "leaderboard" : "player";
    assert.equal(validateDeviceProfile({ ...validDeviceProfile, deviceId, role }).deviceId, deviceId);
  }
});

test("rejects a device profile with an unknown key", () => {
  assert.throws(() => validateDeviceProfile({ ...validDeviceProfile, unexpected: true }), /unknown key/i);
});

test("rejects a mismatched event or device role", () => {
  assert.throws(
    () => validateDeviceProfile({ ...validDeviceProfile, eventId: "skillup-festa-2026" }),
    /event/i
  );
  assert.throws(
    () => validateDeviceProfile({ ...validDeviceProfile, deviceId: "PC10", role: "leaderboard" }),
    /role/i
  );
});

test("rejects insecure or credential-bearing API URLs", () => {
  for (const apiBaseUrl of [
    "http://records.example.test",
    "https://user:secret@records.example.test",
    "https://records.example.test/api?token=secret",
    "https://records.example.test/api#secret"
  ]) {
    assert.throws(() => validateDeviceProfile({ ...validDeviceProfile, apiBaseUrl }), /HTTPS|credentials|query|hash/i);
  }
});

test("rejects incomplete sessions and invalid retry timing", () => {
  assert.throws(
    () => validateDeviceProfile({ ...validDeviceProfile, sessions: { practice: { sessionId: "practice" } } }),
    /sessions/i
  );
  assert.throws(() => validateDeviceProfile({ ...validDeviceProfile, requestTimeoutMs: 0 }), /positive/i);
  assert.throws(
    () => validateDeviceProfile({ ...validDeviceProfile, retry: { initialDelayMs: 60001, maxDelayMs: 60000 } }),
    /retry/i
  );
});
