import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createActiveAttemptStore } from "../../electron/activeAttemptStore";
import { createGeumcheonRecordRuntime } from "../../electron/geumcheonRecordRuntime";
import * as evidenceHelpers from "../../shared/utils/geumcheonRecordEvidence";
import { createChallengeSaveInput } from "../../apps/typing-game/src/AIChallengeGame";
import { buildRecordRow, ensureRuntime, readRecords, saveRecord, updateOneDriveSettings, updateRecord, validateOneDriveSetup } from "../../shared/csv/fileStore";
import type { RecordRow, SaveRecordInput } from "../../shared/types";

const participant = {
  name: "합성 기록계약", phone1: "010", phone2: "0000", phone3: "0001",
  birthYear: "2000", birthMonth: "01", birthDay: "01",
  privacyAgreedAt: "2026-09-09T00:00:00.000Z"
};
const selections = [
  { id: "synthetic-1", catalogVersion: "synthetic-v1", stageNumber: 1, text: "1234" },
  { id: "synthetic-2", catalogVersion: "synthetic-v1", stageNumber: 2, text: "1234567890" },
  { id: "synthetic-3", catalogVersion: "synthetic-v1", stageNumber: 3, text: "12345678901234567890" }
] as const;
const battle = {
  stage: 1, text: "1234", userTimeMs: 5000, userCpm: 24, userAccuracy: 50,
  aiTimeMs: 5000.2, aiElapsedMs: 5000.2, aiCpm: 48, plannedAiCpm: 175,
  aiTypedUnits: 4, aiTypedChars: 4, result: "AI_WIN" as const, userInput: "12x"
};
type ExpectedEvidence = {
  schemaVersion: 1;
  canonicalAttempt: NonNullable<SaveRecordInput["canonicalAttempt"]>;
  battles: readonly typeof battle[];
};
function evidenceOf(value: unknown): ExpectedEvidence | undefined {
  return (value as { recordEvidence?: ExpectedEvidence }).recordEvidence;
}
function lossInput(battleRows = [{ ...battle }]) {
  return createChallengeSaveInput({
    participant, stageTexts: selections.map((entry) => entry.text) as [string, string, string],
    stageTextSelections: selections, battleRows, status: "FAILED", failedStage: "1",
    terminalStage: 1, isGeumcheon: true, debugModeType: ""
  });
}

test("renderer retains the unrounded battle evidence before record serialization loses it", () => {
  const input = lossInput();
  const evidence = evidenceOf(input);
  assert.ok(evidence, "detailed recordEvidence must survive the renderer boundary");
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(evidence.battles, [battle]);
  assert.equal(evidence.canonicalAttempt.participantAverageCpmRaw, 36);
  assert.equal(evidence.battles[0].aiElapsedMs, 5000.2);
  assert.equal("entered" in evidence.battles[0], false);
});

test("record serialization preserves nested evidence without changing legacy CPM or adding canonical rank fields", () => {
  const input = lossInput();
  const row = buildRecordRow(input);
  assert.ok(evidenceOf(row), "local persistence must not discard detailed recordEvidence");
  assert.equal(row.canonicalAttempt, undefined);
  assert.equal(row.final_cpm, "24");
  assert.equal(row.participant_avg_cpm, "24");
  assert.equal(row.final_accuracy, "50");
  assert.equal(evidenceOf(row)?.canonicalAttempt.participantAverageCpmRaw, 36);
});

test("mutating live battle data or the checkpoint input cannot rewrite a serialized evidence snapshot", () => {
  const live = { ...battle };
  const input = lossInput([live]);
  const row = buildRecordRow(input);
  assert.ok(evidenceOf(row), "serialized evidence snapshot is required");
  live.aiTimeMs = 99;
  live.userInput = "rewritten";
  input.canonicalAttempt!.stages[0].participantValidInputUnits = 99;
  assert.equal(evidenceOf(input)?.battles[0].aiTimeMs, 5000.2);
  assert.equal(evidenceOf(row)?.battles[0].userInput, "12x");
  assert.equal(evidenceOf(row)?.canonicalAttempt.stages[0].participantValidInputUnits, 3);
});

test("unknown or incomplete evidence is rejected instead of silently saved or normalized away", () => {
  const input = lossInput();
  const valid = evidenceOf(input)!;
  for (const invalid of [null, { ...valid, schemaVersion: 2 }, { ...valid, battles: [] },
    { ...valid, battles: [{ ...battle, aiTimeMs: Number.NaN }] },
    { ...valid, battles: [{ ...battle, userTimeMs: 0.5 }] },
    { ...valid, battles: [{ ...battle, extra: "unknown" }] },
    { ...valid, canonicalAttempt: { schemaVersion: 1 } }]) {
    assert.throws(() => buildRecordRow({ ...input, recordEvidence: invalid } as SaveRecordInput),
      /RECORD_EVIDENCE_INVALID/);
  }
});

test("public projection removes source details while keeping original 24 CPM and 50 percent accuracy", () => {
  const project = (evidenceHelpers as Record<string, unknown>).toGeumcheonPublicRecordRow as
    ((row: ReturnType<typeof buildRecordRow> & { record_id: string }) => ReturnType<typeof buildRecordRow>);
  assert.equal(typeof project, "function", "protected source must have an explicit public projection");
  const raw = { record_id: "synthetic", ...buildRecordRow(lossInput()) };
  const visible = project(raw);
  assert.equal("recordEvidence" in visible, false);
  assert.equal(visible.canonicalAttempt, undefined);
  assert.equal(visible.participant_avg_cpm, "24");
  assert.equal(visible.final_accuracy, "50");
  assert.equal(evidenceOf(raw)?.canonicalAttempt.participantAverageCpmRaw, 36);
  const legacy = { ...raw };
  delete legacy.recordEvidence;
  assert.deepEqual(project(legacy), legacy);
});

test("trusted runtime identity survives the actual encrypted checkpoint read boundary in both evidence copies", async (context) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "r7-record-evidence-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  // Only the operating-system encryption adapter is substituted; file IO and validation are real.
  const store = createActiveAttemptStore({
    checkpointPath: path.join(rootDir, "active.bin"), eventProfileId: "geumcheon-2026",
    encryption: { isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (value) => value.toString("utf8") }
  });
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026", variant: "ai", deviceId: "PC01", store,
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc01-11111111-1111-4111-8111-111111111111",
      attemptId: "gsc26-attempt-11111111-1111-4111-8111-111111111111"
    }), now: () => "2026-09-09T00:00:00.000Z",
    persistLocal: async () => { throw new Error("not used by checkpoint test"); },
    enqueue: async () => { throw new Error("not used by checkpoint test"); }
  });
  await runtime.checkpoint(lossInput());
  const restored = await store.read();
  const canonical = evidenceOf(restored?.input)?.canonicalAttempt;
  assert.equal(canonical?.recordId, "gsc26-pc01-11111111-1111-4111-8111-111111111111");
  assert.equal(canonical?.attemptId, "gsc26-attempt-11111111-1111-4111-8111-111111111111");
  assert.equal(canonical?.deviceId, "PC01");
  assert.equal(canonical?.recordedAt, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(canonical, restored?.input.canonicalAttempt);
  assert.equal(evidenceOf(restored?.input)?.battles[0].aiTimeMs, 5000.2);
});

async function localReadFixture(context: { after(callback: () => unknown): void }) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "r7-evidence-local-read-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const ctx = ensureRuntime(path.join(rootDir, "runtime"));
  updateOneDriveSettings(ctx, { syncMode: "onedrive_manual", pcRole: "player", pcId: "PC01",
    oneDriveRoot: path.join(rootDir, "synthetic-files"), recordBaseFolderName: "records", dayNo: 1, roundNo: 1 }, "player");
  validateOneDriveSetup(ctx, "player");
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026", variant: "ai", deviceId: "PC01",
    store: { read: async () => null, save: async () => undefined, clear: async () => undefined },
    createAttemptIdentity: () => ({ recordId: "gsc26-pc01-11111111-1111-4111-8111-111111111111",
      attemptId: "gsc26-attempt-11111111-1111-4111-8111-111111111111" }),
    now: () => "2026-09-09T00:00:00.000Z",
    persistLocal: (input, identity) => saveRecord(ctx, input, identity.recordId), enqueue: async () => undefined
  });
  const saved = await runtime.save(lossInput());
  const file = path.join(ctx.config.aiIncomingPath, `${saved.record_id}.json`);
  return { ctx, saved, file };
}

async function replaceSyntheticJson(file: string, row: RecordRow) {
  const bytes = JSON.stringify(row);
  await writeFile(file, bytes, "utf8");
  // Force the existing directory cache to observe this synthetic fixture edit.
  const changed = new Date(Date.now() + 2000);
  await utimes(path.dirname(file), changed, changed);
  return bytes;
}

test("local read rejects a hybrid top-level canonical plus nested evidence without rewriting its source JSON", async (context) => {
  const { ctx, saved, file } = await localReadFixture(context);
  const hybrid = { ...saved, canonicalAttempt: saved.recordEvidence!.canonicalAttempt };
  const bytes = await replaceSyntheticJson(file, hybrid);
  assert.equal(readRecords(ctx).length, 0, "hybrid records must not select the alternate canonical ranking branch");
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("local read rejects intrinsic canonical contradictions and evidence belonging to another record", async (context) => {
  for (const failure of ["totals", "identity"] as const) {
    await context.test(failure, async (child) => {
      const { ctx, saved, file } = await localReadFixture(child);
      const invalid = structuredClone(saved);
      if (failure === "totals") invalid.recordEvidence!.canonicalAttempt.participantAverageCpmRaw = 99;
      else invalid.recordEvidence!.canonicalAttempt.recordId = "review-r5-record-22222222-2222-4222-8222-222222222222";
      const bytes = await replaceSyntheticJson(file, invalid);
      assert.equal(readRecords(ctx).length, 0, "invalid protected source must not become a normal public record");
      assert.equal(await readFile(file, "utf8"), bytes);
    });
  }
});

test("local read keeps historical canonical-only records unchanged", async (context) => {
  const { ctx, saved, file } = await localReadFixture(context);
  const legacy = { ...saved, canonicalAttempt: saved.recordEvidence!.canonicalAttempt };
  delete legacy.recordEvidence;
  await replaceSyntheticJson(file, legacy);
  const [restored] = readRecords(ctx);
  assert.deepEqual(restored.canonicalAttempt, legacy.canonicalAttempt);
  assert.equal(restored.recordEvidence, undefined);
  assert.equal(restored.participant_avg_cpm, "24");
});

test("repeated local admin overlays retain immutable source evidence despite generated replacement IDs", async (context) => {
  const { ctx, saved, file } = await localReadFixture(context);
  const originalBytes = await readFile(file, "utf8");
  const first = await updateRecord(ctx, saved.record_id, { participant_name: "합성 첫 수정" }, "합성 운영자");
  const second = await updateRecord(ctx, first.record_id, { participant_name: "합성 두 번째 수정", final_accuracy: "55" }, "합성 운영자");
  let visible = readRecords(ctx);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].record_id, second.record_id);
  assert.equal(visible[0].participant_name, "합성 두 번째 수정");
  assert.equal(visible[0].final_accuracy, "55");
  assert.deepEqual(visible[0].recordEvidence, saved.recordEvidence);
  const originalEvidence = structuredClone(saved.recordEvidence!);
  // Structurally valid and canonical-ID-preserving, but a different protected source snapshot.
  const substituted = { ...originalEvidence,
    battles: originalEvidence.battles.map((entry) => ({ ...entry, aiTimeMs: entry.aiTimeMs + 1 })) };
  await updateRecord(ctx, second.record_id, { recordEvidence: substituted }, "합성 운영자");
  visible = readRecords(ctx);
  assert.equal(visible[0].record_id, second.record_id, "a source-replacing overlay must not hide the accepted record");
  assert.deepEqual(visible[0].recordEvidence, saved.recordEvidence);
  assert.equal(await readFile(file, "utf8"), originalBytes);
});
