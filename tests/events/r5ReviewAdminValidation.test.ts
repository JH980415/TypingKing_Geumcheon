import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  formatReviewStorageValidationMessage,
  OneDriveSettingsPanel
} from "../../apps/shell/src/OneDriveSettingsPanel";
import {
  assertPlayerRecordSaveAllowed,
  assertReviewExternalStorageIpcAllowed,
  REVIEW_EXTERNAL_STORAGE_IPC_CHANNELS
} from "../../electron/geumcheonConnection";
import type { ReviewRuntimeContext } from "../../shared/types";

const reviewContext: ReviewRuntimeContext = {
  environment: "review",
  profileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026-review",
  buildId: "R2.0.4-R5",
  deviceId: "review-ai",
  role: "player",
  sessionKind: "official",
  storageKind: "local"
};

test("review admin storage panel exposes only fixed local environment role and session labels", () => {
  const html = renderToStaticMarkup(createElement(OneDriveSettingsPanel, {
    role: "player",
    eventProfileId: "geumcheon-2026",
    sessionKind: "official",
    gameMode: "ai_challenge"
  }));

  assert.match(html, /로컬 검토 저장소/);
  assert.match(html, /검토 환경/);
  assert.match(html, /플레이어/);
  assert.match(html, /공식회차/);
  assert.doesNotMatch(html, /장치 ID|중앙 기록 API|https?:\/\/|token|credential/i);
});

test("review validation messages contain fixed result labels without diagnostic detail", () => {
  assert.equal(formatReviewStorageValidationMessage({
    storage: "local",
    environment: "review",
    role: "leaderboard",
    session: "practice",
    result: "normal"
  }), "로컬 검토 저장소 / 검토 환경 / 리더보드 / 연습회차 / 정상");
  assert.equal(formatReviewStorageValidationMessage({
    storage: "local",
    environment: "review",
    role: "leaderboard",
    session: "practice",
    result: "error"
  }), "로컬 검토 저장소 / 검토 환경 / 리더보드 / 연습회차 / 오류");
});

test("review context rejects every external-storage IPC before its side effect", () => {
  assert.deepEqual(REVIEW_EXTERNAL_STORAGE_IPC_CHANNELS, [
    "stage:publishShared",
    "sync:getSettings",
    "sync:updateSettings",
    "sync:validateSetup",
    "sync:poke",
    "sync:cleanupLegacyArtifacts",
    "sync:chooseRoot",
    "sync:openSessionFolder"
  ]);

  for (const channel of REVIEW_EXTERNAL_STORAGE_IPC_CHANNELS) {
    let sideEffectCalls = 0;
    assert.throws(() => {
      assertReviewExternalStorageIpcAllowed(reviewContext, channel);
      sideEffectCalls += 1;
    }, { message: "REVIEW_EXTERNAL_STORAGE_DISABLED" });
    assert.equal(sideEffectCalls, 0, channel);
  }
});

test("external-storage IPC policy leaves production operations unchanged", () => {
  let sideEffectCalls = 0;
  assert.doesNotThrow(() => {
    assertReviewExternalStorageIpcAllowed(undefined, "sync:updateSettings");
    sideEffectCalls += 1;
  });
  assert.equal(sideEffectCalls, 1);
});

test("main record-save policy accepts players and rejects leaderboards", () => {
  assert.doesNotThrow(() => assertPlayerRecordSaveAllowed("player"));
  assert.throws(() => assertPlayerRecordSaveAllowed("leaderboard"), {
    message: "RECORD_SAVE_PLAYER_ONLY"
  });
});
