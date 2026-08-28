import assert from "node:assert/strict";
import test from "node:test";
import { recalculateRecord } from "../../shared/csv/fileStore";
import type { RecordRow } from "../../shared/types";

test("recalculates every derived field before a Geumcheon NAS admin edit", () => {
  const replacement = recalculateRecord({
    record_id: "gsc26-leaderboard01-123e4567-e89b-42d3-a456-426614174000",
    participant_name: "수정 참가자",
    phone_part1: "010",
    phone_part2: "9876",
    phone_part3: "5432",
    phone_full: "stale",
    phone_masked: "stale",
    birth_year: "2014",
    birth_month: "1",
    birth_day: "2",
    birthdate: "stale",
    birthdate_masked: "stale",
    stage1_text: "abcd",
    stage2_text: "efgh",
    stage3_text: "ijkl",
    stage1_time_ms: "1000",
    stage2_time_ms: "2000",
    stage3_time_ms: "3000",
    stage1_char_count: "0",
    stage2_char_count: "0",
    stage3_char_count: "0",
    total_char_count: "0",
    stage1_cumulative_ms: "0",
    stage2_cumulative_ms: "0",
    total_time_ms: "0",
    display_stage1_sec: "stale",
    display_stage2_sec: "stale",
    display_stage3_sec: "stale",
    display_total_sec: "stale",
    final_cpm: "0"
  } as RecordRow);

  assert.deepEqual(
    {
      phone_full: replacement.phone_full,
      phone_masked: replacement.phone_masked,
      birth_month: replacement.birth_month,
      birth_day: replacement.birth_day,
      birthdate: replacement.birthdate,
      birthdate_masked: replacement.birthdate_masked,
      stage1_char_count: replacement.stage1_char_count,
      stage2_char_count: replacement.stage2_char_count,
      stage3_char_count: replacement.stage3_char_count,
      total_char_count: replacement.total_char_count,
      stage1_cumulative_ms: replacement.stage1_cumulative_ms,
      stage2_cumulative_ms: replacement.stage2_cumulative_ms,
      total_time_ms: replacement.total_time_ms,
      display_stage1_sec: replacement.display_stage1_sec,
      display_stage2_sec: replacement.display_stage2_sec,
      display_stage3_sec: replacement.display_stage3_sec,
      display_total_sec: replacement.display_total_sec,
      final_cpm: replacement.final_cpm
    },
    {
      phone_full: "010-9876-5432",
      phone_masked: "010-****-5432",
      birth_month: "01",
      birth_day: "02",
      birthdate: "2014-01-02",
      birthdate_masked: "2014-**-**",
      stage1_char_count: "4",
      stage2_char_count: "4",
      stage3_char_count: "4",
      total_char_count: "12",
      stage1_cumulative_ms: "1000",
      stage2_cumulative_ms: "3000",
      total_time_ms: "6000",
      display_stage1_sec: "1.000",
      display_stage2_sec: "2.000",
      display_stage3_sec: "3.000",
      display_total_sec: "6.000",
      final_cpm: "120"
    }
  );
});
