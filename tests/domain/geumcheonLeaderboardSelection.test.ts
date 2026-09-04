import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalAiAttemptV1, RecordRow } from "../../shared/types";
import {
  buildAiLeaderboardDisplayV2,
  selectGeumcheonAiLeaderboardEntriesForMode
} from "../../apps/leaderboard/src/LeaderboardApp";
import * as leaderboardModule from "../../apps/leaderboard/src/LeaderboardApp";
import { buildCanonicalAiAttempt } from "../../shared/utils/geumcheonAiAttempt";

function record(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    record_id: "record-1",
    created_at: "2026-09-18T01:00:00.000Z",
    completed_at: "2026-09-18T01:01:00.000Z",
    participant_name: "참가자",
    phone_part1: "010",
    phone_part2: "1234",
    phone_part3: "5678",
    phone_full: "01012345678",
    phone_masked: "010-****-5678",
    birth_year: "2014",
    birth_month: "01",
    birth_day: "01",
    birthdate: "2014-01-01",
    birthdate_masked: "2014-**-**",
    privacy_agreed: "true",
    privacy_agreed_at: "2026-09-18T01:00:00.000Z",
    stage1_text: "과학은 질문에서 시작됩니다",
    stage2_text: "태양 에너지는 우리 생활에 새로운 힘을 더합니다",
    stage3_text: "우리가 던진 작은 질문은 관찰과 실험을 거쳐 새로운 과학의 길을 엽니다",
    stage_text_catalog_version: "geumcheon-draft-20260825-v1",
    stage1_text_id: "gsc26-ai-s1-001",
    stage2_text_id: "gsc26-ai-s2-001",
    stage3_text_id: "gsc26-ai-s3-001",
    stage1_char_count: "13",
    stage2_char_count: "24",
    stage3_char_count: "39",
    total_char_count: "76",
    stage1_time_ms: "10000",
    stage2_time_ms: "10000",
    stage3_time_ms: "10000",
    stage1_cumulative_ms: "10000",
    stage2_cumulative_ms: "20000",
    total_time_ms: "30000",
    display_stage1_sec: "10.00",
    display_stage2_sec: "10.00",
    display_stage3_sec: "10.00",
    display_total_sec: "30.00",
    final_cpm: "500",
    final_accuracy: "100",
    app_version: "1.0.0",
    is_test: "false",
    is_debug: "false",
    debug_mode_type: "",
    memo: "",
    game_mode: "ai_challenge",
    ai_enabled: "true",
    ai_challenge_status: "SUCCESS",
    ai_failed_stage: "",
    ai_stage1_cpm: "400",
    ai_stage2_cpm: "400",
    ai_stage3_cpm: "400",
    ai_stage1_time_ms: "10000",
    ai_stage2_time_ms: "10000",
    ai_stage3_time_ms: "10000",
    ai_total_time_ms: "30000",
    stage1_vs_ai_result: "USER_WIN",
    stage2_vs_ai_result: "USER_WIN",
    stage3_vs_ai_result: "USER_WIN",
    final_vs_ai_result: "USER_WIN",
    stage1_time_diff_ms: "0",
    stage2_time_diff_ms: "0",
    stage3_time_diff_ms: "0",
    final_time_diff_ms: "0",
    participant_result_time_ms: "30000",
    ai_result_time_ms: "30000",
    participant_avg_cpm: "500",
    ai_avg_cpm: "400",
    challenge_result_label: "참여자 승리",
    participant_progress_percent: "100",
    ai_progress_percent: "100",
    duel_time_ms: "30000",
    result_stage: "3",
    original_record_id: "",
    is_admin_edited: "false",
    fairness: {
      catalogVersion: "geumcheon-draft-20260825-v1",
      totalUserTimeMs: 30000,
      stages: [
        { stageNumber: 1, textId: "gsc26-ai-s1-001", catalogVersion: "geumcheon-draft-20260825-v1", targetText: "과학은 질문에서 시작됩니다", typedText: "과학은 질문에서 시작됩니다", userTimeMs: 10000, typingUnits: 30, aiCpm: 400, result: "USER_WIN" },
        { stageNumber: 2, textId: "gsc26-ai-s2-001", catalogVersion: "geumcheon-draft-20260825-v1", targetText: "태양 에너지는 우리 생활에 새로운 힘을 더합니다", typedText: "태양 에너지는 우리 생활에 새로운 힘을 더합니다", userTimeMs: 10000, typingUnits: 40, aiCpm: 400, result: "USER_WIN" },
        { stageNumber: 3, textId: "gsc26-ai-s3-001", catalogVersion: "geumcheon-draft-20260825-v1", targetText: "우리가 던진 작은 질문은 관찰과 실험을 거쳐 새로운 과학의 길을 엽니다", typedText: "우리가 던진 작은 질문은 관찰과 실험을 거쳐 새로운 과학의 길을 엽니다", userTimeMs: 10000, typingUnits: 50, aiCpm: 400, result: "USER_WIN" }
      ]
    },
    attemptNumber: 1,
    rankingEligible: true,
    participantKey: "server-hmac-a",
    serverReceivedAt: "2026-09-18T01:00:00.000Z",
    completionStatus: "completed",
    ...overrides
  };
}

function builtCanonicalAttemptForRank(
  overrides: Partial<CanonicalAiAttemptV1>
): CanonicalAiAttemptV1 {
  const stageReached = overrides.stageReached ?? 3;
  const correctUnits = overrides.wholeGameProgressRaw ?? 100;
  const participantCpm = overrides.participantAverageCpmRaw ?? 600;
  const validUnits = participantCpm === 1 ? 1 : participantCpm / 100;
  const activeTypingTimeMs = validUnits * 60_000 / participantCpm;
  const duelTimeMs = overrides.totalActiveDuelTimeMs ?? 6_000;
  const capacities = [20, 30, 50] as const;
  const distribute = (total: number): number[] => {
    let remaining = total;
    return capacities.map((capacity, index) => {
      if (index >= stageReached) return 0;
      const value = Math.min(capacity, remaining);
      remaining -= value;
      return value;
    });
  };
  const correctByStage = distribute(correctUnits);
  const validByStage = distribute(validUnits);
  const participantCompleted = stageReached === 3 && correctUnits === 100;
  return buildCanonicalAiAttempt({
    schemaVersion: 1,
    attemptId: overrides.attemptId ?? "attempt-1",
    recordId: overrides.recordId ?? "record-1",
    deviceId: overrides.deviceId ?? "PC01",
    recordedAt: overrides.recordedAt ?? "2026-09-18T01:00:00.000Z",
    result: participantCompleted ? "PARTICIPANT_WIN" : "INTERRUPTED",
    interruptionReason: participantCompleted ? null : "HOME",
    participantFinishTimeMs: participantCompleted ? duelTimeMs : null,
    geumnaraeFinishTimeMs: participantCompleted ? duelTimeMs : null,
    stages: capacities.map((capacity, index) => ({
      stageNumber: (index + 1) as 1 | 2 | 3,
      entered: index < stageReached,
      assignedInputUnits: capacity,
      participantCorrectInputUnits: correctByStage[index],
      participantValidInputUnits: validByStage[index],
      participantActiveTypingTimeMs: index === 0 ? activeTypingTimeMs : 0,
      geumnaraeCorrectInputUnits: correctByStage[index],
      geumnaraeValidInputUnits: validByStage[index],
      geumnaraeActiveTypingTimeMs: index === 0 ? activeTypingTimeMs : 0,
      activeDuelTimeMs: index === 0 ? duelTimeMs : 0
    }))
  });
}

function canonicalRecord(
  recordId: string,
  attemptOverrides: Partial<CanonicalAiAttemptV1>,
  recordOverrides: Partial<RecordRow> = {}
): RecordRow {
  const attempt = builtCanonicalAttemptForRank({
    attemptId: `attempt-${recordId}`,
    recordId,
    ...attemptOverrides
  });
  return record({
    record_id: recordId,
    canonicalAttempt: attempt,
    ...recordOverrides
  });
}

function entry(row: RecordRow) {
  return {
    record: row,
    display: {
      participantTimeMs: Number(row.participant_result_time_ms),
      aiTimeMs: Number(row.ai_result_time_ms),
      participantAvgCpm: Number(row.participant_avg_cpm),
      aiAvgCpm: Number(row.ai_avg_cpm),
      resultLabel: row.challenge_result_label,
      participantTimeText: "30초",
      aiTimeText: "30초",
      participantCpmText: `${row.participant_avg_cpm}타`,
      aiCpmText: `${row.ai_avg_cpm}타`,
      resultStage: Number(row.result_stage),
      resultStageText: "3단계",
      participantProgressPercent: Number(row.participant_progress_percent),
      aiProgressPercent: Number(row.ai_progress_percent),
      duelTimeMs: Number(row.duel_time_ms),
      duelTimeText: "30초",
      duelRecordText: "30초",
      participantProgressText: "100%",
      aiProgressText: "100%"
    }
  };
}

type LeaderboardEditSelection = {
  selectedId: string;
  edit: {
    participant_name: string;
    memo: string;
  } | null;
};

function leaderboardEditSelectionResolver(): (
  selectedId: string,
  row: RecordRow
) => LeaderboardEditSelection {
  const resolver = (leaderboardModule as typeof leaderboardModule & {
    resolveLeaderboardEditSelection?: (
      selectedId: string,
      row: RecordRow
    ) => LeaderboardEditSelection;
  }).resolveLeaderboardEditSelection;

  assert.equal(typeof resolver, "function");
  return resolver;
}

test("clicking an unselected leaderboard row selects it for editing", () => {
  const resolveSelection = leaderboardEditSelectionResolver();
  const row = record({ record_id: "selected-record", participant_name: "선택 참가자", memo: "선택 메모" });

  const next = resolveSelection("", row);

  assert.equal(next.selectedId, "selected-record");
  assert.equal(next.edit?.participant_name, "선택 참가자");
  assert.equal(next.edit?.memo, "선택 메모");
});

test("clicking the selected leaderboard row again clears selection and edit state", () => {
  const resolveSelection = leaderboardEditSelectionResolver();

  const next = resolveSelection("selected-record", record({ record_id: "selected-record" }));

  assert.deepEqual(next, { selectedId: "", edit: null });
});

test("clicking a different leaderboard row moves selection and edit state", () => {
  const resolveSelection = leaderboardEditSelectionResolver();
  const nextRow = record({ record_id: "next-record", participant_name: "다음 참가자", memo: "다음 메모" });

  const next = resolveSelection("selected-record", nextRow);

  assert.equal(next.selectedId, "next-record");
  assert.equal(next.edit?.participant_name, "다음 참가자");
  assert.equal(next.edit?.memo, "다음 메모");
});

test("Geumcheon practice AI leaderboard keeps repeated participant attempts", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(record({ record_id: "first", participant_avg_cpm: "500" })),
      entry(record({ record_id: "best", participant_avg_cpm: "650" })),
      entry(record({ record_id: "other", participant_name: "다른참가자", phone_full: "01099995678", phone_masked: "010-****-5678", participant_avg_cpm: "550" }))
    ],
    { isGeumcheonOfficialBoard: false, isGeumcheonPracticeBoard: true }
  );

  assert.deepEqual(visible.map(({ record: row }) => row.record_id), ["best", "other", "first"]);
});

test("Geumcheon official AI leaderboard keeps fourth attempts without server-only metadata", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(record({ record_id: "fallback-only", attemptNumber: 4, rankingEligible: false, participantKey: undefined, serverReceivedAt: undefined, completionStatus: undefined, challenge_result_label: "참여자 승리" })),
      entry(record({ record_id: "trusted", participantKey: "server-hmac-b", completionStatus: "completed" }))
    ],
    { isGeumcheonOfficialBoard: true, isGeumcheonPracticeBoard: false }
  );

  assert.deepEqual(visible.map(({ record: row }) => row.record_id), ["fallback-only", "trusted"]);
});

test("Geumcheon AI ranking ignores winner labels and completion timestamps", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(canonicalRecord(
        "lower-canonical-winner",
        {
          stageReached: 2,
          wholeGameProgressRaw: 49,
          participantAverageCpmRaw: 900,
          totalActiveDuelTimeMs: 1_000,
          recordedAt: "2026-09-18T01:00:00.000Z"
        },
        {
          challenge_result_label: "참여자 승리",
          completed_at: "2026-09-18T01:00:01.000Z"
        }
      )),
      entry(canonicalRecord(
        "higher-canonical-loss",
        {
          stageReached: 3,
          wholeGameProgressRaw: 55,
          participantAverageCpmRaw: 1,
          totalActiveDuelTimeMs: 99_000,
          recordedAt: "2026-09-18T02:00:00.000Z"
        },
        {
          challenge_result_label: "참여자 패배",
          completed_at: "2026-09-18T02:00:01.000Z"
        }
      ))
    ],
    { isGeumcheonOfficialBoard: true, isGeumcheonPracticeBoard: false }
  );

  assert.deepEqual(
    visible.map(({ record: row }) => row.record_id),
    ["lower-canonical-winner", "higher-canonical-loss"]
  );
});

test("Geumcheon AI ranking uses exactly four raw keys and competition tie ranks", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(canonicalRecord("stage-one", {
        stageReached: 1,
        wholeGameProgressRaw: 15,
        participantAverageCpmRaw: 1_000,
        totalActiveDuelTimeMs: 100
      })),
      entry(canonicalRecord("same-cpm-longer", {
        stageReached: 2,
        wholeGameProgressRaw: 40,
        participantAverageCpmRaw: 800,
        totalActiveDuelTimeMs: 7_000
      })),
      entry(canonicalRecord("tie-newer", {
        stageReached: 2,
        wholeGameProgressRaw: 45,
        participantAverageCpmRaw: 900,
        totalActiveDuelTimeMs: 10_000,
        recordedAt: "2026-09-18T03:00:00.000Z"
      })),
      entry(canonicalRecord("progress-lower", {
        stageReached: 2,
        wholeGameProgressRaw: 35,
        participantAverageCpmRaw: 1_000,
        totalActiveDuelTimeMs: 500
      })),
      entry(canonicalRecord("higher-cpm-longer", {
        stageReached: 2,
        wholeGameProgressRaw: 40,
        participantAverageCpmRaw: 800,
        totalActiveDuelTimeMs: 5_000
      })),
      entry(canonicalRecord("stage-three", {
        stageReached: 3,
        wholeGameProgressRaw: 55,
        participantAverageCpmRaw: 1,
        totalActiveDuelTimeMs: 99_000
      })),
      entry(canonicalRecord("lower-cpm-shorter", {
        stageReached: 2,
        wholeGameProgressRaw: 40,
        participantAverageCpmRaw: 700,
        totalActiveDuelTimeMs: 1_000
      })),
      entry(canonicalRecord("tie-older", {
        stageReached: 2,
        wholeGameProgressRaw: 45,
        participantAverageCpmRaw: 900,
        totalActiveDuelTimeMs: 10_000,
        recordedAt: "2026-09-18T02:00:00.000Z"
      }))
    ],
    { isGeumcheonOfficialBoard: true, isGeumcheonPracticeBoard: false }
  );

  assert.deepEqual(
    visible.map((item) => ({
      recordId: item.record.record_id,
      rank: (item as typeof item & { rank: number }).rank
    })),
    [
      { recordId: "progress-lower", rank: 1 },
      { recordId: "stage-one", rank: 1 },
      { recordId: "tie-older", rank: 3 },
      { recordId: "tie-newer", rank: 3 },
      { recordId: "higher-cpm-longer", rank: 5 },
      { recordId: "same-cpm-longer", rank: 5 },
      { recordId: "lower-cpm-shorter", rank: 7 },
      { recordId: "stage-three", rank: 8 }
    ]
  );
});

test("Geumcheon official AI leaderboard keeps every repeated participant attempt", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(canonicalRecord("retry-third", {
        attemptId: "attempt-third",
        wholeGameProgressRaw: 55,
        participantAverageCpmRaw: 300
      })),
      entry(canonicalRecord("retry-first", {
        attemptId: "attempt-first",
        wholeGameProgressRaw: 55,
        participantAverageCpmRaw: 500
      })),
      entry(canonicalRecord("retry-second", {
        attemptId: "attempt-second",
        wholeGameProgressRaw: 55,
        participantAverageCpmRaw: 400
      }))
    ],
    { isGeumcheonOfficialBoard: true, isGeumcheonPracticeBoard: false }
  );

  assert.deepEqual(
    visible.map((item) => ({
      recordId: item.record.record_id,
      rank: (item as typeof item & { rank: number }).rank
    })),
    [
      { recordId: "retry-first", rank: 1 },
      { recordId: "retry-second", rank: 2 },
      { recordId: "retry-third", rank: 3 }
    ]
  );
});

test("Geumcheon AI all mode keeps every attempt while best mode selects one per opaque participant key", () => {
  const entries = [
    entry(canonicalRecord("opaque-a-first", {
      attemptId: "attempt-opaque-a-first",
      participantAverageCpmRaw: 300,
      recordedAt: "2026-09-18T01:00:00.000Z"
    }, { participant_name: "동명이인", participantKey: "opaque-a" })),
    entry(canonicalRecord("opaque-a-best", {
      attemptId: "attempt-opaque-a-best",
      participantAverageCpmRaw: 500,
      recordedAt: "2026-09-18T02:00:00.000Z"
    }, { participant_name: "동명이인", participantKey: "opaque-a" })),
    entry(canonicalRecord("opaque-b-best", {
      attemptId: "attempt-opaque-b-best",
      participantAverageCpmRaw: 400,
      recordedAt: "2026-09-18T03:00:00.000Z"
    }, { participant_name: "동명이인", participantKey: "opaque-b" }))
  ];

  const all = selectGeumcheonAiLeaderboardEntriesForMode(entries, {
    isGeumcheonOfficialBoard: true,
    isGeumcheonPracticeBoard: false,
    viewMode: "all"
  });
  const best = selectGeumcheonAiLeaderboardEntriesForMode(entries, {
    isGeumcheonOfficialBoard: true,
    isGeumcheonPracticeBoard: false,
    viewMode: "best"
  });

  assert.deepEqual(all.map(({ record }) => record.record_id), ["opaque-a-best", "opaque-b-best", "opaque-a-first"]);
  assert.deepEqual(best.map(({ record }) => record.record_id), ["opaque-a-best", "opaque-b-best"]);
});

test("Geumcheon AI participant grouping prefers the canonical opaque key", () => {
  const participantKey = (leaderboardModule as typeof leaderboardModule & {
    aiLeaderboardParticipantKey?: (row: RecordRow) => string;
  }).aiLeaderboardParticipantKey;

  assert.equal(typeof participantKey, "function");
  assert.equal(participantKey?.(record({ participantKey: "  server-hmac-canonical  " })), "server-hmac-canonical");
});

test("Geumcheon AI fallback participant key normalizes phone and birthdate without exposing either", () => {
  const participantKey = (leaderboardModule as typeof leaderboardModule & {
    aiLeaderboardParticipantKey?: (row: RecordRow) => string;
  }).aiLeaderboardParticipantKey;
  assert.equal(typeof participantKey, "function");

  const compact = participantKey?.(record({
    participantKey: undefined,
    phone_full: "01012345678",
    birthdate: "2014-01-01"
  }));
  const formatted = participantKey?.(record({
    participantKey: undefined,
    phone_full: "010-1234-5678",
    birthdate: "2014. 01. 01"
  }));

  assert.match(compact ?? "", /^legacy-sha256:[a-f0-9]{64}$/);
  assert.equal(formatted, compact);
  assert.doesNotMatch(compact ?? "", /01012345678|20140101/);
});

test("Geumcheon AI best mode separates namesakes by birthdate and keeps only the best retry", () => {
  const entries = [
    entry(canonicalRecord("same-person-slower", {
      participantAverageCpmRaw: 300
    }, {
      participant_name: "동명이인",
      participantKey: undefined,
      phone_full: "010-1234-5678",
      birthdate: "2014-01-01"
    })),
    entry(canonicalRecord("same-person-best", {
      participantAverageCpmRaw: 500
    }, {
      participant_name: "동명이인",
      participantKey: undefined,
      phone_full: "01012345678",
      birthdate: "2014. 01. 01"
    })),
    entry(canonicalRecord("namesake-other-birthdate", {
      participantAverageCpmRaw: 400
    }, {
      participant_name: "동명이인",
      participantKey: undefined,
      phone_full: "01012345678",
      birthdate: "2014-02-01"
    }))
  ];

  const best = selectGeumcheonAiLeaderboardEntriesForMode(entries, {
    isGeumcheonOfficialBoard: true,
    isGeumcheonPracticeBoard: false,
    viewMode: "best"
  });

  assert.deepEqual(best.map(({ record }) => record.record_id), ["same-person-best", "namesake-other-birthdate"]);
});

test("Geumcheon AI best mode stays best when refreshed entries add another attempt", () => {
  const mode = {
    isGeumcheonOfficialBoard: true,
    isGeumcheonPracticeBoard: false,
    viewMode: "best" as const
  };
  const first = entry(canonicalRecord("refresh-first", {
    attemptId: "attempt-refresh-first",
    participantAverageCpmRaw: 300
  }, { participantKey: "opaque-refresh" }));
  const refreshed = entry(canonicalRecord("refresh-new", {
    attemptId: "attempt-refresh-new",
    participantAverageCpmRaw: 500
  }, { participantKey: "opaque-refresh" }));

  assert.deepEqual(
    selectGeumcheonAiLeaderboardEntriesForMode([first], mode).map(({ record }) => record.record_id),
    ["refresh-first"]
  );
  assert.deepEqual(
    selectGeumcheonAiLeaderboardEntriesForMode([first, refreshed], mode).map(({ record }) => record.record_id),
    ["refresh-new"]
  );
});

test("interrupted AI display shows cumulative duel time without a character count", () => {
  const display = buildAiLeaderboardDisplayV2(record({
    challenge_result_label: "중단 패배",
    ai_challenge_status: "FAILED",
    final_vs_ai_result: "AI_WIN",
    result_stage: "2",
    stage1_vs_ai_result: "USER_WIN",
    stage2_vs_ai_result: "AI_WIN",
    stage3_vs_ai_result: "",
    stage1_text: "가".repeat(20),
    stage2_text: "나".repeat(20),
    stage3_text: "다".repeat(20),
    stage1_char_count: "4",
    stage2_char_count: "3",
    stage3_char_count: "0",
    total_char_count: "7",
    duel_time_ms: "11500"
  }));

  assert.equal(display.duelRecordText, "11.50초");
});

test("participant name masking exposes only the first and final characters", () => {
  const maskParticipantName = (leaderboardModule as typeof leaderboardModule & {
    maskParticipantName?: (name: string) => string;
  }).maskParticipantName;

  assert.equal(typeof maskParticipantName, "function");
  assert.equal(maskParticipantName("홍길동"), "홍*동");
  assert.equal(maskParticipantName("김철"), "김*");
  assert.equal(maskParticipantName("합성참가자1"), "합****1");
  assert.equal(maskParticipantName("박"), "박");
});

test("a failed Geumcheon challenge is labeled as a Geumnarae win", () => {
  const display = buildAiLeaderboardDisplayV2(record({
    challenge_result_label: "참여자 패배",
    ai_challenge_status: "FAILED",
    final_vs_ai_result: "AI_WIN",
    ai_progress_percent: "100"
  }));

  assert.equal(display.resultLabel, "금나래 승리");
});

test("countdown interruption displays stored zero time, CPM, and progress as zero values", () => {
  const display = buildAiLeaderboardDisplayV2(record({
    challenge_result_label: "중단 패배",
    ai_challenge_status: "FAILED",
    final_vs_ai_result: "AI_WIN",
    result_stage: "1",
    stage1_vs_ai_result: "AI_WIN",
    stage2_vs_ai_result: "",
    stage3_vs_ai_result: "",
    stage1_char_count: "0",
    stage2_char_count: "0",
    stage3_char_count: "0",
    total_char_count: "0",
    stage1_time_ms: "0",
    stage2_time_ms: "0",
    stage3_time_ms: "0",
    total_time_ms: "0",
    participant_result_time_ms: "0",
    participant_avg_cpm: "0",
    participant_progress_percent: "0",
    ai_stage1_time_ms: "0",
    ai_stage2_time_ms: "0",
    ai_stage3_time_ms: "0",
    ai_result_time_ms: "0",
    ai_avg_cpm: "0",
    ai_progress_percent: "0",
    duel_time_ms: "0"
  }));

  assert.deepEqual(
    {
      duelTimeMs: display.duelTimeMs,
      duelRecordText: display.duelRecordText,
      participantAvgCpm: display.participantAvgCpm,
      participantCpmText: display.participantCpmText,
      participantProgressPercent: display.participantProgressPercent,
      participantProgressText: display.participantProgressText
    },
    {
      duelTimeMs: 0,
      duelRecordText: "0.00초",
      participantAvgCpm: 0,
      participantCpmText: "평균 0타",
      participantProgressPercent: 0,
      participantProgressText: "진행률 0.00%"
    }
  );
});
