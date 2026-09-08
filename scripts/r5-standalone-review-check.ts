import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { REVIEW_LOCAL_ADMIN_PASSWORD } from "../electron/adminAccessSession";
import { buildRecordRow } from "../shared/csv/fileStore";
import { parseStageTextCatalog } from "../shared/events/stageTextCatalog";
import type { RecordRow, SaveRecordInput } from "../shared/types";
import { canonicalAiContradictionCodes, isCanonicalAiAttemptV1 } from "../shared/utils/geumcheonAiAttempt";
import { countConvertedTypingUnits } from "../shared/utils/typing";

type Variant = "ai" | "ai-leaderboard" | "practice" | "practice-leaderboard";
type Role = "player" | "leaderboard";
type Session = "official" | "practice";

type ArtifactInput = { variant: string; exePath: string };
type ArtifactFinding = { variant: string; exePath: string; bytes: number; sha256: string; pe: boolean; listing: string[] };
type RuntimeObservation = {
  expectedVariant?: string;
  expectedRole?: string;
  expectedSession?: string;
  bootstrap?: any;
  notices?: unknown[];
  observedHelperProcesses?: string[];
  credentialPopupCount?: number;
  commandWindowCount?: number;
  cleanExit?: boolean;
  residualProcessCount?: number | null;
  unexpectedFiles?: string[];
};

type RectObservation = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type PlayerWindowLayoutObservation = {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  heroPanel: RectObservation | null;
  heroGuideCard: RectObservation | null;
  fifthGuideLine: RectObservation | null;
  guideLineCount: number;
};

export function assessConcurrentEvidence(input: {
  simultaneouslyReadyVariants?: string[];
  officialRefreshes?: number;
  practiceRefreshes?: number;
  crossLeakCount?: number;
  residualProcessCount?: number | null;
}): string[] {
  const violations: string[] = [];
  const expected = ["ai", "ai-leaderboard", "practice", "practice-leaderboard"];
  const ready = new Set(input.simultaneouslyReadyVariants ?? []);
  if (expected.some((variant) => !ready.has(variant))) violations.push("FOUR_VARIANTS_NOT_SIMULTANEOUS");
  if (!input.officialRefreshes) violations.push("OFFICIAL_SHARE_NOT_OBSERVED");
  else if (input.officialRefreshes > 2) violations.push("OFFICIAL_SHARE_EXCEEDED_TWO_REFRESHES");
  if (!input.practiceRefreshes) violations.push("PRACTICE_SHARE_NOT_OBSERVED");
  else if (input.practiceRefreshes > 2) violations.push("PRACTICE_SHARE_EXCEEDED_TWO_REFRESHES");
  if ((input.crossLeakCount ?? 0) > 0) violations.push(`CROSS_SESSION_LEAK:${input.crossLeakCount}`);
  if (input.residualProcessCount === null) violations.push("PROCESS_OBSERVATION_UNKNOWN");
  if ((input.residualProcessCount ?? 0) > 0) violations.push(`RESIDUAL_PROCESS:${input.residualProcessCount}`);
  return violations;
}

export function assessLeaderboardViewDifference(input: {
  allRowCount?: number;
  bestRowCount?: number;
  repeatParticipantAttempts?: number;
}): string[] {
  const violations: string[] = [];
  if ((input.repeatParticipantAttempts ?? 0) < 2) violations.push("REPEAT_PARTICIPANT_ATTEMPTS_MISSING");
  if ((input.bestRowCount ?? 0) >= (input.allRowCount ?? 0)) violations.push("BEST_VIEW_DID_NOT_REDUCE_ROWS");
  return violations;
}

export function assessResetEvidence(input: {
  rowsBefore?: number;
  rowsAfter?: number;
  sourceRecordsBefore?: number;
  sourceRecordsAfter?: number;
}): string[] {
  const violations: string[] = [];
  if ((input.rowsBefore ?? 0) < 1 || (input.rowsAfter ?? -1) !== 0) violations.push("RESET_DID_NOT_CLEAR_VISIBLE_ROWS");
  if (input.sourceRecordsAfter !== input.sourceRecordsBefore) violations.push("RESET_DELETED_SOURCE_RECORDS");
  return violations;
}

type LeaderboardTableObservation = {
  bodyCount: number;
  rowCount: number;
  adminModalCount: number;
  modalBackdropCount: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  bodyRect: RectObservation | null;
  lastRowRect: RectObservation | null;
  lastRowVisible: boolean;
};

export function assessLeaderboardTableCapture(expectedRowCount: number, observation: Partial<LeaderboardTableObservation> | null | undefined): string[] {
  const violations: string[] = [];
  if (observation?.bodyCount !== 1) violations.push("LEADERBOARD_AI_BODY_NOT_UNIQUE");
  if (!Number.isInteger(expectedRowCount) || expectedRowCount < 0 || observation?.rowCount !== expectedRowCount) violations.push("LEADERBOARD_CAPTURE_ROW_COUNT_MISMATCH");
  if (observation?.adminModalCount !== 0 || observation?.modalBackdropCount !== 0) violations.push("LEADERBOARD_CAPTURE_OBSCURED_BY_MODAL");
  return violations;
}

export function assessLeaderboardScrollEvidence(input: { before: Partial<LeaderboardTableObservation>; after: Partial<LeaderboardTableObservation> }): string[] {
  const { before, after } = input;
  const violations = [...assessLeaderboardTableCapture(before.rowCount ?? -1, before), ...assessLeaderboardTableCapture(before.rowCount ?? -1, after)];
  if (before.scrollTop !== 0) violations.push("LEADERBOARD_SCROLL_DID_NOT_START_AT_TOP");
  if (!Number.isFinite(after.scrollTop) || !(after.scrollTop! > 0)) violations.push("LEADERBOARD_SCROLL_DID_NOT_MOVE");
  if (!Number.isFinite(after.scrollHeight) || !Number.isFinite(after.clientHeight) || !(after.clientHeight! > 0) || !(after.scrollHeight! > after.clientHeight!) || Math.abs(after.scrollHeight! - after.clientHeight! - after.scrollTop!) > 1) violations.push("LEADERBOARD_SCROLL_DID_NOT_REACH_BOTTOM");
  if (after.lastRowVisible !== true) violations.push("LEADERBOARD_LAST_ROW_NOT_VISIBLE");
  return violations;
}

export function assessLeaderboardResolutionComparison(input: { allRowCount: number; bestRowCount: number; all: Array<Record<string, any>>; best: Array<Record<string, any>> }): string[] {
  const violations: string[] = [];
  if (!(input.allRowCount > input.bestRowCount && input.bestRowCount > 0)) violations.push("LEADERBOARD_RESOLUTION_ROWS_DID_NOT_REDUCE");
  for (const [mode, entries, expectedCount] of [["all", input.all, input.allRowCount], ["best", input.best, input.bestRowCount]] as const) {
    if (entries.length !== 2) violations.push(`LEADERBOARD_RESOLUTION_COUNT:${mode}`);
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      const matches = entries.filter((entry) => entry.requestedViewport?.width === width && entry.requestedViewport?.height === height);
      if (matches.length !== 1) violations.push(`LEADERBOARD_RESOLUTION_MISSING_OR_DUPLICATED:${mode}:${width}x${height}`);
      else violations.push(...assessLeaderboardTableCapture(expectedCount, matches[0].leaderboardTable));
    }
  }
  return violations;
}

function readLeaderboardTableObservation(): LeaderboardTableObservation {
  const bodies = document.querySelectorAll<HTMLElement>(".ai-ranking .ranking-body");
  const body = bodies.item(0);
  const rows = body?.querySelectorAll<HTMLElement>(".ranking-row");
  const lastRow = rows?.item(rows.length - 1);
  const bodyRect = body?.getBoundingClientRect();
  const lastRowRect = lastRow?.getBoundingClientRect();
  const lastRowVisible = Boolean(lastRow && lastRowRect && bodyRect
    && lastRowRect.width > 0 && lastRowRect.height > 0
    && lastRowRect.top >= Math.max(0, bodyRect.top) - 1 && lastRowRect.bottom <= Math.min(window.innerHeight, bodyRect.bottom) + 1
    && lastRowRect.left >= Math.max(0, bodyRect.left) - 1 && lastRowRect.right <= Math.min(window.innerWidth, bodyRect.right) + 1
    && document.elementFromPoint(lastRowRect.left + lastRowRect.width / 2, lastRowRect.top + lastRowRect.height / 2)?.closest(".ranking-row") === lastRow);
  return {
    bodyCount: bodies.length, rowCount: rows?.length ?? 0,
    adminModalCount: document.querySelectorAll(".admin-modal").length,
    modalBackdropCount: document.querySelectorAll(".modal-backdrop").length,
    scrollTop: body?.scrollTop ?? 0, scrollHeight: body?.scrollHeight ?? 0, clientHeight: body?.clientHeight ?? 0,
    bodyRect: bodyRect?.toJSON() ?? null, lastRowRect: lastRowRect?.toJSON() ?? null, lastRowVisible
  };
}

export function assessStandaloneReviewVerdict(input: {
  concurrentViolations?: string[];
  results?: Array<{ variant?: string; verdict?: string; cleanExit?: boolean; forcedCleanup?: boolean }>;
  stageSeeds?: Array<{ session?: string; exists?: boolean; seededBeforeInitialization?: boolean; canonicalDrawObserved?: boolean }>;
}): string[] {
  const violations = [...(input.concurrentViolations ?? [])];
  for (const result of input.results ?? []) {
    const variant = result.variant ?? "unknown";
    if (result.verdict !== "PASS") violations.push(`VARIANT_NOT_PASS:${variant}`);
    if (result.cleanExit !== true) violations.push(`VARIANT_UNCLEAN_EXIT:${variant}`);
    if (result.forcedCleanup === true) violations.push(`VARIANT_FORCED_CLEANUP:${variant}`);
  }
  for (const seed of input.stageSeeds ?? []) {
    if (!seed.exists || !seed.seededBeforeInitialization || !seed.canonicalDrawObserved) {
      violations.push(`STAGE_SEED_INVALID:${seed.session ?? "unknown"}`);
    }
  }
  return violations;
}

export function reviewHarnessLaunchEvidence(): Record<string, unknown> {
  return {
    method: "PowerShell Start-Process (ShellExecute)",
    extraArguments: ["--remote-debugging-port=<ephemeral>", "--user-data-dir=<variant-isolated>"],
    environmentOverrides: ["LOCALAPPDATA", "APPDATA", "TEMP", "TMP"],
    viewportMethod: "Playwright CDP renderer viewport emulation on actual packaged EXE",
    ordinaryNoArgumentLaunch: false,
    defaultUserDirectories: false
  };
}

export function concurrentRuntimeDirectories(root: string, variant: string): Record<string, string> {
  return {
    LOCALAPPDATA: path.join(root, "runtime", "LocalAppData"),
    APPDATA: path.join(root, "runtime", "AppData", variant),
    TEMP: path.join(root, "runtime", "Temp", variant),
    TMP: path.join(root, "runtime", "Temp", variant)
  };
}

export const REVIEW_EXTERNAL_STORAGE_API_METHODS = [
  "publishStageTextsToOneDrive",
  "getOneDriveSettings",
  "updateOneDriveSettings",
  "validateOneDriveSetup",
  "pokeOneDriveSync",
  "cleanupLegacyOneDriveArtifacts",
  "chooseOneDriveRoot",
  "openSessionFolder"
] as const;

export function assessReviewExternalStorageBoundary(
  observations: Array<{ method: string; rejected: boolean }>
): string[] {
  const byMethod = new Map(observations.map((observation) => [observation.method, observation]));
  const violations: string[] = [];
  for (const method of REVIEW_EXTERNAL_STORAGE_API_METHODS) {
    const observation = byMethod.get(method);
    if (!observation) violations.push(`REVIEW_EXTERNAL_STORAGE_MISSING:${method}`);
    else if (!observation.rejected) violations.push(`REVIEW_EXTERNAL_STORAGE_ACCEPTED:${method}`);
  }
  return violations;
}

export function assessPlayerWindowLayout(observation: PlayerWindowLayoutObservation): string[] {
  const violations: string[] = [];
  if (observation.outerWidth !== 1440 || observation.outerHeight !== 900) {
    violations.push(`WINDOW_OUTER_BOUNDS:${observation.outerWidth}x${observation.outerHeight}`);
  }
  if (
    !Number.isFinite(observation.innerWidth)
    || observation.innerWidth <= 0
    || !Number.isFinite(observation.innerHeight)
    || observation.innerHeight <= 0
  ) {
    violations.push("WINDOW_INNER_BOUNDS_INVALID");
  }
  if (observation.guideLineCount !== 5) {
    violations.push(`HERO_GUIDE_LINE_COUNT:${observation.guideLineCount}`);
  }
  if (!containsRect(observation.heroPanel, observation.heroGuideCard)) {
    violations.push("HERO_GUIDE_CARD_NOT_CONTAINED");
  }
  if (
    !containsRect(observation.heroGuideCard, observation.fifthGuideLine)
    || !containsRect(observation.heroPanel, observation.fifthGuideLine)
  ) {
    violations.push("FIFTH_GUIDE_LINE_NOT_CONTAINED");
  }
  return violations;
}

export function assessReviewStorageValidation(
  response: unknown,
  expected: { role: string; session: string }
): string[] {
  if (typeof response !== "object" || response == null || (response as { ok?: unknown }).ok !== true) {
    return ["REVIEW_STORAGE_VALIDATION_NOT_OK"];
  }
  const data = (response as { data?: Record<string, unknown> }).data;
  const violations: string[] = [];
  if (data?.storage !== "local") violations.push("REVIEW_STORAGE_KIND_MISMATCH");
  if (data?.environment !== "review") violations.push("REVIEW_STORAGE_ENVIRONMENT_MISMATCH");
  if (data?.role !== expected.role) violations.push("REVIEW_STORAGE_ROLE_MISMATCH");
  if (data?.session !== expected.session) violations.push("REVIEW_STORAGE_SESSION_MISMATCH");
  if (data?.result !== "normal") violations.push("REVIEW_STORAGE_RESULT_NOT_NORMAL");
  return violations;
}

function containsRect(container: RectObservation | null, content: RectObservation | null): boolean {
  if (!container || !content) return false;
  const values = [
    container.left, container.top, container.right, container.bottom, container.width, container.height,
    content.left, content.top, content.right, content.bottom, content.width, content.height
  ];
  if (!values.every(Number.isFinite) || container.width <= 0 || container.height <= 0 || content.width <= 0 || content.height <= 0) {
    return false;
  }
  const epsilon = 0.5;
  return content.left >= container.left - epsilon
    && content.top >= container.top - epsilon
    && content.right <= container.right + epsilon
    && content.bottom <= container.bottom + epsilon;
}

const MIN_PORTABLE_BYTES = 10 * 1024 * 1024;
const FALLBACK_NOTICE = "문구 파일이 없어 기본 문구로 생성합니다.";
const LEADERBOARD_REJECTED_SAVE_INPUT: SaveRecordInput = {
  participant_name: "리더보드 저장 거부 확인",
  phone_part1: "010",
  phone_part2: "0000",
  phone_part3: "0001",
  birth_year: "2012",
  birth_month: "01",
  birth_day: "02",
  privacy_agreed: true,
  privacy_agreed_at: "2026-09-03T01:00:00.000Z",
  stageTexts: ["1234", "5678", "9012"],
  stageTimesMs: [1000, 1000, 1000]
};
const canonicalStageTexts = parseStageTextCatalog(
  fs.readFileSync(path.resolve("events/geumcheon-2026/stage_texts.csv"), "utf8")
).reduce((byStage, row) => {
  const stage = Number(row.stage_number);
  byStage.set(stage, new Set([...(byStage.get(stage) ?? []), row.text]));
  return byStage;
}, new Map<number, Set<string>>());

export function assessStageSeedEvidence(input: {
  exists: boolean;
  notices: unknown[];
  drawnStageTexts: string[];
}): { seededBeforeInitialization: boolean; canonicalDrawObserved: boolean } {
  const canonicalDrawObserved = input.drawnStageTexts.length === 3
    && input.drawnStageTexts.every((text, index) => canonicalStageTexts.get(index + 1)?.has(text));
  return {
    seededBeforeInitialization: input.exists && !input.notices.includes(FALLBACK_NOTICE),
    canonicalDrawObserved
  };
}
const POLL_MS = 100;

export function expectedRendererTitle(variant: string): string {
  switch (variant) {
    case "ai": return "G-Science AI 타자왕";
    case "ai-leaderboard": return "G-Science AI 타자왕 리더보드";
    case "practice": return "G-Science AI 타자왕 연습모드";
    case "practice-leaderboard": return "G-Science AI 타자왕 연습모드 리더보드";
    default: throw new Error(`Unknown review variant: ${variant}`);
  }
}
export function expectedMaskedPhoneSearchNeedle(variant: string): string {
  if (variant === "ai") return "6101";
  if (variant === "practice") return "6201";
  throw new Error(`Masked-phone search is only valid for player variants: ${variant}`);
}

const specs: Array<{
  variant: Variant;
  role: Role;
  session: Session;
  arg: string;
  fileName: string;
  title: string;
  selector: string;
}> = [
  { variant: "ai", role: "player", session: "official", arg: "--ai", fileName: "G-Science AI 타자왕_검토용.exe", title: expectedRendererTitle("ai"), selector: ".entry-panel" },
  { variant: "practice", role: "player", session: "practice", arg: "--practice", fileName: "G-Science AI 타자왕_연습모드_검토용.exe", title: expectedRendererTitle("practice"), selector: ".entry-panel" },
  { variant: "ai-leaderboard", role: "leaderboard", session: "official", arg: "--ai-leaderboard", fileName: "G-Science AI 타자왕_리더보드_검토용.exe", title: expectedRendererTitle("ai-leaderboard"), selector: ".leaderboard-app" },
  { variant: "practice-leaderboard", role: "leaderboard", session: "practice", arg: "--practice-leaderboard", fileName: "G-Science AI 타자왕_연습모드_리더보드_검토용.exe", title: expectedRendererTitle("practice-leaderboard"), selector: ".leaderboard-app" }
];

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

export function assessMaskedSearchEvidence(input: {
  expectedCount: number;
  expectedMaskedName: string;
  phoneSuffix: string;
  rawParticipantNames: string[];
  rawPhoneNumbers: string[];
  rows: Array<{ name: string; phone: string; text: string }>;
}): string[] {
  const violations: string[] = [];
  if (!Number.isSafeInteger(input.expectedCount) || input.expectedCount < 2 || input.rows.length !== input.expectedCount) {
    violations.push("SEARCH_ATTEMPT_COUNT_MISMATCH");
  }
  const expectedPhone = `010-****-${input.phoneSuffix}`;
  const rawValues = [...input.rawParticipantNames, ...input.rawPhoneNumbers].filter(Boolean);
  for (const [index, row] of input.rows.entries()) {
    if (row.name !== input.expectedMaskedName || row.phone !== expectedPhone || !/^\d{4}$/.test(input.phoneSuffix)) {
      violations.push(`SEARCH_MASKED_IDENTITY_MISMATCH:${index}`);
    }
    if (rawValues.some((value) => row.text.includes(value)) || /010[-\s]?\d{4}[-\s]?\d{4}/.test(row.text)) {
      violations.push(`SEARCH_RAW_IDENTITY_EXPOSED:${index}`);
    }
  }
  return violations;
}

export async function observeInitializedReviewStorageBoundary(input: {
  variant: Variant;
  initializedVariants: Set<Variant>;
  snapshot: () => string[];
  observe: () => Promise<Array<{ method: string; rejected: boolean }>>;
  timeoutMs?: number;
}) {
  input.initializedVariants.add(input.variant);
  await waitUntil(
    "all four portable variants initialized before storage boundary",
    () => specs.every((spec) => input.initializedVariants.has(spec.variant)),
    input.timeoutMs ?? 90_000
  );
  const storageBefore = input.snapshot();
  const observations = await input.observe();
  const storageAfter = input.snapshot();
  const beforeEntries = new Set(storageBefore);
  const afterEntries = new Set(storageAfter);
  return {
    initializedVariants: [...input.initializedVariants].sort(),
    observations,
    storageBefore,
    storageAfter,
    storageDifference: {
      beforeOnly: storageBefore.filter((entry) => !afterEntries.has(entry)),
      afterOnly: storageAfter.filter((entry) => !beforeEntries.has(entry))
    },
    storageUnchanged: JSON.stringify(storageAfter) === JSON.stringify(storageBefore)
  };
}

export function parseObservedCpm(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:CPM|타\/분)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildSyntheticAiFixtureInput(
  row: RecordRow,
  identity: { name: string; phone2: string; phone3: string }
): SaveRecordInput {
  const asResult = (value: unknown): "" | "USER_WIN" | "AI_WIN" =>
    value === "USER_WIN" || value === "AI_WIN" ? value : "";
  const input: SaveRecordInput = {
    participant_name: identity.name,
    phone_part1: "010",
    phone_part2: identity.phone2,
    phone_part3: identity.phone3,
    birth_year: row.birth_year,
    birth_month: row.birth_month,
    birth_day: row.birth_day,
    privacy_agreed: true,
    privacy_agreed_at: row.privacy_agreed_at,
    stageTexts: [row.stage1_text, row.stage2_text, row.stage3_text],
    stageTimesMs: [row.stage1_time_ms, row.stage2_time_ms, row.stage3_time_ms]
      .map((value) => optionalFiniteNumber(value) ?? 0) as [number, number, number],
    game_mode: "ai_challenge",
    final_accuracy: optionalFiniteNumber(row.final_accuracy) ?? 100,
    ai: {
      status: row.ai_challenge_status === "FAILED" ? "FAILED" : "SUCCESS",
      failedStage: row.ai_failed_stage,
      stageCpms: [row.ai_stage1_cpm, row.ai_stage2_cpm, row.ai_stage3_cpm].map(optionalFiniteNumber) as [number | null, number | null, number | null],
      stageTimesMs: [row.ai_stage1_time_ms, row.ai_stage2_time_ms, row.ai_stage3_time_ms].map(optionalFiniteNumber) as [number | null, number | null, number | null],
      stageResults: [row.stage1_vs_ai_result, row.stage2_vs_ai_result, row.stage3_vs_ai_result].map(asResult) as ["" | "USER_WIN" | "AI_WIN", "" | "USER_WIN" | "AI_WIN", "" | "USER_WIN" | "AI_WIN"],
      finalResult: asResult(row.final_vs_ai_result),
      stageDiffsMs: [row.stage1_time_diff_ms, row.stage2_time_diff_ms, row.stage3_time_diff_ms].map(optionalFiniteNumber) as [number | null, number | null, number | null],
      finalDiffMs: optionalFiniteNumber(row.final_time_diff_ms),
      display: {
        participantResultTimeMs: optionalFiniteNumber(row.participant_result_time_ms),
        aiResultTimeMs: optionalFiniteNumber(row.ai_result_time_ms),
        participantAvgCpm: optionalFiniteNumber(row.participant_avg_cpm),
        aiAvgCpm: optionalFiniteNumber(row.ai_avg_cpm),
        resultLabel: row.challenge_result_label,
        participantProgressPercent: optionalFiniteNumber(row.participant_progress_percent),
        aiProgressPercent: optionalFiniteNumber(row.ai_progress_percent),
        duelTimeMs: optionalFiniteNumber(row.duel_time_ms),
        resultStage: optionalFiniteNumber(row.result_stage)
      }
    }
  };
  buildRecordRow(input);
  return input;
}

export function assessCapturedCanonicalInput(input: Partial<SaveRecordInput> | null | undefined): string[] {
  const violations: string[] = [];
  const attempt = input?.canonicalAttempt;
  if (!isCanonicalAiAttemptV1(attempt)) return ["CANONICAL_CAPTURE_MISSING"];
  if (attempt.result !== "PARTICIPANT_WIN") violations.push("CANONICAL_CAPTURE_RESULT");
  if (attempt.contradictionCodes.length > 0 || canonicalAiContradictionCodes(attempt).length > 0) violations.push("CANONICAL_CAPTURE_CONTRADICTION");
  if (attempt.stageReached !== 3 || attempt.stages.length !== 3) violations.push("CANONICAL_CAPTURE_STAGE");
  const texts = input?.stageTexts ?? [];
  const selections = input?.stageTextSelections ?? [];
  const times = input?.stageTimesMs ?? [];
  if (texts.length !== 3 || selections.length !== 3 || times.length !== 3 || attempt.stages.some((stage, index) =>
    !stage.entered
    || stage.stageNumber !== index + 1
    || typeof texts[index] !== "string" || !texts[index].trim()
    || stage.assignedInputUnits !== countConvertedTypingUnits(texts[index])
    || !Number.isFinite(times[index]) || times[index] <= 0
    || selections[index]?.text !== texts[index]
    || stage.participantActiveTypingTimeMs !== times[index]
  )) violations.push("CANONICAL_CAPTURE_ALIGNMENT");
  return violations;
}

export function assessCapturedStoredRow(input: SaveRecordInput, row: RecordRow | undefined): string[] {
  const violations = assessCapturedCanonicalInput(input);
  if (!row?.record_id) return [...violations, "CAPTURED_STORED_ROW_MISSING"];
  if (input.game_mode !== "ai_challenge" || input.ai?.finalResult !== "USER_WIN" || row.final_vs_ai_result !== "USER_WIN") {
    violations.push("CAPTURED_STORED_WIN_MISMATCH");
  }
  const expected = buildRecordRow(input);
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    // These timestamps are assigned during persistence, not in SaveRecordInput.
    if (key === "created_at" || key === "completed_at") continue;
    if (JSON.stringify(row[key]) !== JSON.stringify(expected[key])) violations.push(`CAPTURED_STORED_ROW_MISMATCH:${key}`);
  }
  return violations;
}

export function copyCapturedSyntheticInput(
  captured: SaveRecordInput,
  identity?: { name: string; phone2: string; phone3: string }
): SaveRecordInput {
  assert.deepEqual(assessCapturedCanonicalInput(captured), [], "Synthetic API seed requires validated actual renderer canonical evidence");
  assert.equal(captured.phone_part1, "010");
  assert.equal(captured.game_mode, "ai_challenge");
  const input = structuredClone(captured);
  if (identity) {
    input.participant_name = identity.name;
    input.phone_part2 = identity.phone2;
    input.phone_part3 = identity.phone3;
  }
  buildRecordRow(input);
  return input;
}

export function assessSyntheticSeedEvidence(input: {
  beforeIds: string[]; afterIds: string[]; returnedIds: Array<string | undefined>; repeatBefore: number; repeatAfter: number;
}): string[] {
  const violations: string[] = [];
  const before = new Set(input.beforeIds);
  const returned = new Set(input.returnedIds);
  const after = new Set(input.afterIds);
  if (input.returnedIds.length !== 10 || returned.size !== 10 || input.returnedIds.some((id) =>
    typeof id !== "string" || !/^review-r5-record-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || before.has(id)
  )) violations.push("SYNTHETIC_SEED_IDS_NOT_TEN_FRESH");
  if (after.size !== input.afterIds.length || input.afterIds.length !== input.beforeIds.length + 10
    || input.beforeIds.some((id) => !after.has(id)) || input.returnedIds.some((id) => !after.has(id!))
    || input.afterIds.some((id) => !before.has(id) && !returned.has(id))) violations.push("SYNTHETIC_SEED_PERSISTED_DELTA");
  if (input.repeatAfter !== input.repeatBefore + 1) violations.push("SYNTHETIC_REPEAT_INCREMENT");
  return violations;
}

type CapturedSaveInput = {
  input: SaveRecordInput;
  observedAt: string;
  sourceUrl: string;
  sourceSha256: string;
  argumentName: string;
  breakpointLocation: { scriptId: string; lineNumber: number; columnNumber?: number };
  inputSha256: string;
  resumedImmediately: boolean;
  pauseDurationMs: number;
};

export async function captureRendererSaveInputs(page: Page): Promise<{
  inputs: CapturedSaveInput[]; errors: string[]; stop: () => Promise<void>;
}> {
  const cdp = await page.context().newCDPSession(page);
  const inputs: CapturedSaveInput[] = [];
  const errors: string[] = [];
  const scripts = new Map<string, string>();
  const breakpoints = new Map<string, Omit<CapturedSaveInput, "input" | "observedAt" | "inputSha256" | "resumedImmediately" | "pauseDurationMs">>();
  const onScript = (event: { scriptId: string; url: string }) => {
    if (/dist-renderer\/assets\/index-[^/]+\.js$/.test(event.url)) scripts.set(event.scriptId, event.url);
  };
  let pending = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  const onPaused = (event: { hitBreakpoints?: string[]; callFrames: Array<{ callFrameId: string; location: { scriptId: string } }> }) => {
    pending = (async () => {
      const startedAt = Date.now();
      let captured: CapturedSaveInput | undefined;
      try {
        const source = event.hitBreakpoints?.map((id) => breakpoints.get(id)).find((entry) => entry !== undefined);
        const frame = event.callFrames?.[0];
        assert.ok(source && frame?.location?.scriptId === source.breakpointLocation.scriptId, "Unexpected renderer debugger pause");
        const evaluated = await cdp.send("Debugger.evaluateOnCallFrame", {
          callFrameId: frame.callFrameId,
          expression: `JSON.stringify(${source.argumentName})`,
          returnByValue: true,
          throwOnSideEffect: true
        });
        assert.equal(evaluated.exceptionDetails, undefined, "Renderer save input read raised an exception");
        assert.equal(typeof evaluated.result.value, "string", "Renderer save input was not serializable");
        const input = JSON.parse(evaluated.result.value) as SaveRecordInput;
        assert.ok(input && typeof input === "object", "Renderer save input missing");
        captured = {
          ...source, input, observedAt: new Date().toISOString(),
          inputSha256: crypto.createHash("sha256").update(evaluated.result.value).digest("hex").toUpperCase(),
          resumedImmediately: false, pauseDurationMs: 0
        };
        inputs.push(captured);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        try {
          await cdp.send("Debugger.resume");
          if (captured) captured.resumedImmediately = true;
        } catch (error) {
          errors.push(`DEBUGGER_RESUME_FAILED:${String(error)}`);
        }
        if (captured) captured.pauseDurationMs = Date.now() - startedAt;
      }
    })();
  };
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    await pending;
    try {
      for (const breakpointId of breakpoints.keys()) {
        try { await cdp.send("Debugger.removeBreakpoint", { breakpointId }); }
        catch (error) { errors.push(`DEBUGGER_REMOVE_FAILED:${String(error)}`); }
      }
    } finally {
      cdp.off("Debugger.paused", onPaused);
      cdp.off("Debugger.scriptParsed", onScript);
      try { await cdp.detach(); }
      catch (error) { errors.push(`DEBUGGER_DETACH_FAILED:${String(error)}`); }
    }
  })();
  cdp.on("Debugger.scriptParsed", onScript);
  cdp.on("Debugger.paused", onPaused);
  try {
    await cdp.send("Debugger.enable");
    await waitUntil("packaged renderer source for actual save input capture", () => scripts.size > 0, 5_000);
    for (const [scriptId, sourceUrl] of scripts) {
      const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId });
      const sourceSha256 = crypto.createHash("sha256").update(scriptSource).digest("hex").toUpperCase();
      for (const match of scriptSource.matchAll(/window\.typingKing\.saveRecord\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const lines = scriptSource.slice(0, match.index).split("\n");
        const { breakpointId, actualLocation } = await cdp.send("Debugger.setBreakpoint", {
          location: { scriptId, lineNumber: lines.length - 1, columnNumber: lines.at(-1)!.length }
        });
        breakpoints.set(breakpointId, { sourceUrl, sourceSha256, argumentName: match[1], breakpointLocation: actualLocation });
      }
    }
    assert.ok(breakpoints.size > 0, "Packaged renderer saveRecord source breakpoint missing");
    return { inputs, errors, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

const visibleAssetHashCache = new Map<string, string>();

type MappedImageExpectation = { selector: string; fileName: string };
type ImageReadinessObservation = {
  observedAt: string;
  innerWidth: number;
  innerHeight: number;
  images: Array<{ src: string; currentSrc: string; alt: string; complete: boolean; naturalWidth: number; naturalHeight: number; bounds: RectObservation }>;
};

export function expectedMappedImageForScreen(screen: string): MappedImageExpectation | null {
  const stage = /^stage-([123])$/.exec(screen)?.[1];
  if (stage) return { selector: ".challenge-modal .challenge-modal-art", fileName: `금나래패배_스테이지${stage}.png` };
  if (screen === "result") return { selector: ".challenge-result-panel .challenge-result-art", fileName: "금나래패배_스테이지3.png" };
  if (screen === "ai-win-stage-1") return { selector: ".challenge-modal .challenge-modal-art", fileName: "금나래 승리.png" };
  return null;
}

export function assessMappedImageReadiness(expected: MappedImageExpectation, observation: ImageReadinessObservation, viewport: { width: number; height: number }): string[] {
  const violations: string[] = [];
  if (observation.innerWidth !== viewport.width || observation.innerHeight !== viewport.height) violations.push("IMAGE_VIEWPORT_NOT_READY");
  if (observation.images.length !== 1) return [...violations, "EXPECTED_IMAGE_MISSING_OR_DUPLICATED"];
  const image = observation.images[0];
  const fileName = (src: string) => {
    try {
      const url = new URL(src);
      return url.protocol === "file:" ? path.basename(fileURLToPath(url)) : null;
    } catch { return null; }
  };
  if (fileName(image.src) !== expected.fileName) violations.push("EXPECTED_IMAGE_SRC_MISMATCH");
  if (fileName(image.currentSrc) !== expected.fileName) violations.push("EXPECTED_IMAGE_CURRENT_SRC_MISMATCH");
  if (image.complete !== true || !Number.isFinite(image.naturalWidth) || !Number.isFinite(image.naturalHeight) || image.naturalWidth <= 0 || image.naturalHeight <= 0) violations.push("EXPECTED_IMAGE_NOT_LOADED");
  if (!Number.isFinite(image.bounds?.width) || !Number.isFinite(image.bounds?.height) || image.bounds.width <= 0 || image.bounds.height <= 0) violations.push("EXPECTED_IMAGE_HAS_NO_RENDERED_BOX");
  return violations;
}

export function observeMappedImageReadiness(selector: string): ImageReadinessObservation {
  return {
    observedAt: new Date().toISOString(), innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    images: [...document.querySelectorAll<HTMLImageElement>(selector)].map((image) => ({
      src: image.src ?? "", currentSrc: image.currentSrc ?? "", alt: image.alt ?? "", complete: image.complete === true,
      naturalWidth: image.naturalWidth ?? 0, naturalHeight: image.naturalHeight ?? 0, bounds: image.getBoundingClientRect().toJSON()
    }))
  };
}

export function hashVisibleMappedImages(
  images: Array<{ src: string; currentSrc?: string; alt: string; naturalWidth: number; naturalHeight: number }>,
  approvedHashes: Record<string, string>
): { images: Array<Record<string, unknown>>; violations: string[] } {
  const violations: string[] = [];
  const enriched = images.map((image) => {
    let filePath: string | null = null;
    let fileName: string | null = null;
    let hash: string | null = null;
    let readError: string | null = null;
    try {
      const url = new URL(image.currentSrc || image.src);
      if (url.protocol !== "file:") throw new Error(`unsupported protocol ${url.protocol}`);
      url.search = "";
      url.hash = "";
      filePath = fileURLToPath(url);
      fileName = path.basename(filePath);
      hash = visibleAssetHashCache.get(filePath) ?? sha256(filePath);
      visibleAssetHashCache.set(filePath, hash);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    const expectedSha256 = fileName ? approvedHashes[fileName] ?? null : null;
    const mappedApprovedAsset = expectedSha256 != null;
    const approvedBytesMatch = mappedApprovedAsset && hash === expectedSha256;
    if (mappedApprovedAsset && readError) violations.push(`VISIBLE_ASSET_READ_FAILED:${fileName}`);
    else if (mappedApprovedAsset && !approvedBytesMatch) violations.push(`VISIBLE_ASSET_HASH_MISMATCH:${fileName}`);
    return { ...image, fileName, sha256: hash, expectedSha256, mappedApprovedAsset, approvedBytesMatch, readStatus: readError ? "VISIBLE_ASSET_READ_FAILED" : "PASS" };
  });
  return { images: enriched, violations };
}

function approvedMappedAssetHashes(): Record<string, string> {
  const assetRoot = path.resolve("events", "geumcheon-2026", "assets");
  return Object.fromEntries([
    "금나래 승리.png",
    "금나래패배_스테이지1.png",
    "금나래패배_스테이지2.png",
    "금나래패배_스테이지3.png"
  ].map((fileName) => [fileName, sha256(path.join(assetRoot, fileName))]));
}

const APPROVED_MAPPED_ASSET_HASHES = approvedMappedAssetHashes();

function snapshotDirectory(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const snapshot: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        snapshot.push(`${relativePath}/`);
        visit(fullPath);
      } else {
        const bytes = fs.statSync(fullPath).size;
        snapshot.push(`${relativePath}:${bytes}:${sha256(fullPath)}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

async function observeExternalStorageBoundary(
  page: Page
): Promise<Array<{ method: string; rejected: boolean }>> {
  return page.evaluate(async (methods) => {
    const api = (window as any).typingKing;
    const observations: Array<{ method: string; rejected: boolean }> = [];
    for (const method of methods) {
      try {
        let response: any;
        switch (method) {
          case "publishStageTextsToOneDrive":
            response = await api.publishStageTextsToOneDrive();
            break;
          case "getOneDriveSettings":
            response = await api.getOneDriveSettings();
            break;
          case "updateOneDriveSettings":
            response = await api.updateOneDriveSettings({ syncMode: "local" });
            break;
          case "validateOneDriveSetup":
            response = await api.validateOneDriveSetup();
            break;
          case "pokeOneDriveSync":
            response = await api.pokeOneDriveSync("review-boundary-check");
            break;
          case "cleanupLegacyOneDriveArtifacts":
            response = await api.cleanupLegacyOneDriveArtifacts();
            break;
          case "chooseOneDriveRoot":
            response = await api.chooseOneDriveRoot();
            break;
          case "openSessionFolder":
            response = await api.openSessionFolder();
            break;
        }
        observations.push({ method, rejected: response?.ok === false });
      } catch {
        observations.push({ method, rejected: false });
      }
    }
    return observations;
  }, REVIEW_EXTERNAL_STORAGE_API_METHODS);
}

async function observePlayerWindowLayout(page: Page): Promise<PlayerWindowLayoutObservation> {
  return page.evaluate(() => {
    const heroPanel = document.querySelector(".hero-panel");
    const heroGuideCard = heroPanel?.querySelector(".hero-guide-card") ?? null;
    const guideLines = heroGuideCard?.querySelectorAll(".hero-guide-list > li");
    const fifthGuideLine = guideLines?.item(4) ?? null;
    const heroPanelBounds = heroPanel?.getBoundingClientRect();
    const heroGuideCardBounds = heroGuideCard?.getBoundingClientRect();
    const fifthGuideLineBounds = fifthGuideLine?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      heroPanel: heroPanelBounds ? {
        left: heroPanelBounds.left,
        top: heroPanelBounds.top,
        right: heroPanelBounds.right,
        bottom: heroPanelBounds.bottom,
        width: heroPanelBounds.width,
        height: heroPanelBounds.height
      } : null,
      heroGuideCard: heroGuideCardBounds ? {
        left: heroGuideCardBounds.left,
        top: heroGuideCardBounds.top,
        right: heroGuideCardBounds.right,
        bottom: heroGuideCardBounds.bottom,
        width: heroGuideCardBounds.width,
        height: heroGuideCardBounds.height
      } : null,
      fifthGuideLine: fifthGuideLineBounds ? {
        left: fifthGuideLineBounds.left,
        top: fifthGuideLineBounds.top,
        right: fifthGuideLineBounds.right,
        bottom: fifthGuideLineBounds.bottom,
        width: fifthGuideLineBounds.width,
        height: fifthGuideLineBounds.height
      } : null,
      guideLineCount: guideLines?.length ?? 0
    };
  });
}

export function inspectReviewArtifacts(inputs: ArtifactInput[]): { artifacts: ArtifactFinding[]; violations: string[] } {
  const violations: string[] = [];
  const artifacts = inputs.map(({ variant, exePath }) => {
    const bytes = fs.statSync(exePath).size;
    const header = Buffer.alloc(2);
    const handle = fs.openSync(exePath, "r");
    try { fs.readSync(handle, header, 0, 2, 0); } finally { fs.closeSync(handle); }
    const pe = header.equals(Buffer.from("MZ"));
    const listing = fs.readdirSync(path.dirname(exePath)).sort();
    const hash = sha256(exePath);
    if (!pe) violations.push(`${variant}:NON_PE`);
    if (bytes < MIN_PORTABLE_BYTES) violations.push(`${variant}:UNDERSIZED:${bytes}`);
    for (const sibling of listing.filter((name) => name !== path.basename(exePath))) {
      violations.push(`${variant}:UNEXPECTED_SIBLING:${sibling}`);
    }
    return { variant, exePath, bytes, sha256: hash, pe, listing };
  });
  const byHash = new Map<string, string[]>();
  for (const artifact of artifacts) byHash.set(artifact.sha256, [...(byHash.get(artifact.sha256) ?? []), artifact.variant]);
  for (const [hash, variants] of byHash) {
    if (variants.length > 1) violations.push(`DUPLICATE_HASH:${hash}:${variants.join(",")}`);
  }
  return { artifacts, violations };
}

export function assessRuntimeObservation(input: RuntimeObservation): string[] {
  const violations: string[] = [];
  const context = input.bootstrap?.reviewContext;
  if (!context || context.environment !== "review" || context.profileId !== "geumcheon-2026"
    || context.eventId !== "geumcheon-science-festival-2026-review" || context.buildId !== "R2.0.4-R5"
    || context.storageKind !== "local" || context.role !== input.expectedRole
    || context.sessionKind !== input.expectedSession || input.bootstrap?.variant !== input.expectedVariant) {
    violations.push("REVIEW_CONTEXT_MISSING");
  }
  if ((input.notices ?? []).includes(FALLBACK_NOTICE)) violations.push("STAGE_TEXT_FALLBACK");
  if ((input.observedHelperProcesses ?? []).length) violations.push("UNEXPECTED_HELPER_PROCESS");
  if ((input.credentialPopupCount ?? 0) > 0) violations.push("CREDENTIAL_POPUP");
  if ((input.commandWindowCount ?? 0) > 0) violations.push("COMMAND_WINDOW");
  if (input.cleanExit === false) violations.push("UNCLEAN_EXIT");
  if (input.residualProcessCount === null) violations.push("PROCESS_OBSERVATION_UNKNOWN");
  if ((input.residualProcessCount ?? 0) > 0) violations.push("RESIDUAL_PROCESS");
  if ((input.unexpectedFiles ?? []).length) violations.push("UNEXPECTED_RUNTIME_FILE");
  return violations;
}

async function waitUntil(description: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${description}${last instanceof Error ? `: ${last.message}` : ""}`);
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function readCdp(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body).webSocketDebuggerUrl); } catch { resolve(undefined); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(undefined));
  });
}

function sanitizedEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i.test(key)
    && !["APP_VARIANT", "TYPINGKING_EVENT_PROFILE", "TYPINGKING_RUNTIME_ROOT", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"].includes(key.toUpperCase())
  ));
  return { ...env, ...overrides };
}

export async function captureResolutionEvidence(page: Page, variant: Variant, screen: string, outputRoot: string): Promise<Array<Record<string, unknown>>> {
  const evidence: Array<Record<string, unknown>> = [];
  for (const [width, height] of [[1280, 720], [1920, 1080]] as const) {
    const expectedImage = expectedMappedImageForScreen(screen);
    const imageObservationPath = expectedImage ? path.join(outputRoot, "image-observations", `${variant}-${screen}-${width}x${height}.json`) : null;
    const imageObservation: Record<string, any> | null = expectedImage ? {
      schemaVersion: 1, variant, screen, requestedViewport: { width, height }, expectedImage,
      readyTimeoutMs: 2_000, status: "PENDING", readinessSamples: [], beforeCapture: null, afterCapture: null,
      geometry: null, byteObservations: null, screenshot: null, error: null
    } : null;
    try {
    await page.setViewportSize({ width, height });
    await waitUntil(`${variant} ${screen} viewport ${width}x${height}`, () => page.evaluate(({ width, height }) => window.innerWidth === width && window.innerHeight === height, { width, height }), 10_000);
    if (expectedImage && imageObservation) {
      await waitUntil(`${variant} ${screen} exact image ready at ${width}x${height}`, async () => {
        const observation = await page.evaluate(observeMappedImageReadiness, expectedImage.selector);
        const violations = assessMappedImageReadiness(expectedImage, observation, { width, height });
        imageObservation.readinessSamples.push({ ...observation, violations });
        assert.deepEqual(violations, [], `Expected ${expectedImage.fileName}: ${JSON.stringify(observation)}`);
        return true;
      }, imageObservation.readyTimeoutMs);
    }
    const geometry = await page.evaluate(() => {
      const titleBox = document.querySelector(".left-title-group")?.getBoundingClientRect().toJSON() ?? null;
      const titleArtwork = document.querySelector(".geumcheon-main-title-image")?.getBoundingClientRect().toJSON() ?? null;
      const secondGuide = document.querySelector(".hero-copy")?.getBoundingClientRect().toJSON() ?? null;
      const heroPanel = document.querySelector(".hero-panel")?.getBoundingClientRect().toJSON() ?? null;
      const heroGuideCard = document.querySelector(".hero-guide-card")?.getBoundingClientRect().toJSON() ?? null;
      const heroGuideLines = document.querySelectorAll(".hero-guide-list > li");
      const fifthGuideLine = heroGuideLines.item(4)?.getBoundingClientRect().toJSON() ?? null;
      const slogan = document.querySelector(".entry-event-copy span");
      const sloganRect = slogan?.getBoundingClientRect();
      const app = document.querySelector<HTMLElement>(".leaderboard-app");
      const leaderboardBoard = document.querySelector<HTMLElement>(".ranking-table.ai-ranking");
      const leaderboardTitle = leaderboardBoard?.querySelector<HTMLImageElement>(".leaderboard-ai-title-img") ?? null;
      const leaderboardTitleContainer = leaderboardTitle?.closest<HTMLElement>(".leaderboard-mode-title") ?? null;
      const appStyle = app ? getComputedStyle(app) : null;
      const boardRect = leaderboardBoard?.getBoundingClientRect();
      const boardTitleRect = leaderboardTitle?.getBoundingClientRect();
      const boardTitleContainerRect = leaderboardTitleContainer?.getBoundingClientRect();
      const visibleMappedImages: Array<{ src: string; currentSrc: string; alt: string; complete: boolean; naturalWidth: number; naturalHeight: number; bounds: any }> = [];
      for (const element of document.querySelectorAll(".ai-boss-typing, .challenge-modal-art, .challenge-result-art")) {
        const image = element as HTMLImageElement;
        const bounds = image.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) {
          visibleMappedImages.push({ src: image.src, currentSrc: image.currentSrc, alt: image.alt, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, bounds: bounds.toJSON() });
        }
      }
      return {
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        titleBox, titleArtwork, secondGuide, heroPanel, heroGuideCard, fifthGuideLine, guideLineCount: heroGuideLines.length,
        slogan: sloganRect ? { left: sloganRect.left, top: sloganRect.top, right: sloganRect.right, bottom: sloganRect.bottom, width: sloganRect.width, height: sloganRect.height } : null,
        sloganCenterVisible: Boolean(slogan && sloganRect && document.elementFromPoint(sloganRect.left + sloganRect.width / 2, sloganRect.top + sloganRect.height / 2)?.closest(".entry-event-copy")),
        visibleMappedImages,
        leaderboard: app && leaderboardTitle && boardRect && boardTitleRect && boardTitleContainerRect ? {
          backgroundImage: appStyle?.backgroundImage ?? "",
          backgroundPosition: appStyle?.backgroundPosition ?? "",
          backgroundSize: appStyle?.backgroundSize ?? "",
          backgroundRepeat: appStyle?.backgroundRepeat ?? "",
          board: boardRect.toJSON(),
          titleContainer: boardTitleContainerRect.toJSON(),
          title: boardTitleRect.toJSON(),
          titleSrc: leaderboardTitle.currentSrc || leaderboardTitle.src,
          titleNaturalWidth: leaderboardTitle.naturalWidth,
          titleNaturalHeight: leaderboardTitle.naturalHeight,
          titleCenterOffsetPx: Math.abs((boardTitleRect.left + boardTitleRect.width / 2) - (boardRect.left + boardRect.width / 2)),
          titleContainerCenterOffsetPx: Math.abs((boardTitleContainerRect.left + boardTitleContainerRect.width / 2) - (boardRect.left + boardRect.width / 2)),
          titleWithinContainer: boardTitleRect.left >= boardTitleContainerRect.left - 1 && boardTitleRect.right <= boardTitleContainerRect.right + 1 && boardTitleRect.top >= boardTitleContainerRect.top - 1 && boardTitleRect.bottom <= boardTitleContainerRect.bottom + 1,
          titleContainerWithinBoard: boardTitleContainerRect.left >= boardRect.left - 1 && boardTitleContainerRect.right <= boardRect.right + 1 && boardTitleContainerRect.top >= boardRect.top - 1 && boardTitleContainerRect.bottom <= boardRect.bottom + 1
        } : null
      };
    });
    const screenshot = path.join(outputRoot, "screenshots", `${variant}-${screen}-${width}x${height}.png`);
    const leaderboardTable = screen.startsWith("leaderboard-") ? await page.evaluate(readLeaderboardTableObservation) : null;
    if (expectedImage && imageObservation) {
      imageObservation.geometry = geometry;
      imageObservation.beforeCapture = await page.evaluate(observeMappedImageReadiness, expectedImage.selector);
      assert.deepEqual(assessMappedImageReadiness(expectedImage, imageObservation.beforeCapture, { width, height }), [], `${variant} ${screen} image changed before capture`);
    }
    await page.screenshot({ path: screenshot });
    if (expectedImage && imageObservation) {
      imageObservation.screenshot = screenshot;
      imageObservation.afterCapture = await page.evaluate(observeMappedImageReadiness, expectedImage.selector);
      assert.deepEqual(assessMappedImageReadiness(expectedImage, imageObservation.afterCapture, { width, height }), [], `${variant} ${screen} image changed during capture`);
    }
    assert.equal(geometry.innerWidth, width);
    assert.equal(geometry.innerHeight, height);
    const group = geometry.titleBox;
    const title = geometry.titleArtwork;
    const guide = geometry.secondGuide;
    const alignment = screen === "main" && group && title && guide ? {
      titleWidthPx: title.width,
      secondGuideWidthPx: guide.width,
      widthDifferencePx: Math.abs(title.width - guide.width),
      titleCenterOffsetPx: Math.abs((title.left + title.width / 2) - (group.left + group.width / 2)),
      secondGuideCenterOffsetPx: Math.abs((guide.left + guide.width / 2) - (group.left + group.width / 2)),
      titleContained: title.left >= group.left - 1 && title.right <= group.right + 1,
      secondGuideContained: guide.left >= group.left - 1 && guide.right <= group.right + 1
    } : null;
    const centerTolerancePx = width <= 1366 ? 3 : 2;
    const alignmentStatus = alignment
      ? (alignment.titleContained && alignment.secondGuideContained && alignment.titleCenterOffsetPx <= centerTolerancePx && alignment.secondGuideCenterOffsetPx <= centerTolerancePx ? "PASS" : "PARTIAL")
      : "NOT_APPLICABLE";
    const raw = { requestedViewport: { width, height }, viewportMethod: "Playwright CDP renderer viewport emulation on actual packaged EXE", nativeWindowOuter: { width: geometry.outerWidth, height: geometry.outerHeight }, ...geometry, leaderboardTable, alignment, alignmentStatus, screenshot, imageObservationPath };
    const mappedImages = hashVisibleMappedImages(raw.visibleMappedImages, APPROVED_MAPPED_ASSET_HASHES);
    if (imageObservation) imageObservation.byteObservations = mappedImages;
    assert.deepEqual(mappedImages.violations, [], `${variant} ${screen} visible mapped asset bytes mismatch`);
    if (/^(?:stage-[123]|result|ai-win-stage-1)$/.test(screen)) {
      assert.ok(mappedImages.images.some((image) => image.mappedApprovedAsset === true && image.approvedBytesMatch === true), `${variant} ${screen} has no byte-verified approved mapped image`);
    }
    if (expectedImage) {
      assert.ok(mappedImages.images.some((image) => image.fileName === expectedImage.fileName && image.approvedBytesMatch === true), `${variant} ${screen} expected byte-verified image ${expectedImage.fileName} missing`);
    }
    if (screen === "main") {
      const { width, height } = raw.requestedViewport;
      assert.equal(raw.guideLineCount, 5, `${variant} ${width}x${height} guide count`);
      assert.equal(containsRect(raw.heroPanel, raw.heroGuideCard), true, `${variant} ${width}x${height} guide card clipped`);
      assert.equal(containsRect(raw.heroGuideCard, raw.fifthGuideLine), true, `${variant} ${width}x${height} fifth guide clipped by guide card`);
      assert.equal(containsRect(raw.heroPanel, raw.fifthGuideLine), true, `${variant} ${width}x${height} fifth guide clipped by hero panel`);
    }
    evidence.push({ ...raw, visibleMappedImages: mappedImages.images });
    if (imageObservation) imageObservation.status = "PASS";
    } catch (error) {
      if (imageObservation) {
        imageObservation.status = "FAIL";
        imageObservation.error = error instanceof Error ? error.stack ?? error.message : String(error);
      }
      throw error;
    } finally {
      if (imageObservation && imageObservationPath) {
        fs.mkdirSync(path.dirname(imageObservationPath), { recursive: true });
        fs.writeFileSync(imageObservationPath, `${JSON.stringify(imageObservation, null, 2)}\n`);
      }
    }
  }
  return evidence;
}

async function openAdminAndValidate(page: Page, variant: Variant, outputRoot: string): Promise<string> {
  await page.getByRole("button", { name: "관리자 모드", exact: true }).click();
  await page.locator(".admin-modal").waitFor({ state: "visible" });
  const inputs = page.locator(".admin-modal input");
  await inputs.nth(0).fill("synthetic-review-admin");
  await inputs.nth(1).fill(REVIEW_LOCAL_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "비밀번호 확인", exact: true }).click();
  await page.locator(".admin-modal.wide").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "로컬 저장소 검증" }).click();
  const tuple = page.locator(".geumcheon-nas-status-panel .notice-text");
  await waitUntil("visible completed storage tuple", () => tuple.innerText().then((text) => text.includes("정상")), 10_000);
  const message = await tuple.innerText();
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-admin-validation-complete.png`) });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  return message;
}

function launchViaShellExecute(exePath: string, cwd: string, port: number, userDataDir: string, env: NodeJS.ProcessEnv): number {
  const launchedAfterMs = Date.now() - 2_000;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=Start-Process -FilePath $env:TK_R5_EXE -WorkingDirectory $env:TK_R5_CWD -ArgumentList @('--remote-debugging-port=' + $env:TK_R5_PORT, '--user-data-dir=' + $env:TK_R5_USER_DATA) -PassThru",
    "[Console]::Out.Write($p.Id)"
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...env, TK_R5_EXE: exePath, TK_R5_CWD: cwd, TK_R5_PORT: String(port), TK_R5_USER_DATA: userDataDir }
  });
  if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) throw new Error(`SHELLEXECUTE_FAILED:${result.stderr.trim()}`);
  const pid = Number(result.stdout.trim());
  processRootExpectations.set(pid, { executablePath: path.resolve(exePath), notBeforeMs: launchedAfterMs });
  return pid;
}

type ProcessInfo = { ProcessId: number; ParentProcessId: number; Name: string; MainWindowTitle: string; ExecutablePath: string; CreatedAtUtc: string };
type ProcessRootExpectation = { executablePath: string; notBeforeMs: number };
const processRootExpectations = new Map<number, ProcessRootExpectation>();

export function parseNativeProcessSnapshot(
  result: { status: number | null; stdout: string; stderr?: string; error?: { code?: string; message?: string } },
  rootPid: number,
  expected?: ProcessRootExpectation
): ProcessInfo[] {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, "PROCESS_TREE_INVALID_ROOT_PID");
  if (result.error?.code === "ETIMEDOUT") throw new Error("PROCESS_TREE_ENUMERATION_TIMEOUT");
  if (result.error || result.status !== 0) throw new Error(`PROCESS_TREE_ENUMERATION_FAILED:${result.error?.code ?? result.status}:${result.stderr ?? ""}`);
  let value: any;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error("PROCESS_TREE_INVALID_JSON"); }
  assert.ok(value?.method === "Toolhelp32Snapshot + Get-Process" && value.snapshotComplete === true
    && Number.isSafeInteger(value.snapshotProcessCount) && value.snapshotProcessCount > 0
    && value.rootPid === rootPid && typeof value.rootPresent === "boolean" && Array.isArray(value.processes), "PROCESS_TREE_INCOMPLETE_SNAPSHOT");
  const rows = value.processes as ProcessInfo[];
  assert.ok(rows.every((row) => row && Number.isSafeInteger(row.ProcessId) && row.ProcessId > 0
    && Number.isSafeInteger(row.ParentProcessId) && row.ParentProcessId >= 0
    && typeof row.Name === "string" && row.Name.length > 0 && typeof row.MainWindowTitle === "string"
    && typeof row.ExecutablePath === "string" && row.ExecutablePath.length > 0
    && typeof row.CreatedAtUtc === "string" && Number.isFinite(Date.parse(row.CreatedAtUtc))), "PROCESS_TREE_INVALID_PROCESS_METADATA");
  assert.equal(new Set(rows.map((row) => row.ProcessId)).size, rows.length, "PROCESS_TREE_DUPLICATE_PID");
  assert.equal(value.rootPresent, rows.some((row) => row.ProcessId === rootPid), "PROCESS_TREE_ROOT_PRESENCE_MISMATCH");
  const reachable = new Set([rootPid]);
  for (let previous = -1; previous !== reachable.size;) {
    previous = reachable.size;
    for (const row of rows) if (reachable.has(row.ParentProcessId)) reachable.add(row.ProcessId);
  }
  assert.ok(rows.every((row) => reachable.has(row.ProcessId)), "PROCESS_TREE_UNRELATED_PROCESS");
  if (expected) {
    for (const row of rows) {
      assert.ok(Date.parse(row.CreatedAtUtc) >= expected.notBeforeMs, "PROCESS_TREE_ROOT_IDENTITY:creation time predates launch");
      if (row.ProcessId === rootPid) assert.equal(path.resolve(row.ExecutablePath).toLowerCase(), path.resolve(expected.executablePath).toLowerCase(), "PROCESS_TREE_ROOT_IDENTITY:executable path changed");
    }
  }
  return rows;
}

const nativeProcessTreeScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class R6ProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Entry {
    public uint dwSize, cntUsage, th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public static Entry[] Read() {
    var handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var rows = new List<Entry>(); var entry = new Entry();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(handle, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
      do { rows.Add(entry); entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry)); } while (Process32NextW(handle, ref entry));
      var error = Marshal.GetLastWin32Error();
      if (error != 18) throw new Win32Exception(error);
      return rows.ToArray();
    } finally { CloseHandle(handle); }
  }
}
'@
$rootProcessId=[uint32]$env:TK_R5_PID
for($attempt=0;$attempt -lt 3;$attempt++) {
  $entries=@([R6ProcessSnapshot]::Read())
  $ids=[Collections.Generic.HashSet[uint32]]::new()
  [void]$ids.Add($rootProcessId)
  do {$added=0;foreach($entry in $entries){if($ids.Contains($entry.th32ParentProcessID)-and $ids.Add($entry.th32ProcessID)){$added++}}}while($added)
  $selected=@($entries|Where-Object {$ids.Contains($_.th32ProcessID)})
  $rows=@();$retry=$false
  foreach($entry in $selected) {
    try { $process=Get-Process -Id $entry.th32ProcessID -ErrorAction Stop }
    catch {
      if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*'){$retry=$true;break}
      throw
    }
    $process.Refresh()
    $rows += [pscustomobject]@{ProcessId=$entry.th32ProcessID;ParentProcessId=$entry.th32ParentProcessID;Name=$entry.szExeFile;MainWindowTitle=$process.MainWindowTitle;ExecutablePath=$process.Path;CreatedAtUtc=$process.StartTime.ToUniversalTime().ToString('o')}
  }
  if($retry){continue}
  [pscustomobject]@{method='Toolhelp32Snapshot + Get-Process';snapshotComplete=$true;snapshotProcessCount=$entries.Count;rootPid=$rootProcessId;rootPresent=[bool]($entries|Where-Object {$_.th32ProcessID -eq $rootProcessId});processes=@($rows)}|ConvertTo-Json -Depth 5 -Compress
  exit 0
}
throw 'PROCESS_TREE_UNSTABLE_SNAPSHOT'
`;

export function processTree(rootPid: number): ProcessInfo[] {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, "PROCESS_TREE_INVALID_ROOT_PID");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", nativeProcessTreeScript], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TK_R5_PID: String(rootPid) }
  });
  return parseNativeProcessSnapshot(result, rootPid, processRootExpectations.get(rootPid));
}

async function playerFlow(page: Page, variant: Variant, outputRoot: string): Promise<{ recordId: string; participantName: string; searchNeedle: string; stageTexts: string[]; repeatParticipantAttempts: number; uniqueParticipantCount: number; resolutionEvidence: Array<Record<string, unknown>>; controlPauseEvidence: Array<Record<string, unknown>>; canonicalCaptureEvidence: Record<string, unknown>; syntheticSeedEvidence: Record<string, unknown> }> {
  const participantName = variant === "ai" ? "합성공식검증" : "합성연습검증";
  const searchNeedle = expectedMaskedPhoneSearchNeedle(variant);
  const resolutionEvidence: Array<Record<string, unknown>> = [];
  const controlPauseEvidence: Array<Record<string, unknown>> = [];
  const saveCapture = await captureRendererSaveInputs(page);
  try {
  await openAdminAndValidate(page, variant, outputRoot);
  resolutionEvidence.push(...await captureResolutionEvidence(page, variant, "main", outputRoot));
  await page.locator(".entry-form-group input").first().fill(participantName);
  const phone = page.locator(".phone-row input");
  await phone.nth(0).fill(variant === "ai" ? "5101" : "5201");
  await phone.nth(1).fill(searchNeedle);
  const birth = page.locator(".birth-row select");
  await birth.nth(0).selectOption("2012");
  await birth.nth(1).selectOption("1");
  await birth.nth(2).selectOption("2");
  await page.locator('.entry-form-group input[type="checkbox"]').check();
  await page.locator(".entry-form-group input").first().focus();
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-focus-input.png`) });
  await birth.nth(0).focus();
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-focus-select.png`) });
  await page.locator('.entry-form-group input[type="checkbox"]').focus();
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-focus-checkbox.png`) });
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-main.png`) });
  await page.locator(".entry-panel .button-row .primary-button").click();
  await page.locator(".challenge-screen").waitFor({ state: "visible", timeout: 30_000 });
  const stageTexts: string[] = [];
  for (let stage = 1; stage <= 3; stage += 1) {
    const input = page.locator("textarea.typing-input");
    await waitUntil(`stage ${stage} input enabled`, () => input.isEnabled(), 15_000);
    if (stage === 1) {
      await input.focus();
      await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-focus-challenge.png`) });
      const aiPanel = page.locator(".duel-panel").nth(1);
      const beforeControl = await aiPanel.innerText();
      const targetBeforeControl = await page.locator(".duel-target").first().innerText();
      const stageBeforeControl = await page.locator(".challenge-stage-center").innerText();
      await page.getByRole("button", { name: "다시하기", exact: true }).click();
      await page.locator(".game-confirm-modal").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "취소", exact: true }).click();
      await page.locator(".game-confirm-modal").waitFor({ state: "hidden" });
      const afterControl = await aiPanel.innerText();
      const targetAfterControl = await page.locator(".duel-target").first().innerText();
      const stageAfterControl = await page.locator(".challenge-stage-center").innerText();
      const observedCpmBefore = parseObservedCpm(beforeControl);
      const observedCpmAfter = parseObservedCpm(afterControl);
      assert.ok(observedCpmBefore != null && Number.isFinite(observedCpmBefore), `${variant} pre-control observed CPM missing`);
      assert.ok(observedCpmAfter != null && Number.isFinite(observedCpmAfter), `${variant} post-control observed CPM missing`);
      assert.equal(targetAfterControl, targetBeforeControl, `${variant} target changed across pause/cancel`);
      assert.equal(stageAfterControl, stageBeforeControl, `${variant} stage changed across pause/cancel`);
      assert.equal(await input.isEnabled(), true, `${variant} input did not resume after control cancel`);
      controlPauseEvidence.push({
        stage: 1,
        targetPreserved: true,
        stagePreserved: true,
        inputResumed: true,
        observedCpmBefore,
        observedCpmAfter,
        observedRateMeaning: "informational live rate; not the fixed drawn stage target",
        fixedDrawProtectionEvidence: "covered by existing AI-plan/domain regression tests, not inferred from live rate equality"
      });
    }
    const target = (await page.locator(".duel-target").first().innerText()).replace(/\u00a0/g, " ").trim();
    assert.equal(canonicalStageTexts.get(stage)?.has(target), true, `${variant} stage ${stage} did not draw from canonical catalog: ${target}`);
    stageTexts.push(target);
    await input.fill(target);
    const modal = page.locator(".challenge-modal");
    await modal.waitFor({ state: "visible", timeout: 20_000 });
    resolutionEvidence.push(...await captureResolutionEvidence(page, variant, `stage-${stage}`, outputRoot));
    await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-stage-${stage}.png`) });
    await modal.locator(".primary-button").click();
  }
  await page.locator(".challenge-result-panel").waitFor({ state: "visible", timeout: 20_000 });
  await waitUntil("actual participant-win renderer save input", () => saveCapture.errors.length > 0 || saveCapture.inputs.some((entry) =>
    entry.input.participant_name === participantName && entry.input.canonicalAttempt?.result === "PARTICIPANT_WIN"
  ), 10_000);
  await saveCapture.stop();
  assert.deepEqual(saveCapture.errors, [], `${variant} actual renderer capture failed`);
  const wins = saveCapture.inputs.filter((entry) => entry.input.participant_name === participantName && entry.input.canonicalAttempt?.result === "PARTICIPANT_WIN");
  assert.equal(wins.length, 1, `${variant} actual renderer winning input missing or ambiguous`);
  const capturedWin = wins[0];
  assert.equal(capturedWin.resumedImmediately, true, `${variant} renderer was not resumed`);
  assert.deepEqual(assessCapturedCanonicalInput(capturedWin.input), [], `${variant} captured canonical input invalid`);
  assert.deepEqual(capturedWin.input.stageTexts, stageTexts, `${variant} captured texts differ from actual UI draw`);
  resolutionEvidence.push(...await captureResolutionEvidence(page, variant, "result", outputRoot));
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-result.png`) });
  await page.locator(".challenge-result-panel").getByRole("button", { name: "다시 도전하기", exact: true }).click();
  await page.locator(".challenge-screen").waitFor({ state: "visible", timeout: 20_000 });
  await waitUntil("AI-win replay stage input", () => page.locator("textarea.typing-input").isEnabled(), 20_000);
  const aiWinModal = page.locator(".challenge-modal");
  await aiWinModal.waitFor({ state: "visible", timeout: 90_000 });
  const aiWinImage = aiWinModal.locator(".challenge-modal-art");
  const aiWinSrc = decodeURIComponent(await aiWinImage.getAttribute("src") ?? "");
  assert.match(aiWinSrc, /금나래 승리\.png$/, `${variant} AI-win modal did not use approved Geumnarae victory asset`);
  resolutionEvidence.push(...await captureResolutionEvidence(page, variant, "ai-win-stage-1", outputRoot));
  await aiWinModal.getByRole("button", { name: "다시 도전하기", exact: true }).click();
  await waitUntil("AI-win loss record persisted", async () => {
    const value = await page.evaluate(async () => (window as any).typingKing.listRecords());
    return value?.data?.filter((candidate: any) => candidate.participant_name === participantName).length >= 2;
  }, 20_000);
  const listed = await page.evaluate(async () => (window as any).typingKing.listRecords());
  const row = listed?.data?.find((candidate: any) => candidate.participant_name === participantName && candidate.final_vs_ai_result === "USER_WIN");
  assert.ok(row?.record_id, `${variant} result record missing`);
  assert.deepEqual(assessCapturedStoredRow(capturedWin.input, row), [], `${variant} captured winning input does not match stored flat row`);
  const canonicalCaptureEvidence = {
    method: "CDP source-location breakpoint on actual packaged renderer window.typingKing.saveRecord argument",
    observationBoundary: "renderer SaveRecordInput before protected saveRecord IPC; not persisted canonical data",
    debuggerTimingIntervention: "Renderer paused for read-only argument serialization and immediately resumed in finally; elapsed pause is instrumented timing",
    ...capturedWin,
    canonicalValidationViolations: assessCapturedCanonicalInput(capturedWin.input),
    storedFlatRecordId: row.record_id,
    storedFlatCorrelationViolations: assessCapturedStoredRow(capturedWin.input, row),
    persistedRowHasCanonicalAttempt: row.canonicalAttempt != null,
    breakpointCleanupComplete: saveCapture.errors.length === 0
  };
  const repeated = await page.evaluate(async (input) => (window as any).typingKing.saveRecord(input), copyCapturedSyntheticInput(capturedWin.input));
  assert.equal(repeated?.ok, true, `${variant} repeat participant attempt save failed`);
  const beforeSeedIds: string[] = listed.data.map((candidate: RecordRow) => candidate.record_id);
  const repeatBeforeSeeds = listed.data.filter((candidate: RecordRow) => candidate.participant_name === participantName).length;
  const returnedSeedIds: Array<string | undefined> = [repeated?.data?.record_id];
  for (let index = 1; index <= 9; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const seeded = await page.evaluate(async (input) => (window as any).typingKing.saveRecord(input), copyCapturedSyntheticInput(capturedWin.input, {
      name: `${variant === "ai" ? "합성공식" : "합성연습"}${suffix}`,
      phone2: `${index}`.padStart(4, "0"),
      phone3: `${index + 100}`.padStart(4, "0")
    }));
    assert.equal(seeded?.ok, true, `${variant} synthetic participant ${suffix} save failed`);
    returnedSeedIds.push(seeded?.data?.record_id);
  }
  const repeatedRows = await page.evaluate(async () => (window as any).typingKing.listRecords());
  assert.equal(repeatedRows?.ok, true, `${variant} seeded record listing failed`);
  const repeatParticipantAttempts = repeatedRows.data.filter((candidate: any) => candidate.participant_name === participantName).length;
  const afterSeedIds: string[] = repeatedRows.data.map((candidate: RecordRow) => candidate.record_id);
  const seedViolations = assessSyntheticSeedEvidence({ beforeIds: beforeSeedIds, afterIds: afterSeedIds, returnedIds: returnedSeedIds, repeatBefore: repeatBeforeSeeds, repeatAfter: repeatParticipantAttempts });
  assert.deepEqual(seedViolations, [], `${variant} synthetic API saves did not create the expected new records`);
  const uniqueParticipantCount = new Set(repeatedRows.data.map((candidate: any) => candidate.participantKey)).size;
  assert.ok(repeatParticipantAttempts >= 2, `${variant} repeat participant attempts missing`);
  assert.ok(uniqueParticipantCount >= 10, `${variant} synthetic ten-participant fixture missing`);
  const syntheticSeedEvidence = {
    method: "Protected saveRecord IPC with copies of the full validated actual renderer SaveRecordInput",
    actualUiGames: { participantWins: 1, aiWinReplays: 1 },
    syntheticApiSeedRecords: afterSeedIds.length - beforeSeedIds.length,
    syntheticRepeatedParticipantRecords: repeatParticipantAttempts - repeatBeforeSeeds,
    syntheticAdditionalParticipants: new Set(repeatedRows.data.filter((candidate: RecordRow) => returnedSeedIds.includes(candidate.record_id) && candidate.participant_name !== participantName).map((candidate: RecordRow) => candidate.participantKey)).size,
    returnedRecordIdCount: returnedSeedIds.length,
    freshDistinctRecordIdCount: new Set(returnedSeedIds).size,
    returnedRecordIdsSha256: crypto.createHash("sha256").update([...returnedSeedIds].sort().join("\n")).digest("hex").toUpperCase(),
    validationViolations: seedViolations,
    copiedSourceInputSha256: capturedWin.inputSha256,
    preservedFields: "All captured gameplay fields, including game_mode, selections, fairness and canonicalAttempt; only additional participant identity changed",
    identityAssignment: "Protected saveRecord IPC assigns fresh record/attempt IDs and review storage computes participant keys",
    syntheticSeedsAreActualUiGames: false
  };
  return { recordId: row.record_id, participantName, searchNeedle, stageTexts, repeatParticipantAttempts, uniqueParticipantCount, resolutionEvidence, controlPauseEvidence, canonicalCaptureEvidence, syntheticSeedEvidence };
  } finally {
    await saveCapture.stop();
    assert.deepEqual(saveCapture.errors, [], `${variant} renderer capture or cleanup failed`);
  }
}

async function openLeaderboardAdmin(page: Page, focusScreenshot?: string): Promise<void> {
  await page.getByRole("button", { name: "관리자", exact: true }).click();
  await page.locator(".admin-modal").waitFor({ state: "visible" });
  const loginInputs = page.locator(".admin-login-grid input");
  await loginInputs.nth(0).waitFor({ state: "visible" });
  assert.equal(await loginInputs.count(), 2, "leaderboard admin must require UI reauthentication");
  await loginInputs.nth(0).fill("synthetic-review-admin");
  await loginInputs.nth(1).fill(REVIEW_LOCAL_ADMIN_PASSWORD);
  if (focusScreenshot) {
    await loginInputs.nth(0).focus();
    await page.screenshot({ path: focusScreenshot });
  }
  await page.getByRole("button", { name: "진입", exact: true }).click();
  await page.locator(".admin-toolbar").waitFor({ state: "visible", timeout: 10_000 });
}

async function closeLeaderboardAdmin(page: Page): Promise<void> {
  await page.locator(".admin-modal").getByRole("button", { name: "닫기", exact: true }).click();
  await page.locator(".admin-modal").waitFor({ state: "detached" });
  assert.equal(await page.locator(".modal-backdrop").count(), 0, "leaderboard is still obscured by the admin backdrop");
  assert.equal(await page.locator(".admin-toolbar").count(), 0, "closed admin controls must be removed");
}

async function leaderboardFlow(page: Page, expected: { recordId: string; participantName: string; searchNeedle: string; repeatParticipantAttempts: number }, forbiddenId: string, outputRoot: string, variant: Variant, reviewStorageRoot: string): Promise<{ refreshes: number; crossLeak: number; allRowCount: number; bestRowCount: number; repeatParticipantAttempts: number; reset: Record<string, number>; resolutionEvidence: Array<Record<string, unknown>>; searchEvidence: Record<string, unknown>; scrollEvidence: Record<string, unknown>; viewComparisonEvidence: Array<Record<string, unknown>> }> {
  const resolutionEvidence: Array<Record<string, unknown>> = [];
  const rankingBody = page.locator(".ai-ranking .ranking-body");
  const rankingRows = rankingBody.locator(".ranking-row");
  let rows: any[] = [];
  let refreshes = 0;
  while (refreshes < 2) {
    refreshes += 1;
    const result = await page.evaluate(async () => (window as any).typingKing.listRecords());
    assert.equal(result?.ok, true);
    rows = result.data;
    if (rows.some((row) => row.record_id === expected.recordId)) break;
    await page.getByRole("button", { name: "새로고침" }).click();
    await waitUntil("leaderboard refresh button enabled", () => page.getByRole("button", { name: "새로고침" }).isEnabled(), 10_000);
  }
  assert.ok(rows.some((row) => row.record_id === expected.recordId), `${variant} pair record not shared within two refreshes`);
  const crossLeak = rows.filter((row) => row.record_id === forbiddenId).length;
  assert.equal(crossLeak, 0, `${variant} cross namespace leak`);
  const initialLeaderboardEvidence = await captureResolutionEvidence(page, variant, "leaderboard-initial", outputRoot);
  for (const entry of initialLeaderboardEvidence) {
    const structure = entry.leaderboard as any;
    assert.ok(structure, `${variant} leaderboard structure missing`);
    assert.match(structure.backgroundImage, /stage_01_03_science_classroom\.png/);
    assert.match(decodeURIComponent(structure.titleSrc), /ai_타자왕_금나래의_도전\.png$/);
    assert.equal(structure.titleWithinContainer, true);
    assert.equal(structure.titleContainerWithinBoard, true);
    assert.ok(structure.titleCenterOffsetPx <= 2, `${variant} central title offset ${structure.titleCenterOffsetPx}`);
    assert.ok(structure.titleContainerCenterOffsetPx <= 2, `${variant} title container offset ${structure.titleContainerCenterOffsetPx}`);
  }
  resolutionEvidence.push(...initialLeaderboardEvidence);
  const recordIdsBeforeRejectedSave = rows.map((row) => row.record_id).sort();
  const rejectedSave = await page.evaluate(
    async (input) => (window as any).typingKing.saveRecord(input),
    LEADERBOARD_REJECTED_SAVE_INPUT
  );
  assert.equal(rejectedSave?.ok, false, `${variant} leaderboard record save was accepted`);
  const recordsAfterRejectedSave = await page.evaluate(async () => (window as any).typingKing.listRecords());
  assert.equal(recordsAfterRejectedSave?.ok, true);
  assert.deepEqual(
    recordsAfterRejectedSave.data.map((row: any) => row.record_id).sort(),
    recordIdsBeforeRejectedSave,
    `${variant} leaderboard rejected save changed record ids`
  );
  const search = page.locator(".search-input");
  await search.fill(expected.searchNeedle);
  await search.focus();
  const expectedSearchCount = rows.filter((candidate: RecordRow) => candidate.participant_name === expected.participantName).length;
  assert.equal(expectedSearchCount, expected.repeatParticipantAttempts, `${variant} shared fixture attempt count changed before search`);
  await waitUntil("all searched fixture attempts", () => rankingRows.count().then((count) => count === expectedSearchCount), 10_000);
  const searchedRows = await rankingRows.evaluateAll((elements) => elements.map((element) => {
    const cells = element.querySelectorAll(":scope > span");
    return { name: cells[1]?.textContent?.trim() ?? "", phone: cells[2]?.textContent?.trim() ?? "", text: (element as HTMLElement).innerText };
  }));
  const searchViolations = assessMaskedSearchEvidence({
    expectedCount: expectedSearchCount,
    expectedMaskedName: "합****증",
    phoneSuffix: expected.searchNeedle,
    rawParticipantNames: rows.map((candidate: RecordRow) => candidate.participant_name),
    rawPhoneNumbers: rows.map((candidate: RecordRow) => candidate.phone_full),
    rows: searchedRows
  });
  assert.deepEqual(searchViolations, [], `${variant} search rows violated fixture membership or masking`);
  const searchEvidence = { view: "all records", expectedAttemptCount: expectedSearchCount, observedRowCount: searchedRows.length, phoneSuffix: expected.searchNeedle, rows: searchedRows, violations: searchViolations };
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-search.png`) });
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-focus-search.png`) });
  await search.fill("");
  await openLeaderboardAdmin(page, path.join(outputRoot, "screenshots", `${variant}-focus-admin.png`));
  await page.getByRole("button", { name: "로컬 저장소 검증" }).click();
  const validationTuple = page.locator(".geumcheon-nas-status-panel .notice-text");
  await waitUntil("leaderboard visible completed storage tuple", () => validationTuple.innerText().then((text) => text.includes("정상")), 10_000);
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-admin-validation-complete.png`) });
  await page.getByRole("button", { name: "전체기록 보기" }).click();
  await waitUntil("all records mode selected", () => page.getByRole("button", { name: "전체기록 보기" }).getAttribute("aria-pressed").then((pressed) => pressed === "true"), 10_000);
  await closeLeaderboardAdmin(page);
  assert.equal(rows.length, 12, `${variant} complete shared fixture must contain twelve attempts`);
  const uniqueFixtureParticipants = new Set(rows.map((row: RecordRow) => row.participantKey)).size;
  assert.equal(uniqueFixtureParticipants, 10, `${variant} complete shared fixture must contain ten distinct participants`);
  await waitUntil("all records rows", () => rankingRows.count().then((count) => count === rows.length), 10_000);
  const allRowCount = await rankingRows.count();
  assert.ok(allRowCount >= 10, `${variant} all-record view must show at least ten synthetic participants/attempts`);
  assert.equal(allRowCount, 12);
  await rankingBody.evaluate((element) => { element.scrollTop = 0; });
  const allRecordsResolutionEvidence = await captureResolutionEvidence(page, variant, "leaderboard-all-records", outputRoot);
  assert.equal(allRecordsResolutionEvidence.length, 2);
  resolutionEvidence.push(...allRecordsResolutionEvidence);
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-all-records.png`) });
  await page.setViewportSize({ width: 1280, height: 720 });
  await waitUntil("leaderboard scroll viewport 1280x720", () => page.evaluate(() => window.innerWidth === 1280 && window.innerHeight === 720), 10_000);
  await rankingBody.evaluate((element) => { element.scrollTop = 0; });
  const scrollBefore = await page.evaluate(readLeaderboardTableObservation);
  let scrollAfter = scrollBefore;
  await waitUntil("leaderboard reaches bottom with last row visible", async () => {
    await rankingBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    scrollAfter = await page.evaluate(readLeaderboardTableObservation);
    assert.deepEqual(assessLeaderboardScrollEvidence({ before: scrollBefore, after: scrollAfter }), [], `${variant} scroll observation: ${JSON.stringify({ before: scrollBefore, after: scrollAfter })}`);
    return true;
  }, 10_000);
  const scrollScreenshot = path.join(outputRoot, "screenshots", `${variant}-all-records-scrolled.png`);
  await page.screenshot({ path: scrollScreenshot });
  const scrollEvidence = { selector: ".ai-ranking .ranking-body", requestedViewport: { width: 1280, height: 720 }, before: scrollBefore, after: scrollAfter, screenshot: scrollScreenshot };
  assert.deepEqual(assessLeaderboardScrollEvidence(scrollEvidence), []);
  await openLeaderboardAdmin(page);
  await page.getByRole("button", { name: "최고기록만 보기" }).click();
  await waitUntil("best records mode selected", () => page.getByRole("button", { name: "최고기록만 보기" }).getAttribute("aria-pressed").then((pressed) => pressed === "true"), 10_000);
  await closeLeaderboardAdmin(page);
  await waitUntil("best records reduce rows", () => rankingRows.count().then((count) => count === uniqueFixtureParticipants), 10_000);
  const bestRowCount = await rankingRows.count();
  assert.equal(bestRowCount, 10);
  assert.deepEqual(assessLeaderboardViewDifference({ allRowCount, bestRowCount, repeatParticipantAttempts: expected.repeatParticipantAttempts }), []);
  await rankingBody.evaluate((element) => { element.scrollTop = 0; });
  const bestRecordsResolutionEvidence = await captureResolutionEvidence(page, variant, "leaderboard-best-records", outputRoot);
  resolutionEvidence.push(...bestRecordsResolutionEvidence);
  assert.deepEqual(assessLeaderboardResolutionComparison({ allRowCount, bestRowCount, all: allRecordsResolutionEvidence, best: bestRecordsResolutionEvidence }), []);
  const viewComparisonEvidence = allRecordsResolutionEvidence.map((all, index) => ({
    requestedViewport: all.requestedViewport, expectedAllCount: rows.length, expectedBestCount: uniqueFixtureParticipants,
    all: { observation: all.leaderboardTable, screenshot: all.screenshot },
    best: { observation: bestRecordsResolutionEvidence[index].leaderboardTable, screenshot: bestRecordsResolutionEvidence[index].screenshot }
  }));
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-best-records.png`) });
  await openLeaderboardAdmin(page);
  const picker = page.locator(".admin-record-picker button").first();
  await picker.click();
  await page.locator(".edit-grid").waitFor({ state: "visible" });
  assert.match((await picker.getAttribute("class")) ?? "", /selected/);
  await picker.click();
  await page.locator(".edit-grid").waitFor({ state: "detached" });
  assert.doesNotMatch((await picker.getAttribute("class")) ?? "", /selected/);
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-admin.png`) });
  const rowsBefore = await rankingRows.count();
  const countSourceRecords = () => snapshotDirectory(reviewStorageRoot).filter((entry) => entry.includes("/records/") && /\.json:\d+:/.test(entry)).length;
  const sourceRecordsBefore = countSourceRecords();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "현재 회차 표시 초기화" }).click();
  await waitUntil("leaderboard visible reset", () => rankingRows.count().then((count) => count === 0), 10_000);
  await closeLeaderboardAdmin(page);
  const rowsAfter = await rankingRows.count();
  const sourceRecordsAfter = countSourceRecords();
  const reset = { rowsBefore, rowsAfter, sourceRecordsBefore, sourceRecordsAfter };
  assert.deepEqual(assessResetEvidence(reset), []);
  assert.deepEqual(assessLeaderboardTableCapture(0, await page.evaluate(readLeaderboardTableObservation)), []);
  await page.screenshot({ path: path.join(outputRoot, "screenshots", `${variant}-reset-complete.png`) });
  return { refreshes, crossLeak, allRowCount, bestRowCount, repeatParticipantAttempts: expected.repeatParticipantAttempts, reset, resolutionEvidence, searchEvidence, scrollEvidence, viewComparisonEvidence };
}

async function runOne(spec: typeof specs[number], exePath: string, outputRoot: string, localAppData: string, paired: Map<Session, { recordId: string; participantName: string; searchNeedle: string; stageTexts: string[]; repeatParticipantAttempts: number }>, initializedVariants: Set<Variant>, simultaneouslyReady: Set<Variant>, failedPlayerSessions: Set<Session>): Promise<any> {
  const port = await reservePort();
  const runtimeDirectories = concurrentRuntimeDirectories(outputRoot, spec.variant);
  assert.equal(runtimeDirectories.LOCALAPPDATA, localAppData);
  fs.mkdirSync(runtimeDirectories.APPDATA, { recursive: true });
  fs.mkdirSync(runtimeDirectories.TEMP, { recursive: true });
  const env = sanitizedEnvironment(runtimeDirectories);
  const userDataDir = path.join(outputRoot, "runtime", "UserData", spec.variant);
  fs.mkdirSync(userDataDir, { recursive: true });
  const pid = launchViaShellExecute(exePath, path.dirname(exePath), port, userDataDir, env);
  let browser: Browser | undefined;
  let page: Page | undefined;
  let error: string | undefined;
  let cleanExit = false;
  let forcedCleanup = false;
  let flow: any;
  let bootstrap: any;
  let storageValidation: any;
  let externalStorageBoundary: any;
  let playerWindowLayout: PlayerWindowLayoutObservation | null = null;
  let processes: ProcessInfo[] = [];
  let finalProcessSnapshot: ProcessInfo[] | null = null;
  const processObservationErrors: string[] = [];
  try {
    let ws: string | undefined;
    await waitUntil("portable CDP endpoint", async () => Boolean(ws = await readCdp(port)), 90_000);
    browser = await chromium.connectOverCDP(ws!);
    await waitUntil("packaged renderer page", () => browser!.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url().startsWith("file:")), 45_000);
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("file:"))!;
    await page.locator(spec.selector).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.title(), spec.title);
    if (spec.role === "player") {
      playerWindowLayout = await observePlayerWindowLayout(page);
      assert.deepEqual(
        assessPlayerWindowLayout(playerWindowLayout),
        [],
        `${spec.variant} packaged player window/layout contract failed`
      );
    }
    const bootstrapResult = await page.evaluate(async () => (window as any).typingKing.getBootstrap());
    assert.equal(bootstrapResult?.ok, true);
    bootstrap = bootstrapResult.data;
    const auth = await page.evaluate(async (password) => (window as any).typingKing.validateAdmin(password, "synthetic-review-admin"), REVIEW_LOCAL_ADMIN_PASSWORD);
    assert.equal(auth?.ok, true);
    storageValidation = await page.evaluate(async () => (window as any).typingKing.validateReviewStorage());
    assert.deepEqual(
      assessReviewStorageValidation(storageValidation, { role: spec.role, session: spec.session }),
      [],
      `${spec.variant} review storage validation tuple failed`
    );
    const reviewStorageRoot = path.join(
      localAppData,
      "ThePMD",
      "TypingKing",
      "Geumcheon2026",
      "Review",
      spec.session
    );
    externalStorageBoundary = await observeInitializedReviewStorageBoundary({
      variant: spec.variant,
      initializedVariants,
      snapshot: () => snapshotDirectory(reviewStorageRoot),
      observe: () => observeExternalStorageBoundary(page!)
    });
    assert.deepEqual(assessReviewExternalStorageBoundary(externalStorageBoundary.observations), []);
    assert.equal(externalStorageBoundary.storageUnchanged, true, `${spec.variant} external-storage call changed review files`);
    const notices = Array.isArray(bootstrap.notices) ? bootstrap.notices : [];
    assert.equal(notices.includes(FALLBACK_NOTICE), false, `${spec.variant} used fallback stage texts`);
    processes = processTree(pid);
    const helperNames = processes.map((entry) => entry.Name).filter((name) => /^(?:node|cmd|powershell|pwsh|wscript|cscript)\.exe$/i.test(name));
    const titled = processes.filter((entry) => entry.MainWindowTitle?.trim());
    const credentialPopupCount = titled.filter((entry) => /credential|자격 증명|접속정보/i.test(entry.MainWindowTitle!)).length;
    const commandWindowCount = titled.filter((entry) => /^(?:cmd|powershell|pwsh)\.exe$/i.test(entry.Name)).length;
    simultaneouslyReady.add(spec.variant);
    await waitUntil("all four portable variants ready concurrently", () => simultaneouslyReady.size === specs.length, 90_000);
    if (spec.role === "player") {
      flow = await playerFlow(page, spec.variant, outputRoot);
      paired.set(spec.session, flow);
    } else {
      await waitUntil(`${spec.session} player completion`, () => paired.has(spec.session) || failedPlayerSessions.has(spec.session), 120_000);
      assert.ok(paired.has(spec.session), `${spec.session} player flow failed before record sharing`);
      const otherSession = spec.session === "official" ? "practice" : "official";
      await waitUntil("opposite-session player completion", () => paired.has(otherSession) || failedPlayerSessions.has(otherSession), 120_000);
      assert.ok(paired.has(otherSession), `${otherSession} player flow failed before isolation check`);
      const expected = paired.get(spec.session)!;
      const other = paired.get(spec.session === "official" ? "practice" : "official")!;
      flow = await leaderboardFlow(page, expected, other.recordId, outputRoot, spec.variant, reviewStorageRoot);
    }
    const runtimeViolations = assessRuntimeObservation({ expectedVariant: spec.variant, expectedRole: spec.role, expectedSession: spec.session, bootstrap, notices, observedHelperProcesses: helperNames, credentialPopupCount, commandWindowCount });
    assert.deepEqual(runtimeViolations, []);
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    if (spec.role === "player") failedPlayerSessions.add(spec.session);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputRoot, "screenshots", `${spec.variant}-failure.png`) }).catch(() => undefined);
  } finally {
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => undefined);
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    const observeExit = () => {
      try {
        finalProcessSnapshot = processTree(pid);
        return finalProcessSnapshot.length === 0;
      } catch (caught) {
        finalProcessSnapshot = null;
        const message = caught instanceof Error ? caught.message : String(caught);
        if (!processObservationErrors.includes(message)) processObservationErrors.push(message);
        throw caught;
      }
    };
    await waitUntil("portable process tree exit", observeExit, 8_000).catch(() => undefined);
    // Unknown or reused process identity cannot authorize a PID-based forced cleanup.
    if (finalProcessSnapshot != null && (finalProcessSnapshot as ProcessInfo[]).length > 0 && processObservationErrors.length === 0) {
      forcedCleanup = true;
      const killed = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
      if (killed.error || killed.status !== 0) processObservationErrors.push(`PROCESS_CLEANUP_FAILED:${killed.error?.message ?? killed.stderr}`);
      await waitUntil("forced portable process tree exit", observeExit, 10_000).catch(() => undefined);
    }
    cleanExit = !forcedCleanup && finalProcessSnapshot != null && (finalProcessSnapshot as ProcessInfo[]).length === 0 && processObservationErrors.length === 0;
  }
  const residualProcessCount = finalProcessSnapshot == null ? null : (finalProcessSnapshot as ProcessInfo[]).length;
  if (processObservationErrors.length) error = [error, ...processObservationErrors].filter(Boolean).join("\n");
  const listing = fs.readdirSync(path.dirname(exePath)).sort();
  const unexpectedFiles = listing.filter((name) => name !== path.basename(exePath));
  const finalViolations = assessRuntimeObservation({ expectedVariant: spec.variant, expectedRole: spec.role, expectedSession: spec.session, bootstrap, notices: bootstrap?.notices, cleanExit, residualProcessCount, unexpectedFiles });
  if (finalViolations.length && !error) error = finalViolations.join(",");
  return { variant: spec.variant, role: spec.role, session: spec.session, pid, title: spec.title, bootstrap: bootstrap ? { variant: bootstrap.variant, reviewContext: bootstrap.reviewContext, notices: bootstrap.notices } : null, storageValidation: storageValidation?.data ?? null, playerWindowLayout, externalStorageBoundary, processSnapshot: processes, processObservation: { method: "Toolhelp32Snapshot + Get-Process", commandLineCollected: false, timeoutMs: 10_000, errors: processObservationErrors, finalSnapshot: finalProcessSnapshot }, flow, cleanExit, forcedCleanup, residualProcessCount, executableFolderListing: listing, error, verdict: error ? "FAIL" : "PASS" };
}

function parseArgs(argv: string[]): { outputRoot: string; inputs: Map<Variant, string> } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) throw new Error("Usage: --output <dir> --ai <exe> --ai-leaderboard <exe> --practice <exe> --practice-leaderboard <exe>");
    values.set(argv[index], argv[index + 1]);
  }
  const output = values.get("--output");
  if (!output) throw new Error("Missing --output");
  const inputs = new Map<Variant, string>();
  for (const spec of specs) {
    const value = values.get(spec.arg);
    if (!value) throw new Error(`Missing ${spec.arg}`);
    inputs.set(spec.variant, path.resolve(value));
  }
  return { outputRoot: path.resolve(output), inputs };
}

async function main(): Promise<void> {
  const { outputRoot, inputs } = parseArgs(process.argv.slice(2));
  const allowedRoot = path.resolve("test_artifacts") + path.sep;
  if (!outputRoot.startsWith(allowedRoot)) throw new Error(`Output must be under ${allowedRoot}`);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(outputRoot, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "runtime", "LocalAppData"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "runtime", "AppData"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "runtime", "Temp"), { recursive: true });
  const staged: ArtifactInput[] = [];
  for (const spec of specs) {
    const dir = path.join(outputRoot, "isolated", spec.variant);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, spec.fileName);
    fs.copyFileSync(inputs.get(spec.variant)!, target);
    staged.push({ variant: spec.variant, exePath: target });
  }
  const preflight = inspectReviewArtifacts(staged);
  assert.deepEqual(preflight.violations, [], preflight.violations.join("\n"));
  const paired = new Map<Session, { recordId: string; participantName: string; searchNeedle: string; stageTexts: string[]; repeatParticipantAttempts: number }>();
  const initializedVariants = new Set<Variant>();
  const simultaneouslyReady = new Set<Variant>();
  const failedPlayerSessions = new Set<Session>();
  const results = await Promise.all(specs.map((spec) => runOne(
    spec,
    staged.find((item) => item.variant === spec.variant)!.exePath,
    outputRoot,
    path.join(outputRoot, "runtime", "LocalAppData"),
    paired,
    initializedVariants,
    simultaneouslyReady,
    failedPlayerSessions
  )));
  const stageSourceHash = sha256(path.resolve("events/geumcheon-2026/stage_texts.csv"));
  const stageSeeds = (["official", "practice"] as const).map((session) => {
    const target = path.join(outputRoot, "runtime", "LocalAppData", "ThePMD", "TypingKing", "Geumcheon2026", "Review", session, "data", "stage_texts.csv");
    const matchingRuns = results.filter((entry) => entry.session === session);
    const playerRun = matchingRuns.find((entry) => entry.role === "player");
    const evidence = assessStageSeedEvidence({
      exists: fs.existsSync(target),
      notices: matchingRuns.flatMap((entry) => entry.bootstrap?.notices ?? []),
      drawnStageTexts: playerRun?.flow?.stageTexts ?? []
    });
    return {
      session,
      path: target,
      exists: fs.existsSync(target),
      canonicalSourceSha256: stageSourceHash,
      postInitializationSha256: fs.existsSync(target) ? sha256(target) : null,
      ...evidence
    };
  });
  const crossLeakCount = results.filter((entry) => entry.role === "leaderboard").reduce((sum, entry) => sum + (entry.flow?.crossLeak ?? 0), 0);
  const concurrentEvidence = {
    initializedVariants: [...initializedVariants].sort(),
    simultaneouslyReadyVariants: [...simultaneouslyReady].sort(),
    officialRefreshes: results.find((entry) => entry.variant === "ai-leaderboard")?.flow?.refreshes ?? 0,
    practiceRefreshes: results.find((entry) => entry.variant === "practice-leaderboard")?.flow?.refreshes ?? 0,
    crossLeakCount,
    residualProcessCount: results.some((entry) => entry.residualProcessCount == null) ? null : results.reduce((sum, entry) => sum + entry.residualProcessCount, 0)
  };
  const concurrentViolations = assessConcurrentEvidence(concurrentEvidence);
  const standaloneViolations = assessStandaloneReviewVerdict({ concurrentViolations, results, stageSeeds });
  const summary = { schemaVersion: 2, generatedAt: new Date().toISOString(), launch: reviewHarnessLaunchEvidence(), actualNasUsed: false, operationalCredentialsUsed: false, offlineSingleExeTest: "HOLD", hostInstrumentedStandaloneExe4: standaloneViolations.length ? "HOLD" : "PASS", standaloneExe4: "HOLD", offlineReason: "No proven network-disabled Windows Sandbox or VM was available on this host. This instrumented run does not test ordinary no-argument/default-directory startup; see separate ordinary lifecycle evidence.", preflight, stageSeeds, concurrentEvidence, concurrentViolations, standaloneViolations, results, officialRecordShare: results.find((entry) => entry.variant === "ai-leaderboard")?.verdict === "PASS" ? "PASS" : "HOLD", practiceRecordShare: results.find((entry) => entry.variant === "practice-leaderboard")?.verdict === "PASS" ? "PASS" : "HOLD", crossLeakCount, passed: results.filter((entry) => entry.verdict === "PASS").length, failed: results.filter((entry) => entry.verdict === "FAIL").length };
  fs.writeFileSync(path.join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ outputRoot, passed: summary.passed, failed: summary.failed, offlineSingleExeTest: summary.offlineSingleExeTest }, null, 2));
  if (standaloneViolations.length) process.exitCode = 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
