import type { RecordRow } from "../types";

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
