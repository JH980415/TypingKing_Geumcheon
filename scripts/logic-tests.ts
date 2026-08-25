import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../shared/constants/defaults";
import type { RecordRow } from "../shared/types";
import { bestRecordOnly, sortRecords } from "../shared/utils/ranking";
import {
  applyTargetLineBreaks,
  calculateAccuracy,
  calculateCurrentCpm,
  calculateFinalCpm,
  countConvertedTypingUnits,
  countMatchingPrefixTypingUnits,
  getLineProgress,
  getTextPrefixByTypingUnits,
  isExactMatch,
  isLineProgressAllowed,
  splitChars
} from "../shared/utils/typing";
import { daysInMonth, isValidBirthdate } from "../shared/utils/date";
import { validatePhoneParts } from "../shared/utils/masking";
import { pickRotatingStageText, type StageTextRotationState } from "../shared/utils/stageTextRotation";
import type { StageText } from "../shared/types";

const HONG_GIL_DONG = "\ud64d\uae38\ub3d9";
const GA = "\uac00";
const GEOK = "\uac71";
const NA = "\ub098";
const ILJALLER = "\uc77c\uc798\ub7ec";
const TEST_EXCLAMATION = "\ud14c\uc2a4\ud2b8!";

function record(partial: Partial<RecordRow>): RecordRow {
  return {
    record_id: "1",
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    participant_name: HONG_GIL_DONG,
    phone_part1: "010",
    phone_part2: "1234",
    phone_part3: "5678",
    phone_full: "010-1234-5678",
    phone_masked: "010-****-5678",
    birth_year: "1998",
    birth_month: "04",
    birth_day: "15",
    birthdate: "1998-04-15",
    birthdate_masked: "1998-**-**",
    privacy_agreed: "true",
    privacy_agreed_at: "2026-01-01T00:00:00.000Z",
    stage1_text: `${GA} ${NA}`,
    stage2_text: ILJALLER,
    stage3_text: TEST_EXCLAMATION,
    stage1_char_count: "3",
    stage2_char_count: "3",
    stage3_char_count: "4",
    total_char_count: "10",
    stage1_time_ms: "1000",
    stage2_time_ms: "1000",
    stage3_time_ms: "1000",
    stage1_cumulative_ms: "1000",
    stage2_cumulative_ms: "2000",
    total_time_ms: "3000",
    display_stage1_sec: "1.000",
    display_stage2_sec: "1.000",
    display_stage3_sec: "1.000",
    display_total_sec: "3.000",
    final_cpm: "220",
    final_accuracy: "100",
    app_version: "1.0.0",
    is_test: "false",
    memo: "",
    ...partial
  };
}

assert.equal(calculateCurrentCpm("1234567890123456789012345678901234567890", 30000), 80);
assert.equal(calculateCurrentCpm("12345", 30000), 10);
assert.equal(calculateFinalCpm(110, 60000), 110);

assert.equal(countConvertedTypingUnits(GA), 2);
assert.equal(countConvertedTypingUnits(GEOK), 3);
assert.equal(countConvertedTypingUnits("AI 2026!"), 8);
assert.equal(countConvertedTypingUnits("PMD"), 3);
assert.equal(countConvertedTypingUnits("!?.,"), 4);
assert.equal(countConvertedTypingUnits("(PMD)"), 5);
assert.equal(countConvertedTypingUnits(`${GA}\n${GEOK}`), 5);
assert.equal(calculateCurrentCpm(GA, 60000, GA), 2);
assert.equal(calculateCurrentCpm(GEOK, 60000, GEOK), 3);

const typoInput = "\uc77c\uc798\ub7ec\ub294 \ube60\ub974\uac1c";
const typoTarget = "\uc77c\uc798\ub7ec\ub294 \ube60\ub974\uac8c";
const matchingPrefix = "\uc77c\uc798\ub7ec\ub294 \ube60\ub974";
assert.equal(countMatchingPrefixTypingUnits(typoInput, typoTarget), countConvertedTypingUnits(matchingPrefix));
assert.equal(calculateCurrentCpm(typoInput, 60000, typoTarget), countConvertedTypingUnits(matchingPrefix));
assert.equal(getTextPrefixByTypingUnits("\uac71\uc815", 3), GEOK);

assert.equal(splitChars(`${GA} ${NA}`).length, 3);
assert.equal(splitChars("\uc88b\uc544\uc694!").length, 4);
assert.equal(calculateAccuracy(ILJALLER, ILJALLER), 100);
assert.equal(calculateAccuracy("\uc77c\uc798\ub77c", ILJALLER), 66.6);
assert.equal(isExactMatch("\uac00\ub098\ub2e4", "\uac00\ub098\ub2e4"), true);
assert.equal(isExactMatch("\uac00\ub098\ub2e4", "\uac00\ub2e4"), false);

const line1 = "\uc77c\uc798\ub7ec\ub294 \ube60\ub974\uac8c \uc6c0\uc9c1\uc785\ub2c8\ub2e4.";
const line2 = "\ud558\uc9c0\ub9cc \uc815\ud655\ud568\uc744 \ub193\uce58\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4!";
const twoLineTarget = `${line1}\n${line2}`;
assert.equal(isLineProgressAllowed(line1.replace(".", "?"), twoLineTarget), true);
assert.equal(getLineProgress(line1.replace(".", "?"), twoLineTarget).currentLineIndex, 0);
assert.equal(isLineProgressAllowed(`${line1.replace(".", "?")}${line2[0]}`, twoLineTarget), false);
assert.equal(isLineProgressAllowed(`${line1.slice(0, -1)}${line2}`, twoLineTarget), false);
assert.equal(isLineProgressAllowed(line1, twoLineTarget), true);
assert.equal(isLineProgressAllowed(`${line1}${line2[0]}`, twoLineTarget), true);
assert.equal(applyTargetLineBreaks(`${line1}${line2[0]}`, twoLineTarget), `${line1}\n${line2[0]}`);
assert.equal(getLineProgress(`${line1}${line2[0]}`, twoLineTarget).currentLineIndex, 1);
assert.equal(isExactMatch(`${line1}${line2}`, twoLineTarget), true);
assert.equal(isExactMatch(`${line1.slice(0, -1)}${line2}`, twoLineTarget), false);

const threeLineTarget = "A.\nB.\nC.";
assert.equal(isLineProgressAllowed("A.B?C", threeLineTarget), false);
assert.equal(isLineProgressAllowed("A.B.C.", threeLineTarget), true);
assert.equal(isExactMatch("C.", threeLineTarget), false);
assert.equal(getLineProgress("A.B.", threeLineTarget).currentLineIndex, 2);

assert.equal(validatePhoneParts("010", "1234", "5678"), null);
assert.equal(validatePhoneParts("010", "123", "5678"), "휴대폰번호는 010-0000-0000 형식으로 입력해 주세요.");
assert.equal(validatePhoneParts("010", "1234", "567"), "휴대폰번호는 010-0000-0000 형식으로 입력해 주세요.");
assert.equal(validatePhoneParts("010", "12a4", "5678"), "휴대폰번호는 010-0000-0000 형식으로 입력해 주세요.");
assert.equal(daysInMonth(2024, 2), 29);
assert.equal(isValidBirthdate("2024", "02", "29"), true);

assert.deepEqual(DEFAULT_CONFIG.aiChallenge.stageSpeedRanges.stage1, { min: 300, max: 350 });
assert.deepEqual(DEFAULT_CONFIG.aiChallenge.stageSpeedRanges.stage2, { min: 350, max: 400 });
assert.deepEqual(DEFAULT_CONFIG.aiChallenge.stageSpeedRanges.stage3, { min: 400, max: 500 });
assert.equal(DEFAULT_CONFIG.aiChallenge.aiSpeedChangeIntervalMs, 500);

const rotationRows: StageText[] = [
  { id: "s1-a", stage_number: "1", text: "문구 A.", is_active: "true", game_mode: "normal", created_at: "", updated_at: "" },
  { id: "s1-b", stage_number: "1", text: "문구 B.", is_active: "true", game_mode: "normal", created_at: "", updated_at: "" },
  { id: "s1-c", stage_number: "1", text: "문구 C.", is_active: "true", game_mode: "normal", created_at: "", updated_at: "" }
];
let rotationState: StageTextRotationState = {};
const rotationSequence: string[] = [];
for (let index = 0; index < 4; index += 1) {
  const selected = pickRotatingStageText(rotationRows, "normal", 1, rotationState, () => 0);
  rotationSequence.push(selected.row.id);
  rotationState = selected.nextState;
}
assert.deepEqual(rotationSequence.slice(0, 3), ["s1-a", "s1-b", "s1-c"]);
assert.equal(rotationSequence[3], "s1-a");

const ranked = sortRecords([
  record({ record_id: "3", total_time_ms: "1000", final_cpm: "100", completed_at: "2026-01-01T00:00:03.000Z" }),
  record({ record_id: "2", total_time_ms: "1000", final_cpm: "120", completed_at: "2026-01-01T00:00:02.000Z" }),
  record({ record_id: "1", total_time_ms: "900", final_cpm: "80", completed_at: "2026-01-01T00:00:01.000Z" })
]);
assert.deepEqual(ranked.map((row) => row.record_id), ["1", "2", "3"]);

const tied = sortRecords([
  record({ record_id: "2", total_time_ms: "1000", final_cpm: "100", completed_at: "2026-01-01T00:00:02.000Z" }),
  record({ record_id: "1", total_time_ms: "1000", final_cpm: "100", completed_at: "2026-01-01T00:00:01.000Z" })
]);
assert.deepEqual(tied.map((row) => row.record_id), ["1", "2"]);

const best = bestRecordOnly([
  record({ record_id: "1", total_time_ms: "2000", final_cpm: "200" }),
  record({ record_id: "2", total_time_ms: "1500", final_cpm: "180" })
]);
assert.equal(best.length, 1);
assert.equal(best[0].record_id, "2");

const interruptedRanked = sortRecords([
  record({
    record_id: "interrupted-fast",
    total_time_ms: "100",
    final_cpm: "999",
    challenge_result_label: "중단",
    participant_progress_percent: "90",
    result_stage: "3",
    memo: "사용자 중단:다시하기"
  }),
  record({ record_id: "completed-slow", total_time_ms: "9000", final_cpm: "100" }),
  record({
    record_id: "interrupted-low",
    total_time_ms: "5000",
    final_cpm: "150",
    challenge_result_label: "중단",
    participant_progress_percent: "20",
    result_stage: "1",
    memo: "사용자 중단:메인화면"
  })
]);
assert.deepEqual(
  interruptedRanked.map((row) => row.record_id),
  ["completed-slow", "interrupted-fast", "interrupted-low"]
);

const bestWithInterruption = bestRecordOnly([
  record({ record_id: "interrupted", total_time_ms: "10", challenge_result_label: "중단", memo: "사용자 중단:다시하기" }),
  record({ record_id: "completed", total_time_ms: "5000" })
]);
assert.equal(bestWithInterruption[0].record_id, "completed");

console.log("logic tests passed");
