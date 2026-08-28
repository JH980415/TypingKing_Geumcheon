import { readFile, unlink } from "node:fs/promises";
import { GEUMCHEON_NAS_EVENT_ID } from "../../shared/nas/protocol";
import { isEncoded256BitToken, normalizeNasApiBaseUrl, type NasCredentialStore } from "./credentialStore";

export type BootstrapCredentialStore = Pick<NasCredentialStore, "importToken" | "getToken">;

export type BootstrapCredentialResult = {
  status: "imported" | "existing";
};

export type BootstrapCredentialFileSystem = {
  readFile(filePath: string): Promise<string>;
  unlink(filePath: string): Promise<void>;
};

export type BootstrapCredentialOptions = {
  filePath: string;
  expectedEventId: string;
  expectedDeviceId: string;
  expectedApiBaseUrl: string;
  store: BootstrapCredentialStore;
  verifyCredential(): Promise<unknown>;
  fileSystem?: BootstrapCredentialFileSystem;
};

type BootstrapCredential = {
  schemaVersion: 1;
  eventId: typeof GEUMCHEON_NAS_EVENT_ID;
  deviceId: string;
  apiBaseUrl: string;
  token: string;
};

const defaultFileSystem: BootstrapCredentialFileSystem = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  unlink,
};

export async function importBootstrapCredential(
  options: BootstrapCredentialOptions,
): Promise<BootstrapCredentialResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  let text: string;
  try {
    text = await fileSystem.readFile(options.filePath);
  } catch (error) {
    if (isNotFound(error)) return useExistingCredential(options.store);
    throw new Error("BOOTSTRAP_CREDENTIAL_READ_FAILED");
  }

  const credential = parseCredential(text);
  if (credential.eventId !== GEUMCHEON_NAS_EVENT_ID || credential.eventId !== options.expectedEventId) {
    throw new Error("BOOTSTRAP_CREDENTIAL_EVENT_MISMATCH");
  }
  if (credential.deviceId !== options.expectedDeviceId) {
    throw new Error("BOOTSTRAP_CREDENTIAL_DEVICE_MISMATCH");
  }
  let expectedApiBaseUrl: string;
  try {
    expectedApiBaseUrl = normalizeNasApiBaseUrl(options.expectedApiBaseUrl);
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_API_MISMATCH");
  }
  if (credential.apiBaseUrl !== expectedApiBaseUrl) {
    throw new Error("BOOTSTRAP_CREDENTIAL_API_MISMATCH");
  }

  try {
    await options.store.importToken(credential.token);
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_IMPORT_FAILED");
  }

  let storedToken: string;
  try {
    storedToken = await options.store.getToken();
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_READBACK_FAILED");
  }
  if (storedToken !== credential.token) throw new Error("BOOTSTRAP_CREDENTIAL_READBACK_MISMATCH");

  try {
    await options.verifyCredential();
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_AUTH_FAILED");
  }

  try {
    await fileSystem.unlink(options.filePath);
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_DELETE_FAILED");
  }
  return { status: "imported" };
}

async function useExistingCredential(store: BootstrapCredentialStore): Promise<BootstrapCredentialResult> {
  let token: string;
  try {
    token = await store.getToken();
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_EXISTING_INVALID");
  }
  if (!isEncoded256BitToken(token)) throw new Error("BOOTSTRAP_CREDENTIAL_EXISTING_INVALID");
  return { status: "existing" };
}

function parseCredential(text: string): BootstrapCredential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_INVALID");
  }
  if (!isObject(value)) throw new Error("BOOTSTRAP_CREDENTIAL_INVALID");
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "apiBaseUrl,deviceId,eventId,schemaVersion,token"
    || value.schemaVersion !== 1
    || typeof value.eventId !== "string"
    || typeof value.deviceId !== "string"
    || value.deviceId.length === 0
    || typeof value.apiBaseUrl !== "string"
    || !isEncoded256BitToken(value.token)
  ) {
    throw new Error("BOOTSTRAP_CREDENTIAL_INVALID");
  }
  let apiBaseUrl: string;
  try {
    apiBaseUrl = normalizeNasApiBaseUrl(value.apiBaseUrl);
  } catch {
    throw new Error("BOOTSTRAP_CREDENTIAL_INVALID");
  }
  return { ...value, apiBaseUrl } as BootstrapCredential;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
