import type {
  CanonicalAiAttemptEvidenceV1,
  CanonicalAiAttemptV1,
  CanonicalAiContradictionCode,
  CanonicalAiStageEvidenceV1,
  CanonicalAiStageState
} from "../types";

export type CanonicalAiExpectedIdentity = Partial<
  Pick<CanonicalAiAttemptV1, "attemptId" | "recordId" | "deviceId">
>;

type AttemptWithoutCodes = Omit<CanonicalAiAttemptV1, "contradictionCodes">;

const CONTRADICTION_CODES: readonly CanonicalAiContradictionCode[] = [
  "METRIC_NON_FINITE",
  "METRIC_NEGATIVE",
  "PROGRESS_OUT_OF_RANGE",
  "ASSIGNED_UNITS_INVALID",
  "CPM_UNDEFINED",
  "TOTALS_MISMATCH",
  "STAGE_PROGRESS_CONTRADICTION",
  "RESULT_PROGRESS_CONTRADICTION",
  "RESULT_TIMING_CONTRADICTION",
  "INTERRUPTION_REASON_MISMATCH",
  "IDENTITY_MISMATCH"
];

function sumEntered(
  stages: readonly CanonicalAiStageEvidenceV1[],
  field: keyof CanonicalAiStageEvidenceV1
): number {
  return stages
    .filter((stage) => stage.entered)
    .reduce((total, stage) => total + Number(stage[field]), 0);
}

function sumAssignedInputUnits(stages: readonly CanonicalAiStageEvidenceV1[]): number {
  return stages.reduce((total, stage) => total + stage.assignedInputUnits, 0);
}

function rawPercent(completedUnits: number, assignedUnits: number): number {
  return assignedUnits > 0 ? completedUnits / assignedUnits * 100 : 0;
}

function rawCpm(validUnits: number, activeTypingTimeMs: number): number {
  return activeTypingTimeMs > 0 ? validUnits * 60_000 / activeTypingTimeMs : 0;
}

export function resolveCanonicalAiStageBoundary(
  stages: readonly CanonicalAiStageEvidenceV1[]
): { stageReached: 1 | 2 | 3; stageState: CanonicalAiStageState } {
  const entered = stages
    .filter((stage) => stage.entered)
    .sort((left, right) => left.stageNumber - right.stageNumber);
  const current = entered.at(-1);
  if (!current) return { stageReached: 1, stageState: "IN_PROGRESS" };
  return {
    stageReached: current.stageNumber,
    stageState: current.assignedInputUnits > 0 &&
      current.participantCorrectInputUnits >= current.assignedInputUnits
      ? "COMPLETED"
      : "IN_PROGRESS"
  };
}

function isParticipantCompleted(
  stages: readonly CanonicalAiStageEvidenceV1[],
): boolean {
  const stage3 = stages.find((stage) => stage.stageNumber === 3);
  return Boolean(stage3?.entered) && stages.length > 0 && stages.every((stage) =>
    stage.entered &&
    stage.assignedInputUnits > 0 &&
    stage.participantCorrectInputUnits >= stage.assignedInputUnits
  );
}

function isGeumnaraeCompleted(stages: readonly CanonicalAiStageEvidenceV1[]): boolean {
  const terminal = stages
    .filter((stage) => stage.entered)
    .sort((left, right) => left.stageNumber - right.stageNumber)
    .at(-1);
  return Boolean(
    terminal &&
    terminal.assignedInputUnits > 0 &&
    terminal.geumnaraeCorrectInputUnits >= terminal.assignedInputUnits
  );
}

export function buildCanonicalAiAttempt(
  evidence: CanonicalAiAttemptEvidenceV1
): CanonicalAiAttemptV1 {
  const stages = evidence.stages.map((stage) => ({ ...stage }));
  const assignedInputUnits = sumAssignedInputUnits(stages);
  const participantCorrectInputUnits = sumEntered(stages, "participantCorrectInputUnits");
  const participantValidInputUnits = sumEntered(stages, "participantValidInputUnits");
  const participantActiveTypingTimeMs = sumEntered(stages, "participantActiveTypingTimeMs");
  const geumnaraeCorrectInputUnits = sumEntered(stages, "geumnaraeCorrectInputUnits");
  const geumnaraeValidInputUnits = sumEntered(stages, "geumnaraeValidInputUnits");
  const geumnaraeActiveTypingTimeMs = sumEntered(stages, "geumnaraeActiveTypingTimeMs");
  const attempt: AttemptWithoutCodes = {
    ...evidence,
    stages,
    ...resolveCanonicalAiStageBoundary(stages),
    assignedInputUnits,
    participantCorrectInputUnits,
    participantValidInputUnits,
    participantActiveTypingTimeMs,
    geumnaraeCorrectInputUnits,
    geumnaraeValidInputUnits,
    geumnaraeActiveTypingTimeMs,
    wholeGameProgressRaw: rawPercent(participantCorrectInputUnits, assignedInputUnits),
    participantAverageCpmRaw: rawCpm(
      participantValidInputUnits,
      participantActiveTypingTimeMs
    ),
    geumnaraeProgressRaw: rawPercent(geumnaraeCorrectInputUnits, assignedInputUnits),
    geumnaraeAverageCpmRaw: rawCpm(
      geumnaraeValidInputUnits,
      geumnaraeActiveTypingTimeMs
    ),
    totalActiveDuelTimeMs: sumEntered(stages, "activeDuelTimeMs"),
    participantCompleted: isParticipantCompleted(stages),
    geumnaraeCompleted: isGeumnaraeCompleted(stages)
  };
  return {
    ...attempt,
    contradictionCodes: canonicalAiContradictionCodes(attempt)
  };
}

function differs(left: number, right: number): boolean {
  return !Number.isFinite(left) || !Number.isFinite(right) || left !== right;
}

export function canonicalAiContradictionCodes(
  attempt: AttemptWithoutCodes | CanonicalAiAttemptV1,
  expectedIdentity: CanonicalAiExpectedIdentity = {}
): CanonicalAiContradictionCode[] {
  const codes = new Set<CanonicalAiContradictionCode>();
  const stages = attempt.stages;
  const numericEvidence = stages.flatMap((stage) => [
    stage.assignedInputUnits,
    stage.participantCorrectInputUnits,
    stage.participantValidInputUnits,
    stage.participantActiveTypingTimeMs,
    stage.geumnaraeCorrectInputUnits,
    stage.geumnaraeValidInputUnits,
    stage.geumnaraeActiveTypingTimeMs,
    stage.activeDuelTimeMs
  ]);
  const metrics = [
    attempt.wholeGameProgressRaw,
    attempt.participantAverageCpmRaw,
    attempt.geumnaraeProgressRaw,
    attempt.geumnaraeAverageCpmRaw,
    attempt.totalActiveDuelTimeMs
  ];
  const optionalTimes = [attempt.participantFinishTimeMs, attempt.geumnaraeFinishTimeMs]
    .filter((value): value is number => value !== null);

  if ([...numericEvidence, ...metrics, ...optionalTimes].some((value) => !Number.isFinite(value))) {
    codes.add("METRIC_NON_FINITE");
  }
  if ([...numericEvidence, ...metrics, ...optionalTimes].some((value) => value < 0)) {
    codes.add("METRIC_NEGATIVE");
  }
  if (stages.length === 0 || stages.some((stage) =>
    !Number.isInteger(stage.assignedInputUnits) ||
    (stage.entered ? stage.assignedInputUnits <= 0 : stage.assignedInputUnits < 0)
  )) {
    codes.add("ASSIGNED_UNITS_INVALID");
  }
  if (stages.some((stage) =>
    stage.participantCorrectInputUnits > stage.assignedInputUnits ||
    stage.geumnaraeCorrectInputUnits > stage.assignedInputUnits
  ) || [attempt.wholeGameProgressRaw, attempt.geumnaraeProgressRaw]
    .some((value) => value < 0 || value > 100)) {
    codes.add("PROGRESS_OUT_OF_RANGE");
  }
  if (stages.some((stage) =>
    (stage.participantValidInputUnits > 0 && stage.participantActiveTypingTimeMs <= 0) ||
    (stage.geumnaraeValidInputUnits > 0 && stage.geumnaraeActiveTypingTimeMs <= 0)
  )) {
    codes.add("CPM_UNDEFINED");
  }

  const assignedInputUnits = sumAssignedInputUnits(stages);
  const participantCorrectInputUnits = sumEntered(stages, "participantCorrectInputUnits");
  const participantValidInputUnits = sumEntered(stages, "participantValidInputUnits");
  const participantActiveTypingTimeMs = sumEntered(stages, "participantActiveTypingTimeMs");
  const geumnaraeCorrectInputUnits = sumEntered(stages, "geumnaraeCorrectInputUnits");
  const geumnaraeValidInputUnits = sumEntered(stages, "geumnaraeValidInputUnits");
  const geumnaraeActiveTypingTimeMs = sumEntered(stages, "geumnaraeActiveTypingTimeMs");
  if (
    differs(attempt.assignedInputUnits, assignedInputUnits) ||
    differs(attempt.participantCorrectInputUnits, participantCorrectInputUnits) ||
    differs(attempt.participantValidInputUnits, participantValidInputUnits) ||
    differs(attempt.participantActiveTypingTimeMs, participantActiveTypingTimeMs) ||
    differs(attempt.geumnaraeCorrectInputUnits, geumnaraeCorrectInputUnits) ||
    differs(attempt.geumnaraeValidInputUnits, geumnaraeValidInputUnits) ||
    differs(attempt.geumnaraeActiveTypingTimeMs, geumnaraeActiveTypingTimeMs) ||
    differs(attempt.totalActiveDuelTimeMs, sumEntered(stages, "activeDuelTimeMs")) ||
    differs(attempt.wholeGameProgressRaw, rawPercent(participantCorrectInputUnits, assignedInputUnits)) ||
    differs(attempt.participantAverageCpmRaw, rawCpm(participantValidInputUnits, participantActiveTypingTimeMs)) ||
    differs(attempt.geumnaraeProgressRaw, rawPercent(geumnaraeCorrectInputUnits, assignedInputUnits)) ||
    differs(attempt.geumnaraeAverageCpmRaw, rawCpm(geumnaraeValidInputUnits, geumnaraeActiveTypingTimeMs))
  ) {
    codes.add("TOTALS_MISMATCH");
  }

  const boundary = resolveCanonicalAiStageBoundary(stages);
  const enteredNumbers = stages
    .filter((stage) => stage.entered)
    .map((stage) => stage.stageNumber)
    .sort((left, right) => left - right);
  const expectedEntered = Array.from(
    { length: Math.max(0, boundary.stageReached) },
    (_, index) => index + 1
  );
  const participantCompleted = isParticipantCompleted(stages);
  const geumnaraeCompleted = isGeumnaraeCompleted(stages);
  if (
    stages.length !== 3 ||
    new Set(stages.map((stage) => stage.stageNumber)).size !== stages.length ||
    enteredNumbers.length !== expectedEntered.length ||
    enteredNumbers.some((value, index) => value !== expectedEntered[index]) ||
    stages.some((stage) => !stage.entered && [
      stage.participantCorrectInputUnits,
      stage.participantValidInputUnits,
      stage.participantActiveTypingTimeMs,
      stage.geumnaraeCorrectInputUnits,
      stage.geumnaraeValidInputUnits,
      stage.geumnaraeActiveTypingTimeMs,
      stage.activeDuelTimeMs
    ].some((value) => value !== 0)) ||
    attempt.stageReached !== boundary.stageReached ||
    attempt.stageState !== boundary.stageState ||
    attempt.participantCompleted !== participantCompleted ||
    attempt.geumnaraeCompleted !== geumnaraeCompleted ||
    (attempt.wholeGameProgressRaw === 100 &&
      (attempt.stageReached !== 3 || attempt.stageState !== "COMPLETED"))
  ) {
    codes.add("STAGE_PROGRESS_CONTRADICTION");
  }

  if (
    (attempt.result === "PARTICIPANT_WIN" && !participantCompleted) ||
    (attempt.result === "GEUMNARAE_WIN" && !geumnaraeCompleted)
  ) {
    codes.add("RESULT_PROGRESS_CONTRADICTION");
  }
  if (
    (participantCompleted && attempt.participantFinishTimeMs === null) ||
    (!participantCompleted && attempt.participantFinishTimeMs !== null) ||
    (geumnaraeCompleted && attempt.geumnaraeFinishTimeMs === null) ||
    (!geumnaraeCompleted && attempt.geumnaraeFinishTimeMs !== null) ||
    (attempt.result === "PARTICIPANT_WIN" && geumnaraeCompleted &&
      attempt.participantFinishTimeMs !== null && attempt.geumnaraeFinishTimeMs !== null &&
      attempt.participantFinishTimeMs > attempt.geumnaraeFinishTimeMs) ||
    (attempt.result === "GEUMNARAE_WIN" && participantCompleted &&
      attempt.participantFinishTimeMs !== null && attempt.geumnaraeFinishTimeMs !== null &&
      attempt.participantFinishTimeMs <= attempt.geumnaraeFinishTimeMs)
  ) {
    codes.add("RESULT_TIMING_CONTRADICTION");
  }
  if (
    (attempt.result === "INTERRUPTED" && attempt.interruptionReason === null) ||
    (attempt.result !== "INTERRUPTED" && attempt.interruptionReason !== null)
  ) {
    codes.add("INTERRUPTION_REASON_MISMATCH");
  }
  if (
    !attempt.attemptId || !attempt.recordId || !attempt.deviceId ||
    (expectedIdentity.attemptId !== undefined && expectedIdentity.attemptId !== attempt.attemptId) ||
    (expectedIdentity.recordId !== undefined && expectedIdentity.recordId !== attempt.recordId) ||
    (expectedIdentity.deviceId !== undefined && expectedIdentity.deviceId !== attempt.deviceId)
  ) {
    codes.add("IDENTITY_MISMATCH");
  }
  return [...codes];
}

export function isCanonicalAiAttemptPubliclyRankable(
  attempt: CanonicalAiAttemptV1,
  expectedIdentity: CanonicalAiExpectedIdentity = {}
): boolean {
  return canonicalAiContradictionCodes(attempt, expectedIdentity).length === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStageEvidence(value: unknown): value is CanonicalAiStageEvidenceV1 {
  if (!isObject(value) || !hasExactKeys(value, [
    "stageNumber",
    "entered",
    "assignedInputUnits",
    "participantCorrectInputUnits",
    "participantValidInputUnits",
    "participantActiveTypingTimeMs",
    "geumnaraeCorrectInputUnits",
    "geumnaraeValidInputUnits",
    "geumnaraeActiveTypingTimeMs",
    "activeDuelTimeMs"
  ])) return false;
  return [1, 2, 3].includes(value.stageNumber as number) &&
    typeof value.entered === "boolean" &&
    [
      value.assignedInputUnits,
      value.participantCorrectInputUnits,
      value.participantValidInputUnits,
      value.participantActiveTypingTimeMs,
      value.geumnaraeCorrectInputUnits,
      value.geumnaraeValidInputUnits,
      value.geumnaraeActiveTypingTimeMs,
      value.activeDuelTimeMs
    ].every((number) => isFiniteNumber(number) && Number.isInteger(number));
}

export function isCanonicalAiAttemptV1(value: unknown): value is CanonicalAiAttemptV1 {
  if (!isObject(value) || !hasExactKeys(value, [
    "schemaVersion",
    "attemptId",
    "recordId",
    "deviceId",
    "recordedAt",
    "result",
    "interruptionReason",
    "participantFinishTimeMs",
    "geumnaraeFinishTimeMs",
    "stages",
    "stageReached",
    "stageState",
    "wholeGameProgressRaw",
    "participantAverageCpmRaw",
    "geumnaraeProgressRaw",
    "geumnaraeAverageCpmRaw",
    "totalActiveDuelTimeMs",
    "assignedInputUnits",
    "participantCorrectInputUnits",
    "participantValidInputUnits",
    "participantActiveTypingTimeMs",
    "geumnaraeCorrectInputUnits",
    "geumnaraeValidInputUnits",
    "geumnaraeActiveTypingTimeMs",
    "participantCompleted",
    "geumnaraeCompleted",
    "contradictionCodes"
  ])) return false;
  const integerFields = [
    value.totalActiveDuelTimeMs,
    value.assignedInputUnits,
    value.participantCorrectInputUnits,
    value.participantValidInputUnits,
    value.participantActiveTypingTimeMs,
    value.geumnaraeCorrectInputUnits,
    value.geumnaraeValidInputUnits,
    value.geumnaraeActiveTypingTimeMs
  ];
  return value.schemaVersion === 1 &&
    typeof value.attemptId === "string" &&
    typeof value.recordId === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.recordedAt === "string" &&
    ["PARTICIPANT_WIN", "GEUMNARAE_WIN", "INTERRUPTED"].includes(value.result as string) &&
    (value.interruptionReason === null ||
      ["HOME", "RETRY", "EXIT"].includes(value.interruptionReason as string)) &&
    (value.participantFinishTimeMs === null || isFiniteNumber(value.participantFinishTimeMs)) &&
    (value.geumnaraeFinishTimeMs === null || isFiniteNumber(value.geumnaraeFinishTimeMs)) &&
    Array.isArray(value.stages) && value.stages.every(isStageEvidence) &&
    [1, 2, 3].includes(value.stageReached as number) &&
    ["IN_PROGRESS", "COMPLETED"].includes(value.stageState as string) &&
    [
      value.wholeGameProgressRaw,
      value.participantAverageCpmRaw,
      value.geumnaraeProgressRaw,
      value.geumnaraeAverageCpmRaw
    ].every(isFiniteNumber) &&
    integerFields.every((number) => isFiniteNumber(number) && Number.isInteger(number)) &&
    typeof value.participantCompleted === "boolean" &&
    typeof value.geumnaraeCompleted === "boolean" &&
    Array.isArray(value.contradictionCodes) &&
    value.contradictionCodes.every((code) =>
      CONTRADICTION_CODES.includes(code as CanonicalAiContradictionCode)
    );
}
