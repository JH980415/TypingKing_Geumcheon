import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import type { SafeStorageAdapter } from "../nas/credentialStore";

const MAGIC = Buffer.from([84, 75, 68, 80, 65, 80, 73, 1]);
const PROBE = Buffer.from("TKDPAPI_OK_V1", "ascii");
const PLAIN_LIMIT = 8 * 1024 * 1024;
const CIPHER_LIMIT = PLAIN_LIMIT + 64 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function failed(): never { throw new Error("DPAPI_STORAGE_FAILED"); }
function assertCiphertext(buffer: Buffer): void {
  if (buffer.length > CIPHER_LIMIT) failed();
  if (buffer.length <= MAGIC.length || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("DPAPI_LEGACY_STORAGE_UNSUPPORTED");
  }
}
function assertNoLinks(target: string): void {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      failed();
    }
    if (stat.isSymbolicLink()) failed();
  }
}
export function createWindowsDpapiStorage(resourcesPath: string): SafeStorageAdapter {
  if (!path.isAbsolute(resourcesPath)) failed();
  const helperPath = path.join(resourcesPath, "security", "TypingKingDpapiBridge.exe");
  let available: boolean | undefined;
  function invoke(operation: "protect" | "unprotect" | "probe", input: Buffer): Buffer {
    if (process.platform !== "win32") failed();
    try {
      assertNoLinks(helperPath);
      if (!fs.statSync(helperPath).isFile()) failed();
      const result = spawnSync(helperPath, [operation], {
        input, shell: false, windowsHide: true, timeout: 5000,
        maxBuffer: CIPHER_LIMIT, encoding: "buffer"
      });
      if (result.error || result.signal || result.status !== 0 || result.stderr.length !== 0 || !Buffer.isBuffer(result.stdout)) failed();
      return result.stdout;
    } catch { failed(); }
  }
  const adapter: SafeStorageAdapter = {
    isEncryptionAvailable() {
      if (available === undefined) {
        try { available = invoke("probe", Buffer.alloc(0)).equals(PROBE); } catch { available = false; }
      }
      return available;
    },
    encryptString(value) {
      const input = Buffer.from(value, "utf8");
      try {
        if (input.length > PLAIN_LIMIT || input.toString("utf8") !== value || !adapter.isEncryptionAvailable()) failed();
        const output = invoke("protect", input);
        assertCiphertext(output);
        return output;
      } finally { input.fill(0); }
    },
    decryptString(buffer) {
      assertCiphertext(buffer); // Never ask Chromium to migrate an unknown or v10/v11 envelope.
      if (!adapter.isEncryptionAvailable()) failed();
      const output = invoke("unprotect", buffer);
      try {
        if (output.length > PLAIN_LIMIT) failed();
        return strictUtf8.decode(output);
      } catch { failed(); }
      finally { output.fill(0); }
    }
  };
  return adapter;
}
export function selectDeploymentStorage(options: {
  deploymentProfileVersion?: number; eventProfileId?: string; hasReviewContext: boolean;
  resourcesPath: string; legacy: SafeStorageAdapter;
}): SafeStorageAdapter {
  return options.deploymentProfileVersion === 2 && options.eventProfileId === "geumcheon-2026" && !options.hasReviewContext
    ? createWindowsDpapiStorage(options.resourcesPath) : options.legacy;
}
/** Read-only preflight under the existing device mutation lock, before any profile or queue write. */
export function assertSharedWindowsDpapiStateReadable(options: {
  runtimeRoot: string; installationRoot: string; storage: SafeStorageAdapter;
}): void {
  const nas = path.join(options.runtimeRoot, "nas");
  const files = [
    path.join(options.installationRoot, "selected-profile.bin"),
    path.join(options.installationRoot, "administrator-recovery.bin"),
    ...["deployment-profile.bin", "device-token.bin", "leaderboard-token.bin", "operator-token.bin",
      "active-attempt-official.bin", "active-attempt-practice.bin"].map(name => path.join(nas, name))
  ];
  for (const root of [options.runtimeRoot, options.installationRoot]) assertNoLinks(root);
  for (const kind of ["official", "practice"]) for (const area of ["pending", "blocked"]) {
    const directory = path.join(nas, "outbox", kind, area);
    assertNoLinks(directory);
    if (!fs.existsSync(directory)) continue;
    const names = fs.readdirSync(directory);
    if (names.length > 10000) failed();
    for (const name of names) if (name.endsWith(".bin")) files.push(path.join(directory, name));
  }
  for (const file of files) {
    assertNoLinks(file);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > CIPHER_LIMIT) failed();
    options.storage.decryptString(fs.readFileSync(file));
  }
}
