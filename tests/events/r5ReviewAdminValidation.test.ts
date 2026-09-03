import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import {
  formatReviewStorageValidationMessage,
  OneDriveSettingsPanel
} from "../../apps/shell/src/OneDriveSettingsPanel";

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
