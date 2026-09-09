import type { GeumcheonRecordEvidenceV1, RecordRow } from "../types";
import { isCanonicalAiAttemptV1 } from "./geumcheonAiAttempt";

const BATTLE_KEYS = [
  "stage", "text", "userTimeMs", "userCpm", "userAccuracy", "aiTimeMs",
  "aiElapsedMs", "aiCpm", "plannedAiCpm", "aiTypedUnits", "aiTypedChars", "result", "userInput"
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Structural evidence validation; cross-field semantics remain the server's responsibility. */
export function isGeumcheonRecordEvidenceV1(value: unknown): value is GeumcheonRecordEvidenceV1 {
  if (!object(value) || Object.keys(value).sort().join(",") !== "battles,canonicalAttempt,schemaVersion" ||
    value.schemaVersion !== 1 || !isCanonicalAiAttemptV1(value.canonicalAttempt) ||
    !Array.isArray(value.battles) || value.battles.length < 1 || value.battles.length > 3) return false;
  return value.battles.every((battle, index) => {
    if (!object(battle) || BATTLE_KEYS.some((key) => !Object.hasOwn(battle, key)) ||
      Object.keys(battle).some((key) => key !== "entered" && !BATTLE_KEYS.includes(key as typeof BATTLE_KEYS[number])) ||
      (Object.hasOwn(battle, "entered") && typeof battle.entered !== "boolean") ||
      battle.stage !== index + 1 || typeof battle.text !== "string" || typeof battle.userInput !== "string" ||
      (battle.result !== "USER_WIN" && battle.result !== "AI_WIN")) return false;
    const numbers = [battle.userTimeMs, battle.userCpm, battle.userAccuracy, battle.aiTimeMs,
      battle.aiElapsedMs, battle.aiCpm, battle.plannedAiCpm, battle.aiTypedUnits, battle.aiTypedChars];
    return numbers.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0) &&
      Number.isSafeInteger(battle.userTimeMs) && Number.isSafeInteger(battle.aiTypedChars) &&
      Number.isSafeInteger(battle.plannedAiCpm) && Number(battle.plannedAiCpm) > 0 && Number(battle.userAccuracy) <= 100;
  });
}

/** Keep the existing public columns and ranking source; raw evidence remains in protected storage. */
export function toGeumcheonPublicRecordRow(row: RecordRow): RecordRow {
  const { recordEvidence: _protectedEvidence, ...publicRow } = row;
  return publicRow;
}

/** Capture source values without rounding, recomputing, or retaining live aliases. */
export function cloneGeumcheonRecordEvidence(
  evidence: GeumcheonRecordEvidenceV1,
): GeumcheonRecordEvidenceV1 {
  return Object.freeze({
    schemaVersion: evidence.schemaVersion,
    canonicalAttempt: Object.freeze({
      ...evidence.canonicalAttempt,
      stages: Object.freeze(evidence.canonicalAttempt.stages.map((stage) => Object.freeze({ ...stage }))),
      contradictionCodes: Object.freeze([...evidence.canonicalAttempt.contradictionCodes]),
    }),
    battles: Object.freeze(evidence.battles.map((battle) => Object.freeze({ ...battle }))),
  });
}
