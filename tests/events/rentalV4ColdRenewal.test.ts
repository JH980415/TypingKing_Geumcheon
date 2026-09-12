import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as profiles from "../../electron/deploymentProfile";
import { EncryptedNasOutbox } from "../../electron/nas/outbox";
import { createActiveAttemptStore } from "../../electron/activeAttemptStore";
import { profileFixture } from "./rentalV4Fixture";

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from("protected:" + s),
  decryptString: (b: Buffer) => {
    const text = b.toString();
    if (!text.startsWith("protected:")) throw new Error("BAD_CIPHER");
    return text.slice(10);
  }
};
function fixture(context: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r4-auto-renewal-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "client"), runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(directory); fs.mkdirSync(path.join(runtimeRoot, "nas"), { recursive: true });
  const old = profileFixture();
  old.issuedAt = old.notBefore = "2026-01-01T00:00:00.000Z";
  old.expiresAt = "2026-02-01T00:00:00.000Z";
  const next = profiles.parseDeploymentProfile({
    ...structuredClone(old), deploymentId: "renewed", expiresAt: "2099-01-01T00:00:00.000Z",
    credentials: {
      writer: { ...old.credentials.writer, token: "c".repeat(64) },
      leaderboard: { ...old.credentials.leaderboard, token: "d".repeat(64) }
    }
  });
  const selectedFilePath = path.join(directory, "player_01.device-profile.json");
  const selectionPath = path.join(root, "selected-profile.bin");
  const protectedPath = path.join(runtimeRoot, "nas", "deployment-profile.bin");
  fs.writeFileSync(selectedFilePath, JSON.stringify(old));
  profiles.saveDeploymentSelection(selectionPath, directory, old as any, selectedFilePath, storage);
  fs.writeFileSync(protectedPath, storage.encryptString(JSON.stringify(old)));
  fs.writeFileSync(selectedFilePath, JSON.stringify(next));
  const options = { selectionPath, directory, safeStorage: storage, runtimeRootForProfile: () => runtimeRoot };
  const original = () => [fs.readFileSync(selectionPath), fs.readFileSync(protectedPath)];
  const renew = async () => (profiles as any).renewExpiredAdjacentDeployment(options);
  return { root, directory, runtimeRoot, old, next, selectedFilePath, selectionPath, protectedPath, options, original, renew };
}
test("R4 control: old normal startup rejects expiry before the valid adjacent profile", context => {
  const f = fixture(context);
  assert.throws(() => profiles.readDeploymentSelection(f.selectionPath, f.directory, storage), /PROFILE_EXPIRED/);
  assert.throws(() => new profiles.DeploymentProfileStore(f.protectedPath, storage).activate(f.next), /PROFILE_EXPIRED/);
  assert.throws(() => new profiles.DeploymentProfileStore(f.protectedPath, storage).token("writer"), /PROFILE_EXPIRED/);
});
test("R4 cold same-name renewal updates both protected caches and permits normal strict startup", async context => {
  const f = fixture(context);
  assert.equal(await f.renew(), true);
  const saved = profiles.readDeploymentSelection(f.selectionPath, f.directory, storage)!;
  assert.deepEqual(saved.profile, f.next);
  const store = new profiles.DeploymentProfileStore(f.protectedPath, storage);
  store.activate(saved.profile);
  assert.equal(store.token("writer"), f.next.credentials.writer!.token);
  assert.equal(store.token("leaderboard"), f.next.credentials.leaderboard.token);
  assert.equal(await f.renew(), false);
});
test("R4 cold renewal preserves original pending envelope and all unrelated runtime bytes", async context => {
  const f = fixture(context);
  const outbox = new EncryptedNasOutbox({ rootDir: path.join(f.runtimeRoot, "nas", "outbox"), safeStorage: storage });
  const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";
  const envelope: any = { schema_version: 1, event_id: f.next.device.eventId, session: { kind: "official", session_id: "day1-round1", day_no: 1, round_no: 1 }, row: { record_id: recordId, participant_name: "합성갱신", game_mode: "ai_challenge" } };
  await outbox.enqueue("official", envelope);
  const pending = path.join(f.runtimeRoot, "nas", "outbox", "official", "pending", recordId + ".bin");
  const session = path.join(f.runtimeRoot, "nas", "session-ai.json"), records = path.join(f.runtimeRoot, "records.csv");
  fs.writeFileSync(session, JSON.stringify(f.next.device.sessions.official)); fs.writeFileSync(records, "original-record-bytes");
  const checkpoint = path.join(f.runtimeRoot, "nas", "active-attempt-official.bin");
  await createActiveAttemptStore({ checkpointPath: checkpoint, encryption: storage, eventProfileId: "geumcheon-2026" }).save({
    schemaVersion: 2, eventProfileId: "geumcheon-2026", variant: "ai", recordId,
    attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000",
    recordedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
    input: { participant_name: "합성갱신", phone_part1: "010", phone_part2: "0000", phone_part3: "0000",
      birth_year: "2014", birth_month: "1", birth_day: "1", privacy_agreed: true, privacy_agreed_at: "2026-01-01T00:00:00.000Z",
      stageTexts: ["첫 문장", "둘째 문장", "셋째 문장"], stageTimesMs: [1000, 0, 0], game_mode: "ai_challenge" }
  });
  const before = [pending, session, records, checkpoint].map(p => fs.readFileSync(p));
  assert.equal(await f.renew(), true);
  assert.deepEqual([pending, session, records, checkpoint].map(p => fs.readFileSync(p)), before);
  assert.deepEqual((await outbox.list("official"))[0].envelope, envelope);
});
test("R4 unchanged adjacent fingerprint keeps saved administrator selection precedence", async context => {
  const f = fixture(context);
  const external = path.join(f.root, "selected", "player_01.device-profile.json");
  fs.mkdirSync(path.dirname(external)); fs.writeFileSync(external, JSON.stringify(f.next));
  profiles.saveDeploymentSelection(f.selectionPath, f.directory, f.next, external, storage);
  fs.writeFileSync(f.protectedPath, storage.encryptString(JSON.stringify(f.next)));
  const before = f.original();
  assert.equal(await f.renew(), false);
  assert.deepEqual(f.original(), before);
  assert.equal(profiles.readDeploymentSelection(f.selectionPath, f.directory, storage)!.selectedFilePath, external);
  fs.unlinkSync(external);
  assert.equal(await f.renew(), false);
  assert.deepEqual(f.original(), before);
  assert.equal(profiles.readDeploymentSelection(f.selectionPath, f.directory, storage)!.selectedFilePath, external);
});
test("R4 valid cached credentials do not gain an automatic replacement path", async context => {
  const f = fixture(context);
  const valid = { ...f.old, expiresAt: "2099-01-01T00:00:00.000Z" };
  fs.writeFileSync(f.selectedFilePath, JSON.stringify(valid));
  profiles.saveDeploymentSelection(f.selectionPath, f.directory, valid as any, f.selectedFilePath, storage);
  fs.writeFileSync(f.protectedPath, storage.encryptString(JSON.stringify(valid)));
  fs.writeFileSync(f.selectedFilePath, JSON.stringify(f.next));
  const before = f.original();
  assert.equal(await f.renew(), false);
  assert.deepEqual(f.original(), before);
  assert.throws(() => profiles.readDeploymentSelection(f.selectionPath, f.directory, storage), /PROFILE_CACHE_CONFLICT/);
});
test("R4 same scope remains mandatory without pending records", async context => {
  const f = fixture(context);
  const mutations: Array<(p: any) => void> = [
    p => { p.device.deviceId = "PC02"; p.credentials.writer.deviceId = p.credentials.leaderboard.deviceId = "PC02"; },
    p => { p.device.apiBaseUrl = "https://typingking.thepmd.synology.me"; p.credentials.writer.apiBaseUrl = p.credentials.leaderboard.apiBaseUrl = p.device.apiBaseUrl; },
    p => { p.device.requestTimeoutMs += 100; },
    p => { p.device.retry.initialDelayMs += 100; },
    p => { p.allowedSessions.push({ sessionId: "round2", dayNo: 1, roundNo: 2 }); },
    p => { p.administrator.hash = "c".repeat(128); },
    p => { p.device.role = "leaderboard"; p.device.deviceId = "LEADERBOARD01"; delete p.credentials.writer; p.credentials.leaderboard.deviceId = "LEADERBOARD01"; }
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(f.next); mutate(candidate);
    const before = f.original(); fs.writeFileSync(f.selectedFilePath, JSON.stringify(candidate));
    await assert.rejects(f.renew, /PROFILE_(ORIGINAL_NAME_REQUIRED|PENDING_SCOPE_CHANGE)/);
    assert.deepEqual(f.original(), before);
  }
});
test("R4 rejects invalid, ambiguous, or still-expired adjacent candidates without changing caches", async context => {
  const f = fixture(context);
  for (const candidate of [{ ...f.old, deploymentId: "still-expired" }, { ...f.next, notBefore: "2098-01-01T00:00:00.000Z" }, { ...f.next, credentials: { ...f.next.credentials, writer: { ...f.next.credentials.writer, role: "leaderboard" } } }]) {
    const before = f.original(); fs.writeFileSync(f.selectedFilePath, JSON.stringify(candidate));
    await assert.rejects(f.renew, /PROFILE_(EXPIRED|NOT_ACTIVE|CREDENTIAL_BINDING_INVALID)/);
    assert.deepEqual(f.original(), before);
  }
  fs.writeFileSync(f.selectedFilePath, JSON.stringify(f.next));
  fs.writeFileSync(path.join(f.directory, "player_02.device-profile.json"), JSON.stringify(f.next));
  const before = f.original(); await assert.rejects(f.renew, /PROFILE_MULTIPLE_FILES/); assert.deepEqual(f.original(), before);
});
test("R4 cold renewal rejects every live executable lease including the current PID", async context => {
  const f = fixture(context);
  const lease = path.join(f.runtimeRoot, "nas", "app-leases", "ai.pid");
  fs.mkdirSync(path.dirname(lease)); fs.writeFileSync(lease, String(process.pid));
  const before = f.original();
  await assert.rejects(f.renew, /PROFILE_OTHER_APP_RUNNING/);
  assert.deepEqual(f.original(), before);
});
test("R4 fails closed on missing, corrupt, or mismatched protected state", async context => {
  const f = fixture(context), originalProtected = fs.readFileSync(f.protectedPath);
  for (const value of [undefined, Buffer.from("corrupt"), storage.encryptString(JSON.stringify({ ...f.old, deploymentId: "different-old" }))]) {
    if (value === undefined) fs.unlinkSync(f.protectedPath); else fs.writeFileSync(f.protectedPath, value);
    const selectionBefore = fs.readFileSync(f.selectionPath);
    await assert.rejects(f.renew);
    assert.deepEqual(fs.readFileSync(f.selectionPath), selectionBefore);
    if (value) assert.deepEqual(fs.readFileSync(f.protectedPath), value); else assert.equal(fs.existsSync(f.protectedPath), false);
    fs.writeFileSync(f.protectedPath, originalProtected);
  }
});
test("R4 candidate or cache mutation while waiting for a deployment lock cannot be overwritten", async context => {
  for (const target of ["candidate", "selection", "protected"] as const) {
    const f = fixture(context);
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const held = profiles.withDeploymentLocks([f.runtimeRoot], async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const operation = f.renew();
    operation.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 35));
    const file = target === "candidate" ? f.selectedFilePath : target === "selection" ? f.selectionPath : f.protectedPath;
    const mutated = Buffer.from("changed-while-waiting");
    fs.writeFileSync(file, mutated);
    release(); await held;
    await assert.rejects(() => operation, /PROFILE_CONFIGURATION_CHANGED/);
    assert.deepEqual(fs.readFileSync(file), mutated);
  }
});
test("R4 failure writing the selection rolls both protected caches back to their exact original bytes", async context => {
  const f = fixture(context), before = f.original(), rename = fs.renameSync;
  let injected = false;
  (fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (!injected && String(to) === f.selectionPath && !String(from).endsWith(".rollback")) { injected = true; throw new Error("SYNTHETIC_SELECTION_RENAME"); }
    return rename(from, to);
  };
  try { await assert.rejects(f.renew, /SYNTHETIC_SELECTION_RENAME/); } finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.deepEqual(f.original(), before);
});

test("R4 missing selection remains a normal initial import and unchanged expired state remains expired", async context => {
  const f = fixture(context);
  fs.writeFileSync(f.selectedFilePath, JSON.stringify(f.old));
  const before = f.original();
  assert.equal(await f.renew(), false);
  assert.deepEqual(f.original(), before);
  assert.throws(() => profiles.readDeploymentSelection(f.selectionPath, f.directory, storage), /PROFILE_EXPIRED/);
  fs.unlinkSync(f.selectionPath);
  const protectedBefore = fs.readFileSync(f.protectedPath);
  assert.equal(await f.renew(), false);
  assert.deepEqual(fs.readFileSync(f.protectedPath), protectedBefore);
});
test("R4 corrupt selection and unavailable encrypted storage never fall back to an adjacent credential", async context => {
  const f = fixture(context), beforeProtected = fs.readFileSync(f.protectedPath);
  fs.writeFileSync(f.selectionPath, "corrupt-selection");
  await assert.rejects(f.renew, /PROFILE_CACHE_UNREADABLE/);
  assert.equal(fs.readFileSync(f.selectionPath, "utf8"), "corrupt-selection");
  assert.deepEqual(fs.readFileSync(f.protectedPath), beforeProtected);
  const next = fixture(context), before = next.original();
  next.options.safeStorage = { ...storage, isEncryptionAvailable: () => false };
  await assert.rejects(next.renew, /SAFE_STORAGE_UNAVAILABLE/);
  assert.deepEqual(next.original(), before);
});
test("R4 failure replacing the protected cache leaves both originals exact", async context => {
  const f = fixture(context), before = f.original(), rename = fs.renameSync;
  let injected = false;
  (fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (!injected && String(to) === f.protectedPath && !String(from).endsWith(".rollback")) { injected = true; throw new Error("SYNTHETIC_PROTECTED_RENAME"); }
    return rename(from, to);
  };
  try { await assert.rejects(f.renew, /SYNTHETIC_PROTECTED_RENAME/); } finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.deepEqual(f.original(), before);
});

test("R4 two simultaneous cold starts share one committed renewal and both retain strict startup", async context => {
  const f = fixture(context);
  let release!: () => void, ready!: () => void;
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  const held = profiles.withDeploymentLocks([f.runtimeRoot], async () => { ready(); await new Promise<void>(resolve => { release = resolve; }); });
  await acquired;
  const first = f.renew().then(result => {
    const lease = path.join(f.runtimeRoot, "nas", "app-leases", "ai.pid");
    fs.mkdirSync(path.dirname(lease)); fs.writeFileSync(lease, String(process.pid));
    return result;
  }), second = f.renew();
  first.catch(() => {}); second.catch(() => {});
  release(); await held;
  assert.deepEqual((await Promise.all([first, second])).sort(), [false, true]);
  const saved = profiles.readDeploymentSelection(f.selectionPath, f.directory, storage)!;
  assert.deepEqual(saved.profile, f.next);
  const game = new profiles.DeploymentProfileStore(f.protectedPath, storage);
  const board = new profiles.DeploymentProfileStore(f.protectedPath, storage);
  game.activate(saved.profile); board.activate(saved.profile);
  assert.equal(game.token("writer"), f.next.credentials.writer!.token);
  assert.equal(board.token("leaderboard"), f.next.credentials.leaderboard.token);
});
test("R4 concurrent different candidate never turns a changed baseline into successful renewal", async context => {
  const f = fixture(context);
  let release!: () => void, ready!: () => void;
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  const held = profiles.withDeploymentLocks([f.runtimeRoot], async () => { ready(); await new Promise<void>(resolve => { release = resolve; }); });
  await acquired;
  const stale = f.renew(); stale.catch(() => {});
  const other = structuredClone(f.next);
  other.deploymentId = "different-renewal";
  other.credentials.writer!.token = "e".repeat(64);
  fs.writeFileSync(f.selectedFilePath, JSON.stringify(other));
  const current = f.renew(); current.catch(() => {});
  release(); await held;
  await assert.rejects(() => stale, /PROFILE_CONFIGURATION_CHANGED/);
  assert.equal(await current, true);
  assert.deepEqual(profiles.readDeploymentSelection(f.selectionPath, f.directory, storage)!.profile, other);
});

test("R4 issuer inspection requires the exact original filename at runtime and does not authorize expired credentials", context => {
  const f = fixture(context);
  const inspect = profiles.inspectDeploymentProfileForRenewal;
  for (const options of [undefined, {}, { fileName: "" }, { fileName: "renamed.device-profile.json" }]) {
    assert.throws(() => inspect(f.old, options as any), /PROFILE_ORIGINAL_NAME_REQUIRED/);
  }
  const inspected = inspect(f.old, { fileName: "player_01.device-profile.json" });
  assert.deepEqual(inspected, f.old);
  assert.throws(() => profiles.parseDeploymentProfile(inspected), /PROFILE_EXPIRED/);
  const invalid = structuredClone(f.old); invalid.credentials.writer.role = "leaderboard";
  assert.throws(() => inspect(invalid, { fileName: "player_01.device-profile.json" }), /PROFILE_CREDENTIAL_BINDING_INVALID/);
});
