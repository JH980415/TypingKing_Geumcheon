import type { CanonicalAiAttemptV1, RecordRow } from "../types";

export type CanonicalAiRankKey = readonly [number, number];

export type CanonicalAiRankable = Pick<
  CanonicalAiAttemptV1,
  | "participantAverageCpmRaw"
  | "recordedAt"
  | "recordId"
  | "result"
  | "contradictionCodes"
>;

export type CanonicalAiRanked<T extends CanonicalAiRankable> = {
  rank: number;
  record: T;
};

export function canonicalAiRankKey(record: CanonicalAiRankable): CanonicalAiRankKey {
  return [
    record.result === "PARTICIPANT_WIN" ? 0 : 1,
    record.participantAverageCpmRaw
  ];
}

export function compareCanonicalAiRankKeys(
  left: CanonicalAiRankKey,
  right: CanonicalAiRankKey
): number {
  return left[0] - right[0] || right[1] - left[1];
}

export function compareCanonicalAiDisplayOrder(
  left: CanonicalAiRankable,
  right: CanonicalAiRankable
): number {
  return compareCanonicalAiRankKeys(canonicalAiRankKey(left), canonicalAiRankKey(right)) ||
    left.recordedAt.localeCompare(right.recordedAt) ||
    left.recordId.localeCompare(right.recordId);
}

export function rankCanonicalAiAttempts<T extends CanonicalAiRankable>(
  records: readonly T[]
): Array<CanonicalAiRanked<T>> {
  const sorted = records
    .filter((record) => record.contradictionCodes.length === 0)
    .slice()
    .sort(compareCanonicalAiDisplayOrder);
  let rank = 0;
  let previousKey: CanonicalAiRankKey | undefined;
  return sorted.map((record, index) => {
    const key = canonicalAiRankKey(record);
    if (!previousKey || compareCanonicalAiRankKeys(previousKey, key) !== 0) {
      rank = index + 1;
    }
    previousKey = key;
    return { rank, record };
  });
}

function legacyAiNumber(
  value: string | number | null | undefined,
  fallback = 0
): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function legacyAiResultRank(record: RecordRow): number {
  const label = String(record.challenge_result_label ?? "");
  if (label.includes("참여자 승리")) return 0;
  if (label.includes("금나래 승리") || label.includes("참여자 패배")) return 1;
  return record.ai_challenge_status === "SUCCESS" ||
    record.final_vs_ai_result === "USER_WIN"
    ? 0
    : 1;
}

export function compareLegacyAiRecords(a: RecordRow, b: RecordRow): number {
  const resultDiff = legacyAiResultRank(a) - legacyAiResultRank(b);
  if (resultDiff !== 0) return resultDiff;

  const cpmDiff =
    legacyAiNumber(b.participant_avg_cpm || b.final_cpm, -1) -
    legacyAiNumber(a.participant_avg_cpm || a.final_cpm, -1);
  if (cpmDiff !== 0) return cpmDiff;

  const completedDiff =
    new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime();
  if (completedDiff !== 0) return completedDiff;
  return String(a.record_id).localeCompare(String(b.record_id));
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function isInterruptedRecord(record: RecordRow): boolean {
  return String(record.challenge_result_label ?? "").includes("중단") ||
    String(record.memo ?? "").startsWith("사용자 중단:");
}

export function compareRecords(a: RecordRow, b: RecordRow): number {
  const interruptedDiff = Number(isInterruptedRecord(a)) - Number(isInterruptedRecord(b));
  if (interruptedDiff !== 0) return interruptedDiff;

  if (isInterruptedRecord(a) && isInterruptedRecord(b)) {
    const stageDiff = numberValue(b.result_stage) - numberValue(a.result_stage);
    if (stageDiff !== 0) return stageDiff;

    const progressDiff = numberValue(b.participant_progress_percent) - numberValue(a.participant_progress_percent);
    if (progressDiff !== 0) return progressDiff;

    const cpmDiff = numberValue(b.final_cpm) - numberValue(a.final_cpm);
    if (cpmDiff !== 0) return cpmDiff;
  }

  const timeDiff = numberValue(a.total_time_ms) - numberValue(b.total_time_ms);
  if (timeDiff !== 0) return timeDiff;

  const cpmDiff = numberValue(b.final_cpm) - numberValue(a.final_cpm);
  if (cpmDiff !== 0) return cpmDiff;

  const completedDiff = new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime();
  if (completedDiff !== 0) return completedDiff;

  return numberValue(a.record_id) - numberValue(b.record_id);
}

export function sortRecords(records: RecordRow[]): RecordRow[] {
  return [...records].sort(compareRecords);
}

export function bestRecordOnly(records: RecordRow[]): RecordRow[] {
  const best = new Map<string, RecordRow>();
  for (const record of records) {
    const key = `${record.participant_name.trim()}|${record.phone_full.trim()}`;
    const current = best.get(key);
    if (!current || compareRecords(record, current) < 0) best.set(key, record);
  }
  return sortRecords([...best.values()]);
}
