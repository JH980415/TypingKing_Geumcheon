import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./atomicFile";

export type SafeStorageAdapter = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type NasCredentialBinding = {
  eventId: string;
  deviceId: string;
  apiBaseUrl: string;
};

type StoredNasCredentialV1 = {
  schemaVersion: 1;
  eventId: string;
  deviceId: string;
  apiBaseUrl: string;
  token: string;
};

export class NasCredentialStore {
  private readonly binding: NasCredentialBinding;

  constructor(private readonly options: {
    filePath: string;
    safeStorage: SafeStorageAdapter;
    eventId: string;
    deviceId: string;
    apiBaseUrl: string;
  }) {
    this.binding = normalizeNasCredentialBinding(options);
  }

  async importToken(token: string): Promise<void> {
    this.assertAvailable();
    if (!isEncoded256BitToken(token)) throw new Error("NAS_CREDENTIAL_INVALID");
    const credential: StoredNasCredentialV1 = {
      schemaVersion: 1,
      ...this.binding,
      token,
    };
    let encrypted: Buffer;
    try {
      encrypted = this.options.safeStorage.encryptString(JSON.stringify(credential));
    } catch {
      throw new Error("NAS_CREDENTIAL_ENCRYPT_FAILED");
    }
    await atomicWriteFile(this.options.filePath, encrypted);
  }

  async getToken(): Promise<string> {
    this.assertAvailable();
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.options.filePath);
    } catch {
      throw new Error("NAS_CREDENTIAL_MISSING");
    }
    let decrypted: string;
    try {
      decrypted = this.options.safeStorage.decryptString(encrypted);
    } catch {
      throw new Error("NAS_CREDENTIAL_DECRYPT_FAILED");
    }
    const credential = parseStoredCredential(decrypted);
    if (
      credential.eventId !== this.binding.eventId
      || credential.deviceId !== this.binding.deviceId
      || credential.apiBaseUrl !== this.binding.apiBaseUrl
    ) {
      throw new Error("NAS_CREDENTIAL_BINDING_MISMATCH");
    }
    return credential.token;
  }

  private assertAvailable(): void {
    if (!this.options.safeStorage.isEncryptionAvailable()) throw new Error("SAFE_STORAGE_UNAVAILABLE");
  }
}

export function normalizeNasApiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("NAS_BASE_URL_INVALID"); }
  if (url.protocol !== "https:") throw new Error("NAS_BASE_URL_HTTPS_REQUIRED");
  if (url.username || url.password || url.search || url.hash) throw new Error("NAS_BASE_URL_INVALID");
  return url.toString().replace(/\/$/, "");
}

export function isEncoded256BitToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^[0-9a-f]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function normalizeNasCredentialBinding(value: NasCredentialBinding): NasCredentialBinding {
  if (typeof value.eventId !== "string" || value.eventId.trim() === "") throw new Error("NAS_CREDENTIAL_BINDING_INVALID");
  if (!/^(?:PC(?:0[1-9]|10)|LEADERBOARD01)$/.test(value.deviceId)) throw new Error("NAS_CREDENTIAL_BINDING_INVALID");
  return { eventId: value.eventId, deviceId: value.deviceId, apiBaseUrl: normalizeNasApiBaseUrl(value.apiBaseUrl) };
}

function parseStoredCredential(value: string): StoredNasCredentialV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("NAS_CREDENTIAL_INVALID"); }
  if (!isObject(parsed)) throw new Error("NAS_CREDENTIAL_INVALID");
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "apiBaseUrl,deviceId,eventId,schemaVersion,token"
    || parsed.schemaVersion !== 1 || typeof parsed.eventId !== "string" || typeof parsed.deviceId !== "string"
    || typeof parsed.apiBaseUrl !== "string" || !isEncoded256BitToken(parsed.token)) throw new Error("NAS_CREDENTIAL_INVALID");
  return parsed as StoredNasCredentialV1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
