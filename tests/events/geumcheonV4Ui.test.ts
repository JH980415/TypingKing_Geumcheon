import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AIChallengeGame, BattlePopup, ChallengeSummary } from "../../apps/typing-game/src/AIChallengeGame";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { loadEventProfile } from "../../shared/events/eventProfile";

const profile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
const participant = {
  name: "표시검수", phone1: "010", phone2: "0000", phone3: "0000",
  birthYear: "2000", birthMonth: "1", birthDay: "1", privacyAgreedAt: "2026-09-12T00:00:00.000Z"
};
const battle = {
  stage: 1, text: "가".repeat(13), userTimeMs: 7000, userCpm: 257, userAccuracy: 100,
  aiTimeMs: 12340, aiElapsedMs: 12340, aiCpm: 57, plannedAiCpm: 300,
  aiTypedUnits: 6, aiTypedChars: 6, result: "USER_WIN" as const, userInput: "가".repeat(13)
};
const noop = () => undefined;

test("v4 battle heading names AI Geumnarae without duplicating its prefix", () => {
  const html = renderToStaticMarkup(createElement(AIChallengeGame, {
    config: DEFAULT_CONFIG, participant, stageTexts: ["가", "나", "다"],
    assetBaseUrl: "file:///assets", eventProfile: profile, onHome: noop, onRetry: noop
  }));
  assert.match(html, /<h2>AI 금나래<\/h2>/);
  assert.doesNotMatch(html, /AI AI 금나래/);
});

for (const stage of [1, 2, 3]) {
  for (const result of ["USER_WIN", "AI_WIN"] as const) {
    test(`v4 Stage ${stage} ${result} popup uses the two requested AI metric labels`, () => {
      const html = renderToStaticMarkup(createElement(BattlePopup, {
        battle: { ...battle, stage, result }, isFinalWin: stage === 3 && result === "USER_WIN",
        onNext: noop, onRetry: noop, onHome: noop, saveError: "",
        assetBaseUrl: "file:///assets", eventProfile: profile, isDebug: false
      }));
      assert.match(html, /<span>AI 금나래 기록 <strong>/);
      assert.match(html, /<span>AI 금나래 평균 타수 <strong>/);
      assert.match(html, /<span>도전자 기록 <strong>/);
      assert.doesNotMatch(html, /AI AI 금나래/);
    });
  }
}

test("v4 final comparison keeps the two labels and original numeric precision in shared metric rows", () => {
  const html = renderToStaticMarkup(createElement(ChallengeSummary, {
    battles: [battle], row: null, participant, assetBaseUrl: "file:///assets", eventProfile: profile
  }));
  const rows = [...html.matchAll(/<strong class="r7-stage-metric-row"[^>]*>([\s\S]*?)<\/strong>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, ""));
  assert.deepEqual(rows, ["도전자 :7.00초｜13글자｜257타", "금나래 :12.34초｜6글자｜57타"]);
  assert.match(html, /class="r7-stage-metrics"/);
  assert.doesNotMatch(html, /AI 금나래 :/);
});

test("v4 presentation does not change another event's popup labels or final result format", () => {
  const otherProfile = { ...profile, profileId: "skillup-2026" as const };
  const popup = renderToStaticMarkup(createElement(BattlePopup, {
    battle, isFinalWin: false, onNext: noop, onRetry: noop, onHome: noop, saveError: "",
    assetBaseUrl: "file:///assets", eventProfile: otherProfile, isDebug: false
  }));
  assert.match(popup, /<span>금나래 기록 <strong>/);
  assert.match(popup, /<span>금나래 평균 타수 <strong>/);
  assert.doesNotMatch(popup, /AI 금나래 기록/);
  const summary = renderToStaticMarkup(createElement(ChallengeSummary, {
    battles: [battle], row: null, participant, assetBaseUrl: "file:///assets", eventProfile: otherProfile
  }));
  assert.match(summary, /사용자 총 기록/);
  assert.doesNotMatch(summary, /r7-stage-metrics/);
});
