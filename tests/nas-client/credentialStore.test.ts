import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NasCredentialStore, type SafeStorageAdapter } from "../../electron/nas/credentialStore";

const token = "1".repeat(64);
const binding = {
  eventId: "geumcheon-science-festival-2026",
  deviceId: "PC01",
  apiBaseUrl: "https://records.example.test",
};

function safeStorage(available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => Buffer.from(value.toString().slice("encrypted:".length), "base64").toString(),
  };
}

test("imports a token encrypted and decrypts it only when requested", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-credential-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "device-token.bin");
  const store = new NasCredentialStore({ filePath, safeStorage: safeStorage(), ...binding });

  await store.importToken(token);

  const bytes = await readFile(filePath);
  assert.equal(bytes.includes(Buffer.from(token)), false);
  assert.equal(await store.getToken(), token);
});

test("refuses import and use when operating-system encryption is unavailable", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-credential-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new NasCredentialStore({ filePath: path.join(root, "token.bin"), safeStorage: safeStorage(false), ...binding });

  await assert.rejects(() => store.importToken(token), /SAFE_STORAGE_UNAVAILABLE/);
  await assert.rejects(() => store.getToken(), /SAFE_STORAGE_UNAVAILABLE/);
});

test("does not include a rejected token in its error", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-credential-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new NasCredentialStore({ filePath: path.join(root, "token.bin"), safeStorage: safeStorage(), ...binding });

  await assert.rejects(
    () => store.importToken("short"),
    (error: unknown) => error instanceof Error && error.message === "NAS_CREDENTIAL_INVALID" && !error.message.includes("short"),
  );
});

test("rejects an encrypted credential when event device or API binding changes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-credential-binding-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "device-token.bin");
  const originalOptions = { filePath, safeStorage: safeStorage(), ...binding };
  await new NasCredentialStore(originalOptions).importToken(token);

  for (const changed of [
    { ...originalOptions, eventId: "another-event" },
    { ...originalOptions, deviceId: "PC02" },
    { ...originalOptions, apiBaseUrl: "https://attacker.example.test" },
  ]) {
    await assert.rejects(
      () => new NasCredentialStore(changed).getToken(),
      (error: unknown) => error instanceof Error && error.message === "NAS_CREDENTIAL_BINDING_MISMATCH",
    );
  }
});

test("normalizes the bound HTTPS API URL but rejects unsafe URLs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-credential-url-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "device-token.bin");
  await new NasCredentialStore({ filePath, safeStorage: safeStorage(), ...binding, apiBaseUrl: "https://records.example.test/" }).importToken(token);
  assert.equal(await new NasCredentialStore({ filePath, safeStorage: safeStorage(), ...binding }).getToken(), token);

  for (const apiBaseUrl of ["http://records.example.test", "https://user:pass@records.example.test", "https://records.example.test?q=1"] ) {
    assert.throws(() => new NasCredentialStore({ filePath, safeStorage: safeStorage(), ...binding, apiBaseUrl }), /NAS_BASE_URL/);
  }
});

test("rejects tokens that are not exactly 256-bit hex or base64url", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-credential-format-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new NasCredentialStore({ filePath: path.join(root, "device-token.bin"), safeStorage: safeStorage(), ...binding });

  await assert.rejects(() => store.importToken("device-secret-token-1234567890"), /NAS_CREDENTIAL_INVALID/);
  await store.importToken("2".repeat(64));
  assert.equal(await store.getToken(), "2".repeat(64));
});
