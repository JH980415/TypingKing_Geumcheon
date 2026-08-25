import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuxiliaryIpLimiter,
  TokenBucketLimiter,
  authenticateRequest,
  type AuthenticationHeaders,
  type TokenManifestV1,
} from "../src/auth.js";
import { loadNasConfig, validateLinuxProtectionChain, type NasConfigEnvironment } from "../src/config.js";

const NOW = Date.parse("2026-08-26T03:00:00.000Z");

function syntheticToken(seed: number): string {
  return Buffer.alloc(32, seed).toString("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function manifest(overrides: Partial<TokenManifestV1["tokens"][number]> = {}): TokenManifestV1 {
  const token = syntheticToken(17);
  return {
    manifestVersion: 1,
    eventId: "geumcheon-science-festival-2026",
    tokens: [{
      tokenId: "PC01-write",
      tokenHash: tokenHash(token),
      deviceId: "PC01",
      role: "writer",
      allowedSessions: ["official", "practice"],
      expiresAt: "2026-08-27T03:00:00.000Z",
      revokedAt: null,
      ...overrides,
    }],
  };
}

function headersFor(deviceId: string, token: string, overrides: Partial<AuthenticationHeaders> = {}): AuthenticationHeaders {
  return {
    authorization: `Bearer ${token}`,
    "x-device-id": deviceId,
    eventId: "geumcheon-science-festival-2026",
    requiredRole: "writer",
    sessionKind: "official",
    ...overrides,
  };
}

test("binds a write token to one device and event", () => {
  const token = syntheticToken(17);
  const principal = authenticateRequest(headersFor("PC01", token), manifest(), NOW);
  assert.deepEqual(principal, {
    tokenId: "PC01-write",
    deviceId: "PC01",
    eventId: "geumcheon-science-festival-2026",
    role: "writer",
    allowedSessions: ["official", "practice"],
  });
  assert.throws(() => authenticateRequest(headersFor("PC02", token), manifest(), NOW), /DEVICE_SCOPE/);
  assert.throws(
    () => authenticateRequest(headersFor("PC01", token, { eventId: "another-event" }), manifest(), NOW),
    /AUTH_INVALID/,
  );
});

test("uses the manifest event scope without requiring a client-controlled event header", () => {
  const token = syntheticToken(17);
  const authenticated = authenticateRequest({
    authorization: `Bearer ${token}`,
    "x-device-id": "PC01",
  }, manifest(), NOW);
  assert.equal(authenticated.eventId, "geumcheon-science-festival-2026");
});

test("accepts an exactly 256-bit base64url token without weakening token length", () => {
  const token = Buffer.alloc(32, 23).toString("base64url");
  const scopedManifest = manifest({ tokenHash: tokenHash(token) });
  assert.equal(authenticateRequest(headersFor("PC01", token), scopedManifest, NOW).tokenId, "PC01-write");
  assert.throws(() => authenticateRequest(headersFor("PC01", token.slice(0, -1)), scopedManifest, NOW), /AUTH_INVALID/);
});

test("rejects missing, malformed, expired, and revoked credentials with stable codes", () => {
  const token = syntheticToken(17);
  assert.throws(() => authenticateRequest({ "x-device-id": "PC01" }, manifest(), NOW), /AUTH_MISSING/);
  assert.throws(() => authenticateRequest(headersFor("PC01", "short"), manifest(), NOW), /AUTH_INVALID/);
  assert.throws(
    () => authenticateRequest(headersFor("PC01", token), manifest({ expiresAt: "2026-08-26T02:59:59.999Z" }), NOW),
    /AUTH_EXPIRED/,
  );
  assert.throws(
    () => authenticateRequest(headersFor("PC01", token), manifest({ revokedAt: "2026-08-26T02:00:00.000Z" }), NOW),
    /AUTH_REVOKED/,
  );
});

test("separates writer, leaderboard, and operator role and session scopes", () => {
  const token = syntheticToken(17);
  assert.throws(
    () => authenticateRequest(headersFor("PC01", token, { requiredRole: "leaderboard" }), manifest(), NOW),
    /ROLE_SCOPE/,
  );
  assert.throws(
    () => authenticateRequest(headersFor("PC01", token, { sessionKind: "practice" }), manifest({ allowedSessions: ["official"] }), NOW),
    /SESSION_SCOPE/,
  );
});

test("limits a token to burst 120 and refills 60 per minute", () => {
  const limiter = new TokenBucketLimiter({ capacity: 120, refillPerSecond: 1 });
  for (let index = 0; index < 120; index += 1) assert.equal(limiter.consume("PC01-write", 0).allowed, true);
  const blocked = limiter.consume("PC01-write", 0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1000);
  assert.equal(limiter.consume("PC01-write", 1000).allowed, true);
});

test("keeps the shared-IP limiter auxiliary and above normal ten-PC traffic", () => {
  const limiter = new AuxiliaryIpLimiter({ capacity: 2400, refillPerSecond: 40 });
  for (let index = 0; index < 2400; index += 1) assert.equal(limiter.consume("proxy-peer", 0).allowed, true);
  assert.deepEqual(limiter.consume("proxy-peer", 0), { allowed: false, retryAfterMs: 25 });
  assert.equal(limiter.consume("proxy-peer", 25).allowed, true);
});

test("rejects unsafe limiter configuration without disclosing identifiers", () => {
  assert.throws(() => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1 }), /RATE_LIMIT_CONFIG_INVALID/);
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
  assert.throws(() => limiter.consume("", 0), /RATE_LIMIT_KEY_INVALID/);
  assert.throws(() => limiter.consume("synthetic-id", Number.NaN), /RATE_LIMIT_TIME_INVALID/);
});

function configFixture() {
  const root = mkdtempSync(join(tmpdir(), "typingking-nas-config-"));
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot);
  const catalogPath = join(root, "stage_texts.csv");
  writeFileSync(catalogPath, "id,catalog_version,game_mode,stage_number,text,is_active,created_at,updated_at\n", "utf8");
  const eventConfigPath = join(root, "event.json");
  const tokenManifestPath = join(root, "tokens.json");
  const hmacPath = join(root, "participant-hmac.key");
  const eventConfig = {
    schemaVersion: 1,
    eventId: "geumcheon-science-festival-2026",
    recordBaseFolderName: "기록저장",
    stageTextCatalogPath: catalogPath,
    allowedSessions: {
      official: [{ sessionId: "official-day1-round1", dayNo: 1, roundNo: 1 }],
      practice: { sessionId: "practice-2026" },
    },
    aiRanges: {
      official: [[150, 200], [200, 250], [250, 300]],
      practice: [[100, 150], [150, 200], [200, 250]],
    },
  };
  const tokenManifest = manifest();
  writeFileSync(eventConfigPath, JSON.stringify(eventConfig), "utf8");
  writeFileSync(tokenManifestPath, JSON.stringify(tokenManifest), "utf8");
  writeFileSync(hmacPath, Buffer.alloc(32, 29));
  const env: NasConfigEnvironment = {
    NAS_EVENT_CONFIG: eventConfigPath,
    NAS_TOKEN_MANIFEST: tokenManifestPath,
    NAS_DATA_ROOT: dataRoot,
    NAS_PARTICIPANT_HMAC_KEY_FILE: hmacPath,
  };
  return { root, env, eventConfigPath, tokenManifestPath, hmacPath, catalogPath, eventConfig, tokenManifest };
}

function loadSyntheticConfig(env: NasConfigEnvironment) {
  return loadNasConfig(env, process.platform === "win32" ? { windowsAclVerifier: () => true } : {});
}

test("loads strict NAS configuration from only the four approved environment paths", (context) => {
  const fixture = configFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const loaded = loadSyntheticConfig(fixture.env);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.dataRoot, fixture.env.NAS_DATA_ROOT);
  assert.deepEqual(loaded.aiRanges.official, [[150, 200], [200, 250], [250, 300]]);
  assert.deepEqual(loaded.aiRanges.practice, [[100, 150], [150, 200], [200, 250]]);
  assert.equal(loaded.tokenManifest.tokens[0]?.tokenId, "PC01-write");
  assert.equal(loaded.participantHmacKey.byteLength, 32);
});

test("rejects unknown configuration keys and short HMAC material", (context) => {
  const fixture = configFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(fixture.eventConfigPath, JSON.stringify({ ...fixture.eventConfig, unexpected: true }), "utf8");
  assert.throws(() => loadSyntheticConfig(fixture.env), /CONFIG_UNKNOWN_KEY/);

  writeFileSync(fixture.eventConfigPath, JSON.stringify(fixture.eventConfig), "utf8");
  writeFileSync(fixture.hmacPath, Buffer.alloc(31, 29));
  assert.throws(() => loadSyntheticConfig(fixture.env), /HMAC_KEY_INVALID/);
});

test("rejects a missing configured phrase catalog", (context) => {
  const fixture = configFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  rmSync(fixture.catalogPath);
  assert.throws(() => loadSyntheticConfig(fixture.env), /CONFIG_FILE_PERMISSION_INVALID/);
});

test("rejects duplicate token IDs and hashes without accepting plaintext token fields", (context) => {
  const fixture = configFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const original = fixture.tokenManifest.tokens[0]!;
  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [original, { ...original }] }),
    "utf8",
  );
  assert.throws(() => loadSyntheticConfig(fixture.env), /TOKEN_ID_DUPLICATE/);

  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [original, { ...original, tokenId: "PC02-write", deviceId: "PC02" }] }),
    "utf8",
  );
  assert.throws(() => loadSyntheticConfig(fixture.env), /TOKEN_HASH_DUPLICATE/);

  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [{ ...original, plaintextToken: syntheticToken(17) }] }),
    "utf8",
  );
  assert.throws(() => loadSyntheticConfig(fixture.env), /TOKEN_UNKNOWN_KEY/);
});

test("rejects impossible token dates while accepting a real leap day", (context) => {
  const fixture = configFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const original = fixture.tokenManifest.tokens[0]!;

  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [{ ...original, expiresAt: "2025-02-29T00:00:00.000Z" }] }),
    "utf8",
  );
  assert.throws(() => loadSyntheticConfig(fixture.env), /TOKEN_EXPIRY_INVALID/);

  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [{ ...original, expiresAt: "2028-02-29T00:00:00.000Z" }] }),
    "utf8",
  );
  assert.equal(loadSyntheticConfig(fixture.env).tokenManifest.tokens[0]?.expiresAt, "2028-02-29T00:00:00.000Z");

  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [{ ...original, revokedAt: "2025-02-29T00:00:00.000Z" }] }),
    "utf8",
  );
  assert.throws(() => loadSyntheticConfig(fixture.env), /TOKEN_REVOCATION_INVALID/);

  writeFileSync(
    fixture.tokenManifestPath,
    JSON.stringify({ ...fixture.tokenManifest, tokens: [{ ...original, revokedAt: "2028-02-29T00:00:00.000Z" }] }),
    "utf8",
  );
  assert.equal(loadSyntheticConfig(fixture.env).tokenManifest.tokens[0]?.revokedAt, "2028-02-29T00:00:00.000Z");
});

test("enforces Linux owner and replacement permissions for leaves and parent directories", () => {
  const validChain = [
    { type: "file" as const, uid: 1000, mode: 0o100600 },
    { type: "directory" as const, uid: 1000, mode: 0o40700 },
    { type: "directory" as const, uid: 0, mode: 0o40755 },
  ];
  assert.doesNotThrow(() => validateLinuxProtectionChain(validChain, [0, 1000]));
  assert.throws(
    () => validateLinuxProtectionChain([{ ...validChain[0]!, uid: 2000 }, ...validChain.slice(1)], [0, 1000]),
    /CONFIG_FILE_OWNER_INVALID/,
  );
  assert.throws(
    () => validateLinuxProtectionChain([{ ...validChain[0]!, mode: 0o100620 }, ...validChain.slice(1)], [0, 1000]),
    /CONFIG_FILE_PERMISSION_INVALID/,
  );
  assert.throws(
    () => validateLinuxProtectionChain([validChain[0]!, { ...validChain[1]!, mode: 0o40770 }, validChain[2]!], [0, 1000]),
    /CONFIG_FILE_PERMISSION_INVALID/,
  );
  assert.doesNotThrow(() => validateLinuxProtectionChain([
    validChain[0]!,
    validChain[1]!,
    { type: "directory", uid: 0, mode: 0o41777 },
    validChain[2]!,
  ], [0, 1000]));
});

test("requires an explicit Windows ACL trust decision", { skip: process.platform !== "win32" }, (context) => {
  const fixture = configFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(() => loadNasConfig(fixture.env), /CONFIG_FILE_TRUST_UNVERIFIED/);
  assert.throws(
    () => loadNasConfig(fixture.env, { windowsAclVerifier: () => false }),
    /CONFIG_FILE_PERMISSION_INVALID/,
  );
  assert.equal(loadNasConfig(fixture.env, { windowsAclVerifier: () => true }).schemaVersion, 1);
});

test("rejects configuration files reached through a directory junction", { skip: process.platform !== "win32" }, (context) => {
  const fixture = configFixture();
  const junctionRoot = `${fixture.root}-junction`;
  symlinkSync(fixture.root, junctionRoot, "junction");
  context.after(() => {
    rmdirSync(junctionRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const throughJunction: NasConfigEnvironment = {
    NAS_EVENT_CONFIG: join(junctionRoot, "event.json"),
    NAS_TOKEN_MANIFEST: join(junctionRoot, "tokens.json"),
    NAS_DATA_ROOT: join(junctionRoot, "data"),
    NAS_PARTICIPANT_HMAC_KEY_FILE: join(junctionRoot, "participant-hmac.key"),
  };
  assert.throws(
    () => loadNasConfig(throughJunction, { windowsAclVerifier: () => true }),
    /CONFIG_FILE_SUBSTITUTION/,
  );
});
