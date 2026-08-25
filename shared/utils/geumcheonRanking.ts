export type CompletionStatus = "completed" | "failed" | "interrupted";

export type OfficialAttemptCandidate = {
  recordId: string;
  participantKey: string;
  serverReceivedAt: string;
  completedAt: string;
  completionStatus: CompletionStatus;
  completedStages: number;
  progressPercent: number;
  totalTypingUnits: number;
  totalUserTimeMs: number;
  isTest: boolean;
  isDebug: boolean;
};

export type AttemptEligibility = {
  attemptNumber: number | null;
  rankingEligible: boolean;
};

function requireSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
}

function requireNonnegativeSafeInteger(value: number, name: string): void {
  requireSafeInteger(value, name);
  if (value < 0) throw new Error(`${name} must be nonnegative`);
}

function requirePositiveSafeInteger(value: number, name: string): void {
  requireSafeInteger(value, name);
  if (value <= 0) throw new Error(`${name} must be positive`);
}

function validateCandidate(record: OfficialAttemptCandidate): void {
  requireNonnegativeSafeInteger(record.completedStages, "completedStages");
  requireNonnegativeSafeInteger(record.totalTypingUnits, "totalTypingUnits");
  requirePositiveSafeInteger(record.totalUserTimeMs, "totalUserTimeMs");
  if (!Number.isFinite(record.progressPercent) || record.progressPercent < 0) {
    throw new Error("progressPercent must be nonnegative");
  }
  if (!record.recordId) throw new Error("recordId is required");
  if (!record.participantKey) throw new Error("participantKey is required");
  if (!record.serverReceivedAt) throw new Error("serverReceivedAt is required");
  if (!record.completedAt) throw new Error("completedAt is required");
}

export function calculateEffectiveCpm(totalTypingUnits: number, totalUserTimeMs: number): number {
  requireNonnegativeSafeInteger(totalTypingUnits, "totalTypingUnits");
  requirePositiveSafeInteger(totalUserTimeMs, "totalUserTimeMs");
  return (totalTypingUnits * 60000) / totalUserTimeMs;
}

function compareEffectiveCpmDesc(a: OfficialAttemptCandidate, b: OfficialAttemptCandidate): number {
  const left = BigInt(a.totalTypingUnits) * BigInt(b.totalUserTimeMs);
  const right = BigInt(b.totalTypingUnits) * BigInt(a.totalUserTimeMs);
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

function completionRank(status: CompletionStatus): number {
  if (status === "completed") return 0;
  if (status === "failed") return 1;
  return 2;
}

function compareTieBreakers(a: OfficialAttemptCandidate, b: OfficialAttemptCandidate): number {
  const unitDiff = b.totalTypingUnits - a.totalTypingUnits;
  if (unitDiff !== 0) return unitDiff;

  const timeDiff = a.totalUserTimeMs - b.totalUserTimeMs;
  if (timeDiff !== 0) return timeDiff;

  const completedDiff = Date.parse(a.completedAt) - Date.parse(b.completedAt);
  if (completedDiff !== 0 && Number.isFinite(completedDiff)) return completedDiff;

  return a.recordId.localeCompare(b.recordId);
}

export function compareGeumcheonRecords(a: OfficialAttemptCandidate, b: OfficialAttemptCandidate): number {
  validateCandidate(a);
  validateCandidate(b);

  const completionDiff = Number(a.completionStatus !== "completed") - Number(b.completionStatus !== "completed");
  if (completionDiff !== 0) return completionDiff;

  if (a.completionStatus !== "completed" && b.completionStatus !== "completed") {
    const stageDiff = b.completedStages - a.completedStages;
    if (stageDiff !== 0) return stageDiff;

    const progressDiff = b.progressPercent - a.progressPercent;
    if (progressDiff !== 0) return progressDiff;
  }

  const cpmDiff = compareEffectiveCpmDesc(a, b);
  if (cpmDiff !== 0) return cpmDiff;

  if (a.completionStatus !== "completed" && b.completionStatus !== "completed") {
    const statusDiff = completionRank(a.completionStatus) - completionRank(b.completionStatus);
    if (statusDiff !== 0) return statusDiff;
  }

  return compareTieBreakers(a, b);
}

function compareAttemptOrder(a: OfficialAttemptCandidate, b: OfficialAttemptCandidate): number {
  const participantDiff = a.participantKey.localeCompare(b.participantKey);
  if (participantDiff !== 0) return participantDiff;

  const receivedDiff = Date.parse(a.serverReceivedAt) - Date.parse(b.serverReceivedAt);
  if (receivedDiff !== 0 && Number.isFinite(receivedDiff)) return receivedDiff;

  return a.recordId.localeCompare(b.recordId);
}

export function assignOfficialAttemptEligibility<T extends OfficialAttemptCandidate>(
  records: readonly T[],
  limit = 3
): Array<T & AttemptEligibility> {
  requirePositiveSafeInteger(limit, "limit");
  const counts = new Map<string, number>();

  return [...records].sort(compareAttemptOrder).map((record) => {
    validateCandidate(record);
    if (record.isTest || record.isDebug) {
      return { ...record, attemptNumber: null, rankingEligible: false };
    }

    const attemptNumber = (counts.get(record.participantKey) ?? 0) + 1;
    counts.set(record.participantKey, attemptNumber);
    return {
      ...record,
      attemptNumber,
      rankingEligible: attemptNumber <= limit && record.completionStatus === "completed"
    };
  });
}

export function selectBestEligibleRecordPerParticipant<
  T extends OfficialAttemptCandidate & AttemptEligibility
>(records: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const record of records) {
    validateCandidate(record);
    if (!record.rankingEligible || record.completionStatus !== "completed") continue;
    const current = best.get(record.participantKey);
    if (!current || compareGeumcheonRecords(record, current) < 0) best.set(record.participantKey, record);
  }
  return [...best.values()].sort(compareGeumcheonRecords);
}
