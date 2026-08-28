import { open, unlink, link } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type AtomicStoreHooks = Partial<{
  beforeWrite: () => void | Promise<void>;
  beforeFileSync: () => void | Promise<void>;
  beforeLink: () => void | Promise<void>;
  beforeDirectorySync: () => void | Promise<void>;
}>;

export async function writeFileNoReplaceAtomic(targetPath: string, bytes: Uint8Array, hooks: AtomicStoreHooks = {}): Promise<void> {
  const parent = dirname(targetPath);
  const temporaryPath = join(parent, `.${basename(targetPath)}.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await hooks.beforeWrite?.();
    await handle.writeFile(bytes);
    await hooks.beforeFileSync?.();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeLink?.();
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    temporaryExists = false;
    await hooks.beforeDirectorySync?.();
    await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function verifyWritableDirectory(directory: string): Promise<boolean> {
  const temporaryPath = join(directory, `.nas-ready-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(temporaryPath);
    await syncDirectory(directory);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
