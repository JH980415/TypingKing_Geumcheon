import assert from "node:assert/strict";
import test from "node:test";
import type { RecordRow } from "../../shared/types";
import { selectGeumcheonAiLeaderboardEntriesForMode } from "../../apps/leaderboard/src/LeaderboardApp";

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

test("Geumcheon practice AI leaderboard shows only each participant's best practice record", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(record({ record_id: "first", participant_avg_cpm: "500" })),
      entry(record({ record_id: "best", participant_avg_cpm: "650" })),
      entry(record({ record_id: "other", participant_name: "다른참가자", phone_full: "01099995678", phone_masked: "010-****-5678", participant_avg_cpm: "550" }))
    ],
    { isGeumcheonOfficialBoard: false, isGeumcheonPracticeBoard: true }
  );

  assert.deepEqual(visible.map(({ record: row }) => row.record_id), ["best", "other"]);
});

test("Geumcheon official AI leaderboard excludes rows missing authoritative completionStatus", () => {
  const visible = selectGeumcheonAiLeaderboardEntriesForMode(
    [
      entry(record({ record_id: "fallback-only", completionStatus: undefined, challenge_result_label: "참여자 승리" })),
      entry(record({ record_id: "trusted", participantKey: "server-hmac-b", completionStatus: "completed" }))
    ],
    { isGeumcheonOfficialBoard: true, isGeumcheonPracticeBoard: false }
  );

  assert.deepEqual(visible.map(({ record: row }) => row.record_id), ["trusted"]);
});
