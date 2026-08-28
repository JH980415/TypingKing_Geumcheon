import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  importBootstrapCredential,
  type BootstrapCredentialFileSystem,
  type BootstrapCredentialOptions,
  type BootstrapCredentialStore,
} from "../../electron/nas/bootstrapCredential";
import { NasCredentialStore, type SafeStorageAdapter } from "../../electron/nas/credentialStore";

const EVENT_ID = "geumcheon-science-festival-2026";
const DEVICE_ID = "PC01";
const API_BASE_URL = "https://records.example.test";
const SYNTHETIC_TOKEN = "3".repeat(64);
const STORE_BINDING = { eventId: EVENT_ID, deviceId: DEVICE_ID, apiBaseUrl: API_BASE_URL };

function safeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => Buffer.from(value.toString().slice("encrypted:".length), "base64").toString(),
  };
}

function runBootstrapImport(
  options: Omit<BootstrapCredentialOptions, "expectedApiBaseUrl" | "verifyCredential">
    & Partial<Pick<BootstrapCredentialOptions, "expectedApiBaseUrl" | "verifyCredential">>,
) {
  return importBootstrapCredential({
    expectedApiBaseUrl: API_BASE_URL,
    verifyCredential: async () => undefined,
    ...options,
  });
}
test("imports an exact bootstrap credential, verifies it, and consumes the plaintext file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPath = path.join(root, "bootstrap-credentials.json");
  const encryptedPath = path.join(root, "device-token.bin");
  await writeFile(bootstrapPath, JSON.stringify({
    schemaVersion: 1,
    eventId: EVENT_ID,
    deviceId: DEVICE_ID,
    apiBaseUrl: API_BASE_URL,
    token: SYNTHETIC_TOKEN,
  }));
  const store = new NasCredentialStore({ filePath: encryptedPath, safeStorage: safeStorage(), ...STORE_BINDING });

  const result = await runBootstrapImport({
    filePath: bootstrapPath,
    expectedEventId: EVENT_ID,
    expectedDeviceId: DEVICE_ID,
    store,
  });

  assert.deepEqual(result, { status: "imported" });
  assert.equal(await store.getToken(), SYNTHETIC_TOKEN);
  assert.equal((await readFile(encryptedPath)).includes(Buffer.from(SYNTHETIC_TOKEN)), false);
  await assert.rejects(() => readFile(bootstrapPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("uses an already encrypted credential when the bootstrap file is absent", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new NasCredentialStore({
    filePath: path.join(root, "device-token.bin"),
    safeStorage: safeStorage(),
    ...STORE_BINDING,
  });
  await store.importToken(SYNTHETIC_TOKEN);

  const result = await runBootstrapImport({
    filePath: path.join(root, "bootstrap-credentials.json"),
    expectedEventId: EVENT_ID,
    expectedDeviceId: DEVICE_ID,
    store,
  });

  assert.deepEqual(result, { status: "existing" });
  assert.equal(await store.getToken(), SYNTHETIC_TOKEN);
});

test("rejects anything other than the exact bootstrap schema without consuming the file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const invalidPayloads: ReadonlyArray<{ name: string; value: unknown }> = [
    {
      name: "extra-field",
      value: { schemaVersion: 1, eventId: EVENT_ID, deviceId: DEVICE_ID, apiBaseUrl: API_BASE_URL, token: SYNTHETIC_TOKEN, extra: true },
    },
    {
      name: "missing-field",
      value: { schemaVersion: 1, eventId: EVENT_ID, deviceId: DEVICE_ID },
    },
    {
      name: "wrong-schema-version",
      value: { schemaVersion: 2, eventId: EVENT_ID, deviceId: DEVICE_ID, apiBaseUrl: API_BASE_URL, token: SYNTHETIC_TOKEN },
    },
    {
      name: "wrong-token-type",
      value: { schemaVersion: 1, eventId: EVENT_ID, deviceId: DEVICE_ID, apiBaseUrl: API_BASE_URL, token: 123 },
    },
    {
      name: "invalid-token",
      value: { schemaVersion: 1, eventId: EVENT_ID, deviceId: DEVICE_ID, apiBaseUrl: API_BASE_URL, token: "short" },
    },
    { name: "array-root", value: [] },
  ];

  for (const invalid of invalidPayloads) {
    const bootstrapPath = path.join(root, `${invalid.name}.json`);
    const encryptedPath = path.join(root, `${invalid.name}.bin`);
    await writeFile(bootstrapPath, JSON.stringify(invalid.value));
    const store = new NasCredentialStore({ filePath: encryptedPath, safeStorage: safeStorage(), ...STORE_BINDING });

    await assert.rejects(
      () => runBootstrapImport({
        filePath: bootstrapPath,
        expectedEventId: EVENT_ID,
        expectedDeviceId: DEVICE_ID,
        store,
      }),
      (error: unknown) => error instanceof Error
        && error.message === "BOOTSTRAP_CREDENTIAL_INVALID"
        && !error.message.includes(SYNTHETIC_TOKEN),
      invalid.name,
    );
    assert.deepEqual(JSON.parse(await readFile(bootstrapPath, "utf8")), invalid.value);
    await assert.rejects(() => readFile(encryptedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  }
});

test("rejects event and device mismatches before importing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mismatches = [
    {
      name: "event",
      payload: { schemaVersion: 1, eventId: "another-event", deviceId: DEVICE_ID, apiBaseUrl: API_BASE_URL, token: SYNTHETIC_TOKEN },
      code: "BOOTSTRAP_CREDENTIAL_EVENT_MISMATCH",
    },
    {
      name: "device",
      payload: { schemaVersion: 1, eventId: EVENT_ID, deviceId: "PC02", apiBaseUrl: API_BASE_URL, token: SYNTHETIC_TOKEN },
      code: "BOOTSTRAP_CREDENTIAL_DEVICE_MISMATCH",
    },
  ] as const;

  for (const mismatch of mismatches) {
    const bootstrapPath = path.join(root, `${mismatch.name}.json`);
    const encryptedPath = path.join(root, `${mismatch.name}.bin`);
    await writeFile(bootstrapPath, JSON.stringify(mismatch.payload));
    const store = new NasCredentialStore({ filePath: encryptedPath, safeStorage: safeStorage(), ...STORE_BINDING });

    await assert.rejects(
      () => runBootstrapImport({
        filePath: bootstrapPath,
        expectedEventId: EVENT_ID,
        expectedDeviceId: DEVICE_ID,
        store,
      }),
      (error: unknown) => error instanceof Error && error.message === mismatch.code,
    );
    assert.deepEqual(JSON.parse(await readFile(bootstrapPath, "utf8")), mismatch.payload);
    await assert.rejects(() => readFile(encryptedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  }
});

test("keeps the bootstrap file when encrypted read-back differs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPath = path.join(root, "bootstrap-credentials.json");
  await writeFile(bootstrapPath, JSON.stringify({
    schemaVersion: 1,
    eventId: EVENT_ID,
    deviceId: DEVICE_ID,
    apiBaseUrl: API_BASE_URL,
    token: SYNTHETIC_TOKEN,
  }));
  const mismatchingStore: BootstrapCredentialStore = {
    importToken: async () => undefined,
    getToken: async () => "different-synthetic-token-9876543210",
  };

  await assert.rejects(
    () => runBootstrapImport({
      filePath: bootstrapPath,
      expectedEventId: EVENT_ID,
      expectedDeviceId: DEVICE_ID,
      store: mismatchingStore,
    }),
    (error: unknown) => error instanceof Error
      && error.message === "BOOTSTRAP_CREDENTIAL_READBACK_MISMATCH"
      && !error.message.includes(SYNTHETIC_TOKEN),
  );
  assert.equal(JSON.parse(await readFile(bootstrapPath, "utf8")).token, SYNTHETIC_TOKEN);
});

test("sanitizes credential-store failures and keeps the bootstrap file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const failures: ReadonlyArray<{
    name: string;
    expectedCode: string;
    store: BootstrapCredentialStore;
  }> = [
    {
      name: "import",
      expectedCode: "BOOTSTRAP_CREDENTIAL_IMPORT_FAILED",
      store: {
        importToken: async (token) => { throw new Error(`failed to import ${token}`); },
        getToken: async () => SYNTHETIC_TOKEN,
      },
    },
    {
      name: "readback",
      expectedCode: "BOOTSTRAP_CREDENTIAL_READBACK_FAILED",
      store: {
        importToken: async () => undefined,
        getToken: async () => { throw new Error(`failed to read ${SYNTHETIC_TOKEN}`); },
      },
    },
  ];

  for (const failure of failures) {
    const bootstrapPath = path.join(root, `${failure.name}.json`);
    await writeFile(bootstrapPath, JSON.stringify({
      schemaVersion: 1,
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
      apiBaseUrl: API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    }));

    await assert.rejects(
      () => runBootstrapImport({
        filePath: bootstrapPath,
        expectedEventId: EVENT_ID,
        expectedDeviceId: DEVICE_ID,
        store: failure.store,
      }),
      (error: unknown) => error instanceof Error
        && error.message === failure.expectedCode
        && !error.message.includes(SYNTHETIC_TOKEN),
    );
    assert.equal(JSON.parse(await readFile(bootstrapPath, "utf8")).token, SYNTHETIC_TOKEN);
  }
});

test("returns a safe failure when the consumed bootstrap file cannot be deleted", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPath = path.join(root, "bootstrap-credentials.json");
  await writeFile(bootstrapPath, JSON.stringify({
    schemaVersion: 1,
    eventId: EVENT_ID,
    deviceId: DEVICE_ID,
    apiBaseUrl: API_BASE_URL,
    token: SYNTHETIC_TOKEN,
  }));
  const store = new NasCredentialStore({
    filePath: path.join(root, "device-token.bin"),
    safeStorage: safeStorage(),
    ...STORE_BINDING,
  });
  const fileSystem: BootstrapCredentialFileSystem = {
    readFile: (filePath) => readFile(filePath, "utf8"),
    unlink: async () => { throw new Error(`cannot delete ${SYNTHETIC_TOKEN}`); },
  };

  await assert.rejects(
    () => runBootstrapImport({
      filePath: bootstrapPath,
      expectedEventId: EVENT_ID,
      expectedDeviceId: DEVICE_ID,
      store,
      fileSystem,
    }),
    (error: unknown) => error instanceof Error
      && error.message === "BOOTSTRAP_CREDENTIAL_DELETE_FAILED"
      && !error.message.includes(SYNTHETIC_TOKEN),
  );
  assert.equal(await store.getToken(), SYNTHETIC_TOKEN);
  assert.equal(JSON.parse(await readFile(bootstrapPath, "utf8")).token, SYNTHETIC_TOKEN);
});

test("sanitizes an invalid existing credential when the bootstrap file is absent", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store: BootstrapCredentialStore = {
    importToken: async () => undefined,
    getToken: async () => { throw new Error(`missing ${SYNTHETIC_TOKEN}`); },
  };

  await assert.rejects(
    () => runBootstrapImport({
      filePath: path.join(root, "bootstrap-credentials.json"),
      expectedEventId: EVENT_ID,
      expectedDeviceId: DEVICE_ID,
      store,
    }),
    (error: unknown) => error instanceof Error
      && error.message === "BOOTSTRAP_CREDENTIAL_EXISTING_INVALID"
      && !error.message.includes(SYNTHETIC_TOKEN),
  );
});

test("does not import a bootstrap token bound to a different API URL", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-binding-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPath = path.join(root, "bootstrap-credentials.json");
  await writeFile(bootstrapPath, JSON.stringify({
    schemaVersion: 1,
    eventId: EVENT_ID,
    deviceId: DEVICE_ID,
    apiBaseUrl: "https://records.example.test",
    token: "4".repeat(64),
  }));
  let imported = false;
  const store: BootstrapCredentialStore = {
    importToken: async () => { imported = true; },
    getToken: async () => "4".repeat(64),
  };
  const options = {
    filePath: bootstrapPath,
    expectedEventId: EVENT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedApiBaseUrl: "https://attacker.example.test",
    store,
    verifyCredential: async () => undefined,
  };

  await assert.rejects(
    () => runBootstrapImport(options),
    (error: unknown) => error instanceof Error && error.message === "BOOTSTRAP_CREDENTIAL_API_MISMATCH",
  );
  assert.equal(imported, false);
  assert.equal(JSON.parse(await readFile(bootstrapPath, "utf8")).token, "4".repeat(64));
});

test("keeps plaintext bootstrap until authenticated readiness succeeds", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "typingking-bootstrap-auth-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPath = path.join(root, "bootstrap-credentials.json");
  await writeFile(bootstrapPath, JSON.stringify({
    schemaVersion: 1,
    eventId: EVENT_ID,
    deviceId: DEVICE_ID,
    apiBaseUrl: "https://records.example.test",
    token: "5".repeat(64),
  }));
  const store: BootstrapCredentialStore = {
    importToken: async () => undefined,
    getToken: async () => "5".repeat(64),
  };
  const options = {
    filePath: bootstrapPath,
    expectedEventId: EVENT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedApiBaseUrl: "https://records.example.test",
    store,
    verifyCredential: async () => { throw new Error("secret server detail"); },
  };

  await assert.rejects(
    () => runBootstrapImport(options),
    (error: unknown) => error instanceof Error && error.message === "BOOTSTRAP_CREDENTIAL_AUTH_FAILED" && !error.message.includes("secret"),
  );
  assert.equal(JSON.parse(await readFile(bootstrapPath, "utf8")).token, "5".repeat(64));
});
