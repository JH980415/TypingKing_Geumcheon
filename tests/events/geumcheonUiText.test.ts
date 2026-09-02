import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AIChallengeGame } from "../../apps/typing-game/src/AIChallengeGame";
import * as challengeGameModule from "../../apps/typing-game/src/AIChallengeGame";
import { LeaderboardApp } from "../../apps/leaderboard/src/LeaderboardApp";
import { TypingGameApp } from "../../apps/typing-game/src/TypingGameApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";

const geumcheonProfile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));

const participant = {
  name: "금천 참가자",
  phone1: "010",
  phone2: "1234",
  phone3: "5678",
  birthYear: "2014",
  birthMonth: "1",
  birthDay: "2",
  privacyAgreedAt: "2026-08-31T00:00:00.000Z"
};

function renderChallengeMarkup() {
  return renderToStaticMarkup(
    createElement(AIChallengeGame, {
      config: DEFAULT_CONFIG,
      participant,
      stageTexts: ["금천 과학 축제", "AI와 함께 배우는 금천", "금나래와 끝까지 타자 대결"],
      assetBaseUrl: "file:///resources/assets",
      eventProfile: geumcheonProfile,
      onHome: () => undefined,
      onRetry: () => undefined
    })
  );
}

function renderLeaderboardMarkup() {
  return renderToStaticMarkup(
    createElement(LeaderboardApp, {
      bootstrap: createBootstrapData({
        config: DEFAULT_CONFIG,
        assetBaseUrl: "file:///resources/assets",
        notices: [],
        mode: "leaderboard",
        variant: "ai-leaderboard",
        eventProfile: geumcheonProfile
      })
    })
  );
}

test("Geumcheon start screen keeps central title without duplicate header title", () => {
  const html = renderToStaticMarkup(
    createElement(TypingGameApp, {
      bootstrap: createBootstrapData({
        config: DEFAULT_CONFIG,
        assetBaseUrl: "file:///resources/assets",
        notices: [],
        mode: "game",
        variant: "ai",
        eventProfile: geumcheonProfile
      })
    })
  );

  assert.match(html, /geumcheon-main-title-image/);
  assert.match(html, /AI 타자왕 금나래를 이겨라!/);
  assert.doesNotMatch(html, /class="brand-header"/);
  assert.doesNotMatch(html, /AI보다 100%/);
});

test("Geumcheon challenge screen names the AI competitor as Geumnarae", () => {
  const html = renderChallengeMarkup();

  assert.match(html, /금나래 입력 대기 중/);
  assert.match(html, /금나래보다 먼저 완성하세요/);
  assert.doesNotMatch(html, /AI 입력 대기 중/);
  assert.doesNotMatch(html, /AI보다 먼저/);
});

test("Geumcheon official leaderboard uses approved R2.0.3 labels and count wording", () => {
  const html = renderLeaderboardMarkup();

  for (const label of [
    "순위",
    "참여자명",
    "휴대폰번호",
    "결과",
    "종료 지점",
    "참여자 기록",
    "금나래 기록",
    "총 대결시간",
    "공식 도전 기록 0건"
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /title_05_geumcheon_geumnarae_r203\.png/);
  assert.doesNotMatch(html, /종료 스테이지/);
  assert.doesNotMatch(html, /참여자 점수/);
  assert.doesNotMatch(html, /AI 점수/);
  assert.doesNotMatch(html, /대결 시간/);
  assert.doesNotMatch(html, /명 참가 중/);
});

test("challenge save errors shown to users hide internal codes and absolute paths", () => {
  const format = (challengeGameModule as typeof challengeGameModule & {
    formatChallengeSaveErrorForDisplay?: (error: string) => string;
  }).formatChallengeSaveErrorForDisplay;
  assert.equal(typeof format, "function");

  const message = format("BOOTSTRAP_CREDENTIAL_INVALID: C:\\Users\\tester\\secret\\bootstrap-credentials.json");

  assert.match(message, /기록 저장/);
  assert.doesNotMatch(message, /BOOTSTRAP_CREDENTIAL_INVALID|C:\\Users|bootstrap-credentials\.json/);
  assert.doesNotMatch(message, /관리자 PIN|0208/);
});
